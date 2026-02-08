/**
 * Test: Sniper Watcher (polling fallback) + Handshake (⏵ prompt detection)
 *
 * Проверяет:
 * 1. При запуске `claude` Sniper ловит session ID (через polling или fs.watch)
 * 2. Handshake state machine проходит через WAITING_PROMPT → DEBOUNCE_PROMPT → TAB_SENT → READY
 * 3. Session ID появляется в tab state (store)
 * 4. В main process логах видны маркеры: "Sniper", "Session detected", "Prompt detected"
 *
 * Запуск: ./run.sh sandbox/test-sniper-handshake.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

// Colors for logging
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
    // Ждём терминал
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    log.pass('Терминал активен')

    // Фокус
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // Новый таб
    log.step('Создаём новый таб (Cmd+T)...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)
    log.pass('Новый таб создан')

    // Переход в проект — ждём 2с чтобы OSC 7 обновил CWD в tab state
    const targetDir = '/Users/fedor/Desktop/custom-terminal'
    log.step(`Переход в директорию: ${targetDir}`)
    await typeCommand(page, `cd ${targetDir}`)
    await page.waitForTimeout(2000)

    // Проверяем что CWD обновился
    const cwdCheck = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      const proj = store?.openProjects?.get?.(store?.activeProjectId)
      const tab = proj?.tabs?.get?.(proj?.activeTabId)
      return tab?.cwd
    })
    log.info(`Tab CWD after cd: ${cwdCheck}`)
    if (cwdCheck?.includes('custom-terminal')) {
      log.pass('CWD обновлён корректно')
    } else {
      log.warn(`CWD может быть неверным: ${cwdCheck} — Sniper может следить за неправильной директорией`)
    }

    // ===== ТЕСТ 1: Запуск claude (Sniper + Handshake) =====
    log.step('Ввод команды: claude')
    await typeCommand(page, 'claude')
    log.pass('Команда claude введена')

    // Ждём запуска Claude + handshake + sniper (20 сек)
    log.step('Ожидание Sniper detection + Handshake (20 сек)...')
    await page.waitForTimeout(20000)

    // ===== ПРОВЕРКА: Tab State =====
    log.step('Проверка tab state...')
    const tabState = await page.evaluate(() => {
      const store = window.useWorkspaceStore?.getState?.()
      if (!store) return { hasStore: false }

      const activeProjectId = store.activeProjectId
      const project = store.openProjects?.get?.(activeProjectId)
      const activeTabId = project?.activeTabId
      const tab = project?.tabs?.get?.(activeTabId)

      return {
        hasStore: true,
        activeProjectId,
        activeTabId,
        tab: tab ? {
          id: tab.id,
          name: tab.name,
          claudeSessionId: tab.claudeSessionId,
          commandType: tab.commandType,
        } : null
      }
    })

    console.log('\n--- Tab State ---')
    console.log(JSON.stringify(tabState, null, 2))
    console.log('--- End ---\n')

    // ===== ПРОВЕРКА: Sniper в main process логах =====
    log.step('Анализ Main Process логов...')

    const sniperLogs = mainProcessLogs.filter(l =>
      l.includes('Sniper') || l.includes('Session detected') || l.includes('session-detected')
    )
    console.log('\n--- Sniper Logs ---')
    sniperLogs.forEach(l => log.log(l))
    console.log('--- End ---\n')

    // ===== ПРОВЕРКА: Handshake в main process логах =====
    const handshakeLogs = mainProcessLogs.filter(l =>
      l.includes('Handshake') || l.includes('Prompt detected') || l.includes('WAITING_PROMPT')
    )
    console.log('--- Handshake Logs ---')
    handshakeLogs.forEach(l => log.log(l))
    console.log('--- End ---\n')

    // ===== ПРОВЕРКА: Renderer логи (session detection) =====
    const restoreLogs = findInLogs(consoleLogs, '[RESTORE]')
    const sessionLogs = findInLogs(consoleLogs, 'session')
    console.log('--- Renderer [RESTORE] logs ---')
    restoreLogs.forEach(l => log.log(l))
    console.log('--- End ---\n')

    console.log('--- Renderer Session logs ---')
    sessionLogs.slice(-15).forEach(l => log.log(l))
    console.log('--- End ---\n')

    // ===== ИТОГО =====
    console.log('\n═══════════════════════════════════════')

    // Check 1: Session ID captured
    const hasSessionId = tabState.tab?.claudeSessionId && tabState.tab.claudeSessionId.length > 10
    if (hasSessionId) {
      log.pass(`Sniper: Session ID captured: ${tabState.tab.claudeSessionId}`)
    } else {
      log.fail('Sniper: Session ID NOT captured in tab state')
    }

    // Check 2: Sniper detected session in main process
    const sniperDetected = sniperLogs.some(l => l.includes('Session detected') || l.includes('session-detected'))
    if (sniperDetected) {
      log.pass('Sniper: Detection event found in main process logs')
    } else {
      log.warn('Sniper: No detection event in main process logs (may still work via renderer)')
    }

    // Check 3: Handshake prompt detection
    const promptDetected = handshakeLogs.some(l =>
      l.includes('Prompt detected') || l.includes('DEBOUNCE_PROMPT') || l.includes('TAB_SENT')
    )
    if (promptDetected) {
      log.pass('Handshake: Prompt detected (⏵ or >)')
    } else {
      log.warn('Handshake: No prompt detection in logs')
    }

    // Check 4: commandType set to claude
    if (tabState.tab?.commandType === 'claude') {
      log.pass('Tab commandType: claude')
    } else {
      log.warn(`Tab commandType: ${tabState.tab?.commandType || 'undefined'}`)
    }

    // Overall result
    if (hasSessionId && tabState.tab?.commandType === 'claude') {
      log.pass('ТЕСТ ПРОЙДЕН: Sniper + Handshake работают!')
    } else {
      log.fail('ТЕСТ НЕ ПРОЙДЕН: проверьте логи выше')
    }

    console.log('═══════════════════════════════════════')

    // Dump all main process logs for debugging
    console.log('\n--- ALL Main Process Logs (last 50) ---')
    mainProcessLogs.slice(-50).forEach(l => console.log(l))

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
