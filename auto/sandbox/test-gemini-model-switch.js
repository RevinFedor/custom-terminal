/**
 * Test: Gemini /model — raw data analysis + proper parsing (v3)
 *
 * Key issue: Gemini renders modal with cursor positioning (CSI H/f sequences)
 * stripVTControlCharacters strips them → text is there but unstructured.
 * Need to check what the raw data actually contains.
 *
 * Run: node auto/sandbox/test-gemini-model-switch.js
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

// Better approach: replace cursor positioning with newlines,
// then strip remaining ANSI, then parse
function smartClean(raw) {
  // Replace cursor position codes \x1b[row;colH with newlines
  let text = raw.replace(/\x1b\[\d+;\d+[Hf]/g, '\n')
  // Replace cursor forward \x1b[nC with spaces
  text = text.replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n) || 1))
  // Replace cursor up/down/back movement with newlines
  text = text.replace(/\x1b\[\d*[ABD]/g, '\n')
  // Strip remaining ANSI
  text = stripVTControlCharacters(text)
  return text
}

// Parse ● from smart-cleaned text
function parseSelected(text) {
  const lines = text.split('\n')
  for (const line of lines) {
    const match = line.match(/●\s*(\d+)\.\s*(.+)/)
    if (match) return { number: parseInt(match[1]), text: match[2].trim() }
  }
  return null
}

// Parse all numbered options
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
    term.write('gemini\r')
    await sleep(15000)
    await drainData(term, 2000)
    log.pass('Gemini ready')

    // ═══════════════════════════════════════════════════════════
    // Step 1: Send /model
    // ═══════════════════════════════════════════════════════════
    log.step('Sending /model...')
    term.write('/model\r')
    await sleep(3000)

    // Collect everything
    const raw1 = await drainData(term, 1500)
    const clean1 = smartClean(raw1)
    console.log(`\n${c.bold}=== After /model (${raw1.length}B raw, smartClean): ===${c.reset}`)
    console.log(clean1.slice(-800))

    const has1 = clean1.includes('Select') || clean1.includes('Manual') || clean1.includes('●')
    log.info('Has menu markers: ' + has1)

    // ═══════════════════════════════════════════════════════════
    // Step 2: Send DOWN to trigger re-render, capture it
    // ═══════════════════════════════════════════════════════════
    log.step('Sending DOWN arrow...')
    term.write('\x1b[B')
    const raw2 = await drainData(term, 1000)
    const clean2 = smartClean(raw2)
    console.log(`\n${c.bold}=== After DOWN (${raw2.length}B raw, smartClean): ===${c.reset}`)
    console.log(clean2.slice(-800))

    const sel2 = parseSelected(clean2)
    if (sel2) log.pass('Detected: ● ' + sel2.number + '. ' + sel2.text)
    else log.warn('No ● found in DOWN output')

    // ═══════════════════════════════════════════════════════════
    // Step 3: Send UP, capture
    // ═══════════════════════════════════════════════════════════
    log.step('Sending UP arrow...')
    term.write('\x1b[A')
    const raw3 = await drainData(term, 1000)
    const clean3 = smartClean(raw3)
    console.log(`\n${c.bold}=== After UP (${raw3.length}B raw, smartClean): ===${c.reset}`)
    console.log(clean3.slice(-800))

    const sel3 = parseSelected(clean3)
    if (sel3) log.pass('Detected: ● ' + sel3.number + '. ' + sel3.text)
    else log.warn('No ● found in UP output')

    // ═══════════════════════════════════════════════════════════
    // Step 4: Navigate to Manual (option 3), go DOWN until we reach it
    // ═══════════════════════════════════════════════════════════
    log.step('Navigating to Manual (going to bottom)...')
    for (let i = 0; i < 5; i++) {
      term.write('\x1b[B')
      const navRaw = await drainData(term, 500)
      const navClean = smartClean(navRaw)
      const navSel = parseSelected(navClean)
      if (navSel) {
        log.info('  ● ' + navSel.number + '. ' + navSel.text)
        if (navSel.text.toLowerCase().includes('manual')) {
          log.pass('  Reached Manual!')
          break
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // Step 5: Press Enter → submenu
    // ═══════════════════════════════════════════════════════════
    log.step('Pressing Enter to open Manual submenu...')
    term.write('\r')
    await sleep(2000)
    const raw5 = await drainData(term, 1500)
    const clean5 = smartClean(raw5)
    console.log(`\n${c.bold}=== After Enter (${raw5.length}B, submenu?): ===${c.reset}`)
    console.log(clean5.slice(-800))

    const subOpts = parseOptions(clean5)
    const subSel = parseSelected(clean5)
    if (subOpts.length > 0) {
      log.pass('Submenu parsed: ' + subOpts.length + ' options')
      subOpts.forEach(o => console.log(`  ${o.selected ? '●' : ' '} ${o.number}. ${o.text}`))
    }

    // Try DOWN to trigger re-render if submenu not visible
    if (subOpts.length === 0) {
      log.info('Trying DOWN for re-render...')
      term.write('\x1b[B')
      const raw5b = await drainData(term, 1000)
      const clean5b = smartClean(raw5b)
      console.log(`\n${c.bold}=== Submenu re-render: ===${c.reset}`)
      console.log(clean5b.slice(-800))

      const subOpts2 = parseOptions(clean5b)
      const subSel2 = parseSelected(clean5b)
      if (subOpts2.length > 0) {
        log.pass('Submenu after re-render: ' + subOpts2.length + ' options')
        subOpts2.forEach(o => console.log(`  ${o.selected ? '●' : ' '} ${o.number}. ${o.text}`))
      }
    }

    // ═══════════════════════════════════════════════════════════
    // Step 6: Navigate submenu and confirm
    // ═══════════════════════════════════════════════════════════
    log.step('Navigating submenu to find flash/pro...')
    for (let i = 0; i < 6; i++) {
      term.write('\x1b[B')
      const navRaw = await drainData(term, 500)
      const navClean = smartClean(navRaw)
      const navSel = parseSelected(navClean)
      const navOpts = parseOptions(navClean)
      if (navSel) log.info(`  ● ${navSel.number}. ${navSel.text}`)
      if (navOpts.length > 0 && !subOpts.length) {
        log.pass('  Submenu options found!')
        navOpts.forEach(o => console.log(`    ${o.selected ? '●' : ' '} ${o.number}. ${o.text}`))
      }
    }

    // Navigate back up
    log.step('Going UP in submenu...')
    for (let i = 0; i < 6; i++) {
      term.write('\x1b[A')
      const navRaw = await drainData(term, 500)
      const navClean = smartClean(navRaw)
      const navSel = parseSelected(navClean)
      if (navSel) log.info(`  ● ${navSel.number}. ${navSel.text}`)
    }

    // Confirm selection
    log.step('Confirming with Enter...')
    term.write('\r')
    const confirmRaw = await drainData(term, 3000)
    const confirmClean = smartClean(confirmRaw)
    const modelMatch = confirmClean.match(/(gemini-[\w.-]+)/)
    if (modelMatch) log.pass('Model: ' + modelMatch[1])

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ SUMMARY ═══${c.reset}`)
    console.log(`  smartClean() works for cursor-positioned renders: YES/NO (check above)`)
    console.log(`  ● detection reliable: check above`)
    console.log(`  Submenu parsing: check above`)
    console.log(`${c.bold}═══════════════${c.reset}`)

  } finally {
    log.step('Cleanup...')
    term.write('\x1b') // ESC to close any menu
    await sleep(300)
    term.write('\x03') // Ctrl+C
    await sleep(500)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
