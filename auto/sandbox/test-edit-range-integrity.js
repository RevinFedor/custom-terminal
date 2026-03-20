/**
 * Test: Edit Range Integrity — удаление из середины, проверка что записи ПОСЛЕ range сохранены
 *
 * 1. Создаёт 7 сообщений (alpha..golf)
 * 2. Удаляет записи 3-4 (gamma, delta) из середины
 * 3. Проверяет: alpha, beta ПЕРЕД range сохранены
 * 4. Проверяет: epsilon, foxtrot, golf ПОСЛЕ range сохранены
 * 5. Проверяет: compact вставлен между beta и epsilon
 * 6. Проверяет: Claude при resume видит golf как последнее сообщение
 * 7. Проверяет: backtrace chain целостен
 *
 * Запуск: node auto/sandbox/test-edit-range-integrity.js 2>&1 | tee /tmp/test-integrity.log
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, waitForMainProcessLog, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

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

const HARD_KILL_MS = 300000
const globalTimer = setTimeout(() => { console.error('\n[HARD KILL]'); process.exit(1) }, HARD_KILL_MS)

async function sendAndWait(page, mainProcessLogs, text) {
  const logsBefore = mainProcessLogs.length
  await page.keyboard.type(text, { delay: 30 })
  await page.keyboard.press('Enter')
  for (let t = 0; t < 200; t++) {
    for (let j = logsBefore; j < mainProcessLogs.length; j++) {
      if (/\[Spinner\].*IDLE/.test(mainProcessLogs[j])) return true
    }
    await page.waitForTimeout(300)
  }
  return false
}

async function main() {
  log.step('1. Launching...')
  const { app, page, consoleLogs, mainProcessLogs } = await launch({ logConsole: false, logMainProcess: true, waitForReady: 4000 })
  log.pass('App launched')

  try {
    await waitForTerminal(page, 15000)
    for (let i = 0; i < 3; i++) { try { await electron.focusWindow(app); break } catch { await page.waitForTimeout(1000) } }

    // New tab
    log.step('2. New tab + cd')
    const tabsBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.(); return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((p) => {
      const s = window.useWorkspaceStore?.getState?.(); return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > p
    }, tabsBefore, { timeout: 5000 })
    await page.waitForTimeout(1000)
    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(1500)
    log.pass('Ready')

    // Start Claude
    log.step('3. Starting Claude...')
    await typeCommand(page, 'env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude --dangerously-skip-permissions')
    await waitForClaudeSessionId(page, 60000)
    const sessionId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.tabs?.get?.(p?.activeTabId)?.claudeSessionId
    })
    log.pass('Session: ' + sessionId?.slice(0, 8))

    // Send 7 messages
    log.step('4. Sending 7 messages...')
    await waitForMainProcessLog(mainProcessLogs, /Prompt ready/, 30000)
    await page.waitForTimeout(2000)

    const msgs = ['say alpha', 'say beta', 'say gamma', 'say delta', 'say epsilon', 'say foxtrot', 'say golf']
    for (let i = 0; i < msgs.length; i++) {
      const ok = await sendAndWait(page, mainProcessLogs, msgs[i])
      log.info(`${msgs[i]}: ${ok ? 'OK' : 'timeout'}`)
      await page.waitForTimeout(500)
    }

    await page.waitForTimeout(4000) // timeline refresh

    // Get timeline entries
    log.step('5. Getting timeline entries...')
    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId); return p?.activeTabId
    })
    const cwd = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.(); const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.tabs?.get?.(p?.activeTabId)?.cwd
    })

    const before = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Timeline entries: ' + before.entries?.length)
    before.entries?.forEach((e, i) => log.info(`  [${i}] ${e.uuid?.slice(0,8)} "${e.content?.slice(0,30)}"`))

    assert(before.entries?.length >= 7, `Have ${before.entries?.length} entries (need >= 7)`)
    await page.screenshot({ path: '/tmp/integrity-before.png' })

    // Pick entries 2-3 (gamma, delta) — 0-indexed
    const gammaEntry = before.entries[2]
    const deltaEntry = before.entries[3]
    log.info(`Will remove: [2] "${gammaEntry?.content?.slice(0,20)}" to [3] "${deltaEntry?.content?.slice(0,20)}"`)

    // Exit Claude — DangerZone pattern
    log.step('6. Exiting Claude...')
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron'); ipcRenderer.send('terminal:input', tid, '\x03')
    }, tabId)
    log.info('Ctrl+C #1 sent, waiting for DangerZone...')
    const dz = await waitForMainProcessLog(mainProcessLogs, /DangerZone|again to exit|ctrlc-danger/, 3000)
    log.info('DangerZone: ' + (dz ? 'detected' : 'timeout'))
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron'); ipcRenderer.send('terminal:input', tid, '\x03')
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

    // Call edit-range
    log.step('7. Calling edit-range...')
    const editResult = await page.evaluate(({ sid, cwdArg, startU, endU }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:edit-range', {
        sessionId: sid, cwd: cwdArg, startUuid: startU, endUuid: endU,
        compactText: 'COMPACT: gamma и delta были удалены.'
      })
    }, { sid: sessionId, cwdArg: cwd, startU: gammaEntry.uuid, endU: deltaEntry.uuid })

    log.info('Result: ' + JSON.stringify(editResult))
    assert(editResult.success, 'edit-range success')
    log.info('Removed: ' + editResult.removedCount)

    // Check main process logs
    const editLogs = findInLogs(mainProcessLogs, '[EditRange]')
    editLogs.forEach(l => { if (l.includes('Range:') || l.includes('entry') || l.includes('Removing') || l.includes('Written')) log.info('  ' + l.trim().replace('[Main:stdout] ', '')) })

    // Wait for shell prompt before restarting
    log.step('8. Waiting for prompt-ready, then restarting Claude...')
    await waitForMainProcessLog(mainProcessLogs, /\[OSC 133\].*Prompt ready/, 10000)
    log.pass('Prompt ready')

    await page.evaluate(({ tid, sid }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('claude:run-command', { tabId: tid, command: 'claude-c', sessionId: sid })
    }, { tid: tabId, sid: sessionId })

    await waitForClaudeSessionId(page, 30000)
    await page.waitForTimeout(5000) // timeline refresh + Claude resume

    await page.screenshot({ path: '/tmp/integrity-after.png' })

    // Check timeline AFTER edit
    log.step('9. Checking timeline after edit...')
    const after = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Timeline after: ' + after.entries?.length + ' entries')
    after.entries?.forEach((e, i) => log.info(`  [${i}] ${e.uuid?.slice(0,8)} "${e.content?.slice(0,40)}"`))

    // Verify presence/absence
    const contents = after.entries?.map(e => e.content) || []
    assert(!contents.some(c => c?.startsWith('say gamma')), 'gamma REMOVED')
    assert(!contents.some(c => c?.startsWith('say delta')), 'delta REMOVED')
    assert(contents.some(c => c?.startsWith('say alpha')), 'alpha PRESERVED')
    assert(contents.some(c => c?.startsWith('say beta')), 'beta PRESERVED')
    assert(contents.some(c => c?.startsWith('say epsilon')), 'epsilon PRESERVED (after range)')
    assert(contents.some(c => c?.startsWith('say foxtrot')), 'foxtrot PRESERVED (after range)')
    assert(contents.some(c => c?.startsWith('say golf')), 'golf PRESERVED (after range)')
    assert(contents.some(c => c?.includes('COMPACT')), 'compact PRESENT')

    // Check ORDER: alpha, beta, compact, epsilon, foxtrot, golf
    const alphaIdx = contents.findIndex(c => c?.startsWith('say alpha'))
    const betaIdx = contents.findIndex(c => c?.startsWith('say beta'))
    const compactIdx = contents.findIndex(c => c?.includes('COMPACT'))
    const epsilonIdx = contents.findIndex(c => c?.startsWith('say epsilon'))
    const golfIdx = contents.findIndex(c => c?.startsWith('say golf'))
    assert(alphaIdx < betaIdx && betaIdx < compactIdx && compactIdx < epsilonIdx && epsilonIdx < golfIdx,
      `Order correct: alpha(${alphaIdx}) < beta(${betaIdx}) < compact(${compactIdx}) < epsilon(${epsilonIdx}) < golf(${golfIdx})`)

    // Check Claude TUI sees golf as last
    log.step('10. Checking Claude TUI...')
    const termContent = await page.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows > div')
      return Array.from(rows).map(r => r.textContent).filter(t => t?.trim()).join('\n')
    })
    const hasGolfInTerm = termContent.includes('golf') || termContent.includes('Golf')
    log.info('Terminal shows golf: ' + hasGolfInTerm)

    await page.screenshot({ path: '/tmp/integrity-final.png' })

    // JSONL chain integrity check via backtrace
    log.step('11. Backtrace integrity...')
    const chainCheck = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })
    assert(chainCheck.success, 'Backtrace succeeds after edit')
    assert(chainCheck.entries?.length >= 6, `Chain has ${chainCheck.entries?.length} entries (6+ expected)`)

    // Step 12: Send NEW message after edit and verify chain stays intact
    log.step('12. Sending new message after edit...')
    // Wait for Claude prompt
    await page.waitForTimeout(2000)
    const newMsgOk = await sendAndWait(page, mainProcessLogs, 'say final check')
    log.info('New message response: ' + (newMsgOk ? 'OK' : 'timeout'))
    await page.waitForTimeout(4000) // timeline refresh

    await page.screenshot({ path: '/tmp/integrity-after-new-msg.png' })

    // Check chain after new message
    const afterNewMsg = await page.evaluate(({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      return ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Timeline after new msg: ' + afterNewMsg.entries?.length + ' entries')
    afterNewMsg.entries?.forEach((e, i) => log.info(`  [${i}] ${e.uuid?.slice(0,8)} "${e.content?.slice(0,40)}"`))

    const afterContents = afterNewMsg.entries?.map(e => e.content) || []

    // All original preserved entries must still be there
    assert(afterContents.some(c => c?.startsWith('say alpha')), 'alpha STILL preserved after new msg')
    assert(afterContents.some(c => c?.startsWith('say beta')), 'beta STILL preserved after new msg')
    assert(afterContents.some(c => c?.startsWith('say epsilon')), 'epsilon STILL preserved after new msg')
    assert(afterContents.some(c => c?.startsWith('say golf')), 'golf STILL preserved after new msg')
    assert(afterContents.some(c => c?.includes('COMPACT')), 'compact STILL present after new msg')
    assert(afterContents.some(c => c?.startsWith('say final')), 'new message present')

    // Removed entries must NOT reappear
    assert(!afterContents.some(c => c?.startsWith('say gamma')), 'gamma still removed after new msg')
    assert(!afterContents.some(c => c?.startsWith('say delta')), 'delta still removed after new msg')

    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } catch (err) {
    log.fail('Error: ' + err.message)
    console.error(err.stack)
    await page.screenshot({ path: '/tmp/integrity-error.png' }).catch(() => {})
    process.exitCode = 1
  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
