/**
 * Test: Gemini Timeline — slug resolution + IPC handler + DOM rendering
 *
 * Проверяет:
 * 1. gemini:get-timeline IPC handler возвращает entries из существующей сессии
 * 2. resolveGeminiProjectDir находит slug-based директорию
 * 3. Timeline DOM появляется когда geminiSessionId установлен в store
 * 4. Точки Timeline соответствуют количеству user messages
 * 5. Context menu для Gemini показывает Rewind (но НЕ Range Copy)
 *
 * Запуск: node auto/stable/test-gemini-timeline.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

// Existing Gemini session with 5 user messages in slug-based dir
const TEST_SESSION_ID = '10807e79-99a1-407d-90d0-835fca893708'
const TEST_CWD = '/Users/fedor/Desktop/custom-terminal'

const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m'
}

const log = {
  step: (msg) => console.log(`${c.cyan}[STEP]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`)
}

let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    log.pass(message)
    passed++
  } else {
    log.fail(message)
    failed++
  }
}

async function main() {
  log.step('Запуск Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  try {
    // 1. Wait for terminal
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)
    log.pass('Терминал активен')

    // ═══════════════════════════════════════════════════════════
    // TEST 1: gemini:get-timeline IPC handler works
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 1: Проверка gemini:get-timeline IPC...')

    const timelineResult = await page.evaluate(async ({ sessionId, cwd }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-timeline', { sessionId, cwd })
    }, { sessionId: TEST_SESSION_ID, cwd: TEST_CWD })

    assert(timelineResult.success === true, 'IPC returned success: true')
    assert(Array.isArray(timelineResult.entries), 'IPC returned entries array')
    assert(timelineResult.entries.length === 5, `IPC returned 5 entries (got ${timelineResult.entries.length})`)
    assert(timelineResult.sessionBoundaries.length === 0, 'No session boundaries (Gemini)')
    assert(timelineResult.latestSessionId === null, 'No latestSessionId (Gemini)')

    // Check entry structure
    if (timelineResult.entries.length > 0) {
      const first = timelineResult.entries[0]
      assert(first.uuid && first.uuid.length > 0, 'Entry has uuid')
      assert(first.type === 'user', 'Entry type is "user"')
      assert(first.timestamp && first.timestamp.length > 0, 'Entry has timestamp')
      assert(first.content && first.content.length > 0, 'Entry has content')
      assert(first.sessionId === TEST_SESSION_ID, 'Entry has correct sessionId')
      log.info(`First entry content preview: "${first.content.slice(0, 60)}..."`)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 2: Timeline DOM appears when geminiSessionId is set
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 2: Установка geminiSessionId в store и проверка Timeline DOM...')

    // Create a new tab, cd to project dir, then manually set geminiSessionId
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)
    await typeCommand(page, `cd ${TEST_CWD}`)
    await page.waitForTimeout(1000)

    // Get current tab info
    const tabInfo = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      return {
        activeProjectId: store?.activeProjectId,
        activeTabId: proj?.activeTabId
      }
    })
    log.info(`Tab: ${tabInfo.activeTabId}`)

    // Manually set geminiSessionId and commandType in store (simulates Sniper detection)
    await page.evaluate(({ sessionId }) => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tabId = proj?.activeTabId
      if (tabId) {
        store.setGeminiSessionId(tabId, sessionId)
        store.setTabCommandType(tabId, 'gemini')
      }
    }, { sessionId: TEST_SESSION_ID })

    // Wait for store to propagate + Timeline 2s polling + React re-render
    await page.waitForTimeout(4000)

    // Diagnostics: check store state and Workspace render conditions
    const diagState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return {
        geminiSessionId: tab?.geminiSessionId,
        commandType: tab?.commandType,
        cwd: tab?.cwd,
        view: proj?.currentView
      }
    })
    log.info(`Store state: geminiSessionId=${diagState.geminiSessionId}, commandType=${diagState.commandType}, cwd=${diagState.cwd}, view=${diagState.view}`)

    // Check Timeline dots in DOM — search for Timeline container
    // Timeline is a narrow strip (16px wide) with a border-left containing circular dots
    const timelineDom = await page.evaluate(() => {
      // Method 1: look for 16px width with border-left and dots
      const allDivs = document.querySelectorAll('div')
      for (const el of allDivs) {
        const style = window.getComputedStyle(el)
        if (style.width === '16px' && style.borderLeftStyle !== 'none') {
          const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
          if (dots.length > 0) {
            return { found: true, dots: dots.length, method: 'width-16px' }
          }
        }
      }
      // Method 2: look for any container with multiple circular dots (relaxed)
      for (const el of allDivs) {
        const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
        if (dots.length >= 3) {
          const style = window.getComputedStyle(el)
          const w = parseInt(style.width)
          if (w > 0 && w <= 30) {
            return { found: true, dots: dots.length, method: `width-${w}px`, width: style.width }
          }
        }
      }
      return { found: false, dots: 0 }
    })

    log.info(`Timeline DOM: ${JSON.stringify(timelineDom)}`)
    assert(timelineDom.found, 'Timeline DOM элемент найден')
    assert(timelineDom.dots >= 4, `Timeline имеет >= 4 точек (got ${timelineDom.dots})`)

    // ═══════════════════════════════════════════════════════════
    // TEST 3: Main process logs confirm slug resolution
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 3: Проверка логов main process...')

    const geminiTimelineLogs = mainProcessLogs.filter(l => l.includes('[Gemini Timeline]'))
    assert(geminiTimelineLogs.length > 0, 'Main process имеет [Gemini Timeline] логи')

    const returningLogs = mainProcessLogs.filter(l => l.includes('Returning') && l.includes('entries'))
    if (returningLogs.length > 0) {
      log.info(`Timeline log: ${returningLogs[0].trim()}`)
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 4: Context menu hides Claude-only features
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 4: Проверка context menu (Rewind доступен, Range Copy скрыт для Gemini)...')

    // Find a timeline dot and right-click on it
    const dotPosition = await page.evaluate(() => {
      const elements = document.querySelectorAll('div')
      for (const el of elements) {
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

    if (dotPosition) {
      // Right-click on dot to open context menu
      await page.mouse.click(dotPosition.x, dotPosition.y, { button: 'right' })
      await page.waitForTimeout(500)

      // Check context menu content
      const menuContent = await page.evaluate(() => {
        // Context menu is rendered in a portal (document.body)
        const buttons = document.querySelectorAll('div[style*="z-index: 10001"] button')
        const labels = []
        buttons.forEach(btn => labels.push(btn.textContent?.trim()))
        return labels
      })

      log.info(`Context menu buttons: ${JSON.stringify(menuContent)}`)

      const hasRangeCopy = menuContent.some(l => l?.includes('Начать копирование'))
      const hasRewind = menuContent.some(l => l?.includes('Откатиться'))
      const hasCopyText = menuContent.some(l => l?.includes('Копировать текст'))

      assert(!hasRangeCopy, 'Range copy скрыт для Gemini')
      assert(hasRewind, 'Rewind доступен для Gemini')
      assert(hasCopyText, 'Копировать текст доступен для Gemini')

      // Close menu by moving mouse away
      await page.mouse.move(0, 0)
      await page.waitForTimeout(300)
    } else {
      log.warn('Не удалось найти точку Timeline для context menu теста')
    }

    // ═══════════════════════════════════════════════════════════
    // TEST 5: Invalid session returns empty entries
    // ═══════════════════════════════════════════════════════════
    log.step('TEST 5: Невалидная сессия возвращает пустой массив...')

    const emptyResult = await page.evaluate(async ({ cwd }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('gemini:get-timeline', {
        sessionId: 'nonexistent-session-id',
        cwd
      })
    }, { cwd: TEST_CWD })

    assert(emptyResult.entries.length === 0, 'Несуществующая сессия → пустой entries')

    // ═══════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════')
    console.log(`  Passed: ${passed}  Failed: ${failed}`)
    if (failed === 0) {
      log.pass('ВСЕ ТЕСТЫ ПРОЙДЕНЫ')
    } else {
      log.fail(`${failed} тест(ов) провалено`)
    }
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
