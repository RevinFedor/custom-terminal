/**
 * Test: Gemini Timeline Navigation Diagnostics
 *
 * Diagnoses timeline click navigation for Gemini session 10807e79.
 *
 * Since we can't easily populate the xterm buffer with conversation content
 * in a test instance, this test:
 * 1. Verifies getSearchLines() produces correct output for each entry
 * 2. Verifies Timeline IPC and DOM rendering
 * 3. Clicks each dot and captures scrollToTextInBuffer logs
 * 4. Simulates the EXACT search logic (lineContains + multi-line matching)
 *    against a realistic Gemini TUI buffer dump to identify matching bugs
 * 5. Tests edge cases: word boundary matching for "да", duplicate detection
 *
 * Run: node auto/sandbox/test-gemini-timeline-nav.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

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

// ══════════════════════════════════════════════════════════════
// Replicate the exact search logic from terminalRegistry.ts
// ══════════════════════════════════════════════════════════════

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

function lineContains(haystack, needle) {
  if (needle.length >= 5) return haystack.includes(needle)
  // Word-boundary matching for short strings
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

function searchInBuffer(bufferLines, contentLines, occurrenceIndex) {
  const firstLine = contentLines[0]
  let validCount = 0

  for (let i = 0; i <= bufferLines.length - contentLines.length; i++) {
    if (!lineContains(bufferLines[i], firstLine)) continue

    let allMatch = true
    for (let j = 1; j < contentLines.length; j++) {
      if (i + j >= bufferLines.length || !lineContains(bufferLines[i + j], contentLines[j])) {
        allMatch = false
        break
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

// ══════════════════════════════════════════════════════════════
// Simulated Gemini TUI buffer — realistic representation
// of what the terminal actually shows when Gemini CLI is running
// ══════════════════════════════════════════════════════════════

// This simulates the actual xterm buffer content from a real Gemini session.
// Gemini CLI (Ink TUI) renders user messages WITHOUT prompt markers.
// The user's typed text appears in the buffer, sometimes with Ink formatting.
const SIMULATED_BUFFER = `
fedor@MacBook-Air-Fedor custom-terminal % gemini
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

Continuing the work on documentation updates...
`.trim().split('\n')


async function main() {
  log.header('Gemini Timeline Navigation Diagnostic Test')

  // ══════════════════════════════════════════════════════════════
  // PART 1: Pure logic test (no Electron needed)
  // ══════════════════════════════════════════════════════════════
  log.header('PART 1: Search Logic Test (simulated buffer)')

  // Read session data
  const fs = require('fs')
  const sessionPath = require('os').homedir() + '/.gemini/tmp/custom-terminal/chats/session-2026-02-24T22-31-10807e79.json'
  const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'))
  const userMessages = sessionData.messages.filter(m => m.type === 'user')

  log.info(`Session has ${userMessages.length} user messages`)

  // Extract content from each user message
  const entries = userMessages.map((m, i) => {
    let content = ''
    if (Array.isArray(m.content)) {
      content = m.content.filter(p => p.text).map(p => p.text).join('\n')
    } else {
      content = String(m.content || '')
    }
    return { index: i, content }
  })

  log.info(`Simulated buffer: ${SIMULATED_BUFFER.length} lines`)

  // Test each entry
  for (let i = 0; i < entries.length; i++) {
    const searchLines = getSearchLines(entries[i].content)

    // Calculate occurrenceIndex (same logic as Timeline click handler)
    let occurrenceIndex = 0
    for (let j = 0; j < i; j++) {
      const eLines = getSearchLines(entries[j].content)
      if (eLines.length === searchLines.length && eLines.every((l, k) => l === searchLines[k])) {
        occurrenceIndex++
      }
    }

    const result = searchInBuffer(SIMULATED_BUFFER, searchLines, occurrenceIndex)
    const preview = entries[i].content.replace(/\n/g, ' | ').substring(0, 80)

    log.info(`Entry #${i}: "${preview}"`)
    log.info(`  searchLines: ${JSON.stringify(searchLines)}`)
    log.info(`  occurrenceIndex: ${occurrenceIndex}`)

    if (result.found) {
      log.pass(`  FOUND at line ${result.line}: "${SIMULATED_BUFFER[result.line].substring(0, 80)}"`)
    } else {
      log.fail(`  NOT FOUND (validMatches: ${result.validMatches})`)

      // Debug: search for first searchLine in all buffer lines
      const firstLine = searchLines[0]
      log.info(`  Debugging first searchLine: "${firstLine}"`)
      for (let lineIdx = 0; lineIdx < SIMULATED_BUFFER.length; lineIdx++) {
        const bl = SIMULATED_BUFFER[lineIdx]
        // Check raw includes
        if (bl.includes(firstLine)) {
          const lcResult = lineContains(bl, firstLine)
          log.info(`    Line ${lineIdx}: includes=true, lineContains=${lcResult} -> "${bl.substring(0, 80)}"`)
        }
        // Also check if the line starts with part of the search
        if (firstLine.length > 5 && bl.trim().startsWith(firstLine.substring(0, 10))) {
          log.info(`    Line ${lineIdx}: starts with prefix -> "${bl.substring(0, 80)}"`)
        }
      }
    }
    console.log()
  }

  // ══════════════════════════════════════════════════════════════
  // Edge case tests
  // ══════════════════════════════════════════════════════════════
  log.header('Edge Case: Word Boundary for "да"')

  // "да" appears in "да Добавь..." and standalone "да"
  // The word boundary check should distinguish them
  const daSearchLines = getSearchLines('да')
  log.info(`searchLines for "да": ${JSON.stringify(daSearchLines)}`)

  // Test lineContains for various contexts
  const testCases = [
    { haystack: 'да', needle: 'да', expected: true, desc: 'exact match' },
    { haystack: 'да Добавь также еще вот это', needle: 'да', expected: true, desc: 'start of line with space after' },
    { haystack: 'документации:', needle: 'да', expected: false, desc: 'inside word "документации"' },
    { haystack: '  да  ', needle: 'да', expected: true, desc: 'surrounded by spaces' },
    { haystack: 'Отвечай да или нет', needle: 'да', expected: true, desc: 'word in sentence' },
    { haystack: 'надо дописать', needle: 'да', expected: false, desc: 'inside "надо"' },
    { haystack: 'года', needle: 'да', expected: false, desc: 'inside "года"' },
    { haystack: 'всегда', needle: 'да', expected: false, desc: 'inside "всегда"' },
  ]

  for (const tc of testCases) {
    const actual = lineContains(tc.haystack, tc.needle)
    const status = actual === tc.expected ? 'OK' : 'MISMATCH'
    const prefix = status === 'OK' ? c.green : c.red
    console.log(`  ${prefix}[${status}]${c.reset} lineContains("${tc.haystack}", "${tc.needle}") = ${actual} (expected ${tc.expected}) -- ${tc.desc}`)
    if (actual !== tc.expected) failed++
    else passed++
  }

  // ══════════════════════════════════════════════════════════════
  // Key finding: Entry #1 has "да Добавь..." as searchLines[0]
  // This is 50+ chars so uses includes() (no boundary check).
  // But Entry #2 has just "да" which needs boundary check.
  // The occurrence counting must separate them because their
  // searchLines are different.
  // ══════════════════════════════════════════════════════════════
  log.header('Occurrence Index Analysis')

  for (let i = 0; i < entries.length; i++) {
    const searchLines = getSearchLines(entries[i].content)
    let occurrenceIndex = 0
    for (let j = 0; j < i; j++) {
      const eLines = getSearchLines(entries[j].content)
      if (eLines.length === searchLines.length && eLines.every((l, k) => l === searchLines[k])) {
        occurrenceIndex++
      }
    }
    log.info(`Entry #${i}: occurrenceIndex=${occurrenceIndex}, searchLines=${JSON.stringify(searchLines)}`)
  }

  // ══════════════════════════════════════════════════════════════
  // PART 2: Electron test (real click handler)
  // ══════════════════════════════════════════════════════════════
  log.header('PART 2: Electron Click Handler Test')

  log.step('Launching Noted Terminal...')

  let app, page, consoleLogs
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await launch({
        logConsole: true,
        logMainProcess: false,
        waitForReady: 4000
      })
      app = result.app; page = result.page; consoleLogs = result.consoleLogs
      break
    } catch (e) {
      log.warn(`Launch attempt ${attempt}: ${e.message}`)
      if (attempt < 3) await new Promise(r => setTimeout(r, 5000))
      else throw e
    }
  }

  try {
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    await waitForTerminal(page, 20000)
    log.pass('Terminal ready')

    // Set up tab
    log.step('Setting up Gemini session tab...')
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

    log.info('Waiting 5s for Timeline to load...')
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
    assert(dotCount === 5, `Timeline rendered ${dotCount} dots (expected 5)`)

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

      if (!dotPos) { log.warn(`  Position not found`); continue }

      await page.mouse.click(dotPos.x, dotPos.y)
      await page.waitForTimeout(800)

      const newLogs = consoleLogs.slice(logsBeforeClick)
      const scrollLogs = newLogs.filter(l =>
        l.includes('scrollToTextInBuffer') ||
        l.includes('[Timeline]') ||
        l.includes('Diagnosing')
      )

      for (const sl of scrollLogs) {
        const isFound = sl.includes('Found at logicalLine')
        console.log(`  ${isFound ? c.green : c.red}${sl}${c.reset}`)
      }

      if (scrollLogs.length === 0) {
        log.warn(`  No scroll logs captured`)
      }
    }

    // ── All logs ──
    log.header('ALL scrollToTextInBuffer Logs from Electron')
    const allScroll = consoleLogs.filter(l => l.includes('scrollToTextInBuffer'))
    for (const line of allScroll) {
      console.log(`  ${line}`)
    }

    log.info(`Total: ${allScroll.length} log entries`)
    log.info(`Found: ${allScroll.filter(l => l.includes('Found at')).length}`)
    log.info(`NOT found: ${allScroll.filter(l => l.includes('NOT found')).length}`)

  } finally {
    await app.close()
  }

  // ══════════════════════════════════════════════════════════════
  // FINAL SUMMARY
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
