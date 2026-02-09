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

## 3. Code Map
- **UI Компонент:** `src/renderer/components/Workspace/TabBar.tsx`
    - Контекстное меню → секция `{/* Scripts - submenu */}`
    - `contextScripts` state: загружается при ПКМ через async IIFE в `handleContextMenu`.
- **IPC Handlers:**
    - `file:read`: Чтение `package.json` с диска (Main process).
    - `terminal:getCwd`: Запрос текущего пути процесса `node-pty`.

## 4. Trap: OSC 133 и dev-серверы
Dev-серверы — долгоживущие процессы. Шелл отправляет `OSC 133;B` (command started), но **никогда не отправит `133;D`** (command finished), пока сервер работает. Это by design. Статус `isRunning: true` сохраняется в `terminalCommandState` (main.js) до остановки сервера (Ctrl+C).

Но `commandType: 'devServer'` на табе устанавливается через `setTabCommandType` в renderer — это **независимый** от OSC 133 механизм. RestartZone требует **оба**: `hasProcess === true` (из OSC) И `commandType === 'devServer'` (из store).
