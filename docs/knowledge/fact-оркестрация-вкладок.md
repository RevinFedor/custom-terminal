# Оркестрация AI-вкладок

## Зачем нужен отдельный контур

Оркестрация вкладок — продуктовый сценарий Project API, а не цикл чтения чужой истории. Он нужен для запросов, которые могут работать десятки минут и запускаться с другого компьютера, где у клиента нет локальных MCP-серверов. Поэтому HTTP-запрос подтверждает только принятие задачи и быстро завершается; ожидание ответа принадлежит сохранённому run и SSE.

Terminal/History scenario layer остаётся единственной точкой живого управления Claude/Codex. Оркестрация не пишет в PTY напрямую и не читает TUI-output: создание фоновой вкладки, readiness, send during streaming, resume и очередь проходят через те же сценарии, что Project API и History. `delegate_to_session` / `get_delegation_result` единого Terminal MCP — тонкие typed-wrapper'ы над этим API; history-tools не участвуют в штатном ожидании run.

### Читаемая граница реализации

- `orchestration-completion-flow.js` задаёт короткий порядок одного прохода:
  fresh result read → при необходимости arm watcher → повторный read → один
  именованный переход результата. Долгое ожидание принадлежит сохранённому run;
  transcript-событие или restart запускает следующий короткий проход.
- `orchestration-result-proof.js` классифицирует структурированные исходы
  `complete | pending | terminal-failure`. Текст остаётся объяснением, но
  переход выбирается по `errorCode`, а не по разбору текста ошибки.
- `OrchestrationRunStore` владеет долговечными переходами. Result-proof
  записывается через `recordResultProofObservation`, а не произвольным
  caller-side `patch` набора lifecycle-полей.
- `codex-prompt-audit.js` единолично определяет допустимые Codex carrier и их
  эквивалентность. Delivery, prompt context и batch result-proof используют
  его carrier/alias-группировку; resumable History/live pairer используют тот
  же classifier, matcher и exact-alias контракт, сохраняя своё потоковое
  состояние отдельно.
- `web-server.js` остаётся HTTP/SSE wiring и владельцем эффектов. Он вызывает
  общий send-сценарий, но не решает повторно, разрешена ли provider queue.

Новый явный вызов в остановленный существующий target не остаётся вечной очередью: сохранённое намерение передаётся общему сценарию, который возобновляет процесс и ждёт реального принятия prompt. Если указанный `targetTabId` уже закрыт, сам вызов является явным разрешением восстановить единственную архивную запись с тем же identity. Run сохраняется и становится видимым до этого side effect, затем вкладка возвращается в фоне под прежним `tabId`, а запуск и Enter по-прежнему выполняет общий send-сценарий ровно один раз. Удалённый или неоднозначный архив завершается объяснимой ошибкой. Ни startup reconcile, ни generic lifecycle не имеют права открывать закрытую вкладку самостоятельно; закрытие уже идущего run остаётся recovery-событием.

Это не отменяет FIFO неизвестного предыдущего Enter: даже idle/adopted target
может ждать старый provider-owned head, а новый run оставаться registered/sending
без input. Exact `send-receipts/reconcile` отдельно перечитывает прежний audit и
положительным proof освобождает исходный waiting intent, не создавая новый run.
Absent/unknown, Stop и скрытие карточки не являются таким proof. Контракт и
app capability — fact-terminal-mcp.md::Адресный Повтор Audit Квитанции.

## Контракт run

Каждый запуск связывает исходную и целевую вкладки вместе с их проектами. Новая target-вкладка всегда создаётся в фоне: запуск исполнителя не меняет активный проект или вкладку пользователя. Связанная работа в том же проекте по умолчанию создаётся visual-child исходной вкладки, но физически добавляется последней, чтобы новый исполнитель не сдвигал ручной порядок существующих вкладок и детей; независимый run использует явный `placement: root`. Межпроектный запуск без явно выбранного parent остаётся root, а повторный вызов существующего `targetTabId` никогда не переподчиняет и не перемещает уже организованную вкладку.

Визуальная иерархия вкладок и причинная иерархия run — разные связи. Явно переданный `parentRunId` имеет приоритет, а автоматическая связь разрешена только когда Terminal MCP передал точный контекст текущего исполняемого source-turn и он совпал с контекстом конкретного входящего run. Сам факт, что B является target активного A→B, не доказывает, что ручной независимый B→C вызов является потомком A; без причинного proof такой run остаётся root. Цикл, ссылка на завершённый run и несовпавший контекст отклоняются, а уже доказанная связь переживает restart. По умолчанию `waitForDescendants: true`: собственный ответ исполнителя сохраняется, но родитель не получает итог, пока не завершены дочерние ветки и не принят их exact completion-handoff. Обязательно отдельное app-owned completion user-message, но не обязательно новый физический provider-turn: `same-active-turn` принимает queued notification внутри ещё работающего parent, а `same-settled-turn` восстанавливает такую связь из уже завершённого transcript без повторного открытия parent. Provider/session/turn/generation должны точно совпасть с соответствующим guard. `parentConsumedAt` в штатном пути ставится после доказанного handoff, но также при явном закрытии ошибки с подавлением уведомления. Поэтому само поле не доказывает доставку, GET результата или смысловую обработку моделью; его читают вместе с notificationStatus/notificationSuppressed и exact receipt. Polling до notification не является заменой handoff. `waitForDescendants: false` — явное разрешение раннего отчёта, а не скрытая эвристика по effort или длине ответа.

Контекст target-turn закрепляется на точной границе принятого prompt, а не на ближайшем `busy` той же вкладки. У Claude `UserPromptSubmit` создаёт identity хода раньше, чем транспорт успевает записать `deliveryAcceptedAt`; такой ранний `busy` сам по себе ничего не привязывает. Когда post-Enter audit доказывает конкретный handoff/UUID, он атомарно сохраняет контекст именно того же события. Provider и session audit должны совпасть с контекстом; противоречие оставляет контекст непривязанным и попадает в diagnostic. Повтор того же proof может безопасно дополнить ранее недоступный контекст, но не заменить уже сохранённый другим turn. У Codex `user_message` и `task_started` могут появиться в любом порядке: ранний audit дожидается структурного start-события, а при раннем `task_started` выбранная exact `user_message` запись сразу получает уже активный контекст того же session/turn. При неоднозначности связь не угадывается. Благодаря этому B→C внутри A→B наследует родителя даже при порядке `busy → delivery acceptance`, а независимый B→C по-прежнему остаётся root.

Физическое поколение Codex — отдельная координата, не `executionContext.generation`
счётчика turn. Если canonical target audit опередил transport ACK, пустой
`targetLifecycleGeneration` дополняется в том же confirmation из сохранённого
Enter lease exact `orchestration-target:<run>` и принятого audit той же attempt/
session/turn. Не разрешать восстановление по generic текущей вкладке. Known
generation/attempt не перезаписываются; поздний original audit после Resume не
меняет новый turn. `targetLifecycleProof` — сохранённая provenance этой привязки,
не readiness и не новая квитанция доставки. Без exact lease прежний unknown
guard остаётся; это важно для capacity recovery до следующего Enter.

Для Claude точный turn становится доступен audit только потому, что repo-owned `UserPromptSubmit` hook переносит принятый prompt в локальный socket-envelope. Полный текст не логируется и не сохраняется как новый source of truth: он сравнивается с in-memory hash+length уже отправленных audit. Связь разрешена только при одном совпадении; два одинаковых pending prompt оставляются непривязанными с diagnostic, тогда как durable JSONL-записи продолжают подтверждаться своим отдельным oldest-first алгоритмом. Это защищает causal parent от cross-bind без ослабления доставки одинаковых сообщений.

`202 Accepted` означает принятие run приложением, но не готовность ответа и не обязательно физическую отправку prompt: `queued` может ещё ждать занятую target-вкладку. Независимые задачи допускаются в освободившийся target отдельно, а не смешиваются в native queue одного provider-turn. Состояние дальше приходит как `orchestration-update` через SSE; статус и результат адресуются стабильным `runId`. Клиент не держит исходный POST открытым и не опрашивает transcript. Новый completion обычно уже содержит полный ответ; `get_delegation_result`/HTTP GET нужны при явном reference, старом уведомлении или адресном восстановлении.

Большой ответ не дублируется в JSON orchestration-store. Store хранит точный UUID принятого target-prompt, размер и fingerprint, а результат извлекается из канонического Claude/Codex transcript. UUID является первичным proof: два одинаковых текста обязаны вернуть ответы своих разных ходов. Hash используется только для старых run без UUID, внутри сохранённых временных границ; несколько совпадений означают неоднозначность и не разрешают результат. Для новой содержательной доставки отдельная SQLite `orchestration_completion_content` фиксирует immutable notification snapshot до Send: retry не перечитывает изменившийся ответ. Это сохранённые bytes доставки, не второй lifecycle-run или замена transcript proof.

Шрам10.10/v10 iOS: после app restart прежний target turn получил `turn_aborted`.
Родитель передал «продолжай» через `send_message`; статусный reply пришёл, затем
ребёнок закончил новый ход. Старый run всё ещё описывал прерванную execution,
поэтому новый final не стал его completion. Одинаковый SID и текст продолжения
не разрешают такую перепривязку. Для уже продолженной работы подходит отдельное
`wait_for_tab_response`; это чтение нового результата, не повтор старого задания.

## Наблюдение уже выполняющейся работы

`runKind=response-observation` сохраняется в прежнем registry, но не владеет
исполнением target: нет prompt, delivery intent, predecessor, восстановления
закрытой вкладки, Stop или auto-stop. Наблюдение не усыновляет чужих исполнителей
и не отменяет уже законный auto-stop другого run. Собственный source может ждать
его как обычную причинную зависимость; при регистрации циклическое ожидание отклоняется.

Обычный `wait_for_tab_response` ждёт подтверждённого idle, внутренних background
задач и исходящих completion-blockers target. Новая работа до выбора результата
продлевает ожидание. Child delivery-error остаётся требующим внимания, не успехом.
С `waitForDescendants:false` busy admission фиксирует текущий точный ход;
завершение successor не подменяет его. При отсутствии current-turn identity
такой режим отклоняется до регистрации. Смена owner/SID или закрытие target
дают ошибку чтения, не автоматическую перепривязку/Resume.

Main читает результат через существующие parser/source-proof owners.
Codex выбирает последнюю physical `task_started` execution, включая Goal-ход без
новой обычной user-записи. Latest incomplete/abort/error не разрешает вернуть
старый успешный ответ. Историческая execution не получает выдуманное поколение
процесса; у COW read-view SID и physical SID остаются разными. Для живого Claude
сохраняется admitted Stop/StopFailure по точным prompt_id/PID/generation; prompt_id
не выдаётся за JSONL UUID. Saved idle-read использует точную запись прежнего parser.
Готовность composer не доказывает idle; ошибка process lookup не равна absent.

Один immutable выбранный результат/ошибка сохраняется в SQLite до публикации
terminal-state. Restart восстанавливает JSON-проекцию и доставку без повторного
выбора позднего ответа. Содержимое не попадает в общий SSE/runtime status.
Cancellation/suppression подтверждаются только после долговечной записи; позднее
чтение не оживляет отменённый run. Неизвестный/нечитаемый registry не разрешает
удалять сохранённые ответы. Ограниченный result сохраняет `assistantChars/truncated`;
лимит текста и обычная source-handoff защита прежние.

Ожидание event-driven: busy/child wait не читает transcript на каждый append;
после completion подписка на прежний transcript-owner закрывает окно flush.
Перед выбором latest повторно проверяются owner, runtime revision и child gate.
UI показывает статичный timer, unknown/child attention отдельно; отмена снимает
только ожидание. Детали API и версий — fact-terminal-mcp::Статус доставки и
получение результата. Это новый read-flow, не изменение прав обычной делегации.

## Browser-консультация как второй тип target

`runKind=external-research` использует тот же durable store, причинное дерево,
inherited activity, History tracker и source-handoff, но не создаёт фиктивную
Claude/Codex-вкладку. Внешний target отображается как `SC Desktop / provider`,
поэтому у run законно нет `targetTabId`; UI не предлагает открыть или
Pause/Resume несуществующий terminal runtime. Имя в live tracker и раскрытом
History run является кнопкой: тот же `orchestration:open-research-job` открывает
сохранённый SC Research detail по полному jobId, не браузер и не новый запрос.
Успех ждёт rendered ACK; repeated click coalesces, ошибка видна в прежних деталях.

В Research-строке History справа от SC-стрелки есть отдельная browser SVG,
затем прежние Copy/chevron. Новый `orchestration:open-research-browser` связывает
run с сохранённым jobId и вызывает SC `/research-open-browser({jobId,requestId})`.
Нужна `research-capabilities.browserNavigation.version=1` с exactJob/confirmedTab;
старый SC не получает blind `/open-url` fallback. SC выбирает сначала same-job
system tab с текущим URL proof, потом другой system/обычный tab того же conversation.
`pendingUrl` учитывается как текущий адрес назначения, stale tabId/URL-prefix не
доказывают соответствие. При потере markers у startup проверяется exact job в
`window.name`; это только чтение, без инъекции watcher/Send. Результат остаётся
на прежнем run: переход не создаёт research/import, не подтверждает delivery/final.
Закрытый сохранённый conversation открывается чистым URL; temporary без URL
не превращается в новый чат. Отдельные navigation hints удерживают ещё неизвестный
created tab, не присваивая ему research execution. Native/live приёмка и установка
не следуют из component/HTTP/SQLite проверок.

Публичный вход — `POST /api/external-research/orchestrations`, typed wrappers —
`start_external_research`, `continue_external_research` и
`import_external_conversation`. До browser side effect
Noted Terminal атомарно сохраняет request fingerprint, source tab/project/точный
execution context, полный внутренний intent и пару
`runId ↔ jobId=noted_<runId>`. Затем main-owned coordinator обращается к
SC Desktop `/research-start` и ждёт `/research-status?wait=60000`; MCP-модель
после accepted заканчивает исходный ход и ничего не поллит.

Повтор того же run сначала сверяет fingerprint. Тот же запрос продолжает тот же
детерминированный SC job, изменённый получает409. Перед повторным start coordinator
читает status; SC дополнительно восстанавливает request/job из durable metadata,
browser-tab registry или terminal result. Поэтому потерянный HTTP ACK и restart
не дают автоматического права создать второй платный browser prompt. Временная
недоступность SC остаётся видимым статичным ожиданием и повторяется с bounded
backoff; каждый capability/start/status/stop HTTP имеет физический deadline
(status: long-poll60с плюс сетевой запас). Авторитетный SC `status:error`
становится terminal failure, а не вечным loader.

`status:done` считается успехом только вместе со structured `result`. Store не
копирует большой ответ: он сохраняет terminal proof, `conversationUrl` /
`conversationId` и компактную метаинформацию, а один общий
`GET /api/orchestrations/:runId/result` читает полный результат у SC. Ошибка
доставки completion в source является отдельным outcome и не уничтожает готовый
browser-result. Уведомление идёт прежним send-сценарием, сохраняет чужой draft и
теперь обычно содержит проверенный полный текст ответа, run/job/conversation
identity для следующего review. Новый обязательный GET не нужен. Точный SC job
по-прежнему доказывает завершение; промежуточный browser-текст не становится reply.

URL-import не вводит второй store или отдельный notification-path. Wrapper резервирует
обычный external-research run с `readOnlyImport=true`, а SC открывает отдельную вкладку
того же conversation и извлекает уже существующий current final. Внутренний prompt
существует только как непустой orchestration intent и не отправляется провайдеру.
Поэтому success требует одновременно structured result и provider message identity;
commentary/tool без final остаются pending. Отправка нового вопроса по чужой ссылке —
другая операция: обычный start с `conversationUrl`.
Read-only result остаётся answer-first: внутренний activity trace не нужен source для
обычного продолжения работы и по умолчанию заменяется count/omitted marker. Это не потеря
финала или источников; полная activity включается только отдельным forensic-флагом.

Продолжение ChatGPT — новый run и новый SC job с прежним `conversationUrl`.
`continue_external_research({previousRunId,...})` принимает только завершённый
run с conversation identity, наследует его provider/options при отсутствии
override и передаёт новые file descriptors. Переиспользовать завершённый request
ID запрещено: иначе старый result мог бы ложно стать ответом нового review.

Для Codex live audit может раньше canonical UUID получить точную физическую
identity `session + byte offset`, особенно в Resume, где единственным carrier
остаётся `response_item/message(role=user)`. Store сохраняет эту identity. Если
позднее появляется парный `event_msg/user_message`, он становится canonical, а
ранняя identity остаётся alias той же операции. Отсутствие `event_msg` не
означает, что prompt находится вне provider-turn. Alias действует только внутри
одной структурной границы Codex: `task_complete`, `turn_aborted` и следующий
`task_started` запрещают связывать одинаковый текст соседних ходов. При этом
первый `task_started` может законно идти сразу **после** раннего
`response_item(role=user)` того же prompt: exact identity связывает carrier с
этим следующим start, не с предыдущим завершённым ходом. Но если перед carrier
уже есть незакрытый `task_started`, он выигрывает: безусловный поиск вперёд
ошибочно перепривязывает обычный prompt хода A к следующему start хода B.

Codex compact и внутренний `subagent_notification` внутри долгого ответа не
начинают новый продуктовый turn. History может представить compact отдельной
строкой, а rollout — сохранить служебное уведомление как `event_msg`
`user_message`; обе result-проекции обязаны считать их продолжением исходного
внешнего хода. Поэтому ответ включает assistant-текст до и после служебной
границы. Следующее настоящее пользовательское сообщение остаётся жёсткой
границей и в чужой результат не попадает.

Claude completion встроенного Agent/Task также не начинает новый продуктовый
turn. Claude CLI сохраняет его как служебный `<task-notification>`: иногда
отдельной user-записью, иногда attachment `queued_command` с
`commandMode=task-notification`. Это продолжение внешнего prompt, который
запустил Agent, поэтому следующие assistant-блоки и финальный `end_turn`
принадлежат тому же orchestration-result.

Обычный пользовательский `queued_command` остаётся самостоятельным turn в History, но не
разрезает физическое исполнение orchestration-run. Если исходный prompt доказан точным
UUID, а run хранит точные Claude session/turnId, result-proof включает все последовательные
пользовательские `queued_command` до сохранённого completion-time. Завершение доказывает только
новейший queued-срез: старый `end_turn` перед более поздним незавершённым follow-up не закрывает
run. Следующий обычный user-turn или queued-запись позже exact completion-time являются жёсткой
границей и не могут быть усыновлены старым run. Без exact UUID/turnId остаётся прежний
безопасный fallback. Иначе готовый target зависает как `resultAvailable=true/resultComplete=false`,
а source не получает уже существующий финальный ответ.

Для fresh Codex модель и effort принадлежат launch: новая вкладка получает их при старте, а первый send передаёт только prompt. Повторная попытка применить ту же пару вместе с `queue:true` уже после появления ready-composer корректно отклоняется idle-guard'ом и раньше оставляла target готовым, но без пользовательского сообщения (`codex_settings_change_requires_idle`). Для существующего idle target настройки можно применить перед send; busy target не должен маскировать смену настроек очередью.

## Авторитетный lifecycle

Готовность определяется структурными событиями агента: `task_started`/`task_complete`/`turn_aborted` для Codex и эквивалентным busy/done-контуром Claude. Но событие применяется только к сохранённому контексту исполнения: provider, session, turn, поколению writer и, для Claude, PID процесса. Стабильность текста, совпавший `tabId`, возврат prompt-глифа и terminal output не являются completion-proof.

Внутренний Codex background count — только execution lease, не mailbox count.
`collaboration.send_message`/interacted не запускают idle child, а настоящие
followup/resume продолжают удерживать gate до собственного terminal proof.
09.10 задержка4196→3607 была вызвана ошибочным mail→running у child producer,
не потерей508char финала и не заменой pinned turn следующим ручным запросом.
При правильном count0 существующий task_complete/zero-edge закрывает run;
unknown snapshot не превращается в0. Исправление находится у subagent owner,
orchestration guards не ослаблены; recovery старого run отдельно сохранила
cancelled/suppressed, не переписала его задним числом в completed.

`queue:true` означает только разрешение поставить сообщение за уже идущей работой. Это не доказательство, что предыдущий turn существует. Ожидание чужого completion включается только по реальному baseline `busy` или по сохранённому predecessor-run на том же target. Иначе собственный `task_complete` ошибочно поглощается как окончание несуществующей предыдущей задачи, а run навсегда остаётся `queued`.

У Codex post-Enter `user_message` audit и собственный `task_started` могут прийти в любом порядке. Поэтому события до подтверждения доставки не объявляют run запущенным вслепую, а exact audit и start-контекст объединяются только по их структурной границе; сразу после acceptance выполняется одна сверка transcript + live status. Она закрывает окно гонки; дальнейшее ожидание снова полностью event-driven. Это не polling.

Незавершённый result-proof остаётся ожидающим только пока его provider-turn
физически открыт на конце transcript. Если уже встретился следующий
`task_started`, несовпавший terminal-event или иная закрывающая структурная
граница, новые записи внутрь старого хода появиться не могут. После
authoritative completion такой результат сразу становится явной terminal
failure, а не ждёт recovery deadline с неподвижным индикатором.

Несколько run на одном target упорядочиваются predecessor-связью, но очередь исполнения target отделена от причинного дерева. После собственного terminal-state run освобождает execution-lane даже если его ветка остаётся в `waiting_descendants`; следующий run того же target получает собственный busy→done и не ждёт случайного transcript-reconcile. Первый run продолжает ждать своих потомков независимо. Один completion нельзя засчитать двум задачам.

Зависимости пересчитываются снизу вверх отдельно от predecessor-очереди. После собственного успешного ответа run с незавершёнными потомками остаётся активным в `waiting_descendants`; exact post-Enter audit уведомления ребёнка доказывает, какой именно follow-up начался, и только последующий authoritative done может закрыть ветку. Generic busy-turn того же исполнителя не устанавливает эту причинную связь. Поэтому короткий idle-разрыв между ребёнком и follow-up родителя не является окончанием всей работы.

После terminal-state дочернего run ветка ещё не считается свободной: отдельное durable-состояние source-handoff удерживает `inheritedBusy` во время result-proof, вставки/очереди completion-сообщения и до post-Enter доказательства именно этого уведомления. Доказательство несёт точный `runId` в handoff/source identity; generic `busy:true` источника не имеет права снимать oldest pending run. Prompt/Stop/Close After, Git Run After и Restart After используют общий completion-gate: они не стреляют на idle родителя, пока живы потомки или не завершён точный handoff. Фиксированная пятисекундная пауза запрещена: занятый input может законно держать notification в очереди дольше.

Fresh Claude требует отдельной причинной границы: до первого prompt у вкладки ещё нет JSONL-пути и `sessionId`, хотя процесс и composer уже готовы. Непосредственно перед Enter main доказывает Claude PID под точным PTY, чтобы `UserPromptSubmit` привязал появившуюся запись к staged send. Только для этого unresolved-transcript случая допустимо сравнение timestamp записи с моментом отправки; ошибка чтения уже известного JSONL не превращается в такое доказательство. Иначе одно физическое уведомление отображается в History дважды: как временная строка handoff и как durable user-запись.

## Завершение и уведомление источника

History/Timeline SOURCE компактно показывают доказанный External Research итог
через display-only projection. History11.10 использует прозрачные tool-строки:
однострочный Markdown excerpt под каждым ответом, Research/saved model без
технического имени job в шапке, whole-header toggle, ограниченное тело с тёмной
нейтральной подложкой и отдельную SC-стрелку. Timeline сохраняет свой popup.
Это не новый формат notification/result и не преобразование сохранённого JSON.
Все transport/Copy/provenance/UUID/hash остаются прежними; reader не вызывается
на каждую строку. Строго соседние Research completion/failure от двух штук имеют
общую правую History-шапку с левой rail и видимым числом typed failures, но остаются
разными уведомлениями/records и Timeline-точками. Отрицательный verdict внутри
JSON не является delivery failure; отправленный request не увеличивает этот счёт.
Модель берётся из сохранённых options exact run через прежний локальный каталог;
дополнительный metadata read разрешается новому непокрытому runId, без result GET.
Показ prewarmed History использует текущий presentation channel, не начальный
React seed видимости. Это renderer admission, не изменение run/delivery authority.
Подробности — `fact-история-как-основная-поверхность::Компактный
ответ External Research`.

Completion входит в общий Main FIFO с stable desktop-history operationKey уже
до renderer. Шрам04.10: без key первый memory-registry waiter ждал renderer,
renderer повторно принимал запрос через agent:enqueue-prompt, а возврат FIFO
стал конфликтом того же handoffId. Отказ был до attempt/paste/Enter, хотя target
успешно завершился. Не отключать fingerprint guard и не лечить одинаковым хэшем:
это может заменить conflict самоприсоединением к ожидающему caller. Проверка
Main→actual renderer function→Main воспроизводит отказ на старом caller и одну
отправку на новом; prepared context и source/session guards сохраняются.

После успешного completion сервер сопоставляет result-turn, читает проверенный
результат и фиксирует notification snapshot до отправки через общий History/send.
Новый payload содержит полный Markdown-ответ и точные run/source/target IDs;
browser также даёт job/conversation identity. В History видны тело и карточка
источника, а служебная инструкция/ID не занимают место ответа. Источник использует
уже доставленный текст, не вызывает GET для отметки прочтения. Разовый созданный
исполнитель по-прежнему закрывается только когда больше не нужен.

Предел inline совпадает с существующим result-reader250000символов. Truncated,
отсутствующий или больший ответ даёт явный reference с точным run/session/job,
без молчаливого усечения или объявления частичного текста полным. Ненормальный
исход передаёт причину ошибки, не выдавая partial output за успешный ответ.
Уже начатые до обновления handoffs сохраняют прежний технический payload:
смена текста под тем же operation ID нарушила бы audit/idempotency. Поэтому
агент смотрит на фактически пришедшее сообщение: inline использует сразу,
reference/legacy читает один раз по указанному ID.

Новые native/browser runs отдельно сохраняют source send-target независимо от
causal parent context. Известная сессия пинится по provider/SID; fresh live-source
до первой записи — по точному terminal instance/launch. Поздний ответ не получает
право уйти в новую сессию только потому, что tabId тот же. Snapshot identity
проверяется после result-read и снова у физической записи. Неизвестная runtime
identity не подменяется saved SID; допустимый Resume проходит по exact alias.
Весь source pin передаётся через bridge, readiness и provider adapter до main,
не только sessionId: у provisional launch его ещё нет. Иначе materialization
после HTTP-preflight и замена процесса до renderer могли бы потерять защиту.
History скрывает envelope только при совпадении полного UTF-8 hash, длины и
сохранённого header; совпавшего UUID или offsets недостаточно после правки тела.

`bodyProjectionHash`, envelopeText и UTF-16 границы в trusted semantic tag
относятся к полному prepared prompt вместе с context-prefix. UI скрывает только
свою оболочку при точном совпадении; codec/изменившийся текст дают полный raw
fallback. Copy/Rewind сохраняют исходный prompt и адрес результата.

Служебное уведомление не владеет текстом, уже набранным пользователем в source-composer. Видимый History-input живёт отдельно от PTY: реальный Electron-flow сохранил его текст, пока Claude получил и обработал completion отдельным turn. Нативный TUI composer защищён другим preflight того же send-сценария даже при `queue:true`: Codex использует headless draft-authority, Claude — актуальный headless terminal snapshot. Доказанный draft возвращает `terminal_draft_conflict`, уведомление переходит в `waiting-for-input`, а текст не меняется; неизвестность на активном materialized composer останавливает отправку вместо blind paste. Fresh source без materialized terminal-state остаётся разрешённым первым prompt, иначе уведомление само никогда не смогло бы создать его первую запись.

После authoritative освобождения input доставка пробуждается событием и повторяется. Для конфликта с уже набранным Claude/Codex TUI draft `busy:true` источника является безопасным wake-сигналом: source начал новый turn, после чего доставка заново выполняет авторитетный draft-preflight и продолжает только при пустом composer. Само событие не доказывает identity отправленного текста, не заменяет preflight и не подтверждает ни одно completion-уведомление. Успешный post-Enter audit освобождает только совпавший `runId`, поэтому два pending уведомления могут подтверждаться в обратном порядке без сдвига на один run. Idle/noise-событие retry не вызывает; `done` остаётся дополнительной границей для прежних waiting-состояний. Результат всё время доступен по `runId`, а повторная доставка не выводится из таймера или чтения transcript. Автоматическое пробуждение остаётся штатным для доказанного draft-conflict; явный Retry нужен для терминального состояния `unconfirmed`, где неизвестен исход доставки: Enter мог быть уже доказан без точной user-записи либо сам переход остался неизвестным после bridge timeout. Такой Retry осознанно допускает повтор и потому не выполняется автоматически.

Streaming source сам по себе не является конфликтом и не откладывает вызов.
Сервер немедленно вызывает общий send-сценарий с `queue:true`; тот выполняет
тот же exact draft-preflight, что обычный History Send. Только доказанный draft
даёт `waiting-for-input`. Локальная проверка `source busy → return` запрещена:
она обходит provider queue и оставляет готовый результат в
`notificationStatus: pending` без физической попытки доставки.

Уведомление — отдельный outcome. Run может быть успешно завершён, даже если source нельзя разбудить: например, fresh Claude был остановлен до первого materialized turn. Тогда сохраняется `notificationStatus: failed` с причиной `session_not_materialized`, а результат остаётся доступен по `runId`; ошибка уведомления не переписывает успешный target-result. Если source-вкладку удалили уже после target-result, ещё не доставленное уведомление терминально подавляется как `source-closed`, но сам результат остаётся завершённым и доступным.

Если fresh source-процесс всё ещё жив и input-ready, completion notification может стать его первым materialized prompt. Это нормальный путь: уведомление отправляется один раз, создаёт первую durable user-запись и гасит временный History handoff. Остановленный fresh source без готового composer остаётся предыдущим failure-case и не получает искусственную историю.

Abort/interrupt target-turn переводит run в failure, а не в completed. Отвязка orchestration-run прекращает ожидание и подавляет обратное уведомление, но никогда не interrupt’ит target: дочерняя вкладка продолжает работу самостоятельно. Остановка target — отдельное явное действие (`interrupt=true` в API), а обычное завершение также оставляет runtime пригодным для следующего сообщения.

Явный Terminal MCP `complete_task` относится к готовности всей задачи source-вкладки, а не к исходу одного run. Поэтому вкладка с активными исходящими run получает отказ и не может погасить свой Loop или отчитаться как полностью готовая раньше дочерних исполнителей. Сам вызов ничего не завершает: он становится действительным только вместе с успешным authoritative done точного текущего provider-turn; ненормальный исход этот intent отменяет.

### Скрытое уведомление не стирает знание о завершении

Шрам14.09: ce8 завершился успешно, completion transport вернул неизвестную
доставку, пользователь скрыл предупреждение. Сервер сохранил completed, но при
следующем вопросе source-модель ответила «ещё выполняется»: у неё остался старый
разговор, а доставка нового notification не была подтверждена. `sourceAcknowledgedAt`
означает действие пользователя с attention, не прочтение результата моделью.
`unconfirmed` допускает и известный Enter без audit, и bridge timeout без знания,
пересёк ли Enter; одно нельзя объявлять другим.

По требованию пользователя закрытие остаётся тихим: не возвращает chip, не
запускает source и не повторяет спорное уведомление. Отдельный bounded read из
того же run-store даёт короткий факт завершения следующему обычному Send текущей
подтверждённой source session. Он идёт через существующий TabWorkContext до
receipt hash, с собственными ID в immutable handoff, не через новый queue runner.
Ни prompt исполнителя, ни полный result туда не входят; terminal fact не означает
команду заново читать уже прочитанный ответ или создавать новый run.

Не больше8 фактов на handoff; новая подготовка не добавляет reserved/unknown
факты, доказанный отказ освобождает их для следующего обычного prompt. Ранняя подготовка старой отправки не меняется
после позднего completion. Другой SID/provider, slash и старый notification
исключены; focus/reopen сами ничего не готовят. Raw TUI ввод не проходит этот
слой: там текущий статус нужно запрашивать по runId, не угадывать по разговору.
Проверены actual main/configuration→HTTP Send/registry и SQLite/restart; это не
доказательство отсутствия любой ошибки в последующем ответе LLM. Execution status
и result/notification receipt остаются прежними, finished не становится running.

Повторный audit выявил отдельный write-gap: ранний возврат immutable handoff не
проверяет, куда его затем отправят. Actual HTTP воспроизвёл unsent H(A)→новый B→
plain Send с null-SID. Source guard теперь проверяется до исполнения и в общей
PTY-очереди/перед каждым chunk/Enter. Сам payload и уже полученные receipts не
переписываются; обычный новый Send в B сохранён. Stopped A может подготовить
Resume по saved binding, но physical proof берётся только из main destination
resolver; точный собственный accepted Resume source переносится штатно, не
через произвольную lineage. Код отказа — `agent_context_source_changed`.

Пользователь15.09 отдельно разрешил ручной Retry ранее доказанно неотправленного
H1, даже если его короткий факт F уже включён в unresolved H2. H1 и H2 — разные
пользовательские сообщения со своими квитанциями; запрещать законный Retry из-за
повторяемой справки нельзя. Frozen H1 остаётся прежним, F — тот же read-only
факт по runId, не новая задача, notification или запрос результата. Retry самого
unknown H2 по-прежнему только читает receipt; новый H3 не получает F заново.
`continuation_facts` — состав сообщения, не эксклюзивная блокировка знания.

## Цена проверки результата

Performance-шрам14.09: event-driven reconciliation не гарантирует
дешёвого чтения. Прежний exact Codex result-reader сначала вызывал общий
`_loadSessionTurns`, затем `loadSessionRecords` для provider-proof. При raw-LRU
768MiB два одновременно нужных rollout504/275MiB взаимно вытесняются;
в установленном приложении это дало8 full parses/2228.9MiB за минуту и
совпало с global input/hover stalls. Это путь native Codex result, существовавший
до browser-research, не доказанная стоимость новой карты Run after.
Source-ремонт exact-пути выделяет компактный индекс перед generic loader;
дочитывание append не зависит от raw-LRU и не строит History. Прежние
provider classifiers/carriers и координатный reducer сохранены. Дешёвое наблюдение
не даёт права завершать или восстанавливать run. Перед таким решением проверяются
bytes/digest и физические snapshots всех сегментов после I/O: неизменная lineage
не доказывает, что inode/содержимое остались прежними. Проверка обязательна и для
abort/empty-final/error, а перед выдачей результата или окончательным отказом
закрытому target — также для отсутствия записи. Иначе rewrite+growth может
сделать ложным как положительный ответ, так и «результат не найден».
Отсутствие полного parse не означает нулевое чтение при cold/final/rewrite. Async commit сверяет неизменяемый
lookup/execution, включая generation и Resume. Неизменные наблюдения не
пишут store и не рассылаются снова.

Готовый собственный ход, ожидающий потомков, продолжает получать события и
дочитывать append, но не хэширует весь rollout при каждом tool-output следующего
хода. Так же pending child не перепроверяет большой frozen parent на каждое
дописывание за пределами его среза. Digest остаётся обязательным перед решением;
одному увеличению размера не доверяют. Точный закрытый Codex A не становится
running из-за busy следующего B; ожидание потомков и внутренних продолжений
сохраняет отдельный gate.

Закрытие target присоединяется к общей выполняющейся проверке и её trailing-read.
Постановка повтора не означает, что чтение уже закончено: до его результата
нельзя объявлять `result_unavailable`. Подтверждение получения notification
родителем использует тот же Codex reader с provider исходной вкладки; оно
проверяет адрес prompt и не требует ждать завершения ответа родителя.

Retry/reopen и restart до binding не возвращают known-Codex запрос в generic
reader. Провайдер и сохранённая SID/cwd берутся из immutable run; late live-status
другой вкладки их не подменяет. Bootstrap использует компактные metadata и
прежние UUID/source/hash/time правила, выводит настоящий turn из transcript,
но не выдумывает generation и не регистрирует live execution. Старый ID-less
формат сохраняет ограниченный user-bound collector с locators; современный
terminal ID без его start остаётся pending. Текстовое окно не вправе скрыть
ошибку поздней canonical alias; первый terminal outcome не отменяется поздним
idle Stop. Исходный generic compatibility-путь остаётся для других providers,
а обычное ожидание Codex не строит всю историю при каждом событии.

Source-проверка включает большие файлы, Retry/restart, отсутствие renderer,
rollback/alias, stale commits, close во время чтения и чужой следующий turn.
Повтор Astra получен14.09; замечания проверяются исполняемыми регрессиями,
а не считаются устранёнными по согласию с текстом reviewer. Установленная
приёмка остаётся отдельной; точные результаты — рабочая карта окон14.09.

## Ошибка, восстановление и очистка

Точный окончательный отказ Claude — `StopFailure` с main-owned turn context
либо `isApiErrorMessage=true` в assistant-записи выбранного provider-turn —
завершает run как failed сразу, с причиной провайдера. Это отдельное исключение
из recovery grace ниже: server429 уже отказал этому выполнению, ожидать его
успешный ответ незачем. `error` без такого proof, временный retry, Escape и
потеря процесса сохраняют собственные прежние правила. Ошибка в старом turn не
применяется к новому, а отменённый пользователем run не оживает.

Остальные ошибки провайдера без окончательного proof, startup failure, выход процесса и закрытие target не должны выглядеть как успешный ответ или вечная очередь. Они нормализуются в отдельный outcome и переводят run в `waiting_recovery` с сохранённым deadline. Исключение — точно доказанный отказ до submit (`submitted=false`): Enter не был принят, поэтому run сразу получает конечную ошибку и уведомляет source без recovery grace. Неизвестная доставка и пропажа процесса такого доказательства не дают и сохраняют обычное окно восстановления. Ручной interrupt/Escape всегда переводит уже начатый вызов в то же видимое ожидание, но настройка управляет только таймером: выключенная реакция оставляет связь без срока, включённая запускает обратный отсчёт до передачи ошибки.

Есть второе точное исключение без recovery grace: после Enter
`provider-not-accepted` доказывает, что provider-turn не создан,
исходный draft без изменений остался в composer, а новой
user-записи нет. Run сразу завершается ошибкой, освобождает
serialization-lane и уведомляет source. Draft не очищается, а тот
же handoff не повторяется. Смешанный или изменённый draft такого
доказательства не даёт и остаётся в неопределённом состоянии.

После ручного interrupt следующее сообщение в той же target-сессии автоматически продолжает этот вызов, но только по новому точному контексту provider/session/turn и только при одном ожидающем кандидате. Повторный busy старого хода, событие без identity, другая сессия и несколько подходящих recovery-run ничего не привязывают. Закрытие target, смена процесса и реальные ошибки по-прежнему требуют явного Retry: они не являются паузой того же разговора. Retry создаёт новую доказанную причинную границу; поздняя работа после dismiss или истёкшего deadline старый вызов не оживляет.

Во время grace-периода ручного interrupt пользователь может снять таймер и ждать следующего сообщения без срока, вручную восстановить выбранную связь, передать ошибку родителю сейчас или закрыть связь без сообщения. Ручное восстановление остаётся запасным путём для неоднозначного случая с несколькими ожидающими run; обычный единственный run продолжится автоматически. Для закрытого/ошибочного target восстановление всегда явное: это либо действие Retry/Resume, либо новый адресный `send_prompt`/`delegate_to_session`, но не фоновое наблюдение. Закрытие вкладки проходит через общий `closeTab` и сообщает store сразу, поэтому все связанные активные run получают исход вместо вечного `queued`.

`Продолжить запрос` в hover-карточке — отдельное app-owned действие `continue`,
а не прежний Retry исходного текста и не обычный ControlBar Resume. Оно проверяет
source/target history и исходный/последний выбранный prompt, строго сохраняет
continuationIntent и отдельный H `orchestration-continue:<runId>:<ordinal>` до FIFO.
Общий sender возобновляет остановленный target и отправляет ровно один `continue`;
повторное нажатие присоединяется к операции. Каноническая квитанция именно этого H
с exact new execution context привязывает result-reader к новому UUID/turn,
не переписывая original request fingerprint/hash/адреса. Generic busy старого либо
чужого хода не потребляет continuation. Пока proof не получен, карточка жёлтая,
а не фиктивно running; после binding действуют обычные inherited/result gates.

Проверки повторяются в preparation общего FIFO, в том числе после восстановления
сохранённой очереди; неизменного SID недостаточно при другом последнем поручении.
Goal/background work, unknown process lookup, draft/readiness и Main physical-owner
guards не обходятся. Ready original result восстанавливает outcome без нового
input, только после свежих ownership/work checks. Claude original reader использует
существующий verified transcript callback, не объявляет legacy stat source proof.
Пауза остаётся link-only: поздняя Continue-квитанция хранит delivery proof, но не
снимает Pause; Resume не принимает turn, начавшийся раньше его собственной границы.

`new-request` — явное новое поручение в текущих историях: копируется сохранённый
original snapshot text, получается новый стабильный runId и обычный queued intent.
Прежняя связь закрывается без Stop процесса и сохраняется в History. Valid прежний
causal parent сохраняется при той же source history, другая ветка не получает
старую связь по одному tabId. Replay созданного replacement восстанавливает его
dispatcher, не создаёт второй run. При удалённом адресате/несохранённом тексте
приложение не угадывает получателя: новый запрос создаётся явно из нужной вкладки.
External research и response-observation не получают physical Continue.

Отмена из карточки и `/api/orchestrations/:runId/cancel` сначала сохраняет exact
continuation cancellation у прежнего FIFO/receipt owner, затем closure до ACK.
Это не отрицательная квитанция прошлой доставки. Canonical audit может уточнить
исторический Enter, но cancelled run не оживает. Подтверждённый receipt удерживается
pin до strict projection; после restart неизвестный Enter re-audit/reconcile,
не новый prompt. Для одной target-вкладки competing accepted request не обходится.

Pause относится к связи run, а не к процессу target. Исполнитель продолжает жить, пользователь может отправлять ему сообщения, но ходы, начатые до Resume, не возвращаются source и не создают новых причинных потомков приостановленного run. Resume не перечитывает «последний доступный ответ»: он сохраняет новую временную границу и принимает только точный provider/session/turn, реально начавшийся после неё. Запоздалый audit исходного prompt и завершение хода из периода паузы эту границу не обходят. Пауза переживает restart, остаётся жёлтым completion-блокером для Run After и Build Install, но не включает фиолетовый inherited shimmer. После Resume до точного старта нового хода сохраняется та же жёлтая блокировка без фиолетовой анимации; фиолетовая активность возвращается только по этому старту. После начала source-handoff ставить связь на паузу уже поздно; остаются действия доставки или отвязки.

Deadline и настройки хранятся вместе с run-store, а main ждёт ближайшую дату одним scheduler'ом. Renderer только показывает обратный отсчёт. По истечении recovery deadline ошибка становится конечной и доставляется source; после успешного одноразового run отдельный deadline может остановить созданный orchestration target, но только после `resultComplete=true`. Старое намерение auto-stop навсегда теряет право на действие, если после завершения его run тот же target принял или начал более новую работу — даже когда новая работа уже успела завершиться к deadline. Проверять только текущие active run недостаточно: такой guard останавливал вкладку под уже выполненным следующим заданием. Вкладка не удаляется, а переиспользованный пользовательский target автоматически не останавливается.

### Fable limit и разные представления prompt — 13.09

Точный production-run `44ecf880-806a-4525-899d-259997907ef7`, target
`…a19b89db-dead-46e3-92f7-5229afa4729d`, SID `6f65c69f…`:54TAB заменились
на216пробелов, длина выросла на162 (36567→36729chars). Live API receipt
сохранил оба текста; replay `prepareClaudePromptTransport` совпал полностью.
В18:08:04.184UTC аудит exact user `6721738a…` отвергся по promptHash/expectedHash:
durable request `a2808b84d9e53baa`, transport `71d40f9e0dc01104`. Поэтому run
не получил execution context, хотя History усвоила сообщение. В19:46:47UTC
StopFailure снял main busy, но не завершил непривязанный run. В20:37:22 пользователь
отвязал его сам; source repair не пересылает prompt/ошибку и не восстанавливает run.

Live/main и startup audit теперь доказывают request→transport отдельно от
transport→provider. HTTP передаёт `canonicalReason` вместе с обоими hashes и в
target proof, и в source follow-up; одного флага canonicalized недостаточно.
Result-reader также различает настоящий ответ и synthetic API-error: последний
не становится success от `stop_sequence`, в том числе после Resume-записи
`No response requested.`. Закрытие по exact JSONL работает и при раннем отказе
до доставки live audit или после потери события.

Проверки: `claude-provider-failure.integration.test.js` исполняет actual main
audit→SQLite→HTTP proof→run store, actual StopFailure publication и recovery
result branch, actual Claude parser→live History. Соседние settings/registry/
orchestration/Codex usage-limit suites сохранены. Это source/integration proof;
нового provider CLI/packaged UI прогона и install не было.

## Persistence и восстановление

Run-метаданные, точный target-prompt UUID, контекст исполнения, дерево зависимостей, recovery/auto-stop deadlines и настройки пишутся атомарно вне renderer-state и переживают Electron restart. При старте tracked-записи сверяются с transcript и текущим состоянием вкладки: exact UUID восстанавливает `running`, `waiting_descendants` или результат; bounded hash-fallback разрешён только для legacy-записи без UUID. `completed + resultComplete=false` остаётся tracked, заново вооружает доказательство transcript и не разрешает auto-stop. Для source completion сначала проверяется точная durable History-квитанция того же handoff; при недостаточном proof используется прежний exact сохранённый prompt hash в transcript source-вкладки. Совпадение завершает handoff; отсутствие обоих доказательств переводит старое `sent/queued` в `unconfirmed`, сохраняет возможность позднего exact proof, но убирает ложный spinner и требует Retry либо явного закрытия. Renderer нужен для отображения, countdown и переходов, но не является владельцем lifecycle. После authoritative target completion UI немедленно меняет running-spinner на отдельную статичную фазу проверки результата; жёлтый timer относится только к реальному recovery.

CompletionContentStore замораживает неизменный пакет до доставки; inline-пакет
содержит полный ответ в пределах прежнего лимита, oversized reference не становится
вторым хранилищем полного provider/SC результата. До Main FIFO строго сохраняются
handoff, hashes и source session. Ошибка этого checkpoint не допускает ввода.
Квитанция `history:<sourceTabId>:orchestration-complete:<runId>` удерживается pin
`orchestration-source-followup` до durable confirmation. Atomic canonical audit
дополнительно сохраняет `receipt.auditExecutionContext` той же row/session/attempt
и только явный boolean `auditQueuedAtSubmit`. Legacy absence остаётся unknown;
повторный audit лишь дополняет неизвестные поля, не заменяет конфликтующий context.

Startup сначала соединяет canonical receipt с run, без нового Send и без
вооружения transcript reader при достаточном proof. Проверяются operation/attempt,
source tab/handoff, provider/session, canonical user address и request-to-provider
hash proof; `historyOnly`, transport-only и неизвестная доставка не подходят.
Причинный parent по-прежнему требует exact execution context и прежние
same-active/same-settled guards. Подтверждение, включая повтор после write failure,
дожидается strict persistence до освобождения pin; startup убирает лишь pins
своего owner для уже подтверждённых, suppressed либо удалённых run. Cancellation
остаётся отдельной осью: поздний receipt уточняет прошлую доставку, но не оживляет
отменённый source handoff. Отсутствие proof не разрешает blind resend.

Source/private проверки включают реальную SQLite/RunStore, actual Main/web функции
и SIGKILL отдельного тестового writer после canonical commit до run projection.
Provider/PTY/SC и watcher transport в этих проверках контролируемые; это не
принудительный restart работающего платного research и не installed acceptance.

История ограничена по числу и возрасту завершённых записей; run с незавершённым result-proof, source-handoff, recovery или ошибкой доставки не удаляется этим лимитом, даже если target уже имеет terminal-status. Idempotent client-supplied `runId` защищает повтор POST после сетевой ошибки от создания второго исполнителя.

## UI в History

Цвет доставки общий для native/browser run и адресной переписки: штатная очередь
серая, отправка синяя, подтверждённая доставка зелёная, неизвестный исход или
внимание жёлтые, явная ошибка красная. Сохранённое `sent` без обязательного
prompt-proof или с audit-pending ещё не зелёное. `queued` с transport-unknown
также остаётся жёлтым. Синий `sending` до исполнения статичен; purple execution
и recovery countdown остаются отдельными осями, completion-block не снимается.

Live tracker сообщений и run находится в отдельном absolute dock рядом с rail,
а не среди flex-кнопок. Его высота не двигает RunAfter; измеряются также hover/
pinned queue и выступающие edge-controls в своей pane. На узкой pane список
доступен через постоянную кнопку History. Она объединяет run и question-thread
по времени; детали сохраняют native pause/retry/detach действия. Сообщения не
превращаются в run ради общего списка; их X отменяет будущую доставку и ожидание
через message owner, не Stop адресата и не удаление сохранённой пары.
Одна кнопка со статусами Send/Reply открывает боковую пару вопрос/ответ,
не закрывая и не прокручивая History. Escape сначала закрывает эту дочернюю
поверхность; native run по-прежнему раскрывается внутри списка.
Основной header26px одинаков для native/browser run и переписки, включая status
slot и крестик; Send/Reply является одним визуально вложенным рядом, не другой
геометрией header. Общий scrollbar3px принадлежит dock, внутреннего второго
скролла run нет. Такое вложение не создаёт причинную parent/child зависимость.
По уточнению Fedor12.10 compact dock слева от History показывает только ожидания,
работу и требующее действия внимание, без зелёных карточек. Текущий зелёный
presentation скрывается сразу: и success, и `sent`/передача результата с зелёным
статусом, даже если backend handoff ещё ожидает своего proof. Runtime, receipts,
inherited/completion gates и доставка при этом не меняются. Message success требует
sent обеих сторон; ожидание ответа, ошибка, recovery и незавершённый result-proof
остаются. Прежняя4секундная задержка и success-expiry timer удалены. History,
его счётчик и открытый preview сохраняются; детали message-контракта в
`fact-tab-messages.md::UI и инструкции`.

Начальное чтение списка подписывается после установки event-listener, а поздний
list сливается с уже принятыми events по runId/updatedAt; равный timestamp
сохраняет live update. Иначе completed event мог снова стать active после
возврата старой hydration. У source completion время audit/user-record и свежесть
run — разные оси: `sourceFollowupStartedAt` сохраняет точное историческое время
записи, но `updatedAt` подтверждения и изменённых causal parents публикуется по
времени применения и строго позже прежней версии. Иначе queued snapshot может
оказаться новее фактически принятого sent и live tracker навсегда останется серым.
`OrchestrationPublication` различает proofAt/previous/published после strict save;
source identity/hash/causal execution и lifecycle timestamps не меняются.
`sending` без target execution context показывается
статичным таймером «Ожидает доставки», не спиннером выполняющегося агента.
Run остаётся в ожидании, не скрывается для косметического устранения loader.
Тот же merge действует в глобальном store: во время hydration сохранены и
terminal events удалённых из activeRuns записей. Старый список не воскресит их,
а ошибка чтения не стирает принятые events. Неподтверждённый `sending`, как и
`queued`, не включает inherited shimmer без deliveryAcceptedAt/targetPromptProofAt;
completion block при этом сохраняется. Static wait в карточке и общие tab/project
сигналы не должны приписывать агенту работу до факта принятой доставки.

Раскрытая запись run не повторяет «Состояние» из header. `outcome` и
`completionReason` сведены в один «Итог»; одинаковые error/resultError показаны
один раз, различные ошибки сохраняются с указанием этапа. Общая проекция деталей
используется и в hover. Typed `outcome:interrupted + completionReason:turn_aborted`
показывается как «Остановлено вручную»: тот же exact `turn_aborted` в execution/
result error не дублируется как «Ошибка». Это отмена, не provider/delivery failure.
Неизвестная причина, другой outcome, развёрнутый error и отдельная notification
error сохраняются; durable run/error/receipt при отображении не меняются.
`notificationStatus` относится к обратному уведомлению,
не к отправке задания: failed + sent означает «Не выполнено» и «Уведомление об
ошибке доставлено», а success + notification failed сохраняет «Выполнено».
Queued/unconfirmed не переименовываются в доставку; pending до результата не
создаёт ложное ожидание уже готового ответа. Проверка result-proof остаётся явной.
Дата в header отдельная от обрезаемого имени, с годом и минутами в системном
часовом поясе; в раскрытом блоке она не дублируется. «Отправлен» использует
native deliveryAcceptedAt только при targetPromptProofAt; если есть лишь proof,
подпись «Подтверждён». Иначе показывается createdAt как «Создан»: принятие job
SC Desktop не доказывает отправку в браузере, даже когда заполнен deliveryAcceptedAt.
Неизвестные коды причин не теряются, runId и lifecycle-действия сохраняются.

Верхняя поверхность слева от служебной области — live tracker: она показывает активные run и требующие решения recovery/delivery-состояния. Несколько одновременных вызовов объединяются в ограниченный по высоте прокручиваемый список; каждый ряд ведёт к связанной вкладке и раскрывает направление, проект и состояние. Верхняя строка popover принадлежит run, поэтому generic `закрыть / копировать` там не показываются: активная или прерванная связь получает Pause, приостановленная — Resume, recovery — ожидание без таймера либо восстановление, передачу ошибки и закрытие без сообщения, а неподтверждённая доставка — Retry и `×`. Для активного run `×` закрывает только связь, подавляет будущее уведомление и освобождает completion-gate; уже запущенный Claude/Codex продолжает работу без `Escape`, `Ctrl+C` или kill. Если prompt ещё физически не отправлен, отменяется только его exact handoff. Отдельная settings-кнопка управляет grace, auto-stop и реакцией на ручной interrupt. При раскрытом Timeline rail сдвигается на его overlay-ширину: служебные controls не должны перекрывать semantic group и перехватывать клик её строк.

`waiting_recovery` показывает два ортогональных признака одновременно: статичная жёлтая иконка таймера означает, что durable-связь продолжает ждать решения или следующего хода, а знак предупреждения объясняет ненормальную паузу. Такая же статичная иконка используется для жёлтой очереди до Enter и ожидания exact delivery-proof: вращение зарезервировано для реально выполняемой работы. Это локальный индикатор карточки, не inherited activity: он блокирует completion/Run After/Build Install, но не включает фиолетовый shimmer вкладки или проекта, потому что дочерняя работа в этот момент не доказана.

Успешно завершённый target исчезает из tracker только после полного result-proof и точного подтверждения source-handoff. `completed + resultComplete=false` показывается как «Проверка результата»; terminal failure, recovery и delivery-error остаются до решения или deadline. Все конечные run доступны в компактном окне `History`, размещаемом рядом с кнопкой в границах своей pane. Окно не блокирует History/terminal и прокручивается внутри. Переход из обеих поверхностей использует сохранённые `projectId + projectPath + tabId`, поэтому работает между проектами и не зависит от текущего `activeProjectId`.

Пока родитель ждёт потомков, точный result-proof или source-handoff, его собственный runtime может быть idle, но работа, которой он владеет, ещё не завершена. TabBar и project aggregate получают отдельный `inheritedBusy`: он сохраняет process strip на вкладке и проекте с настраиваемым цветом, но не подменяет runtime busy, не запускает Run After и не рисует background-work loader над History input. Recovery и ошибка доставки требуют внимания и продолжают блокировать опасные действия, но не являются активной работой и не получают ложный shimmer; их объясняет карточка. Цвет полосы обозначает наследованного владельца, а общий контрастный shimmer — только реально продолжающуюся работу или доказательство результата. Минорный UI-контракт: колокольчик завершения ждёт тот же orchestration completion-gate, поэтому собственный idle родителя при фиолетовом loader не отправляет раннее Telegram/outbox-уведомление; успешное освобождение отправляет его, abnormal-исход только снимает ожидание.

Доставленный Terminal MCP request/completion/failure остаётся пользовательской
записью по роли в разговоре, но History отличает его происхождение спокойным
полупрозрачным фиолетовым bubble вместо обычного оранжевого. Источник цвета —
только app-owned `semanticTags.kind=orchestration` с `runId`; буквальная цитата
`[Оркестрация]` остаётся обычным user-сообщением. До durable audit тот же вид
разрешён точной паре app-owned source/handoff, поэтому карточка не мигает
оранжевым перед подтверждением. Это атрибуция, а не новая граница ответа:
очередь, группировка итераций и response timing не меняются.

Codex response-first пара может подтвердиться по `response_item` раньше, чем
History выберет canonical `event_msg` с другим UUID и timestamp. При promotion
сохраняются не только sourceIdentity aliases, но и прежняя пара
`promptPresentationAuditTimestamp + promptPresentationTransportHash`: через неё
reader находит уже сохранённый presentation sidecar. Alias добавляется ПОСЛЕ
смены primary identity, иначе helper считает его текущим primary и пропускает.
Шрам05.10, Astra completion8b438bdd в367: receipt24241/.763, History24242/.764,
один transport hash; пропущенный alias оставлял оранжевый bubble и raw
`orchestration-result`, хотя Timeline был фиолетовым. Исправляется reducer,
не CSS и не External Research skill. Existing sidecar читается без переписывания
receipt/разговора; renderer снова получает тот же trusted tag и проверяет полный
body hash перед скрытием оболочки. Литеральная цитата не становится оркестрацией.

Не-Research фиолетовый user-message использует те же правила collapse, что обычный:
HistoryCollapsiblePrompt для текста и общий mixed-message toggle для вставок.
Markdown не обходит порог600/preview400; в закрытом состоянии обычное текстовое
preview, при раскрытии полный Markdown с верхним и нижним «Свернуть».
forceExpanded для поиска сохраняет полный ответ без toggles. Это только
видимая проекция: скрытый хвост остаётся доступен Copy/Rewind. Неподтверждённый
body hash по-прежнему показывает исходный transport через обычный collapse.
Для доказанного Research completion/failure действует отдельное компактное JSON/code/
Markdown-представление выше; оно переиспользует прежний reveal-owner, не порог
обычного prompt и не формат сохранённого уведомления.

## Проекция в Timeline

Сообщение оркестрации распознаётся не по редактируемой строке `[Оркестрация]`, а по app-owned semantic tag в `history_prompt_presentations`. Tag сохраняется только после post-Enter audit рядом с точной durable identity пользовательской записи; Claude/Codex JSONL остаётся неизменным. Тот же sidecar переносит tag в доказанный Codex child при Resume/Fork вместе с presentation metadata.

Последовательные Terminal MCP request/completion/failure turns образуют отдельную фиолетовую группу и ромб-маркер. Счётчик группы — отдельная цифра без `×`: при наличии Pencil/Search верхний и нижний углы распределяются заранее, поэтому значки не перекрываются. Свёрнутая группа агрегирует работу с документацией всех своих turns в общем Cmd-hover, раскрытая показывает её у конкретных turns. Клик раскрывает список вниз без изменения ширины рельсы; горизонтальная полоса сворачивает только группу. Ширина панели и раскрытие детей независимы: узкая панель тоже допускает обычную UUID-навигацию History по детям. Ромб всегда строится из квадратной геометрии до поворота — общий child-marker `8×3` превращал его в диагональную черту. Это не группа встроенных Claude subagents: внешняя полноценная вкладка имеет durable `runId`, а встроенный Agent/Task остаётся отдельным типом Timeline. Миграция старых записей допускает exact-prefix только в одноразовом backfill; runtime никогда не классифицирует сообщение по тексту.

В эту визуальную MCP-группу входят также адресная переписка и обычные MCP prompts
по своим metadata tags. Это объединение происхождения на экране, не создание
orchestration-run/parent для вопроса или обычной отправки. Их phase и message ID
сохраняются отдельно; runtime-выполнение из фиолетового цвета не выводится.

Пока занятый ход откладывает чтение полного transcript, Timeline показывает временную точку подтверждённой отправки по её точному UUID. Она должна нести ту же orchestration-метку, что History: метка берётся только из совпавших app-owned `handoffId` и `source`, а не из текста уведомления. Инцидент 25.09, Codex source tab-4196: browser completion `d9bb5fe6-13b3-4ece-9c57-2df3bcb7e35e` уже имел durable tag `completion` и фиолетовую History-карточку, но временная Timeline-точка переносила только prompt-origin, поэтому оставалась обычной user-точкой до refresh. Source теперь переносит orchestration identity в эту временную точку; если Timeline уже прочитал ту же user-запись до сохранения её метки, он временно дополняет только эту запись по точному UUID/source alias, не меняя кэш и не создавая дубль. Подтверждены live receipt/history identity и 38 узких тестов; установленная версия после этой source-правки отдельно не проверялась.

## Связи

- Граница чтения истории: [`fact-session-history.md`](fact-session-history.md).
- Живые terminal-сценарии: [`fact-terminal-mcp.md`](fact-terminal-mcp.md).
- Внешний HTTP/SSE transport: [`fact-mobile-web.md`](fact-mobile-web.md).
- User-flow: [`../methodology/сценарии-использования.md`](../methodology/сценарии-использования.md) — «Фоновая оркестрация AI-вкладки».

## Durable reservation и точная identity запроса

У закрытой legacy-вкладки requested tabId и восстановленный runtime tabId могут
различаться. Архив владеет reserve/commit и выдаёт durable proof точной пары
namespace/history/source/target. Orchestration принимает новый runtime только
после reread этого receipt и неизменного SQLite owner/provider/SID/cwd; исходный
request fingerprint не переписывается. Native v2 сохраняет прежний tabId, но
новый close/restore revision инвалидирует старый proof. До первой попытки Send
тот же frozen context-handoff переносится вместе с его exact update-members;
чужой/entered handoff не переносится, session guard остаётся у physical write.
Crash между archive commit и run adoption принимает уже materialized owner без
ещё одного Restore и будит тот же normal delivery dispatcher для первого Send.
Metadata edit того же owner не является новым close-generation. Неоконченный archive не даёт права
фоновому наблюдателю открывать закрытую вкладку. Cancelled/entered/unknown run
не ретаргетится; late old-runtime exit/prompt proof не относится к новому ID.

Шрам07.10: archive3233 успешно создал новый `restored-*` для Luna, но App bridge
требовал равенства со старым target ID. `closed tab restore failed` пришёл после
создания PTY/commit, но до задания. Отказ не означает отсутствие всех side effects;
нельзя ни снимать identity guard, ни повторять создание для получения лучшего ACK.
Это ремонт адресации `delegate_to_session`, не переоценка исторического failed-run.
Остальные physical-send/Rewind adapters сохраняют строгий текущий tabId: при
replacement используют уже подтверждённый новый адрес, а не renderer hint.

Клиентский `runId` означает повтор **того же** запроса, а не свободное имя.
Перед созданием target-вкладки сервер нормализует все влияющие на исполнение
поля и сохраняет их отпечаток вместе с заранее выбранным tabId. Только после
успешной записи разрешены создание вкладки, запуск процесса и Enter. Exact retry
возвращает существующий run; тот же `runId` с другим source, target, provider,
model, effort или prompt-hash получает конфликт. Поэтому сбой durable-write не
может оставить работающего исполнителя, которого store не знает.

Создание новой target-вкладки также имеет durable-границу: renderer возвращает
её `tabId` серверу только после ACK полного снимка проекта, содержащего эту
вкладку. Иначе сервер может через несколько миллисекунд вызвать materialize
сессии, main не найдёт строку в SQLite и вернёт `codex_tab_row_missing`, хотя
вкладка уже видна в памяти renderer. Последующие point-write и запуск provider
разрешены только после этого ACK; обычная задержка SQLite не должна выглядеть
как ошибка создания или оставлять run без target. Отрицательный ACK тоже не
считается завершением: новая вкладка и её PTY удаляются, вызывающий получает
`tab_persistence_failed`, а запуск provider не начинается. До положительного
ACK вкладка не публикуется в Zustand, не становится active и не попадает в MRU;
поэтому rollback не зависит от `closeTab`, main IPC или повторного DB-write.
Commit создания сериализован по проекту: каждая параллельная попытка строит
candidate Map уже из результата предыдущей, затем сохраняет и публикует её.
Поэтому положительный ACK одной вкладки не может случайно показать соседнюю
попытку, которая ещё не получила или уже не получила свой ACK.
Если во время DB-write другая операция всё же изменила текущую Map вкладок,
commit сравнивает структурный снимок, заново строит candidate из свежего
состояния и повторно сохраняет его перед публикацией. Это не даёт параллельному
close/reorder потеряться за успешным create. Повтор ограничен четырьмя
попытками; непрерывная конкурирующая мутация возвращает явную
`tab_creation_concurrent_mutation`, а не создаёт новое вечное ожидание. Перед
PTY cleanup renderer ставит в общую IO-очередь точечное удаление именно этого
ещё не materialized tabId и ждёт ACK; main отказывается удалить строку, если у
неё уже появилась session identity. Поэтому не опубликованный candidate не
воскресает после crash/restart и не задевает соседние вкладки.
Отдельный номер постановки full snapshot ловит изменения объекта на месте
(`rename`, session-id write), где состав Map не меняется: если после create-write
уже поставлен более новый snapshot, create повторяет сохранение после него.

Destructive close использует обратную последовательность: сначала строит Map
без закрываемой вкладки и отправляет её вместе с точным набором tabId, который
должен сейчас находиться в SQLite. Main отклоняет `forceCleanup`, если DB-набор
отличается. Та же проверка выполняется до остановки runtime, а renderer очищает
buffer и удаляет строку из Zustand только после положительного ACK; при позднем
конфликте откатывается и уже созданная History-запись. Поэтому частично
восстановленное окно не может удалить все durable tabs пустым snapshot.

Доставка результата имеет собственную неизменяемую identity: `runId` плюс хеш
точного completion-сообщения. Transcript-аудит обязан подтвердить оба значения;
совпадение текста или метаданные другого run недостаточны. Сохранённое
`sending` после restart переводится в проверку уже принятого Enter, а не остаётся
вечным loader и не отправляется повторно вслепую.

Сигнал готовности target не лишний, даже если проверка этого run уже идёт. Если
текущая попытка всё ещё отложила доставку, после неё один раз проигрывается
последнее точное readiness-событие; успешная отправка повтор запрещает. Поздний ответ
renderer только будит этот же run и принимается лишь при совместимых provider, session и
поколениях процесса; перед Enter main ещё раз читает точную готовность. Это event-driven
single-flight, а не polling и не таймер. До доказанного Enter обычная очередь остаётся
completion-блокером Run After/Build Install с серым индикатором; жёлтый нужен для
неопределённости/внимания. Ложного фиолетового inherited shimmer до delivery-proof нет.
