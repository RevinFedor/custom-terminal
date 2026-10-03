# AI Gemini Automation: Resume, Detection, Injection & Fork

---

## Antigravity CLI — отдельный runtime, не новая команда старого Gemini

С 18 июня 2026 consumer/free, Google AI Pro и Ultra больше не обслуживаются
старым Gemini CLI; официальный подписочный terminal-клиент — Antigravity CLI
(`agy`). Старый Gemini CLI остаётся для Enterprise/Cloud и платных API-ключей.
Поэтому описанные ниже свойства `gemini` остаются текущей реализацией Noted
Terminal, а не описанием `agy`.

Подписка покрывает Antigravity как продукт, включая CLI, но не превращается в
Gemini API balance. В мае 2026 Google ввёл Ultra за $100 (5× лимита Pro) и
снизил верхний Ultra до $200 (20× Pro). Это не безлимит: есть обновляемый каждые
пять часов baseline и недельный предел; Gemini-модели расходуют общий пул с
весом относительно API-цены, сторонние модели имеют отдельный лимит. Точные
числа намеренно не обещаны и меняются с capacity. SDK требует Gemini API key
или Google Cloud и поэтому не решает задачу «работать по consumer-подписке».

Официальный headless-контракт `agy` — постоянный процесс со
`--input-format stream-json --output-format stream-json`. Он один раз отдаёт
`init`, затем для каждого последовательного prompt — `step_update` и ровно один
`result`; `conversation_id` сохраняется между ходами, а новый процесс может
возобновить его через `--conversation`. Это достаточная основа для точных live
ответов, tool cards, usage и lifecycle без разбора TUI. Но это не аналог Codex
app-server: вход принимает только text, следующий prompt разрешён после
`result`, `control_request/control_response` и slash-команды завершают stream
ошибкой. Публичных steer, fork, rewind, approval-response или ACP/JSON-RPC
методов в этом публичном stdio-контракте нет. Это не доказывает отсутствие
других интерфейсов внутри бинарника: локальный API 1.2.14 проверен ниже.

Интерактивный TUI `agy` имеет `/resume`, `/fork` и `/rewind`. Они являются
единственным документированным путём для обязательных fork/rewind: в headless
stream они недоступны. Нельзя переносить старый True Fork путём копирования
файла: `agy` хранит разговоры в другой связке server identity, protobuf/SQLite
и `brain/`, а resume проверяет ID через backend. Прежняя рекомендация обязательно
передавать conversation из headless в TUI для fork/rewind была основана только
на публичной документации. 01.10.2026 нативные fork, conversation rewind и
независимое продолжение обеих веток доказаны через loopback API штатного 1.2.14
без TUI, PTY, SDK и редактирования хранилища.

Целевая интеграция должна быть новым runtime `antigravity`, а не заменой строки
`gemini` в текущем коде: нынешние Sniper, History, Timeline и Rewind знают
`~/.gemini/tmp/.../session-*.json` и старые ANSI-маркеры. Официальный stream-json
и внутренний локальный API — разные по стабильности кандидаты адаптера.
В 1.2.14 `--print-timeout` по умолчанию равен 0 (без лимита); прежний default
5 минут отменён начиная с 1.2.6. Клиентский таймер не является turn completion.

Не перехватывать и не воспроизводить внутренние OAuth-запросы. Документированный
subprocess/headless остаётся внутри официального клиента; Antigravity Terms
отдельно запрещают доступ к сервису сторонним ПО через OAuth и допускают
блокировку аккаунта. Сетевой reverse engineering вдобавок не даёт владельца
tool state, permission и conversation mutation. Проверенный ниже локальный
control API не извлекает Google OAuth credential: запрос к модели выполняет
сам AGY с текущим входом. Техническая работоспособность приватного API не делает
его документированным поддерживаемым интерфейсом.
Актуальный открытый issue 1.1.27 показывает обрезку ~452 KB входа до ~192 KB,
поэтому длину принятого текста нужно доказывать до model generation, а не по
самому факту появления `user` event.

---

## Внутренний API AGY 1.2.14 без терминального экрана

Штатный macOS arm64 `agy` одновременно с print-mode поднимает собственные
loopback HTTP/HTTPS listeners. В исследовании порты получены по PID именно
своего процесса. Параметр `--csrf_token=<случайный локальный токен>` задаёт
доступ к этому процессу; это не Google OAuth token. JSON RPC находятся под
`/exa.language_server_pb.LanguageServerService/`. Имена и protobuf-поля
восстановлены из установленного бинарника, затем проверены запросами.

На неизменённом CLI с Google account sign-in подтверждены:

- `SendUserCascadeMessage` + Connect-поток `StreamAgentStateUpdates`:
  настоящий ответ Gemini и события `RUNNING → steps → fullyIdle`, без prompt
  на stdin. Старый `StreamCascadeReactiveUpdates` отвечает `reactive state is
  deprecated`; наличие символа в бинарнике само по себе не доказывает работу.
- `GetCascadeTrajectory`, `ForkConversation` с
  `FORK_TARGET_CURRENT_WORKSPACE`, `RevertToCascadeStep`. Revert сохраняет
  `stepIndex` **включительно**; чтобы удалить выбранный user turn, нужен индекс
  перед ним. Требуется `overrideConfig` с настоящим model config исходника,
  иначе сервер отвечает `plan model not specified`.
- После fork/rewind hash исходных steps не изменился; новый процесс на ветке
  помнит ранний canary и не знает удалённый поздний, исходник помнит поздний.
- Native `CancelCascadeInvocation` прекращает генерацию, сохраняя процесс;
  следующий запрос работает. Также проверены обычный stream-json, реальный
  file-read tool, resume и переключение low → medium через новый процесс.

Отдельное ограничение print-обвязки: она автоматически пропускает `ask_question`
и отклоняет permission requests. Успеть ответить HTTP-вызовом нельзя считать
решением: в наблюдении `WAITING → skipped` заняло 2 мс. В **изолированной копии**
1.2.14 исследовательский патч getter `Manager.IsPrintMode` (4 байта, exact
SHA/version guard) оставил запросы ожидающими собственного host UI. На этой
копии подтверждены `HandleCascadeUserInteraction`, ответ RED, очередь
`WHEN_IDLE` и `NEXT_INVOCATION` (ввод потреблён до idle текущего turn),
отказ записи без изменения файла и разовый allow с реальной
записью; fixture восстановлена. Это не auto-approve и не установленный патч.
Полное устранение TUI поэтому требует учёта host-owned interactions, а не
только подключения к локальному порту. Поддержка закрытого протокола/патча
при обновлениях остаётся ценой такого варианта.

Патч не сохраняет доверенную подпись вендора. Read-only проверка `codesign -dv`
02.10 показала у оригинала Developer ID Google / TeamIdentifier `EQHXZ8M8AV`,
у тестовой копии — `Signature=adhoc`, без TeamIdentifier. Копия работала с
текущим локальным Google login, но это не доказательство переносимости её
доверия/доступа к credentials на другой Mac или будущие версии. Нельзя
приравнивать локально работающий research executable к готовой подписанной
поставке; глобальные проверки macOS ради интеграции не отключались.

Артефакты: `/tmp/noted-agy-proof.R14Ohk/`, рабочий статус и пределы проверок —
`docs/tmp/исследование-терминалов-и-агентов.md`. Исходный `~/.local/bin/agy`
не изменён; runtime Noted на этот протокол не переводился. Снятие TUI не
устраняет agent process: в этих коротких прогонах его RSS был примерно
180–220 MiB; это не сравнительный benchmark с TUI.
Позднейший сопоставимый A/B с живыми процессами, включая эту host-копию,
измерял `phys_footprint`, а не RSS: см.
`fact-terminal-rendering.md::Цена TUI в живых CLI: ограниченный A/B 02.10.2026`.

## Переиспользование открытого ядра без TUI

Исходники старого Gemini CLI нельзя приравнивать к подписочному `agy`.
В Gemini CLI 0.62.0 отдельный npm-пакет `@google/gemini-cli-core` экспортирует
`LegacyAgentSession`: его цикл уже связывает `GeminiClient.sendMessageStream`
с `Scheduler.schedule`, записью результатов и следующим обращением к модели.
Обязательно писать этот цикл с нуля при удалении TUI не требуется. Approvals
идут через MessageBus, запись и conversation rewind — через
ChatRecordingService; часть composition для fork/rewind и file rollback остаётся
в CLI. Одного импорта ядра недостаточно для полного сохранения этих действий.

01.10 пакет 0.62.0 импортирован отдельным Node runner без Ink, PTY и
терминального renderer. Контролируемые client/scheduler подтвердили
model → tool → model, следующий prompt, native отказ concurrent send и abort.
Это runtime-proof границы ядра с тестовыми providers, не запуск настоящих
инструментов, подписочный inference или проверка durable fork/rewind.
Артефакт/продолжение — `docs/tmp/исследование-терминалов-и-агентов.md`.
Переход текущих Noted-вкладок на embedded core не выполнялся; код старого
Gemini не доказывает права на Antigravity quota или AGY-only модели.

## 1. Smart Gemini Resume (State Detection)
**Файл-источник:** `fix-smart-gemini-resume.md`

### Problems
1. **Commands sent when Gemini already running**: Redundant `gemini` command breaks session restore.
2. **Commands sent before Gemini ready**: Gemini takes 2-5s to load; immediate commands are lost.

### Solution: New 4-stage approach
1. **Stage 1: Detect Current State**: Use `serializeAddon` to check if Gemini prompt `>` is already visible.
2. **Stage 2: Wait for Ready State**: If starting, wait up to 15s for "Type your message" pattern.
3. **Stage 3: Deterministic TUI Readiness (HIDE CURSOR)**: ANSI-последовательность `HIDE CURSOR` (`\x1b[?25l`) — самый быстрый и точный сигнал готовности Ink-интерфейса Gemini. Она отправляется ровно один раз в конце инициализации.
4. **Stage 4: Smart Execution**: Only send `gemini` if needed, then send `/chat resume`.

### Deterministic TUI Readiness: HIDE CURSOR Signal
При холодном запуске Gemini (или перезапуске приложения) система должна дождаться полной инициализации интерфейса перед вставкой текста. **Единственный надежный сигнал готовности** — ANSI-последовательность `HIDE CURSOR` (`\x1b[?25l`), которую Gemini CLI отправляет в конце инициализации Ink-интерфейса.
- **Почему не `geminiSpinnerBusy`?** При холодном старте спиннер может появиться и исчезнуть (переход THINKING → IDLE) еще до загрузки MCP-серверов и инициализации основного интерфейса. Это приведет к преждевременной вставке текста в незагруженный TTY, что вызовет потерю или смешивание символов.
- **Преимущество HIDE CURSOR:** Это явный сигнал об окончании инициализации, отправляемый один раз при первой готовности интерфейса. Он не может быть ложным срабатыванием спиннера.

---

## 2. Headless Mode: `gemini -p` (удалено)

> Единственным потребителем headless-режима был пайплайн обновления
> документации, удалённый 2026-08-18 (см. [`fact-docs-update.md`](fact-docs-update.md)).
> В коде вызова `gemini -p` больше нет.

Что выяснилось, пока режим существовал: предполагалось, что headless даёт лучшее
качество ответов за счёт 11K-токенного системного промпта GEMINI.md. **На практике
разница оказалась незначительной** — реальная проблема качества была в отсутствии
файлов `docs/knowledge/` в промпте. После их добавления во все три метода качество
выровнялось. Полезно помнить, если headless-канал понадобится снова.

### Implementation
```bash
echo "prompt" | gemini -p "" -m gemini-3-flash-preview -o json --approval-mode plan
```

Промпт передается через stdin. Флаг `-o json` возвращает структурированный ответ с метриками. `--approval-mode plan` — read-only (без изменения файлов).

### Реализация в коде
- **IPC:** `docs:gemini-cli-request` в `ipc/docs.js`
- **Функция:** `callGeminiCli(system, prompt, model, cwd)` — записывает промпт во временный файл, запускает `execFile('gemini', ...)`, парсит JSON stdout
- **Timeout:** 5 минут, maxBuffer 50MB

---

## 3. Sniper Watcher (Auto-Capture)
Sniper — фоновый процесс, следящий за активностью Gemini CLI.

### Динамический резолвинг (v0.30+)
Ранее Sniper следил за жестко заданным списком SHA256-директорий. Теперь он использует `resolveGeminiProjectDir`:
1. При запуске `gemini` в табе Sniper запрашивает slug проекта через `projects.json`.
2. Путь наблюдения (`fs.watch`) динамически переключается на `~/.gemini/tmp/<slug>/chats/`.
3. Это позволяет мгновенно подхватывать новые сессии даже в проектах, которые только что были проиндексированы Gemini CLI.

### Invisible Intent: Command Type Sync
При программном запуске Gemini (через IPC `spawn-with-watcher`) стандартный перехват клавиатуры в `Terminal.tsx` не срабатывает.
- **Проблема:** Сессия захватывалась, но `commandType` таба оставался пустым, что блокировало появление AI-инструментов (Timeline, InfoPanel-кнопки и др., которые реактивно зависят от этого поля).
- **Решение:** В обработчик `handleGeminiSessionDetected` добавлена принудительная установка `commandType: 'gemini'`. Это гарантирует корректную работу UI-панелей управления сессией даже при автоматизированном запуске.

---

## 3. Handshake Strategy
**Файл-источник:** `fix-gemini-cli-automation.md`

### Model Switching & Queueing
Gemini CLI не поддерживает очередь команд (ошибка "Slash commands cannot be queued"). 
- **Mechanism:** В `main.js` реализована `geminiCommandQueue` для каждого таба.
- **Execution:** Кнопки моделей (pro/flash) вызывают `gemini:send-command`. Система ждет `HIDE CURSOR` (`\x1b[?25l`) или окно тишины перед отправкой следующей команды. Это гарантирует, что команда `/model` уйдет только тогда, когда CLI готов.

---

## 4. Gemini Rewind Flow (Deterministic Navigation)

Для автоматизации меню `/rewind` приложение отказалось от слепых пауз «тишины» (`drainPtyData`) в пользу **детерминированного ожидания** конкретных маркеров через функцию `waitForPtyText`.

### Алгоритм синхронизации
1. **Загрузка меню:** После отправки `/rewind\r` система ждет появления текста `Stay at current position`.
2. **Навигация (UP/DOWN):** Каждое нажатие клавиши верифицируется появлением ANSI-последовательности зеленого цвета (`\x1b[38;2;166;227;161m`). Если после нажатия UP в течение 2с данные не пришли (0B) — достигнута верхняя граница истории.
3. **Подтверждение:** После Enter система ждет текст `Rewind conversation` или `Do nothing` (последний пункт диалога подтверждения).
4. **Завершение:** Финальная готовность определяется по возврату статус-бара (маркеры `shift+tab`, `INSERT` или `NORMAL`).

### Особенности буфера
Поскольку Gemini CLI использует **Alternate Screen Buffer**, стандартные маркеры xterm.js (`registerMarker`) в этом режиме не работают. Поэтому навигация в Gemini всегда использует текстовый поиск по буферу (Heuristic Search), в то время как Claude использует детерминированные OSC-маркеры.

### Визуальная синхронизация (scrollToTextInBuffer)
`scrollToTextInBuffer` используется **не в Rewind flow**, а в Timeline click handler (`Timeline.tsx`). При клике по точке на таймлайне система ищет текст entry в xterm-буфере и скроллит к найденной позиции. Rewind handler (`gemini:open-history-menu`) завершается возвратом `{ success: true }` и не управляет скроллом напрямую.

---

## 5. Safe Input & Control (Danger Zone)
 Стандартный `Ctrl+C` в Gemini CLI часто приводит к мгновенному выходу из процесса («Terminated»), что фатально для активной сессии.
- **Очистка ввода:** Для очистки длинных промптов в терминале вместо `Ctrl+C` используется связка `Ctrl+A` (в начало) + `Ctrl+K` (удалить до конца). Это позволяет очистить инпут, оставаясь внутри интерактивной сессии.
- **Thinking Guard:** Программная вставка (Paste) и отправка команд **строго запрещены**, если Gemini находится в состоянии `THINKING`. Любой ввод в этот момент игнорируется CLI или приводит к непредсказуемому смешиванию данных. Перед автоматизированными действиями код обязан дождаться `gemini:busy-state` со значением `false`.

### Invisible Intent: Игнорирование ввода в Raw Mode
В отличие от Claude Code, который может буферизовать ввод во время размышлений, Gemini CLI в Raw Mode (через Ink) часто полностью отбрасывает приходящие через PTY байты, если они получены во время отрисовки ответа. Ожидание состояния IDLE — единственный надежный способ гарантировать доставку промпта.

---

## 6. Golden Session Pattern (Test Optimization)
Для ускорения автотестов и UI-дебага используется паттерн «Золотой сессии».
- **Механика:** Вместо того чтобы каждый раз отправлять 10-20 промптов через PTY (что занимает до 60 секунд), тест один раз создает эталонную сессию.
- **Клонирование:** Последующие тесты используют `gemini-f` (True Fork) для мгновенного клонирования этой сессии.
- **Результат:** Время подготовки окружения сокращается с 40-60с до 2-3с, что критично для стабильности Playwright-тестов.

---

## 7. Session Restore: From "Trojan Horse" to Direct Injection
**Файл-источник:** `fix-trojan-horse-replaced.md`

### Problem
Old method was confusing: it created a visible dummy checkpoint `trojan-xxx` in terminal, then renamed it.

### Solution: Direct Injection
Gemini CLI doesn't have an internal registry; it just scans `~/.gemini/tmp/<SHA256_HASH>/checkpoint-*.json`.
**New Strategy:**
1. Calculate SHA256 of the project directory.
2. Manually write the checkpoint JSON file into the correct Gemini temp folder.
3. User runs `/chat resume <name>` directly.
**Benefits:** Faster, invisible background work, no terminal pollution.

---

## 8. Compact Detection (The Empty Info Pattern)

### Внешний факт
В Gemini CLI команда `/compact` не сохраняет текст саммари в JSON-файле сессии. Она записывается как сообщение типа `info` с пустым содержимым (`content: ""`).

### Механика
Система детектирует сжатие при парсинге логов:
1. **Якорь:** Поиск `type: "info"` с пустым контентом.
2. **Верификация:** Сравнение `input tokens` в сообщениях до и после этого якоря. Резкое падение (например, со 120к до 40к) подтверждает факт сжатия.
3. **UI:** В Timeline и HistoryPanel вставляется маркер `COMPACTED` с указанием объема токенов до сжатия (`preTokens`).

---

## 9. Spinner Detection (Thinking Signal)
Для обеспечения стабильности E2E тестов и визуальной индикации в Main-процесс добавлена детекция «размышлений» Gemini.

### Механика
Система сканирует поток данных PTY на наличие Unicode Braille-символов (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), которые Gemini CLI использует для анимации спиннера.

### Guard: geminiActiveTabs
Детектор работает только для вкладок, включенных в `geminiActiveTabs` Set.
- **Почему не geminiWatchers:** Ранее использовался `geminiWatchers.has(tabId)`, но вочеры файловой системы удаляются сразу после захвата сессии при старте. Это приводило к тому, что спиннер детектировался только при первом запуске Gemini и игнорировался во всех последующих промптах.
- **Lifecycle:** Вкладка добавляется в `geminiActiveTabs` при спавне и удаляется только при завершении PTY-процесса.

### Регистрация
Вкладка добавляется в `geminiActiveTabs` в **двух** местах:
- **`gemini:spawn-with-watcher`** — при первом запуске Gemini (new session).
- **`gemini:run-command`** — при continue/fork/resume (команды `gemini-c`, `gemini-f`).

**Ловушка (fix 2026-03):** Ранее `gemini:run-command` не добавлял в `geminiActiveTabs`. Восстановленные Gemini-сессии (continue после рестарта) не детектировали спиннер — индикатор не мигал, хотя Gemini работал. Логи `[GeminiSpinner]` полностью отсутствовали.

### Состояния
- **THINKING:** Активируется мгновенно при появлении любого Braille-символа в активном Gemini-табе.
- **IDLE:** Активируется после **1.5 секунд** отсутствия спиннеров в потоке. Этого времени достаточно для подтверждения того, что Gemini закончил генерацию ответа и вернулся к промпту.

### Invisible Intent (Почему без "esc to cancel")
Ранее планировалось искать спиннер только вместе с текстом-хинтом `"esc to cancel"`. От этой идеи отказались, так как:
1. **Loading phase:** При холодном старте Gemini показывает спиннер `⠋` без всяких хинтов.
2. **Robustness:** Braille-символы крайне редко встречаются в обычном выводе кода или текста, поэтому они сами по себе являются надежным сигналом.

---

## 10. Spurious Cycles Scar (The False IDLE)

### Симптомы
В автоматизированных сценариях второй промпт вставлялся мгновенно, не дожидаясь реального ответа от первого, либо вставлялся прямо поверх генерируемого текста.

### Причина
Gemini CLI ведет себя нелинейно при получении инпута:
1. **Input Acceptance:** При нажатии Enter спиннер может мелькнуть на 0.5-0.9с (авто-обработка), после чего Gemini уходит в IDLE. Это **не ответ**, а просто подтверждение приема команды.
2. **Heavy Processing:** При загрузке большого контекста (MCP, файлы) спиннер может замирать на экране на 2-10с, пока PTY-поток полностью молчит. Стандартные детекторы тишины (silence detection) ошибочно считали это концом ответа.

### Решение: Buffer Inspection
Отказ от анализа только PTY-потока в пользу проверки физического состояния экрана через `terminalRegistry.hasSpinnerOnScreen(tabId)`.
- **Логика:** Если `gemini:busy-state` перешел в IDLE, система проверяет последние 5 строк буфера xterm.js на наличие Braille-символов.
- **Результат:** Если спиннер виден на экране (даже если он замер и PTY молчит), сессия считается **BUSY**. Это единственный 100% надежный способ дождаться окончания генерации в Ink TUI.

---


## 5. Поддержка Truecolor (24-bit) в терминале

### Проблема
Интерфейсы на базе Ink (Gemini CLI, Claude Code) выглядели тусклыми (16/256 цветов), несмотря на поддержку Canvas рендерера.

### Причина
Многие современные CLI проверяют переменную окружения `COLORTERM`. Если она не установлена в `truecolor`, они переходят в режим совместимости с ограниченной палитрой.

### Решение
При создании PTY-процесса в `src/main/main.js` в объект `env` принудительно добавляется флаг:

```javascript
const ptyProcess = pty.spawn(shell, [], {
  ...
  env: {
    ...process.env,
    COLORTERM: 'truecolor'
  }
});
```

### Результат
Терминал корректно отображает яркие 24-битные цвета, что критично для визуального разделения блоков кода и системных сообщений AI-агентов.

---

## 6. Почему Gemini -r не является форком (True Fork)

### Problem
Первоначальная попытка реализовать `gemini-f` через простую команду `gemini -r <sessionId>` в новой вкладке привела к конфликту состояний.

### Symptoms
- Две вкладки работают с одним и тем же JSON-файлом в `~/.gemini/tmp/`.
- Сообщения из одной вкладки появляются в другой после перезапуска.
- Нарушается линейность диалога, сессия становится "битой".

### Cause
Gemini CLI привязывает сессию к конкретному файлу. Команда `-r` просто открывает этот файл. Если две копии CLI пишут в один файл одновременно, результат непредсказуем.

### Solution: True Fork
Реализован механизм физического клонирования состояния на уровне Main-процесса:
1. Поиск оригинального файла `session-*.json` по UUID.
2. Копирование файла под новым именем.
3. **Патчинг JSON:** Изменение поля `sessionId` внутри файла на новый UUID. Это критически важно, так как Gemini валидирует соответствие имени файла и внутреннего ID.
4. Запуск новой копии CLI с новым UUID.

### Результат
Каждая вкладка получает свой независимый файл сессии, что позволяет вести разные ветки диалога из одной точки.
