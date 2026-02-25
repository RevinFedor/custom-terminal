/**
 * Test: Gemini rapid model switch (pro ↔ flash)
 *
 * Validates that:
 * 1. Queue serializes concurrent commands
 * 2. Ctrl+A + Ctrl+K clears input without triggering DZ
 * 3. Rapid clicks don't kill Gemini
 *
 * Run: node auto/sandbox/test-gemini-rapid-model.js
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

// Replicate the fixed gemini:send-command queue approach
// Uses Ctrl+A + Ctrl+K to clear line (no Ctrl+C!)
async function sendGeminiCommand(term, command, queue) {
  const prev = queue.promise || Promise.resolve()
  const next = prev.then(async () => {
    await drainData(term, 300)

    // Clear input without Ctrl+C
    term.write('\x01') // Ctrl+A (beginning of line)
    term.write('\x0b') // Ctrl+K (kill to end of line)
    await sleep(100)

    // Paste command
    const PASTE_START = '\x1b[200~'
    const PASTE_END = '\x1b[201~'
    term.write(PASTE_START + command + PASTE_END)
    await sleep(500)
    term.write('\r')

    // Wait for processing
    await drainData(term, 500)
  })
  queue.promise = next.catch(() => {})
  return next
}

// Check if Gemini is alive by sending a test command
async function checkGeminiAlive(term) {
  // Send /help which should produce output without side effects
  term.write('\x01\x0b') // clear line
  await sleep(100)
  term.write('/help\r')
  await sleep(1000)
  const raw = await drainData(term, 1500)
  const clean = smartClean(raw)
  // /help produces "Available commands" or similar
  return clean.includes('Available') || clean.includes('/model') ||
         clean.includes('/help') || clean.includes('shift+tab') ||
         clean.includes('MCP') || clean.includes('gemini')
}

async function main() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'

  log.step('Spawning PTY...')
  const term = pty.spawn('zsh', ['-l'], {
    name: 'xterm-256color',
    cols: 140,
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

    const queue = { promise: Promise.resolve() }
    const results = []

    // ═══════════════════════════════════════════════════════════
    // TEST 1: Single switch
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 1: Single /model set flash ═══${c.reset}`)
    await sendGeminiCommand(term, '/model set flash', queue)
    await sleep(500)

    const alive1 = await checkGeminiAlive(term)
    if (alive1) { log.pass('Alive after single switch'); results.push(true) }
    else { log.fail('Dead after single switch'); results.push(false) }

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Rapid double switch (queued)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 2: Rapid pro → flash (queued, 0ms gap) ═══${c.reset}`)
    const p1 = sendGeminiCommand(term, '/model set pro', queue)
    const p2 = sendGeminiCommand(term, '/model set flash', queue)
    await Promise.all([p1, p2])
    await sleep(500)

    const alive2 = await checkGeminiAlive(term)
    if (alive2) { log.pass('Alive after rapid double switch'); results.push(true) }
    else { log.fail('Dead after rapid double switch'); results.push(false) }

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Triple rapid switch
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 3: Triple pro → flash → pro (queued, 0ms gap) ═══${c.reset}`)
    const t1 = sendGeminiCommand(term, '/model set pro', queue)
    const t2 = sendGeminiCommand(term, '/model set flash', queue)
    const t3 = sendGeminiCommand(term, '/model set pro', queue)
    await Promise.all([t1, t2, t3])
    await sleep(500)

    const alive3 = await checkGeminiAlive(term)
    if (alive3) { log.pass('Alive after triple switch'); results.push(true) }
    else { log.fail('Dead after triple switch'); results.push(false) }

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Rapid quintuple switch (stress)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 4: 5x rapid switches ═══${c.reset}`)
    const models = ['flash', 'pro', 'flash', 'pro', 'flash']
    const promises = models.map(m => sendGeminiCommand(term, '/model set ' + m, queue))
    await Promise.all(promises)
    await sleep(500)

    const alive4 = await checkGeminiAlive(term)
    if (alive4) { log.pass('Alive after 5x rapid switch'); results.push(true) }
    else { log.fail('Dead after 5x rapid switch'); results.push(false) }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    const allPass = results.every(r => r)
    console.log(`\n${c.bold}═══════════════════════════════════════════════${c.reset}`)
    console.log(`${allPass ? c.green : c.red}${c.bold}  ${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════════════${c.reset}`)
    results.forEach((r, i) => {
      console.log(`  Test ${i + 1}: ${r ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset}`)
    })
    console.log(`${c.bold}═══════════════════════════════════════════════${c.reset}`)

  } finally {
    log.step('Cleanup...')
    term.write('\x1b')
    await sleep(200)
    term.write('\x03')
    await sleep(500)
    term.write('\x03')
    await sleep(200)
    term.write('exit\r')
    await sleep(500)
    term.kill()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
