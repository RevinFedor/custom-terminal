/**
 * Standalone test: Spawn gemini in a raw PTY and capture /model menu output
 *
 * No Electron needed — just node-pty directly.
 * Goal: See exact ANSI codes Gemini uses for ● selection markers.
 *
 * Run: node auto/sandbox/test-gemini-pty-raw.js
 */

const pty = require('node-pty')
const { stripVTControlCharacters } = require('node:util')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m',
  magenta: '\x1b[35m'
}

const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Collect PTY data for a duration
function collectData(term, durationMs) {
  return new Promise((resolve) => {
    let buf = ''
    const handler = term.onData((data) => { buf += data })
    setTimeout(() => { handler.dispose(); resolve(buf) }, durationMs)
  })
}

// Wait for specific text to appear in PTY output
function waitForText(term, text, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { handler.dispose(); reject(new Error(`Timeout waiting for "${text}"`)) }, timeoutMs)
    const handler = term.onData((data) => {
      buf += data
      const clean = stripVTControlCharacters(buf)
      if (clean.includes(text)) {
        clearTimeout(timer)
        handler.dispose()
        resolve(buf)
      }
    })
  })
}

// Wait for silence (no data for ms)
function drainData(term, ms = 500) {
  return new Promise((resolve) => {
    let buf = ''
    let timer = null
    const handler = term.onData((data) => {
      buf += data
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { handler.dispose(); resolve(buf) }, ms)
    })
    timer = setTimeout(() => { handler.dispose(); resolve(buf) }, ms)
  })
}

function analyzeRaw(raw, label) {
  console.log(`\n${c.bold}═══ ${label} (${raw.length} bytes) ═══${c.reset}`)

  // Clean text
  const clean = stripVTControlCharacters(raw)
  console.log(`${c.dim}--- Clean text ---${c.reset}`)
  console.log(clean)

  // All ANSI color codes
  const colorCodes = raw.match(/\x1b\[[\d;]*m/g) || []
  const uniqueColors = [...new Set(colorCodes)]
  console.log(`\n${c.dim}Unique ANSI color codes (${uniqueColors.length}):${c.reset}`)
  uniqueColors.forEach(code => {
    const readable = code.replace(/\x1b/g, 'ESC')
    const count = colorCodes.filter(c => c === code).length
    console.log(`  ${readable} (×${count})`)
  })

  // RGB codes
  const rgbCodes = raw.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g) || []
  if (rgbCodes.length > 0) {
    const uniqueRgb = [...new Set(rgbCodes)]
    console.log(`\n${c.dim}RGB foreground colors:${c.reset}`)
    uniqueRgb.forEach(code => {
      const m = code.match(/38;2;(\d+);(\d+);(\d+)/)
      console.log(`  RGB(${m[1]}, ${m[2]}, ${m[3]})`)
    })
  }

  // BG RGB codes
  const bgRgbCodes = raw.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g) || []
  if (bgRgbCodes.length > 0) {
    const uniqueBgRgb = [...new Set(bgRgbCodes)]
    console.log(`\n${c.dim}RGB background colors:${c.reset}`)
    uniqueBgRgb.forEach(code => {
      const m = code.match(/48;2;(\d+);(\d+);(\d+)/)
      console.log(`  BG RGB(${m[1]}, ${m[2]}, ${m[3]})`)
    })
  }

  // Sync markers
  const syncH = (raw.match(/\x1b\[\?2026h/g) || []).length
  const syncL = (raw.match(/\x1b\[\?2026l/g) || []).length
  console.log(`\n${c.dim}Sync markers: ?2026h=${syncH}, ?2026l=${syncL}${c.reset}`)

  // Bullet symbols
  const bulletPositions = []
  const lines = clean.split('\n')
  lines.forEach((l, i) => {
    if (l.includes('●')) bulletPositions.push({ line: i, text: l.trim() })
  })
  if (bulletPositions.length > 0) {
    console.log(`\n${c.dim}● positions:${c.reset}`)
    bulletPositions.forEach(p => console.log(`  line ${p.line}: ${p.text}`))
  }

  // Find what ANSI codes surround ● specifically
  const bulletIdx = raw.indexOf('●')
  if (bulletIdx !== -1) {
    // Look back 100 chars for ANSI codes
    const contextBefore = raw.substring(Math.max(0, bulletIdx - 100), bulletIdx)
    const contextAfter = raw.substring(bulletIdx, Math.min(raw.length, bulletIdx + 100))
    const nearCodes = (contextBefore + contextAfter).match(/\x1b\[[\d;]*m/g) || []
    console.log(`\n${c.dim}ANSI codes near ● symbol:${c.reset}`)
    nearCodes.forEach(code => {
      const readable = code.replace(/\x1b/g, 'ESC')
      console.log(`  ${readable}`)
    })

    // Show raw hex around ●
    const hexBefore = Buffer.from(contextBefore.slice(-30)).toString('hex')
    const hexAfter = Buffer.from(contextAfter.slice(0, 30)).toString('hex')
    console.log(`\n${c.dim}Raw hex context around ● (30B before|after):${c.reset}`)
    console.log(`  before: ${hexBefore}`)
    console.log(`  after:  ${hexAfter}`)
  }

  console.log(`${c.bold}═══ END ${label} ═══${c.reset}\n`)
}

async function main() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'

  log.step('Spawning PTY with gemini...')
  const term = pty.spawn('zsh', ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  })

  try {
    // Wait for shell prompt
    log.step('Waiting for shell prompt...')
    await drainData(term, 2000)

    // Start gemini
    log.step('Starting gemini CLI...')
    term.write('gemini\r')

    // Wait for Gemini to fully start (look for prompt or specific text)
    log.step('Waiting for Gemini to initialize...')
    let initData
    try {
      initData = await waitForText(term, '>', 30000)
      log.pass('Gemini started (found ">" prompt)')
    } catch (e) {
      log.warn('Timeout waiting for > prompt, draining...')
      initData = await drainData(term, 5000)
    }

    // Drain any remaining output
    await drainData(term, 2000)

    // ═══════════════════════════════════════════════════════════
    // TEST 1: Send /model and capture the initial menu
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 1: Sending /model...')
    term.write('/model\r')

    const menuRaw = await drainData(term, 3000)
    analyzeRaw(menuRaw, 'INITIAL /model MENU')

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Send UP arrow and see what changes
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 2: Sending UP arrow...')
    term.write('\x1b[A')
    const upRaw = await drainData(term, 1000)
    analyzeRaw(upRaw, 'AFTER UP ARROW')

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Send another UP arrow
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 3: Sending another UP arrow...')
    term.write('\x1b[A')
    const up2Raw = await drainData(term, 1000)
    analyzeRaw(up2Raw, 'AFTER SECOND UP ARROW')

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Send DOWN arrow
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 4: Sending DOWN arrow...')
    term.write('\x1b[B')
    const downRaw = await drainData(term, 1000)
    analyzeRaw(downRaw, 'AFTER DOWN ARROW')

    // ═══════════════════════════════════════════════════════════
    // TEST 5: Navigate to Manual and press Enter to get submenu
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 5: Navigate to "Manual" and press Enter...')

    // First, figure out where we are. Read current clean text.
    // We need to go to option 3 (Manual). Current position unknown.
    // Let's go DOWN enough times to reach it, then confirm.

    // Go to bottom first
    for (let i = 0; i < 5; i++) {
      term.write('\x1b[B')
      await sleep(200)
    }
    await drainData(term, 500) // consume output

    // Now go UP to position at option 3 (Manual)
    // Since there are 3 options, going up from bottom means UP × 0 should be at option 3
    // But we need to verify. Let's just capture current state.
    const preEnterCollect = await collectData(term, 100)

    // Press Enter to select Manual
    term.write('\r')
    const submenuRaw = await drainData(term, 3000)
    analyzeRaw(submenuRaw, 'SUBMENU AFTER ENTER (Manual)')

    // ═══════════════════════════════════════════════════════════
    // TEST 6: Navigate submenu with arrows
    // ═══════════════════════════════════════════════════════════
    const submenuClean = stripVTControlCharacters(submenuRaw)
    if (submenuClean.includes('gemini-3') || submenuClean.includes('gemini-2')) {
      log.pass('Submenu with model list detected!')

      // Try UP
      log.step('TEST 6: UP in submenu...')
      term.write('\x1b[A')
      const subUp = await drainData(term, 1000)
      analyzeRaw(subUp, 'SUBMENU AFTER UP')

      // DOWN
      log.step('DOWN in submenu...')
      term.write('\x1b[B')
      const subDown = await drainData(term, 1000)
      analyzeRaw(subDown, 'SUBMENU AFTER DOWN')
    } else {
      log.warn('No submenu detected, clean text:')
      console.log(submenuClean)
    }

    // Escape to close
    log.step('Pressing Escape to close...')
    term.write('\x1b')
    await drainData(term, 1000)

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══════════════════════════════════════${c.reset}`)
    console.log(`${c.bold}  FINDINGS SUMMARY${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)
    console.log(`  This test captured raw PTY output from Gemini CLI's /model menu.`)
    console.log(`  Check the output above for:`)
    console.log(`  - ANSI color codes used for selected items (●)`)
    console.log(`  - Whether sync markers are present`)
    console.log(`  - How navigation (UP/DOWN) changes the output`)
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)

  } finally {
    // Kill gemini and shell
    log.step('Cleaning up...')
    term.write('\x03') // Ctrl+C
    await sleep(500)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
