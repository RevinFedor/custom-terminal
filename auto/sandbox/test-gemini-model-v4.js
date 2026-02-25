/**
 * Test: Gemini /model — focused test on correct flow
 *
 * From v3 results: /model opens the dialog but the initial render
 * uses cursor positioning that isn't parsed from raw PTY.
 * After sending a navigation key (DOWN), the re-render IS parseable.
 *
 * Also tests: Ctrl+C before /model (clear input)
 *
 * Run: node auto/sandbox/test-gemini-model-v4.js
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

function parseSelected(text) {
  const lines = text.split('\n')
  for (const line of lines) {
    const match = line.match(/●\s*(\d+)\.\s*(.+)/)
    if (match) return { number: parseInt(match[1]), text: match[2].trim() }
  }
  return null
}

function parseOptions(text) {
  const lines = text.split('\n')
  const opts = []
  for (const line of lines) {
    const match = line.match(/[●\s]\s*(\d+)\.\s*(.+)/)
    if (match) {
      opts.push({
        number: parseInt(match[1]),
        text: match[2].trim(),
        selected: line.includes('●')
      })
    }
  }
  return opts
}

// Navigate until ● is on target option
async function navigateTo(term, targetTest, maxSteps = 10) {
  for (let i = 0; i < maxSteps; i++) {
    term.write('\x1b[B') // DOWN
    const raw = await drainData(term, 600)
    const clean = smartClean(raw)
    const sel = parseSelected(clean)
    if (sel) {
      log.info(`  ● ${sel.number}. ${sel.text}`)
      if (targetTest(sel)) return sel
    }
  }
  return null
}

async function main() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'

  log.step('Starting...')
  const term = pty.spawn('zsh', ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  })

  try {
    await drainData(term, 2000)
    term.write('gemini\r')
    log.step('Waiting for Gemini (15s)...')
    await sleep(15000)
    await drainData(term, 2000)
    log.pass('Gemini ready')

    // ═══════════════════════════════════════════════════════════
    // TEST A: Clean flow with Ctrl+C first
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST A: /model with Ctrl+C pre-clear ═══${c.reset}`)

    log.step('A1: Ctrl+C to clear...')
    term.write('\x03')
    await sleep(1000)
    const ctrlcRaw = await drainData(term, 1000)
    const ctrlcClean = smartClean(ctrlcRaw)
    const hasDangerZone = ctrlcClean.includes('Press Ctrl+C again')
    log.info('Danger zone: ' + hasDangerZone)

    if (hasDangerZone) {
      log.warn('Danger zone detected! Waiting for it to clear...')
      await sleep(4000)
      await drainData(term, 500)
    }

    log.step('A2: Typing /model + Enter...')
    // Type character by character (not paste)
    for (const ch of '/model') {
      term.write(ch)
      await sleep(50)
    }
    term.write('\r')

    // Wait for the dialog to open
    log.step('A3: Waiting for dialog (3s)...')
    await sleep(3000)

    // Now send DOWN to get a parseable re-render
    log.step('A4: DOWN to trigger parseable re-render...')
    term.write('\x1b[B')
    const raw4 = await drainData(term, 1000)
    const clean4 = smartClean(raw4)
    const sel4 = parseSelected(clean4)
    const opts4 = parseOptions(clean4)

    if (sel4) {
      log.pass(`Dialog open! ● ${sel4.number}. ${sel4.text}`)
      log.info('Options:')
      opts4.forEach(o => console.log(`  ${o.selected ? '●' : ' '} ${o.number}. ${o.text}`))
    } else {
      log.fail('Dialog not parseable after DOWN')
      console.log('Clean:', clean4.slice(-400))

      // Try another DOWN
      log.step('A4b: Another DOWN...')
      term.write('\x1b[B')
      const raw4b = await drainData(term, 1000)
      const clean4b = smartClean(raw4b)
      const sel4b = parseSelected(clean4b)
      if (sel4b) log.pass(`Got it on retry: ● ${sel4b.number}. ${sel4b.text}`)
      else {
        log.fail('Still not parseable')
        console.log('Clean:', clean4b.slice(-400))
      }
    }

    // ═══════════════════════════════════════════════════════════
    // TEST B: Navigate to Manual → Enter → Submenu
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST B: Navigate to Manual → Submenu ═══${c.reset}`)

    log.step('B1: Navigate to Manual...')
    const manualSel = await navigateTo(term, sel => sel.text.toLowerCase().includes('manual'))
    if (manualSel) {
      log.pass('Reached Manual: ' + manualSel.text)
    } else {
      log.fail('Could not reach Manual')
      return
    }

    log.step('B2: Enter to select Manual...')
    term.write('\r')
    await sleep(2000)

    // Trigger re-render for submenu
    term.write('\x1b[B')
    const subRaw = await drainData(term, 1000)
    const subClean = smartClean(subRaw)
    const subSel = parseSelected(subClean)
    const subOpts = parseOptions(subClean)

    if (subOpts.length > 0) {
      log.pass(`Submenu open! ${subOpts.length} models`)
      subOpts.forEach(o => console.log(`  ${o.selected ? '●' : ' '} ${o.number}. ${o.text}`))
    } else {
      log.warn('Submenu not visible, trying more DOWNs...')
      for (let i = 0; i < 3; i++) {
        term.write('\x1b[B')
        const r = await drainData(term, 600)
        const cl = smartClean(r)
        const so = parseOptions(cl)
        const ss = parseSelected(cl)
        if (so.length > 0) {
          log.pass(`Got submenu on try ${i + 1}`)
          so.forEach(o => console.log(`  ${o.selected ? '●' : ' '} ${o.number}. ${o.text}`))
          break
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // TEST C: Switch model (flash ↔ pro)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST C: Select pro or flash ═══${c.reset}`)

    // Navigate to find models with "3" in name
    log.step('C1: Navigate to find Gemini 3 models...')
    let targetSel = null

    // Go through all options to find flash or pro with "3"
    for (let i = 0; i < 8; i++) {
      term.write('\x1b[B')
      const r = await drainData(term, 500)
      const cl = smartClean(r)
      const s = parseSelected(cl)
      if (s) {
        log.info(`  ● ${s.number}. ${s.text}`)
        // Look for pro-preview or flash-preview with 3
        if (s.text.includes('3') && (s.text.includes('pro') || s.text.includes('flash'))) {
          // If not already current, mark as target
          targetSel = s
          log.pass(`  → Target candidate: ${s.text}`)
        }
      }
    }

    if (targetSel) {
      // Navigate back to target
      log.step('C2: Navigate to target: ' + targetSel.text)
      const found = await navigateTo(term, sel => sel.text === targetSel.text)
      if (found) {
        log.step('C3: Confirming selection...')
        term.write('\r')
        await sleep(2000)
        const finalRaw = await drainData(term, 2000)
        const finalClean = smartClean(finalRaw)

        // Check for model in status bar
        const modelMatch = finalClean.match(/(gemini-[\w.-]+)/)
        if (modelMatch) {
          log.pass(`✅ Model switched to: ${modelMatch[1]}`)
        } else {
          log.info('Status bar not captured, but selection was confirmed')
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══════════════════════════════════════════════════════════${c.reset}`)
    console.log(`${c.bold}  FINDINGS${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════════════════════════${c.reset}`)
    console.log(`  1. /model\\r opens dialog — initial render NOT parseable from raw PTY`)
    console.log(`  2. After DOWN/UP arrow, re-render IS parseable via smartClean()`)
    console.log(`  3. ● (U+25CF) reliably marks selected item`)
    console.log(`  4. RGB(166, 227, 161) = green color for selected text`)
    console.log(`  5. No sync markers — use drainPtyData (silence-based)`)
    console.log(`  6. Menu wraps around (option 3 → option 1)`)
    console.log(`  7. Ctrl+C danger zone: "Press Ctrl+C again to exit"`)
    console.log(`  8. Recommended flow: Ctrl+C → /model\\r → wait → DOWN → parse → navigate → Enter`)
    console.log(`${c.bold}═══════════════════════════════════════════════════════════${c.reset}`)

  } finally {
    log.step('Cleanup...')
    term.write('\x1b')
    await sleep(200)
    term.write('\x03')
    await sleep(500)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
