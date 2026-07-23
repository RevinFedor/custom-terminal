# Feature: Terminal MCP Server

## Intro
MCP-сервер для управления терминальными вкладками из AI-агента (Claude Code, Codex CLI, Gemini CLI). Позволяет агенту видеть запущенные dev-серверы, перезапускать процессы после изменения кода, читать output, выполнять build-цепочки и управлять живыми AI CLI во вкладках — без ручного переключения вкладок пользователем.

## Архитектура

### Два MCP-сервера, один HTTP backend
Проект использует два отдельных MCP-сервера, и оба ходят в один и тот же main-process HTTP:
- `.claude/mcp/terminal-server.mjs` — Terminal Management (tabs, restart, run, output, AI live control). *Оператор*: что сейчас крутится, запустить/отправить prompt/остановить.
- `~/.claude/mcp/overseer-server.mjs` — контроль сессий (чтение + редактирование истории через `/overseer/*` endpoints). *Историк/редактор*: что сессия сделала, прочитать/переписать транскрипт. Полная механика — [`fact-overseer-mcp.md`](fact-overseer-mcp.md).

Граница по blast radius: terminal MCP может убить dev-сервер, overseer MCP — переписать JSONL. Оба общаются с main process через один и тот же HTTP-сервер (`mcpHttpServer` на localhost). Порт обнаруживается через `~/.noted-terminal/mcp-port-<PID>` (см. [`fix-mcp-multi-instance.md`](fix-mcp-multi-instance.md)).

### Определение проекта
MCP-сервер определяет проект через `process.cwd()` (как knowledge-server). Это позволяет одному серверу обслуживать любой проект без конфигурации. Main process находит проект в SQLite по path и отдаёт только его вкладки.

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

`send_prompt` / `Status: sent` — это delivery-only сигнал. Он подтверждает, что prompt доставлен в PTY/agent tab, но не ждёт завершения ответа. Completion и финальный текст читать через Overseer (`list_open_sessions` → `busy/status` → `session_stats/list_turns/get_assistant_text`), иначе агент начинает парсить TUI-output и преждевременно объявляет long-running Claude «не ответившим».

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

Граница с Overseer: если нужно узнать, что агент уже сделал, читать session history через overseer. Если нужно заставить живую вкладку что-то сделать сейчас, использовать terminal MCP. Не пытаться реализовать Codex orchestration через rewrite rollout JSONL: Codex history append-only и не имеет Claude edit-range модели.

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
Сервер копируется в каждый проект как `.claude/mcp/terminal-server.mjs`. Регистрация: `.mcp.json` (Claude) + `.claude/settings.json` (auto-approval) + `~/.gemini/settings.json` (глобальный для Gemini).
