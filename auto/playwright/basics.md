# Playwright Basics — Шаблоны, селекторы, ожидания

## Шаблон теста

```javascript
const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

async function main() {
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)

    // ... логика теста

  } finally {
    await app.close()
  }
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
```

## Ожидания: event-driven, не таймауты

Приложение event-driven (SessionBridge → fs.watch → IPC → Zustand store).
Тесты ждут те же сигналы через `page.waitForFunction()`.

```javascript
// ПЛОХО — слепой таймаут:
await page.waitForTimeout(20000)

// ХОРОШО — ждём реальный сигнал из store:
await waitForClaudeSessionId(page, 30000)
```

### Zustand store — источник истины

```javascript
const tabState = await page.evaluate(() => {
  const store = window.useWorkspaceStore?.getState?.()
  const proj = store?.openProjects?.get?.(store?.activeProjectId)
  const tab = proj?.tabs?.get?.(proj?.activeTabId)
  return {
    claudeSessionId: tab?.claudeSessionId,
    commandType: tab?.commandType,
    cwd: tab?.cwd
  }
})
```

## Shell Readiness

Никогда не вводить команды без ожидания готовности терминала.

```javascript
// ПЛОХО:
await page.keyboard.type('npm run dev')

// ХОРОШО:
await waitForTerminal(page)           // .xterm-screen visible
await electron.focusWindow(app)       // фокус на окно
await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })
await typeCommand(page, 'npm run dev')
```

## Event-driven замены типичных таймаутов

```javascript
// Вместо waitForTimeout(1500) после Cmd+T:
const countBefore = await page.evaluate(() => {
  const s = window.useWorkspaceStore?.getState?.()
  const p = s?.openProjects?.get?.(s?.activeProjectId)
  return p?.tabs?.size ?? 0
})
await page.keyboard.press('Meta+t')
await page.waitForFunction((prev) => {
  const s = window.useWorkspaceStore?.getState?.()
  const p = s?.openProjects?.get?.(s?.activeProjectId)
  return (p?.tabs?.size ?? 0) > prev
}, countBefore, { timeout: 5000 })

// Вместо waitForTimeout(15000) "ждём ответ Claude":
// Main process логирует [BoundaryMarker] при возврате промта
// Ищи в mainProcessLogs или жди OSC 133 "Prompt ready (A)"
const waitForPromptReturn = async (mainProcessLogs, timeout = 30000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (mainProcessLogs.some(l => l.includes('BoundaryMarker'))) return true
    await page.waitForTimeout(500)  // poll interval, не слепой таймаут
  }
  return false
}

// Вместо waitForTimeout(4000) для Timeline:
await page.waitForSelector('div[style*="border-radius: 50%"]', { timeout: 10000 })
```

## CWD: принудительный переход

PTY стартует в домашней папке. Первый шаг теста — `cd` в нужную директорию.

```javascript
const targetDir = '/Users/fedor/Desktop/custom-terminal'
await typeCommand(page, `cd ${targetDir}`)
// Event-driven: ждём OSC 7 → store.tab.cwd обновится
await page.waitForFunction((dir) => {
  const s = window.useWorkspaceStore?.getState?.()
  const p = s?.openProjects?.get?.(s?.activeProjectId)
  const t = p?.tabs?.get?.(p?.activeTabId)
  return t?.cwd?.includes?.(dir)
}, targetDir, { timeout: 5000 })
```

## Доставка Ctrl+C (\x03)

`page.keyboard.press('Control+c')` в Electron может перехватываться ОС как Copy или игнорироваться эмулятором терминала при потере фокуса. Для надёжной отправки `SIGINT` (Ctrl+C) в PTY используйте прямой IPC вызов:

```javascript
async function sendCtrlC(page, tabId) {
  await page.evaluate((tid) => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('terminal:input', tid, '\x03')
  }, tabId)
}
```

## Hover: эффект телепортации

Playwright перемещает курсор мгновенно. Узкие триггеры (Timeline) могут не зафиксировать пересечение границы.

```javascript
// ПЛОХО (мгновенно):
await page.mouse.move(100, 200)

// ХОРОШО (плавно):
await page.mouse.move(100, 200, { steps: 10 })
```

### Portals и relatedTarget

`relatedTarget` при уходе мыши на портал (вне иерархии триггера) = `null`.
- **В коде:** проверять координаты мыши вместо `e.relatedTarget`
- **В тесте:** двигать мышь медленно (`steps`) чтобы JS-слушателям хватило времени

## Zombie Processes

При падении теста Electron может зависнуть в памяти → блокировка портов, SQLite locks.

```javascript
// Всегда try/finally:
try {
  // логика теста
} finally {
  await app.close()
}
```

Если порт занят:
```bash
pkill -f 'playwright' || true
```

## Формат вывода (console colors)

```javascript
const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
}
const log = {
  step: (msg) => console.log(`${c.cyan}[STEP]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`)
}
```

## Checklist для новых тестов

1. [ ] Dev server запущен (`npm run dev` → localhost:5182)?
2. [ ] Если менял main.js — `npx electron-vite build` перед запуском?
3. [ ] `waitForTerminal()` перед вводом?
4. [ ] `cd` в целевую директорию?
5. [ ] `steps` для hover-перемещений?
6. [ ] `try/finally` с `app.close()`?
7. [ ] Event-driven ожидания вместо таймаутов?
