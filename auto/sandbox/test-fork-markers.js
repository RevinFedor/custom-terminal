/**
 * Test: Fork Markers - синяя полоска на Timeline после fork
 *
 * Проверяет что при форке сессии (claude-f <sessionId>):
 * 1. Fork marker сохраняется в SQLite
 * 2. Timeline показывает синюю полоску на точке fork
 * 3. Точка fork окрашена в синий цвет
 *
 * Запуск: ./run.sh sandbox/test-fork-markers.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

// Session ID для тестирования - должен существовать в ~/.claude/projects/
const TEST_SESSION_ID = 'fce33cf0-467f-470a-bddc-2a94052f82d1'

const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  blue: '\x1b[34m'
}

const log = {
  step: (msg) => console.log(`${c.cyan}[STEP]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  debug: (msg) => console.log(`${c.blue}[DEBUG]${c.reset} ${msg}`)
}

async function main() {
  log.step('Запуск Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: true,
    waitForReady: 4000
  })

  log.pass('Приложение запущено')

  // Ждём терминал
  log.step('Ожидание терминала...')
  try {
    await waitForTerminal(page, 15000)
    log.pass('Терминал активен')
  } catch (e) {
    log.fail('Терминал не появился: ' + e.message)
    await app.close()
    process.exit(1)
  }

  // Фокус
  await electron.focusWindow(app)
  await page.waitForTimeout(500)

  // Создаём новый таб
  log.step('Создаём новый таб (Cmd+T)...')
  await page.keyboard.press('Meta+t')
  await page.waitForTimeout(1500)

  // Переходим в директорию проекта
  const targetDir = '/Users/fedor/Desktop/custom-terminal'
  log.step(`Переход в директорию: ${targetDir}`)
  await typeCommand(page, `cd ${targetDir}`)
  await page.waitForTimeout(500)

  // Выполняем fork через claude-f
  const command = `claude-f ${TEST_SESSION_ID}`
  log.step(`Выполняем fork: ${command}`)
  await typeCommand(page, command)

  // Ждём запуска Claude и обработки fork
  log.step('Ожидание обработки fork (12 сек)...')
  await page.waitForTimeout(12000)

  // === ПРОВЕРКА 1: Fork marker в логах main process ===
  log.step('Проверка: Fork marker сохранён в БД...')

  const forkLogs = mainProcessLogs.filter(l =>
    l.includes('Fork marker') || l.includes('[Claude Fork]')
  )

  console.log('\n--- Fork Logs (Main Process) ---')
  forkLogs.forEach(l => log.debug(l))

  const markerSaved = forkLogs.some(l => l.includes('Fork marker saved'))
  if (markerSaved) {
    log.pass('Fork marker сохранён в SQLite')
  } else {
    log.warn('Fork marker НЕ найден в логах main process')
  }

  // === ПРОВЕРКА 2: Fork markers загружены в Timeline ===
  log.step('Проверка: Fork markers загружены в Timeline...')

  const timelineLogs = consoleLogs.filter(l =>
    l.includes('[Timeline]') || l.includes('Fork markers')
  )

  console.log('\n--- Timeline Logs (Renderer) ---')
  timelineLogs.slice(-15).forEach(l => log.debug(l))

  const markersLoaded = timelineLogs.some(l =>
    l.includes('Fork markers result') || l.includes('Setting fork markers')
  )

  if (markersLoaded) {
    log.pass('Fork markers загружены в Timeline')
  } else {
    log.warn('Fork markers не найдены в логах Timeline')
  }

  // === ПРОВЕРКА 3: Синяя полоска в DOM ===
  log.step('Проверка: Синяя полоска fork в DOM...')

  const forkIndicator = await page.evaluate(() => {
    // Ищем элемент с bg-blue-500 и w-[3px] (fork indicator)
    const blueLines = document.querySelectorAll('[class*="bg-blue-500"]')

    for (const el of blueLines) {
      const style = window.getComputedStyle(el)
      // Fork indicator имеет width: 3px и position: absolute
      if (style.width === '3px' && style.position === 'absolute') {
        return {
          found: true,
          width: style.width,
          backgroundColor: style.backgroundColor
        }
      }
    }

    // Альтернативный поиск по inline style
    const allDivs = document.querySelectorAll('div')
    for (const el of allDivs) {
      if (el.className && el.className.includes('bg-blue-500') && el.className.includes('w-[3px]')) {
        return { found: true, class: el.className }
      }
    }

    return { found: false }
  })

  if (forkIndicator.found) {
    log.pass('Синяя полоска fork найдена в DOM!')
    log.info(`  Details: ${JSON.stringify(forkIndicator)}`)
  } else {
    log.warn('Синяя полоска fork НЕ найдена в DOM')
    log.info('  Возможно: нет fork markers в БД или Timeline ещё не отрисовался')
  }

  // === ПРОВЕРКА 4: Синяя точка на fork point ===
  log.step('Проверка: Точка fork окрашена в синий...')

  const blueDot = await page.evaluate(() => {
    // Ищем точки в Timeline (border-radius: 50%)
    const dots = document.querySelectorAll('div[style*="border-radius"]')

    for (const dot of dots) {
      const style = window.getComputedStyle(dot)
      // Blue color: rgb(59, 130, 246) = #3b82f6
      if (style.backgroundColor === 'rgb(59, 130, 246)' &&
          style.borderRadius === '50%') {
        return { found: true, color: style.backgroundColor }
      }
    }
    return { found: false }
  })

  if (blueDot.found) {
    log.pass('Синяя точка fork найдена!')
  } else {
    log.info('Синяя точка не найдена (может быть нормально если нет hover)')
  }

  // === ДИАГНОСТИКА: Tab State ===
  log.step('Диагностика: Tab State...')

  const tabState = await page.evaluate(() => {
    const store = window.useWorkspaceStore?.getState?.()
    if (!store) return { error: 'Store not found' }

    const activeProjectId = store.activeProjectId
    const project = store.openProjects?.get?.(activeProjectId)
    const activeTabId = project?.activeTabId
    const tab = project?.tabs?.get?.(activeTabId)

    return {
      claudeSessionId: tab?.claudeSessionId,
      commandType: tab?.commandType,
      cwd: tab?.cwd
    }
  })

  console.log('\n--- Tab State ---')
  console.log(JSON.stringify(tabState, null, 2))

  // === ИТОГ ===
  console.log('\n' + '═'.repeat(50))

  let passed = 0
  let total = 3

  if (markerSaved) passed++
  if (markersLoaded) passed++
  if (forkIndicator.found) passed++

  if (passed === total) {
    log.pass(`ТЕСТ ПРОЙДЕН: Fork Markers работают! (${passed}/${total})`)
  } else if (passed > 0) {
    log.warn(`ТЕСТ ЧАСТИЧНО: ${passed}/${total} проверок пройдено`)
  } else {
    log.fail(`ТЕСТ НЕ ПРОЙДЕН: 0/${total} проверок`)
    log.info('Убедитесь что:')
    log.info('  1. Dev server перезапущен (таблица fork_markers создана)')
    log.info('  2. Session ID существует в ~/.claude/projects/')
    log.info('  3. claude-f интерцептор работает')
  }

  console.log('═'.repeat(50))

  // Cleanup
  await app.close()
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
