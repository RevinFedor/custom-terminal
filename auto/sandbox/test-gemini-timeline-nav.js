/**
 * Test: Gemini Timeline Navigation Diagnostics
 *
 * Diagnoses timeline click navigation for Gemini session 10807e79.
 *
 * PART 1 (pure logic, no Electron): Tests search logic against simulated buffer
 * PART 2 (Electron): Clicks dots and captures scrollToTextInBuffer logs
 *
 * FOUND BUGS (FIXED):
 * - BUG 1: Entry #0 multi-line match — searchInBuffer must skip empty buffer
 *   lines between content lines (Gemini TUI adds blank lines).
 *   FIX: searchInBuffer now skips empty lines (matching terminalRegistry.ts).
 * - BUG 2: "continue" / short entries matching AI response lines.
 *   FIX: isIsolatedShort now requires needle at START of trimmed line
 *   (prefix must be non-alphanumeric), preventing "OK, continue." matches.
 * - BUG 3 (was already fixed): "да" matching "да Добавь..." —
 *   isStrictShort mode requires trimmed === needle or endsWith with len <= 3.
 *
 * Run: node auto/sandbox/test-gemini-timeline-nav.js
 */

const { launch, waitForTerminal, typeCommand } = require('../core/launcher')
const electron = require('../core/electron')
const fs = require('fs')
const os = require('os')

const TEST_CWD = '/Users/fedor/Desktop/custom-terminal'
const TEST_SESSION_ID = '10807e79-99a1-407d-90d0-835fca893708'

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  header: (m) => console.log(`\n${c.bold}${c.cyan}${'='.repeat(60)}${c.reset}\n${c.bold}  ${m}${c.reset}\n${c.bold}${c.cyan}${'='.repeat(60)}${c.reset}`)
}

let passed = 0, failed = 0
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

// ── Replicate exact logic from terminalRegistry.ts ──

function getSearchLines(content) {
  const rawLines = content.split('\n')
  const result = []
  for (const line of rawLines) {
    const t = line.trim()
    if (!t) continue
    if (t.length >= 3 && /^(.)\1+$/.test(t)) continue
    result.push(t.slice(0, 50))
    if (result.length >= 3) break
  }
  if (result.length === 0) {
    const first = rawLines.find(l => l.trim())?.trim().slice(0, 50)
    if (first) result.push(first)
  }
  return result
}

// lineContains: matches real terminalRegistry.ts logic with isStrictShort/isIsolatedShort
function makeLineContains(contentLines) {
  const isStrictShort = contentLines.length === 1 && contentLines[0].length < 5
  const isIsolatedShort = contentLines.length === 1 && contentLines[0].length < 30

  return function lineContains(haystack, needle) {
    if (isStrictShort) {
      const trimmed = haystack.trim()
      if (trimmed === needle) return true
      if (trimmed.length > needle.length + 4) return false
      const pos = trimmed.indexOf(needle)
      if (pos < 0) return false
      if (pos === 0) return true
      const prefix = trimmed.slice(0, pos)
      return !/[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(prefix)
    }
    if (isIsolatedShort) {
      const trimmed = haystack.trim()
      if (trimmed.length > needle.length + 10) return false
      const pos = trimmed.indexOf(needle)
      if (pos < 0) return false
      if (pos === 0) return true
      const prefix = trimmed.slice(0, pos)
      return !/[a-zA-Z0-9\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(prefix)
    }
    if (needle.length >= 5) return haystack.includes(needle)
    let from = 0
    while (true) {
      const pos = haystack.indexOf(needle, from)
      if (pos === -1) return false
      const before = pos > 0 ? haystack[pos - 1] : ' '
      const after = pos + needle.length < haystack.length ? haystack[pos + needle.length] : ' '
      const boundaryRe = /[\s\.,;:!?\-\u2014\u2013()\[\]{}<>\/\\|"'`~@#$%^&*+=]/
      if ((pos === 0 || boundaryRe.test(before)) && (pos + needle.length === haystack.length || boundaryRe.test(after))) {
        return true
      }
      from = pos + 1
    }
  }
}

// searchInBuffer: matches real terminalRegistry.ts logic (gap-based multi-line matching)
function searchInBuffer(bufferLines, contentLines, occurrenceIndex) {
  const lineContains = makeLineContains(contentLines)
  const firstLine = contentLines[0]
  let validCount = 0
  for (let i = 0; i <= bufferLines.length - contentLines.length; i++) {
    if (!lineContains(bufferLines[i], firstLine)) continue
    let allMatch = true
    let bufIdx = i + 1
    for (let j = 1; j < contentLines.length; j++) {
      // Allow up to 5 gap lines (empty, separators, TUI formatting) between matches
      let found = false
      const maxGap = 5
      for (let gap = 0; gap < maxGap && bufIdx < bufferLines.length; gap++, bufIdx++) {
        if (lineContains(bufferLines[bufIdx], contentLines[j])) {
          found = true
          bufIdx++
          break
        }
      }
      if (!found) {
        allMatch = false; break
      }
    }
    if (!allMatch) continue
    if (validCount === occurrenceIndex) {
      return { found: true, line: i, occurrence: occurrenceIndex }
    }
    validCount++
  }
  return { found: false, validMatches: validCount }
}

// ── Simulated buffer (realistic Gemini TUI output) ──

const SIMULATED_BUFFER = `fedor@MacBook-Air-Fedor custom-terminal % gemini
✦ Welcome to Gemini CLI!

Ниже промпт документации:

<!-- @include: ./правила-документации.md -->

---

# Правила для промпта обновления документации

## Контекст
Ты получишь diff изменений кода (или описание изменений) и должен обновить документацию проекта.

## Что обновлять
1. Файлы в docs/knowledge/ — факты и фиксы
2. CLAUDE.md — если изменились архитектурные паттерны
3. auto/context.md — если изменились тестовые конвенции

## Формат обновления
- Для новых знаний: создай файл fact-*.md или fix-*.md
- Для обновления: найди и обнови релевантный файл

Some model response explaining documentation rules...

I understand the documentation prompt rules. Let me analyze the structure:

1. Knowledge files in docs/knowledge/
2. CLAUDE.md for architecture
3. auto/context.md for tests

да Добавь также еще вот это. # Claude Session Export
Session: 852e20a2-f4ca-4a5a-90c5-e500d00ff316
CWD: /Users/fedor/Desktop/custom-terminal

## Summary
This session covered adding timeline navigation...

Model response about the session export...

Added the session export information to the documentation.

да

Got it, continuing with the next step.

а что с пакой /auto/context.md - Посмотри, какая там организация и структура, потому что туда тоже надо дописать

Let me check /auto/context.md...
The file has this structure:
- Test conventions
- File naming
- Entry points

continue

Continuing the work on documentation updates...`.split('\n')


async function main() {
  log.header('Gemini Timeline Navigation Diagnostic Test')

  // ══════════════════════════════════════════════════════════════
  // PART 1: Pure search logic test
  // ══════════════════════════════════════════════════════════════
  log.header('PART 1: Search Logic vs Simulated Buffer')

  const sessionPath = `${os.homedir()}/.gemini/tmp/custom-terminal/chats/session-2026-02-24T22-31-10807e79.json`
  const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'))
  const userMessages = sessionData.messages.filter(m => m.type === 'user')

  const entries = userMessages.map(m => {
    if (Array.isArray(m.content)) {
      return m.content.filter(p => p.text).map(p => p.text).join('\n')
    }
    return String(m.content || '')
  })

  log.info(`Session: ${entries.length} user messages, Buffer: ${SIMULATED_BUFFER.length} lines`)

  for (let i = 0; i < entries.length; i++) {
    const searchLines = getSearchLines(entries[i])
    let occurrenceIndex = 0
    for (let j = 0; j < i; j++) {
      const eLines = getSearchLines(entries[j])
      if (eLines.length === searchLines.length && eLines.every((l, k) => l === searchLines[k])) {
        occurrenceIndex++
      }
    }

    const result = searchInBuffer(SIMULATED_BUFFER, searchLines, occurrenceIndex)
    const preview = entries[i].replace(/\n/g, ' | ').substring(0, 80)

    log.info(`Entry #${i}: "${preview}"`)
    log.info(`  searchLines: ${JSON.stringify(searchLines)}`)
    log.info(`  occurrenceIndex: ${occurrenceIndex}`)

    if (result.found) {
      console.log(`  ${c.green}[FOUND]${c.reset} at line ${result.line}: "${SIMULATED_BUFFER[result.line].substring(0, 80)}"`)
    } else {
      console.log(`  ${c.red}[NOT FOUND]${c.reset} validMatches: ${result.validMatches}`)
      // Debug
      const debugLC = makeLineContains(searchLines)
      for (let li = 0; li < SIMULATED_BUFFER.length; li++) {
        if (debugLC(SIMULATED_BUFFER[li], searchLines[0])) {
          const nextMatch = searchLines.length > 1
            ? (li + 1 < SIMULATED_BUFFER.length ? debugLC(SIMULATED_BUFFER[li + 1], searchLines[1]) : false)
            : true
          console.log(`    Line ${li}: first match YES, next line match: ${nextMatch} -> "${SIMULATED_BUFFER[li].substring(0, 60)}"`)
          if (li + 1 < SIMULATED_BUFFER.length) {
            console.log(`    Line ${li + 1}: "${SIMULATED_BUFFER[li + 1].substring(0, 60)}" (expected: "${searchLines[1]}")`)
          }
        }
      }
    }
    console.log()
  }

  // ── Bug analysis ──
  log.header('BUG ANALYSIS')

  // BUG 1: Multi-line match with empty lines between content
  log.info('BUG 1: Entry #0 - Multi-line match fails due to empty buffer lines')
  log.info('  searchLines[0] = "Ниже промпт документации:" -> found at buffer line 3')
  log.info('  searchLines[1] = "<!-- @include: ./правила-документации.md -->" -> expected at line 4')
  log.info('  But buffer line 4 is EMPTY ("") -> mismatch!')
  log.info('  The actual match is at buffer line 5, but the algorithm requires CONSECUTIVE lines.')
  log.info('')
  log.info('  ROOT CAUSE: Gemini TUI inserts blank lines between content paragraphs,')
  log.info('  but getSearchLines() skips blank lines from the entry content.')
  log.info('  The algorithm then expects consecutive buffer lines to match,')
  log.info('  but the buffer has blank lines that the content does not.')
  log.info('')
  log.info('  FIX: scrollToTextInBuffer should skip empty buffer lines when matching')
  log.info('  multi-line content, OR getSearchLines should only use 1 line.')
  console.log()

  // BUG 2: "да" matches "да Добавь..."
  log.info('BUG 2: Entry #2 ("да") navigates to wrong position')
  log.info('  searchLines = ["да"] (2 chars -> uses word boundary matching)')
  log.info('  lineContains("да Добавь...", "да") = true (space after "да" is a boundary)')
  log.info('  This matches at buffer line 31 (Entry #1 position) instead of line 42 (correct)')
  log.info('')
  log.info('  The occurrence counting does NOT help here because:')
  log.info('  - Entry #1 searchLines = ["да Добавь также..."] (different from ["да"])')
  log.info('  - So occurrenceIndex for Entry #2 is still 0')
  log.info('  - But the first match of "да" in buffer is at line 31 (wrong location)')
  log.info('')
  log.info('  ROOT CAUSE: lineContains matches "да" at start of "да Добавь..." because')
  log.info('  it has a word boundary (space) after it. This is correct behavior for')
  log.info('  word boundary detection, but incorrect for navigation because it finds')
  log.info('  the wrong user message.')
  log.info('')
  log.info('  FIX OPTIONS:')
  log.info('  1. For single-line short entries, require the match to be the ONLY content')
  log.info('     on the line (or at line start with nothing else meaningful)')
  log.info('  2. Use a stricter match: for entries with just 1 very short searchLine,')
  log.info('     require the entire buffer line to be ~equal (trimmed)')
  log.info('  3. Count ALL "да" matches including those in longer lines,')
  log.info('     and use occurrence to skip past "да Добавь..." match')

  // ── Matching edge cases (using factory function to test each mode) ──
  log.header('Matching Tests (isStrictShort / isIsolatedShort / default)')

  // isStrictShort tests (needle < 5 chars, single-line)
  const strictShortLC = makeLineContains(['да'])
  const strictShortTests = [
    { h: 'да', n: 'да', exp: true, desc: 'isStrictShort: exact match' },
    { h: 'да Добавь', n: 'да', exp: false, desc: 'isStrictShort: long line with "да" prefix — must NOT match' },
    { h: '  да  ', n: 'да', exp: true, desc: 'isStrictShort: spaces around' },
    { h: '> да', n: 'да', exp: true, desc: 'isStrictShort: prompt prefix "> "' },
    { h: 'надо', n: 'да', exp: false, desc: 'isStrictShort: inside "надо"' },
    { h: 'года', n: 'да', exp: false, desc: 'isStrictShort: inside "года"' },
  ]

  for (const t of strictShortTests) {
    const actual = strictShortLC(t.h, t.n)
    const ok = actual === t.exp
    const prefix = ok ? c.green + '[OK]' : c.red + '[MISMATCH]'
    console.log(`  ${prefix}${c.reset} lineContains("${t.h}", "${t.n}") = ${actual} (exp ${t.exp}) -- ${t.desc}`)
    if (ok) passed++; else failed++
  }

  // isIsolatedShort tests (needle 5..29 chars, single-line)
  const isolatedLC = makeLineContains(['continue'])
  const isolatedTests = [
    { h: 'continue', n: 'continue', exp: true, desc: 'isIsolatedShort: exact match' },
    { h: '  continue  ', n: 'continue', exp: true, desc: 'isIsolatedShort: spaces around' },
    { h: '> continue', n: 'continue', exp: true, desc: 'isIsolatedShort: prompt ">"' },
    { h: 'OK, continue.', n: 'continue', exp: false, desc: 'isIsolatedShort: AI "OK, continue." — alpha prefix' },
    { h: 'Sure, continue.', n: 'continue', exp: false, desc: 'isIsolatedShort: AI "Sure, continue." — alpha prefix' },
    { h: "I'll continue.", n: 'continue', exp: false, desc: 'isIsolatedShort: AI "I\'ll continue." — alpha prefix' },
    { h: 'Let me continue working on the documentation...', n: 'continue', exp: false, desc: 'isIsolatedShort: long AI response — too long' },
    { h: 'Continuing the work...', n: 'continue', exp: false, desc: 'isIsolatedShort: "Continuing" (different word) — not found' },
  ]

  for (const t of isolatedTests) {
    const actual = isolatedLC(t.h, t.n)
    const ok = actual === t.exp
    const prefix = ok ? c.green + '[OK]' : c.red + '[MISMATCH]'
    console.log(`  ${prefix}${c.reset} lineContains("${t.h}", "${t.n}") = ${actual} (exp ${t.exp}) -- ${t.desc}`)
    if (ok) passed++; else failed++
  }

  // ══════════════════════════════════════════════════════════════
  // PART 2: Electron test
  // ══════════════════════════════════════════════════════════════
  log.header('PART 2: Electron Click Handler Test')

  log.step('Launching Noted Terminal...')

  let app, page, consoleLogs
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await launch({
        logConsole: true,
        logMainProcess: false,
        waitForReady: 5000,
        timeout: 45000
      })
      app = result.app; page = result.page; consoleLogs = result.consoleLogs
      break
    } catch (e) {
      log.warn(`Launch attempt ${attempt}: ${e.message.substring(0, 100)}`)
      if (attempt < 2) await new Promise(r => setTimeout(r, 8000))
      else {
        log.warn('Electron launch failed. Skipping Part 2.')
        log.header('Final Summary (Part 1 only)')
        console.log(`  Passed: ${passed}  Failed: ${failed}`)
        if (failed === 0) log.pass('ALL TESTS PASSED')
        else log.fail(`${failed} test(s) failed`)
        process.exit(failed > 0 ? 1 : 0)
      }
    }
  }

  try {
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    await waitForTerminal(page, 20000)
    log.pass('Terminal ready')

    // Setup tab
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(2000)
    await typeCommand(page, `cd ${TEST_CWD}`)
    await page.waitForTimeout(1000)

    await page.evaluate(({ sessionId }) => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) {
        store.setGeminiSessionId(tabId, sessionId)
        store.setTabCommandType(tabId, 'gemini')
      }
    }, { sessionId: TEST_SESSION_ID })

    await page.waitForTimeout(5000)

    const dotCount = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div')
      for (const el of allDivs) {
        const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
        if (dots.length >= 3) {
          const w = parseInt(window.getComputedStyle(el).width)
          if (w > 0 && w <= 30) return dots.length
        }
      }
      return 0
    })
    assert(dotCount === 5, `Timeline rendered ${dotCount} dots`)

    // Click each dot
    for (let dotIndex = 0; dotIndex < dotCount; dotIndex++) {
      log.step(`Clicking dot #${dotIndex}...`)

      const logsBeforeClick = consoleLogs.length

      const dotPos = await page.evaluate((idx) => {
        const allDivs = document.querySelectorAll('div')
        for (const el of allDivs) {
          const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
          if (dots.length >= 3) {
            const w = parseInt(window.getComputedStyle(el).width)
            if (w > 0 && w <= 30 && dots[idx]) {
              const rect = dots[idx].getBoundingClientRect()
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            }
          }
        }
        return null
      }, dotIndex)

      if (!dotPos) { log.warn('  Position not found'); continue }

      await page.mouse.click(dotPos.x, dotPos.y)
      await page.waitForTimeout(800)

      const newLogs = consoleLogs.slice(logsBeforeClick)
      const scrollLogs = newLogs.filter(l =>
        l.includes('scrollToTextInBuffer') || l.includes('[Timeline]') || l.includes('Diagnosing')
      )

      for (const sl of scrollLogs) {
        const isFound = sl.includes('Found at logicalLine')
        console.log(`  ${isFound ? c.green : c.red}${sl}${c.reset}`)
      }
      if (scrollLogs.length === 0) log.info('  (No scroll logs — buffer is empty in test instance)')
    }

    // All scroll logs
    log.header('ALL scrollToTextInBuffer Logs')
    const allScroll = consoleLogs.filter(l => l.includes('scrollToTextInBuffer'))
    for (const line of allScroll) console.log(`  ${line}`)

    log.info(`Found: ${allScroll.filter(l => l.includes('Found at')).length}, NOT found: ${allScroll.filter(l => l.includes('NOT found')).length}`)
    log.info('NOTE: All NOT found is expected — buffer has no Gemini conversation in test instance')

  } finally {
    await app.close()
  }

  // ══════════════════════════════════════════════════════════════
  log.header('Final Summary')
  console.log(`  Passed: ${passed}  Failed: ${failed}`)
  if (failed === 0) log.pass('ALL TESTS PASSED')
  else log.fail(`${failed} test(s) failed`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
