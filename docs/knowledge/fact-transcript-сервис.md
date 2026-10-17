# Fact: Transcript Service

`SessionTranscriptService` — main-process слой инвалидации и snapshot-чтения для AI-транскриптов. Он появился не как ещё один parser, а как архитектурная граница: desktop Timeline, Cmd+] HistoryPanel, Project Terminal API и native iOS должны смотреть на один durable источник (`~/.claude/...jsonl` или `~/.codex/...rollout-*.jsonl`), а не держать собственные polling-loop'и с разной частотой и разными cache-предположениями.

Пользовательский симптом старой модели на больших сессиях: Timeline кликался быстро, но на историях в несколько сотен итераций переход в History иногда «ничего не делал», а после успешного перехода немедленный ручной scroll мог дёргаться. Отдельный desktop polling (Timeline ~2с, History ~3с) и mobile/API чтение создавали несколько независимых readers одного файла; на Codex rollout это особенно больно, потому что один `replacement_history` или длинный tool-output превращает полный read/parse в заметную паузу main process.

## Контракт

- Ключ подписки — `toolType + sessionId + cwd`, consumer — явный `consumerId` (`timeline:<tabId>`, `history:<tabId>`, web subscriber). Один файл получает один watcher и ref-count по consumers; последний unsubscribe закрывает watcher. Публикация state в общей Map происходит только после async resolve файла, поэтому сам init тоже дедуплицируется отдельным inflight promise: иначе одновременно смонтированные History и Timeline оба успевают увидеть miss и открыть по watcher до первой записи в Map.
- Сервис шлёт lightweight invalidation, а не готовый UI-state: renderer получает `agent-transcript:changed`, web/iOS получает SSE/WS событие `transcript-changed`. После этого surface сам запрашивает нужный snapshot (`get-timeline`, `get-history`, `get-messages`) и сохраняет свою локальную логику merge/optimistic rows.
- Для Codex live-chat `type:'message'` не входит в контракт Transcript Service. Его единственный владелец — CodexTurn watcher в `main.js`, который из одного разбора нормализует `event_msg.user_message` и `response_item` для SSE и небольшого ephemeral-хвоста desktop History; Transcript Service для Codex только держит durable cache/watch и шлёт `transcript-changed`. Если оба слоя параллельно производят live-сообщения, native iOS и desktop получают дубли с разными identity.
- Permanent UI polling запрещён как источник freshness для Claude/Codex Timeline/History. Допустимы manual refresh и visibility-resume reconciliation: они проверяют, не пропустили ли событие, но не являются главным clock'ом системы.
- Gemini намеренно не поддержан этим сервисом: у него нет того же durable JSONL/rollout файла и он остаётся на своём legacy parser path.

## Display projection для внешних клиентов

Project Terminal API добавляет к live `type:'message'` совместимый `projection` envelope: `version`, `entryId`, `kind`, `role`, `source`, `transcript`, `ephemeral`. Старое поле `message` остаётся для совместимости, но новые клиенты не должны заново угадывать видимость из raw JSONL/Codex shape. Если `projection.transcript === false`, событие не попадает в reducer истории и не делает `conversationMaterialized=true`; если есть `entryId`, клиент использует его для upsert/adopt вместо локального timestamp-id.

Классификация по пользовательскому смыслу:
- обычный user prompt → History + Timeline + может materialize conversation;
- `attachment.queued_command` с обычным prompt → queued/sent user-row в History, Timeline и materialization после durable proof;
- `<command-name>` slash command → history-only управляющая строка. Startup defaults `/model`/`/effort` видны в History как фиолетовые служебные строки, но не становятся Timeline turn'ами и не materialize conversation;
- `thinking`/Codex `reasoning` без обычного assistant-message → ephemeral turn-state, не durable history row;
- Codex `task_complete.error` → durable `usage-limit`/`provider-error` service row в History, messages и live stream с одной source identity, без Timeline user-turn. `providerError.message/info/turnId` сохраняют исходную ошибку; короткий `content` не подменяет доказательство. Это не assistant answer и не responseTiming. Transient error без terminal completion и цитата в prompt не создают строку;
- Claude typed system `local_command` с явным stdout/stderr отказом и system `api_error` → History service error. Full History и desktop append fan-out применяют общий classifier; retry `api_error` не означает конец turn. Цитата в обычном user/assistant и ошибка tool-result не меняют роль. См. `fact-история-как-основная-поверхность.md::Контракт поверхностей`.
- `tool_result`, Codex `function_call_output`/`custom_tool_call_output`, успешный/обычный `<local-command-stdout>`, `<system-reminder>`, caveat/stdout wrappers → service-noise, не History и не Timeline. Исключение для типизированного Claude отказа выше не является общим поиском слова error.

Шрам 2026-07: live Codex projection уже считал `reasoning` и tool output transient, но REST `getMessages` возвращал их как обычные сообщения. После reload/iOS snapshot History видел строки, которых live-путь не показывал. Правило: REST snapshot обязан применять ту же display-классификацию, что live SSE; reasoning/tool-output можно логировать как процесс выполнения, но нельзя превращать в пользовательскую историю.

Команда и аргумент рендерятся раздельно (`/model haiku`, `/effort low`), а не склеиваются в camel-case (`/modelHaiku`). Источник ввода тоже не часть display-семантики: если manual slash и auto/default slash дают одну и ту же durable-запись, History показывает их одинаково. Route (`manual`, startup defaults, iOS, History) можно логировать как source для диагностики, но нельзя делать по нему другой UI.

Старый шрам: во время streaming пользователь отправил `Stop`, а iOS показал это слово как часть assistant-ответа, потому что live SSE классифицировал raw `tool_result`/queued payload не по пользовательскому смыслу. Обратный шрам: `/model haiku` и `/effort low` на fresh Claude появлялись как фиолетовые строки и исчезали после reload, потому что live-путь и `/history` фильтровали по-разному. Любое новое display-событие должно пройти один server-side projection path, иначе iOS, Inbox и History снова начнут расходиться.

## Границы миграции

Claude full History пока остаётся на совместимом `claude:get-full-history` path, потому что там есть отдельная recovery-логика parentUuid/backtrace/chain-break. Нельзя заменить его на простой `parseTimelineEntries` ради унификации: сначала нужно доказать парность recovery с HistoryPanel. Сервис уже может invalidation/watch для Claude и timeline snapshot, но robust Claude full-history — отдельная миграция.

Codex, наоборот, должен идти через сервис для Timeline/History/message snapshots: rollout shape один и тот же для desktop, Project API и iOS, а `agent-transcript:get-timeline/get-history/get-messages` защищают от расхождения между поверхностями. Legacy `codex:get-timeline` / `codex:get-full-history` могут оставаться compatibility entrypoints, но новый код не должен добавлять третий независимый polling reader.

## Внешние read-consumers: ревизия и одна SSE-подписка

Fresh Codex16.09 может получить normal settled empty History до writer: main
проверяет отдельный exact standalone metadata-only source/lease, не сервис
угадывает пустоту из409. Read SID появляется на causal ready event; shared reader
возвращает обычный200/entries[]/revision, writerConfirmedfalse. Source growth/
submit отзывает empty admission; late zero response после stronger same-SID
read owner не публикуется. Не заменять этим unknown bounded-head/thin fork.

HTTP `history?view=history` теперь пропускает opt-in conditional/delta через
этот же reader, не через новый JSONL parser. Публичный opaque historyRevision
связывает внутренний revision с tab/read owner и конкретным окном; неизвестный
или вытесненный token означает обычное полное чтение окна, не пустую историю.
`unchanged` сохраняет клиентские строки, Codex delta передаёт exact changedEntries
и order; Claude пока отдаёт full changed window. Chips и responseTiming sidecars
уже входят во внутреннюю revision и потому не пропускаются при неизменном JSONL.
Для opt-in delta HTTP задаёт отдельный `deltaConsumerId` конкретного read-окна;
desktop сохраняет прежний ключ. Иначе широкий snapshot той же tab/revision мог
подтвердить UUID, которого узкий клиент ещё не получал. Tab ID для sidecars при
этом не меняется, общий bounded digest store и parser остаются единственными.

SSE `tabIds` объединяет явно названные tab topics на одном соединении. Один
service consumer на tab переживает одновременных клиентов и меняет read SID по
runtime event, но освобождается после последнего unsubscribe. Late async subscribe
не оставляет orphan и не снимает нового consumer. Собственный park/grace сервиса
сохранён. Wire/capabilities и client resync — `fact-mobile-web.md::Read-only timing`.

## Resolved-path memo (правый клик и переключение вкладок)

Discovery файла сессии (`findCodexSessionFile` — полный walk `~/.codex/sessions` с чтением metadata-head; сотни rollout, десятки >100MB) стоит ~400мс main-loop. Прод-шрам 2026-07-25: каждый ВОЗВРАТ на вкладку платил этот walk заново — уход с вкладки снимает последнего consumer, `_closeState` закрывает state, resolved path терялся; правый клик по вкладке, попавший в это окно, открывал контекстное меню через 200-380мс (замерено бимодально: 75мс вне окна / 200-380мс внутри). Фикс — memo на двух уровнях: `resolvedPathCache` в самом сервисе (`toolType:sessionId → filePath`, переживает teardown state) и `codexSessionFilePathMemo` внутри `findCodexSessionFile` (закрывает остальные call-sites: timeline, hover, history, overseer). Обоснование безопасности: rollout/JSONL никогда не переезжает после создания; existence перепроверяется `fs.access` перед reuse, исчезнувший файл падает на обычный walk. После фикса повторные переключения дают 57-85мс на открытие меню.

Атрибуция «медленного subscribe»: `[Perf:IpcSlow] channel=agent-transcript:subscribe` меряет invoke→ответ, то есть включает очередь за чужим main-блокером. Проба `[TranscriptService:SubscribeSlow] ensureMs=…` печатается только когда СОБСТВЕННАЯ работа handler'а превысила 50мс: IpcSlow без этой строки рядом = виноват сосед (искать по `MainLoopGap.ops`), с ней = реальный медленный `_ensureState`.

## Ранняя свежесть native History, отдельно от runtime

04.10 пользователь потребовал не ждать тяжёлой History, чтобы понять, устарел ли
видимый iPhone-кэш: в реальном возврате busy уже закончился, а новые rows пришли
позже. `busy=false`, runtimeRevision и SSE sequence не подтверждают доставку
истории или успешный outcome. Новый opt-in `freshness=v1` связывает ответ
прежнего reader с фактически прочитанными physical witnesses и metadata;
лёгкий `/api/history-freshness` сравнивает их без parse/lineage/worker admission.
Сохранённый read SID допустим для остановленной вкладки, но не становится writer.
После workflow cutover это включает standalone tabs без legacy Project row. Metadata
descriptor lookup использует собственный cwd вкладки и необязательный project fallback;
обязательный JOIN Projects давал `read-owner-unavailable` при уже известной прямой History.
Не чинить такой разрыв созданием фиктивного Project или допуском unknown как fresh.

Это bounded набор сертификатов зависимостей **от реального reader**, не второй
кэш содержимого. До первого подтверждённого чтения, после eviction/restart или
изменения topology ответ unknown: каталог не должен тайком готовить все сессии.
Проверка делает async stat и прежнюю validation по dev:ino/size/mtime/ctime;
SQLite witnesses транзакционно учитывают chips, timing/alias/joined duration и
lineage, включая записи другого connection. Счётчик watcher не доказывает
отсутствие пропущенного append. Epoch меняется при restart; поколение worker
тоже участвует, чтобы старый page/payload owner не оживал после его смерти.

Full/unchanged/delta несут `historyFreshness` с exact window coverage. Клиент
сохраняет её только после публикации соответствующих rows; более поздний dirty
event не очищается старым HTTP reply. Неизменившееся certified окно отвечает до
тяжёлой подготовки. Для virtual Fork/Rewind берутся физические, не обрезанные
логические snapshots: parent append может вызвать лишнюю проверку, но не расширяет
замороженную историю. Неизвестные новые зависимости могут потребовать одного
дополнительного выбранного чтения. Pending/unknown не превращаются в fresh по
deadline. Wire и правила сравнения — `fact-mobile-web.md::Ранняя свежесть кэша`.

Read ticket проверяет exact-tab event и после последнего awaited context, перед
remember/known. Иначе событие в этом промежутке выдавало старым rows новый known
sequence. Новое событие оставляет окно unverified/unknown даже при совпавшем stat;
событие другой вкладки не отзывает его proof. Runtime idle это правило не заменяет.

В Claude устранён prerequisite-дефект: equal size раньше позволял прикрепить
новые stat к старому recordMap после replacement/rewrite. Теперь совпадает
физический witness; timestamp-only touch сохраняет прежний graph лишь после
точной потоковой hash-проверки. Обычный unchanged остаётся stat-only, append —
suffix-only. Необъявленная in-place rewrite+growth всё ещё требует штатной writer
invalidation, как Codex; эти metadata не обещают hash всего prefix на каждом GET.

## Тёплая пауза наблюдения (park/unpark)

Уход последнего consumer'а раньше немедленно уничтожал state — и возврат на вкладку заново читал тот же файл целиком, хотя фоновая подписка секунду назад держала данные актуальными (прод: девять переключений за 11с → LongTask 1088мс на полных перечитках при готовом кэше). Теперь state переходит в «тёплую паузу» на 90с: файл не перечитывается, но и НЕ публикуется наружу — иначе фоновая сессия кормила бы событиями подсистемы, для которых её никто не показывает. Возврат внутри окна забирает то же состояние и один раз догоняет пропущенный хвост. Спящих сессий максимум восемь, самая старая вытесняется. Логи: `[TranscriptService:Park] reason=no-consumers graceMs=90000` / `[TranscriptService:Unpark] idleMs=`.

Дешёвая проверка ревизии на возврате — отдельный слой и он работал ещё до park (за сутки 142 обновления с токеном ревизии, 73 ответа «не менялось»); park лечит именно случай реально изменившегося файла, где ревизия не спасает. Stats-only пути «не изменилось» для Claude (probe истории, unchanged timeline) — см. `fact-история-производительность.md::Main-процесс`.

## Codex incremental cache

Codex rollout читается инкрементально: unchanged требует совпадения `dev:ino + size + mtimeMs + ctimeMs` прочитанного источника. Рост того же физического файла читает только новые байты, незавершённая строка переносится через `leftover`, replacement/shrink/same-size rewrite делает полный reread, concurrent callers одного файла получают один inflight promise. Это нужно не ради микрооптимизации, а чтобы один и тот же большой rollout не парсился заново для Timeline, History, iOS и tooltip/hover запросов. Рост размера сам по себе не доказывает сохранность prefix при посторонней in-place перезаписи; штатные edit/delete/fork по-прежнему явно инвалидируют оба кэша.

Поверх raw-record cache существует отдельный stateful projector, который один
file cursor одновременно кормит History и Timeline. Его eviction имеет один
source of truth — настроенный byte-budget; прежний скрытый count-cap на 12
сессий удалён. Он вытеснял тринадцатую сессию даже при `308/2048MB`, поэтому
History могла оставаться тёплой в renderer, а Timeline после первого paint
получала `mode=rebuild` и заново кормила тысячи records. В eviction-логе
`usedMB` уже описывает состояние ПОСЛЕ удаления и не доказывает memory-pressure.
Каждая сессия учитывается минимум как 1MiB, а после append стоимость обеих
проекций пересчитывается; увеличение budget не заменяет эту единую политику.

### Подготовленная история на SSD и отдельный владелец чтения

С11.10 SOURCE положительный proof уже материализованного app compact-fork
удерживается отдельно от six-file raw LRU: максимум64 digest-пары без тел истории.
Иначе eviction raw мог повторно прочитать весь rollout перед корректным SSD
Timeline hit. Ключ связывает child SID/cwd, физический snapshot/epoch, весь
fork-event и свежую bounded metadata. SSD hit или один header не создаёт proof:
на miss остаётся прежняя canonical проверка records/Timeline. После restart
малый proof cache пуст; размеры дискового и parser-кэша не меняются.

Последняя source-проверка и свежий lineage определяют право вернуть результат,
а не только право запомнить certificate. Отказ fence либо замена/мутация fork-event
во время await дают прежний `CODEX_SOURCE_READ_INVALIDATED`: caller повторяет
чтение текущих входов в своём bounded retry. Нельзя продолжать с захваченным старым
event или вернуть success, лишь отказавшись от cache admission. Unknown fast-path
guard сохраняет canonical fallback, ошибки не превращаются в negative cache.

25.09 SOURCE: desktop Codex больше не связывает просмотр старого участка с
наличием полного parser graph в RAM. Read-сервис исполняется в Node worker:
History/Timeline/payload, совместимые messages, поиск, копирование и экспорт.
PTY, writer/operation proof, подписки, live delivery и мутации остаются main-owned.
SQLite sidecars читаются прежними методами через отдельное соединение без
startup migrations; точные binding/asset/lineage уведомления возвращаются main.

После saved COW Rewind подготовка должна попасть именно в этот configured worker,
а не только в Main cache: иначе тот же большой retained prefix строился дважды.
Main передаёт private committed coordinate/byte witness, не raw JSONL/полный graph;
worker переиспользует свой exact pre-cut checkpoint и дочитывает остаток теми же
двумя reducers. Physical source+child/epoch guards остаются, miss/eviction дают
один обычный canonical rebuild с причиной. Record count не равен physical line
при пустых строках. Полный потоковый hash записанного ребёнка сохраняет проверку
append после restart, включая streamed image bytes; hash только дочитанного
tail её не заменяет. Header/proof hints не выходят в public History receipt и не
дают writer/inputReady authority. Non-worker reader остаётся поддержан.

На SSD раздельны готовые тела строк с лёгким позиционным индексом, Timeline,
canonical base rows до sidecars, полные раскрываемые payload и continuation
обоих парсеров. Это относится и к physical, и к direct-virtual Fork/Rewind.
Просмотр читает
нужные тела + tail/live-work; возвращаемый список UUID остаётся полным. Он не
восстанавливает parser. После RAM eviction новое событие может восстановить
continuation и дочитать suffix; это отдельная работа, не цена каждого seek.
Continuation включает aliases/связи объектов, pending calls и неполный UTF-8 хвост.
Большие завершённые payload выносятся до оценки/сохранения графа и коммитятся
с continuation атомарно. Семантический hash строки не равен V8 byte checksum:
одинаковый объект после deserialize может иметь другую бинарную кодировку.

Metadata-only обновление после eviction повторяет decoration/binding по base
rows, не восстанавливая parser. Provider-wide prompt revision не сужается:
изменение пометки ancestor должно дойти до child. Runtime ownership Task-карточек
накладывается заново по exact session/call/byte offset; сохранённое поколение
процесса не является действующим правом после restart. При физическом копировании
ветки пересчитывается и этот byte offset. Composite contentRevision живёт в
header и накладывается при выдаче; его смена не переписывает тела всех ancestor rows.

Успех/quiet refusal awaited prepared write — не решение о свежести прочитанных
rows. После base/view save и rewrite baseline, включая mismatch fallthrough,
сервис повторно проверяет logical source generation и использует прежние bounded3
attempts. При invalidation SQLite owner может вернуть null без throw; без внешнего
source fence direct service принимал g1 после g2. Полный worker/client уже имел
source-epoch throwing fence и защищал проверенные cold/base/view случаи до этого
ремонта. Append намеренно сохраняет logical generation; его физические/epoch
witnesses и прежние независимые cache tiers не заменяются этим guard.

Virtual continuation сохраняет обе проекции, frozen witnesses и child cursor.
Замена parent/child, ctime-only rewrite и explicit invalidation проверяются
read tickets всех файлов; frozen range обязан сохранить исходный digest.
При restart+growth проверяется старый child prefix перед восстановлением cursor.
Допись ancestor за замороженной границей не меняет логическую revision child.

С06.10 SOURCE удержание кэша ускорения имеет default20GiB на все sessions/версии,
включая SQLite journals. С10.10 SSD-поле Settings меняет общий лимит после restart;
boot передаёт одно значение worker и capacity service. Default/нормализация
общие через `history-cache-settings.cjs`/`history-cache-policy.js`.
original JSONL не удаляется. Source/V8 schema, owner/cwd, inode/size/mtime/ctime,
checksums и версии sidecars запрещают устаревший hit. Corruption/quota/недоступный
cache → обычный canonical read в worker. После restart при выросшем источнике
проверяются прежние chunk hashes без JSON parse; это может читать prefix и не
обещает suffix-only I/O при неизвестной сохранности старых байтов.
Это post-operation retention quota, не peak reservation: SQLite journal и
временные codec buffers могут занимать больше во время записи. Save, удалённый
quota-prune, не подтверждает сохранение. Кэш можно потерять без потери истории.
Legacy payload caller без ожидаемого поколения всё равно проверяет текущий
источник до RAM/SSD-hit; отсутствие этого аргумента не разрешает старый текст.

Готовые rows, тяжёлые continuation/payload и компактные Timeline/source-proof
хранятся тремя независимыми SQLite families одного owner. Prune сначала удаляет
устаревшие схемы; среди тяжёлых файлов учитывает давность owner и защищает
записываемый owner, у него checkpoint вытесняется перед rows. Compact Timeline
и source certificate идут последними. Глобальное «все checkpoints первыми»
оставляло бы старые страницы ценой постоянного rebuild рабочей сессии при append.
Все tiers вместе ограничены общим quota (default20GiB); oversized/zero quota сохраняют canonical fallback.
Invalidation источника отзывает все tiers owner, включая незавершённый async
page-write. Corruption одной family не уничтожает независимую корректную family.
Диагностика отдаёт cacheTier и отдельные obsolete/state/rows/timeline eviction counts.

После удаления checkpoint неизменные History/Timeline могут прочитать готовые
страницы без raw JSONL; новая допись при уже удалённом checkpoint законно
потребует rebuild. При сохранённом checkpoint прежний suffix-only путь остаётся.
Увеличение disk budget не увеличивает RAM budget и не резервирует весь лимит сразу.
Предупреждение о будущей нехватке — отдельный metadata-only сервис; оно не
вызывает History, не запускает worker и не удаляет файлы. Формула/границы —
[`fact-resource-usage-panel.md::Предупреждение о месте на диске`](fact-resource-usage-panel.md).

Настроенный RAM-budget делится между read graphs, индексом (до32MiB) и прежним
ускорителем mutation proof в main (до64MiB), а не выдаётся каждому второй раз.
Внутри worker allocation virtual graphs получают до128MiB/четверти allocation;
physical graphs — остаток, без прежних дополнительных400MiB сверх бюджета.
Это оценки удержания, не полный RSS: buffers, payload stash и renderer отдельны;
прежнее исключение одного oversized active graph сохраняется. Только холодный
разбор/restore входит в общую очередь и удерживает admission до конца подготовки/
commit RPC, чтобы порционная запись не накопила много холодных transient graphs;
warm append и готовая страница её обходят.
Доказанная собственная допись отменяет старый inflight read, но не выбрасывает
полный тёплый prefix. Rewrite по-прежнему инвалидирует состояние.

Подготовка большого набора rows уступает worker между короткими порциями;
одна транзакция удерживает прежнюю committed версию до конца. Это транзакция
дискового acceleration-файла, НЕ долгий lock application sidecars. Другой owner
читает свою страницу между порциями; prune не удаляет активный файл. Отзыв source
или SQLITE_FULL откатывает запись и удаляет только disposable cache, не JSONL.
Codec одного continuation остаётся синхронным: bypass cold queue сам по себе
не обещает frame-sized latency во всех фазах. Отдельный различающий замер —
`scripts/history-worker-warm-latency.cjs`, запрос warm A в фазах cold B.

Main меняет shared source epoch до асинхронного сообщения worker: queued
invalidation не должна ждать окончания synchronous parse/SQLite. Запросы одного
owner последовательны, результат отозванного чтения ограниченно повторяется.
Внутренний readProof несёт зависимости всех методов, включая search, payload,
copy/export и physical-row resolution, независимо от формы публичного DTO.
Проверяется и окно между завершением worker и публикацией main, для object и binary.
Поколение файла восстанавливается и когда первым после restart пришёл full-client.
Desktop IPC отдельно согласует бинарный ответ: main пересылает bytes, renderer
декодирует прежний DTO. HTTP/MCP и старый main остаются на object-протоколе;
формат revision/delta/rewrite receipt не меняется.

С30.09 диагностика имеет отдельные `hr-…`/UI context IDs и request/attempt/worker
generation. Они удаляются перед service, не становятся source identity или
read proof. `[HistoryRead]` отделяет очередь своей сессии, cold admission,
cache/read/preparation, serialization и main delivery; renderer отдельно пишет
decode. Причина SSD miss и RAM eviction различается, поздний отказ не теряется
за успешными фазами. Точный словарь/пределы — `логирование-оптимизации.md`.
Source fingerprint кэша сохранён: изменение реализации, включая этот этап,
создаёт новую версию disposable cache; первый read после установки может быть
cold. Это не потеря исходной истории и не разрешение ослаблять проверку версии.

Проверки: `history-read-worker.test.js`, `historyReadTransport.test.mjs`,
`scripts/history-disk-cache-cost-regression.cjs`, `history-disk-cache-e2e.mjs`
и `history-worker-asar-regression.mjs`. ASAR smoke идёт через настоящий IPC:
ранний запуск из inspector evaluate дал SIGSEGV в тестовой среде, а обычный
IPC-путь прошёл; это не доказательство дефекта ASAR. Source/isolated PASS
не означает установленную версию или устранение всех renderer/native лагов.

**Вытеснение parser ≠ новое содержимое файла.** Отдельный малый ledger хранит
поколение источника и последние physical stat-признаки после потери тяжёлого
graph. Его metadata учитывается в прежнем projector budget; неприкреплённые
witnesses вытесняются по собственному byte-порогу. Append и повторная сборка
того же источника сохраняют поколение, rewrite меняет его. Это поколение связывает
delta digest и расширенные payload caches: одинаковые UUID и inode после
in-place rewrite не разрешают вернуть старые середины длинных строк. Потеря
parser cache сама по себе не должна сбросить измерения тёплого renderer.

**Физический файл ≠ поколение содержимого.** `agent-transcript:changed.fileIdentity`
— dev:ino, а `getHistory.payloadGeneration` — opaque generation, способная
измениться при same-inode rewrite. Renderer хранит их раздельно: physical witness
берётся из primary/current-session `revision.sources`, не из ancestor и не
разбором строки generation. Watcher сравнивается только с physical witness;
ответы/payload caches — с generation. Смешение давало ложный rewrite на КАЖДОЙ
дописи, owner reset, пустую History и второй reset при ответе IPC. При настоящем
physical replacement старое поколение очищается до новой загрузки, а поздний
ответ старого файла не банкится поверх нового. Busy append не сбрасывает owner.

Invalidation также отменяет уже выполняющиеся чтения. Простого удаления Map
недостаточно: старый read иначе успевал повторно опубликовать старый prefix
после Rewind. Read fence проверяется перед publish и после асинхронной metadata
подготовки; изменённый источник ограниченно перечитывается, а ошибочный append
не оставляет half-fed owner. Cursor reads связывают bytes с одним открытым fd,
проверяют fstat/path и фактический размер прочитанного диапазона. Копия raw
records несёт собственный cursor witness через WeakMap даже после raw-LRU
eviction; более новый stat файла не может подтвердить старую копию массива.

Холодный/rewrite-путь тоже chunked, а не `readFile(..., 'utf8')`: live rollout 582+ MB воспроизводимо падал с `RangeError: Invalid string length` ещё до группировки. Chunked reader сохраняет physical line numbering, incomplete UTF-8/JSONL tail и коммитит append-записи в cache только после успешного EOF. Async I/O сам по себе не защищает от string-limit и allocation spike.

Полный records-cache ограничен LRU в шесть файлов и 768 MiB raw bytes. Лимит три файла вытеснял активный 73-MB rollout между его собственными History/Timeline/usage-запросами, превращая каждый append в новый полный parse. Один oversized active rollout может превысить byte-budget и остаться в cache: выкидывать его значило бы повторять сотни мегабайт при каждом клике. Discovery не использует этот cache: он читает bounded metadata-head до первой non-metadata записи. Эти два пути нельзя снова сводить в один parser.

Размер файла на диске отдельно ограничен 1.5 GiB, но главный memory-repair происходит раньше JSON.parse. В top-level `compacted` inline `data:image/...` заменяется на `[image omitted]` прямо в сырой строке: эти картинки и так никогда не показывались, а рекурсивные compact-снимки копировали один screenshot много раз. На реальном rollout 1340 MB это снизило дополнительную память разбора примерно с 1725 до 532 MB при том же числе записей. Обычные user-image не режутся. Parsed/UI-слой и persistence-слой намеренно различаются: Fork/Edit/Delete потоково восстанавливают raw data URL по file byte ranges + SHA-256 и fail-closed при изменившемся source; запись literal `[image omitted]` в child делает его не-resumable. Точный write-контракт — `fact-codex.md::Timeline и History`.

Логи для диагностики: `[CodexJsonlCache] full/append`, `[TranscriptService:Subscribe]`, `[TranscriptService:WatchStart/WatchStop]`, `[TranscriptService:Changed]`, `[TranscriptService:CodexDelta]`. Если iOS видит loader, но не видит новые строки, разделяй два слоя: `transcript-changed` доказывает invalidation snapshot'а, а `[WebBcast:SEND] type=message` от CodexTurn watcher доказывает live fan-out конкретных rows. Для Codex `TranscriptService:CodexDelta sent=0` вместе с `suppressedLiveMessages`/`skippedLiveUsers` — ожидаемое состояние, не ошибка: сервис увидел append и инвалидировал snapshots, но не стал вторым live-stream.

Смежный source-ремонт14.09: exact Codex orchestration result использует
отдельный компактный индекс адресов/структурных записей с тем же provider
matcher и координатным reducer. Raw-LRU eviction его не сбрасывает. Новый
consumer-mode range-reader сохраняет UTF-8 partial-tail и физические строки,
но не копит полный records-массив; исключение consumer отменяет весь staged
проход, а не маскируется под malformed JSON. Physical/virtual source разрешается
до и после I/O через сервис. Наблюдение снимает свежие адреса/stat без SHA;
перед окончательным решением отдельно проверяет frozen/child-prefix digest и
физическую версию, включая замену после адресного чтения текста. Рост ancestor
за пределами frozen range не заставляет pending child хэшировать его заново.
Источник явно различает наблюдение и проверенный digest, а счётчик включает
реальные hash-байты, в том числе при отказе; GUI History
не становится владельцем результата. Непривязанные после Retry/restart run
восстанавливают реальный turn через этот же индекс; историческая generation
остаётся неизвестной. ID-less совместимость также читает только выбранное
семантическое окно, сохраняя прежний collector. Границы проверки —
`fact-оркестрация-вкладок.md::Цена проверки результата`.

## Поиск History: полный источник и ограниченная выдача

`searchHistory` у Codex выполняется тем же History worker над полной canonical
проекцией, включая virtual fork. Renderer не сканирует только загруженный кусок:
у далёких строк бывают пустые identity stubs, которые дали бы ложное «не найдено».
После вытеснения графа поиск читает подготовленную SSD-проекцию, не разбирает
rollout заново. Claude использует полную локальную History-проекцию; matcher
общий, буквальный, с фильтрами user/assistant/user-images и пустым запросом при
выбранном типе. `imageCount` — небольшая metadata реальных image blocks, а не
передача base64 в renderer; row stubs сохраняют этот признак.

API принимает `offset/limit` и возвращает ограниченные snippets/offsets, но
считает полный `total` совпадений, `entryTotal` сообщений и exact ключи всех
затронутых итераций для Timeline. Assistant match относится к предшествующему
user-turn. UI отправляет запрос после короткого debounce, отвергает устаревший
ответ и показывает ошибку чтения отдельно от нуля совпадений. Новые поля
не меняют source/writer authority, сохранённый transcript или submit proof.

## Смена физической сессии после JSONL-Rewind

Удаление первой/единственной user-итерации может законно оставить materialized
child без Timeline-точек. Нельзя принимать любую пустую проекцию со словом Fork
за потерянный native prefix. Разрешение пустого результата требует exact app-owned
history_edit/delete/rewind event, `snapshotComplete=true`, пустые entryUuids и
boundary, совпадающие child/source metadata и standalone `history_mode=legacy`
без paging base/ordinal. Metadata приходит из той же прочитанной проекции, не из
старого кэша. Unknown/native event, недостающий/непустой snapshot, чужие identity
или повреждённый manifest по-прежнему дают lineage_unresolved. History может
сохранять служебные строки model/effort при нуле пользовательских итераций.

Resume такого child не обязан сразу подтвердить writer: read-capability отдельна.
Когда discovery сохранил exact generation-bound provisional source observation,
он сразу публикует новую общую runtime-проекцию/SSE snapshot. Иначе cached HTTP
reader оставался без read SID до побочного запроса `/status`, хотя proof уже был
в main. Публикация не меняет readiness, не создаёт writer proof и не обходит
submit-resolution/generation guards. Регрессия: codex-rewrite-empty-read.test.js
и single-turn actual saved-history scenario.

Copy-on-write Edit/Delete/Rewind меняет физический rollout, но не делает
неизменившийся префикс другим разговором. Старый путь принимал новую session
identity за обязательный cache miss: готовая History исчезала, main повторно
разбирал сотни MiB, затем Continue отдельно заказывал тот же raw-read.
Обычный same-session delta здесь недостаточен: UUID/byte offsets меняются,
а сохранённые `entryMappings` Fork описывают точки Timeline, не все строки History.

После atomic lineage commit writer передаёт обеим проекциям точный подготовленный
файл и соответствие сохранённых физических записей. Разбор продолжается с
ближайшего подтверждённого checkpoint перед изменением; переносится состояние
обоих парсеров, а не только `entries.slice(...)`. Незавершённые инструменты,
Task-карточки, pairing пользовательских carriers и compact companions могут
связывать префикс с будущими записями. Наивная копия массива потеряла бы эти связи.
Checkpoint хранит preview/ref вместо тяжёлых выводов и учитывается в том же
byte-budget. Разбор и копирование состояния уступают main event loop между порциями.

Перенос в renderer подготавливается до binding CAS, публикуется только после
успешного CAS. Receipt сверяется с точной предыдущей ревизией и реально
подготовленной новой. Для тёплого baseline сервер сравнивает все поля строки после
перевода identity и проверяет, что producer каждого тяжёлого payload входит
в сохранённый префикс: одинаковые короткие preview не доказывают равенство
полного вывода. Обычная delta также учитывает эти producer-координаты и изменения
в середине Task results/структурированных меток. Через IPC идут новые адреса префикса
и только изменённые тела строк. React-ключ сохранённой строки отделён от её
нового физического UUID: команды/Timeline адресуют новую ветку, прежний DOM
может остаться. Generation/owner guards не отменяются. Hidden owner при показе
по-прежнему проходит post-paint proof; перенос кэша не является разрешением
скрыть loader над ещё не доказанным изображением.
Сохранённый список может не вызвать `rangeChanged` вообще, поэтому после
смены owner нужен отдельный запуск общего paint-probe. Это снимает loader
после настоящей отрисовки при изменившихся метаданных, без ожидания scroll/show.
Уже раскрытые payload переносятся в renderer-cache только для доказанно
неизменных строк, чтобы полное содержимое не схлопывалось временно до preview.

Нет точного baseline/checkpoint — обычный полный путь остаётся корректным.
В частности, stat одного дочернего файла не доказывает многосоставной virtual
transcript: используется его composite reader, не случайный физический cache.
После reload памяти для переноса нет; холодная сборка должна дать ту же ветку.
Сама copy-on-write запись по-прежнему пишет целый новый файл. Убраны повторный
разбор и повторная передача префикса, а не стоимость безопасного сохранения.

Raw cache для Continue получает собственный точный writer cursor в прежнем LRU.
Ссылки compact-image пересчитываются на байты нового файла. Содержимое payload
stash предка не копируется по одному `callId`: более поздний результат мог его
перезаписать. Нужный полный вывод при cache miss восстанавливается из нового
rollout. Read-only `__physicalSessionId/__segment*` не сериализуются в materialized
файл: иначе адрес записи говорил бы «предок», хотя байты принадлежат ребёнку.

Отдельный explicit `inPlace` repair сохраняет имя файла, но атомарно заменяет
сам файл. На macOS старый `fs.watch` после этого не наблюдает новые append.
Сервис отличает замену по file identity, переподключает watcher, сбрасывает
старый byte cursor и digest/projection/payload cache; замену нельзя выдавать за live append.
При повторном использовании номера строки следующий compact мог получить полный
текст удалённого compact из stash. Renderer поэтому различает поколения файла
и payload producer, отвергает старые ответы и выполняет обычный owner-generation
reset для inPlace даже при том же sessionId. Main отклоняет payload-запрос к
уже заменённому поколению. Новый COW owner и обычный append этого reset не вызывают.
Это не перевод default UI-Rewind в inPlace.

Диагностика: `CodexRewriteProjection reused/fed/readKB`, `TranscriptService:RewriteDelta
carried/changed`, `HistoryRewrite reusedRows`, `TranscriptService:WatchRebind`.
Повторяемая проверка — `codex-data.rewrite-projection.test.js` и
`historyRewriteSnapshot.test.js`; экранные доказательства и остаток — в рабочей
карте `docs/tmp/оптимизация-history.md`.

## Ресурсная модель большой сессии

Resume не обязан создавать полную raw-проекцию ещё раз ради настроек запуска.
После ремонта19.09 `codex-c` потоково извлекает root metadata, последний
структурный model/effort и точное наличие user-turns. Общие reducers сохраняют
pairing, Fork/compact/rollback и отказ на более новую неполную настройку;
tool/assistant/replacement-history payload не накапливается в массиве Resume.
У неизменной физической версии возвращается компактный proof без I/O. При
смене path/inode/size/mtime/ctime проход повторяется: один рост файла не
доказывает append, а произвольный хвост может не содержать последние настройки.
Fork сохраняет полный source для точного lineage snapshot.

SSD/OS file-cache ускоряют доставку bytes, но не отменяют JSON.parse, объекты
и последующую сборку мусора. Поэтому уменьшение heap важнее обещания меньшего
времени холодного прохода. Изолированный ElectronNode18/622MiB A/B: heap641.5→15MiB,
event-loop max62.4→19.1мс, cold678→892мс; unchanged0байт. Это отдельные процессы
с одинаковой synthetic fixture, не память всего Noted или замер его hover.
Первая подготовка History остаётся самостоятельным потребителем и видна
малиновым resource-chip; raw-cache budget намеренно не увеличивался.

Пользовательский симптом: dev Electron в один момент занял около 19 GB, а при открытии известной длинной сессии Timeline несколько секунд выглядел пустым. Сам пик 19 GB не был снят live-sample'ом, поэтому нельзя писать, что он полностью объяснён или что controlled stress-test уже прошёл.

Механизм умножения памяти доказан отдельно. Инцидентный rollout был около 609 MB / 32 тысяч records; streaming-аудит нашёл около 169 MB raw tool-result и 268 MB raw `replacement_history`, а eager History projection содержала около 179 MB текста ещё **до** JS object overhead, IPC structured clone и renderer state. В логе полный cache-read был около 511 110 KiB, Timeline snapshot занял 2.27 с, рядом main RSS был около 2.3 GB и heap около 1.6 GB. Другие boot-проходы полностью читали 1.3–1.75 GB посторонних rollout ради discovery.

Виртуализация History ограничивает DOM, но не parser cache, не full projection, не IPC-копию и не удержанные renderer snapshots. Поэтому `Virtuoso`, `startTransition` и GPU-spinner не являются memory-fix. Так же LRU не убирает базовую стоимость одного active 609-MB файла; он убирает неограниченное накопление чужих sessions.

Текущий capability-preserving repair убирает множители:

- адресное Codex audit-enrichment не материализует raw history ради `__line`: bounded LF scan + metadata projection и один canonical record. На661216194bytes/64002rows isolated ElectronNode18: peak JS637.35→5.57MiB, cold address821→129мс, parsed64002→1, raw-cache0bytes у нового пути. Неизменный повтор читает130bytes; изменённый source всё ещё требует подсчёта prefix bytes (123мс в том же прогоне). Это не обещание убрать cold чтение после настоящего projector eviction и не замер production wheel. Exact address/revision guards — `fact-codex.md::Адрес принятого prompt`;
- discovery и full parsing разделены, full cache bounded;
- Codex catalog search использует отдельную query-проекцию в том же History
  worker: Main не получает raw-массив и full turn graph. Это не перенос общего
  `_loadSessionTurns`: другие MCP readers пока могут готовить весь источник.
  Сохранность координат/lineage и пределы временных payload — `fact-session-history.md`;
- готовый physical turns graph общего Main reader может пережить независимое
  вытеснение raw records: graph-owned read proof допускает RAM hit до raw read,
  со свежими annotations и последней проверкой текущего resolver/source/lineage.
  Virtual ancestry и cold miss сохраняют полную canonical подготовку; текущий
  stat старого файла не заменяет provenance graph и binding запроса;
- SOURCE14.10 direct physical Codex turns miss с действующими graph proof/read
  готовится порциями через `setImmediate`: прежние History feed/finalize, затем
  Timeline feed/finalize, metadata и полный Main turns/recordMap. Это private
  one-shot graph запроса, не reuse persistent projector и не новый worker RPC.
  Цель порции128units/~8ms; неделимый decoder/helper может быть дольше, его время
  видно отдельно. Полный prefix по-прежнему обрабатывается, общая CPU/RAM работа
  и снижение production latency этим SOURCE-контролем не подтверждены.
  Локальный FIFO допускает miss до raw load, после ожидания повторяет cache
  eligibility; valid warm hit обходит его, ошибка освобождает следующего.
  Проверки после yield не заменяют финальные fd/stat/resolver/lineage guards.
  Release очереди выполняется до последнего assert, включая reentrant
  async_hooks; partial graph не публикуется. Notes/rewind читаются по прежней
  свежей Main-границе. Virtual/composite/UNKNOWN proof сохраняют canonical
  fallback. Outer cache192MiB/64 неизменен: один oversized334MB result также
  вытесняется, поэтому малый unchanged-hit не доказывает такой hit для него.
  Проверки — immutable original reducers/Main mapper, реальные Node macrotasks,
  queue/source races и маленькие tempFS; runtime/installed — отдельная приёмка;
- Timeline, History и Codex presence держат один request в полёте и максимум одну trailing reconciliation. Invalidation, пришедшая во время активного чтения, не считается уже покрытой первым snapshot: watcher запоминает её и запускает ровно одно дополнительное чтение после завершения первого. То же правило действует при смене presence-generation во время IPC: текущий flight сам взводит повторное чтение, иначе спокойная остановленная вкладка навсегда остаётся в `Checking` до remount. Read-only presence берётся из main-owned event projection; тяжёлое process/materialization observation не является UI-refresh endpoint. Удалить trailing или молча отбросить такое событие значит оставить последний append или lifecycle edge невидимым до следующего внешнего изменения;
- History не держит вторую полную server-entry copy только ради Rewind convergence; для membership достаточен UUID set;
- повторное открытие History сначала показывает renderer snapshot, а read-сервис проверяет durable revision до parse/projection; unchanged-ответ не переносит полный массив через IPC. Для Codex read-сервис и SSD pages принадлежат worker, для Claude сохраняется прежний main-путь;
- Timeline показывает owner-keyed initial loader до первого snapshot, а background refresh оставляет уже известные rows видимыми;
- History публикует новый surface owner только вместе с его rows/loading. Раздельные state-переходы давали один кадр `новый owner + пустые старые rows + loader уже скрыт`, поэтому пользователь видел белую пустоту вместо объяснимого ожидания;
- Prompt Summary генерируется последовательно, а не сотнями параллельных AI-вызовов.

Renderer snapshot ключуется всей identity `tab + tool + session + cwd` и ограничен одновременно 64 MiB, 40 тысячами rows и восемью owners. Вытесняется целый least-recent owner, а не хвост отдельной истории: молчаливое усечение внутри session изменило бы смысл History. Snapshot сохраняет уже построенные сырые server rows без второй глубокой копии.

Текущая row-window модель desktop не является возвращением удалённых display-only окон. Позиционный массив всегда полный; вне читаемого диапазона тяжёлый payload заменён identity-stub, поэтому UUID-порядок, scrollbar, restore и Timeline addressing не меняются. Tail и незавершённая фоновая работа остаются полными, а перемещение окна проходит обычной delta. Группировка обязана быть структурно одинаковой на stubs и full rows.

Для правых Research-серий stub сохраняет короткие string-поля semanticTags:
kind/runId/runKind/phase и tab-message/origin coordinates для прежнего приоритета
classifier. Envelope, offsets/hash и chips не переносятся. Старая потеря tags
распадала новую серию при перемещении hydration span; actual stub/full regression
обязательна. Наличие tag не делает stub прочитанным телом или viewport proof.

Подготовка stubs тоже может блокировать main, даже при маленьком append и
уже показанной History. Старый путь при каждом refresh повторно классифицировал
команды всех невидимых tool rows и извлекал их подписи. Headless A/B настоящего
row-window на6084rows/5334stubs/2KiB shell commands: повторный проход1182.7→19.03мс,
отложенная задача1182.91→19.1мс, полная сериализация ответа побайтно одинакова.
Это доказательство конкретного множителя, не полного production input latency.
`scripts/history-row-window-cost-regression.cjs` отключает только memo в
отрицательной контрольной ветке, не меняя shared tree.

Source-ремонт сохраняет подписи на lifetime raw action через WeakMap с точными
свидетелями полей классификации и простых аргументов. Raw action может изменяться
на месте: новый текст, удаление аргумента или смена family должны инвалидировать
memo, одинакового object identity недостаточно. Структурные/accessor arguments
пересчитываются, а live-work/result/error и UUID читаются заново. Текст не
обрезается, JSONL/source revision не подменяется этим presentation-кэшем. Он не
пинит вытесненные sessions и не увеличивает общий memory budget. Первый расчёт
новой/восстановленной проекции остаётся отдельной ценой; ждать quiet курсора
ради этого ремонта не требуется.

Холодный расчёт тоже не должен становиться одним main-task. После настоящего
eviction новые rawTool теряют WeakMap memo; новый Send при уже готовой History
может заново классифицировать тысячи старых команд. Перед desktop row-window
эти подписи прогреваются порциями под существующей session serialization;
непрерывная порция целится в8мс, а конечная выдача использует прежние exact
witnesses. Структурные/accessor args не прогреваются зря — они не имеют безопасного
shallow memo. Это не новая revision и не перенос refresh до окончания ввода.
Cold file-reader также сразу кормит оба проектора, не удерживая промежуточный
массив всех raw bodies; частичный owner не публикуется при ошибке чтения.
Rebuild после изменения вытесненной сессии остаётся допустимым чтением, но не
допустимой длинной монопольной работой главного потока. Изолированный A/B на
298MiB/32001records: идентичные History/Timeline, max event-loop1081→23мс,
total≈2.17с в обеих ветках. Это не обещание native latency: одна огромная JSONL-строка,
GC и другие фазы требуют собственного замера. Повторяемый тест —
`scripts/codex-cold-history-cost-regression.cjs`.

Byte-limit не должен создавать cliff на больших сессиях. Обычный LRU остаётся строго ограниченным, а отдельный oversized-pool хранит не больше трёх последних exact-snapshot без копирования массивов и имеет собственный общий byte-budget 360 MiB. Три слота нужны именно для A → B → C → A между реально большими сессиями; 240 MiB не удерживал наблюдаемую пару примерно по 150 MiB, и два resume/fork owner вытесняли друг друга. Четвёртый oversized owner вытесняет least-recent целиком. Повышать обычный budget или оставлять oversized-chain без независимых лимитов означало бы вернуть неограниченное накопление памяти.

Streaming projection обязана одновременно замечать содержательные изменения и сохранять identity неизменившихся строк. Сравнение History-row включает tool result/status, thinking, actions и остальные поля presentation: сравнение только по `uuid/type/content` оставляло pending-карточку вечной после прихода результата. Но полностью пересоздавать все объекты на каждом append тоже нельзя — Virtuoso заново рендерит большую ленту. Для Codex pending и completed tool-card получают UUID из исходного call identity; output-line не создаёт новую карточку, иначе раскрытие и локальное состояние теряются в момент завершения.

Desktop History не добавляет live-события в полный durable snapshot и не копирует его на каждый append. Вместо отдельного footer-overlay durable- и live-записи собираются в один presentation-массив Virtuoso: durable выигрывает по физической source identity, а только ещё не материализованные live-записи остаются обычными строками того же списка. Один assistant-source получает стабильный ключ, поэтому переход live → durable не создаёт промежуточную пустую поверхность. Отдельный footer был отброшен: высокий live-ответ мог удерживать будущую durable-строку вне overscan и тем самым блокировать собственный DOM-handoff. Результат инструмента связывается с durable action через одинаковый канонический `toolUseId`; потеря этого поля в parser заставляет live-строку остаться unmatched и повторять тяжёлые refresh, хотя карточка уже существует.

Порядок локальной очереди является частью той же проекции. Prompt, поставленный во время busy-turn, располагается после текущего live-ответа; после доказанного перехода в `sent` он получает exact rollout source identity и занимает место по физическому byte offset, а не по времени появления optimistic-карточки. Это важно для auto-compact: top-level `compacted` может физически появиться между Enter и следующим `user_message`, поэтому CodexTurn watcher сразу отдаёт History лёгкий compact-marker без тяжёлого `replacement_history`; durable compact затем заменяет его по той же identity. Полный History во время busy-turn ради этого не перечитывается. Иначе единый список устраняет моргание, но причинно переставляет compact, вопрос и ответ до следующего remount.

Нормальный streaming-follow имеет одного владельца — `Virtuoso followOutput`. Параллельные ручной `scrollToIndex` и отложенный pixel-scroll создавали разные clocks до и после измерения высоты строки и визуальное движение вниз-вверх-вниз. Они не участвуют в live-streaming: отдельный scheduler остаётся только для изменения высоты composer, а двухэтапный переход — для явной пользовательской навигации. Пользователь, ушедший вверх, прекращает follow; пользователь у хвоста остаётся у нового конца без дополнительного таймера.

Durable revision строится из identity и метаданных реально прочитанных JSONL/rollout sources. Codex physical reader передаёт `path + dev:ino + size + mtime + ctime` из своего курсора, не из более нового stat после чтения. Старые токены без этих полей проходят через обычный refresh. Для Claude сохраняются собственные source snapshots, topology resume/clear-context chain, discovery-состояние директории и editable-last-prompt presentation state: неизменившийся primary JSONL сам по себе не доказывает, что не появился child или не изменился SQLite link. Проверка переживает restart main process и не зависит от watcher counter в памяти.

Шрам25.09: atomic rename с теми же размером/mtime оставлял старые строки и в
projector, и в raw cache; ранний `ifRevision` также отвечал unchanged. Проверять
только reader недостаточно — ревизия иначе вообще не допускает вызов reader.
Одинаковый guard нужен обоим кэшам, а rewrite checkpoints/receipts сохраняют
тот же физический witness. При same-size in-place write с возвращённым mtime
изменение выявляется по ctime. Это защита от проверенных замен, не доказательство
произвольного rewrite+growth и не ускорение большого rebuild после eviction.

Prepared rewrite передаёт dev/ino/ctime от СВОЕЙ записи файла; публикация не
подставляет свежую ctime поверх устаревших prepared records. Тот же witness
проверяется при допуске prefix receipt, до переноса hydration-якоря. Watcher
сравнивает ctime и отделяет rewrite от append, чтобы изменение не осталось
незамеченным до ручного повторного запроса.

Нормализованные entry bounds и full/dehydrated policy входят в revision context
наряду с hydration. Поэтому переход от `last:1` к `last:2`, от missing anchor
к полной истории или от preview к полным payloads не получает ложный unchanged.
Структурные поля row-stub целиком входят в его небольшой digest; их изменение
должно дойти до grouping, даже если текст и UUID прежние.

### Ревизия prompt-пометок без повторного чтения всех тел

Пометки сохраняют UUID через resume/fork, поэтому их ревизия охватывает весь
provider, а не только текущую session. Сужать её ради скорости нельзя: child
иначе не узнает об изменившейся пометке ancestor. До25.09 каждый revision-probe
снова выбирал все `chips_json` provider и сериализовал их ради SHA; на30MiB
тестовых пометок один неизменный запрос блокировал loop на211–220мс.

Теперь DatabaseManager повторно использует ТОТ ЖЕ SHA по отдельной SQLite
версии provider. INSERT/DELETE и изменения полей, участвующих в hash, двигают
её триггерами в той же транзакции, включая запись из другого соединения.
Обновление только `updated_at` SHA прежде не меняло и не инвалидирует кэш.
Внутри транзакции reuse/publish кэша запрещены: rollback способен повторно
использовать номер версии для другого содержимого. Restart начинает с пустого
кэша; первая проверка или реальное изменение всё ещё вычисляет прежний hash.
Это ускорение проверки пометок, не отказ от canonical refresh, не увеличение
projector budget и не новый публичный revision-формат.

Поиск пометок по inherited UUID имеет собственный `(tool_type, entry_uuid)`
index: session-leading index не обслуживал этот фильтр и повторял provider-wide
scan. Порядок кандидатов сохранён явно (session/entry/rowid), текущая session
по-прежнему имеет прежний приоритет в decorator. Ускорение lookup не меняет
provider-wide область SHA и не исключает ancestor metadata.

### Время ответа: полный поиск привязки, оконное чтение готовых значений

Pending interval выбирает единственный ответ по ПОЛНОЙ проекции. После этого
bound-only decorator читает готовые значения для переданных полных rows; в
прежнем main-пути это hydrated window, при построении SSD-версии — вся готовая
проекция один раз на её revision. Последующие page hits уже содержат эти значения. Он
вообще не умеет привязывать pending и вызывать binding observers. Пустой
предварительный probe не заменяет эту границу: чужое SQLite connection может
вставить pending между двумя вызовами, и partial combined decorator ошибочно
принял бы единственную видимую строку вместо двух неоднозначных full candidates.

Bound values, pending-проверка и returned timing revision читаются в одном
коротком READ snapshot. Binding/observers происходят до него после обычного
commit. Если появился ещё не обработанный pending, повторяется полный binding;
после трёх непрерывных изменений token намеренно не подтверждает свежесть на
следующем ifRevision. Не оборачивать весь prepare в SQLite transaction: это
выключило бы memo prompt SHA и вернуло большой scan. Prompt authoring/recovery,
offscreen binding, порядок всех rows и full-payload API сохранены.

С отдельным worker connection проверка свободного target и claim — одна
атомарная SQL-команда. Alias writer проверяет тот же target в write transaction.
Два interval не могут занять один exact response между SELECT и UPDATE;
binding observers получают только успешный commit, повтор того же claim допустим.

Изолированный actual service/SQLite,13k rows: timing+final revision около32→9мс,
готовая projection→ответ около64мс в последнем проходе. Все13009rows нового
timing-window равны старому full-timing пути; SQL timing rows2202→302.
Reader здесь заменён готовой проекцией: эти числа не включают JSONL rebuild,
IPC/paint и не доказывают native scroll latency. Последний большой read после
реального eviction этим локальным timing-ремонтом не закрывался; принятый позже
worker/SSD-контракт описан выше. Приведённые числа относятся к прежнему
прямому service-пути, не к полной цене подготовки SSD-версии.

Локальные `sending/queued/sent`, rewind marker, handoff metadata и временные suppression не входят в durable snapshot. Они живут в отдельном LRU-overlay с лимитами восемь owners / 512 элементов / 2 MiB и восстанавливаются при переключении вкладки. Смешать их с server rows опасно в обе стороны: локальный prompt пропадёт на remount до записи в transcript, а suppression-filtered server array может навсегда скрыть строку после истечения TTL. Ближайшее истечение suppression запускает одноразовую reconciliation из raw snapshot; постоянный timer polling не нужен.

Timeline не снимает busy-дефер этого сервиса ради одного нового prompt. После
exact SENT targeted History projection дополняет общий handoff canonical UUID
до presentation consume, и Timeline временно добавляет только bounded
user-marker. Следующий обычный snapshot заменяет его по UUID/source alias. Это
presentation-overlay, а не второй transcript reader и не отдельный polling
clock.

Каждая committed привязка History к owner получает монотонное поколение. Проверка только по owner-key недостаточна для A → B → A: поздний ответ первого A снова совпадёт по ключу и перетрёт более новый A. Любая state/cache write после async должна подтвердить и key, и generation.

### Дегидрация и полное тело по запросу

Desktop `dehydrate:true` заменяет tool-result/thinking/compact больше16Ki
символов на preview2Ki + детерминированную ссылку; `history:get-tool-payload`
сохраняет прежний render-cap4Mi символов. Полный текст держит общий byte-bounded
stash192MiB, Codex worker также сохраняет его на SSD. Claude legacy rebuild
восстанавливает result/thinking по recordMap с background-notification; его
compact остаётся inline из-за branch look-ahead. Default full HTTP и Timeline
не получают превью молча. Durable `resultRef` покрывает live tool-result по
наличию exact ссылки, а не по равенству полного текста и превью.

С03.10 source HTTP предлагает отдельный opt-in `payloads=on-demand-v1`
(контракт — `fact-mobile-web.md::History: скрытые тела только по tap`). Причина:
native раньше обрезала до2K уже ПОСЛЕ загрузки; один80-row ответ весил1.22MB,
включая150 tool actions и compact157K. Только прежних resultRef недостаточно:
аргументы shell/code/Edit и diffHunks тоже тяжёлые. Новый detached projection
оставляет обычную prose, UUID/source identities и дешёвые grouping headers,
но передаёт action целиком через JSON payload того же stash; resultRef внутри
action по-прежнему адресует большой отдельный text. Native policy не мутирует
canonical prepared rows/desktop graph. Thinking presence остаётся структурной.

Тот же getToolPayload проверяет exact row/ref/hash на bounded canonical read;
Claude compact восстанавливается тем же branch projector, не новым extract-парсером.
Ответ идёт страницами до4Mi UTF-16 units, без потери остатка и без разрыва
surrogate pair. Policy участвует в conditional revision и HTTP delta-consumer;
hash различает позднее изменение action при том же source generation. Codex
generation переживает SSD/restart, Claude native generation привязано к source
revision и меняется также при append. Устаревшая ссылка требует refresh rows,
не подстановки текста другой сессии. Frozen ancestor проверяется canonical
lineage digest/read tickets: stat по synthetic frozen revision с mtime0 дал бы
ложный отказ даже неизменному Fork. Desktop/старые клиенты сохраняют прежний
контракт; наличие source не означает установленную capability или готовую iOS.

Native headerVersion2 сохраняет различия, которые раньше читались из тела:
`hasResult` не путает absent/null с успешным пустым result, а `status` не принимает
async acceptance за конец Task/background. `fileChange` передаёт exact пути и
счётчики canonical hunks либо полного argument diff; неизвестное — null, не0.
Подсчёт использует уже нормализованные actions, не второй JSONL/patch parser;
count-only frontier не строит квадратичную UI LCS-матрицу. Delete без исходного содержимого
сохраняет явную неизвестность в canonical normalization. Version2 включена в
read revision: иначе прежний header мог остаться unchanged навсегда. Wire —
`fact-mobile-web.md::History: скрытые тела только по tap`.

**Кладбище: tail-window и reading-window (реализованы 25.07, удалены 26.07).** Две механики «показать короткий массив мгновенно, затем подменить целым» — хвост ~120 записей и mini-кэш видимого фрагмента. Они почти не экономили parse, но создавали шов с тёмным кадром, прыжком viewport и порчей позиции; оба пути также обходили viewport-proof. Не путать их с нынешними stubs полного позиционного массива: там нет подмены списка и перенумерации. Допустимый display-only survivor — rewind-префикс внутри одной вкладки с writer proof. Не возвращать короткие массивы «для скорости» без замера реального bottleneck.

## Связанные поверхности

Timeline и HistoryPanel подписываются отдельно, но на один service-key. HistoryPanel сохраняет свои локальные handoff rows и prompt merge через `loadHistory(true)`; сервис не должен знать о presentation-state. Project Terminal API использует тот же слой как pure-server read path: bridge нужен для Zustand/tab actions, но не для чтения durable transcript. Claude PTY live-message watcher из `fact-mobile-claude-pty.md` остаётся отдельным live tail каналом до полной миграции; не смешивай его с shared invalidation contract.

Codex raw-record callback — не второй live-row writer. Он передаёт main точную
физическую границу append-записи до фильтра live-публикации, чтобы provider
preview получил canonical `itemId`, reasoning/tool boundary и terminal turn
boundary даже при временном `publicTurnStateSuppressed`. Main обязан повторно
доказать текущие launch/run/lifecycle/watcher file+offset; сервис сам не решает,
какой rollout принадлежит живому процессу и не использует provider session как
read-owner.

См. `fact-timeline.md::Визуальный фидбек и навигация`, `fact-codex.md::Timeline и History`, `fact-mobile-web.md::Bridge pattern`.
