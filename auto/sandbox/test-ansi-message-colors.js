/**
 * Exploration: ANSI background/foreground colors in message output
 *
 * Goal: Determine if Claude Code / Gemini CLI use distinct ANSI background
 * colors (48;2;R;G;B) for user vs assistant messages — which would give us
 * 100% deterministic message boundaries for timeline scroll.
 *
 * Run: node auto/sandbox/test-ansi-message-colors.js [gemini|claude]
 */

const pty = require('node-pty')
const { stripVTControlCharacters } = require('node:util')

const mode = process.argv[2] || 'gemini'

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

function waitForText(term, text, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { handler.dispose(); resolve(buf) }, timeoutMs)
    const handler = term.onData((data) => {
      buf += data
      if (stripVTControlCharacters(buf).includes(text)) {
        clearTimeout(timer)
        handler.dispose()
        resolve(buf)
      }
    })
  })
}

function analyzeColors(raw, label) {
  console.log(`\n${c.bold}═══ ${label} (${raw.length} bytes) ═══${c.reset}`)

  // FG RGB
  const fgMatches = [...raw.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)]
  const fgUnique = new Map()
  for (const m of fgMatches) {
    const key = `RGB(${m[1]},${m[2]},${m[3]})`
    fgUnique.set(key, (fgUnique.get(key) || 0) + 1)
  }
  if (fgUnique.size > 0) {
    console.log(`${c.green}FG colors (${fgUnique.size}):${c.reset}`)
    for (const [k, count] of fgUnique) console.log(`  ${k} x${count}`)
  }

  // BG RGB
  const bgMatches = [...raw.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)]
  const bgUnique = new Map()
  for (const m of bgMatches) {
    const key = `BG(${m[1]},${m[2]},${m[3]})`
    bgUnique.set(key, (bgUnique.get(key) || 0) + 1)
  }
  if (bgUnique.size > 0) {
    console.log(`${c.yellow}BG colors (${bgUnique.size}):${c.reset}`)
    for (const [k, count] of bgUnique) console.log(`  ${k} x${count}`)
  } else {
    console.log(`${c.dim}No BG RGB colors found${c.reset}`)
  }

  // Standard BG codes (non-RGB)
  const stdBg = [...raw.matchAll(/\x1b\[(4[0-7]|10[0-7])m/g)]
  const stdBgUnique = new Map()
  for (const m of stdBg) {
    const key = `SGR ${m[1]}`
    stdBgUnique.set(key, (stdBgUnique.get(key) || 0) + 1)
  }
  if (stdBgUnique.size > 0) {
    console.log(`${c.dim}Standard BG codes:${c.reset}`)
    for (const [k, count] of stdBgUnique) console.log(`  ${k} x${count}`)
  }

  // 256-color BG
  const bg256 = [...raw.matchAll(/\x1b\[48;5;(\d+)m/g)]
  const bg256Unique = new Map()
  for (const m of bg256) {
    const key = `BG256(${m[1]})`
    bg256Unique.set(key, (bg256Unique.get(key) || 0) + 1)
  }
  if (bg256Unique.size > 0) {
    console.log(`${c.dim}256-color BG:${c.reset}`)
    for (const [k, count] of bg256Unique) console.log(`  ${k} x${count}`)
  }

  // Show where BG colors appear in context
  if (bgMatches.length > 0) {
    console.log(`\n${c.bold}BG color context (first 5 occurrences):${c.reset}`)
    const shown = new Set()
    let count = 0
    for (const m of bgMatches) {
      if (count >= 5) break
      const key = `BG(${m[1]},${m[2]},${m[3]})`
      if (shown.has(key)) continue
      shown.add(key)
      count++

      const idx = m.index
      const before = raw.substring(Math.max(0, idx - 60), idx)
      const after = raw.substring(idx, Math.min(raw.length, idx + 120))
      const contextClean = stripVTControlCharacters(before + after)
      console.log(`  ${c.yellow}${key}${c.reset} near: "${contextClean.trim().substring(0, 80)}"`)
    }
  }

  // Clean text snippet
  const clean = stripVTControlCharacters(raw)
  console.log(`\n${c.dim}--- Clean text (first 400 chars): ---${c.reset}`)
  console.log(clean.replace(/\n{3,}/g, '\n\n').substring(0, 400))
  console.log(`${c.dim}--- end ---${c.reset}`)
}

async function testGemini() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'
  log.step('Spawning PTY for Gemini...')
  const term = pty.spawn('zsh', ['-l'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  })

  try {
    await drainData(term, 2000)
    log.step('Starting gemini...')
    term.write('gemini\r')
    await waitForText(term, '>', 30000)
    await drainData(term, 2000)
    log.pass('Gemini ready')

    // Send a message and capture the FULL exchange
    log.step('Sending message: "say hello world"')
    term.write('\x01\x0b')
    await sleep(100)

    // Start capturing BEFORE sending
    let fullCapture = ''
    const handler = term.onData((data) => { fullCapture += data })

    term.write('\x1b[200~say hello world\x1b[201~')
    await sleep(300)
    term.write('\r')

    // Wait for response to complete (silence)
    await sleep(20000)
    await drainData(term, 3000)
    handler.dispose()

    analyzeColors(fullCapture, 'GEMINI: Full message exchange (user prompt + AI response)')

    // Send second message
    log.step('Sending message 2: "what is 2+2"')
    let capture2 = ''
    const handler2 = term.onData((data) => { capture2 += data })

    term.write('\x01\x0b')
    await sleep(100)
    term.write('\x1b[200~what is 2+2\x1b[201~')
    await sleep(300)
    term.write('\r')

    await sleep(15000)
    await drainData(term, 3000)
    handler2.dispose()

    analyzeColors(capture2, 'GEMINI: Second message exchange')

  } finally {
    term.write('\x03')
    await sleep(500)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

async function testClaude() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'
  log.step('Spawning PTY for Claude Code...')
  const term = pty.spawn('zsh', ['-l'], {
    name: 'xterm-256color', cols: 120, rows: 40, cwd,
    env: { ...process.env, TERM: 'xterm-256color' }
  })

  try {
    await drainData(term, 2000)
    log.step('Starting claude...')
    term.write('claude\r')

    // Wait for Claude prompt (⏵ or ❯)
    const initRaw = await waitForText(term, 'Claude Code', 30000)
    await drainData(term, 3000)
    log.pass('Claude ready')

    analyzeColors(initRaw, 'CLAUDE: Initialization / welcome screen')

    // Send a message
    log.step('Sending message: "say hello world, nothing else"')
    let fullCapture = ''
    const handler = term.onData((data) => { fullCapture += data })

    term.write('\x1b[200~say hello world, nothing else\x1b[201~')
    await sleep(300)
    term.write('\r')

    // Wait for response
    await sleep(20000)
    await drainData(term, 3000)
    handler.dispose()

    analyzeColors(fullCapture, 'CLAUDE: Full message exchange (user prompt + AI response)')

    // Send second message
    log.step('Sending message 2: "what is 2+2, just the number"')
    let capture2 = ''
    const handler2 = term.onData((data) => { capture2 += data })

    term.write('\x1b[200~what is 2+2, just the number\x1b[201~')
    await sleep(300)
    term.write('\r')

    await sleep(15000)
    await drainData(term, 3000)
    handler2.dispose()

    analyzeColors(capture2, 'CLAUDE: Second message exchange')

  } finally {
    term.write('\x03')
    await sleep(1000)
    term.write('\x03')
    await sleep(500)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

async function main() {
  console.log(`${c.bold}═══ ANSI Message Color Explorer (${mode}) ═══${c.reset}\n`)

  if (mode === 'gemini') {
    await testGemini()
  } else if (mode === 'claude') {
    await testClaude()
  } else {
    log.fail('Usage: node test-ansi-message-colors.js [gemini|claude]')
    process.exit(1)
  }

  console.log(`\n${c.bold}═══ DONE ═══${c.reset}`)
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
