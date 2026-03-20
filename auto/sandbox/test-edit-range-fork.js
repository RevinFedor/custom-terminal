/**
 * Test: Edit Range via Fork — форкает golden session, edit middle, verify integrity
 * Uses claude-f to fork, no need to create new session each time.
 *
 * Golden session: 7e972e4d-d379-4ffb-9b00-a03a2dbf2c49
 * Content: say alpha, say beta, say gamma, say delta, say epsilon, say foxtrot, say golf
 *
 * Запуск: node auto/sandbox/test-edit-range-fork.js 2>&1 | tee /tmp/test-fork.log
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

const GOLDEN_SESSION = '7e972e4d-d379-4ffb-9b00-a03a2dbf2c49'

const c = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m' }
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`)
}
let passed = 0, failed = 0
function assert(cond, msg) { if (cond) { log.pass(msg); passed++ } else { log.fail(msg); failed++ } }

const globalTimer = setTimeout(() => { console.error('[HARD KILL]'); process.exit(1) }, 180000)

async function main() {
  log.step('1. Launching...')
  const { app, page, mainProcessLogs } = await launch({ logConsole: false, logMainProcess: true, waitForReady: 4000 })
  log.pass('App launched')

  try {
    await waitForTerminal(page, 15000)
    for (let i = 0; i < 3; i++) { try { await electron.focusWindow(app); break } catch { await page.waitForTimeout(1000) } }

    // New tab + cd
    log.step('2. New tab + cd')
    const tabsBefore = await page.evaluate(() => { const s = window.useWorkspaceStore?.getState?.(); return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0 })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((p) => { const s = window.useWorkspaceStore?.getState?.(); return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > p }, tabsBefore, { timeout: 5000 })
    await page.waitForTimeout(1000)
    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(1500)
    log.pass('Ready')

    // Fork golden session
    log.step('3. Forking golden session...')
    await typeCommand(page, `claude-f ${GOLDEN_SESSION}`)
    await waitForClaudeSessionId(page, 60000)
    const sessionId = await page.evaluate(() => { const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId); return p?.tabs?.get?.(p?.activeTabId)?.claudeSessionId })
    log.pass('Fork session: ' + sessionId?.slice(0, 8))

    // Wait for timeline
    await page.waitForTimeout(5000)

    // Get timeline
    log.step('4. Getting timeline...')
    const tabId = await page.evaluate(() => { const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId); return p?.activeTabId })
    const cwd = await page.evaluate(() => { const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId); return p?.tabs?.get?.(p?.activeTabId)?.cwd })

    const before = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Entries: ' + before.entries?.length)
    before.entries?.forEach((e, i) => log.info(`  [${i}] "${e.content?.slice(0,20)}"`))
    assert(before.entries?.length >= 7, `Have ${before.entries?.length} entries`)

    await page.screenshot({ path: '/tmp/fork-before.png' })

    // Delete gamma+delta (indices 2-3)
    const gammaEntry = before.entries[2]
    const deltaEntry = before.entries[3]
    log.info(`Removing: [2] "${gammaEntry?.content?.slice(0,20)}" [3] "${deltaEntry?.content?.slice(0,20)}"`)

    // Exit Claude — DangerZone pattern (same as onApply in Timeline.tsx)
    log.step('5. Exiting Claude...')
    const cmdState = await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron'); return ipcRenderer.invoke('terminal:getCommandState', tid)
    }, tabId)
    log.info('commandState: ' + JSON.stringify(cmdState))

    if (cmdState?.isRunning) {
      // Ctrl+C #1
      await page.evaluate((tid) => {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('terminal:input', tid, '\x03')
      }, tabId)
      log.info('Ctrl+C #1 sent, waiting for DangerZone...')

      // Wait for "again to exit" via main process log
      const dz = await waitForMainProcessLog(mainProcessLogs, /DangerZone|again to exit|ctrlc-danger/, 3000)
      log.info('DangerZone: ' + (dz ? 'detected' : 'timeout'))

      // Ctrl+C #2
      await page.evaluate((tid) => {
        const { ipcRenderer } = window.require('electron')
        ipcRenderer.send('terminal:input', tid, '\x03')
      }, tabId)
      log.info('Ctrl+C #2 sent')

      // Wait for isRunning=false (OSC 133 D)
      for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(300)
        const state = await page.evaluate((tid) => {
          const { ipcRenderer } = window.require('electron'); return ipcRenderer.invoke('terminal:getCommandState', tid)
        }, tabId)
        if (!state?.isRunning) { log.info('isRunning=false at poll ' + i); break }
      }
    } else {
      log.warn('isRunning=false — Claude not detected as running!')
    }

    await page.screenshot({ path: '/tmp/fork-after-exit.png' })

    // Edit range
    log.step('6. Calling edit-range...')
    const editResult = await page.evaluate(({ sid, cwdArg, startU, endU }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:edit-range', {
        sessionId: sid, cwd: cwdArg, startUuid: startU, endUuid: endU,
        compactText: 'COMPACT: gamma и delta удалены.'
      })
    }, { sid: sessionId, cwdArg: cwd, startU: gammaEntry.uuid, endU: deltaEntry.uuid })

    log.info('Result: ' + JSON.stringify(editResult))
    assert(editResult.success, 'edit-range success')

    // Wait for shell prompt (OSC 133 A) before restarting Claude
    const resumeId = editResult.fileSessionId || sessionId
    log.step('7. Waiting for prompt-ready, then restarting Claude: ' + resumeId?.slice(0, 8))
    await waitForMainProcessLog(mainProcessLogs, /\[OSC 133\].*Prompt ready/, 10000)
    log.pass('Prompt ready')

    await page.evaluate(({ tid, sid }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('claude:run-command', { tabId: tid, command: 'claude-c', sessionId: sid })
    }, { tid: tabId, sid: resumeId })

    // Wait for Claude to load
    await waitForMainProcessLog(mainProcessLogs, /Spinner.*IDLE/, 30000)
    await page.waitForTimeout(3000)

    await page.screenshot({ path: '/tmp/fork-after-resume.png' })

    // Check timeline
    log.step('8. Timeline after edit...')
    const after = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })

    log.info('After: ' + after.entries?.length + ' entries')
    after.entries?.forEach((e, i) => log.info(`  [${i}] "${e.content?.slice(0,40)}"`))

    const contents = after.entries?.map(e => e.content) || []
    assert(!contents.some(c => c?.startsWith('say gamma')), 'gamma removed')
    assert(!contents.some(c => c?.startsWith('say delta')), 'delta removed')
    assert(contents.some(c => c?.startsWith('say alpha')), 'alpha preserved')
    assert(contents.some(c => c?.startsWith('say beta')), 'beta preserved')
    assert(contents.some(c => c?.startsWith('say epsilon')), 'epsilon preserved')
    assert(contents.some(c => c?.startsWith('say foxtrot')), 'foxtrot preserved')
    assert(contents.some(c => c?.startsWith('say golf')), 'golf preserved')
    assert(contents.some(c => c?.includes('COMPACT')), 'compact present')

    // Send new message to verify Claude sees full chain
    log.step('9. Sending new message...')
    await page.waitForTimeout(2000)
    const logsBefore = mainProcessLogs.length
    await page.keyboard.type('say final verify', { delay: 30 })
    await page.keyboard.press('Enter')
    for (let t = 0; t < 150; t++) {
      let found = false
      for (let j = logsBefore; j < mainProcessLogs.length; j++) { if (/\[Spinner\].*IDLE/.test(mainProcessLogs[j])) { found = true; break } }
      if (found) break
      await page.waitForTimeout(300)
    }
    await page.waitForTimeout(4000)

    await page.screenshot({ path: '/tmp/fork-after-new-msg.png' })

    const final = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Final: ' + final.entries?.length + ' entries')
    final.entries?.forEach((e, i) => log.info(`  [${i}] "${e.content?.slice(0,40)}"`))

    const fc = final.entries?.map(e => e.content) || []
    assert(fc.some(c => c?.startsWith('say epsilon')), 'epsilon STILL there after new msg')
    assert(fc.some(c => c?.startsWith('say golf')), 'golf STILL there after new msg')
    assert(fc.some(c => c?.startsWith('say final')), 'new msg present')
    assert(!fc.some(c => c?.startsWith('say gamma')), 'gamma still removed')

    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } catch (err) {
    log.fail('Error: ' + err.message)
    console.error(err.stack)
    await page.screenshot({ path: '/tmp/fork-error.png' }).catch(() => {})
    process.exitCode = 1
  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
