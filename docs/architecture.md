# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных и файловой системой. 
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`), чтобы не блокировать Event Loop главного процесса и IPC.
- **Renderer Process:** React UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).
- **Terminal Routing:** Данные от PTY содержат `tabId`. Renderer направляет их в соответствующий инстанс `xterm.js`.
- **New IPC Channels:**
    - `project:save-tabs`: Сохранение расширенных метаданных (color, isUtility).
    - `prompts:get` / `prompts:save`: Управление AI шаблонами.
    - `commands:get-global` / `commands:save-global`: Глобальные быстрые команды.
    - `docs:export-session`: Экспорт сессии Claude Code.
    - `docs:read-prompt-file`: Чтение внешних файлов промптов.
    - `docs:save-selection`: Сохранение выделения терминала в файл (✂️).
    - `docs:save-prompt-temp`: Сохранение временного файла для Gemini.
    - `docs:cleanup-temp`: Удаление временных артефактов.

## 2. Data Layer
- **SQLite (`noted-terminal.db`):** Хранит сессии AI (`ai_sessions`) и историю развертываний.
- **JSON (`projects.json`):** Хранит метаданные проектов, заметки, табы (теперь с `color`), промпты и команды. Путь: `~/Library/Application Support/noted-terminal/`.
- **Persistence Strategy:** Для минимизации нагрузки на диск и IPC используется **Debounce (300-500ms)** при сохранении табов и сессий. См. `knowledge/fix-data-persistence.md`.
- **Visual State (In-Memory):**
    - `terminalBuffers`: (Zustand) Хранит сериализованные строки `xterm.js` при переключении между Workspace и Dashboard. Очищается после восстановления.
- **LocalStorage:**
    - `noted-terminal-font-settings`: Настройки шрифтов.
    - `noted-terminal-research-v2`: История чатов Research (Conversations).
    - `noted-terminal-ai-model`: Выбранная глобальная модель Gemini.
    - `noted-terminal-thinking-level`: Настройка глубины рассуждений Gemini 3.
    - `noted-terminal-research-prompt`: Системный промпт для ресерча.
    - `noted-terminal-doc-prompt`: Настройки промпта для обновления документации (Update Docs).
- **UI State (`useUIStore`):** Хранит настройки интерфейса, включая размеры шрифтов и текущее выделение терминала (`terminalSelection`).

## 3. Terminal Integration
- **Backend:** `node-pty` для создания псевдотерминалов.
- **Frontend:** `xterm.js` с использованием **Canvas рендерера**. WebGL отключен для предотвращения лагов "прогрева" GPU и обхода лимитов контекстов (max 16). См. `knowledge/fix-ui-stability.md`.
- **Terminal Registry:** Глобальный маппинг `tabId -> xterm instance` для доступа к данным терминала (выделение, ввод) из любой части приложения. См. `knowledge/fact-terminal-registry.md`.
- **Lazy Hydration:** Инстанс `xterm.js` и его аддоны создаются только при первом физическом показе таба (активация таба или проекта). До этого данные от PTY буферизируются. Это обеспечивает мгновенный старт приложения (Cold Start) даже с десятками табов.
- **Rendering Strategy:** Для предотвращения дёргания (jitter) при переключении проектов терминалы всех открытых проектов рендерятся одновременно и скрываются через `visibility: hidden`. См. `knowledge/fix-terminal-jitter.md`.
- **Buffer Optimization:** `FLUSH_DELAY = 10ms` для предотвращения дрожания UI при интенсивном выводе.
- **Visual Persistence (Serialization):** При размонтировании (unmount) воркспейса, содержимое терминалов сериализуется через `SerializeAddon` и сохраняется в `useWorkspaceStore`. При возврате данные восстанавливаются через `term.write()`. См. `knowledge/fix-terminal-serialization.md`.

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