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
