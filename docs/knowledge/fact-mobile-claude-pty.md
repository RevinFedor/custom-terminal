# Fact: Mobile-web → PTY+Claude tabs

Расширение mobile-web (см. `fact-mobile-web.md`) на работу с **CLAUDE-табами в обычном терминале** (commandType='claude', tabType='terminal') — не SDK. До этого с phone можно было только смотреть JSONL такого таба read-only + форкнуть в SDK; теперь — открывать, отправлять сообщения, Resume после crash'а, переключать модель/effort, останавливать процесс.

Архитектурно это **тот же mobile-web UI** что для SDK-табов — `SDKParamsButton`, `ChatView`, Virtuoso, composer. Под капотом подменяется источник истории, путь отправки, и появляется ещё одна точка управления lifecycle (Resume + Stop).

## Lifecycle states

PTY+Claude-таб для phone имеет четыре состояния (расширены поверх trivial busy/idle SDK):

- **`inactive`** — PTY жив, но внутри shell, не Claude. Либо Claude exit'нулся (Ctrl+C×2, crash, app restart), либо изначально не запускался. JSONL на диске есть (если когда-то была сессия). UI: Resume-баннер вместо composer, серый dot.
- **`starting`** — Claude процесс существует (bridge.json есть, `bridgeKnownSessions.has(tabId)`), но TUI **ещё не отрендерил prompt-символ `⏵`**. Между этими событиями 1-6 секунд. UI: «Starting Claude…» strip вместо composer.
- **`active`** — Claude TUI готов принимать ввод (`⏵` отрендерён хотя бы раз = `claudePromptReady.has(tabId)`). UI: composer открыт, зелёная dot.
- **`busy`** — Claude в середине turn'а (`claudeSpinnerBusy` или `claudeTurnBusy`). UI: composer disabled, янтарная dot, Stop кнопка в header.

Переходы между состояниями — **только** event-driven, без polling:
- `inactive → starting` — Bridge:Fresh (StatusLine bridge.json) → `notifyClaudeSessionAvailable(tabId)`
- `starting → active` — детектор `⏵` в PTY-выводе → `claudePromptReady.add(tabId)` + WS snapshot
- `active ↔ busy` — Stop hook (UserPromptSubmit / Stop / StopFailure) → `claude:busy-state` → WS broadcast
- `* → inactive` — PTY exit / terminal:kill / clearBridgeTab → WS snapshot + reset обоих Set'ов

## REST endpoints (расширение mobile-web)

```
POST /api/projects/:id/claude-tabs           — создать PTY+Claude таб (Terminal.tsx сам spawn'ит claude по pendingAction)
POST /api/projects/:id/agent-tabs            — generic PTY agent create; body {toolType:'claude'|'codex'}
POST /api/sdk-tabs/:tabId/resume             — claude --resume <sid> в существующий PTY
POST /api/sdk-tabs/:tabId/status             — GET тоже — текущий status + sessionId + commandType
POST /api/sdk-tabs/:tabId/send               — sendMessageAuto (single dispatch) — backend сам роутит SDK vs PTY
POST /api/sdk-tabs/:tabId/interrupt          — soft interrupt текущего turn'а (PTY Esc / SDK close warm)
GET  /api/sdk-tabs/:tabId/draft              — authoritative чтение draft'а из TUI composer
POST /api/sdk-tabs/:tabId/stop               — расширен: для PTY делает SIGTERM по claude-child-PID через stopClaudeTab bridge (terminal:stop-ai-process)
```

Все ID — через `decId()` (см. `fact-mobile-web.md::URL-encoded path параметры`).

## Bridge actions

Renderer App.tsx::handleWebBridge новые actions для CLAUDE-PTY:
- `createClaudeTab` — `state.createTab` с `commandType:'claude', pendingAction:{type:'claude-new'}`. **Не зовёт** `claude:spawn-with-watcher` сам — Terminal.tsx mount'нется и обработает pendingAction. Двойной spawn ломал bridge fresh detection.
- `createAgentTab` — generic версия для native iOS picker'а (`toolType:'claude'|'codex'`). Для Claude делает тот же `pendingAction:{type:'claude-new'}`, для Codex — `pendingAction:{type:'codex-new'}`, плюс ставит `color` равным агенту. Это важно: phone-кнопка "New Terminal" не должна сама писать `claude`/`codex` в PTY и обходить desktop launch defaults, session detection и future launch guards. Старый `createClaudeTab` остаётся как совместимый wrapper для mobile-web.
- `resumeClaudeTab` — pre-check через `claude:get-presence`; если **active/busy** → refuse + return `alreadyRunning:true` (Ctrl+U стёр бы typed text на desktop). Иначе `markPendingResume` + `clearInterruptedState` + `\x15claude --dangerously-skip-permissions --resume <sid>\r` в PTY.
- `stopClaudeTab` — `ipcRenderer.invoke('terminal:stop-ai-process', tabId)` (тот же handler что desktop Stop-кнопка). SIGTERM по claude-child-PID, через 800ms эскалация в SIGKILL. Shell PTY жив → Resume в этом же табе работает. Graveyard `\x03+\x03 setTimeout(250ms)` — Ink TUI redraws prompt между Ctrl+C, второй трактуется как новый первый, Claude не выходит. См. `fact-claude-tui-control.md::Mobile preserve-shell Stop`, `fix-claude-busy-detection.md::4`.
- `sendMessageAuto` — единая точка для `/api/sdk-tabs/:id/send`. Раньше было 2 bridge round-trip'а (status check + send) = +50ms latency. Теперь dispatch внутри одного action: если `tab.commandType==='claude' && tab.tabType!=='claude-sdk'` → `terminal:paste {fast:false}`, иначе → `claude-sdk:send-message`.
- `getClaudeTabStatus` / `getClaudeTabStatusBatch` — обёртки над `claude:get-presence` (одиночная и batch). Batch используется в `getProjectTabsLive` для списка табов в проекте.
- `getProjectTabsLive` расширен — для PTY-agent табов отдаёт `sessionStatus` (active/busy/inactive/starting) через agent-runtime adapter, а не через Claude-only presence. В том же ответе передаются desktop `tab.color`, assigned status `statusColor`, project `icon` и `statusMarker` config — native/web клиенты не имеют доступа к `useUIStore`, поэтому сервер обязан отдать уже нормализованные поля.

## fs.watch JSONL tail для live-сообщений

SDK-таб получает live-стрим через `webBroadcast` вызываемый из main на каждом message в `query()` loop. PTY+Claude — нет такого внутреннего callback'а, Claude пишет JSONL сам через append. Решение: при первом WS subscribe на CLAUDE-таб поднимается `fs.watch(filePath)` watcher (`startClaudeTabWatcher` в web-server.js), который при каждом write читает incremental delta и шлёт каждую запись как `{type:'message', message: inner}` — тот же формат что SDK pipeline.

Watcher имеет три неочевидных guard'а:
- **`entry.inflight`** — fs.watch на macOS может fire несколько раз между нашим scheduleRead debounce и `stream.on('end')`. Без guard'а два concurrent reads делят `entry.offset` и пропускают байты (тот же паттерн что в `fix-incremental-reader-race.md`).
- **`entry.leftover`** — если Claude append'ит строку в два write'а, `buf.split('\n')` обрежет JSON в середине → `JSON.parse` бросит → запись потеряна. Незавершённая последняя строка carry-forward'тся в next read.
- **Re-read после end** — `nowSize > entry.offset` после consume → schedule ещё раз. Защищает от записи которая landed между `fs.stat` и нашим чтением (race window ~10ms).

Offset стартует с EOF (`fs.statSync(filePath).size`). Mobile reducer дедупит по uuid, так что повторных broadcast'ов от warm-cache fetch не появится.

## Event-driven session promotion

Когда mobile подписывается на WS для tab у которого ещё **нет sessionId** (Claude только спавнится после `createClaudeTab`), watcher не может стартовать. Раньше был **polling** retry каждые 2 секунды до 60 секунд — костыль.

Сейчас: `claudeTabWatcherPending: Set<tabId>` — таб припаркован в ожидании. Main.js на каждом `claude:session-detected` (4 call sites: Bridge:Fresh, CwdGuard skip, MCP-delegate resume, Claude Runner new) вызывает `_notifyClaudeSession(tabId, sessionId)`. Это:
1. `notifyClaudeSessionAvailable(tabId)` экспорт из web-server → promote pending в живой watcher.
2. `_webBroadcast(tabId, {type:'snapshot', sessionId, sessionStatus:'active'})` → mobile UI получает sessionId моментально без `/status` polling.

Один-выстрел event-driven, никаких retry-таймеров. Edge case: sessionId известен но JSONL ещё не на диске — `fs.watch(~/.claude/projects/)` на корне ждёт появления файла с UUID в имени, при appear → promote.

## Resume guard rails

Mobile-web Resume для CLAUDE-таба обязан соблюдать три инварианта:

1. **Pre-check через `claude:get-presence`** — если status=active/busy, refuse слать `claude --resume`. Ctrl+U в живом Claude TUI стёр бы typed text desktop-пользователя И выкинул бы его из TUI. Юзер видит `alreadyRunning:true`, состояние не меняется.
2. **`markPendingResume(tabId, sessionId)`** — без этого guard'а stale `~/.claude/bridge/<oldSid>.json` (Claude никогда не удаляет свои bridge-файлы) может в первые 15 секунд после Resume stomp sessionId на старый UUID. Mobile-web — пятый writer в реестре (см. `fix-bridge-stale-takeover.md::Layer 4`), наряду с AutoResume, Terminal.tsx Case 2/5, claude-f fork flow.
3. **`state.clearInterruptedState(tabId)`** — Mobile Resume снимает «Сессия была прервана» overlay на desktop. Иначе пользователь увидит stale модалку поверх работающего Claude.

## WS protocol — расширение для PTY+Claude

Поверх существующих SDK событий (`snapshot/message/busy/done`) добавлены поля и события:

- `{type:'snapshot', sessionId, busy, sessionStatus, inputReady}` — `sessionStatus` строка из четырёх состояний, `inputReady` булев флаг (приходит когда `claudePromptReady` flag flip'нулся).
- `{type:'bridge-update', sessionId, model, contextPct}` — main зеркалит `claude:bridge-update` IPC из StatusLine bridge.json (model + context %). Mobile back-derives `usedTokens = window * contextPct / 100`, header pill обновляется live без polling.
- `{type:'busy'/done', busy, sessionId}` — main зеркалит Stop hook в `_webBroadcast` для PTY-табов тоже (раньше только SDK). Без этого composer не блокировался на mobile во время turn'а → race при двойном Send.

## Mobile UI: header pill, Stop, Resume

В header чата для CLAUDE-PTY-табов появляются те же контролы что у SDK:
- **Pill «model · effort»** в центре — `SDKParamsButton` переиспользован. `canParams` open только когда status=active/busy (slash-commands нужен живой prompt).
- **Stop ■** справа от ☰ — красная, видна только когда status=active/busy. Под капотом `Api.stop` который роутит через `stopClaudeTab` bridge → `terminal:stop-ai-process` (SIGTERM по PID, тот же путь что desktop Stop).
- **Context%** под именем таба слева — через `bridge-update` WS event.
- **Resume-баннер** вместо composer когда `claudeSessionId && status==='inactive'`.

`getSDKParams` / `setSDKParams` bridge actions расширены — для PTY-таба читают `bridgeMetadata` (model) + `tab.claudeEffortLocal` (effort), пишут через `claude:send-command` (`/model X`, `/effort Y`). Думать/Think кнопки у SDK на mobile нет, у PTY тоже не добавляем.

## Tab-row: два разных «статуса» на одном поле

В строке вкладки (project tab list) **две независимые оси состояния**, которые легко спутать, потому что desktop и mobile исторически назвали их одинаково `sessionStatus`:

1. **Назначенная категория** (`fact-session-status.md`) — user-assigned маркер dev/bugfix/knowledge/custom. На desktop это `Tab.sessionStatus` = **id** из палитры `useUIStore.sessionStatuses`, цвет резолвится lookup'ом, форма (dot/square) + размер — глобальный `useUIStore.statusMarker`. Хранится в SQLite колонке `tabs.session_status`.
2. **Runtime-состояние** процесса (active/busy/inactive/starting) — из `claude:get-presence`. На mobile поле `tab.sessionStatus` исторически держало **именно это** (runtime), не категорию.

Mobile-web — отдельный SPA, у него **нет** доступа к `useUIStore`/localStorage, где живут палитра и shape. Поэтому оба передаются по проводу из main:
- `GET /api/projects/:id/tabs` теперь отдаёт top-level `statusMarker:{shape,sizePx}` + per-tab `statusId` + **`statusColor`** (хекс, уже зарезолвленный из палитры server-side — телефон не должен знать про палитру). Два пути дают это: DB-path (web-server.js) через bridge-action `getStatusMarkerConfig`, live-Zustand-path (App.tsx `getProjectTabsLive`) — напрямую из `useUIStore.getState()`.
- Левый маркер = **категория** (форма из `statusMarker`, цвет `statusColor`). Когда категория НЕ назначена (или сервер старый, `statusColor` absent) — маркер **не рендерится вообще** (`StatusMarker` возвращает null), как на desktop TabBar (там `sessionStatuses.find()` → undefined → guard, ничего не рисуется). Никакого fallback-dot'а: type-чип уже идентифицирует строку, резервировать слот не нужно. Юзер прямо просил убрать «снежный» серый кружок.
- Runtime ушёл в **фон строки + лоадер справа**, НЕ в левый маркер. `busy` → крутящийся `InlineSpinner` ring (не opacity-пульс, не текст) + background-breathing строки (`@keyframes mob-row-busy`, codec-safe). `active`/`live` → статичная accent-точка. Текстовый лейбл «active/busy/inactive» удалён полностью (был мусором).

**Один `TabRow`, плоский список в desktop-порядке.** Фон строки = desktop `tab.color` (TabColor enum → `tabRowStyle()` зеркалит таблицу `TAB_COLORS` из TabBar.tsx + SDK-claude override 0.20→0.30 alpha). **Рамки НЕТ** — у inactive vertical-вкладок на desktop рамка только индикатор active/selected, неактивные borderless. **Type-чипа (CLAUDE/SDK/DEV) НЕТ** — юзер: «заголовок Claude/SDK убери». **Секций и группировки НЕТ** — раньше список бился на sdkTabs/claudeTabs/otherTabs с заголовками; теперь один `tabs.filter(t=>t.tabId).map()` в порядке как отдаёт сервер. Порядок = desktop: DB `getProjectById` делает `SELECT … ORDER BY position`, live-Zustand-path — insertion order `ws.tabs`. Interactive (SDK/Claude → chat) vs read-only (shell/gemini/прочее) — per-tab предикат `isInteractive()`, влияет только на onTap target, НЕ на раскладку. `tab.color` тоже шлётся обоими server-путями (web-server.js tab-map + getProjectTabsLive). Юзер: «должны отображаться в таком же порядке, в каком внутри десктопного приложения».

Раньше было два дивергентных компонента (`SDKTabRow`/`TerminalTabRow`) → объединены в `TabRow`; ещё раньше `tabKindStyle()` красил по типу (per-type accent bg+border) → выпилен в пользу desktop `tab.color`.

Graceful degrade — обязателен: старый prod-asar (до этих изменений) не шлёт `statusMarker`/`statusColor`/`processBar`/`color` → телефон рисует fallback (no marker, default faint bg, cyan-left strip), ничего не ломается. Новые поля «загораются» только после пересборки хоста.

## Presence: composer busy = turn, не spinner и не alive

`claude:get-presence` (main.js) — **основной** источник `sessionStatus` для mobile (4 call sites в App.tsx bridge: getProjectTabsLive, resume pre-check, getClaudeTabStatus single/batch). Маппинг: `!hasTerm → inactive`; иначе `hasBridge ? (isBusy ? busy : inputReady ? active : starting) : inactive`. Этот `busy` доезжает до телефона через watcher initial-snapshot (`busy: status.status === 'busy'`, web-server.js) и управляет **composer Send↔Stop swap** — кнопка справа от инпута это **turn/loader-контрол**, не process-контрол. (Не **единственный** эмиттер `busy` на телефон — есть второй, `⏵`-детектор; см. ниже «Второй busy-эмиттер».)

`isBusy = claudeTurnBusy` **и только он** (Stop-hook pipeline, `fact-claude-stop-hook.md`: UserPromptSubmit→true / Stop→false). Это эволюция через два бага:

1. **`claudeCliActive` (выпилен).** Process-liveness, SET на запуске Claude, DELETE только на exit/kill — живёт всю сессию **включая idle-at-prompt** (старый комментарий «claudeCliActive empties at the prompt» был ложью). Конфляция: idle-but-alive Claude → presence отдаёт `busy` → composer навсегда Stop.
2. **`claudeSpinnerBusy` (выпилен).** Глиф-эвристика (`✻✳…`, `fix-claude-busy-detection.md`). **False-fire на stale scrollback**: при переоткрытии таба PTY реплеит историю, где ещё висит старый кадр `✻ Brewed for 15m 28s ❯ /` от давно завершённого turn'а → детектор флипает BUSY при `BoundarySM=idle` (НЕ реальный turn, никакого `UserPromptSubmit` хука нет). Хуже: IDLE-грань глифа шлёт `claude:busy-state` только в desktop-renderer (`mainWindow.webContents.send`), **никогда не `_webBroadcast`** → телефон залип на `busy:true` без парного `busy:false`. Глиф умеет отличить «думает» от «не думает», но НЕ умеет отличить активный 15-мин turn от protухшего лейбла завершённого — для composer'а это фатально.

**Канон для mobile presence: `claudeTurnBusy` only.** Глиф и liveness — desktop-вкусовщина, hook — истина. Это РАСХОДИТСЯ с `computeActiveLoaders`/PTY-exit-diag: rebuild/install-gate может пессимистично учитывать `claudeTurnBusy || claudeSpinnerBusy || claudeLocalCommandWatchers`, но всё равно **не** имеет права считать `claudeCliActive` или `terminalCommandState.isRunning` для AI-tab'а blocker'ом. Иначе idle-at-prompt Claude выглядит для iOS как «streaming/loader». get-presence — единственный, кому нужен строго hook, потому что он рулит интерактивной кнопкой, а не блокировкой ребилда.

### Второй busy-эмиттер: `⏵`-детектор (Resume glyph-leak)

`get-presence` — не единственный путь, по которому `busy` доезжает до телефона. Есть **второй** эмиттер: глобальный детектор prompt-символа `⏵` в PTY-выводе (main.js, тот же что промотит `starting → active`). Когда он впервые ловит `⏵` для таба, он сразу шлёт `_webBroadcast({type:'snapshot', inputReady:true, busy, sessionStatus})` — и в первой версии считал `busy: !!claudeSpinnerBusy.get(tabId)`, **тот же глиф** что выпилили из get-presence. Фикс get-presence его не покрывал — это отдельный broadcast, мимо presence-маппинга.

Симптом: после **Resume** через мобилу composer залипал на Stop, лечилось **только refresh** страницы. Механизм: Resume поднимает Claude → PTY реплеит старый скроллбэк, где висит протухший кадр спиннера (`✻ Brewed for 4s` от давно завершённого turn'а) → `claudeSpinnerBusy` ложно `true` → в момент когда `⏵` отрендерился, этот broadcast улетал с `busy:true` → телефон лочил composer. Refresh лечил, потому что свежая загрузка шла через get-presence (уже починенный), а не через `⏵`-snapshot. Фикс — этот broadcast тоже читает `claudeTurnBusy` (`turnBusy ? 'busy' : 'active'`), как и get-presence: **оба** busy-эмиттера на телефон обязаны быть на hook'е, не на глифе. Урок: когда чинишь конфляцию в формуле, прогрепай **все** эмиттеры того же сигнала (`_webBroadcast.*busy`) — один фикс в «главном» источнике оставляет дубль-путь живым, и баг возвращается на узком триггере (тут — Resume).

Разделение, которое юзер сформулировал прямо («кнопка справа от инпута отвечает ТОЛЬКО за лоадер; запущенный процесс — в навбаре»):
- **Composer Send↔Stop** ← `busy` (turn в полёте). Idle-alive Claude → `busy=false` → **Send** доступен.
- **Навбар Stop ■** ← `claudeStatus === 'active' || 'busy'` (процесс жив в PTY). Виден всё время пока Claude up, в т.ч. на idle — это «убить запущенный процесс», отдельный mental action от «прервать turn».

## Composer Stop = turn-interrupt (Esc), навбар Stop = kill (SIGTERM)

Две кнопки — **два разных действия**, не только разная видимость:
- **Composer `stop()`** (App.tsx) → `Api.interrupt` → `POST /api/sdk-tabs/:id/interrupt` → bridge `interruptClaudeTurn` → **одиночный `\x1b` (Esc) в PTY** через `terminal:input`. Claude'ский нативный Esc-handler прерывает генерацию, возвращается к `⏵`-промпту, **процесс жив**. Single `\x1b`, НЕ `\x1b×2` (откроет Rewind-меню) и НЕ `\x03×2` (выйдет из Claude). main.js::`terminal:input` уже спец-обрабатывает single-`\x1b` mid-turn: `armInterruptIdleProbe` (safety net на случай если abort не fire'нет Stop hook — `fix-claude-aborted-streaming-loader.md`). Для SDK-таба `/interrupt` делает `query.close()` (процесс warm).
- **Навбар `onHeaderStop()`** (App.tsx) → `Api.stop` → `POST /api/sdk-tabs/:id/stop` → bridge `stopClaudeTab` → `terminal:stop-ai-process` (Ctrl+C→300ms→SIGTERM→800ms→SIGKILL по claude-child-PID). **Убивает процесс**, shell жив → Resume.

Баг до фикса: composer `stop()` звал `Api.stop` (тот же что навбар) → **тап Stop под инпутом убивал всю Claude-сессию**, хотя должен был только прервать turn. Юзер: *«нажал отправить, потом нажал кнопку остановки, у меня остановилась вся сессия, хотя это должно влиять на отправку инпута»*. Десктоп-аналогия: на desktop PTY-Claude soft-interrupt — это **физический Esc** который юзер жмёт в TUI (нативный Claude), а Stop-кнопка ControlBar'а = kill; на мобиле физического Esc нет, поэтому composer Stop эмулирует Esc программно.

После soft-interrupt мобильный клиент не имеет права возвращать в input последний отправленный prompt из памяти. Он ждёт детерминированный terminal event (`done.reason=interrupt` для Claude, `turn_aborted`/`catch-up-turn_aborted` для Codex), затем делает короткую серию probes `GET /api/sdk-tabs/:id/draft`. Только текст, реально вернувшийся в TUI composer, показывается как restored draft. Если `/draft` пустой, UI показывает нейтральное «отмена подтверждена; terminal input пустой»: это честнее, чем фабриковать prompt из last-sent и расходиться с тем, что увидит сам CLI при resume/reload. Та же логика уже закреплена в desktop `Cmd+\` History для Codex/Claude; mobile обязан переиспользовать этот contract, а не держать отдельную эвристику.

**Hot-reload ловушка при отладке этого** (горело): правка в main.js / web-server.js (bridge action, REST route) **не подхватывается** живым dev-Electron'ом — main-процесс не hot-reload'ится, нужен рестарт dev-инстанса (НЕ хоста: хост = prod 55096 где живёт `mcp__terminal`; dev = отдельный на CDP 9224 / web 7979). А правка в `mobile-web/` **не видна в уже открытой вкладке браузера** пока не сделать hard-reload (`reload bypassCache`) — `navigate` на тот же URL оставляет старый бандл в памяти. Симптом-ловушка: проверяешь фикс, в браузере крутится `index-<СТАРЫЙ-хеш>.js`, в логах летит старое действие (`stopClaudeTab` вместо `interruptClaudeTurn`), думаешь «фикс не сработал» — а это stale bundle. Всегда сверяй `[...document.scripts].map(s=>s.src)` хеш с последним `npm run build`.

## Symptoms (для семантического поиска)

- Открываю CLAUDE-таб с мобилы — composer виден сразу но Send уходит в shell, не в Claude
- После Resume через мобилу desktop показывает «Сессия была прервана» поверх работающего Claude
- Нажал Stop под инпутом на мобиле — убилась вся Claude-сессия, хотя должен был прерваться только текущий ответ
- Composer Stop и навбар Stop делают одно и то же (оба kill) — composer должен soft-interrupt turn, навбар kill процесс
- Создаю новый Claude-tab с мобилы — sessionId никогда не появляется, UI висит на «Starting Claude…»
- Mobile composer не блокируется во время Claude turn → две одновременные отправки → одна теряется
- Stop с мобилы убил весь таб целиком, Resume не возвращает Claude (Ctrl+D вместо Ctrl+C×2)
- Открываю Claude-таб с мобилы, Claude простаивает (turn закончился) — кнопка отправки залипла в Stop, сообщение не отправить
- Composer показывает Stop вместо Send хотя Claude ничего не генерирует; status='busy' при idle-at-prompt
- После Resume через мобилу composer залип на Stop, помогает только обновить страницу (второй busy-эмиттер `⏵`-детектор протёк stale-глиф)
- На мобилке маркер вкладки всегда круг, не уважает настройку квадрат/круг из desktop Статусы
- Цвет назначенного статуса (dev/bugfix) не виден в строке вкладки на телефоне, только runtime-точка
- В строке вкладки на мобилке текст active/busy/inactive — мусорный лейбл, убрать
- SDK и Claude вкладки на мобилке выглядят по-разному, должны отличаться только фоном
- Status badge скачет между active/inactive каждые несколько секунд
- Long-press на CLAUDE-табе в project list работает а на тапе пустой чат (read-only условие игнорирует commandType='claude')

## Code map (неочевидные связи)

- `_notifyClaudeSession` в main.js вызывается из 4 разных call sites (`processFile` cwd-related, CwdGuard skip path, `MCP:Delegate` resume, `Claude Runner` new) — единая точка обновления для mobile WS, никакой дублирующей логики в каждом из них.
- `claudePromptReady` Set обновляется в **одной** точке (PTY data handler, расширенный детектор `⏵`/`>`) — никакого второго writer'а. Cleanup в трёх местах: PTY exit, terminal:kill, clearBridgeTab. **Но** эта же точка — второй эмиттер `busy` на телефон (snapshot при первом `⏵`); он обязан читать `claudeTurnBusy`, не `claudeSpinnerBusy` (Resume glyph-leak, см. секцию «Второй busy-эмиттер»). Любой code path который шлёт `_webBroadcast(...busy...)` — проверь что busy = turn-флаг, не глиф.
- `terminal:paste` IPC по умолчанию `fast=true` (для Gemini/bash). Для Claude bridge action явно передаёт `fast:false` — иначе Ink режет paste на N chip'ов (см. `fact-claude-tui-mechanics.md::Section 4`).
