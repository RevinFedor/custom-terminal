/**
 * Test: History Restore — sessionId из БД сохраняется в store
 *
 * Проверяет что при клике на запись в History:
 * 1. Создаётся таб с claudeSessionId из БД (без запуска Claude)
 * 2. В store у таба есть sessionId
 * 3. History entry удаляется
 *
 * Запуск: node auto/sandbox/test-history-restore.js
 */

const { launch, waitForTerminal, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

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
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
}

let passed = 0
let failed = 0

function check(label, condition) {
  if (condition) { log.pass(label); passed++ }
  else { log.fail(label); failed++ }
}

const SESSION_ID = 'deadbeef-1234-5678-9abc-def012345678'

async function main() {
  log.step('Запуск приложения...')

  const { app, page, consoleLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 4000
  })

  try {
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // Dismiss interrupted overlays from previous runs
    await page.evaluate(() => {
      const ws = window.useWorkspaceStore?.getState?.()
      if (!ws) return
      for (const [, workspace] of ws.openProjects) {
        for (const [tabId, tab] of workspace.tabs) {
          if (tab.wasInterrupted) ws.dismissInterruptedSession(tabId)
        }
      }
    })
    await page.waitForTimeout(300)

    // Get project info
    const projId = await page.evaluate(() => {
      return window.useWorkspaceStore?.getState?.()?.activeProjectId
    })
    log.info(`Project ID: ${projId}`)

    // Clean up any leftover test tabs from previous runs
    await page.evaluate((projectId) => {
      const ws = window.useWorkspaceStore?.getState?.()
      const proj = ws?.openProjects?.get?.(projectId)
      if (!proj) return
      const { ipcRenderer } = window.require('electron')
      for (const [tabId, tab] of proj.tabs) {
        if (tab.name?.startsWith('test-')) {
          ipcRenderer.send('terminal:kill', tabId)
          proj.tabs.delete(tabId)
        }
      }
      ws.openProjects.set(projectId, { ...proj })
      window.useWorkspaceStore.setState({ openProjects: new Map(ws.openProjects) })
    }, projId)
    await page.waitForTimeout(500)

    const tabsBefore = await page.evaluate(() => {
      const ws = window.useWorkspaceStore?.getState?.()
      const proj = ws?.openProjects?.get?.(ws?.activeProjectId)
      return proj?.tabs?.size || 0
    })
    log.info(`Tabs before: ${tabsBefore}`)

    // ═══════════════════════════════════════
    // 1. Создаём history entry С sessionId
    // ═══════════════════════════════════════
    log.step('Создание history entry с claudeSessionId...')
    await page.evaluate(async ({ projId, sessionId }) => {
      const { ipcRenderer } = window.require('electron')
      const ws = window.useWorkspaceStore?.getState?.()
      const proj = ws?.openProjects?.get?.(projId)
      await ipcRenderer.invoke('project:archive-tab', {
        projectId: projId,
        tab: {
          name: 'test-restore-session',
          cwd: proj?.projectPath || '/tmp',
          color: 'claude',
          commandType: 'claude',
          tabType: 'terminal',
          claudeSessionId: sessionId,
          createdAt: Math.floor(Date.now() / 1000)
        }
      })
    }, { projId, sessionId: SESSION_ID })

    // Verify it's in history
    const historyBefore = await page.evaluate(async (projectId) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('project:get-tab-history', { projectId })
    }, projId)
    const entryInHistory = (historyBefore || []).find(h => h.name === 'test-restore-session')
    check('1. History entry created with claude_session_id',
      entryInHistory && entryInHistory.claude_session_id === SESSION_ID)
    log.info(`History entry claude_session_id: ${entryInHistory?.claude_session_id}`)

    // ═══════════════════════════════════════
    // 2. Переключаемся в Home, кликаем restore
    // ═══════════════════════════════════════
    log.step('Переключение в Home View...')
    await page.evaluate(() => {
      window.useUIStore?.getState?.().setCurrentView('home')
    })
    await page.waitForTimeout(1000)

    log.step('Клик по "test-restore-session"...')
    const entry = page.locator('text=test-restore-session').first()
    await entry.waitFor({ state: 'visible', timeout: 5000 })
    await entry.click()

    // Ждём создание таба (createTab + PTY spawn)
    await page.waitForTimeout(3000)

    // ═══════════════════════════════════════
    // 3. ПРОВЕРКИ
    // ═══════════════════════════════════════
    log.step('Проверки...')

    const state = await page.evaluate(() => {
      const ws = window.useWorkspaceStore?.getState?.()
      const ui = window.useUIStore?.getState?.()
      const proj = ws?.openProjects?.get?.(ws?.activeProjectId)

      // Ищем таб по имени
      let tab = null
      if (proj) {
        for (const [, t] of proj.tabs) {
          if (t.name === 'test-restore-session') {
            tab = {
              id: t.id,
              name: t.name,
              commandType: t.commandType,
              color: t.color,
              claudeSessionId: t.claudeSessionId,
            }
            break
          }
        }
      }

      return {
        currentView: ui?.currentView,
        tabsCount: proj?.tabs?.size || 0,
        activeTabId: proj?.activeTabId,
        tab
      }
    })

    console.log('\n--- Tab State ---')
    console.log(JSON.stringify(state, null, 2))
    console.log('---\n')

    check('2. currentView === "terminal"', state.currentView === 'terminal')
    check('3. Tab count increased', state.tabsCount === tabsBefore + 1)
    check('4. Tab found by name', !!state.tab)
    check('5. Tab is active', state.activeTabId === state.tab?.id)
    check('6. commandType === "claude"', state.tab?.commandType === 'claude')
    check('7. claudeSessionId === "' + SESSION_ID + '"', state.tab?.claudeSessionId === SESSION_ID)

    // History entry удалена
    const historyAfter = await page.evaluate(async (projectId) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('project:get-tab-history', { projectId })
    }, projId)
    const stillExists = (historyAfter || []).some(h => h.name === 'test-restore-session')
    check('8. History entry deleted after restore', !stillExists)

    // Renderer logs
    const restoreLogs = findInLogs(consoleLogs, '[RESTORE]')
    const hasContinue = restoreLogs.some(l => l.includes('claude-continue') && l.includes(SESSION_ID))
    check('9. pendingAction built as claude-continue with sessionId', hasContinue)

    // ═══════════════════════════════════════
    console.log('\n═══════════════════════════════════════')
    console.log(`${c.green}PASSED: ${passed}${c.reset}  ${c.red}FAILED: ${failed}${c.reset}`)
    if (failed === 0) log.pass('ALL TESTS PASSED')
    else log.fail(`${failed} test(s) failed`)
    console.log('═══════════════════════════════════════')

    if (restoreLogs.length > 0) {
      console.log('\n--- [RESTORE] logs ---')
      restoreLogs.forEach(l => console.log(l))
    }

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
