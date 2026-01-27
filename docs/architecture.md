# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных и файловой системой.
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`), чтобы не блокировать Event Loop главного процесса и IPC. См. `knowledge/fix-ui-stability.md` (раздел 8).
    - **Vite & Escaping:** При написании Bash-команд в `main.js` необходимо экранировать `$`, чтобы избежать ошибок трансформации Vite. См. `knowledge/fix-main-process-escaping.md`.
    - **Stability:** Используется `disable-http-cache` для предотвращения загрузки устаревшего кода в продакшн-билдах. См. `knowledge/fix-terminal-colors.md`.
- **Renderer Process:** React 19 UI. Общается с Main через типизированные IPC-вызовы (см. `src/preload/index.js`).

## 2. Data & Metadata Layer
- **SQLite (`noted-terminal.db`):** Хранит сессии AI (`ai_sessions`) и глобальное состояние приложения (`app_state`).
- **JSON (`projects.json`):** Хранит метаданные проектов, заметки и расширенные данные табов.
- **Minayu History Layer (`~/.minayu/history/`):** Система снепшотов для Gemini Time Machine. См. `features/time-machine.md`.
- **Tab Metadata:**
    - `geminiSessionId`: UUID активной сессии Gemini CLI.
    - `wasInterrupted`: Флаг прерванной сессии для показа Overlay.
    - `overlayDismissed`: Флаг осознанного закрытия оверлея пользователем (сохраняется в БД, колонка `overlay_dismissed`). См. `knowledge/fix-interrupted-overlay-persistence.md`.
- **Persistence Strategy:** Состояние табов сохраняется в SQLite. Важное ограничение: данные PTY, приходящие во время размонтирования таба, временно теряются. См. `knowledge/fix-terminal-serialization-loss.md`.

## 3. Startup & Recovery Flow
Система гарантирует плавное восстановление состояния без визуального шума.
- **RestoreLoader:** При запуске приложения или переключении проекта включается полноэкранный лоадер (флаг `isRestoring` в store).
- **Batch Restoration:** Во время восстановления `createTab` не переключает `activeTabId`, предотвращая "дёрганье" UI. Финальный таб устанавливается один раз в конце процесса.
- **Persistence:** Каждое изменение таба (CWD, цвет, ID сессии) немедленно синхронизируется с SQLite.

## 4. Terminal Integration
- **Backend:** `node-pty`.
- **Shell Integration (OSC 7 & 133):**
    - **OSC 7:** Передача текущего рабочего каталога (CWD). См. `knowledge/fact-osc7-cwd.md`.
    - **OSC 133 (Event-Driven):** Использование невидимых сигналов от шелла для отслеживания жизненного цикла команд. Позволяет мгновенно узнавать о старте и завершении процесса без polling. См. `knowledge/fact-shell-integration.md`.
- **Search Engine:** Интеграция `@xterm/addon-search` для полнотекстового поиска по буферу.
    - **Proposed API:** Для работы поиска в `xterm.js` включена опция `allowProposedApi: true`.
- **AI Integrations:**
    - **Claude Sniper:** Захват UUID через `fs.watch` на `.jsonl` файлы.
    - **Gemini Sniper:** Захват UUID через `fs.watch` на `session-*.json`. См. `knowledge/fix-gemini-id-capture.md`.
    - **Timeline Engine:** Асинхронный парсинг JSONL файлов с использованием алгоритма **Backtrace** для фильтрации отменённых (Undo) веток диалога. См. `knowledge/fix-jsonl-backtrace.md`.
- **Large Input:** Safe Write (chunked write) для вставки промптов > 4KB. См. `knowledge/fix-pty-buffer-overflow.md`.

## 5. Debug Logger
Централизованная система логирования на базе библиотеки `debug`.
- **Файл:** `src/renderer/utils/logger.ts`.
- **Категории:** `app:claude`, `app:tabs`, `app:commands`, `app:perf`, `app:terminal`, `app:store`, `app:ui`.
- **Управление:** Включается через консоль DevTools: `localStorage.debug = 'app:*'`.
- **Хелперы:** Доступны через глобальный объект `window.debug`.

## 6. Styling & Rendering
- **Tailwind v4:** Использует JIT-компиляцию и директиву `@source` для сканирования `.tsx` файлов. См. `knowledge/fix-tailwind-v4-source.md`.
- **Dynamic Styles:** Для рантайм-цветов используются Inline Styles. См. `knowledge/fix-data-persistence.md`.
- **Markdown:** Специальный рендерер для исправления гидратации и inline-кода. См. `knowledge/fix-markdown-hydration.md` и `knowledge/fix-markdown-inline-code.md`.
- **Hotkeys:** Перехват `Cmd+Plus/Minus` для изменения шрифта терминала вместо системного зума. См. `knowledge/fix-ui-stability.md` (раздел 6).

## 7. UI Patterns & Modals
- **Context Modals (Notes, Research):** Должны рендериться внутри контейнера `Workspace` с использованием `absolute positioning` (inset-0) и `z-index: 50`. Контейнер Workspace должен иметь `relative`.
    - **Why:** Это обеспечивает правильное наложение поверх терминала, но сохранение контекста рабочей области, а также позволяет использовать "floating sheet" дизайн с отступами.
    - **Avoid:** Не использовать `createPortal(..., document.body)` для контекстных инструментов, так как это нарушает иерархию стилей и усложняет позиционирование относительно UI терминала.
- **Global Modals (Settings, Toasts):** Могут использовать Top-Level рендеринг в `App.tsx` или Portals, так как они должны перекрывать весь интерфейс независимо от контекста.
