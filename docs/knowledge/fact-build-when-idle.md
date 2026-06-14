# Fact: `build:i-obs` — ребилд, ждущий пока приложение освободится

## Задача
`npm run build:install` сначала гасит приложение (`graceful-quit.sh` → AppleScript quit → before-quit). Если в этот момент в проде идёт активная работа (открыты Claude-табы, крутится `npm run dev`, стримит Gemini), ребилд прервёт её. Нужна команда, которую запускают **в стороннем терминале** (не внутри Noted Terminal), которая **ждёт** пока всё во всех проектах не станет idle, показывает прогресс, и только потом дёргает `build:install`.

Команда: **`npm run build:i-obs`** (`i` = install, `obs` = observe). Реализация — `scripts/build-when-idle.js` (чистый Node, без зависимостей).

## Что считается «активным» (блокирует ребилд)
Единый источник правды — `computeActiveLoaders()` в `src/main/main.js`. **Переиспользует те же самые live-Map'ы, что питают per-tab loader в UI** — никакого второго понятия «busy» не вводится:

| Источник | Map в main | Семантика |
|---|---|---|
| PTY Claude | `bridgeKnownSessions` + `terminals` + (`claudeTurnBusy`\|`claudeSpinnerBusy`\|`claudeLocalCommandWatchers`) + `claudePromptReady` | `busy` только когда реально идёт turn/loader/local slash command; idle-alive Claude (`claudeCliActive`, живой PTY у prompt) отдаётся как `active/starting`, но **не** считается blocker. Stale bridge без живого PTY (`!terminals.has`) **не** блокирует (= `inactive`) |
| SDK Claude | `sdkSessions` | одна запись = один in-flight `query()` → `busy` |
| Gemini | `geminiSpinnerBusy` | `busy` только при `=== true` |
| Codex | `codexTurnWatchers` | блокирует только rollout `task_started → task_complete/turn_aborted`; живой idle Codex CLI не blocker |
| Любой non-AI процесс | `terminalCommandState.isRunning` | `running`. **ЛЮБОЙ** non-AI `isRunning` блокирует, не только `commandType==='devServer'` — юзер просил «npm run dev тоже считается». AI CLI tabs исключены из этой ветки, потому что их PTY-процесс может быть живым и idle |

Дедупликация по `tabId` (один таб = максимум один loader; claude-ветка выигрывает у process-ветки для того же таба).

Идемпотентно для idle-определения: `idle === (loaders.length === 0)`.

Шрам mobile install preflight: если `terminalCommandState.isRunning` применять ко всем вкладкам без фильтра AI, `/api/active-loaders` возвращает десятки `kind:"process", status:"running"` для idle Claude/Codex табов. На iOS это выглядит как ложный alert «Terminal занят, остановите вкладки где идёт streaming/loader», хотя loader нигде не идёт. Разделитель: AI tabs блокируют install только через свои deterministic busy-сигналы выше; обычные shell-команды блокируют через `terminalCommandState.isRunning`.

## Транспорт: переиспользует mobile web-server
Не отдельный сервер. Эндпоинт добавлен в существующий `src/main/web-server.js` (тот же что обслуживает mobile-web на порту 7878):

```
GET /api/active-loaders   (Bearer-token, тот же ~/.noted-terminal/web-token.txt)
→ { idle:bool, count:int, loaders:[{tabId,kind,status,project,name,cwd,command?}], ts }
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

### Гарантии безопасности
- **`IDLE_CONFIRM=2`** (env-настраиваемо): ребилд только после N подряд idle-поллов. Гасит 1-тиковый разрыв между двумя turn'ами из очереди (turn A кончился → 0 на один полл → turn B стартанул).
- **Failed poll ≠ idle**: таймаут/сетевой блип сбрасывает `idleStreak=0`, не считается за idle.
- **Старый билд без эндпоинта** (404): печатает «predates /api/active-loaders», просит разовый `build:install` для бутстрапа, exit 2. НЕ строит вслепую.
- **Прод не запущен**: нечего ждать → строит сразу (или exit при `NO_BUILD=1`).

### Граница применения: не mobile install endpoint
`build:i-obs` — команда для внешнего ручного/терминального запуска, когда нужно сначала
наблюдать live Noted Terminal через `/api/active-loaders`. Voice Record endpoint
`/api/terminal/build-install` не должен запускать этот wrapper: телефон уже сделал preflight
по тому же endpoint'у перед confirm, а в момент самой переустановки Noted Terminal может быть
уже закрыт или недоступен. Для sibling-host сценария правильная команда — прямой
`npm run build:install` из `/Users/fedor/Desktop/custom-terminal`.

### AI-hop изнутри Noted Terminal
Когда rebuild инициирует агент внутри самого Noted Terminal, он не должен запускать
`npm run build:install` в своей PTY-вкладке: управляющий процесс умрёт вместе с приложением.
Terminal MCP tool `build_install_noted_terminal` передаёт задачу в Voice Record
`POST /api/terminal/build-install` с `returnTo` (`tabId`, `sessionId`, `projectId`,
`projectPath`). MCP tool сразу возвращает job id; дальнейшее ожидание живёт в Voice Record.

После exit build-команды Voice Record не использует фиксированный sleep. Он читает live
`~/.noted-terminal/mcp-port-*`, фильтрует живые PID и проект, предпочитает packaged-инстанс,
дёргает `/terminal/tabs?color=` и ждёт, пока исходный tab существует, PTY alive, а `sessionId`
снова совпал. Только после этого callback шлёт completion prompt через `/terminal/ai-prompt`.
Это защищает кейс, где после install восстанавливается 20+ вкладок и нужная AI-сессия появляется
позже самого окна. Статус callback виден в Voice Record `GET /api/terminal/build-install`
(`returnTo`, `callback`, `logTail`).

### Env-кнобы
`POLL_MS=1000`, `IDLE_CONFIRM=2`, `NO_BUILD=1` (только наблюдать), `PORT=7878` (форсить порт, минуя discovery — для теста).

## Тестирование без ребилда
`web-server.js` требует electron (`ipcMain`/`app`/`BrowserWindow`). Для headless-харнесса замокать через `Module._load` shim (`require('electron')` → fake), `start({sdkSessions:new Map(), computeActiveLoaders: ()=>mockState})`, дёргать скрипт с `PORT=<mockport>`. Логика `computeActiveLoaders` юнит-тестится копией функции с mock-Map'ами (stale-bridge skip, дедуп, gemini=false, teardown→idle).

## Связанное
- `fact-claude-stop-hook.md` — откуда `claudeTurnBusy` (authoritative busy)
- `fix-claude-busy-detection.md` — cleanup busy-Map'ов на exit/stop (почему stale-bridge без PTY = не busy)
- `fact-mobile-web.md` — host web-server, токен, discovery-файлы
- `fact-terminal-mcp.md` — `terminalCommandState` (OSC 133 B/D → isRunning)
