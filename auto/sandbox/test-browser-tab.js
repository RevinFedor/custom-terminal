/**
 * Test: Browser Tab — Create, Switch Views, Error Handling
 *
 * Проверяет:
 * 1. Кнопка Globe создаёт browser tab (tabType === 'browser')
 * 2. Tab дефолтно открывается в browser view (activeView === 'browser')
 * 3. Webview рендерится (dom-ready)
 * 4. Переключение Browser ↔ Terminal работает без ошибок
 * 5. Terminal view содержит рабочий xterm.js
 * 6. Нет uncaught errors (ERR_ABORTED, reload is not a function)
 *
 * Запуск: node auto/sandbox/test-browser-tab.js
 */

const { launch, waitForTerminal } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m'
}

const log = {
  step: (msg) => console.log(`${c.cyan}[STEP]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`)
}

// Collect uncaught errors from renderer
const uncaughtErrors = []

async function main() {
  log.step('Запуск Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 4000
  })

  log.pass('Приложение запущено')

  // Track page errors (uncaught exceptions)
  page.on('pageerror', (err) => {
    uncaughtErrors.push(err.message)
  })

  try {
    // ===== SETUP =====
    log.step('Ожидание готовности приложения...')
    await electron.focusWindow(app)
    await page.waitForTimeout(3000) // Wait for app init + restore

    // If previous test left a browser tab as active, switch to a terminal tab first
    const currentTabType = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return tab?.tabType
    }).catch(() => null)

    if (currentTabType === 'browser') {
      log.warn('Активный таб — browser (от предыдущего теста). Создаём новый терминал...')
      await page.keyboard.press('Meta+t')
      await page.waitForTimeout(2000)
    }

    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    log.pass('Терминал активен')

    // ===== TEST 1: Создание browser tab =====
    log.step('Клик по кнопке Globe (Open browser tab)...')

    // Find the Globe button in ProjectToolbar
    const globeButton = page.locator('button[title="Open browser tab"]')
    const globeVisible = await globeButton.isVisible().catch(() => false)

    if (!globeVisible) {
      log.fail('Кнопка Globe не найдена в toolbar')
      return
    }

    await globeButton.click()
    await page.waitForTimeout(2000) // PTY spawn + webview init

    log.pass('Кнопка Globe нажата')

    // ===== TEST 2: Проверка tab state =====
    log.step('Проверка tab state в store...')

    const tabState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      if (!store) return null
      const proj = store.openProjects?.get?.(store.activeProjectId)
      if (!proj) return null
      const tab = proj.tabs?.get?.(proj.activeTabId)
      return tab ? {
        id: tab.id,
        name: tab.name,
        tabType: tab.tabType,
        url: tab.url,
        activeView: tab.activeView,
      } : null
    })

    log.info(`Tab state: ${JSON.stringify(tabState)}`)

    if (tabState?.tabType === 'browser') {
      log.pass('tabType === "browser"')
    } else {
      log.fail(`tabType: ${tabState?.tabType || 'undefined'} (expected "browser")`)
    }

    // ===== TEST 3: Webview рендерится =====
    log.step('Проверка наличия webview в DOM...')

    const webviewExists = await page.evaluate(() => {
      const wv = document.querySelector('webview')
      return !!wv
    })

    if (webviewExists) {
      log.pass('Webview присутствует в DOM')
    } else {
      log.fail('Webview не найден в DOM')
    }

    // ===== TEST 4: Browser view активен по умолчанию =====
    log.step('Проверка дефолтного view...')

    // Check that Browser button is highlighted (active)
    const browserBtnActive = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[title="Browser view"]')
      for (const btn of btns) {
        const style = btn.getAttribute('style') || ''
        if (style.includes('rgba(255')) return true
      }
      return false
    })

    if (browserBtnActive) {
      log.pass('Browser view активен по умолчанию')
    } else {
      log.warn('Browser view может быть не активен (проверьте визуально)')
    }

    // ===== TEST 5: Переключение на Terminal view =====
    log.step('Переключение на Terminal view...')

    // Use store directly — DOM buttons can collide with hidden browser tabs
    await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) store.setBrowserActiveView(tabId, 'terminal')
    })
    await page.waitForTimeout(1500)

    // Check that terminal rendered
    const hasTerminal = await page.evaluate(() => {
      const screens = document.querySelectorAll('.xterm-screen')
      // At least one visible xterm-screen
      for (const s of screens) {
        const rect = s.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) return true
      }
      return false
    })

    if (hasTerminal) {
      log.pass('Terminal view содержит xterm.js')
    } else {
      log.warn('Terminal view: xterm-screen не виден (может быть ещё не инициализирован)')
    }

    // ===== TEST 5b: Проверка ввода в терминал (prompt + input) =====
    log.step('Проверка ввода в embedded терминал...')

    // Wait for prompt to appear (lazy init + SIGWINCH redraw)
    await page.waitForTimeout(1500)

    // Check if terminal has any content (shell prompt)
    const terminalContent = await page.evaluate(() => {
      // Find all xterm instances, get the one that's visible
      const screens = document.querySelectorAll('.xterm-screen')
      for (const s of screens) {
        const rect = s.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          // Get text content from xterm rows
          const rows = s.querySelectorAll('.xterm-rows > div')
          const lines = []
          for (const row of rows) {
            const text = row.textContent?.trim()
            if (text) lines.push(text)
          }
          return lines.join('\n')
        }
      }
      return ''
    })

    if (terminalContent.length > 0) {
      log.pass(`Терминал содержит контент (${terminalContent.length} chars) — prompt отображён`)
    } else {
      log.fail('Терминал пуст — prompt не отображён (pendingBuffer race?)')
    }

    // Send echo command to embedded terminal PTY via IPC
    const testMarker = 'BROWSER_TAB_INPUT_TEST_' + Date.now()
    const browserTabId = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      return proj?.activeTabId
    })

    if (browserTabId) {
      await page.evaluate((args) => {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('terminal:input', args.tabId, 'echo ' + args.marker + '\r')
      }, { tabId: browserTabId, marker: testMarker })

      await page.waitForTimeout(1000)

      // Check if echo output appeared
      const outputAfterInput = await page.evaluate(() => {
        const screens = document.querySelectorAll('.xterm-screen')
        for (const s of screens) {
          const rect = s.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            const rows = s.querySelectorAll('.xterm-rows > div')
            const lines = []
            for (const row of rows) {
              const text = row.textContent?.trim()
              if (text) lines.push(text)
            }
            return lines.join('\n')
          }
        }
        return ''
      })

      if (outputAfterInput.includes(testMarker)) {
        log.pass('Ввод в терминал работает — echo отобразился')
      } else {
        log.fail('Ввод в терминал НЕ работает — echo не найден в выводе')
        log.info(`Искали: ${testMarker}`)
        log.info(`Вывод (last 200): ${outputAfterInput.slice(-200)}`)
      }
    } else {
      log.warn('Не удалось получить tabId для проверки ввода')
    }

    // ===== TEST 6: Переключение обратно на Browser view =====
    log.step('Переключение обратно на Browser view...')

    await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) store.setBrowserActiveView(tabId, 'browser')
    })
    await page.waitForTimeout(1000)

    // Check store activeView
    const viewAfterSwitch = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return tab?.activeView
    })

    if (viewAfterSwitch === 'browser') {
      log.pass('activeView === "browser" после переключения')
    } else {
      log.fail(`activeView: ${viewAfterSwitch} (expected "browser")`)
    }

    // ===== TEST 7: Ввод URL и навигация =====
    log.step('Ввод URL в адресную строку...')

    const urlInput = page.locator('input[placeholder="http://localhost:3000"]')
    const inputVisible = await urlInput.isVisible().catch(() => false)

    if (inputVisible) {
      await urlInput.click()
      await urlInput.fill('http://localhost:5173')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(2000)

      // Check address bar updated
      const currentUrl = await urlInput.inputValue()
      if (currentUrl.includes('localhost:5173') || currentUrl.includes('localhost')) {
        log.pass(`URL updated: ${currentUrl}`)
      } else {
        log.warn(`URL may not have updated: ${currentUrl}`)
      }
    } else {
      log.warn('URL input не найден')
    }

    // ===== TEST 8: Нет uncaught errors =====
    log.step('Проверка uncaught errors...')

    // Filter out benign errors
    const criticalErrors = uncaughtErrors.filter(e =>
      !e.includes('ERR_ABORTED') &&       // Expected when view switches during load
      !e.includes('ERR_CONNECTION_REFUSED') // Expected if localhost not running
    )

    if (criticalErrors.length === 0) {
      log.pass(`Нет критических uncaught errors (benign: ${uncaughtErrors.length})`)
    } else {
      log.fail(`Критические errors (${criticalErrors.length}):`)
      criticalErrors.forEach(e => log.info(`  ${e}`))
    }

    // Check for "reload is not a function" specifically
    const reloadError = uncaughtErrors.find(e => e.includes('reload is not a function'))
    if (!reloadError) {
      log.pass('Нет ошибки "reload is not a function" (webviewTag enabled)')
    } else {
      log.fail('Ошибка "reload is not a function" — webviewTag не включён?')
    }

    // ===== ИТОГО =====
    console.log('\n═══════════════════════════════════════')

    const results = {
      browserTabCreated: tabState?.tabType === 'browser',
      webviewInDom: webviewExists,
      terminalHasPrompt: terminalContent.length > 0,
      noReloadError: !reloadError,
      noCriticalErrors: criticalErrors.length === 0,
      viewSwitchWorks: viewAfterSwitch === 'browser',
    }

    const allPassed = Object.values(results).every(Boolean)

    if (allPassed) {
      log.pass('ТЕСТ ПРОЙДЕН: Browser Tab работает корректно')
    } else {
      log.fail('ТЕСТ НЕ ПРОЙДЕН:')
      for (const [key, val] of Object.entries(results)) {
        if (!val) log.fail(`  ${key}: FAILED`)
      }
    }

    console.log('═══════════════════════════════════════')

    // Dump errors if any
    if (uncaughtErrors.length > 0) {
      console.log('\n--- All Uncaught Errors ---')
      uncaughtErrors.forEach(e => log.info(e))
      console.log('--- End ---\n')
    }

  } finally {
    log.step('Закрытие приложения...')
    await app.close()
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
