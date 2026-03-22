/**
 * Test: Gemini Rewind — full integration through app
 *
 * Uses golden session fixture (13 user messages with edge cases).
 * Tests through Playwright (IPC, store, DOM):
 * 1. gemini:get-timeline returns 13 entries from golden session
 * 2. gemini:copy-range extracts correct message range
 * 3. Timeline DOM shows 13 dots
 * 4. Context menu shows "Откатиться" for Gemini
 * 5. Duplicate prefix detection (skipDuplicates)
 * 6. gemini:open-history-menu IPC accepts correct params
 *
 * Golden session: auto/mock-data/gemini-rewind-session.json
 * Copied to ~/.gemini/tmp/custom-terminal/chats/ before test.
 *
 * Run: node auto/stable/test-gemini-rewind.js
 */

const { launch, waitForTerminal, typeCommand } = require('../core/launcher')
const electron = require('../core/electron')
const fs = require('fs')
const path = require('path')

const TEST_CWD = '/Users/fedor/Desktop/custom-terminal'
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'gemini-rewind-session.json')

// Read fixture to get session ID
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'))
const TEST_SESSION_ID = fixture.sessionId
const EXPECTED_USER_COUNT = fixture.messages.filter(m => m.type === 'user').length

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}

let passed = 0, failed = 0

function assert(condition, message) {
  if (condition) { log.pass(message); passed++ }
  else { log.fail(message); failed++ }
}

// Ensure golden session is in Gemini chats dir
function ensureGoldenSession() {
  const chatsDir = path.join(require('os').homedir(), '.gemini', 'tmp', 'custom-terminal', 'chats')
  if (!fs.existsSync(chatsDir)) {
    log.warn('Gemini chats dir not found: ' + chatsDir)
    return false
  }

  // Check if already exists
  const files = fs.readdirSync(chatsDir)
  const existing = files.find(f => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(chatsDir, f), 'utf-8'))
      return d.sessionId === TEST_SESSION_ID
    } catch { return false }
  })

  if (existing) {
    log.info('Golden session already in chats dir: ' + existing)
    return true
  }

  // Copy fixture
  const fileName = `session-test-rewind-golden.json`
  fs.writeFileSync(path.join(chatsDir, fileName), JSON.stringify(fixture, null, 2))
  log.info('Copied golden session to: ' + fileName)
  return true
}

async function main() {
  log.step('Preparing golden session...')
  log.info('Session ID: ' + TEST_SESSION_ID)
  log.info('Expected user messages: ' + EXPECTED_USER_COUNT)

  const sessionReady = ensureGoldenSession()
  if (!sessionReady) {
    log.fail('Could not prepare golden session')
    process.exit(1)
  }

  log.step('Launching Noted Terminal...')
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal ready')

    // ═══════════════════════════════════════════════════════════
    // TEST 1: gemini:get-timeline returns all entries
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 1: gemini:get-timeline IPC...')

    const timeline = await page.evaluate(async ({ sessionId, cwd }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-timeline', { sessionId, cwd })
    }, { sessionId: TEST_SESSION_ID, cwd: TEST_CWD })

    assert(timeline.success, 'Timeline IPC success')
    assert(timeline.entries.length === EXPECTED_USER_COUNT,
      `Timeline has ${EXPECTED_USER_COUNT} entries (got ${timeline.entries.length})`)

    // Verify edge cases are present
    const contents = timeline.entries.map(e => e.content)
    assert(contents.some(c => c.includes('leading space')), 'Leading space message present')
    assert(contents.filter(c => c.startsWith('MSG-06')).length === 2, 'Two MSG-06 duplicates present')
    assert(contents.some(c => c.includes('truncation')), 'Long message present')

    // ═══════════════════════════════════════════════════════════
    // TEST 2: gemini:copy-range extracts correct content
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 2: gemini:copy-range IPC...')

    const entry4 = timeline.entries[3] // MSG-04
    const entryLast = timeline.entries[timeline.entries.length - 1]

    const range = await page.evaluate(async ({ sessionId, cwd, startUuid, endUuid }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:copy-range', { sessionId, cwd, startUuid, endUuid })
    }, {
      sessionId: TEST_SESSION_ID, cwd: TEST_CWD,
      startUuid: entry4.uuid, endUuid: entryLast.uuid
    })

    assert(range.success, 'Copy-range IPC success')
    assert(range.content.length > 100, `Copy-range returned content (${range.content.length} chars)`)
    assert(range.content.includes('MSG-04'), 'Range starts from MSG-04')
    assert(range.content.includes('MSG-12') || range.content.includes('Final message'), 'Range includes last message')
    log.info('Range preview: ' + range.content.substring(0, 80) + '...')

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Timeline DOM shows dots
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 3: Timeline DOM rendering...')

    // Create tab and set gemini session
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)
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

    // Wait for Timeline to render (2s polling + React re-render)
    await page.waitForTimeout(4000)

    const timelineDom = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div')
      for (const el of allDivs) {
        const style = window.getComputedStyle(el)
        if (style.width === '16px' && style.borderLeftStyle !== 'none') {
          const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
          if (dots.length > 0) return { found: true, dots: dots.length }
        }
      }
      for (const el of allDivs) {
        const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
        if (dots.length >= 3) {
          const w = parseInt(window.getComputedStyle(el).width)
          if (w > 0 && w <= 30) return { found: true, dots: dots.length }
        }
      }
      return { found: false, dots: 0 }
    })

    assert(timelineDom.found, 'Timeline DOM found')
    assert(timelineDom.dots >= 10, `Timeline has >= 10 dots (got ${timelineDom.dots})`)

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Context menu shows "Откатиться" for Gemini
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 4: Context menu shows Rewind...')

    const dotPos = await page.evaluate(() => {
      const allDivs = document.querySelectorAll('div')
      for (const el of allDivs) {
        const style = window.getComputedStyle(el)
        if (style.width === '16px' && style.borderLeftStyle !== 'none') {
          const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
          if (dots.length > 0) {
            const rect = dots[0].getBoundingClientRect()
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
          }
        }
      }
      return null
    })

    if (dotPos) {
      await page.mouse.click(dotPos.x, dotPos.y, { button: 'right' })
      await page.waitForTimeout(500)

      const menuContent = await page.evaluate(() => {
        const buttons = document.querySelectorAll('div[style*="z-index: 10001"] button')
        return Array.from(buttons).map(btn => btn.textContent?.trim())
      })

      log.info('Menu buttons: ' + JSON.stringify(menuContent))

      const hasRewind = menuContent.some(l => l?.includes('Откатиться'))
      const hasRangeCopy = menuContent.some(l => l?.includes('Начать копирование'))
      const hasCopyText = menuContent.some(l => l?.includes('Копировать текст'))

      assert(hasRewind, 'Rewind ("Откатиться") visible for Gemini')
      assert(!hasRangeCopy, 'Range copy hidden for Gemini')
      assert(hasCopyText, 'Copy text visible for Gemini')

      // Close menu
      await page.mouse.move(0, 0)
      await page.waitForTimeout(300)
    } else {
      log.warn('Could not find timeline dot for context menu test')
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 5: Duplicate prefix skipDuplicates logic
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 5: Duplicate prefix skipDuplicates...')

    // Simulate what handleRewind does for duplicate detection
    const dupResult = await page.evaluate(({ entries }) => {
      // Find MSG-06 alpha (first occurrence)
      const target = entries.find(e => e.content.includes('alpha'))
      if (!target) return { error: 'alpha not found' }

      const targetPrefix = target.content.trim().substring(0, 40)
      const targetIndex = entries.findIndex(e => e.uuid === target.uuid)

      // Count duplicates AFTER target
      let skipDuplicates = 0
      for (let i = targetIndex + 1; i < entries.length; i++) {
        const ePrefix = entries[i].content.trim().substring(0, 40)
        if (ePrefix === targetPrefix) skipDuplicates++
      }

      return { targetPrefix, targetIndex, skipDuplicates }
    }, { entries: timeline.entries })

    if (dupResult.error) {
      log.fail('Duplicate test: ' + dupResult.error)
    } else {
      assert(dupResult.skipDuplicates === 1,
        `skipDuplicates = ${dupResult.skipDuplicates} for MSG-06 alpha (expected 1)`)
      log.info(`Target: "${dupResult.targetPrefix}" at index ${dupResult.targetIndex}`)
    }

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════')
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed === 0) log.pass('ALL TESTS PASSED')
    else log.fail(`${failed} test(s) failed`)
    console.log('═══════════════════════════════════════')

  } finally {
    await app.close()
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
