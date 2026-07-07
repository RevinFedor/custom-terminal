# Fact: `build:i-obs` — ребилд, ждущий пока приложение освободится

## Задача
`npm run build:install` сначала гасит приложение (`graceful-quit.sh` → AppleScript quit → before-quit). Если в этот момент в проде идёт активная AI-работа или shell-команда, запущенная через `Restart after`, ребилд прервёт её. Нужна команда, которую запускают **в стороннем терминале** (не внутри Noted Terminal), которая **ждёт** пока такие blocker'ы во всех проектах не станут idle, показывает прогресс, и только потом дёргает `build:install`.

Команда: **`npm run build:i-obs`** (`i` = install, `obs` = observe). Реализация — `scripts/build-when-idle.js` (чистый Node, без зависимостей).

## Что считается «активным» (блокирует ребилд)
Единый источник правды — `computeActiveLoaders()` в `src/main/main.js`. **Переиспользует те же самые live-Map'ы, что питают per-tab loader в UI** — никакого второго понятия «busy» не вводится:

| Источник | Map в main | Семантика |
|---|---|---|
| PTY Claude | `bridgeKnownSessions` + `terminals` + (`claudeTurnBusy`\|`claudeSpinnerBusy`\|`claudeLocalCommandWatchers`) + `claudePromptReady` | `busy` только когда реально идёт turn/loader/local slash command; idle-alive Claude (`claudeCliActive`, живой PTY у prompt) **не возвращается из `/api/active-loaders` вообще**. `active/starting` — это presence/status-слой, не blocker-list. Stale bridge без живого PTY (`!terminals.has`) **не** блокирует (= `inactive`) |
| SDK Claude | `sdkSessions` | одна запись = один in-flight `query()` → `busy` |
| Gemini | `geminiSpinnerBusy` | `busy` только при `=== true` |
| Codex | `codexTurnWatchers` | блокирует только rollout `task_started → task_complete/turn_aborted`; живой idle Codex CLI не blocker |
| Restart-after non-AI процесс | `terminalCommandState.isRunning` + `activeCommandSource === 'restart-after'` + (`tabs.restart_after_tab_ids` или legacy `tabs.restart_after_tab_id`) | `running`. Ручные shell-команды (`npm run dev`, `npm run build`, `./deploy.sh`) сами по себе **не блокируют** `build:i-obs`; blocker'ом становится только команда, которую реально запустил `Restart after`, пока у вкладки есть хотя бы одна trigger-подписка. AI CLI tabs исключены из этой ветки, потому что их PTY-процесс может быть живым и idle |
| Git-операции | `ipc/git.js` active operations registry | `kind:"git"` для generate/commit/undo/push/fetch/checkout пока операция in-flight. Это нужно для сценария Git run-after: AI-вкладка завершилась, Git-панель начала generate+commit, и `build:i-obs` не должен закрыть приложение между AI-trigger и фактическим commit/push |

Дедупликация по `tabId` (один таб = максимум один loader; claude-ветка выигрывает у process-ветки для того же таба).

Идемпотентно для idle-определения: `idle === (loaders.length === 0)`.

Важно для логов: `idle:true` в `/api/active-loaders` означает только «нет install-блокеров», а не «в Noted Terminal вообще нет живых процессов». Ручной `npm run dev` или idle Codex/Claude PTY могут продолжать существовать. Web-server логирует изменившиеся снимки как `[ActiveLoaders] status=... idle=... count=... kinds=... tabs=...`, поэтому диагностика `build:i-obs` должна читать этот смысл, а не текст старого wrapper'а `already idle`.

Шрам mobile install preflight: если `terminalCommandState.isRunning` применять ко всем вкладкам без фильтра AI, `/api/active-loaders` возвращает десятки `kind:"process", status:"running"` для idle Claude/Codex табов. На iOS это выглядит как ложный alert «Terminal занят, остановите вкладки где идёт streaming/loader», хотя loader нигде не идёт. Разделитель: AI tabs блокируют install только через свои deterministic busy-сигналы выше; обычные shell-команды не блокируют install, кроме случая `kind:"restart-after"` — команда была запущена `Restart after` и её надо дождаться как AI-turn.

## Транспорт: переиспользует mobile web-server
Не отдельный сервер. Эндпоинт добавлен в существующий `src/main/web-server.js` (тот же что обслуживает mobile-web на порту 7878):

```
GET /api/active-loaders   (Bearer-token, тот же ~/.noted-terminal/web-token.txt)
→ { idle:bool, count:int, loaders:[{tabId,kind,status,project,name,cwd,command?,source?}], ts }
```

`computeActiveLoaders` **инжектится** в `web-server.start({ sdkSessions, computeActiveLoaders })` (не импортируется) — web-server остаётся leaf-модулем без back-reference в main. Считается в main против live-Map'ов, поэтому отвечает корректно **даже когда renderer перезагружается/расфокушен** (в отличие от bridgeRequest-пути `getClaudeTabStatusBatch`, который ходит в renderer).

**Fail-safe:** если инжекция отсутствует (старый код) — эндпоинт отдаёт `503 {idle:false}`, НЕ `idle:true`. Никогда не green-light'ит ребилд при сломанном состоянии.

## Скрипт `scripts/build-when-idle.js`

### Discovery прод-инстанса (ловушка stale-файлов)
`~/.noted-terminal/web-server-<pid>.json` копятся сотнями — приложение **никогда не удаляет** их при краше (тот же класс бага, что `~/.claude/bridge/*.json`, см. `fix-bridge-stale-takeover.md`). Фильтр прод-инстанса:
1. PID жив (`process.kill(pid,0)`)
2. `ps -p <pid> -o command=` содержит `/Applications/Noted Terminal.app` — отсекает dev-инстансы (electron-vite, порт **7979**) и реюзнутые соседом PID'ы
3. Свежайший `updatedAt` если вдруг >1 прод-копии

Прод = порт **7878**, dev = **7979** (`package.json::dev` ставит `NOTED_WEB_PORT=7979`).

### Append-only feed (НЕ self-clearing dashboard)
Соответствует ментальной модели юзера: «закрыта такая-то вкладка… все вкладки закрыты». Печатает baseline-список один раз, потом по одной строке на каждое появление (`＋ active`) / уход в idle (`✓ idle`), затем `✓ all tabs idle`. Без очистки экрана → переживает scrollback, нет хрупкой cursor-математики.

Если первый poll уже видит `idle:true`, wrapper пишет `✓ no install blockers`. Это специально не формулируется как «nothing running»: эндпоинт отвечает про безопасность install, а не про все процессы в приложении.

### Гарантии безопасности
- **`IDLE_CONFIRM=2`** (env-настраиваемо): ребилд только после N подряд idle-поллов. Гасит 1-тиковый разрыв между двумя turn'ами из очереди (turn A кончился → 0 на один полл → turn B стартанул).
- **Failed poll ≠ idle**: таймаут/сетевой блип сбрасывает `idleStreak=0`, не считается за idle.
- **Старый билд без эндпоинта** (404): печатает «predates /api/active-loaders», просит разовый `build:install` для бутстрапа, exit 2. НЕ строит вслепую.
- **Прод не запущен**: нечего ждать → строит сразу (или exit при `NO_BUILD=1`).

### Observe-фаза в Voice Record endpoint (НЕ wrapper-скрипт)
`build:i-obs` (wrapper `scripts/build-when-idle.js`) — команда для внешнего ручного запуска
в отдельном терминале. Voice Record endpoint `/api/terminal/build-install` этот **wrapper не
запускает** (он foreground-поллер, а Voice Record — sibling-сервис), но с июня 2026 делает
**собственную observe-фазу** против того же `/api/active-loaders` перед спавном `build:install`.

Раньше (graveyard) endpoint строил **мгновенно** без idle-проверки, полагаясь на то, что iOS
сделал preflight перед confirm. Это ломалось при AI-hop: агент в одной вкладке дёргал rebuild,
а `build:install` через `pkill` гасит **весь** прод — включая соседние проекты, где в этот
момент шёл turn. Теперь endpoint ждёт, пока все сессии **кроме вызвавшей** не уйдут в idle.

Механика observe (`observeTerminalIdle` в voice-record `web-server.js`):
- **Exclude-caller**: `returnTo.tabId` вычитается из списка блокеров. Вкладка-инициатор busy
  именно потому, что запустила rebuild — ждать её = вечный дедлок. iOS-путь без `returnTo`
  больше не делает собственный blocking preflight: телефон показывает confirm/status, а
  решение “что можно остановить, а что надо ждать” живёт здесь, в Mac-side Voice Record.
- **Auto-stop только для обычных процессов**: исторически endpoint пробовал остановить blockers
  `kind:"process"` / devServer через `POST /terminal/stop`. Новый `/api/active-loaders` не
  возвращает ручные shell-команды как blockers, а restart-after-owned процессы отдаёт отдельным
  `kind:"restart-after"` — их нужно ждать, а не auto-stop'ить. AI/Claude/Codex/Gemini blockers
  также никогда не auto-stop'ятся, чтобы не убить turn посередине.
  Результат пишется в `wait.autoStopped`/`job.autoStopped` для desktop и iOS status UI.
  Если установленный прод ещё не знает `/terminal/stop`, Voice Record использует fallback
  Ctrl+C через старый `/terminal/run` route.
- **Discovery прода**: `web-server-<pid>.json` (живой PID) + авторитетный `isPackaged` из
  соседнего `mcp-port-<pid>` (тот же main PID пишет оба файла); фоллбэк — `ps`-маркер
  `/Applications/Noted Terminal.app`. Тот же stale-файл фильтр, что в wrapper'е.
- **Fail-safe сохраняет «строить даже когда прод недоступен»** (старый rationale): нет живого
  прод-инстанса → строить сразу; 404 (старый прод без эндпоинта, этот же build его и завезёт)
  → строить; 503/timeout/401 **никогда** не считается idle (сбрасывает streak); `IDLE_CONFIRM=2`
  подряд гасит 1-тиковый разрыв между turn'ами. Любая ошибка наблюдения → строить (явно
  запрошенный rebuild не должен застрять из-за бага в idle-watching).
- Прогресс виден в `GET /api/terminal/build-install`: `job.phase` (pending→observing→building→
  finished), `job.wait.blockers` (какая соседняя сессия держит).

### AI-hop изнутри Noted Terminal
Когда rebuild инициирует агент внутри самого Noted Terminal, он не должен запускать
`npm run build:install` в своей PTY-вкладке: управляющий процесс умрёт вместе с приложением.
Terminal MCP tool `build_install_noted_terminal` передаёт задачу в Voice Record
`POST /api/terminal/build-install` с `returnTo` (`tabId`, `sessionId`, `projectId`,
`projectPath`). MCP tool сразу возвращает job id; ожидание соседей (observe-фаза выше) и
ожидание рестарта (callback ниже) живут в Voice Record — вызвавший агент не блокируется.

После exit build-команды Voice Record не использует фиксированный sleep. Он читает live
`~/.noted-terminal/mcp-port-*`, фильтрует живые PID и проект, предпочитает packaged-инстанс,
дёргает `/terminal/tabs?color=` и ждёт, пока исходный tab существует, PTY alive, а `sessionId`
снова совпал. Только после этого callback шлёт completion prompt через `/terminal/ai-prompt`.
Это защищает кейс, где после install восстанавливается 20+ вкладок и нужная AI-сессия появляется
позже самого окна. Статус callback виден в Voice Record `GET /api/terminal/build-install`
(`returnTo`, `callback`, `logTail`).

Callback delivery должен быть **idempotent-by-classification**, а не "retry until HTTP 200".
`/terminal/ai-prompt` может ждать Codex startup prompts (`Update available`, directory chooser,
MCP startup) дольше обычного HTTP timeout'а, а после paste может вернуть audit/turn-watcher
ошибку уже **после того как Enter ушёл в TUI**. Voice Record поэтому ретраит только состояния,
где terminal input точно не трогался (нет живого target / target ещё не восстановлен). Если
ответ/ошибка говорит `submitted:true`, `submitted_unverified`, `codex_paste_not_visible_*`,
`codex_draft_state_unknown_after_paste`, `codex_user_message_audit_mismatch`,
`codex_turn_watcher_closed_before_user_message` или просто POST timeout после handoff'а,
job фиксируется как `sent_unverified` и повторно тот же completion prompt не отправляется.
Пользовательский симптом нарушенного контракта — после install в AI-вкладку много раз падает
одна и та же строка `Build install completed...`; лечить это увеличением sleep нельзя, потому
что причина не задержка, а неразличение "не доставлено" и "доставлено, но не доказано".

### Env-кнобы
`POLL_MS=1000`, `IDLE_CONFIRM=2`, `NO_BUILD=1` (только наблюдать), `PORT=7878` (форсить порт, минуя discovery — для теста).

## Тестирование без ребилда
`web-server.js` требует electron (`ipcMain`/`app`/`BrowserWindow`). Для headless-харнесса замокать через `Module._load` shim (`require('electron')` → fake), `start({sdkSessions:new Map(), computeActiveLoaders: ()=>mockState})`, дёргать скрипт с `PORT=<mockport>`. Логика `computeActiveLoaders` юнит-тестится копией функции с mock-Map'ами (stale-bridge skip, дедуп, gemini=false, teardown→idle).

## Связанное
- `fact-claude-stop-hook.md` — откуда `claudeTurnBusy` (authoritative busy)
- `fix-claude-busy-detection.md` — cleanup busy-Map'ов на exit/stop (почему stale-bridge без PTY = не busy)
- `fact-mobile-web.md` — host web-server, токен, discovery-файлы
- `fact-terminal-mcp.md` — `terminalCommandState` (OSC 133 B/D → isRunning)
