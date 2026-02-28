/**
 * Headless test helpers — shared utilities for tests that run
 * without Electron, using only Node.js + @xterm/xterm.
 *
 * Usage:
 *   const { assert, log, summary, writeAndWait, createMiddleware } = require('../core/headless')
 */

const { stripVTControlCharacters } = require('node:util')

// ── Console colors ──

const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
}

// ── Logging ──

const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  header: (m) => console.log(`\n${c.bold}${c.cyan}${'='.repeat(60)}${c.reset}\n${c.bold}  ${m}${c.reset}\n${c.bold}${c.cyan}${'='.repeat(60)}${c.reset}`)
}

// ── Assertions ──

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

/** Print summary and exit with correct code */
function summary() {
  console.log('\n' + '='.repeat(50))
  if (failed > 0) {
    console.log(`${c.red}Results: ${passed} passed, ${failed} failed${c.reset}`)
    console.log(`${c.red}[FAIL] ${failed} test(s) failed${c.reset}`)
  } else {
    console.log(`${c.green}Results: ${passed} passed, 0 failed${c.reset}`)
    console.log(`${c.green}[PASS] ALL TESTS PASSED${c.reset}`)
  }
  console.log('='.repeat(50))
  process.exit(failed > 0 ? 1 : 0)
}

/** Get current counts (for custom summaries) */
function getCounts() {
  return { passed, failed }
}

// ── xterm.js helpers ──

/**
 * Write data to xterm.js terminal and wait for parsing to complete.
 * OSC handlers fire during write() — the callback fires AFTER parsing.
 *
 *   const markers = new Map()
 *   term.parser.registerOscHandler(7777, (data) => { ... })
 *   await writeAndWait(term, processedData)
 *   // markers are now populated
 */
function writeAndWait(term, data) {
  return new Promise(resolve => term.write(data, resolve))
}

// ── OSC 7777 State Machine ──

/**
 * Detect incomplete escape sequence at end of data chunk.
 * Returns number of bytes to buffer (0 if all complete).
 */
function detectIncompleteEscapeTail(data) {
  for (let i = data.length - 1; i >= Math.max(0, data.length - 128); i--) {
    if (data.charCodeAt(i) === 0x1b) {
      const tail = data.slice(i)
      if (tail.length === 1) return tail.length
      const second = tail.charCodeAt(1)
      if (second === 0x5b) { // CSI: ESC [
        for (let j = 2; j < tail.length; j++) {
          if (tail.charCodeAt(j) >= 0x40 && tail.charCodeAt(j) <= 0x7e) return 0
        }
        return tail.length
      }
      if (second === 0x5d) { // OSC: ESC ]
        if (tail.includes('\x07') || tail.includes('\x1b\\')) return 0
        return tail.length
      }
      if (second === 0x50) { // DCS: ESC P
        if (tail.includes('\x1b\\')) return 0
        return tail.length
      }
      if (second >= 0x40 && second <= 0x7e) return 0
      return tail.length
    }
  }
  return 0
}

/**
 * Replicates the prompt boundary state machine from main.js.
 *
 * Detects Claude prompt transitions (⏵/❯) and injects OSC 7777
 * escape sequences into the data stream.
 *
 * Includes escape carryover: buffers incomplete escape tails from one chunk
 * and reassembles them into the next chunk before injection, preventing
 * OSC 7777 from splitting multi-chunk escape sequences.
 *
 *   const mw = createMiddleware()
 *   const processed = mw.process(rawPtyChunk)
 *   // processed may contain \x1b]7777;prompt:N\x07 prefix
 */
function createMiddleware() {
  let state = 'idle'
  let seq = 0
  let carryover = ''

  return {
    process(rawData) {
      let data = rawData

      // Reassemble carryover from previous chunk
      if (carryover) {
        data = carryover + data
        carryover = ''
      }

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

      // While busy, buffer trailing incomplete escapes
      if (state === 'busy') {
        const tail = detectIncompleteEscapeTail(data)
        if (tail > 0) {
          carryover = data.slice(data.length - tail)
          data = data.slice(0, data.length - tail)
        }
      }

      return data
    },
    getState() { return state },
    getSeq() { return seq }
  }
}

module.exports = {
  c,
  log,
  assert,
  summary,
  getCounts,
  writeAndWait,
  createMiddleware,
  detectIncompleteEscapeTail
}
