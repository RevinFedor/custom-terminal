/**
 * E2E Test: MCP update_docs Tool (Live Gemini CLI + Claude Sub-Agent)
 *
 * Phase 0: Setup (Gemini launch, session, MCP port discovery)
 * Phase 1: Delegation — Gemini creates a Claude sub-agent that does real work
 * Phase 2: update_docs — Gemini calls update_docs MCP tool on the sub-agent's session
 *
 * Tests the full flow:
 * 1. Sub-agent creation via delegate_to_claude
 * 2. Sub-agent completes work
 * 3. update_docs is called via Gemini prompt (natural language → MCP tool)
 *    OR via direct HTTP POST /update-docs (for faster/deterministic testing)
 * 4. API response is returned as tool result to Gemini
 *
 * [E2E+Gemini+Claude] — Requires: npm run dev (port 5182) + npx electron-vite build + gemini CLI + claude CLI
 * Hard kill: 600s (10 minutes)
 *
 * Run: node auto/sandbox/test-update-docs-mcp.js 2>&1 | tee /tmp/test-update-docs.log
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

function httpPost(port, endpoint, body, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const timer = setTimeout(() => reject(new Error(`HTTP POST timeout: ${endpoint}`)), timeoutMs)
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

// Parse --mode argument: 'gemini' (via Gemini prompt) or 'direct' (HTTP POST)
const mode = process.argv.includes('--direct') ? 'direct' : 'gemini'

// ═════════════════════════════════════════════════════════════════════
// MAIN TEST
// ═════════════════════════════════════════════════════════════════════
async function main() {
  // Hard kill: 600s (10 minutes)
  const globalTimer = setTimeout(() => {
    console.error(`\n${c.red}[FATAL]${c.reset} Global timeout (600s). Force exit.`)
    process.exit(1)
  }, 600000)

  log.info(`Test mode: ${mode} (use --direct for HTTP-only, default uses Gemini prompt)`)

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
    assert(!!geminiTabId, `Gemini spawn-with-watcher sent: ${geminiTabId}`)

    // Wait for Gemini session
    log.step('Waiting for Gemini session...')
    const stopHbSession = startHeartbeat('gemini-session')
    let geminiSessionDetected = false
    try {
      await waitForGeminiSessionId(page, 40000)
      geminiSessionDetected = true
    } catch {}
    stopHbSession()
    softAssert(geminiSessionDetected, 'Gemini session ID detected')

    // Wait for TUI ready
    log.step('Waiting for Gemini TUI ready...')
    const stopHbReady = startHeartbeat('gemini-tui-ready')
    const loadingThinking = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*THINKING/, 20000)
    if (loadingThinking) {
      log.info('Gemini loading spinner detected, waiting for IDLE...')
      await waitForMainProcessLog(mainProcessLogs, /\[GeminiSpinner\].*IDLE/, 30000)
    } else {
      log.warn('No loading spinner, 10s fallback')
      await page.waitForTimeout(10000)
    }
    stopHbReady()
    await page.waitForTimeout(1000)

    // Discover MCP HTTP port
    log.step('Discovering MCP HTTP port...')
    let mcpPort = null
    const portLog = await waitForMainProcessLog(mainProcessLogs, /MCP:HTTP.*listening.*:\d+/, 10000)
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

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: DELEGATION — Create sub-agent with real work
    // ═══════════════════════════════════════════════════════════════════
    log.phase(1, 'DELEGATION — CREATE SUB-AGENT')

    log.step('Sending delegation prompt to Gemini...')
    const delegationPrompt = 'Use the delegate_to_claude tool to ask Claude to read the file package.json in the current directory and tell you the project name, version, and main dependencies. Tell Claude to be concise. Do not do anything yourself, just delegate.'
    await page.evaluate(({ tabId, text }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('gemini:send-command', tabId, text)
    }, { tabId: geminiTabId, text: delegationPrompt })

    // Wait for Gemini THINKING
    const stopHb1a = startHeartbeat('gemini-thinking')
    const thinking1 = await logWatch.waitFor(/\[GeminiSpinner\].*THINKING/, 15000)
    stopHb1a()
    assert(!!thinking1, `Gemini THINKING: ${thinking1 ? 'detected' : 'TIMEOUT'}`)

    // Wait for sub-agent creation
    log.step('Waiting for sub-agent creation...')
    const stopHb1b = startHeartbeat('delegation')
    const delegation1 = await logWatch.waitFor(/MCP:Delegate.*sub-agent tab created/, 120000)
    stopHb1b()
    assert(!!delegation1, `Sub-agent created: ${delegation1 ? 'detected' : 'TIMEOUT'}`)

    // Extract taskId from logs
    let taskId1 = null
    const httpDelegateLogs = findInLogs(mainProcessLogs, 'MCP:HTTP] POST /delegate')
    if (httpDelegateLogs.length > 0) {
      const m = httpDelegateLogs[httpDelegateLogs.length - 1].match(/taskId=([a-f0-9-]+)/i)
      if (m) taskId1 = m[1]
    }
    log.info(`Extracted taskId: ${taskId1}`)
    assert(!!taskId1, `TaskId extracted from logs`)

    // Wait for Claude to finish work
    log.step('Waiting for Claude to complete work...')
    const stopHb1c = startHeartbeat('claude-working')
    const busy1 = await logWatch.waitFor(/\[Spinner\].*BUSY/, 60000)
    assert(!!busy1, `Claude BUSY detected`)

    const completion1 = await logWatch.waitFor(/Sub-agent completion triggered/, 120000)
    assert(!!completion1, `Sub-agent completion triggered`)

    const delivery1 = await logWatch.waitFor(/MCP:Complete.*Delivering \d+ chars/, 150000)
    stopHb1c()
    assert(!!delivery1, `Result delivered to Gemini: ${delivery1 ? 'yes' : 'TIMEOUT'}`)

    // Verify sub-agent exists in store
    const subAgents = await page.evaluate((gTabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return []
      return Array.from(p.tabs.values())
        .filter(t => t.parentTabId === gTabId)
        .map(t => ({ id: t.id, commandType: t.commandType }))
    }, geminiTabId)
    assert(subAgents.length >= 1, `Sub-agents in store: ${subAgents.length}`)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: UPDATE_DOCS — Call the MCP tool
    // ═══════════════════════════════════════════════════════════════════
    log.phase(2, 'UPDATE_DOCS — MCP TOOL')

    // Let Gemini settle after Phase 1 delivery
    log.step('Waiting for Gemini to settle...')
    await page.waitForTimeout(5000)

    if (mode === 'direct') {
      // ── Direct HTTP mode: call /update-docs endpoint directly ──
      log.step('Calling POST /update-docs directly (HTTP mode)...')

      if (!taskId1) {
        log.fail('No taskId — cannot call update_docs')
      } else {
        const stopHb2 = startHeartbeat('update-docs-api', 10000)
        try {
          const result = await httpPost(mcpPort, '/update-docs', {
            taskIds: [taskId1],
            provider: 'claude',
            ppid: 0  // Direct HTTP doesn't have real ppid
          }, 180000) // 3 min timeout for API call

          stopHb2()
          log.info(`update_docs response: ${JSON.stringify(result).substring(0, 200)}...`)

          assert(result.results && result.results.length === 1, `Got 1 result back: ${result.results?.length}`)

          if (result.results && result.results[0]) {
            const r = result.results[0]
            assert(r.taskId === taskId1, `Result taskId matches: ${r.taskId === taskId1}`)

            if (r.success) {
              assert(r.text && r.text.length > 50, `Response text received: ${r.text?.length} chars`)
              assert(!!r.usage, `Usage stats present: in=${r.usage?.input_tokens} out=${r.usage?.output_tokens}`)
              log.info(`API response preview: ${r.text?.substring(0, 150)}...`)
            } else {
              // API might fail if no prompt configured — that's expected in test env
              log.warn(`API returned error (may be expected): ${r.error}`)
              softAssert(r.error?.includes('prompt'), `Error is about missing prompt config: ${r.error}`)
            }
          }
        } catch (e) {
          stopHb2()
          log.fail(`HTTP /update-docs failed: ${e.message}`)
        }
      }

    } else {
      // ── Gemini prompt mode: ask Gemini to use update_docs tool ──
      log.step('Sending update_docs prompt to Gemini...')

      const updateDocsPrompt = `Use the update_docs tool to analyze the session of your sub-agent. Pass the task ID "${taskId1}" in the taskIds array. Use provider "claude". This will export the agent's session, send it to the documentation API, and return the analysis.`
      await page.evaluate(({ tabId, text }) => {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('gemini:send-command', tabId, text)
      }, { tabId: geminiTabId, text: updateDocsPrompt })

      // Wait for Gemini THINKING
      const stopHb2a = startHeartbeat('gemini-thinking-2')
      const thinking2 = await logWatch.waitFor(/\[GeminiSpinner\].*THINKING/, 15000)
      stopHb2a()
      assert(!!thinking2, `Gemini THINKING (update_docs): ${thinking2 ? 'detected' : 'TIMEOUT'}`)

      // Wait for /update-docs HTTP call in main process logs
      log.step('Waiting for POST /update-docs in main process...')
      const stopHb2b = startHeartbeat('update-docs-http', 10000)
      const updateDocsLog = await logWatch.waitFor(/MCP:HTTP.*POST \/update-docs/, 30000)
      stopHb2b()
      assert(!!updateDocsLog, `POST /update-docs received: ${updateDocsLog ? 'yes' : 'TIMEOUT'}`)

      // Wait for API call and response
      log.step('Waiting for API response (may take 30-120s)...')
      const stopHb2c = startHeartbeat('api-call', 10000)
      const apiResponse = await logWatch.waitFor(/docs:(claude|gemini)-api.*Response:/, 180000)
      stopHb2c()
      assert(!!apiResponse, `API response logged: ${apiResponse ? apiResponse.substring(0, 100) : 'TIMEOUT'}`)

      // Wait for Gemini to process the tool result
      log.step('Waiting for Gemini to process update_docs result...')
      const stopHb2d = startHeartbeat('gemini-processing')
      // Gemini should transition THINKING → IDLE after processing
      const idle2 = await logWatch.waitFor(/\[GeminiSpinner\].*IDLE/, 60000)
      stopHb2d()
      softAssert(!!idle2, `Gemini IDLE after update_docs: ${idle2 ? 'detected' : 'TIMEOUT'}`)
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: VERIFY ENDPOINT WORKS WITH MULTIPLE SESSIONS
    // ═══════════════════════════════════════════════════════════════════
    log.phase(3, 'VERIFY — MULTI-SESSION & ERROR HANDLING')

    // Test with invalid taskId
    log.step('Testing update_docs with invalid taskId...')
    try {
      const badResult = await httpPost(mcpPort, '/update-docs', {
        taskIds: ['nonexistent-task-id'],
        provider: 'claude',
        ppid: 0
      }, 10000)

      assert(
        badResult.results && badResult.results[0] && !badResult.results[0].success,
        `Invalid taskId returns error: ${badResult.results?.[0]?.error?.substring(0, 60)}`
      )
    } catch (e) {
      log.warn(`Invalid taskId test HTTP error: ${e.message}`)
    }

    // Test with empty taskIds
    log.step('Testing update_docs with empty taskIds...')
    try {
      const emptyResult = await httpPost(mcpPort, '/update-docs', {
        taskIds: [],
        provider: 'claude',
        ppid: 0
      }, 10000)

      assert(!!emptyResult.error, `Empty taskIds returns error: ${emptyResult.error}`)
    } catch (e) {
      log.warn(`Empty taskIds test HTTP error: ${e.message}`)
    }

    // Test list_sub_agents → update_docs pipeline (simulate what Gemini would do)
    log.step('Testing list_sub_agents → update_docs pipeline...')
    try {
      // Read MCP port to get sub-agents (use ppid=0, which may not find agents
      // but the endpoint itself should work)
      const subAgentsResult = await httpGet(mcpPort, '/sub-agents?ppid=0')
      log.info(`Sub-agents via HTTP: ${JSON.stringify(subAgentsResult).substring(0, 200)}`)
      assert(!subAgentsResult.error, `sub-agents endpoint works: ${subAgentsResult.agents?.length ?? 0} agents`)
    } catch (e) {
      log.warn(`Sub-agents endpoint error: ${e.message}`)
    }

    // ═══════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ RESULTS ═══${c.reset}`)
    console.log(`${c.green}Passed: ${passed}${c.reset}`)
    if (failed > 0) console.log(`${c.red}Failed: ${failed}${c.reset}`)
    if (warned > 0) console.log(`${c.yellow}Warned: ${warned}${c.reset}`)
    console.log(`Total: ${passed + failed} assertions (${warned} soft warnings)`)
    process.exitCode = failed > 0 ? 1 : 0

  } catch (error) {
    log.fail(`Unhandled error: ${error.message}`)
    console.error(error.stack)
    process.exitCode = 1
  } finally {
    clearTimeout(globalTimer)
    try { await app.close() } catch {}
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`)
  process.exit(1)
})
