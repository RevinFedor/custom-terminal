/**
 * Diagnostic: Plan Mode → Clear Context → Session Change
 *
 * Полностью автоматический. Читает .xterm-rows на каждом шаге.
 * Запуск: node auto/sandbox/test-plan-mode-detect.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m',
  bold: '\x1b[1m', magenta: '\x1b[35m'
}
const log = {
  step: (msg) => console.log(`\n${c.cyan}[STEP]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  term: (lines) => {
    lines.forEach(l => console.log(`  ${c.magenta}|${c.reset} ${l}`))
  }
}

// ===== HELPERS =====

async function readTermLines(page) {
  return page.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div')
    const lines = []
    rows.forEach(r => { if (r.textContent?.trim()) lines.push(r.textContent) })
    return lines
  })
}

async function dumpTerm(page, label, n = 12) {
  const lines = await readTermLines(page)
  const show = lines.slice(-n)
  console.log(`${c.dim}--- ${label} (${lines.length} total, last ${n}) ---${c.reset}`)
  log.term(show)
  return lines
}

async function getTabState(page) {
  return page.evaluate(() => {
    const s = window.useWorkspaceStore?.getState?.()
    if (!s) return null
    const p = s.openProjects?.get?.(s.activeProjectId)
    const t = p?.tabs?.get?.(p?.activeTabId)
    return t ? { id: t.id, claudeSessionId: t.claudeSessionId, commandType: t.commandType } : null
  })
}

async function sendToTerminal(page, text) {
  await page.evaluate((t) => {
    const { ipcRenderer } = window.require('electron')
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    if (p?.activeTabId) ipcRenderer.send('terminal:input', p.activeTabId, t)
  }, text)
}

async function waitForText(page, patterns, timeoutMs = 60000, pollMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const lines = await readTermLines(page)
    const text = lines.join('\n')
    for (const p of patterns) {
      if (text.includes(p)) return { found: p, lines }
    }
    await page.waitForTimeout(pollMs)
  }
  return { found: null, lines: await readTermLines(page) }
}

// ===== MAIN =====

async function main() {
  log.step('Запуск приложения...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 8000
  })
  log.pass('OK')

  try {
    await electron.focusWindow(app)

    // Терминал должен быть видим после 8с инициализации
    log.step('Проверка терминала...')
    await waitForTerminal(page, 10000)
    log.pass('Терминал найден')
    await dumpTerm(page, 'Initial')

    // Новый таб + cd
    log.step('Cmd+T → новый таб')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(2000)
    await dumpTerm(page, 'New tab')

    log.step('cd /Users/fedor/Desktop/custom-terminal')
    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2500)
    await dumpTerm(page, 'After cd')

    // Запуск claude
    log.step('Ввод: claude')
    await typeCommand(page, 'claude')

    log.step('Ждём Session ID (Sniper/Bridge)...')
    try {
      await waitForClaudeSessionId(page, 60000)
    } catch {
      log.fail('Session ID не пойман за 60с')
      await dumpTerm(page, 'Timeout')
      return
    }

    const state0 = await getTabState(page)
    const oldSessionId = state0?.claudeSessionId
    log.pass(`OLD Session ID: ${oldSessionId}`)
    await dumpTerm(page, 'Claude ready')

    // Сначала обычное сообщение — чтобы JSONL файл гарантированно создался
    log.step('Отправляем обычное сообщение (для создания JSONL)...')
    await page.evaluate((cmd) => {
      const { ipcRenderer } = window.require('electron')
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (p?.activeTabId) ipcRenderer.send('claude:send-command', p.activeTabId, cmd)
    }, 'Say only "OK" and nothing else.')

    log.info('Обычный промпт отправлен, ждём ответ...')
    // Ждём пока Claude ответит (ищем промпт ❯ снова)
    await page.waitForTimeout(5000)
    await waitForText(page, ['OK', '❯'], 30000, 2000)
    await page.waitForTimeout(3000)
    await dumpTerm(page, 'After initial message')

    // Теперь отправляем промпт для plan mode
    log.step('Отправляем промпт (plan mode + clear context)...')
    const prompt = 'Enter plan mode. Create a 3-line plan: step 1 read files, step 2 edit code, step 3 test. Then exit plan mode with Clear Context (option 1).'

    // Use claude:send-command IPC (goes through safePasteAndSubmit)
    await page.evaluate((cmd) => {
      const { ipcRenderer } = window.require('electron')
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      if (p?.activeTabId) ipcRenderer.send('claude:send-command', p.activeTabId, cmd)
    }, prompt)

    log.info('Промпт отправлен')
    await page.waitForTimeout(5000)
    await dumpTerm(page, '5с после промпта', 20)

    // Поллинг: читаем терминал + sessionId
    log.step('Начинаем поллинг (терминал + sessionId) каждые 3с, макс 3 мин...')
    const pollStart = Date.now()
    const MAX_WAIT = 180000
    let newSessionId = null
    let iter = 0

    while (Date.now() - pollStart < MAX_WAIT) {
      await page.waitForTimeout(3000)
      iter++

      const lines = await readTermLines(page)
      const last5 = lines.slice(-5).join(' | ')
      const state = await getTabState(page)
      const currentId = state?.claudeSessionId
      const sec = Math.round((Date.now() - pollStart) / 1000)

      // Session changed?
      if (currentId && currentId !== oldSessionId) {
        newSessionId = currentId
        log.pass(`SESSION CHANGED @ ${sec}с: ${oldSessionId?.substring(0, 8)} → ${currentId.substring(0, 8)}`)
        await dumpTerm(page, 'At session change', 20)
        break
      }

      // Логируем каждые ~6с
      if (iter % 2 === 0) {
        log.info(`${sec}с | sid=${currentId?.substring(0, 8) || 'null'} | ${last5.substring(0, 120)}`)
      }

      // Дамп терминала каждые ~15с
      if (iter % 5 === 0) {
        await dumpTerm(page, `Poll @ ${sec}с`, 15)
      }

      // Автоматические действия по содержимому терминала
      const fullText = lines.join('\n')

      if (fullText.includes('Do you want') || fullText.includes('approve') || fullText.includes('Yes, and') || fullText.includes('Start implementing')) {
        log.warn('Вижу вопрос → Enter')
        await sendToTerminal(page, '\r')
        await page.waitForTimeout(2000)
        await dumpTerm(page, 'After auto-Enter', 15)
      }

      if (fullText.includes('Clear context') || fullText.includes('clear context') || fullText.includes('Start a new')) {
        log.warn('Вижу Clear Context → Enter')
        await sendToTerminal(page, '\r')
        await page.waitForTimeout(3000)
        await dumpTerm(page, 'After Clear Context', 15)
      }
    }

    // ===== РЕЗУЛЬТАТЫ =====
    console.log('\n' + '═'.repeat(60))
    console.log(`${c.bold}РЕЗУЛЬТАТЫ${c.reset}`)
    console.log('═'.repeat(60))
    console.log(`  OLD: ${oldSessionId}`)
    console.log(`  NEW: ${newSessionId || 'NOT DETECTED'}`)

    if (newSessionId) {
      // Проверяем JSONL bridge
      const claudeDir = path.join(os.homedir(), '.claude', 'projects')
      try {
        for (const slug of fs.readdirSync(claudeDir)) {
          const fp = path.join(claudeDir, slug, newSessionId + '.jsonl')
          if (fs.existsSync(fp)) {
            const firstLine = fs.readFileSync(fp, 'utf-8').split('\n')[0]
            const entry = JSON.parse(firstLine)
            console.log(`\n  JSONL 1st entry:`)
            console.log(`    sessionId:  ${entry.sessionId}`)
            console.log(`    parentUuid: ${entry.parentUuid}`)
            console.log(`    type:       ${entry.type}`)
            if (entry.sessionId && entry.sessionId !== newSessionId) {
              log.pass('JSONL BRIDGE FOUND → ' + entry.sessionId.substring(0, 8))
            } else {
              log.warn('NO JSONL BRIDGE (sessionId = filename)')
            }
            break
          }
        }
      } catch (e) { log.warn('JSONL check error: ' + e.message) }
    }

    // Bridge logs
    const bridgeLogs = mainProcessLogs.filter(l =>
      l.includes('[Bridge]') && (l.includes('session:') || l.includes('Session transition'))
    )
    console.log('\n  Bridge session logs:')
    bridgeLogs.forEach(l => console.log(`    ${l.trim().substring(0, 150)}`))

    if (bridgeLogs.some(l => l.includes('Session transition'))) {
      log.pass('Bridge transition detected')
    }

    // Chain + findSessionFile logs
    const chainLogs = mainProcessLogs.filter(l =>
      l.includes('[SessionChain]') || l.includes('[findSessionFile]')
    )
    if (chainLogs.length) {
      console.log('\n  SessionChain + findSessionFile logs:')
      chainLogs.forEach(l => console.log(`    ${l.trim()}`))
    }

    console.log('\n' + '═'.repeat(60))
    if (newSessionId) {
      log.pass('ТЕСТ ПРОЙДЕН')
    } else {
      log.fail('ТЕСТ НЕ ПРОЙДЕН')
      await dumpTerm(page, 'Final terminal', 25)
    }
    console.log('═'.repeat(60))

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  process.exit(1)
})
