/**
 * Test: Tab Click → Model Switch
 *
 * Воспроизводит баг: при клике по вкладке терминала (TabBar),
 * а не внутри самого терминала, model switch не работает —
 * курсор просто переносится на следующую строку.
 *
 * Сценарий:
 * 1. Запускаем Claude в первом табе (tab-0)
 * 2. Создаём второй таб и переключаемся на него
 * 3. Переключаемся обратно на Claude таб кликом по ВКЛАДКЕ в TabBar
 * 4. Отправляем model switch и проверяем логи
 *
 * Запуск: node auto/sandbox/test-tab-click-model-switch.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, findInLogs } = require('../core/launcher')
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

async function getTabInfo(page) {
  return page.evaluate(() => {
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    if (!p?.tabs) return { tabs: [], activeTabId: null, tabOrder: [] }
    const tabs = []
    p.tabs.forEach((t, id) => tabs.push({ id, name: t.name, commandType: t.commandType, claudeSessionId: t.claudeSessionId }))
    return { tabs, activeTabId: p.activeTabId, tabOrder: p.tabOrder || [] }
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

/**
 * Switch to a specific tab via store (programmatic, like Cmd+click)
 */
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
 * Click on a tab in TabBar by finding the DOM element that contains the tab name text.
 * This clicks on the [data-tab-item] element, NOT inside the terminal.
 */
async function clickTabByName(page, name) {
  const tabItems = page.locator('[data-tab-item]')
  const count = await tabItems.count()
  log.info(`Looking for tab "${name}" among ${count} tab items...`)

  for (let i = 0; i < count; i++) {
    const text = await tabItems.nth(i).textContent()
    log.info(`  tab[${i}] text: "${text?.trim()}"`)
    if (text?.trim()?.toLowerCase().includes(name.toLowerCase())) {
      log.info(`  → clicking tab[${i}]`)
      await tabItems.nth(i).click()
      return true
    }
  }
  log.warn(`Tab with name "${name}" not found in DOM`)
  return false
}

async function clickInsideTerminal(page) {
  // Multiple .xterm-screen elements exist (one per tab). Use .first() for the visible one.
  const terminal = page.locator('.xterm-screen').first()
  await terminal.click()
}

async function isClaudeAlive(page, tabId) {
  return page.evaluate((tid) => {
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    const t = tid ? p?.tabs?.get?.(tid) : p?.tabs?.get?.(p?.activeTabId)
    return {
      alive: !!(t?.commandType === 'claude' || t?.claudeSessionId),
      commandType: t?.commandType,
      sessionId: t?.claudeSessionId?.slice(0, 8)
    }
  }, tabId)
}

async function main() {
  log.step('Запуск Noted Terminal...')
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: true, waitForReady: 4000
  })
  log.pass('Приложение запущено')

  try {
    // ═══════════════════════════════════════════════════════════
    // SETUP: Launch Claude in the default tab
    // ═══════════════════════════════════════════════════════════
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // Use the default tab (tab-0) — no need to create a new one
    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2000)

    const claudeTabId = await getActiveTabId(page)
    log.info('Claude tab ID: ' + claudeTabId)

    log.step('Запуск Claude...')
    await typeCommand(page, 'claude')
    try {
      await waitForClaudeSessionId(page, 30000)
      log.pass('Session ID detected')
    } catch {
      log.warn('Session ID timeout — continuing anyway')
    }

    log.step('Ожидание готовности Claude (5с)...')
    await page.waitForTimeout(5000)

    // Dump tab info
    let info = await getTabInfo(page)
    log.info('Tabs: ' + JSON.stringify(info.tabs.map(t => `${t.name}(${t.id.slice(-6)})`)))
    log.info('Active: ' + info.activeTabId?.slice(-6))

    // Create second tab to have something to switch away to
    log.step('Создание второго таба (Cmd+T)...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    const secondTabId = await getActiveTabId(page)
    log.info('Second tab ID: ' + secondTabId)

    info = await getTabInfo(page)
    log.info('All tabs after: ' + JSON.stringify(info.tabs.map(t => `${t.name}(${t.id.slice(-6)})`)))
    log.info('Active: ' + info.activeTabId?.slice(-6))

    // We're now on the second (empty) tab.
    // The Claude tab should be named "claude" (name updates when claude starts).

    // ═══════════════════════════════════════════════════════════
    // TEST A: Click TAB in TabBar → Model Switch (BUG scenario)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST A: Click TAB → Model Switch ═══${c.reset}`)

    log.step('Переключение на Claude таб кликом по ВКЛАДКЕ...')
    const logMarkA = mainProcessLogs.length

    const found = await clickTabByName(page, 'claude')
    if (!found) {
      // Fallback: try clicking by tab with claudeSessionId
      log.warn('Fallback: switching via store...')
      await switchToTabViaStore(page, claudeTabId)
    }
    await page.waitForTimeout(1500) // Wait for activation + safeFit

    // Verify we switched
    const activeAfterClick = await getActiveTabId(page)
    log.info('Active tab after click: ' + activeAfterClick?.slice(-6) + ' (expected: ' + claudeTabId?.slice(-6) + ')')
    if (activeAfterClick === claudeTabId) {
      log.pass('Switched to Claude tab')
    } else {
      log.fail('Did NOT switch to Claude tab!')
    }

    // Check Claude is alive before
    const beforeState = await isClaudeAlive(page, claudeTabId)
    log.info('Claude before model switch: ' + JSON.stringify(beforeState))

    // Model switch WITHOUT clicking inside terminal
    log.step('Model switch (sonnet) — WITHOUT clicking inside terminal...')
    const contentBefore = await getTerminalContent(page, 5)
    log.info('Terminal before: ' + contentBefore.substring(0, 100))

    await sendModelSwitch(page, claudeTabId, 'sonnet')
    await page.waitForTimeout(6000)

    const contentAfterA = await getTerminalContent(page, 10)
    log.info('Terminal after A: ' + contentAfterA.substring(0, 200))

    // Check if Claude is still alive (main indicator)
    const afterStateA = await isClaudeAlive(page, claudeTabId)
    log.info('Claude after model switch: ' + JSON.stringify(afterStateA))

    const modelSwitchA = afterStateA.alive && !contentAfterA.includes('fedor@') // shell prompt = Claude died

    // Logs
    const logsA = mainProcessLogs.slice(logMarkA)
    console.log(`\n--- Logs (Test A) ---`)
    logsA.filter(l =>
      l.includes('safeFit') || l.includes('terminal:resize') ||
      l.includes('send-command') || l.includes('safePasteAndSubmit') ||
      l.includes('waitForRender') || l.includes('sync marker') ||
      l.includes('TabBar:click')
    ).forEach(l => console.log('  ' + l.trim()))
    console.log('---')

    if (modelSwitchA) {
      log.pass('TEST A: Model switch worked after tab click')
    } else {
      log.fail('TEST A: Model switch FAILED after tab click')
    }

    // ═══════════════════════════════════════════════════════════
    // TEST B: Click INSIDE terminal → Model Switch (WORKING scenario)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST B: Click INSIDE terminal → Model Switch ═══${c.reset}`)

    // Test A killed Claude. Dismiss overlay + restart.
    log.step('Dismiss overlay + restart Claude for Test B...')
    await page.evaluate((tid) => {
      const s = window.useWorkspaceStore?.getState?.()
      if (s?.dismissInterruptedSession) s.dismissInterruptedSession(tid)
      // Also manually clear flags
      const proj = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = proj?.tabs?.get?.(tid)
      if (tab) {
        tab.wasInterrupted = false
        tab.overlayDismissed = true
        tab.commandType = undefined
        tab.claudeSessionId = undefined
      }
    }, claudeTabId)
    await page.waitForTimeout(500)

    // Click terminal (overlay dismissed)
    await clickInsideTerminal(page)
    await page.waitForTimeout(300)

    // Restart Claude
    log.step('Restarting Claude...')
    await typeCommand(page, 'claude')
    try {
      await waitForClaudeSessionId(page, 30000)
      log.pass('Claude restarted for Test B')
    } catch { log.warn('Session ID timeout on restart') }
    await page.waitForTimeout(5000)

    // Switch away, then back via tab click, then click inside terminal
    log.step('Switching away to second tab...')
    await switchToTabViaStore(page, secondTabId)
    await page.waitForTimeout(1000)

    log.step('Switching back to Claude tab (tab click)...')
    await clickTabByName(page, 'claude')
    await page.waitForTimeout(1500)

    // THIS TIME: click inside terminal first
    log.step('Клик ВНУТРИ терминала...')
    const logMarkB = mainProcessLogs.length
    await clickInsideTerminal(page)
    await page.waitForTimeout(500)

    log.step('Model switch (opus) — AFTER clicking inside terminal...')
    await sendModelSwitch(page, claudeTabId, 'opus')
    await page.waitForTimeout(6000)

    const contentAfterB = await getTerminalContent(page, 10)
    log.info('Terminal after B: ' + contentAfterB.substring(0, 200))

    const afterStateB = await isClaudeAlive(page, claudeTabId)
    log.info('Claude after B: ' + JSON.stringify(afterStateB))

    const modelSwitchB = afterStateB.alive

    const logsB = mainProcessLogs.slice(logMarkB)
    console.log(`\n--- Logs (Test B) ---`)
    logsB.filter(l =>
      l.includes('safeFit') || l.includes('terminal:resize') ||
      l.includes('send-command') || l.includes('safePasteAndSubmit') ||
      l.includes('waitForRender') || l.includes('sync marker')
    ).forEach(l => console.log('  ' + l.trim()))
    console.log('---')

    if (modelSwitchB) {
      log.pass('TEST B: Model switch worked after terminal click')
    } else {
      log.fail('TEST B: Model switch FAILED after terminal click')
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══════════════════════════════════════${c.reset}`)
    console.log(`  Test A (Tab Click → Model):      ${modelSwitchA ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset}`)
    console.log(`  Test B (Terminal Click → Model):  ${modelSwitchB ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset}`)

    if (!modelSwitchA && modelSwitchB) {
      console.log(`\n${c.yellow}${c.bold}BUG CONFIRMED: Tab click breaks model switch${c.reset}`)
    } else if (modelSwitchA && modelSwitchB) {
      console.log(`\n${c.green}${c.bold}Both work — bug not reproduced${c.reset}`)
    } else if (!modelSwitchA && !modelSwitchB) {
      console.log(`\n${c.red}${c.bold}Both fail — different issue${c.reset}`)
    }
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)

    // Dump ALL safePasteAndSubmit + resize logs
    console.log(`\n--- ALL safePasteAndSubmit + resize logs ---`)
    mainProcessLogs
      .filter(l => l.includes('safePasteAndSubmit') || l.includes('sync marker') || l.includes('terminal:resize') || l.includes('safeFit'))
      .forEach(l => console.log('  ' + l.trim()))
    console.log('---')

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
