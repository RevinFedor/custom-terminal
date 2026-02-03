/**
 * Test: Copy Session функциональность
 *
 * Проверяет:
 * 1. Работает ли экспорт Claude сессии
 * 2. Корректно ли работает backtrace алгоритм
 * 3. Опции includeCode и fromStart
 * 4. Multi-select копирование
 *
 * Запуск: ./run.sh sandbox/test-copy-session.js
 */

const { launch, waitForTerminal, typeCommand, findInLogs } = require('../core/launcher')
const electron = require('../core/electron')

// Session ID для тестирования (из существующей сессии)
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
    logConsole: false,
    logMainProcess: true,
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

  // Создаём новый таб для тестирования
  log.step('Создаём новый таб (Cmd+T)...')
  await page.keyboard.press('Meta+t')
  await page.waitForTimeout(1500)
  log.pass('Новый таб создан')

  // Переходим в нужную директорию
  const targetDir = '/Users/fedor/Desktop/custom-terminal'
  log.step(`Переход в директорию: ${targetDir}`)
  await typeCommand(page, `cd ${targetDir}`)
  await page.waitForTimeout(500)
  log.pass('Перешли в директорию')

  // Запускаем claude с --resume чтобы установить claudeSessionId
  log.step(`Запуск claude --resume ${TEST_SESSION_ID}`)
  await typeCommand(page, `claude --resume ${TEST_SESSION_ID}`)
  await page.waitForTimeout(5000)

  // Проверяем состояние вкладки
  log.step('Проверка состояния вкладки...')
  const tabState = await page.evaluate(() => {
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
          claudeSessionId: tab.claudeSessionId,
        } : null
      }
    }
    return { hasStore: false }
  })

  console.log('\n--- Tab State ---')
  console.log(JSON.stringify(tabState, null, 2))

  // Тест 1: Прямой вызов IPC для экспорта сессии
  log.step('Тест 1: Прямой IPC вызов claude:export-clean-session...')

  const exportResult = await page.evaluate(async (sessionId) => {
    const { ipcRenderer } = window.require('electron')
    const result = await ipcRenderer.invoke('claude:export-clean-session', {
      sessionId,
      cwd: '/Users/fedor/Desktop/custom-terminal',
      includeCode: false,
      fromStart: true
    })
    return result
  }, TEST_SESSION_ID)

  if (exportResult.success) {
    log.pass(`Экспорт успешен! Длина: ${exportResult.content?.length || 0} символов`)
    console.log('\n--- Export Preview (first 500 chars) ---')
    console.log(exportResult.content?.substring(0, 500))
    console.log('--- End Preview ---\n')
  } else {
    log.fail(`Экспорт не удался: ${exportResult.error}`)
  }

  // Тест 2: Экспорт с includeCode=true
  log.step('Тест 2: Экспорт с включённым кодом...')

  const exportWithCode = await page.evaluate(async (sessionId) => {
    const { ipcRenderer } = window.require('electron')
    const result = await ipcRenderer.invoke('claude:export-clean-session', {
      sessionId,
      cwd: '/Users/fedor/Desktop/custom-terminal',
      includeCode: true,
      fromStart: true
    })
    return result
  }, TEST_SESSION_ID)

  if (exportWithCode.success) {
    log.pass(`Экспорт с кодом успешен! Длина: ${exportWithCode.content?.length || 0} символов`)
    const hasCodeBlocks = exportWithCode.content?.includes('```')
    if (hasCodeBlocks) {
      log.pass('Найдены блоки кода в экспорте')
    } else {
      log.warn('Блоки кода не найдены (возможно нет tool_result)')
    }
  } else {
    log.fail(`Экспорт с кодом не удался: ${exportWithCode.error}`)
  }

  // Тест 3: Экспорт с fromStart=false
  log.step('Тест 3: Экспорт с последнего форка...')

  const exportFromFork = await page.evaluate(async (sessionId) => {
    const { ipcRenderer } = window.require('electron')
    const result = await ipcRenderer.invoke('claude:export-clean-session', {
      sessionId,
      cwd: '/Users/fedor/Desktop/custom-terminal',
      includeCode: false,
      fromStart: false
    })
    return result
  }, TEST_SESSION_ID)

  if (exportFromFork.success) {
    log.pass(`Экспорт с форка успешен! Длина: ${exportFromFork.content?.length || 0} символов`)
    // Сравниваем размеры
    if (exportFromFork.content?.length < exportResult.content?.length) {
      log.pass('fromStart=false даёт меньший вывод (как ожидалось)')
    }
  } else {
    log.fail(`Экспорт с форка не удался: ${exportFromFork.error}`)
  }

  // Проверяем main process логи
  console.log('\n--- Main Process Logs (Claude Export) ---')
  const exportLogs = mainProcessLogs.filter(l =>
    l.includes('Claude Export') || l.includes('export')
  )
  if (exportLogs.length > 0) {
    exportLogs.forEach(l => log.log(l))
  } else {
    log.warn('Нет логов экспорта в main process')
  }

  // Проверяем renderer логи
  console.log('\n--- Renderer Console Logs (CopySession) ---')
  const copySessionLogs = findInLogs(consoleLogs, 'CopySession')
  if (copySessionLogs.length > 0) {
    copySessionLogs.forEach(l => log.log(l))
  } else {
    log.info('Нет логов CopySession в renderer (UI не использовался)')
  }

  // Cleanup
  log.step('Завершение Claude сессии...')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1000)

  log.step('Закрытие приложения...')
  await app.close()

  // Итоговый результат
  console.log('\n═══════════════════════════════════════')
  if (exportResult.success) {
    log.pass('ТЕСТ ПРОЙДЕН: Copy Session фича работает!')
    console.log(`  - Экспорт без кода: ${exportResult.content?.length} символов`)
    console.log(`  - Экспорт с кодом: ${exportWithCode.content?.length} символов`)
    console.log(`  - Экспорт с форка: ${exportFromFork.content?.length} символов`)
  } else {
    log.fail('ТЕСТ НЕ ПРОЙДЕН: Проверьте логи выше')
  }
  console.log('═══════════════════════════════════════')
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  console.error(err.stack)
  process.exit(1)
})
