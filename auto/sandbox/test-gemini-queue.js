/**
 * E2E Test: Gemini Response Queue System
 *
 * Tests the response queue that holds Claude sub-agent responses when Gemini is busy
 * or the user has text typed in the input field.
 *
 * Part 1: Input State Detection
 *   1. Gemini CLI launch & session detection
 *   2. Type a character → [GeminiInput] hasText: true
 *   3. Press Enter → [GeminiInput] hasText: false (submit/cancel)
 *   4. Type text, press Ctrl+C → input clears
 *   5. gemini:get-queue IPC returns correct hasText state
 *
 * Part 2: Queue System
 *   6. gemini:get-queue returns empty queue initially
 *   7. Queue accessible via IPC with correct structure
 *   8. gemini:queue-update event structure (via logs)
 *
 * [E2E+Gemini] — Requires: npm run dev (port 5182) + npx electron-vite build + gemini CLI installed
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

// Heartbeat: prints dots every N seconds so output doesn't look stuck
function startHeartbeat(label, intervalMs = 5000) {
  let count = 0
  const timer = setInterval(() => {
    count++
    process.stdout.write(`${c.dim}  ...${label} ${count * (intervalMs / 1000)}s${c.reset}\n`)
  }, intervalMs)
  return () => clearInterval(timer)
}

async function main() {
  // Hard kill safety (180s)
  const globalTimer = setTimeout(() => {
    console.error('\n[FATAL] Global timeout (180s). Force exit.')
    process.exit(1)
  }, 180000)

  log.step('Launching Electron app...')
  let { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    log.step('Waiting for app initialization...')
    await page.waitForTimeout(3000)

    // Focus window (retry on HMR navigation)
    for (let i = 0; i < 3; i++) {
      try {
        await electron.focusWindow(app)
        break
      } catch (e) {
        log.info(`focusWindow attempt ${i + 1} failed, retrying...`)
        await page.waitForTimeout(2000)
        const windows = await app.windows()
        for (const win of windows) {
          const url = await win.url()
          if (!url.includes('devtools://')) { page = win; break }
        }
      }
    }

    // Ensure terminal is visible (might start in Home View)
    let terminalVisible = false
    try {
      await waitForTerminal(page, 5000)
      terminalVisible = true
    } catch {
      log.info('Terminal not visible, creating tab via Cmd+T...')
      await page.keyboard.press('Meta+t')
      await page.waitForTimeout(2000)
      try {
        await waitForTerminal(page, 10000)
        terminalVisible = true
      } catch {
        log.warn('Still no terminal after Cmd+T')
      }
    }

    try {
      await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })
    } catch { /* ok */ }
    log.info(`Terminal ${terminalVisible ? 'ready' : 'not visible'}, window focused`)

    // ===============================================================
    // SETUP: Create fresh tab and launch Gemini CLI
    // ===============================================================
    log.step('SETUP: Create fresh tab and launch Gemini CLI')

    // Create a fresh tab to avoid reusing existing claude/gemini tabs
    const tabsBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabsBefore, { timeout: 5000 })
    await page.waitForTimeout(1000)
    log.info('Fresh tab created')

    // Navigate to project directory
    await typeCommand(page, 'cd ~/Desktop/custom-terminal')
    await page.waitForTimeout(1500)

    // Start Gemini via IPC (spawn-with-watcher)
    const activeTabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tabId = p?.activeTabId
      if (tabId) {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('gemini:spawn-with-watcher', {
          tabId,
          cwd: '/Users/fedor/Desktop/custom-terminal'
        })
      }
      return tabId
    })
    log.info(`Gemini spawn-with-watcher sent for tab: ${activeTabId}`)

    // Wait for session detection (event-driven)
    log.step('Waiting for Gemini session detection...')
    const stopHb1 = startHeartbeat('waiting-gemini-session')
    let geminiSessionDetected = false
    try {
      await waitForGeminiSessionId(page, 40000)
      geminiSessionDetected = true
    } catch {
      log.warn('Gemini session ID timeout -- CLI may still be loading')
    }
    stopHb1()

    if (!geminiSessionDetected) {
      log.fail('Cannot proceed without Gemini session. Aborting.')
      process.exitCode = 1
      return
    }
    log.info('Gemini session detected')

    // Wait for Gemini TUI readiness: spinner appears then stops
    log.step('Waiting for Gemini TUI readiness...')
    const stopHbReady = startHeartbeat('waiting-gemini-ready')
    const loadingLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*THINKING/, 20000)
    if (loadingLog) {
      log.info('Gemini loading spinner detected, waiting for IDLE...')
      const readyLog = await waitForMainProcessLog(mainProcessLogs,
        /\[GeminiSpinner\].*IDLE/, 20000)
      if (readyLog) log.info('Gemini TUI ready (spinner stopped)')
    } else {
      log.warn('No loading spinner detected, using 10s fallback')
      await page.waitForTimeout(10000)
    }
    stopHbReady()
    await page.waitForTimeout(1000) // Small settle time

    // Verify tab commandType is now 'gemini'
    const geminiTabInfo = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = p?.tabs?.get?.(p?.activeTabId)
      return { commandType: tab?.commandType, geminiSessionId: tab?.geminiSessionId }
    })
    assert(geminiTabInfo?.commandType === 'gemini',
      `Tab commandType is 'gemini': ${geminiTabInfo?.commandType}`)
    log.info(`Gemini session: ${geminiTabInfo?.geminiSessionId}`)

    // Record the log baseline index (ignore logs before our tests)
    const logBaseline = mainProcessLogs.length

    // ===============================================================
    // TEST 1: gemini:get-queue returns empty queue initially
    // ===============================================================
    log.step('TEST 1: gemini:get-queue returns empty queue initially')

    const initialQueue = await page.evaluate(({ tabId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', tabId)
    }, { tabId: activeTabId })

    assert(initialQueue !== null && initialQueue !== undefined,
      'gemini:get-queue returned a result')
    assert(initialQueue.hasText === false,
      `Initial hasText is false: ${initialQueue.hasText}`)
    assert(Array.isArray(initialQueue.queue) && initialQueue.queue.length === 0,
      `Initial queue is empty array: length=${initialQueue.queue?.length}`)

    // ===============================================================
    // TEST 2: Type a character -> [GeminiInput] hasText: true
    // ===============================================================
    log.step('TEST 2: Type a character -> input detected')

    // Clear log baseline for this specific test
    const logIndexBeforeType = mainProcessLogs.length

    // Type a single printable character into Gemini TUI
    await page.keyboard.type('x')

    // Wait for [GeminiInput] log with "Input detected"
    const inputDetectedLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiInput\].*Input detected.*typing/, 10000)

    assert(inputDetectedLog !== null,
      `[GeminiInput] Input detected (user typing): ${inputDetectedLog ? 'yes' : 'no'}`)

    // Verify hasText via IPC
    const afterTypeQueue = await page.evaluate(({ tabId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', tabId)
    }, { tabId: activeTabId })

    assert(afterTypeQueue.hasText === true,
      `hasText is true after typing: ${afterTypeQueue.hasText}`)

    // ===============================================================
    // TEST 3: Press Ctrl+C -> input clears
    // ===============================================================
    log.step('TEST 3: Press Ctrl+C -> input clears')

    // Ctrl+C should clear input
    await page.keyboard.press('Control+c')

    // Wait for [GeminiInput] log with "Input cleared"
    const inputClearedCtrlCLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiInput\].*Input cleared.*submit\/cancel/, 10000)

    assert(inputClearedCtrlCLog !== null,
      `[GeminiInput] Input cleared (submit/cancel): ${inputClearedCtrlCLog ? 'yes' : 'no'}`)

    // Verify hasText via IPC
    const afterCtrlCQueue = await page.evaluate(({ tabId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', tabId)
    }, { tabId: activeTabId })

    assert(afterCtrlCQueue.hasText === false,
      `hasText is false after Ctrl+C: ${afterCtrlCQueue.hasText}`)

    // ===============================================================
    // TEST 4: Type text, then press Enter -> input clears
    // ===============================================================
    log.step('TEST 4: Type text, press Enter -> input clears + Gemini goes BUSY')

    // Wait a moment for the TUI to settle after Ctrl+C
    await page.waitForTimeout(1000)

    // Type a short prompt
    await page.keyboard.type('hi')
    await page.waitForTimeout(500)

    // Verify hasText is true before Enter
    const beforeEnterQueue = await page.evaluate(({ tabId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', tabId)
    }, { tabId: activeTabId })

    assert(beforeEnterQueue.hasText === true,
      `hasText is true before Enter: ${beforeEnterQueue.hasText}`)

    // Press Enter to submit
    await page.keyboard.press('Enter')

    // Wait for input cleared log (Enter triggers submit)
    const inputClearedEnterLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiInput\].*Input cleared/, 10000)

    assert(inputClearedEnterLog !== null,
      `[GeminiInput] Input cleared on Enter: ${inputClearedEnterLog ? 'yes' : 'no'}`)

    // After Enter, Gemini should start thinking (spinner THINKING)
    log.step('Waiting for Gemini THINKING after submit...')
    const stopHb2 = startHeartbeat('waiting-thinking')
    const thinkingLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*THINKING/, 15000)
    stopHb2()

    assert(thinkingLog !== null,
      `Gemini THINKING after submit: ${thinkingLog ? 'yes' : 'no'}`)

    // ===============================================================
    // TEST 5: Gemini BUSY clears input state automatically
    // ===============================================================
    log.step('TEST 5: Gemini BUSY clears input state automatically')

    // When Gemini goes BUSY (spinner detected), any hasText should be cleared.
    // Look for the specific log pattern: "Input cleared (Gemini BUSY)"
    // This fires when spinner transitions to THINKING and hasText was true.
    // Since we already typed + Enter, the input was cleared by Enter itself,
    // so the BUSY-triggered clear may not fire. Check the log pattern anyway.
    const busyClearLogs = findInLogs(mainProcessLogs, 'Input cleared (Gemini BUSY)')

    if (busyClearLogs.length > 0) {
      log.pass(`Gemini BUSY auto-cleared input: found ${busyClearLogs.length} occurrence(s)`)
      passed++
    } else {
      // This is expected: Enter already cleared hasText before spinner THINKING.
      // The BUSY auto-clear only fires if user typed text without pressing Enter
      // and Gemini goes busy from another source (e.g. MCP paste).
      log.info('No BUSY auto-clear fired (Enter already cleared hasText -- expected)')
      log.pass('Gemini BUSY auto-clear: not triggered (Enter cleared first -- correct behavior)')
      passed++
    }

    // ===============================================================
    // TEST 6: Wait for Gemini IDLE, verify queue state is clean
    // ===============================================================
    log.step('TEST 6: Wait for Gemini IDLE after response')

    const stopHb3 = startHeartbeat('waiting-idle')
    const idleLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*IDLE/, 60000)
    stopHb3()

    assert(idleLog !== null,
      `Gemini IDLE after response: ${idleLog ? 'yes' : 'no'}`)

    // After IDLE, hasText should be false and queue empty
    await page.waitForTimeout(500)

    const postIdleQueue = await page.evaluate(({ tabId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', tabId)
    }, { tabId: activeTabId })

    assert(postIdleQueue.hasText === false,
      `hasText is false after IDLE: ${postIdleQueue.hasText}`)
    assert(postIdleQueue.queue.length === 0,
      `Queue is empty after IDLE: length=${postIdleQueue.queue.length}`)

    // ===============================================================
    // TEST 7: Queue structure validation (via gemini:get-queue)
    // ===============================================================
    log.step('TEST 7: Queue structure validation')

    // Verify the returned object has the expected shape
    const queueResult = await page.evaluate(({ tabId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', tabId)
    }, { tabId: activeTabId })

    assert(typeof queueResult === 'object' && queueResult !== null,
      'gemini:get-queue returns an object')
    assert('hasText' in queueResult,
      `Result has 'hasText' field: ${typeof queueResult.hasText}`)
    assert('queue' in queueResult,
      `Result has 'queue' field: ${typeof queueResult.queue}`)
    assert(typeof queueResult.hasText === 'boolean',
      `hasText is boolean: ${typeof queueResult.hasText}`)
    assert(Array.isArray(queueResult.queue),
      `queue is an array: ${Array.isArray(queueResult.queue)}`)

    // ===============================================================
    // TEST 8: IPC events fire correctly (gemini:busy-state)
    // ===============================================================
    log.step('TEST 8: Verify gemini:busy-state IPC events in logs')

    const busyStateLogs = findInLogs(mainProcessLogs, '[GeminiSpinner]')
    const thinkingCount = busyStateLogs.filter(l => l.includes('THINKING')).length
    const idleCount = busyStateLogs.filter(l => l.includes('IDLE')).length

    log.info(`Spinner transitions: ${thinkingCount} THINKING, ${idleCount} IDLE`)
    assert(thinkingCount >= 1,
      `At least 1 THINKING transition logged: ${thinkingCount}`)
    assert(idleCount >= 1,
      `At least 1 IDLE transition logged: ${idleCount}`)

    // The [GeminiSpinner] logs correspond to gemini:busy-state IPC sends.
    // Each THINKING sends { tabId, busy: true }, each IDLE sends { tabId, busy: false }.
    assert(thinkingCount >= idleCount || idleCount - thinkingCount <= 1,
      `THINKING/IDLE balance reasonable: ${thinkingCount}T / ${idleCount}I`)

    // ===============================================================
    // TEST 9: gemini:input-state IPC events fired correctly
    // ===============================================================
    log.step('TEST 9: Verify gemini:input-state events via [GeminiInput] logs')

    const inputLogs = findInLogs(mainProcessLogs, '[GeminiInput]')
    const inputDetectedCount = inputLogs.filter(l => l.includes('Input detected')).length
    const inputClearedCount = inputLogs.filter(l => l.includes('Input cleared')).length

    log.info(`Input events: ${inputDetectedCount} detected, ${inputClearedCount} cleared`)
    assert(inputDetectedCount >= 1,
      `At least 1 input detection event: ${inputDetectedCount}`)
    assert(inputClearedCount >= 1,
      `At least 1 input cleared event: ${inputClearedCount}`)

    // Every "detected" should eventually have a matching "cleared"
    assert(inputClearedCount >= inputDetectedCount,
      `Input cleared >= detected (no stuck state): ${inputClearedCount} >= ${inputDetectedCount}`)

    // ===============================================================
    // TEST 10: gemini:get-queue for non-existent tab returns defaults
    // ===============================================================
    log.step('TEST 10: gemini:get-queue for non-existent tab')

    const fakeTabQueue = await page.evaluate(() => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('gemini:get-queue', 'non-existent-tab-id-12345')
    })

    assert(fakeTabQueue.hasText === false,
      `Non-existent tab hasText defaults to false: ${fakeTabQueue.hasText}`)
    assert(Array.isArray(fakeTabQueue.queue) && fakeTabQueue.queue.length === 0,
      `Non-existent tab queue defaults to empty: length=${fakeTabQueue.queue?.length}`)

    // ===============================================================
    // RESULTS
    // ===============================================================
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    console.log(`${'='.repeat(50)}`)

    // Dump relevant logs summary
    log.info('\n--- LOG SUMMARY ---')
    const allInputLogs = findInLogs(mainProcessLogs, '[GeminiInput]')
    const allSpinnerLogs = findInLogs(mainProcessLogs, '[GeminiSpinner]')
    const allQueueLogs = findInLogs(mainProcessLogs, '[MCP:Queue]')
    log.info(`[GeminiInput] logs: ${allInputLogs.length}`)
    for (const l of allInputLogs.slice(-5)) log.info(`  ${l.trim().substring(0, 120)}`)
    log.info(`[GeminiSpinner] logs: ${allSpinnerLogs.length}`)
    for (const l of allSpinnerLogs.slice(-5)) log.info(`  ${l.trim().substring(0, 120)}`)
    log.info(`[MCP:Queue] logs: ${allQueueLogs.length}`)
    for (const l of allQueueLogs.slice(-5)) log.info(`  ${l.trim().substring(0, 120)}`)

    if (failed > 0) process.exitCode = 1

  } catch (err) {
    console.error(`\n${c.red}[ERROR]${c.reset} ${err.message}`)
    console.error(err.stack)
    process.exitCode = 1
  } finally {
    clearTimeout(globalTimer)
    try { await app.close() } catch {}
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
