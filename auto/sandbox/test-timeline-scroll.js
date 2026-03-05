/**
 * Test: Timeline Scroll — verifies scroll behavior with many entries
 *
 * Uses real Gemini session 0e05bed3 (hh-tool, 106 user messages)
 * Checks:
 * 1. IPC returns correct entry count
 * 2. Timeline container is scrollable (scrollHeight > clientHeight)
 * 3. Custom scroll indicator appears
 * 4. Entries have minimum spacing (minHeight enforced)
 *
 * Запуск: node auto/sandbox/test-timeline-scroll.js 2>&1 | tee /tmp/test-timeline-scroll.log
 */

const { launch, waitForTerminal, typeCommand } = require('../core/launcher')
const electron = require('../core/electron')

const TEST_SESSION_ID = '0e05bed3-74a9-4916-9bdc-1051897439d7'
const TEST_CWD = '/Users/fedor/Desktop/hh-tool'

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
function assert(cond, msg) {
  if (cond) { log.pass(msg); passed++ }
  else { log.fail(msg); failed++ }
}

// Hard kill safety
const globalTimer = setTimeout(() => {
  console.error('HARD KILL: 120s timeout')
  process.exit(1)
}, 120000)

async function main() {
  log.step('Launching Noted Terminal...')

  const { app, page, mainProcessLogs } = await launch({
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Terminal active')

    // ═══════════════════════════════════════════════════════════
    // TEST 1: IPC returns entries for this session
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 1: gemini:get-timeline IPC with 106-user-message session')

    const result = await page.evaluate(async ({ sessionId, cwd }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-timeline', { sessionId, cwd })
    }, { sessionId: TEST_SESSION_ID, cwd: TEST_CWD })

    assert(result.success === true, 'IPC success')
    log.info(`Entries returned: ${result.entries.length}`)
    assert(result.entries.length > 50, `Got >50 entries (actual: ${result.entries.length})`)

    // Count sub-agent entries
    const subAgentCount = result.entries.filter(e => e.isSubAgent).length
    log.info(`Sub-agent entries: ${subAgentCount}`)

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Set up Timeline in DOM and check scroll
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 2: Set geminiSessionId in store, check Timeline scroll')

    // Create new tab and cd
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)
    await typeCommand(page, `cd ${TEST_CWD}`)
    await page.waitForTimeout(1000)

    // Set session in store
    await page.evaluate(({ sessionId }) => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) {
        store.setGeminiSessionId(tabId, sessionId)
        store.setTabCommandType(tabId, 'gemini')
      }
    }, { sessionId: TEST_SESSION_ID })

    // Wait for Timeline to load (2s polling + render)
    await page.waitForTimeout(5000)

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Check Timeline DOM — scrollable container
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 3: Timeline DOM — scroll dimensions')

    const scrollInfo = await page.evaluate(() => {
      // Find timeline container (24px wide with data-timeline attr)
      const timeline = document.querySelector('[data-timeline]')
      if (!timeline) return { found: false }

      // Find the scrollable inner div (first child div with overflow-y)
      const children = timeline.children
      let scrollable = null
      for (const child of children) {
        const style = window.getComputedStyle(child)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollable = child
          break
        }
      }
      if (!scrollable) return { found: true, scrollable: false }

      const rect = scrollable.getBoundingClientRect()
      return {
        found: true,
        scrollable: true,
        clientHeight: Math.round(rect.height),
        scrollHeight: scrollable.scrollHeight,
        isOverflowing: scrollable.scrollHeight > rect.height,
        ratio: (scrollable.scrollHeight / rect.height).toFixed(2),
        childCount: scrollable.querySelectorAll('[data-segment]').length,
      }
    })

    log.info(`Timeline: ${JSON.stringify(scrollInfo)}`)
    assert(scrollInfo.found, 'Timeline container found in DOM')
    assert(scrollInfo.scrollable, 'Scrollable div found inside timeline')
    assert(scrollInfo.childCount > 30, `Has >30 entry segments (got ${scrollInfo.childCount})`)
    assert(scrollInfo.isOverflowing, `Content overflows: scrollHeight(${scrollInfo.scrollHeight}) > clientHeight(${scrollInfo.clientHeight}) ratio=${scrollInfo.ratio}`)

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Check entry min-height
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 4: Entry minHeight enforcement')

    const entryHeights = await page.evaluate(() => {
      const segments = document.querySelectorAll('[data-segment]')
      const heights = []
      for (const seg of segments) {
        const rect = seg.getBoundingClientRect()
        if (rect.height > 0) heights.push(Math.round(rect.height))
      }
      return {
        count: heights.length,
        min: Math.min(...heights),
        max: Math.max(...heights),
        avg: (heights.reduce((a, b) => a + b, 0) / heights.length).toFixed(1),
        first5: heights.slice(0, 5),
      }
    })

    log.info(`Entry heights: min=${entryHeights.min} max=${entryHeights.max} avg=${entryHeights.avg} count=${entryHeights.count}`)
    log.info(`First 5 heights: ${entryHeights.first5.join(', ')}`)
    assert(entryHeights.min >= 8, `Min entry height >= 8px (got ${entryHeights.min})`)

    // ═══════════════════════════════════════════════════════════
    // TEST 5: Custom scroll indicator
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 5: Custom scroll indicator visibility')

    const scrollIndicator = await page.evaluate(() => {
      const timeline = document.querySelector('[data-timeline]')
      if (!timeline) return { found: false }
      // Look for the scroll indicator div (absolute, 3px wide, pointer-events none)
      const children = timeline.children
      for (const child of children) {
        const style = window.getComputedStyle(child)
        if (style.pointerEvents === 'none' && style.position === 'absolute') {
          const w = parseInt(style.width)
          if (w <= 5 && w > 0) {
            return {
              found: true,
              width: style.width,
              height: style.height,
              top: style.top,
              right: style.right,
              bg: style.backgroundColor,
            }
          }
        }
      }
      return { found: false }
    })

    log.info(`Scroll indicator: ${JSON.stringify(scrollIndicator)}`)
    assert(scrollIndicator.found, 'Custom scroll indicator found in DOM')

    // ═══════════════════════════════════════════════════════════
    // TEST 6: Scroll actually works
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 6: Programmatic scroll changes scrollTop')

    const scrollResult = await page.evaluate(() => {
      const timeline = document.querySelector('[data-timeline]')
      if (!timeline) return { error: 'no timeline' }
      const children = timeline.children
      let scrollable = null
      for (const child of children) {
        const style = window.getComputedStyle(child)
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          scrollable = child
          break
        }
      }
      if (!scrollable) return { error: 'no scrollable' }

      const before = scrollable.scrollTop
      scrollable.scrollTop = 200
      const after = scrollable.scrollTop
      return { before, after, changed: after !== before }
    })

    log.info(`Scroll: before=${scrollResult.before} after=${scrollResult.after}`)
    assert(scrollResult.changed, 'scrollTop changed after programmatic scroll')

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════')
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed === 0) log.pass('ALL TESTS PASSED')
    else log.fail(`${failed} test(s) failed`)
    console.log('═══════════════════════════════════════')

  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
