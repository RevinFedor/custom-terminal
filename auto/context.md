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
│   └── test-history-restore.js       # [E2E] History: восстановление из SQLite ⚠️ BROKEN
├── sandbox/                          # Одноразовые эксперименты. Готов → перенести в stable/
└── screenshots/                      # Артефакты тестов
```

Метки тестов:
- **[Headless]** — чистый Node.js, без Electron. < 1 сек, 100% детерминированный.
- **[E2E+Fixture]** — Electron + golden session из `fixtures/`. Не требует реального AI.
- **[E2E+Claude]** — Electron + живой Claude. Требует CLI `claude` и ~30-60 сек.

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
```

### Параллельный запуск

Тестовый Electron работает параллельно с основным — **это нормально**. Но может быть конкуренция за SQLite (`better-sqlite3` WAL mode).

**Если launch упал:**
- Подождать **10 сек** и повторить (до 3 раз)
- Не убивать основной экземпляр
- Таймаут bash: **минимум 180 секунд**

### Известные проблемы (2026-02-27)

| Тест | Статус | Причина |
|------|--------|---------|
| `test-history-restore.js` | BROKEN | `setCurrentView` отсутствует в store API |
| `test-gemini-rewind.js` | 11/12 | Golden fixture ожидает 13 entries, IPC возвращает 11 |
| Все E2E | WARNING | `MaxListenersExceededWarning` при 8+ сохранённых табах |
