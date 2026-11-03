# Факт: Claude Code Stop hook → Unix socket → main process

## Проблема
Нужен **детерминированный** сигнал конца turn'а Claude Code (CLI). Эвристики на PTY (исчезновение спиннера `✢`, появление `╰` в инпут-боксе) ненадёжны: внутри одного turn Claude может думать → вывести текст → снова думать → вызвать tool → снова думать → финальный текст. Spinner gone после первой thinking-фазы ≠ конец turn'а.

## Решение
**Stop hook** Claude Code — единственный officially-документированный сигнал, fired ровно один раз на полный turn (после всех tool rounds). Источник в декомпиле: `packages/claude-code-src/query.ts:1062` — `handleStopHooks` вызывается только когда `!needsFollowUp` (model API call вернул без новых `tool_use` блоков).

### Архитектура

```
[Claude turn ends inside query.ts loop]
       ↓ fork() child process
[node ~/.claude/hooks/noted-turn-event.js]
       ↓ читает JSON со stdin
       ↓ resolveSock(): NOTED_MAIN_PID env → cwd-discovery → legacy fallback
       ↓ Unix socket connect
[/tmp/noted-terminal-claude-hook-<pid>.sock — net.Server в Electron main]
       ↓ парсит JSON, write "ok\n" обратно (ack)
       ↓ lookup session_id → tabId через bridgeKnownSessions
[mainWindow.webContents.send('claude:turn-state', ...)]
       ↓
[Renderer InfoPanel / Loader]
```

Per-PID socket путь означает что каждый main listens на свой `claude-hook-<pid>.sock` и публикует его в `~/.noted-terminal/claude-hook-<pid>.json` discovery (`{sock, pid, openProjectPaths, updatedAt}`). Hook-script читает все живые discovery, выбирает инстанс через priority: env `NOTED_MAIN_PID` (Claude PTY env пишется тем main'ом что spawn'ил Claude) → longest-prefix cwd match → most-recent updatedAt. Legacy `/tmp/noted-terminal-claude-hook.sock` тоже биндится «вторым server'ом» через try-listen + probe-before-unlink, для совместимости со старыми hook-script'ами без discovery-логики. Сервер на каждое envelope пишет `ok\n` обратно — script-side выходит с `acked_<latency>ms` outcome. Старый `sent_no_ack` означал лишь отсутствие ACK к150мс, а не доказанный отказ main; текущие фазовые исходы описаны в секции Hook script. См. [`fix-claude-hook-silent-dropouts.md`](fix-claude-hook-silent-dropouts.md).

### Зарегистрированные события

В `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "Stop":               [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "StopFailure":        [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "PreToolUse":         [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "PostToolUse":        [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "PostToolUseFailure": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }]
}
```

- **UserPromptSubmit** текущего main-owner → `busy: true` (turn начался)
- **Stop** того же main-owner → `busy: false, success: true` (turn завершился успешно)
- **StopFailure** того же main-owner → `busy: false, success: false` (turn упал на API error: rate_limit / auth / server_error)
- **PreToolUse / PostToolUse / PostToolUseFailure** (matcher `AskUserQuestion`) → `claude:awaiting-input` `{awaiting:true|false}` — детерминированный бракет «Claude задал вопрос и ждёт ответа человека». Тот же скрипт, тот же сокет. PreToolUse(AskUserQuestion) = вопрос появился; Post*(AskUserQuestion) = ответил/отменил. Matcher гарантирует ноль спавнов скрипта на Read/Bash/Edit. Полная механика — [`fact-claude-awaiting-input.md`](fact-claude-awaiting-input.md).

### Явная ошибка провайдера

`StopFailure` закрывает только доказанный текущий turn, не процесс Claude.
В общие busy/done-события входят `terminalProviderFailure`, `providerErrorCode`
и понятный `providerErrorMessage`; helper сохраняет также `error_details`.
Оркестрация завершает этот вызов ошибкой без recovery grace и передаёт результат
источнику штатным уведомлением. Обычный Stop, ручной Escape, временный сетевой
retry без StopFailure и неизвестная доставка не становятся этим исходом.

Шрам13.09: Fable `StopFailure` был принят в19:46:47.146UTC и выключил основной
busy. Продолжавшийся loader принадлежал orchestration-run без execution binding:
его раньше не связали с доставленным текстом после TAB→spaces. Это не потерянный
hook и не повод дописывать новый spinner-детектор. Полная граница и replay —
[`fact-оркестрация-вкладок.md`](fact-оркестрация-вкладок.md#fable-limit-и-разные-представления-prompt--1309).

### Обрыв потока на середине ответа продолжается сам (02.11.2026)

Anthropic может разорвать поток **посреди уже идущего ответа**. Claude Code
пишет синтетическую запись и останавливается; ход заканчивается половиной
ответа, и раньше пользователь сам замечал это и писал «продолжай».
Production 02.11, сессия be82a19d, запись 15ce6c4b, смещение 48691710:

```text
error: "server_error"   streamCutCause: "server_error"
truncatedAfterOutput: true      ← часть ответа уже в переписке
isApiErrorMessage: true         model: "<synthetic>"
text: "API Error: Server error mid-response. The response above may be incomplete."
```

Это не лимит и не перегрузка: `usage-limit` ловится отдельно по 429 и своей
очередью ожидания, продолжать её сразу бессмысленно.

Решение Fedor 02.11: **продолжать автоматически всегда**, как при перегрузке
модели у Codex. Кнопку «Продолжить» рассматривали и отклонили — она отправила
бы то же слово, риск повторного запуска инструмента такой же, а цена клик.
Claude при продолжении видит всю переписку, поэтому уже выполненный инструмент
ему виден и вслепую не повторяется.

Переиспользована политика Codex целиком (`codex-capacity-retry-policy`,
`codex-capacity-retry-runtime`) — та же пользовательская настройка числа
повторов и задержек, то же правило «настоящий прогресс восстанавливает бюджет»,
тот же запрет повторять один и тот же идентификатор ошибки. Claude-специфично
только распознавание записи: `src/shared/claude-stream-cut-retry.cjs`,
признак — `isApiErrorMessage` + `streamCutCause ∈ {server_error,
overloaded_error, api_error}` и не 429; цитата этой фразы в обычном ответе
повтор не вооружает. Состояние — свой ключ `claude-stream-cut-retry-state:`.

Отправка идёт обычным Project API Send (`sendClaudeStreamCutContinuation`,
текст `продолжай`, `queue:true`, `requireLive:true`): та же очередь, квитанции
и отмена. Владение проверяется дважды — при входе и прямо перед вставкой:
терминал, поколение запуска, привязка сессии, отсутствие идущего Stop.
Остановленная вкладка не запускается. Тесты
`claude-stream-cut-retry.actual.test.js` 7/7 и
`claude-stream-cut-continuation.actual.test.js` 8/8.

### IPC payload в renderer

```ts
ipcRenderer.on('claude:turn-state', (_, data: {
  tabId: string;
  sessionId: string;
  event: 'UserPromptSubmit' | 'Stop' | 'StopFailure';
  busy: boolean;
  success: boolean;
  lastAssistantMessage: string | null;  // финальный текст ответа Claude (с v2.1.47)
}) => { ... });
```

## Детерминизм — эмпирическая проверка

Headless test через `claude -p "Read 3 files and summarize"`:
- 1 user prompt → 3 tool_use rounds (Read) → 1 финальный summary text
- В логе ровно **2 события**: UserPromptSubmit + Stop. Никаких промежуточных Stop между tool calls.
- Latency Stop hook → нашему сокету: < 5ms (Unix socket на localhost).

## Маппинг hook → tabId

Известный `session_id` из `bridgeKnownSessions` остаётся главным доказательством. Но у fresh Claude первый `UserPromptSubmit` и даже короткий `Stop` могут прийти раньше StatusLine/JSONL-привязки. Для этого окна main использует только заранее доказанный Claude PID из process-tree конкретного PTY: PID резервируется после принятого launch и повторно проверяется непосредственно перед внешним Enter. После появления session binding маршрутизация снова идёт по `session_id`; неизвестный PID или уже закрытая вкладка не могут принять hook чужого Claude.

Эта ранняя привязка нужна не только loader'у. Без неё orchestration-run может получить `Stop`, не увидев собственного `UserPromptSubmit`, а первый completion prompt source-вкладки останется временной History-строкой рядом с уже записанной durable user-записью.

### Один session/PID не означает один ход

20.09 tab171 принял UserPromptSubmit в13:45:02.149UTC, а через224мс StopFailure
погасил loader, timing и semantic owner. Точный main request после этого получил
HTTP200 и продолжал tools. Старый helper отбрасывал признаки subagent/исходного
prompt; по сохранённому envelope нельзя установить, какой именно чужой вызов
дал этот StopFailure. Busy=false в этом случае не доказывал завершение ответа.

Hook helper и main устанавливаются согласованно: `agent_id`,
`agent_transcript_path` и `prompt_id` не теряются при передаче. До изменения
busy/preview/timing/очереди main отсекает subagent start/end, неизвестные типы и
несовпадение доказанного process/session/prompt owner. `agent_type` сам по себе
не является subagent proof: main-сессия тоже может работать через `--agent`.
Это различие задано [официальным hook input](https://code.claude.com/docs/en/hooks#common-input-fields).
Точный повтор start активного prompt не меняет generation и completion intent;
отсутствующий у старого CLI prompt_id не придумывается и сохраняет legacy путь.
Обычные Stop/StopFailure текущего владельца, fresh PID-before-bridge и фоновые
вкладки сохранены. Main outcome не восстанавливается по глифу spinner или факту
получения части ответа. Нужны и actual socket-handler replay, и запуск настоящего
helper через private socket: тест готового envelope не ловит потерю полей в helper.
Tool hooks не являются turn-end и сохраняют существующий отдельный путь,
включая AskUserQuestion дочернего агента через тот же PTY. Фильтровать вообще
все child hooks нельзя: это скрывает законный вопрос вместо ремонта loader.

## Известные ограничения (по версии 2.1.x, май 2026)

1. **Silent tool stop / hook dropout** (bug #29881 class): turn может закончиться без `Stop` или hook-script может не добежать. **Mitigation:** main-process watchdog на `claudeTurnBusy`. С июня 2026 это не "жёсткий reset через 60 минут", а liveness-check: если Claude-процесс жив и есть свежий spinner-frame (<30s) или свежий `mtime` JSONL (<10min), watchdog продлевается ещё на 15 минут. Жёсткий `busy:false` остаётся только когда оба artifact-сигнала затухли.
2. **JSONL writes стопаются после auto-update mid-session** (#16, open). Не affects hook (hook fires из самого процесса), но affects JSONL fallback.
3. **`stop_reason: null` в JSONL** (#27361) — поле всегда null, нельзя tail'ить JSONL по нему. Hook — единственный надёжный канал.
4. **CLAUDE_CODE_NO_FLICKER=1** (с v2.1.89) — fullscreen mode, ломает ANSI-эвристики типа «появление `╰` в нижней строке». Stop hook этим не задет.
5. **Aborted streaming не fires hook** — путь `query.ts:1051` для user-initiated interrupt (Esc, Ctrl+C, submit-interrupt новым промптом во время стрима) возвращает `{ reason: 'aborted_streaming' }` **без вызова handleStopHooks**. Это намеренное поведение Claude, не баг (issues #29881, #17466). **Mitigation:** JSONL interruption watcher — `fs.watch` на сессионный JSONL, ищем запись `type:"user"` с `text:"[Request interrupted by user]"` (или `... for tool use` вариант), которую Claude гарантированно пишет на abort. Отдельно важно: spinner fallback после этого остаётся только эвристикой; его `claude:busy-state` идёт с `reason:'spinner'` и не должен использоваться как authoritative end-of-turn в автоматиках вроде PromptQueueRunner. См. [`fix-claude-aborted-streaming-loader.md`](fix-claude-aborted-streaming-loader.md) и переносимый принцип `methodology/дизайн-принципы.md::Authoritative artifact > эвристика на input-side`.
6. **Multi-instance silent-dropout** — dev + prod одновременно открыли один cwd → hook events из прод-Claude'а попадали в dev silently (cwd routing tie не разрешался). Закрыто через per-PID socket + ack-протокол + `NOTED_MAIN_PID` env. Симптомы и полная цепочка из четырёх слоёв — [`fix-claude-hook-silent-dropouts.md`](fix-claude-hook-silent-dropouts.md).

## Hook script (`~/.claude/hooks/noted-turn-event.js`)

Скрипт читает JSON со stdin и передаёт полный envelope в socket. Успех —
`ok\n` от main после разбора, не вызов `write` и не истёкший таймер. Сначала
ожидается соединение, затем callback полной записи, затем ACK. Предельные
окна ограничивают зависший канал, но не являются обязательными задержками:
1с connect,5с write/drain,1с ACK после полной записи. При сбое Claude не
блокируется навсегда; в диагностике остаются phase/bytes/pendingBytes/outcome.

Шрам10.09: tab413 отправил24661char prompt, а `UserPromptSubmit` helper оборвал
сокет через250мс до полной записи. Main видел `Conn close ... lines=0`, тогда
как sender писал `timeout_250ms`; ни начала turn, ни loader не было. Независимый
JSONL-аудит подтвердил сам prompt — это объясняет работающего Claude при
`busy=false`, но не заменяет пропущенное hook-событие. Source и установленный
helper на момент инцидента совпадали. Обрыв больше не привязан к короткому
общему таймеру: write/drain имеет собственную границу перед ожиданием ACK.
Тот же транспорт обслуживает Stop и tool hooks; проверка большим UTF-8 пакетом
и paused socket обязательна, маленький happy-path её не заменяет. Main отдельно
логирует `INCOMPLETE_ENVELOPE` без содержимого prompt; повторное событие/Send
не создаётся и busy из отсутствующего пакета не выдумывается.

Канонический исходник живёт в repo: `scripts/claude-hooks/noted-turn-event.js`; домашний файл — только runtime-копия. Установка выполняется `npm run install:claude-hook`: скрипт побайтно и атомарно синхронизирует runtime, сохраняет неизвестные поля `~/.claude/settings.json`, не дублирует регистрации и ничего не пишет в `/Applications`. Обычный `build:install` вызывает тот же установщик до замены app-копии. Hook запускается новым Node-процессом на каждое событие, поэтому замена уже зарегистрированного файла действует со следующего события; перезапуск Claude нужен только если менялась сама регистрация в settings.

Только `UserPromptSubmit` переносит в локальном envelope точный `prompt`; `Stop` и tool-события этого поля не получают, а диагностический mirror никогда не пишет его содержимое. Main использует текст не как готовый result-proof, а чтобы найти ровно один уже отправленный pending audit и закрепить за ним identity начавшегося turn. Если одновременно ожидаются два одинаковых prompt с тем же hash+length, связь не угадывается: оба остаются без execution context с явным diagnostic. Последующий JSONL audit по-прежнему независимо распределяет durable user-записи oldest-first; его порядок нельзя использовать задним числом как доказательство владельца hook-события.

## Re-entrancy guard `stop_hook_active`

В payload приходит `stop_hook_active: true` когда Stop hook уже исполняется. Наш скрипт не возвращает `{"decision": "block"}` — то есть никогда не заставляет Claude continue, поэтому re-entrancy не происходит. Поле просто пропускается в envelope.

## Интеграция в claude:busy-state

Hook теперь **authoritative source** для loader'а. Поток:

```
UserPromptSubmit → claudeSpinnerBusy.set(tabId, true) + emit claude:busy-state busy=true
              ↓
Stop / StopFailure → cancel pending spinner-idle-timer
                  → claudeSpinnerBusy.set(tabId, false) + emit claude:busy-state busy=false
```

**Спиннер-детектор подавлен пока turn активен:**
- `claudeSpinnerBusy IDLE timer` проверяет `if (claudeTurnBusy.get(tabId) === true) return;` — не shipит false-IDLE между thinking phases.
- Это убирает классический баг "loader выключился после первой фазы".

**Watchdog 60 минут + продление по liveness:** safety net на silent-tool-stop (#29881), упавший hook script, killed claude process. На happy path у длинного turn'а он не должен ложно сработать: свежий spinner или свежий JSONL `mtime` продлевают окно ещё на 15 минут. Жёсткий `reason:'watchdog'` остаётся только когда и процесс, и артефакты затихли.

## Fresh-process detection — `claude:process-started`

`claude:session-detected` fires **на каждом bridge re-sync** (statusline-script у Claude дёргается раз в 1-2 секунды). Для одноразовых side effects типа auto `/effort` это плохо: session_id остаётся прежним при перезапуске Claude (`claude --resume <id>`), guard `if (currentId !== data.sessionId)` всегда `false` для перезапущенной сессии. Эффект — `/effort` инжектится только при первом запуске Claude в жизни таба, при перезапуске молча пропускается.

**Решение:** отдельный event `claude:process-started` fires когда `bridgePidCache` видит **новый Claude PID** для tab'а — это происходит ровно один раз на каждый реальный spawn процесса. PID меняется при каждом запуске binary, даже если sessionId тот же.

Renderer по-прежнему получает `claude:process-started` для presentation-side
liveness, welcome/analytics и привязки sessionId. Startup-настройки из этого
handler больше не запускаются.

**`/effort` не принадлежит ни одному renderer-event handler.**
`claude:process-started` (= `Bridge:Fresh`) и более ранний
`claude:tui-ready` — два readiness-input одной main-side транзакции по launch
generation. Первый прибывший открывает её, второй только join'ится. Так новый
PID остаётся fallback, если prompt не распознан, но два сигнала физически не
могут поделить `/model` и `/effort` между разными владельцами. Полная механика
— `fact-claude-tui-control.md::Startup defaults /model + /effort`.

## Prompt Queue — grab-input flow

`Ctrl+G` в Claude TUI → действие `chat:externalEditor` → Claude execSync'ом запускает `$EDITOR <tempfile>`. Мы инжектим `EDITOR=~/.claude/hooks/noted-code-grab.js` в env PTY-процесса.

Helper script:
1. Читает содержимое tempfile (с раскрытыми pasted-text refs)
2. Через тот же сокет шлёт `{event:'GrabInput', ppid, text}`
3. Truncate'ит tempfile в пустую строку
4. exit 0

Claude после нашего exit'а перечитывает файл → видит пустой input → инпут очищается.

**Маппинг ppid → tabId:** через `bridgePidCache` (заполняется SessionBridge'ем, Claude PID → tabId).

**Caveats:**
- Image attachments через editor всё ещё приходят как `[Image #N]` placeholder'ы, но это не plain text: main резолвит файл в `~/.claude/image-cache/<sessionId>/<N>.<ext>` и сохраняет image-slot рядом с History draft. Если файл найден, History показывает семантический `[Image #N]` и блокирует тихую отправку как обычного текста; если файл потерян, в draft остаётся явный `imageError`. Не возвращать поведение «просто вставить placeholder и считать prompt восстановленным».
- Имя скрипта **должно начинаться с "code"** (`noted-code-grab`) — Claude classifies basename: если содержит `code|cursor|windsurf|codium|subl|atom`, GUI-path (silent), иначе alt-screen flash. См. `editor.ts:20-30` в декомпиле.
- `getExternalEditor` в Claude **memoize'ан** — EDITOR должен быть установлен ДО spawn'а Claude. Существующие табы запущенные до изменения env не получат фичу до рестарта Claude процесса.
- `getExternalEditor` проверяет `VISUAL` ПЕРЕД `EDITOR` — мы инжектим оба для надёжности.

## Сообщение из очереди Claude продолжает ход (01.11.2026)

Сообщение, отправленное в занятую вкладку, Claude ставит в свою очередь. Hook
`UserPromptSubmit` приходит в момент постановки, с `prompt_id` **активного** хода, и
`admitClaudeMainHook` законно отбрасывает его (`duplicate-prompt-start`). Дальше
два поведения Claude, оба видны в dev 01.11:

```text
merge:   QUEUE_CONSUMED operation=remove  ДО Stop  → сообщение ушло в текущий ход,
         Stop — настоящий конец (ничего не делаем)
dequeue: Stop → QUEUE_CONSUMED operation=dequeue ПОСЛЕ границы Stop → новый ход,
         но без нового UserPromptSubmit → вкладка «свободна», пока Claude работает
```

Решение пользователя: вкладка занята, пока ход из очереди реально не закончится.
Main запоминает отброшенный hook (`claudeQueuedPromptSubmits`), на `Stop` фиксирует
байтовую границу транскрипта, и при `dequeue` нашего сообщения после неё повторно
подаёт тот же `UserPromptSubmit` в собственный hook-сокет — срабатывает весь штатный
переход (busy, редьюсер хода для Run After/Loop, превью, наблюдатели). Подаётся
**без `prompt_id`**: Claude выполняет ход из очереди под новым id, и закреплённый
старый id делал настоящий `Stop` `prompt-owner-mismatch` → вечный лоадер (пойман в
dev 18:21:58). Сессия и процесс по-прежнему сверяются. `remove`, `dequeue` до границы,
чужой текст или ход ещё идёт — ничего не подаётся. Окно ложного idle сокращается с
длины хода до ~170 мс: Run After на первом `Stop` может начать подготовку, но его
отправка встанет в очередь Claude после нашего сообщения. Работает для отправок,
которые проходят аудит приложения; ручной ввод в TUI не покрыт. Логи
`[ClaudeQueueContinuation] remembered|stop-boundary|dequeue|consumed`. Тест
`claude-queue-continuation.actual.test.js`.

### `prompt_id` хода не постоянен: сверка по нему держала лоадер 9 минут (01.11.2026)

Тот же шрам, но без повтора с нашей стороны: Claude **сам** закрыл ход другим
`prompt_id`, чем открыл. Production, вкладка 95c379a4fb0f, сессия 9e688393:

```text
15:49:47  UserPromptSubmit → ход открыт, prompt_id = e04bc4b2…
15:52:39  сообщение в занятую вкладку → duplicate-prompt-start (штатно)
15:56:12  Stop от Claude   → prompt_id = f13bd3eb…
          ClaudeHookScope ignored reason=prompt-owner-mismatch
          …turn=1 spin=1 девять замеров ClaudeSnapshot подряд…
15:59:20  пользователь шлёт новое сообщение → новый ход
16:00:38  Stop принят → лоадер погас
```

Правило «чужой Stop не гасит мой ход» считало `prompt_id` неизменным на время
хода. Выше в этом же файле записано, что при повторной подаче он меняется —
но здесь он сменился без всякой подачи. Поэтому в `admitClaudeMainHook`
несовпадение `prompt_id` **само по себе больше не отклоняет** терминальное
событие (`Stop`/`StopFailure`). Обязательными остаются сессия и процесс, а
субагент отсекается раньше по `agent_id`/`agent_transcript_path` — именно эта
проверка и защищает родительский ход от дочернего. Для `UserPromptSubmit`
точная сверка id сохранена: ею отличается сообщение из очереди от нового хода,
и на ней держится продолжение очереди. Тест
`claude-turn-prompt-id-drift.actual.test.js` (PRE 5/8 → POST 8/8).

### Строка очереди без байтового смещения двоилась (01.11.2026)

Отдельный от карточки случай с тем же симптомом: одно сообщение — ДВЕ строки,
обе `queued`, у обеих **одинаковый Message ID**. То есть одна запись JSONL
нарисована дважды, а не два отправления. Production, вкладка 6d6fd1718b66,
сессия 30ea154d, enqueue на смещении 41443353.

Живая строка очереди опознаётся по физическому смещению записи. Когда та же
запись приходит повторно **без смещения** (переподключение, обновление, любой
конверт без позиции), опознаватель строится по запасной формуле
`сессия:время:хеш текста` — другая строка для той же записи. Сверка сравнивала
только основную форму, не находила и добавляла вторую строку.

Исправление: строка несёт обе формы (`sourceIdentity` + `sourceIdentityAliases`)
и сверяется по любой из них. Где у обеих сторон есть смещение — решает только
смещение: два одинаковых промпта, отправленных дважды, имеют одинаковую
запасную форму и не должны склеиваться. Проверено на всех шести сочетаниях.
Тест `historyQueueRowDeduplication.actual.test.mjs` (PRE 5/6 → POST 6/6);
`historyClaudePromptCarriers.test.mjs` 16/16 без изменений.

Проверялись и исключены три других слоя: разбор JSONL на настоящем файле даёт
одну строку (порядок `enqueue → remove → носитель` верен, носитель съедает
строку очереди); цепочка сессий не дублирует операции очереди (50 операций,
50 уникальных по файлу и смещению); слияние живого потока с перечитанным дало
одну строку. Дубль возникал внутри самого живого потока.

### Та же карточка: проверка висела не в том месте (02.11.2026)

Правка 01.11 (ниже) была верной по условию, но стояла в подписке на изменения
**карточки**. Запись Claude карточку не меняет, поэтому при обычном порядке
событий проверка просто не вызывалась:

```text
10:58:23.642  QUEUE_CONSUMED — отправка подтверждена
10:58:23.808  карточка стала sent; записи Claude ещё нет
   …57 секунд два одинаковых сообщения на экране…
10:59:20.309  отложенная полная перечитка
10:59:20.317  LOCAL_RETIRED_BY_CANONICAL
```

Production 02.11, вкладка 16b18cfdeba5, handoff mvz5b8ea-gzs3aq, текст «оке ищи».
Проверено, что остальные слои здоровы: живой поток на настоящем файле даёт одну
строку (enqueue → remove → носитель, 1 строка на каждом шаге), опознаватели
совпадают, дубля в проекции нет.

Ремонт: тот же разбор вызывается ещё и там, где живая проекция публикует строки
Claude (`retireLocalPromptsCoveredByCanonicalRows`). Доказательство прежнее —
точный опознаватель, снятие привязано к конкретной попытке. Прежняя проверка в
подписке сохранена: она нужна для обратного порядка, когда строка уже видна, а
карточка подтверждается позже. Тест
`historyLiveRowRetiresLocalCard.actual.test.mjs` (PRE 5/6 → POST 6/6).

### Карточка History уступает записи Claude сразу, не после перечитывания (01.11.2026)

Третье следствие того же `duplicate-prompt-start`: одно сообщение показывалось
в History ДВУМЯ карточками, обе `sent`. Факты одного случая (production,
tab 1ccc61c912ae, handoff mvxh37m5-6r7ucv):

```text
06:52:34.668  QUEUE_CONSUMED operation=remove source=claude-queue:offset:…:31653423
06:52:34.828  settle: hasSourceIdentity=1  ← у карточки есть точный опознаватель
              ... LOCAL_REMOVE нет вообще ...
07:01:48.567  DURABLE_PRESENTATION_ACK applied=1 ← сняла только перечитка, +9 мин
```

Проверены все четыре слоя: разбор JSONL даёт ОДНУ строку (реплей настоящей
`getFullHistory` по настоящему файлу), живая проекция — одну, их слияние —
одну. Дубль только в четвёртом: локальная карточка Send. Settlement приходит от
потребления очереди, записи Claude в History в этот момент ещё нет (полная
перечитка намеренно отложена на время хода), поэтому сверять не с чем, а
ретроспективно карточку снимала только перечитка после конца хода.

Исправление в `HistoryPanel.tsx`: при `queueStatus === 'sent'` с точным
`sourceIdentity`/`auditEntryUuid` карточка снимается сразу, если каноническая
строка уже видна — в живом потоке или в закоммиченном срезе
(`consumeLocalPromptEntry(..., 'canonical-row-already-visible')`, лог
`LOCAL_RETIRED_BY_CANONICAL`). Это тот же критерий, по которому её снимала
перечитка, поэтому меняется только момент: текста без карточки не остаётся,
запись Claude уже существует. Своя локальная строка доказательством не
считается, одинаковый текст без точного опознавателя — тоже. Тест
`src/renderer/utils/historyCanonicalRetiresLocalCard.actual.test.mjs` 4/4 на
настоящих примитивах идентичности.

### Тот же отброшенный hook подтверждает PasteAudit (01.11.2026)

Второе следствие того же отбрасывания: карточка висела CONFIRMING весь чужой ход
и затем становилась `delivery-unknown`, хотя пользователь видел свой промпт в
Claude Code. PasteAudit ждёт **следующий допущенный** `UserPromptSubmit`, а
единственное событие про это сообщение было отброшено:

```text
05:37:31.642  PasteAudit staged … await=true          (handoff mvxeergg-roqznl)
05:37:31.694  ClaudeHookScope ignored duplicate-prompt-start
05:37:39.643  PasteAudit:TIMEOUT — на транскрипт никто не посмотрел
05:38:30.867  renderer receipt unavailable → delivery-unknown
```

Пост-Enter проверка в этом случае не помогает: при `turnBusy` она откладывается
до конца хода (`deferUntilClaudeTurnIdle`), а ход занят чужой работой на минуты.
Отброшенный hook при этом несёт точный `transcript_path`: он не вправе начать
ход, но доказать доставку вправе. `confirmClaudePasteAuditsFromQueuedHook`
выполняет тот же транскриптный скан, что и остальные пути подтверждения
(`readClaudeUserRecords` + `selectClaudePendingPromptAudit` + общий
`confirmClaudePasteAuditFromTranscriptSelection`), с коротким ограниченным
ретраем на флаш JSONL (0/120/400/1200 мс), без поллинга. Граница `preSubmitBoundary`
и правила причинности прежние: запись, не совпавшая ни с одним ожиданием,
оставляет их pending, а не проваливает. Логи
`[ClaudeQueueContinuation] audit-confirmed|audit scan failed`. Тест
`claude-queued-prompt-audit.actual.test.js` PRE 3/4 → POST 4/4.


## 02.11 — дубль карточки: второй путь прихода канонической строки

Первая правка в этот день подключила снятие локальной карточки к приходу
живой проекции. Этого хватило для короткого хода, но не для длинного: когда
ход завершается, собственная строка Claude приезжает **обновлением с сервера**,
а не живым событием. На том пути проверки не было, и карточка снова висела
рядом с двойником до отложенной перечитки.

Производство, вкладка 1ccc61c912ae, handoff `mvzciw0f-9247op`:

```text
14:20:15.377  LOCAL_APPEND              локальная карточка
14:20:17.214  queueStatus=sending
14:21:33.718  REFRESH_LOCALS            сервер принёс каноническую строку
14:21:33.765  LOCAL_RETIRED_BY_CANONICAL  ← 78 с спустя, отложенной перечиткой
```

Теперь снятие вызывается на обоих путях. В ветке обновления оно планируется
через микрозадачу — внутри редьюсера состояния побочных действий быть не
должно — и выполняется под той же проверкой владельца по тем же точным
опознавателям, что и остальные два места.

## 03.11 — сообщение с картинкой: карточка не снималась

Прежние правки снимали локальную карточку, как только появлялась собственная
строка Claude, — и работали для обычного текста. Сообщение с картинкой
записывается иначе:

```text
queue-operation enqueue                      наша отправка
user        uuid=d84b93b5                    оболочка хода
attachment  uuid=72c64b51  type=queued_command   ← ЭТО лента рисует как
                                                   сообщение пользователя
```

Разбор проецирует такое вложение как `role: 'user'`, поэтому строка в ленте
была и роль совпадала. Не совпал опознаватель: снятие сверяло
`auditProof.entryUuid` — тот uuid, который видел аудит, — а у показанной
строки uuid вложения.

Точное доказательство при этом никуда не девалось: строка-вложение наследует
`sourceIdentity` поглощённой записи очереди, карточка несёт его же в
`providerQueueProof`. Сравнение по тексту, времени или форме содержимого не
нужно и не используется — достаточно искать по обоим опознавателям.
