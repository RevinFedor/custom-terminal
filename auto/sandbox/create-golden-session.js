/**
 * Creates a golden session with 7 messages for edit-range tests.
 * Run ONCE, then use the session ID in test-edit-range-fork.js
 */
const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog } = require('../core/launcher')
const electron = require('../core/electron')

const c = { reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', dim: '\x1b[2m' }
const log = { step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`), pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`), info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`) }

const globalTimer = setTimeout(() => { console.error('[HARD KILL]'); process.exit(1) }, 300000)

async function sendAndWait(page, logs, text) {
  const before = logs.length
  await page.keyboard.type(text, { delay: 30 })
  await page.keyboard.press('Enter')
  for (let t = 0; t < 200; t++) {
    for (let j = before; j < logs.length; j++) { if (/\[Spinner\].*IDLE/.test(logs[j])) return true }
    await page.waitForTimeout(300)
  }
  return false
}

async function main() {
  log.step('Launching...')
  const { app, page, mainProcessLogs } = await launch({ logConsole: false, logMainProcess: true, waitForReady: 4000 })

  try {
    await waitForTerminal(page, 15000)
    for (let i = 0; i < 3; i++) { try { await electron.focusWindow(app); break } catch { await page.waitForTimeout(1000) } }

    const tabsBefore = await page.evaluate(() => { const s = window.useWorkspaceStore?.getState?.(); return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0 })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((p) => { const s = window.useWorkspaceStore?.getState?.(); return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > p }, tabsBefore, { timeout: 5000 })
    await page.waitForTimeout(1000)
    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(1500)

    log.step('Starting Claude...')
    await typeCommand(page, 'env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude --dangerously-skip-permissions')
    await waitForClaudeSessionId(page, 60000)
    const sessionId = await page.evaluate(() => { const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId); return p?.tabs?.get?.(p?.activeTabId)?.claudeSessionId })
    log.pass('Session: ' + sessionId)

    await waitForMainProcessLog(mainProcessLogs, /Prompt ready/, 30000)
    await page.waitForTimeout(2000)

    const msgs = ['say alpha', 'say beta', 'say gamma', 'say delta', 'say epsilon', 'say foxtrot', 'say golf']
    for (const msg of msgs) {
      const ok = await sendAndWait(page, mainProcessLogs, msg)
      log.info(`${msg}: ${ok ? 'OK' : 'timeout'}`)
      await page.waitForTimeout(500)
    }

    console.log('\n========================================')
    console.log('GOLDEN SESSION ID: ' + sessionId)
    console.log('========================================')
    console.log('Copy this ID into test-edit-range-fork.js')

  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
