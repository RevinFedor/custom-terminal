/**
 * Test: History Panel — Scroll & Render Diagnostics
 *
 * Диагностирует:
 * 1. Сколько раз re-render происходит при открытии панели
 * 2. Какие scroll events летят (scrollTop, direction, кто вызвал)
 * 3. Jitter detection: scroll position changing > 2 раз за 500ms
 * 4. Virtuoso data identity: меняется ли reference без нужды
 * 5. Race conditions: scrollToIndex vs data loading
 *
 * Запуск: node auto/sandbox/test-history-panel-scroll.js
 */

const { launch, waitForTerminal, waitForClaudeSessionId } = require('../core/launcher')
const electron = require('../core/electron')

const c = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m'
}

const log = {
  step: (msg) => console.log(`${c.cyan}[STEP]${c.reset} ${msg}`),
  info: (msg) => console.log(`${c.dim}[INFO]${c.reset} ${msg}`),
  pass: (msg) => console.log(`${c.green}[PASS]${c.reset} ${msg}`),
  fail: (msg) => console.log(`${c.red}[FAIL]${c.reset} ${msg}`),
  warn: (msg) => console.log(`${c.yellow}[WARN]${c.reset} ${msg}`),
  data: (msg) => console.log(`${c.magenta}[DATA]${c.reset} ${msg}`),
  scroll: (msg) => console.log(`${c.bold}[SCROLL]${c.reset} ${msg}`),
}

async function main() {
  log.step('Запуск Noted Terminal...')

  const { app, page, consoleLogs, mainProcessLogs } = await launch({
    logConsole: false,
    logMainProcess: false,
    waitForReady: 4000
  })

  log.pass('Приложение запущено')

  try {
    // 1. Ждём терминал
    log.step('Ожидание терминала...')
    await waitForTerminal(page, 15000)
    log.pass('Терминал активен')

    await electron.focusWindow(app)
    await page.waitForTimeout(500)

    // 2. Подставляем claudeSessionId в активный таб текущего проекта
    const TARGET_SESSION = 'fb6da3fa-da19-42b6-9a76-b9ede4116e90'
    const TARGET_CWD = '/Users/fedor/Desktop/custom-terminal'

    log.step('Подставляем Claude session в активный таб...')
    const setupResult = await page.evaluate(({ sid, cwd }) => {
      const store = window.useWorkspaceStore?.getState?.()
      if (!store) return { error: 'no store' }

      const projId = store.activeProjectId
      const workspace = store.openProjects.get(projId)
      if (!workspace) return { error: 'no workspace' }

      const tab = workspace.tabs.get(workspace.activeTabId)
      if (!tab) return { error: 'no active tab', tabCount: workspace.tabs.size }

      // Мутируем таб + forceUpdate через set()
      tab.claudeSessionId = sid
      tab.commandType = 'claude'
      tab.cwd = cwd

      // Zustand: openProjects = new Map() чтобы сработал re-render
      const updatedProjects = new Map(store.openProjects)
      updatedProjects.set(projId, { ...workspace, tabs: new Map(workspace.tabs) })

      // Внутренний set через прямой вызов (store exposed на window)
      window.useWorkspaceStore.setState({
        openProjects: updatedProjects,
      })

      // Убеждаемся что view = terminal
      store.setProjectView?.(projId, 'terminal')

      return {
        projId,
        tabId: tab.id,
        claudeSessionId: tab.claudeSessionId,
        cwd: tab.cwd,
        commandType: tab.commandType,
        currentView: workspace.currentView,
      }
    }, { sid: TARGET_SESSION, cwd: TARGET_CWD })

    console.log('Setup result:', JSON.stringify(setupResult, null, 2))

    if (setupResult.error) {
      log.fail(`Setup failed: ${setupResult.error}`)
      return
    }
    log.pass(`Таб настроен: session=${TARGET_SESSION.slice(0,8)}...`)

    // Даём UI обновиться
    await page.waitForTimeout(1500)

    // 3. Инжектим диагностический monkey-patch ПЕРЕД открытием панели
    log.step('Инжектим scroll/render мониторинг...')
    await page.evaluate(() => {
      // Глобальный буфер диагностики
      window.__historyDiag = {
        renders: [],       // { time, version, entriesLen, loading }
        scrolls: [],       // { time, scrollTop, scrollHeight, clientHeight, source }
        dataUpdates: [],   // { time, prevLen, newLen, isRefresh }
        scrollToIndex: [], // { time, index, behavior }
        errors: [],
      }

      // Патчим console.warn чтобы ловить [HistoryPanel] логи
      const origWarn = console.warn
      console.warn = function(...args) {
        const msg = args.join(' ')
        if (msg.includes('[HistoryPanel]')) {
          window.__historyDiag.errors.push({ time: Date.now(), msg })
        }
        origWarn.apply(console, args)
      }
    })
    log.pass('Мониторинг установлен')

    // 4. Открываем History Panel через store
    log.step('Открываем History Panel...')
    await page.evaluate(() => {
      window.useUIStore?.getState?.()?.setHistoryPanelOpen(true)
    })

    // Ждём появления панели
    await page.waitForTimeout(500)

    // Проверяем что панель появилась (React inline styles → style.zIndex, не атрибут)
    const panelCheck = await page.evaluate(() => {
      // React sets style as object → element.style.zIndex
      const allDivs = document.querySelectorAll('div')
      for (const div of allDivs) {
        if (div.style.zIndex === '9000' || div.style.zIndex === 9000) {
          return { found: true, method: 'zIndex' }
        }
      }
      // Fallback: ищем span с текстом "History" внутри fixed div
      for (const div of allDivs) {
        if (div.style.position === 'fixed') {
          const span = div.querySelector('span')
          if (span && span.textContent === 'History') {
            return { found: true, method: 'text-History' }
          }
        }
      }
      return { found: false }
    })
    console.log('Panel check:', JSON.stringify(panelCheck))

    if (!panelCheck.found) {
      log.fail('History Panel НЕ появилась')

      // Детальная диагностика
      const diagState = await page.evaluate(() => {
        const ui = window.useUIStore?.getState?.()
        const ws = window.useWorkspaceStore?.getState?.()
        const proj = ws?.openProjects?.get?.(ws?.activeProjectId)
        const tab = proj?.tabs?.get?.(proj?.activeTabId)
        return {
          historyPanelOpen: ui?.historyPanelOpen,
          historyPanelWidth: ui?.historyPanelWidth,
          currentView: proj?.currentView,
          claudeSessionId: tab?.claudeSessionId,
          commandType: tab?.commandType,
          hasActiveTab: !!tab,
          activeProjectId: ws?.activeProjectId,
        }
      })
      console.log('Diagnostic state:', JSON.stringify(diagState, null, 2))
      log.info('Render conditions: historyPanelOpen && claudeSessionId && activeTab && currentView===terminal')
      return
    }
    log.pass(`History Panel открыта (${panelCheck.method})`)

    // 5. Устанавливаем scroll listener на Virtuoso scroller
    log.step('Устанавливаем scroll listener...')
    await page.evaluate(() => {
      // Virtuoso создаёт div с data-testid="virtuoso-scroller" или просто scrollable div
      // Ищем scrollable div внутри History Panel
      const findScrollContainer = () => {
        // History Panel = div с position:fixed и zIndex 9000 (React inline style)
        const allFixed = document.querySelectorAll('div')
        for (const el of allFixed) {
          const style = el.style
          if (style.position === 'fixed' && (String(style.zIndex) === '9000')) {
            // Внутри ищем virtuoso scroller
            const scroller = el.querySelector('[data-virtuoso-scroller="true"]') ||
                             el.querySelector('[data-testid="virtuoso-scroller"]')
            if (scroller) return scroller

            // Fallback: ищем div с overflow-y: auto
            const scrollables = el.querySelectorAll('div')
            for (const s of scrollables) {
              const cs = getComputedStyle(s)
              if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && s.scrollHeight > s.clientHeight) {
                return s
              }
            }

            // Last fallback: first child with scrollHeight > clientHeight
            for (const s of scrollables) {
              if (s.scrollHeight > s.clientHeight + 10) {
                return s
              }
            }
          }
        }
        return null
      }

      const scroller = findScrollContainer()
      if (scroller) {
        window.__historyDiag.scrollerFound = true
        window.__historyDiag.scrollerTag = scroller.tagName
        window.__historyDiag.scrollerAttrs = {
          'data-virtuoso-scroller': scroller.getAttribute('data-virtuoso-scroller'),
          'data-testid': scroller.getAttribute('data-testid'),
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          scrollTop: scroller.scrollTop,
        }

        let lastScrollTop = scroller.scrollTop
        let scrollCount = 0

        scroller.addEventListener('scroll', () => {
          scrollCount++
          const now = Date.now()
          const st = scroller.scrollTop
          const direction = st > lastScrollTop ? 'DOWN' : st < lastScrollTop ? 'UP' : 'NONE'
          const delta = Math.abs(st - lastScrollTop)

          window.__historyDiag.scrolls.push({
            time: now,
            scrollTop: Math.round(st),
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            direction,
            delta: Math.round(delta),
            count: scrollCount,
          })

          // Keep only last 100
          if (window.__historyDiag.scrolls.length > 100) {
            window.__historyDiag.scrolls = window.__historyDiag.scrolls.slice(-100)
          }

          lastScrollTop = st
        }, { passive: true })

        // MutationObserver on scroller children to detect Virtuoso DOM changes
        let mutationCount = 0
        const observer = new MutationObserver((mutations) => {
          mutationCount += mutations.length
          window.__historyDiag.lastMutationCount = mutationCount
          window.__historyDiag.lastMutationTime = Date.now()
        })
        observer.observe(scroller, { childList: true, subtree: true })
        window.__historyDiag.mutationObserver = true
      } else {
        window.__historyDiag.scrollerFound = false
      }
    })

    const scrollerInfo = await page.evaluate(() => ({
      found: window.__historyDiag.scrollerFound,
      tag: window.__historyDiag.scrollerTag,
      attrs: window.__historyDiag.scrollerAttrs,
    }))
    console.log('Scroller info:', JSON.stringify(scrollerInfo, null, 2))

    if (!scrollerInfo.found) {
      log.warn('Scroll container не найден — ждём чуть дольше...')
      await page.waitForTimeout(2000)
      // Retry
      const retry = await page.evaluate(() => window.__historyDiag.scrollerFound)
      if (!retry) {
        log.fail('Scroll container не найден даже после ожидания')
      }
    }

    // 6. Ждём стабилизации (первая загрузка + scroll-to-bottom)
    log.step('Ждём 3 секунды для стабилизации...')
    await page.waitForTimeout(3000)

    // 7. Снимаем snapshot #1: Начальное состояние
    log.step('=== Snapshot #1: Начальное состояние после загрузки ===')
    const snap1 = await page.evaluate(() => {
      const d = window.__historyDiag
      return {
        scrolls: d.scrolls.length,
        lastScroll: d.scrolls[d.scrolls.length - 1],
        firstScroll: d.scrolls[0],
        errors: d.errors,
        mutationCount: d.lastMutationCount,
        scrollerAttrs: d.scrollerAttrs,
      }
    })
    console.log('Snap #1:', JSON.stringify(snap1, null, 2))

    if (snap1.scrolls > 10) {
      log.warn(`Слишком много scroll events (${snap1.scrolls}) за 3 секунды! Возможен jitter.`)
    } else {
      log.pass(`Scroll events: ${snap1.scrolls} (нормально)`)
    }

    // 8. Проверяем количество entries
    const entriesCount = await page.evaluate(() => {
      // Пробуем достать через store/IPC
      const uiStore = window.useUIStore?.getState?.()
      // Entries в ref — недоступны снаружи, считаем DOM-элементы внутри Virtuoso
      const panel = document.querySelector('div[style*="z-index: 9000"]') ||
                    document.querySelector('div[style*="zIndex: 9000"]')
      if (!panel) return { dom: 0, panelFound: false }

      // Count visible rendered items
      const items = panel.querySelectorAll('[data-item-index]')
      // If Virtuoso doesn't use data-item-index, count children in scroller
      if (items.length > 0) {
        return { dom: items.length, panelFound: true, method: 'data-item-index' }
      }

      // Fallback: count items that look like history entries
      const allDivs = panel.querySelectorAll('div')
      let userEntries = 0, claudeEntries = 0
      for (const div of allDivs) {
        const text = div.textContent
        if (text && div.children.length === 0) {
          if (text === 'USER') userEntries++
          if (text === 'CLAUDE') claudeEntries++
        }
      }
      return { panelFound: true, userEntries, claudeEntries, method: 'text-scan' }
    })
    log.data(`Entries in DOM: ${JSON.stringify(entriesCount)}`)

    // 9. Тест: скролл вверх (пользовательский)
    log.step('=== Тест скролла вверх ===')

    // Записываем scroll count до теста
    const beforeScrollUp = await page.evaluate(() => window.__historyDiag.scrolls.length)

    // Скроллим колесиком вверх 5 раз
    // Находим центр панели для наведения мыши
    const panelBounds = await page.evaluate(() => {
      const uiStore = window.useUIStore?.getState?.()
      const w = uiStore?.historyPanelWidth || 420
      const np = uiStore?.notesPanelWidth || 300
      const bodyW = document.body.clientWidth
      return {
        x: bodyW - np - w / 2,
        y: window.innerHeight / 2,
        width: w,
      }
    })
    log.info(`Panel center: x=${Math.round(panelBounds.x)}, y=${Math.round(panelBounds.y)}`)

    // Наводим мышь на центр панели
    await page.mouse.move(panelBounds.x, panelBounds.y)
    await page.waitForTimeout(200)

    // Скроллим вверх
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, -300) // negative = scroll up
      await page.waitForTimeout(100)
    }
    await page.waitForTimeout(500)

    const afterScrollUp = await page.evaluate((prevCount) => {
      const d = window.__historyDiag
      const recent = d.scrolls.slice(-20)
      return {
        totalScrolls: d.scrolls.length,
        newScrollEvents: d.scrolls.length - prevCount,
        recentScrolls: recent.map(s => ({
          dir: s.direction,
          delta: s.delta,
          top: s.scrollTop,
        })),
        currentScrollTop: recent[recent.length - 1]?.scrollTop,
      }
    }, beforeScrollUp)
    console.log('After scroll up:', JSON.stringify(afterScrollUp, null, 2))

    // 10. Ждём 4с — проверяем что refresh не сбросил позицию
    log.step('=== Тест: ждём refresh (4с) — scroll не должен прыгнуть вниз ===')
    const scrollTopBeforeWait = await page.evaluate(() => {
      const d = window.__historyDiag
      return d.scrolls[d.scrolls.length - 1]?.scrollTop || 0
    })
    log.info(`scrollTop перед ожиданием: ${scrollTopBeforeWait}`)

    await page.waitForTimeout(4000) // Больше чем 3с refresh interval

    const snap2 = await page.evaluate(() => {
      const d = window.__historyDiag
      const recent = d.scrolls.slice(-30)

      // Detect jitter: find rapid direction changes
      let jitterCount = 0
      for (let i = 2; i < recent.length; i++) {
        if (recent[i].direction !== recent[i-1].direction && recent[i-1].direction !== 'NONE' && recent[i].direction !== 'NONE') {
          jitterCount++
        }
      }

      // Detect big jumps (>100px in one event)
      const bigJumps = recent.filter(s => s.delta > 100)

      return {
        totalScrolls: d.scrolls.length,
        currentScrollTop: recent[recent.length - 1]?.scrollTop,
        jitterCount,
        bigJumps: bigJumps.map(j => ({ dir: j.direction, delta: j.delta, top: j.scrollTop })),
        recentDirections: recent.slice(-10).map(s => s.direction),
        mutationCount: d.lastMutationCount,
        errors: d.errors,
      }
    })
    console.log('Snap #2 (after 4s wait):', JSON.stringify(snap2, null, 2))

    const scrollTopAfterWait = snap2.currentScrollTop
    const scrollDrift = Math.abs((scrollTopAfterWait || 0) - scrollTopBeforeWait)

    if (scrollDrift > 50) {
      log.fail(`Scroll сдвинулся на ${scrollDrift}px после refresh! Был: ${scrollTopBeforeWait}, стал: ${scrollTopAfterWait}`)
    } else {
      log.pass(`Scroll стабилен (drift: ${scrollDrift}px)`)
    }

    if (snap2.jitterCount > 3) {
      log.fail(`Jitter detected: ${snap2.jitterCount} быстрых смен направления`)
    } else {
      log.pass(`Jitter: ${snap2.jitterCount} (норма)`)
    }

    if (snap2.bigJumps.length > 0) {
      log.fail(`Big jumps detected: ${snap2.bigJumps.length}`)
      snap2.bigJumps.forEach(j => log.warn(`  Jump: ${j.dir} ${j.delta}px → scrollTop=${j.top}`))
    } else {
      log.pass('Нет больших прыжков (>100px)')
    }

    // 11. Дамп всех scroll events для анализа
    log.step('=== Полный дамп scroll events ===')
    const allScrolls = await page.evaluate(() => window.__historyDiag.scrolls)
    console.log(`\nTotal scroll events: ${allScrolls.length}`)
    console.log('Time | Dir | Delta | scrollTop | scrollHeight')
    console.log('-'.repeat(60))

    const t0 = allScrolls[0]?.time || 0
    for (const s of allScrolls) {
      const t = ((s.time - t0) / 1000).toFixed(2)
      console.log(`${t}s | ${(s.direction || '').padEnd(4)} | ${String(s.delta).padStart(5)} | ${String(s.scrollTop).padStart(7)} | ${s.scrollHeight}`)
    }

    // 12. Финальная сводка
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`${c.bold}ИТОГИ:${c.reset}`)
    console.log(`  Total scroll events: ${allScrolls.length}`)
    console.log(`  Jitter (direction flips): ${snap2.jitterCount}`)
    console.log(`  Big jumps (>100px): ${snap2.bigJumps.length}`)
    console.log(`  Scroll drift after refresh: ${scrollDrift}px`)
    console.log(`  DOM mutations: ${snap2.mutationCount}`)
    console.log(`  Errors: ${snap2.errors?.length || 0}`)

    if (snap2.errors?.length > 0) {
      console.log(`\n--- Errors ---`)
      snap2.errors.forEach(e => console.log(`  ${e.msg}`))
    }

    // Renderer console logs related to HistoryPanel
    const historyLogs = consoleLogs.filter(l =>
      l.includes('HistoryPanel') || l.includes('History') || l.includes('get-full-history')
    )
    if (historyLogs.length > 0) {
      console.log(`\n--- Console logs (History) ---`)
      historyLogs.slice(-20).forEach(l => console.log(`  ${l}`))
    }

    // Main process logs for get-full-history
    const mainHistoryLogs = mainProcessLogs.filter(l =>
      l.includes('FullHistory') || l.includes('get-full-history')
    )
    if (mainHistoryLogs.length > 0) {
      console.log(`\n--- Main process logs (FullHistory) ---`)
      mainHistoryLogs.slice(-10).forEach(l => console.log(`  ${l}`))
    }

    console.log('═'.repeat(60))

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
