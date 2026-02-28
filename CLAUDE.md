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

## Тестирование
- **Playwright-тесты:** `auto/` — entry point: `auto/context.md`, запуск: `node auto/stable/test-name.js`
- **Observability:** В Main-процессе реализовано логирование `[GeminiSpinner] THINKING/IDLE` для отслеживания состояний Gemini CLI в тестах.

## Ключевые решения (Knowledge Base)
### AI Orchestration
- **Busy State Detection:** [`fix-claude-busy-detection.md`](docs/knowledge/fix-claude-busy-detection.md) — решение проблемы ложных срабатываний и зависания busy-индикатора (OSC sequences & Spinner regex).
- **MCP Delegation:** [`fact-mcp-delegation.md`](docs/knowledge/fact-mcp-delegation.md) — общая архитектура.
- **Handshake Fix:** [`fix-gemini-delegation-handshake.md`](docs/knowledge/fix-gemini-delegation-handshake.md) — решение проблем с разрывом slash-команд при делегации Gemini → Claude.
- **PTY Middleware:** [`fact-terminal-core.md`](docs/knowledge/fact-terminal-core.md) — детерминированные границы через OSC 7777.
- **Multi-instance Isolation:** [`fix-mcp-multi-instance.md`](docs/knowledge/fix-mcp-multi-instance.md) — изоляция портов через PID.

### Data Layer (Persistence)
- **Sessions & History:** [`fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md) — общая логика SQLite.
- **Tab Identity:** [`fix-tab-persistence.md`](docs/knowledge/fix-tab-persistence.md) — использование `tab_id` для сохранения связей суб-агентов.
- **Project Instances:** [`fact-data-persistence.md`](docs/knowledge/fact-data-persistence.md) — почему проекты стали UUID-сущностями.
