/**
 * [E2E+Claude] Scroll Jitter Diagnostic
 *
 * Measures scroll jitter during Claude output on a long session (lots of scrollback).
 *
 * Flow:
 * 1. Fork source session (copy JSONL) → fresh UUID
 * 2. New tab → cd → claude -r <fork-uuid> --model haiku
 * 3. Wait for Spinner IDLE (deterministic)
 * 4. Inject scroll monitor on visible viewport
 * 5. Send prompt → Spinner BUSY → IDLE
 * 6. Analyze scroll events
 * 7. Cleanup: delete forked JSONL
 *
 * node auto/sandbox/test-scroll-jitter.js 2>&1 | tee /tmp/scroll-jitter.log
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog } = require('../core/launcher')
const electron = require('../core/electron')

// ── Config ──
const SOURCE_SESSION = '8cbda5e3-8f02-4811-991b-9d8d857135e7'
const PROJECT_SLUG = '-Users-fedor-Desktop-custom-terminal'
const SESSIONS_DIR = path.join(process.env.HOME, '.claude', 'projects', PROJECT_SLUG)
const PROJECT_DIR = '/Users/fedor/Desktop/custom-terminal'

// ── Logging ──
const c = { R: '\x1b[0m', G: '\x1b[32m', F: '\x1b[31m', C: '\x1b[36m', Y: '\x1b[33m', D: '\x1b[2m', B: '\x1b[1m' }
const log = {
  step: m => console.log(`${c.C}[STEP]${c.R} ${m}`),
  pass: m => console.log(`${c.G}[PASS]${c.R} ${m}`),
  fail: m => console.log(`${c.F}[FAIL]${c.R} ${m}`),
  warn: m => console.log(`${c.Y}[WARN]${c.R} ${m}`),
  info: m => console.log(`${c.D}[INFO]${c.R} ${m}`)
}

let passed = 0, failed = 0
const assert = (ok, msg) => { ok ? (log.pass(msg), passed++) : (log.fail(msg), failed++) }

const HARD_KILL = setTimeout(() => { console.error('\n[FATAL] 3min timeout'); process.exit(2) }, 180000)

// ── Fork session (copy JSONL with new UUID) ──
function forkSession() {
  const forkId = crypto.randomUUID()
  const src = path.join(SESSIONS_DIR, `${SOURCE_SESSION}.jsonl`)
  const dst = path.join(SESSIONS_DIR, `${forkId}.jsonl`)

  if (!fs.existsSync(src)) throw new Error(`Source session not found: ${src}`)

  fs.copyFileSync(src, dst)
  const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1)
  log.info(`Forked session: ${forkId.slice(0, 8)}... (${sizeMB}MB)`)
  return { forkId, forkPath: dst }
}

// ── Cleanup forked session ──
function cleanupFork(forkPath) {
  try {
    if (fs.existsSync(forkPath)) {
      fs.unlinkSync(forkPath)
      log.info('Forked session deleted')
    }
  } catch (e) {
    log.warn(`Cleanup failed: ${e.message}`)
  }
}

async function main() {
  // Step 0: Fork session before app launch
  log.step('Forking source session...')
  const { forkId, forkPath } = forkSession()

  log.step('Launching app...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: false, waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal ready')

    // ── Dismiss recovery modal if present ──
    const modalBtn = page.locator('div.absolute.inset-0.z-50 button').first()
    if (await modalBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      log.info('Dismissing recovery modal')
      await modalBtn.click()
      await page.waitForTimeout(1500)
    }

    // ── New tab (state isolation per context.md §2) ──
    log.step('Creating new tab...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    await typeCommand(page, `cd ${PROJECT_DIR}`)
    await page.waitForTimeout(1500)

    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore.getState()
      const p = s.openProjects.get(s.activeProjectId)
      return p?.activeTabId
    })
    log.info(`Tab: ${tabId}`)

    // ── Launch Claude with forked session ──
    log.step('Launching Claude (forked session)...')
    await typeCommand(page, `claude -r ${forkId}`)

    log.step('Waiting for session ID...')
    try {
      await waitForClaudeSessionId(page, 60000)
      log.pass('Session ID detected')
    } catch {
      log.warn('Session ID timeout — continuing with Spinner detection')
    }

    // ── Wait for Claude ready (deterministic: Spinner IDLE) ──
    log.step('Waiting for Spinner IDLE (Claude ready)...')
    const idle = await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE/, 45000, 200)
    assert(!!idle, 'Claude prompt ready (Spinner IDLE)')
    await page.waitForTimeout(500)

    // ── Inject scroll diagnostics ──
    log.step('Injecting scroll monitor...')
    const injected = await page.evaluate(() => {
      window.__sd = { events: [], jitter: 0, maxEps: 0, t0: Date.now() }

      // Find ACTUALLY visible viewport (visibility:hidden has nonzero rects)
      let vp = null
      for (const el of document.querySelectorAll('.xterm-viewport')) {
        if (window.getComputedStyle(el).visibility !== 'hidden' &&
            el.getBoundingClientRect().height > 50) { vp = el; break }
      }
      if (!vp) return 'no-viewport'

      let lastY = vp.scrollTop, lastDir = 0, epsCount = 0, epsSec = 0
      vp.addEventListener('scroll', () => {
        const y = vp.scrollTop
        if (Math.abs(y - lastY) < 0.5) return
        const dir = y > lastY ? 1 : -1, now = Date.now()
        if (dir !== lastDir && lastDir !== 0) window.__sd.jitter++
        const s = Math.floor(now / 1000)
        if (s === epsSec) epsCount++
        else { if (epsCount > window.__sd.maxEps) window.__sd.maxEps = epsCount; epsCount = 1; epsSec = s }
        window.__sd.events.push({ t: now - window.__sd.t0, y: Math.round(y), d: Math.round(y - lastY) })
        if (window.__sd.events.length > 3000) window.__sd.events = window.__sd.events.slice(-2000)
        lastY = y; lastDir = dir
      })
      return `ok:y=${Math.round(vp.scrollTop)},h=${vp.scrollHeight}`
    })
    assert(injected.startsWith('ok'), `Scroll monitor on viewport (${injected})`)

    // ── Send prompt ──
    log.step('Sending prompt...')
    await typeCommand(page, 'List numbers 1 to 100, each on its own line. Format: "N - word". Plain text, no code blocks.')

    // ── Spinner BUSY → IDLE (deterministic) ──
    log.step('Waiting for Spinner BUSY...')
    const busy = await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*BUSY/, 30000, 150)
    assert(!!busy, 'Spinner BUSY (processing)')

    const hb = setInterval(async () => {
      try {
        const d = await page.evaluate(() => ({
          n: window.__sd.events.length, j: window.__sd.jitter, m: window.__sd.maxEps
        }))
        log.info(`events=${d.n} jitter=${d.j} maxEps=${d.m}`)
      } catch {}
    }, 4000)

    log.step('Waiting for Spinner IDLE...')
    const done = await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE/, 90000, 150)
    assert(!!done, 'Spinner IDLE (response done)')
    await page.waitForTimeout(1500)
    clearInterval(hb)

    // ── Analyze ──
    log.step('Analyzing...')
    const r = await page.evaluate(() => {
      const ev = window.__sd.events
      const buckets = {}
      for (const e of ev) { const s = Math.floor(e.t / 1000); buckets[s] = (buckets[s] || 0) + 1 }
      const eps = Object.values(buckets)
      const jitters = []
      for (let i = 1; i < ev.length; i++) {
        if ((ev[i].d > 0 && ev[i - 1].d < 0) || (ev[i].d < 0 && ev[i - 1].d > 0)) {
          if (ev[i].t - ev[i - 1].t < 100)
            jitters.push({ t: ev[i].t, from: ev[i - 1].y, to: ev[i].y, dt: ev[i].t - ev[i - 1].t })
        }
      }
      return {
        total: ev.length, jitter: window.__sd.jitter,
        maxEps: Math.max(window.__sd.maxEps, ...eps, 0),
        avgEps: eps.length ? Math.round(eps.reduce((a, b) => a + b, 0) / eps.length) : 0,
        jitters: jitters.slice(0, 20),
        dur: ev.length > 1 ? ev[ev.length - 1].t - ev[0].t : 0,
        buckets,
        sample: ev.length <= 40 ? ev : [...ev.slice(0, 20), ...ev.slice(-20)]
      }
    })

    // ── Report ──
    console.log('\n' + '═'.repeat(60))
    console.log(`${c.B}  SCROLL JITTER REPORT${c.R}`)
    console.log('═'.repeat(60))
    console.log(`  Total scroll events:  ${r.total}`)
    console.log(`  Duration:             ${(r.dur / 1000).toFixed(1)}s`)
    console.log(`  Avg events/sec:       ${r.avgEps}`)
    console.log(`  Max events/sec:       ${r.maxEps}`)
    console.log(`  Jitter (dir flips):   ${r.jitter}`)
    console.log(`  Jitter <100ms:        ${r.jitters.length}`)

    const keys = Object.keys(r.buckets).sort((a, b) => a - b)
    if (keys.length) {
      console.log('\n  Events/second:')
      for (const k of keys) {
        const n = r.buckets[k]
        const color = n > 50 ? c.F : n > 20 ? c.Y : c.G
        console.log(`  ${k}s: ${color}${'█'.repeat(Math.min(n, 60))}${c.R} ${n}`)
      }
    }

    if (r.jitters.length) {
      console.log(`\n${c.Y}  Jitter samples (<100ms dir change):${c.R}`)
      for (const j of r.jitters.slice(0, 10))
        console.log(`    t=${j.t}ms  ${j.from}→${j.to}  Δ${j.dt}ms`)
    }

    if (r.sample.length) {
      console.log('\n  Scroll trace:')
      for (const e of r.sample.slice(0, 20))
        console.log(`    ${e.d > 0 ? '↓' : '↑'} t=${e.t}ms y=${e.y} Δ=${e.d}`)
    }
    console.log('═'.repeat(60))

    assert(r.total > 0, `Got scroll events (${r.total})`)
    assert(r.maxEps < 200, `Max eps ${r.maxEps} < 200`)
    assert(r.jitters.length < 10, `Jitter seqs ${r.jitters.length} < 10`)
    assert(r.jitter < 30, `Dir flips ${r.jitter} < 30`)

    console.log(`\n${c.B}Result: ${passed} passed, ${failed} failed${c.R}`)
    if (failed > 0) process.exitCode = 1

  } finally {
    clearTimeout(HARD_KILL)
    await app.close().catch(() => {})
    // Cleanup: delete forked session to save disk space
    cleanupFork(forkPath)
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1) })
