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
await page.waitForTimeout(500)        // PTY инициализация
await typeCommand(page, 'npm run dev')
```

## CWD: принудительный переход

PTY стартует в домашней папке. Первый шаг теста — `cd` в нужную директорию.

```javascript
const targetDir = '/Users/fedor/Desktop/custom-terminal'
await typeCommand(page, `cd ${targetDir}`)
await page.waitForTimeout(2000)  // OSC 7 обновит CWD в store
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
