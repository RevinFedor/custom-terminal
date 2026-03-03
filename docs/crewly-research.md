# Crewly AI — Technical Research

**Дата:** 2026-03-03
**Пакет:** `crewly@1.2.3` (npm)
**Сайт:** crewlyai.com
**GitHub:** github.com/stevehuang0115/crewly
**Лицензия:** MIT
**Размер:** 11 MB (unpacked)
**Локальная копия:** `/tmp/crewly-pkg/package/` (распакован через `npm pack crewly`)

---

## TL;DR — Что это такое

Crewly — **process manager + message bus для CLI-агентов**, а не полноценный оркестратор. Запускает Claude Code / Gemini CLI / Codex в PTY-сессиях с ролевыми промптами, мониторит здоровье процессов, рестартит при падении, шлёт алерты в Slack. Оркестратор — это просто ещё один LLM в PTY, бэкенд пайпит текст туда-сюда без анализа содержимого.

**Нет feedback loop.** Агент не "возвращает" результаты. Бэкенд видит только:
- Терминал замолчал → `idle` (polling каждые 2 мин)
- CLI процесс вышел → regex `/Claude exited/i` или `pgrep` fallback
- Regex по stdout → `/task completed/i` → определяет conclusion, но action-методы — TODO-заглушки

---

## Общая архитектура

- **Backend:** Express + Socket.IO + node-pty (прямой PTY, без tmux)
- **Frontend:** Vite + React, собрано в `frontend/dist/`
- **Terminal rendering:** `@xterm/headless` v6 (серверный парсинг)
- **MCP:** `@modelcontextprotocol/sdk` v0.5 — есть mcp-server и mcp-client
- **Messaging:** Slack (@slack/bolt), WhatsApp (@whiskeysockets/baileys), Discord, Telegram
- **Storage:** JSON-файлы на диске (не SQLite)
- **Dependencies:** node-pty, express, socket.io, ws, chokidar, commander, yaml, ajv, pdf-parse

---

## Оркестрация: как реально работает

### Архитектура: "LLM-as-orchestrator"

Оркестратор — Claude Code (или Gemini CLI) запущенный в PTY-сессии `crewly-orc`. Бэкенд — пассивный pipe:

```
User (Slack/Web/Dashboard)
    → MessageQueueService → QueueProcessorService
    → sendMessageToAgent() — текст вставляется в PTY оркестратора
    → LLM сам решает что делать (backend НЕ видит и НЕ анализирует)
    → ответ захватывается из терминала
    → ResponseRouterService → обратно в Slack/Web
```

**Бэкенд не анализирует ответы оркестратора. Не принимает решений. Просто пайпит текст.**

### MCP Tools оркестратора

| Tool | Работает? | Что делает |
|------|-----------|------------|
| `crewly_get_teams` | Да | Читает статусы из JSON |
| `crewly_get_status` | Да | Читает статусы |
| `crewly_create_team` | Да | Создаёт metadata |
| `crewly_assign_task` | **Частично** | Пишет ticketId в массив, НЕ доставляет задачу агенту |
| `crewly_send_message` | **Стаб** | Возвращает "queued" но ничего не шлёт |
| `crewly_recall_memory` | Да | Поиск по knowledge base |

`crewly_send_message` — буквально возвращает `{ message: 'Message received and queued' }` без реальной отправки. Комментарий в коде: `"For now, return a confirmation"`.

### ContinuationService — анализ есть, действий нет

Анализирует вывод → определяет conclusion → рекомендует action. Но ВСЕ методы исполнения — TODO:

```javascript
// TODO: Integrate with PtySessionBackend to actually inject the prompt
// TODO: Integrate with TaskService to find and assign next task
// TODO: Integrate with external notification system
// TODO: Integrate with PtySessionBackend to actually pause
```

### Quality Gates — не подключены к flow

`QualityGateService` реально работает (typecheck, tests, lint, build с AJV-валидацией), но ни один code path не вызывает его при завершении задачи. Standalone REST endpoint, не часть orchestration.

### Crash Recovery — единственное что реально работает

При падении агента `RuntimeExitMonitorService`:
1. Сохраняет Claude session ID
2. Kill PTY → создаёт новую сессию → `--resume`
3. Читает task file → вставляет текст задачи в PTY
4. Broadcast WebSocket event

Аналогично при 95% контекста: kill → restart → resume → re-deliver tasks.

---

## Busy Detection: как понимают что Claude генерирует

**Нет real-time детекции.** Никакого spinner detection.

`ActivityMonitorService` — polling каждые 2 минуты:
- `capturePane(sessionName)` — снимок терминала
- Сравнивает с предыдущим: `currentOutput !== previousOutput`
- Если текст изменился → `workingStatus = 'in_progress'`, иначе → `'idle'`
- Результат пишется в `teamWorkingStatus.json`

Единственное применение — не прерывать compact, пока агент busy.

---

## Completion Detection: как понимают что ответ завершён

### OutputAnalyzer — regex по stdout

Принимает очищенный от ANSI текст, прогоняет через 4 группы regex:

**1. Completion signals:**
- `/task\s+(completed?|done|finished)/i`
- `/all\s+tests\s+pass(ed)?/i`
- `/build\s+(succeeded|successful|complete)/i`
- `/\[\w+\s+[a-f0-9]{7,}\]/` (git commit hash)
- `/gh\s+pr\s+create/i`, `/https:\/\/github\.com\/.*\/pull\/\d+/`
- `/\b(done|finished|completed)\b/i` ← ловит ЛЮБОЕ "done" в тексте

**2. Error patterns:**
- `/error TS\d+:/i`, `/SyntaxError:/i`, `/Build failed/i`
- `/\d+\s+fail(ed|ing)?/i`, `/FAIL\s+/`
- `/Error:/i`, `/Exception:/i`, `/fatal:/i` ← ловит любой Error: в логах

**3. Waiting signals:**
- `/waiting\s+for/i`, `/please\s+provide/i`
- `/\?\s*$/m` (строка заканчивается на `?` — ненадёжно!)
- `/shift\+tab\s+to\s+cycle/i` (Plan Mode detection)

**4. Idle patterns (только последние 10 строк):**
- `/\$\s*$/m`, `/>\s*$/m`, `/❯\s*$/m` (shell prompt)
- `/Claude\s+(Code\s+)?exited/i`, `/Session\s+ended/i`

### RuntimeExitMonitor — выход CLI

1. Rolling buffer PTY-данных → проверка exit regex
2. Debounce (`CONFIRMATION_DELAY_MS`)
3. Подтверждение через shell prompt (`$`, `>`, `❯`, `%`)
4. Fallback: periodic `pgrep -P <pid>` (child process alive?)
5. Gemini: exponential backoff retry при transient API errors

---

## Context Window Monitor

**Regex по PTY-выводу для извлечения % контекста:**

```javascript
// Claude Code:
/(\d{1,3})%\s*(?:of\s+)?context/i    // "85% context"
/context[:\s]+(\d{1,3})%/i            // "context: 85%"
/(\d{1,3})%\s*ctx/i                    // "85% ctx"

// Gemini CLI (token-based):
/(\d+(?:\.\d+)?)\s*(K|M)?\s*context\s+left/i  // "500K context left"
```

### Пороги:
- **Yellow (70%):** Warning event
- **Red (85%):** Warning + автоматический `/compact\r` в PTY
- **Critical (95%):** Retry compact с cooldown; опционально kill + restart

### Auto-compact логика:
1. Проверяет `workingStatus !== 'in_progress'` (не прерывать работу)
2. Для Claude/Codex: Escape (`\x1b`) + 200ms delay, потом `/compact\r`
3. Для Gemini: пропускает Escape (может отменить запрос), сразу `/compress\r`
4. После compact ждёт `COMPACT_WAIT_MS`, проверяет снизился ли %
5. Max `MAX_COMPACT_ATTEMPTS` попыток, потом cooldown

### Proactive compact:
Отслеживает кумулятивный объём PTY-вывода (байты). При превышении `PROACTIVE_COMPACT_THRESHOLD_BYTES` — запускает compact даже если % контекста неизвестен.

---

## PTY Session

Обёртка над node-pty:

```javascript
session.write(data)  // прямая запись в PTY, без safePasteAndSubmit
```

- `forceKill()`: SIGTERM → 200ms delay → SIGKILL процесс + SIGKILL process group
- `isChildProcessAlive()`: через `pgrep -P <pid>` (execSync!)

**Нет:** bracketed paste, TTYHOG chunking, handshake, OSC markers, spinner detection.

---

## Idle Detection

`PtyActivityTrackerService` — `Map<sessionName, lastActivityTimestamp>`:
- `recordFilteredActivity(name, rawData)` — strip ANSI, min bytes threshold
- `isIdleFor(name, durationMs)` — idle если нет вывода N минут
- Orchestrator exempt
- Доп. проверка: если `workingStatus === 'in_progress'` — не suspend'ить

---

## Сравнение с Noted Terminal

### Что у них есть, а у нас нет

| Фича | Реализовано? | Полезно нам? |
|------|-------------|-------------|
| Auto-compact при 85% контекста | **Да, работает** | **Да** — единственная реально полезная фича |
| Proactive compact по объёму вывода | **Да, работает** | **Да** |
| 14 ролевых промптов (5-8KB) | Да | Может быть |
| Quality Gates (typecheck/tests/lint) | Да, но не подключены к flow | Нет |
| Memory System (agent/project/session) | Да | У нас есть CLAUDE.md |
| Slack/WhatsApp/Telegram нотификации | Да | Нет |
| Web Dashboard | Да | Нет (Electron) |
| Crash recovery с task re-delivery | Да | Может быть |

### Чего у них нет (наши преимущества)

| Аспект | Crewly | Noted Terminal |
|--------|--------|----------------|
| "Думает ли Claude?" | 2-min polling + output diff | Spinner regex (sub-second) |
| "Ответ завершён?" | Regex по stdout (fragile) | JSONL Guard: `turn_duration` + `stop_reason` |
| "CLI вышел?" | Exit regex + shell prompt + pgrep | OSC 133 + process events |
| Real-time granularity | ~120 секунд | ~100ms |
| False positives | `Error:` / `done` matchит любой лог | Структурный JSONL парсинг |
| Orchestration | Пассивный pipe (LLM решает сам) | Активный бэкенд (JSONL Guard + Response Queue + Interceptor) |
| Paste reliability | `session.write(data)` | Bracketed paste + TTYHOG chunking |
| Cross-model delegation | Нет | Gemini → Claude через MCP HTTP |
| Response Queue | Нет | С определением занятости Gemini |
| Handshake protocol | Нет | Sequential slash commands + debounce |
| Boundary markers | Нет | OSC 7777 (Timeline навигация) |
| Deferred re-check | Нет | До 40 перепроверок с 3s интервалом |

---

## Ключевые файлы (пути в распакованном пакете)

### PTY & Session Management
```
dist/backend/backend/src/services/session/pty/pty-session.js
dist/backend/backend/src/services/session/pty/pty-session-backend.js
dist/backend/backend/src/services/session/session-command-helper.js
dist/backend/backend/src/services/session/session-state-persistence.js
```

### Completion & Continuation Detection
```
dist/backend/backend/src/services/continuation/output-analyzer.service.js      # regex анализ stdout
dist/backend/backend/src/services/continuation/continuation.service.js         # TODO-заглушки в action методах
dist/backend/backend/src/services/continuation/continuation-events.service.js  # EventEmitter + debounce
dist/backend/backend/src/services/continuation/patterns/completion-patterns.js
dist/backend/backend/src/services/continuation/patterns/error-patterns.js
dist/backend/backend/src/services/continuation/patterns/idle-patterns.js
dist/backend/backend/src/services/continuation/patterns/waiting-patterns.js
```

### Agent Lifecycle & Monitoring
```
dist/backend/backend/src/services/agent/idle-detection.service.js
dist/backend/backend/src/services/agent/pty-activity-tracker.service.js
dist/backend/backend/src/services/agent/context-window-monitor.service.js      # auto-compact, 967 строк
dist/backend/backend/src/services/agent/runtime-exit-monitor.service.js        # exit detection, 732 строки
dist/backend/backend/src/services/agent/agent-heartbeat.service.js
dist/backend/backend/src/services/agent/agent-registration.service.js
dist/backend/backend/src/services/monitoring/activity-monitor.service.js       # 2-min polling busy detection
```

### Runtime Adapters
```
dist/backend/backend/src/services/agent/claude-runtime.service.js
dist/backend/backend/src/services/agent/gemini-runtime.service.js
dist/backend/backend/src/services/agent/codex-runtime.service.js
dist/backend/backend/src/services/agent/runtime-agent.service.abstract.js
```

### Orchestrator
```
dist/backend/backend/src/services/orchestrator/orchestrator-restart.service.js
dist/backend/backend/src/controllers/orchestrator/orchestrator.controller.js    # mock data в getOrchestratorCommands
dist/backend/backend/src/services/mcp-server.js                                # MCP tools (send_message = стаб)
```

### Quality Gates
```
dist/backend/backend/src/services/quality/quality-gate.service.js
dist/backend/backend/src/services/quality/task-output-validator.service.js
```

### Roles & Prompts
```
config/roles/developer/prompt.md          # 8.0kB
config/roles/architect/prompt.md          # 5.7kB
config/roles/ops/prompt.md               # 8.2kB
config/roles/qa/prompt.md
config/roles/frontend-developer/prompt.md
config/roles/backend-developer/prompt.md
config/roles/product-manager/prompt.md
(+ ещё 7 ролей)
```

### Constants
```
config/constants.ts                    # 28.7kB — ВСЕ пороги и таймауты
```

---

## Команды для повторного исследования

```bash
# Скачать и распаковать (если /tmp очищен)
mkdir -p /tmp/crewly-pkg && cd /tmp/crewly-pkg
npm pack crewly && tar xzf crewly-*.tgz

# Все JS файлы
find /tmp/crewly-pkg/package/dist -name "*.js" | sort

# Поиск по коду
grep -r "PATTERN" /tmp/crewly-pkg/package/dist/backend/

# Константы (все пороги, таймауты, regex'ы)
cat /tmp/crewly-pkg/package/config/constants.ts

# Промпты ролей
ls /tmp/crewly-pkg/package/config/roles/*/prompt.md

# MCP server (все tools)
cat /tmp/crewly-pkg/package/dist/backend/backend/src/services/mcp-server.js

# Orchestrator controller (mock data)
cat /tmp/crewly-pkg/package/dist/backend/backend/src/controllers/orchestrator/orchestrator.controller.js
```
