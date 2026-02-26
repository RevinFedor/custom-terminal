# Feature: Terminal Scripts

## 1. Intro + User Flow
Запуск npm-скриптов из `package.json` через контекстное меню таба (ПКМ → Scripts).

**Flow:**
ПКМ по табу → Подменю "Scripts" (подгружается из `package.json` CWD этого таба) → Клик по скрипту → В терминал отправляется `npm run [name]`.

## 2. Behavior Specs
- **Динамическое считывание:** Список скриптов загружается при открытии контекстного меню (запрашивается актуальный CWD через `terminal:getCwd`).
- **Фильтрация приватных команд:** Скрипты с подчёркиванием (`_rebuild`) скрываются из UI.
- **Dev-Server Auto-Detection:** При запуске скрипта, имя которого начинается с `dev`, `start`, `serve` или `watch` (regex: `/^(dev|start|serve|watch)/i`), автоматически вызывается `setTabCommandType(tabId, 'devServer')`. Это делает таб зелёным и активирует кнопку перезагрузки (RestartZone).
- **Подменю с отступом:** Scripts отображаются как подменю контекстного меню (CSS `group-hover/scripts`), открывающееся вправо.

## 3. Stop Running Process
Три способа остановить активный процесс (все отправляют `\x03` — Ctrl+C):
- **Middle-click на RestartZone** (зелёная точка/кнопка ↻ на табе). `onAuxClick` с `stopPropagation` — перехватывает middle-click ДО TabItem, поэтому вкладка НЕ закрывается.
- **ПКМ по табу → Scripts → Stop: {name}** — появляется только если `processStatus.get(tabId) && commandType === 'devServer'`. Текст берётся из `tab.name`.
- **ПКМ по терминалу → Scripts (● running) → ● Stop process** — нативное Electron меню в main.js, проверяет `terminalCommandState.get(tabId).isRunning`.

**Trap: Два раздельных контекстных меню скриптов.** Tab context menu (ПКМ по вкладке) — React-компонент в `TabBar.tsx`, проверяет `processStatus` Map + `commandType` из store. Terminal context menu (ПКМ по терминалу) — нативное `Menu.buildFromTemplate` в `main.js:show-terminal-context-menu`, проверяет `terminalCommandState` Map напрямую. При изменении логики скриптов нужно обновлять **оба** места.

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
