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

Явный `send_prompt` с `submit=true` является разрешением вернуть адресованную AI-вкладку в рабочее состояние. Остановленный процесс возобновляется общим send-сценарием; закрытая вкладка сначала восстанавливается в фоне из единственной архивной записи с тем же исходным `tabId`, после чего тот же сценарий поднимает прежнюю Claude/Codex-сессию и выполняет отправку. Архивная запись, рабочая папка и восстановленная вкладка проверяются до Enter. Удалённая запись, два архива с одним identity, другой тип вкладки или недоступная папка дают явную ошибку: создавать «похожую» новую сессию запрещено. Пассивный lifecycle/restart reconcile вкладку не открывает — закрытие пользователем сохраняет силу, пока не придёт новый явный send. `submit=false` остаётся операцией над уже живым composer и сам вкладку не восстанавливает.

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

`send_prompt` / `Status: sent` — это delivery-only сигнал. Для остановленной или восстановленной вкладки он включает ожидание запуска, но возвращается только после принятия prompt целевым агентом; завершения ответа он не ждёт. Для ручной инспекции уже открытой сессии history-tools того же Terminal MCP читают `list_open_sessions` → `busy/status` → targeted turn/text. Для долгой делегации этот цикл запрещён: `delegate_to_session` создаёт persistent run, после чего текущий assistant-turn заканчивается. Completion-уведомление приходит отдельным следующим user-turn, и только он вызывает `get_delegation_result` ровно один раз. Чтение result/status/transcript до этого уведомления является polling и не доказывает штатный flow. Так 30-минутный turn не держит HTTP/MCP-вызов и переживает restart.

Вложенная делегация сохраняет ту же модель. Terminal MCP передаёт Project API точный контекст текущего source-turn; только его совпадение с конкретным исполняемым входящим run разрешает автоматический `parentRunId`. Само наличие A→B не делает независимый ручной B→C его ребёнком. `waitForDescendants` по умолчанию не даёт target отчитаться наверх, пока его дочерняя ветка не закончена и результат не обработан следующим turn. Это зависимость durable run, а не visual-child вкладки и не встроенный Claude/Codex subagent. Ранний отчёт разрешается только явным `waitForDescendants:false`; progress/status polling не заменяет этот параметр.

Входящий run получает этот контекст не от generic `busy` по `tabId`, а вместе с exact post-Enter proof собственного prompt. Это закрывает порядок, где `UserPromptSubmit` уже создал новый ход, а Project API ещё не успел отметить transport acceptance. Совпадение provider/session обязательно; повтор одного proof идемпотентно дополняет отсутствующий контекст и никогда не заменяет уже доказанный соседним turn. У Codex audit и `task_started` допустимы в обоих порядках: ранний audit дожидается start-события, а ранний start прикрепляется к следующей exact `user_message` записи того же хода. Polling и угадывание по `tabId` не используются; неоднозначность остаётся root с diagnostic.

У Codex один физический provider-turn может пройти через несколько compaction,
внутренние `subagent_notification` и обычные пользовательские уточнения без нового
`task_started`. Поэтому пользовательское сообщение само по себе не разрывает
результат orchestration-run. Точный UUID/hash сначала доказывает исходный prompt,
после чего сохранённые provider, session, process generation и `turnId` ограничивают
одну физическую задачу: результат собирается от её `task_started` до
`task_complete` либо `turn_aborted` с тем же `turnId`. Новый `task_started` —
жёсткая граница; конфликт или несколько подходящих prompt остаются неподтверждёнными.
Для старых run без точного `turnId` сохраняется прежний bounded UUID/hash fallback.

У Claude встроенный async `Agent`/`Task` не является дочерним Terminal MCP-run,
но тоже не разрешает исходной делегации завершиться раньше времени. После
структурно подтверждённого запуска внутреннего исполнителя первый `Stop` Claude
считает только концом промежуточного среза: durable run остаётся активным,
унаследованный loader не исчезает, completion-уведомление и auto-stop не
запускаются. Когда Claude доставляет точный служебный carrier
`<task-notification>` или `<agent-message>`, он продолжает результат исходного
prompt, а не создаёт новый пользовательский ход; итоговый result включает текст
до и после такого carrier.

Связь не выводится из обычного текста или одного `tabId`. Живую внутреннюю работу
доказывают структурные tool-use/result записи той же Claude session, а следующий
служебный ход принимается только для единственного ожидающего run с тем же
provider/session/process owner. Обычный пользовательский prompt и похожий
незакрытый XML-текст не усыновляют ожидание. После restart сохранённый run может
завершиться по transcript только если после его промежуточного `Stop` появился
новый служебный carrier и последний продолженный сегмент имеет конечный
`stop_reason`; старый `end_turn` до carrier недостаточен.

Наличие хотя бы одного assistant-блока не является готовым результатом. Для
Codex нужен `task_complete` или `turn_aborted` того же точного provider-turn, для Claude — конечный `stop_reason`;
до этого `/result` остаётся `ready:false`, run остаётся видимым как проверка
результата и блокирует completion/install. Read-back сначала пинится к точному
UUID target-prompt; текстовый hash используется только для legacy run без UUID,
внутри нижней и верхней временных границ и только при одном совпадении. Финальная
проверка обходит обычный JSONL-кэш: task-complete может дописаться, пока другой
читатель ещё заканчивает старый снимок с тем же размером/mtime. Это сохраняет
контракт «одно уведомление → один fetch» и не требует polling или таймаута.

`get_session_progress` решает другой сценарий: по явному запросу посмотреть, какие структурные операции появились в уже существующей сессии после прошлого просмотра. Клиент возвращает opaque cursor из предыдущего ответа; сервер не хранит watermark и не решает за агента, что уже прочитано. Если Rewind/fork заменил ветку и cursor больше не принадлежит текущей истории, ответ явно помечает reset вместо молчаливого пропуска. Этот метод не является completion-gate: готовность по-прежнему определяется `busy/status`, а progress не возвращает полные аргументы и результаты инструментов.

`complete_task` — отдельный self-only сигнал готовности текущей задачи, а не команда остановки процесса и не результат оркестрации. Метод не принимает target: родительская вкладка берётся из `NOTED_PARENT_TAB_ID`, а main принимает вызов только во время её точного текущего Claude/Codex turn. Вызов регистрирует одноразовый intent и сразу отвечает; готовность считается доказанной лишь после последующего авторитетного успешного конца того же turn. Duplicate-call идемпотентен, старый intent не переносится на следующий turn, а error/interrupt/manual stop/PTY exit не могут превратить вызов в ложный успех.

Исходящий orchestration-run той же вкладки блокирует `complete_task`, пока идёт работа исполнителя, доказательство полного результата или completion-handoff в source; recovery и ошибка доставки также остаются блокерами решения, хотя не изображаются активным shimmer. После доказанного начала отдельного follow-up хода смысловая обработка уже полученного результата принадлежит агенту и системной инструкции, а не выводится сервером из текста. Эта граница не обходится `waitForDescendants:false`, потому что тот параметр управляет отчётом конкретного durable run, а не готовностью всей текущей задачи. Основной потребитель сигнала — Prompt Queue Loop: точный успешный outcome выключает Loop до reconciliation, не удаляя обычные queued prompts.

`/terminal/ai-prompt` с `submit=true` для Claude **и Codex** не пишет в PTY напрямую: main пересылает запрос в renderer scenario layer (`sendAgentPromptScenario`) — тот же путь, что History Enter / Project API / Inbox. Это даёт MCP-отправке готовность/queue/audit-проверки и статус-паритет: `submitted_unverified` возвращается как HTTP 202 (доставлено в TUI, durable-подтверждение ещё не пришло), а не теряется. Прямой `safePasteAndSubmit` остался только для paste-без-submit (`submit=false`) и Gemini, у которого нет scenario runtime. Следствие: если renderer недоступен (окно перезагружается), Claude/Codex submit вернёт ошибку bridge, а не молча вставит байты в PTY.

**Одна квитанция для Project API, Inbox, Terminal MCP и orchestration.**
Если нижний слой вернул `submitted:false`, Enter не пересечён: HTTP 409 разрешает
осмысленный retry. Если `submitted:true`, но exact JSONL/rollout audit ещё не
пришёл, ответ — HTTP 202 `audit-pending` с исходным `handoffId`; Terminal MCP
объясняет, что повторять prompt нельзя. Только exact audit того же handoff даёт
HTTP 200 `sent`. Target-run и completion notification сохраняют этот handoff до
поздней сверки; транспортный callback не может откатить уже найденный exact
proof, а Retry в `audit-pending` не выполняет второй physical send. Inbox
привязывает поздний audit ещё и к provider/session/prompt hash, поэтому
одинаковый текст соседней операции не является подтверждением.

Есть отдельный конечный исход после физического Enter: Claude уже получил
paste и Enter, но не создал provider-turn, а точная повторная проверка после
остановки loader нашла в composer исходный текст без изменений и не нашла новой
user-записи после сохранённой transcript-границы. Такая квитанция называется
`provider-not-accepted`: она сохраняет `submitted:true`, потому что Enter уже
пересёк транспорт, но возвращается как явная HTTP 409 / Terminal MCP error и
сразу завершает orchestration ошибкой без recovery grace. Исходный draft не
очищается, тот же handoff не отправляется повторно, а поздний generic audit не
может повысить эту конечную квитанцию до success. Claude может сам заменить
отдельные строки с существующими абсолютными путями изображений на `[Image #N]`
ещё внутри composer. Это тоже является точным отрицательным proof только когда
после удаления этих известных строк и созданных Claude-маркеров весь остальной
текст совпадает побайтно, количества совпадают и каждый image ref успешно
материализован. Лишнее/потерянное изображение, изменённый или смешанный draft,
несинхронный снимок и любая неоднозначность остаются `audit-pending`, а не
превращаются в этот исход.

Для разбора неподтверждённого Claude Enter main удерживает ограниченную
причинную трассу только в памяти: изменения composer, PTY-байты между
зафиксированными кадрами и точные границы paste/Enter/Ctrl+G. Обычная успешная
отправка не создаёт файл. Если после остановки авторитетного хода повторная
проверка всё ещё даёт `provider-not-accepted` или неоднозначный post-Enter
исход, в каталоге логов атомарно сохраняется приватный (`0600`) файл
`terminal-send-forensics-claude-<tab>-<timestamp>-<attempt>.json`. Он привязан
к конкретной физической попытке и поколению процесса, поэтому одновременные
handoff не перезаписывают друг друга. Если точный user-turn материализуется
позже, файл этой попытки удаляется; трасса не является доказательством доставки
и не разрешает повторный Enter. Теги журнала: `[ClaudePostEnterForensics]`.

Обычная отправка из desktop History является ещё одним caller-ом той же
квитанции, а не отдельным renderer-only исключением. Когда операция достигает
головы общей PTY-очереди, main сначала сохраняет в SQLite точные `handoffId`,
номер физической попытки и ключ операции, и только затем может пересечь Enter.
Строка `SENDING/CONFIRMING` в History — лишь быстрая проекция этой квитанции.
Поздний audit может завершить только ту же попытку; audit попытки A не закрывает
повтор B даже при одинаковом тексте и `handoffId`. При закрытии и повторном
открытии History renderer сверяет только ограниченный локальный список строк с
актуальным снимком квитанций: отсутствие строки в UI не считается удалением, а
подтверждённая/отменённая операция не может воскреснуть как `SENDING`.

При restart main сначала ограниченно читает только точный transcript-диапазон
после сохранённой pre-Enter границы и лишь затем разрешает History, Project API
и Inbox восстановить квитанции. Один exact post-boundary turn переводит запись
в `confirmed`; отсутствие записи и неоднозначность не дают права на второй
Enter. Тот же контракт используют обычные Prompt Queue и Loop: Queue связывает
операцию с долговечным item ID, Loop — с item ID и конкретным причинным outcome,
поэтому renderer restart не повторяет уже возможную отправку. Slash-команды
очереди пока намеренно исключены: обычный `user_message` не доказывает
завершение локальной команды, для них нужен отдельный command-specific receipt.

При renderer remount сохранённая квитанция публикуется одной конечной записью:
`audit-pending` становится `CONFIRMING`, а `confirmed` становится `SENT` только
пока точная каноническая user-строка ещё не показана History. Hydration не
создаёт промежуточный `SENDING`, который успел бы попасть в локальный cache и
пережить уже подтверждённую отправку.

Подтверждение доставки и завершение временного показа — разные долговечные
факты. Exact audit сохраняет Claude `entryUuid` либо Codex `sourceIdentity` и
каноническое ISO-время. Когда History находит именно эту строку, main принимает
presentation ACK только для той же operation/attempt/surface/tab/handoff,
provider, audit-session и exact row identity; совпадение текста или времени не
достаточно. ACK записывается в ту же SQLite-строку квитанции и сбрасывается при
новой физической попытке. После ACK remount не создаёт локальный `SENT`, но всё
ещё может очистить его старую renderer-копию. На холодном owner подтверждённая
квитанция ждёт первого чтения канонической History, чтобы не появиться в хвосте
на один кадр перед уже сохранённым ответом. ACK failure не скрывает
каноническую строку; следующий remount повторяет exact reconciliation.

`submitted:false` обязателен не только у физического paste, но и у каждого
раннего отказа scenario layer, случившегося до вызова prompt-runtime: неизвестный
composer, конфликт/неудачный grab и незавершённая настройка Claude. Одних
`success:false`/`ok:false` недостаточно: без явной границы сервер обязан считать,
что Enter мог пересечься, сохраняет `delivery-unknown` и блокирует следующего
predecessor. Точный no-Enter receipt сразу завершает run ошибкой, убирает его из
target/inherited loader и позволяет новому явно созданному run занять ту же
serialization-lane. То же освобождение выполняет точный `provider-not-accepted`,
но он не даёт retry-authority старому handoff: Enter уже был, поэтому продолжение
возможно только новым явным действием после решения сохранённого draft. Ни один
из этих путей не является автоматическим повтором.

Если renderer получил сценарий, но его ответ не вернулся, это отдельное HTTP
202 `delivery-unknown`: Enter мог как пересечься, так и не пересечься. Сервер
сохраняет handoff для позднего exact audit, не делает автоматический replay и не
выдаёт неизвестный исход ни за `submitted:false`, ни за `sent`. Это состояние
одинаково проходит через прямую отправку, Inbox, target-run и completion.

Дедлайн HTTP/renderer-моста не уничтожает точную попытку отправки. Если ответ
сценария пришёл сразу после дедлайна и доказывает `submitted:false`, именно этот
run немедленно получает исходную ошибку вместо вечного `sending` и общей
recovery-паузы. Если ответ не пришёл вообще, после restart попытка остаётся
`delivery-unknown`: повторный Enter не разрешён, а исход может уточнить только
точный audit. Это различие нужно потому, что транспортный envelope может быть
успешным, хотя вложенный сценарий семантически отказал ещё до submit.

Выбранный агент и модель проверяются как одна пара до резервирования run,
создания/восстановления target и запуска сценария. Известная Codex-модель не
может уйти в Claude и наоборот; сервер не меняет провайдера и не подставляет
другую модель молча. При этом проверка не является закрытым каталогом shipping
моделей: неизвестный custom id остаётся у явно выбранного провайдера и
проверяется его runtime. Один контракт действует для новой и существующей
вкладки, прямого Project API/Inbox, orchestration и Terminal MCP start/send.

Для Claude orchestration и Project API сначала разрешают значение по сохранённым
строкам Settings: точный `id` имеет приоритет, а уникальный стабильный `key` или
отображаемый `label` превращается в точный `id`. Если имя подходит нескольким
вариантам, например 200K и 1M одной модели, запрос отклоняется до создания run;
неизвестный custom id по-прежнему передаётся выбранному runtime без закрытого
allowlist. Канонический id входит в fingerprint и delivery intent, поэтому
закрытие вкладки, очередь и restart не возвращают исходный alias. Это важно для
Claude: app-default может успешно установить `claude-opus-5[1m]`, но поздняя
команда `/model opus` переключает уже готовую вкладку на 200K. Поэтому raw alias
нельзя сохранять как per-send override после точного startup-default.

Критическая wiring-граница этого контракта находится до HTTP-классификации.
Общий Claude runtime обязан передать требование дождаться `UserPromptSubmit`
через `terminal:paste` до физического владельца Enter; иначе успешная запись
байта выглядит как точный `200`, хотя audit ещё только поставлен в очередь.
Codex History может смягчить post-Enter timeout для локального интерфейса, но
обязан сохранить `audit-pending` в результате: `success:true` без этой пометки
так же ошибочно превращается во внешний `200`. Серверный тест, который
подменяет renderer готовым receipt, не доказывает эти два живых caller-path.

Per-send Think является таким же writer-ом поля ввода, как prompt. Открытие и
закрытие picker происходит внутри общей PTY-очереди, меняет identity ввода и
считает переход завершённым только после полного синхронизированного кадра из
main-owned headless snapshot. Differential PTY-кусок с первым маркером конца
перерисовки является только wake-up и не доказывает, что в кадре одновременно
есть `Enabled`, `Disabled` и выбранный пункт. После изменения состояние один раз
перечитывается повторным открытием picker и окно доказанно закрывается; только
тогда разрешается свежий composer proof. Поэтому proof, снятый до picker, не
может разрешить последующую отправку, а таймер, часть перерисовки или порядок
нажатых клавиш сами по себе не считаются успехом.

Copy/Grab/Restore через Ctrl+G — также полноценные PTY writer-операции. Весь
external-editor roundtrip занимает общую write-очередь и повышает identity ввода
ровно перед Ctrl+G: capture, вставка prompt и Enter больше не могут физически
пересечься. Main сначала подписывается на возврат TUI и только затем отвечает
helper-у: для Claude завершение доказывает полный synchronized frame, для Codex
— первый PTY-output после выхода helper. Timeout означает unknown/failure, а не
готовность к следующей записи. Exact setting retry/clear и старый clear-input не
имеют отдельного fire-and-forget пути. Если native Rewind уже владеет очередью,
он вызывает внутреннюю границу capture без повторного lock. Перенос задач из
TaskPlan использует main-side compare-and-swap: замена происходит только если
input после точного чтения всё ещё побайтно равен ожидаемому; более новый текст
пользователя остаётся нетронутым. Generic `terminal:paste` сохраняет raw
paste (`submit=false`) и быстрые non-Claude пути, но автоматический Enter в
живой Claude разрешает только полный semantic-send профиль с draft proof,
handoff и ожиданием audit; неоднозначный legacy caller отклоняется до байтов.
Stop, пришедший во время per-send `/model`/`/effort`/Think, проверяется внутри
каждого шага: уже доказанная команда не откатывается, но оставшиеся настройки и
пользовательский prompt больше не выполняются.

Portable image marker является намерением вложить файл только когда внутри указан абсолютный filesystem path. Относительный путь или prose-пример проходит в prompt дословно, не занимает image-slot и не запускает staging; документация с буквальным `[imagePath: example only]` не должна приводить к `codex_image_path_unavailable`. Доступный абсолютный путь сохраняет обычный attachment-flow. Если абсолютный файл исчез между подготовкой и отправкой, это не отменяет весь prompt: marker становится позиционным `imageError`, а окружающий текст и остальные вложения отправляются. В UI известная недоступность показывается постоянным предупреждением до Send; после явного Send повторный отказ всего сообщения уже не является допустимым способом сообщить о ней. Direct plan и preflight replacement обязаны проверять одну и ту же границу абсолютности.

Два fail-closed edge этого маршрута. (1) Bridge-timeout (60с) ≠ ошибка доставки: renderer-сценарий может законно жить дольше (launch-if-needed + readiness + paste) и всё ещё доставить prompt — ответ в этом случае HTTP 202 `delivery-unknown` с предупреждением не повторять тот же prompt вслепую; повтор в живую AI-сессию хуже неизвестного статуса (тот же принцип, что completion prompt после rebuild выше). (2) Если renderer ещё не гидрировал workspace store (запрос сразу после старта приложения), сценарий не сваливается в Claude SDK fallback — для MCP-источников это была бы отправка НЕ тем агентом в Codex-вкладку; возвращается явная ошибка «tab not resolved yet, retry after load».

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

Полноценные AI-сессии используют ту же визуальную связь, но остаются самостоятельными процессами. `create_tab` и `delegate_to_session` по умолчанию создают связанную новую сессию как visual-child вызывающей вкладки, когда обе находятся в одном проекте; `placement='root'` оставляет независимую работу на верхнем уровне. Новая фоновая сессия добавляется последней в уже заданном порядке: связь с родителем не даёт API права вставить её перед вручную расставленными вкладками или сделать первым ребёнком. Для другого проекта без явно переданного `parentTabId` безопасный default — root, а делегация в уже существующий target никогда не меняет его место в иерархии.

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

Каноническая установка выполняется `npm run install:terminal-mcp`. Установщик сравнивает runtime-файлы побайтно и заменяет только отличающиеся через временный файл + атомарный rename; конфиги также меняются атомарно, с backup, и точечно нормализуют регистрацию Claude/Codex, не перезаписывая другие MCP и не печатая секреты. В `env_vars` регистрации обязательно прокидываются `NOTED_MAIN_PID`, `NOTED_PARENT_PROJECT_ID` и `NOTED_PARENT_TAB_ID`: MCP-процесс, запущенный Codex/Claude, не получает эти значения автоматически только потому, что их имел родительский CLI. Dry-run и повторный запуск должны быть идемпотентны.

`npm run build:install` после успешной упаковки, но до замены и запуска `/Applications/Noted Terminal.app`, обязательно вызывает этот же `install:terminal-mcp`, а затем отдельный `install:claude-hook` для turn-event bridge. Ручной build-install, `build:i-obs` и Voice Record сходятся в одном `npm run build:install`, поэтому copy-логика не дублируется в shell/соседнем приложении. Если синхронизация runtime-интеграций падает, цепочка `&&` не устанавливает и не запускает новый backend; безопаснее временно иметь новый клиент со старым backend, чем поднять новый backend со stale-клиентом без обязательной identity metadata.

Каноническое направление развёртывания — только из repo source в установленную копию. Обратное копирование опасно: установленный сервер может отставать и стереть новые методы из актуального source. Перед заменой нужно сравнить обе копии, после неё — проверить `tools/list` именно у установленного сервера.

Claude и Codex получают схему MCP-инструментов и загружают код stdio-server при старте MCP-процесса. Замена файла на диске не является hot reload: уже работающий MCP продолжает старый код, а новая версия гарантируется только новому или перезапущенному Claude/Codex/MCP-процессу. Симптом stale deployment: repo `delegate_to_session` отправляет causal `sourceMeta`, установленная копия нет, поэтому новый backend корректно оставляет nested child root (`parentRunId=null`). Нельзя компенсировать это угадыванием parent по `tabId`; после установки нужно перезапустить именно AI/MCP-клиента и повторить nested-вызов.

Claude turn-hook имеет другую загрузочную границу: CLI запускает `node ~/.claude/hooks/noted-turn-event.js` заново для каждого `UserPromptSubmit`/`Stop`, поэтому новая runtime-копия применяется на следующем hook-событии, если регистрация уже существовала. Для causal lineage hook передаёт точный prompt только на `UserPromptSubmit`; отсутствие поля или несколько одинаковых pending audit оставляют target context непривязанным, а не разрешают backend угадать parent по вкладке.
