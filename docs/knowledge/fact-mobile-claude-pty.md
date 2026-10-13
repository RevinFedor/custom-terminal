# Fact: Project Terminal API → PTY agents

Контракт управления **Claude/Codex в обычном PTY** через Project Terminal API. Основной клиент — нативный Terminal Control в Habit Tracker; `mobile-web` остаётся legacy. Телефон отображает runtime/history и отправляет намерения, но Start/Resume, busy-send, draft ownership и provider submit принадлежат общему server scenario layer.

Claude и Codex различаются адаптером TUI, но не публичной моделью lifecycle/delivery. Нативный клиент не повторяет внутреннюю PTY-автоматику и не выводит право Send из одного строкового статуса.

## Lifecycle states

PTY+Claude-таб для phone имеет пять состояний (расширены поверх trivial busy/idle SDK):

- **`inactive`** — PTY жив, но agent process отсутствует. JSONL/rollout может быть materialized или пустым. Explicit Start/Resume остаётся видимым, но обычный Send также может передать намерение серверу: scenario сам выберет fresh start или resume и дождётся безопасной границы.
- **`starting`** — запуск ещё не settled. Это не синоним `inputReady=false`: Resume Goal может уже войти в `task_started`, и ввод тогда доступен через очередь. UI сохраняет starting-индикатор и отдельно следует `inputReady`/server scenario, а не подменяет phase на active.
- **`active`** — Claude TUI готов принимать ввод (`⏵` отрендерён хотя бы раз = `claudePromptReady.has(tabId)`). UI: composer открыт, зелёная dot.
- **`busy`** — подтверждённый turn выполняется (`turnBusy=true`). Composer не становится read-only: новый Send проходит через server queue/send-during-streaming, а Stop прерывает текущий turn. Запрещены только операции, которые действительно нельзя совместить с running turn.
- **`stopping`** — пользователь/API уже попросил убить Claude/Codex process, kill-ladder идёт, но shell/PTY ещё не подтвердил exit. Send/resume/rewind/edit запрещены до финального `inactive`; native/mobile composer остаётся disabled. Desktop при этом не прячет терминал модалкой: показывает компактную top-left плашку, оставляет scroll/selection, но main-side guard отбрасывает raw keyboard/paste до exit. Это не `busy`: `busy` = агент думает и может вернуть prompt, `stopping` = runtime tearing down.

Переходы между состояниями — **только** event-driven, без polling:
- `inactive → starting` — Bridge:Fresh (StatusLine bridge.json) → `notifyClaudeSessionAvailable(tabId)`
- `starting → active` — детектор `⏵` в PTY-выводе → `claudePromptReady.add(tabId)` + WS snapshot
- `active ↔ busy` — Stop hook (UserPromptSubmit / Stop / StopFailure) → `claude:busy-state` → WS broadcast
- `active|busy|starting → stopping` — `terminal:stop-ai-process` / `agent:stopping-state` сразу после stop intent, до SIGTERM/SIGKILL outcome
- `* → inactive` — PTY exit / terminal:kill / clearBridgeTab → WS snapshot + reset обоих Set'ов

## REST endpoints (расширение mobile-web)

```
POST /api/projects/:id/claude-tabs           — создать PTY+Claude таб (Terminal.tsx сам spawn'ит claude по pendingAction)
POST /api/projects/:id/agent-tabs            — generic PTY agent create; body {toolType:'claude'|'codex'}
POST /api/terminal-tabs/:tabId/start              — fresh Claude/Codex runtime в существующей PTY-вкладке, когда сохранённого разговора ещё нет
POST /api/terminal-tabs/:tabId/resume             — claude --resume <sid> в существующий PTY; HTTP 200 доказывает live runtime ready, startup defaults едут отдельными полями
GET  /api/terminal-tabs/:tabId/status             — coherent runtime snapshot с generation/revision
POST /api/terminal-tabs/:tabId/send               — sendAgentPromptScenario; backend сам ведёт Claude/Codex terminal runtime и draft ownership
GET  /api/terminal-tabs/:tabId/send-receipts      — read-only сверка exact handoff без повторной отправки
POST /api/terminal-tabs/:tabId/interrupt          — interruptAgentTurnScenario; soft interrupt текущего turn'а (PTY Esc / Codex abort signal)
GET  /api/terminal-tabs/:tabId/draft              — grabAgentDraftScenario; authoritative чтение draft'а из TUI composer
GET  /api/terminal-tabs/:tabId/draft-state        — inspectAgentDraftScenario; read-only preflight TUI composer
POST /api/terminal-tabs/:tabId/rewind             — rewindAgentTimelineScenario; native `/rewind`/Codex backtrack с auto-resume
POST /api/terminal-tabs/:tabId/history-operations — saved-history Rewind/Delete (v1, providers из capability), общий desktop executor,202 + receipt
GET  /api/terminal-tabs/:tabId/history-operations/:operationId — тот же результат/structured draft без повторной мутации
GET  /api/terminal-tabs/:tabId/history-operations/:operationId/applicability — current owner verdict, отдельно от неизменной квитанции
GET  /api/terminal-tabs/:tabId/pending-question   — текущий AskUserQuestion, если клиент подключился mid-question
POST /api/terminal-tabs/:tabId/answer-question    — ответить или stop на AskUserQuestion
POST /api/terminal-tabs/:tabId/stop               — stopAgentProcessScenario; для PTY делает SIGTERM по AI-child-PID через terminal:stop-ai-process
```

Все ID — через `decId()` (см. `fact-mobile-web.md::URL-encoded path параметры`).

Claude saved-history source14.09 сохраняет прежнюю семантику desktop: same-SID
rewrite, либо `fileDeleted` с атомарно очищенным binding и без Resume удалённого
файла. Мобильный клиент читает `binding.applied/mode/sessionId`, а не требует
Codex `newSessionId`. Возвращённый portable draft идёт по явному Send в общий
serializer, `expectedToolType:claude`; после cleared binding используется явный
null SID. Старый null — wildcard; opt-in `expectedBinding:'none'` + ownerToken
из актуального main proof защищает первый явный Send от чужого нового разговора.
Квитанция прошлого не разрешает переписать более новый composer даже на том же
SID/process: `conversationOwner` и applicability сверяются отдельно. Их own Resume
не снимает, новый ввод снимает; ownerOrder общий у status/SSE/History. Полный
контракт известной пустоты и cold receipt — fact-mobile-web::Применимость поздней квитанции.
Наличие source adapter не является physical CLI/iOS PASS или
авторизацией private target. Полный wire-контракт — fact-mobile-web::Saved-history.

## Runtime, startup defaults и materialized conversation

Нельзя использовать один `sessionId` как доказательство всех прав вкладки. Claude может создать технический UUID и маленький JSONL-файл только со служебными строками (`mode`, `permission-mode`, startup `/model`/`/effort`), но для продукта это ещё не сохранённый разговор. Доказанный контрпример из сессии 2026-07-03: JSONL существовал, Timeline видел `entries=0`, а попытка Resume выглядела как продолжение сессии, которой пользовательски не было.

Поэтому API отдаёт независимые оси: lifecycle, `inputReady`, `turnBusy`, delivery конкретного handoff и transcript materialization (`conversationMaterialized`, `timelineCount`, `materializationReason`, `canResume`, `canCopySessionId`). Fresh Claude до первого prompt может принимать сообщение, но `conversationMaterialized=false`: copy-id скрыт, Timeline пустой без ошибки, Resume после Stop не предлагается. Первый содержательный turn материализует разговор.

Каждый runtime snapshot несёт `lifecycleGeneration` и `runtimeRevision`. `/tabs`, `/status`, initial/tab SSE и project activity используют одну внешнюю нумерацию; iOS применяет их монотонно и не держит 4/8/20-секундные suppression-окна после Stop/Resume/Rewind. Смена process generation сильнее старой revision, а поздний read прежнего запроса не переписывает уже применённое SSE-событие.

Initial JSONL watcher snapshot тоже подчиняется этому правилу. Renderer может
дать watcher'у cwd/метаданные файла, но его status не является lifecycle proof:
подписка способна прочитать старый `starting` уже после main-owned StartupTx
`ready`. Перед broadcast watcher читает цельный `readAgentRuntimeSnapshot`; при
временной недоступности main он сохраняет fs.watch capability, но не публикует
stale renderer status. Поэтому `active revisionN → watcher subscribe` не создаёт
новый `starting revisionN+1`, а легитимный main `starting+inputReady` остаётся.

Startup defaults (`/model`, `/effort`) — отдельная операция поверх live runtime.
Первый prompt-ready ещё не подтверждает настройки. Pending удерживает idle Send;
явный failed завершает ожидание ошибкой настройки, не504 и не ready:true. Прежнее
описание «живой процесс → success/ready даже после defaults failed» было неверным:
сохранённый процесс и выполненный контракт Start/Resume — разные результаты.
Source14.09 также отделяет failed от Starting: доказанный idle CLI остаётся active,
но inputReady=false; настоящий принятый busy-turn сохраняет type-ahead. Закрытие
плашки не меняет ни эти права, ни delivery. Main gate/prompt/project events читают
ту же runtime-проекцию; renderer/API не домешивают старый tab-only gate в новый
launch. См. `fact-claude-tui-control.md::Отказ настройки не является продолжающимся запуском`.

14.09 source retake: Start/Resume/Create/Inbox сохраняют identity принятого launch
вплоть до readiness wait, fresh read и финального ответа. Claude own first OSC-B
не меняет стабильный launch ID. Найденный другой launch даёт
`agent_ready_owner_changed`, не успешный ответ старому запросу и не Close нового
процесса. Main собирает runtime/gate/PID/writer/owner одним проверенным снимком;
смена во время чтения допускает один catch-up, затем503 `runtime_snapshot_unstable`.
Это unknown состояния конкретной вкладки, не offline сервера. Полный снимок
с `coherent:true` владеет и явными null; частичные события сохраняют совместимость,
но не наследуют PID/ready/writer прежнего launch. Пары main/web/renderer должны
обновляться вместе. Нет нового coordinator или ограничения background capability.

Fresh native Create может подписать History и получить `tui-ready` до завершения
параллельного PID-poll. Composer proof в этот момент необходим, но недостаточен:
main setting sender ждёт exact process acceptance, закрепляет единственного Claude
child за тем же terminal/lifecycle/run/launch/input и только затем допускает
`/model`. Он не ждёт sessionId/JSONL, поэтому pre-bridge startup capability
сохраняется. Failed settings публикуют `inputReady=false` и существующие
`manualActionRequired/manualActionType=claude-startup-settings`; process остаётся
active для Stop, но не send-ready.

## Bridge actions

Renderer App.tsx::handleWebBridge actions для PTY-agent табов:
- `createClaudeTab` — `state.createTab` с `commandType:'claude', pendingAction:{type:'claude-new'}`. **Не зовёт** `claude:spawn-with-watcher` сам — Terminal.tsx mount'нется и обработает pendingAction. Двойной spawn ломал bridge fresh detection.
- `createAgentTab` — generic версия для native iOS picker'а (`toolType:'claude'|'codex'`). Desktop-only путь может оставить `pendingAction:{type:'claude-new'|'codex-new'}` до mount'а Terminal, но native/API передаёт `startNow:true`: renderer создаёт tab, сразу запускает Claude/Codex тем же desktop payload'ом и возвращает success только если runtime launch принят. При failed PTY/cwd/run новая вкладка закрывается и bridge возвращает failure; телефон не должен получить "созданный" fresh tab, который на деле уже умер. Это важно: phone-кнопка "New Terminal" не должна сама писать `claude`/`codex` в PTY и обходить desktop launch defaults, session detection и future launch guards. Старый `createClaudeTab` остаётся как совместимый wrapper для mobile-web.
- `resumeClaudeTab` — pre-check через `claude:get-presence`; если **active/busy** → refuse + return `alreadyRunning:true` (Ctrl+U стёр бы typed text на desktop). Иначе `markPendingResume` + `clearInterruptedState` + `\x15claude --dangerously-skip-permissions --resume <sid>\r` в PTY.
- `stopAgentProcessScenario` (`stopClaudeTab` legacy alias) сохраняется для renderer/старых isolated hosts. Paired Project/Inbox HTTP16.09 вызывает напрямую общий `stopAgentProcessScenarioInMain`, который использует тот же serialized owner/authority что `terminal:stop-ai-process` desktop. Сразу `stopping`, затем owned Ctrl+C→300ms scope-exit proof→SIGTERM800ms→SIGKILL300ms; ответ после exact exit/audit, без renderer deadline2s. Потеря HTTP ответа не отменяет Stop/не повторяет его. Shell сохраняется; residual tools/lookup unknown не становятся success. Graveyard клиентский `\x03+\x03 setTimeout(250ms)` не возвращается. См. `fact-claude-tui-control.md::Mobile preserve-shell Stop`, `fix-claude-busy-detection.md::4`.
- `sendAgentPromptScenario` (`sendMessageAuto` legacy alias) — единая точка для `/api/terminal-tabs/:id/send`. Это уже не просто paste: scenario проверяет terminal draft ownership, при inactive выбирает resume или fresh start, при starting присоединяется к уже принятому launch, при busy выбирает очередь, и только затем вызывает runtime-примитив. Claude Send ждёт exact main startup gate без локального15s failure timer: late ready продолжает одну операцию, failed/Stop/replacement завершают её до paste. Клиент не делает предварительный Resume и не ставит lifecycle в busy сам. Project/History/iOS при чужом draft получают structured conflict и не очищают TUI; Inbox имеет отдельный ownership-контракт.
- `interruptAgentTurnScenario`, `grabAgentDraftScenario`, `inspectAgentDraftScenario`, `rewindAgentTimelineScenario` — общие terminal entrypoints для mobile, History и внешнего API. Старые action names оставлены только как совместимость, чтобы старый mobile-web/native build не умер после обновления desktop host.
- `getClaudeTabStatus` / `getClaudeTabStatusBatch` — обёртки над `claude:get-presence` (одиночная и batch). Batch используется в `getProjectTabsLive` для списка табов в проекте.
- `getProjectTabsLive` расширен — для PTY-agent табов отдаёт `sessionStatus` (active/busy/inactive/starting/stopping) через agent-runtime adapter, а не через Claude-only presence. В том же ответе передаются desktop `tab.color`, assigned status `statusColor`, project `icon` и `statusMarker` config — native/web клиенты не имеют доступа к `useUIStore`, поэтому сервер обязан отдать уже нормализованные поля.

Timeline/Rewind не возвращаются к клиентскому text/index matching. Server-normalized строка composite Codex history несёт `entryRef`, aliases и `contentRevision`; `/rewind` проводит tuple через renderer scenario до main, где physical row и revision перепроверяются непосредственно перед первой записью в PTY. Partial tuple, stale revision или другая строка с тем же текстом дают отказ без provider mutation.

## fs.watch JSONL tail для live-сообщений

SDK-таб получает live-стрим через `webBroadcast` вызываемый из main на каждом message в `query()` loop. PTY+Claude — нет такого внутреннего callback'а, Claude пишет JSONL сам через append. Решение: при первом WS subscribe на CLAUDE-таб поднимается `fs.watch(filePath)` watcher (`startClaudeTabWatcher` в web-server.js), который при каждом write читает incremental delta и шлёт каждую запись как `{type:'message', message: inner}` — тот же формат что SDK pipeline.

Watcher имеет три неочевидных guard'а:
- **Main-owned initial lifecycle** — renderer status используется только для
  JSONL/cwd fallback. В lifecycle snapshot попадает coherent main runtime; если
  он unknown/unavailable, watcher читает файл без выдуманного status.
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
4. **Ready proof перед HTTP 200.** `/api/terminal-tabs/:tabId/resume` не должен отвечать success сразу после `bridgeRequest('resumeClaudeTab')`: bridge-ack доказывает только запись команды, не готовность CLI. Deadline без результата даёт504; явная ошибка `/model`/`/effort` завершает ожидание сразу отдельной ошибкой настройки. Живой процесс после отказа не считается успешным ready и не должен выглядеть вечно Starting; его состояние возвращается отдельно. Обе оси описаны выше в «Runtime, startup defaults и materialized conversation».

## WS protocol — расширение для PTY+Claude

Поверх существующих SDK событий (`snapshot/message/busy/done`) добавлены поля и события:

- `{type:'snapshot', sessionId, sessionStatus, inputReady, turnBusy, lifecycleGeneration, runtimeRevision}` — один versioned runtime snapshot. Для `stopping` `inputReady=false`; `starting + inputReady=true` и `busy + inputReady=true` валидны и не схлопываются в active.
- `{type:'bridge-update', sessionId, model, contextPct}` — main зеркалит `claude:bridge-update` IPC из StatusLine bridge.json (model + context %). Mobile back-derives `usedTokens = window * contextPct / 100`, header pill обновляется live без polling.
- `{type:'busy'/done', busy, sessionId}` — main зеркалит Stop hook в `_webBroadcast` для PTY-табов тоже (раньше только SDK). Без этого composer не блокировался на mobile во время turn'а → race при двойном Send.

## Mobile UI: header pill, Stop, Resume

Историческое описание UI ниже относится к legacy mobile-web. Native разделяет
короткий busy Interrupt и process Stop, в том числе во время запуска. Source11.10
`pendingSends` companion отменяет будущий ввод независимо от `processStop` и не
превращает unknown прошлой доставки в no-Enter. Полный wire/границы —
`fact-terminal-mcp.md::Main FIFO принятых Send`; native/поставка этим чтением
исходников не проверены.

В header чата для CLAUDE-PTY-табов появляются те же контролы что у SDK:
- **Pill «model · effort»** в центре — `SDKParamsButton` переиспользован. `canParams` open только когда status=active/busy (slash-commands нужен живой prompt).
- **Stop ■** справа от ☰ — красная, видна только когда status=active/busy/starting. Под капотом `Api.stop` который роутит через `stopClaudeTab` bridge → `terminal:stop-ai-process` (SIGTERM по PID, тот же путь что desktop Stop). После клика status становится `stopping`; кнопка и composer блокируются до `inactive`.
- **Context%** под именем таба слева — через `bridge-update` WS event.
- **Resume-баннер** вместо composer только когда server сказал `canResume=true` (`conversationMaterialized=true` + runtime inactive). Если runtime inactive, но разговор ещё не materialized, показывается Start Claude/Start Codex в стиле Resume: это fresh runtime start, а не восстановление пустого технического UUID.

`getSDKParams` для Claude PTY читает через main подтверждённую модель JSONL-ветки
и effort текущего процесса; bridge label и renderer sentinel не становятся proof.
`setSDKParams` передаёт всю запрошенную пару одному main applySettings owner,
как ControlBar, а не двум независимым slash-вызовам. При partial отказе
POST `/params` возвращает409 и optional `appliedSettings` (только подтверждённые
model/effort этой попытки), `failedCommand` и `code`; это не успех всей пары и
не обещание, что более поздний запрос ещё не сменил настройку. Без точного
bridge-ответа в legacy POST без requestId эти поля отсутствуют: timeout не означает
«ничего не применено». Source15.09 добавляет для Claude отдельную re-queryable
квитанцию с requestId; см. раздел ниже. Это не новый native/installed прогон.
SDK-ветка не изменялась.

Для Codex native picker обязан повторять desktop-разделение busy-state: model и effort можно менять во время streaming, но это настройка следующего turn'а, а не текущего ответа. Effort не отправляется отдельной «сырой» slash-командой; iOS вызывает тот же desktop scenario/native picker, ждёт success-result и только потом показывает короткий applied-state по аналогии с Fast. Если `/api/agent-models` пришёл от старого Mac build без `controlCapabilities.codexEffortPicker`, iOS ограничивает effort исторически безопасным набором и не показывает `max/ultra` как кликабельные.

## Контекст-% и список моделей: единый снапшот, не разрозненные каналы

`getSDKParams` (GET `/params`) отдаёт модель, effort, Think и contextPct одним
ответом: прежний отдельный SSE-only процент появлялся лишь через ~30с после
модели. Source15.09 собирает PTY-снимок в main, чтобы async renderer не смешивал
разные владельцы. Claude/Codex context берётся из exact provider/session
наблюдения, иначе явно помечается SQLite last-known;0 — корректное значение.
Bridge display metadata без owner-stamp не является таким proof. SDK сохраняет
свой `tab.contextPct`, `/api/projects/:id/tabs` — seed до входа в чат, SSE —
дальнейшие дельты. Source/known/owner и nullable observed model variant отделяют
текущую правду от intent/истории. Для потерянного Claude params POST есть отдельная
stable-requestId квитанция, не повтор через клиентский Enter; wire/совместимость —
`fact-mobile-web.md::Квитанция настройки после потери ответа`.
Изменение подтверждённых Claude model/effort и изменение context имеют отдельные
монотонные смысловые ревизии. Поэтому context `20→50→20` во время чтения не
выглядит неизменным только из-за совпавших крайних значений: main перечитывает
весь снимок либо возвращает типизированное «состояние меняется». Кадры анимации
и timestamp heartbeat эти ревизии не увеличивают.

Список моделей для native — `GET /api/agent-models` (прямой роут, без bridge: `listCodexModels()` живёт в main). Возвращает `{codex:[{id,label,efforts}], claude:[{id,label}]}` — Codex из live `codex debug models` (кэш 5 мин), Claude из `claudeLevels.ts` литерала, инлайн-зеркалом в `web-server.js`. Native строит пикер из ответа с фолбэком на свой хардкод; раньше iOS хардкодил 2 модели Codex и показывал не весь аккаунт. Роут вставлен **до** цепочки `let m =` (прямой `pathname ===`, не трогает `m`) — иначе TDZ-шрам `fact-mobile-web.md::Гочи let m`.

## Tab-row: два разных «статуса» на одном поле

В строке вкладки (project tab list) **две независимые оси состояния**, которые легко спутать, потому что desktop и mobile исторически назвали их одинаково `sessionStatus`:

1. **Назначенная категория** (`fact-session-status.md`) — user-assigned маркер dev/bugfix/knowledge/custom. На desktop это `Tab.sessionStatus` = **id** из палитры `useUIStore.sessionStatuses`, цвет резолвится lookup'ом, форма (dot/square) + размер — глобальный `useUIStore.statusMarker`. Хранится в SQLite колонке `tabs.session_status`.
2. **Runtime-состояние** процесса (active/busy/inactive/starting/stopping) — из `claude:get-presence` / generic agent presence. На mobile поле `tab.sessionStatus` исторически держало **именно это** (runtime), не категорию.

Mobile-web — отдельный SPA, у него **нет** доступа к `useUIStore`/localStorage, где живут палитра и shape. Поэтому оба передаются по проводу из main:
- `GET /api/projects/:id/tabs` теперь отдаёт top-level `statusMarker:{shape,sizePx}` + per-tab `statusId` + **`statusColor`** (хекс, уже зарезолвленный из палитры server-side — телефон не должен знать про палитру). Два пути дают это: DB-path (web-server.js) через bridge-action `getStatusMarkerConfig`, live-Zustand-path (App.tsx `getProjectTabsLive`) — напрямую из `useUIStore.getState()`.
- Левый маркер = **категория** (форма из `statusMarker`, цвет `statusColor`). Когда категория НЕ назначена (или сервер старый, `statusColor` absent) — маркер **не рендерится вообще** (`StatusMarker` возвращает null), как на desktop TabBar (там `sessionStatuses.find()` → undefined → guard, ничего не рисуется). Никакого fallback-dot'а: type-чип уже идентифицирует строку, резервировать слот не нужно. Юзер прямо просил убрать «снежный» серый кружок.
- Runtime ушёл в **фон строки + лоадер справа**, НЕ в левый маркер. `busy` → крутящийся `InlineSpinner` ring (не opacity-пульс, не текст) + background-breathing строки (`@keyframes mob-row-busy`, codec-safe). `active`/`live` → статичная accent-точка. Текстовый лейбл «active/busy/inactive» удалён полностью (был мусором).

**Один `TabRow`, плоский список в desktop-порядке.** Фон строки = desktop `tab.color` (TabColor enum → `tabRowStyle()` зеркалит таблицу `TAB_COLORS` из TabBar.tsx + SDK-claude override 0.20→0.30 alpha). **Рамки НЕТ** — у inactive vertical-вкладок на desktop рамка только индикатор active/selected, неактивные borderless. **Type-чипа (CLAUDE/SDK/DEV) НЕТ** — юзер: «заголовок Claude/SDK убери». **Секций и группировки НЕТ** — раньше список бился на sdkTabs/claudeTabs/otherTabs с заголовками; теперь один `tabs.filter(t=>t.tabId).map()` в порядке как отдаёт сервер. Порядок = desktop: DB `getProjectById` делает `SELECT … ORDER BY position`, live-Zustand-path — insertion order `ws.tabs`. Interactive (SDK/Claude → chat) vs read-only (shell/gemini/прочее) — per-tab предикат `isInteractive()`, влияет только на onTap target, НЕ на раскладку. `tab.color` тоже шлётся обоими server-путями (web-server.js tab-map + getProjectTabsLive). Юзер: «должны отображаться в таком же порядке, в каком внутри десктопного приложения».

Раньше было два дивергентных компонента (`SDKTabRow`/`TerminalTabRow`) → объединены в `TabRow`; ещё раньше `tabKindStyle()` красил по типу (per-type accent bg+border) → выпилен в пользу desktop `tab.color`.

Graceful degrade — обязателен: старый prod-asar (до этих изменений) не шлёт `statusMarker`/`statusColor`/`processBar`/`color` → телефон рисует fallback (no marker, default faint bg, cyan-left strip), ничего не ломается. Новые поля «загораются» только после пересборки хоста.

## Presence: composer busy = turn, не spinner и не alive

### Восстановление неудачного наблюдения — 19.09

В desktop History `unknown` после завершившегося неудачного чтения — конечное
«НЕ ПРОВЕРЕНО», а индикатор проверки живёт только пока действительно выполняется
чтение. Шрам tab171: первое `ps` после запуска упало, последующие общие снимки
уже были успешны, но mounted History несколько минут оставалась Checking.
Main теперь помнит только exact PTY/run/launch/cwd scope неудачного Claude-read;
следующий текущий успешный snapshot инвалидирует его failed cache и будит
`agent:process-observation`. History перечитывает ту же presence; событие не
содержит придуманного ready/absent и не меняет writer или доставку. Отброшенный
snapshot/другая PTY не будит старого владельца. Возврат в окно также делает один
read-only catch-up неизвестного статуса. Дополнительного polling/таймера нет.

Поздний ответ чтения не сильнее уже полученного события запуска/готовности/выхода.
Эти события инвалидируют начатое чтение в History; существующий flight дочитывает
актуальное поколение. Иначе `command-started → starting → старый inactive` снова
останавливал бы рабочую вкладку только в UI. Подтверждено actual callback-тестами
с управляемой доставкой; такой порядок Electron IPC не объявлен отдельным live
инцидентом. Легитимный `starting + inputReady` не заменяется искусственным active.

### Process Stop до передачи History Send — 19.09

Локальное намерение Send существует раньше handoff/PTY-сценария. Ранние return
(пустой ввод, недоступная картинка, неверное состояние/вопрос) раньше оставляли
coordinator token, потому что его освобождал только ещё не вызванный общий Send.
Клик Stop затем ждал его бесконечно: в tab134 был Stopping больше трёх часов
при полном отсутствии main Stop. Каждый выход теперь освобождает свой exact
token. Stop при ещё не привязанном handoff сразу идёт через прежний process
stopper; поздняя подготовка не может связать отменённый token и отправить текст.
Stop и finally разделяют одно settlement; `inactive` — только после его proof.
После handoff сохраняются прежние cancel-at-write и queued-stop границы.
Это общая History-механика для Claude/Codex; новый runner не добавлен.

Настоящий draft conflict остаётся остановкой Send с сохранением ввода. В tab171
18.09 helper действительно забрал другой 30-символьный draft; новый174-символьный
prompt не был вставлен, rollback сохранил оба текста. Ни stopped UI, ни таймер
не разрешают обойти этот guard. Не путать этот исход с Checking или потерей Stop.

### Источники busy

`claude:get-presence` (main.js) — **основной** источник `sessionStatus` для mobile (4 call sites в App.tsx bridge: getProjectTabsLive, resume pre-check, getClaudeTabStatus single/batch). Маппинг: если `agent:get-stopping-state` говорит stopping → `stopping`; иначе `!hasTerm → inactive`; иначе `hasBridge ? (isBusy ? busy : inputReady ? active : starting) : inactive`. Initial watcher больше не ретранслирует этот renderer-wrapper как отдельную истину: перед broadcast он читает тот же coherent main runtime, что `/status`. Его `busy` управляет **composer Send↔Stop swap** — кнопка справа от инпута это **turn/loader-контрол**, не process-контрол. (Не **единственный** эмиттер `busy` на телефон — есть второй, `⏵`-детектор; см. ниже «Второй busy-эмиттер».)

`isBusy = claudeTurnBusy` **и только он** (Stop-hook pipeline, `fact-claude-stop-hook.md`: UserPromptSubmit→true / Stop→false). Это эволюция через два бага:

1. **`claudeCliActive` (выпилен).** Process-liveness, SET на запуске Claude, DELETE только на exit/kill — живёт всю сессию **включая idle-at-prompt** (старый комментарий «claudeCliActive empties at the prompt» был ложью). Конфляция: idle-but-alive Claude → presence отдаёт `busy` → composer навсегда Stop.
2. **`claudeSpinnerBusy` (выпилен).** Глиф-эвристика (`✻✳…`, `fix-claude-busy-detection.md`). **False-fire на stale scrollback**: при переоткрытии таба PTY реплеит историю, где ещё висит старый кадр `✻ Brewed for 15m 28s ❯ /` от давно завершённого turn'а → детектор флипает BUSY при `BoundarySM=idle` (НЕ реальный turn, никакого `UserPromptSubmit` хука нет). Хуже: IDLE-грань глифа шлёт `claude:busy-state` только в desktop-renderer (`mainWindow.webContents.send`), **никогда не `_webBroadcast`** → телефон залип на `busy:true` без парного `busy:false`. Глиф умеет отличить «думает» от «не думает», но НЕ умеет отличить активный 15-мин turn от protухшего лейбла завершённого — для composer'а это фатально.

**Канон для mobile presence: `claudeTurnBusy` only.** Глиф и liveness — desktop-вкусовщина, hook — истина. Это РАСХОДИТСЯ с `computeActiveLoaders`/PTY-exit-diag: rebuild/install-gate может пессимистично учитывать `claudeTurnBusy || claudeSpinnerBusy || claudeLocalCommandWatchers`, но всё равно **не** имеет права считать `claudeCliActive` или `terminalCommandState.isRunning` для AI-tab'а blocker'ом. Иначе idle-at-prompt Claude выглядит для iOS как «streaming/loader». get-presence — единственный, кому нужен строго hook, потому что он рулит интерактивной кнопкой, а не блокировкой ребилда.

### Второй busy-эмиттер: `⏵`-детектор (Resume glyph-leak)

`get-presence` — не единственный путь, по которому `busy` доезжает до телефона. Есть **второй** эмиттер: глобальный детектор prompt-символа `⏵` в PTY-выводе (main.js, тот же что промотит `starting → active`). Когда он впервые ловит `⏵` для таба, он сразу шлёт `_webBroadcast({type:'snapshot', inputReady:true, busy, sessionStatus})` — и в первой версии считал `busy: !!claudeSpinnerBusy.get(tabId)`, **тот же глиф** что выпилили из get-presence. Фикс get-presence его не покрывал — это отдельный broadcast, мимо presence-маппинга.

Симптом: после **Resume** через мобилу composer залипал на Stop, лечилось **только refresh** страницы. Механизм: Resume поднимает Claude → PTY реплеит старый скроллбэк, где висит протухший кадр спиннера (`✻ Brewed for 4s` от давно завершённого turn'а) → `claudeSpinnerBusy` ложно `true` → в момент когда `⏵` отрендерился, этот broadcast улетал с `busy:true` → телефон лочил composer. Refresh лечил, потому что свежая загрузка шла через get-presence (уже починенный), а не через `⏵`-snapshot. Фикс — этот broadcast тоже читает `claudeTurnBusy` (`turnBusy ? 'busy' : 'active'`), как и get-presence: **оба** busy-эмиттера на телефон обязаны быть на hook'е, не на глифе. По той же причине failed Stop не восстанавливает `busy` из сохранённого spinner: если authoritative `turnBusy=false`, процесс может остаться живым, но ответ считается idle. Урок: когда чинишь конфляцию в формуле, прогрепай **все** эмиттеры того же сигнала (`_webBroadcast.*busy`) — один фикс в «главном» источнике оставляет дубль-путь живым, и баг возвращается на узком триггере (тут — Resume или ошибка Stop).

Разделение, которое юзер сформулировал прямо («кнопка справа от инпута отвечает ТОЛЬКО за лоадер; запущенный процесс — в навбаре»):
- **Composer Send↔Stop** ← `busy` (turn в полёте). Idle-alive Claude → `busy=false` → **Send** доступен.
- **Навбар Stop ■** ← `claudeStatus === 'active' || 'busy'` (процесс жив в PTY). Виден всё время пока Claude up, в т.ч. на idle — это «убить запущенный процесс», отдельный mental action от «прервать turn».

## Composer Stop = turn-interrupt (Esc), навбар Stop = kill (SIGTERM)

Актуальный native-контракт14.09: `/interrupt` идёт через общий
interruptAgentTurnScenario и provider-owned PTY lock, не синтетический второй
Enter. `interruptRequested:true`/legacy `interrupted:true` подтверждает только
запись Escape текущему turn. Idle/сменившийся turn/повтор дают явный skipped;
ничего не доказывается таймером. Уже committed native queue может немедленно
запустить successor: его busy/session/turn события нельзя перекрывать старым
STOPPING или считать подтверждением всех pending сообщений.

`/stop` завершает exact process scope (Ctrl+C→TERM→KILL при необходимости),
публикует stopping→inactive после проверки выхода и оставляет shell/историю.
Codex close watcher делает final audit drain; Claude bridge clear запускает
финальное чтение своих staged audit boundaries. Сверка асинхронна и может
закончиться после HTTP stop response: stopped не означает confirmed для каждого
handoff. Native перечитывает exact send receipt; unknown/missing не разрешает
повтор POST. Ошибка процесса/lookup/residual descendants не изображается успехом.

`/draft` остаётся owned Grab текущего native composer, не пассивным снимком и не
последним отправленным prompt. Не вызывать его по одному interrupt ACK и не
забирать input уже работающего successor. Описанные ниже probes — исторический
legacy-flow; для native restore нужна текущая turn/session/idle identity и
реальный draft, без цикла клиентских повторов и без синтетического last-sent.

### Историческая проводка legacy mobile-web

Две кнопки — **два разных действия**, не только разная видимость:
- **Composer `stop()`** (App.tsx) → `Api.interrupt` → `POST /api/terminal-tabs/:id/interrupt` → bridge `interruptClaudeTurn` → **одиночный `\x1b` (Esc) в PTY** через `terminal:input`. Claude'ский нативный Esc-handler прерывает генерацию, возвращается к `⏵`-промпту, **процесс жив**. Single `\x1b`, НЕ `\x1b×2` (откроет Rewind-меню) и НЕ `\x03×2` (выйдет из Claude). main.js::`terminal:input` уже спец-обрабатывает single-`\x1b` mid-turn: `armInterruptIdleProbe` (safety net на случай если abort не fire'нет Stop hook — `fix-claude-aborted-streaming-loader.md`). Для SDK-таба `/interrupt` делает `query.close()` (процесс warm).
- **Навбар `onHeaderStop()`** (App.tsx) → `Api.stop` → `POST /api/terminal-tabs/:id/stop` → bridge `stopClaudeTab` → `terminal:stop-ai-process` (Ctrl+C→300ms→SIGTERM→800ms→SIGKILL по claude-child-PID). **Убивает процесс**, shell жив → Resume.

Баг до фикса: composer `stop()` звал `Api.stop` (тот же что навбар) → **тап Stop под инпутом убивал всю Claude-сессию**, хотя должен был только прервать turn. Юзер: *«нажал отправить, потом нажал кнопку остановки, у меня остановилась вся сессия, хотя это должно влиять на отправку инпута»*. Десктоп-аналогия: на desktop PTY-Claude soft-interrupt — это **физический Esc** который юзер жмёт в TUI (нативный Claude), а Stop-кнопка ControlBar'а = kill; на мобиле физического Esc нет, поэтому composer Stop эмулирует Esc программно.

После soft-interrupt мобильный клиент не имеет права возвращать в input последний отправленный prompt из памяти. Он ждёт детерминированный terminal event (`done.reason=interrupt` для Claude, `turn_aborted`/`catch-up-turn_aborted` для Codex), затем делает короткую серию probes `GET /api/terminal-tabs/:id/draft`. Только текст, реально вернувшийся в TUI composer, показывается как restored draft. Если `/draft` пустой, UI показывает нейтральное «отмена подтверждена; terminal input пустой»: это честнее, чем фабриковать prompt из last-sent и расходиться с тем, что увидит сам CLI при resume/reload. Та же логика уже закреплена в desktop `Cmd+]` History для Codex/Claude; mobile обязан переиспользовать этот contract, а не держать отдельную эвристику.

**Hot-reload ловушка при отладке этого** (горело): правка в main.js / web-server.js (bridge action, REST route) **не подхватывается** живым dev-Electron'ом — main-процесс не hot-reload'ится, нужен рестарт dev-инстанса (НЕ хоста: хост = prod 55096 где живёт `mcp__terminal`; dev = отдельный на CDP 9224 / web 7979). А правка в `mobile-web/` **не видна в уже открытой вкладке браузера** пока не сделать hard-reload (`reload bypassCache`) — `navigate` на тот же URL оставляет старый бандл в памяти. Симптом-ловушка: проверяешь фикс, в браузере крутится `index-<СТАРЫЙ-хеш>.js`, в логах летит старое действие (`stopClaudeTab` вместо `interruptClaudeTurn`), думаешь «фикс не сработал» — а это stale bundle. Всегда сверяй `[...document.scripts].map(s=>s.src)` хеш с последним `npm run build`.

## Symptoms (для семантического поиска)

- Открываю CLAUDE-таб с мобилы — composer виден сразу но Send уходит в shell, не в Claude
- После Resume через мобилу desktop показывает «Сессия была прервана» поверх работающего Claude
- Нажал Stop под инпутом на мобиле — убилась вся Claude-сессия, хотя должен был прерваться только текущий ответ
- Composer Stop и навбар Stop делают одно и то же (оба kill) — composer должен soft-interrupt turn, навбар kill процесс
- Создаю новый Claude-tab с мобилы — sessionId никогда не появляется, UI висит на «Starting Claude…»
- Нажал Start/Resume с iOS — вкладка бесконечно показывает `starting`, хотя HTTP `/resume` уже вернул success
- Остановил Claude до первого prompt — iPhone показывает Resume или copy-id, хотя сохранённого разговора нет
- После `New → Claude` на iPhone `/model` или `/effort` мелькает в истории и исчезает после reload
- В History на iPhone slash-команда видна слитно (`/modelHaiku`, `/effortLow`) вместо `/model haiku` / `/effort low`
- После ответа Claude thinking пропал, но assistant-текст появился только через секунду — `done` перепутали с published history
- После Resume/Start следующий prompt попал в `Choose working directory` / update prompt вместо composer
- Нажал Stop/Close на Claude/Codex, но iOS/History сразу показывает input или Resume до реального exit — пропущен runtime `stopping`
- Новый prompt во время Claude/Codex turn блокируется клиентом вместо server queue или теряет точную позицию
- После foreground поздний `/status` откатывает уже применённый SSE busy/active либо возвращает старую session generation
- Два одинаковых prompt усыновляют одну локальную строку по тексту вместо exact handoff/UUID/source identity
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
