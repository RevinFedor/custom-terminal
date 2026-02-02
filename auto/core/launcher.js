/**
 * Electron Launcher for Noted Terminal
 *
 * Запуск Electron с правильными флагами и правами.
 * Возвращает { app, page, consoleLogs } готовые к использованию.
 */

const { _electron: electron } = require('playwright')
const path = require('path')

const DEFAULT_OPTIONS = {
  timeout: 30000,
  waitForReady: 3000,
  devServerUrl: 'http://localhost:5182'
}

/**
 * Запускает Electron приложение
 * @param {Object} options
 * @returns {Promise<{app: ElectronApplication, page: Page, consoleLogs: string[]}>}
 */
async function launch(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // Путь к приложению (1 уровень вверх от auto/)
  const appPath = options.appPath || path.join(__dirname, '..', '..')

  console.log('[Launcher] Starting app from:', appPath)

  // Массив для сбора console логов
  const consoleLogs = []
  const mainProcessLogs = []

  // Запуск Electron
  const app = await electron.launch({
    args: [appPath],
    timeout: opts.timeout,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: opts.devServerUrl
    }
  })

  // Захват stdout/stderr main process
  app.process().stdout?.on('data', (data) => {
    const text = data.toString()
    mainProcessLogs.push(`[stdout] ${text}`)
    if (opts.logMainProcess) console.log('[Main:stdout]', text)
  })
  app.process().stderr?.on('data', (data) => {
    const text = data.toString()
    mainProcessLogs.push(`[stderr] ${text}`)
    if (opts.logMainProcess) console.log('[Main:stderr]', text)
  })

  // Получение главного окна (не DevTools)
  let page = null
  const windows = await app.windows()

  for (const win of windows) {
    const url = await win.url()
    if (!url.includes('devtools://')) {
      page = win
      break
    }
  }

  // Если DevTools открылся первым - ждём главное окно
  if (!page) {
    page = await app.waitForEvent('window', {
      predicate: async (win) => !(await win.url()).includes('devtools://'),
      timeout: opts.timeout
    })
  }

  // Подписываемся на console логи
  page.on('console', (msg) => {
    const text = msg.text()
    consoleLogs.push(`[${msg.type()}] ${text}`)

    // Выводим в реальном времени если нужно
    if (opts.logConsole) {
      console.log(`[Console:${msg.type()}] ${text}`)
    }
  })

  // Права на clipboard
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

  // Ждём инициализацию
  if (opts.waitForReady > 0) {
    await page.waitForTimeout(opts.waitForReady)
  }

  return { app, page, consoleLogs, mainProcessLogs }
}

/**
 * Ждёт появления терминала
 * @param {Page} page
 * @param {number} timeout
 */
async function waitForTerminal(page, timeout = 10000) {
  const terminal = page.locator('.xterm-screen')
  await terminal.waitFor({ state: 'visible', timeout })
  return terminal
}

/**
 * Вводит команду в терминал
 * @param {Page} page
 * @param {string} command
 */
async function typeCommand(page, command) {
  await page.keyboard.type(command, { delay: 50 })
  await page.waitForTimeout(100)
  await page.keyboard.press('Enter')
}

/**
 * Ждёт появления Timeline компонента
 * @param {Page} page
 * @param {number} timeout
 */
async function waitForTimeline(page, timeout = 30000) {
  // Timeline имеет width: 16px и border-left
  const timeline = page.locator('div').filter({
    has: page.locator('div[style*="border-radius: 50%"]')
  }).filter({
    hasNot: page.locator('.xterm')
  }).first()

  try {
    await timeline.waitFor({ state: 'visible', timeout })
    return { found: true, element: timeline }
  } catch (e) {
    return { found: false, error: e.message }
  }
}

/**
 * Проверяет логи на наличие паттерна
 * @param {string[]} logs
 * @param {string|RegExp} pattern
 */
function findInLogs(logs, pattern) {
  const matches = []
  for (const log of logs) {
    if (typeof pattern === 'string') {
      if (log.includes(pattern)) matches.push(log)
    } else {
      if (pattern.test(log)) matches.push(log)
    }
  }
  return matches
}

module.exports = {
  launch,
  waitForTerminal,
  typeCommand,
  waitForTimeline,
  findInLogs,
  DEFAULT_OPTIONS
}
