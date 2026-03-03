/**
 * E2E Test: read_claude_history with last_n parameter (replaces watermark)
 *
 * Phase 0: Setup (Gemini launch, session, MCP port discovery)
 * Phase 1: Delegation — Gemini creates a Claude sub-agent that does a simple task
 * Phase 2: read_claude_history — Tests last_n=1 (default), last_n=0 (all), summary, with_code
 *
 * Validates:
 * - last_n=1 returns only last turn with "earlier turns omitted" message
 * - last_n=0 returns all turns
 * - detail=summary returns last response with thinking
 * - detail=with_code returns actions/diffs
 * - No watermark / deliveredTurns state (re-reading same turn returns same data)
 * - Logs show correct behavior
 *
 * [E2E+Gemini+Claude] — Requires: npx electron-vite build + gemini CLI + claude CLI
 * Hard kill: 480s (8 minutes)
 *
 * Run: node auto/sandbox/test-read-history-last-n.js 2>&1 | tee /tmp/test-read-history.log
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

// ─── Log Watcher ─────────────────────────────────────────────────────
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
    findAll(pattern) {
      return logs.filter(l => typeof pattern === 'string' ? l.includes(pattern) : pattern.test(l))
    },
    get position() { return cursor }
  }
}

// ═════════════════════════════════════════════════════════════════════
// MAIN TEST
// ═════════════════════════════════════════════════════════════════════
async function main() {
  const globalTimer = setTimeout(() => {
    console.error(`\n${c.red}[FATAL]${c.reset} Global timeout (480s). Force exit.`)
    process.exit(1)
  }, 480000)

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
    // Focus window
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

    // Create fresh tab
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
    assert(!!geminiTabId, `Gemini tab ID: ${geminiTabId}`)

    // Wait for Gemini session
    log.step('Waiting for Gemini session ID...')
    const geminiSessionId = await waitForGeminiSessionId(page, geminiTabId, 30000)
    assert(!!geminiSessionId, `Gemini session: ${geminiSessionId?.substring(0, 8)}...`)

    // Discover MCP port
    log.step('Discovering MCP port from logs...')
    const portLog = await logWatch.waitFor('[MCP:Server] HTTP server listening on port', 15000)
    const mcpPort = portLog ? parseInt(portLog.match(/port (\d+)/)?.[1]) : null
    assert(!!mcpPort, `MCP port: ${mcpPort}`)

    if (!mcpPort) throw new Error('No MCP port — cannot continue')

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: DELEGATION
    // ═══════════════════════════════════════════════════════════════════
    log.phase(1, 'DELEGATION')

    // Ask Gemini to delegate a task to Claude (simple: read package.json + summarize)
    log.step('Asking Gemini to delegate task to Claude...')
    await typeCommand(page, 'Use delegate_to_claude to create a Claude sub-agent with this exact prompt: "Read the file package.json and tell me the project name and version. Then list any 3 dependencies." Name the agent "test-history".')

    // Wait for delegation log
    log.step('Waiting for delegation...')
    const delegateLog = await logWatch.waitFor('[MCP:Delegate]', 60000)
    assert(!!delegateLog, `Delegation logged: ${delegateLog?.substring(0, 80)}`)

    // Wait for task to complete (Claude does work, spinner detection)
    log.step('Waiting for Claude to complete task...')
    const completeLog = await logWatch.waitFor('[MCP:Complete]', 180000, 1000)
    assert(!!completeLog, `Completion logged: ${completeLog?.substring(0, 80)}`)

    // Extract taskId from logs
    let taskId = null
    const taskLogs = logWatch.findAll('[MCP:Delegate]')
    for (const l of taskLogs) {
      const m = l.match(/taskId[=:]?\s*([a-f0-9-]{36})/i)
      if (m) { taskId = m[1]; break }
    }
    if (!taskId) {
      // Fallback: find in sub-agents
      try {
        const agents = await httpGet(mcpPort, `/sub-agents?ppid=0`)
        if (agents.agents?.length > 0) {
          taskId = agents.agents[0].taskId
          log.info(`TaskId from sub-agents: ${taskId}`)
        }
      } catch {}
    }
    assert(!!taskId, `Task ID: ${taskId}`)

    if (!taskId) throw new Error('No taskId — cannot test history')

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: READ_CLAUDE_HISTORY TESTS
    // ═══════════════════════════════════════════════════════════════════
    log.phase(2, 'READ_CLAUDE_HISTORY TESTS')

    // 2a. Default: last_n=1 — should return only last turn
    log.step('2a. last_n=1 (default — last turn only)...')
    try {
      const hist1 = await httpGet(mcpPort, `/claude-history/${taskId}?last_n=1`)
      log.info(`last_n=1: totalTurns=${hist1.totalTurns}, lastN=${hist1.lastN}, content length=${hist1.content?.length}`)
      assert(hist1.totalTurns >= 1, `totalTurns >= 1: ${hist1.totalTurns}`)
      assert(hist1.lastN === 1, `lastN in response === 1: ${hist1.lastN}`)
      if (hist1.totalTurns > 1) {
        assert(hist1.content?.includes('earlier turns omitted'), `Content says "earlier turns omitted"`)
      }
      assert(hist1.content?.includes('CLAUDE:'), `Content has CLAUDE: marker`)
      assert(!hist1.newTurns && hist1.newTurns !== 0, `No newTurns field (watermark removed): ${hist1.newTurns}`)
    } catch (e) {
      log.fail(`last_n=1 failed: ${e.message}`)
      failed++
    }

    // 2b. last_n=0 — all turns
    log.step('2b. last_n=0 (all turns)...')
    let allTotalTurns = 0
    try {
      const histAll = await httpGet(mcpPort, `/claude-history/${taskId}?last_n=0`)
      log.info(`last_n=0: totalTurns=${histAll.totalTurns}, lastN=${histAll.lastN}, content length=${histAll.content?.length}`)
      allTotalTurns = histAll.totalTurns || 0
      assert(histAll.totalTurns >= 1, `totalTurns >= 1: ${histAll.totalTurns}`)
      assert(histAll.lastN === 0, `lastN in response === 0: ${histAll.lastN}`)
      assert(histAll.content?.includes('USER:'), `Content has USER: markers`)
      assert(histAll.content?.includes('CLAUDE:'), `Content has CLAUDE: markers`)
      assert(histAll.content?.includes('--- Turn 1/'), `Content has Turn 1 header`)
      // No "earlier turns omitted" since we're getting all
      if (histAll.totalTurns > 0) {
        assert(!histAll.content?.includes('earlier turns omitted'), `No "earlier turns omitted" for all turns`)
      }
    } catch (e) {
      log.fail(`last_n=0 failed: ${e.message}`)
      failed++
    }

    // 2c. detail=summary — last response only
    log.step('2c. detail=summary...')
    try {
      const histSummary = await httpGet(mcpPort, `/claude-history/${taskId}?detail=summary`)
      log.info(`summary: totalTurns=${histSummary.totalTurns}, content length=${histSummary.content?.length}`)
      assert(histSummary.content?.includes('## Response'), `Summary has "## Response" section`)
      assert(histSummary.totalTurns >= 1, `Summary totalTurns >= 1: ${histSummary.totalTurns}`)
    } catch (e) {
      log.fail(`summary failed: ${e.message}`)
      failed++
    }

    // 2d. detail=with_code — includes tool actions
    log.step('2d. detail=with_code, last_n=1...')
    try {
      const histCode = await httpGet(mcpPort, `/claude-history/${taskId}?detail=with_code&last_n=1`)
      log.info(`with_code: totalTurns=${histCode.totalTurns}, content length=${histCode.content?.length}`)
      assert(histCode.totalTurns >= 1, `with_code totalTurns >= 1: ${histCode.totalTurns}`)
      // Claude was asked to read package.json — should have at least one action
      const hasActions = histCode.content?.includes('Actions:')
      softAssert(hasActions, `with_code has Actions section`)
    } catch (e) {
      log.fail(`with_code failed: ${e.message}`)
      failed++
    }

    // 2e. STATELESS: Re-read same turn — should return same data (no watermark advancing)
    log.step('2e. Stateless check: re-read last_n=1 twice, same result...')
    try {
      const read1 = await httpGet(mcpPort, `/claude-history/${taskId}?last_n=1&detail=full`)
      const read2 = await httpGet(mcpPort, `/claude-history/${taskId}?last_n=1&detail=full`)
      assert(read1.totalTurns === read2.totalTurns, `Same totalTurns: ${read1.totalTurns} === ${read2.totalTurns}`)
      assert(read1.content === read2.content, `Same content (stateless, no watermark): ${read1.content?.length} chars`)
    } catch (e) {
      log.fail(`Stateless check failed: ${e.message}`)
      failed++
    }

    // 2f. Re-read with different detail (the exact scenario that watermark broke)
    log.step('2f. Re-read same turn: summary → with_code (watermark bug scenario)...')
    try {
      const readSummary = await httpGet(mcpPort, `/claude-history/${taskId}?detail=summary`)
      const readCode = await httpGet(mcpPort, `/claude-history/${taskId}?detail=with_code&last_n=1`)
      assert(!!readSummary.content && readSummary.content.length > 10, `Summary returned content: ${readSummary.content?.length} chars`)
      assert(!!readCode.content && readCode.content.length > 10, `with_code returned content after summary: ${readCode.content?.length} chars`)
      // The key check: with_code should NOT say "no new turns" (that was the watermark bug)
      assert(!readCode.content?.includes('No new turns'), `with_code does NOT say "No new turns" (watermark bug fixed)`)
    } catch (e) {
      log.fail(`Re-read scenario failed: ${e.message}`)
      failed++
    }

    // 2g. last_n=3 — bounded read
    log.step('2g. last_n=3 (bounded)...')
    try {
      const hist3 = await httpGet(mcpPort, `/claude-history/${taskId}?last_n=3`)
      log.info(`last_n=3: totalTurns=${hist3.totalTurns}, lastN=${hist3.lastN}, content length=${hist3.content?.length}`)
      assert(hist3.lastN === 3, `lastN in response === 3: ${hist3.lastN}`)
      // If total turns > 3, should have "earlier turns omitted"
      if (hist3.totalTurns > 3) {
        assert(hist3.content?.includes('earlier turns omitted'), `Bounded read shows omission note`)
      }
    } catch (e) {
      log.fail(`last_n=3 failed: ${e.message}`)
      failed++
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: LOG VERIFICATION
    // ═══════════════════════════════════════════════════════════════════
    log.phase(3, 'LOG VERIFICATION')

    // Check that no deliveredTurns or watermark references appear in logs
    const watermarkLogs = logWatch.findAll('deliveredTurns')
    assert(watermarkLogs.length === 0, `No "deliveredTurns" in logs (${watermarkLogs.length} found)`)

    // Check mcp_task_id persistence
    const migrationLogs = logWatch.findAll('mcp_task_id')
    log.info(`mcp_task_id migration logs: ${migrationLogs.length}`)

    // Check sub-agents list works
    log.step('Verifying list_sub_agents...')
    try {
      // Use gemini tab's PID for proper discovery — for test just check via HTTP
      const agentList = await httpGet(mcpPort, `/sub-agents?ppid=0`)
      log.info(`Sub-agents: ${JSON.stringify(agentList.agents?.map(a => ({ id: a.taskId?.substring(0, 8), name: a.name, status: a.status })))}`)
      // At least one agent should exist (the one we just created)
      softAssert(agentList.agents?.length >= 1, `At least 1 sub-agent in list`)
    } catch (e) {
      log.warn(`Sub-agents check failed: ${e.message}`)
    }

    // ═══════════════════════════════════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══════════════════════════════════════════════════════════${c.reset}`)
    console.log(`${c.green}  PASSED: ${passed}${c.reset}`)
    if (warned > 0) console.log(`${c.yellow}  WARNED: ${warned}${c.reset}`)
    if (failed > 0) console.log(`${c.red}  FAILED: ${failed}${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════════════════════════${c.reset}`)

    clearTimeout(globalTimer)
    await app.close().catch(() => {})
    process.exit(failed > 0 ? 1 : 0)

  } catch (e) {
    console.error(`\n${c.red}[FATAL]${c.reset} ${e.message}`)
    console.error(e.stack)
    clearTimeout(globalTimer)
    await app.close().catch(() => {})
    process.exit(1)
  }
}

main()
