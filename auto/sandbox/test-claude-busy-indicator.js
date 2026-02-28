/**
 * Test: Claude spinner busy indicator detection
 * [E2E+Claude] — Requires live `claude` CLI
 *
 * Verifies:
 * 1. Spinner detection (✢✳✶✻✽·) triggers claude:busy-state { busy: true }
 * 2. Prompt return (⏵) triggers claude:busy-state { busy: false }
 * 3. Main process logs show [Spinner] BUSY / IDLE transitions
 *
 * Запуск: node auto/sandbox/test-claude-busy-indicator.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId,
        waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

const GLOBAL_MS = 120000
const globalTimer = setTimeout(() => {
  console.error('\n\x1b[31m[KILL] 120s global timeout\x1b[0m')
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

const LOG_FILTER = /Spinner|busy-state|BoundaryMarker|Handshake|Prompt detect|Sniper|Session detect/i

async function main() {
  log.step('Launching Noted Terminal...')

  const { app, page, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 4000
  })

  // Stream relevant logs
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
    // ═══ T1: Terminal ready ═══
    log.step('T1: Waiting for terminal...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal visible')

    // ═══ T2: Start Claude ═══
    log.step('T2: Starting claude...')
    await typeCommand(page, 'claude --dangerously-skip-permissions')
    log.pass('claude command sent')

    // ═══ T3: Wait for session ═══
    log.step('T3: Waiting for Claude session ID...')
    try {
      await waitForClaudeSessionId(page, 30000)
      log.pass('Session ID captured')
    } catch {
      log.warn('Session ID timeout (continuing — may still work)')
    }

    // Extra wait for Claude to fully render
    await page.waitForTimeout(2000)

    // ═══ T4: Verify no busy state at idle ═══
    log.step('T4: Verify NOT busy at idle prompt')
    const busyBeforePrompt = findInLogs(mainProcessLogs, '[Spinner]')
    assert(busyBeforePrompt.length === 0, `No spinner detected at idle (got ${busyBeforePrompt.length})`)

    // ═══ T5: Send prompt to trigger thinking ═══
    log.step('T5: Sending prompt to trigger thinking...')
    await typeCommand(page, 'say exactly one word: BUSYTEST')
    log.info('Prompt sent, waiting for spinner detection...')

    // ═══ T6: Wait for BUSY ═══
    log.step('T6: Waiting for [Spinner] BUSY...')
    const busyLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, '[Spinner]', 20000),
      25000, 'Spinner BUSY detection'
    )
    assert(!!busyLog, `Spinner BUSY detected: ${busyLog?.slice(0, 80) || 'N/A'}`)

    // ═══ T7: Wait for IDLE ═══
    log.step('T7: Waiting for [Spinner] IDLE (prompt return)...')
    const idleLog = await withTimeout(
      waitForMainProcessLog(mainProcessLogs, 'IDLE', 45000),
      50000, 'Spinner IDLE detection'
    )
    assert(!!idleLog, `Spinner IDLE detected: ${idleLog?.slice(0, 80) || 'N/A'}`)

    // ═══ T8: Verify both transitions ═══
    log.step('T8: Verify transition pair')
    const allSpinnerLogs = findInLogs(mainProcessLogs, '[Spinner]')
    log.info(`Total [Spinner] log entries: ${allSpinnerLogs.length}`)
    allSpinnerLogs.forEach(l => log.info(`  ${l.replace(/^\[(stdout|stderr)\]\s*/, '').trim().slice(0, 120)}`))

    const hasBusy = allSpinnerLogs.some(l => l.includes('BUSY'))
    const hasIdle = allSpinnerLogs.some(l => l.includes('IDLE'))
    assert(hasBusy, 'Has BUSY transition')
    assert(hasIdle, 'Has IDLE transition')

    // ═══ SUMMARY ═══
    clearInterval(logPump)
    console.log('\n' + '═'.repeat(45))
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) { process.exitCode = 1; log.fail('SOME TESTS FAILED') }
    else log.pass('ALL TESTS PASSED')
    console.log('═'.repeat(45))

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
