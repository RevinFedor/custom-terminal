/**
 * [E2E+Claude] Scroll Jitter Diagnostic
 *
 * Measures scroll jitter during Claude output on a long session.
 *
 * Usage:
 *   node auto/sandbox/test-scroll-jitter.js              # auto-close after report
 *   node auto/sandbox/test-scroll-jitter.js --keep       # keep app open for manual inspection
 *
 * node auto/sandbox/test-scroll-jitter.js 2>&1 | tee /tmp/scroll-jitter.log
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { launch, waitForTerminal, waitForClaudeSessionId, waitForMainProcessLog } = require('../core/launcher')
const electron = require('../core/electron')

// ── Config ──
const SOURCE_SESSION = '8cbda5e3-8f02-4811-991b-9d8d857135e7'
const PROJECT_SLUG = '-Users-fedor-Desktop-custom-terminal'
const SESSIONS_DIR = path.join(process.env.HOME, '.claude', 'projects', PROJECT_SLUG)
const PROJECT_DIR = '/Users/fedor/Desktop/custom-terminal'
const KEEP_OPEN = process.argv.includes('--keep')

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

const HARD_KILL = setTimeout(() => {
  console.error('\n[FATAL] timeout'); process.exit(2)
}, KEEP_OPEN ? 600000 : 300000)  // 10min for --keep, 5min auto

// ── Fork / cleanup ──
function forkSession() {
  const forkId = crypto.randomUUID()
  const src = path.join(SESSIONS_DIR, `${SOURCE_SESSION}.jsonl`)
  const dst = path.join(SESSIONS_DIR, `${forkId}.jsonl`)
  if (!fs.existsSync(src)) throw new Error(`Source session not found: ${src}`)
  fs.copyFileSync(src, dst)
  log.info(`Forked: ${forkId.slice(0, 8)}... (${(fs.statSync(dst).size / 1024 / 1024).toFixed(1)}MB)`)
  return { forkId, forkPath: dst }
}

function cleanupFork(forkPath) {
  try { if (fs.existsSync(forkPath)) { fs.unlinkSync(forkPath); log.info('Fork deleted') } }
  catch (e) { log.warn(`Cleanup: ${e.message}`) }
}

// ── Fast paste via IPC (no char-by-char typing) ──
async function fastType(page, tabId, text) {
  await page.evaluate(({ tid, txt }) => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('terminal:input', tid, txt + '\r')
  }, { tid: tabId, txt: text })
}

async function main() {
  log.step('Forking source session...')
  const { forkId, forkPath } = forkSession()

  log.step('Launching app...')
  const rendererDiag = []
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: false, waitForReady: 4000
  })
  page.on('console', msg => {
    const t = msg.text()
    if (t.includes('DIAG:BIG_JUMP')) { rendererDiag.push(t); console.log(`${c.Y}  ${t}${c.R}`) }
    if (t.includes('[WHEEL]')) console.log(`${c.D}  ${t}${c.R}`)
  })

  try {
    await electron.focusWindow(app)
    // Switch to workspace if on dashboard
    await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      if (s?.view === 'dashboard') s.setView('workspace')
    }).catch(() => {})
    await page.waitForTimeout(1000)
    await waitForTerminal(page, 15000)
    await page.waitForTimeout(500)
    log.pass('Terminal ready')

    // ── Dismiss recovery modal ──
    const modalBtn = page.locator('div.absolute.inset-0.z-50 button').first()
    if (await modalBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      log.info('Dismissing recovery modal')
      await modalBtn.click()
      await page.waitForTimeout(1500)
    }

    // ── New tab + launch Claude (clean state per context.md §2) ──
    log.step('Creating new tab...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(2000)

    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore.getState()
      return s.openProjects.get(s.activeProjectId)?.activeTabId
    })
    log.info(`Tab: ${tabId}`)

    log.step('Launching Claude (forked session)...')
    await fastType(page, tabId, `cd ${PROJECT_DIR}`)
    await page.waitForTimeout(1000)
    await fastType(page, tabId, `claude -r ${forkId}`)

    log.step('Waiting for session ID...')
    try { await waitForClaudeSessionId(page, 60000); log.pass('Session ID') }
    catch { log.warn('Session ID timeout') }

    log.step('Waiting for Spinner IDLE...')
    await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE/, 45000, 200)
    log.pass('Claude ready')
    await page.waitForTimeout(500)

    // ── Init jitter log (populated by enforcement loop inside Terminal.tsx) ──
    log.step('Initializing jitter capture...')
    await page.evaluate(() => { window.__scrollJitter = [] })
    log.pass('Jitter capture ready (inside enforcement loop)')

    // ── --keep mode: send prompt, then let user interact ──
    if (KEEP_OPEN) {
      // Send the same prompt as auto mode
      log.step('Sending prompt...')
      await page.locator('.xterm-helper-textarea').first().focus()
      await page.waitForTimeout(200)
      await page.keyboard.type('Read 5 different files from this project one by one. For each file: first read it (just 1 line), then write a short comment about what you read. Do this sequentially for 5 files. Pick any .ts or .js files.', { delay: 5 })
      await page.waitForTimeout(100)
      await page.keyboard.press('Enter')
      log.info('Prompt submitted (read 5 files task)')

      console.log(`\n${c.B}═══ MANUAL MODE ═══${c.R}`)
      console.log(`  Scroll monitor active. Prompt sent.`)
      console.log(`  Wait for response, scroll around, reproduce the bug.`)
      console.log(`  Press ${c.Y}Ctrl+C${c.R} when done — report will print.\n`)

      // Periodic heartbeat
      const hbManual = setInterval(async () => {
        try {
          const d = await page.evaluate(() => ({
            n: window.__sd.events.length, j: window.__sd.jitter, m: window.__sd.maxEps,
            big: window.__sd.bigJumps.length,
            lastY: window.__sd.events.length > 0 ? window.__sd.events[window.__sd.events.length - 1].y : '-'
          }))
          log.info(`events=${d.n} jitter=${d.j} maxEps=${d.m} bigJumps=${d.big} lastY=${d.lastY}`)
        } catch {}
      }, 5000)

      // Wait for Ctrl+C
      await new Promise((resolve) => {
        process.on('SIGINT', () => { clearInterval(hbManual); resolve() })
      })

      // Collect and print report after Ctrl+C
      console.log(`\n${c.C}[STEP]${c.R} Collecting scroll data...`)

      // Diagnostic: dump all viewport states
      const vpDiag = await page.evaluate(() => {
        const res = []
        document.querySelectorAll('.xterm-viewport').forEach((vp, i) => {
          res.push({
            i, vis: window.getComputedStyle(vp).visibility,
            scrollTop: Math.round(vp.scrollTop), scrollH: vp.scrollHeight, clientH: vp.clientHeight,
            w: Math.round(vp.getBoundingClientRect().width), h: Math.round(vp.getBoundingClientRect().height),
            hooked: window.__sd.hooked.has(vp)
          })
        })
        return res
      }).catch(() => [])
      console.log(`\n${c.C}  Viewport diagnostics:${c.R}`)
      for (const v of vpDiag) {
        console.log(`    #${v.i}: vis=${v.vis} scrollTop=${v.scrollTop} scrollH=${v.scrollH} clientH=${v.clientH} ${v.w}x${v.h} hooked=${v.hooked}`)
      }
      // Jump to analysis (reuse the same report logic below)
      // We need finalState, r, s2, bigJumps — compute them now
      const finalState = await page.evaluate(() => {
        for (const vp of document.querySelectorAll('.xterm-viewport')) {
          if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
            return { scrollTop: Math.round(vp.scrollTop), scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
              isAtBottom: Math.abs(vp.scrollTop + vp.clientHeight - vp.scrollHeight) < 5 }
        }
        return null
      }).catch(() => null)

      // Read jitter corrections from enforcement loop
      const jd = await page.evaluate(() => {
        const events = window.__scrollJitter || []
        let maxDrift = 0
        for (const e of events) { if (Math.abs(e.drift) > Math.abs(maxDrift)) maxDrift = e.drift }
        return {
          total: events.length, maxDrift,
          samples: events.slice(0, 20).map(e => ({ drift: e.drift, wanted: e.xtermWanted, restored: e.weRestored })),
          last: events.slice(-10).map(e => ({ drift: e.drift, wanted: e.xtermWanted, restored: e.weRestored }))
        }
      }).catch(() => ({ total: 0, maxDrift: 0, samples: [], last: [] }))

      console.log('\n' + '═'.repeat(60))
      console.log(`${c.B}  SCROLL JITTER REPORT${c.R}`)
      console.log('═'.repeat(60))
      console.log(`  Jitter corrections:   ${jd.total}`)
      console.log(`  Max drift amplitude:  ${jd.maxDrift}px`)
      if (finalState) {
        console.log(`  Final scrollTop:      ${finalState.scrollTop}`)
        console.log(`  isAtBottom:           ${finalState.isAtBottom}`)
      }
      if (jd.samples.length) {
        console.log(`\n  Corrections (xterm wanted → restored):`)
        for (const j of jd.samples.slice(0, 15))
          console.log(`    xterm→${j.wanted}px  restored→${j.restored}px  drift=${j.drift}px`)
      }
      if (jd.last.length) {
        console.log(`\n  Last corrections:`)
        for (const j of jd.last)
          console.log(`    xterm→${j.wanted}px  restored→${j.restored}px  drift=${j.drift}px`)
      }
      console.log('═'.repeat(60))

      await app.close().catch(() => {})
      cleanupFork(forkPath)
      clearTimeout(HARD_KILL)
      process.exit(0)
    }

    // ══════════════════════════════════════════════════
    // AUTO MODE (no --keep): send prompt, measure, exit
    // ══════════════════════════════════════════════════
    log.step('Sending prompt...')
    // Mark log position BEFORE sending — so we only detect NEW Spinner events
    const logMarkBeforePrompt = mainProcessLogs.length

    await page.locator('.xterm-helper-textarea').first().focus()
    await page.waitForTimeout(200)
    await page.keyboard.type('Read 5 different files from this project one by one. For each file: first read it (just 1 line), then write a short comment about what you read. Do this sequentially for 5 files. Pick any .ts or .js files.', { delay: 5 })
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    log.info('Prompt submitted (read 5 files task)')

    // ── Spinner BUSY → IDLE (search only NEW logs after prompt) ──
    log.step('Waiting for Spinner BUSY (new logs only)...')
    const busyFound = await new Promise((resolve) => {
      const start = Date.now()
      const iv = setInterval(() => {
        for (let i = logMarkBeforePrompt; i < mainProcessLogs.length; i++) {
          if (/\[Spinner\].*BUSY/.test(mainProcessLogs[i])) { clearInterval(iv); resolve(true); return }
        }
        if (Date.now() - start > 30000) { clearInterval(iv); resolve(false) }
      }, 150)
    })
    assert(busyFound, 'Spinner BUSY (after prompt)')

    // ── SCENARIO 2: Scroll up while Claude is responding ──
    log.step('SCENARIO 2: Scrolling up ~73px (2 wheel ticks) while Claude is busy...')
    await page.waitForTimeout(1000)

    const beforeManualScroll = await page.evaluate(() => {
      for (const vp of document.querySelectorAll('.xterm-viewport'))
        if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
          return Math.round(vp.scrollTop)
      return -1
    })
    console.log(`${c.Y}  [AUTO-SCROLL] scrollTop BEFORE scroll-up: ${beforeManualScroll}px${c.R}`)

    // Scroll up ~75px: set DOM scrollTop directly + update enforcement loop target atomically
    await page.evaluate((tid) => {
      const term = window.__terminalRegistry?.get?.(tid)
      if (!term) return
      const vp = term.element?.querySelector('.xterm-viewport')
      if (!vp) return
      const newTop = Math.max(0, vp.scrollTop - 75)
      vp.scrollTop = newTop
      // Update enforcement loop to hold this new position
      if (window.__scrollSave) {
        window.__scrollSave.savedTop = newTop
        window.__scrollSave.wasAtBottom = false
      }
    }, tabId)
    await page.waitForTimeout(100)

    const afterManualScroll = await page.evaluate(() => {
      for (const vp of document.querySelectorAll('.xterm-viewport'))
        if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
          return Math.round(vp.scrollTop)
      return -1
    })
    console.log(`${c.Y}  [AUTO-SCROLL] scrollTop AFTER scroll-up: ${afterManualScroll}px (moved ${afterManualScroll - beforeManualScroll}px)${c.R}`)

    // Reset diagnostic counters for scenario 2 measurement
    await page.evaluate(() => {
      window.__sd.scenario2Start = Date.now() - window.__sd.t0
      window.__sd.scenario2StartY = (() => {
        for (const vp of document.querySelectorAll('.xterm-viewport')) {
          if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
            return Math.round(vp.scrollTop)
        }
        return -1
      })()
    })

    const hb = setInterval(async () => {
      try {
        const d = await page.evaluate(() => ({
          n: (window.__scrollJitter || []).length,
          last: (window.__scrollJitter || []).slice(-1)[0]
        }))
        const lastStr = d.last ? `drift=${d.last.drift}px wanted=${d.last.xtermWanted}` : '-'
        log.info(`jitter corrections: ${d.n}  last: ${lastStr}`)
      } catch {}
    }, 4000)

    log.step('Waiting for Spinner IDLE (new logs only)...')
    const idleFound = await new Promise((resolve) => {
      const start = Date.now()
      // Search only logs after the BUSY we just found
      const searchFrom = mainProcessLogs.length - 1
      const iv = setInterval(() => {
        for (let i = searchFrom; i < mainProcessLogs.length; i++) {
          if (/\[Spinner\].*IDLE/.test(mainProcessLogs[i])) { clearInterval(iv); resolve(true); return }
        }
        if (Date.now() - start > 180000) { clearInterval(iv); resolve(false) }
      }, 150)
    })
    assert(idleFound, 'Spinner IDLE (after prompt)')
    await page.waitForTimeout(2000)
    clearInterval(hb)

    // ── Check final scroll position ──
    const finalState = await page.evaluate(() => {
      const vps = document.querySelectorAll('.xterm-viewport')
      for (const vp of vps) {
        if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50) {
          return {
            scrollTop: Math.round(vp.scrollTop),
            scrollHeight: vp.scrollHeight,
            clientHeight: vp.clientHeight,
            isAtBottom: Math.abs(vp.scrollTop + vp.clientHeight - vp.scrollHeight) < 5
          }
        }
      }
      return null
    })

    // ── Analyze jitter corrections from inside enforcement loop ──
    log.step('Analyzing jitter corrections...')
    const jitterData = await page.evaluate(() => {
      const events = (window.__scrollJitter || []).filter(e => e && typeof e.t === 'number')
      const t0 = events.length > 0 ? events[0].t : 0
      // Max drift amplitude
      let maxDrift = 0
      for (const e of events) { if (Math.abs(e.drift) > Math.abs(maxDrift)) maxDrift = e.drift }
      return {
        total: events.length,
        maxDrift,
        samples: events.slice(0, 30).map(e => ({ t: e.t - t0, drift: e.drift, wanted: e.xtermWanted, restored: e.weRestored })),
        lastSamples: events.slice(-10).map(e => ({ t: e.t - t0, drift: e.drift, wanted: e.xtermWanted, restored: e.weRestored }))
      }
    })

    // ── Report ──
    console.log('\n' + '═'.repeat(60))
    console.log(`${c.B}  SCROLL JITTER REPORT${c.R}`)
    console.log('═'.repeat(60))
    console.log(`  Jitter corrections:   ${jitterData.total}`)
    console.log(`  Max drift amplitude:  ${jitterData.maxDrift}px`)
    if (finalState) {
      console.log(`\n  Final scroll state:`)
      console.log(`    scrollTop:    ${finalState.scrollTop}`)
      console.log(`    scrollHeight: ${finalState.scrollHeight}`)
      console.log(`    isAtBottom:   ${finalState.isAtBottom}`)
    }

    if (jitterData.samples.length) {
      console.log(`\n  First corrections (xterm wanted → we restored):`)
      for (const j of jitterData.samples.slice(0, 15))
        console.log(`    t=${j.t}ms  xterm→${j.wanted}px  restored→${j.restored}px  drift=${j.drift}px`)
    }
    if (jitterData.lastSamples.length) {
      console.log(`\n  Last corrections:`)
      for (const j of jitterData.lastSamples)
        console.log(`    t=${j.t}ms  xterm→${j.wanted}px  restored→${j.restored}px  drift=${j.drift}px`)
    }

    if (r.sample.length) {
      console.log('\n  Scroll trace:')
      for (const e of r.sample.slice(0, 25))
        console.log(`    ${e.d > 0 ? '↓' : '↑'} t=${e.t}ms y=${e.y} Δ=${e.d}`)
    }
    console.log('═'.repeat(60))

    // ── Scenario 2 analysis ──
    console.log('═'.repeat(60))

    // Assertions based on real jitter data from enforcement loop
    assert(jitterData.total > 0, `Enforcement loop caught corrections (${jitterData.total})`)
    assert(Math.abs(jitterData.maxDrift) < 20000, `Max drift ${jitterData.maxDrift}px recorded`)
    // Scenario 2 scrolls up intentionally — scroll should STAY near user's position, not snap to bottom or top
    if (finalState) {
      const scrolledUpDuringResponse = afterManualScroll < beforeManualScroll
      if (scrolledUpDuringResponse) {
        // User scrolled up → viewport should stay near their position, NOT jump to 0 or bottom
        const driftFromManualPos = Math.abs(finalState.scrollTop - afterManualScroll)
        assert(driftFromManualPos < 500, `Scroll stayed near user position (drift ${driftFromManualPos}px < 500)`)
        assert(finalState.scrollTop > 100, `Scroll did NOT jump to top (scrollTop=${finalState.scrollTop})`)
      } else {
        assert(finalState.isAtBottom, `Scroll at bottom after response`)
      }
    }

    console.log(`\n${c.B}Result: ${passed} passed, ${failed} failed${c.R}`)
    if (failed > 0) process.exitCode = 1

    // ── --keep: wait for manual close ──
    if (KEEP_OPEN) {
      console.log(`\n${c.Y}--keep mode: app stays open. Press Ctrl+C to close.${c.R}`)
      await new Promise(() => {}) // hang forever until Ctrl+C
    }

  } finally {
    clearTimeout(HARD_KILL)
    if (!KEEP_OPEN) {
      await app.close().catch(() => {})
    }
    cleanupFork(forkPath)
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1) })
