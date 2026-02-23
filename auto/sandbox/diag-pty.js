/**
 * Diagnostic: Why does browser tab PTY exit?
 * Checks PTY creation and exit logs from main process.
 */
const { launch } = require('../core/launcher')
const electron = require('../core/electron')

async function main() {
  console.log('[DIAG] Starting app...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 4000
  })

  try {
    await electron.focusWindow(app)
    await page.waitForTimeout(3000)

    // Create a browser tab
    console.log('[DIAG] Creating browser tab...')
    await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      store?.createBrowserTab?.(store?.activeProjectId)
    })
    await page.waitForTimeout(5000) // Wait longer to catch PTY exit

    // Check tab state
    const tabState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return tab ? { id: tab.id, tabType: tab.tabType, pid: tab.pid } : null
    })
    console.log('[DIAG] Tab state:', JSON.stringify(tabState))

    // Dump PTY-related main process logs
    console.log('\n=== MAIN PROCESS PTY LOGS ===')
    for (const log of mainProcessLogs) {
      if (log.includes('PTY:') || log.includes('[terminal:create]') || log.includes('pty.spawn') || log.includes('PERF:main')) {
        console.log(log)
      }
    }
    console.log('=== END ===\n')

  } finally {
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
