/**
 * Test: Gemini spinner busy indicator detection
 * [E2E+Gemini] — Requires live `gemini` CLI
 *
 * Verifies:
 * 1. Braille spinner detection triggers [GeminiSpinner] THINKING in main process logs
 * 2. Response completion triggers [GeminiSpinner] IDLE
 * 3. Full THINKING→IDLE cycle for a user prompt (not just startup)
 *
 * Requires: npm run dev (port 5182) + npx electron-vite build + gemini CLI
 * Run: node auto/sandbox/test-gemini-busy-indicator.js 2>&1 | tee /tmp/test-gemini-busy.log
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

const GLOBAL_MS = 180000
const globalTimer = setTimeout(() => {
  console.error('\n\x1b[31m[KILL] 180s global timeout\x1b[0m')
  process.exit(2)
}, GLOBAL_MS)
globalTimer.unref()

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

async function withTimeout(promise, ms, label) {
  let timer
  const to = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms`)), ms) })
  try {
    const r = await Promise.race([promise, to])
    clearTimeout(timer)
    return r
  } catch (err) {
    clearTimeout(timer)
    log.fail(`${label}: ${err.message}`)
    failed++
    return null
  }
}

/**
 * Wait for a log pattern starting from a given index (ignores earlier entries).
 */
async function waitForLogAfter(logs, fromIndex, pattern, timeout = 30000, pollInterval = 300) {
  const start = Date.now()
  let lastChecked = fromIndex
  while (Date.now() - start < timeout) {
    for (let i = lastChecked; i < logs.length; i++) {
      const match = typeof pattern === 'string'
        ? logs[i].includes(pattern)
        : pattern.test(logs[i])
      if (match) return logs[i]
    }
    lastChecked = logs.length
    await new Promise(r => setTimeout(r, pollInterval))
  }
  return null
}

const LOG_FILTER = /GeminiSpinner|busy-state|Gemini.*Sniper|gemini:spawn|gemini:send|send-command|safePaste/i

function startHeartbeat(label, intervalMs = 5000) {
  let count = 0
  const timer = setInterval(() => {
    count++
    process.stdout.write(`${c.dim}  ...${label} ${count * (intervalMs/1000)}s${c.reset}\n`)
  }, intervalMs)
  return () => clearInterval(timer)
}

async function main() {
  log.step('Launching Noted Terminal...')

  const { app, page, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 4000
  })

  // Stream relevant logs in real time
  let lastLogIdx = 0
  const logPump = setInterval(() => {
    for (let i = lastLogIdx; i < mainProcessLogs.length; i++) {
      if (LOG_FILTER.test(mainProcessLogs[i])) {
        console.log(`${c.dim}  [main] ${mainProcessLogs[i].replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 140)}${c.reset}`)
      }
    }
    lastLogIdx = mainProcessLogs.length
  }, 300)

  log.pass('App launched')

  try {
    // === T1: Terminal ready ===
    log.step('T1: Waiting for terminal...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal visible')

    // === T2: Create fresh tab (state isolation) ===
    log.step('T2: Creating fresh tab for isolation...')
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
    log.pass('Fresh tab created')

    // === T3: Start Gemini via IPC (spawn-with-watcher) ===
    log.step('T3: Starting Gemini CLI via IPC...')
    const activeTabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tabId = p?.activeTabId
      if (tabId) {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('gemini:spawn-with-watcher', {
          tabId,
          cwd: s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.get?.(tabId)?.cwd || process.cwd()
        })
      }
      return tabId
    })
    assert(!!activeTabId, `Gemini spawn-with-watcher sent for tab: ${activeTabId}`)

    // === T4: Wait for Gemini session detection ===
    log.step('T4: Waiting for Gemini session ID...')
    const stopHb1 = startHeartbeat('waiting-gemini-session')
    try {
      await waitForGeminiSessionId(page, 45000)
      log.pass('Gemini session ID captured')
    } catch {
      log.warn('Gemini session ID timeout (continuing)')
    }
    stopHb1()

    // === T5: Wait for startup spinner to settle (THINKING→IDLE) ===
    log.step('T5: Waiting for Gemini startup to settle...')
    const stopHb2 = startHeartbeat('waiting-startup-idle')
    const startupIdle = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, /GeminiSpinner.*IDLE/, 30000),
      35000, 'Gemini startup IDLE'
    )
    stopHb2()
    if (startupIdle) {
      log.pass('Gemini startup spinner settled (THINKING→IDLE)')
    } else {
      log.warn('No startup spinner detected (may be fast startup)')
    }
    await page.waitForTimeout(2000)

    // Record baseline: all further checks start from this index
    const baselineLogCount = mainProcessLogs.length
    log.info(`Baseline log index: ${baselineLogCount}`)

    // === T6: Send prompt via gemini:send-command IPC ===
    log.step('T6: Sending prompt to Gemini via IPC...')
    const promptText = 'Write a detailed 200-word explanation of how TCP/IP works, including the 4 layers of the protocol stack'

    // Re-read active tabId (may have changed after session detection)
    const currentTabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.activeTabId
    })
    log.info(`Using tabId: ${currentTabId} (original: ${activeTabId})`)

    const sendResult = await page.evaluate(({ tabId, text }) => {
      try {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('gemini:send-command', tabId, text)
        return { ok: true, tabId }
      } catch (err) {
        return { ok: false, error: err.message }
      }
    }, { tabId: currentTabId, text: promptText })
    log.info(`Send result: ${JSON.stringify(sendResult)}`)
    assert(sendResult.ok, `Prompt sent via gemini:send-command`)

    // === T7: Wait for THINKING (post-baseline only) ===
    log.step('T7: Waiting for [GeminiSpinner] THINKING...')
    const stopHb3 = startHeartbeat('waiting-thinking')
    const thinkingLog = await withTimeout(
      waitForLogAfter(mainProcessLogs, baselineLogCount, /GeminiSpinner.*THINKING/, 30000),
      35000, 'GeminiSpinner THINKING detection'
    )
    stopHb3()
    assert(!!thinkingLog, `GeminiSpinner THINKING detected: ${thinkingLog?.replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 100) || 'N/A'}`)

    // === T8: Wait for IDLE (post-baseline only) ===
    log.step('T8: Waiting for [GeminiSpinner] IDLE (response complete)...')
    const stopHb4 = startHeartbeat('waiting-idle')
    const idleLog = await withTimeout(
      waitForLogAfter(mainProcessLogs, baselineLogCount, /GeminiSpinner.*IDLE/, 60000),
      65000, 'GeminiSpinner IDLE detection'
    )
    stopHb4()
    assert(!!idleLog, `GeminiSpinner IDLE detected: ${idleLog?.replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 100) || 'N/A'}`)

    // === T9: Verify both transitions in post-baseline logs ===
    log.step('T9: Verify THINKING→IDLE transition pair (after prompt)')
    const postBaselineLogs = mainProcessLogs.slice(baselineLogCount)
    const allGeminiLogs = postBaselineLogs.filter(l => l.includes('[GeminiSpinner]'))
    log.info(`Post-prompt [GeminiSpinner] log entries: ${allGeminiLogs.length}`)
    allGeminiLogs.forEach(l => log.info(`  ${l.replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 120)}`))

    const hasThinking = allGeminiLogs.some(l => l.includes('THINKING'))
    const hasIdle = allGeminiLogs.some(l => l.includes('IDLE'))
    assert(hasThinking, 'Has THINKING transition in post-prompt logs')
    assert(hasIdle, 'Has IDLE transition in post-prompt logs')

    // === SUMMARY ===
    clearInterval(logPump)
    console.log('\n' + '='.repeat(45))
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) { process.exitCode = 1; log.fail('SOME TESTS FAILED') }
    else log.pass('ALL TESTS PASSED')
    console.log('='.repeat(45))

  } finally {
    clearTimeout(globalTimer)
    clearInterval(logPump)
    log.info('Closing app...')
    await app.close().catch(() => {})
  }
}

main().catch(err => {
  console.error(`\n${c.red}[FATAL]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
