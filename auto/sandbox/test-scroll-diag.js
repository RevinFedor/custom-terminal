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

const SOURCE_SESSION = 'e3dab764-73af-482f-befb-5ef5eaa3dad5'
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

    // screenshot 1 removed — only keep anchor, 5s, 15s

    // Switch to haiku + disable think for faster responses
    log.step('Switching to haiku model...')
    await typeCommand(page, '/model haiku')
    await page.waitForTimeout(2000)
    log.step('Toggling think off...')
    const thinkResult = await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:toggle-thinking', tid)
    }, tabId)
    log.info(`Think toggle: ${JSON.stringify(thinkResult)}`)
    await page.waitForTimeout(1000)

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
    // screenshot 2 removed

    // === KEY: Scroll up using mouse.wheel — triggers real DOM scroll event ===
    // term.scrollLines() does NOT trigger DOM scroll event (xterm.js #3201),
    // so our userScrollTopRef tracking wouldn't catch it.
    log.step('Scrolling up via mouse.wheel...')
    const termScreen = page.locator('.xterm-screen').last()
    await termScreen.hover()
    await page.mouse.wheel(0, -1500) // scroll up ~1500px (~100 rows, fully above active area)
    await page.waitForTimeout(300) // let scroll events + rAF fire

    // Verify we actually scrolled up
    const afterScroll = await page.evaluate((tid) => {
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(tid)
      if (!term) return null
      const buf = term.buffer.active
      const lines = term._core?.buffer?.lines?.length || -1
      const maxLen = term._core?.buffer?.lines?.maxLength || -1
      return { viewportY: buf.viewportY, baseY: buf.baseY, isAtBottom: buf.viewportY >= buf.baseY, lines, maxLen }
    }, tabId)
    log.info(`After scroll: ${JSON.stringify(afterScroll)}`)
    if (afterScroll) {
      assert(!afterScroll.isAtBottom, `User scrolled up: viewportY=${afterScroll.viewportY} baseY=${afterScroll.baseY}`)
    }

    await page.screenshot({ path: 'tmp/scroll-anchor.png', clip: { x: 0, y: 100, width: 900, height: 600 } })

    // Hook into buffer.lines.onTrim to detect line index shifts
    await page.evaluate((tid) => {
      window.__testTrimCount = 0
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(tid)
      if (!term || !term._core) return
      const buf = term._core.buffer
      if (buf?.lines?.onTrim) {
        buf.lines.onTrim((amount) => {
          window.__testTrimCount += amount
          if (window.__testTrimCount <= 5 || window.__testTrimCount % 100 === 0) {
            console.warn(`[ScrollTest] TRIM: ${amount} lines removed (total: ${window.__testTrimCount})`)
          }
        })
      }
    }, tabId)

    // Start continuous tracker: viewportY + first visible line content
    const anchorContent = await page.evaluate((tid) => {
      window.__testScrollHistory = []
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(tid)
      if (!term) return null
      // Save anchor: first visible line text
      const buf = term.buffer.active
      const line = buf.getLine(buf.viewportY)
      const text = line ? line.translateToString(true).trim() : ''
      // Save first 5 lines as anchor
      window.__testTabId = tid
      window.__testAnchorLines = []
      for (let i = 0; i < 5; i++) {
        const l = buf.getLine(buf.viewportY + i)
        window.__testAnchorLines.push(l ? l.translateToString(true).trim() : '')
      }
      window.__testAnchorY = buf.viewportY

      // === Comprehensive scrollbar monitor ===
      // thumbRatio = scrollTop / maxScroll — the VISUAL position of the scrollbar thumb
      // This is what the user sees. scrollTop can be stable while thumbRatio jumps
      // because scrollHeight changes (CSI 3J clear / Ink redraw cycle).
      window.__testScrollBarHistory = []
      window.__testThumbJumps = [] // large ratio changes between samples

      // 1. rAF poll: viewportY + content + thumbRatio
      let lastThumbRatio = -1
      window.__testScrollTracker = setInterval(() => {
        const b = term.buffer.active
        let allMatch = true
        for (let i = 0; i < 5; i++) {
          const l = b.getLine(b.viewportY + i)
          const t = l ? l.translateToString(true).trim() : ''
          if (t !== window.__testAnchorLines[i]) { allMatch = false; break }
        }
        window.__testScrollHistory.push({
          y: b.viewportY,
          match: allMatch
        })

        // Scrollbar thumb ratio tracking
        const vp = term.element?.querySelector('.xterm-viewport')
        if (vp) {
          const maxScroll = vp.scrollHeight - vp.clientHeight
          const thumbRatio = maxScroll > 0 ? vp.scrollTop / maxScroll : 0
          const entry = {
            scrollTop: Math.round(vp.scrollTop),
            scrollHeight: Math.round(vp.scrollHeight),
            clientHeight: Math.round(vp.clientHeight),
            baseY: b.baseY,
            thumbRatio: Math.round(thumbRatio * 10000) / 10000
          }
          window.__testScrollBarHistory.push(entry)

          // Detect thumb jumps (>5% ratio change between samples)
          if (lastThumbRatio >= 0) {
            const ratioDelta = Math.abs(thumbRatio - lastThumbRatio)
            if (ratioDelta > 0.05) {
              window.__testThumbJumps.push({
                from: Math.round(lastThumbRatio * 10000) / 10000,
                to: entry.thumbRatio,
                delta: Math.round(ratioDelta * 10000) / 10000,
                scrollTop: entry.scrollTop,
                scrollHeight: entry.scrollHeight
              })
            }
          }
          lastThumbRatio = thumbRatio
        }
      }, 16)

      // 2. Scroll event listener (catches every browser scroll event)
      window.__testScrollEvents = []
      const vpEl = term.element?.querySelector('.xterm-viewport')
      if (vpEl) {
        vpEl.addEventListener('scroll', () => {
          const maxScroll = vpEl.scrollHeight - vpEl.clientHeight
          const ratio = maxScroll > 0 ? vpEl.scrollTop / maxScroll : 0
          window.__testScrollEvents.push({
            t: performance.now(),
            scrollTop: Math.round(vpEl.scrollTop),
            scrollHeight: Math.round(vpEl.scrollHeight),
            thumbRatio: Math.round(ratio * 10000) / 10000
          })
        }, { passive: true })
      }

      // 3. MutationObserver on .xterm-scroll-area (xterm changes its height to control scrollbar)
      window.__testHeightChanges = []
      const scrollArea = vpEl?.querySelector('.xterm-scroll-area')
      if (scrollArea) {
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.attributeName === 'style') {
              window.__testHeightChanges.push({
                t: performance.now(),
                height: scrollArea.style.height,
                scrollHeight: Math.round(vpEl.scrollHeight),
                scrollTop: Math.round(vpEl.scrollTop)
              })
            }
          }
        })
        obs.observe(scrollArea, { attributes: true, attributeFilter: ['style'] })
      }

      return window.__testAnchorLines[0]
    }, tabId)
    log.info(`Anchor line: "${anchorContent?.substring(0, 80)}"`)


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
    await page.screenshot({ path: 'tmp/scroll-5s.png', clip: { x: 0, y: 100, width: 900, height: 600 } })

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
    await page.screenshot({ path: 'tmp/scroll-15s.png', clip: { x: 0, y: 100, width: 900, height: 600 } })

    if (after15s) {
      assert(after15s.viewportY > 0, `viewportY > 0 after 15s (got ${after15s.viewportY})`)
    }

    // ── Log-based assertions (continuous, not snapshot) ──

    const allLogs = [...mainProcessLogs, ...consoleLogs]

    // 1. No large jumps after user scroll-up (catches oscillation)
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

    // 2. No drift in protectedWrite restores (catches 1-line-per-message creep).
    //    Every [ScrollFix] log with Δ != 0 means the scroll position drifted.
    //    Only exception: Δ < 0 when baseAfter < savedLine (buffer temporarily too small).
    const scrollFixLogs = allLogs.filter(l => l.includes('ScrollFix') && l.includes('Δ'))
    const badDrifts = scrollFixLogs.filter(l => {
      const m = l.match(/Δ([+-]?\d+)/)
      if (!m) return false
      const delta = parseInt(m[1])
      if (delta === 0) return false
      // Allow negative drift only when buffer shrunk below savedLine (clamped case)
      if (delta < 0) {
        const baseMatch = l.match(/base:\d+→(\d+)/)
        const restoreMatch = l.match(/restore:\d+→(\d+)/)
        if (baseMatch && restoreMatch && parseInt(restoreMatch[1]) === parseInt(baseMatch[1])) {
          return false // clamped to baseAfter — expected when buffer shrinks
        }
      }
      return true // genuine drift
    })
    assert(badDrifts.length === 0, `No scroll drift in protectedWrite (found ${badDrifts.length})`)
    if (badDrifts.length > 0) {
      badDrifts.slice(0, 5).forEach(l => {
        const short = l.replace(/.*\[ScrollFix\] /, '')
        log.info(`  ${short}`)
      })
    }
    if (scrollFixLogs.length === 0) {
      log.info('No ScrollFix drift logs (all writes had Δ=0)')
    } else {
      log.info(`ScrollFix logs: ${scrollFixLogs.length} total, ${badDrifts.length} bad drifts`)
    }

    // 3. Continuous tracker — checks BOTH viewportY number AND content stability.
    //    viewportY can be stable while content shifts (reflow, trimStart).
    //    Content check catches this: if first visible line text changes, test fails.
    const trackerResult = await page.evaluate(() => {
      clearInterval(window.__testScrollTracker)
      const h = window.__testScrollHistory || []
      if (h.length === 0) return null
      const ys = h.map(e => e.y)
      const min = Math.min(...ys)
      const max = Math.max(...ys)
      const mismatches = h.filter(e => !e.match).length
      // Get current state of anchor lines for comparison
      const registry = window.terminalRegistry || window.__terminalRegistry
      const term = registry?.get?.(window.__testTabId)
      let currentLines = []
      if (term) {
        const buf = term.buffer.active
        for (let i = 0; i < 5; i++) {
          const l = buf.getLine(buf.viewportY + i)
          currentLines.push(l ? l.translateToString(true).trim() : '')
        }
      }
      return {
        samples: h.length, min, max, spread: max - min,
        mismatches,
        anchorLines: window.__testAnchorLines?.map(l => l.substring(0, 60)) || [],
        currentLines: currentLines.map(l => l.substring(0, 60))
      }
    })
    if (trackerResult) {
      log.info(`Tracker: ${trackerResult.samples} samples, viewportY [${trackerResult.min}..${trackerResult.max}], spread=${trackerResult.spread}`)
      log.info(`Content: ${trackerResult.mismatches} mismatches out of ${trackerResult.samples} (checking 5 lines)`)
      if (trackerResult.mismatches > 0) {
        log.info(`  Anchor lines:`)
        trackerResult.anchorLines.forEach((l, i) => log.info(`    [${i}] "${l}"`))
        log.info(`  Current lines:`)
        trackerResult.currentLines.forEach((l, i) => log.info(`    [${i}] "${l}"`))
      }
      // Also report trim count
      const trimCount = await page.evaluate(() => window.__testTrimCount || 0)
      log.info(`Buffer trims: ${trimCount} lines removed during test`)
      assert(trackerResult.spread <= 2, `viewportY stable (spread=${trackerResult.spread})`)
      assert(trackerResult.mismatches === 0, `Content stable — first line unchanged (${trackerResult.mismatches} mismatches)`)
    }

    // 4. Scrollbar THUMB position (the visual indicator the user sees)
    //    thumbRatio = scrollTop / (scrollHeight - clientHeight)
    //    0.0 = thumb at top, 1.0 = thumb at bottom
    //    Even if scrollTop is stable, scrollHeight changes move the thumb.
    const thumbResult = await page.evaluate(() => {
      const h = window.__testScrollBarHistory || []
      if (h.length === 0) return null
      const ratios = h.map(e => e.thumbRatio)
      const scrollTops = h.map(e => e.scrollTop)
      const scrollHeights = h.map(e => e.scrollHeight)
      const baseYs = h.map(e => e.baseY)
      const jumps = window.__testThumbJumps || []
      const scrollEvents = window.__testScrollEvents || []
      const heightChanges = window.__testHeightChanges || []
      return {
        samples: h.length,
        thumbRatio: {
          min: Math.round(Math.min(...ratios) * 10000) / 10000,
          max: Math.round(Math.max(...ratios) * 10000) / 10000,
          first: ratios[0],
          last: ratios[ratios.length - 1]
        },
        scrollTop: { min: Math.min(...scrollTops), max: Math.max(...scrollTops) },
        scrollHeight: { min: Math.min(...scrollHeights), max: Math.max(...scrollHeights) },
        baseY: { min: Math.min(...baseYs), max: Math.max(...baseYs), first: baseYs[0], last: baseYs[baseYs.length - 1] },
        thumbJumps: jumps.length,
        thumbJumpSamples: jumps.slice(0, 10),
        scrollEventCount: scrollEvents.length,
        heightChangeCount: heightChanges.length,
        lastHeightChanges: heightChanges.slice(-5).map(h => ({ height: h.height, scrollH: h.scrollHeight, scrollT: h.scrollTop }))
      }
    })
    if (thumbResult) {
      const tr = thumbResult.thumbRatio
      const ratioSpread = Math.round((tr.max - tr.min) * 10000) / 10000
      log.info(`Thumb ratio: [${tr.min}..${tr.max}] spread=${ratioSpread} (0=top, 1=bottom)`)
      log.info(`  scrollTop: [${thumbResult.scrollTop.min}..${thumbResult.scrollTop.max}]`)
      log.info(`  scrollHeight: [${thumbResult.scrollHeight.min}..${thumbResult.scrollHeight.max}]`)
      log.info(`  baseY: [${thumbResult.baseY.min}..${thumbResult.baseY.max}] growth=${thumbResult.baseY.last - thumbResult.baseY.first}`)
      log.info(`  Scroll events: ${thumbResult.scrollEventCount}, Height mutations: ${thumbResult.heightChangeCount}`)
      log.info(`  Thumb jumps (>5% ratio change): ${thumbResult.thumbJumps}`)
      if (thumbResult.thumbJumps > 0) {
        thumbResult.thumbJumpSamples.forEach((j, i) =>
          log.warn(`    Jump ${i+1}: ratio ${j.from}→${j.to} (Δ${j.delta}) scrollTop=${j.scrollTop} scrollH=${j.scrollHeight}`)
        )
      }
      if (thumbResult.lastHeightChanges.length > 0) {
        log.info(`  Last height changes:`)
        thumbResult.lastHeightChanges.forEach(h => log.info(`    height=${h.height} scrollH=${h.scrollH} scrollT=${h.scrollT}`))
      }
      assert(thumbResult.thumbJumps === 0, `No scrollbar thumb jumps (found ${thumbResult.thumbJumps})`)
      assert(ratioSpread < 0.1, `Thumb ratio stable (spread=${ratioSpread})`)
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
