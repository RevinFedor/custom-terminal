# Noted Terminal

## Обзор
Noted Terminal — кастомный эмулятор терминала на базе Electron с глубокой интеграцией AI-агентов (Gemini CLI, Claude Code) и управлением проектами.

## Технический Стек
- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer)
- **Styling:** Tailwind CSS v4
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter
- **DB:** SQLite (Sessions & Projects)


## State Management
- **ProjectWorkspace:** Хранит состояние вкладок, директорий и активных сессий проекта.
- **viewingSubAgentTabId:** Позволяет переключать вьюпорт на суб-агента, сохраняя основной фокус на родительском табе (Gemini).
- **effectiveTab Pattern:** Абстракция в `Workspace.tsx`, которая резолвит текущий "смысловой" таб (суб-агент или активный). Используется для автоматического переключения Timeline, поиска и заметок.

## Документация
Вся документация в `docs/knowledge/` — единая плоская структура:
- **`fix-*`** — шрамы: баги, фиксы, обходные решения
- **`fact-*`** — факты: как работают подсистемы, платформенные ограничения, поведение фич

Нет иерархии. Семантический роутер (`???` в конце промпта) автоматически выбирает нужные файлы.

## Anti-Patterns (обязательно к соблюдению)
- **Zustand: Не подписывайся на Map целиком:** Подписка на `openProjects` вызывает ре-рендер всего приложения при любом изменении в любой вкладке (из-за `new Map` ссылки). Используй гранулярные селекторы (Fingerprint Pattern). См. [`fix-performance-lags.md`](docs/knowledge/fix-performance-lags.md).
- **O(n²) Restore Cascade:** При восстановлении сессии (множественное создание табов) обязательно используй флаг `isRestoring`. `createTab` не должен триггерить `set()` и `saveTabs()` внутри цикла восстановления.
- **Async Large File I/O:** Никогда не читай большие файлы (>1MB) синхронно в main process. Для JSONL-логов Claude используй асинхронный Incremental Reader. См. [`fix-performance-lags.md`](docs/knowledge/fix-performance-lags.md).
- **Не используй `activeProjectId` для фоновых задач:** При создании суб-агентов или обновлении данных в фоне (через MCP), всегда ищи целевой проект по `tabId` в `openProjects`. `activeProjectId` отражает только то, что пользователь видит в UI в данный момент, и может не совпадать с проектом, где работает агент.
- **Избегай серверного состояния (Watermark) для истории:** Не пытайся отслеживать в памяти сервера, сколько ходов истории уже "прочитал" агент. Это блокирует повторное чтение с разной детализацией и сбрасывается при рестарте. Используй Stateless API с параметром `last_n`.
- **Async onData race:** Никогда не делай `await` внутри обработчика PTY `onData` без предварительной **синхронной блокировки** (cooldown/флаг). Высокочастотный вывод терминала породит десятки дублирующих асинхронных вызовов.
- **Не используй `execSync`** в main process — фризит весь UI
- **Не используй polling** для статуса процессов — используй OSC 133
- **Экранируй `$`** в bash-командах в main.js — Vite трансформирует их при сборке
- **Не используй `navigator.clipboard`** в renderer — используй `window.require('electron').clipboard`
- **TUI Logic Testing:** Для низкоуровневой логики парсинга терминала (маркеры, поиск в буфере) предпочитай **Headless Unit-тесты** (node + @xterm/headless). Playwright-тесты используй только для UI и IPC сценариев.

## Логирование (обязательно к соблюдению)
- **Глобальный интерсептор:** В main process `console.log/error/warn` перехватываются автоматически. Никаких специальных импортов или функций не нужно.
  - **Dev:** `logs/dev.log` (в корне проекта)
  - **Production (packaged):** `~/Library/Logs/noted-terminal/production.log` (через `app.getPath('logs')`). См. [`fix-packaged-app-logs.md`](docs/knowledge/fix-packaged-app-logs.md).
- **Контракт:** Все логи в main process ДОЛЖНЫ начинаться с `[Tag]` — например `console.log('[MyFeature] something happened')`. Только такие сообщения попадают в файл. Логи без `[` остаются только в stdout.
- **`console.error`** — ВСЕГДА пишется в файл с префиксом `[ERROR]`, даже без тега.
- **Дедупликация:** Повторяющиеся строки схлопываются в `×N`. Не бойся частых логов в горячих путях — спама не будет.
- **НЕ создавай** отдельные логгеры, файлы логов или `fs.appendFile` для логирования. Всё идёт через единый `console.log('[Tag]')` перехватчик.

## Тестирование
- **Полная документация:** [`auto/context.md`](auto/context.md) — entry point, шаблоны, troubleshooting, event-driven паттерны.
- **Философия:** [`fact-test-infrastructure.md`](docs/knowledge/fact-test-infrastructure.md) — два уровня (Headless + E2E), структура папок.
- **Playwright-тесты:** `auto/` — запуск: `node auto/stable/test-name.js`
- **Observability:** В Main-процессе реализовано логирование `[GeminiSpinner] THINKING/IDLE` и `[Spinner] BUSY/IDLE` для E2E тестов.

## Ключевые решения (Knowledge Base)
### AI Orchestration
- **Performance Lags:** [`fix-performance-lags.md`](docs/knowledge/fix-performance-lags.md) — устранение фризов через инкрементальное чтение и оптимизацию селекторов.
- **Range-based Timeline:** [`fact-timeline.md`](docs/knowledge/fact-timeline.md) — детерминированная подсветка сообщений через диапазоны строк (владение блоком). Решает проблему "мертвого" таймлайна при скролле длинных ответов и ложных срабатываний при дублировании текста (Claude sub-agent responses).
- **Busy State Detection:** [`fix-claude-busy-detection.md`](docs/knowledge/fix-claude-busy-detection.md) — решение проблемы ложных срабатываний и зависания busy-индикатора (OSC sequences & Spinner regex).
- **MCP Delegation:** [`fact-mcp-delegation.md`](docs/knowledge/fact-mcp-delegation.md) — общая архитектура и система очереди ответов (Response Queue).
- **Completion Reliability:** [`fix-mcp-completion-reliability.md`](docs/knowledge/fix-mcp-completion-reliability.md) — детерминированное завершение через `turn_duration`, Deferred Re-check и валидацию таймстампов (`end_turn` guard).
- **Sub-Agent Lifecycle V2:** [`fact-mcp-v2-lifecycle.md`](docs/knowledge/fact-mcp-v2-lifecycle.md) — восстановление после рестарта, персистентные Task ID и stateless история (last_n).
- **Handshake Fix:** [`fix-gemini-delegation-handshake.md`](docs/knowledge/fix-gemini-delegation-handshake.md) — решение проблем с разрывом slash-команд при делегации Gemini → Claude.
- **Compact Logic:** [`fix-compact-logic.md`](docs/knowledge/fix-compact-logic.md) — защита от ложных форков после сжатия и логика извлечения саммари для Claude/Gemini.
- **Timeout Stability:** [`fix-mcp-timeout-stability.md`](docs/knowledge/fix-mcp-timeout-stability.md) — предотвращение ложных таймаутов через управляемые таймеры и персистентные метки времени.
- **PTY Middleware:** [`fact-terminal-core.md`](docs/knowledge/fact-terminal-core.md) — детерминированные границы через OSC 7777.
- **Multi-instance Isolation:** [`fix-mcp-multi-instance.md`](docs/knowledge/fix-mcp-multi-instance.md) — изоляция портов через PID.
- **Interceptor Re-arm:** [`fact-interceptor-rearm.md`](docs/knowledge/fact-interceptor-rearm.md) — ручное вмешательство и управление перехватом ответов субагентов.
- **Lifecycle Management:** [`fact-mcp-v2-lifecycle.md`](docs/knowledge/fact-mcp-v2-lifecycle.md) — закрытие суб-агентов через `close_sub_agent`.

### Infrastructure & Data Layer
- **Production Logs:** [`fix-packaged-app-logs.md`](docs/knowledge/fix-packaged-app-logs.md) — почему нельзя писать логи в `app.asar`.
- **Sessions & History:** [`fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md) — общая логика SQLite.
- **Tab Identity:** [`fix-tab-persistence.md`](docs/knowledge/fix-tab-persistence.md) — использование `tab_id` для сохранения связей суб-агентов.
- **Safe Tab Persistence:** [`fix-save-tabs-data-loss.md`](docs/knowledge/fix-save-tabs-data-loss.md) — замена деструктивного `DELETE ALL + re-INSERT` на targeted DELETE с safety guard.
- **Project Instances:** [`fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md) — почему проекты стали UUID-сущностями.
