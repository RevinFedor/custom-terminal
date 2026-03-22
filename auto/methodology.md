# Methodology — мета-правила тестирования

**event-driven ожидания, не setTimeout** ждать реальные сигналы — OSC 133, IPC-событие, Zustand-обновление
    - *плохо:* `await page.waitForTimeout(3000)`
    - *хорошо:* `await waitForTerminal(page)` или `await page.waitForFunction(() => ...)`

**не верить собственным логам** делать скриншот и сравнивать с ожидаемым результатом
    - если логи говорят "drift=0px" а пользователь видит прыгающий скролл — логи врут
    - причина: тест может мониторить скрытый viewport (visibility trap)

**скриншоты обязательны** каждый E2E тест ДОЛЖЕН делать скриншоты после критических шагов
    - без них диагностика провалов невозможна — логи не показывают состояние терминала
    - минимум: после открытия UI-элемента, после apply/submit, финальное состояние
    - `await page.screenshot({ path: '/tmp/test-name-step-N.png' })`

**rebuild после правок main.js** при ЛЮБОМ изменении файлов в `src/main/` — сначала `npx electron-vite build`, потом запуск теста
    - без этого тест запустит старый код и ты будешь отлаживать несуществующий баг
    - при изменении `src/renderer/` — убедись что запущен `npm run dev`
    - проверка: сравни timestamp `dist/main/main.js` с `src/main/main.js` — если dist старше, нужен build

**visibility через getComputedStyle, не getBoundingClientRect** скрытые табы (`visibility:hidden`) имеют ненулевые размеры
    - `getBoundingClientRect()` вернёт валидные координаты для скрытого viewport — ловушка
    - *правильно:* `getComputedStyle(el).visibility` — единственный надёжный способ

**не писать тесты, подтверждающие гипотезу** писать тесты, которые её опровергают
    - если думаешь "баг в парсинге" — напиши тест который покажет правильный парсинг
    - headless тест может пройти 22/22, но пропустить реальный баг (модель ≠ реальность)

**исследовать неизвестные ошибки в интернете** не угадывать причину
    - если ошибка незнакомая — искать в документации, GitHub Issues, Stack Overflow
    - предположение без исследования = потеря 30+ минут на ложный путь

**работать через `claude -f` (fork) или спрашивать session ID** для длинных сессий
    - форкать исходную сессию перед тестом, удалять после
    - паттерн: `fs.copyFileSync(src, dst)` → тест → `fs.unlinkSync(dst)` в finally

**удалять тестовые сессии после использования** не засорять диск
    - fork'нутые JSONL-файлы удалять в `finally` блоке теста
    - golden fixtures из `mock-data/` — не трогать, они переиспользуются

**всегда запускать через `tee`** Bash tool в Claude Code буферизирует stdout
    - без `tee` получишь пустой вывод и exit code 1 без диагностики
    - *правило:* `node auto/stable/test-name.js 2>&1 | tee /tmp/test-name.log`

**state isolation — чистый таб** при старте `launch()` приложение восстанавливает последнее состояние из SQLite
    - если активным табом оказался остаток прошлого теста — команды могут не сработать
    - *правило:* создавай новый таб (`Meta+t`), дождись появления, потом работай

**live feedback обязателен** тесты НЕ должны молчать
    - `log.step()` ДО вызова `launch()` или `waitForTerminal()`
    - операция >5 сек — heartbeat через `setInterval`
    - стриминг логов Main-процесса должен быть отфильтрованным

**global timeouts и safety** любой асинхронный вызов — потенциальная точка зависания
    - `withTimeout(promise, ms, label)` для каждого `page.waitFor...` или `httpRequest`
    - hard kill: `setTimeout(...)` в начале `main()` — принудительное завершение через 150-180 секунд

**waitForMainProcessLog: ловушка повторного вызова** начинает поиск с индекса 0
    - повторный вызов для ожидания BUSY после промпта мгновенно найдёт старый лог от инициализации
    - *правильно:* трекать `mainProcessLogs.length` перед промптом, искать только новые записи

**Ctrl+C доставка через IPC, не keyboard** `page.keyboard.press('Control+c')` ненадёжно в Electron
    - может перехватываться ОС как Copy или игнорироваться при потере фокуса
    - *правильно:* `ipcRenderer.send('terminal:input', tabId, '\x03')` — два отдельных аргумента, не объект

**WheelEvent не работает для скролла xterm** xterm.js игнорирует синтетические wheel events
    - *правильно:* устанавливать `viewport.scrollTop` напрямую

**terminal:input — два аргумента, не объект** сигнатура `(event, tabId, data)` принимает 2 отдельных аргумента
    - `ipcRenderer.send('terminal:input', tabId, data)` — не `{ tabId, data }`

**не убивать PTY перед claude:run-command** `terminal:kill` удаляет PTY из `terminals` Map
    - отправить Ctrl+C x2, дождаться `terminal:prompt-ready` (OSC 133 A), затем `claude:run-command`

**focusWindow retry после launch** Execution context destroyed — Electron перезагружает окно при restore
    - оборачивать `focusWindow` в retry (3 попытки, 1с пауза)

**typeCommand когда shell не готов** первые символы поглощаются shell-инициализацией
    - ждать 1с после создания таба или дождаться OSC 133 A перед набором

**assert без `|| true`** `assert(condition || true, ...)` — assert всегда PASS, баг скрыт
    - code review: никогда `|| true` в assert

**logMainProcess: true обязательно** для `[E2E+Claude]` и `[E2E+Gemini+Claude]` тестов
    - `logMainProcess: false` = нет логов Main-процесса для отладки

**terminal:paste для Claude Code** Ink TUI не обрабатывает raw text через `terminal:input`
    - использовать `terminal:paste` (через `safePasteAndSubmit`)

**recovery modal после рестарта** если предыдущий тест убил приложение пока Claude был активен
    - при рестарте появится модалка восстановления (`div.absolute.inset-0.z-50`), блокирующая клики
    - проверять и закрывать в начале теста

**hover: плавно, не мгновенно** Playwright перемещает курсор мгновенно — узкие триггеры не фиксируют пересечение
    - *плохо:* `await page.mouse.move(100, 200)`
    - *хорошо:* `await page.mouse.move(100, 200, { steps: 10 })`

**zombie processes** при падении теста Electron зависает в памяти → блокировка портов, SQLite locks
    - всегда `try/finally` с `await app.close()`
    - если порт занят: `pkill -f 'playwright' || true`

---

## Допустимые фиксированные задержки

Только когда нет сигнала для ожидания:
- `100ms` между набором и Enter (keyboard simulation)
- `300ms` для анимации контекстного меню
- `1000ms` после создания таба (shell init, до первого OSC 133 A)
- `8000ms` retry после падения Electron
