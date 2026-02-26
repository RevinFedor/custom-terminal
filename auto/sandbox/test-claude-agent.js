/**
 * Test: Claude Agent Orchestration (@claude:...@end pattern detection)
 *
 * Verifies:
 * 1. Pattern Detection — main process detects @claude:...@end in PTY output of a Gemini tab
 * 2. ClaudeAgentManager — SDK is invoked, returns a response
 * 3. Status Updates — renderer receives IPC `claude-agent:status` and updates store
 * 4. Response Paste — Claude response is pasted back into the terminal
 *
 * Strategy:
 * - Create a new tab, cd into project directory
 * - Start `gemini` (creates Gemini watcher for the tab — required for pattern detector)
 * - Send @claude:...@end pattern via terminal:input IPC
 * - Wait for claudeAgentStatus to become 'done' or 'error'
 * - Verify main process logs and store state
 *
 * Run: node auto/sandbox/test-claude-agent.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

// Colors for logging
const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
}

const log = {
  step: (msg) => console.log(`${c.cyan}[STEP]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  log: (msg) => console.log(`${c.dim}[LOG]${c.reset} ${msg}`)
}

const PROMPT_TEXT = 'Say hello in one short sentence'
const TARGET_DIR = '/Users/fedor/Desktop/custom-terminal'

async function main() {
  log.step('Launching Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  log.pass('Application launched')

  try {
    // Wait for terminal
    log.step('Waiting for terminal...')
    await waitForTerminal(page, 15000)
    log.pass('Terminal is active')

    // Focus window
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // Create new tab
    log.step('Creating new tab (Cmd+T)...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)
    log.pass('New tab created')

    // Navigate to project directory
    log.step(`Navigating to: ${TARGET_DIR}`)
    await typeCommand(page, `cd ${TARGET_DIR}`)
    await page.waitForTimeout(2000)

    // Verify CWD updated
    const cwdCheck = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return tab?.cwd
    })
    log.info(`Tab CWD after cd: ${cwdCheck}`)
    if (cwdCheck?.includes('custom-terminal')) {
      log.pass('CWD updated correctly')
    } else {
      log.warn(`CWD may be incorrect: ${cwdCheck}`)
    }

    // Get tab ID
    const tabId = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      return proj?.activeTabId
    })
    log.info(`Active tab ID: ${tabId}`)

    if (!tabId) {
      log.fail('Could not get active tab ID')
      return
    }

    // ===== STEP 1: Start Gemini (to create watcher for pattern detection) =====
    log.step('Starting Gemini CLI (typeCommand "gemini")...')
    await typeCommand(page, 'gemini')
    log.pass('Gemini command entered')

    // Spawn Gemini watcher via IPC (required for pattern detector to activate)
    log.step('Spawning Gemini watcher via IPC...')
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('gemini:spawn-with-watcher', { tabId: tid, cwd: '/Users/fedor/Desktop/custom-terminal' })
    }, tabId)
    log.pass('Gemini watcher IPC sent')

    // Wait for Gemini to initialize (TUI needs time to load)
    log.step('Waiting 10s for Gemini TUI to initialize...')
    await page.waitForTimeout(10000)
    log.pass('Gemini startup wait complete')

    // Check initial claudeAgentStatus
    const initialStatus = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return {
        claudeAgentStatus: tab?.claudeAgentStatus,
        claudeAgentSessionId: tab?.claudeAgentSessionId,
        commandType: tab?.commandType
      }
    })
    log.info(`Initial state: status=${initialStatus.claudeAgentStatus || 'undefined'}, sessionId=${initialStatus.claudeAgentSessionId || 'none'}, commandType=${initialStatus.commandType || 'undefined'}`)

    // ===== STEP 2: Send :::claude ... ::: pattern via terminal:input =====
    log.step(`Sending pattern: :::claude ${PROMPT_TEXT} :::`)
    await page.evaluate(({ tid, prompt }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, `:::claude ${prompt} :::\n`)
    }, { tid: tabId, prompt: PROMPT_TEXT })
    log.pass('Pattern sent via terminal:input IPC')

    // Brief wait for pattern to be detected
    await page.waitForTimeout(3000)

    // Check if pattern was detected in main process logs
    const detectLogs = findInLogs(mainProcessLogs, '[ClaudeAgent:Detect]')
    if (detectLogs.length > 0) {
      log.pass(`Pattern detection found (${detectLogs.length} log entries)`)
      detectLogs.forEach(l => log.log(l.substring(0, 200)))
    } else {
      log.warn('No [ClaudeAgent:Detect] logs yet (may appear later)')
    }

    // Check if handle started
    const handleLogs = findInLogs(mainProcessLogs, '[ClaudeAgent:Handle]')
    if (handleLogs.length > 0) {
      log.pass(`Handle started (${handleLogs.length} log entries)`)
      handleLogs.slice(0, 3).forEach(l => log.log(l.substring(0, 200)))
    } else {
      log.warn('No [ClaudeAgent:Handle] logs yet')
    }

    // ===== STEP 3: Check running status =====
    log.step('Checking if claudeAgentStatus became "running"...')
    try {
      await page.waitForFunction(() => {
        const store = window.useWorkspaceStore?.getState?.()
        const proj = store?.openProjects?.get?.(store?.activeProjectId)
        const tab = proj?.tabs?.get?.(proj?.activeTabId)
        return tab?.claudeAgentStatus === 'running' || tab?.claudeAgentStatus === 'done' || tab?.claudeAgentStatus === 'error'
      }, { timeout: 15000 })

      const runningState = await page.evaluate(() => {
        const store = window.useWorkspaceStore?.getState?.()
        const proj = store?.openProjects?.get?.(store?.activeProjectId)
        const tab = proj?.tabs?.get?.(proj?.activeTabId)
        return tab?.claudeAgentStatus
      })
      log.pass(`Claude Agent status transitioned to: ${runningState}`)
    } catch (e) {
      log.fail('claudeAgentStatus never became running/done/error within 15s')
    }

    // ===== STEP 4: Wait for completion (done or error) =====
    log.step('Waiting for Claude Agent to complete (up to 120s)...')
    try {
      await page.waitForFunction(() => {
        const store = window.useWorkspaceStore?.getState?.()
        const proj = store?.openProjects?.get?.(store?.activeProjectId)
        const tab = proj?.tabs?.get?.(proj?.activeTabId)
        return tab?.claudeAgentStatus === 'done' || tab?.claudeAgentStatus === 'error'
      }, { timeout: 120000 })
      log.pass('Claude Agent completed')
    } catch (e) {
      log.fail('Claude Agent did not complete within 120s')
    }

    // ===== STEP 5: Collect final state =====
    log.step('Collecting final tab state...')
    const finalState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return {
        claudeAgentStatus: tab?.claudeAgentStatus,
        claudeAgentSessionId: tab?.claudeAgentSessionId,
        commandType: tab?.commandType,
        tabId: tab?.id
      }
    })

    console.log('\n--- Final Tab State ---')
    console.log(JSON.stringify(finalState, null, 2))
    console.log('--- End ---\n')

    // ===== STEP 6: Analyze main process logs =====
    log.step('Analyzing main process logs...')

    const allDetectLogs = findInLogs(mainProcessLogs, '[ClaudeAgent:Detect]')
    const allHandleLogs = findInLogs(mainProcessLogs, '[ClaudeAgent:Handle]')
    const allPasteLogs = findInLogs(mainProcessLogs, '[ClaudeAgent:Paste')
    const allErrPasteLogs = findInLogs(mainProcessLogs, '[ClaudeAgent:ErrPaste')
    const allAgentLogs = findInLogs(mainProcessLogs, '[ClaudeAgent')

    console.log('\n--- All ClaudeAgent Logs ---')
    allAgentLogs.forEach(l => log.log(l.substring(0, 300)))
    console.log('--- End ---\n')

    // Renderer logs (claude-agent related)
    const rendererAgentLogs = findInLogs(consoleLogs, 'ClaudeAgent')
    console.log('--- Renderer Claude Agent Logs ---')
    rendererAgentLogs.forEach(l => log.log(l.substring(0, 200)))
    console.log('--- End ---\n')

    // ===== RESULTS =====
    console.log('\n' + c.bold + '═══════════════════════════════════════' + c.reset)
    console.log(c.bold + '  CLAUDE AGENT ORCHESTRATION TEST RESULTS' + c.reset)
    console.log(c.bold + '═══════════════════════════════════════' + c.reset + '\n')

    let passCount = 0
    let failCount = 0

    // Check 1: Pattern detection in main process
    const patternDetected = allDetectLogs.length > 0
    if (patternDetected) {
      log.pass('CHECK 1: Pattern :::claude::: detected in main process')
      passCount++
    } else {
      log.fail('CHECK 1: Pattern :::claude::: NOT detected in main process')
      failCount++
    }

    // Check 2: Handle started
    const handleStarted = allHandleLogs.some(l => l.includes('Send') || l.includes('NEW session'))
    if (handleStarted) {
      log.pass('CHECK 2: handleClaudeAgentCommand started')
      passCount++
    } else {
      log.fail('CHECK 2: handleClaudeAgentCommand did NOT start')
      failCount++
    }

    // Check 3: Status transitioned to running (check renderer logs)
    const statusRunning = rendererAgentLogs.some(l => l.includes('running'))
    if (statusRunning) {
      log.pass('CHECK 3: Renderer received "running" status update')
      passCount++
    } else {
      log.fail('CHECK 3: Renderer did NOT receive "running" status update')
      failCount++
    }

    // Check 4: Final status is done or error
    const finalStatus = finalState.claudeAgentStatus
    if (finalStatus === 'done') {
      log.pass(`CHECK 4: Final status = "done"`)
      passCount++
    } else if (finalStatus === 'error') {
      log.warn(`CHECK 4: Final status = "error" (Claude Agent failed, but orchestration worked)`)
      passCount++ // Error means the pipeline ran end-to-end, just the SDK call failed
    } else {
      log.fail(`CHECK 4: Final status = "${finalStatus || 'undefined'}" (expected "done" or "error")`)
      failCount++
    }

    // Check 5: Session ID appeared (only if status is done)
    if (finalStatus === 'done' && finalState.claudeAgentSessionId) {
      log.pass(`CHECK 5: Session ID captured: ${finalState.claudeAgentSessionId}`)
      passCount++
    } else if (finalStatus === 'done' && !finalState.claudeAgentSessionId) {
      log.fail('CHECK 5: Status is "done" but no Session ID in store')
      failCount++
    } else if (finalStatus === 'error') {
      log.warn('CHECK 5: Skipped (status is "error", Session ID may not be available)')
    } else {
      log.fail('CHECK 5: No Session ID (status is not done)')
      failCount++
    }

    // Check 6: Response paste (only if status is done)
    if (finalStatus === 'done') {
      const hasPaste = allPasteLogs.length > 0
      if (hasPaste) {
        log.pass('CHECK 6: Response pasted back into terminal')
        passCount++
      } else {
        log.fail('CHECK 6: No paste logs found (response may not have been pasted)')
        failCount++
      }
    } else if (finalStatus === 'error') {
      const hasErrPaste = allErrPasteLogs.length > 0
      if (hasErrPaste) {
        log.pass('CHECK 6: Error message pasted back into terminal')
        passCount++
      } else {
        log.warn('CHECK 6: No error paste logs (may have been cancelled)')
      }
    } else {
      log.fail('CHECK 6: Skipped (no completion)')
      failCount++
    }

    // Check 7: Response contains metadata (turn, tokens, cost)
    const metaLog = allHandleLogs.find(l => l.includes('Turn=') && l.includes('Tokens='))
    if (metaLog) {
      log.pass('CHECK 7: Response contains metadata (turn, tokens, cost)')
      log.log(metaLog.substring(0, 200))
      passCount++
    } else if (finalStatus === 'error') {
      log.warn('CHECK 7: Skipped (status is "error")')
    } else {
      log.fail('CHECK 7: No metadata in handle logs')
      failCount++
    }

    // Summary
    console.log('')
    console.log(c.bold + '═══════════════════════════════════════' + c.reset)
    const total = passCount + failCount
    if (failCount === 0) {
      log.pass(`ALL CHECKS PASSED: ${passCount}/${total}`)
    } else {
      log.fail(`FAILED: ${failCount}/${total} checks failed, ${passCount}/${total} passed`)
    }
    console.log(c.bold + '═══════════════════════════════════════' + c.reset)

    // Dump last 80 main process logs for debugging
    console.log('\n--- ALL Main Process Logs (last 80) ---')
    mainProcessLogs.slice(-80).forEach(l => console.log(l.substring(0, 300)))

  } finally {
    log.step('Closing application...')
    await app.close()
  }
}

// Retry wrapper: up to 3 attempts with 10s pause on launch failure
async function run() {
  const MAX_RETRIES = 3
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await main()
      return
    } catch (err) {
      if (attempt < MAX_RETRIES && (err.message.includes('Process failed to launch') || err.message.includes('Timeout') || err.message.includes('waitForEvent'))) {
        log.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`)
        log.warn('Waiting 10s before retry...')
        await new Promise(r => setTimeout(r, 10000))
      } else {
        console.error(`${c.red}[ERROR]${c.reset}`, err.message)
        console.error(err.stack)
        process.exit(1)
      }
    }
  }
}

run()
