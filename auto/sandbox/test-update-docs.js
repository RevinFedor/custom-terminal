/**
 * Test: Update Docs — Gemini spawn + paste + session capture
 *
 * Проверяет:
 * 1. gemini:spawn-with-watcher пишет 'gemini\r' в PTY + устанавливает watcher
 * 2. Gemini CLI стартует (ловим status bar / prompt)
 * 3. terminal:paste вставляет промпт в Gemini CLI
 * 4. Gemini session ID захватывается Sniper watcher
 *
 * Запуск: node auto/sandbox/test-update-docs.js
 */

const { launch, waitForTerminal, typeCommand, waitForGeminiSessionId, findInLogs } = require('../core/launcher')
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
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  log: (msg) => console.log(`${c.dim}[LOG]${c.reset} ${msg}`)
}

async function main() {
  log.step('Запуск Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  log.pass('Приложение запущено')

  try {
    // 1. Wait for terminal
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    log.pass('Терминал активен')

    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // 2. Create new tab and cd to project dir
    log.step('Создаём новый таб (Cmd+T)...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    const targetDir = '/Users/fedor/Desktop/custom-terminal'
    log.step(`cd ${targetDir}`)
    await typeCommand(page, `cd ${targetDir}`)
    await page.waitForTimeout(2000)

    // Get tab info
    const tabInfo = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return { tabId: proj?.activeTabId, cwd: tab?.cwd }
    })
    log.info(`Tab: ${tabInfo.tabId}, CWD: ${tabInfo.cwd}`)

    // 3. Send gemini:spawn-with-watcher (writes 'gemini\r' + sets up watcher)
    log.step('Отправляем gemini:spawn-with-watcher (пишет gemini\\r + watcher)...')
    await page.evaluate(({ tabId, cwd }) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('gemini:spawn-with-watcher', { tabId, cwd })
    }, { tabId: tabInfo.tabId, cwd: tabInfo.cwd || targetDir })

    // 4. Wait for Gemini to be ready — capture ALL output for diagnosis
    log.step('Ожидание Gemini (сбор полного буфера 45с)...')
    const geminiResult = await page.evaluate(async (tabId) => {
      return new Promise((resolve) => {
        const { ipcRenderer } = window.require('electron')
        // Multiple patterns that indicate Gemini is ready
        const readyPatterns = [
          'type your message',
          'how can i help',
          '│',  // TUI box border
          '✦',  // Gemini prompt marker
          '>'   // Simple prompt
        ]
        const timeout = setTimeout(() => {
          ipcRenderer.removeListener('terminal:data', handler)
          resolve({ ready: false, buffer: cleanBuf.slice(-1000), rawLen: buffer.length })
        }, 45000)

        let buffer = ''
        let cleanBuf = ''
        let foundPattern = null
        const handler = (_event, { tabId: dataTabId, data }) => {
          if (dataTabId !== tabId) return
          buffer += data
          // Strip ANSI codes
          cleanBuf = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\].*?\x07/g, '').replace(/\x1b\[[\?0-9;]*[a-zA-Z]/g, '')

          for (const p of readyPatterns) {
            if (cleanBuf.toLowerCase().includes(p.toLowerCase())) {
              foundPattern = p
              // Don't resolve immediately for '│' — wait 2s more for full init
              if (p === '│' || p === '>' || p === '✦') {
                setTimeout(() => {
                  if (foundPattern) {
                    clearTimeout(timeout)
                    ipcRenderer.removeListener('terminal:data', handler)
                    resolve({ ready: true, pattern: foundPattern, buffer: cleanBuf.slice(-500), rawLen: buffer.length })
                  }
                }, 3000)
                return
              }
              clearTimeout(timeout)
              ipcRenderer.removeListener('terminal:data', handler)
              resolve({ ready: true, pattern: foundPattern, buffer: cleanBuf.slice(-500), rawLen: buffer.length })
              return
            }
          }
        }
        ipcRenderer.on('terminal:data', handler)
      })
    }, tabInfo.tabId)

    if (geminiResult.ready) {
      log.pass(`Gemini готов! Паттерн: "${geminiResult.pattern}" (rawLen: ${geminiResult.rawLen})`)
    } else {
      log.fail(`Gemini не готов (таймаут). Буфер ${geminiResult.rawLen} chars`)
    }

    // Always show last part of buffer
    console.log('\n--- Gemini Buffer (last 500 chars, cleaned) ---')
    console.log(geminiResult.buffer)
    console.log('--- End ---\n')

    if (!geminiResult.ready) {
      // Dump main process logs for debugging
      console.log('--- Main Process Logs (last 30) ---')
      mainProcessLogs.slice(-30).forEach(l => console.log(l))
      return
    }

    // 5. Extra wait for stability
    await page.waitForTimeout(1000)

    // 6. Paste content via terminal:paste
    const testPrompt = 'Hello Gemini, this is a test from Update Docs automation. Please respond with OK.'
    log.step(`Вставляем промпт (${testPrompt.length} chars) через terminal:paste...`)

    const pasteResult = await page.evaluate(async ({ tabId, content }) => {
      const { ipcRenderer } = window.require('electron')
      return await ipcRenderer.invoke('terminal:paste', {
        tabId,
        content,
        submit: true
      })
    }, { tabId: tabInfo.tabId, content: testPrompt })

    log.info(`Paste result: ${JSON.stringify(pasteResult)}`)
    if (pasteResult?.success !== false) {
      log.pass('Промпт вставлен!')
    } else {
      log.fail(`Paste failed: ${pasteResult?.error}`)
    }

    // 7. Wait for Gemini session ID (Sniper catches session file after first message)
    log.step('Ожидание Gemini Session ID (Sniper watcher, 30с)...')
    try {
      await waitForGeminiSessionId(page, 30000)
      log.pass('Gemini Session ID захвачен!')
    } catch (e) {
      log.warn('Таймаут — Session ID не появился')
    }

    // 8. Wait for response
    log.step('Ожидание ответа Gemini (15с)...')
    await page.waitForTimeout(15000)

    // 9. Final state
    const finalState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return {
        geminiSessionId: tab?.geminiSessionId,
        commandType: tab?.commandType,
      }
    })

    // ===== RESULTS =====
    console.log('\n═══════════════════════════════════════')

    if (geminiResult.ready) log.pass('CHECK 1: Gemini started')
    else log.fail('CHECK 1: Gemini did NOT start')

    if (pasteResult?.success !== false) log.pass('CHECK 2: Paste delivered')
    else log.fail('CHECK 2: Paste failed')

    if (finalState.geminiSessionId) log.pass(`CHECK 3: Session ID: ${finalState.geminiSessionId}`)
    else log.warn('CHECK 3: Session ID not captured')

    const allPassed = geminiResult.ready && pasteResult?.success !== false
    if (allPassed && finalState.geminiSessionId) {
      log.pass('ТЕСТ ПРОЙДЕН: Full Update Docs flow работает!')
    } else if (allPassed) {
      log.pass('ТЕСТ ЧАСТИЧНО ПРОЙДЕН: Gemini + Paste OK, Session ID pending')
    } else {
      log.fail('ТЕСТ НЕ ПРОЙДЕН')
    }

    console.log('═══════════════════════════════════════')

    // Sniper logs
    console.log('\n--- Sniper Logs ---')
    mainProcessLogs
      .filter(l => l.includes('Sniper') || l.includes('session-detected'))
      .forEach(l => log.log(l))
    console.log('--- End ---\n')

  } finally {
    log.step('Закрытие приложения...')
    await app.close()
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
