# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных (таблицы `projects`, `tabs`, `tab_history`, `favorites`), файловой системой и жизненным циклом внешних процессов (`system:kill-process`).
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`), чтобы не блокировать Event Loop главного процесса и IPC. См. `knowledge/ui-ux-stability.md` (раздел 8).
    - **Vite & Escaping:** При написании Bash-команд в `main.js` необходимо экранировать `$`, чтобы избежать ошибок трансформации Vite. См. `knowledge/environment-fixes.md`.
    - **Stability:** Используется `disable-http-cache` для предотвращения загрузки устаревшего кода в продакшн-билдах. См. `knowledge/terminal-core.md`.
- **Renderer Process:** React 19 UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).
- **Focus & Activity Model:** 
    - **Area Focus:** Введено понятие `activeArea` ('projects' | 'workspace'). Это позволяет контекстно интерпретировать горячие клавиши (например, `Cmd+T`). Для надежного переключения области используется событие `onMouseDown`, что предотвращает перехват событий холстом `xterm.js`. См. `knowledge/ui-ux-stability.md` (раздел 12).
    - **Effective Activity:** Терминал считается активным только при совпадении трех условий: вкладка выбрана (`active`), открыт вид терминала (`currentView === 'terminal'`) и виден сам воркспейс (`workspaceView === 'workspace'`). Это предотвращает лишние расчеты `safeFit` и кражу фокуса в фоновом режиме.
- **Navigation History (LRU):** Система хранит стек последних 20 активных проектов (`projectHistory`). Это позволяет реализовать навигацию «Назад» при закрытии вкладок или отмене действий.

## 2. Project Instance Model (Philosophy)
Проект в системе перестал быть «путем на диске» и стал самостоятельной **Сущностью (Entity)**.
- **Empty Projects:** Поддержка создания проектов без начального пути (`project:create-empty`).
    - **Placeholder Paths:** Для обхода `UNIQUE` ограничения на колонку `path` в старых версиях БД (Production), пустые проекты создаются с временным путем `__unset__new_project_{id}`. UI фильтрует этот путь, а терминал использует fallback к `HOME`. См. `knowledge/data-persistence.md`.
- **Entity vs Path:** Раньше один путь `~/app` соответствовал одному проекту. Теперь проект — это уникальный ID в БД. Путь (`path`) — лишь один из атрибутов.
- **Navigation History (LRU):** Система хранит стек истории посещения табов (`tabHistory`) для каждого проекта. При закрытии активного таба система переключает пользователя на предыдущий активный из стека, а не просто на последний в списке.
- **Multiple Instances:** Архитектура позволяет создавать неограниченное количество инстансов для одной и той же директории.
- **ID Generation:** Используется композитный ID: `base64(path)` + `timestamp` + `random`. См. `knowledge/data-persistence.md`.

## 3. Startup & Recovery Flow
Система гарантирует плавное восстановление состояния без визуального шума.
- **Prepare-before-show:** При переключении проекта или запуске система сначала инициализирует PTY-процессы и готовит терминалы в фоне. UI переключается только после готовности ядра.
- **Persistent Workspace:** Компонент `Workspace` остается смонтированным всегда (начиная с первого открытия проекта). Переход между Dashboard и Workspace управляется через `visibility: hidden` в `App.tsx`. Это предотвращает уничтожение WebGL/Canvas контекстов и потерю буферов терминалов. См. `knowledge/ui-ux-stability.md` (раздел 2).
- **RestoreLoader:** Глобальный лоадер (флаг `isRestoring`) скрывает процесс инициализации, делая переходы бесшовными.
- **Dashboard Retention:** При удалении проекта из Dashboard пользователь остается на главном экране, предотвращая переход в пустое рабочее пространство.

## 4. Terminal Integration
- **Backend:** `node-pty`.
- **Process Ownership Tracking:** Система определяет принадлежность процессов Claude CLI и Gemini к конкретным вкладкам приложения.
    - **PPID Mapping:** Используется `ps -eo pid,ppid` для получения Parent Process ID. Если PPID процесса совпадает с PID шелла в одной из вкладок, процесс помечается как **In-App**.
    - **Context Menu Mapping:** Для поддержки функций вроде "Add to Favorites" из терминала, Renderer передает `tabId` и `projectId` в Main-процесс при вызове `show-terminal-context-menu`.
    - **External Detection:** Процессы, чьи PPID не найдены в активных терминалах, классифицируются как **External** (запущенные вне приложения). Для Gemini мониторинг осуществляется через поиск detached-процессов (`ps aux | grep "?"`).
    - **CWD via lsof:** Для получения рабочего каталога процесса без взаимодействия с шеллом используется `lsof -p <PID>`.
- **Shell Integration (OSC 7 & 133):**
    - **OSC 7:** Передача текущего рабочего каталога (CWD). См. `knowledge/terminal-core.md`.
    - **CWD Capture:** Для фичи Scripts (см. `features/scripts.md`) и контекстного меню табов используется IPC `terminal:getCwd`, который запрашивает путь напрямую у инстанса xterm.js, гарантируя актуальность после команд `cd`.
    - **OSC 133 (Event-Driven):** Использование невидимых сигналов от шелла для отслеживания жизненного цикла команд. Позволяет мгновенно узнавать о старте и завершении процесса без polling. См. `knowledge/terminal-core.md`.
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещён polling через `pgrep`/`ps` для определения статуса процесса. Использовать только `terminal:getCommandState` (память) и IPC-события `terminal:command-started`/`terminal:command-finished`.
- **Search Engine:** Интеграция `@xterm/addon-search` для полнотекстового поиска по буферу.
    - **Proposed API:** Для работы поиска в `xterm.js` включена опция `allowProposedApi: true`.
- **Resizing:** Управление размером терминала через `ResizeObserver`. Для стабильности используется `activeRef` во избежание проблем с замыканиями. См. `knowledge/terminal-core.md`.
- **AI Integrations:**
    - **Claude StatusLine Bridge:** Основной механизм захвата и мониторинга Session ID. 
        - **Принцип:** Приложение прописывает скрипт-мост в `~/.claude/settings.json` (секция `statusLine`). Claude автоматически вызывает этот скрипт после каждого ответа.
        - **Flow:** Claude → `statusline-bridge.sh` → запись JSON (`session_id`, `ppid`) в `~/.claude/bridge/` → `fs.watch` в Main процессе.
        - **Stability:** Это обеспечивает 100% точность привязки сессии к конкретному табу через сопоставление PID (ppid из файла → родительский shell PID → наш PTY).
        - **Legacy:** Ранняя реализация через Sniper Watcher (отслеживание создания файлов) сохранена в `docs/knowledge/fact-legacy-sniper-watcher.md`.
    - **Claude Handshake:** Упрощённая стейт-машина (WAITING_PROMPT → DEBOUNCE_PROMPT → send prompt) для автоматической отправки промпта при запуске. Thinking mode обеспечивается `alwaysThinkingEnabled` в settings.json. Поддерживает `⏵` (Claude v2.1.32+) и `>`. Используется `stripVTControlCharacters()`.
    - **Claude TUI Control:** Программное управление Ink TUI через PTY. Модель (`/model <alias>`) переключается через bracketed paste + delayed Enter. Think mode — через реактивный парсинг TUI-пикера (`meta+t`). См. `knowledge/fact-claude-tui-control.md`.
    - **Gemini Sniper:** Захват UUID через `fs.watch` на `session-*.json`. См. `knowledge/ai-automation.md`.
    - **Timeline & Export Engine:** Асинхронный парсинг JSONL файлов с использованием алгоритма **Backtrace** для фильтрации отменённых (Undo) веток диалога. 
     
        - **Unified Pipeline:** Все три механизма (`claude:get-timeline`, `claude:copy-range`, Copy Session) используют идентичный пайплайн: `resolveSessionChain` (загрузка файлов цепи) → генерация единой `merged recordMap` → алгоритм **Backtrace** с применением `compact recovery` и защитой от циклов в мостах. **КРИТИЧЕСКОЕ ПРАВИЛО:** Любой новый IPC-хендлер, который работает с UUID из timeline, ОБЯЗАН использовать `resolveSessionChain`, а не загружать единичный JSONL файл. Иначе UUID из родительских сессий (до Plan Mode) не будут найдены.
        - **Gap Recovery:** Для восстановления связности после операций `/compact`, создающих "битые" ссылки `logicalParentUuid`, используется метод физического поиска: к каждой записи при загрузке добавляются поля `_fileIndex` и `_fromFile`. Если логическая связь разорвана, алгоритм находит физического предшественника в JSONL. См. `knowledge/ai-automation.md`.
    - **Fork Markers (Snapshot UUIDs):** Для визуализации форков в Timeline используется метод снимков. В БД сохраняется массив всех UUID сообщений на момент форка. Это позволяет метке оставаться на правильном месте даже при откатах истории (Escape/Undo). Форк-маркеры корректно работают с самого начала сессии (даже при пустых снапшотах). См. `features/timeline.md`.
    - **Plan Mode Markers:** Визуализация границ "Clear Context" / Plan Mode. Детектируется через смену `sessionId` между соседними timeline-записями (без fork-маркера в той же позиции). Не использует `sessionBoundaries` из-за "Fork Copies Bridges" ловушки (см. `knowledge/ai-automation.md`). См. `features/timeline.md`.
- **Large Input:** Safe Write (chunked write) для вставки промптов > 4KB. См. `knowledge/terminal-core.md`.

## 5. AI Session Recovery
Система восстановления прерванных AI сессий (Claude/Gemini) при перезагрузке или крэше приложения.

### Компоненты:
- **Tab Metadata:** `claudeSessionId`, `geminiSessionId`, `commandType`, `wasInterrupted`, `overlayDismissed` — сохраняются в SQLite.
- **commandType Persistence:** Поле `commandType` сохраняется в БД, чтобы после перезапуска отличить AI-сессию от обычного терминала и избежать автоматического переименования вкладки. См. `knowledge/data-persistence.md`.
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

См. `knowledge/ui-ux-stability.md`.

## 6. Debug Logger
Централизованная система логирования на базе библиотеки `debug`.
- **Файл:** `src/renderer/utils/logger.ts`.
- **Категории:** `app:claude`, `app:tabs`, `app:commands`, `app:perf`, `app:terminal`, `app:store`, `app:ui`.
- **Управление:** Включается через консоль DevTools: `localStorage.debug = 'app:*'`.
- **Принудительный режим:** В режиме разработки логгер принудительно включает `app:tabs` для отслеживания жизненного цикла сессий. См. `knowledge/ui-ux-stability.md`.
- **ЛОВУШКА: console.log перехвачен.** В `main.tsx` установлен глобальный фильтр — `console.log()` пропускает только логи с префиксом `[RESTORE]`. Для отладки использовать `console.warn()`. См. `knowledge/fact-console-interceptor.md`.

## 7. Styling & Rendering
- **Tailwind v4 + Vite:** Используется официальный плагin `@tailwindcss/vite`, обеспечивающий мгновенный HMR и автоматическое сканирование зависимостей. См. `knowledge/rendering-styles.md`.
- **Dynamic Styles:** Для рантайм-цветов используются Inline Styles (Tailwind не поддерживает динамическую генерацию классов типа `bg-${color}`). См. `knowledge/fix-tailwind-dynamic-runtime.md`.
- **Markdown Rendering:**
  - **File Preview:** Унифицированный просмотр всех файлов через `@anthropic/markdown-editor` (readOnly mode). Заменил `react-markdown` + `highlight.js`. См. `knowledge/file-preview-markdown.md`.
  - **Notes & Research:** Разные рендереры для разных целей (CodeMirror для редактирования, react-markdown для AI-ответов). См. `knowledge/rendering-styles.md`.
- **Hotkeys:** Перехват `Cmd+Plus/Minus` для изменения шрифта терминала вместо системного зума. См. `knowledge/ui-ux-stability.md` (раздел 6).

## 8. UI Patterns & Modals
- **Title Bar (Layered Drag):** Для совмещения перетаскивания окна и интерактивных элементов используется стратегия "Слоёного пирога": родитель имеет `drag`, дочерние интерактивные элементы — `no-drag`. См. `knowledge/environment-fixes.md`.
- **Interactive Hover Zones:** Для плавного перехода курсора от триггера к всплывающему окну (порталу) используется стратегия "Невидимого мостика". См. `knowledge/ui-ux-stability.md`.
- **Layout Robustness:** Избегайте дублирования фиксированной ширины (`notesPanelWidth`) во вложенных компонентах. Используйте `w-full` или `flex-1`, чтобы верстка не ломалась при динамическом появлении элементов (например, Timeline). См. `knowledge/ui-ux-stability.md`.
- **Context Modals (Notes, Research):** Должны рендериться внутри контейнера `Workspace` с использованием `absolute positioning` (inset-0) и `z-index: 50`. Контейнер Workspace должен иметь `relative`.
    - **Why:** Это обеспечивает правильное наложение поверх терминала, но сохранение контекста рабочей области, а также позволяет использовать "floating sheet" дизайн с отступами.
    - **Avoid:** Не использовать `createPortal(..., document.body)` для контекстных инструментов, так как это нарушает иерархию стилей и усложняет позиционирование относительно UI терминала.
- **Global Modals (Settings, Toasts):** Могут использовать Top-Level рендеринг в `App.tsx` или Portals, так как они должны перекрывать весь интерфейс независимо от контекста.
