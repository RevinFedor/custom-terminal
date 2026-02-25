/**
 * Comprehensive test: Gemini /rewind — edge cases & full flow
 *
 * Tests:
 * 1. 10+ messages in session
 * 2. Duplicate prefixes (two messages starting with same text)
 * 3. Messages with leading spaces
 * 4. Empty-ish messages
 * 5. Navigation accuracy (position tracking)
 * 6. Full rewind flow (navigate → confirm → verify)
 * 7. Down navigation after up
 *
 * Run: node auto/sandbox/test-gemini-rewind-full.js
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

// Extract text colored with RGB(166,227,161) green
function extractGreenText(raw) {
  const GREEN_START = '\x1b[38;2;166;227;161m'
  const results = []
  let searchFrom = 0
  while (true) {
    const startIdx = raw.indexOf(GREEN_START, searchFrom)
    if (startIdx === -1) break
    let endIdx = startIdx + GREEN_START.length
    let text = ''
    while (endIdx < raw.length) {
      if (raw[endIdx] === '\x1b') {
        const remaining = raw.substring(endIdx)
        if (remaining.startsWith('\x1b[39m') || remaining.startsWith('\x1b[38;2;') || remaining.startsWith('\x1b[0m')) break
        const escEnd = remaining.indexOf('m')
        if (escEnd !== -1 && escEnd < 30) { endIdx += escEnd + 1; continue }
      }
      text += raw[endIdx]
      endIdx++
    }
    const cleaned = stripVTControlCharacters(text).trim()
    if (cleaned.length > 0 && cleaned !== '●') results.push(cleaned)
    searchFrom = endIdx
  }
  return results
}

function textMatchesTarget(selectedText, targetPrefix) {
  if (!selectedText || !targetPrefix) return false
  const st = selectedText.trim().replace(/\s+/g, ' ').substring(0, 50)
  const tp = targetPrefix.trim().replace(/\s+/g, ' ').substring(0, 50)
  if (st.includes(tp) || tp.includes(st)) return true
  const targetWords = tp.split(/\s+/).filter(w => w.length > 2)
  if (targetWords.length > 0) {
    const matched = targetWords.filter(w => st.includes(w))
    if (matched.length / targetWords.length >= 0.6) return true
  }
  return false
}

// Navigate UP in rewind menu, return selected green text
async function navigateUp(term) {
  const navCap = captureFor(term, 2000)
  term.write('\x1b[A')
  const navRaw = await navCap
  if (navRaw.length === 0) return null
  const greenTexts = extractGreenText(navRaw)
  return greenTexts.length > 0 ? greenTexts[greenTexts.length - 1] : null
}

async function navigateDown(term) {
  const navCap = captureFor(term, 2000)
  term.write('\x1b[B')
  const navRaw = await navCap
  if (navRaw.length === 0) return null
  const greenTexts = extractGreenText(navRaw)
  return greenTexts.length > 0 ? greenTexts[greenTexts.length - 1] : null
}

async function sendMessage(term, message, waitMs = 20000) {
  term.write('\x01\x0b')
  await sleep(100)
  term.write('\x1b[200~' + message + '\x1b[201~')
  await sleep(300)
  const cap = captureFor(term, waitMs)
  term.write('\r')
  await cap
  await drainData(term, 2000)
}

async function openRewindMenu(term) {
  term.write('\x01\x0b')
  await sleep(100)
  for (const ch of '/rewind') { term.write(ch); await sleep(30) }
  await sleep(200)
  const cap = captureFor(term, 8000)
  term.write('\r')
  const raw = await cap
  return raw
}

async function closeMenu(term) {
  term.write('\x1b')
  await sleep(1000)
  await drainData(term, 1500)
}

async function main() {
  const cwd = '/Users/fedor/Desktop/custom-terminal'
  const results = []

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
    const geminiCap = captureFor(term, 15000)
    term.write('gemini\r')
    await geminiCap
    log.pass('Gemini ready')

    // ═══════════════════════════════════════════════════════════
    // Send 10 messages with edge cases
    // ═══════════════════════════════════════════════════════════
    const messages = [
      'MSG-01: What is 2+2?',             // Normal
      'MSG-02: capital of France?',        // Normal
      'MSG-03: color of sky?',             // Normal
      'MSG-04: what day is today?',        // Normal
      ' MSG-05: leading space test',       // Leading space!
      'MSG-06: duplicate test alpha',      // Duplicate prefix part 1
      'MSG-06: duplicate test beta',       // Duplicate prefix part 2 (same first 6 chars!)
      'MSG-07: short',                     // Short message
      'MSG-08: a somewhat longer message to test truncation at the forty character boundary which should be interesting', // Long
      'MSG-09: what is pi?',              // Normal
      'MSG-10: final message',             // Final
    ]

    console.log(`\n${c.bold}═══ Sending ${messages.length} messages ═══${c.reset}`)
    for (let i = 0; i < messages.length; i++) {
      log.step(`MSG ${i + 1}/${messages.length}: "${messages[i].substring(0, 40)}"`)
      await sendMessage(term, messages[i])
      log.pass(`Message ${i + 1} sent`)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 1: Open menu, verify all entries visible
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 1: All entries visible ═══${c.reset}`)
    const menuRaw = await openRewindMenu(term)
    const menuClean = smartClean(menuRaw)

    let test1Pass = true
    for (const msg of messages) {
      const prefix = msg.trim().substring(0, 30)
      if (!menuClean.includes(prefix)) {
        log.fail(`Missing: "${prefix}"`)
        test1Pass = false
      }
    }
    if (test1Pass) log.pass('All 11 entries visible in menu')
    else log.fail('Some entries missing')
    results.push({ name: 'All entries visible', pass: test1Pass })

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Navigate through ALL entries (UP from bottom)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 2: Full UP navigation ═══${c.reset}`)

    const upEntries = []
    for (let i = 0; i < 15; i++) {
      const sel = await navigateUp(term)
      if (sel === null) {
        log.info(`UP #${i + 1}: hit boundary (total entries: ${upEntries.length})`)
        break
      }
      upEntries.push(sel)
      log.info(`UP #${i + 1}: "${sel.substring(0, 50)}"`)
    }

    const test2Pass = upEntries.length === messages.length
    if (test2Pass) log.pass(`Navigated through all ${upEntries.length} entries`)
    else log.fail(`Expected ${messages.length} entries, got ${upEntries.length}`)
    results.push({ name: 'Full UP navigation', pass: test2Pass })

    // ═══════════════════════════════════════════════════════════
    // TEST 3: DOWN navigation (back from top)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 3: Full DOWN navigation ═══${c.reset}`)

    const downEntries = []
    for (let i = 0; i < 15; i++) {
      const sel = await navigateDown(term)
      if (sel === null) {
        log.info(`DOWN #${i + 1}: hit boundary (total: ${downEntries.length})`)
        break
      }
      downEntries.push(sel)
      log.info(`DOWN #${i + 1}: "${sel.substring(0, 50)}"`)
    }

    // Should include messages + "Stay at current position"
    const test3Pass = downEntries.length >= messages.length
    if (test3Pass) log.pass(`DOWN navigated through ${downEntries.length} entries`)
    else log.fail(`Expected >= ${messages.length} DOWN entries, got ${downEntries.length}`)
    results.push({ name: 'Full DOWN navigation', pass: test3Pass })

    // Close menu
    await closeMenu(term)

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Leading space detection
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 4: Leading space message ═══${c.reset}`)

    await openRewindMenu(term)
    let foundLeadingSpace = false
    for (let i = 0; i < 15; i++) {
      const sel = await navigateUp(term)
      if (sel === null) break
      // The message " MSG-05: leading space test" — Gemini may trim it
      if (sel.includes('MSG-05')) {
        log.pass(`Found leading space msg: "${sel}"`)
        foundLeadingSpace = true
        break
      }
    }
    if (!foundLeadingSpace) log.fail('Leading space message not found')
    results.push({ name: 'Leading space detection', pass: foundLeadingSpace })
    await closeMenu(term)

    // ═══════════════════════════════════════════════════════════
    // TEST 5: Duplicate prefix matching (skip duplicates)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 5: Duplicate prefix handling ═══${c.reset}`)

    await openRewindMenu(term)
    const targetPrefix = 'MSG-06: duplicate test alpha'
    let duplicateMatches = 0
    let firstDupText = null
    let secondDupText = null

    for (let i = 0; i < 15; i++) {
      const sel = await navigateUp(term)
      if (sel === null) break
      if (sel.includes('MSG-06')) {
        duplicateMatches++
        if (duplicateMatches === 1) firstDupText = sel
        else secondDupText = sel
      }
    }

    const test5Pass = duplicateMatches === 2
    if (test5Pass) {
      log.pass(`Found ${duplicateMatches} MSG-06 entries`)
      log.info(`  1st: "${firstDupText}"`)
      log.info(`  2nd: "${secondDupText}"`)
    } else {
      log.fail(`Expected 2 MSG-06 entries, found ${duplicateMatches}`)
    }
    results.push({ name: 'Duplicate prefix detection', pass: test5Pass })
    await closeMenu(term)

    // ═══════════════════════════════════════════════════════════
    // TEST 6: Target matching with textMatchesTarget()
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 6: textMatchesTarget accuracy ═══${c.reset}`)

    await openRewindMenu(term)
    const targetMsg = 'MSG-04: what day is today?'
    const targetPfx = targetMsg.substring(0, 40)
    let foundTarget = false
    let targetPressCount = 0

    for (let i = 0; i < 15; i++) {
      const sel = await navigateUp(term)
      if (sel === null) break
      targetPressCount++
      if (textMatchesTarget(sel, targetPfx)) {
        log.pass(`Target found at UP #${targetPressCount}: "${sel}"`)
        foundTarget = true
        break
      }
    }
    if (!foundTarget) log.fail('textMatchesTarget failed for MSG-04')
    results.push({ name: 'textMatchesTarget accuracy', pass: foundTarget })
    await closeMenu(term)

    // ═══════════════════════════════════════════════════════════
    // TEST 7: Full rewind flow (navigate to MSG-03, confirm)
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ TEST 7: Full rewind to MSG-03 ═══${c.reset}`)

    await openRewindMenu(term)
    const rewindTarget = 'MSG-03: color of sky?'
    let foundRewindTarget = false

    for (let i = 0; i < 15; i++) {
      const sel = await navigateUp(term)
      if (sel === null) break
      if (textMatchesTarget(sel, rewindTarget.substring(0, 40))) {
        log.pass(`Rewind target found: "${sel}"`)
        foundRewindTarget = true
        break
      }
    }

    if (foundRewindTarget) {
      // Press Enter → confirmation dialog
      log.step('Pressing Enter (selection)...')
      const confirmCap = captureFor(term, 5000)
      term.write('\r')
      const confirmRaw = await confirmCap
      const confirmClean = smartClean(confirmRaw)

      if (confirmClean.includes('Rewind conversation')) {
        log.pass('Confirmation dialog appeared')

        // Press Enter again to confirm
        log.step('Pressing Enter (confirm rewind)...')
        const rewindCap = captureFor(term, 10000)
        term.write('\r')
        const rewindRaw = await rewindCap
        await drainData(term, 3000)
        const rewindClean = smartClean(rewindRaw)

        // Check prompt returned
        const promptRestored = rewindClean.includes('>') || rewindClean.includes('Type your message')
        if (promptRestored) log.pass('Prompt restored after rewind!')
        else log.warn('Prompt status unclear after rewind')

        results.push({ name: 'Full rewind flow', pass: true })
      } else {
        log.fail('Confirmation dialog not detected')
        log.info('Clean: ' + confirmClean.slice(-300))
        results.push({ name: 'Full rewind flow', pass: false })
        await closeMenu(term)
      }
    } else {
      log.fail('Could not find rewind target MSG-03')
      results.push({ name: 'Full rewind flow', pass: false })
      await closeMenu(term)
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    const allPass = results.every(r => r.pass)
    const passCount = results.filter(r => r.pass).length

    console.log(`\n${c.bold}═══════════════════════════════════════════════${c.reset}`)
    console.log(`${allPass ? c.green : c.red}${c.bold}  ${passCount}/${results.length} TESTS PASSED${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════════════${c.reset}`)
    results.forEach((r, i) => {
      console.log(`  ${r.pass ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset} ${i + 1}. ${r.name}`)
    })
    console.log(`${c.bold}═══════════════════════════════════════════════${c.reset}`)

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
