# Feature: Terminal Scripts

## 1. Intro + User Flow
Запуск npm-скриптов из `package.json` и `.sh`-файлов из корня CWD через контекстное меню таба (ПКМ → Scripts).

**Flow:**
ПКМ по табу → Подменю "Scripts" (подгружается из `package.json` + `.sh` файлы CWD этого таба) → Клик по скрипту → В терминал отправляется `npm run [name]` или `./script.sh`.

## 2. Behavior Specs
- **Динамическое считывание:** Список скриптов загружается при открытии контекстного меню (запрашивается актуальный CWD через `terminal:getCwd`).
- **Фильтрация приватных команд:** Скрипты с подчёркиванием (`_rebuild`) скрываются из UI.
- **Dev-Server Auto-Detection:** При запуске скрипта, имя которого начинается с `dev`, `start`, `serve` или `watch` (regex: `/^(dev|start|serve|watch)/i`), автоматически вызывается `setTabCommandType(tabId, 'devServer')`. Это делает таб зелёным и активирует кнопку перезагрузки (RestartZone).
- **Shell-скрипты (.sh):** Помимо npm, парсятся `.sh` файлы в корне CWD (скрытые `.`-файлы исключаются). Отображаются как `./script.sh`. Если есть и npm, и sh — между ними разделительная черта. Dev-Server Auto-Detection работает и для sh (например, `watch.sh` → devServer).
- **Подменю с отступом:** Scripts отображаются как подменю контекстного меню (CSS `group-hover/scripts`), открывающееся вправо.

## 3. Stop Running Process
Все script/devServer stop-пути отправляют `\x03` — Ctrl+C в PTY. Не подменять это SIGTERM по PID: shell сам доставляет SIGINT foreground process group, dev-server получает graceful exit, а UI остаётся в той же терминальной модели.

Текущие поверхности остановки:
- **ПКМ по табу → верхний Close+Stop split-pill** — основной путь для running script/devServer в tab context menu. Stop script mirror'ит Stop Claude UX, но зовёт script-stop ветку.
- **Cmd+hover по правой reload-кнопке в vertical sidebar** — только для зелёной `commandType === 'devServer'` вкладки с живым process-status. Та же кнопка превращается из restart в красный square-stop; click шлёт только Ctrl+C. Подробнее — `fact-process-bar.md::Restart button stop-mode для devServer`.
- **Middle-click на RestartZone** — fallback для horizontal layout, где RestartZone всё ещё рендерится отдельно и `onAuxClick` перехватывает middle-click ДО TabItem.
- **ПКМ по терминалу → Scripts (● running) → ● Stop process** — нативное Electron меню в main.js, проверяет `terminalCommandState.get(tabId).isRunning`.
- **External REST `POST /terminal/stop`** — тот же deterministic Ctrl+C stop для sibling-процессов
  вроде Voice Record build-install preflight. Этот route не закрывает вкладку и не SIGTERM'ит PID:
  он сохраняет терминальную модель “остановить foreground process, оставить shell/tab жить”.

**Trap: Два раздельных контекстных меню скриптов.** Tab context menu (ПКМ по вкладке) — React-компонент в `TabBar.tsx`, проверяет `processStatus` Map + `commandType` из store. Terminal context menu (ПКМ по терминалу) — нативное `Menu.buildFromTemplate` в `main.js:show-terminal-context-menu`, проверяет `terminalCommandState` Map напрямую. При изменении логики скриптов нужно обновлять **оба** места.

**Один из шрамов: auto-color симметрия.** Долго работала только в React-меню TabBar — оно само звало `setTabCommandType(tabId, 'devServer')` после detect'а `^(dev|start|serve|watch)/i`. Нативное меню main.js шлёт команду через `event.send('context-menu-command', 'run-script', { tabId, command })` → renderer App.tsx делает `ipcRenderer.send('terminal:input', tabId, command)` **напрямую в PTY**. Этот путь полностью обходит xterm keydown Enter handler в Terminal.tsx, где живёт второй auto-detect — поэтому вкладка не зеленела при run-script через нативное меню. Симптом юзера: *«ввёл npm run dev, цвет вкладки не стал зелёным»* (см. лог prod-Electron'а: `[ContextMenu] Command received: run-script` followed by `terminal:input ... "npm run dev"` — но без `[Store:setTabCommandType] devServer`). Fix — мирроринг regex'а в `App.tsx::run-script` handler перед `terminal:input`.

Старая entry `Scripts → Stop: {name}` в React submenu больше не рендерится: stop вынесен в top-level split/edge surfaces, чтобы не прятать прерывание внутри списка launch-команд. В submenu оставлен только запуск `npm run X` / `./script.sh`.

Разница restart vs stop: `handleRestart` = `\x03` → 300ms → `!!\r` (Ctrl+C + повтор последней команды через `!!` bash). `handleStop` = только `\x03`.

## Run last command из пустого tab-slot

В vertical sidebar у plain terminal-вкладки без live process, без AI runtime/session-state и без заметки notes-slot при `Cmd+hover` пустой slot превращается в Play. Active tab показывает Play как раньше; inactive tab показывает его только когда сама строка hovered — target определяется наведённой вкладкой, а не глобальным active tab. Это не scripts-menu и не project-wide history: кнопка запускает последнюю сохранённую shell-команду для **текущего cwd** вкладки. Перед lookup renderer спрашивает live cwd через `terminal:getCwd`; main сравнивает сначала in-memory `terminalCommandState.lastCommandCwd`, потом persisted SQLite app-state keyed by cwd.

Граница важна из-за пользовательского сценария «в одной директории `npm run dev`, в другой `./deploy.sh`»: одна Project Workspace может содержать несколько cwd, поэтому ключ "projectId → last command" был бы неверным. Если команда была сохранена в cwd A, а пользователь потом сделал `cd B`, она не должна переехать вслед за табом — для этого у in-memory записи хранится `lastCommandCwd`.

Capture берёт только реальные shell input lines из plain terminal: когда активен Claude/Gemini/Codex runtime, line-buffer очищается и не обучается на TUI output. ANSI CSI вроде `ArrowUp` (`\x1b[A`) не считается командой, persisted мусор типа `[A` отфильтровывается при чтении, bracketed paste не участвует в этом feature. Kill-port prefix, который добавляется перед restart/run (`lsof -ti:...;`), при сохранении отбрасывается, чтобы Play повторял пользовательскую команду, а не служебный preflight.

Важный edge: команда, запущенная через shell history (`↑` + Enter), не проходит через main как текст команды — `terminal:input` видит только escape-код стрелки. Поэтому renderer `CmdDetect` после Enter отправляет в main полный prompt-line, а main уже нормализует его так же как typed input. Если команда была видна в scrollback до появления этой логики и ещё не сохранена в SQLite, Cmd+Play делает одноразовый fallback: сканирует tail текущего xterm-буфера, берёт последнюю строку с shell prompt, нормализует, сохраняет и запускает. Это не замена persisted store, а recovery для живой старой вкладки.

## Restart after AI completion

Обычная terminal/devServer вкладка может быть привязана к завершению другой AI-вкладки через ПКМ → `Restart after`. Это не Prompt Queue и не отправка prompt'а: owner — обычная вкладка с процессом или script'ом, trigger — Claude/Gemini/Codex/SDK вкладка, у которой ждём штатный busy→idle edge.

Контракт side effect:
- выбран только trigger-tab → после natural completion target делает обычный deterministic restart (`Ctrl+C`/stop-flow, затем repeat command);
- выбран trigger-tab + `Script` → target сначала controlled-stop'ит текущий процесс, потом отправляет выбранный `npm run <name>` или `./script.sh`;
- если выбран конечный `Script` уже запущен этой фичей и ещё не завершился, следующий natural completion trigger-tab'а не stop'ит его и не запускает второй экземпляр: ставится один pending rerun, который стартует после `terminal:command-finished` целевой вкладки; несколько trigger'ов пока скрипт идёт схлопываются в один повтор с последней выбранной командой;
- `dev`/`start`/`serve`/`watch`-команды остаются restart-командами: они обычно не завершаются сами, поэтому для них сохраняется прежний controlled stop/restart path вместо ожидания `command-finished`;
- если процесса в target сейчас нет, но выбран `Script`, restart-after просто стартует этот script с нуля; если script не выбран и процесса нет, обычный restart-path no-op'ит как пустой терминал;
- `manual-stop`, `interrupt`, `error`, `watchdog`, Codex `turn_aborted`, Claude `spinner` и обычный `local-command` не запускают restart. Это те же смысловые границы что у Run after: side effect разрешён только после результата, а не после отмены/ошибки/визуального флапа.

Команда, реально запущенная `Restart after`, помечается в main как `activeCommandSource: "restart-after"` на следующий OSC `command-started`: это касается и выбранного `Script`, и plain restart через `!!`, когда script не выбран. `build:i-obs` / `/api/active-loaders` ждёт только такой non-AI процесс, и только пока у вкладки всё ещё есть `restartAfterTabId`. Ручной `npm run dev`, ручной `npm run build`, ручной `./deploy.sh`, цвет вкладки и пользовательский `sessionStatus` не являются blocker'ами install сами по себе.

Выбор trigger-tab сам является активной подпиской. Отдельных restart-after bell-кнопок больше нет: старые `restartAfterArmed` / `restartAfterPersistent` — legacy-поля, которые очищаются при перевыборе/срабатывании. Это важная граница: `restartAfterTabId` без bell-флага всё равно обязан fire'ить. Реальный пользовательский симптом старой модели: target и `npm run dev` были сохранены, Codex loader завершился штатным `task_complete`, но ничего не произошло, потому что старый consume-path дополнительно требовал `armed/persistent`.

`restartAfterTabId` и `restartAfterCommand` сохраняются в SQLite вместе с вкладкой. Сброс trigger'а удаляет и command: script без AI-триггера не имеет смысла, потому что неизвестно после какого события его запускать. В контекстном меню сброс — крестик справа от выбранного trigger'а; в vertical sidebar — `Cmd+click` по фиолетовой restart-кнопке. Если в этот момент открыт stop-mode живого devServer-процесса, тот же жест ещё и останавливает процесс; если процесса нет, жест только очищает подписку.

Restart-after UI использует общий `RunAfterTabPicker`, но в purple-режиме показывает все AI-вкладки сразу (`showAllTabsOnOpen`) и открывает список вправо от tab context menu. Список берёт проекты, группы, порядок вкладок, статус-маркеры и loader из той же модели что TabSidebar; drag/drop в picker'е не работает, это read-only inventory для выбора trigger-source.

Self-target (`triggerTabId === targetTabId`) всегда сбрасывается в `null`, даже если UI уже фильтрует текущую вкладку из picker'а. Это защитный слой против старого persisted state и программных вызовов store: вкладка не может дождаться собственного внешнего busy→idle edge для restart, поэтому такой target выглядел бы настроенным, но никогда не стрелял.

## 4. Code Map
- **UI Компонент:** `src/renderer/components/Workspace/TabBar.tsx`
    - Контекстное меню → секция `{/* Scripts - submenu */}`
    - `contextScripts` state: загружается при ПКМ через async IIFE в `handleContextMenu`.
    - `RestartZone`: компонент с `onRestart` (left-click) и `onStop` (middle-click).
- **Terminal Context Menu:** `src/main/main.js` → `ipcMain.on('show-terminal-context-menu')` — нативное Electron Menu.
- **IPC Handlers:**
    - `file:read`: Чтение `package.json` с диска (Main process).
    - `terminal:getCwd`: Запрос текущего пути процесса `node-pty`.

## 5. Trap: OSC 133 и dev-серверы
Dev-серверы — долгоживущие процессы. Шелл отправляет `OSC 133;B` (command started), но **никогда не отправит `133;D`** (command finished), пока сервер работает. Это by design. Статус `isRunning: true` сохраняется в `terminalCommandState` (main.js) до остановки сервера (Ctrl+C).

Но `commandType: 'devServer'` на табе устанавливается через `setTabCommandType` в renderer — это **независимый** от OSC 133 механизм. RestartZone требует **оба**: `hasProcess === true` (из OSC) И `commandType === 'devServer'` (из store).
