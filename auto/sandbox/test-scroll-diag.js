/**
 * [E2E+Claude] Scroll Diagnostic
 *
 * Fork session, resume claude, send prompt, scroll up via term.scrollLines(),
 * wait, check if scroll position preserved.
 *
 * npx electron-vite build && node auto/sandbox/test-scroll-diag.js 2>&1 | tee /tmp/scroll-diag.log
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

const SOURCE_SESSION = '2fa76efe-b5e0-4dfe-8110-d5fd6739039d'
const PROJECT_SLUG = '-Users-fedor-Desktop-custom-terminal'
const SESSIONS_DIR = path.join(process.env.HOME, '.claude', 'projects', PROJECT_SLUG)
const PROJECT_DIR = '/Users/fedor/Desktop/custom-terminal'

const PROMPT = `Сейчас я хочу кое-что протестировать, точнее формат клауди, как он отвечает. Можешь сейчас написать одну, короче прочитать файл любой, одну строчку. Потом написать в ответе, что ты прочитал строчку, потом прочитать новый файл, также написать в ответе и так пока я тебя не останавливаю. Это пока что тестирование мета.`

const c = { R: '\x1b[0m', G: '\x1b[32m', F: '\x1b[31m', C: '\x1b[36m', Y: '\x1b[33m', D: '\x1b[2m' }
const log = {
  step: m => console.log(`${c.C}[STEP]${c.R} ${m}`),
  pass: m => console.log(`${c.G}[PASS]${c.R} ${m}`),
  fail: m => console.log(`${c.F}[FAIL]${c.R} ${m}`),
  warn: m => console.log(`${c.Y}[WARN]${c.R} ${m}`),
  info: m => console.log(`${c.D}[INFO]${c.R} ${m}`)
}

let passed = 0, failed = 0
const assert = (ok, msg) => { ok ? (log.pass(msg), passed++) : (log.fail(msg), failed++) }
const HARD_KILL = setTimeout(() => { console.log('[HARD_KILL] 120s timeout'); process.exit(2) }, 120000)

function forkSession() {
  const forkId = crypto.randomUUID()
  const src = path.join(SESSIONS_DIR, `${SOURCE_SESSION}.jsonl`)
  const dst = path.join(SESSIONS_DIR, `${forkId}.jsonl`)
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`)
  fs.copyFileSync(src, dst)
  return { forkId, forkPath: dst }
}

async function main() {
  log.step('Forking session...')
  const { forkId, forkPath } = forkSession()
  log.info(`Fork: ${forkId}`)

  log.step('Launching app...')
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: true, waitForReady: 4000
  })

  // Capture ScrollDiag into consoleLogs (launcher captures all, but also print)
  page.on('console', msg => {
    const t = msg.text()
    if (t.includes('ScrollDiag')) {
      consoleLogs.push(t)
      console.log(`${c.Y}[DIAG]${c.R} ${t}`)
    }
  })

  try {
    log.step('Waiting for terminal...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal ready')

    log.step('New tab (Cmd+T)...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)
    log.pass('Tab created')

    log.step(`cd ${PROJECT_DIR}`)
    await typeCommand(page, `cd ${PROJECT_DIR}`)
    await page.waitForTimeout(2000)

    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore.getState()
      return s.openProjects.get(s.activeProjectId)?.activeTabId
    })
    log.info(`tabId: ${tabId}`)

    // Launch claude with resume
    log.step('Launching claude -r ...')
    await typeCommand(page, `claude -r ${forkId}`)

    log.step('Waiting for session ID...')
    try { await waitForClaudeSessionId(page, 60000); log.pass('Session ID captured') }
    catch { log.warn('Session ID timeout') }

    log.step('Waiting for Spinner IDLE...')
    try { await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE/, 45000); log.pass('Claude prompt ready') }
    catch { log.warn('Spinner IDLE timeout') }

    await page.screenshot({ path: '/tmp/scroll-diag-1-before-prompt.png' })

    // Send prompt via keyboard
    log.step('Typing prompt...')
    await page.keyboard.type(PROMPT, { delay: 10 })
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')

    // Wait for Claude to start working
    log.step('Waiting for Spinner BUSY...')
    const busyIdx = mainProcessLogs.length
    try { await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*BUSY/, 30000, 200, busyIdx); log.pass('Claude is working') }
    catch { log.warn('Spinner BUSY timeout') }

    // Wait for some output
    await page.waitForTimeout(3000)
    await page.screenshot({ path: '/tmp/scroll-diag-2-before-scroll.png' })

    // === KEY: Scroll up using mouse.wheel — triggers real DOM scroll event ===
    // term.scrollLines() does NOT trigger DOM scroll event (xterm.js #3201),
    // so our userScrollTopRef tracking wouldn't catch it.
    log.step('Scrolling up via mouse.wheel...')
    const termScreen = page.locator('.xterm-screen').last()
    await termScreen.hover()
    await page.mouse.wheel(0, -500) // scroll up ~500px (~30 rows)
    await page.waitForTimeout(300) // let scroll events + rAF fire

    // Verify we actually scrolled up
    const afterScroll = await page.evaluate((tid) => {
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(tid)
      if (!term) return null
      const buf = term.buffer.active
      return { viewportY: buf.viewportY, baseY: buf.baseY, isAtBottom: buf.viewportY >= buf.baseY }
    }, tabId)
    log.info(`After scroll: ${JSON.stringify(afterScroll)}`)
    if (afterScroll) {
      assert(!afterScroll.isAtBottom, `User scrolled up: viewportY=${afterScroll.viewportY} baseY=${afterScroll.baseY}`)
    }

    await page.screenshot({ path: '/tmp/scroll-diag-3-scrolled-up.png' })

    // Wait 5s — Claude is writing, check if scroll holds
    log.step('Waiting 5s with scroll up...')
    await page.waitForTimeout(5000)

    const after5s = await page.evaluate((tid) => {
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(tid)
      if (!term) return null
      const buf = term.buffer.active
      const vp = term.element?.querySelector('.xterm-viewport')
      return {
        viewportY: buf.viewportY,
        baseY: buf.baseY,
        isAtBottom: buf.viewportY >= buf.baseY,
        scrollTop: vp ? Math.round(vp.scrollTop) : null
      }
    }, tabId)
    log.info(`After 5s: ${JSON.stringify(after5s)}`)
    await page.screenshot({ path: '/tmp/scroll-diag-4-after-5s.png' })

    if (after5s && afterScroll) {
      assert(after5s.viewportY > 0, `viewportY > 0 (got ${after5s.viewportY})`)
      assert(!after5s.isAtBottom, `Still scrolled up after 5s (viewportY=${after5s.viewportY} baseY=${after5s.baseY})`)
      const drift = Math.abs(after5s.viewportY - afterScroll.viewportY)
      assert(drift < 50, `Scroll drift < 50 rows (got ${drift}: ${afterScroll.viewportY} → ${after5s.viewportY})`)
    }

    // Wait 10 more seconds
    log.step('Waiting 10s more...')
    await page.waitForTimeout(10000)

    const after15s = await page.evaluate((tid) => {
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(tid)
      if (!term) return null
      const buf = term.buffer.active
      return { viewportY: buf.viewportY, baseY: buf.baseY, isAtBottom: buf.viewportY >= buf.baseY }
    }, tabId)
    log.info(`After 15s: ${JSON.stringify(after15s)}`)
    await page.screenshot({ path: '/tmp/scroll-diag-5-after-15s.png' })

    if (after15s) {
      assert(after15s.viewportY > 0, `viewportY > 0 after 15s (got ${after15s.viewportY})`)
    }

    // Check ScrollDiag logs: no large jumps after user scroll-up (catches oscillation)
    const allLogs = [...mainProcessLogs, ...consoleLogs]
    const scrollDiagLogs = allLogs.filter(l => l.includes('ScrollDiag') && l.includes('isAtBottom=false'))
    if (scrollDiagLogs.length > 0) {
      const bigJumps = scrollDiagLogs.filter(l => {
        const m = l.match(/delta=(\d+)/)
        return m && parseInt(m[1]) > 100
      })
      assert(bigJumps.length === 0, `No jumps > 100 rows after scroll-up (found ${bigJumps.length})`)
      if (bigJumps.length > 0) {
        bigJumps.slice(0, 5).forEach(l => log.info(`  ${l.replace(/.*ScrollDiag\] /, '')}`))
      }
    } else {
      log.warn('No isAtBottom=false ScrollDiag logs found')
    }

    // Summary
    console.log(`\nPassed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    await app.close().catch(() => {})
    try { fs.unlinkSync(forkPath) } catch {}
    clearTimeout(HARD_KILL)
  }
}

main().catch(err => {
  console.error(`${c.F}[ERROR]${c.R}`, err.message)
  process.exit(1)
})
