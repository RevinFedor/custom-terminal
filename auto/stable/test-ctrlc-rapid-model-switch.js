/**
 * Test: Rapid Model Switch + Ctrl-C cycle
 *
 * Воспроизводит баг: model switch → short delay → Ctrl+C → model switch → Claude exits
 * Verifies that DZ holds for 3+ seconds and send-command waits.
 *
 * Запуск: ./run.sh sandbox/test-ctrlc-rapid-model-switch.js
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

async function sendModelSwitch(page, tabId, model) {
  await page.evaluate(({ tid, cmd }) => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('claude:send-command', tid, '/model ' + cmd)
  }, { tid: tabId, cmd: model })
}

async function isClaudeAlive(page) {
  const state = await page.evaluate(() => {
    const s = window.useWorkspaceStore?.getState?.()
    const p = s?.openProjects?.get?.(s?.activeProjectId)
    const t = p?.tabs?.get?.(p?.activeTabId)
    return { session: t?.claudeSessionId, cmd: t?.commandType }
  })
  return { alive: !!(state.cmd === 'claude' || state.session), state }
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

    log.step('Ожидание готовности Claude (5с)...')
    await page.waitForTimeout(5000)

    const preState = await isClaudeAlive(page)
    if (!preState.alive) { log.fail('Claude не запустилась!'); return }
    log.pass('Claude alive, начинаем тесты')

    // ═══════════════════════════════════════════════════════════
    // CYCLE 1: /model sonnet → 1.5s → Ctrl+C → immediately /model opus
    // This is the exact user scenario: switch model, quickly Ctrl+C, switch again
    // ═══════════════════════════════════════════════════════════
    const cycles = [
      { first: 'sonnet', second: 'opus',   delayBeforeCtrlC: 1500, delayBeforeSecondSwitch: 300 },
      { first: 'opus',   second: 'sonnet', delayBeforeCtrlC: 1000, delayBeforeSecondSwitch: 500 },
      { first: 'sonnet', second: 'opus',   delayBeforeCtrlC: 500,  delayBeforeSecondSwitch: 200 },
    ]

    const results = []

    for (let i = 0; i < cycles.length; i++) {
      const { first, second, delayBeforeCtrlC, delayBeforeSecondSwitch } = cycles[i]
      const logStart = mainProcessLogs.length

      console.log(`\n${c.bold}═══ CYCLE ${i + 1}: /model ${first} → ${delayBeforeCtrlC}ms → Ctrl+C → ${delayBeforeSecondSwitch}ms → /model ${second} ═══${c.reset}`)

      // Check alive before
      const before = await isClaudeAlive(page)
      if (!before.alive) {
        log.fail(`DEAD BEFORE CYCLE ${i + 1}`)
        results.push({ cycle: i + 1, pass: false, reason: 'dead before start' })
        break
      }

      // Step 1: Model switch
      log.step(`[1] /model ${first}`)
      await sendModelSwitch(page, tabId, first)

      // Wait for model switch to complete (need enough time for safePasteAndSubmit + model output)
      await page.waitForTimeout(5000)

      const afterFirst = await isClaudeAlive(page)
      if (!afterFirst.alive) {
        log.fail(`DEAD after /model ${first}`)
        results.push({ cycle: i + 1, pass: false, reason: `died after /model ${first}` })
        break
      }
      log.pass(`Alive after /model ${first}`)

      // Step 2: Wait, then Ctrl+C
      log.info(`Wait ${delayBeforeCtrlC}ms...`)
      await page.waitForTimeout(delayBeforeCtrlC)

      log.step('[2] Ctrl+C')
      await sendCtrlC(page, tabId)

      // Step 3: Short delay, then second model switch (the dangerous part)
      log.info(`Wait ${delayBeforeSecondSwitch}ms...`)
      await page.waitForTimeout(delayBeforeSecondSwitch)

      const afterCtrlC = await isClaudeAlive(page)
      if (!afterCtrlC.alive) {
        log.fail('DEAD after Ctrl+C')
        results.push({ cycle: i + 1, pass: false, reason: 'died after Ctrl+C' })
        break
      }

      log.step(`[3] /model ${second} (DANGER: should be protected by DZ hold)`)
      await sendModelSwitch(page, tabId, second)

      // Wait for DZ to expire + model switch to complete
      // DZ hold = 3s, TTL = 4s, plus safePasteAndSubmit time
      log.info('Wait 8s for DZ + model switch...')
      await page.waitForTimeout(8000)

      // Final check
      const afterSecond = await isClaudeAlive(page)

      // Collect DZ logs
      const cycleLogs = mainProcessLogs.slice(logStart)
      const dzLogs = cycleLogs.filter(l =>
        l.includes('DangerZone') || l.includes('send-command') && (l.includes('waiting') || l.includes('Prompt returned'))
      )

      console.log(`\n--- Key Logs (Cycle ${i + 1}) ---`)
      cycleLogs.filter(l =>
        l.includes('DangerZone') || l.includes('DZ-DIAG') ||
        (l.includes('send-command') && !l.includes('Start:'))
      ).forEach(l => console.log('  ' + l.trim()))
      console.log('---')

      const hasON = dzLogs.some(l => l.includes(': ON'))
      const hasWait = cycleLogs.some(l => l.includes('waiting for prompt'))
      const hasTTL = cycleLogs.some(l => l.includes('TTL expired'))

      log.info(`DZ ON: ${hasON}, Wait: ${hasWait}, TTL: ${hasTTL}`)

      if (afterSecond.alive) {
        log.pass(`CYCLE ${i + 1}: SESSION ALIVE`)
        results.push({ cycle: i + 1, pass: true })
      } else {
        log.fail(`CYCLE ${i + 1}: SESSION DEAD`)
        results.push({ cycle: i + 1, pass: false, reason: `died after /model ${second}` })
        break
      }
    }

    // SUMMARY
    console.log(`\n${c.bold}═══════════════════════════════════════${c.reset}`)
    results.forEach(r => {
      const icon = r.pass ? `${c.green}PASS` : `${c.red}FAIL`
      console.log(`  [${icon}${c.reset}] Cycle ${r.cycle}${r.reason ? ' — ' + r.reason : ''}`)
    })
    const allPass = results.length === cycles.length && results.every(r => r.pass)
    console.log(allPass
      ? `\n${c.green}${c.bold}ВСЕ ЦИКЛЫ ПРОЙДЕНЫ${c.reset}`
      : `\n${c.red}${c.bold}ЕСТЬ ОШИБКИ${c.reset}`)
    console.log(`${c.bold}═══════════════════════════════════════${c.reset}`)

    // All DZ logs
    console.log('\n--- ALL DZ Logs ---')
    mainProcessLogs
      .filter(l => l.includes('DangerZone'))
      .forEach(l => console.log('  ' + l.trim()))
    console.log('---')

  } finally {
    log.step('Закрытие...')
    await app.close()
  }
}

main().catch(err => { console.error(c.red + err.message + c.reset); process.exit(1) })
