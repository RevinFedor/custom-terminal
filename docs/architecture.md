# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных, файловой системой и жизненным циклом внешних процессов (`system:kill-process`).
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`), чтобы не блокировать Event Loop главного процесса и IPC. См. `knowledge/fix-ui-stability.md` (раздел 8).
    - **Vite & Escaping:** При написании Bash-команд в `main.js` необходимо экранировать `$`, чтобы избежать ошибок трансформации Vite. См. `knowledge/fix-main-process-escaping.md`.
    - **Stability:** Используется `disable-http-cache` для предотвращения загрузки устаревшего кода в продакшн-билдах. См. `knowledge/fix-terminal-colors.md`.
- **Renderer Process:** React 19 UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).
- **Focus Model:** Введено понятие `activeArea` ('projects' | 'workspace'). Это позволяет контекстно интерпретировать горячие клавиши (например, `Cmd+T`).
- **Navigation History (LRU):** Система хранит стек последних 20 активных проектов (`projectHistory`). Это позволяет реализовать навигацию «Назад» при закрытии вкладок или отмене действий.

## 2. Project Instance Model (Philosophy)
Проект в системе перестал быть «путем на диске» и стал самостоятельной **Сущностью (Entity)**.
- **Empty Projects:** Поддержка создания проектов без начального пути (`project:create-empty`). Путь назначается позже через Edit Modal.
- **Entity vs Path:** Раньше один путь `~/app` соответствовал одному проекту. Теперь проект — это уникальный ID в БД. Путь (`path`) — лишь один из атрибутов.
- **Multiple Instances:** Архитектура позволяет создавать неограниченное количество инстансов для одной и той же директории. Каждый инстанс имеет свой набор вкладок, заметок и историю AI.
- **ID Generation:** Используется композитный ID: `base64(path)` + `timestamp` + `random`. См. `knowledge/fix-project-instances.md`.

## 3. Startup & Recovery Flow
Система гарантирует плавное восстановление состояния без визуального шума.
- **Prepare-before-show:** При переключении проекта или запуске система сначала инициализирует PTY-процессы и готовит терминалы в фоне. UI переключается только после готовности ядра.
- **RestoreLoader:** Глобальный лоадер (флаг `isRestoring`) скрывает процесс инициализации, делая переходы бесшовными.
- **Dashboard Retention:** При удалении проекта из Dashboard пользователь остается на главном экране, предотвращая переход в пустое рабочее пространство.

## 4. Terminal Integration
- **Backend:** `node-pty`.
- **Process Ownership Tracking:** Система определяет принадлежность процессов Claude CLI к конкретным вкладкам приложения.
    - **PPID Mapping:** Используется `ps -eo pid,ppid` для получения Parent Process ID. Если PPID процесса совпадает с PID шелла в одной из вкладок, процесс помечается как **In-App**.
    - **External Detection:** Процессы, чьи PPID не найдены в активных терминалах, классифицируются как **External** (запущенные вне приложения).
    - **CWD via lsof:** Для получения рабочего каталога процесса без взаимодействия с шеллом используется `lsof -p <PID>`.
- **Shell Integration (OSC 7 & 133):**
    - **OSC 7:** Передача текущего рабочего каталога (CWD). См. `knowledge/fact-osc7-cwd.md`.
    - **CWD Capture:** Для фичи Scripts (см. `features/scripts.md`) используется IPC `terminal:getCwd`, который запрашивает путь напрямую у инстанса xterm.js, гарантируя актуальность после команд `cd`.
    - **OSC 133 (Event-Driven):** Использование невидимых сигналов от шелла для отслеживания жизненного цикла команд. Позволяет мгновенно узнавать о старте и завершении процесса без polling. См. `knowledge/fix-process-polling-to-osc133.md`.
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещён polling через `pgrep`/`ps` для определения статуса процесса. Использовать только `terminal:getCommandState` (память) и IPC-события `terminal:command-started`/`terminal:command-finished`.
- **Search Engine:** Интеграция `@xterm/addon-search` для полнотекстового поиска по буферу.
    - **Proposed API:** Для работы поиска в `xterm.js` включена опция `allowProposedApi: true`.
- **Resizing:** Управление размером терминала через `ResizeObserver`. Для стабильности используется `activeRef` во избежание проблем с замыканиями. См. `knowledge/fix-terminal-resizing.md`.
- **AI Integrations:**
    - **Claude Sniper:** Захват UUID через dual-method: `fs.watch` + polling (1с fallback). Реализован как функция `startSessionSniper()` с snapshot существующих файлов и 30с таймаутом. См. `features/claude-sessions.md`.
    - **Claude Handshake:** Стейт-машина (WAITING_PROMPT → DEBOUNCE_PROMPT → TAB_SENT → READY) для автоматического включения thinking mode (`\t`) и отправки промпта. Поддерживает `⏵` (Claude v2.1.32+) и `>`. Используется `stripVTControlCharacters()`.
    - **Gemini Sniper:** Захват UUID через `fs.watch` на `session-*.json`. См. `knowledge/fix-gemini-id-capture.md`.
    - **Timeline Engine:** Асинхронный парсинг JSONL файлов с использованием алгоритма **Backtrace** для фильтрации отменённых (Undo) веток диалога. См. `knowledge/fix-jsonl-backtrace.md`.
    - **Fork Markers (Snapshot UUIDs):** Для визуализации форков в Timeline используется метод снимков. В БД сохраняется массив всех UUID сообщений на момент форка. Это позволяет метке оставаться на правильном месте даже при откатах истории (Escape/Undo). См. `features/timeline.md`.
- **Large Input:** Safe Write (chunked write) для вставки промптов > 4KB. См. `knowledge/fix-pty-buffer-overflow.md`.

## 5. AI Session Recovery
Система восстановления прерванных AI сессий (Claude/Gemini) при перезагрузке или крэше приложения.

### Компоненты:
- **Tab Metadata:** `claudeSessionId`, `geminiSessionId`, `commandType`, `wasInterrupted`, `overlayDismissed` — сохраняются в SQLite.
- **commandType Persistence:** Поле `commandType` сохраняется в БД, чтобы после перезапуска отличить AI-сессию от обычного терминала и избежать автоматического переименования вкладки. См. `knowledge/fix-tab-rename-on-restart.md`.
- **Sniper Watcher:** `fs.watch` на файлы сессий для захвата UUID при запуске AI.
- **Interrupted Overlay:** UI компонент для предложения восстановления (`TerminalArea.tsx`).

### Критические правила:
1. **Сброс флагов при новой сессии:** При вызове `setClaudeSessionId`/`setGeminiSessionId` флаги `wasInterrupted` и `overlayDismissed` **обязательно сбрасываются**. Это гарантирует что overlay покажется снова если новая сессия будет прервана.
2. **beforeunload:** При закрытии приложения вызывается `markAllSessionsInterrupted()`, который ставит `wasInterrupted = true` для всех табов с активной сессией (если `!overlayDismissed`).
3. **Условие показа overlay:** `wasInterrupted && claudeSessionId` — оба флага должны быть истинны.

### Жизненный цикл:
```
Запуск Claude → setClaudeSessionId() → флаги сброшены
    ↓
Закрытие приложения → wasInterrupted = true
    ↓
Следующий запуск → Overlay "Восстановить?"
    ↓
Continue → claude --resume ID | Dismiss → overlayDismissed = true
```

См. `knowledge/fix-interrupted-overlay-persistence.md`.

## 6. Debug Logger
Централизованная система логирования на базе библиотеки `debug`.
- **Файл:** `src/renderer/utils/logger.ts`.
- **Категории:** `app:claude`, `app:tabs`, `app:commands`, `app:perf`, `app:terminal`, `app:store`, `app:ui`.
- **Управление:** Включается через консоль DevTools: `localStorage.debug = 'app:*'`.
- **Принудительный режим:** В режиме разработки логгер принудительно включает `app:tabs` для отслеживания жизненного цикла сессий. См. `knowledge/fix-ui-stability.md`.

## 7. Styling & Rendering
- **Tailwind v4 + Vite:** Используется официальный плагин `@tailwindcss/vite`, обеспечивающий мгновенный HMR и автоматическое сканирование зависимостей. См. `knowledge/fix-tailwind-v4-source.md`.
- **Dynamic Styles:** Для рантайм-цветов используются Inline Styles (Tailwind не поддерживает динамическую генерацию классов типа `bg-${color}`). См. `knowledge/fix-tailwind-dynamic-runtime.md`.
- **Markdown:** Специальный рендерер для исправления гидратации и inline-кода. См. `knowledge/fix-markdown-hydration.md`, `knowledge/fix-markdown-inline-code.md` и `knowledge/fix-markdown-editor-recreation.md`.
- **Hotkeys:** Перехват `Cmd+Plus/Minus` для изменения шрифта терминала вместо системного зума. См. `knowledge/fix-ui-stability.md` (раздел 6).

## 8. UI Patterns & Modals
- **Title Bar (Layered Drag):** Для совмещения перетаскивания окна и интерактивных элементов используется стратегия "Слоёного пирога": родитель имеет `drag`, дочерние интерактивные элементы — `no-drag`. См. `knowledge/fix-titlebar-layered-drag.md`.
- **Interactive Hover Zones:** Для плавного перехода курсора от триггера к всплывающему окну (порталу) используется стратегия "Невидимого мостика". См. `knowledge/fix-interactive-hover-zones.md`.
- **Layout Robustness:** Избегайте дублирования фиксированной ширины (`notesPanelWidth`) во вложенных компонентах. Используйте `w-full` или `flex-1`, чтобы верстка не ломалась при динамическом появлении элементов (например, Timeline). См. `knowledge/fix-layout-clipping.md`.
- **Context Modals (Notes, Research):** Должны рендериться внутри контейнера `Workspace` с использованием `absolute positioning` (inset-0) и `z-index: 50`. Контейнер Workspace должен иметь `relative`.
    - **Why:** Это обеспечивает правильное наложение поверх терминала, но сохранение контекста рабочей области, а также позволяет использовать "floating sheet" дизайн с отступами.
    - **Avoid:** Не использовать `createPortal(..., document.body)` для контекстных инструментов, так как это нарушает иерархию стилей и усложняет позиционирование относительно UI терминала.
- **Global Modals (Settings, Toasts):** Могут использовать Top-Level рендеринг в `App.tsx` или Portals, так как они должны перекрывать весь интерфейс независимо от контекста.
