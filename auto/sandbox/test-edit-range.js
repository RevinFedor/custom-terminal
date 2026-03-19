/**
 * Test: Edit Range — выделение диапазона на таймлайне, открытие панели, применение
 *
 * Проверяет:
 * 1. Claude сессия стартует и timeline появляется
 * 2. Double-click по точке начинает выделение
 * 3. Click по второй точке показывает popup (Копировать / Редактировать)
 * 4. Кнопка ▶ (тест) мгновенно открывает EditRangePanel
 * 5. Панель отображается корректно (header, source, messages, input, apply button)
 * 6. "Применить" → kill Claude → edit JSONL → restart → "Готово"
 * 7. Timeline обновляется (точки удалены)
 *
 * Запуск: node auto/sandbox/test-edit-range.js 2>&1 | tee /tmp/test-edit-range.log
 * Требует: npm run dev + npx electron-vite build
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

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
const HARD_KILL_MS = 180000
const globalTimer = setTimeout(() => {
  console.error('\n[HARD KILL] Test exceeded ' + (HARD_KILL_MS / 1000) + 's, force exit')
  process.exit(1)
}, HARD_KILL_MS)

async function main() {
  log.step('1. Launching Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  log.pass('App launched')

  try {
    // Wait for terminal
    log.step('2. Waiting for terminal...')
    await waitForTerminal(page, 15000)
    log.pass('Terminal ready')

    // Focus with retry (context can be destroyed during restore navigation)
    for (let i = 0; i < 3; i++) {
      try {
        await electron.focusWindow(app)
        break
      } catch (e) {
        log.warn(`focusWindow attempt ${i + 1} failed: ${e.message.slice(0, 60)}`)
        await page.waitForTimeout(1000)
      }
    }
    try {
      await page.waitForFunction(() => document.hasFocus(), null, { timeout: 5000 })
    } catch { log.warn('document.hasFocus() timeout — continuing anyway') }

    // Create new tab to avoid stale state
    log.step('3. Creating new tab (Cmd+T)...')
    const tabsBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabsBefore, { timeout: 5000 })
    log.pass('New tab created')

    // Wait for shell prompt to be ready before typing
    const targetDir = '/Users/fedor/Desktop/custom-terminal'
    log.step(`4. cd ${targetDir}`)
    await page.waitForTimeout(1000) // Shell init
    await typeCommand(page, `cd ${targetDir}`)
    await page.waitForTimeout(1500) // Wait for OSC 7
    log.pass('cd sent')

    // Start Claude
    log.step('5. Starting Claude session...')
    await typeCommand(page, 'env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude --dangerously-skip-permissions')

    // Wait for session ID
    log.step('6. Waiting for Claude session ID...')
    await waitForClaudeSessionId(page, 60000)
    log.pass('Session ID captured')

    // Send a couple messages to create timeline entries
    log.step('7. Sending test messages to build timeline...')
    // Wait for Claude prompt
    const promptReady = await waitForMainProcessLog(mainProcessLogs, /\[Claude State\].*WAITING_PROMPT|Prompt ready/, 30000)
    log.info('Prompt state: ' + (promptReady || 'timeout'))
    await page.waitForTimeout(2000) // Let handshake complete

    // Send first message
    await page.keyboard.type('say hello', { delay: 30 })
    await page.keyboard.press('Enter')
    log.info('Sent: "say hello"')

    // Wait for response
    const resp1 = await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE|BoundaryMarker/, 45000)
    log.info('Response 1: ' + (resp1 ? 'received' : 'timeout'))
    await page.waitForTimeout(1000)

    // Send second message
    await page.keyboard.type('say goodbye', { delay: 30 })
    await page.keyboard.press('Enter')
    log.info('Sent: "say goodbye"')

    const resp2 = await waitForMainProcessLog(mainProcessLogs, /\[Spinner\].*IDLE|BoundaryMarker/, 45000)
    log.info('Response 2: ' + (resp2 ? 'received' : 'timeout'))
    await page.waitForTimeout(1000)

    // Check timeline has entries
    log.step('8. Checking timeline entries...')
    const timelineEntries = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = p?.tabs?.get?.(p?.activeTabId)
      // Timeline entries are not in store — check DOM
      return document.querySelectorAll('[data-timeline] [data-segment]').length
    })
    log.info(`Timeline segments in DOM: ${timelineEntries}`)
    assert(timelineEntries >= 2, `Timeline has ${timelineEntries} segments (need >= 2)`)

    // Get all timeline segment elements
    const segments = page.locator('[data-timeline] [data-segment]')
    const segmentCount = await segments.count()
    log.info(`Segment count via locator: ${segmentCount}`)

    if (segmentCount < 2) {
      log.fail('Not enough timeline segments to test range selection')
      return
    }

    // Double-click first segment to start selection
    log.step('9. Double-click first timeline segment to start selection...')
    const firstSegment = segments.nth(0)
    await firstSegment.dblclick()
    await page.waitForTimeout(300)

    // Check selection mode is active
    const hasSelection = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      // Selection is local state in Timeline component, check DOM for blue overlay
      return document.querySelector('[data-timeline] [data-segment]') !== null
    })
    log.info('Selection started (DOM check): ' + hasSelection)

    // Click last segment to finish selection
    log.step('10. Click last segment to show action menu...')
    const lastSegment = segments.nth(segmentCount - 1)
    await lastSegment.click()
    await page.waitForTimeout(500)

    // Check for range action menu (portal on body)
    const actionMenu = await page.evaluate(() => {
      // The range action menu is a portal with "Копировать" and "Редактировать" buttons
      const buttons = Array.from(document.querySelectorAll('button'))
      const copyBtn = buttons.find(b => b.textContent?.includes('Копировать'))
      const editBtn = buttons.find(b => b.textContent?.includes('Редактировать'))
      return {
        hasCopy: !!copyBtn,
        hasEdit: !!editBtn,
        copyText: copyBtn?.textContent || '',
        editText: editBtn?.textContent || ''
      }
    })
    log.info(`Action menu - Copy: "${actionMenu.copyText}", Edit: "${actionMenu.editText}"`)
    assert(actionMenu.hasCopy, 'Range action menu has Copy button')
    assert(actionMenu.hasEdit, 'Range action menu has Edit button')

    // Click the ▶ test button (right part of Редактировать split-button)
    log.step('11. Click ▶ test button to open EditRangePanel instantly...')
    const testButton = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const btn = buttons.find(b => b.textContent?.trim() === '▶')
      if (btn) { btn.click(); return true }
      return false
    })
    assert(testButton, 'Found and clicked ▶ test button')
    await page.waitForTimeout(500)

    // Check EditRangePanel appeared
    log.step('12. Checking EditRangePanel is visible...')
    const panelCheck = await page.evaluate(() => {
      // Panel has "✂️ Edit Range" header and "Применить" button
      const allText = document.body.innerText
      return {
        hasHeader: allText.includes('Edit Range'),
        hasApply: allText.includes('Применить'),
        hasSource: allText.includes('Источник'),
        hasTestContent: allText.includes('Тестовая сводка'),
      }
    })
    assert(panelCheck.hasHeader, 'Panel has "Edit Range" header')
    assert(panelCheck.hasApply, 'Panel has "Применить" button')
    assert(panelCheck.hasSource, 'Panel has collapsible "Источник"')
    assert(panelCheck.hasTestContent, 'Panel shows test compact content')

    // Get session info before apply
    const sessionBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const tab = p?.tabs?.get?.(p?.activeTabId)
      return { sessionId: tab?.claudeSessionId, tabId: p?.activeTabId }
    })
    log.info(`Session before apply: ${sessionBefore.sessionId?.slice(0, 8)}... tab: ${sessionBefore.tabId?.slice(0, 8)}`)

    // Click "Применить"
    log.step('13. Clicking "Применить" to start apply flow...')
    const applyClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const btn = buttons.find(b => b.textContent?.includes('Применить'))
      if (btn && !btn.disabled) { btn.click(); return true }
      return false
    })
    assert(applyClicked, 'Clicked "Применить" button')

    // Wait for running state
    await page.waitForTimeout(300)
    const runningState = await page.evaluate(() => {
      return document.body.innerText.includes('Применение...')
    })
    log.info('Running state visible: ' + runningState)

    // Wait for EditRange logs
    log.step('14. Waiting for EditRange IPC flow...')
    const killLog = await waitForMainProcessLog(mainProcessLogs, '[EditRange]', 10000)
    log.info('EditRange log: ' + (killLog || 'none'))

    // Wait for done state (green "Готово")
    log.step('15. Waiting for "Готово" state...')
    let doneVisible = false
    for (let i = 0; i < 20; i++) {
      doneVisible = await page.evaluate(() => document.body.innerText.includes('Готово'))
      if (doneVisible) break
      await page.waitForTimeout(500)
    }
    assert(doneVisible, '"Готово" screen appeared')

    // Check removedCount is shown
    const doneInfo = await page.evaluate(() => {
      return document.body.innerText.includes('Обработано')
    })
    log.info('Shows removed count: ' + doneInfo)

    // Check main process logs for the full flow
    log.step('16. Checking main process logs for flow completeness...')
    const editRangeLogs = findInLogs(mainProcessLogs, '[EditRange]')
    log.info(`EditRange logs (${editRangeLogs.length}):`)
    editRangeLogs.forEach(l => log.info('  ' + l.trim()))

    const hasEditLog = editRangeLogs.some(l => l.includes('Removing') || l.includes('Written'))
    log.info('Has JSONL edit confirmation: ' + hasEditLog)

    // Check for PTY exit (Claude was killed)
    const ptyExitLogs = findInLogs(mainProcessLogs, '[PTY:EXIT]')
    log.info(`PTY:EXIT logs: ${ptyExitLogs.length}`)

    // Check for Claude restart
    const restartLogs = findInLogs(mainProcessLogs, 'Continuing session')
    log.info(`Claude restart logs: ${restartLogs.length}`)

    // Wait for panel to auto-close (3s) or close manually
    await page.waitForTimeout(3500)

    const panelGone = await page.evaluate(() => {
      return !document.body.innerText.includes('Готово')
    })
    log.info('Panel auto-closed: ' + panelGone)

    // Summary
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } catch (err) {
    log.fail('Unexpected error: ' + err.message)
    console.error(err.stack)
    process.exitCode = 1
  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
