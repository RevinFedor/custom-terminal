/**
 * Test: Timeline hover - tooltip должен оставаться при переходе к нему
 *
 * Проверяет что при наведении на точку Timeline и движении к tooltip,
 * tooltip не закрывается преждевременно.
 *
 * Запуск: node auto/sandbox/test-timeline-hover.js
 */

const { launch, waitForTerminal, typeCommand } = require('../core/launcher')

const TEST_SESSION_ID = '1d945484-74e6-4acd-a016-f823142f08ef'

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
    waitForReady: 4000
  })

  log.pass('Приложение запущено')

  // Ждём терминал
  log.step('Ожидание терминала...')
  await waitForTerminal(page, 15000)
  log.pass('Терминал готов')

  // Запускаем Claude сессию
  log.step('Запуск Claude сессии...')
  await typeCommand(page, `cd /Users/fedor/Desktop/custom-terminal`)
  await page.waitForTimeout(500)
  await typeCommand(page, `claude --dangerously-skip-permissions --resume ${TEST_SESSION_ID}`)

  log.step('Ожидание Timeline (15 сек)...')
  await page.waitForTimeout(15000)

  // Ищем Timeline точки
  log.step('Поиск Timeline точек...')
  const segments = page.locator('[data-segment]')
  const count = await segments.count()
  log.info(`Найдено сегментов: ${count}`)

  if (count === 0) {
    log.fail('Timeline сегменты не найдены')
    await app.close()
    process.exit(1)
  }

  // Берём средний сегмент
  const middleIndex = Math.floor(count / 2)
  const segment = segments.nth(middleIndex)
  const segmentBox = await segment.boundingBox()

  if (!segmentBox) {
    log.fail('Не удалось получить boundingBox сегмента')
    await app.close()
    process.exit(1)
  }

  log.info(`Сегмент ${middleIndex}: x=${segmentBox.x}, y=${segmentBox.y}, w=${segmentBox.width}, h=${segmentBox.height}`)

  // Наводим на сегмент
  log.step('Наведение на сегмент...')
  await page.mouse.move(segmentBox.x + segmentBox.width / 2, segmentBox.y + segmentBox.height / 2)
  await page.waitForTimeout(500)

  // Проверяем появился ли tooltip
  const tooltipBefore = await page.locator('[tabindex="-1"]').first().boundingBox()

  if (!tooltipBefore) {
    log.fail('Tooltip не появился при наведении')
    await app.close()
    process.exit(1)
  }

  log.pass(`Tooltip появился: x=${tooltipBefore.x}, y=${tooltipBefore.y}`)

  // Теперь двигаем мышь ВЛЕВО к tooltip (медленно, шагами)
  log.step('Движение мыши к tooltip (влево)...')

  const startX = segmentBox.x + segmentBox.width / 2
  const startY = segmentBox.y + segmentBox.height / 2
  const endX = tooltipBefore.x + tooltipBefore.width / 2
  const endY = tooltipBefore.y + tooltipBefore.height / 2

  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const x = startX + (endX - startX) * (i / steps)
    const y = startY + (endY - startY) * (i / steps)
    await page.mouse.move(x, y)
    await page.waitForTimeout(50)
    log.info(`Step ${i}/${steps}: x=${Math.round(x)}, y=${Math.round(y)}`)
  }

  await page.waitForTimeout(300)

  // Проверяем tooltip всё ещё виден
  const tooltipAfter = await page.locator('[tabindex="-1"]').first().boundingBox()

  if (tooltipAfter) {
    log.pass('Tooltip остался открытым при переходе!')
  } else {
    log.fail('Tooltip закрылся при переходе к нему')
  }

  // Теперь двигаем мышь далеко влево (плавно, должен закрыться)
  log.step('Движение мыши далеко влево (tooltip должен закрыться)...')
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(tooltipBefore.x - (i * 80), startY)
    await page.waitForTimeout(30)
  }
  await page.waitForTimeout(300)

  const tooltipGone = await page.locator('[tabindex="-1"]').first().boundingBox({ timeout: 1000 }).catch(() => null)

  if (!tooltipGone) {
    log.pass('Tooltip закрылся при уходе мыши влево')
  } else {
    log.fail('Tooltip НЕ закрылся при уходе мыши влево')
  }

  // Тест закрытия при уходе ВПРАВО
  log.step('Тест закрытия при уходе ВПРАВО на сайдбар...')
  await page.mouse.move(segmentBox.x + segmentBox.width / 2, segmentBox.y + segmentBox.height / 2)
  await page.waitForTimeout(500)

  const tooltip2 = await page.locator('[tabindex="-1"]').first().boundingBox({ timeout: 2000 }).catch(() => null)
  if (tooltip2) {
    log.pass('Tooltip появился снова')

    // Двигаем ВПРАВО
    for (let i = 0; i < 5; i++) {
      await page.mouse.move(segmentBox.x + segmentBox.width + (i * 30), segmentBox.y + segmentBox.height / 2)
      await page.waitForTimeout(30)
    }
    await page.waitForTimeout(200)

    const tooltipAfterRight = await page.locator('[tabindex="-1"]').first().boundingBox({ timeout: 500 }).catch(() => null)
    if (!tooltipAfterRight) {
      log.pass('Tooltip закрылся при уходе ВПРАВО')
    } else {
      log.fail('Tooltip НЕ закрылся при уходе вправо')
    }
  } else {
    log.info('Tooltip не появился при повторном наведении (возможно требуется клик)')
  }

  // Вывод логов
  console.log('\n--- Console Logs (Timeline Hover) ---')
  consoleLogs
    .filter(l => l.includes('Timeline') || l.includes('Hover'))
    .slice(-20)
    .forEach(l => console.log(l))

  await app.close()
  log.step('Тест завершён')
}

main().catch(err => {
  console.error(`${c.red}[ERROR]${c.reset}`, err.message)
  process.exit(1)
})
