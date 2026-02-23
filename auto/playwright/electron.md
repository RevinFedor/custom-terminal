# Electron-специфика — Clipboard, IPC, Focus, Build Sync

## Запуск тестового Electron

Launcher (`core/launcher.js`) поднимает **отдельный Electron-инстанс** через Playwright.
Основной инстанс приложения не затрагивается.

### Env изоляция

Launcher вычищает `CLAUDECODE` из env. Без этого Claude Code отказывается запускаться внутри тестовых терминалов (защита от вложенных сессий).

```javascript
// core/launcher.js
const { CLAUDECODE, ...cleanEnv } = process.env
const app = await electron.launch({
  args: [appPath],
  env: { ...cleanEnv, NODE_ENV: 'development', VITE_DEV_SERVER_URL: opts.devServerUrl }
})
```

### DevTools фильтрация

DevTools может открыться раньше главного окна. Launcher фильтрует:
```javascript
for (const win of windows) {
  const url = await win.url()
  if (!url.includes('devtools://')) { page = win; break }
}
```

## Clipboard

`navigator.clipboard` ненадёжен в Electron. Использовать `app.evaluate()`:

```javascript
const electron = require('../core/electron')

// Запись
await electron.clipboardWrite(app, 'text')

// Чтение
const text = await electron.clipboardRead(app)

// WebContents copy/paste
await electron.copy(app)
await electron.paste(app)
```

## Focus

Фокус окна обязателен перед взаимодействием с терминалом:

```javascript
await electron.focusWindow(app)   // BrowserWindow.focus() + webContents.focus()
```

### Webview Input Trap

`webview` в Electron является отдельным `WebContents`. Он удерживает фокус ввода на уровне Chromium даже если скрыт через `visibility: hidden` или перекрыт другими элементами.

**Проблема:** если тест пытается печатать в терминал браузерной вкладки, но `webview` активен, ввод может уходить в браузер, а не в терминал.

**Решение:** в коде приложения реализован принудительный `webview.blur()` при переключении на терминал. В тестах необходимо дождаться смены `activeView` в store перед началом ввода.

## IPC: структура ответов

IPC возвращает обёртку `{ success, content, error }`, не чистые данные:

```javascript
// ПЛОХО (content = [object Object]):
const content = await ipcRenderer.invoke('file:read', path)

// ХОРОШО:
const result = await ipcRenderer.invoke('file:read', path)
if (!result.success) throw new Error(result.error)
expect(result.content).toContain('scripts')
```

## Build Sync: dist/ не обновляется автоматически

**Проблема:** после правок в `src/main/main.js` тесты не видят изменений.

**Причина:** Vite HMR обновляет только Renderer. Main-процесс берётся из `dist/main/`, который требует явной пересборки.

**Решение:**
```bash
npx electron-vite build
```

Если тест "не видит" новый `console.log` или `ipcMain.handle` — проверить дату `dist/main/`.

## Log Capture

Launcher перехватывает логи обоих процессов:

```javascript
const { app, page, consoleLogs, mainProcessLogs } = await launch({
  logConsole: true,       // renderer console.log в реальном времени
  logMainProcess: true    // main process stdout/stderr в реальном времени
})

// После теста — поиск по логам:
const matches = findInLogs(consoleLogs, 'Timeline')
const sniperLogs = mainProcessLogs.filter(l => l.includes('Sniper'))
```

## Headless Debugging

В headless режиме логи Renderer теряются. Включать `logConsole: true` в launch options:

```javascript
const { app, page, consoleLogs } = await launch({ logConsole: true })
// Все console.log из React будут видны в терминале как [Console:log] ...
```
