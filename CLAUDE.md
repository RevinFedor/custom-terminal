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
- **Async onData race:** Никогда не делай `await` внутри обработчика PTY `onData` без предварительной **синхронной блокировки** (cooldown/флаг). Высокочастотный вывод терминала породит десятки дублирующих асинхронных вызовов.
- **Не используй `execSync`** в main process — фризит весь UI
- **Не используй polling** для статуса процессов — используй OSC 133
- **Экранируй `$`** в bash-командах в main.js — Vite трансформирует их при сборке
- **Не используй `navigator.clipboard`** в renderer — используй `window.require('electron').clipboard`
- **TUI Logic Testing:** Для низкоуровневой логики парсинга терминала (маркеры, поиск в буфере) предпочитай **Headless Unit-тесты** (node + @xterm/headless). Playwright-тесты используй только для UI и IPC сценариев.

## Логирование (обязательно к соблюдению)
- **Глобальный интерсептор:** В main process `console.log/error/warn` перехватываются автоматически — логи пишутся в `logs/dev.log` (dev) и `logs/production.log` (packaged). Никаких специальных импортов или функций не нужно.
- **Контракт:** Все логи в main process ДОЛЖНЫ начинаться с `[Tag]` — например `console.log('[MyFeature] something happened')`. Только такие сообщения попадают в файл. Логи без `[` остаются только в stdout.
- **`console.error`** — ВСЕГДА пишется в файл с префиксом `[ERROR]`, даже без тега.
- **Дедупликация:** Повторяющиеся строки схлопываются в `×N`. Не бойся частых логов в горячих путях — спама не будет.
- **НЕ создавай** отдельные логгеры, файлы логов или `fs.appendFile` для логирования. Всё идёт через единый `console.log('[Tag]')` перехватчик.

## Тестирование
- **Playwright-тесты:** `auto/` — entry point: `auto/context.md`, запуск: `node auto/stable/test-name.js`
- **Observability:** В Main-процессе реализовано логирование `[GeminiSpinner] THINKING/IDLE` для отслеживания состояний Gemini CLI в тестах.

## Ключевые решения (Knowledge Base)
### AI Orchestration
- **Busy State Detection:** [`fix-claude-busy-detection.md`](docs/knowledge/fix-claude-busy-detection.md) — решение проблемы ложных срабатываний и зависания busy-индикатора (OSC sequences & Spinner regex).
- **MCP Delegation:** [`fact-mcp-delegation.md`](docs/knowledge/fact-mcp-delegation.md) — общая архитектура.
- **Sub-Agent Lifecycle V2:** [`fact-mcp-v2-lifecycle.md`](docs/knowledge/fact-mcp-v2-lifecycle.md) — восстановление суб-агентов после рестарта и синтетические ID.
- **Handshake Fix:** [`fix-gemini-delegation-handshake.md`](docs/knowledge/fix-gemini-delegation-handshake.md) — решение проблем с разрывом slash-команд при делегации Gemini → Claude.
- **PTY Middleware:** [`fact-terminal-core.md`](docs/knowledge/fact-terminal-core.md) — детерминированные границы через OSC 7777.
- **Multi-instance Isolation:** [`fix-mcp-multi-instance.md`](docs/knowledge/fix-mcp-multi-instance.md) — изоляция портов через PID.

### Data Layer (Persistence)
- **Sessions & History:** [`fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md) — общая логика SQLite.
- **Tab Identity:** [`fix-tab-persistence.md`](docs/knowledge/fix-tab-persistence.md) — использование `tab_id` для сохранения связей суб-агентов.
- **Project Instances:** [`fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md) — почему проекты стали UUID-сущностями.
