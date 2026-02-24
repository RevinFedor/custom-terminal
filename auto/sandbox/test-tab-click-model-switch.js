/**
 * Test: Tab Click → Model Switch
 *
 * Воспроизводит баг: при клике по вкладке терминала (TabBar),
 * а не внутри самого терминала, model switch не работает —
 * Ctrl+C от safePasteAndSubmit убивает Claude (exitCode=130).
 *
 * Запуск: node auto/sandbox/test-tab-click-model-switch.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`)
}

async function getActiveTabId(page) {
  return page.evaluate(() => {
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    return p?.activeTabId
  })
}

async function getTerminalContent(page, lastN = 20) {
  return page.evaluate((n) => {
    const rows = document.querySelectorAll('.xterm-rows > div')
    const lines = []
    rows.forEach(row => {
      const text = row.textContent
      if (text?.trim()) lines.push(text)
    })
    return lines.slice(-n).join('\n')
  }, lastN)
}

async function sendModelSwitch(page, tabId, model) {
  await page.evaluate(({ tid, cmd }) => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('claude:send-command', tid, '/model ' + cmd)
  }, { tid: tabId, cmd: model })
}

async function switchToTabViaStore(page, tabId) {
  await page.evaluate((tid) => {
    const s = window.useWorkspaceStore?.getState?.()
    if (s?.switchTab && s?.activeProjectId) {
      s.switchTab(s.activeProjectId, tid)
      s.setProjectView?.(s.activeProjectId, 'terminal')
    }
  }, tabId)
}

/**
 * Click on a tab in TabBar by its store tab ID.
 * Gets tab name from store, then clicks the matching [data-tab-item].
 */
async function clickTabInTabBarById(page, tabId) {
  // Get the tab name from the store
  const tabName = await page.evaluate((tid) => {
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    return p?.tabs?.get?.(tid)?.name
  }, tabId)
  log.info(`Tab "${tabId?.slice(-8)}" has name "${tabName}"`)

  if (!tabName) {
    log.warn('Tab name is null!')
    return false
  }

  // Find the EXACT tab name match in DOM
  const tabItems = page.locator('[data-tab-item]')
  const count = await tabItems.count()

  for (let i = 0; i < count; i++) {
    const text = (await tabItems.nth(i).textContent())?.trim()
    if (text === tabName) {
      log.info(`Clicking tab[${i}] text="${text}"`)
      await tabItems.nth(i).click()
      return true
    }
  }

  log.warn(`Tab "${tabName}" not found in ${count} DOM items`)
  return false
}

/**
 * Create a new tab and return its ID.
 * Names the tab for easy identification.
 */
async function createFreshTab(page) {
  await page.keyboard.press('Meta+t')
  await page.waitForTimeout(1500)
  return getActiveTabId(page)
}


async function main() {
  log.step('Запуск Noted Terminal...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: true, waitForReady: 4000
  })
  log.pass('Приложение запущено')

  try {
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // ═══════════════════════════════════════════════════════════
    // SETUP: Create FRESH tab for Claude (avoid stale session data)
    // ═══════════════════════════════════════════════════════════
    log.step('Создание свежего таба для Claude...')
    const claudeTabId = await createFreshTab(page)
    log.info('Fresh Claude tab: ' + claudeTabId)

    // Note: don't rename — Claude auto-renames on launch

    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2000)

    log.step('Запуск Claude...')
    await typeCommand(page, 'claude')

    // Wait for NEW session ID (not a stale one)
    try {
      await waitForClaudeSessionId(page, 30000)
      log.pass('Session ID detected')
    } catch {
      log.warn('Session ID timeout')
    }

    // Verify Claude is actually running by checking terminal content
    log.step('Ожидание готовности Claude (5с)...')
    await page.waitForTimeout(5000)

    const claudeContent = await getTerminalContent(page, 5)
    log.info('Claude terminal: ' + claudeContent.substring(0, 100))

    if (claudeContent.includes('fedor@') && !claudeContent.includes('>')) {
      log.fail('Claude did not start — still at shell prompt!')
      return
    }
    log.pass('Claude appears to be running')

    // Create a second tab (to switch away from Claude)
    log.step('Создание второго таба...')
    const otherTabId = await createFreshTab(page)
    // Don't rename — just use as-is
    log.info('Other tab: ' + otherTabId)

    // We're now on the OTHER tab.

    // ═══════════════════════════════════════════════════════════
    // TEST A: Click TAB in TabBar → Model Switch (BUG scenario)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST A: Click TAB → Model Switch (no terminal click) ═══${c.reset}`)

    const logMarkA = mainProcessLogs.length

    // Switch back to Claude tab by clicking the tab in DOM
    log.step('Click on Claude tab in TabBar...')
    const clicked = await clickTabInTabBarById(page, claudeTabId)
    if (!clicked) {
      log.fail('Could not find Claude tab in TabBar!')
      return
    }
    await page.waitForTimeout(1500)

    const activeA = await getActiveTabId(page)
    log.info('Active after tab click: ' + activeA?.slice(-8))
    if (activeA !== claudeTabId) {
      log.fail('Wrong tab active!')
    }

    // Send model switch WITHOUT clicking inside terminal
    log.step('Sending /model sonnet via IPC...')
    await sendModelSwitch(page, claudeTabId, 'sonnet')
    await page.waitForTimeout(8000) // Wait for safePasteAndSubmit to finish

    const contentA = await getTerminalContent(page, 15)
    log.info('Terminal after A:\n' + contentA.substring(0, 300))

    // Collect safePasteAndSubmit logs
    const logsA = mainProcessLogs.slice(logMarkA)

    // Check: did Claude exit? Look for exitCode=130 in main process logs for our tab
    const tabSuffix = claudeTabId.slice(-8)
    const exitLogs = logsA.filter(l => l.includes('exitCode=130') && l.includes(tabSuffix))
    const aliveA = exitLogs.length === 0
    // Check: did model actually switch? Look for "Set m" or model name in terminal
    const switchedA = contentA.includes('/model') && (contentA.includes('Set m') || contentA.includes('Already') || contentA.includes('sonnet'))
    // Check: DangerZone was triggered? (Ctrl+C wasted on exit warning)
    const dzTriggered = logsA.some(l => l.includes('DangerZone') && l.includes('ON') && l.includes(tabSuffix))
    log.info('alive: ' + aliveA + ', switched: ' + switchedA + ', DZ triggered: ' + dzTriggered)
    console.log(`\n--- Key Logs (Test A) ---`)
    logsA.filter(l =>
      l.includes('send-command') || l.includes('safePasteAndSubmit') ||
      l.includes('Render timeout') || l.includes('sync marker') ||
      l.includes('terminal:resize') || l.includes('safeFit') ||
      l.includes('exitCode=130') || l.includes('Command FINISHED') ||
      l.includes('Prompt ready')
    ).forEach(l => console.log('  ' + l.trim()))
    console.log('---')

    if (aliveA && switchedA && !dzTriggered) {
      log.pass('TEST A: Model switch worked cleanly after tab click')
    } else if (aliveA && switchedA && dzTriggered) {
      log.warn('TEST A: Model switch worked BUT DangerZone was triggered (Ctrl+C caused exit warning)')
      log.warn('This means Ctrl+C was not just clearing input — it was interpreted as exit attempt')
    } else if (!aliveA) {
      log.fail('TEST A: Claude DIED (exitCode=130)')
    } else {
      log.fail('TEST A: Model switch did not work')
    }

    // Check stale marker handling
    const staleSkipped = logsA.some(l => l.includes('STALE') && l.includes('discarding'))
    const realMarkerOk = logsA.some(l => l.includes('✅ sync marker') && l.includes('skipped'))

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══════════════════════════════════════${c.reset}`)
    console.log(`  Claude alive:     ${aliveA ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)
    console.log(`  Model switched:   ${switchedA ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)
    console.log(`  DZ triggered:     ${dzTriggered ? c.yellow + 'YES (exit warning)' : c.green + 'NO'}${c.reset}`)
    console.log(`  Stale skipped:    ${staleSkipped ? c.green + 'YES (fix working)' : c.yellow + 'NO'}${c.reset}`)
    console.log(`  Real marker OK:   ${realMarkerOk ? c.green + 'YES' : c.red + 'NO'}${c.reset}`)

    const overallPass = aliveA && switchedA && !dzTriggered
    console.log(`\n  Overall: ${overallPass ? c.green + 'PASS' : (aliveA && switchedA) ? c.yellow + 'PARTIAL' : c.red + 'FAIL'}${c.reset}`)

    if (dzTriggered) {
      console.log(`\n${c.yellow}DangerZone was triggered — Ctrl+C hit Claude's "exit warning" state.`)
      console.log(`This happens because Ctrl+C is sent to a CLEAN prompt (no input to clear).`)
      console.log(`Fix: skip Ctrl+C when Claude is at empty prompt, or drain DZ before paste.${c.reset}`)
    }
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
