/**
 * Test: Ctrl-C Danger Zone — Event-Driven Detection & Protection
 *
 * Проверяет:
 * 1. При Ctrl+C → main ловит "Press Ctrl-C again to exit" (ON)
 * 2. Когда Claude возвращает промпт (⏵) → danger zone снимается (OFF) — event-driven
 * 3. При /model в danger zone → команда ЖДЁТ промпта, потом выполняется
 * 4. Claude НЕ выходит
 *
 * Запуск: ./run.sh sandbox/test-ctrlc-danger-zone.js
 */

const { launch, waitForTerminal, typeCommand, waitForClaudeSessionId } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m'
}
const log = {
  step: (m) => console.log(`${c.cyan}[STEP]${c.reset} ${m}`),
  info: (m) => console.log(`${c.dim}[INFO]${c.reset} ${m}`),
  pass: (m) => console.log(`${c.green}[PASS]${c.reset} ${m}`),
  fail: (m) => console.log(`${c.red}[FAIL]${c.reset} ${m}`),
  warn: (m) => console.log(`${c.yellow}[WARN]${c.reset} ${m}`)
}

async function sendCtrlC(page, tabId) {
  await page.evaluate((tid) => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('terminal:input', tid, '\x03')
  }, tabId)
}

async function main() {
  log.step('Запуск Noted Terminal...')
  const { app, page, mainProcessLogs } = await launch({
    logConsole: false, logMainProcess: true, waitForReady: 4000
  })
  log.pass('Приложение запущено')

  try {
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    log.step('Новый таб...')
    await page.keyboard.press('Meta+t')
    await page.waitForTimeout(1500)

    await typeCommand(page, 'cd /Users/fedor/Desktop/custom-terminal')
    await page.waitForTimeout(2000)

    const tabId = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      return p?.activeTabId
    })
    if (!tabId) { log.fail('Нет activeTabId'); return }
    log.info('Tab: ' + tabId)

    log.step('claude...')
    await typeCommand(page, 'claude')
    try { await waitForClaudeSessionId(page, 30000); log.pass('Session ID OK') }
    catch { log.warn('Session ID timeout') }

    log.step('Ожидание готовности (3с)...')
    await page.waitForTimeout(3000)

    // ═══════════════════════════════════════
    // TEST 1: Detection ON/OFF cycle
    // ═══════════════════════════════════════
    log.step('TEST 1: Ctrl+C → ON → prompt → OFF')
    await sendCtrlC(page, tabId)
    await page.waitForTimeout(3000)

    const onLogs = mainProcessLogs.filter(l => l.includes('DangerZone') && l.includes(': ON'))
    const offLogs = mainProcessLogs.filter(l => l.includes('DangerZone') && l.includes(': OFF'))

    const hasON = onLogs.length > 0
    const hasOFF = offLogs.length > 0
    const isEventDriven = offLogs.some(l => l.includes('event-driven'))

    if (hasON) log.pass('ON: маркер "Ctrl-C again" пойман')
    else log.fail('ON: маркер НЕ пойман')

    if (hasOFF && isEventDriven) log.pass('OFF: промпт вернулся (event-driven)')
    else if (hasOFF) log.warn('OFF: сработало, но не event-driven')
    else log.fail('OFF: danger zone не снялся')

    // ═══════════════════════════════════════
    // TEST 2: /model в danger zone
    // ═══════════════════════════════════════
    log.step('TEST 2: Ctrl+C → /model opus (в danger zone)')
    await sendCtrlC(page, tabId)
    await page.waitForTimeout(500) // дать PTY выдать маркер

    await page.evaluate((tid) => {
      const { ipcRenderer } = window.require('electron')
      ipcRenderer.send('claude:send-command', tid, '/model opus')
    }, tabId)

    await page.waitForTimeout(5000)

    const waitingLogs = mainProcessLogs.filter(l => l.includes('waiting for prompt to return'))
    const promptReturnedLogs = mainProcessLogs.filter(l => l.includes('Prompt returned, proceeding'))

    if (waitingLogs.length > 0) log.pass('WAIT: команда ждала промпта')
    else log.fail('WAIT: команда НЕ ждала')

    if (promptReturnedLogs.length > 0) log.pass('PROCEED: команда выполнена после возврата промпта')
    else log.warn('PROCEED: лог не найден')

    // Session alive?
    await page.waitForTimeout(2000)
    const state = await page.evaluate(() => {
      const s = window.useWorkspaceStore?.getState?.()
      const p = s?.openProjects?.get?.(s?.activeProjectId)
      const t = p?.tabs?.get?.(p?.activeTabId)
      return { session: t?.claudeSessionId, cmd: t?.commandType }
    })
    const alive = !!(state.cmd === 'claude' || state.session)
    if (alive) log.pass('SESSION: Claude жива')
    else log.fail('SESSION: Claude вышла (' + state.cmd + ')')

    // ═══════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════
    console.log('\n' + c.bold + '═══════════════════════════════════════' + c.reset)
    const checks = [
      [hasON, 'Детекция ON'],
      [hasOFF && isEventDriven, 'Сброс OFF (event-driven)'],
      [waitingLogs.length > 0, 'Delay: ожидание промпта'],
      [alive, 'Сессия жива']
    ]
    checks.forEach(([ok, label]) => {
      console.log(`  [${ok ? c.green + 'PASS' : c.red + 'FAIL'}${c.reset}] ${label}`)
    })
    const allPass = checks.every(([ok]) => ok)
    console.log(allPass
      ? `\n${c.green}${c.bold}ВСЕ ТЕСТЫ ПРОЙДЕНЫ${c.reset}`
      : `\n${c.red}${c.bold}ЕСТЬ ОШИБКИ${c.reset}`)
    console.log(c.bold + '═══════════════════════════════════════' + c.reset)

    // Debug: all DangerZone logs
    console.log('\n--- DangerZone Logs ---')
    mainProcessLogs.filter(l => l.includes('DangerZone') || l.includes('send-command')).forEach(l => console.log('  ' + l.trim()))
    console.log('---')

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
