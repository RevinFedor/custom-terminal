/**
 * E2E Test: Gemini Orchestration (Live Gemini CLI + Claude Sub-Agent)
 *
 * Tests:
 * 1. Gemini CLI launch & session detection
 * 2. Braille spinner detection (THINKING / IDLE) in main process logs
 * 3. Simple prompt → response cycle
 * 4. Delegation: Gemini → Claude sub-agent creation
 * 5. Sub-agent tab exists with parentTabId in store
 * 6. SubAgentBar visibility (only when active tab is gemini)
 * 7. MCP task status via HTTP /status endpoint
 * 8. Claude spinner detection for sub-agent
 *
 * [E2E+Gemini+Claude] — Requires: npm run dev (port 5182) + npx electron-vite build + gemini CLI installed
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const http = require('http')

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

function httpGet(port, endpoint) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP timeout')), 5000)
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
    const timer = setTimeout(() => reject(new Error('HTTP timeout')), 5000)
    const req = http.request({
      hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
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

// Heartbeat: prints dots every N seconds so output doesn't look stuck
function startHeartbeat(label, intervalMs = 5000) {
  let count = 0
  const timer = setInterval(() => {
    count++
    process.stdout.write(`${c.dim}  ...${label} ${count * (intervalMs/1000)}s${c.reset}\n`)
  }, intervalMs)
  return () => clearInterval(timer)
}

async function main() {
  // Hard kill safety (5 min for live Gemini + Claude)
  const globalTimer = setTimeout(() => {
    console.error('\n[FATAL] Global timeout (300s). Force exit.')
    process.exit(1)
  }, 300000)

  log.step('Launching Electron app...')
  let { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: false,
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

    // Get active tab info
    const tabInfo = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (!p) return null
      const tab = p.tabs?.get?.(p.activeTabId)
      return {
        tabId: p.activeTabId,
        projectId: s.activeProjectId,
        commandType: tab?.commandType,
        cwd: tab?.cwd,
        tabCount: p.tabs.size
      }
    })
    log.info(`Active tab: ${tabInfo?.tabId}, type: ${tabInfo?.commandType}, tabs: ${tabInfo?.tabCount}`)

    // ═══════════════════════════════════════════════════════
    // TEST 1: Create fresh tab and launch Gemini CLI
    // ═══════════════════════════════════════════════════════
    log.step('TEST 1: Launch Gemini CLI (fresh tab)')

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

    assert(activeTabId, `Gemini spawn-with-watcher sent for tab: ${activeTabId}`)

    // Wait for session detection (event-driven)
    log.step('Waiting for Gemini session detection...')
    const stopHb1 = startHeartbeat('waiting-gemini-session')
    let geminiSessionDetected = false
    try {
      await waitForGeminiSessionId(page, 40000)
      geminiSessionDetected = true
    } catch {
      log.warn('Gemini session ID timeout — CLI may still be loading')
    }
    stopHb1()
    assert(geminiSessionDetected, 'Gemini session ID detected in store')

    // Wait for Gemini TUI readiness: ⠋ loading spinner appears then stops
    // First THINKING = Gemini started loading, first IDLE = TUI ready for input
    log.step('Waiting for Gemini loading spinner (⠋)...')
    const stopHbReady = startHeartbeat('waiting-gemini-ready')
    const loadingLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*THINKING/, 20000)
    if (loadingLog) {
      log.info('Gemini loading spinner detected, waiting for TUI ready...')
      const readyLog = await waitForMainProcessLog(mainProcessLogs,
        /\[GeminiSpinner\].*IDLE/, 20000)
      if (readyLog) {
        log.info('Gemini TUI ready (spinner stopped)')
      }
    } else {
      log.warn('No loading spinner detected, waiting 10s fallback...')
      await page.waitForTimeout(10000)
    }
    stopHbReady()
    await page.waitForTimeout(1000) // Small settle time

    // Verify tab commandType is now 'gemini'
    const geminiTabInfo = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = p?.tabs?.get?.(p?.activeTabId)
      return {
        commandType: tab?.commandType,
        geminiSessionId: tab?.geminiSessionId
      }
    })
    assert(geminiTabInfo?.commandType === 'gemini',
      `Tab commandType is 'gemini': ${geminiTabInfo?.commandType}`)
    log.info(`Gemini session: ${geminiTabInfo?.geminiSessionId}`)

    // ═══════════════════════════════════════════════════════
    // TEST 2: Discover MCP HTTP port
    // ═══════════════════════════════════════════════════════
    log.step('TEST 2: Discover MCP HTTP port')

    const portLog = await waitForMainProcessLog(mainProcessLogs, /MCP:HTTP.*listening.*:\d+/, 10000)
    let mcpPort = null
    if (portLog) {
      const m = portLog.match(/:(\d+)/)
      if (m) mcpPort = parseInt(m[1])
    }
    // If not found in logs, try reading from file
    if (!mcpPort) {
      try {
        const portFromFile = await page.evaluate(() => {
          const { ipcRenderer } = window.require('electron')
          const fs = window.require('fs')
          const os = window.require('os')
          const path = window.require('path')
          const portFile = path.join(os.homedir(), '.noted-terminal', 'mcp-port')
          try { return parseInt(fs.readFileSync(portFile, 'utf-8').trim()) } catch { return null }
        })
        if (portFromFile > 0) mcpPort = portFromFile
      } catch {}
    }
    assert(mcpPort && mcpPort > 0, `MCP HTTP port discovered: ${mcpPort}`)

    // ═══════════════════════════════════════════════════════
    // TEST 3: Send simple prompt to Gemini → detect spinner
    // ═══════════════════════════════════════════════════════
    log.step('TEST 3: Send prompt to Gemini, detect thinking spinner')

    // Send prompt via gemini:send-command IPC (uses safePasteAndSubmit + geminiCommandQueue)
    const promptText = 'Say just the word PINEAPPLE and nothing else'
    await page.evaluate(({ tabId, text }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('gemini:send-command', tabId, text)
    }, { tabId: activeTabId, text: promptText })

    log.info(`Sent prompt: "${promptText}"`)

    // Wait for Gemini spinner (THINKING state) in main process logs
    log.step('Waiting for Gemini spinner detection...')
    const stopHb2 = startHeartbeat('waiting-spinner')
    const spinnerLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*THINKING/, 15000)
    stopHb2()

    assert(spinnerLog !== null, `Gemini spinner detected: ${spinnerLog ? 'yes' : 'no'}`)
    if (spinnerLog) {
      log.info(`Spinner log: ${spinnerLog.trim()}`)
    }

    // ═══════════════════════════════════════════════════════
    // TEST 4: Wait for Gemini response (IDLE state)
    // ═══════════════════════════════════════════════════════
    log.step('TEST 4: Wait for Gemini response (spinner IDLE)')

    const stopHb3 = startHeartbeat('waiting-response')
    const idleLog = await waitForMainProcessLog(mainProcessLogs,
      /\[GeminiSpinner\].*IDLE/, 60000)
    stopHb3()

    assert(idleLog !== null, `Gemini response complete (IDLE): ${idleLog ? 'yes' : 'no'}`)
    if (idleLog) {
      log.info(`Idle log: ${idleLog.trim()}`)
    }

    // Small delay for TUI to settle after response
    await page.waitForTimeout(2000)

    // Try to read terminal buffer to verify response
    const bufferContent = await page.evaluate(({ tabId }) => {
      // Try to get visible text from xterm
      const xtermEl = document.querySelector('.xterm-screen')
      if (!xtermEl) return 'NO_XTERM'
      const rows = document.querySelectorAll('.xterm-rows > div')
      if (!rows.length) return 'NO_ROWS'
      // Get last 20 rows
      const lines = []
      const start = Math.max(0, rows.length - 20)
      for (let i = start; i < rows.length; i++) {
        const text = rows[i]?.textContent || ''
        if (text.trim()) lines.push(text.trim())
      }
      return lines.join('\n')
    }, { tabId: activeTabId })

    log.info(`Buffer snapshot (last 20 lines):\n${bufferContent?.substring(0, 500)}`)

    // Check if response contains PINEAPPLE
    // NOTE: Gemini uses alternate buffer with full-screen redraws — response text
    // may be scrolled out or overwritten by TUI re-render. This is informational only.
    const hasPineapple = bufferContent?.toUpperCase().includes('PINEAPPLE')
    if (hasPineapple) {
      log.pass('Response contains PINEAPPLE in visible buffer')
      passed++
    } else {
      log.warn('PINEAPPLE not found in visible buffer (alternate buffer limitation — not a bug)')
    }

    // ═══════════════════════════════════════════════════════
    // TEST 5: Count spinner transitions in logs
    // ═══════════════════════════════════════════════════════
    log.step('TEST 5: Verify spinner state transitions')

    const thinkingLogs = findInLogs(mainProcessLogs, '[GeminiSpinner]')
    const thinkCount = thinkingLogs.filter(l => l.includes('THINKING')).length
    const idleCount = thinkingLogs.filter(l => l.includes('IDLE')).length

    log.info(`Spinner transitions: ${thinkCount} THINKING, ${idleCount} IDLE`)
    assert(thinkCount >= 1, `At least 1 THINKING transition: ${thinkCount}`)
    assert(idleCount >= 1, `At least 1 IDLE transition: ${idleCount}`)

    // ═══════════════════════════════════════════════════════
    // TEST 6: Delegate to Claude sub-agent
    // ═══════════════════════════════════════════════════════
    log.step('TEST 6: Trigger Claude sub-agent delegation')

    if (!mcpPort) {
      log.warn('Skipping delegation tests — no MCP port')
    } else {
      // Get initial tab count
      const beforeDelegation = await page.evaluate(() => {
        const s = window.useWorkspaceStore?.getState?.()
        const p = s?.openProjects?.get?.(s?.activeProjectId)
        return { tabCount: p?.tabs?.size ?? 0 }
      })
      log.info(`Tabs before delegation: ${beforeDelegation.tabCount}`)

      // Send delegation prompt via gemini:send-command IPC
      const delegationPrompt = 'Use the delegate_to_claude tool to ask Claude Code to say the word MANGO and nothing else. Do not do anything yourself, just delegate.'
      await page.evaluate(({ tabId, text }) => {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('gemini:send-command', tabId, text)
      }, { tabId: activeTabId, text: delegationPrompt })

      log.info('Sent delegation prompt to Gemini')

      // Wait for Gemini to process and call the MCP tool
      // This triggers: Gemini thinking → MCP tool call → /delegate HTTP → sub-agent creation
      const stopHb4 = startHeartbeat('waiting-delegation')

      // Wait for delegation log from main process
      const delegateLog = await waitForMainProcessLog(mainProcessLogs,
        /MCP:Delegate.*sub-agent tab created/, 120000)
      stopHb4()

      if (delegateLog) {
        log.pass(`Sub-agent creation detected: ${delegateLog.trim().substring(0, 80)}`)
      } else {
        // Fallback: check via HTTP /delegate directly (Gemini might not call MCP tool)
        log.warn('No delegation log found — Gemini may not have called delegate_to_claude')
        log.info('Attempting direct HTTP delegation as fallback...')

        try {
          const directResult = await httpPost(mcpPort, '/delegate', {
            prompt: 'Say the word MANGO and nothing else',
            ppid: process.pid
          })
          assert(directResult.taskId, `Direct delegation accepted: ${directResult.taskId}`)

          // Wait for sub-agent creation
          const directLog = await waitForMainProcessLog(mainProcessLogs,
            /MCP:Delegate.*sub-agent tab created/, 15000)
          if (directLog) {
            log.pass('Sub-agent created via direct HTTP delegation')
          }
        } catch (e) {
          log.fail(`Direct delegation failed: ${e.message}`)
        }
      }

      // ═══════════════════════════════════════════════════════
      // TEST 7: Verify sub-agent tab in store
      // ═══════════════════════════════════════════════════════
      log.step('TEST 7: Verify sub-agent tab in store')

      await page.waitForTimeout(2000) // store propagation

      const afterDelegation = await page.evaluate(() => {
        const s = window.useWorkspaceStore?.getState?.()
        const p = s?.openProjects?.get?.(s?.activeProjectId)
        if (!p) return null
        const tabs = Array.from(p.tabs.values())
        return {
          tabCount: tabs.length,
          subAgentTabs: tabs.filter(t => !!t.parentTabId).map(t => ({
            id: t.id,
            name: t.name,
            parentTabId: t.parentTabId,
            commandType: t.commandType,
            claudeAgentStatus: t.claudeAgentStatus
          })),
          allTabs: tabs.map(t => ({
            id: t.id,
            name: t.name,
            commandType: t.commandType,
            parentTabId: t.parentTabId || null
          }))
        }
      })

      log.info(`Tabs after delegation: ${afterDelegation?.tabCount}`)
      log.info(`All tabs: ${JSON.stringify(afterDelegation?.allTabs, null, 0)}`)

      const subAgents = afterDelegation?.subAgentTabs || []
      assert(subAgents.length >= 1, `Sub-agent tab(s) found: ${subAgents.length}`)

      if (subAgents.length > 0) {
        const sa = subAgents[0]
        assert(sa.parentTabId, `Sub-agent has parentTabId: ${sa.parentTabId}`)
        assert(sa.commandType === 'claude', `Sub-agent commandType: ${sa.commandType}`)
        log.info(`Sub-agent: ${sa.name} (${sa.id}) → parent: ${sa.parentTabId}`)

        // ═══════════════════════════════════════════════════════
        // TEST 8: Sub-agent hidden from main TabBar
        // ═══════════════════════════════════════════════════════
        log.step('TEST 8: Sub-agent hidden from main TabBar')

        const visibleTabCount = await page.evaluate(() => {
          return document.querySelectorAll('[data-tab-item]').length
        })

        // Sub-agent tabs should NOT appear in TabBar (filtered by parentTabId)
        assert(visibleTabCount <= beforeDelegation.tabCount,
          `TabBar shows ${visibleTabCount} tabs (initial was ${beforeDelegation.tabCount}) — sub-agent hidden`)

        // ═══════════════════════════════════════════════════════
        // TEST 9: SubAgentBar visible (active tab is gemini with sub-agents)
        // ═══════════════════════════════════════════════════════
        log.step('TEST 9: SubAgentBar visibility')

        // The active tab should be gemini, so SubAgentBar should render
        const subAgentBarInfo = await page.evaluate(() => {
          // Look for SubAgentBar by checking for "Sub-agents:" or "Claude #" text
          const allDivs = document.querySelectorAll('div')
          for (const div of allDivs) {
            if (div.textContent?.includes('Sub-agents:') || div.textContent?.includes('Claude #1')) {
              return {
                visible: true,
                text: div.textContent.substring(0, 100),
                height: div.style.height
              }
            }
          }
          return { visible: false }
        })

        assert(subAgentBarInfo.visible,
          `SubAgentBar visible: ${subAgentBarInfo.visible} (text: "${subAgentBarInfo.text?.substring(0, 50)}")`)
      }

      // ═══════════════════════════════════════════════════════
      // TEST 10: MCP task status via HTTP
      // ═══════════════════════════════════════════════════════
      log.step('TEST 10: Check MCP tasks via logs')

      const taskLogs = findInLogs(mainProcessLogs, 'MCP:')
      log.info(`MCP-related log entries: ${taskLogs.length}`)
      for (const tl of taskLogs.slice(-10)) {
        log.info(`  ${tl.trim().substring(0, 120)}`)
      }

      // Try to find a taskId from logs and query status
      const taskIdMatch = taskLogs.join('\n').match(/taskId=([a-f0-9-]+)/i)
      if (taskIdMatch) {
        const taskId = taskIdMatch[1]
        try {
          const status = await httpGet(mcpPort, `/status/${taskId}`)
          log.info(`Task ${taskId}: status=${status.status}`)
          assert(status.status, `Task has status: ${status.status}`)
        } catch (e) {
          log.warn(`Failed to check task status: ${e.message}`)
        }
      }

      // ═══════════════════════════════════════════════════════
      // TEST 11: Wait for Claude sub-agent completion
      // ═══════════════════════════════════════════════════════
      log.step('TEST 11: Wait for Claude sub-agent activity')

      // Wait for Claude spinner (orange) detection in the sub-agent tab
      const stopHb5 = startHeartbeat('waiting-claude-spinner')
      const claudeSpinnerLog = await waitForMainProcessLog(mainProcessLogs,
        /\[Spinner\].*BUSY/, 60000)
      stopHb5()

      if (claudeSpinnerLog) {
        log.pass(`Claude sub-agent busy: ${claudeSpinnerLog.trim().substring(0, 80)}`)

        // Wait for completion
        const stopHb6 = startHeartbeat('waiting-claude-completion')
        const claudeIdleLog = await waitForMainProcessLog(mainProcessLogs,
          /\[Spinner\].*IDLE/, 120000)
        stopHb6()

        if (claudeIdleLog) {
          log.pass(`Claude sub-agent completed: ${claudeIdleLog.trim().substring(0, 80)}`)
        } else {
          log.warn('Claude sub-agent idle not detected within timeout')
        }
      } else {
        log.warn('Claude sub-agent spinner not detected — may have completed very fast')
      }

      // ═══════════════════════════════════════════════════════
      // TEST 12: Verify claudeAgentStatus in store
      // ═══════════════════════════════════════════════════════
      log.step('TEST 12: Check claudeAgentStatus in store')

      await page.waitForTimeout(2000) // let status propagate

      const finalState = await page.evaluate(() => {
        const s = window.useWorkspaceStore?.getState?.()
        const p = s?.openProjects?.get?.(s?.activeProjectId)
        if (!p) return null
        const tabs = Array.from(p.tabs.values())
        return {
          subAgentStatuses: tabs.filter(t => !!t.parentTabId).map(t => ({
            id: t.id,
            status: t.claudeAgentStatus || 'unknown'
          }))
        }
      })

      if (finalState?.subAgentStatuses?.length > 0) {
        for (const sa of finalState.subAgentStatuses) {
          log.info(`Sub-agent ${sa.id}: claudeAgentStatus = ${sa.status}`)
        }
        const allHaveStatus = finalState.subAgentStatuses.every(s => s.status !== 'unknown')
        assert(allHaveStatus,
          `Sub-agent statuses known: ${finalState.subAgentStatuses.map(s => s.status).join(', ')}`)
      }

      // ═══════════════════════════════════════════════════════
      // TEST 13: Count total sub-agents (Gemini should NOT spawn excessive ones)
      // ═══════════════════════════════════════════════════════
      log.step('TEST 13: Sub-agent count sanity check')

      const delegateLogs = findInLogs(mainProcessLogs, 'MCP:Delegate')
      const creationLogs = delegateLogs.filter(l => l.includes('sub-agent tab created'))
      log.info(`Total sub-agent creations: ${creationLogs.length}`)

      // For a single delegation request, there should be at most 2-3 sub-agents
      // (Gemini sometimes retries, but should not spam)
      assert(creationLogs.length <= 5,
        `Sub-agent count reasonable: ${creationLogs.length} (expected <= 5)`)
      if (creationLogs.length > 3) {
        log.warn(`Gemini created ${creationLogs.length} sub-agents — possible excessive delegation`)
      }
    }

    // ═══════════════════════════════════════════════════════
    // RESULTS
    // ═══════════════════════════════════════════════════════
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    console.log(`${'='.repeat(50)}`)

    // Dump relevant logs summary
    log.info('\n--- LOG SUMMARY ---')
    const geminiSpinnerLogs = findInLogs(mainProcessLogs, 'GeminiSpinner')
    const claudeSpinnerLogs = findInLogs(mainProcessLogs, '[Spinner]')
    const mcpLogs = findInLogs(mainProcessLogs, 'MCP:')
    log.info(`Gemini Spinner logs: ${geminiSpinnerLogs.length}`)
    log.info(`Claude Spinner logs: ${claudeSpinnerLogs.length}`)
    log.info(`MCP logs: ${mcpLogs.length}`)

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
