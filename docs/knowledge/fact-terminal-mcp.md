# Feature: Terminal MCP Server

## Intro
MCP-сервер для управления терминальными вкладками из AI-агента (Claude Code, Codex CLI, Gemini CLI). Позволяет агенту видеть запущенные dev-серверы, перезапускать процессы после изменения кода, читать output, выполнять build-цепочки и управлять живыми AI CLI во вкладках — без ручного переключения вкладок пользователем.

## Архитектура

### Один публичный MCP, несколько внутренних границ
После унификации публичная AI-поверхность одна: `~/.claude/mcp/terminal-server.mjs`. Она не переносит бизнес-логику в MCP, а типизированно вызывает существующие main-process HTTP/API-сценарии:
- live process control и shell output;
- Project API для agent send/interrupt/rewind и долговечной оркестрации;
- `/overseer/*` как внутренний read/edit backend истории;
- renderer bridge для persistent UI-state: план задач, имя вкладки и file-child.

Отдельный `overseer-server.mjs`, его MCP-регистрация и skill удалены. Причина объединения — не смешать blast radius, а дать нейронке одну обнаруживаемую поверхность: раньше правила выбора между двумя MCP жили в длинном skill/prompt и регулярно приводили к чтению ответа через terminal output или polling не того канала. Опасные операции по-прежнему разделены отдельными методами и approval-контрактами. Механика истории описана в [`fact-session-history.md`](fact-session-history.md).

### Определение проекта и своей вкладки
Внутри полноценной Noted Terminal-сессии main передаёт MCP `NOTED_PARENT_PROJECT_ID`, `NOTED_PARENT_TAB_ID` и `NOTED_MAIN_PID`. Они приоритетнее cwd и активной вкладки UI: пользователь может смотреть другой проект, пока агент работает в фоне. `current_context` возвращает доказанную пару project/tab и известный sessionId; self-операции (`rename_tab`, `link_file`, `get_tab_plan`, `apply_tab_plan_changes`) принимают отсутствующий `tabId` как эту родительскую вкладку.

Внешний клиент без parent env использует `list_projects` и передаёт явный `projectId`/`tabId`. `process.cwd()` остаётся fallback для старых callers, но не source of truth для собственной идентичности.

### Tab Data: SQLite + Live State
`/terminal/tabs` объединяет данные из двух источников:
- **SQLite** (renderer → save-tabs): name, color, command_type, cwd, tab_id — снимок на момент последнего save
- **Main process Maps** (live): terminals (PTY alive?), terminalCommandState (isRunning), terminalInitialCommand, pid

### План задач вкладки

Terminal MCP публикует две отдельные команды структурированного плана:

- `get_tab_plan` читает план целевой вкладки и одновременно возвращает актуальные статусы задач с их описаниями;
- `apply_tab_plan_changes` атомарно применяет уже подтверждённый пользователем пакет операций.

Если `tabId` не передан, сервер использует `NOTED_PARENT_TAB_ID`, то есть вкладку, которой принадлежит текущая AI-сессия. Это важнее активной вкладки интерфейса: пользователь может в момент фоновой правки смотреть другой проект.

Команда записи намеренно не принимает свободный Markdown. Контракт ограничен операциями над двумя уровнями структуры и архивом корневых задач (`archive_task` / `restore_task`); один вызов образует одну точку общей истории undo/redo. Инструкция инструмента и `docs/prompts/план-задач-вкладки.prompt.md` требуют до вызова показать точную дельту и дождаться явного подтверждения пользователя. Подробнее: [`fact-tab-task-plan.md`](fact-tab-task-plan.md).

## AI live control

Terminal MCP управляет **живым процессом**, а не историей. `start_ai` создаёт или переиспользует вкладку и запускает `claude` / `codex` / `gemini` через те же app-native launch hooks, что UI. `send_prompt` вставляет prompt в целевую вкладку через существующий safe paste path, `stop_ai` останавливает AI process-tree без уничтожения shell. Для `codex-c` / `codex-f` / `claude-c` / `claude-f` create-tab aliases проходят через pendingAction, чтобы renderer применил тот же resume/fork flow, что пользовательская кнопка.

`start_ai` подтверждает не только запись launch-команды. Для Claude ответ
`ready:true/inputReady:true` возможен после TUI prompt **и** ready startup-gate
для `/model`/`/effort`; для Codex — после доказанной готовности composer и
проверки запрошенной next-launch пары. Первый TUI edge лишь будит проверку.
Для Claude он также только открывает транзакцию: первый settings-paste ждёт
устойчивого composer-frame после последней startup-перерисовки. Если запуск сразу
получил пользовательский prompt, тот ждёт доказанных model/effort и не может
обогнать их.
Последующий main-side переход settings `pending → ready/failed` будит тот же
waiter второй раз. И пробуждение, и повторное чтение используют один
main-owned снимок; renderer не обязан успеть принять IPC и вернуть его через
bridge. Поэтому холодный/reloading renderer не оставляет API на однажды
прочитанном `pending`, а startup failure возвращается явно вместо ложного 504.

`send_prompt` / `Status: sent` — это delivery-only сигнал. Он подтверждает, что prompt доставлен в PTY/agent tab, но не ждёт завершения ответа. Для ручной инспекции уже открытой сессии history-tools того же Terminal MCP читают `list_open_sessions` → `busy/status` → targeted turn/text. Для долгой делегации этот цикл запрещён: `delegate_to_session` создаёт persistent run, после чего текущий assistant-turn заканчивается. Completion-уведомление приходит отдельным следующим user-turn, и только он вызывает `get_delegation_result` ровно один раз. Чтение result/status/transcript до этого уведомления является polling и не доказывает штатный flow. Так 30-минутный turn не держит HTTP/MCP-вызов и переживает restart.

Вложенная делегация сохраняет ту же модель. Когда target активного run сам вызывает `delegate_to_session`, Project API связывает новый вызов через `parentRunId`; `waitForDescendants` по умолчанию не даёт target отчитаться наверх, пока его дочерняя ветка не закончена и результат не обработан следующим turn. Это зависимость durable run, а не visual-child вкладки и не встроенный Claude/Codex subagent. Ранний отчёт разрешается только явным `waitForDescendants:false`; progress/status polling не заменяет этот параметр.

У Codex один provider-turn может пройти через context compaction без второго
пользовательского сообщения. History показывает compact и post-compact
продолжение отдельными навигационными строками, но `get_delegation_result`
собирает все assistant-блоки исходного реального turn до следующего реального
user message. Иначе длинный E2E-run возвращал только вводные комментарии до
compact, хотя финальный ответ уже был записан перед `task_complete`.

Наличие хотя бы одного assistant-блока не является готовым результатом. Для
Codex нужен `task_complete` того же turn, для Claude — конечный `stop_reason`;
до этого `/result` остаётся `ready:false`, а completion-уведомление не
отправляется. Финальная проверка обходит обычный JSONL-кэш: task-complete может
дописаться, пока другой читатель ещё заканчивает старый снимок с тем же
размером/mtime. Это сохраняет контракт «одно уведомление → один fetch» и не
требует polling или таймаута.

`get_session_progress` решает другой сценарий: по явному запросу посмотреть, какие структурные операции появились в уже существующей сессии после прошлого просмотра. Клиент возвращает opaque cursor из предыдущего ответа; сервер не хранит watermark и не решает за агента, что уже прочитано. Если Rewind/fork заменил ветку и cursor больше не принадлежит текущей истории, ответ явно помечает reset вместо молчаливого пропуска. Этот метод не является completion-gate: готовность по-прежнему определяется `busy/status`, а progress не возвращает полные аргументы и результаты инструментов.

`/terminal/ai-prompt` с `submit=true` для Claude **и Codex** не пишет в PTY напрямую: main пересылает запрос в renderer scenario layer (`sendAgentPromptScenario`) — тот же путь, что History Enter / Project API / Inbox. Это даёт MCP-отправке готовность/queue/audit-проверки и статус-паритет: `submitted_unverified` возвращается как HTTP 202 (доставлено в TUI, durable-подтверждение ещё не пришло), а не теряется. Прямой `safePasteAndSubmit` остался только для paste-без-submit (`submit=false`) и Gemini, у которого нет scenario runtime. Следствие: если renderer недоступен (окно перезагружается), Claude/Codex submit вернёт ошибку bridge, а не молча вставит байты в PTY.

Два fail-closed edge этого маршрута. (1) Bridge-timeout (60с) ≠ ошибка доставки: renderer-сценарий может законно жить дольше (launch-if-needed + readiness + paste) и всё ещё доставить prompt — ответ в этом случае HTTP 202 `delivery_unknown` с предупреждением не повторять тот же prompt вслепую; повтор в живую AI-сессию хуже неизвестного статуса (тот же принцип, что completion prompt после rebuild выше). (2) Если renderer ещё не гидрировал workspace store (запрос сразу после старта приложения), сценарий не сваливается в Claude SDK fallback — для MCP-источников это была бы отправка НЕ тем агентом в Codex-вкладку; возвращается явная ошибка «tab not resolved yet, retry after load».

`build_install_noted_terminal` — исключение из обычных terminal-actions: это fire-and-forget
handoff в Voice Record, а не команда в текущей PTY. Использовать его, когда агент внутри
Noted Terminal должен инициировать `npm run build:install` самого Noted Terminal. Tool
передаёт `returnTo` исходного tab/session в Voice Record и сразу возвращает job id. Перед
самой сборкой Voice Record ждёт, пока все соседние сессии (вкладки/проекты с живым turn'ом
или running-процессом) уйдут в idle — **вызвавшую вкладку исключает**, иначе дедлок; прогресс
в `job.phase`/`job.wait` (см. `fact-build-when-idle.md::Observe-фаза`). После рестарта callback
в Voice Record ждёт восстановления именно этой вкладки/сессии и сам
отправляет completion prompt через `/terminal/ai-prompt`. Нельзя заменять это на
`run_command("npm run build:install")` или чтение terminal output: управляющая вкладка будет
убита install-процессом, а readiness после рестарта определяется через MCP `/terminal/tabs`,
не через таймаут.

Completion prompt после rebuild — **одноразовая доставка**. Если Voice Record уже нашёл
исходную tab/session и `/terminal/ai-prompt` начал handoff, дальнейший `submitted_unverified`
или timeout не является разрешением повторить тот же prompt: целевая Codex/Claude TUI могла
уже получить ввод, а доказательство могло сорваться на audit/readiness edge. Повтор здесь хуже
ошибки статуса — пользователь получает несколько одинаковых команд в живой AI-сессии.

Единый namespace не отменяет внутреннюю границу: live-действия идут через scenario layer, чтение/редактирование прошлого — через history backend. Не пытаться реализовать Codex orchestration через rewrite rollout JSONL: Codex history append-only и не имеет Claude edit-range модели.

## План задач и дочерний файл

Блок в левом верхнем углу вкладки — структурированный план задач: `get_tab_plan` читает его, а `apply_tab_plan_changes` атомарно применяет только заранее показанный и подтверждённый пользователем пакет операций. Старое поле `tab.notes` остаётся совместимостью удалённой Markdown-поверхности и не выставляется как новый публичный метод. `list_notes` — третья, независимая сущность: пользовательские якоря Timeline.

`link_file` не создаёт новую иерархию. Он вызывает тот же renderer-сценарий, что desktop Link File/DnD: `tabType='file'`, `visualParentTabId=<AI tab>`, inherited `groupId`, background creation. Путь сначала canonicalize/проверяется сервером; повтор той же пары canonical file + parent возвращает существующий file-tab. Без `tabId` файл прикрепляется к родительской полноценной сессии, с явным `tabId` — к другой открытой AI-вкладке, в том числе другого проекта.

Полноценные AI-сессии используют ту же визуальную связь, но остаются самостоятельными процессами. `create_tab` и `delegate_to_session` по умолчанию создают связанную новую сессию как visual-child вызывающей вкладки, когда обе находятся в одном проекте; `placement='root'` оставляет независимую работу на верхнем уровне. Для другого проекта без явно переданного `parentTabId` безопасный default — root, а делегация в уже существующий target никогда не меняет его место в иерархии.

Одноразовый исполнитель не закрывается автоматически до чтения результата. После `get_delegation_result` вызывающий агент завершает disposable-flow через `close_tab`; метод по умолчанию отказывается закрывать busy-вкладку, а `force` допустим только как явное destructive-решение. Долгоживущую сессию, предназначенную для продолжения работы, этот cleanup не затрагивает.

## MCP activity events

Mutating HTTP routes (`run_command`, `restart_process`, `run_chain`, `create_tab`, `kill_process`, `send_prompt`, `start_ai`, `stop_ai`) эмитят `terminal:mcp-activity` в renderer. Событие несёт `sourceMeta` (кто вызвал MCP), target project/tab, action и status (`running`/`sent`/`completed`/`error` и т.п.). StatusBar показывает это как глобальный `MCP` chip, потому что запрос может прийти из внешней локальной нейронки или соседней вкладки, не из текущего UI-контекста.

Passive reads (`list_tabs`, `read_output`) намеренно молчат. Иначе каждый inspection-loop агента превращает StatusBar в шум, хотя пользовательского действия над вкладкой не было.

## Soft Restart (Ctrl+C → re-run)

### Отброшенный подход: Hard Kill (pty.kill + recreate)
Первая реализация убивала PTY через `pty.kill()` и пересоздавала новый через IPC `terminal:mcp-restart` → renderer → `terminal:create`.

**Почему не работает:**
- `onExit` удаляет все Maps (terminals, terminalOutputBuffer, terminalCommandState) → `read_output` возвращает 404
- xterm показывает `[Process completed]` — ввод невозможен до пересоздания PTY
- Race condition: kill + IPC round-trip через renderer + create — 3 async шага с непредсказуемым timing
- Ctrl+C в shell запущенном через `-c "cmd; exec shell"` убивает весь PTY, не только cmd

### Текущий подход: Soft Restart
Тот же механизм что UI кнопка restart в TabBar.tsx:
1. **Ctrl+C** (`\x03`) → останавливает текущий процесс
2. **Ждёт OSC 133;D** (command-finished) — детерминированно через `terminalCommandState.isRunning`
3. **300ms пауза** для полного рендера prompt
4. **Re-run**: `term.write(restartCmd + '\r')`

Shell остаётся живым. Output buffer не теряется. PTY pid не меняется.

### Edge Cases
- **Process уже мёртв** (`isRunning = false`): Ctrl+C безвредно идёт в prompt, ожидание пропускается, команда отправляется сразу
- **Electron graceful shutdown**: electron-vite может завершаться 2-5 секунд. Timeout увеличен до 30s
- **initialCommand не сохранён** (пользователь набрал вручную): возвращается ошибка с требованием передать `command` параметром. Fallback `!!` убран — ненадёжен (пустая history, неправильная команда)
- **Ctrl+C trap**: Некоторые процессы ловят SIGINT. 30s safety timeout покрывает, но в теории возможны две копии процесса если timeout сработает до реального завершения

## Output Ring Buffer
`terminalOutputBuffer` — Map<tabId, {ring: Array(500), head, count, maxLines}>. Circular buffer с O(1) записью на строку. Заполняется синхронно в `ptyProcess.onData` (без await — anti-pattern: async onData race). Удаляется в `onExit`.

**Ловушка (апрель 2026):** Первая реализация была `{lines: string[]}` с `push() + splice(0, excess)` — O(n) splice на каждом onData чанке. При 15+ табах с активными Claude это давало ~750 splice/сек в main event loop, что вместе с Timeline backtrace polling вызывало thermal throttling (kernel_task до 200%). Симптом: macOS становится медленным даже после остановки всех Claude-процессов — память под давлением, page-out, kernel жонглирует страницами.

## Развёртывание
Repo source — `mcp/terminal-server.mjs`, установленная копия — `~/.claude/mcp/terminal-server.mjs`. Claude и Codex регистрируют только имя `terminal`; отдельной регистрации `overseer` нет. Skill-source живёт в `~/.claude/skills/terminal/` и автоматически зеркалится в `~/.codex/skills/terminal/`.

Каноническая установка выполняется `npm run install:terminal-mcp`. Установщик атомарно копирует repo source, сохраняет резервные копии изменяемых конфигов и точечно нормализует регистрацию Claude/Codex, не перезаписывая другие MCP и не печатая секреты. В `env_vars` регистрации обязательно прокидываются `NOTED_MAIN_PID`, `NOTED_PARENT_PROJECT_ID` и `NOTED_PARENT_TAB_ID`: MCP-процесс, запущенный Codex/Claude, не получает эти значения автоматически только потому, что их имел родительский CLI. Dry-run и повторный запуск должны быть идемпотентны.

Каноническое направление развёртывания — только из repo source в установленную копию. Обратное копирование опасно: установленный сервер может отставать и стереть новые методы из актуального source. Перед заменой нужно сравнить обе копии, после неё — проверить `tools/list` именно у установленного сервера.

Claude и Codex получают схему MCP-инструментов при старте своей сессии. Уже работающая сессия не увидит добавленный или удалённый метод после одной синхронизации файла: симптомом будет метод в source и документации, но его отсутствие в доступном наборе tools. После развёртывания нужен restart/reconnect AI-сессии; один restart Electron или build без переподключения клиента этого не доказывает.
