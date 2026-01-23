# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных и файловой системой. 
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`), чтобы не блокировать Event Loop главного процесса и IPC.
    - **Stability:** Используется `disable-http-cache` для предотвращения загрузки устаревшего кода в продакшн-билдах.
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
    - `app:getState` / `app:setState`: Глобальное хранилище состояния (view, session) в SQLite.
    - `project:save-note`: Сохранение заметок проекта в JSON.
    - `claude:spawn-with-watcher`: Запуск Claude с активацией Sniper Watcher.
    - `claude:fork-session-file`: Копирование файла сессии (поиск по всем проектам).
    - `claude:run-command`: Прямой запуск команд Claude из UI (Claude Runner).

## 2. Data Layer
- **SQLite (`noted-terminal.db`):** 
    - Хранит сессии AI (`ai_sessions`).
    - Хранит глобальное состояние приложения (`app_state`): текущий `view` (Dashboard/Workspace), данные последней сессии.
    - **Миграция:** Таблица `tabs` теперь содержит колонку `was_interrupted`.
- **JSON (`projects.json`):** Хранит метаданные проектов, заметки, табы (с `color`, `isUtility`, `claudeSessionId` и `wasInterrupted`).
- **Persistence Strategy:** 
    - Для вкладок используется Debounce (500ms).
    - Для заметок проекта сохранение происходит при `blur` (потере фокуса) или по `Cmd+Enter`.
    - Состояние приложения (`app:setState`) сохраняется асинхронно с дебаунсом, но при закрытии приложения (`beforeunload`) используется синхронный вызов для гарантии записи.
- **State Management Principles:**
    - **Separation of Concerns:** UI-флаги (например, `wasInterrupted`) должны быть строго отделены от идентификаторов данных (`claudeSessionId`). 
    - **Non-destructive UI Actions:** Закрытие оверлеев или уведомлений (Dismiss) должно изменять только UI-флаги. Удаление или обнуление идентификаторов данных (`undefined`) допустимо только при явном действии пользователя по удалению данных (например, "Delete Session"). Это предотвращает потерю контекста при случайных кликах.

## 3. Terminal Integration

- **Backend:** `node-pty` + **Shell Integration (OSC 7)**.
    - **CWD Tracking:** Вместо поллинга через `lsof` используется реактивный подход. Shell (Zsh/Bash) отправляет последовательность OSC 7 при каждой смене директории. Это позволяет приложению мгновенно узнавать `cwd` и сохранять его. См. `knowledge/fact-osc7-cwd.md`.

- **Frontend:** `xterm.js` с использованием **Canvas рендерера**.
    - **Layering Pattern:** Использование слоев и Portals для отрисовки UI (кнопки скролла, Explorer) поверх Canvas без конфликтов Stacking Context. См. `knowledge/fix-layering-pattern.md`.
    - **Lazy Hydration:** Инстанс `xterm.js` создается только при первом физическом показе. Добавлен `isCreatingRef` для предотвращения двойной инициализации.

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

## 6. Debug Logger
- **Библиотека:** `debug` npm package.
- **Файл:** `src/renderer/utils/logger.ts`.
- **Категории:**
    - `app:claude` — Claude session handling
    - `app:tabs` — Tab operations (colors, creation)
    - `app:perf` — Performance timing
    - `app:terminal` — Terminal operations
    - `app:store` — Store actions
    - `app:ui` — UI interactions
    - `app:research` — Research panel
    - `app:commands` — Command detection (npm, claude, gemini)
- **Включение в DevTools консоли:**
    ```javascript
    localStorage.debug = 'app:*'           // все логи
    localStorage.debug = 'app:tabs'        // только tabs
    localStorage.debug = 'app:tabs,app:commands'  // несколько
    // Затем F5 (перезагрузка страницы)
    ```
- **Хелперы в консоли:**
    ```javascript
    debug.enable('app:*')   // включить
    debug.disable()         // выключить
    debug.status()          // показать текущие настройки
    debug.help()            // справка
    ```

## 7. Tab Colors & Command Types
- **Цвета табов** определены в `TabBar.tsx` (`TAB_COLORS`).
- **Специальные цвета:**
    - `claude` — #DA7756 (терракотовый)
    - `gemini` — #4E86F8 (синий)
- **Auto-color:** При первом запуске команды таб автоматически окрашивается:
    - `npm run dev` / `yarn start` / `pnpm serve` / `bun dev` → зелёный
    - `claude` / `claude-c` / `claude-d` → claude (оранжевый)
    - `gemini` → gemini (синий)
- **Флаг `colorSetManually`:** Если пользователь вручную изменил цвет через контекстное меню, авто-окрашивание отключается для этого таба.
- **CommandType на табе:** Определяет тип запущенной команды (`devServer`, `claude`, `gemini`, `generic`). Используется для:
    - Показа/скрытия кнопки Restart (только для `devServer`)
    - Авто-окрашивания