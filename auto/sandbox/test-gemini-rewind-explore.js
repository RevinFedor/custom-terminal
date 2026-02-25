/**
 * Exploration v3: Gemini CLI /rewind
 *
 * Previous test showed: UP arrow = input history cycling (not rewind menu)
 * Esc+Esc with long delay = no menu opened
 *
 * This test tries:
 * 1. /rewind command
 * 2. Esc → short delay → Esc (200ms gap)
 * 3. Full raw dump including "Press Esc again to rewind" banner
 *
 * Run: node auto/sandbox/test-gemini-rewind-explore.js
 */

const pty = require('node-pty')
const { stripVTControlCharacters } = require('node:util')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function captureFor(term, ms) {
  return new Promise((resolve) => {
    let buf = ''
    const handler = term.onData((data) => { buf += data })
    setTimeout(() => { handler.dispose(); resolve(buf) }, ms)
  })
}

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

function smartClean(raw) {
  let text = raw.replace(/\x1b\[\d+;\d+[Hf]/g, '\n')
  text = text.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n) || 1))
  text = text.replace(/\x1b\[\d*[ABD]/g, '\n')
  text = stripVTControlCharacters(text)
  return text
}

function dumpRawAnsi(raw, label, fullClean = false) {
  console.log(`\n${c.bold}═══ ${label} (${raw.length}B) ═══${c.reset}`)

  const rgbMatches = raw.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)
  const rgbColors = new Set()
  for (const m of rgbMatches) { rgbColors.add(`RGB(${m[1]},${m[2]},${m[3]})`) }
  if (rgbColors.size > 0) console.log(`${c.green}RGB: ${[...rgbColors].join(', ')}${c.reset}`)

  const bgRgbMatches = raw.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)
  const bgRgbColors = new Set()
  for (const m of bgRgbMatches) { bgRgbColors.add(`BG(${m[1]},${m[2]},${m[3]})`) }
  if (bgRgbColors.size > 0) console.log(`${c.green}BG: ${[...bgRgbColors].join(', ')}${c.reset}`)

  if (raw.includes('\x1b[?2026h')) console.log(`${c.yellow}Sync START (?2026h)${c.reset}`)
  if (raw.includes('\x1b[?2026l')) console.log(`${c.yellow}Sync END (?2026l)${c.reset}`)

  const clean = smartClean(raw)
  const specials = ['●', '❯', '→', '▶', '►', '⏵', '◆', '◇', '▸', '✓', '⌵', '╰', '╭', '╮', '╯', '│', '─', '▄', '▀']
  const found = specials.filter(s => clean.includes(s))
  if (found.length > 0) console.log(`${c.yellow}Chars: ${found.join(' ')}${c.reset}`)

  if (fullClean) {
    console.log(`${c.dim}--- FULL smartClean: ---${c.reset}`)
    console.log(clean)
  } else {
    console.log(`${c.dim}--- smartClean (last 600): ---${c.reset}`)
    console.log(clean.slice(-600))
  }
  console.log(`${c.dim}--- end ---${c.reset}`)

  return clean
}

async function main() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'

  log.step('Spawning PTY...')
  const term = pty.spawn('zsh', ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  })

  try {
    await drainData(term, 2000)
    log.step('Starting gemini...')
    const geminiCapture = captureFor(term, 15000)
    term.write('gemini\r')
    await geminiCapture
    log.pass('Gemini ready')

    // Send 3 test messages
    const testMessages = [
      'ALPHA: What is 2+2?',
      'BRAVO: capital of France?',
      'CHARLIE: color of sky?',
    ]

    for (let i = 0; i < testMessages.length; i++) {
      log.step(`Sending: "${testMessages[i]}"`)
      term.write('\x01\x0b')
      await sleep(100)
      term.write('\x1b[200~' + testMessages[i] + '\x1b[201~')
      await sleep(300)
      const responseCapture = captureFor(term, 20000)
      term.write('\r')
      await responseCapture
      await drainData(term, 2000)
      log.pass(`Message ${i + 1} done`)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST A: /rewind command
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST A: /rewind command ═══${c.reset}`)

    log.step('Clearing line, typing /rewind...')
    term.write('\x01\x0b')
    await sleep(100)
    // Type character by character (like user would)
    for (const ch of '/rewind') {
      term.write(ch)
      await sleep(50)
    }
    await sleep(200)

    log.step('Pressing Enter with capture...')
    const rewindCapture = captureFor(term, 8000)
    term.write('\r')
    const rewindRaw = await rewindCapture
    const rewindClean = dumpRawAnsi(rewindRaw, '/rewind response', true)

    // Check for menu markers
    if (rewindClean.includes('●') || rewindClean.includes('❯') || rewindClean.includes('Rewind')) {
      log.pass('Rewind menu found!')
    } else {
      log.warn('No obvious rewind menu markers')
    }

    // If menu opened, try navigation
    if (rewindRaw.length > 500) {
      console.log(`\n${c.bold}═══ TEST A.1: Navigation in /rewind ═══${c.reset}`)

      for (let i = 0; i < 4; i++) {
        log.step(`DOWN #${i + 1}...`)
        const navCap = captureFor(term, 2000)
        term.write('\x1b[B')
        const navRaw = await navCap
        if (navRaw.length > 0) {
          dumpRawAnsi(navRaw, `DOWN #${i + 1}`)
        } else {
          log.warn(`DOWN #${i + 1}: 0B`)
        }
      }

      for (let i = 0; i < 4; i++) {
        log.step(`UP #${i + 1}...`)
        const navCap = captureFor(term, 2000)
        term.write('\x1b[A')
        const navRaw = await navCap
        if (navRaw.length > 0) {
          dumpRawAnsi(navRaw, `UP #${i + 1}`)
        } else {
          log.warn(`UP #${i + 1}: 0B`)
        }
      }

      // Close with Escape
      log.step('Closing with Escape...')
      term.write('\x1b')
      await sleep(2000)
      await drainData(term, 1500)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST B: Esc with SHORT delay → Esc (200ms)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST B: Esc → 200ms → Esc ═══${c.reset}`)

    log.step('Capturing... Esc → 200ms → Esc')
    const escCapture = captureFor(term, 8000)
    term.write('\x1b')
    await sleep(200)
    term.write('\x1b')
    const escRaw = await escCapture
    const escClean = dumpRawAnsi(escRaw, 'Esc(200ms)Esc', true)

    if (escClean.includes('rewind') || escClean.includes('Rewind')) {
      log.pass('Found "rewind" in output!')
    }

    // Try navigation after Esc+Esc
    console.log(`\n${c.bold}═══ TEST B.1: Navigation after Esc+Esc ═══${c.reset}`)
    for (let i = 0; i < 3; i++) {
      log.step(`DOWN #${i + 1}...`)
      const navCap = captureFor(term, 2000)
      term.write('\x1b[B')
      const navRaw = await navCap
      if (navRaw.length > 0) dumpRawAnsi(navRaw, `DOWN #${i + 1}`)
      else log.warn(`DOWN #${i + 1}: 0B`)
    }

    // Close
    term.write('\x1b')
    await sleep(2000)
    await drainData(term, 1500)

    // ═══════════════════════════════════════════════════════════
    // TEST C: Esc with LONGER delay → Esc (1500ms)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST C: Esc → 1500ms → Esc ═══${c.reset}`)

    log.step('Capturing... Esc → 1500ms → Esc')
    const esc2Capture = captureFor(term, 8000)
    term.write('\x1b')
    await sleep(1500)
    term.write('\x1b')
    const esc2Raw = await esc2Capture
    const esc2Clean = dumpRawAnsi(esc2Raw, 'Esc(1500ms)Esc', true)

    // Try navigation
    for (let i = 0; i < 3; i++) {
      log.step(`DOWN #${i + 1}...`)
      const navCap = captureFor(term, 2000)
      term.write('\x1b[B')
      const navRaw = await navCap
      if (navRaw.length > 0) dumpRawAnsi(navRaw, `DOWN #${i + 1}`)
      else log.warn(`DOWN #${i + 1}: 0B`)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST D: Check gemini version
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST D: Gemini version check ═══${c.reset}`)
    term.write('\x1b')
    await sleep(2000)
    await drainData(term, 1500)

    log.step('Sending /help...')
    term.write('\x01\x0b')
    await sleep(100)
    const helpCapture = captureFor(term, 5000)
    term.write('/help\r')
    const helpRaw = await helpCapture
    const helpClean = dumpRawAnsi(helpRaw, '/help response', true)

    console.log(`\n${c.bold}═══ DONE ═══${c.reset}`)

  } finally {
    log.step('Cleanup...')
    term.write('\x1b')
    await sleep(200)
    term.write('\x03')
    await sleep(500)
    term.write('\x03')
    await sleep(300)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
