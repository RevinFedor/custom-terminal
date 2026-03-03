/**
 * E2E Test: MCP update_docs with MULTIPLE sessions (2 sub-agents, different content)
 *
 * Phase 0: Setup (Gemini, MCP port)
 * Phase 1: Create sub-agent #1 — reads package.json (project name/version)
 * Phase 2: Create sub-agent #2 — reads CLAUDE.md (project overview)
 * Phase 3: Call update_docs with BOTH taskIds, verify distinct results
 *
 * [E2E+Gemini+Claude] — Requires: npm run dev + electron-vite build + gemini + claude
 * Hard kill: 720s
 *
 * Run: node auto/sandbox/test-update-docs-multi.js 2>&1 | tee /tmp/test-update-docs-multi.log
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const http = require('http')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
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
  if (cond) { log.pass(msg); passed++ } else { log.fail(msg); failed++ }
}
function softAssert(cond, msg) {
  if (cond) { log.pass(msg); passed++ } else { log.warn(msg + ' (soft)'); warned++ }
}

function httpGet(port, endpoint) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GET timeout: ${endpoint}`)), 10000)
    http.get(`http://127.0.0.1:${port}${endpoint}`, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(text)) } catch { resolve({ raw: text }) } })
    }).on('error', e => { clearTimeout(timer); reject(e) })
  })
}

function httpPost(port, endpoint, body, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const timer = setTimeout(() => reject(new Error(`POST timeout: ${endpoint}`)), timeoutMs)
    const req = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(text)) } catch { resolve({ raw: text }) } })
    })
    req.on('error', e => { clearTimeout(timer); reject(e) })
    req.write(data); req.end()
  })
}

function startHeartbeat(label, ms = 5000) {
  let n = 0
  const t = setInterval(() => { n++; process.stdout.write(`${c.dim}  ...${label} ${n * (ms / 1000)}s${c.reset}\n`) }, ms)
  return () => clearInterval(t)
}

function createLogWatcher(logs) {
  let cursor = 0
  return {
    async waitFor(pattern, timeout = 30000, poll = 300) {
      const start = Date.now()
      while (Date.now() - start < timeout) {
        for (let i = cursor; i < logs.length; i++) {
          if (typeof pattern === 'string' ? logs[i].includes(pattern) : pattern.test(logs[i])) {
            cursor = i + 1; return logs[i]
          }
        }
        await new Promise(r => setTimeout(r, poll))
      }
      return null
    }
  }
}

async function main() {
  const globalTimer = setTimeout(() => { console.error(`\n${c.red}[FATAL]${c.reset} Global timeout 720s`); process.exit(1) }, 720000)

  log.phase(0, 'SETUP')
  log.step('Launching Electron...')

  let { app, page, consoleLogs, mainProcessLogs } = await launch({ logMainProcess: true, waitForReady: 4000 })
  const logWatch = createLogWatcher(mainProcessLogs)

  try {
    for (let i = 0; i < 3; i++) {
      try { await electron.focusWindow(app); break } catch {
        await page.waitForTimeout(2000)
        const wins = await app.windows()
        for (const w of wins) { if (!(await w.url()).includes('devtools://')) { page = w; break } }
      }
    }

    try { await waitForTerminal(page, 5000) } catch {
      await page.keyboard.press('Meta+t'); await page.waitForTimeout(2000); await waitForTerminal(page, 10000)
    }
    try { await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 }) } catch {}

    // Fresh tab
    const tabsBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.(); return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.(); return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabsBefore, { timeout: 5000 })
    await page.waitForTimeout(1000)

    await typeCommand(page, 'cd ~/Desktop/custom-terminal')
    await page.waitForTimeout(1500)

    // Spawn Gemini
    const geminiTabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tabId = p?.activeTabId
      if (tabId) { const { ipcRenderer } = window.require('electron'); ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd: '/Users/fedor/Desktop/custom-terminal' }) }
      return tabId
    })
    assert(!!geminiTabId, `Gemini spawned: ${geminiTabId}`)

    const stopS = startHeartbeat('gemini-session')
    try { await waitForGeminiSessionId(page, 40000) } catch {}
    stopS()

    const stopR = startHeartbeat('gemini-ready')
    const lt = await waitForMainProcessLog(mainProcessLogs, /\[GeminiSpinner\].*THINKING/, 20000)
    if (lt) { await waitForMainProcessLog(mainProcessLogs, /\[GeminiSpinner\].*IDLE/, 30000) }
    else { await page.waitForTimeout(10000) }
    stopR()
    await page.waitForTimeout(1000)

    // MCP port
    let mcpPort = null
    const portLog = await waitForMainProcessLog(mainProcessLogs, /MCP:HTTP.*listening.*:\d+/, 10000)
    if (portLog) { const m = portLog.match(/:(\d+)/); if (m) mcpPort = parseInt(m[1]) }
    if (!mcpPort) {
      try { mcpPort = await page.evaluate(() => {
        const fs = window.require('fs'), os = window.require('os'), path = window.require('path')
        const dir = path.join(os.homedir(), '.noted-terminal')
        try { const files = fs.readdirSync(dir).filter(f => f.startsWith('mcp-port'))
          for (const f of files) { const p = parseInt(fs.readFileSync(path.join(dir, f), 'utf-8').trim()); if (p > 0) return p }
        } catch {}; return null
      }) } catch {}
    }
    assert(mcpPort > 0, `MCP port: ${mcpPort}`)
    if (!mcpPort) { log.fail('No MCP port — abort'); process.exitCode = 1; return }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: SUB-AGENT #1 — read package.json
    // ═══════════════════════════════════════════════════════════════════
    log.phase(1, 'SUB-AGENT #1 — package.json')

    const prompt1 = 'Use delegate_to_claude to ask Claude to read package.json in the current directory and tell the project name and version. Tell Claude to be brief, one line. Just delegate, do not do anything yourself.'
    await page.evaluate(({ tabId, text }) => {
      const { ipcRenderer } = window.require('electron'); ipcRenderer.send('gemini:send-command', tabId, text)
    }, { tabId: geminiTabId, text: prompt1 })

    let stopH = startHeartbeat('agent1-thinking')
    await logWatch.waitFor(/\[GeminiSpinner\].*THINKING/, 15000)
    stopH()

    stopH = startHeartbeat('agent1-create')
    const d1 = await logWatch.waitFor(/MCP:Delegate.*sub-agent tab created/, 120000)
    stopH()
    assert(!!d1, 'Sub-agent #1 created')

    // Extract taskId1
    let taskId1 = null
    const dlogs1 = findInLogs(mainProcessLogs, 'MCP:HTTP] POST /delegate')
    if (dlogs1.length > 0) { const m = dlogs1[dlogs1.length - 1].match(/taskId=([a-f0-9-]+)/i); if (m) taskId1 = m[1] }
    assert(!!taskId1, `TaskId #1: ${taskId1?.substring(0, 8)}`)

    // Wait for completion
    stopH = startHeartbeat('agent1-work')
    await logWatch.waitFor(/\[Spinner\].*BUSY/, 60000)
    await logWatch.waitFor(/Sub-agent completion triggered/, 120000)
    const del1 = await logWatch.waitFor(/MCP:Complete.*Delivering \d+ chars/, 150000)
    stopH()
    assert(!!del1, 'Agent #1 result delivered')

    // Let Gemini process
    log.step('Letting Gemini process agent #1 result...')
    await page.waitForTimeout(8000)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: SUB-AGENT #2 — read CLAUDE.md (different content!)
    // ═══════════════════════════════════════════════════════════════════
    log.phase(2, 'SUB-AGENT #2 — CLAUDE.md')

    const prompt2 = 'Use delegate_to_claude to ask Claude to read the file CLAUDE.md in the current directory and list the top 3 section headings. Tell Claude to be brief. Just delegate, do not do anything yourself.'
    await page.evaluate(({ tabId, text }) => {
      const { ipcRenderer } = window.require('electron'); ipcRenderer.send('gemini:send-command', tabId, text)
    }, { tabId: geminiTabId, text: prompt2 })

    stopH = startHeartbeat('agent2-thinking')
    await logWatch.waitFor(/\[GeminiSpinner\].*THINKING/, 15000)
    stopH()

    // Wait for HTTP delegate log FIRST (comes before sub-agent tab created)
    let taskId2 = null
    const delegateLog2 = await logWatch.waitFor(/MCP:HTTP.*POST \/delegate/, 60000)
    if (delegateLog2) {
      const m = delegateLog2.match(/taskId=([a-f0-9-]+)/i)
      if (m) taskId2 = m[1]
    }
    assert(!!taskId2, `TaskId #2: ${taskId2?.substring(0, 8)}`)
    assert(taskId1 !== taskId2, `TaskIds are different: ${taskId1?.substring(0, 8)} vs ${taskId2?.substring(0, 8)}`)

    stopH = startHeartbeat('agent2-create')
    const d2 = await logWatch.waitFor(/MCP:Delegate.*sub-agent tab created/, 120000)
    stopH()
    assert(!!d2, 'Sub-agent #2 created')

    // Wait for completion
    stopH = startHeartbeat('agent2-work')
    await logWatch.waitFor(/\[Spinner\].*BUSY/, 60000)
    await logWatch.waitFor(/Sub-agent completion triggered/, 120000)
    const del2 = await logWatch.waitFor(/MCP:Complete.*Delivering \d+ chars/, 150000)
    stopH()
    assert(!!del2, 'Agent #2 result delivered')

    await page.waitForTimeout(5000)

    // Verify 2 sub-agents in store
    const subAgents = await page.evaluate((gTabId) => {
      const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return []
      return Array.from(p.tabs.values()).filter(t => t.parentTabId === gTabId).map(t => ({ id: t.id, cmd: t.commandType }))
    }, geminiTabId)
    assert(subAgents.length >= 2, `2 sub-agents in store: ${subAgents.length}`)

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: UPDATE_DOCS — both sessions at once
    // ═══════════════════════════════════════════════════════════════════
    log.phase(3, 'UPDATE_DOCS — MULTI-SESSION')

    if (!taskId1 || !taskId2) {
      log.fail('Missing taskIds — cannot test multi-session'); process.exitCode = 1; return
    }

    log.step(`Calling POST /update-docs with 2 taskIds...`)
    log.info(`  taskId1 (package.json): ${taskId1.substring(0, 8)}`)
    log.info(`  taskId2 (CLAUDE.md):    ${taskId2.substring(0, 8)}`)

    stopH = startHeartbeat('update-docs-api', 10000)
    try {
      const result = await httpPost(mcpPort, '/update-docs', {
        taskIds: [taskId1, taskId2],
        provider: 'gemini',
        ppid: 0
      }, 300000) // 5 min for 2 API calls

      stopH()

      assert(result.results && result.results.length === 2, `Got 2 results: ${result.results?.length}`)

      if (result.results?.length === 2) {
        const r1 = result.results[0]
        const r2 = result.results[1]

        // Both should have results
        assert(r1.taskId === taskId1, `Result #1 taskId matches`)
        assert(r2.taskId === taskId2, `Result #2 taskId matches`)

        if (r1.success && r2.success) {
          assert(r1.text.length > 20, `Result #1 has content: ${r1.text.length} chars`)
          assert(r2.text.length > 20, `Result #2 has content: ${r2.text.length} chars`)

          // Key test: results should be DIFFERENT (different sessions → different analysis)
          assert(r1.text !== r2.text, `Results are different (distinct sessions)`)

          // Content hints: #1 should reference package.json, #2 should reference CLAUDE.md
          const r1Lower = r1.text.toLowerCase()
          const r2Lower = r2.text.toLowerCase()

          // At least one should have relevant keywords (the doc prompt may transform output)
          softAssert(
            r1Lower.includes('package') || r1Lower.includes('version') || r1Lower.includes('noted'),
            `Result #1 relates to package.json context`
          )
          softAssert(
            r2Lower.includes('claude') || r2Lower.includes('mcp') || r2Lower.includes('terminal') || r2Lower.includes('electron'),
            `Result #2 relates to CLAUDE.md context`
          )

          // Usage stats
          assert(!!r1.usage, `Result #1 usage: in=${r1.usage?.input_tokens} out=${r1.usage?.output_tokens}`)
          assert(!!r2.usage, `Result #2 usage: in=${r2.usage?.input_tokens} out=${r2.usage?.output_tokens}`)

          // Input tokens should differ (different session sizes)
          if (r1.usage && r2.usage) {
            softAssert(
              r1.usage.input_tokens !== r2.usage.input_tokens,
              `Input tokens differ: ${r1.usage.input_tokens} vs ${r2.usage.input_tokens}`
            )
          }

          log.info(`\n--- Result #1 preview (package.json session) ---`)
          log.info(r1.text.substring(0, 200) + '...')
          log.info(`\n--- Result #2 preview (CLAUDE.md session) ---`)
          log.info(r2.text.substring(0, 200) + '...')

        } else {
          if (!r1.success) log.fail(`Result #1 error: ${r1.error}`)
          if (!r2.success) log.fail(`Result #2 error: ${r2.error}`)
        }
      }

    } catch (e) {
      stopH()
      log.fail(`HTTP /update-docs failed: ${e.message}`)
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
    log.fail(`Unhandled: ${error.message}`); console.error(error.stack); process.exitCode = 1
  } finally {
    clearTimeout(globalTimer); try { await app.close() } catch {}
  }
}

main().catch(e => { console.error(`[FATAL] ${e.message}`); process.exit(1) })
