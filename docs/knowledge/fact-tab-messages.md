# Адресные вопросы и ответы между вкладками

## Назначение

`send_message` спрашивает постоянного владельца во время его работы.
`reply_to_message` возвращает ответ именно на этот вопрос; обычный final
адресата остаётся ответом пользователю. Вопрос сохраняется до доставки,
вызывающий получает messageId и продолжает независимую работу. Два источника
могут получить ответы в обратном порядке без привязки к одному provider-turn.

Это отдельная связь сообщений. Она не создаёт orchestration-run, потомка,
predecessor-очередь или inheritedBusy. Долгое «выполни и проверь» остаётся
`delegate_to_session`; передача новых фактов без пробуждения адресата остаётся
linked Markdown/`publish_context_update`. Иначе уточняющий вопрос B к A может
зависнуть за ожиданием завершения самой B.

После прерывания делегации сообщение «продолжай» запускает новую адресную
переписку, но не перепривязывает старый run к следующему ходу. Ответ «продолжаю»
подтверждает только этот статус: последующий обычный final не пересылается сам.
Если работа уже доказанно продолжилась, `wait_for_tab_response` сохраняет новое
наблюдение её результата без дополнительного prompt. Pending ACK сообщения
не доказывает начало работы; слишком раннее наблюдение idle может прочитать
прежний ответ. Новое отдельное поручение получает новый tracked run.

## API и identity

Ответ связан с вопросами явными IDs, не названием вкладки, порядком или анализом
текста. SOURCE27Oct после прямого «да фиксируем» принимает один messageId либо
messageIds и общий текст. Для одной exact переписки текст доставляется ОДИН раз,
а все включённые вопросы сохраняют связь с той же reply-row/квитанцией. Соседние
неуказанные вопросы не закрываются. Модель передаёт IDs, пользователь не должен
сопоставлять UUID вручную. Старый single-ID вызов остаётся совместимым.

- MCP: `send_message({tabId,text,requestId?})`,
  `reply_to_message({messageId,text,requestId?})` либо `{messageIds,text,requestId?}`,
  `get_message({messageId})`,
  явный `cancel_message({messageId})`.
- REST: `POST /api/tab-messages`, `POST /api/tab-messages/:id/replies`,
  `POST /api/tab-messages/replies` для explicit messageIds,
  `GET /api/tab-messages/:id`, `GET /api/tab-messages?tabId=...`.
- `tabMessages:{version:1,durable:true,replyTo:true}` в `/api/me` проверяется
  MCP до POST. Старый backend требует обновления; fallback на send_prompt
  не создаёт поддерживаемого отношения вопрос/ответ и потому не выполняется.
  Для списка дополнительно требуется batchReply.version1. Старому App не
  отправляется batch и не делается скрытый fanout одиночных Replies.
- MCP получает source из identity вызывающей сессии hub. Reply не принимает
  произвольный return-tab: сервер выводит его из исходного вопроса и проверяет
  responder. Закреплены project/provider/session обеих сторон; совпадение имени
  вкладки не разрешает переадресовать старую переписку новой сессии.
- SOURCE06.10 при null writer SID закрепляет точный provider/terminal instance/
  launch обеих сторон, а не saved/read SID. Публичные source/targetSessionId
  остаются null, provisional address хранится отдельно. Первый SID принимается
  только от того же launch либо exact canonical receipt с frozen hash/attempt/
  source tuple. Новый запуск не получает старое сообщение или обратный reply.
  Если уже известный SID временно не подтверждён, тот же вопрос ждёт identity
  proof без нового Enter; прежние lifecycle/input события продолжают доставку.
  Pin переживает SQLite reopen; unknown не превращается в недоставку/повтор.
- messageId — адрес сохранённого сообщения. requestId — ключ точного повтора,
  сгенерированный MCP до сети, если caller его не передал. Изменённый payload
  под тем же ключом конфликтует; потеря ACK не разрешает новый ID.
  Exact retry сначала читает прежнюю reservation после проверки caller identity,
  даже если вкладки уже закрыты или сменили сессии. Повтор не пытается заново
  разрешить target и не меняет сохранённый адрес.
- Ответ хранится как отдельное сообщение с `replyTo`. Один вопрос имеет один
  явный содержательный ответ; уточнение оформляется новым вопросом. Reply
  не требует автоматического ответного acknowledgement агентом.

Batch возвращает results по каждому ID и messages только новых доставок.
Already-answered сохраняет прежний ответ; reply-pending сохраняет прежнюю
pending/UNKNOWN операцию без замены текста/повторного ввода. Foreign/not-found
не получают чужой связи. Legacy-cancel-ambiguous не угадывается как старый X.
Если новых ответов нет, messages пуст: это не успешная новая доставка.
Q1 уже отвечен, Q2 ждёт, Q3 скрыт → Q1 already-answered + одна новая reply-row
для Q2/Q3. Один native sent завершает обе указанные переписки, не natural final.
Идемпотентный request receipt и все question pointers пишутся атомарно: потеря
ACK/reopen не создаёт второй Reply, конкуренция не заменяет уже принятый ответ.
Single и batch используют общее пространство requestId, даже когда batch вернул
только already-answered/not-found и не создал R. Иначе после reopen тот же ключ
мог незаметно стать другим вопросом; отсутствие новой R-row не освобождает ключ.
Разные exact return conversations получают отдельные deliveries, не retarget
одного frozen input. Старый single-ID retry также не меняет payload или адрес.

Явная операция `build:i-c` добавляет узкий post-delivery restart binding.
Если вопрос был доставлен в A, захвачен именно этот участник/вопрос, а единственный
restart continuation подтверждён canonical FIFO request/attempt/audit в B,
продолжившийся B может ответить на этот вопрос. Старый `deliverySessionId=A`,
исходные поля вопроса и prompt сохраняются; произвольный accepted Resume alias
без операции и квитанции по-прежнему недостаточен. Issued binding переживает
SQLite reopen и проверяется при reply reservation и последующей delivery после
await. Обратный адрес исходного sender имеет отдельный proof; право responder
не переносит автоматически всю переписку A на B. Готовый reply во время downtime
доставляет прежний message owner, без повторного вопроса/нового reply ID.

Шрам14.10 Ai Mindset→4898: usable writer отправителя не подтверждает адресата.
У остановленного Codex сохранённый SID был виден, но coherent Main snapshot
не переносил canResume; message resolver поэтому отказал503 до reservation.
Stopped identity использует прежнюю binding только при свежем process=absent,
inactive/liveLifecycle=false и совпадении sessionId/savedSessionId того же снимка.
Это разрешение общего Resume-сценария, не live writer/input proof. Unknown/found
process и смена owner не получают saved SID как замену. Сам текст ошибки о
«current conversation» не означает, что потерян именно источник вызова.
Класс: `local but check similar paths`. Остановка процесса не отменяет сохранённый
адрес; отказ возникал до общего Resume/Send. Старый consumer-тест вручную задавал
canResume=true и потому не проверял полноту Main DTO. Регрессия теперь соединяет
actual Main producer с messageRuntimeIdentity/scenarioDestination и API/SQLite;
успех этих проверок не заменяет native cold Resume/Enter acceptance после обновления.
Тот же шрам подтверждён для saved reply344c8c45 из4196 в4929:07:00UTC manual-stop,
07:09:23 target lookup0, address-guard503/attempt0 при прежнем SIDd04e6435.
Ответ сохранён, общий текст «address no longer available» не доказывает смену
истории. Actual reply-after-stop и changed-history controls проверяют тот же Main
producer; уже failed reply автоматически не переотправляется после source update.

Отдельный SOURCE seam15.10: стабильный owner не согласует retained event lifecycle
с отдельным свежим process lookup. При event live/unknown и complete absent public
snapshot обращается к прежнему canonical Codex reader с forceWriterReconcile;
тот сохраняет exact accepted-launch/handoff hold. Unknown/found процесс или
pending launch не превращается в stopped, saved SID не повышается до writer.
Исходный Boosty50309:21 не сохранил точный tuple/stage, поэтому этот regression
не выдаётся за доказанную historical rootcause. `[AgentRuntimeIdentity]` отличает
event/physical/canonical verdict, `[AgentMessageIdentity]` — tab/purpose отказа,
без prompt body. Actual stopped producer уже возвращал saved SID при live=false:
гипотеза «stopped всегда NULL» неверна. Контроли —
`stopped-codex-message-identity.actual.test.js`; новые admission/FIFO права не добавлены.

`get_send_receipt({tabId,handoffId})` отдельно читает старый delivery-only
send_prompt. Шрам02.10: агент получил400/409, пытаясь прочитать уже доставленный
ответ повторной отправкой пустого/сокращённого текста. Read не должен пересекать
paste/Enter или создавать другую операцию.

## Доставка и восстановление

SQLite `tab_messages` фиксирует вопрос/ответ и неизменяемый transport prompt
до физических действий. Ответ доступен по ID даже при отказе обратной доставки.
Стадии `pending/sending/queued/sent/waiting-for-input/unconfirmed/failed`
описывают доставку; `replyMessageId/answeredAt` отдельно описывают наличие ответа.
`sent` доказывает запись prompt, а не понимание или использование текста моделью.

Application FIFO reserved/preparing с waiting/dispatching — ещё не отказ доставки.
Проекция переписки сохраняет pending/sending и retryAllowed=0, пока executor владеет
этой записью. Шрам15.10 HH367: прежняя классификация делала queued admission failed
ещё до ввода; затем новый live statusAtSend=busy менял request hash исходного inactive
сообщения. Поэтому statusAtSend сохраняется как admission hint; актуальная готовность
по-прежнему доказывается executor, не этим историческим полем.

Прежний message-owner wake после доказанного no-input refusal вправе вновь поставить
тот же item в Main FIFO: exact current attempt, not-submitted и явные submitted/
pasteWritten/enterWritten=false обязательны. Payload/ID не меняются, повторная
постановка идёт после уже принятой работы. Старый bridge finally удерживает physical
slot; recovery до его возврата сохраняется без нового wake. Обычный same-ID replay
сам по себе не ставит item повторно. Cancelled, unknown, provider rejection и уже
вставленный текст этим recovery не разрешаются; API не даёт caller-у отдельного
retry-grant. После SQLite reopen владельцем ожидания остаётся та же Main очередь.
Actual regression: `agent-send-application-queue.integration.test.js` соединяет
сообщения, очередь и настоящую Main revalidation; provider/PTY в нём controlled.

`accepted:true` при `deliveryState:pending` означает сохранение ответа приложением;
в итоговом отчёте это нельзя называть подтверждённой доставкой. Поздний отказ
остаётся доступен через exact `get_message`, без повторной отправки. Шрам09.10,
iOS chat918b: в18:29Bangkok агент написал «отправил статус4505», хотя replycc0a098b
был сохранён в18:24:45 и через0,3с получил `message_runtime_identity_unavailable`
до первой transport attempt. После Build Install адресат был inactive; последующий
deleteRange в18:30 сменил SID уже после отказа, не был его причиной. Прежний
cancelled Run After v5 — другой объект. Красный Reply и сохранённый текст были
правильными; неверным было отождествление persistence ACK с доставкой.

Транспорт — общий `runAgentSendScenario`, с FIFO попыток одного адресата,
draft-preflight, native queue и exact receipts. Session/provider повторно
проверяются у физического writer; допускается только exact текущий Resume alias,
не произвольная lineage. Native queue не гарантирует мгновенную реакцию модели:
она увидит вопрос на поддержанной провайдером границе текущей работы.

Внутренний coherent Main snapshot переносит `sendTarget` от того же
`readAgentSendDestinationAtWriteBoundary`, отдельно от read/display SID и
inputReady. Передача только readiness без этого tuple ложно отказывает
common pinned Send даже при доказанном writer; incident capacity2846 выявил
пересечение. Current terminal/launch/turn/generation по-прежнему проверяются
до/после await и перед физической записью; missing proof не заменяется saved SID.

Handoff и operationKey имеют `tab-message:<messageId>`. Подготовленный context
фиксируется один раз, поэтому поздние обновления не меняют bytes retry.
После рестарта startup сверяет прежнюю квитанцию, а не повторяет неизвестный
Enter. Только доказанный этап до отправки разрешает продолжение той же операции.
Отмена application FIFO (`agent_send_queue_cancelled`) — окончательный отказ
этого handoff, а не временная ошибка для retry. Startup, wake и поздний send
callback сверяют ту же квитанцию, но не возвращают отменённое сообщение в
dispatch. Frozen prompt и failed presentation остаются доступными; скрытие
строки не является доказательством доставки или разрешением нового Enter.
Receipt pin сохраняется до durable sent либо durable cancel intent сообщения: без него TTL квитанции
мог бы уничтожить proof между выполнением и восстановлением. После записи sent
pin снимается; отмена имеет отдельный компактный marker против нового attempt,
не снимая queue/unknown-asset owners. Startup освобождает остаток crash между записями.
Wake идёт от событий lifecycle/input, модель не поллит историю или статус.

## Собственные вопросы и обычный Loop (SOURCE27.10)

Fedor27Oct явно отделил обычную адресную переписку от подписки на окончание работы.
Вопрос доставлен → один точный Reply сохранён и подтверждённо доставлен обратно →
переписка завершена. Конец consuming turn источника не требуется: источник может
продолжать свою длинную работу. Это не доказательство чтения/понимания ответа.
Делегации, response-observation, Research и explicit own-turn dependencies
сохраняют собственные completion-контракты.

Владелец ожидания прежний Main MessageLoopWaits/SQLite, не mounted UI и не fake run.
Outstanding inventory читается у message owner, не из усечённого списка карточек.
Один вопрос имеет один ответ; explicit список messageIds связывает несколько
вопросов с одной доставкой. При обратном порядке и смешанном состоянии исход
каждого ID остаётся независимым; текст сам связей не создаёт.

~~~text
own question -> all-work message hold
  Reply saved / accepted / queued / unknown -> доставка ещё не завершена
  exact native Reply receipt               -> exchange DONE, message hold снят
  отказ / deadline                         -> durable конечный outcome
ordinary Loop -> отдельно busy / FIFO / current cause / Goal / Stop / install
~~~

Sent не выводится из accepted=true. Private delivery reader проверяет сохранённые
question↔reply IDs, destination, operation/handoff/attempt, immutable FIFO request
fingerprint, prompt hash и canonical native user/source identity. Неподтверждённый
callback либо чужой receipt не закрывает ожидание. Перед asynchronous commit
перечитывается exact receipt вместе с aliases; RAM identity и SQLite revision CAS
защищают от старого продолжения, отмены и конфликтующего writer. При EIO release
не публикуется. Durable delivery settlement не содержит выдуманных replyProcessed
или natural=true и после reopen не требует History/turn scan.

Первый вопрос сохраняет абсолютный deadline30минут; сохранение первого Reply
начинает отдельный срок подтверждения его ДОСТАВКИ, не обработки. ACK/restart срок
не продлевают. Reserved/preparing не является доказанным отказом. No-reply,
доказанный delivery failure и unconfirmed return deadline дают конечный сохранённый
исход, но не no-Send и не разрешение повторить question/Reply/UNKNOWN.
Статус Noted — отдельный one-way outbox прежнего FIFO с frozen ID/body и private
admission, а не обязательная вторая модельная задача. Он не ждёт natural final.
Lost ACK не создаёт вторую отправку; retry возможен лишь по прежнему доказанному
no-input/readiness механизму с тем же ID. При недоступном source outcome остаётся
в журнале без небезопасного ввода и без expired-deadline polling.

Legacy returning/processing-timeout записи с exact delivered Reply заканчиваются
штатным restore/reconcile прежнего владельца без дополнительного модельного хода.
Исторические proofs/body/IDs сохраняются, но больше не являются gate. Устаревший
processing notice сначала durable помечается revoked, затем прежний cancellation
owner снимает только его будущую доставку. Не начатый FIFO item получает no-input;
у crossed/UNKNOWN сохраняются прежние receipt/attempt и input-slot guard. Raw DB
recovery и second-notice Send для legacy C не нужны и не разрешаются.
Поздний настоящий Reply остаётся у того же question ID: пока его доставка pending,
это собственная фаза; exact sent завершает её без поглощения чужих вопросов.
Старый status не закрывает ещё не доставленный поздний Reply.

Message release не создаёт busy:false, parent final либо Loop Send. Отдельная
generic Main native-input boundary связывает natural cause с текущим provider/SID/
physical lifecycle и последним admitted input. Она не читает сообщения и не
проверяет их обработку. Новый canonical input делает старый cause неприменимым
даже в gap до следующего busy-start; повтор старого final не обновляет frozen token.
HEAD проверяет его до и после readiness await. Незавершённый/неизвестный input
остаётся у FIFO, Goal/Stop/install/delegation guards не обходятся.
Никогда не начатый устаревший Loop-head отзывается как deferred, не Loop OFF;
начатый/UNKNOWN не признаётся no-input. Root не создаёт natural cause из delivery,
а отозванную старую причину не пытается использовать заново.

После локального X отдельно сохраняется порядок уже принятых Replies. Если
старый, ещё не начатый Loop оказался HEAD перед таким Reply, existing admission
читает scalar O/H/target reservation у того же SQLite FIFO до и после readiness
await. Старый Loop уступает принятый ввод, оставаясь включённым. Это не ожидание
обработки Reply: после native receipt остаётся только обычный current-input fence.
Pending/UNKNOWN/attempted transport не становится no-input; тела/history не читаются.
Если принятый Reply ещё готовит context и FIFO row отсутствует, старый Loop тоже
не допускается. Несовпавший tab/H у read-only reservation остаётся unknown для
этого input; чужой terminal/confirmed receipt не разрешает обгон. Это закрывает
pre-reservation await gap, не добавляет ожидание consuming turn.
Если удерживает только неотвеченный Q, а принятого Reply ещё нет, тот же не начатый
FIFO Loop остаётся waiting, не cancelled. Source X снимает hold без смены cause/
H/O; immutable cancellation здесь навсегда заблокировала бы этот разрешённый ход.
При accepted Reply прежний Loop по-прежнему уступает очередь. При changed native
input ранний FIFO replay обязан сохранять guarded deferred/causeInvalidated, как
pre-paste refusal: generic cancellation ошибочно выключала бы Loop целиком.

### Исторический Контракт23–25Oct

Прежний Source действительно требовал exact processing natural final и создавал
reply_processing_timeout после уже доставленного ответа. Поэтому один долгий
ход источника задерживал несколько корректно доставленных ответов.27Oct Fedor
отверг именно этот product gate; исправление только цвета Reply его не устраняло.
Доказательства25Oct pinning/streaming и пять guard/race исправлений сохранены в
рабочем [историческом RESULT](../tmp/message-return-repair-20261025/RESULT.md).
Модули physical/structural verification не ослаблены и не превращены в ACK proof,
но normal Send/Reply больше не включает их capture/History путь.

get_message и list/IPC показывают loopWait с отдельной revision. Header и нижний
Reply одинаково отражают transport: подтверждённый ответ зелёный, завершённая
переписка уходит из live tracker, история и детали остаются. Saved/queued текст не
превращается в received. No-reply и unconfirmed delivery outcome остаются attention,
без утверждения, что адресат «не ответил», когда ответ уже сохранён.
Нужен coherent App update Main+renderer; MCP refresh сам его не устанавливает.
Source/private SQL/API/SSR и packaging preflight не являются loaded/UI acceptance.

## UI и инструкции

Desktop snapshot добавляет к последним100 compact Q/R все видимые незавершённые
вопросы и связанные pending Replies. Иначе после50 новых пар remount терял старый
активный Q, хотя durable hold оставался. Generic bounded list/History limit не
меняется; hidden участник не возвращается через active inventory. Это чтение
message metadata, не raw provider History и не замена отдельной History pagination.

Повторная сверка одной receipt не должна создавать новую message revision.
Send-store возвращает updatedAt числом, а messages хранит receiptUpdatedAt как
SQLite TEXT. Source25Oct канонизирует cursor строкой до bind: прежнее число после
SQL не сравнивается каждый wake с другим JS-типом. Новая receipt/acceptance по-прежнему
публикуется; старый неканонический cursor может один раз нормализоваться.
Renderer merge также сохраняет прежние index/row objects, если duplicate/stale
event не добавил данных. Поздний immutable body, отмена, сильнее delivery и новая
loopWait revision сохраняют прежнюю семантику.47 real-SQL backend и33 projection
checks подтверждают этот Source-контракт; они не доказывают installed latency или
причину конкретного зависания. Долгое app-ожидание Reply само не означает открытый
MCP RPC. Инцидент/незавершённая whole-app проверка — рабочая оптимизация History.

Пустой status dock не измеряет rail/pane и не держит ResizeObserver, пока нет
видимых requests/messages/error либо открытого History/settings/message panel.
При появлении такого содержимого тот же layout-effect измеряет свежую геометрию
до показа; кнопки остаются доступны. Подписки/доставка/identity/отмена не зависят
от этой геометрии.17.10 private built UI сохранил открытие настроек внутри своей
pane; это UI-проверка, не доказательство MCP message roundtrip.

Вопросы используют существующую поверхность tracker без фиктивных runs. Основная
строка26px общая с поручением: направление, название, статические status SVG и
зарезервированное место24px для действия. В компактном live tracker вращающийся
индикатор работы/передачи убран вместе со своим слотом: цвет стрелки уже сообщает
состояние, подробная подпись доступна при наведении. Ошибка, ожидание и завершение
сохраняют статические значки; History и детали сохраняют полный набор статусов.
Отдельный hover/click названия ведёт
во вкладку, рядом X. У переписки есть один дочерний ряд с отступом: одна кнопка
открытия содержит `Send` и `Reply`, каждый со своей SVG и цветом состояния, без
дополнительных галочек и правой стрелки. Полный message-item48px включает этот
дочерний ряд; основной header не становится выше native-run.
Это два индикатора, не две команды с одинаковым действием.
Каркас открытого Send/Reply preview вынесен в `RequestDetailsPopover`: тот же
компонент используется для одного выбранного Build Continue event. Он сохраняет
боковое позиционирование/viewport clamp, ограничение высоты, click-outside и
capture-phase Escape. Selection остаётся у dock owner: одновременно открыт
один message или continuation preview; выбор другого события закрывает прежнее.
Данные сообщений, чтение их полного текста и delivery/cancel остаются у прежних
owners. Hover не создаёт preview и не выполняет чтение другого события.
По умолчанию внутри сообщения общий source-header вместо слов «Вопрос/Ответ» показывает
стрелку и кликабельное имя отправителя. `↙` означает входящий вопрос/request,
`↗` — ответ на исходящий вопрос/completion; это причинная роль переписки, не
факт отправки текущей строки наружу. Тот же header используется в body preview.
Одностороннее уведомление `send_prompt` тоже имеет входящий header с именем
и точным tab-link, но не становится вопросом/делегацией и не требует Reply.
Его `phase:prompt` несёт обычный MCP origin с сохранёнными source-полями;
стрелка пассивна без messageId. Старый общий MCP origin без адреса показывает
нейтральное `Terminal MCP`; tooltip сообщает об отсутствии сохранённого отправителя.
Имя по handoff/тексту не угадывается.
Сохранение и immutable retry этого provenance — `fact-terminal-mcp.md`.
В меню окна `⋮` под Timeline есть `MCP как user`: настройка выбранной вкладки
сразу показывает её входящие MCP/межвкладочные сообщения обычными оранжевыми
user-bubbles без source-header. Выключение возвращает источник и фиолетовый фон;
старые и queued карточки используют тот же режим. Это presentation override:
semanticTags, полный транспортный текст, ID и receipt/Copy/Rewind не меняются.
Research и native question replies сохраняют свои специальные поверхности.
Per-tab map хранится в UIStore через SQLite-зеркало `noted-terminal-*`; настройка
переживает restart и перенос вкладки. Режим входит в shape-key сохранённых высот,
но не меняет semantic IDs или reading anchors. Tracker и Timeline preview имеют
прежние независимые представления.
Временная `role:queued` карточка использует полный immutable `semanticTags`
из Main presentation snapshot, а не только общий признак Terminal MCP. Эти данные
сохраняются в handoff, при поздней exact receipt и при восстановлении History;
сравнение стабильных строк учитывает изменение tags даже при прежних UUID/text.
Обогащение существующей карточки требует той же пары operation/attempt, provider,
session и полного prompt. Оно не меняет доставку, текст, hash или audit proof.
Шрам07.10: reply был подтверждён, canonical History имела source-tag, но queued
карточка показывала raw `[Tab message: reply]` без стрелки/имени. Наличие новой
шапки в установленном renderer само по себе не закрывало этот отдельный путь.
После saved-history Codex COW тот же симптом требует проверки переноса sidecar,
а не переключателя цвета. Exact legacy recovery и атомарный transfer описаны в
`fact-session-history.md::Service Presentation После Codex COW`.
У адресного question/reply это две независимые кнопки: имя открывает точную
вкладку, стрелка открывает её и находит исходный `send_message/reply_to_message`
по сохранённому messageId. У стрелки собственный приглушённый фон и более яркие
hover/pressed/focus-visible состояния в постоянном24px slot; наведение не меняет
геометрию header или фон соседнего имени. Пассивная стрелка без exact messageId
не получает оформление кнопки. Read-only locator сверяет нормализованный MCP carrier
и его acceptance/requestId, сохраняет отдельные writer/read SID и повторно
проверяет владельца после I/O. Цитата, похожий текст и соседний номер не подходят.
Для нескольких return conversations один batch-call имеет outer requestId, а R
каждой группы — собственный ключ. Locator связывает их только через структурный
accepted messages[] envelope и explicit question IDs, не через сходство suffix/
текста. Source/session/target/tool-family guards остаются прежними. Restart consumer
тоже учитывает все replyToIds и дедуплицирует только полностью одинаковые proofs:
две Q-ссылки на один R не означают два native input; разные attempts/audits не
сливаются. Отмена первого Q не уничтожает proof живого соседнего Q.
History раскрывает содержащую группу, догружает exact row и тем же seek-owner
центрирует именно tool header. Однократная подсветка начинается после реального
монтажа и стабильного положения, не после таймера загрузки. Новый click, смена
места, ручной скролл и Escape отменяют поздний jump; имя не запускает seek.
У native orchestration/completion без messageId стрелка пока обозначает роль,
но не обещает адресный MCP jump. Наличие найденного вызова не меняет доставку.
Неизвестная phase не получает выдуманную стрелку; отсутствие source-tab metadata
не заменяется догадкой по тексту. Переход остаётся по точному tabId.
У browser completion имя `ChatGPT · model` открывает не браузерный conversation,
а ту же локальную Research-задачу в SC Desktop. Noted Main разрешает сохранённый
runId в полный SC jobId; label и короткий ID не используются для поиска. Успех
принимается только после загрузки exact job и commit его detail-экрана в SC.
Отсутствующий job/старая capability дают явный отказ без нового research или
browser fallback. Это открытие результата, не подтверждение его доставки.
Тот же переход доступен по имени активного external-research в tracker внутри
вкладки и из деталей его History-записи. Это не пассивный label и не terminal
tab-link; нужен обновлённый SC app с navigation/rendered-ACK capability, одной
перезагрузки расширения или обновления Noted недостаточно.
Preview первых слов и дублирующая третья строка «Ответ доступен» не рисуются.
Наличие сохранённого ответа не равняется успешной обратной доставке: ошибка
остаётся на Reply, текст доступен в деталях. Полная пара читается адресно при
открытии preview; секции вопроса и ответа закрыты по умолчанию. Источник
открывается через общий async `openTabById` по точному tabId; сохранённый проект
лишь hint, фактическое место определяет Root. Совпадение названия не подходит; сохранённый
label остаётся provenance, live-состояние задаёт оформление.
Палитра Send/Reply: обычные `pending/queued` серые, `sending` синий, `sent`
зелёный, `waiting-for-input/unconfirmed` жёлтые, `failed` красный. Жёлтый означает
неопределённость или требуемое внимание, а не штатное ожидание очереди. Стадии
независимы: доставленный вопрос остаётся зелёным на Send, пока Reply ещё ожидается.
SOURCE27Oct: нижний `Reply` показывает именно доставку и остаётся зелёным после
подтверждённого возврата, включая metadata-only запись. Header/visibility тоже
завершают обмен по доставке, без отдельного processing wait. Прежний natural-final
gate отменён прямым решением27Oct: длинный рабочий ход источника не создаёт новый
reply_processing_timeout после delivered Reply. Это не смысловая оценка ответа и
не разрешение повторить вопрос. Source/API/SSR не квалифицируют установленный UI.
Успех перехода принимается только после `await true` от общего Root-входа;
его внутренний `placeTab` сохраняет существующее окно/workflow. `activateCenterTab`
не является отдельным menu-navigation контрактом. Чужое окно/workflow не
перестраивается ради клика по имени. Hover native-run подавляется, пока открыты
History/settings/детали сообщения или сам dock свёрнут: оставшаяся portal-подсказка
иначе перекрывала клики по History на средней ширине.

Боковой preview является дочерней поверхностью History, а не заменяет её:
список остаётся открыт на прежней прокрутке при чтении, смене пары и закрытии
preview. Первый Escape и крестик preview закрывают только его; закрытие History
или клик снаружи обеих поверхностей закрывают обе. На широкой области preview
якорится снаружи всей History, не перекрывая край списка; на узкой остаётся
viewport-clamped overlay, но состояние списка не теряется. Шрам04.10: openMessage
явно закрывал History, а два status-button открывали одну и ту же пару. Проверка
только dock этого не замечала; регрессия обязана открывать пару из прокрученной
History. Parent listener читает child ref без переподписки на каждый selection:
иначе закрытие ребёнка могло снять outside-listener посреди того же события.
Escape принадлежит открытой popup-поверхности: History/settings и message preview
перехватывают его в document capture с preventDefault/stopPropagation, до xterm
target. Bubble-only listener мог закрыть popup уже после отправленного terminal
Escape и прервать работающий Codex. Закрытие popup не является Stop/отменой Loop.

Общая `History` содержит chronological union native/browser run и question-thread,
вопрос с ответом считается одной записью. Постоянное место кнопки не зависит от
первой активности. Tracker вынесен из flex-flow rail: normal-flow список растил
высоту кнопок и сдвигал RunAfter. Dock меряет rail и видимую очередь вместе с
edge-controls, включая hover-preview, и располагается слева в пределах своей
pane. При нехватке ширины пассивный список свёрнут в доступ через History;
native pause/retry/detach остаются в раскрытой записи. Открытые детали не меняют
геометрию toolbar/очереди, длинные заголовки обрезаются внутри строки.

Dock имеет один скролл3px и одну общую рамку. Внутренние message/run группы
занимают доступную ширину, а не фиксированные178px поверх scrollbar: прежнее
различие сдвигало native X правее message X. Оба header используют общий
компонент, не независимые почти одинаковые стили.

По уточнению Fedor12.10 завершённые зелёные карточки не показываются в compact
dock слева от History. SOURCE27Oct завершает обе стороны по exact native доставке
Reply, включая source с собственным Loop. Его текущий рабочий ход может ещё
продолжаться: это не повод оставлять успешную переписку в активном dock. Прежнее
условие12Oct о подтверждённой обработке возврата отменено новым решением27Oct.
History сохраняет пару; открытый preview не закрывается. Ожидание ответа,
saved-only, queued/unconfirmed/failed остаются видимыми. Visibility берётся из
текущего presentation строки, не timestamps; отдельного
success-expiry timer больше нет. Это UI-проекция, не автоматический dismiss/ack,
не отмена доставки и не доказательство смыслового прочтения моделью.
После remount зелёные карточки также остаются только в History.

SOURCE27Oct X обычной переписки — LOCAL hide и снятие своего ожидания, не отмена
вопроса/ответа и не Stop. Прежнее правило09Oct «X отменяет доставку» явно заменено
новым решением Fedor. Source X сохраняет sourceDismissedAt, снимает только её
message hold и прекращает новые no-reply/status notices. Target X сохраняет
targetDismissedAt, но не снимает ожидание source. Поздний Reply штатно доставляется,
остаётся в History; hidden карточка не воскресает от receipt/list/reopen.
Закрытие не отзывает уже принятую отправку и не переигрывает UNKNOWN.

Самостоятельная явная отмена переписки остаётся другим действием:
cancelledAt/cancelledByTabId и новый cancelOrigin=explicit сохраняются с delivery
control прежним owner. Процесс не останавливается, исторические квитанции остаются.
Отмена одного вопроса не отзывает shared Reply, пока он принадлежит другому
неотменённому вопросу. UI X к этому действию не подключён.
IPC `tab-messages:cancel`, REST `POST /api/tab-messages/:id/cancel` (`{tabId}`)
и MCP `cancel_message` сходятся в один owner. Участник проверяется по thread,
reply ID адресует вопрос. Capability `tabMessages.cancellation.version=1`
отличает новую отмену от старого приложения; потерянный ACK читается по
`get_message.cancelledAt`, повтор допускается лишь с тем же ID. HTTP также
возвращает `requestedMessageId`, отдельно от корневого question ID.

UI X использует прежние dismissMessage, IPC tab-messages:dismiss и /dismiss,
без новых controls или отдельного recovery service. Ошибка не скрывает строку
оптимистично. Native run/Build Install/Research X сохраняют свои owners.
Новая cancellation metadata сливается монотонно даже если более поздний delivery
event пришёл раньше её ACK. Participant-hide и явная отмена проецируются
в тот же exact History handoff: late queued receipt/list не возвращает ghost.
Это не удаление настоящей canonical user-строки. Физический slot и сохранённые
delivery facts различаются по `fact-terminal-mcp.md::Main FIFO принятых Send`.

Старые cancelledAt не содержали происхождения: карточка X и explicit API писали
одинаковые поля. Fedor отдельно выбрал сохранить эту неопределённость до адресного
решения, не разбирать её массовым снятием guards. Additive migration сохраняет
old receipts/UNKNOWN/frozen inputs и сообщает cancellationOrigin=legacy-unknown;
batch возвращает legacy-cancel-ambiguous, не новый Reply input. Старые настоящие
per-side hides уже не блокируют поздний ответ и после reopen снимают собственный
message wait. Новый Source-контракт требует coherent Main+renderer App и новой
версии Terminal MCP для списка IDs; Source/private PASS не является loaded proof.

History/Timeline получают durable tag `kind:tab-message`; текстовые цитаты
сервисной разметки сами по себе тег не создают. По требованию Fedor вопрос и reply
используют тот же фиолетовый background/ромб, что остальные Terminal MCP sends,
но остаются сообщениями, не делегациями. Класс оформления общий с обычным MCP
prompt; фиолетовый цвет обозначает происхождение, не доставку или выполнение.
UI скрывает только сгенерированный
envelope по сохранённым границам, exact header и SHA256 полного UTF-8 transport,
сохраняет предшествующие
context-chips и Markdown ответа. При расхождении представления с transport
показывается исходный текст, без обрезания. Copy/Rewind сохраняют полный prompt.

Общее правило выбора находится в оригинальном `claude-dev/02-instructions.md`
и разворачивается через protocols.deploy. Terminal skill — автоматически
читаемая техническая справка. В каждом вопросе приложение также передаёт
короткую инструкцию reply с конкретным messageId: открытая старая сессия может
ещё не знать свежих общих правил. Вопрос другой вкладки не расширяет полномочия
и не заменяет текущее поручение пользователя.

Диагностика: `[TabMessages]` — ID, стороны, состояния, attempt, hash/размер;
`[TabMessages:API]` — код отказа до/при принятии. Полные тела в эти логи не
копируются. Статус и тело адресно доступны через get_message.
