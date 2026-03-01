/**
 * E2E Test: Full Orchestration Chain (Live Gemini CLI + Claude Sub-Agent)
 *
 * Phase 0: Setup (Gemini launch, session, MCP port discovery)
 * Phase 1: Delegation via Gemini → Claude does real work (read package.json)
 * Phase 2: continue_claude follow-up (same session, extracted taskId)
 * Phase 3: Second delegation via Gemini → second sub-agent
 * Phase 4: Final assertions (deliveries, false completions, store state)
 * Phase 5: read_claude_history verification (watermark, from_beginning, summary, with_code, manual intervention)
 *
 * All delegations go through Gemini (correct ppid via process tree).
 * Direct HTTP is only used for continue_claude (uses taskId, not ppid).
 *
 * [E2E+Gemini+Claude] — Requires: npm run dev (port 5182) + npx electron-vite build + gemini CLI + claude CLI
 * Hard kill: 720s (12 minutes)
 *
 * Run: node auto/sandbox/test-orchestration-full.js 2>&1 | tee /tmp/test-orchestration-full.log
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const http = require('http')

// ─── Colors & Logging ───────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m',
  bold: '\x1b[1m'
}
const log = {
  step:  (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass:  (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail:  (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn:  (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info:  (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  phase: (n, m) => console.log(`\n${c.bold}${c.cyan}═══ PHASE ${n}: ${m} ═══${c.reset}`)
}

let passed = 0, failed = 0, warned = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}
function softAssert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.warn(msg + ' (soft)'); warned++ }
}

// ─── HTTP Helpers ───────────────────────────────────────────────────
function httpGet(port, endpoint) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP GET timeout: ${endpoint}`)), 10000)
    http.get(`http://127.0.0.1:${port}${endpoint}`, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        clearTimeout(timer)
        try { resolve(JSON.parse(text)) } catch { resolve({ raw: text }) }
      })
    }).on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

function httpPost(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const timer = setTimeout(() => reject(new Error(`HTTP POST timeout: ${endpoint}`)), 10000)
    const req = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        clearTimeout(timer)
        try { resolve(JSON.parse(text)) } catch { resolve({ raw: text }) }
      })
    })
    req.on('error', (e) => { clearTimeout(timer); reject(e) })
    req.write(data)
    req.end()
  })
}

// ─── Heartbeat ──────────────────────────────────────────────────────
function startHeartbeat(label, intervalMs = 5000) {
  let count = 0
  const timer = setInterval(() => {
    count++
    process.stdout.write(`${c.dim}  ...${label} ${count * (intervalMs / 1000)}s${c.reset}\n`)
  }, intervalMs)
  return () => clearInterval(timer)
}

// ─── Log Watcher with Advancing Cursor ──────────────────────────────
function createLogWatcher(logs) {
  let cursor = 0
  return {
    async waitFor(pattern, timeout = 30000, pollInterval = 300) {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        for (let i = cursor; i < logs.length; i++) {
          const match = typeof pattern === 'string'
            ? logs[i].includes(pattern)
            : pattern.test(logs[i])
          if (match) {
            cursor = i + 1
            return logs[i]
          }
        }
        await new Promise(r => setTimeout(r, pollInterval))
      }
      return null
    },
    get position() { return cursor }
  }
}

// ═════════════════════════════════════════════════════════════════════
// MAIN TEST
// ═════════════════════════════════════════════════════════════════════
async function main() {
  // Hard kill: 720s (12 minutes)
  const globalTimer = setTimeout(() => {
    console.error(`\n${c.red}[FATAL]${c.reset} Global timeout (720s). Force exit.`)
    process.exit(1)
  }, 720000)

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 0: SETUP
  // ═══════════════════════════════════════════════════════════════════
  log.phase(0, 'SETUP')
  log.step('Launching Electron app...')

  let { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: true,
    waitForReady: 4000
  })

  const logWatch = createLogWatcher(mainProcessLogs)

  try {
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

    // Ensure terminal is visible
    try {
      await waitForTerminal(page, 5000)
    } catch {
      log.info('Terminal not visible, creating tab via Cmd+T...')
      await page.keyboard.press('Meta+t')
      await page.waitForTimeout(2000)
      await waitForTerminal(page, 10000)
    }

    try {
      await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 })
    } catch { /* ok */ }

    // Create fresh tab (isolation from leftover state)
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

    // Spawn Gemini via IPC
    const geminiTabId = await page.evaluate(() => {
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
    assert(!!geminiTabId, `Gemini spawn-with-watcher sent: ${geminiTabId}`)

    // Wait for Gemini session detection (soft — may take longer than 40s)
    log.step('Waiting for Gemini session...')
    const stopHbSession = startHeartbeat('gemini-session')
    let geminiSessionDetected = false
    try {
      await waitForGeminiSessionId(page, 40000)
      geminiSessionDetected = true
    } catch {
      // Not critical — spinner detection proves Gemini is running
    }
    stopHbSession()
    softAssert(geminiSessionDetected, 'Gemini session ID detected in store')

    // Wait for TUI ready (loading spinner THINKING → IDLE)
    log.step('Waiting for Gemini TUI ready...')
    const stopHbReady = startHeartbeat('gemini-tui-ready')
    const loadingThinking = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*THINKING/, 20000)
    if (loadingThinking) {
      log.info('Gemini loading spinner detected, waiting for IDLE...')
      await waitForMainProcessLog(mainProcessLogs,
        /\[GeminiSpinner\].*IDLE/, 30000)
    } else {
      log.warn('No loading spinner detected, using 10s fallback')
      await page.waitForTimeout(10000)
    }
    stopHbReady()
    await page.waitForTimeout(1000)

    // Verify commandType (might be set after session detection or spinner)
    const geminiCommandType = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.tabs?.get?.(p?.activeTabId)?.commandType
    })
    softAssert(geminiCommandType === 'gemini', `commandType is 'gemini': ${geminiCommandType}`)

    // Discover MCP HTTP port
    log.step('Discovering MCP HTTP port...')
    let mcpPort = null
    const portLog = await waitForMainProcessLog(mainProcessLogs,
      /MCP:HTTP.*listening.*:\d+/, 10000)
    if (portLog) {
      const m = portLog.match(/:(\d+)/)
      if (m) mcpPort = parseInt(m[1])
    }
    if (!mcpPort) {
      try {
        mcpPort = await page.evaluate(() => {
          const fs = window.require('fs')
          const os = window.require('os')
          const path = window.require('path')
          const dir = path.join(os.homedir(), '.noted-terminal')
          try {
            const files = fs.readdirSync(dir).filter(f => f.startsWith('mcp-port'))
            for (const f of files) {
              const port = parseInt(fs.readFileSync(path.join(dir, f), 'utf-8').trim())
              if (port > 0) return port
            }
          } catch {}
          return null
        })
      } catch {}
    }
    assert(mcpPort && mcpPort > 0, `MCP HTTP port: ${mcpPort}`)

    if (!mcpPort) {
      log.fail('Cannot continue without MCP port — aborting')
      process.exitCode = 1
      return
    }

    // Record sub-agent count BEFORE our test creates any
    const subAgentsBefore = await page.evaluate((gTabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return 0
      return Array.from(p.tabs.values()).filter(t => t.parentTabId === gTabId).length
    }, geminiTabId)
    log.info(`Sub-agents parented to our Gemini tab before test: ${subAgentsBefore}`)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: FIRST DELEGATION VIA GEMINI
    // ═══════════════════════════════════════════════════════════════════
    log.phase(1, 'FIRST DELEGATION VIA GEMINI')

    log.step('Sending delegation prompt to Gemini...')
    const prompt1 = 'Use the delegate_to_claude tool to ask Claude to read the file package.json in the current directory and tell you the project name and version. Tell Claude to be brief and answer in one line. Do not do anything yourself, just delegate.'
    await page.evaluate(({ tabId, text }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('gemini:send-command', tabId, text)
    }, { tabId: geminiTabId, text: prompt1 })

    // Wait for Gemini THINKING
    const stopHb1a = startHeartbeat('gemini-thinking-1')
    const thinking1 = await logWatch.waitFor(/\[GeminiSpinner\].*THINKING/, 15000)
    stopHb1a()
    assert(!!thinking1, `Gemini THINKING (1st): ${thinking1 ? 'detected' : 'TIMEOUT'}`)

    // Wait for sub-agent creation
    log.step('Waiting for sub-agent creation...')
    const stopHb1b = startHeartbeat('delegation-1')
    const delegation1 = await logWatch.waitFor(/MCP:Delegate.*sub-agent tab created/, 120000)
    stopHb1b()
    assert(!!delegation1, `Sub-agent 1 created: ${delegation1 ? 'detected' : 'TIMEOUT'}`)

    // Extract taskId from MCP:HTTP log
    let taskId1 = null
    const httpDelegateLogs = findInLogs(mainProcessLogs, 'MCP:HTTP] POST /delegate')
    if (httpDelegateLogs.length > 0) {
      const m = httpDelegateLogs[httpDelegateLogs.length - 1].match(/taskId=([a-f0-9-]+)/i)
      if (m) taskId1 = m[1]
    }
    log.info(`Extracted taskId from logs: ${taskId1}`)

    // Wait for Claude BUSY
    log.step('Waiting for Claude BUSY (1st)...')
    const stopHb1c = startHeartbeat('claude-busy-1')
    const busy1 = await logWatch.waitFor(/\[Spinner\].*BUSY/, 60000)
    stopHb1c()
    assert(!!busy1, `Claude BUSY (1st): ${busy1 ? 'detected' : 'TIMEOUT'}`)

    // Wait for sub-agent completion triggered (Spinner IDLE → completion logic starts)
    log.step('Waiting for sub-agent completion (Spinner IDLE)...')
    const stopHb1d = startHeartbeat('completion-1')
    const completion1 = await logWatch.waitFor(/Sub-agent completion triggered/, 120000)
    stopHb1d()
    assert(!!completion1, `Sub-agent completion triggered (1st): ${completion1 ? 'detected' : 'TIMEOUT'}`)

    // Wait for actual delivery to Gemini
    // Log pattern: [MCP:Complete] Delivering X chars to Gemini tab Y
    log.step('Waiting for delivery to Gemini (1st)...')
    const stopHb1e = startHeartbeat('delivery-1')
    const delivery1 = await logWatch.waitFor(/MCP:Complete.*Delivering \d+ chars/, 150000)
    stopHb1e()
    assert(!!delivery1, `Delivery 1: ${delivery1 ? delivery1.replace(/.*Delivering/, 'Delivering').trim().substring(0, 80) : 'TIMEOUT (JSONL guard may not find turn_duration)'}`)

    // Verify store state — only count sub-agents parented to OUR gemini tab
    log.step('Verifying store state after Phase 1...')
    await page.waitForTimeout(2000)

    const phase1SubAgents = await page.evaluate((gTabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return []
      return Array.from(p.tabs.values())
        .filter(t => t.parentTabId === gTabId)
        .map(t => ({ id: t.id, commandType: t.commandType, status: t.claudeAgentStatus }))
    }, geminiTabId)
    assert(phase1SubAgents.length >= 1, `Sub-agents parented to our Gemini: ${phase1SubAgents.length}`)
    if (phase1SubAgents.length > 0) {
      assert(phase1SubAgents[0].commandType === 'claude', `Sub-agent commandType: ${phase1SubAgents[0].commandType}`)
    }

    // Check for false completions (guard falling back to "no activity signals")
    const falseCompletions1 = findInLogs(mainProcessLogs, 'passed (no activity')
    assert(falseCompletions1.length === 0, `No false completions: ${falseCompletions1.length}`)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: CONTINUE_CLAUDE FOLLOW-UP
    // ═══════════════════════════════════════════════════════════════════
    log.phase(2, 'CONTINUE_CLAUDE FOLLOW-UP')

    if (!taskId1) {
      log.warn('Skipping Phase 2 — no taskId extracted from Phase 1')
    } else {
      log.step('Sending continue_claude via HTTP /continue...')
      try {
        const continueResult = await httpPost(mcpPort, '/continue', {
          taskId: taskId1,
          prompt: 'Now tell me the version from package.json. One line only.',
          ppid: 0
        })
        log.info(`Continue response: ${JSON.stringify(continueResult).substring(0, 100)}`)
      } catch (e) {
        log.fail(`HTTP /continue failed: ${e.message}`)
      }

      // Wait for MCP:Continue log
      const continueLog = await logWatch.waitFor(/MCP:Continue/, 10000)
      assert(!!continueLog, `MCP:Continue log: ${continueLog ? 'detected' : 'TIMEOUT'}`)

      // Wait for Claude BUSY (2nd)
      log.step('Waiting for Claude BUSY (2nd)...')
      const stopHb2a = startHeartbeat('claude-busy-2')
      const busy2 = await logWatch.waitFor(/\[Spinner\].*BUSY/, 60000)
      stopHb2a()
      assert(!!busy2, `Claude BUSY (2nd): ${busy2 ? 'detected' : 'TIMEOUT'}`)

      // Wait for completion triggered (2nd)
      log.step('Waiting for sub-agent completion (2nd)...')
      const stopHb2b = startHeartbeat('completion-2')
      const completion2 = await logWatch.waitFor(/Sub-agent completion triggered/, 120000)
      stopHb2b()
      assert(!!completion2, `Sub-agent completion triggered (2nd): ${completion2 ? 'detected' : 'TIMEOUT'}`)

      // Wait for delivery (2nd)
      log.step('Waiting for delivery (2nd)...')
      const stopHb2c = startHeartbeat('delivery-2')
      const delivery2 = await logWatch.waitFor(/MCP:Complete.*Delivering \d+ chars/, 150000)
      stopHb2c()
      assert(!!delivery2, `Delivery 2: ${delivery2 ? 'detected' : 'TIMEOUT'}`)

      // Verify watermark via read_claude_history HTTP
      log.step('Verifying watermark (read_claude_history)...')
      try {
        const history = await httpGet(mcpPort, `/claude-history/${taskId1}?from_beginning=true`)
        log.info(`History: totalTurns=${history.totalTurns}, new=${history.new}`)
        softAssert(history.totalTurns >= 2, `totalTurns >= 2: ${history.totalTurns}`)
      } catch (e) {
        log.warn(`History check failed: ${e.message}`)
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: SECOND DELEGATION VIA GEMINI
    // ═══════════════════════════════════════════════════════════════════
    log.phase(3, 'SECOND DELEGATION VIA GEMINI')

    // Settle time — let Gemini process Phase 1-2 deliveries
    log.step('Waiting for Gemini to settle...')
    await page.waitForTimeout(5000)

    log.step('Sending second delegation prompt to Gemini...')
    const prompt3 = 'Use the delegate_to_claude tool to ask Claude to say the word PAPAYA and nothing else. Do not do anything yourself, just delegate.'
    await page.evaluate(({ tabId, text }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('gemini:send-command', tabId, text)
    }, { tabId: geminiTabId, text: prompt3 })

    // Wait for Gemini THINKING
    const stopHb3a = startHeartbeat('gemini-thinking-3')
    const thinking3 = await logWatch.waitFor(/\[GeminiSpinner\].*THINKING/, 15000)
    stopHb3a()
    assert(!!thinking3, `Gemini THINKING (Phase 3): ${thinking3 ? 'detected' : 'TIMEOUT'}`)

    // Wait for SECOND sub-agent creation (we need delegation #2 specifically)
    log.step('Waiting for second sub-agent creation...')
    const stopHb3b = startHeartbeat('delegation-3')
    const delegation3 = await logWatch.waitFor(/MCP:Delegate.*sub-agent tab created/, 120000)
    stopHb3b()
    assert(!!delegation3, `Sub-agent 2 created: ${delegation3 ? 'detected' : 'TIMEOUT'}`)

    // Wait for completion + delivery
    log.step('Waiting for completion & delivery (3rd)...')
    const stopHb3c = startHeartbeat('completion-3')
    const completion3 = await logWatch.waitFor(/Sub-agent completion triggered/, 120000)
    assert(!!completion3, `Sub-agent completion triggered (3rd): ${completion3 ? 'detected' : 'TIMEOUT'}`)
    const delivery3 = await logWatch.waitFor(/MCP:Complete.*Delivering \d+ chars/, 150000)
    stopHb3c()
    assert(!!delivery3, `Delivery 3: ${delivery3 ? 'detected' : 'TIMEOUT'}`)

    // Verify 2+ sub-agents parented to our Gemini tab
    log.step('Verifying sub-agents in store...')
    await page.waitForTimeout(2000)

    const phase3SubAgents = await page.evaluate((gTabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return []
      return Array.from(p.tabs.values())
        .filter(t => t.parentTabId === gTabId)
        .map(t => ({ id: t.id, commandType: t.commandType }))
    }, geminiTabId)
    assert(phase3SubAgents.length >= 2, `2+ sub-agents parented to our Gemini: ${phase3SubAgents.length}`)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 4: FINAL ASSERTIONS
    // ═══════════════════════════════════════════════════════════════════
    log.phase(4, 'FINAL ASSERTIONS')

    // Count deliveries (successful delivery log pattern)
    const totalDeliveries = findInLogs(mainProcessLogs, 'Delivering').filter(l => l.includes('chars to Gemini'))
    log.info(`Total successful deliveries: ${totalDeliveries.length}`)
    // With continue, we expect 3 (Phase 1 + Phase 2 + Phase 3). Soft assert because JSONL guard timing varies.
    softAssert(totalDeliveries.length >= 2, `Deliveries >= 2: ${totalDeliveries.length}`)
    softAssert(totalDeliveries.length === 3, `Deliveries === 3: ${totalDeliveries.length}`)

    // No false completions (old guard pattern: "passed (no activity signals)")
    const totalFalseCompletions = findInLogs(mainProcessLogs, 'passed (no activity')
    assert(totalFalseCompletions.length === 0, `No false completions: ${totalFalseCompletions.length}`)

    // SubAgentBar visible in DOM
    const subAgentBarVisible = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div')
      for (const div of allDivs) {
        if (div.textContent?.includes('Sub-agents:') || div.textContent?.includes('Claude #')) {
          return true
        }
      }
      return false
    })
    assert(subAgentBarVisible, 'SubAgentBar visible in DOM')

    // Task status check
    if (taskId1) {
      log.step('Checking task status...')
      try {
        const status1 = await httpGet(mcpPort, `/status/${taskId1}`)
        log.info(`Task 1 (${taskId1}): status=${status1.status}`)
        softAssert(status1.status === 'completed', `Task 1 status: ${status1.status}`)
      } catch (e) {
        log.warn(`Task status check failed: ${e.message}`)
      }
    }

    // Verify sub-agents use correct project
    const projectCheck = await page.evaluate((gTabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return null
      const ours = Array.from(p.tabs.values()).filter(t => t.parentTabId === gTabId)
      return { projectId: s.activeProjectId, count: ours.length }
    }, geminiTabId)
    assert(projectCheck?.count >= 2, `${projectCheck?.count ?? 0} sub-agents in project ${projectCheck?.projectId}`)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 5: READ_CLAUDE_HISTORY VERIFICATION
    // ═══════════════════════════════════════════════════════════════════
    log.phase(5, 'READ_CLAUDE_HISTORY VERIFICATION')

    if (!taskId1) {
      log.warn('Skipping Phase 5 — no taskId from Phase 1')
    } else {
      // 5a. Incremental read (post-delivery) — watermark at totalTurns, expect 0 new
      log.step('5a. Incremental read (post-delivery)...')
      try {
        const histIncr = await httpGet(mcpPort, `/claude-history/${taskId1}`)
        log.info(`Incremental: totalTurns=${histIncr.totalTurns}, newTurns=${histIncr.newTurns}`)
        assert(histIncr.totalTurns !== undefined, `totalTurns is defined: ${histIncr.totalTurns}`)
        assert(histIncr.newTurns === 0, `Post-delivery newTurns === 0: ${histIncr.newTurns}`)
        assert(histIncr.content?.includes('No new turns'), `Content says "No new turns"`)
      } catch (e) {
        log.fail(`Incremental read failed: ${e.message}`)
        failed++
      }

      // 5b. Full history (from_beginning=true) — all turns with content
      log.step('5b. Full history (from_beginning=true)...')
      let fullTotalTurns = 0
      try {
        const histFull = await httpGet(mcpPort, `/claude-history/${taskId1}?from_beginning=true`)
        log.info(`Full: totalTurns=${histFull.totalTurns}, newTurns=${histFull.newTurns}, content length=${histFull.content?.length}`)
        fullTotalTurns = histFull.totalTurns || 0
        assert(histFull.totalTurns >= 2, `Full totalTurns >= 2: ${histFull.totalTurns}`)
        assert(histFull.content?.length > 50, `Content has substance (${histFull.content?.length} chars)`)
        assert(histFull.content?.includes('USER:'), `Content has USER: markers`)
        assert(histFull.content?.includes('CLAUDE:'), `Content has CLAUDE: markers`)
        assert(histFull.content?.includes('--- Turn 1/'), `Content has Turn 1 header`)
      } catch (e) {
        log.fail(`Full history read failed: ${e.message}`)
        failed++
      }

      // 5c. Summary mode — should return last assistant response
      log.step('5c. Summary mode (detail=summary)...')
      try {
        const histSummary = await httpGet(mcpPort, `/claude-history/${taskId1}?detail=summary&from_beginning=true`)
        log.info(`Summary: totalTurns=${histSummary.totalTurns}, content length=${histSummary.content?.length}`)
        assert(histSummary.content?.includes('## Response'), `Summary has "## Response" section`)
        assert(histSummary.totalTurns >= 2, `Summary totalTurns >= 2: ${histSummary.totalTurns}`)
      } catch (e) {
        log.fail(`Summary read failed: ${e.message}`)
        failed++
      }

      // 5d. with_code mode — should include tool action details
      log.step('5d. with_code mode (detail=with_code)...')
      try {
        const histCode = await httpGet(mcpPort, `/claude-history/${taskId1}?detail=with_code&from_beginning=true`)
        log.info(`with_code: totalTurns=${histCode.totalTurns}, content length=${histCode.content?.length}`)
        assert(histCode.totalTurns >= 2, `with_code totalTurns >= 2: ${histCode.totalTurns}`)
        // Claude was asked to read package.json — should have at least one action
        const hasActions = histCode.content?.includes('Actions:')
        softAssert(hasActions, `with_code has Actions section`)
        // Check if Read tool label is shown (includeReading=false, but label still appears)
        const hasReadLabel = histCode.content?.includes('Чтение') || histCode.content?.includes('📄')
        softAssert(hasReadLabel, `with_code shows Read tool label`)
      } catch (e) {
        log.fail(`with_code read failed: ${e.message}`)
        failed++
      }

      // 5e. Manual intervention — write directly to Claude sub-agent tab, then read
      log.step('5e. Manual intervention test...')
      const subAgent1TabId = await page.evaluate((gTabId) => {
        const s = window.useWorkspaceStore?.getState?.()
        const p = s?.openProjects?.get?.(s?.activeProjectId)
        if (!p) return null
        const subs = Array.from(p.tabs.values()).filter(t => t.parentTabId === gTabId)
        return subs.length > 0 ? subs[0].id : null
      }, geminiTabId)

      if (!subAgent1TabId) {
        log.warn('No sub-agent tab found, skipping manual intervention test')
      } else {
        log.info(`Sub-agent 1 tab ID: ${subAgent1TabId}`)

        // Send a simple message to Claude via safePasteAndSubmit (bracketed paste)
        // Claude Code Ink TUI requires bracketed paste — raw term.write() is collapsed
        await page.evaluate(async ({ tabId, content }) => {
          const { ipcRenderer } = window.require('electron')
          await ipcRenderer.invoke('terminal:paste', { tabId, content, submit: true })
        }, { tabId: subAgent1TabId, content: 'What is 2+2? Answer with just the number, nothing else.' })

        // Wait for Claude BUSY (processing the manual message)
        log.step('Waiting for Claude BUSY (manual)...')
        const stopHb5a = startHeartbeat('claude-busy-manual')
        const busyManual = await logWatch.waitFor(/\[Spinner\].*BUSY/, 30000)
        stopHb5a()
        softAssert(!!busyManual, `Claude BUSY (manual): ${busyManual ? 'detected' : 'TIMEOUT'}`)

        // Wait for Claude IDLE (finished processing)
        log.step('Waiting for Claude IDLE (manual)...')
        const stopHb5b = startHeartbeat('claude-idle-manual')
        const idleManual = await logWatch.waitFor(/\[Spinner\].*IDLE/, 60000)
        stopHb5b()
        assert(!!idleManual, `Claude IDLE (manual): ${idleManual ? 'detected' : 'TIMEOUT'}`)

        // Wait for JSONL flush (Claude writes entries in real-time, but small buffer delay)
        await page.waitForTimeout(3000)

        // Incremental read — should have new turns from manual intervention
        log.step('5e. Reading history after manual intervention...')
        try {
          const histManual = await httpGet(mcpPort, `/claude-history/${taskId1}`)
          log.info(`Manual: totalTurns=${histManual.totalTurns}, newTurns=${histManual.newTurns}`)
          log.info(`Manual content preview: ${histManual.content?.substring(0, 200)}`)
          assert(histManual.newTurns >= 1, `Manual intervention newTurns >= 1: ${histManual.newTurns}`)
          assert(histManual.totalTurns > fullTotalTurns, `totalTurns increased: ${histManual.totalTurns} > ${fullTotalTurns}`)
          // Verify content contains the question or answer
          const hasManualContent = histManual.content?.includes('2+2') ||
            histManual.content?.includes('2 + 2') || histManual.content?.includes('4')
          softAssert(hasManualContent, `Manual content mentions 2+2 or 4`)
        } catch (e) {
          log.fail(`Manual intervention read failed: ${e.message}`)
          failed++
        }

        // 5f. Full history after manual — should include ALL turns
        log.step('5f. Full history after manual intervention...')
        try {
          const histFullAfter = await httpGet(mcpPort, `/claude-history/${taskId1}?from_beginning=true`)
          log.info(`Full after manual: totalTurns=${histFullAfter.totalTurns}`)
          assert(histFullAfter.totalTurns > fullTotalTurns,
            `Total turns grew after manual: ${histFullAfter.totalTurns} > ${fullTotalTurns}`)
          // Verify full history contains both original and manual content
          assert(histFullAfter.content?.includes('--- Turn 1/'), `Full history still has Turn 1`)
        } catch (e) {
          log.fail(`Full history after manual failed: ${e.message}`)
          failed++
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n${'═'.repeat(50)}`)
    console.log(`${c.bold}Passed: ${passed}  Failed: ${failed}  Warned: ${warned}${c.reset}`)
    console.log(`${'═'.repeat(50)}`)

    // Log summary
    log.info('\n--- LOG SUMMARY ---')
    const geminiSpinnerLogs = findInLogs(mainProcessLogs, 'GeminiSpinner')
    const claudeSpinnerLogs = findInLogs(mainProcessLogs, '[Spinner]')
    const mcpLogs = findInLogs(mainProcessLogs, 'MCP:')
    const handshakeLogs = findInLogs(mainProcessLogs, 'Handshake')
    const completionLogs = findInLogs(mainProcessLogs, 'Sub-agent completion triggered')
    log.info(`GeminiSpinner logs: ${geminiSpinnerLogs.length}`)
    log.info(`Claude Spinner logs: ${claudeSpinnerLogs.length}`)
    log.info(`MCP logs: ${mcpLogs.length}`)
    log.info(`Handshake logs: ${handshakeLogs.length}`)
    log.info(`Completion triggered: ${completionLogs.length}`)
    log.info(`Deliveries: ${totalDeliveries.length}`)
    log.info(`False completions: ${totalFalseCompletions.length}`)

    // Dump last 5 MCP logs for diagnostics
    const lastMcp = mcpLogs.slice(-5)
    for (const l of lastMcp) {
      log.info(`  ${l.replace(/\x1b\[[0-9;]*m/g, '').trim().substring(0, 120)}`)
    }

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
