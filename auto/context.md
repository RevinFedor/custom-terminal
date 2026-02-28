# Auto — Тестовая инфраструктура Noted Terminal

```
auto/
├── context.md                        # ТЫ ЗДЕСЬ. Читай первым.
├── playwright/                       # Справка: Playwright + Electron
│   ├── basics.md                     # Шаблоны, селекторы, event-driven ожидания
│   └── electron.md                   # Electron: env, clipboard, IPC, build sync
├── libraries/                        # Справка: особенности тестируемых библиотек
│   ├── xterm.md                      # xterm.js: DOM, readiness, ввод, OSC 133
│   ├── zustand-store.md              # Zustand: чтение state, поля таба
│   └── browser-tab.md                # BrowserTab: activeView, webview focus
├── core/                             # Общий код тестов
│   ├── launcher.js                   # E2E: запуск Electron, log capture, хелперы
│   ├── electron.js                   # E2E: clipboard, focus, webContents
│   └── headless.js                   # Headless: assert, log, writeAndWait, createMiddleware
├── fixtures/                         # Фикстуры (golden sessions, mock data)
│   └── gemini-rewind-session.json    # Gemini: 13 сообщений для rewind-тестов
├── stable/                           # Рабочие тесты (регрессия)
│   ├── test-osc-boundary-markers.js  # [Headless] OSC 7777 state machine + xterm markers
│   ├── test-gemini-scroll-sameline.js # [Headless] scrollToTextInBuffer + truncation fallback
│   ├── test-gemini-timeline.js       # [E2E+Fixture] Timeline: рендер, IPC, slug/hash
│   ├── test-gemini-timeline-nav.js   # [E2E+Fixture] Timeline: клик по точкам, скролл
│   ├── test-gemini-rewind.js         # [E2E+Fixture] Gemini Rewind: /rewind, зелёное меню
│   ├── test-sniper-handshake.js      # [E2E+Claude] Sniper + Handshake: session detection
│   ├── test-ctrlc-danger-zone.js     # [E2E+Claude] Ctrl-C: "again to exit" блокировка
│   ├── test-ctrlc-rapid-model-switch.js # [E2E+Claude] Быстрая смена моделей
│   ├── test-timeline.js              # [E2E+Claude] Timeline: точки, парсинг DOM
│   ├── test-rewind-navigation.js     # [E2E+Claude] Rewind: TUI-навигация, RGB поиск
│   ├── test-session-export.js        # [E2E+Claude] Export: backtrace, форматирование
│   ├── test-plan-mode-detect.js      # [E2E+Claude] Plan Mode: Clear Context
│   ├── test-gemini-orchestration.js  # [E2E+Gemini+Claude] Gemini → Claude delegation, spinners, MCP
│   └── test-history-restore.js       # [E2E] History: восстановление из SQLite ⚠️ BROKEN
├── sandbox/                          # Одноразовые эксперименты. Готов → перенести в stable/
│   └── test-claude-busy-indicator.js # [E2E+Claude] Busy State: детекция без цвета + OSC stripping
└── screenshots/                      # Артефакты тестов
```

Метки тестов:
- **[Headless]** — чистый Node.js, без Electron. < 1 сек, 100% детерминированный.
- **[E2E+Fixture]** — Electron + golden session из `fixtures/`. Не требует реального AI.
- **[E2E+Claude]** — Electron + живой Claude. Требует CLI `claude` и ~30-60 сек.
- **[E2E+Gemini+Claude]** — Electron + живой Gemini CLI + Claude Code. ~120-300 сек. Используй hard kill 300с.

---

## Reliability & Troubleshooting (Критично)

**ПРАВИЛО НУЛЕВОГО ДЕЙСТВИЯ:** Прежде чем писать тест или менять код, **перечитай эту секцию**. Каждый пункт — результат реального бага, который стоил 30+ минут отладки.

Если тест падает с **Exit code 1** или "зависает" без вывода — проверь следующие пункты:

### 1. Проблема "Пустого вывода" (Empty Output)
Bash tool в Claude Code буферизирует stdout. Electron + Playwright через pipe теряют вывод при раннем crash'е.
**ОБЯЗАТЕЛЬНО:** Всегда запускай тесты через `tee`:
```bash
node auto/stable/test-name.js 2>&1 | tee /tmp/test-name.log
```
Без `tee` ты получишь пустой вывод и exit code 1 без какой-либо диагностики. Потом читай лог: `cat /tmp/test-name.log`.

### 2. State Isolation (Грязное состояние БД)
При запуске `launch()` приложение восстанавливает последнее состояние рабочей среды (табы, сессии) из SQLite.
**ЛОВУШКА:** Если активным табом при старте оказался остаток от прошлого теста (например, `claude-sub`), попытка запустить в нём другую команду (например, `gemini`) может не сработать.
**ПРАВИЛО:** В начале E2E тестов, если тебе нужна чистая среда, **создавай новый таб** (`await page.keyboard.press('Meta+t')`), дождись его появления, и только потом начинай работу. Не полагайся на дефолтный `activeTabId`.

### 3. Build Sync & Dev Server (Рассинхрон)
E2E тесты запускают приложение, используя `dist/main/main.js` и запущенный Dev Server (порт 5182).
**ПРАВИЛО (Build-Before-Test):**
- При **ЛЮБОМ** изменении файлов в `src/main/` — **сначала** `npx electron-vite build`, **потом** запуск теста. Без этого тест запустит старый код и ты будешь отлаживать несуществующий баг.
- При изменении `src/renderer/`, убедись, что запущен `npm run dev`.
- **Проверка:** Сравни timestamp `dist/main/main.js` с `src/main/main.js`. Если dist старше — нужен build.

### 4. Live Feedback & Logging
Тесты НЕ должны молчать. Пользователь/AI должен видеть прогресс в реальном времени.
- Используй `log.step()` **ДО** вызова `launch()` или `waitForTerminal()`.
- Если операция может занять >5 сек, выводи "Heartbeat" (точки или сообщения) через `setInterval`.
- Стриминг логов Main-процесса (`mainProcessLogs`) должен быть отфильтрованным, чтобы не забивать stdout.

### 5. Global Timeouts & Safety
Любой асинхронный вызов в тесте — потенциальная точка зависания.
- **withTimeout:** Оборачивай каждый `page.waitFor...` или `httpRequest` в хелпер `withTimeout(promise, ms, label)`.
- **Hard Kill:** Всегда ставь `const globalTimer = setTimeout(...)` в начале `main()`, который принудительно завершит процесс через 150-180 секунд.

### 6. Conflict: Port & SQLite
- **MCP Port:** Тестовый инстанс перезаписывает `~/.noted-terminal/mcp-port`.
- **SQLite Lock:** Приложение использует `better-sqlite3` в WAL-режиме. При параллельном запуске возможны задержки.

---

## Два уровня тестирования

### Уровень 1: Headless

Чистый Node.js + `@xterm/xterm` (headless) или `@xterm/headless`. Тестирует **логику** изолированно: state machines, парсеры, алгоритмы поиска, маркеры.

- Скорость: < 1 секунда
- Детерминированность: 100% — синтетические данные, ноль таймаутов
- Не требует: dev server, Electron, AI CLI
- Шаблон: [`stable/test-osc-boundary-markers.js`](stable/test-osc-boundary-markers.js)
- Shared код: [`core/headless.js`](core/headless.js)

### Уровень 2: E2E (Electron + Playwright)

Реальное приложение с реальным TUI. Тестирует **интеграцию**: DOM-рендеринг, IPC, парсинг реального TUI, контекстные меню.

- Скорость: 15-60 секунд
- Требует: `npm run dev` + `npx electron-vite build`
- Шаблон: [`stable/test-gemini-timeline.js`](stable/test-gemini-timeline.js)
- Shared код: [`core/launcher.js`](core/launcher.js), [`core/electron.js`](core/electron.js)

### Почему нужны ОБА уровня

Headless тест может пройти 22/22, но пропустить реальный баг. Пример:
- Headless подаёт в буфер полное сообщение (7503 символов)
- Реальный Gemini TUI обрезает отображение до ~137 символов с префиксом ` > `
- `scrollToTextInBuffer` не находит текст в реальном приложении

**Правило:** headless ловит логические ошибки, E2E ловит расхождения между моделью и реальностью. Если тест проверяет взаимодействие с реальным TUI — нужен E2E.

---

## Как писать новый тест

### 1. Решить уровень

| Что тестируешь | Уровень | Шаблон |
|---|---|---|
| State machine, парсер, алгоритм | Headless | `test-osc-boundary-markers.js` |
| Результат который зависит от реального TUI-рендеринга | E2E | `test-gemini-timeline.js` |
| Не уверен | Начни с Headless. Если проходит, но баг остаётся → добавь E2E |

### 2. Headless: шаблон

```javascript
const { Terminal } = require('@xterm/xterm')  // или '@xterm/headless'
const { assert, log, summary, writeAndWait } = require('../core/headless')

async function testMyFeature() {
  log.step('TEST 1: описание')

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })

  // Синтетические данные — точная копия того что выдаёт TUI
  await writeAndWait(term, 'данные\r\n')

  // Проверки (без таймаутов!)
  assert(/* условие */, 'что проверяем')

  term.dispose()
}

async function main() {
  await testMyFeature()
  summary()  // печатает "N passed, M failed" и exit(code)
}

main().catch(err => { console.error(err.message); process.exit(1) })
```

### 3. E2E: шаблон

```javascript
const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

async function main() {
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })

    // ... логика теста ...

    // Итоги
    console.log(`\nPassed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
```

### 4. Куда сохранять

- **Новый тест → `sandbox/`** пока отлаживаешь
- **Тест стабильно проходит → переместить в `stable/`**
- **Тест использует golden session → положить fixture в `fixtures/`**

---

## Event-driven ожидания (вместо таймаутов)

Приложение event-driven (OSC 133 → IPC → Zustand → React). Тесты ждут **те же сигналы**.

### Хелперы из `core/launcher.js`

| Хелпер | Что ждёт | Вместо |
|--------|----------|--------|
| `waitForTerminal(page, timeout)` | `.xterm-screen` visible в DOM | — |
| `waitForClaudeSessionId(page, timeout)` | `tab.claudeSessionId` в Zustand store | `waitForTimeout(30000)` |
| `waitForGeminiSessionId(page, timeout)` | `tab.geminiSessionId` в Zustand store | `waitForTimeout(30000)` |
| `waitForMainProcessLog(logs, pattern, timeout)` | Паттерн в `mainProcessLogs[]` | `waitForTimeout(15000)` |
| `findInLogs(logs, pattern)` | Все совпадения в массиве логов (не ждёт) | — |

### Паттерны для `page.waitForFunction`

```javascript
// Ждать обновления CWD после cd (вместо waitForTimeout(2000)):
await page.waitForFunction((dir) => {
  const s = window.useWorkspaceStore?.getState?.()
  const p = s?.openProjects?.get?.(s?.activeProjectId)
  return p?.tabs?.get?.(p?.activeTabId)?.cwd?.includes?.(dir)
}, targetDir, { timeout: 5000 })

// Ждать создания нового таба (вместо waitForTimeout(1500)):
const before = await page.evaluate(() => {
  const s = window.useWorkspaceStore?.getState?.()
  return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
})
await page.keyboard.press('Meta+t')
await page.waitForFunction((prev) => {
  const s = window.useWorkspaceStore?.getState?.()
  return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
}, before, { timeout: 5000 })

// Ждать ответ Claude (вместо waitForTimeout(15000)):
await waitForMainProcessLog(mainProcessLogs, /BoundaryMarker.*prompt #\d/, 30000)

// Ждать готовность shell (вместо waitForTimeout(500)):
await waitForMainProcessLog(mainProcessLogs, 'Prompt ready (A)', 5000)
```

### Допустимые фиксированные задержки

Только когда нет сигнала для ожидания:
- `100ms` между набором и Enter (keyboard simulation)
- `300ms` для анимации контекстного меню
- `8000ms` retry после падения Electron

---

## Специфика подсистем

### Terminal (xterm.js)
- Чтение DOM: `page.evaluate` → `.xterm-rows > div` → `.textContent`
- **Truncation:** Gemini TUI обрезает длинные сообщения до ~137 chars с ` > ` prefix
- Подробности: [`libraries/xterm.md`](libraries/xterm.md)

### Timeline
- Поиск точек: `div[style*="border-radius: 50%"]` ширина ~24px
- **Event-driven:** `waitForClaudeSessionId` вместо `waitForTimeout(12000)`
- Подробности: [`libraries/zustand-store.md`](libraries/zustand-store.md)

### Rewind (Gemini)
- Детерминистические маркеры: `waitForPtyText(term, textOrRegex, timeout)`
- RGB matching: зелёный `166;227;161m` для выделения в меню
- Sync: `\x1b[?2026l` для ожидания render frame

### Golden Session Pattern
Для Gemini тестов без реального AI:
1. Файл из `fixtures/` копируется в `~/.gemini/tmp/`
2. Тест получает заполненный таймлайн мгновенно
3. Не зависит от AI-ответов и сети

### OSC 7777 Prompt Boundary Markers
State machine в main.js для Claude:
- `IDLE (промт)` → `BUSY (ответ)` → `IDLE (промт вернулся)` → инжекция `\x1b]7777;prompt:N\x07`
- xterm.js `parser.registerOscHandler(7777)` → `registerMarker(0)` на точной строке
- Timeline: entry N → marker N-1 (entry 0 не имеет маркера)
- **Только Claude** — Gemini использует alternate buffer

### AI Spinner Observability (Main Process Logs)
Main-процесс логирует состояния AI-агентов для E2E тестов:

| Лог-паттерн | Что значит | Используй в тесте |
|---|---|---|
| `[GeminiSpinner] Tab X: THINKING` | Gemini обрабатывает запрос (Braille spinner ⠋ обнаружен) | `waitForMainProcessLog(logs, /GeminiSpinner.*THINKING/, 15000)` |
| `[GeminiSpinner] Tab X: IDLE` | Gemini закончил ответ (1.5с без спиннера) | `waitForMainProcessLog(logs, /GeminiSpinner.*IDLE/, 60000)` |
| `[Spinner] Tab X: BUSY` | Claude Code занят (✢✳✶✻✽, без цвета + OSC stripping) | `waitForMainProcessLog(logs, /Spinner.*BUSY/, 60000)` |
| `[Spinner] Tab X: IDLE` | Claude Code вернул промт (500ms debounce без спиннера) | `waitForMainProcessLog(logs, /Spinner.*IDLE/, 120000)` |
| `[MCP:Delegate] Claude sub-agent tab created` | Sub-agent таб создан | `waitForMainProcessLog(logs, /MCP:Delegate.*sub-agent tab created/, 120000)` |
| `[MCP:HTTP] POST /delegate` | MCP delegation request принят | `findInLogs(logs, 'MCP:')` |

**IPC события:** `gemini:busy-state` и `claude:busy-state` отправляются в renderer для UI-обновлений.

### Gemini Alternate Buffer
Gemini CLI работает в alternate screen buffer xterm.js. Это значит:
- **Нельзя** читать историю Gemini через `buffer.getLine()` — видишь только текущий экран
- **Нельзя** использовать OSC 7777 маркеры для Gemini
- **Можно** читать видимые строки через `.xterm-rows > div` → `.textContent`, но содержимое перерисовывается при каждом re-render TUI
- Для отправки команд в Gemini используй IPC `gemini:send-command` (через `safePasteAndSubmit` + `geminiCommandQueue`)

### MCP Delegation (Gemini → Claude)
Архитектура: Gemini вызывает MCP tool `delegate_to_claude` → HTTP POST `/delegate` → main.js создаёт sub-agent tab → Claude Code запускается → результат автоматически доставляется через `safePasteAndSubmit`.
- Sub-agent tab имеет `parentTabId` → скрыт из TabBar, виден в SubAgentBar
- **Fire-and-forget:** Gemini не должен поллить `get_task_status` — описание тулов в `mcp-server.mjs` явно это запрещает
- Тест: `test-gemini-orchestration.js`

---

## Запуск

```bash
# ── Headless (мгновенно, без зависимостей) ──
node auto/stable/test-osc-boundary-markers.js
node auto/stable/test-gemini-scroll-sameline.js

# ── E2E (требуют dev server + актуальный билд) ──
npm run dev                    # → http://localhost:5182
npx electron-vite build        # синхронизировать dist/ с src/main/main.js

# Gemini (fixture, без AI):
node auto/stable/test-gemini-timeline.js
node auto/stable/test-gemini-rewind.js
node auto/stable/test-gemini-timeline-nav.js

# Claude (нужен живой claude CLI):
node auto/stable/test-sniper-handshake.js
node auto/stable/test-ctrlc-danger-zone.js
node auto/stable/test-timeline.js

# Gemini + Claude (нужны оба CLI, ~3-5 мин):
node auto/stable/test-gemini-orchestration.js 2>&1 | tee /tmp/test-gemini-orch.log
```

### Параллельный запуск

Тестовый Electron работает параллельно с основным — **это нормально**. Но может быть конкуренция за SQLite (`better-sqlite3` WAL mode).

**Если launch упал:**
- Подождать **10 сек** и повторить (до 3 раз)
- Не убивать основной экземпляр
- Таймаут bash: **минимум 180 секунд**

### Известные проблемы (2026-02-28)

| Тест | Статус | Причина |
|------|--------|---------|
| `test-history-restore.js` | BROKEN | `setCurrentView` отсутствует в store API |
| `test-gemini-rewind.js` | 11/12 | Golden fixture ожидает 13 entries, IPC возвращает 11 |
| `test-gemini-orchestration.js` | 16/16 PASS, 1 WARN | Claude sub-agent IDLE может не прийти за 120с (Claude долго читает контекст). Не FAIL — soft timeout |
| Все E2E | WARNING | `MaxListenersExceededWarning` при 8+ сохранённых табах |

### Типичные ошибки при написании тестов (шрамы)

| Ошибка | Последствие | Как избежать |
|--------|-------------|--------------|
| Не создать свежий таб в начале теста | `gemini:spawn-with-watcher` идёт в claude-таб, `commandType` остаётся `claude` | См. §2 State Isolation |
| Не сделать `npx electron-vite build` после правки `src/main/` | Тест запускает старый код, баги "невоспроизводимы" | См. §3 Build Sync |
| Запустить тест без `\| tee /tmp/file.log` | Пустой вывод, нет диагностики | См. §1 Empty Output |
| `assert(condition \|\| true, ...)` | Assert всегда PASS, баг скрыт | Code review: никогда `\|\| true` в assert |
| `logMainProcess: false` в `launch()` | Нет логов Main-процесса для отладки | Всегда `logMainProcess: true` для [E2E+Claude] и [E2E+Gemini+Claude] |
