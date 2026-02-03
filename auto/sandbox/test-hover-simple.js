/**
 * Simple Hover Test - без запуска Claude сессии
 *
 * Тестирует hover логику Timeline напрямую через evaluate
 */

const { launch } = require('../core/launcher')

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
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`)
}

async function main() {
  log.step('Запуск приложения...')

  const { app, page, consoleLogs } = await launch({
    logConsole: true,
    waitForReady: 5000
  })

  log.pass('Приложение запущено')

  // Ждём загрузки
  await page.waitForTimeout(3000)

  // Inject test Timeline с моковыми данными напрямую в DOM
  log.step('Инжектим тестовый Timeline...')

  await page.evaluate(() => {
    // Симулируем Timeline показ через store
    const store = (window as any).__ZUSTAND_STORE__
    if (store) {
      console.log('[Test] Store found, checking state...')
      const state = store.getState()
      console.log('[Test] Active project:', state.activeProjectId)
    }
  })

  // Проверяем есть ли уже Timeline (может быть от предыдущей сессии)
  const existingTimeline = await page.locator('[data-timeline]').count()
  log.info(`Existing Timeline elements: ${existingTimeline}`)

  const existingSegments = await page.locator('[data-segment]').count()
  log.info(`Existing segments: ${existingSegments}`)

  if (existingSegments > 0) {
    log.pass('Timeline уже есть! Тестируем hover...')
    await testHover(page)
  } else {
    log.info('Timeline не найден. Нужна Claude сессия.')
  }

  // Вывод console логов
  console.log('\n--- Console Logs ---')
  consoleLogs.filter(l => l.includes('Test') || l.includes('Hover')).forEach(l => console.log(l))

  await app.close()
}

async function testHover(page) {
  const segment = page.locator('[data-segment]').first()
  const segmentBox = await segment.boundingBox()

  if (!segmentBox) {
    log.fail('Segment boundingBox is null')
    return
  }

  log.info(`Segment: x=${segmentBox.x}, y=${segmentBox.y}`)

  // Hover на сегмент
  log.step('Наведение на сегмент...')
  await page.mouse.move(segmentBox.x + segmentBox.width / 2, segmentBox.y + segmentBox.height / 2)
  await page.waitForTimeout(500)

  // Проверяем tooltip
  const tooltip = await page.locator('[tabindex="-1"]').first().boundingBox()

  if (tooltip) {
    log.pass(`Tooltip появился: x=${tooltip.x}`)

    // Двигаем к tooltip
    log.step('Движение к tooltip...')
    for (let i = 0; i < 5; i++) {
      const x = segmentBox.x - (i * 50)
      await page.mouse.move(x, segmentBox.y + segmentBox.height / 2)
      await page.waitForTimeout(100)
      log.info(`Move to x=${x}`)
    }

    await page.waitForTimeout(300)
    const tooltipAfter = await page.locator('[tabindex="-1"]').first().boundingBox()

    if (tooltipAfter) {
      log.pass('Tooltip остался открытым!')
    } else {
      log.fail('Tooltip закрылся при движении')
    }
  } else {
    log.fail('Tooltip не появился')
  }
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  process.exit(1)
})
