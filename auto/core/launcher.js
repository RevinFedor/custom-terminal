/**
 * Electron Launcher for Noted Terminal
 *
 * Запуск Electron с правильными флагами и правами.
 * Возвращает { app, page, consoleLogs } готовые к использованию.
 */

const { _electron: electron } = require('playwright')
const path = require('path')
const http = require('http')

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

  // Проверка dev server
  const serverOk = await new Promise((resolve) => {
    http.get(opts.devServerUrl, () => resolve(true)).on('error', () => resolve(false))
  })
  if (!serverOk) {
    throw new Error(`Dev server not running on ${opts.devServerUrl}. Start it with: npm run dev`)
  }
  console.log('[Launcher] Dev server OK')

  // Массив для сбора console логов
  const consoleLogs = []
  const mainProcessLogs = []

  // Запуск Electron
  // Strip CLAUDECODE so nested terminals don't block claude from launching
  const { CLAUDECODE, ...cleanEnv } = process.env

  const app = await electron.launch({
    args: [appPath],
    timeout: opts.timeout,
    env: {
      ...cleanEnv,
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

/**
 * Ждёт появления Claude Session ID в store (event-driven, не таймаут)
 * @param {Page} page
 * @param {number} timeout
 */
async function waitForClaudeSessionId(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const store = window.useWorkspaceStore?.getState?.()
    if (!store) return false
    const proj = store.openProjects?.get?.(store.activeProjectId)
    if (!proj) return false
    const tab = proj.tabs?.get?.(proj.activeTabId)
    return tab?.claudeSessionId?.length > 10
  }, { timeout })
}

/**
 * Ждёт появления Gemini Session ID в store (event-driven, не таймаут)
 * @param {Page} page
 * @param {number} timeout
 */
async function waitForGeminiSessionId(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const store = window.useWorkspaceStore?.getState?.()
    if (!store) return false
    const proj = store.openProjects?.get?.(store.activeProjectId)
    if (!proj) return false
    const tab = proj.tabs?.get?.(proj.activeTabId)
    return tab?.geminiSessionId?.length > 10
  }, { timeout })
}

/**
 * Ждёт появления паттерна в mainProcessLogs (polling).
 * mainProcessLogs — обычный массив, пополняется через stdout/stderr.
 *
 * @param {string[]} logs - массив mainProcessLogs из launch()
 * @param {string|RegExp} pattern - строка или регулярка
 * @param {number} timeout - максимальное ожидание (мс)
 * @param {number} pollInterval - частота проверки (мс)
 * @returns {Promise<string|null>} - первый совпавший лог или null при таймауте
 */
async function waitForMainProcessLog(logs, pattern, timeout = 30000, pollInterval = 300) {
  const start = Date.now()
  let lastChecked = 0

  while (Date.now() - start < timeout) {
    // Проверяем только новые записи с последней проверки
    for (let i = lastChecked; i < logs.length; i++) {
      const match = typeof pattern === 'string'
        ? logs[i].includes(pattern)
        : pattern.test(logs[i])
      if (match) return logs[i]
    }
    lastChecked = logs.length
    await new Promise(r => setTimeout(r, pollInterval))
  }
  return null
}

module.exports = {
  launch,
  waitForTerminal,
  typeCommand,
  waitForTimeline,
  waitForClaudeSessionId,
  waitForGeminiSessionId,
  waitForMainProcessLog,
  findInLogs,
  DEFAULT_OPTIONS
}
