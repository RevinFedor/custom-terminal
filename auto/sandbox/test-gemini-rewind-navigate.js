/**
 * Exploration v4: Gemini rewind — deep navigation analysis
 *
 * From v3 we know:
 * - /rewind\r opens the modal reliably
 * - ● starts at "Stay at current position" (bottom)
 * - UP moves ● to CHARLIE→BRAVO→ALPHA
 * - DOWN = 0B from initial position
 * - RGB(166,227,161) = green for selected
 *
 * This test:
 * 1. Sends 5 messages (ALPHA..ECHO)
 * 2. Opens /rewind
 * 3. Deep-analyzes raw PTY to find reliable parsing method
 * 4. Tests UP then DOWN (after UP)
 * 5. Tests exact text extraction from RGB-colored regions
 *
 * Run: node auto/sandbox/test-gemini-rewind-navigate.js
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

// Extract text colored with RGB(166,227,161) — the green selection color
function extractGreenText(raw) {
  const GREEN_START = '\x1b[38;2;166;227;161m'
  const results = []
  let searchFrom = 0

  while (true) {
    const startIdx = raw.indexOf(GREEN_START, searchFrom)
    if (startIdx === -1) break

    // Find end of this green region: look for color reset or new color
    let endIdx = startIdx + GREEN_START.length
    let text = ''
    while (endIdx < raw.length) {
      // Check for color change or reset
      if (raw[endIdx] === '\x1b') {
        // Could be new color, reset, or cursor movement
        const remaining = raw.substring(endIdx)
        if (remaining.startsWith('\x1b[39m') || remaining.startsWith('\x1b[38;2;') || remaining.startsWith('\x1b[0m')) {
          break
        }
        // Skip other escape sequences
        const escEnd = remaining.indexOf('m')
        if (escEnd !== -1 && escEnd < 30) {
          endIdx += escEnd + 1
          continue
        }
      }
      text += raw[endIdx]
      endIdx++
    }

    const cleaned = stripVTControlCharacters(text).trim()
    if (cleaned.length > 0) {
      results.push(cleaned)
    }
    searchFrom = endIdx
  }

  return results
}

// Parse ● marker from cleaned text — find the line with ●
function findSelectedEntry(clean) {
  const lines = clean.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('●')) {
      return trimmed.replace(/^●\s*/, '').trim()
    }
  }
  return null
}

// Parse all menu entries from cleaned text
function parseRewindMenu(clean) {
  const lines = clean.split('\n').map(l => l.trim()).filter(Boolean)
  const entries = []
  let inBox = false
  let currentEntry = null

  for (const line of lines) {
    // Box start
    if (line.startsWith('╭')) { inBox = true; continue }
    if (line.startsWith('╰')) { inBox = false; continue }
    if (!inBox) continue

    // Strip leading/trailing │
    const content = line.replace(/^│\s*/, '').replace(/\s*│$/, '').trim()
    if (!content) continue

    // Title
    if (content === '> Rewind') continue
    // Instructions
    if (content.startsWith('(Use Enter')) continue

    // Selected entry
    if (content.startsWith('●')) {
      if (currentEntry) entries.push(currentEntry)
      currentEntry = {
        text: content.replace(/^●\s*/, ''),
        selected: true,
        subtitle: null
      }
      continue
    }

    // Subtitle patterns
    if (content === 'No files have been changed' || content === 'Cancel rewind and stay here') {
      if (currentEntry) currentEntry.subtitle = content
      continue
    }

    // File change patterns (could have different subtitles)
    if (content.match(/^\d+ files? (changed|modified|created|deleted)/i)) {
      if (currentEntry) currentEntry.subtitle = content
      continue
    }

    // Regular entry (user message)
    if (currentEntry) entries.push(currentEntry)
    currentEntry = {
      text: content,
      selected: false,
      subtitle: null
    }
  }
  if (currentEntry) entries.push(currentEntry)

  return entries
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

    // Send 5 messages
    const messages = [
      'ALPHA: What is 2+2?',
      'BRAVO: capital of France?',
      'CHARLIE: color of sky?',
      'DELTA: what day is today?',
      'ECHO: what is pi?',
    ]

    for (let i = 0; i < messages.length; i++) {
      log.step(`MSG ${i + 1}: "${messages[i]}"`)
      term.write('\x01\x0b')
      await sleep(100)
      term.write('\x1b[200~' + messages[i] + '\x1b[201~')
      await sleep(300)
      const cap = captureFor(term, 20000)
      term.write('\r')
      await cap
      await drainData(term, 2000)
      log.pass(`Message ${i + 1} done`)
    }

    // ═══════════════════════════════════════════════════════════
    // Open /rewind
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ Opening /rewind ═══${c.reset}`)

    term.write('\x01\x0b')
    await sleep(100)
    for (const ch of '/rewind') { term.write(ch); await sleep(30) }
    await sleep(200)

    const menuCapture = captureFor(term, 8000)
    term.write('\r')
    const menuRaw = await menuCapture

    const menuClean = smartClean(menuRaw)
    const menuEntries = parseRewindMenu(menuClean)
    const greenTexts = extractGreenText(menuRaw)
    const selected = findSelectedEntry(menuClean)

    console.log(`\n${c.bold}INITIAL MENU STATE:${c.reset}`)
    console.log(`  Entries: ${menuEntries.length}`)
    menuEntries.forEach((e, i) => {
      console.log(`  ${e.selected ? '●' : ' '} [${i}] ${e.text}${e.subtitle ? ` — ${e.subtitle}` : ''}`)
    })
    console.log(`  Green texts: [${greenTexts.join(', ')}]`)
    console.log(`  Selected (●): ${selected}`)

    // ═══════════════════════════════════════════════════════════
    // Navigation UP — go through all entries
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ UP Navigation (all entries) ═══${c.reset}`)

    const navResults = []

    for (let i = 0; i < 8; i++) {
      const navCap = captureFor(term, 2000)
      term.write('\x1b[A') // UP
      const navRaw = await navCap

      if (navRaw.length === 0) {
        log.warn(`UP #${i + 1}: 0B (hit boundary)`)
        navResults.push({ step: i + 1, dir: 'UP', bytes: 0, selected: null, green: [] })
        break
      }

      const navClean = smartClean(navRaw)
      const navSelected = findSelectedEntry(navClean)
      const navGreen = extractGreenText(navRaw)
      const navEntries = parseRewindMenu(navClean)

      log.info(`UP #${i + 1}: ${navRaw.length}B, ● = "${navSelected}", green = [${navGreen.join(', ')}]`)

      // Show parsed entries
      if (navEntries.length > 0) {
        navEntries.forEach((e) => {
          if (e.selected) log.pass(`  ● ${e.text}`)
        })
      }

      navResults.push({
        step: i + 1, dir: 'UP', bytes: navRaw.length,
        selected: navSelected, green: navGreen,
        entries: navEntries
      })
    }

    // ═══════════════════════════════════════════════════════════
    // Navigation DOWN — go back
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ DOWN Navigation (back) ═══${c.reset}`)

    for (let i = 0; i < 8; i++) {
      const navCap = captureFor(term, 2000)
      term.write('\x1b[B') // DOWN
      const navRaw = await navCap

      if (navRaw.length === 0) {
        log.warn(`DOWN #${i + 1}: 0B (hit boundary)`)
        break
      }

      const navClean = smartClean(navRaw)
      const navSelected = findSelectedEntry(navClean)
      const navGreen = extractGreenText(navRaw)

      log.info(`DOWN #${i + 1}: ${navRaw.length}B, ● = "${navSelected}", green = [${navGreen.join(', ')}]`)
    }

    // ═══════════════════════════════════════════════════════════
    // Close with Escape, verify prompt restored
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ Close with Escape ═══${c.reset}`)
    const closeCap = captureFor(term, 3000)
    term.write('\x1b')
    const closeRaw = await closeCap
    const closeClean = smartClean(closeRaw)
    const hasPrompt = closeClean.includes('>') && closeClean.includes('Type your message')
    log.info(`Close: ${closeRaw.length}B, prompt restored: ${hasPrompt}`)

    // ═══════════════════════════════════════════════════════════
    // Now test ENTER selection: re-open, navigate to BRAVO, confirm
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══ Selection Test: Rewind to BRAVO ═══${c.reset}`)

    // Re-open
    await drainData(term, 1000)
    term.write('\x01\x0b')
    await sleep(100)
    for (const ch of '/rewind') { term.write(ch); await sleep(30) }
    await sleep(200)
    const menu2Cap = captureFor(term, 8000)
    term.write('\r')
    const menu2Raw = await menu2Cap

    // Navigate UP to find BRAVO (should be 4th UP: Stay→ECHO→DELTA→CHARLIE→BRAVO)
    log.step('Navigating UP to BRAVO (expecting 4 UPs)...')
    let foundBravo = false
    for (let i = 0; i < 7; i++) {
      const navCap = captureFor(term, 2000)
      term.write('\x1b[A')
      const navRaw = await navCap
      if (navRaw.length === 0) { log.warn('Hit boundary'); break }

      const navClean = smartClean(navRaw)
      const navSelected = findSelectedEntry(navClean)
      const navGreen = extractGreenText(navRaw)
      log.info(`UP #${i + 1}: ● = "${navSelected}", green = [${navGreen.join(', ')}]`)

      // Check both ● marker and green text for BRAVO
      const isBravo = (navSelected && navSelected.includes('BRAVO')) ||
                       navGreen.some(t => t.includes('BRAVO'))
      if (isBravo) {
        log.pass(`Found BRAVO at UP #${i + 1}!`)
        foundBravo = true
        break
      }
    }

    if (foundBravo) {
      log.step('Pressing Enter to confirm rewind to BRAVO...')
      const confirmCap = captureFor(term, 10000)
      term.write('\r')
      const confirmRaw = await confirmCap
      const confirmClean = smartClean(confirmRaw)

      // Check if rewind happened
      if (confirmClean.includes('Rewound') || confirmClean.includes('rewind') ||
          confirmClean.includes('>') && confirmClean.includes('Type your message')) {
        log.pass('Rewind confirmed! Prompt restored.')
      } else {
        log.warn('Rewind result unclear')
        console.log(confirmClean.slice(-500))
      }

      // Extra drain
      await drainData(term, 3000)
    } else {
      log.fail('Could not find BRAVO in rewind menu')
      // Close menu
      term.write('\x1b')
      await sleep(2000)
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log(`\n${c.bold}═══════════════════════════════════════════════${c.reset}`)
    console.log(`${c.bold}  NAVIGATION SUMMARY${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════════════${c.reset}`)
    navResults.forEach(r => {
      console.log(`  ${r.dir} #${r.step}: ${r.bytes}B, ● = "${r.selected}", green = [${r.green.join(', ')}]`)
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
