# Noted Terminal

Electron-терминал для разработки с Claude Code и Gemini CLI. Не обёртка — инфраструктура управления контекстом, памятью и историей AI-сессий.

## Зачем

Все AI-инструменты теряют контекст: сессия закончилась → агент забыл всё. С 1M контекстом один агент умеет почти всё, но через 2 часа окно забито мусором — начинаешь заново или чистишь вручную.

Noted Terminal даёт три вещи которых нет ни у Cursor, ни у Claude CLI:

- **Fork / Rewind / Edit Range** — git для диалогов с AI
- **Knowledge Base + Semantic Router** — персистентная память проекта между сессиями
- **Visual Timeline** — история как дерево, а не лог

## Features

### Context Management

**Fork** — клонирование сессии в один клик. Получаешь полную копию истории в новом табе, оригинал не тронут. Основной паттерн: Fork → вырезать ненужное → продолжить с чистой историей.

**Edit Range** — компактирование. Выделяешь диапазон на Timeline (например 30 шагов неудачных тестов) → Gemini сжимает в резюме → Claude рестартует с чистым контекстом, суть сохранена.

**Rewind** — откат к любому сообщению. ПКМ по точке на Timeline → терминал автоматически навигирует по TUI-меню Claude (Escape → стрелки → Enter) → агент откатывается + получает резюме удалённого контекста. Ctrl+Z для разговора с AI.

### Knowledge Base

70+ файлов `docs/knowledge/` — персистентная память проекта:
- `fact-*` — как работают подсистемы, API-лимиты, ограничения платформ
- `fix-*` — баги которые стоили часов: что пробовали, почему не сработало, как починили

Семантический роутер: `???` в промпте → Haiku выбирает 2-4 релевантных файла из индекса → агент сразу в контексте. `docs_search` MCP — Claude сам вызывает без триггера от пользователя. Новый агент входит в проект за 5 минут.

### Timeline

Вертикальная полоса справа — каждая точка = сообщение. Клик → скролл к сообщению, наведение → превью. Session chain: `(root)` → `(plan mode)` → `(fork)` с маркером активной ветки. History Panel с markdown-рендером, syntax highlighting, token usage и range copy.

### Orchestration (Gemini → Claude)

Gemini CLI в одном табе управляет Claude-агентами в других через 6 MCP V2 tools:

| Tool | Назначение |
|------|-----------|
| `delegate_to_claude` | Создать таб с Claude, отправить промпт |
| `continue_claude` | Сообщение существующему агенту (auto-respawn при crash) |
| `read_claude_history` | Что агент наделал (summary / full / with_code) |
| `list_sub_agents` | Статусы ACTIVE / IDLE / STOPPED |
| `close_sub_agent` | Graceful shutdown + архивация |
| `update_docs` | Batch analysis → обновление knowledge/ |

Response Queue: zero-loss delivery, persistence в SQLite, восстановление после рестарта.

### Claude TUI Control

| Команда | Что делает |
|---------|-----------|
| Model switching | `/model default\|sonnet\|opus\|haiku` из UI-кнопки, Command Guard |
| Effort level | `/effort low\|medium\|high` — бюджет thinking tokens |
| Think mode | `meta+t` — парсинг picker menu, навигация стрелками |
| Handshake | Автоматическая отправка промпта при старте (History Restore, Delegation) |

### Docs Pipeline

Встроенный pipeline обновления документации: в конце сессии вставляешь промпт → Claude анализирует изменения → обновляет `docs/knowledge/`. Семантический индекс пересобирается через `build-index.sh`.

## Getting Started

```bash
# TODO: инструкции по установке и запуску
```

## Tech Stack

- **Runtime:** Electron 28
- **Frontend:** React 19 + Vite + TypeScript
- **State:** Zustand
- **Terminal:** xterm.js (Canvas renderer)
- **Styling:** Tailwind CSS v4
- **DB:** SQLite (sessions, projects, tabs)
- **AI Rendering:** react-markdown + remark-gfm + syntax-highlighter

## Architecture

### Event-Driven — ноль таймаутов

Всё управление через события, не `setTimeout`:
- `safePasteAndSubmit` с sync marker verification (`\x1b[?2026l`)
- OSC 7777 маркеры → xterm.js IMarker на точную строку
- OSC 133 детектит начало/конец команды, OSC 7 трекает CWD
- Busy state: content-based Braille spinner detection, не polling

### JSONL Parsing

Полный парсинг Claude Code JSONL — структурированные данные, не скриншот:
- **Backtrace** — обратный обход `parentUuid` цепочки с пропуском отменённых веток
- **Bridge following** — автоматический переход между файлами при Clear Context / Plan Mode
- **Incremental reader** — async чтение только новых байт, race-safe снапшот
- **Compact boundary recovery** — двухуровневый fallback после `/compact`

### Session Management

Три метода детекции sessionId:
- StatusLine Bridge: shell script → `~/.claude/bridge/`
- Sniper Watcher: `fs.watch` + 1s polling fallback, snapshot filtering
- Manual entry: real-time validation на диске

Session chain resolution: автоматический обход Plan Mode / Clear Context / Fork переходов через `resolveSessionChain()`.

### Rendering & Performance

- `TERM_PROGRAM=vscode` — Ink переключается на xterm.js-оптимизированный path (убрало 90% scroll jitter)
- Sync frame protection: BSU/ESU buffering → atomic write
- Canvas renderer (не WebGL) — instant tab switching
- GPU compositor: `will-change: transform`, React 19 `startTransition` для 200+ entries

### Workspace

Multi-project: каждый проект = набор табов + sessions + notes. Auto-naming, colors, drag-and-drop, multi-select (Shift/Cmd+Click), batch operations. SQLite persistence с safety guard.

## Testing

Two-tier:
- **Headless** (Node.js, <1s) — JSONL parsing, backtrace, TUI marker detection
- **E2E** (Playwright + Electron, 15-60s) — store polling, OSC signals, real PTY interaction
- Event-driven: `waitForClaudeSessionId`, `findInLogs('BoundaryMarker')`, no `waitForTimeout`

## License

MIT
