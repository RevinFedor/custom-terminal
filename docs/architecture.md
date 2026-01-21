# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных и файловой системой.
- **Renderer Process:** React UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).
- **Terminal Routing:** Данные от PTY содержат `tabId`. Renderer направляет их в соответствующий инстанс `xterm.js`.
- **New IPC Channels:**
    - `project:save-tabs`: Сохранение расширенных метаданных (color, isUtility).
    - `prompts:get` / `prompts:save`: Управление AI шаблонами.
    - `commands:get-global` / `commands:save-global`: Глобальные быстрые команды.

## 2. Data Layer
- **SQLite (`noted-terminal.db`):** Хранит сессии AI (`ai_sessions`) и историю развертываний.
- **JSON (`projects.json`):** Хранит метаданные проектов, заметки, табы (теперь с `color`), промпты и команды. Путь: `~/Library/Application Support/noted-terminal/`.
- **LocalStorage:**
    - `noted-terminal-font-settings`: Настройки шрифтов.
    - `noted-terminal-research-v2`: История чатов Research (Conversations).
    - `noted-terminal-ai-model`: Выбранная глобальная модель Gemini.
    - `noted-terminal-research-prompt`: Системный промпт для ресерча.
- **UI State (`useUIStore`):** Хранит настройки интерфейса, включая размеры шрифтов и текущее выделение терминала (`terminalSelection`).

## 3. Terminal Integration
- **Backend:** `node-pty` для создания псевдотерминалов.
- **Frontend:** `xterm.js` с аддоном WebGL для высокой производительности рендеринга.
- **Terminal Registry:** Глобальный маппинг `tabId -> xterm instance` для доступа к данным терминала (выделение, ввод) из любой части приложения. См. `knowledge/fact-terminal-registry.md`.
- **Rendering Strategy:** Для предотвращения дёргания (jitter) при переключении проектов терминалы всех открытых проектов рендерятся одновременно и скрываются через `visibility: hidden`. См. `knowledge/fix-terminal-jitter.md`.
- **Buffer Optimization:** `FLUSH_DELAY = 10ms` для предотвращения дрожания UI при интенсивном выводе.

## 4. Styling System
- Tailwind CSS v4 с JIT-компиляцией.
- Темы и переменные определены в `src/renderer/styles/globals.css`.
- **Ограничение:** Для динамических стилей в рантайме используем Inline Styles (см. `knowledge/fix-tailwind-dynamic-runtime.md`).

## 5. Global Events & Hotkeys
- **App-level listener:** В `src/renderer/App.tsx` настроен глобальный перехват `keydown`.
- **Shortcuts:**
    - `Cmd + ,`: Открытие `SettingsModal`.
    - `Cmd + J`: Gemini Focus.
    - `Cmd + B`: Toggle Sidebar.
    - `Cmd + Plus / Minus`: Изменение размера шрифта активного терминала (вместо системного зума). См. `knowledge/fix-zoom-override.md`.
    - `Cmd + T`: Создание нового таба в активном проекте.