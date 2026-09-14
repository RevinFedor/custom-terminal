# Fact: Mobile / Project Terminal API

Этот файл про **общий REST/SSE contract Project Terminal API**, а не про актуальный React-клиент. `mobile-web/` — legacy SPA и сейчас не используется как пользовательский iOS-клиент; production iOS surface — нативный Habit Tracker Terminal mode (`/Users/fedor/Desktop/vs-code/habit-tracker`). Название файла историческое: здесь остаются серверные endpoint'ы, bridge-инварианты и legacy-шрамы, потому что ими пользуются и старый web-клиент, и native iOS.

Параллельный режим работы с проектными terminal-вкладками через native iOS и старый mobile-web. Сервер живёт в main process Electron (port 7878), canonical REST для Claude/Codex PTY — `/api/terminal-tabs/:tabId/*`. Старые `/api/projects/:id/sdk-tabs` и `/api/inbox/sdk-tabs` относятся только к созданию legacy Claude SDK tab; они не являются именем Project Terminal API.

Authenticated `GET /api/me` — ещё и точный process/listener proof. Поле `service` содержит `name:"noted-terminal"`, PID/instance, `state/listening`, preferred/resolved port, timestamps, bind conflicts и последний API request; capability — `mobileDiagnostics.version=1`. `getInfo().running` означает именно `httpServer.listening`, а не просто созданный JS-объект сервера. Это позволяет внешней диагностике отличить закрытый app, сорванный listen и port-walk; UI-процесс или старый discovery-файл не заменяют этот proof.

## Почему НЕ cloud-хостинг

`query()` из `@anthropic-ai/claude-agent-sdk` запускает Claude Code subprocess **локально** с `cwd: project.path`, читает файлы пользователя, пишет JSONL в `~/.claude/projects/<slug>/`. На удалённой машине этот процесс не имеет доступа к локальной FS пользователя — а это и есть главный value (работа с реальными проектами с телефона). Поэтому сервер обязан быть локально, на том же устройстве где запущено приложение. Trade-off: ПК должен быть включён и в той же Wi-Fi что телефон.

## Bridge pattern: main ↔ renderer

Часть REST-эндпоинтов требует **живого renderer state** (Zustand store с открытыми проектами и табами). Main не имеет доступа к store напрямую. Решение — request/reply IPC bridge:

1. Main: `bridgeRequest(action, payload, timeoutMs=5000)` спавнит `requestId`, шлёт `web:bridge-request` в renderer, ждёт ответа на `web:bridge-reply` с тем же id.
2. Renderer: один listener в `App.tsx` диспатчит по action — `getOpenProjectIds`, `createSDKTab`, `sendSDKMessage`, `loadSDKHistory`, `forkToTab`, `forkToSDK`, `closeTab`, `renameTab`, `renameProject` (мобильный rename проекта → `useProjectsStore.updateProject{name}`), `getSDKParams`, `setSDKParams`, `getTabSessionInfo`, `getAppSettings`, `setAppSettings`. Расширение для PTY+Claude/Codex: `createClaudeTab` (legacy wrapper), `createAgentTab` (generic PTY agent), `resumeClaudeTab`, scenario-actions `sendAgentPromptScenario` / `stopAgentProcessScenario` / `interruptAgentTurnScenario` / `grabAgentDraftScenario` / `inspectAgentDraftScenario` / `rewindAgentTimelineScenario` с legacy aliases (`sendMessageAuto`, `stopClaudeTab`, `interruptClaudeTurn`, `grabAgentDraft`, `inspectAgentDraft`, `rewindAgentTimeline`), `getClaudeTabStatus`, `getClaudeTabStatusBatch`, `getProjectTabsLive` (отдаёт `sessionStatus`, project `icon`, `statusMarker`). Детали — `fact-mobile-claude-pty.md`.
3. Таймаут bridge не доказывает отмену уже начатой операции. Legacy routes могут
   вернуть 409; receipt-backed Send и saved-history actions сохраняют неизвестный
   исход и требуют чтения того же receipt, не повторения действия.

**Критично:** bridge нужен ТОЛЬКО для actions, требующих store. Чисто-серверные operations (timeline parse через `parseTimelineEntries`, projects list из SQLite через `projectManager.db.getAllProjects()`) идут напрямую без bridge — это и быстрее, и работает даже если renderer mounted с задержкой.

Transcript operations теперь отдельный pure-server слой: Timeline/History snapshots и Codex mobile messages идут через `SessionTranscriptService`, а не через renderer bridge и не через per-client polling. Bridge остаётся для tab/store actions; durable transcript read/invalidation принадлежит main process, потому что тем же данным пользуются desktop Timeline, Cmd+] HistoryPanel, Project Terminal API и native iOS. См. `fact-transcript-сервис.md`.

Слой terminal primitives остаётся ниже API: нажать клавишу, вставить текст, остановить процесс, прочитать TUI draft/JSONL. Project API (`/api/terminal-tabs/:tabId/*`), History/iOS и Inbox API не должны заново собирать send-during-streaming, stopped-session rewind или draft-conflict из этих примитивов; web-server вызывает scenario-action, а тот уже доказывает readiness, решает ownership draft и ждёт durable terminal signal. Это защищает будущий iOS/History переход: при смене парсинга xterm/PTY или момента JSONL-audit внешний контракт меняется только если меняются сами статусы/поля API, а не из-за внутренней механики отправки.

## External Research orchestration

`POST /api/external-research/orchestrations` запускает browser-консультацию,
которой физически владеет SC Desktop, но связь с вызывающей terminal-сессией
владеет Noted Terminal. Тело содержит `sourceTabId`, `prompt`, `provider`,
`options`, file descriptors, опциональные `runId`, `conversationUrl` либо
`continueFromRunId`. Ответ202 возвращает durable `runId`, детерминированный SC
`jobId` и обычные orchestration URLs; он не означает готовый browser answer.

Main проверяет SC capability idempotent request ID до создания нового run,
сохраняет intent до side effect и самостоятельно long-poll'ит существующий
`/research-status`. SC получает прежнюю форму
`{requestId:jobId,provider,prompt,options,files,conversationUrl}`; прямой
SC HTTP/bash-клиент не меняется. После restart Noted восстанавливает monitor по
run-store, а не повторяет запрос с новым ID.

Статус и результат остаются в общих endpoint'ах:
`GET /api/orchestrations/:runId` и
`GET /api/orchestrations/:runId/result`. Result-ответ для browser-run содержит
`assistantText`, structured `externalResult`, `jobId`, `conversationUrl` и
`conversationId`. Follow-up создаётся новым POST с `continueFromRunId`: сервер
берёт conversation URL завершённого запуска, но выдаёт новые run/job IDs.
`GET /api/me.capabilities.externalResearchOrchestration.version=1` является
deployment gate для Terminal MCP; новый wrapper рядом со старым app обязан
отказать до mutation.

Browser `done|error` и доставка короткого source notification — независимые
исходы. Уведомление проходит общий agent send/receipt и не очищает чужой draft;
при `waiting-for-input/failed/unconfirmed` готовый result всё равно читается по
runId. В active loaders внешний run блокирует completion source, после принятия
SC даёт inherited activity, но никогда не создаёт target-tab loader.

## Saved-history Rewind/Delete для Timeline внешнего клиента

По требованию пользователя13.09 мобильный Timeline должен вызывать обычный
desktop JSONL-Rewind, а не native backtrack или AI-сжатие. Это additive API;
старый `/rewind` с `mode: native|ai`, его pending/recovery и старый Inbox route
не переопределяются. Capability `/api/me.capabilities.savedHistory.version=1`
перечисляет поддерживаемые PTY в `providers`; отсутствие provider в capability
не разрешает fallback в native. Начальная установленная v1 была Codex-only;
source14.09 добавляет Claude без изменения Codex-полей и без второго executor.

Это не отсутствие saved-history у Claude: desktop executor уже выполняет его
через Stop → claude:delete-range → structured draft → Resume того же SID.
При fileDeleted он очищает binding и оставляет новый пустой разговор для Send.
Внешний v1 adapter использует ту же ветку executor для Claude: current-chain
identity, Stop/input scope и same-SID/fileDeleted receipt, не native fallback.
Это source-контракт: включение в конкретном сервере проверяется его capability,
а физическая Claude/iOS приёмка требует отдельного авторизованного private target.

Main prerequisites для Claude сами по себе НЕ расширяют capability: требуется
подключённый provider adapter. `savedHistoryRuntime.capture` выбирает Claude
saved SID/launch generation, `inspectDraft` использует актуальный headless Claude
composer parser, `waitForDraft` — прежнее событийное ожидание. Stop всё ещё
проверяет `authority:{kind:'saved-history',tabId,operationId}` у physical signal.

`claude:run-command` с `command:'claude-c',sessionId,historyOperation:{operationId}`
проверяет операцию до preparation, затем под общей PTY-очередью после shell proof:
claim → reservation следующего run/launch → claimed → durable write gate → одна
команда. Внутренний callback всегда использует настоящий tabId, не подставленный
в historyOperation. `launchWritten:true,launchId,launchGeneration` доказывает
команду, не готовность CLI; первый OSC B потребляет preclaim без второго run++.
Ошибка до write не даёт новый Send/Resume, поздний отказ публикации после write
не превращается в `launchWritten:false`. Legacy запуск без historyOperation
сохраняет прежний путь.

Внутренний `_api.loadOperationSource({sessionId,cwd})` Claude возвращает точные
physical `records`, `recordMap`, цепочку `sources` и `revision` со schema
`claude-mutation-v1`/token. Это server-owned snapshot, не filepath из клиента и не
public Timeline revision. `_api.deleteRange` дополнительно принимает
`expectedRevision` (этот объект либо token), синхронные `validateSource(loaded)`
и `beforeCommit(loaded)` (`beforeWrite` — совместимый alias). Перед rename/unlink
проверяются все source hashes/stat identities и topology, затем owner callback
и повторная проверка без await. Результат сохраняет `fileDeleted` и добавляет
`committed`, `sourceRevision`; после уже выполненного commit отказ не выдаётся
за отсутствие изменения. Claude adapter передаёт эти guards прежнему writer;
выбранный UUID должен принадлежать его текущему physical файлу и цепочке. Это
не новый multi-file mutator: произвольная ancestor-only строка не понижается до
поиска по тексту/номеру. Старый desktop writer и его границы сохранены.

Для Claude можно передать `provider:'claude'` (alias `toolType`) с обязательным
`expectedContentRevision=timeline.revision.token`. Public revision проверяется
до Stop, затем отдельно защищается внутренний source snapshot у commit. Busy
flush после принятия разрешён: после Stop переопределяется текущий tail, но не
выбранный target. Embedded image выбранной user-записи материализуется до мутации
через прежний managed asset store, с exact presentation sidecar; отсутствующий/
повреждённый payload отказывает до удаления, не возвращает потерянное вложение.
Добавленные самой подготовкой managed image refs меняют presentation, но не
авторскую запись. Claude mutation защищается исходным raw-record hash/цепочкой,
а не равенством декорированного Timeline до и после собственного sidecar write.

Claude receipt добавляет `mutationSessionId`, `fileDeleted` и
`binding:{applied:true,mode:'retained'|'cleared',previousSessionId,sessionId,removedSessionId}`.
При retained `activeSessionId` — тот же physical SID, `removedSessionId:null`;
при cleared оба `binding.sessionId` и `activeSessionId` равны null, removedSessionId
называет удалённую сессию. Binding и receipt фиксируются одной DB-транзакцией.
`newSessionId` для Claude не выдумывается. Cleared завершается без Resume:
`resume:{launchWritten:false,skipped:true,reason:'session-file-deleted',status:'inactive'}`.
Следующий явный Send использует свежий разговор, а не --resume удалённого файла.

`POST /api/terminal-tabs/:tabId/history-operations`:

```json
{
  "operationId": "unique-client-intent-id",
  "kind": "rewind",
  "toolType": "codex",
  "expectedSessionId": "sessionId-from-current-timeline",
  "targetUuid": "exact-user-uuid",
  "targetEntryRef": null,
  "expectedContentRevision": null,
  "targetSourceIdentity": null
}
```

`kind: delete` удаляет одну семантическую user-итерацию с её ответом/инструментами;
`rewind` удаляет выбранную итерацию и будущее. Диапазон не вычисляется на iOS.
Rewind единственной итерации законно возвращает Timeline0 и History без user/
assistant (служебные model/effort могут остаться). Exact app-materialized rewrite
отличается от неизвестного thin native fork по сохранённому полному snapshot и
standalone metadata. `conversationMaterialized=false` здесь означает отсутствие
user-turn, а не повреждение файла. Появление exact Resume-source read capability
публикует snapshot само, без обязательного предварительного GET `/status`.
Для composite передаются `entryRef` строки и `contentRevision` Timeline целиком:
physicalSessionId/rawUuid/sourceIdentity не заменяются порядковым номером или
похожим текстом. `expectedSessionId` — владелец показанной истории, не physical
родитель выбранной строки. Binding проверяется отдельно; read SID не даёт writer
proof. Для physical истории достаточно exact UUID/session; переданная revision
также проверяется. Нельзя передавать тело target как источник восстановления:
сервер читает точную History-запись вместе с авторскими chips/image refs.

Ответ `{ok:true, operation:{...}}`: новый запрос быстро получает202. Дальше
`GET /api/terminal-tabs/:tabId/history-operations/:operationId` возвращает202
пока исход pending,200 для completed,409 для failed;404 означает неизвестный ID.
`ok:true` означает, что квитанция прочитана, а не что операция удалась.
Тот же ID+тот же запрос возвращает прежний receipt (`idempotent:true`), другой
запрос с тем же ID —409. Стадии приходят по существующему tab SSE/WS как
`saved-history-operation`; event несёт небольшой progress, полный draft читается GET.

Один existing renderer executor владеет порядком prepare → Stop → native-journal
reconcile → rewrite → adopt → Resume. Main сохраняет стадии/результат в SQLite и
проверяет тот же terminal/project/cwd/run/lifecycle/input перед Stop и launch write.
Состояния idle, busy, stopped и background не требуют mounted History/xterm или
перехода курсора на desktop. Неизвестный кадр сначала ждёт существующий main-frame
сигнал; настоящий чужой TUI draft даёт conflict до Stop, не очищается. Скрытый
desktop composer тоже не заменяется: клиент восстанавливает свой draft сам.

В receipt важны независимые `historyMutated`, `bindingCommitted`, `newSessionId`,
`activeSessionId`, `draft`, `resume`. `draft` Rewind — `{text,chips,imagePaths}`
по desktop authoring contract: prompt/context-file metadata, context-update ID,
paste anchors и image id/path сохраняются; Delete возвращает null. После binding
используется существующий History projection handoff и перенос settings proof.
Codex остаётся copy-on-write, исходный rollout сохраняется; это не app Fork-marker.
Resume не отправляет восстановленный prompt: требуется отдельный настоящий Send.

`completed` доказывает завершение history-сценария, **не готовность CLI**.
`resume.launchWritten=true` может сочетаться с `accepted:null`,
`acceptancePending:true`, `status:starting`. Новый writer/inputReady/model state
берётся из обычного `/status`/runtime SSE. Не посылать дополнительный `/resume`
или Enter. При failed после adoption история уже изменилась и draft доступен:
не возвращать старую ленту только из-за ошибки запуска.

Receipt переживает reopen. Обрыв HTTP не запускает второй сценарий; поздний
executor может закончить тот же receipt. Main/app crash посреди операции оставляет
`outcome-unknown`: отрицательные флаги означают «не подтверждено», не доказательство
отсутствия мутации. Автоматического продолжения незавершённого destructive flow
после crash здесь нет; повтор/new operation блокируется до точной сверки.

Inbox provider-chat использует additive
`POST /api/inbox/runs/:runId/history-operations` и GET `.../:operationId`;
capability `inboxSavedHistory.version=1,providers:['codex']` отдельна от tab API.
Body: operationId/kind/conversationKey/expectedSessionId/targetEntryUuid,
опциональные targetSourceIdentity/targetEntryRef/expectedContentRevision.
Сервер связывает confirmed send receipt, attempt, audit user identity и
детерминированную conversation-tab; текущий Timeline разрешает только exact
canonical alias, не текст или локальный индекс. Старый audit SID сохраняется
как адрес исходной отправки, новый binding приходит только из history receipt.

Ответ `{ok:true,runId,conversationKey,tabId,cleanup,operation}` использует те же
202/200/409/404 и стадии. `operation.operationId` — ID клиента,
`executorOperationId` — внутренний ID того же общего executor; `origin` содержит
точную связь run/conversation/audit. Ingress mapping и приём executor атомарны.
Повтор того же ID не исполняет снова, в том числе после TTL старой send-квитанции;
для НОВОЙ операции всё ещё нужна сохранённая confirmed send-квитанция.

Noted удерживает auto-stop/close и допуск нового Inbox Send на время операции.
Same-tab archived restore использует прежний resumePolicy:never; нужен exact
архив и сохранённая политика conversation, не создание вкладки по догадке.
Успех возвращает прежнюю cleanup-политику только тому же владельцу; новое
сообщение/другая conversation или desktop open не получают старые timers.
Непривязанная уже выполненная мутация сохраняет `cleanup.state:'held'` для recovery.
Crash после durable completion до ingress cleanup даёт `released-recovered` и
освобождает допуск без восстановления timers старого процесса. Незавершённая
операция остаётся outcome-unknown, без автоматического повторения.

Voice сохраняет operationId, применяет только подтверждённую mutation/binding,
возвращает portable draft своему composer ровно один раз, сохраняя новый ввод.
Ни wrapper, ни iOS не выполняют отдельные Stop/Resume/Enter. Старый native route
не изменён, pending native не допускается в новый flow и не мигрируется.
Реализация Voice/native consumer и её physical round-trip остаются у их owner.

### Применимость поздней квитанции и известная пустая привязка

Source14.09 отделяет прошлый результат O от права применить его сейчас. Новый
`GET /api/terminal-tabs/:tabId/history-operations/:operationId/applicability`
возвращает `{ok,operationId,operationRevision,applicability}`. Опциональный query
`operationRevision` проверяет exact версию O (несовпадение409). Сама старая GET
квитанции не меняется и не вызывает runtime capture.

`applicability` содержит `verdict: applicable|superseded|unknown`, `version:1`,
`ownerToken`, `ownerOrder:{epoch,revision}` и `currentBinding`:
`{state:'bound',provider,sessionId}`, `{state:'none',provider}` либо
`{state:'unknown'}`. Capability — `conversationOwner.version=1`, providers
Claude/Codex, canonical route в `applicability`; `strictKnownEmptySend:['claude']`.
`none` возникает только из exact committed Claude clear и сохраняемой main
привязки, не из inactive, отсутствующего поля или null в старом `/status`.
Legacy session/read/writer поля совместимы, включая старое сохранение SID при
null: новый клиент не использует их как отрицательное доказательство.

Контрольная отметка сохраняется с binding+receipt в одной SQLite-транзакции.
Codex point-write получает exact historyOperation через существующий executor;
Claude использует свой прежний атомарный binding commit. Свой Resume переносит
отметку через main claim/claimed/write; exact source→child adoption не становится
чужим ходом. Следующий авторский ввод, live provider user-turn, другой launch/
run/project/cwd/binding или другая принятая history-операция снимают применимость,
в том числе при SAME SID/process. Холодная запись пользовательского prompt в
историю снимает её у существующего before-commit gate, не ждёт provider turn.
Нет нового scanner, timer, queue runner или
сравнения текста. Исчезновение текущего proof-хранилища даёт unknown, не
superseded/none; старые receipts без checkpoint не мигрируются по догадке.

`conversationOwner` приходит в `/status`, runtime snapshot и отдельном SSE/WS
событии `type:'conversation-owner'`. В одной epoch клиент применяет ownerOrder
монотонно; смена epoch требует новой сверки, не сравнения revision разных эпох.
Canonical History/Timeline также отдают эту отметку. History запоминает её ДО
async чтения; `ownerSnapshotCurrent:false` означает, что за чтение владелец успел
измениться. Старые строки не получают token нового владельца. Это снимок, не lock:
поздний applicable нельзя применять после уже увиденного более нового ownerOrder.
При unknown/superseded результат и draft остаются отдельно, новый composer не
переписывается. Применимость не обещает ready или успешный ответ агента.

Для первого явного structured Send после clear новый клиент передаёт
`expectedToolType:'claude', expectedSessionId:null, expectedBinding:'none',
ownerToken:<из актуального applicability/currentBinding:none>` вместе с новым
handoffId и authoring. Старый null без этих полей остаётся совместимым wildcard.
Main проверяет token до reservation и на claim; claim привязан к прежней durable
send-attempt, не к локальному номеру клиента. Только её собственный первый launch
может перенести proof к реальному новому SID. Проверки повторяются под PTY lock,
перед paste/chunk и Enter; после paste отказ сохраняет `pasteWritten:true`.
Отказ —409 `agent_send_binding_changed`/`agent_send_owner_launch_changed` с явным
negative send result. Lost response читается по тому же receipt; новая отправка
или повтор Enter не выводятся из timeout/отсутствия строки. Plain Send не меняется.
У Codex saved-history остаётся bound child даже после удаления единственного
хода: нового смысла «Codex clear→none» эта capability не выдумывает.

Inbox сохраняет свой ingress и executorOperationId. Его клиент может читать
этот же canonical applicability по возвращённым tabId/executorOperationId;
не нужен второй history executor. Обычный Inbox Send остаётся run-scoped.
Source проверки — conversation-owner tests, actual HTTP/SQLite/main guards и
прежние provider executor fixtures; live CLI/native retake требует согласованной
обновлённой frozen-сборки. Ни один old incident не пересылается для проверки.

## Structured authoring: явный Send после Rewind

`presentationSnapshot` — метаданные показа/audit, не команда собрать пользовательский
prompt. Старый `/send` принимал готовую строку и добавлял uploaded attachments;
такой вход не мог восстановить desktop anchors и полную семантику chips из iOS.
Новый additive вход использует тот же `/api/terminal-tabs/:tabId/send`, но поле
`authoring` вместо готового `prompt`. Capability `structuredAuthoring.version=1`
с `providers:[codex,claude]` в source14.09 — отдельна от savedHistoryv1. Нет capability — нельзя
молча flatten'ить восстановленный draft или переключаться на native Rewind.

Новый saved-history reply сохраняет прежние draft.text/chips/imagePaths и добавляет
`draft.authoring` — готовый переносимый объект. Native редактор хранит его как
данные, меняет text parts/порядок refs/содержимое chips и передаёт по явному Send:

```json
{
  "handoffId": "new-explicit-send-id",
  "expectedToolType": "codex",
  "expectedSessionId": "current-conversation-id",
  "authoring": {
    "version": 1,
    "parts": [
      {"kind":"text","text":"before "},
      {"kind":"paste","chipId":"paste-1"},
      {"kind":"text","text":" after "},
      {"kind":"image","imageId":7}
    ],
    "chips": [{"id":"paste-1","kind":"paste","text":"editable pasted body"}],
    "imagePaths": [{"id":7,"path":"/absolute/already-uploaded/image.png"}]
  }
}
```

Text parts соединяются без придуманного whitespace. Paste parts ссылаются на
ID, не на строку `Pasted Content N chars`: изменение длины/emoji или два равных
по длине chip не требуют Swift-копии marker grammar. Prompt/file chips сохраняют
порядок prefix-band, как desktop. Для старого неизменённого draft поддерживается
вариант `{version:1,text,chips,imagePaths}`; одновременно text и parts запрещены.
Stale paste marker в этом варианте даёт400, не добавление тела в начало второй раз.

Когда Codex сохранил typed image-part как staged path, confirmed exact
mapping/span/hash/attempt превращается в постоянную canonical authoring sidecar.
History `content` получает `[Image #N]` в доказанной позиции, thumbnail остаётся
в imagePaths. Буквально набранный такой же путь вне image-part не удаляется.
Это общий server reader, не iOS regex; исходный transport/JSONL неизменен.
Проекция переживает TTL send-receipt и exact metadata copy в child. Старые
confirmed receipts мигрируются только по сохранившемуся точному proof.
Подробности: fix-codex-image-receipt-projection.md::Canonical History.

У prompt-chip сохраняются sourceKey/contextUpdateId/inheritanceDepth/
inheritanceParentLabel. Context file остаётся `kind:prompt,attachmentKind:file`
с filePath/role/text/sha256/bytes/sourceKey; его тело не читается с диска повторно.
Предъявленные sha/bytes обязаны соответствовать телу snapshot. При намеренном
редактировании тела можно убрать sha/bytes: сервер вычислит новые, без чтения
файла. Поля saved-prompt inheritance/contextUpdateId не применяются к file-chip.
Пустой файл сохраняет metadata и bytes0; пустая paste-wrapper остаётся текстом,
не orphan chip. Unknown fields/kinds, duplicate IDs, dangling refs, неверные
metadata/path/Unicode и превышение лимитов дают ошибку до Send.

Новые изображения сначала загружаются обычным upload API, затем добавляются в
imagePaths и parts. Нельзя одновременно передавать authoring и непустые
prompt/prompts/promptRefs/files/contextFiles/attachments/presentationSnapshot:
иначе получилось бы два источника тела и повторное добавление image prefixes.
Лимиты v1:8MiB canonical DTO/transport,256chips,64images/occurrences,4096parts.

Pure composer/image codec один, в src/shared; старые renderer import paths —
compatibility exports. Main использует его до существующего context/send scenario.
Formatter получает точные image spans, привязанные к hash всего подготовленного
prompt. Pending context может изменить prefix, но неизменность authoring body
проверяется отдельно; изменение тела не разрешает подбор похожего marker.
`imagePath` внутри file/paste текста поэтому не становится лишним вложением.
FS-import/alias выполняет только прежний provider image-formatter. Native image
IDs пересчитываются по фактическому порядку успешно staged изображений; editable
IDs клиента остаются у его DTO. Image-error остаётся явно видимым текстом.

Metadata DTO входит в существующий send fingerprint: тот же handoff с изменённым
sourceKey или порядком refs — конфликт, даже если часть transport-текста совпала.
Обычный plain `/send` не изменён. Нет дополнительного Enter, resend, очищения
чужого draft или новой readiness-цепочки; статусы/receipts остаются общими.
Ошибка валидации возвращает submitted=false/pasteWritten=false/enterWritten=false.
Сохранённая typed image projection переживает restart по тем же exact
tab/handoff/operation/attempt и request→transport→provider доказательствам.

Claude использует тот же serializer → обычный `sendClaudePtyPrompt` → terminal:paste,
не новый codec. `expectedToolType:'claude'` и текущий SID обязательны; после
fileDeleted старый явный `expectedSessionId:null` остаётся wildcard, а не proof
пустоты. Для строгого первого Send используется opt-in `expectedBinding:none`
с текущим ownerToken (контракт выше). Это не permission повторить старое сообщение.
Private roots/auth и реальный provider image/media round-trip проверяются отдельно
от source tests.

Inbox provider-chat отправляет отредактированный draft через прежний
`POST /api/inbox/runs`, НЕ через tab-level `/send`: иначе теряются новый runId,
attempt/result mapping и cleanup ownership. Capability
`inboxSavedHistory.structuredAuthoring:true` подтверждает именно этот вход.
Body сохраняет `provider:'codex',runId,conversationKey,expectedSessionId` и
`authoring`; `expectedToolType` можно опустить (его задаёт provider). Для этого
варианта обязательны явные runId и conversationKey; optional resumeSessionId
должен совпадать с expectedSessionId. Это новый explicit Send, не reuse ID Rewind
или старого send-run. Не передавать prompt/text/attachments/presentationSnapshot
поверх authoring. Обычный Inbox prompt+attachments остаётся совместимым.

Тот же prepareStructuredAuthoring формирует immutable authoringSnapshot и
presentationSnapshot, которые проходят прежний Inbox send/audit. Pending context
готовится один раз; общий binder переносит image spans с original authoring prompt
на итоговый prefix по неизменному body hash. Повторная материализация картинок и
отдельный Voice/Swift codec не нужны. DTO metadata входит в fingerprint run:
тот же runId с изменёнными chips/порядком refs даёт409, а подтверждённый/unknown
run replay возвращает прежний результат без второго Enter. Это не меняет
отдельный нерешённый send storage-generation контракт после утраты всех receipts.

Reply остаётся прежним Inbox run response: runId/tabId/sessionId/handoffId,
status и resultUrl/eventsUrl/stopUrl; durable operationKey=`inbox:<runId>`,
handoffId=`external-run:<runId>`. Exact attempt/audit/result читаются через
существующий `/api/inbox/runs/:runId/result` и send-receipts. Authoring acceptance
не доказывает completed response. Неправильный DTO отказывает до reservation/
tab creation с submitted/pasteWritten/enterWritten=false; смена target до
настоящего ввода по-прежнему проверяется общим main scenario.

## Read-only provider Usage

`GET /api/agent-usage?provider=codex|claude&accountKey=<key>&refresh=1` —
authenticated read-only adapter общих desktop getters, capability `agentUsage`
version1. Нельзя передать home/token/authReader/force/profile action или выбрать
аккаунт запущенной вкладки: key меняет только показанный snapshot. POST405;
ошибки доступа401, некорректный provider/key400, provider error —200 + DTOerror.
DTO содержит только accounts key/label/current/connected/stale/source/time/status,
выбранный key, windows usedPct/resetAt/resetPolicy, безопасные credits/fullResets
и freshness. Полный контракт/ограничения — fact-claude-usage-chip::Read-only Usage.
Swift/UI не владеет provider fetch, auth или quota normalization.

## Synthetic user-message broadcast

Когда mobile шлёт `POST /api/terminal-tabs/:id/send`, main вызывает `sendAgentPromptScenario`. Для Claude/Codex PTY реальная user-запись в JSONL/rollout появляется **позже**, когда terminal runtime durable-примет prompt; для legacy SDK это всё ещё может пройти через `sdkStartQuery`. Phone не должен ждать durable-запись, чтобы показать локальный handoff, но durable JSONL/rollout остаётся источником истины для замены optimistic bubble.

Решение: при старте query main **сам** бродкастит synthetic message всем WS-подписчикам tabId:
```js
_webBroadcast(tabId, {
  type: 'message',
  message: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    __webSynthetic: true,
  },
});
```
Это event летит ТОЛЬКО на WS — десктопный renderer его не видит (не подписан). Десктоп получает свой user-bubble через локальный `onNew` композера.

**Edge case:** когда отправка пришла **с phone**, десктоп `onNew` не вызвался. Renderer-bridge handler перед `claude-sdk:send-message` диспатчит CustomEvent `claude-sdk:external-prompt` — ClaudeSDKTab слушает и пушит свой user-bubble в локальный `setMessages`. Без этого десктоп показывал ответ Claude но не сам запрос.

**Mobile-side guard:** phone reducer **игнорирует** `__webSynthetic: true` входящие messages — иначе на phone был бы дубль user-bubble (synthetic + real-record когда дойдёт). Native iOS получает мгновенный feedback через локальную строку с неизменным `handoffId`. Canonical строка может заменить её только по operation/handoff, UUID/source identity или полному composite `entryRef`; одинаковый текст больше ничего не доказывает. Старый React mobile-web сохраняет text-fallback только как legacy-поведение и не является образцом для новых клиентов.

Тот же инвариант теперь обязателен для History и native iOS: локальная user-row появляется **до** ожидания `sendAgentPromptScenario`/JSONL audit со статусом `sending`, после принятия API может стать `sent/queued`, а durable JSONL/rollout row только adopt'ит её. Tool/MCP/thinking entries — это metadata следующего agent turn'а, не delivery feedback для пользовательского prompt'а. Пользовательский симптом нарушенного handoff'а: после Send первым видимым элементом становится `MCP`/`thinking`, а своего сообщения со статусом `sending` нет.

Если между локальным `sending` и durable row приходит canonical `/history` reload, клиент обязан смерджить pending handoff обратно в publish. Иначе heavy reload стирает optimistic user-row, и UI выглядит так, будто prompt исчез или заменился tool-событием. Source of truth всё равно durable transcript: локальный handoff живёт только до matching user entry / failed / cancelled.

Busy-send и Stop во время streaming имеют ещё один промежуточный случай: сервер может прислать provider-queue proof / HTTP handoff-ack раньше, чем canonical history reload увидит durable user-row. Для Codex local marker после Enter остаётся лишь pending, пока main не увидел exact committed `Messages to be submitted after next tool call`; после этого API честно возвращает `queued`, хотя durable `user_message` ещё отсутствует. Для Claude ту же роль играет exact `queue-operation`. Ни один queue proof не делает строку полноценной историей: marker остаётся до matching durable row, проверенного consumed-state или явного cancel, а restart восстанавливает его из receipt без повторного Enter. Логовая строка `handoff materialized` без exact provider identity означает только принятие сценарным слоем.

`thinking` — отдельная семантическая строка, а не tool-card. Pending `tool_use` без результата можно скрыть или дождаться результата, но нельзя на один кадр превращать thinking в `MCP thinking` с badge, chevron или раскрытием справа. Completed tool rows могут быть отдельными раскрываемыми карточками; этот contract не распространяется на thinking, потому что для пользователя это статус размышления агента, а не объект инструмента.

## Project Terminal API: action response, runtime и transcript projection

После provider failure три разных факта сохраняются раздельно: send receipt
может быть confirmed, runtime active/inputReady, а результат хода — error.
Codex canonical History теперь возвращает role/serviceCarrier `provider-error`
(typed quota: прежний `usage-limit`), исходную причину в `providerError.message`,
код/info/turnId и physical source identity. Compatibility messages/live используют
тот же UUID и type/role, `projection.transcript=true`, timeline=false, ephemeral=false.
Клиент не парсит надпись терминала, не рисует successful assistant из ошибки и
не повторяет исходный Send. Source-fix14.09 не установлен на frozen7997; его
обновление/physical iOS acceptance остаются у owner3951.

Внешний API не должен быть сырой шиной внутренних событий. Native iOS, legacy mobile-web и Inbox не знают, какая строка JSONL/rollout является видимой историей, какая только служебной настройкой, а какая transient-state turn'а. Серверная модель делит три факта:

- HTTP action response (`/send`, `/start`, `/resume`, `/stop`) говорит, принято ли действие и какой следующий state ожидается, но не материализует историю сам по себе.
- Runtime snapshot/SSE (`sessionStatus`, `inputReady`, `turnBusy`, `stopping`, `startupDefaults*`) говорит, что происходит с живым процессом. `/tabs`, `/status`, initial/tab SSE и `project-activity` проходят через одну публичную проекцию с `lifecycleGeneration` и монотонным `runtimeRevision`: поздний HTTP-ответ или событие прежнего запуска не может откатить новый runtime.
- Delivery receipt относится к одной отправке, а не к вкладке. `sent`, `queued`, `audit-pending`, `delivery-unknown` и exact refusal живут на конкретной user-row; read-only `/send-receipts` позволяет сверить прежний handoff после reconnect без повторного Enter.
- Transcript projection (`projection.transcript`, `entryId`, `kind`, `ephemeral`) говорит, можно ли событие класть в видимую историю и использовать для materialization/Timeline.

Старый симптом смешения: iPhone получал `done/busy=false`, гасил thinking, но финальная assistant-строка появлялась только после следующего `/history`; пользователь видел пустой зазор между loader и ответом. Другой симптом — startup `/model` или `/effort` мелькал как user-row, а canonical `/history` тут же удалял его. Правило: UI-событие считается опубликованной историей только после transcript projection или canonical history reload; runtime `done` означает конец turn'а, а не то, что все display rows уже доставлены.

## History loader: НЕ getSessionMessages

`getSessionMessages` из Anthropic SDK возвращает **другой набор записей** чем `parseTimelineEntries` — uuids не пересекаются. Если history грузить через SDK-helper, GoTo из timeline (использует timeline uuids как anchors) никогда не находит цель. См. [`fix-mobile-history-uuid-mismatch.md`](fix-mobile-history-uuid-mismatch.md).

Решение: новый IPC `claude-sdk:active-branch-messages` читает JSONL напрямую, walks active branch (тот же алгоритм что в `parseTimelineEntries`), возвращает **все типы** в chain order — user, assistant, tool_use, tool_result. Mobile reducer обрабатывает их так же как стрим. Anchors совпадают.

## Slash-чип / compact-summary / XML wrappers в mobile reducer

Mobile receiver получает тот же поток raw SDK-сообщений что и десктоп — значит видит **все CLI/SDK-инъекции** которые на десктопе разруливаются в `ClaudeSDKTab` парсере: служебные XML-обёртки, slash-команды как user-bubble, compact-summary records с metrics. Без специальной обработки в mobile reducer'е (`mobile-web/src/messages.ts`) юзер видит сырой `<command-name>/compact</command-name>` как обычное сообщение, `<local-command-stdout>Compacted</local-command-stdout>` как user-реплику, а compact summary без оранжевой карточки и метрик.

Распознавание в `apply()` reducer'а:
- `type:'system' && subtype:'compact_boundary'` — стэшится `pendingCompactMetrics` (preTokens / postTokens / durationMs), сама запись не рендерится. Метрики прицепятся к следующей user-записи с compact-summary флагом.
- `<command-name>X</command-name>` + optional `<command-args>` → `kind:'slash'`, рендерится как фиолетовая (`rgba(129,140,248,*)`) compact-пилюля справа, моноширный шрифт, `userSelect:none`. Точная копия desktop UserMsg isSlashCommand-ветки.
- `<local-command-stdout>` / `<local-command-caveat>` / `<system-reminder>` / `<tool_result>` / `[tool_result]` → drop. CLI-артефакты, не пользовательский текст.
- `isCompactSummary === true` (authoritative SDK-флаг) или text начинается с `'This session is being continued from a previous conversation'` (fallback для старых сессий) → `kind:'compact-summary'`, прицепляются метрики из `pendingCompactMetrics`. Рендерится как orange-card (`#DA7756` border + bg `rgba(218,119,86,0.06)`), заголовок «COMPACT SUMMARY», метрики `preTokens → postTokens · Ns` моноширно, collapsible body с 600-char preview (`COMPACT_PREVIEW_CHARS`).
- `maybeSwapCompactPair()` — после push'а compact-summary или slash-чипа в `state.entries` пробует swap последних двух элементов если они `[compact-summary, slash('/compact')]`. JSONL пишет summary ДО следующей `<command-name>/compact</command-name>` записи, визуально chip должен быть выше — юзер ввёл команду, потом SDK сделал summary.

Dedup для slash/compact работает через `entryUuid` — WS replay после optimistic local apply не плодит дубликаты.

Серверный mobile timeline (`parseTimelineEntries` → `normalizeMobileTimelineEntries`) держит тот же смысл: `compact_boundary` и следующая `isCompactSummary` user-запись являются одной логической точкой compact. Boundary рендерится как compact-маркер с текстом summary, а сама `isCompactSummary` не выходит отдельным user-prompt'ом. Это важно для native iOS/REST snapshot: live reducer и reload не должны превращать один compact в две точки или в пользовательский input.

## Paste-chip flow на мобилке + EntryView как адаптер к пакету

Мобилка получила **полный paste-chip flow** — зеркало desktop SDK (порог 500, чип-бар над композером, tap → preview, `<pasted_content>`-обёртка каждого чипа при отправке, `UserText`-разбор обёртки в user-бабле). Раньше мобильный composer не имел `onPaste` вообще: длинный текст вваливался в textarea, `send()` слал сырьё, бабл рендерил его без разбора. Send активен при наличии чипа даже с пустым текстом (bare-paste = валидный промпт, как на десктопе).

Весь визуал строки чата теперь рисует `@noted/claude-blocks::ChatMessage` (см. `fact-claude-blocks-package.md::ChatMessage`). Мобильный `EntryView` стал **тонким адаптером**: `uiToChatEntry(UiEntry) → <ChatMessage ctx={mobileRenderCtx}>`. Все прежние per-kind карточки (`UserText`/`ThinkingCard`/`ToolCard`/`CompactSummaryCard`/`CollapsibleText`/`Markdown`-wrapper, ~150 строк) **удалены** — их форма ушла в пакет. `mobileRenderCtx` инжектит collapse-контроллер: `isOpen` читает persist-карту `_entryExpanded`, `toggle` оборачивает в `stickToggle` (bottom-stick) + глобальный re-render через `bumpGlobalToggle`/`useGlobalToggle` (virtua держит в DOM только видимые ряды, перерисуются лишь они). Бабл юзера при переезде перекрашен `#1f3a5f` → Claude-оранж (canon — десктоп). Под капотом lifecycle (SSE/JSONL/kill) остаётся у мобилы — пакет его не касается.

## File-tab Markdown preview bottom-sheet

File-tabs на mobile — это не chat route. Если `tabType === 'file'`, tap по строке должен открыть read-only preview sheet поверх списка проекта, а не вести в `ChatView` с пустым сообщением «No Claude session attached». Это тот же mental model, что у attached-chip preview: пользователь хочет быстро подсмотреть документ и вернуться к списку табов.

Контракт данных: `/api/projects/:id/tabs` отдаёт `filePath` для file-tab'ов. `cwd` остаётся рабочей директорией/legacy fallback и не должен использоваться как canonical file path, иначе сервер получит directory и вернёт `not a file`. Чтение файла идёт через `POST /api/file-preview {path}` прямо в `web-server.js`: absolute path required, `stat.isFile()`, cap 1MB, `utf8` read, ответ `{path,name,ext,size,content}`. Bridge в renderer тут не нужен — preview читает файловую систему, а не Zustand state; это быстрее и работает даже если renderer ещё не ответил на bridge.

UI: `MarkdownFileSheet` — bottom-sheet с backdrop, drag handle и swipe-down dismiss (`dragY` threshold), header filename/path/size и внутренний scroll для body. Рендер Markdown на mobile использует `@noted/claude-blocks::Markdown`, а не desktop `@gt-editor/markdown-editor`: mobile уже тащит chat Markdown renderer, а desktop editor heavy/local-file dependency не нужна в phone bundle. Если file-tab принадлежит группе, отдельной логики не требуется: server уже отдаёт тот же tab row с `groupId`, а preview открывается по `filePath` независимо от группировки.

## Terminal prompt library для native iOS

`GET /api/prompts` отдаёт `resolvedText` для каждого context-menu prompt'а: сначала собственный `content`, затем содержимое `file_paths`, прочитанное на Mac и очищенное тем же `sanitizeFileForPrompt`, что desktop `ai-prompts:read-files`. Это не дублирование renderer-логики, а мобильный контракт: телефон не может сам прочитать Mac paths, а desktop picker делает это в момент вставки через IPC.

Пользовательский симптом без `resolvedText`: prompt с файлами виден в списке, tap по нему выглядит как выбор, но native iOS отбрасывает его как empty и chip не появляется; другой prompt с обычным `content` при этом работает. Поэтому etag `/api/prompts` считается уже по response с `resolvedText`, чтобы изменение файла за prompt'ом обновляло мобильный кэш даже без изменения SQLite row.

## Mobile upload attachments: камера / галерея / файлы

Terminal Control на iOS прикрепляет реальные фото/файлы не как base64 в prompt и не как iOS sandbox URL, а как предварительный upload на Mac. Причина: после выбора из Photos/FileImporter ссылка живёт в sandbox телефона, а Claude/Codex исполняются на Mac и должны читать локальный path. `/api/mobile-attachments` принимает `{name, kind, mimeType, dataBase64}`, кладёт файл в `app.getPath('temp')/noted-terminal-mobile-attachments/<id>/<sanitized-name>` и режет payload по 25MB. После успешного Send temp-файл остаётся жить для sent history preview: upload-route не запускает age-cleanup, а `DELETE /api/mobile-attachments/:id` — только best-effort cleanup при удалении chip до отправки. Если понадобится автоматическая уборка, она должна быть history-aware, иначе iOS reload теряет preview отправленного изображения.

В legacy plain-режиме `POST /api/terminal-tabs/:tabId/send` принимает `attachments` отдельно от `prompt`, заново валидирует что каждый path absolute и лежит внутри temp-root, а затем добавляет в prompt блок `Attached files from iOS are already uploaded to this Mac...` со списком local paths. Это намеренно дублируется с visible text, который iOS уже показывает пользователю: агент получает обычный текстовый контракт «прочитай эти path», а API response возвращает нормализованные attachments для аудита. Если такой блок уже есть в prompt, сервер не добавляет второй. Structured authoring использует уже загруженные image refs/parts и не входит в этот prefix-path; смешивать формы нельзя. GT file chips остаются другой моделью: они path-only ссылки на уже существующие файлы проекта, а mobile upload attachments — временные копии пользовательских файлов/фото.

Отдельный `files:[{path,role,label?}]` у Project API send/orchestration означает
не upload и не path-only подсказку, а server-resolved context snapshot. Он
принимает локальный absolute UTF-8 regular file, до dispatch читает/хеширует его
на Mac и передаёт полный текст в `<context_file>`; `source` сохраняет текст,
`instructions` применяет include/AI-metadata sanitation. Ошибка файла прекращает
операцию до Enter. Не подменять `files` существующим mobile `attachments`: у них
разные ownership, security boundary и поведение целевого агента.

Path-block в prompt — машинный контракт для Mac agent, а не UI-текст истории. iOS обязан распарсить строки вида `[image, image/jpeg] name: /tmp/...` в sent attachment chips и скрыть сам блок из transcript/copy/full-prompt view; если агент случайно эхо'ит этот блок в assistant content, native transcript тоже фильтрует его из видимого ответа. Иначе пользователь видит raw temp path вместо того же chip'а, который только что отправлял. `POST /api/mobile-attachments/preview` существует только для восстановления preview после history reload: он принимает temp path, проверяет что файл всё ещё внутри mobile-attachments root, и отдаёт base64 только для image-файлов до 12MB. Для произвольных документов preview не пытается читать содержимое — достаточно имени/иконки/path в chip/detail sheet.

## ParamsSheet (model/effort/think) — close-on-select + invisible-intent источники

Хедер-пилюля `model · effort ▾` открывает bottom-sheet `ParamsSheet` (SDK,
PTY-Claude и PTY-Codex табы). Четыре неочевидных факта:

- **Select = loader-in-pill → close по применению (НЕ по сырому тапу).** Тап по
  опции помечает её busy (спиннер на месте, `cursor: wait`), соседи тускнеют и
  блокируются (`busyKey`), и sheet закрывается **по резолву** `Api.setParams`;
  на reject — спиннер снят, sheet остаётся для повтора. Переносимый принцип —
  `methodology/дизайн-принципы.md::Async single-select`. Предпосылка к этому —
  iOS touch-retarget: на iOS Safari тап по внутренней `<button>` баблится так,
  что голый `onClick={onDismiss}` на backdrop'е тоже срабатывал → выбор любого
  Model/Effort/Thinking **мгновенно** закрывал sheet (до применения, и SDK и PTY).
  Guard `onClick={(e) => { if (e.target === e.currentTarget && !busyKey)
  onDismiss(); }}` — закрытие только по тапу в сам backdrop, и только когда не
  busy. Браузерный синтетический click (десктоп) баг НЕ воспроизводит — нужен
  реальный тач, ловить живьём на телефоне.
- **Effort/Think для PTY = invisible-intent через window-карты.** PTY-Claude не
  транслирует effort/think обратно. `getSDKParams` (renderer-bridge в `App.tsx`)
  читает effort из `window.__effortSentForTab` (`{level}`, set'ится auto-inject'ом
  и ручными кликами, чистится на смерти Claude — см.
  [`fact-claude-tui-control.md::Auto-inject /effort`](fact-claude-tui-control.md)),
  think — из `window.__thinkStateForTab` (`Map<tabId,bool>`, default ON, пишется
  десктопным `toggleThink` И мобильным `setSDKParams`). Absent effort → `'?'`
  (а не врущее `high`). Это та же модель что десктопный ControlBar показывает в
  `effortLocal`/`thinkLocal` — единый cross-client источник, не пересчёт.
- **Codex params = tab-scoped intent + safe live apply.** Для Codex `getSDKParams`
  отдаёт `tab.codexModel/codexEffort` с fallback на app defaults, а `setSDKParams`
  ведёт себя как desktop ControlBar: если живой Codex idle и xterm-probe безопасен,
  применяет выбор через `codex:select-model-effort`; если Codex занят, input-state
  неизвестен или picker не подтвердился — возвращает ошибку и НЕ меняет tab-state,
  чтобы phone/desktop не показывали модель, которую TUI не получил. Если живого
  Codex нет, запись сохраняется как future intent на вкладке и пойдёт в следующий
  launch args.
- **Think — одна toggle-пилюля, не on/off-пара.** Mirror десктопной Think-кнопки:
  `Think ON`/`Think OFF`, тап флипает. Для PTY каждая смена шлёт
  `claude:toggle-thinking` (meta+t флип), и **только** если запрошенное состояние
  отличается от трекнутого (picker — toggle, не setter; повторный тап того же
  значения = no-op). Для SDK — `sdkThinking` boolean в Tab.

## Prompt Queue ("Run after") — mobile mirror, НЕ второй движок

Мобильная панель Run-after (иконка в правом верхнем углу хедера, рядом с timeline-бургером) — **зеркало** десктопного `PromptQueueOverlay`, не самостоятельная фича. Ключевой инвариант: **мобилка не владеет очередью**. Единственный источник правды — десктопный `usePromptQueueStore`, единственный движок исполнения — App-root синглтон `usePromptQueueRunner` (см. `fact-prompt-queue.md`). Мобилка только (1) читает live-core и (2) шлёт мутации; стрельбу промптов делает десктоп. Это та же модель, что у effort/think window-карт (мобилка — тонкий remote, не второе хранилище) — и прямое следствие принципа CLAUDE.md «переиспользуй существующий код, не переизобретай».

**Три канала (read / write / live), все через bridge:**
- **Read:** `GET /queue` → bridge `getPromptQueue` → renderer сериализует `serializePromptQueueCore(getQueue(tabId))` + список sibling AI-табов (для pivot-пикера «on tab», тот же предикат что десктопный `RunAfterTabPicker`: SDK / PTY-claude+sessionId / gemini+sessionId, self исключён).
- **Write:** любой контрол → `POST /queue {op,args}` → bridge `mutatePromptQueue` → вызывает **тот же store-метод** что десктопный оверлей (`addPrompt`/`updatePrompt(enabled)`/`setAutoRun`/`setStopAfter`/`setCloseAfter`/`setRunAfterTab`/`setFirstDelaySeconds`/`setPostPrompt*`/...). Все каскады (closeAfter⟹stopAfter, auto-disarm на manual empty-out по active-count, SQLite-persist, hint-arming) срабатывают идентично — мы **не реимплементим** логику очереди, только remote-invoke. Op-таблица `QueueOp` в `mobile-web/src/api.ts` — 1:1 с case-веткой в `App.tsx::mutatePromptQueue`.
- **Live:** любое изменение store (десктоп ИЛИ телефон) → `usePromptQueueWebSync` (App-root, рядом с runner) диффает per-tab core-JSON → `web:broadcast-queue` IPC → main `_webBroadcast(type:'queue-update')` → SSE → телефон обновляет мирор. Поэтому successful Run after удаляет sent item и одноразовый `runAfterTabId` на desktop, native iOS и legacy Android/mobile-web одним store-commit; клиент не держит локальный статус, способный переиграть эту дельту. `webBroadcast` no-op'ит без подписчиков, поэтому на desktop-only пути это один `JSON.stringify`+Map-дифф на мутацию и ничего больше.

**Owner support зависит от поверхности, движок общий.** Desktop и native iOS разрешают PTY-Claude и PTY-Codex owner'ов; runner выбирает `claude:send-command` или `codex:send-command` по реальному tab runtime. Legacy Android/mobile-web пока сохраняет старый UI-gate `canQueue = isClaudePtyTab`, хотя live mirror понимает общий `PromptQueueCore`. SDK/Gemini остаются только pivot-таргетами. Не расширять owner UI на новый runtime, пока runner не умеет маршрутизировать его send path.

**Почему web-sync на App-root, не в панели:** идентично runner'у — панель unmount'ится как только юзер ушёл с Claude-таба, но телефон может смотреть **фоновый** таб. Gated-by-active-tab бродкастер замолчал бы ровно когда телефон ждёт дельту. См. `fact-prompt-queue.md::Auto-runner — singleton hook, не в overlay`.

**UI-маппинг на десктопный оверлей (bottom-sheet, не right-panel — thumb-reach, как ParamsSheet/ActionSheet):** хедер-иконка = list-глиф + violet `[N]` когда armed; `[N]` считает только enabled items, как desktop. При открытой панели становится ✕ (закрывает и панель, и редактор). Две колонки настроек: левая — pivot «on tab» + delay-секунды; правая — Run after (violet) / Stop after split с power-иконкой Close-after (red) / Post split с карандашом. Список очереди (≈5 строк, потом скролл), тап по строке или «+ Add» → инлайн-редактор (Mirror Editing, ≈5 строк textarea, Save). Checkbox на строке шлёт `update(enabled)` и оставляет disabled item видимым с темно-малиновым фоном; это mirror skip-state, не mobile-only фильтр. `queue-update` SSE держит всё live без ре-фетча. Цвета — те же семантические роли что в `PromptQueueOverlay`: `#a78bfa` armed, `#8b5cf6` pivot-target, `#DA7756` stop/post, `#ef4444` close.

**Prod требует `build:install`** — `App.tsx::handleWebBridge` (новые actions) и `web-server.js` (новые routes) живут в asar; mobile-web Vite-dev итерирует только фронт. См. «Stale prod-app → silent bridge timeout» ниже.

## Native clients share the REST/SSE contract

### Read-only timing, multiplex и условная History

Capabilities `/api/me`: `responseTiming.version=1`, `tabEvents.version=1`
(`multiplex:"tabIds",maxTabs:32`), `historyRead.version=1`
(`view:"history",conditional:"ifRevision",deltaProviders:["codex"]`). Это
additive source-контракт: наличие в checkout не доказывает capability конкретного
установленного/тестового экземпляра.

`GET /api/terminal-tabs/:tabId/timing[?toolType=codex|claude]` читает тот же
`readAgentTabTiming`, что desktop IPC `agent-activity:get-tab-timing`:

```json
{
  "success": true,
  "tabId": "T",
  "instanceId": "server-instance",
  "observedAt": 1789300000000,
  "timingRevision": "opaque-content-hash",
  "scope": {
    "tabId": "T", "toolType": "codex", "lifecycleGeneration": "generation",
    "runSeq": 2, "launchId": "launch", "sessionId": null,
    "readSessionId": "source", "writerSessionId": null, "writerConfirmed": false
  },
  "timing": {
    "state": "running", "phase": "preflight", "intervalId": null,
    "toolType": "codex", "sessionId": null, "startTs": 1789299999000,
    "endTs": null, "durationMs": null
  }
}
```

`timing:null` — нет текущего интервала. Обычный `running` берёт start/session из
существующего activity; `phase:preflight` — из уже вооружённой подготовки paste,
не из времени HTTP-запроса или открытия экрана. `pending` содержит настоящий
intervalId/startTs/endTs/durationMs и `validUntil=endTs+10000`: это прежний короткий
handoff до exact привязки к ответу, не новая работа. После привязки время лежит в
`History.entries[].responseTiming` именно своего assistant UUID. Совпавший intervalId
в строке заменяет pending footer; старую длительность нельзя приписывать новому
ответу без sidecar. Shimmer/tap и формат локальной даты принадлежат iOS; для живого
цифрового тика допустима только проекция server start/observedAt, не свой старт
от mount/turnStartedAt. Timing scope не даёт writer/adoption authority.

SSE получает `type:"timing-changed"` с тем же полным snapshot и `reason`:
initial connect, существующее activity open/close/teardown событие, preflight
open/close, exact sidecar binding. Нет секундного polling/нового busy detector;
`recordActivity` не изменён. Даже без подписки `scope=projects` timing приходит
на tab topic. Ошибка getter не считается отсутствующим интервалом.

`GET /api/events?tabIds=<URL-encoded JSON array of tab IDs>` объединяет **1–32
явно названных существующих вкладки** на одном соединении. Повторы ID устраняются;
смешивание с `tabId`/`scope`/`projectActivity` даёт400, неизвестная вкладка404 до
подписки. Auth прежний Bearer (query token — только старый EventSource-compatible
вариант). Старые `?tabId=T`, `?scope=projects` и WS сохранены.

Каждая вкладка получает обычные initial runtime/orchestration/timing snapshots,
live messages и `transcript-changed`; payload сохраняет собственный session/version,
source/read SID не превращается в writer SID. SSE добавляет `streamInstanceId`,
`connectionId`, `sequence`, `initial`. Sequence относится к соединению, после
reconnect не продолжается. Пока initial одной вкладки читается, её live-события
буферизуются и уходят после initial; другие вкладки не ждут. Буфер ограничен2MiB:
переполнение закрывает соединение для resync, не молча пропускает сообщения.
Это не durable event log/Last-Event-ID replay.

Один service-consumer на tab разделяется между SSE/WS-клиентами. Закрытие последнего
клиента освобождает подписку, включая close во время async subscribe. Runtime
snapshot/bridge-update перепроверяет read identity и переводит тот же consumer
на доказанный child; reconnect/late cleanup не удаляет новое наблюдение. Дальнейший
park/grace watcher остаётся политикой Transcript Service, не отдельным iOS parser.

Для History: первый `GET /api/terminal-tabs/T/history?view=history&last=200&delta=1`
возвращает прежние rows/метаданные плюс **opaque `historyRevision`**. Последующие
запросы того же окна передают `ifRevision=<historyRevision>`:

- `unchanged:true`: строк нет — сохранить текущие rows, НЕ очистить список;
- `delta:true`: `changedEntries` + полный `order` UUID этого окна, метаданные
  total/startIndex/hasMore и новая historyRevision. Собрать окно из старых строк и
  exact changedEntries; UUID вне order из этого окна удаляется. Нет строки для
  названного UUID — запросить полное окно, не угадывать по тексту;
- иначе обычный полный ответ того же bounded окна. После смены окна/read SID,
  вытеснения bounded cache либо restart fallback full закономерен.

`from=<UUID>` — включительно от удерживаемой строки до хвоста; прежние
last/after/before/around/radius сохранены. Условие привязано к tab/provider/read
session/cwd/**всему запросу окна**. Переданный клиентом JSON с file paths не
принимается вместо opaque token. Внутри выполняется прежняя проверка revision
Transcript Service: файлы/lineage + chips + session/tab timing sidecars, а затем
его же delta projector. База сравнения delta разделена по HTTP read-окну и не
подменяется более широким окном другого клиента/desktop: чужое наличие UUID
не доказывает, что строка уже есть у этого клиента. Это отдельный consumer key
прежнего bounded digest store, не второй parser/хранилище содержимого.
Старый `etag` по UUID не является proof неизменности;
`If-None-Match/304` не добавлены. Старые поля `revision` и messages/NDJSON API
сохранены, но новый conditional/delta контракт требует `view=history`.

Claude использует тот же main-owned full-history adapter и условную проверку;
изменившееся окно пока приходит целиком, без обещания Codex row-delta. Во время
чтения сменился read owner —409 `history_read_identity_changed`, а не старые rows
под новым SID. Нет разрешённого read owner —409 `history_read_identity_unavailable`
для conditional/delta запроса. Ни одна ошибка не очищает удерживаемые rows сама.
Codex metadata для этого read берётся из main event projection, без process scan.

На reopen/foreground/reconnect клиент сохраняет rows, восстанавливает один SSE
на свой набор активных чатов и проверяет их ревизии. `transcript-changed` и
`timing-changed` — поводы для одного conditional read с максимум одним trailing
read при событии в полёте. Unconditional full reload, SSE на каждый чат и новый
локальный учёт длительности не требуются.

### Общие владельцы состояния

`mobile-web` больше не основной потребитель этого сервера. Нативный iOS-клиент Habit Tracker (`fact-voice-chat-tab.md::Terminal mode`) ходит в те же REST/SSE endpoints и рисует Terminal сам на SwiftUI; React `mobile-web/` оставлен только как legacy/debug surface и не является целевым клиентом. Это не вторая модель terminal-control: source of truth остаётся в custom-terminal renderer/main, а native app только отображает снапшоты и шлёт команды.

App-level settings тоже принадлежат desktop app-state, а не каждому клиенту отдельно. Mobile-web settings sheet читает/пишет `streamerMode` через `/api/app-settings` → renderer bridge `getAppSettings/setAppSettings`; это тот же флаг, который скрывает desktop remote URL chip. Клиент может иметь локальный redaction fallback для собственного host-label, но если он управляет Noted Terminal state, запись должна идти в desktop app-state, иначе phone и desktop начнут расходиться: на телефоне включён privacy, а desktop продолжает светить URL в stream.

Следствие для контракта: всё, что native UI не может честно вывести из файлов на диске, должно приходить по API уже нормализованным. Project icon (`project.icon`), назначенный status marker (`statusId/statusColor`) и форма/размер marker (`statusMarker:{shape,sizePx}`) передаются сервером, потому что palette и настройка живут в desktop `useUIStore`, недоступном iOS. Runtime `sessionStatus` остаётся отдельным полем: это busy/active/inactive/starting/stopping процесса, а не user-assigned категория. `starting` означает, что launch ещё не полностью settled, но не всегда означает `inputReady=false`: Codex Resume может уже показать чистый composer и разрешить одно защищённое первое действие, пока writer identity ещё определяется. Клиент следует явному `inputReady` для ввода и отдельным capability-полям для Copy/Rewind/History, а не выводит всё из одного status. `stopping` — first-class transitional status: stop уже принят, но exit ещё не доказан, поэтому native не должен показывать обычный input, Resume или Rewind до `inactive`.

Для Codex `status` и SSE snapshot должны быть привязаны к актуальной runtime session после resume/start, а не к старому `sessionId`, который остался в layout metadata. Диагностический шрам 2026-06-20: iOS корректно показал `active`, потому что `/status` и SSE сами отдавали `active` для старой session, а desktop startup уже работал с новой Codex-сессией; после failed Rewind тот же API переключился в `starting`. Если native логи показывают такую цепочку, чинить нужно main/API session-binding и readiness, не iOS UI.

Status, busy, input readiness и writer identity обязаны принадлежать одному runtime snapshot/generation. Несколько последовательных IPC-чтений не являются эквивалентом: handoff между ними даёт невозможную комбинацию вроде `status=busy`, `isBusy=false` и старого ID. Аудит 2026-07-23 нашёл именно такую незакрытую агрегацию в History presence; это server/renderer architecture gap, а не повод добавлять клиентский fallback.

HTTP-ответ и runtime-состояние — разные доказательства. Полученный `503 process lookup unknown` означает, что Mac web-server доступен, но состояние процесса установить не удалось; native-клиент не должен превращать его ни в глобальный `offline`, ни в `inactive`. После неуспешного `Start`/`Resume` клиент сохраняет последний доказанный runtime и может перечитать `/status`; если за время запроса уже пришёл более свежий SSE, поздняя HTTP-ошибка не имеет права его откатить. `offline` допустим только при транспортном разрыве или отсутствии HTTP-ответа.

`GET /api/projects` для native клиентов отдаёт не просто SQLite `updated_at DESC`.
Открытые проекты сортируются по порядку `openProjects` из renderer — это тот же порядок,
в котором desktop project tabs стоят слева направо; телефон показывает его сверху вниз.
Закрытые проекты идут после открытых по freshness. Нативный клиент не должен повторно
сортировать этот ответ: порядок project tabs — пользовательская навигационная раскладка,
а не производная от времени последнего изменения проекта.

`Inbox` приходит в том же списке как system project (`isSystem:true`, `systemType:'inbox'`) и
сервер пинит его перед обычными проектами. После него обычные открытые проекты сохраняют
renderer-order; закрытые остаются архивом по freshness. Клиент может визуально разделять
`Active` и `All`, но внутри каждой группы обязан сохранять порядок, уже пришедший из API.
Не сортировать active-блок по `isActive` или `updatedAt`: это даёт пользовательский симптом
«на Mac порядок проектов нормальный, на телефоне другой», хотя bridge и `/api/projects`
работают корректно.

Изменение этого порядка — отдельный live-сигнал, не tab layout. Renderer `reorderProjects`
после `saveSession()` шлёт `project:order-changed`; следующий `project-activity` кадр несёт
`projectOrderChanged:true`, и native клиент должен тихо перезагрузить `/api/projects` после
своего quiet-window. Не пытайся кодировать новый порядок в `project-activity.projects`:
этот массив остаётся runtime-агрегатом активных проектов, а source of truth порядка —
свежий `/api/projects` через renderer bridge `getOpenProjectIds`.

Создание новых PTY-агентов для native идёт через `/api/projects/:id/agent-tabs {toolType:'claude'|'codex'}`. Этот route намеренно делегирует в renderer `createAgentTab`, но для native/API передаёт `startNow:true`: внешний клиент может никогда не смонтировать desktop `Terminal.tsx`, поэтому один `pendingAction` не запустит CLI и первый `/send` увидит `inactive/no session id`. Не заводить на iOS отдельный launch-path, который сам пишет command в PTY: запуск должен идти через общий renderer/main route, где применяются desktop guards, model/effort defaults, `starting` snapshot и session detection.

`startNow:true` означает не "tab row создан", а "PTY создан и agent launch принят". Если `terminal:create` не может открыть рабочую папку (например, проект всё ещё указывает на удалённый `/Users/fedor/Desktop/cli-tools`), route обязан вернуть structured failure (`409 working_directory_missing`) и не оставлять новый tab как будто он живой. Старый симптом: iOS открывал fresh Codex tab, видел `inactive/no session`, показывал обычный composer, первый send создавал optimistic user-row, а сервер переводил вкладку в fake `starting` без процесса. Для native fresh-agent composer разрешается только при `inputReady=true`; status при этом обычно `active`, но Resume имеет допустимое переходное сочетание `starting + inputReady=true`, пока текущий writer ещё не доказан.

`GET /api/projects/:id/tabs` для native — это уже нормализованный layout snapshot, а не
сырой список процессов: вместе с tabs приходят `groups`, `statuses`, `statusMarker`,
`processBar`, `contextPct`, `filePath`, `groupId` и `visualParentTabId`. Нативный клиент
должен переиспользовать эту модель как mirror desktop sidebar'а. Не заводить отдельную iOS
схему групп, статусов или file-tab связей: иначе desktop DnD/status и phone list начнут
расходиться на первом же `project:layout-changed`.

Layout operations для native split'ятся от runtime activity. CRUD групп и статусы идут через
`/tab-groups/*`, reorder — через `/tab-layout` с `orderedIds`, `groupAssignments` и
`groupAnchorAssignments`; busy/loaders продолжают идти маленьким `project-activity`
snapshot'ом. Если смешать эти оси и перезагружать `/tabs` ради каждого busy-edge, phone снова
получит тяжёлые reload'ы во время навигации.

Native iOS также использует `GET /api/active-loaders` как preflight перед удалённым
`build:install`. Endpoint возвращает широкий snapshot live-состояний, но install UI блокирует
только элементы со `status=busy|running`. Важная граница: idle-alive Claude/Codex CLI — это
живой процесс в PTY, но не loader; такие tabs не должны попадать в `kind:"process"` blockers,
иначе iOS показывает ложный alert «Terminal занят» при полностью idle вкладках. AI tabs
блокируют install только через свои deterministic busy-сигналы (`claudeTurnBusy`/spinner/local
command, Codex rollout `task_started`, SDK query, Gemini busy); ordinary shell commands
блокируют только если `/api/active-loaders` отдаёт `kind:"restart-after"` — команду реально
запустил `Restart after`. Сам install endpoint при этом **не**
находится в custom-terminal — его держит Voice Record, потому что `build:install` закрывает
Noted Terminal и управляющий HTTP-сервер цели может исчезнуть в середине операции.

Native iOS Terminal transcript не должен рендерить REST history как «готовый список строк».
`/history` может вернуть 80 entries, но внутри будут tool results по 40k символов и compact
summary по 200k; если положить этот raw text в row body/diff/measurement, телефон фризит даже
без Timeline. Контракт native-клиента: сначала материализовать bounded display model
(preview, stable id, line-count/raw length, display kind), а полный payload хранить side-store
по entry id и доставать только для full sheet или явного раскрытия user prompt. Tool/bash/MCP
rows в transcript остаются стабильной высоты и открывают full sheet по tap; user prompt может
иметь inline `Show more`/`Show less`, но tap по самому prompt тоже открывает sheet с нативным
выделением текста. Счётчик справа у tool rows — строки, не payload chars: пользователь решает
«насколько большой вывод», а не отлаживает raw JSON size.

Для длинной истории native iOS грузит хвост (`last=80`) и расширяет окно вверх
инкрементально (`80 -> 160 -> 240...`). При таком prepend нельзя сохранять абсолютный
`contentOffset`: новые rows появляются выше, и старый offset начинает указывать на другой
логический текст. Перед reload клиент сохраняет первую видимую entry + delta от верхней
границы viewport, после reload восстанавливает эту же entry в той же точке экрана и повторяет
restore после self-sizing settle. Timeline в этом режиме префетчится при входе в чат; jump к
старой точке может загрузить around-target slice, закрыть drawer, проскроллить table к anchor и
коротко подсветить target row. Шрам и canary-логи: [`fix-ios-скролл-фриз.md`](fix-ios-скролл-фриз.md).

## Native iOS validation via Simulator/WDA

Simulator/WDA smoke не должен тестировать «красоту SwiftUI» отдельно от Project Terminal API:
ценность проверки в том, что один сценарий проходит через native gesture, REST/SSE contract,
runtime status и durable transcript. Рабочий baseline 2026-06-24: WDA создал Codex tab через
`/api/projects/:id/agent-tabs`, дождался `starting → active`, отправил первый prompt, увидел
`busy` в header и `In progress` loader, затем проверил completion через visible answer и
overseer/rollout. Для rollout-дедупа считать только conversation messages
(`response_item.payload.type === "message"` с role `user|assistant`); Codex `event_msg.user_message`
дублирует prompt как служебный event и не является второй строкой visible history.

Pull-to-refresh на native projects/tabs доказывается не одним screenshots. Минимальная цепочка:
`begin-drag` → `pull threshold armed=true` → `refresh begin`/`refresh pin` →
`GET /api/projects` или `/api/projects/:id/tabs` со статусом 200 →
`TerminalProjectSSE rest snapshot reason=pull-*` → `refresh end before` →
`refresh end next`. После `end-refresh` UIKit может ещё логировать `armed=true` и затем
`end-drag shouldRefresh=false` из-за deceleration/adjusted inset; это не второй refresh и не
ошибка само по себе, пока есть единственный `refresh begin` и корректный `refresh end`.

Foreground catch-up проверяется только пока turn ещё реально busy. Короткий prompt успевает
завершиться в фоне и не доказывает loader recovery. Надёжный smoke: отправить Codex prompt,
который выполняет `sleep 20`, увести Simulator в Settings на несколько секунд и вернуть
`com.habittracker.swift`. Сразу после foreground native должен показать `busy`, loader/Stop и
disabled model/effort controls; логи должны содержать `history load done reason=foreground-scene-active`
и `foreground catch-up done ... status=busy`, а после `task_complete` — `status=active`.

Если тесту нужны свежие native logs, сначала пробуй in-app `Copy Terminal and AI Chat log`.
Файлы `~/Library/Logs/voice-record/ios-chat.log` и repo-local `logs/ios-chat-latest.log` могут
быть устаревшими относительно текущего Simulator buffer; stale tail нельзя использовать как
отрицательное доказательство отсутствия `TerminalScroll`/`TerminalSSE` событий.

## Self-healing busy reconciliation (loader никогда не залипает навсегда)

**Проблема.** Мобильный loader («thinking…») управляется SSE-событиями `busy`/`done`. Но если `busy:false`/`done` **потерялся** — turn закончился путём, который не сделал `_webBroadcast busy:false` (например: на десктопе юзер **отклонил** AskUserQuestion → «Request interrupted by user for tool use» → turn оборвался через aborted_streaming), SSE-фрейм дропнулся, ИЛИ баг в самом мобильном коде неверно затрекал busy — phone **залипает** на «thinking…» навсегда. Юзер: *«нажал ⏺ → declined → но на мобилке всё равно идёт thinking… хотя thinking нет; нужен фолбэк, чтобы мобилка подхватывала реальное состояние с продакшена»*.

**Решение — периодический authoritative-поллинг, который ВСЕГДА побеждает.** `ChatView` для PTY-claude табов поллит `Api.claudeStatus` (`claude:get-presence`) на mount + при смене sessionId + **каждые 4с**, и **сверяет** `busy`:
```ts
const authoritativeBusy = d.status === 'busy';
setBusy(cur => cur !== authoritativeBusy ? authoritativeBusy : cur);
```
`get-presence` выводит `status` из `claudeTurnBusy` (Stop-hook pipeline — тот же authoritative источник, которому доверяет десктопный loader), поэтому рассинхрон лечится за ≤1 интервал поллинга, **независимо от причины**. Это и есть «реальное соединение с продом»: мобилка никогда не доверяет своему залипшему `busy` бесконечно — периодическое authoritative-чтение всегда корректирует. Forcing только при **расхождении** (`cur !== authoritativeBusy`), чтобы не драться с in-flight оптимистик-апдейтом в том же кадре. Раньше этот поллинг был **one-shot на mount** (обновлял только `claudeStatus`, не `busy`) — отсюда залипание. Переносимый принцип — [`methodology/дизайн-принципы.md::Authoritative artifact > эвристика`] + «periodic reconcile для latched UI-state от lossy event-канала».

## Mobile composer: caret + permanent ring + selective scrollbar

Три неочевидных решения в `mobile-web/src/App.tsx::Composer`:

- **Orange visible caret** (`caretColor: '#FFB382'`). Раньше пробовал `caret-color: transparent` (юзер: «значок мигающий надо убрать»). Потом юзер репортил «не работает печать» — на самом деле работало, но он не видел каретки и не знал что инпут активен. Caret — единственный достоверный сигнал «текст идёт сюда» когда юзер начал печатать в полупустой инпут.
- **Permanent border `#FFB382`** (всегда, не `focus:border-*`). Юзер: *«просто рамка всегда активна»*, *«заново мигать рамкой тоже не надо»*. Раньше переключали `focus:border-[#555]` — каждый re-focus на mobile (touch tap → blur от scroll → re-focus) давал визуальный flicker рамки. Постоянная оранжевая рамка читается как «вот THE инпут».
- **Conditional orange scrollbar**: textarea автоэкспандится до 40vh; пока content не достиг кап, `overflowY: hidden` (никакого скролла в одну строку); как только превысил — `overflowY: auto` + класс `composer-textarea--scroll` который **переписывает глобальное** `::-webkit-scrollbar { width:0 }` на `width:6px` с `thumb: #FFB382` (orange, отделено от history-скролла который остаётся скрытым). Юзер: *«у инпута, если у нас одна строка, не должен отображаться scroll, и также scroll у инпута сделай отдельно, оранжевым»*.
- **Mic-dictation (Soniox)**: 🎤-кнопка в row 2 composer'а, тот же движок что в десктопном `MicButton` (`mobile-web/src/dictation.ts` — копия `src/renderer/utils/dictation.ts`, два независимых Vite-билда не могут шарить через alias). При старте — `prefixRef.current = text` снимает снэпшот того что юзер успел напечатать, потом `onUpdate` пишет `prefix + final + partial` в textarea. Без снэпшота транскрипт затирал бы пользовательский текст. По stop — `prefixRef.current = ''` для следующей сессии. Floating window над кнопкой реализован прямо в composer'е (не делегируется внешнему компоненту). Token mint — `Api.sonioxToken()` → `POST /api/soniox-token` → main process с `SONIOX_API_KEY` из env. **Требует secure context**: `navigator.mediaDevices` существует только на HTTPS/localhost. Phone грузит mobile-web по plain `http://<lan-ip>:7878` в **dev** → `mediaDevices === undefined` → мик не работает («needs HTTPS» в `onError`, явный guard в `dictation.ts` вместо загадочного «Cannot read getUserMedia of undefined»). На **Prod** (HTTPS через VPS-туннель, `fact-remote-access.md`) — работает; WKWebView сам грантит мик через `allowsInlineMediaPlayback`. Тот же `MediaStreamAudioDestinationNode`-фикс от SIGSEGV что на десктопе — см. [`fix-mic-renderer-sigsegv.md`](fix-mic-renderer-sigsegv.md).

## Endpoint map

```
GET  /api/me                                   → ping, проверка токена
GET  /api/projects                             → SQLite + isOpen/isActive + project icon из renderer bridge
GET  /api/inbox                                → system Inbox project metadata
POST /api/inbox/runs                           → внешний Codex run в system Inbox: create/reuse tab по conversationKey, wait TUI-ready, send prompt, return runId/tabId/eventsUrl
GET  /api/inbox/runs/:runId                    → lifecycle/delivery receipt exact внешней попытки, без повторного действия
GET  /api/inbox/runs/:runId/result             → canonical result по run+handoff+attempt+session+user-turn; SSE только будит это чтение
POST /api/inbox/runs/:runId/rewind             → exact external rewrite/native Rewind через общий scenario layer
POST /api/inbox/runs/:runId/stop               → остановка внешнего Codex run тем же stop-flow, что desktop/PTY Codex. Fail-closed: недоказанный stop (structured refusal / lookupUnknown / bridge error) возвращает 409 `agent_stop_unconfirmed` (или 500 при исключении), run возвращается в прежний статус, авто-close НЕ планируется, ранее взведённый auto-stop таймер перевзводится. Клиенты обязаны обрабатывать не-200: раньше route всегда отвечал 200 и мог закрыть вкладку с ещё живым агентом
POST /api/projects/:id/rename                  → renameProject (через bridge → updateProject{name} → project:save-metadata)
GET  /api/projects/:id/tabs                    → tabs + groups + statuses + timelineCount + live state + statusMarker/processBar/contextPct
POST /api/inbox/sdk-tabs                       → createSDKTab в system Inbox, без projectId у клиента
POST /api/projects/:id/sdk-tabs                → createSDKTab (через bridge)
POST /api/terminal-tabs/:tabId/send                 → sendAgentPromptScenario; project ownership, TUI draft conflict не очищается
POST /api/terminal-tabs/:tabId/start                → fresh Claude/Codex runtime в existing PTY, когда Resume недоступен
POST /api/terminal-tabs/:tabId/stop                 → stopAgentProcessScenario; для legacy SDK fallback query.close()
POST /api/terminal-tabs/:tabId/close                → closeTab (через bridge, body {aiBusy?})
POST /api/terminal-tabs/:tabId/rename               → renameTab (через bridge)
POST /api/terminal-tabs/:tabId/open-in-workspace    → exact restore/place/reveal в указанном workflow/window; явное открытие отменяет external auto-close
POST /api/terminal-tabs/:tabId/fork                 → forkToTab: materialized Claude/Codex session → соседний PTY tab с тем же pendingAction, что desktop
POST /api/tabs/:tabId/fork-to-sdk                   → forkToSDK (через bridge → fork-from-session); legacy route вне Project Terminal API
GET  /api/terminal-tabs/:tabId/history              → JSON or NDJSON (Accept-driven)
                                               → query params: ?last=N (tail), ?after=<uuid> (delta sync), ?before=<uuid> (prefix backfill)
                                               → Accept: application/x-ndjson → streamed line-by-line, Brotli-4
POST /api/terminal-tabs/:tabId/truncate              → drop everything ≥ targetUuid (Edit/Repeat)
GET  /api/terminal-tabs/:tabId/send-receipts        → read-only durable receipt list; optional `handoffId`, чтение никогда не повторяет send
GET  /api/terminal-tabs/:tabId/timeline             → server-normalized Timeline; composite строки несут `entryRef` + `contentRevision`
POST /api/terminal-tabs/:tabId/rewind               → общий agent scenario; exact tuple проходит до main write-boundary, stale/ambiguous target отклоняется до provider mutation
GET  /api/terminal-tabs/:tabId/rewind-state         → read-only commit/unchanged/pending проекция prepared native branch
GET  /api/terminal-tabs/:tabId/params               → параметры model/effort/think и Codex `fast/fastPending` для agent tab
POST /api/terminal-tabs/:tabId/params               → применить параметры через runtime-specific path
POST /api/terminal-tabs/:tabId/codex/fast           → атомарно переключить durable Fast intent; stopped/starting принимаются, ответ несёт `desiredFast/revision/queued`
POST /api/terminal-tabs/:tabId/interrupt            → soft interrupt текущего turn'а (PTY Esc / SDK close warm)
GET  /api/terminal-tabs/:tabId/draft                → authoritative чтение TUI composer после interrupt
GET  /api/terminal-tabs/:tabId/draft-state          → read-only preflight состояния TUI composer перед mobile send
GET  /api/terminal-tabs/:tabId/queue                 → getPromptQueue (core + sibling aiTabs)
POST /api/terminal-tabs/:tabId/queue                 → mutatePromptQueue ({op, args})
GET  /api/terminal-tabs/:tabId/pending-question      → текущий AskUserQuestion (connect mid-question)
POST /api/terminal-tabs/:tabId/answer-question       → answerClaudeQuestion ({source, answers, stop})
GET  /api/active-loaders                       → live loaders snapshot для external install preflight
GET  /api/project-activity                     → full project activity snapshot для native project badges
GET  /api/events?scope=projects                → SSE только project-activity, без tab transcript watcher'ов
POST /api/mobile-attachments                   → upload iOS camera/gallery/file bytes в Mac temp, cap 25MB
POST /api/mobile-attachments/preview           → восстановить preview temp upload по absolute path, image cap 12MB
DELETE /api/mobile-attachments/:id             → удалить temp upload, если chip убрали до send
POST /api/file-preview                         → read-only file-tab preview по absolute path, cap 1MB
GET  /api/prompts[?etag=X]                     → getPrompts + getPromptGroups + `resolvedText` (content + sanitized file_paths, no bridge); ?etag match → { etag, unchanged: true }
GET  /api/agent-models                         → живой каталог моделей: Codex из `codex debug models`+Settings, Claude со stable selection id, label и точным runtimeId из Settings; `controlCapabilities.codexEffortPicker` описывает controller effort. Новый caller передаёт `modelSelection:{kind:'catalog'|'custom',id}`, а не угадывает строковый alias; capability — `/api/me.capabilities.agentModelSelection.version`, адресное разрешение для start-path — `POST /api/agent-models/resolve`. Прямые роуты до `let m` — см. «Гочи let m»
GET  /api/app-settings                         → app-level settings через renderer bridge (`streamerMode`)
POST /api/app-settings                         → mutate app-level settings (`streamerMode`) через desktop source of truth
POST /api/log/client                           → mobile diagnostic logs → console.log → dev.log
GET  /api/events?token=&tabId=                 → SSE (text/event-stream) — ОСНОВНОЙ live-канал. snapshot/message/busy/done/bridge-update/queue-update/ask-question/question-cancelled. Не блокируется anti-tracker'ами как ws://. См. секцию «SSE transport».
GET  /api/events?tabIds=<JSON array>             → тот же SSE для 1–32 явных tabs, один клиентский connection
GET  /api/terminal-tabs/:tabId/timing            → main-owned running/preflight/pending interval + read/writer scope
WS   /ws?token=&tabId=                          → тот же набор events. Legacy-канал для permissive-браузеров; на Yandex/Chrome с Protect не работает (ws:// к private-IP режется молча).
POST /api/projects/:id/claude-tabs              → legacy alias на native-safe `/agent-tabs` для Claude; тоже стартует CLI без ожидания mounted Terminal
POST /api/inbox/agent-tabs                      → создать PTY+Claude/Codex таб в system Inbox; body {toolType}
POST /api/projects/:id/agent-tabs               → создать PTY+Claude/Codex таб; body {toolType:'claude'|'codex'}
POST /api/projects/:id/tab-groups               → create group row через renderer bridge
POST /api/projects/:id/tab-groups/:gid/rename   → rename group
POST /api/projects/:id/tab-groups/:gid/toggle-collapsed → collapse/expand group
POST /api/projects/:id/tab-groups/:gid/status   → assign/clear group session status
POST /api/projects/:id/tab-groups/:gid/delete   → delete group container, keep tabs
POST /api/projects/:id/tab-layout               → reorder tabs/groups + group assignments/anchors
POST /api/terminal-tabs/:tabId/start                 → fresh runtime start в existing PTY, когда сохранённого разговора ещё нет
POST /api/terminal-tabs/:tabId/resume                → resume в existing PTY; 200 только после live runtime ready, startup defaults отдельными полями
GET  /api/terminal-tabs/:tabId/status                → coherent runtime: lifecycle/input/turn, generation/revision, session/read/writer identity
```

Для Claude/Codex PTY-табов расширение mobile-web — см. `fact-mobile-claude-pty.md`. `/send`, `/stop`, `/interrupt`, `/draft`, `/draft-state` и `/rewind` роутятся через общий scenario layer: backend сам выбирает Claude PTY/Codex PTY runtime, а endpoint остаётся Project Terminal API. Legacy SDK fallback существует только для старых SDK-табов, не как модель нового API.

В текущем продуктовом потоке native iOS использует обычный `mode:"native"`: выбранный prompt возвращается в composer после подтверждённого native Rewind и авторитетной перезагрузки истории. В SwiftUI-коде ещё осталась доступная ветка меню `AI` → `mode:"ai"`, которая делает native откат и auto-submit Gemini-сводки, но основной iOS Rewind на неё не опирается. Desktop `AI` имеет другой смысл: он готовит замену сохранённого диапазона сводкой через review/Apply; соседний desktop `Chat` оставляет Rewind-промпт неотправленным для ручной правки. Простое изменение desktop-кнопок поэтому не меняет обычный iOS Rewind.

`/start` и `/resume` — часть того же Project Terminal API, а не сырой bridge proxy. Успешный ответ доказывает готовность live runtime/composer'а к следующей команде; bridge failure/runtime readiness timeout возвращаются как non-success JSON. После ожидания startup defaults сервер обязательно перечитывает единый свежий runtime snapshot: readiness до ожидания не переживает Exit/Stop автоматически. Ошибка defaults при всё ещё живом и заново доказанном runtime не равна failed resume: ответ несёт `startupDefaultsReady=false`/`startupDefaultsError`, а клиент показывает warning/error gate без вечного `starting`. Если свежий snapshot уже `stopping/inactive`, потерял `inputReady` или недоступен, ответ не может сохранить старое `ready:true`. Native клиент после настоящей action-ошибки должен снять локальный `starting`, а не ждать следующего poll/SSE snapshot'а, потому что `starting busy=false` после failed resume часто является stale startup state.

Stop/Interrupt также различают три результата process lookup. Только успешный пустой снимок (`processAbsent/noProcess`) означает «активной сессии нет» и может вернуть идемпотентный 200. `process_lookup_failed/lookupUnknown` возвращается как 503 с исходными деталями; разрыв bridge и его timeout — 502/504. Renderer→main bridge обязан передать структурированный domain-result даже при `success:false`, иначе HTTP-слой превращает неизвестность в ложное отсутствие и клиент снимает loader как после доказанного Stop.

Если resume/startup завершился ошибкой, API обязан вернуть/разослать явный failure-state, который клиент может показать в той же blocking-поверхности. Пропажа resume-overlay без успеха недопустима: для пользователя исчезновение окна означает «готово», а не «ошибка ушла в лог». Поэтому ошибка readiness/watchdog должна быть видимой (`startupError`/non-success JSON/SSE), пока пользователь не закроет или не повторит действие.

`/draft-state` — диагностический/read-only preflight, а не разрешение на Send и не команда
активации desktop UI. Native iOS не строит вокруг него второй send-flow: `/send` сам проверяет
чужой draft непосредственно на границе записи, выбирает start/resume/direct/queue и возвращает
structured conflict/rollback. Если renderer видит mounted xterm, отдельный inspect всё ещё
может вернуть `hasDraft=true/false`; если вкладка скрыта и terminal-компонент не смонтирован,
ответ остаётся `source:"no-terminal"` / `hasDraft:null`, без `showWorkspace`, `setProjectView`
или `switchTab`. Phone не имеет права переключать проект/вкладку на Mac ради проверки draft.

Для Codex это правило после 2026-06-20 стало строже: скрытая вкладка не должна автоматически
давать `source:"no-terminal"`, пока main-side headless xterm mirror может классифицировать
composer. Renderer bridge action обязан сначала вызвать общий `codex:get-draft-state`, который
читает main/headless proof и только потом переходит к mounted renderer. `no-terminal` для
живого Codex теперь означает «оба proof-канала не смогли дать ответ», а не разрешение молча
пропустить guard. Это сохраняет background Rewind/History/API без фокуса Mac-вкладки.

`POST /api/terminal-tabs/:tabId/send` следует той же границе совместимости: при реальном
terminal draft он возвращает `409 terminal_draft_conflict`, но не вызывает
`grabAgentDraft` и не очищает TUI composer. Для Codex active/send path сначала пытается получить
main/headless draft proof; если он доказал empty composer, send продолжает PTY/audit-путь и
сверяется уже по rollout/JSONL. Если proof неизвестен, это ambiguity/error для клиента, а не
повод переключать desktop UI или фокусить вкладку на Mac. Для fresh/resume сессий это послабление
не действует — startup/readiness по-прежнему обязателен, иначе prompt можно отправить в экран запуска или MCP-confirmation.
Нормальная отправка с native iOS не должна перед этим вызывать destructive `GET /draft` как обязательный gate: `/draft` нужен после interrupt/Rewind или явного "забрать input", а не как проверка "можно ли отправлять". Такой preflight дублирует scenario layer и даёт ложный `claude_busy` в момент, когда `/send` сам умеет решить busy/queue/draft-conflict. Если клиенту нужна только защита от чужого текста, использовать read-only `/draft-state`; окончательное решение всё равно принимает `/send`.
Это важно для native iOS и старых project/tab-клиентов: они управляют конкретной вкладкой,
поэтому источник текста остаётся в терминале до явного действия пользователя. Противоположный контракт только у
`/api/inbox/runs`: Inbox-клиент владеет своим chat composer, поэтому Noted Terminal
может забрать draft, очистить terminal input и вернуть `draftText` наружу для rollback.

Codex Fast вынесен в отдельный `POST /api/terminal-tabs/:tabId/codex/fast`, потому что он не меняет `codexModel`/`codexEffort`, но теперь это persistent desired state, а не требование немедленно выполнить live slash. Endpoint атомарно переключает main-owned intent с ревизией и поэтому работает при stopped/starting; после готовности main сверяет exact `priority/default` и лишь при несовпадении пишет `/fast`. Два запроса до readiness дают состояние последнего запроса, а не два отложенных toggle. `GET .../params` возвращает `fast` и `fastPending`; POST — `desiredFast`, `revision`, `queued`. Не возвращать прежний live-only preflight в iOS: draft/turn проверяются в момент реальной PTY-транзакции, а не в момент сохранения intent.

Все pathname-параметры (`:id`, `:tabId`) ОБЯЗАТЕЛЬНО прогоняются через `decId()` (`decodeURIComponent`) перед использованием — см. секцию «URL-encoded path параметры» ниже.

Публичный URL вместо LAN-IP — см. [`fact-remote-access.md`](fact-remote-access.md). С phone'а через интернет endpoint-map тот же, отличается только хост в URL.

**Гочи: общий `let m` в цепочке роутов = TDZ на вставке нового роута выше.** Хендлер строит роуты последовательными `m = parsed.pathname.match(...)`, но переменная `m` объявляется через `let` **один раз** — исторически на роуте `/tabs` где-то в середине файла. Если добавить новый роут (как project-rename) **выше** этой `let`-строки и написать там `m = match()`, JS temporal dead zone роняет вызов: `Cannot access 'm' before initialization` — и не только новый роут, а **все** роуты от точки вставки и ниже отдают 500 (исключение прерывает хендлер). Симптом был коварный: `/api/projects` (отдаётся выше вставки) работал 200, а `/api/projects/:id/tabs` и `/rename` (ниже) — 500, на iOS «переименование откатилось, на десктопе ничего». Правило при вставке роута: первый по файлу `m = match()` обязан быть `let m =`; всё ниже — голые присваивания. Перенёс объявление `let m` на самый верхний роут (project-rename), бывший `let m` у `/tabs` стал `m =`.

## URL-encoded path параметры (`=` в base64-id)

ProjectId формируется как `base64(path)`. Короткие пути (`/Users/fedor/Desktop/vs-code/agrotech/uav` → `L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvdnMtY29kZS9hZ3JvdGVjaC91YXY=`) оканчиваются на `=`, который в URL сериализуется как `%3D`. Tab-id наследует base64-префикс от projectId, тот же эффект.

**Симптом:** `HTTP 404: {"error":"project not found","projectId":"…%3D"}` только на проектах с коротким именем; длинные имена (`custom-terminal`) с padding `0` или `==` без `=` работают сразу.

**Причина:** regex-захват `parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tabs$/)` возвращает **URL-encoded** строку. `projectManager.db.getProjectById('…%3D')` ищет в SQLite по дословному ключу, а в БД — декодированный `=`. Не находит → 404.

**Решение:** helper `decId(s) { try { return decodeURIComponent(s); } catch { return s; } }` обязательно применяется к каждому `m[1]` / `m[2]` в `web-server.js::handleApi`. Это покрывает не только `=`, но и кириллицу, пробелы, любой символ который mobile-web кодирует в URL. Когда добавляешь новый route с pathname-параметром — `decId(m[1])`, не голый `m[1]`.

## Live-fallback для `/api/projects/:id/tabs` через Zustand-bridge

`getProjectById` в `database.js` ходит **только в SQLite**. Проблема: проекты бывают **dashboard-only / draft** — открытые в Zustand `openProjects` Map, но ещё не записанные через `saveTabs` в БД. До этой правки таких проектов с phone'а нельзя было открыть — 404.

**Логика endpoint'а теперь двухступенчатая:**
1. `projectManager.db.getProjectById(projectId)` — основной путь (persisted проекты).
2. Если `null` → `bridgeRequest('getProjectTabsLive', { projectId })` — renderer проверяет `state.openProjects.get(projectId)` в Zustand и отдаёт live-snapshot табов.
3. Если и там нет → 404 с диагностическим логом `[WebServer] 404 project not found: <id> (not in DB, not in live Zustand)`.

Bridge-action `getProjectTabsLive` в `App.tsx::handleWebBridge` возвращает табы в том же shape что SQLite-путь, чтобы phone не отличал. Один из крайних случаев: если проект **открыт в UI и одновременно есть в БД с другим набором табов** — live из Zustand берёт верх (первый ступень нашла, ко второй не пошли). Это правильно — Zustand authoritative для активного состояния.

## Stale prod-app → silent bridge timeout (5s)

**Самый дорогой класс багов с phone-доступом.** Если в `App.tsx::handleWebBridge` или `web-server.js::bridgeRequest` сделана правка, но **не запущен `build:install`** — prod-app продолжает работать со старой сборкой в asar. С позиции web-server'а bridge-вызов уходит в `webContents.send('web:bridge-request', …)`, renderer его получает, но **handler с нужным action'ом не зарегистрирован** в старой версии → reply не приходит → ровно через `timeoutMs` (5000 по умолчанию) web-server отдаёт 500 `Bridge timeout: <action>`.

**Симптомы:**
- `[WebTiming] /history ERROR Bridge timeout: loadSDKHistory total=5000ms` (или другой action ровно по таймауту).
- Phone показывает бесконечный loader, через ~15с — пустой чат с composer'ом «Send something below».
- `/timeline` тоже валится в `bridge=1500ms` (там короче timeout на `getOpenProjectIds`), но **продолжает работать** через fallback на пустой openIds + чтение JSONL напрямую → юзер видит таймлайн при пустом чате, что особенно сбивает.

**Диагностика — мгновенные парные логи в трёх точках:**
- `web-server.js::bridgeRequest` пишет `[BridgeDiag] SEND action=… rid=… wins=…` на отправке, `[BridgeDiag] REPLY action=… elapsedMs=…` на приёме, `[BridgeDiag] TIMEOUT action=…` при истечении, `[BridgeDiag] REPLY_DROPPED rid=…` если ответ пришёл уже после timeout.
- `App.tsx::handleWebBridge` пишет `[BridgeDiag:R] RECV rid=…` на входе и `[BridgeDiag:R] REPLY rid=… ok=… elapsedMs=…` перед `ipcRenderer.send('web:bridge-reply', …)`.

Сценарии чтения:
- `SEND` без последующего `RECV` (через ~50ms gap) → renderer не получает IPC. Window-mismatch, dead webContents, или handler не зарегистрирован.
- `SEND + RECV + REPLY:R + REPLY (main)` все есть → всё ок, замерь `elapsedMs`.
- `SEND + RECV + REPLY:R` но `REPLY_DROPPED` в main → ответ опоздал, поднять `timeoutMs` для этого action'а в `bridgeRequest`.
- `SEND + RECV` но **нет** `REPLY:R` → handler упал silent внутри `await` (например `ipcRenderer.invoke('claude-sdk:active-branch-messages', …)` на огромном JSONL).

**Правило:** любая правка `App.tsx::handleWebBridge` или `web-server.js::bridgeRequest` требует `npm run build:install` перед тестом с phone'а — иначе симптом всегда будет «Bridge timeout» вне зависимости от качества правки. Это занудно, но иначе час уйдёт на отладку не того процесса. Mobile-web Vite dev (`cd mobile-web && npm run dev`) НЕ решает — фронт можно итерировать без билда, но `web-server.js` живёт в Electron main, его правки требуют `build:install` всё равно.

**`build:install` теперь собирает мобилку сам.** Цепочка: `graceful-quit → build:markdown → build:mobile (cd mobile-web && npm run build) → electron-vite build → electron-builder → install`. Electron-builder **копирует** `mobile-web/dist/**` в asar (`build.files`), но НЕ собирает — раньше пёк устаревший dist, если забыл пересобрать вручную. Каждый `npm run <step>` изолирован (npm всегда cwd=package-root), поэтому внутренние `cd` в `build:markdown`/`build:mobile` не утекают в следующий шаг. `build:mobile` — отдельный скрипт, можно дёрнуть в одиночку для быстрой пересборки только фронта.

## Wire protocol (общий для SSE и WS)

Один и тот же JSON-envelope летит и через SSE (`data: <json>\n\n`), и через WS (`ws.send(<json>)`) — `webBroadcast` транспортно-агностичен (см. «SSE transport»). Server → client:
```
{ type:'snapshot',     tabId, sessionId, busy, sessionStatus?, inputReady? }   — на connect и при lifecycle-сменах
{ type:'message',      tabId, message, sessionId }                              — каждое SDK или JSONL-сообщение
{ type:'busy',         tabId, busy }                                            — переключение busy (SDK + PTY-Claude + Codex)
{ type:'done',         tabId, sessionId }                                       — окончание turn'а
{ type:'bridge-update', tabId, sessionId, model, contextPct }                   — PTY-Claude: StatusLine bridge.json обновился
{ type:'queue-update',  tabId, queue }                                          — Run-after очередь изменилась (десктоп или другой телефон); `queue` = PromptQueueCore
{ type:'ask-question',  tabId, source, toolUseID, questions }                   — Claude задал AskUserQuestion; source=pty|sdk
{ type:'question-cancelled', tabId, source }                                    — вопрос отвечен/прерван/turn оборвался
```

Вопросы (`ask-question`/`question-cancelled`): десктоп показывает AskUserQuestion в Ink TUI, мобилка TUI не имеет — main бродкастит **контент** вопроса, телефон рисует свой пикер. PTY-ответ драйвит Ink клавишами, SDK резолвит parked `canUseTool` Promise. Полная механика — `fact-claude-awaiting-input.md::Мобильное расширение`.

`sessionStatus` / `inputReady` / `bridge-update` появились с расширением mobile-web на CLAUDE-PTY-табы — см. `fact-mobile-claude-pty.md::WS protocol`.

Client → server: `{ type: 'subscribe', tabId }` для смены подписки на лету (текущая mobile-сборка не использует — переподключается).

## Token & paths

- Файл токена: `~/.noted-terminal/web-token.txt`, генерируется `crypto.randomBytes(24).toString('hex')` при первом старте, mode 0o600.
- Auth: `Authorization: Bearer <token>` для REST. WS не может отправить custom headers из браузера → токен идёт в query `?token=...`. Сервер проверяет оба.
- Mobile сохраняет токен в localStorage первый раз когда видит `?token=...` в URL, потом чистит через `history.replaceState` (чтобы он не светился в адресной строке). См. `mobile-web/src/api.ts::bootstrapToken`.

## Production packaging: `mobile-web/dist/**/*` обязателен в `build.files`

Production `web-server.js` раздаёт SPA по `path.resolve(__dirname, '../../mobile-web/dist')`. Из `app.asar/src/main` это резолвится в `app.asar/mobile-web/dist` — но если в `package.json::build.files` нет `mobile-web/dist/**/*`, директории внутри asar нет, и phone получает text-ответ «mobile-web/dist not built. Run: cd mobile-web && npm run build» (этот fallback в `serveStatic` при ENOENT). Electron-овский патченный fs прозрачно читает файлы из asar — никакого `asarUnpack`/`extraResources` не нужно, достаточно include. Билд порядок: сначала `cd mobile-web && npm run build`, потом electron-builder.

## Module loading: srcMainDir, не relative

`web-server.js` лежит в `src/main/`, **не** в `dist/main/`. Electron-vite бандлит только `main.js`, sibling-модули копируются как raw .js. Поэтому загружать через:
```js
const webServer = require(path.join(srcMainDir, 'web-server'));
```
а **не** `require('./web-server')` — relative resolve смотрит относительно `dist/main/main.js`, файла там нет → `Cannot find module './web-server'`.

Тот же паттерн применён для `_webBroadcast` lazy-require в `sdkStartQuery`.

## Mobile diagnostic logs

`POST /api/log/client { tag, msg, data }` → `console.log('[' + tag + '] ' + msg + ...)` → попадает в `logs/dev.log` через стандартный console interceptor. Используется когда поведение надо отлаживать с phone (touch-events, scroll, focus): `Api.log('TimelineGoTo', 'jump', { targetTop, currentScroll })`. Без этого с iPhone Safari отладочную информацию не достать.

## Code map (неочевидные связи)

- Mobile-web `prefetch timeline on ChatView mount` (а не on drawer-open) → к моменту тапа на ☰ entries уже в state, drawer открывается instantly. Critical для UX на 200+ entries.
- Drawer mount-pattern: `display: none` вместо `{open && ...}` → scrollTop сохраняется браузером бесплатно, не нужен manual save/restore.
- `webServer.start({ sdkSessions })` принимает Map by reference. Если declaration `sdkSessions` находится **ниже** call-site `webServer.start()`, получишь TDZ ReferenceError. Декларацию держать в верхней секции `main.js` рядом с `srcMainDir`/`projectManager`, а не возле SDK-обработчиков.
- `parseTimelineEntries` фильтрует тот же noise что desktop Timeline: `<command-name>`, `<system-reminder>`, `<task-notification>`, `<local-command-stdout>`, `<local-command-stderr>`, `[Request interrupted]`. Без этого первые 5 timeline-entries — это model-switch slash-команды.

## Routing (HashRouter)

URL-схема: `#/projects/:projectId/chat/:tabId[?ro=1]`. HashRouter а не BrowserRouter — node-static в `web-server.js` не имеет SPA-fallback'а на произвольные pathnames; hash на сервер не уходит, фрагмент читается клиентом. Reload на любой странице → попадаешь обратно туда же. Deep-link (нет `state.tab` в `history.state`) → `Api.listTabs(projectId)` ищет TabInfo по `tabId`, либо показывает «Tab not found» с кнопкой назад. См. `methodology/переносимый-дизайн-mobile.md::Deep-link routing`.

## History pipeline (NDJSON streaming + IDB delta sync + virtuoso)

**Архитектура (заменила window-render + JSON two-phase в мае 2026):**

```
Mount ChatView
  ↓
[Phase 0] readCachedHistory(sid) → IDB hit?
   yes → reducer.reset + apply ALL cached → paint immediately, historyLoading=false
   no  → continue
  ↓
[Phase 1] streamHistory(?last=200) — NDJSON over Brotli-4
   meta {total, returned, firstUuid, lastUuid, etag}
   message...message...message  (one JSON per \n)
   done {written}
   ↓ each message: reducer.apply, scheduleFlush per rAF
  ↓
[Phase 2 — only if cold and total > returned] streamHistory(?before=<firstTailUuid>)
   ↓ collect into prefixBuffer
   ↓ on done: prefixMergeLockRef = true
   ↓        reducer.reset → apply(prefix + tail) → drain wsDeferredQueue
   ↓        prefixMergeLockRef = false
   ↓        flush
  ↓
[Persist] writeFullHistory(sid, rawHistoryBufferRef, etag, total, lastUuid)
```

Warm-cache путь: только одна фаза `?after=<cachedLastUuid>` — сервер вернёт пустой стрим (silent revalidation) или дельту с момента последнего mount'а.

Editable-last-prompt proof: для `view=history` сервер может вернуть выбранную durable user-entry с `deliveryStatus:'editable-last-prompt'` и top-level `editableLastPromptStatus`, когда native Claude Rewind успешно перенёс этот текст обратно в composer живой вкладки. JSONL при этом не меняется, но History-клиент не должен рисовать эту запись как отправленное сообщение: он заканчивает рабочую ветку перед target и показывает текст только в input. Raw/Timeline-представление вправе сохранять физическую запись. `etag` для history-view обязан учитывать смену этого proof-состояния даже без нового uuid.

**NDJSON wire format:**
- `Accept: application/x-ndjson` → server отвечает `Content-Type: application/x-ndjson`, `Content-Encoding: br` (если accepted)
- Line 1: `{"type":"meta", total, returned, truncated, dropped, sessionId, etag, firstUuid, lastUuid}`
- Lines 2..N+1: один SDK-message JSON на строку
- Last line: `{"type":"done", written}` — sentinel для clean stream end vs cut-off

Клиент-парсер: ручной `response.body.getReader()` (Safari нет async-iterable bodies до 26.x), `TextDecoder({stream: true})` для multi-byte chars across chunks, split по `\n` с carry-over remainder.

**Virtuoso вместо window-slice:** DOM bounded ~15-30 items независимо от total. **Удалили:** `renderStart/renderEnd`, "Load older" кнопку, full-screen GoTo overlay, `fullLoading` state, "N new below" marker, ручной scroll-restore. GoTo через `virtuosoRef.scrollToIndex({index, align:'center'})` — instant, без force-render.

**IDB record store** (idb 8.x):
- `meta` store keyed by `sessionId`: `{lastUuid, etag, total, updatedAt}`
- `messages` store keyed by `[sessionId, ord]`: одна запись на сообщение, secondary index `by-uuid`
- Read returns structured-cloned live objects — **нет JSON.parse на хот-пути** (vs 30ms parse 20MB blob каждый mount)
- Delta sync: meta.lastUuid → server `?after=<lastUuid>` → дописываем appendDelta. Полный rewrite только когда нет cache.

## SWR-кэш списков проектов/табов (мгновенный заход в проект)

**Проблема:** заход в проект показывал full-screen «Loading…» пока `Api.listTabs`
не вернётся целиком — а он тянет live-статус по каждой вкладке (N+1, задача #42),
поэтому «крайне долго». То же на экране всех проектов.

**Решение — stale-while-revalidate** через generic `kv`-store в том же IDB
(`idb.ts`, DB **v2**, additive upgrade — chat-history stores НЕ тронуты):
- `kv` keyed by string: `'projects'`, `'tabs:<projectId>'`. Хелперы `readKv`/`writeKv`
  (best-effort, `try/catch` — private-mode IDB недоступен → фоллбэк на сеть).
- `ProjectRoute`: на mount читает `tabs:<id>` из кэша → `setData` мгновенно (paint
  табов за ~18ms, измерено), параллельно фоновый `listTabs` → overwrite + `writeKv`.
  Inline-спиннер (`InlineSpinner`, серый, в `right`-слоте `Header`) виден ТОЛЬКО пока
  идёт фоновый refresh (`revalidating` флаг) — табы остаются видимы и кликабельны.
- `ProjectsView` (все проекты): seed из `kv:'projects'` на mount + `writeKv` на каждом
  4s-poll. Full-screen «Loading projects…» только при cold-open с пустым кэшом.
- `ChatRoute` deep-link reload: резолвит таб сперва из `tabs:<id>` кэша (instant),
  потом подтверждает сетью. Историю чата дальше красит свой IDB-кэш истории.

Known edge 2026-06-14: если project-card loader на экране всех проектов не горит при уже активном desktop turn, но после захода в проект tab-row loader виден и после возврата project-card тоже начинает гореть, не чини Codex/Claude streaming заново. In-tab SSE уже жив; рассинхрон находится между child tab runtime/revalidation и parent `ProjectsView` aggregate/cache adoption. Симптом важен для поиска: «loader на проекте появляется только после открытия проекта».

## Project activity snapshot для native iOS badges

Для нативного iPhone Terminal project list нужен не transcript и не live-канал каждой вкладки,
а маленький агрегированный снимок по проектам. Контракт: `GET /api/project-activity` отдаёт
полный snapshot вида `{projects:[{projectId,count,streaming,tabs:[{tabId,status,streaming,inputReady,turnBusy,lifecycleGeneration,runtimeRevision,sessionId}]}],ts}`.
Тот же payload летит первым событием и последующими обновлениями через
`GET /api/events?scope=projects` (`projectActivity=1` оставлен как совместимый alias). Это
отдельный subscriber topic, не `tabId`: scope=projects не запускает Claude JSONL watcher,
не подписывается на N вкладок и не получает `message`/token events.

Snapshot намеренно полный, а не дельты `+1/-1`. iOS может потерять событие, уйти в background
или поймать zombie-SSE; следующий full snapshot исправляет count/loader без ручного захода в
проект. Heartbeat остаётся обычным `: hb`, reconnect на клиенте всегда делает REST seed.
Отсутствующий project или tab в snapshot означает inactive/zero, а не «оставь старое».

Строка `status` в этом payload — часть той же versioned runtime-проекции, а не самостоятельный источник правды.
Реальный владелец состояния остаётся на Mac: жив ли процесс, готов ли Codex/Claude к вводу,
идёт ли turn, доказан ли exit. HTTP-ответ на `/resume` или `/stop` подтверждает контракт
действия, но не заменяет runtime-событие для списков: `ready/inputReady` сильнее устаревшего
`starting`, `busy` сильнее ready, а отсутствие tab после stop — уже финальный ноль. Не
переноси mobile-side локальные фазы (`resuming`, `stopping`) обратно в server truth: клиент
может держать их только до первого авторитетного runtime snapshot.

`computeProjectActivity()` собирает агрегат из живых runtime maps: Claude PTY, Codex, Gemini,
SDK и safety-net `activityOpenIntervals` на случай, когда edge уже открыт, а конкретный engine
карта ещё не успела обновиться. Это не второй детектор busy-state: все входы всё равно идут от
тех же lifecycle/busy send'ов, что рисуют desktop/mobile loaders и пишут Agent Activity.
`broadcastProjectActivity(reason)` debounced (~80ms) и no-op без subscribers; триггеры —
busy/done/snapshot, `_notifyClaudeSession`, `recordActivity` open/close. Не слать это событие
на каждый token/message: project badge интересуют только переходы состояния.

`tabs[]` в snapshot — компактный runtime patch для native project-tabs page. Он нужен, чтобы
телефон, стоящий на списке вкладок проекта, увидел busy-loader без входа в chat и без
фонового `/api/projects/:id/tabs` refresh во время свайпа. Полные tab metadata, порядок,
statusMarker, processBar и contextPct остаются ответственностью `/api/projects/:id/tabs`;
project-activity патчит только `status/streaming`.

Completion notification использует тот же project-activity канал, но это отдельная ось от
busy. Если desktop bell сработал на скрытой AI-вкладке, snapshot включает
`notificationCount` на project item и компактные tab-поля
`completionNotificationFired/FiredAt/Mode`; проект остаётся в `projects[]` даже когда
`count=0` и `streaming=false`. `GET /api/projects` дублирует агрегат как
`completionNotificationCount`, а `GET /api/projects/:id/tabs` отдаёт per-tab
`completionNotificationPersistent/Armed/Fired/FiredAt`, чтобы native мог показать root badge,
project glow и tab glow без захода в transcript.

Foreground/local notification и background/locked notification — разные каналы. Если native
iOS уже держит `project-activity` SSE/REST, он сам создаёт local notification и дедупит её по
`tabId:firedAt`. Когда app свернут, suspended или телефон заблокирован, этот stream нельзя
считать delivery-механизмом: desktop `tab-notification:fired` должен параллельно отправить
remote APNs alert по зарегистрированным iOS token'ам. Push payload несёт тот же canonical
`kind=terminal-completion`, `projectId`, `tabId`, `tabName`, `firedAt`, `mode`; iOS применяет
его в local unread-state до навигации. Если APNs credentials или iOS token отсутствуют,
сервер только логирует причину и сохраняет обычный foreground путь через project-activity.
Это сознательный fallback, не доказательство что locked-phone flow работает.

`firedAt` нормализуется один раз на desktop fire-edge и дальше используется тем же объектом для
`tabCompletionNotifications`, `project-activity` snapshot и APNs payload. Не пересчитывать timestamp
отдельно по каналам: native dedupe держится на `tabId:firedAt`, и разные значения превращают один
завершившийся turn в два баннера или два unread-state.

`POST /api/terminal-tabs/:tabId/completion-notification/clear` — idempotent acknowledgement
для native: повторный clear или уже закрытая вкладка возвращают success, потому что тап по
iOS notification может догнать desktop clear/reload. Endpoint чистит fired/armed mirror, но
не обязан выключать persistent watch (`keepPersistent`): persistent — подписка на будущие
busy-edge, а acknowledgement относится к уже сработавшему unread. Пустой
`project-activity.projects` после clear означает authoritative zero; native не должен
оставлять старый badge из прошлого `/api/projects` seed.

`starting` в project-activity — тоже runtime patch, а не layout metadata. Вкладка в `starting`
считается live для project badge/count, но `streaming=false`: процесс запускается или
восстанавливается, пользовательский turn ещё не идёт. Нельзя сворачивать это в `active` до
input-ready — иначе iOS показывает composer/input для вкладки, где desktop ещё ждёт startup
prompt, `/model`/`/effort` defaults или Codex MCP readiness. Нельзя и делать global blocker
по одному `starting` tab: список проектов и History должны оставаться доступными, меняется
только статус конкретной вкладки.

У Codex `starting` может появиться до rollout session id: `codex:run-command` сразу seed'ит
runtime/project-activity из launch payload, чтобы iOS/API не показывали `input` или `Resume`
пока hidden tab проходит update/trust/directory/MCP startup. Этот payload не является
персистентным статусом и должен исчезать на stop/kill/exit/command-finished; иначе старый
launch переживёт ручное вмешательство и вернёт вкладку в ложный `starting`.

`commandRunning=true` у AI-вкладки в mobile/control-bar логах означает «жив процесс или
стартовый process strip», а не обязательно busy-loader пользовательского turn'а. Для
`/active-loaders` AI-вкладка блокирует install/deploy только по deterministic busy-сигналам,
а ordinary shell-процесс — только если он запущен `Restart after`; `starting`/process strip нужен для видимости состояния вкладки,
но не должен превращаться в глобальный install blocker.

Layout changes идут отдельным полем snapshot'а `layoutChangedProjectIds`. Renderer вызывает
`project:layout-changed` при изменении структуры или metadata вкладок конкретного проекта:
create, close, reopen, rename, изменение групп, статусов и tab-layout reorder. Server добавляет
id проекта в следующий project-activity кадр, чтобы native клиент запланировал `/tabs` reload
после своего quiet-window. Это не license таскать полный tabs metadata в project-activity:
activity остаётся маленьким runtime-каналом, а structural reload происходит отдельным путём.

Project order — соседний, но другой structural signal: `projectOrderChanged:true` означает
«перезагрузи `/api/projects`», а не «перезагрузи `/tabs` выбранного проекта». Это нужно для
симптома «на Mac поменял порядок проектов, на iPhone список остался старым»: per-project
`layoutChangedProjectIds` здесь бессмысленен, потому что изменилась сама последовательность
project rows, а не содержимое одного проекта.

**Error-policy (важно):** ошибка сети показывается full-screen ТОЛЬКО когда показать
нечего (`error && !data`). Если кэш есть — стейл-табы остаются, ошибка глотается, next
poll восстановит. Иначе мигающий «Failed» поверх рабочего списка.

**Bump DB-версии безопасен:** `upgrade()` создаёт `kv` только если его нет
(`if (!db.objectStoreNames.contains('kv'))`) — `meta`/`messages` не пересоздаются,
кэш переписок юзера переживает миграцию.

**Race protection (prefix-merge lock):** между `reducer.reset()` и `apply(merged)` в phase-2 могут прийти WS messages. Раньше они применялись в `reset → empty → WS apply (без context) → merge replace` → live message терялся. Теперь:
- `prefixMergeLockRef.current = true` перед reset
- WS handler: `if (prefixMergeLockRef.current) wsDeferredQueueRef.push(msg); return`
- После apply(merged): drain wsDeferredQueue → reducer.apply каждый → flush → release lock

## SSE transport (заменил WebSocket в live-канале)

**Корень почему не WS:** Yandex Browser (его встроенный Protect) и Chrome anti-tracker расширения **молча блокируют `ws://` к private-IP** (`192.168.x`, `127.0.0.1`). Детерминированно (горело 2026-05-28): из браузера `fetch('/api/me')` → 200, а `new WebSocket('ws://192.168.0.103:7979/ws')` → `readyState` навсегда `0` (CONNECTING), ни `open`, ни `error`, ни `close`, и на сервер **не приходит ни одного upgrade-запроса**. При этом `curl` с тем же URL даёт `101 Switching Protocols` — сервер исправен, режет именно браузер. WS-события `error readyState=3 + close 1006` мгновенно если расширение рвёт после конструктора. Симптом для юзера: «WebSocket подключается…», Resume жмётся но «ничего не происходит» (бэкенд работает, broadcast'ы падают в `[WebBcast:DROP] noSubscribers`).

**Решение — Server-Sent Events** (`GET /api/events?token=&tabId=`, `EventSource` на клиенте). SSE едет поверх обычного HTTP GET (`text/event-stream`), который anti-tracker'ы не трогают. Проверено в реальном Яндексе: `EventSource` → `OPEN@5ms` + snapshot, там где ws:// висел вечно.

Серверная механика — **транспортно-агностичный Sink** в `web-server.js`:
- `subscribers: Map<tabId, Set<Sink>>`, `Sink = { kind:'ws'|'sse', send(str), isAlive(), close() }`.
- `wsSink(ws)` оборачивает WebSocket; SSE-route создаёт inline-sink (`send` пишет `data: <json>\n\n`, `isAlive` = `!res.writableEnded`).
- `webBroadcast(tabId, payload)` фанит на оба транспорта одинаково — main.js не знает какой транспорт у клиента. **WS-эндпоинт оставлен** для permissive-браузеров (десктоп, Safari) — оба регистрируются в один реестр.
- SSE-route: `Content-Type: text/event-stream`, `X-Accel-Buffering: no` (отрубить прокси-буфер), `retry: 2000` (EventSource auto-reconnect), heartbeat-комментарий `: hb\n\n` каждые 25s (держит сокет тёплым за радиомодемами), `req.on('close')` → `unsubscribeAll(sink) + releaseClaudeWatchersIfOrphan()`.
- **gzip не трогает SSE** — `sendJson` (где gzip) не вызывается, route пишет `res.write` напрямую. Глобального gzip-middleware в `createServer` нет.

При subscribe на tab transcript web-server также регистрирует consumer в `SessionTranscriptService` и освобождает его, когда у tab больше нет WS/SSE subscribers. Сервис шлёт `transcript-changed` как invalidation; для Codex live `message` отсюда не фанится. Единственный live-владелец Codex rows — CodexTurn watcher в `main.js`, а Transcript Service остаётся snapshot/invalidation layer. Шрам 2026-06-21: когда оба слоя слали `message`, native iOS показывал отправленный с desktop prompt дважды; второй event имел другой uuid и часто `session=nil blocks=0 textLen=0`, потому что пришёл из другой нормализации. Claude PTY live tail watcher из `fact-mobile-claude-pty.md` пока остаётся отдельным каналом live-message; общий сервис не должен ломать его guards по `entry.inflight/leftover`.

Клиент: `EventSource` имеет **встроенный** auto-reconnect — рукодельный backoff/watchdog/visibilitychange (которые были у WS) удалены, браузер сам реконнектит. `esRef`, `eventsUrl()` в `api.ts`. Парсинг сообщений тот же (общий JSON-envelope).

**`webBroadcast` логирование — lifecycle-first, но `message` тоже трассируется metadata-only:** `type:'message'` может лететь десятками раз за turn, поэтому в лог не пишется chat text/content. Но SEND/DROP для `message` логируются с коротким summary (`role/content-types`, `noSubscribers`, `to=N/N`), потому что иначе баг «iOS не видит live text, но история появляется после переоткрытия» не отличить от parser-регрессии. Lifecycle-типы (`snapshot`, `busy`, `done`, `bridge-update`, `queue-update`, questions) продолжают логироваться всегда.

**Loader'ы Resume/Stop — строго по SSE-событию, без таймаутов:**
- Resume: `setResuming(true)` на клик, HTTP-ответ (~15ms) loader НЕ гасит. Гаснет `useEffect` когда `claudeStatus → active|busy` (SSE snapshot от `Bridge:Fresh`/`ClaudePromptReady`, ~1.1s). Edge: bridge вернул `alreadyRunning:true` (Claude уже жив, stale mobile-статус) → нового snapshot не будет → гасим loader сразу в `onResume` + `setClaudeStatus('active')`, иначе вечный спиннер.
- Stop: `setStopping(true)` на клик, гаснет когда `claudeStatus → inactive` (SSE snapshot от `clearBridgeTab` после реальной смерти процесса, ~500ms). Edge: `stop` вернул `{stopped:false}` (процесса уже не было) → нет PTY-exit → гасим loader сразу + `setClaudeStatus('inactive')`.
- `InlineSpinner` — `transform:rotate` (не opacity), UPPERCASE лейбл «RESUMING…»/«STOPPING» — детектируется на видеозаписи (CLAUDE.md::AI-Optimized UI).

После 2026-06-20 Stop loader опирается не только на локальный mobile flag: server публикует `sessionStatus:'stopping'` сразу после `terminal:stop-ai-process`, до финального `inactive`. Это нужно для native iOS, History и внешних API-клиентов, которые не нажимали кнопку в mobile-web и не имеют локального `setStopping(true)`. Любой клиент, увидевший `stopping`, обязан блокировать send/resume/rewind и ждать следующего lifecycle snapshot; `busy:false` при этом не означает готовность composer'а.

**Регрессия-canary:** `[WebSSE:Open/Close]`, `[WebSub:Subscribe/Unsubscribe]`, `[WebBcast:SEND/DROP]` (metadata-only для lifecycle/message), `[MobResume]/[MobStop] click/reply-ok/loader-cleared`, `[MobWS] snapshot/busy/done` (имя `MobWS` историческое, канал теперь SSE). Если loader виснет — grep `loader-cleared` отсутствует → SSE-событие смены статуса не пришло (проверь `[WebBcast:SEND] to=N/N` на сервере и `EventSource` readyState на клиенте).

**Stream idle watchdog:** 30s без bytes → abort + onError. Без этого Electron-crash mid-stream → phone forever pending без сигнала.

**Synthetic broadcast skip on mobile:** main.js шлёт `__webSynthetic: true` user message через WS чтобы desktop рендер показал bubble на mobile-prompt'ах. Phone reducer **игнорирует** synthetic — иначе phone получит дубль (synthetic + real-record). Mobile получает мгновенный feedback через **локальный optimistic push** в `send()`, real-record adopt'ит свой uuid в существующую entry (dedupe by text).

См. `methodology/переносимый-дизайн-mobile.md::Tail-first loading`, `knowledge/fix-mobile-history-bottleneck.md` (история отладки до streaming), `knowledge/fix-mobile-scroll-jitter-virtuoso.md` (CV+virtuoso антипаттерн), `knowledge/fix-mobile-scroll-teleport.md` (resize-shrink → false-positive atBottom → followOutput pin).

## Expanded state map (across virtuoso re-mount)

`_entryExpanded: Map<entryId, boolean>` в module scope `mobile-web/src/App.tsx`. Hook `useEntryExpanded(id, defaultOpen)` подписывается на per-id version counter. Используется в ThinkingCard и ToolCard. Cleanup в `clearEntryExpandedForIds` срабатывает на ChatView unmount — иначе Map течёт по entry.id'ам всех когда-либо открытых чатов.

См. `methodology/переносимый-дизайн-mobile.md::Persistent expanded state across virtual list re-mount`.

## Dev-port isolation (parallel production)

Production app (installed `/Applications/Noted Terminal.app`) слушает 7878. `npm run dev` устанавливает `NOTED_WEB_PORT=7979` через npm script — поднимает свой web-server на 7979, оба работают параллельно. Phone подключается на нужный порт (production URL стабильный, dev URL = тестовая копия).

**Port-walk fallback при EADDRINUSE.** Если preferred port (7878 или явный `NOTED_WEB_PORT`) занят — server инкрементирует и пробует следующий, до `PREFERRED + 20`. Раньше второй инстанс просто молча умирал с `EADDRINUSE` через `console.error`, mobile-web был доступен ровно у первого запустившегося. Теперь оба живые на разных портах. Реальный bound порт пишется в `~/.noted-terminal/web-server-<pid>.json` (`{port, pid, lanIp, updatedAt}`) — discovery для StatusBar mobile-chip'а и любого внешнего инспектора. `getInfo()` отдаёт `resolvedPort`, не const — без этого QR-код и copy-URL показывали 7878 на инстансе который реально на 7879.

Mobile-web Vite dev (`cd mobile-web && npm run dev`) — `host: '0.0.0.0'`, port 5180. Proxy `/api` и `/ws` на :7878. Используется когда нужен HMR на phone при правках `mobile-web/src/*.tsx`.

Token общий — `~/.noted-terminal/web-token.txt` читается обоими инстансами.

## Prompt cache (etag-revalidation)

`localStorage['noted-prompts-cache:v1']` = `{ etag: string, data: { groups, prompts } }`. PromptPickerSheet hydrate'ится синхронно из cache на mount → UI рисуется в первый кадр без spinner'а. Параллельно `Api.prompts(cachedEtag)` — server считает sha-1 от canonical JSON, если совпало — `{ etag, unchanged: true }` (~50 байт). Network failure при наличии cache → silent fallback.

Версия ключа `:v1` бампается **только** при backwards-incompatible изменении схемы (новые поля в prompt — нет, переименование — да). Контентные изменения отлавливает etag сам.

## Performance instrumentation

Server: `[WebTiming]` теги — каждый `/timeline`, `/history` пишет `bridge=Xms find=Yms parse=Zms total=Wms`, `[WebGzip] origB → gzipB (N%) in Tms` для крупных payloads (>64KB).

Client: `[History] streamFetch / streamMeta / streamDone / prefixMerged / idbWrote / cacheHit` через `Api.log()` → `POST /api/log/client` → `console.log` → `dev.log`. Каждый шаг с `*Ms` для blame'а. `[TimelineGoTo] click / done / NOT FOUND` для timeline-навигации. `[WS] open / close` с code/reason/backoffMs для reconnect диагностики. `[ScrollDiag] flushReducer / followOutput / atBottomStateChange / isScrolling / scroll {delta:N}` — для отладки scroll-jitter (см. `fix-mobile-scroll-jitter-virtuoso.md` для CV-кейса, `fix-mobile-scroll-teleport.md` для shrink+false-atBottom-кейса). `atBottomStateChange` несёт `{isScrolling}` тегом — gate в коде дропает true пока юзер тащит палец.

**Архивные теги (устарели):** `tailFetch / tailFetched / fullFetch / fullFetched / fullApplied` использовались в JSON two-phase архитектуре, удалены вместе с ней.

## gzip threshold

`sendJson` — gzip только для payloads ≥ 4KB **и** только если client прислал `Accept-Encoding: gzip`. Уровень 6 (баланс ratio/CPU). На 20MB JSON history даёт 60-65% сжатие (7-8MB), 250ms server CPU — приемлемо когда альтернатива 4-15 сек transfer на phone. Под threshold'ом overhead не оправдан (gzip header + CPU > saved bytes).
