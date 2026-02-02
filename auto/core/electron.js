/**
 * Electron API - Direct Electron Main Process Access
 *
 * Набор хелперов для работы с Electron через app.evaluate().
 * Работает ВСЕГДА, независимо от фокуса окна.
 */

// ═══════════════════════════════════════════════════════════════
// CLIPBOARD
// ═══════════════════════════════════════════════════════════════

/**
 * Записать текст в буфер обмена
 */
async function clipboardWrite(app, text) {
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
}

/**
 * Прочитать текст из буфера обмена
 */
async function clipboardRead(app) {
  return await app.evaluate(({ clipboard }) => clipboard.readText())
}

// ═══════════════════════════════════════════════════════════════
// WEBCONTENTS COMMANDS
// ═══════════════════════════════════════════════════════════════

/**
 * Выполнить команду webContents
 * @param {'copy'|'paste'|'cut'|'selectAll'|'undo'|'redo'|'delete'} command
 */
async function webContentsCommand(app, command) {
  await app.evaluate(({ BrowserWindow }, cmd) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && win.webContents[cmd]) {
      win.webContents[cmd]()
    }
  }, command)
}

// Shortcuts
const copy = (app) => webContentsCommand(app, 'copy')
const paste = (app) => webContentsCommand(app, 'paste')
const cut = (app) => webContentsCommand(app, 'cut')
const selectAll = (app) => webContentsCommand(app, 'selectAll')
const undo = (app) => webContentsCommand(app, 'undo')
const redo = (app) => webContentsCommand(app, 'redo')

/**
 * Вставить текст напрямую (без clipboard)
 */
async function insertText(app, text) {
  await app.evaluate(({ BrowserWindow }, t) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.insertText(t)
  }, text)
}

// ═══════════════════════════════════════════════════════════════
// WINDOW
// ═══════════════════════════════════════════════════════════════

/**
 * Получить информацию об окнах
 */
async function getWindowInfo(app) {
  return await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    return windows.map(w => ({
      id: w.id,
      title: w.getTitle(),
      bounds: w.getBounds(),
      focused: w.isFocused(),
      visible: w.isVisible()
    }))
  })
}

/**
 * Сфокусировать главное окно
 */
async function focusWindow(app) {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      win.focus()
      win.webContents.focus()
    }
  })
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM
// ═══════════════════════════════════════════════════════════════

/**
 * Получить версию Electron
 */
async function getElectronVersion(app) {
  return await app.evaluate(() => process.versions.electron)
}

/**
 * Выполнить произвольный код в Main Process
 */
async function evaluateMain(app, fn, ...args) {
  return await app.evaluate(fn, ...args)
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Clipboard
  clipboardWrite,
  clipboardRead,

  // WebContents
  webContentsCommand,
  copy,
  paste,
  cut,
  selectAll,
  undo,
  redo,
  insertText,

  // Window
  getWindowInfo,
  focusWindow,

  // System
  getElectronVersion,
  evaluateMain
}
