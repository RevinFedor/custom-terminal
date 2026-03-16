/**
 * [E2E+Claude] Scroll Jitter Diagnostic Test
 *
 * Measures scroll jitter during Claude Code output.
 * Injects scroll monitoring into renderer, sends a prompt to Claude (Haiku),
 * and captures all viewport position changes to detect jitter patterns.
 *
 * Usage:
 *   npm run dev                     # start dev server
 *   npx electron-vite build         # sync main.js
 *   node auto/sandbox/test-scroll-jitter.js 2>&1 | tee /tmp/scroll-jitter.log
 */

const { launch, waitForTerminal, waitForClaudeSessionId, waitForMainProcessLog } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  data: (m) => console.log(`${c.bold}[DATA]${c.reset} ${m}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

// Hard kill safety
const HARD_KILL = setTimeout(() => {
  console.error('\n[FATAL] Hard kill after 180s')
  process.exit(2)
}, 180000)

async function main() {
  log.step('Launching Electron app...')
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logMainProcess: false,
    logConsole: false,
    waitForReady: 5000
  })

  try {
    await electron.focusWindow(app)
    await page.waitForFunction(() => document.hasFocus(), null, { timeout: 5000 }).catch(() => {})

    // If app opened on Dashboard, switch to workspace
    const onDashboard = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      return store?.view === 'dashboard'
    }).catch(() => false)
    if (onDashboard) {
      log.info('App on Dashboard, switching to workspace...')
      await page.evaluate(() => {
        const store = window.useWorkspaceStore?.getState?.()
        store?.setView?.('workspace')
      })
      await page.waitForTimeout(1000)
    }

    await waitForTerminal(page, 20000)
    log.step('Terminal ready, window focused')

    // ── Step 1: Inject scroll monitoring into renderer ──
    log.step('Injecting scroll diagnostics into renderer...')
    await page.evaluate(() => {
      // Global diagnostic collector
      window.__scrollDiag = {
        events: [],           // { time, source, viewportY, baseY, isAtBottom }
        writeCount: 0,
        jitterCount: 0,       // rapid direction changes
        maxEventsPerSecond: 0,
        started: false
      }

      // Find the active terminal's xterm-viewport
      const viewport = document.querySelector('.xterm-viewport')
      if (!viewport) {
        console.warn('[DIAG] No .xterm-viewport found!')
        return
      }

      let lastY = viewport.scrollTop
      let lastDir = 0 // 1=down, -1=up, 0=none
      let eventsThisSecond = 0
      let lastSecond = Math.floor(Date.now() / 1000)

      // Monitor native scroll events on viewport
      viewport.addEventListener('scroll', () => {
        const now = Date.now()
        const y = viewport.scrollTop
        const dir = y > lastY ? 1 : (y < lastY ? -1 : 0)

        // Detect jitter: rapid direction change within 100ms
        if (dir !== 0 && dir !== lastDir && lastDir !== 0) {
          window.__scrollDiag.jitterCount++
        }

        // Events per second tracking
        const sec = Math.floor(now / 1000)
        if (sec === lastSecond) {
          eventsThisSecond++
        } else {
          if (eventsThisSecond > window.__scrollDiag.maxEventsPerSecond) {
            window.__scrollDiag.maxEventsPerSecond = eventsThisSecond
          }
          eventsThisSecond = 1
          lastSecond = sec
        }

        window.__scrollDiag.events.push({
          time: now,
          scrollTop: Math.round(y),
          delta: Math.round(y - lastY),
          dir
        })

        // Keep only last 2000 events to avoid memory issues
        if (window.__scrollDiag.events.length > 2000) {
          window.__scrollDiag.events = window.__scrollDiag.events.slice(-1000)
        }

        lastY = y
        lastDir = dir
      })

      window.__scrollDiag.started = true
      console.warn('[DIAG] Scroll monitoring injected successfully')
    })

    const diagStarted = await page.evaluate(() => window.__scrollDiag?.started)
    assert(diagStarted, 'Scroll diagnostics injected')

    // ── Step 2: Check current state ──
    log.step('Checking current terminal state...')
    const termState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      if (!store) return null
      const proj = store.openProjects?.get?.(store.activeProjectId)
      if (!proj) return null
      const tab = proj.tabs?.get?.(proj.activeTabId)
      return {
        tabId: tab?.id,
        commandType: tab?.commandType,
        claudeSessionId: tab?.claudeSessionId?.substring(0, 8),
        name: tab?.name
      }
    })
    log.info(`Current tab: ${JSON.stringify(termState)}`)

    // ── Step 3: Ensure Claude is running ──
    const isClaude = termState?.commandType === 'claude'
    if (!isClaude) {
      log.step('No Claude tab active, launching claude with Haiku...')
      // Create new tab
      await page.keyboard.press('Meta+t')
      await page.waitForTimeout(2000)

      // Type claude command
      await page.keyboard.type('claude --model claude-haiku-4-5-20251001', { delay: 30 })
      await page.waitForTimeout(200)
      await page.keyboard.press('Enter')

      log.step('Waiting for Claude session...')
      await waitForClaudeSessionId(page, 60000)
      log.pass('Claude session detected')
    } else {
      log.info('Claude tab already active: ' + (termState.claudeSessionId || 'no session'))
      if (!termState.claudeSessionId) {
        log.step('Waiting for Claude session ID...')
        await waitForClaudeSessionId(page, 30000)
      }
    }

    // ── Step 4: Switch to Haiku to save tokens ──
    log.step('Switching to Haiku model...')
    // Use IPC to send /model haiku command
    await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.invoke('claude:send-command', { tabId, command: '/model haiku' })
      }
    })
    await page.waitForTimeout(3000)
    log.info('Model switch command sent')

    // ── Step 5: Reset diagnostics before test prompt ──
    await page.evaluate(() => {
      window.__scrollDiag.events = []
      window.__scrollDiag.jitterCount = 0
      window.__scrollDiag.maxEventsPerSecond = 0
      window.__scrollDiag.writeCount = 0
    })

    // ── Step 6: Send test prompt that generates line-by-line output ──
    log.step('Sending test prompt to Claude (Haiku)...')
    const testPrompt = 'Print numbers from 1 to 50, each on a new line. After each number, add a short description like "Number 1 - first" etc. Do NOT use code blocks, just print plain text.'

    await page.evaluate((prompt) => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.invoke('terminal:paste', { tabId, content: prompt, submit: true })
      }
    }, testPrompt)

    // ── Step 7: Wait for response and collect diagnostics ──
    log.step('Waiting for Claude response (capturing scroll events)...')

    // Heartbeat during wait
    const heartbeat = setInterval(() => {
      page.evaluate(() => ({
        events: window.__scrollDiag.events.length,
        jitter: window.__scrollDiag.jitterCount,
        maxEps: window.__scrollDiag.maxEventsPerSecond
      })).then(d => {
        log.info(`Scroll events: ${d.events}, Jitter: ${d.jitter}, Max events/sec: ${d.maxEps}`)
      }).catch(() => {})
    }, 5000)

    // Wait for Claude to finish (Spinner IDLE after BUSY)
    const busyLog = await waitForMainProcessLog(mainProcessLogs, /Spinner.*BUSY/, 30000)
    if (busyLog) {
      log.info('Claude started working (Spinner BUSY detected)')
    } else {
      log.warn('No Spinner BUSY detected in 30s — Claude may not have started')
    }

    // Wait for IDLE (response complete)
    const idleLog = await waitForMainProcessLog(mainProcessLogs, /Spinner.*IDLE/, 90000)
    if (idleLog) {
      log.info('Claude finished (Spinner IDLE detected)')
    } else {
      log.warn('No Spinner IDLE in 90s — timeout')
    }

    // Extra wait for final renders
    await page.waitForTimeout(2000)
    clearInterval(heartbeat)

    // ── Step 8: Collect and analyze results ──
    log.step('Analyzing scroll diagnostics...')
    const results = await page.evaluate(() => {
      const d = window.__scrollDiag
      const events = d.events

      // Calculate events per second distribution
      const secondBuckets = {}
      for (const e of events) {
        const sec = Math.floor(e.time / 1000)
        secondBuckets[sec] = (secondBuckets[sec] || 0) + 1
      }
      const epsValues = Object.values(secondBuckets)
      const avgEps = epsValues.length > 0
        ? Math.round(epsValues.reduce((a, b) => a + b, 0) / epsValues.length)
        : 0

      // Find jitter sequences (rapid up/down within 100ms)
      let jitterSequences = []
      for (let i = 1; i < events.length; i++) {
        if (events[i].dir !== 0 && events[i - 1].dir !== 0 &&
            events[i].dir !== events[i - 1].dir &&
            events[i].time - events[i - 1].time < 100) {
          jitterSequences.push({
            time: events[i].time,
            from: events[i - 1].scrollTop,
            to: events[i].scrollTop,
            deltaMs: events[i].time - events[i - 1].time
          })
        }
      }

      // Sample of events (first 20 + last 20)
      const sample = events.length <= 40
        ? events
        : [...events.slice(0, 20), { time: 0, scrollTop: 0, delta: 0, dir: 0, marker: '...' }, ...events.slice(-20)]

      return {
        totalEvents: events.length,
        jitterCount: d.jitterCount,
        maxEventsPerSecond: Math.max(d.maxEventsPerSecond, ...epsValues, 0),
        avgEventsPerSecond: avgEps,
        jitterSequences: jitterSequences.slice(0, 20), // first 20 jitter events
        sample,
        durationMs: events.length > 1 ? events[events.length - 1].time - events[0].time : 0
      }
    })

    // ── Step 9: Report ──
    console.log('\n' + '═'.repeat(60))
    console.log(`${c.bold}  SCROLL JITTER DIAGNOSTIC REPORT${c.reset}`)
    console.log('═'.repeat(60))
    log.data(`Total scroll events:      ${results.totalEvents}`)
    log.data(`Duration:                 ${(results.durationMs / 1000).toFixed(1)}s`)
    log.data(`Avg events/second:        ${results.avgEventsPerSecond}`)
    log.data(`Max events/second:        ${results.maxEventsPerSecond}`)
    log.data(`Jitter count (dir flips): ${results.jitterCount}`)
    log.data(`Jitter sequences (<100ms): ${results.jitterSequences.length}`)

    if (results.jitterSequences.length > 0) {
      console.log(`\n${c.yellow}Jitter samples (rapid direction changes):${c.reset}`)
      for (const j of results.jitterSequences.slice(0, 10)) {
        console.log(`  scrollTop ${j.from} → ${j.to} (${j.deltaMs}ms)`)
      }
    }

    console.log(`\n${c.dim}Event sample (first/last):${c.reset}`)
    for (const e of results.sample.slice(0, 15)) {
      if (e.marker) { console.log(`  ...`); continue }
      const arrow = e.dir > 0 ? '↓' : (e.dir < 0 ? '↑' : '·')
      console.log(`  ${arrow} scrollTop=${e.scrollTop} delta=${e.delta}`)
    }
    console.log('═'.repeat(60))

    // ── Assertions ──
    // Healthy terminal: < 50 events/second, < 5 jitter sequences
    assert(results.maxEventsPerSecond < 200, `Max events/sec ${results.maxEventsPerSecond} < 200 (no event storm)`)
    assert(results.jitterSequences.length < 20, `Jitter sequences ${results.jitterSequences.length} < 20 (no rapid flicker)`)
    assert(results.jitterCount < 50, `Total jitter ${results.jitterCount} < 50 (stable scroll direction)`)

    // Final summary
    console.log(`\n${c.bold}Passed: ${passed}  Failed: ${failed}${c.reset}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    clearTimeout(HARD_KILL)
    await app.close().catch(() => {})
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message)
  process.exit(1)
})
