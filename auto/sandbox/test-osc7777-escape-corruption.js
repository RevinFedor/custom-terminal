/**
 * Test: OSC 7777 Escape Carryover Fix
 *
 * Verifies that OSC 7777 injection no longer corrupts escape sequences
 * split across PTY chunks.
 *
 * Bug: PTY splits "\x1b[38;2;153;153;153m❯" into two chunks.
 * Middleware prepends OSC 7777 to chunk 2, aborting the in-progress CSI.
 * User sees raw "38;2;153;153;153m❯" as text.
 *
 * Fix: escapeCarryover buffers incomplete escape tails and reassembles
 * them into the next chunk before injection.
 *
 * Run: node auto/sandbox/test-osc7777-escape-corruption.js
 */

const { Terminal } = require('@xterm/xterm')
const { assert, log, summary, writeAndWait, createMiddleware, detectIncompleteEscapeTail } = require('../core/headless')

// ── Helpers ──

function readBufferText(term) {
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) {
      const text = line.translateToString(true)
      if (text.trim()) lines.push({ row: i, text: text.trimEnd() })
    }
  }
  return lines
}

function hasEscapeArtifacts(lines) {
  for (const { text } of lines) {
    if (/\d+;2;\d+;\d+;\d+m/.test(text)) return true
    if (/\d+;5;\d+m/.test(text)) return true
    if (/^\[?\d+;\d+/.test(text)) return true
    if (/^\d+m/.test(text)) return true
  }
  return false
}

// ═══════════════════════════════════════════
// A. detectIncompleteEscapeTail unit tests
// ═══════════════════════════════════════════

async function testDetectFunction() {
  log.step('A. detectIncompleteEscapeTail unit tests')

  // Complete sequences → 0
  assert(detectIncompleteEscapeTail('hello') === 0, 'Plain text: 0')
  assert(detectIncompleteEscapeTail('\x1b[38;2;153;153;153m') === 0, 'Complete CSI: 0')
  assert(detectIncompleteEscapeTail('\x1b[0m') === 0, 'Complete reset: 0')
  assert(detectIncompleteEscapeTail('\x1b]7777;prompt:0\x07') === 0, 'Complete OSC with BEL: 0')
  assert(detectIncompleteEscapeTail('text\x1b[32mmore') === 0, 'CSI mid-string complete: 0')

  // Incomplete sequences → >0
  assert(detectIncompleteEscapeTail('\x1b') === 1, 'ESC alone: 1')
  assert(detectIncompleteEscapeTail('\x1b[') === 2, 'ESC[: 2')
  assert(detectIncompleteEscapeTail('\x1b[38') === 4, 'ESC[38: 4 (esc+[+3+8)')
  assert(detectIncompleteEscapeTail('\x1b[38;2;153;153;153') === 18, 'CSI params no final byte: 18')
  assert(detectIncompleteEscapeTail('text\x1b[') === 2, 'Text then ESC[: 2')
  assert(detectIncompleteEscapeTail('text\x1b[38;2') === 6, 'Text then partial CSI: 6')

  // Complete then incomplete
  const mixed = '\x1b[32mtext\x1b['
  assert(detectIncompleteEscapeTail(mixed) === 2, 'Complete CSI + text + incomplete ESC[: 2')

  // OSC incomplete
  assert(detectIncompleteEscapeTail('\x1b]7777;prompt:0') > 0, 'OSC without terminator: >0')
}

// ═══════════════════════════════════════════
// B. Baseline: same-chunk injection (still works)
// ═══════════════════════════════════════════

async function testSameChunkStillWorks() {
  log.step('B. Same-chunk injection still works after fix')

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const markers = new Map()
  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      markers.set(parseInt(data.slice(7), 10), term.registerMarker(0))
    }
    return true
  })

  const mw = createMiddleware()

  // Full cycle in complete chunks (no splitting)
  const chunks = [
    '\u23F5 ',
    'User asks a question\r\n',
    'Claude responds with answer\r\n',
    '\x1b[38;2;55;55;55m\u23F5\x1b[0m ',
  ]

  for (const chunk of chunks) {
    await writeAndWait(term, mw.process(chunk))
  }

  const lines = readBufferText(term)
  log.info('Buffer:')
  lines.forEach(l => log.info(`  [${l.row}] "${l.text}"`))

  assert(!hasEscapeArtifacts(lines), 'No artifacts in same-chunk scenario')
  assert(markers.size === 1, `Marker created (got ${markers.size})`)
  assert(lines.some(l => l.text.includes('\u23F5')), 'Prompt visible')

  term.dispose()
}

// ═══════════════════════════════════════════
// C. THE FIX: chunk split at \x1b[ boundary
// ═══════════════════════════════════════════

async function testChunkSplitAtEscBracket() {
  log.step('C. ★ Chunk split at \\x1b[ — FIX should prevent corruption')

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const markers = new Map()
  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      markers.set(parseInt(data.slice(7), 10), term.registerMarker(0))
    }
    return true
  })

  const mw = createMiddleware()
  mw.process('\u23F5 ')
  mw.process('Claude is working on your request\r\n')

  // Chunk 1: ends with incomplete ESC[
  const chunk1 = mw.process('\x1b[')
  // Chunk 2: rest of CSI + prompt char
  const chunk2 = mw.process('38;2;153;153;153m\u276F\x1b[0m \r\n')

  log.info('Chunk 1: ' + JSON.stringify(chunk1))
  log.info('Chunk 2: ' + JSON.stringify(chunk2))

  await writeAndWait(term, chunk1)
  await writeAndWait(term, chunk2)

  const lines = readBufferText(term)
  log.info('Buffer:')
  lines.forEach(l => log.info(`  [${l.row}] "${l.text}"`))

  assert(!hasEscapeArtifacts(lines), 'NO escape artifacts (fix works!)')
  assert(lines.some(l => l.text.includes('\u276F')), 'Prompt ❯ visible and clean')
  assert(markers.size === 1, `Marker created (got ${markers.size})`)

  term.dispose()
}

// ═══════════════════════════════════════════
// D. Single-byte ESC split
// ═══════════════════════════════════════════

async function testSingleByteEscSplit() {
  log.step('D. Single-byte ESC split — \\x1b alone in chunk1')

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  term.parser.registerOscHandler(7777, () => true)
  const mw = createMiddleware()

  mw.process('\u23F5 ')
  mw.process('Claude working...\r\n')

  const chunk1 = mw.process('\x1b')
  const chunk2 = mw.process('[38;2;153;153;153m\u276F\x1b[0m \r\n')

  log.info('Chunk 1: ' + JSON.stringify(chunk1))
  log.info('Chunk 2: ' + JSON.stringify(chunk2))

  await writeAndWait(term, chunk1)
  await writeAndWait(term, chunk2)

  const lines = readBufferText(term)
  log.info('Buffer:')
  lines.forEach(l => log.info(`  [${l.row}] "${l.text}"`))

  assert(!hasEscapeArtifacts(lines), 'NO artifacts with single-byte ESC split')
  assert(lines.some(l => l.text.includes('\u276F')), 'Prompt ❯ visible')

  term.dispose()
}

// ═══════════════════════════════════════════
// E. Split inside CSI params (\x1b[38 | ;2;153...)
// ═══════════════════════════════════════════

async function testSplitInsideCsiParams() {
  log.step('E. Split inside CSI params — \\x1b[38 in chunk1, ;2;... in chunk2')

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  term.parser.registerOscHandler(7777, () => true)
  const mw = createMiddleware()

  mw.process('\u23F5 ')
  mw.process('Claude response text\r\n')

  const chunk1 = mw.process('\x1b[38')
  const chunk2 = mw.process(';2;153;153;153m\u276F\x1b[0m \r\n')

  log.info('Chunk 1: ' + JSON.stringify(chunk1))
  log.info('Chunk 2: ' + JSON.stringify(chunk2))

  await writeAndWait(term, chunk1)
  await writeAndWait(term, chunk2)

  const lines = readBufferText(term)
  log.info('Buffer:')
  lines.forEach(l => log.info(`  [${l.row}] "${l.text}"`))

  assert(!hasEscapeArtifacts(lines), 'NO artifacts with mid-params split')
  assert(lines.some(l => l.text.includes('\u276F')), 'Prompt ❯ visible')

  term.dispose()
}

// ═══════════════════════════════════════════
// F. All color types survive chunk split
// ═══════════════════════════════════════════

async function testAllColorTypes() {
  log.step('F. All color types survive chunk split + middleware')

  const patterns = [
    { name: 'Truecolor RGB(153,153,153)', code: '38;2;153;153;153m' },
    { name: 'Truecolor RGB(136,136,136)', code: '38;2;136;136;136m' },
    { name: 'Truecolor RGB(55,55,55)',    code: '38;2;55;55;55m' },
    { name: '256-color',                  code: '38;5;245m' },
    { name: 'Basic green',                code: '32m' },
  ]

  for (const { name, code } of patterns) {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.parser.registerOscHandler(7777, () => true)
    const mw = createMiddleware()

    mw.process('\u23F5 ')
    mw.process('Claude says something interesting\r\n')

    const chunk1 = mw.process('\x1b[')
    const chunk2 = mw.process(code + '\u276F\x1b[0m \r\n')

    await writeAndWait(term, chunk1)
    await writeAndWait(term, chunk2)

    const lines = readBufferText(term)
    const clean = !hasEscapeArtifacts(lines)

    if (!clean) {
      log.warn(`  ${name}: STILL CORRUPTED`)
      lines.forEach(l => log.info(`    [${l.row}] "${l.text}"`))
    }

    assert(clean, `${name}: no corruption after fix`)
    term.dispose()
  }
}

// ═══════════════════════════════════════════
// G. Idle state — no buffering, no side effects
// ═══════════════════════════════════════════

async function testIdleNoSideEffects() {
  log.step('G. Idle state — chunk split handled by xterm.js natively')

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const mw = createMiddleware()

  mw.process('\u23F5 ')  // stays idle

  // Chunk split while idle — middleware should pass through unchanged
  const chunk1 = mw.process('\x1b[')
  const chunk2 = mw.process('38;2;153;153;153m\u276F\x1b[0m \r\n')

  assert(chunk1 === '\x1b[', 'Idle: chunk1 passed through unchanged')
  assert(!chunk2.includes('\x1b]7777'), 'Idle: no OSC injection')

  await writeAndWait(term, chunk1)
  await writeAndWait(term, chunk2)

  const lines = readBufferText(term)
  assert(!hasEscapeArtifacts(lines), 'Idle: no artifacts (xterm handles natively)')

  term.dispose()
}

// ═══════════════════════════════════════════
// H. Realistic multi-exchange Claude session
// ═══════════════════════════════════════════

async function testRealisticSession() {
  log.step('H. Realistic multi-exchange Claude session with split prompts')

  const term = new Terminal({ cols: 80, rows: 40, allowProposedApi: true })
  const markers = new Map()
  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      markers.set(parseInt(data.slice(7), 10), term.registerMarker(0))
    }
    return true
  })

  const mw = createMiddleware()

  // Exchange 1: normal (no split)
  const session1 = [
    '\x1b[38;2;55;55;55m\u23F5\x1b[0m ',
    'What is 2+2?\r\n',
    '\x1b[38;2;200;200;200mThe answer is 4.\x1b[0m\r\n',
    '\x1b[38;2;55;55;55m\u23F5\x1b[0m ',
  ]

  // Exchange 2: prompt split at \x1b[ boundary
  const session2 = [
    'Explain recursion\r\n',
    '\x1b[38;2;200;200;200mRecursion is when a function calls itself.\x1b[0m\r\n',
    '\x1b[',                                    // ← chunk split!
    '38;2;55;55;55m\u23F5\x1b[0m ',             // ← rest of prompt
  ]

  // Exchange 3: prompt split at single ESC byte
  const session3 = [
    'What about fibonacci?\r\n',
    '\x1b[1mFibonacci: 1 1 2 3 5 8 13...\x1b[0m\r\n',
    '\x1b',                                     // ← single ESC
    '[38;2;55;55;55m\u23F5\x1b[0m ',            // ← rest
  ]

  for (const chunks of [session1, session2, session3]) {
    for (const chunk of chunks) {
      await writeAndWait(term, mw.process(chunk))
    }
  }

  const lines = readBufferText(term)
  log.info('Buffer:')
  lines.forEach(l => log.info(`  [${l.row}] "${l.text}"`))
  log.info('Markers: ' + markers.size)

  assert(!hasEscapeArtifacts(lines), 'No artifacts in full realistic session')
  assert(markers.size === 3, `3 markers created (got ${markers.size})`)

  // Markers should be ascending
  const mLines = [...markers.values()].map(m => m.line)
  const asc = mLines.every((v, i) => i === 0 || v > mLines[i - 1])
  assert(asc, `Markers ascending: [${mLines.join(', ')}]`)

  term.dispose()
}

// ═══════════════════════════════════════════
// I. Both prompt chars ❯ and ⏵
// ═══════════════════════════════════════════

async function testBothPromptChars() {
  log.step('I. Both prompt chars (❯ and ⏵) survive chunk split')

  for (const { char, name } of [
    { char: '\u276F', name: '❯ (U+276F)' },
    { char: '\u23F5', name: '⏵ (U+23F5)' },
  ]) {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    term.parser.registerOscHandler(7777, () => true)
    const mw = createMiddleware()

    mw.process(char + ' ')
    mw.process('Claude response text here\r\n')
    const c1 = mw.process('\x1b[')
    const c2 = mw.process('38;2;153;153;153m' + char + '\x1b[0m \r\n')

    await writeAndWait(term, c1)
    await writeAndWait(term, c2)

    const lines = readBufferText(term)
    assert(!hasEscapeArtifacts(lines), `${name}: no corruption`)
    assert(lines.some(l => l.text.includes(char)), `${name}: prompt visible`)
    term.dispose()
  }
}

// ═══════════════════════════════════════════

async function main() {
  log.header('OSC 7777 Escape Carryover Fix — Verification')

  await testDetectFunction()
  await testSameChunkStillWorks()
  await testChunkSplitAtEscBracket()
  await testSingleByteEscSplit()
  await testSplitInsideCsiParams()
  await testAllColorTypes()
  await testIdleNoSideEffects()
  await testRealisticSession()
  await testBothPromptChars()

  summary()
}

main().catch(err => {
  console.error('FATAL: ' + err.message)
  console.error(err.stack)
  process.exit(1)
})
