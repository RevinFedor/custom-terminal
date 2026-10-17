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

- MCP: `send_message({tabId,text,requestId?})`,
  `reply_to_message({messageId,text,requestId?})`, `get_message({messageId})`,
  явный `cancel_message({messageId})`.
- REST: `POST /api/tab-messages`, `POST /api/tab-messages/:id/replies`,
  `GET /api/tab-messages/:id`, `GET /api/tab-messages?tabId=...`.
- `tabMessages:{version:1,durable:true,replyTo:true}` в `/api/me` проверяется
  MCP до POST. Старый backend требует обновления; fallback на send_prompt
  не создаёт поддерживаемого отношения вопрос/ответ и потому не выполняется.
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

## UI и инструкции

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
По умолчанию внутри сообщения общий source-header вместо слов «Вопрос/Ответ» показывает
стрелку и кликабельное имя отправителя. `↙` означает входящий вопрос/request,
`↗` — ответ на исходящий вопрос/completion; это причинная роль переписки, не
факт отправки текущей строки наружу. Тот же header используется в body preview.
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

По уточнению Fedor12.10 зелёные карточки не показываются в compact dock слева
от History: успешная доставка вопроса И ответа скрывает переписку сразу,
без прежней4секундной задержки. History сохраняет пару; открытый preview не
закрывается. Ожидание ответа, saved-only, queued/unconfirmed/failed остаются
видимыми. Visibility берётся из текущего presentation, не timestamps; отдельного
success-expiry timer больше нет. Это UI-проекция, не автоматический dismiss/ack,
не отмена доставки и не доказательство смыслового прочтения моделью.
После remount зелёные карточки также остаются только в History.

X переписки означает отмену будущей доставки и ожидания ответа, а не hide.
По уточнению Fedor09.10 закрытый MCP-вопрос не должен неожиданно отправляться
после следующего ручного сообщения. `cancelledAt/cancelledByTabId` записываются
атомарно с delivery-control question и уже сохранённого reply. До Enter отмена
запрещает ввод, после него сохраняет неизвестный/подтверждённый исход; уже
переданное нельзя обещать отозвать. Процесс адресата не останавливается.
Поздний ответ сохраняется читаемым, но не пересылается; restart, callbacks и
повтор того же ID не оживляют dispatch. History и immutable текст не удаляются.
IPC `tab-messages:cancel`, REST `POST /api/tab-messages/:id/cancel` (`{tabId}`)
и MCP `cancel_message` сходятся в один owner. Участник проверяется по thread,
reply ID адресует вопрос. Capability `tabMessages.cancellation.version=1`
отличает новую отмену от старого приложения; потерянный ACK читается по
`get_message.cancelledAt`, повтор допускается лишь с тем же ID. HTTP также
возвращает `requestedMessageId`, отдельно от корневого question ID.

Legacy `dismissMessage`, IPC `tab-messages:dismiss` и `/dismiss` сохранены как
per-side hide (`sourceDismissedAt/targetDismissedAt`), без изменения доставки.
Старые hides не мигрируют в отмену задним числом. UI теперь вызывает cancel;
ошибка не скрывает строку оптимистично. Native run X остаётся отдельным owner.
Новая cancellation metadata сливается монотонно даже если более поздний delivery
event пришёл раньше её ACK. Старый participant-hide и новая отмена проецируются
в тот же exact History handoff: late queued receipt/list не возвращает ghost.
Это не удаление настоящей canonical user-строки. Физический slot и сохранённые
delivery facts различаются по `fact-terminal-mcp.md::Main FIFO принятых Send`.

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
