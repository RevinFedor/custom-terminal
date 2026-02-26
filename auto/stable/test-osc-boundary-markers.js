/**
 * Test: OSC 7777 Prompt Boundary Markers — Standalone
 *
 * Tests the full pipeline WITHOUT Electron:
 * 1. State machine: IDLE→BUSY→IDLE detection of Claude prompts
 * 2. OSC 7777 injection into PTY data stream
 * 3. xterm.js parser fires registerOscHandler(7777)
 * 4. registerMarker(0) pins exact buffer position
 * 5. Markers track correct lines as buffer grows
 *
 * Uses node-pty + xterm.js headless (no DOM, no Electron).
 *
 * Run: node auto/sandbox/test-osc-boundary-markers.js
 */

const { Terminal } = require('@xterm/xterm')
const { stripVTControlCharacters } = require('node:util')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

// Replicate the state machine from main.js
function createMiddleware() {
  let state = 'idle'
  let seq = 0

  return {
    process(rawData) {
      let data = rawData
      const sc = stripVTControlCharacters(data)
      const hasPrompt = sc.includes('\u23F5') || sc.includes('\u276F')

      if (state === 'idle') {
        if (!hasPrompt && sc.replace(/\s/g, '').length > 5) {
          state = 'busy'
        }
      } else if (state === 'busy' && hasPrompt) {
        state = 'idle'
        data = '\x1b]7777;prompt:' + seq + '\x07' + data
        seq++
      }
      return data
    },
    getState() { return state },
    getSeq() { return seq }
  }
}

function writeAndWait(term, data) {
  return new Promise(resolve => term.write(data, resolve))
}

async function testBasicStateMachine() {
  console.log(`\n${c.bold}=== TEST 1: Basic state machine ===${c.reset}`)

  const mw = createMiddleware()

  // Initial prompt — should stay idle, no injection
  let out = mw.process('\u23F5 ')
  assert(mw.getState() === 'idle', 'Initial prompt: stays idle')
  assert(!out.includes('\x1b]7777'), 'Initial prompt: no OSC injected')

  // User sends message — idle→busy
  out = mw.process('User typed hello\r\n')
  assert(mw.getState() === 'busy', 'After user message: transitions to busy')

  // Claude streaming — stays busy
  out = mw.process('Claude is thinking...\r\n')
  assert(mw.getState() === 'busy', 'During streaming: stays busy')
  assert(!out.includes('\x1b]7777'), 'During streaming: no OSC injected')

  // Claude done, prompt returns — busy→idle, inject!
  out = mw.process('Response done\r\n\u23F5 ')
  assert(mw.getState() === 'idle', 'Prompt returned: back to idle')
  assert(out.includes('\x1b]7777;prompt:0\x07'), 'Prompt returned: OSC #0 injected')

  // Second message cycle
  mw.process('Another question\r\n')
  assert(mw.getState() === 'busy', 'Second question: busy')

  out = mw.process('Second response\r\n\u23F5 ')
  assert(mw.getState() === 'idle', 'Second response: idle')
  assert(out.includes('\x1b]7777;prompt:1\x07'), 'Second response: OSC #1 injected')
  assert(mw.getSeq() === 2, 'Sequence counter at 2')
}

async function testXtermMarkerCreation() {
  console.log(`\n${c.bold}=== TEST 2: xterm.js marker creation ===${c.reset}`)

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const markers = new Map()

  // Register OSC handler (same as Terminal.tsx)
  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      const seq = parseInt(data.slice(7), 10)
      const marker = term.registerMarker(0)
      if (marker) markers.set(seq, marker)
    }
    return true
  })

  const mw = createMiddleware()

  // Simulate 3-message session
  const chunks = [
    '\u23F5 ',                                    // Initial prompt
    'hello world\r\n',                            // User msg 1 (idle→busy)
    'Thinking about your question...\r\n',        // Streaming
    'Here is the answer.\r\n\u23F5 ',             // Done → marker #0
    'second question\r\n',                        // User msg 2 (idle→busy)
    'Processing second...\r\n',                   // Streaming
    'Second answer done.\r\n\u23F5 ',             // Done → marker #1
    'third question\r\n',                         // User msg 3 (idle→busy)
    'Computing third...\r\n',                     // Streaming
    'Third answer complete.\r\n\u23F5 ',          // Done → marker #2
  ]

  let fullData = ''
  for (const chunk of chunks) {
    fullData += mw.process(chunk)
  }

  await writeAndWait(term, fullData)

  assert(markers.size === 3, `3 markers created (got ${markers.size})`)

  // Verify marker positions
  const buf = term.buffer.active
  const lines = []
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)
    if (line) {
      const text = line.translateToString(true).trim()
      if (text) lines.push({ row: i, text })
    }
  }

  log.info('Buffer contents:')
  lines.forEach(l => log.info(`  [${l.row}] ${l.text}`))
  log.info('Marker positions:')
  markers.forEach((m, seq) => log.info(`  #${seq} → line ${m.line}`))

  // Each marker should be at or near the response line (before the prompt)
  for (const [seq, marker] of markers) {
    assert(!marker.isDisposed, `Marker #${seq} is not disposed`)
    assert(marker.line >= 0, `Marker #${seq} has valid line (${marker.line})`)
  }

  // Markers should be in ascending order
  const markerLines = [...markers.values()].map(m => m.line)
  const isAscending = markerLines.every((v, i) => i === 0 || v > markerLines[i - 1])
  assert(isAscending, `Markers in ascending order: [${markerLines.join(', ')}]`)

  term.dispose()
}

async function testMarkerSurvivesScrollback() {
  console.log(`\n${c.bold}=== TEST 3: Marker survives scrollback growth ===${c.reset}`)

  const term = new Terminal({ cols: 80, rows: 10, scrollback: 100, allowProposedApi: true })
  const markers = new Map()

  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      const seq = parseInt(data.slice(7), 10)
      const marker = term.registerMarker(0)
      if (marker) markers.set(seq, marker)
    }
    return true
  })

  // Write first marker
  await writeAndWait(term, '\x1b]7777;prompt:0\x07Line A\r\n')
  const lineBeforeGrowth = markers.get(0)?.line

  // Add 30 more lines to push content into scrollback
  let bulk = ''
  for (let i = 0; i < 30; i++) bulk += `Filler line ${i}\r\n`
  await writeAndWait(term, bulk)

  // Write second marker
  await writeAndWait(term, '\x1b]7777;prompt:1\x07Line B\r\n')

  const m0 = markers.get(0)
  const m1 = markers.get(1)

  assert(m0 && !m0.isDisposed, 'Marker #0 survived scrollback growth')
  // After 30 lines added, marker #0 is now in scrollback — its absolute line stays 0
  // but it's still valid and reachable
  assert(m0.line >= 0, `Marker #0 line valid after growth: ${m0.line}`)
  assert(m1 && !m1.isDisposed, 'Marker #1 created in scrollback')
  assert(m1.line > m0.line, `Marker #1 (${m1.line}) > Marker #0 (${m0.line})`)

  log.info(`Marker #0: ${m0.line}, Marker #1: ${m1.line}`)

  term.dispose()
}

async function testNoInjectionForShortData() {
  console.log(`\n${c.bold}=== TEST 4: No injection for trivial data ===${c.reset}`)

  const mw = createMiddleware()

  // Initial prompt
  mw.process('\u23F5 ')

  // Short/trivial data should NOT trigger busy (e.g. cursor moves, redraws)
  let out = mw.process('\x1b[H')  // Cursor home (2 chars after strip)
  assert(mw.getState() === 'idle', 'Cursor escape: stays idle')

  out = mw.process('   \r\n')  // Whitespace only
  assert(mw.getState() === 'idle', 'Whitespace: stays idle')

  out = mw.process('\x1b[2J')  // Clear screen
  assert(mw.getState() === 'idle', 'Clear screen: stays idle')

  // Substantial data should trigger busy
  out = mw.process('This is a real response from Claude\r\n')
  assert(mw.getState() === 'busy', 'Substantial text: transitions to busy')
}

async function testDoublePromptNoDuplicate() {
  console.log(`\n${c.bold}=== TEST 5: Double prompt doesn't create duplicate ===${c.reset}`)

  const mw = createMiddleware()

  mw.process('\u23F5 ')                    // Initial prompt
  mw.process('user message\r\n')           // idle→busy
  let out1 = mw.process('resp\r\n\u23F5 ')  // busy→idle, inject #0

  assert(out1.includes('prompt:0'), 'First prompt: injected #0')

  // Prompt appears again (redraw) while idle — no injection
  let out2 = mw.process('\u23F5 ')
  assert(!out2.includes('\x1b]7777'), 'Idle redraw: no duplicate injection')

  // Another prompt redraw
  let out3 = mw.process('x\u23F5 y')
  assert(!out3.includes('\x1b]7777'), 'Idle with prompt: no injection (has prompt in data, stays idle)')
}

async function testEntryToMarkerBinding() {
  console.log(`\n${c.bold}=== TEST 6: Entry-to-marker binding simulation ===${c.reset}`)

  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  const promptMarkers = new Map()  // seq → IMarker
  const entryMarkers = new Map()   // uuid → { marker, isReachable }

  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      const seq = parseInt(data.slice(7), 10)
      const marker = term.registerMarker(0)
      if (marker) promptMarkers.set(seq, marker)
    }
    return true
  })

  const mw = createMiddleware()

  // Simulate 3-message session — process through middleware then write to xterm
  // IMPORTANT: response and prompt must be separate chunks (like real PTY data)
  // because the state machine checks hasPrompt per-chunk
  const session = [
    '\u23F5 ',                    // Initial prompt
    'first question here\r\n',   // User msg 1 → idle→busy
    'first response text\r\n',   // Streaming
    '\u23F5 ',                    // Prompt returns → busy→idle, inject #0
    'second question here\r\n',  // User msg 2 → idle→busy
    'second response text\r\n',  // Streaming
    '\u23F5 ',                    // Prompt returns → busy→idle, inject #1
    'third question here\r\n',   // User msg 3 → idle→busy
    'third response text\r\n',   // Streaming
    '\u23F5 ',                    // Prompt returns → busy→idle, inject #2
  ]
  let fullData = ''
  for (const chunk of session) fullData += mw.process(chunk)
  await writeAndWait(term, fullData)

  assert(promptMarkers.size === 3, `3 prompt markers (got ${promptMarkers.size})`)

  // Simulate Timeline binding: entry N → prompt boundary N-1
  // (entry 0 has no marker — initial prompt not tracked)
  const entries = [
    { uuid: 'entry-0-aaa', content: 'msg1' },
    { uuid: 'entry-1-bbb', content: 'msg2' },
    { uuid: 'entry-2-ccc', content: 'msg3' },
  ]

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) {
      const marker = promptMarkers.get(i - 1)
      if (marker && !marker.isDisposed) {
        entryMarkers.set(entries[i].uuid, { marker, isReachable: true })
      }
    }
  }

  assert(!entryMarkers.has('entry-0-aaa'), 'Entry 0: no marker (initial prompt)')
  assert(entryMarkers.has('entry-1-bbb'), 'Entry 1: bound to marker #0')
  assert(entryMarkers.has('entry-2-ccc'), 'Entry 2: bound to marker #1')

  // Verify scrollToEntry works (only if markers were bound)
  if (entryMarkers.has('entry-1-bbb') && entryMarkers.has('entry-2-ccc')) {
    const e1 = entryMarkers.get('entry-1-bbb')
    const e2 = entryMarkers.get('entry-2-ccc')
    assert(e1.marker.line >= 0, `Entry 1 scrollable to line ${e1.marker.line}`)
    assert(e2.marker.line > e1.marker.line, `Entry 2 line (${e2.marker.line}) > Entry 1 line (${e1.marker.line})`)
    log.info(`Entry 1 → line ${e1.marker.line}, Entry 2 → line ${e2.marker.line}`)
  } else {
    log.warn('Skipping scroll verification — markers not bound')
  }

  term.dispose()
}

async function testWithRealAnsiSequences() {
  console.log(`\n${c.bold}=== TEST 7: Real ANSI sequences (Claude-like) ===${c.reset}`)

  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
  const markers = new Map()

  term.parser.registerOscHandler(7777, (data) => {
    if (data.startsWith('prompt:')) {
      const seq = parseInt(data.slice(7), 10)
      const marker = term.registerMarker(0)
      if (marker) markers.set(seq, marker)
    }
    return true
  })

  const mw = createMiddleware()

  // Simulate Claude-like output with ANSI codes
  const chunks = [
    // Initial prompt with colors
    '\x1b[38;2;55;55;55m\u23F5\x1b[0m ',
    // User message (triggers busy)
    'What is 2+2?\r\n',
    // Claude streaming with sync frames
    '\x1b[?2026h\x1b[38;2;200;200;200mThinking...\x1b[0m\x1b[?2026l\r\n',
    '\x1b[?2026h\x1b[1mThe answer is 4.\x1b[0m\x1b[?2026l\r\n',
    // Response done, prompt returns
    '\x1b[38;2;55;55;55m\u23F5\x1b[0m ',
    // Second message
    'What about 3+3?\r\n',
    // Streaming
    '\x1b[38;2;200;200;200mLet me calculate...\x1b[0m\r\n',
    '\x1b[1mThe answer is 6.\x1b[0m\r\n',
    // Done
    '\x1b[38;2;55;55;55m\u23F5\x1b[0m ',
  ]

  let data = ''
  for (const chunk of chunks) data += mw.process(chunk)
  await writeAndWait(term, data)

  assert(markers.size === 2, `2 markers from ANSI stream (got ${markers.size})`)
  assert(mw.getSeq() === 2, 'Sequence at 2')

  // Verify markers are at distinct positions
  const lines = [...markers.values()].map(m => m.line)
  assert(lines[0] < lines[1], `Marker lines ascending: ${lines[0]} < ${lines[1]}`)

  log.info(`Markers at lines: ${lines.join(', ')}`)
  term.dispose()
}

async function main() {
  console.log(`${c.bold}OSC 7777 Prompt Boundary Markers — Standalone Test${c.reset}\n`)

  await testBasicStateMachine()
  await testXtermMarkerCreation()
  await testMarkerSurvivesScrollback()
  await testNoInjectionForShortData()
  await testDoublePromptNoDuplicate()
  await testEntryToMarkerBinding()
  await testWithRealAnsiSequences()

  console.log(`\n${c.bold}=== RESULTS ===${c.reset}`)
  console.log(`${c.green}Passed: ${passed}${c.reset}`)
  if (failed > 0) console.log(`${c.red}Failed: ${failed}${c.reset}`)
  else console.log(`${c.green}All tests passed!${c.reset}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(c.red + 'FATAL: ' + err.message + c.reset)
  process.exit(1)
})
