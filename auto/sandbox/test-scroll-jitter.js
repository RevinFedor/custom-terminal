/**
 * [E2E+Claude] Scroll Jitter Diagnostic
 *
 * One flow, --keep only prevents closing at the end.
 *
 * node auto/sandbox/test-scroll-jitter.js              # auto-close after report
 * node auto/sandbox/test-scroll-jitter.js --keep       # keep open after report
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { launch, waitForTerminal, waitForClaudeSessionId, waitForMainProcessLog } = require('../core/launcher')
const electron = require('../core/electron')

const SOURCE_SESSION = '8cbda5e3-8f02-4811-991b-9d8d857135e7'
const PROJECT_SLUG = '-Users-fedor-Desktop-custom-terminal'
const SESSIONS_DIR = path.join(process.env.HOME, '.claude', 'projects', PROJECT_SLUG)
const PROJECT_DIR = '/Users/fedor/Desktop/custom-terminal'
const KEEP_OPEN = process.argv.includes('--keep')

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
const HARD_KILL = setTimeout(() => { process.exit(2) }, KEEP_OPEN ? 600000 : 300000)

function forkSession() {
  const forkId = crypto.randomUUID()
  const src = path.join(SESSIONS_DIR, `${SOURCE_SESSION}.jsonl`)
  const dst = path.join(SESSIONS_DIR, `${forkId}.jsonl`)
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`)
  fs.copyFileSync(src, dst)
  log.info(`Forked: ${forkId.slice(0, 8)}...`)
  return { forkId, forkPath: dst }
}

async function fastType(page, tabId, text) {
  await page.evaluate(({ tid, txt }) => {
    window.require('electron').ipcRenderer.send('terminal:input', tid, txt + '\r')
  }, { tid: tabId, txt: text })
}

async function collectReport(page) {
  const finalState = await page.evaluate(() => {
    for (const vp of document.querySelectorAll('.xterm-viewport')) {
      if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
        return { scrollTop: Math.round(vp.scrollTop), scrollHeight: vp.scrollHeight, clientHeight: vp.clientHeight,
          isAtBottom: Math.abs(vp.scrollTop + vp.clientHeight - vp.scrollHeight) < 5 }
    }
    return null
  }).catch(() => null)

  const jd = await page.evaluate(() => {
    const corrections = (window.__scrollJitter || []).filter(e => e && typeof e.t === 'number')
    const scrollLog = window.__scrollLog || []
    let maxDrift = 0
    for (const e of corrections) { if (Math.abs(e.drift) > Math.abs(maxDrift)) maxDrift = e.drift }
    return {
      corrections: corrections.length, maxDrift,
      scrollEvents: scrollLog.length,
      corrSamples: corrections.slice(0, 15).map(e => ({ drift: e.drift, wanted: e.xtermWanted, restored: e.weRestored })),
      corrLast: corrections.slice(-10).map(e => ({ drift: e.drift, wanted: e.xtermWanted, restored: e.weRestored })),
      scrollLast: scrollLog.slice(-20).map(e => ({ y: e.y, d: e.d, scrollH: e.scrollH, scrollHD: e.scrollHDelta, areaH: e.scrollAreaH, sync: e.syncFlag }))
    }
  }).catch(() => ({ corrections: 0, maxDrift: 0, scrollEvents: 0, corrSamples: [], corrLast: [], scrollLast: [] }))

  console.log('\n' + '═'.repeat(60))
  console.log(`${c.B}  SCROLL JITTER REPORT${c.R}`)
  console.log('═'.repeat(60))
  console.log(`  Scroll events (rAF poll): ${jd.scrollEvents}`)
  console.log(`  Enforcement corrections:  ${jd.corrections}`)
  console.log(`  Max drift amplitude:      ${jd.maxDrift}px`)
  if (finalState) {
    console.log(`  Final scrollTop:          ${finalState.scrollTop}px`)
    console.log(`  isAtBottom:               ${finalState.isAtBottom}`)
  }
  // safeWrite isAtBottom checks
  const checks = await page.evaluate(() => window.__safeWriteChecks || []).catch(() => [])
  if (checks.length) {
    console.log(`\n  safeWrite isAtBottom checks (${checks.length}):`)
    for (const ch of checks.slice(0, 10))
      console.log(`    scrollTop=${ch.scrollTop} + clientH=${ch.clientH} = ${ch.sum} vs threshold=${ch.threshold} → ${ch.isAtBottom ? 'AT_BOTTOM' : 'SCROLLED_UP'}`)
    if (checks.length > 10) console.log(`    ... ${checks.length - 10} more`)
  }

  if (jd.corrSamples.length) {
    console.log(`\n  First corrections:`)
    for (const j of jd.corrSamples)
      console.log(`    xterm→${j.wanted}px  restored→${j.restored}px  drift=${j.drift}px`)
  }
  if (jd.corrLast.length) {
    console.log(`\n  Last corrections:`)
    for (const j of jd.corrLast)
      console.log(`    xterm→${j.wanted}px  restored→${j.restored}px  drift=${j.drift}px`)
  }
  if (jd.scrollLast.length) {
    console.log(`\n  Last scroll positions:`)
    for (const e of jd.scrollLast)
      console.log(`    ${e.d > 0 ? '↓' : '↑'} y=${e.y}px Δ=${e.d}px  scrollH=${e.scrollH || '?'} scrollHΔ=${e.scrollHD || 0} areaH=${e.areaH || '?'} sync=${e.sync ?? '?'}`)
  }
  console.log('═'.repeat(60))
  return { finalState, jd }
}

async function main() {
  log.step('Forking session...')
  const { forkId, forkPath } = forkSession()

  log.step('Launching app...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: true, logMainProcess: false, waitForReady: 4000
  })
  page.on('console', msg => {
    const t = msg.text()
    if (t.includes('Viewport') || t.includes('_sync') || t.includes('patch'))
      console.log(`${c.C}  [RENDERER] ${t}${c.R}`)
  })

  try {
    // ── Startup ──
    await waitForTerminal(page, 20000).catch(async () => {
      await page.evaluate(() => {
        window.useWorkspaceStore?.getState?.()?.setView?.('workspace')
      }).catch(() => {})
      await waitForTerminal(page, 10000)
    })
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal ready')

    const modalBtn = page.locator('div.absolute.inset-0.z-50 button').first()
    if (await modalBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      log.info('Dismissing modal')
      await modalBtn.click()
      await page.waitForTimeout(1500)
    }

    // ── New tab (fresh Terminal component with latest code) ──
    log.step('New tab...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(2000)
    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore.getState()
      return s.openProjects.get(s.activeProjectId)?.activeTabId
    })
    log.info(`Tab: ${tabId}`)

    log.step('Claude launch...')
    await fastType(page, tabId, `cd ${PROJECT_DIR}`)
    await page.waitForTimeout(1000)
    await fastType(page, tabId, `claude -r ${forkId}`)
    try { await waitForClaudeSessionId(page, 60000); log.pass('Session ID') }
    catch { log.warn('Session ID timeout') }
    await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE/, 45000, 200)
    log.pass('Claude ready')
    await page.waitForTimeout(500)

    // ── Monitors ──
    await page.evaluate(() => { window.__scrollJitter = [] })
    await page.evaluate((tid) => {
      const term = window.__terminalRegistry?.get?.(tid)
      if (!term) return
      const vp = term.element?.querySelector('.xterm-viewport')
      if (!vp) return
      // Also find scroll area (child of viewport that defines scrollable height)
      const scrollArea = vp.querySelector('.xterm-scroll-area')

      // Log which viewport — check if it matches the VISIBLE one
      const allVps = document.querySelectorAll('.xterm-viewport')
      let visibleVp = null
      allVps.forEach(v => { if (window.getComputedStyle(v).visibility !== 'hidden' && v.getBoundingClientRect().height > 50) visibleVp = v })
      const isCorrectVp = vp === visibleVp
      console.warn('[MONITOR] tabId=' + tid + ' vpMatch=' + isCorrectVp + ' vis=' + window.getComputedStyle(vp).visibility + ' scrollTop=' + Math.round(vp.scrollTop))

      window.__scrollLog = []
      let lastTop = vp.scrollTop
      let lastScrollH = vp.scrollHeight
      const poll = () => {
        const top = vp.scrollTop
        const scrollH = vp.scrollHeight
        const scrollAreaH = scrollArea ? scrollArea.offsetHeight : -1
        // Log ANY change in scrollTop OR scrollHeight
        if (Math.abs(top - lastTop) > 0.5 || Math.abs(scrollH - lastScrollH) > 0.5) {
          window.__scrollLog.push({
            t: Date.now(), y: Math.round(top), d: Math.round(top - lastTop),
            scrollH: Math.round(scrollH), scrollHDelta: Math.round(scrollH - lastScrollH),
            scrollAreaH: Math.round(scrollAreaH),
            syncFlag: !!globalThis.__xtermSyncOutput
          })
          if (window.__scrollLog.length > 2000) window.__scrollLog = window.__scrollLog.slice(-1000)
          lastTop = top
          lastScrollH = scrollH
        }
        requestAnimationFrame(poll)
      }
      requestAnimationFrame(poll)
    }, tabId)
    log.pass('Monitors active')

    // ── Send prompt ──
    log.step('Sending prompt...')
    const logMark = mainProcessLogs.length
    await page.locator('.xterm-helper-textarea').first().focus()
    await page.waitForTimeout(200)
    await page.keyboard.type('STOP all previous work. New task: just say hello and list 3 random numbers. Nothing else.', { delay: 5 })
    await page.keyboard.press('Enter')
    log.info('Prompt sent')

    // ── Wait BUSY ──
    log.step('Waiting for Spinner BUSY...')
    const busyOk = await new Promise(resolve => {
      const start = Date.now()
      const iv = setInterval(() => {
        for (let i = logMark; i < mainProcessLogs.length; i++)
          if (/\[Spinner\].*BUSY/.test(mainProcessLogs[i])) { clearInterval(iv); return resolve(true) }
        if (Date.now() - start > 30000) { clearInterval(iv); resolve(false) }
      }, 150)
    })
    assert(busyOk, 'Spinner BUSY')

    // ── Scroll up 75px AFTER prompt sent, AFTER Spinner BUSY (real user scenario) ──
    await page.waitForTimeout(1000) // let Claude start outputting
    log.step('Scrolling up 75px...')
    const before = await page.evaluate(() => {
      for (const vp of document.querySelectorAll('.xterm-viewport'))
        if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
          return Math.round(vp.scrollTop)
      return -1
    })
    await page.evaluate(() => {
      for (const vp of document.querySelectorAll('.xterm-viewport'))
        if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50) {
          vp.scrollTop = Math.max(0, vp.scrollTop - 75)
          if (window.__scrollState) window.__scrollState.savedScrollTop = vp.scrollTop
          break
        }
    })
    await page.waitForTimeout(100)
    const after = await page.evaluate(() => {
      for (const vp of document.querySelectorAll('.xterm-viewport'))
        if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
          return Math.round(vp.scrollTop)
      return -1
    })
    console.log(`${c.Y}  [SCROLL] ${before}px → ${after}px (Δ=${after - before}px)${c.R}`)

    // ── Heartbeat while waiting for IDLE ──
    let earlyStop = false
    const hb = setInterval(async () => {
      try {
        const d = await page.evaluate(() => ({
          scrollY: (() => { for (const vp of document.querySelectorAll('.xterm-viewport'))
            if (window.getComputedStyle(vp).visibility !== 'hidden' && vp.getBoundingClientRect().height > 50)
              return Math.round(vp.scrollTop); return -1 })(),
          events: (window.__scrollLog || []).length,
          corrections: (window.__scrollJitter || []).length,
          xtermLog: (globalThis.__xtermScrollLog || []).slice(-5)
        }))
        log.info(`scrollTop=${d.scrollY}px events=${d.events} corrections=${d.corrections}`)
        // Check CSI handler log
        const csi = await page.evaluate(() => window.__csiLog || []).catch(() => [])
        if (csi.length > 0) {
          console.log(`${c.C}  CSI ?h log: ${JSON.stringify(csi.slice(0, 3))}${c.R}`)
        }
        const sync = await page.evaluate(() => ({
          syncActive: window.__scrollState?.syncActive,
          syncDetects: window.__terminalRegistry?.get?.(
            window.useWorkspaceStore?.getState?.()?.openProjects?.get?.(
              window.useWorkspaceStore?.getState?.()?.activeProjectId
            )?.activeTabId
          )?.__syncDetectCount || 0,
          csiLog: (window.__csiLog || []).length
        })).catch(() => ({}))
        console.log(`${c.D}  sync=${sync.syncActive} detects=${sync.syncDetects} csiEntries=${sync.csiLog}${c.R}`)
        // Check if raw PTY data contains DEC 2026 markers
        const has2026 = await page.evaluate(() => window.__has2026 || 0).catch(() => 0)
        if (has2026) console.log(`${c.G}  DEC 2026 found in PTY data: ${has2026} times${c.R}`)
        // Show xterm internal scroll log
        for (const e of d.xtermLog) {
          const status = e.blocked ? 'BLOCKED' : 'APPLIED'
          console.log(`${c.D}    [xterm] ${e.src}: ${e.from}→${e.to} scrollH=${e.scrollH} sync=${e.syncFlag} ${status}${c.R}`)
        }
        // Early stop if scrollTop jumped to 0
        if (d.scrollY === 0 && after > 0) {
          log.warn('scrollTop=0 detected! Collecting xterm log...')
          const fullLog = await page.evaluate(() => globalThis.__xtermScrollLog || [])
          console.log(`\n${c.F}  XTERM INTERNAL SCROLL LOG (${fullLog.length} entries):${c.R}`)
          for (const e of fullLog.slice(-30)) {
            const status = e.blocked ? `${c.G}BLOCKED${c.R}` : `${c.F}APPLIED${c.R}`
            console.log(`    ${e.src}: ${e.from}→${e.to}px  scrollH=${e.scrollH}  sync=${e.syncFlag}  ${status}`)
          }
          earlyStop = true
          clearInterval(hb)
        }
      } catch {}
    }, 3000)

    log.step('Waiting for Spinner IDLE...')
    const idleOk = await new Promise(resolve => {
      const start = Date.now(), from = mainProcessLogs.length - 1
      const iv = setInterval(() => {
        for (let i = from; i < mainProcessLogs.length; i++)
          if (/\[Spinner\].*IDLE/.test(mainProcessLogs[i])) { clearInterval(iv); return resolve(true) }
        if (Date.now() - start > 180000) { clearInterval(iv); resolve(false) }
      }, 150)
    })
    assert(idleOk, 'Spinner IDLE')
    await page.waitForTimeout(2000)
    clearInterval(hb)

    // ── Report ──
    const { finalState, jd } = await collectReport(page)

    assert(jd.scrollEvents > 0 || jd.corrections > 0, `Got monitoring data (scroll=${jd.scrollEvents} corr=${jd.corrections})`)
    if (finalState && after > 0) {
      const drift = Math.abs(finalState.scrollTop - after)
      assert(drift < 500, `Scroll drift ${drift}px < 500px`)
      assert(finalState.scrollTop > 100, `Not at top (scrollTop=${finalState.scrollTop})`)
    }

    console.log(`\n${c.B}Result: ${passed} passed, ${failed} failed${c.R}`)
    if (failed > 0) process.exitCode = 1

    if (KEEP_OPEN) {
      console.log(`\n${c.Y}--keep: app open. Ctrl+C to close.${c.R}`)
      await new Promise(resolve => process.on('SIGINT', resolve))
      await collectReport(page).catch(() => {})
    }

  } finally {
    clearTimeout(HARD_KILL)
    if (!KEEP_OPEN) await app.close().catch(() => {})
    try { fs.unlinkSync(forkPath) } catch {}
  }
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1) })
