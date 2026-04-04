<p align="center">
  <h1 align="center">Noted Terminal</h1>
  <p align="center">
    Electron-терминал для разработки с Claude Code и Gemini CLI.<br/>
    Не обёртка — инфраструктура управления контекстом, памятью и историей AI-сессий.
  </p>
</p>

---

## Проблема

Все AI-инструменты теряют контекст: сессия закончилась → агент забыл всё. С 1M контекстом один агент умеет почти всё, но через 2 часа окно забито мусором — начинаешь заново или чистишь вручную.

**Noted Terminal даёт три вещи которых нет ни у Cursor, ни у Claude CLI:**

| | Возможность | Суть |
|---|---|---|
| 🔀 | **Fork / Rewind / Edit Range** | Git для диалогов с AI |
| 🧠 | **Knowledge Base + Semantic Router** | Персистентная память проекта между сессиями |
| 📊 | **Visual Timeline** | История как дерево, а не лог |

---

## Features

### 🔀 Context Management

<details>
<summary><b>Fork</b> — клонирование сессии в один клик</summary>

Нажал кнопку → получил полную копию истории в новом табе, оригинал не тронут.

Основной паттерн: **Fork → вырезать ненужное → продолжить с чистой историей.**

</details>

<details>
<summary><b>Edit Range</b> — компактирование мусора в резюме</summary>

Выделяешь диапазон на Timeline (например 30 шагов где Claude не мог пройти тесты) → Gemini сжимает в резюме: *"пробовали X, Y, Z — не вышло, ошибка была в W"* → JSONL редактируется, Claude рестартует с чистым контекстом.

Контекстное окно освободилось, суть сохранилась.

</details>

<details>
<summary><b>Rewind</b> — откат к любому сообщению</summary>

ПКМ по точке на Timeline → терминал автоматически навигирует по TUI-меню Claude (Escape → стрелки → выбор → Enter) → агент откатывается + получает резюме удалённого контекста.

По сути **Ctrl+Z для разговора с AI** — вернуться в точку где всё было хорошо и пойти другим путём.

</details>

---

### 🧠 Knowledge Base + Semantic Router

70+ файлов `docs/knowledge/` — **персистентная память проекта**, которая переживает любую сессию:

| Тип | Содержимое |
|-----|-----------|
| `fact-*` | Как работают подсистемы, API-лимиты, ограничения платформ |
| `fix-*` | Баги которые стоили часов: что пробовали, почему не сработало, как починили |

> Записывается только то, что AI **не может вывести из кода**: мотивация, отброшенные подходы, неочевидные связи.

**Как работает поиск:**

```
Пользователь: "почему sync возвращает 0 полей ???"
                                                  ↓
              UserPromptSubmit хук перехватывает промпт по триггеру ???
                                                  ↓
              Промпт + .semantic-index.json → Claude Haiku
                                                  ↓
              Haiku выбирает 2-4 релевантных файла по тегам и симптомам
                                                  ↓
              Содержимое файлов инжектится в контекст Claude Code
                                                  ↓
              Claude сразу знает: "Axenta имеет telemetryAccountId: null,
              искать нужно через userId"
```

- **`???`** в промпте — ручной триггер, Haiku роутинг
- **`docs_search` MCP** — Claude сам вызывает когда работает с незнакомой подсистемой
- **`build-index.sh`** — офлайн-индексация: Haiku извлекает explicit-темы, implicit-концепции и symptoms из каждого файла

> Новый агент (хоть другая модель через полгода) за 5 минут входит в проект на уровне, недостижимом для человека за неделю.

---

### 📊 Timeline

Вертикальная полоса справа — **каждая точка = сообщение**.

- Клик → скролл терминала к сообщению
- Наведение → превью текста промпта
- Session chain: `(root)` → `(plan mode)` → `(fork)` с маркером активной ветки
- **History Panel:** полная markdown-рендеренная история с syntax highlighting и diff-view
- Compact counter `♻️ ×N`, token usage, длительность каждого хода
- Range copy: выбор диапазона сообщений для экспорта

---

### 🤖 Orchestration (Gemini → Claude)

Gemini CLI в одном табе управляет Claude-агентами в других через **6 MCP V2 tools**.

> Не для параллельного кодинга (с 1M контекстом один агент справляется сам). Для случаев когда нужен **другой контекст**: фоновые тесты, аудит кода с чистого листа, автообновление документации.

| Tool | Назначение |
|------|-----------|
| `delegate_to_claude` | Создать таб с Claude, отправить промпт |
| `continue_claude` | Сообщение существующему агенту (auto-respawn при crash) |
| `read_claude_history` | Что агент наделал (`summary` / `full` / `with_code`) |
| `list_sub_agents` | Статусы `ACTIVE` / `IDLE` / `STOPPED` |
| `close_sub_agent` | Graceful shutdown + архивация таба |
| `update_docs` | Batch analysis → обновление knowledge/ |

**Response Queue:** zero-loss delivery, persistence в SQLite, восстановление после рестарта.

---

### ⌨️ Claude TUI Control

| Команда | Что делает |
|---------|-----------|
| `/model` | `default\|sonnet\|opus\|haiku` из UI-кнопки. Command Guard блокирует double operations |
| `/effort` | `low\|medium\|high` — бюджет thinking tokens (5K/16K/50K) |
| `meta+t` | Think mode — парсинг picker menu, навигация стрелками |
| Handshake | Автоматическая отправка промпта при старте (History Restore, Delegation) |

---

### 📝 Docs Pipeline

В конце сессии вставляешь промпт `docs-rules.prompt.md` → Claude анализирует изменения → обновляет `docs/knowledge/`. Фильтрация: только невидимый контекст (мотивация, шрамы, неочевидные связи — не пересказ кода). Индекс пересобирается через `build-index.sh`.

---

## Getting Started

```bash
# TODO: инструкции по установке и запуску
```

## Tech Stack

| | Технология |
|---|---|
| Runtime | Electron 28 |
| Frontend | React 19 + Vite + TypeScript |
| State | Zustand |
| Terminal | xterm.js (Canvas renderer) |
| Styling | Tailwind CSS v4 |
| DB | SQLite (sessions, projects, tabs) |
| AI Rendering | react-markdown + remark-gfm + syntax-highlighter |

---

## Architecture

<details>
<summary><b>Event-Driven — ноль таймаутов</b></summary>

Всё управление через события, не `setTimeout`:
- `safePasteAndSubmit` с sync marker verification (`\x1b[?2026l]`)
- OSC 7777 маркеры → xterm.js IMarker на точную строку
- OSC 133 детектит начало/конец команды, OSC 7 трекает CWD
- Busy state: content-based Braille spinner detection (`✢✳✶✻✽`), 500ms debounce
- Результат: ноль потерянных команд, ноль race conditions

</details>

<details>
<summary><b>JSONL Parsing</b></summary>

Полный парсинг Claude Code JSONL — структурированные данные, не скриншот:
- **Backtrace** — обратный обход `parentUuid` цепочки с пропуском Escape-отменённых веток
- **Bridge following** — автоматический переход между файлами при Clear Context / Plan Mode
- **Incremental reader** — async чтение только новых байт, race-safe снапшот перед `await`
- **Compact boundary recovery** — двухуровневый fallback после `/compact`
- **Sub-agent progress** — группировка по `parentToolUseID`, inline отображение в timeline

</details>

<details>
<summary><b>Session Management</b></summary>

Три метода детекции sessionId:
- **StatusLine Bridge:** shell script после каждого ответа Claude → `~/.claude/bridge/`
- **Sniper Watcher:** `fs.watch` + 1s polling fallback, snapshot filtering
- **Manual entry:** real-time validation на диске

Session chain resolution: автоматический обход Plan Mode / Clear Context / Fork через `resolveSessionChain()` (backward walk) и `resolveLatestSessionInChain()` (forward walk).

</details>

<details>
<summary><b>Rendering & Performance</b></summary>

- `TERM_PROGRAM=vscode` — Ink переключается на xterm.js-оптимизированный path (убрало 90% scroll jitter)
- Sync frame protection: BSU/ESU buffering → atomic write
- Canvas renderer (не WebGL) — instant tab switching, stale recovery
- GPU compositor: `will-change: transform`, React 19 `startTransition` для 200+ entries

</details>

<details>
<summary><b>Workspace & Projects</b></summary>

Multi-project: каждый проект = набор табов + sessions + notes.
- Auto-naming (`claude-N`, `gemini-N`, `docs-XX`), colors, drag-and-drop
- Multi-select: Shift+Click range, Cmd+Click toggle, batch operations
- SQLite persistence с safety guard (no silent data loss)
- Terminal buffer serialization: save/restore при switch между табами
- Dashboard: процесс-мониторинг (In-App vs External), stop button

</details>

---

## Testing

Two-tier:

| Уровень | Runtime | Скорость | Что тестирует |
|---------|---------|----------|--------------|
| Headless | Node.js | <1s | JSONL parsing, backtrace, TUI markers |
| E2E | Playwright + Electron | 15-60s | Store polling, OSC signals, real PTY |

Event-driven: `waitForClaudeSessionId`, `findInLogs('BoundaryMarker')`, no `waitForTimeout`.

---

## License

MIT
