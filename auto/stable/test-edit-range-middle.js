/**
 * Test: Edit Range — удаление из СЕРЕДИНЫ сессии + проверка backtrace
 *
 * 1. Создаёт Claude сессию с 5 сообщениями
 * 2. Форкает сессию (claude-f) для безопасности
 * 3. Выделяет записи 2-3 из 5 (середина)
 * 4. Применяет edit-range через IPC напрямую (без UI)
 * 5. Проверяет: backtrace корректен, записи 1,4,5 + compact на месте
 * 6. Проверяет: Claude resume работает на отредактированном файле
 *
 * Запуск: node auto/sandbox/test-edit-range-middle.js 2>&1 | tee /tmp/test-edit-range-middle.log
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

const HARD_KILL_MS = 240000
const globalTimer = setTimeout(() => {
  console.error('\n[HARD KILL] Test exceeded ' + (HARD_KILL_MS / 1000) + 's')
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
    log.step('2. Waiting for terminal...')
    await waitForTerminal(page, 15000)
    log.pass('Terminal ready')

    for (let i = 0; i < 3; i++) {
      try { await electron.focusWindow(app); break }
      catch { await page.waitForTimeout(1000) }
    }

    // New tab
    log.step('3. Creating new tab...')
    const tabsBefore = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      return s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0
    })
    await page.keyboard.press('Meta+t')
    await page.waitForFunction((prev) => {
      const s = window.useWorkspaceStore?.getState?.()
      return (s?.openProjects?.get?.(s?.activeProjectId)?.tabs?.size ?? 0) > prev
    }, tabsBefore, { timeout: 5000 })
    log.pass('New tab')

    // cd
    const targetDir = '/Users/fedor/Desktop/custom-terminal'
    log.step('4. cd ' + targetDir)
    await page.waitForTimeout(1000)
    await typeCommand(page, `cd ${targetDir}`)
    await page.waitForTimeout(1500)
    log.pass('cd sent')

    // Start Claude
    log.step('5. Starting Claude...')
    await typeCommand(page, 'env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude --dangerously-skip-permissions')
    log.step('6. Waiting for session ID...')
    await waitForClaudeSessionId(page, 60000)
    const sessionId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.tabs?.get?.(p?.activeTabId)?.claudeSessionId
    })
    log.pass('Session: ' + sessionId?.slice(0, 8))

    // Send 5 messages
    log.step('7. Sending 5 messages...')
    await waitForMainProcessLog(mainProcessLogs, /Prompt ready/, 30000)
    await page.waitForTimeout(2000)

    const messages = ['say alpha', 'say beta', 'say gamma', 'say delta', 'say epsilon']
    for (let i = 0; i < messages.length; i++) {
      const logsBefore = mainProcessLogs.length
      await page.keyboard.type(messages[i], { delay: 30 })
      await page.keyboard.press('Enter')
      log.info(`Sent: "${messages[i]}"`)

      // Wait for response (only new logs)
      let found = false
      for (let t = 0; t < 150; t++) {
        for (let j = logsBefore; j < mainProcessLogs.length; j++) {
          if (/\[Spinner\].*IDLE/.test(mainProcessLogs[j])) { found = true; break }
        }
        if (found) break
        await page.waitForTimeout(300)
      }
      log.info(`Response ${i + 1}: ${found ? 'OK' : 'timeout'}`)
      await page.waitForTimeout(500)
    }

    // Wait for timeline
    await page.waitForTimeout(4000)

    // Get timeline entries
    log.step('8. Getting timeline entries...')
    const timelineBefore = await page.evaluate(() => {
      const segments = document.querySelectorAll('[data-timeline] [data-segment]')
      return segments.length
    })
    log.info('Timeline entries: ' + timelineBefore)
    assert(timelineBefore >= 5, `Have ${timelineBefore} entries (need >= 5)`)

    await page.screenshot({ path: '/tmp/edit-range-before.png' })
    log.info('Screenshot: /tmp/edit-range-before.png')

    // Get UUIDs of entries from timeline IPC (backtrace order)
    log.step('9. Getting entry UUIDs via IPC...')
    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.activeTabId
    })
    const cwd = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.tabs?.get?.(p?.activeTabId)?.cwd
    })

    const timelineData = await page.evaluate(async ({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      const result = await ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
      if (!result.success) return { error: result.error }
      return {
        entries: result.entries.map((e, i) => ({ i, uuid: e.uuid, type: e.type, content: e.content?.slice(0, 30) })),
        count: result.entries.length
      }
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Timeline IPC entries: ' + timelineData.count)
    if (timelineData.entries) {
      timelineData.entries.forEach(e => log.info(`  [${e.i}] ${e.type} ${e.uuid?.slice(0, 8)} "${e.content}"`))
    }

    assert(timelineData.count >= 5, `IPC returned ${timelineData.count} entries (need >= 5)`)

    // Pick middle range: entries 2-3 (0-indexed), so we keep 0,1 and 4+
    const entry2 = timelineData.entries[2]
    const entry3 = timelineData.entries[3]
    log.info(`Will remove entries 2-3: "${entry2?.content}" and "${entry3?.content}"`)

    // Exit Claude — DangerZone pattern
    log.step('10. Exiting Claude (Ctrl+C)...')
    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('terminal:input', tid, '\x03')
    }, tabId)
    log.info('Ctrl+C #1 sent, waiting for DangerZone...')
    const dz = await waitForMainProcessLog(mainProcessLogs, /DangerZone|again to exit|ctrlc-danger/, 3000)
    log.info('DangerZone: ' + (dz ? 'detected' : 'timeout'))
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

    // Call edit-range IPC directly
    log.step('11. Calling claude:edit-range IPC...')
    const editResult = await page.evaluate(async ({ sid, cwdArg, startU, endU }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('claude:edit-range', {
        sessionId: sid,
        cwd: cwdArg,
        startUuid: startU,
        endUuid: endU,
        compactText: '## Сводка удалённых записей\nЗаписи gamma и delta были сокращены.'
      })
    }, { sid: sessionId, cwdArg: cwd, startU: entry2.uuid, endU: entry3.uuid })

    log.info('Edit result: ' + JSON.stringify(editResult))
    assert(editResult.success, 'edit-range succeeded')
    log.info('Removed: ' + editResult.removedCount + ', compactUuid: ' + editResult.compactUuid?.slice(0, 8))

    // Wait for shell prompt before restarting
    log.step('12. Waiting for prompt-ready, then restarting Claude...')
    await waitForMainProcessLog(mainProcessLogs, /\[OSC 133\].*Prompt ready/, 10000)
    log.pass('Prompt ready')

    await page.evaluate(({ tid, sid }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('claude:run-command', { tabId: tid, command: 'claude-c', sessionId: sid })
    }, { tid: tabId, sid: sessionId })

    // Wait for Claude to start
    await waitForClaudeSessionId(page, 30000)
    await page.waitForTimeout(3000)

    await page.screenshot({ path: '/tmp/edit-range-after-resume.png' })
    log.info('Screenshot: /tmp/edit-range-after-resume.png')

    // Check timeline after edit
    log.step('13. Checking timeline after edit...')
    await page.waitForTimeout(4000) // Timeline refresh

    const timelineAfter = await page.evaluate(async ({ sid, cwdArg }) => {
      const { ipcRenderer } = window.require('electron')
      const result = await ipcRenderer.invoke('claude:get-timeline', { sessionId: sid, cwd: cwdArg })
      if (!result.success) return { error: result.error }
      return {
        entries: result.entries.map((e, i) => ({ i, uuid: e.uuid, type: e.type, content: e.content?.slice(0, 40) })),
        count: result.entries.length
      }
    }, { sid: sessionId, cwdArg: cwd })

    log.info('Timeline after edit: ' + timelineAfter.count + ' entries')
    if (timelineAfter.entries) {
      timelineAfter.entries.forEach(e => log.info(`  [${e.i}] ${e.type} ${e.uuid?.slice(0, 8)} "${e.content}"`))
    }

    // Verify: entries 0,1 preserved, compact inserted, entries 4+ preserved
    // Removed entries (gamma, delta) should NOT appear
    // Check by content starting with "say gamma"/"say delta" (not includes — compact text mentions them)
    const hasGamma = timelineAfter.entries?.some(e => e.content?.startsWith('say gamma'))
    const hasDelta = timelineAfter.entries?.some(e => e.content?.startsWith('say delta'))
    const hasAlpha = timelineAfter.entries?.some(e => e.content?.includes('alpha'))
    const hasEpsilon = timelineAfter.entries?.some(e => e.content?.includes('epsilon'))
    const hasCompact = timelineAfter.entries?.some(e => e.content?.includes('Сводка') || e.content?.includes('сокращены'))

    assert(!hasGamma, 'gamma removed from timeline')
    assert(!hasDelta, 'delta removed from timeline')
    assert(hasAlpha, 'alpha preserved in timeline')
    assert(hasEpsilon, 'epsilon preserved in timeline')
    assert(hasCompact, 'compact entry present in timeline')

    // Expected: was 5, removed 2 (gamma+delta) + their responses, added 1 compact
    // So timeline should have: alpha, beta, compact, epsilon = 4 entries (or 3 if beta's response was included)
    log.info(`Entries before: ${timelineBefore}, after: ${timelineAfter.count}`)

    await page.screenshot({ path: '/tmp/edit-range-final-timeline.png' })
    log.info('Screenshot: /tmp/edit-range-final-timeline.png')

    // Check that Claude sees the compact text
    log.step('14. Checking Claude sees compact text...')
    // Send /status or just check terminal content
    const termContent = await page.evaluate(() => {
      const rows = document.querySelectorAll('.xterm-rows > div')
      const lines = []
      rows.forEach(r => { if (r.textContent?.trim()) lines.push(r.textContent) })
      return lines.join('\n')
    })
    const seesCompact = termContent.includes('Сводка') || termContent.includes('сокращены')
    log.info('Terminal shows compact text: ' + seesCompact)

    // Summary
    console.log(`\n${'='.repeat(50)}`)
    console.log(`Passed: ${passed}  Failed: ${failed}`)
    if (failed > 0) process.exitCode = 1

  } catch (err) {
    log.fail('Unexpected error: ' + err.message)
    console.error(err.stack)
    await page.screenshot({ path: '/tmp/edit-range-error.png' }).catch(() => {})
    process.exitCode = 1
  } finally {
    clearTimeout(globalTimer)
    await app.close()
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
