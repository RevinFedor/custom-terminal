/**
 * Test: Replace session ID via ✎ button
 *
 * 1. Start Claude, get auto-detected session ID
 * 2. Click ✎ button, paste a known UUID, click Replace
 * 3. Verify the store was updated
 * 4. Log all console.warn from renderer (our diagnostics)
 *
 * Запуск: node auto/sandbox/test-replace-session.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId } = require('../core/launcher')
const electron = require('../core/electron')

const TARGET_SESSION = '6a2bad69-ba2d-4bec-8288-de0855c0fde2'

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

async function getSessionFromStore(page) {
  return await page.evaluate(() => {
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    const t = p?.tabs?.get?.(p?.activeTabId)
    return {
      tabId: p?.activeTabId,
      claudeSessionId: t?.claudeSessionId,
      commandType: t?.commandType
    }
  })
}

async function main() {
  log.step('Запуск Noted Terminal...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: true, logMainProcess: true, waitForReady: 4000
  })
  log.pass('Приложение запущено')

  // Collect renderer console warnings
  const rendererLogs = []
  page.on('console', msg => {
    const text = msg.text()
    if (text.includes('[ReplaceSession]') || text.includes('[Store:setClaudeSessionId]') || text.includes('[Workspace]')) {
      rendererLogs.push(text)
      console.log(`${c.yellow}[RENDERER]${c.reset} ${text}`)
    }
  })

  try {
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    log.step('Новый таб...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2000)

    log.step('Запуск Claude...')
    await typeCommand(page, 'claude')
    try { await waitForClaudeSessionId(page, 30000); log.pass('Session ID detected') }
    catch { log.warn('Session ID detection timeout — continuing anyway') }

    await page.waitForTimeout(3000)

    // Get initial session state
    const initState = await getSessionFromStore(page)
    log.info('Initial state: ' + JSON.stringify(initState))
    const originalSession = initState.claudeSessionId

    if (!originalSession) {
      log.warn('No initial session ID detected, continuing...')
    } else {
      log.pass('Original session: ' + originalSession)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST: Replace session via ✎ button
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ REPLACE SESSION TEST ═══${c.reset}`)

    // Step 1: Find and click ✎ button
    log.step('[1] Кликаем ✎ (Replace session ID)...')

    // The ✎ button has title="Replace session ID"
    const editBtn = page.locator('button[title="Replace session ID"]')
    const editBtnVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false)

    if (!editBtnVisible) {
      log.fail('✎ button NOT VISIBLE — cannot proceed')
      // Check if InfoPanel is even open
      const infoPanelVisible = await page.locator('.text-\\[11px\\].uppercase:has-text("AI Session")').isVisible({ timeout: 2000 }).catch(() => false)
      log.info('InfoPanel "AI Session" section visible: ' + infoPanelVisible)

      // Try to check what the right panel shows
      const rightPanel = await page.evaluate(() => {
        const s = window.useWorkspaceStore?.getState?.()
        const p = s?.openProjects?.get?.(s?.activeProjectId)
        return { sidebarOpen: p?.sidebarOpen }
      })
      log.info('Sidebar state: ' + JSON.stringify(rightPanel))
      return
    }

    log.pass('✎ button visible')
    await editBtn.click()
    await page.waitForTimeout(300)

    // Step 2: Find input and type UUID
    log.step('[2] Вводим UUID: ' + TARGET_SESSION)
    const sessionInput = page.locator('input[placeholder="Paste session UUID..."]')
    const inputVisible = await sessionInput.isVisible({ timeout: 3000 }).catch(() => false)

    if (!inputVisible) {
      log.fail('Session input NOT VISIBLE after clicking ✎')
      return
    }

    log.pass('Input visible')
    await sessionInput.fill(TARGET_SESSION)
    await page.waitForTimeout(200)

    // Verify input value
    const inputVal = await sessionInput.inputValue()
    log.info('Input value: ' + inputVal)

    // Step 3: Click Replace button
    log.step('[3] Кликаем Replace...')
    const replaceBtn = page.locator('button:has-text("Replace")')
    const replaceBtnVisible = await replaceBtn.isVisible({ timeout: 2000 }).catch(() => false)

    if (!replaceBtnVisible) {
      log.fail('Replace button NOT VISIBLE')
      return
    }

    // Check if disabled
    const isDisabled = await replaceBtn.isDisabled()
    log.info('Replace button disabled: ' + isDisabled)

    await replaceBtn.click()
    log.info('Replace clicked, waiting 1s...')
    await page.waitForTimeout(1000)

    // Step 4: Verify store was updated
    log.step('[4] Проверяем store...')
    const afterState = await getSessionFromStore(page)
    log.info('After state: ' + JSON.stringify(afterState))

    if (afterState.claudeSessionId === TARGET_SESSION) {
      log.pass('Store updated correctly: ' + TARGET_SESSION)
    } else if (afterState.claudeSessionId === originalSession) {
      log.fail('Store NOT updated — still has original: ' + originalSession)
    } else {
      log.warn('Store has unexpected value: ' + afterState.claudeSessionId)
    }

    // Step 5: Wait for InfoPanel polling to pick up change (500ms interval)
    log.step('[5] Ожидание InfoPanel polling (1.5с)...')
    await page.waitForTimeout(1500)

    // Check if the displayed session ID changed
    const displayedSession = await page.locator('code.text-\\[10px\\].text-\\[\\#aaa\\]').first().textContent().catch(() => 'NOT_FOUND')
    log.info('Displayed session in UI: ' + displayedSession)

    if (displayedSession === TARGET_SESSION) {
      log.pass('UI displays new session')
    } else {
      log.warn('UI still displays: ' + displayedSession)
    }

    // Step 6: Check toast
    log.step('[6] Проверяем toast...')
    // Toast should have appeared with "Session set: 6a2bad69..."

    // Summary
    console.log(`\n${c.bold}═══ RENDERER LOGS ═══${c.reset}`)
    rendererLogs.forEach(l => console.log('  ' + l))
    if (rendererLogs.length === 0) {
      log.warn('No renderer logs captured! (console.warn interception issue?)')
    }

    console.log(`\n${c.bold}═══ SUMMARY ═══${c.reset}`)
    console.log('  Original session: ' + (originalSession || 'NONE'))
    console.log('  Target session:   ' + TARGET_SESSION)
    console.log('  Store value:      ' + afterState.claudeSessionId)
    console.log('  UI display:       ' + displayedSession)

    const storeOk = afterState.claudeSessionId === TARGET_SESSION
    const uiOk = displayedSession === TARGET_SESSION

    if (storeOk && uiOk) {
      console.log(`\n${c.green}${c.bold}REPLACE SESSION: FULL SUCCESS${c.reset}`)
    } else if (storeOk && !uiOk) {
      console.log(`\n${c.yellow}${c.bold}REPLACE SESSION: STORE OK, UI NOT UPDATED${c.reset}`)
    } else {
      console.log(`\n${c.red}${c.bold}REPLACE SESSION: FAILED${c.reset}`)
    }

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
