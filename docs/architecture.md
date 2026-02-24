# Architecture: Foundation

## 1. Process Model (Electron IPC)
- **Main Process:** Управляет `node-pty` (терминальными сессиями), SQLite базой данных (таблицы `projects`, `tabs`, `tab_history`, `favorites`), файловой системой и жизненным циклом внешних процессов.
    - **КРИТИЧЕСКОЕ ПРАВИЛО:** Запрещено использование `execSync`. Все системные вызовы (pgrep, lsof, ps) должны быть асинхронными (через `execAsync`). См. `knowledge/ui-input-events.md`.
    - **Vite & Escaping:** При написании Bash-команд в `main.js` необходимо экранировать `$`. См. `knowledge/environment-fixes.md`.
    - **Stability:** Используется `disable-http-cache` для предотвращения загрузки устаревшего кода. См. `knowledge/terminal-core.md`.
- **Renderer Process:** React 19 UI. Общается с Main через типизированные IPC-вызовы.
- **Focus & Activity Model:** 
    - **Area Focus:** Введено понятие `activeArea` ('projects' | 'workspace'). Переключение через `onMouseDown`. См. `knowledge/ui-react-patterns.md`.
    - **Effective Activity:** Терминал активен только при совпадении условий (tab active + terminal view + workspace visible).

## 2. Project Instance Model (Philosophy)
Проект — это уникальный ID в БД, а не просто путь на диске.
- **Entity vs Path:** Один путь может иметь несколько инстансов проектов с разной историей вкладок.
- **Navigation History (LRU):** Система хранит стек истории посещения табов. При закрытии активного таба переключает на предыдущий из стека. См. `knowledge/data-persistence.md`.

## 3. Startup & Recovery Flow
- **Persistent Workspace:** Компонент `Workspace` остается смонтированным всегда. Переход между Dashboard и Workspace через `visibility: hidden`. Это сохраняет контексты терминалов. См. `knowledge/ui-terminal-rendering.md`.
- **RestoreLoader:** Глобальный лоадер скрывает инициализацию PTY при запуске.

## 4. Terminal Integration
- **Backend:** `node-pty`.
- **Shell Integration (OSC 7 & 133):**
    - **OSC 7:** Передача текущего рабочего каталога (CWD).
    - **OSC 133:** Отслеживание жизненного цикла команд (start/finish). См. `knowledge/terminal-core.md`.
- **AI Integrations:**
    - **Claude StatusLine Bridge:** Захват Session ID через хук в Claude settings. См. `knowledge/fact-claude-tui-mechanics.md`.
    - **Claude Handshake:** Автоматическая отправка промпта при запуске (WAITING_PROMPT стейт).
    - **Claude TUI Control:** Программное управление Ink TUI через PTY. См. `knowledge/fact-claude-tui-mechanics.md` и `knowledge/fix-rewind-navigation.md`.
    - **Claude Ctrl-C Protection:** Предотвращение случайного выхода при быстром переключении моделей. См. `knowledge/fix-claude-ctrlc-exit.md`.
    - **Timeline Engine:** Асинхронный парсинг JSONL с алгоритмом Backtrace. См. `knowledge/ai-backtrace-jsonl.md`.
- **Large Input (Two-Tier Paste):** Обход macOS TTYHOG (1024 bytes) через атомарный чанкинг. См. `knowledge/fact-claude-tui-mechanics.md` и `knowledge/terminal-core.md`.

## 5. AI Session Recovery
Система восстановления прерванных сессий при перезагрузке и склеивания разорванных цепочек.
- **Tab Metadata:** `wasInterrupted`, `claudeSessionId` сохраняются в SQLite.
- **Session Linking:** Использование таблицы `session_links` для восстановления цепочек в Claude при Clear Context (Plan Mode), когда JSONL не содержит bridge-записей. См. `knowledge/fix-claude-plan-mode-chain.md`.
- **Interrupted Overlay:** UI для предложения восстановления. См. `knowledge/ui-ux-patterns.md`.

## 6. Debug Logger
Централизованная система на базе `debug` и `Tag-based Log Filter`. См. `knowledge/fact-console-interceptor.md`.

## 7. Styling & Rendering
- **Tailwind v4 + Vite:** Плагин `@tailwindcss/vite` для HMR и авто-сканирования. См. `knowledge/rendering-styles.md`.
- **Dynamic Styles:** Для рантайм-цветов используются Inline Styles. См. `knowledge/fix-tailwind-dynamic-runtime.md`.
- **Markdown Rendering:** Унифицированный просмотр через `@anthropic/markdown-editor`. См. `knowledge/file-preview-markdown.md`.
- **Native Virtualization:** Для списков до 1000 элементов используется `content-visibility: auto` вместо тяжелых JS-библиотек. См. `knowledge/fix-ui-stability.md`.

## 8. State Management (Zustand)
- **КРИТИЧЕСКОЕ ПРАВИЛО:** Любая мутация `tab.*` свойств в store **обязана** вызывать `set()`. Без `set()` Zustand не нотифицирует subscribers → компоненты показывают stale data. См. `knowledge/fix-zustand-silent-mutation.md`.
- **Guard Pattern:** Если мутация вызывается часто (Bridge poll каждые 2с), добавлять `if (old === new) return` перед `set()` чтобы избежать лишних re-render.
- **Polling Workaround (anti-pattern):** InfoPanel использует `setInterval(500ms)` + `getState()` для чтения session ID. Это обход проблемы silent mutation — новый код должен полагаться на `set()`, а не polling.

## 9. UI Patterns
- **Interactive Hover Zones:** Стратегия "Невидимого мостика". См. `knowledge/ui-react-patterns.md`.
- **Context Modals:** Рендеринг внутри Workspace с `absolute positioning` (не Portals в body).
