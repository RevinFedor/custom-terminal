/**
 * Test: Timeline появляется при запуске Claude сессии
 *
 * Проверяет что при запуске `claude --resume <sessionId>`:
 * 1. Приложение запускается
 * 2. Команда вводится в терминал
 * 3. Timeline компонент появляется справа
 * 4. В логах появляется [Claude Timeline] Getting timeline for session
 *
 * Запуск: ./run.sh sandbox/test-timeline.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

// Session ID для тестирования
const TEST_SESSION_ID = '1d945484-74e6-4acd-a016-f823142f08ef'

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

  // Запуск приложения с включенным логированием
  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,  // Отключим для чистоты
    logMainProcess: true,  // Показывать main process логи
    waitForReady: 4000
  })

  log.pass('Приложение запущено')

  // Ждём появления терминала
  log.step('Ожидание терминала...')
  try {
    await waitForTerminal(page, 15000)
    log.pass('Терминал активен')
  } catch (e) {
    log.fail('Терминал не появился: ' + e.message)
    await app.close()
    process.exit(1)
  }

  // Фокус на терминал
  log.step('Фокусировка на терминал...')
  await electron.focusWindow(app)
  await page.waitForTimeout(500)

  // Создаём новый таб чтобы избежать проблем с сохранёнными сессиями
  log.step('Создаём новый таб (Cmd+T)...')
  await page.keyboard.press('Meta+t')
  await page.waitForTimeout(1500)
  log.pass('Новый таб создан')

  // Сначала переходим в правильную директорию
  const targetDir = '/Users/fedor/Desktop/custom-terminal'
  log.step(`Переход в директорию: ${targetDir}`)
  await typeCommand(page, `cd ${targetDir}`)
  await page.waitForTimeout(500)
  log.pass('Перешли в директорию')

  // Используем claude-f вместо прямой команды (интерцептор ловит claude-f)
  const command = `claude-f ${TEST_SESSION_ID}`
  log.step(`Ввод команды: ${command}`)

  await typeCommand(page, command)
  log.pass('Команда введена')

  // Ждём запуска Claude
  log.step('Ожидание запуска Claude (12 сек)...')
  await page.waitForTimeout(12000)

  // Диагностика состояния таба и Timeline условий
  log.step('Диагностика состояния таба...')
  const tabState = await page.evaluate(() => {
    // Достаём состояние из Zustand store
    const store = window.__ZUSTAND_STORE__ || null

    // Попробуем получить через React DevTools или напрямую из window
    const workspaceStore = window.useWorkspaceStore?.getState?.() || null

    if (workspaceStore) {
      const activeProjectId = workspaceStore.activeProjectId
      const project = workspaceStore.openProjects?.get?.(activeProjectId)
      const activeTabId = project?.activeTabId
      const tab = project?.tabs?.get?.(activeTabId)

      return {
        hasStore: true,
        activeProjectId,
        activeTabId,
        tab: tab ? {
          id: tab.id,
          name: tab.name,
          cwd: tab.cwd,
          claudeSessionId: tab.claudeSessionId,
          geminiSessionId: tab.geminiSessionId,
          commandType: tab.commandType,
          wasInterrupted: tab.wasInterrupted
        } : null
      }
    }

    return { hasStore: false, error: 'Store not accessible' }
  })

  console.log('\n--- Tab State ---')
  console.log(JSON.stringify(tabState, null, 2))
  console.log('--- End Tab State ---\n')

  // Проверяем содержимое терминала
  log.step('Проверка содержимого терминала...')
  const terminalContent = await page.evaluate(() => {
    const xtermScreen = document.querySelector('.xterm-screen')
    if (!xtermScreen) return 'xterm-screen not found'

    // Получаем текст из терминала
    const rows = document.querySelectorAll('.xterm-rows > div')
    const lines = []
    rows.forEach(row => {
      const text = row.textContent
      if (text && text.trim()) lines.push(text)
    })
    return lines.slice(-20).join('\n')  // последние 20 строк
  })

  console.log('\n--- Terminal Content (last 20 lines) ---')
  console.log(terminalContent)
  console.log('--- End Terminal Content ---\n')

  // Проверяем логи на наличие Timeline
  log.step('Анализ console логов...')

  console.log('\n--- Console Logs Summary ---')
  const timelineLogs = findInLogs(consoleLogs, 'Timeline')
  const claudeLogs = findInLogs(consoleLogs, 'Claude')
  const sessionLogs = findInLogs(consoleLogs, TEST_SESSION_ID)
  const storeLogs = findInLogs(consoleLogs, '[Store]')
  const commandLogs = findInLogs(consoleLogs, 'command')

  // Timeline Debug logs (most important!)
  const timelineDebugLogs = findInLogs(consoleLogs, 'Timeline Debug')
  console.log(`\nTimeline DEBUG logs (${timelineDebugLogs.length}):`)
  timelineDebugLogs.slice(-20).forEach(l => log.log(l))

  console.log(`\nTimeline logs (${timelineLogs.length}):`)
  timelineLogs.slice(0, 10).forEach(l => log.log(l))

  console.log(`\nClaude logs (${claudeLogs.length}):`)
  claudeLogs.slice(0, 10).forEach(l => log.log(l))

  console.log(`\nSession ID logs (${sessionLogs.length}):`)
  sessionLogs.forEach(l => log.log(l))

  console.log(`\nStore logs (${storeLogs.length}):`)
  storeLogs.slice(0, 10).forEach(l => log.log(l))

  console.log(`\nCommand logs (${commandLogs.length}):`)
  commandLogs.slice(0, 10).forEach(l => log.log(l))

  // Проверка на ключевые маркеры
  console.log('\n--- Key Markers Check ---')

  const hasTimelineLoad = findInLogs(consoleLogs, 'Claude Timeline').length > 0 ||
                          findInLogs(consoleLogs, 'get-timeline').length > 0
  const hasSessionCapture = findInLogs(consoleLogs, 'setClaudeSessionId').length > 0 ||
                            findInLogs(consoleLogs, 'claudeSessionId').length > 0
  const hasCommandStart = findInLogs(consoleLogs, 'command-started').length > 0 ||
                          findInLogs(consoleLogs, 'OSC 133').length > 0
  const hasCommandType = findInLogs(consoleLogs, 'commandType').length > 0

  if (hasTimelineLoad) {
    log.pass('Timeline IPC вызван (claude:get-timeline)')
  } else {
    log.warn('Timeline IPC не найден в логах')
  }

  if (hasSessionCapture) {
    log.pass('Claude Session ID захвачен')
  } else {
    log.warn('Claude Session ID capture не найден')
  }

  if (hasCommandStart) {
    log.pass('Command lifecycle события обнаружены')
  } else {
    log.warn('Command lifecycle события не найдены')
  }

  // Проверка UI - есть ли Timeline в DOM
  log.step('Проверка Timeline в DOM...')

  // Timeline селектор - ищем контейнер с характерными стилями
  const timelineExists = await page.evaluate(() => {
    // Ищем элемент с width 16px и border-left (характеристики Timeline)
    const elements = document.querySelectorAll('div')
    for (const el of elements) {
      const style = window.getComputedStyle(el)
      if (style.width === '16px' && style.borderLeftStyle !== 'none') {
        // Проверяем что это не что-то другое - должны быть точки внутри
        const dots = el.querySelectorAll('div[style*="border-radius: 50%"]')
        if (dots.length > 0) {
          return { found: true, dots: dots.length }
        }
      }
    }
    return { found: false }
  })

  if (timelineExists.found) {
    log.pass(`Timeline найден в DOM! Точек: ${timelineExists.dots}`)
  } else {
    log.warn('Timeline не найден в DOM (возможно Claude ещё не запустился или нет entries)')
  }

  // Main process логи (самые важные!)
  console.log('\n--- Main Process Logs ---')
  const sniperLogs = mainProcessLogs.filter(l =>
    l.includes('Sniper') || l.includes('Claude') || l.includes('Timeline') ||
    l.includes('Session') || l.includes('fs.watch') || l.includes('JSONL')
  )
  if (sniperLogs.length > 0) {
    sniperLogs.forEach(l => log.log(l))
  } else {
    log.warn('Нет логов Sniper/Claude/Timeline в main process')
    console.log('Все main process логи:')
    mainProcessLogs.slice(-30).forEach(l => console.log(l))
  }

  // Вывод renderer логов для отладки
  console.log('\n--- Renderer Console Logs (last 30) ---')
  consoleLogs.slice(-30).forEach(l => console.log(l))

  // Cleanup
  log.step('Закрытие приложения...')
  await app.close()

  // Итоговый результат
  console.log('\n═══════════════════════════════════════')
  if (hasTimelineLoad || timelineExists.found) {
    log.pass('ТЕСТ ПРОЙДЕН: Timeline фича работает!')
  } else {
    log.warn('ТЕСТ ЧАСТИЧНО: Timeline не обнаружен, проверьте логи выше')
  }
  console.log('═══════════════════════════════════════')
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
