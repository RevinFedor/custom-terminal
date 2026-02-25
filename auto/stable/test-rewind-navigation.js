/**
 * Test: Rewind Diagnostic
 *
 * Тестирует фикс race condition в claude:open-history-menu:
 * Steps 1-2 теперь ждут sync marker, + drain перед Step 3
 *
 * Запуск: node auto/sandbox/test-rewind-diagnostic.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m',
  magenta: '\x1b[35m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`),
  data: (m) => console.log(`${c.magenta}[DATA]${c.reset} ${m}`)
}

async function readTerminalContent(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div')
    const lines = []
    rows.forEach(row => {
      const text = row.textContent
      if (text?.trim()) lines.push(text)
    })
    return lines.slice(-30).join('\n')
  })
}

async function callRewindIpc(page, tabId, targetIndex, targetText) {
  return page.evaluate(({ tid, ti, tt }) => {
    const { ipcRenderer } = window.require('electron')
    return ipcRenderer.invoke('claude:open-history-menu', {
      tabId: tid,
      targetIndex: ti,
      targetText: tt,
      pasteAfter: undefined
    })
  }, { tid: tabId, ti: targetIndex, tt: targetText })
}

async function sendClaudePrompt(page, tabId, text) {
  await page.evaluate(({ tid, txt }) => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('claude:send-command', tid, txt)
  }, { tid: tabId, txt: text })
}

async function main() {
  log.step('Запуск Noted Terminal...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: true, waitForReady: 5000
  })
  log.pass('Приложение запущено')

  try {
    // Wait for any terminal (longer timeout for restored tabs)
    log.step('Ожидание терминала (30с)...')
    try {
      await waitForTerminal(page, 30000)
    } catch (e) {
      log.warn('Terminal not visible, trying Meta+t for new tab...')
      await page.keyboard.press('Meta+t')
      await page.waitForTimeout(3000)
      await waitForTerminal(page, 15000)
    }
    await electron.focusWindow(app)
    await page.waitForTimeout(1000)

    // Open new tab and cd
    log.step('Новый таб + cd...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(2000)

    // Focus and wait for new terminal
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2000)

    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.activeTabId
    })
    if (!tabId) { log.fail('Нет activeTabId'); return }
    log.info('Tab: ' + tabId)

    // Launch Claude
    log.step('Запуск claude...')
    await typeCommand(page, 'claude')

    try {
      await waitForClaudeSessionId(page, 35000)
      log.pass('Session ID OK')
    } catch {
      log.warn('Session ID timeout')
    }

    log.step('Ожидание инициализации Claude (7с)...')
    await page.waitForTimeout(7000)

    // Send 3 prompts to create history
    const prompts = [
      'say exactly "ALPHA" nothing else',
      'say exactly "BRAVO" nothing else',
      'say exactly "CHARLIE" nothing else'
    ]

    for (const prompt of prompts) {
      log.step('Sending: ' + prompt)
      await sendClaudePrompt(page, tabId, prompt)
      await page.waitForTimeout(15000)
    }

    // Show terminal
    const termContent = await readTerminalContent(page)
    log.data('Terminal:')
    termContent.split('\n').slice(-8).forEach(l => console.log('  > ' + l))

    // ══════════════════════════════════════
    // REWIND TEST
    // ══════════════════════════════════════
    console.log(`\n${c.bold}═══ REWIND TEST ═══${c.reset}`)

    const logStart = mainProcessLogs.length

    // Rewind to first prompt (ALPHA) — 3 entries back
    const targetText = 'say exactly "ALPHA" nothing else'
    log.step('Rewind to: "' + targetText.substring(0, 40) + '"')

    let result
    try {
      result = await callRewindIpc(page, tabId, 0, targetText.substring(0, 40))
      log.data('Result: ' + JSON.stringify(result))

      if (result?.success) {
        log.pass('REWIND SUCCESS')
      } else {
        log.fail('REWIND FAIL: ' + (result?.error || 'unknown'))
      }
    } catch (err) {
      log.fail('REWIND ERROR: ' + err.message)
    }

    await page.waitForTimeout(2000)

    // Show all Restore logs
    console.log(`\n${c.bold}═══ [Restore:History] Logs ═══${c.reset}`)
    const logs = mainProcessLogs.slice(logStart)
    const restoreLogs = logs.filter(l => l.includes('[Restore:'))
    if (restoreLogs.length > 0) {
      restoreLogs.forEach(l => console.log('  ' + l.trim()))
    } else {
      log.warn('No [Restore:] logs. All logs from IPC call:')
      logs.slice(-20).forEach(l => console.log('  ' + l.trim()))
    }

    // Final terminal state
    const finalContent = await readTerminalContent(page)
    log.data('Final terminal:')
    finalContent.split('\n').slice(-8).forEach(l => console.log('  > ' + l))

    // Summary
    console.log(`\n${c.bold}═══ VERDICT ═══${c.reset}`)
    if (result?.success) {
      console.log(`${c.green}${c.bold}REWIND WORKS${c.reset}`)
    } else {
      console.log(`${c.red}${c.bold}REWIND BROKEN${c.reset}`)
    }

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
