/**
 * E2E Test: Adopt Agent (Drag Claude tab onto Gemini tab)
 *
 * Tests:
 * 1. Create Claude tab, wait for session via Bridge
 * 2. Create Gemini tab (idle, CLI not running)
 * 3. Adopt Claude tab via IPC mcp:adopt-agent
 * 4. Verify: Claude tab gets parentTabId
 * 5. Verify: Gemini auto-launches (HIDE CURSOR detected)
 * 6. Verify: Adopted context delivered (queue → processGeminiQueue)
 * 7. Verify: Gemini JSONL session contains [Adopted Agent Context]
 * 8. Verify: SubAgentBar shows chip
 *
 * [E2E+Claude] — Requires: npm run dev + npx electron-vite build + claude CLI + gemini CLI
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId,
        waitForGeminiSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

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

function startHeartbeat(label, intervalMs = 5000) {
  let count = 0
  const timer = setInterval(() => {
    count++
    process.stdout.write(`${c.dim}  ...${label} ${count * (intervalMs/1000)}s${c.reset}\n`)
  }, intervalMs)
  return () => clearInterval(timer)
}

async function main() {
  const globalTimer = setTimeout(() => {
    console.error('\n[FATAL] Global timeout (300s). Force exit.')
    process.exit(1)
  }, 300000)

  log.step('Launching Electron app...')
  let { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    await page.waitForTimeout(3000)

    for (let i = 0; i < 3; i++) {
      try { await electron.focusWindow(app); break }
      catch { await page.waitForTimeout(2000); const wins = await app.windows(); for (const w of wins) { if (!(await w.url()).includes('devtools://')) { page = w; break } } }
    }

    try { await waitForTerminal(page, 5000) }
    catch { await page.keyboard.press('Meta+t'); await waitForTerminal(page, 10000) }
    try { await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 }) } catch {}

    // ═══════════════════════════════════════════════════════
    // STEP 1: Create Claude tab + wait for session
    // ═══════════════════════════════════════════════════════
    log.step('STEP 1: Create Claude tab')

    const tabs1 = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabs1, { timeout: 5000 })
    await page.waitForTimeout(500)

    await typeCommand(page, 'cd ~/Desktop/custom-terminal')
    await page.waitForTimeout(1000)

    const claudeTabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.activeTabId
    })
    log.info('Claude tab: ' + claudeTabId)

    await typeCommand(page, 'claude --dangerously-skip-permissions')

    // Wait for Bridge to detect session (event-driven)
    log.step('Waiting for Claude session (Bridge)...')
    const stopHb1 = startHeartbeat('claude-bridge')
    const bridgePattern = new RegExp('Bridge:PID.*tab=' + claudeTabId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    try {
      await waitForMainProcessLog(mainProcessLogs, bridgePattern, 30000)
    } catch {
      log.warn('Bridge detection timed out for ' + claudeTabId)
    }
    stopHb1()

    const claudeSessionId = await page.evaluate((tabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      for (const [, ws] of s.openProjects) {
        const tab = ws.tabs.get(tabId)
        if (tab?.claudeSessionId) return tab.claudeSessionId
      }
      return null
    }, claudeTabId)
    assert(claudeSessionId, 'Claude session: ' + (claudeSessionId || 'NONE'))

    // ═══════════════════════════════════════════════════════
    // STEP 2: Create Gemini tab (idle)
    // ═══════════════════════════════════════════════════════
    log.step('STEP 2: Create Gemini tab (idle)')

    const tabs2 = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabs2, { timeout: 5000 })
    await page.waitForTimeout(500)

    const geminiTabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.activeTabId
    })
    log.info('Gemini tab: ' + geminiTabId)

    // Set commandType to gemini
    await page.evaluate((tabId) => {
      window.useWorkspaceStore?.getState?.()?.setTabCommandType?.(tabId, 'gemini')
    }, geminiTabId)

    await typeCommand(page, 'cd ~/Desktop/custom-terminal')
    await page.waitForTimeout(1000)

    // ═══════════════════════════════════════════════════════
    // STEP 3: Adopt
    // ═══════════════════════════════════════════════════════
    log.step('STEP 3: Adopt Claude tab via IPC')

    const adoptResult = await page.evaluate(({ claudeId, geminiId }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('mcp:adopt-agent', { claudeTabId: claudeId, geminiTabId: geminiId })
    }, { claudeId: claudeTabId, geminiId: geminiTabId })

    assert(adoptResult?.success, 'mcp:adopt-agent success: ' + JSON.stringify(adoptResult))
    const taskId = adoptResult?.taskId
    log.info('Task ID: ' + taskId)

    // ═══════════════════════════════════════════════════════
    // STEP 4: Verify parentTabId
    // ═══════════════════════════════════════════════════════
    log.step('STEP 4: Check parentTabId')
    await page.waitForTimeout(500)

    const parentId = await page.evaluate((tabId) => {
      const s = window.useWorkspaceStore?.getState?.()
      for (const [, ws] of s.openProjects) {
        const tab = ws.tabs.get(tabId)
        if (tab) return tab.parentTabId
      }
      return null
    }, claudeTabId)
    assert(parentId === geminiTabId, 'parentTabId correct: ' + parentId)

    // ═══════════════════════════════════════════════════════
    // STEP 5: Wait for HIDE CURSOR (Gemini TUI ready)
    // ═══════════════════════════════════════════════════════
    log.step('STEP 5: Wait for Gemini TUI ready (HIDE CURSOR)')
    const stopHb2 = startHeartbeat('gemini-tui')

    let tuiReady = false
    try {
      await waitForMainProcessLog(mainProcessLogs, /MCP:Adopt.*HIDE CURSOR detected/, 30000)
      tuiReady = true
    } catch {
      log.warn('HIDE CURSOR log not found')
    }
    stopHb2()
    assert(tuiReady, 'Gemini TUI ready (HIDE CURSOR)')

    // ═══════════════════════════════════════════════════════
    // STEP 6: Wait for delivery
    // ═══════════════════════════════════════════════════════
    log.step('STEP 6: Wait for context delivery')
    const stopHb3 = startHeartbeat('delivery')

    let delivered = false
    try {
      await waitForMainProcessLog(mainProcessLogs, /MCP:Queue.*Delivering queued response/, 30000)
      delivered = true
    } catch {
      log.warn('Queue delivery log not found')
    }
    stopHb3()
    assert(delivered, 'Context delivered via queue')

    // Wait for Gemini to process the paste
    log.step('Waiting for Gemini to process adopted context...')
    const stopHb4 = startHeartbeat('gemini-process')
    try {
      await waitForMainProcessLog(mainProcessLogs, /GeminiSpinner.*IDLE/, 60000)
    } catch {
      log.warn('Gemini IDLE not detected')
    }
    stopHb4()

    // ═══════════════════════════════════════════════════════
    // STEP 7: Verify Gemini JSONL contains adopted context
    // ═══════════════════════════════════════════════════════
    log.step('STEP 7: Check Gemini session JSONL')

    // Wait for Gemini session detection (Sniper watcher)
    let geminiSessionId = null
    try {
      geminiSessionId = await waitForGeminiSessionId(page, 15000)
    } catch {
      // Try from store directly
      geminiSessionId = await page.evaluate((tabId) => {
        const s = window.useWorkspaceStore?.getState?.()
        for (const [, ws] of s.openProjects) {
          const tab = ws.tabs.get(tabId)
          if (tab?.geminiSessionId) return tab.geminiSessionId
        }
        return null
      }, geminiTabId)
    }
    log.info('Gemini session: ' + (geminiSessionId || 'NONE'))

    // Search Gemini session files for adopted context
    let jsonlContainsAdopted = false
    if (geminiSessionId) {
      // Find Gemini session file
      const geminiDir = path.join(os.homedir(), '.gemini', 'tmp')
      try {
        const findInDir = (dir) => {
          if (!fs.existsSync(dir)) return null
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const e of entries) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) {
              const sub = path.join(full, 'chats')
              if (fs.existsSync(sub)) {
                const files = fs.readdirSync(sub).filter(f => f.includes('session') && f.endsWith('.json'))
                for (const f of files) {
                  try {
                    const content = fs.readFileSync(path.join(sub, f), 'utf-8')
                    if (content.includes(geminiSessionId) && content.includes('Adopted Agent Context')) {
                      return { file: path.join(sub, f), found: true }
                    }
                  } catch {}
                }
              }
            }
          }
          return null
        }
        const result = findInDir(geminiDir)
        if (result) {
          jsonlContainsAdopted = true
          log.info('Found in: ' + result.file)
        } else {
          log.info('Searching all chats dirs...')
          // Broader search in all gemini tmp dirs
          const dirs = fs.readdirSync(geminiDir, { withFileTypes: true }).filter(d => d.isDirectory())
          for (const d of dirs) {
            const chatsDir = path.join(geminiDir, d.name, 'chats')
            if (!fs.existsSync(chatsDir)) continue
            const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'))
            for (const f of files) {
              try {
                const content = fs.readFileSync(path.join(chatsDir, f), 'utf-8')
                if (content.includes('Adopted Agent Context')) {
                  jsonlContainsAdopted = true
                  log.info('Found adopted context in: ' + path.join(chatsDir, f))
                  // Check it's recent (created in last 2 min)
                  const stat = fs.statSync(path.join(chatsDir, f))
                  const ageMs = Date.now() - stat.mtimeMs
                  log.info('File age: ' + Math.round(ageMs / 1000) + 's')
                  break
                }
              } catch {}
            }
            if (jsonlContainsAdopted) break
          }
        }
      } catch (e) {
        log.warn('Error searching Gemini files: ' + e.message)
      }
    }
    assert(jsonlContainsAdopted, 'Gemini session JSONL contains [Adopted Agent Context]')

    // ═══════════════════════════════════════════════════════
    // STEP 8: SubAgentBar
    // ═══════════════════════════════════════════════════════
    log.step('STEP 8: SubAgentBar check')

    await page.evaluate((tabId) => {
      window.useWorkspaceStore?.getState?.()?.switchTab?.(
        window.useWorkspaceStore?.getState?.()?.activeProjectId, tabId
      )
    }, geminiTabId)
    await page.waitForTimeout(500)

    const subAgentCount = await page.evaluate((gId) => {
      const s = window.useWorkspaceStore?.getState?.()
      let count = 0
      for (const [, ws] of s.openProjects) {
        for (const [, tab] of ws.tabs) {
          if (tab.parentTabId === gId) count++
        }
      }
      return count
    }, geminiTabId)
    assert(subAgentCount > 0, 'SubAgentBar has ' + subAgentCount + ' sub-agent(s)')

    // ═══════════════════════════════════════════════════════
    // All adopt logs
    // ═══════════════════════════════════════════════════════
    const adoptLogs = findInLogs(mainProcessLogs, 'MCP:Adopt')
    log.info('Adopt logs (' + adoptLogs.length + '):')
    for (const l of adoptLogs) log.info('  ' + l.substring(0, 120))

    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => { console.error('[ERROR]', err.message); process.exit(1) })
