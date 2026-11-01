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

SOURCE26.10 cold state init различает resolve/path memo, discovery с read-view,
refresh/stat и bounded context seed. Общий `ensureMs` включает await этих стадий;
даже большой ensure не доказывает exclusive CPU handler'а. Joined init имеет
тот же `initAttemptId` и собственные исходные action/read/request IDs. Сама
History RPC и подготовка subscription могут закончиться в разное время.
Вложенные admission/decode/publication read-view фазы и scalar framing counters
описаны в `логирование-оптимизации.md::Cold History`; новая диагностика не делает
дополнительного discovery/stat/decode и не меняет watcher/readiness authority.

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

`changed-during-read` не означает только append в rollout. Само чтение может
связать pending response timing с готовым assistant UUID и изменить SQLite
metadata version: файл уже стабилен и provider idle, но первый certificate ещё
unknown. После стабилизации metadata следующее выбранное чтение может стать
known. Такой собственный bind не разрешает обходить прежние owner/event/source
guards или объявлять доставленные rows свежими по одному `success:true`.

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

Отдельный read-only `read_session_snapshot` сохраняет зафиксированный prefix при
дальнейшем append: request-local FD/identity, hash всех диапазонов и повторный
logical/resolver proof. Его rewrite epochs отделены от strict append epochs,
а Main journal и owner/Stop/input проверяются до публикации. Canonical query
projection не создаёт Main raw graph; выходной ответ и decode batches ограничены.
Новый метод не использует тяжёлый cold lineage bootstrap: нужен physical full
source либо готовый virtual manifest. Строгие cache/mutation readers выше
сохраняют прежнюю инвалидизацию. Контракт и ошибки —
`fact-session-history.md::Снимок последних Codex-итераций во время busy`.

25.09 SOURCE: desktop Codex больше не связывает просмотр старого участка с
наличием полного parser graph в RAM. С22.10 SOURCE configured Codex reader
исполняется в Electron `utilityProcess` вместо прежнего `worker_threads`:
History/Timeline/payload, совместимые messages, поиск, копирование и экспорт.
PTY, writer/operation proof, подписки, live delivery и мутации остаются main-owned.
SQLite sidecars читаются прежними методами через отдельное соединение без
startup migrations; точные binding/asset/lineage уведомления возвращаются main.
Fatal V8 в thread не изолирует Main; отдельный процесс ограничивает этот failure
domain. UNKNOWN/disconnect/error не доказывает exit: replacement ждёт actual exit.
Node child injection существует только в Source tests, production fallback на
worker_threads не используется. Это не защита всех Main SQLite/Claude/client reads.

Native-приёмка read-кода должна проверять filesystem API целевого runtime.
На Electron28.3.3/Node18.18.2/ABI119 `Dir.readSync` с `encoding:'buffer'`
падает в `Dir.processReadResult → path.join(Buffer)` с `ERR_INVALID_ARG_TYPE`.
Catch такого сбоя как «дочерний файл не найден» оставляет завершённый Task
в состоянии running. В частном candidate это исправлено однобайтовым чтением
имён с восстановлением raw bytes; порядок/Unicode и actual child completion
проверены отдельно. Это не изменение текущего default service. OS errno
недоступной директории и программная несовместимость должны различаться;
произвольные ошибки нельзя превращать в отсутствие child.
Отдельный native pathname требует фиксированного scratch budget до decode,
а загрузка постоянного кода helper — bootstrap до измеряемой read-операции.
Проверка raw-имён на Linux не заменяет macOS: APFS fixture с невалидным UTF-8
может завершиться `EILSEQ` ещё при создании файла. Подставной Dirent проверяет
алгоритм, но не физическую поддержку такого имени. Native RSS/DT_UNKNOWN и
универсальная filesystem-совместимость этим не доказаны. Точные receipts и
границы candidate — [рабочее состояние](../tmp/оптимизация-history.md).

Тяжёлый read имеет отдельные demand leases, не только общий Promise: уход A
не отменяет B, уход последнего отзывает producer, следующий C получает новую
generation. Cold admission удаляет отменённого waiter. HTTP aborted/premature
response-close и sender-owned IPC demand освобождают consumer; watcher subscribe
и input/Send authority остаются другими владельцами. Renderer держит AbortSignal
локально, поздний result/finally не очищает новый flight.

Reader→Main stream использует накопленный consumed byte credit: duplicate/future
ACK не расширяет окно, end ждёт final credit. JSON/NDJSON кодируются частями,
без второго полного stringify/gzip buffer в Main. После частичного ответа ошибка
закрывает wire, не запускает второй full read; UNKNOWN/source invalidation не
маскируются consumer cleanup. Conditional/delta/freshness сохраняют свои ветки.
Эта граница ограничивает transport-owned bytes, не canonical/pending graph,
произвольный toJSON, full-array DTO или строки потребителя.

23.10 SOURCE добавляет отдельный opt-in canonical/pending producer в прежнем
Codex file-feed: `projectCodexFullHistoryFromFile/Stream({rootedOwner})` принимает
`CodexRootProjectionOwner` с reader-owned `HistoryPagedStore`. Тот же semantic
reducer хранит rows, logical owners, aliases и pending indexes на страницах;
continuation отделён от CoW presentation view. Результат содержит явные cursors
и operation leases, а не полный DTO. Current pin и до четырёх checkpoint pins
принадлежат reader/cache; скрытый SQLite на каждый legacy projector не создаётся.
Append/restart проверяет сохранённый prefix точным порционным сравнением bytes,
поэтому тёплая admission пока стоит O(prefix), а не O(stat). CoW/SQL write
amplification и сборка неиспользуемых страниц требуют отдельного бюджета.

Полный startup/service sweep пока является частью admission, а не лишним
безусловным read, который можно просто заменить несколькими `collectStep`.
На конечном SQLite-контроле накопленный мусор занимал241 из512SQL-pages: порог
75% ещё не требовал pressure cleanup, но следующая допустимая300003UTF16-unit
сборка получила SQLITE_FULL; прежний полный collect доставлял точные bytes с
одной попытки. Для сокращения sweep нужен pre-write reservation/allocation proof,
учитывающий unreclaimed pages, рабочие SQL-страницы и journal. Процент заполнения,
cleanup после ошибки или повтор producer такой proof не заменяют. GC-диагностика
считает steps/reclaimed/retired только после успешного commit, иначе rollback
выдаёт освобождённые страницы, которых в действительности не стало меньше.

26.10 SOURCE sweep этой же коллекции обрабатывает оставшиеся в текущем work-budget
page ordinals одним SQL-диапазоном: наружу выходят только count/end, а рёбра и
непомеченные страницы удаляются внутри прежней транзакции. Предел работы,
checkpoints, полная mark/sweep-последовательность, lease fences и `DELETE/FULL`
не меняются. Конечный real-SQLite differential сохранил полные frozen values,
rollback и33 шага/2102work/2048reclaimed, SQL executions12567→236; прежний quota
counterexample по-прежнему требует полного sweep. Это Source-доказательство
сокращения SQL-вызовов, не native latency или общий memory bound.

Поздняя фаза удаления старых GC-отметок также остаётся в том же collector.
`epoch<>? LIMIT 1` обходил текущие отметки заново для каждого удаления. SOURCE
читает два непересекающихся диапазона `epoch<? UNION ALL epoch>? LIMIT 1` через
существующий `hp_gc_pending(epoch,done,page)`: по-прежнему одна старая отметка
на work item, без нового индекса или массива IDs. Обе стороны сохраняют старые
и возможные будущие epochs, исключая только текущий; `epoch` имеет NOT NULL.
Это устраняет повторный scan, сохраняя полный sweep, транзакции и rollback.
Фактический выигрыш в Electron проверяется после сборки; SQL-control не является
замером native CPU/RAM или всей задержки открытия.

В mark-фазе SOURCE удерживает только текущие `page`/`next_edge` внутри одного
существующего transaction callback. Children сразу попадают в SQLite queue;
завершение страницы сохраняет cursor вместе с `done=1`, а незавершённый cursor
сбрасывается в SQL перед выходом callback, до `checkDisk`/commit. Эти два скаляра
не переживают bounded step, rollback или yield. Edge и completion по-прежнему
расходуют отдельные work units; полный sweep,64-work quantum, epoch restart,
builders/pins и quota fences сохраняются. Это сокращает повторные `markNext` и
промежуточные `markAdvance`, не меняет cold O(N) и само по себе не доказывает
wall-time benefit. Worker fingerprint включает этот store: новая реализация
проходит обычную смену source schema/freshness, без заимствования старых receipts.

24.10 SOURCE rooted file path подаёт bytes в `readRootedJsonlRange` и paged
parser до накопления полной JSONL-строки. Parsed cursors лениво связываются с
прежним reducer, raw bytes остаются frozen backing для старых leases после
rewrite. Partial tail повторно разбирается порциями из backing; это bounded
working set с O(unfinished-record bytes) повторной работой, не сохранённое
lexical continuation. Number conversion и codec ancestry также используют
ограниченный scratch и backing frames.

Это ещё не default service/worker protocol: обычные desktop callers сохраняют
прежний полный graph. Read-only semantic adapters могут материализовать большой
leaf: exec/Babel, image markup/references, native question proof и tool-name
normalization. Их полное содержание сохраняется, но zero-materialization
assertions остаются RED. Postprocessors, ordinal UI, Full/Copy/Input и native
RSS этим opt-in не ограничены.
Пустые Proxy targets внутри reducer представляют logical handles; их bounded
cache не является пределом всех transient/native allocations. Подключение
service не должно использовать `getHistory→captureLegacy`: такой переход сначала
строит весь DTO и добавляет запись на диск вместо устранения исходного owner.

SOURCE private root-route классифицирует physical Codex scope напрямую по
paged header/lineage metadata. Legacy lineage/recovery getter здесь недопустим:
даже один обычный parent может иметь тысячи forward children и UUID members.
Read descriptor связывается с настоящим canonical file/epoch и проверяется до
prompt/timing preparation, которая вправе сделать собственные sidecar writes.
Только точно аттестованный полный event/link counter contract позволяет игнорировать
посторонний Main UI commit; неизвестная схема сохраняет общий committed DB fence,
а local rollback/смена connection/source и настоящее изменение lineage отзывают
кандидат. Это read proof, не право recovery write, Send, Resume или Input.
Неподдержанный composite остаётся отдельной явно выбранной legacy веткой.

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

26.10 SOURCE private primary root может объявлять `metadataRowWindow` profile
`primary-metadata-fields-v1`: range передаёт консервативную credit-оценку строки,
а rowWindow возвращает её упорядоченные name/value descriptors одним обходом.
Проверяется точный signed source/durable metadata address текущего lease;
неподдержанный профиль, недостаточный credit или большая строка выбирают прежний
fields-walk ДО fast RPC. Ошибка выданного запроса не даёт повтор/fallback.
Сумма bounds включает scalar-page BIGINT и отдельный descriptor/control overhead;
max3 items/старые byte credits/cache/page/quota/FIFO не меняются. На конечном
16-user corpus source+durable RPC204→108 при равных полных значениях; это Source
work proof, не native latency. В этом срезе декодированные IDs/metadata ещё
оставались отдельным native owner; более поздний canonical-путь описан ниже.
Full/Copy/selected-text consumers также хешируют
UTF16LE фиксированным4096B scratch, сохраняя lone surrogates/CRLF; конечная joined
строка/decoded graph/rich renderer от этого не становятся bounded.

SOURCE27.10 direct-root History объявляет отдельный negotiated профиль
`primary-presentation-address-v1`: до3 адресов в пределах прежних65536B. Старый
metadata rowWindow остаётся limit1. Prepared source ordinal, canonical ordinal и
display rank различаются: скрытый член группы возвращает свой exact UUID/source
ряд, а carrier/header — отдельные поля. Physical key сохраняет прежние override/
source/queue/UUID правила; это не rank/lease key и не сертификат layout.
Неоднозначность не выбирает произвольный ряд; ошибка, отмена и смена cut не дают
negative proof или legacy fallback. Point probe не закрывает shared parent и
независимый document reader.
Текущие body/address maps публикуются вместе; вытесненный snapshot не допускает
строку заново. Остальные full-metadata consumers сохраняют свой прежний путь;
адресный профиль сам по себе не ограничивает один большой unit/scalar или общую
память и не даёт Input/queue/writer/Stop authority.

Новый primary Root пока выбирается только общим Main/renderer test-profile
gate (`history-primary-rollout.cjs`). Packaged private acceptance с этим gate
не является доказательством, что ordinary installed reader уже переключён.

28.10 SOURCE окно уже загруженных primary bodies сохраняет только текущий
диапазон и небольшой соседний запас; при движении дальние тела и их addresses
вытесняются вместе. Запас не запускает чтение ещё не открытых гигантских строк.
Полный prepared metadata graph и geometry имеют других владельцев: размер
body-window нельзя выдавать за предел всей History/RSS. Full/Copy и Timeline
по-прежнему адресуют полный источник, а не накопленный набор посещённых страниц.

Для обычной ENTRY selected-body reader теперь удерживает exact installed view
отдельным pin и порционно декодирует выбранную строку. Раньше даже готовый body
повторно материализовался и сериализовался в новый V8-document, попадая за чужой
cold/maintenance lane. Pin остаётся SQL allocation, с прежними lease FIFO,
source predecessor, quotas и cleanup по исходному child request ID; это не
разрешение пропускать зависимость своего source. Group и неподдержанные формы
сохраняют прежний настоящий V8-путь. Полный selected-native result может быть
большим; кредит отдельного packet не является лимитом итогового объекта.

Рабочий page-cache Root получает фиксированную долю прежнего index-memory
budget, а не дополнительный глобальный бюджет. Прежние настройки Root3slots/2KiB
raw и8KiB SQLite многократно перечитывали backing даже на16строках. При32MiB
allowance теперь28MiB остаются prepared indexes,4MiB зарезервированы под raw
slots и main/TEMP pager targets. Это учёт и SQLite target, не замер native RSS;
tiny/injected adversarial stores и zero-budget не расширяются. Увеличение
SSD-лимита само по себе эту рабочую память и лишние чтения не исправляло.

#### Координаты текущей и удерживаемой проекции

SOURCE28Oct переведённая primary Root-ветка не строит `unitIndexByUuid`;
`displayEntryIndexByUuid` был alias той же Map, а не второй owner. Готовый Root
сохраняет свои выбранные адреса. Для реально показанного порядка при pending/
отсутствующем Root используется отдельный `history-presentation-position-v1`:

```text
показанные entries/units/keys + исходный owner → регистрация в paged store
полный выбранный UUID → независимый query → rank/member + прежний physical key
исходные visit/gesture/scroller/restore/paint guards → допустимая коррекция
```

Регистрация остаётся allocating работой по всему порядку под прежними квотами. Она захватывает
реальные display arrays, owner/rewrite/generation/mode, без зависимости от будущего
preparation input. Одинаковые показанные arrays не загружаются заново только из-за
изменения такого input. Last physical unit / first matching group member сохраняют
прежнюю Map-грамматику. Полные UTF16 сравниваются независимо от chunk partition;
даже mismatch завершает проверку целостности выбранного leaf. Genuine legacy/
composite Map сохраняется. Это не универсальная замена object-key Map.

Только аутентифицированные held fork-v2/target не пишут target pages/SQL pins и
не ждут несвязанную canonical allocation maintenance. Они делят одну настоящую
immutable SQL pin с независимым lifetime, сохраняя свой lease FIFO и явно заданный
source FIFO. Cold-регистрация и release остаются на прежних allocating/cleanup
границах. Родительский close не отзывает уже выданного child.

Четыре выбранных consumer lanes ограничены одним running и одним replaceable
pending demand каждая; raw cleanup ACK хранит точного владельца отдельно от
результата/отмены. Неразрешённый predecessor даёт явный UNKNOWN до новой allocation,
не отсутствие и не replay. Parent ACK сам по себе не подтверждает cleanup детей.
Координаты не дают canonical/source, body/paint, Input или writer authority.
Исходный Timeline срок остаётся inclusive20s с проверкой после await; resize/
saved-anchor сохраняют прежнюю240-attempt сходимость без нового20s ограничения.
SOURCE-контроли не подтверждают mounted/native latency или global memory.

#### Независимо удерживаемая prepared-проекция

SOURCE28Oct primary-модель выдаёт independently retained prepared child до
сохраняющегося Np decode. Он держит исходный semantic bundle/view, signed
metadata descriptor, schema/semantic/view/source binding и свой lease/request ID.
Закрытие или замена Root/model освобождает только model reference: показанный
cut продолжает читать свою проекцию. Это display/read lifetime, не текущая
canonical/source truth, writer/Input, data-commit или paint authority.

Полная Np thin-graph/UTF16 validation имеет отдельный owner fact; canonical Nc
fact её не заменяет. Cold backing check и authenticated same-data rebind остаются
разными доказательствами. Отмена prepared fork чистит только его новую allocation
с исходным preparedRequestId. Даже genuine поле inputDocument в malformed reply
не разрешает closing другого удерживаемого документа того же consumer.

Sparse CURRENT publication хранит настоящие local objects и затронутые source
ordinals/sidecars, сохраняя V49 matching/order/reservation/witness правила.
Historical predicates читают полные prepared/MIXED значения, а compatibility
materializer всё ещё возвращает настоящий Np-массив оставшимся consumers.
React data commit связывает exact shown publication/current overlay отдельно
от canonical receiptDataSubject, same diagnostic-tail object и measured paint.

Selected V51 arm отпускает native array borrows после регистрации и выбирает
историческую строку по исходному ordinal из retained child; CURRENT locator
сохраняет native object identity. Непереведённая transformation заранее выбирает
названный native compatibility adapter; UNKNOWN/error не запускают такой fallback.
Source-order и обычный group replay не требуют N-Map; произвольный немонотонный
ordinal lookup может стоить O(Np×Nu), preflight и registration остаются двумя
проходами. Это не устранение cold Np decoder/units/keys или latency/RSS proof.

Два неочевидных lifetime ограничения нельзя убрать при упрощении. Retained invoke
создаётся отдельной factory вне transient async query context: inline closure
удерживал original Model.open context и native Np даже после model.close.
Selected metadata text заимствует уже pinned signed node через private non-owning
HistoryTextDocument; полный length/digest и обычные range/credit checks сохраняются.
Его close локальный: новая text allocation/raw release ACK здесь не нужны и
не удерживают отменённую lane. Обычные Full/Copy/Input/decoder text forks и
последний реальный prepared release сохраняют прежние независимые lifetimes.

#### Каталог агентов: historical thin и native CURRENT

SOURCE primary roster/Inspector читает отдельный retained catalog из прежнего
chip-domain: показанные entries и literal raw live join. Итоговый display-domain
после Rewind/settings, mounted window и canonical Nc не заменяют этот состав.
Original model может закрыться, а собственный source/catalog child продолжает
читать тот же cut. Полные selected значения остаются native sinks; Np decoder,
compatibility graph, registration и geometry этим consumer не устраняются.

Historical input должен совпасть с **декодированным** старым thin metadata:
raw paged null-prototype object не эквивалентен обычному object старого decoder.
Иначе прежний label `[object Object]` становился TypeError. Catalog-local paged
COW сохраняет data properties, indexed arrays/holes/undefined и alias/cycle
identity; CURRENT objects и глобальная canonical grammar не нормализуются.

Main-facts authority возникает из original normalized records и exact filtered
collection capture. Кандидат event-normalization ещё может содержать identity,
которую прежний owner filter должен отвергнуть; factory не переносит этот фильтр
раньше и не превращает такой record в авторизованный Map. Structural ReadonlyMap
или custom getter не доказывают pure lookup. Original collection contents/order
и data descriptors проверяются отдельно от FULL native caller witness и его
cheap owner fence. Main-only active/terminal grammar совпадает в CURRENT face
и готовом paged catalog. Terminal `values()` нельзя заменить entries traversal
по одной проверке методов Map: публичный iterator.next может различать результаты.
Native continuation сохраняет literal method и один next-method на iterator;
build/replay имеют независимые iterator records.

Own data property сама по себе не неизменна: другой CURRENT getter способен
изменить и восстановить её между наблюдениями. Общие reads остаются в ordered
replay; adjacent RLE меняет хранение, но исполняет каждый вызов и проверку отмены.
Отдельный optional settings shortcut требует genuine Node non-Proxy authority
и original own keys/descriptors/values; отсутствие такого proof оставляет точный
generic replay. Его storage/time зависят от наблюдённой последовательности,
поэтому универсальный O(CURRENT) и global/native memory bound не заявляются.
Cooperative64 относится к controlled producer work/ограниченным UTF16 windows
вне SQL transaction/builder, не к wall time произвольного callback/giant sink.

При явном закрытии самого `HistoryPagedStore` cleanup его pins и native
`db.close` — отдельные fallible шаги: ошибка первого не пропускает второй и
остаётся основной даже при отказе диагностики. Если native close отказал,
успех не объявляется и прежний explicit retry сохраняется; автоматического
повтора нет. Это закрытие всего backing owner, не cleanup выбранного child.
Сохранённый путь failed backing не обещает неизменные байты момента ошибки:
для причинного разбора нужна полная семья DB/journal до последующего cleanup.

SOURCE27.10 добавляет отдельный `primary-canonical-consumers-v1` для
later-canonical receipt recovery, terminal-preview membership и поиска уже
confirmed receipt. Canonical source и prepared/live composition читаются раздельно;
пустой результат тоже требует dedicated producer proof текущего cut. Выбранные
полные значения сравниваются потоково через независимые child documents;
ошибка/UNKNOWN/отмена не означают absence и не закрывают shared parent.
Размер страницы — до3 descriptors/прежние65536B; metadata limit1 и allocating
maintenance/quota/FIFO/64work сохраняются. Receipt проверяет полный нормализованный
текст, exact SID и physical offset начиная с сохранённого boundary. Live handoff
различает canonical presence, prepared membership, полный text hash и actual
measured paint/address: один из этих фактов не заменяет остальные. Этот профиль
сам по себе не устраняет native metadata inventory и не доказывает
сокращение всей памяти или O(1) поиск. Более поздний canonical fact снимает одну
из двух renderer-копий; prepared-массив сохраняет отдельное назначение.

#### Canonical metadata без второй renderer-копии

SOURCE27Oct primary-путь получает `primary-canonical-metadata-v1` вместо полного
декодирования и заморозки canonical Nc в renderer. Prepared Np — другая
последовательность после overlays/Rewind: её настоящий compatibility graph
сохраняется. Успешный model metadata содержит `canonicalMetadataFact`, а не
`durableEntries`; signed durable descriptor остаётся для выбранных полных чтений.
Отключить старый decoder без замены проверки нельзя: hidden canonical строка
может отсутствовать в Np, но всё ещё обязана пройти прежнюю thin/graph-проверку.

```text
canonical metadata на SSD → полный обход и immutable digest
                          → cold demand: очистить page cache, заново разрешить root,
                            проверить весь граф/UTF16 и исходный digest
renderer: prepared Np + проверенный canonical fact + выбранный diagnostic tail
                          → data commit → отдельное measured paint proof
```

Pending/visited адреса полного обхода живут в прежнем quota-accounted SQLite;
native frontier ограничен64 адресами, работа проверяется/уступает через64 единицы.
Вставки frontier коммитятся ограниченными batch без await внутри транзакции;
отмена проверяется ДО flush, а committed sequence меняется сразу после успешного
commit/checkDisk. При ошибке чистятся только собственные committed job rows.
Так устраняется per-node transaction amplification без пропуска строк, aliases,
cycles или scalar/text integrity. Это остаётся O(размер графа и текста), не O(1)
и не предел global/native memory; аварийный выход до finally может оставить
временные rows до retirement derived backing.

Cold-проверка не использует прежний успешный результат вместо чтения backing.
Даже root cursor разрешается ПОСЛЕ очистки page cache: иначе cached owner envelope
может выбрать старый граф при уже изменённой физической странице с новым SHA.
Passive view reuse имеет иной scope: отдельный producer demand подтверждает
предыдущую завершённую validation receipt и новую точную привязку того же immutable
owner. Header/count/token без такой проверки не подходят. Ошибка/UNKNOWN не дают
пустой fact, legacy fallback или новый load cycle. Проверенный пустой domain
отличается от unavailable; selected tail не даёт body/Input/writer authority.

Версия acceleration учитывает фактически загруженные implementation bytes:
isolated Root worker хеширует как собственное engine-дерево, так и общий
`src/shared` для `.js/.cjs`. Общая metadata grammar загружается до этого hash;
иначе её изменение не отзывает старую интерпретацию. Это расширение freshness
scope, не смена legacy-worker routing. Source-регрессии проверяют cold corruption,
rollback/cancel и реальный hash/renderer CJS admission; native UI/RSS/latency
квалифицируются отдельно в рабочем плане.

Confirmed matcher — отдельный договор: первая подходящая canonical-строка по
UUID/sourceIdentity или двум Array alias-полям, с прежним optional SID-фильтром.
Он не требует user-role, текста, timestamp или byte-boundary и не заменяется
later-user predicate. Typed receipt→audit fallback для поиска отличается от
прежнего truthy-OR до проверки типов в ACK; очищенный selector не даёт новой
ACK authority. Выбранный proof читается без native metadata inventory, но Main
ACK по-прежнему проверяет собственные operation/attempt/provider/SID и CAS.

В SOURCE27Oct тот же held-root/selected-value канал обслуживает primary live
identity coverage. Фиксированные `truthy`, `live-setting-kind`,
`live-setting-value` дополняют allowlist; произвольного getter/eval или нового
read profile нет. До3 текущих claims сравниваются с полным canonical источником
через signed text children. Полный проход сохраняет поздние coercion failures и
последний валидный settings fact для каждого identity; plain membership и
settings conflict возвращаются отдельно. Raw assistant UUID не заменяет
`assistant-uuid:` identity, а `sourceUuidAliases` не добавляются в live grammar.
Strict session equality не становится string/deep equality.

Это O(N) на batch до3, при L текущих claims — до O(N×ceil(L/3)) посещений плюс
settings pass. Historical native Set/Map для нового query не создаётся, но обе
metadata arrays при model.open и остальные compatibility consumers сохраняются.
При нескольких malformed rows в разных batches первый diagnostic может
отличаться от прежнего общего прохода: результат остаётся UNKNOWN, без частичной
retirement и собственного retry; exact diagnostic-order equivalence не заявлена.
Consumer/commit/cancellation — в `fact-живой-ответ-в-history.md::Primary root`.

SOURCE27Oct selected prompt adoption использует этот же held канал для delayed
append, raw-status, no-exact-ID recovery, ordered shared handoff и genuinely late
CURRENT locals. Fixed operations `prompt-identity`, `prompt-selected-identity`,
`graph-identity`, `array-some-check` и ограниченные semanticTags member fields
сохраняют full normalization, typed/lazy aliases и native refusal. Ordinary
finder идёт по source order с inline legacy/exact/fallback внутри строки;
shared pass сначала ищет допустимый full legacy handoff по всей последовательности.
Один current-pass UUID exclusion Set сохраняется через await и резервирует UUID
до enrichment/ACK. Это не historical inventory и не canonical ordinal.

Selected identity graph включает пять identity fields и реальные attachment
length-presence flags; sparse/inherited aliases, own undefined, cycles, shared
refs и принимаемые Maps/Sets сохраняются. Другие root content/actions/timestamp
не перечисляются. Декодирование выбранного graph/scalar остаётся native sink,
без универсальной memory/giant-graph квалификации. Канонический match не равен
prepared absence: TTL/suppression/Rewind тоже могут убрать local из проекции.
Model provisional prepareAdopt ищет late locals в эффективном MIXED prepared
domain с полным CURRENT local вместо captured stub. Старые N metadata arrays
пока ещё нужны для membership/order и остальных topology/adoption consumers.

Narrow generator current local compatibility согласует extraction, generated
code, dependencies и manifest. Recovery-owned failed/cancelled local не истекает
по старому15s TTL; primaryTimeWindow использует ту же политику. Shared image
normalizer включает CURRENT protected web-image grammar. При изменении Panel
проверять и full input SHA manifest, даже если selected declarations не менялись.


Exact identity index final semantic root включает `sourceUuidAliases` вместе
с прежними uuid/sourceIdentity/entryRef/sourceIdentityAliases/uuidAliases.
Alias-only match не равен отсутствию canonical row; повторные matches читаются
страницами в canonical order. `aliases:false` по-прежнему ищет только UUID.
Этот индекс не доказывает tag/text/tool-result coverage и не заменяет полную
durable metadata проекцию в её нынешних consumers.

Primary History не строит дополнительный полный Set durable UUID при adoption.
Rewind проверяет точный UUID через `hasCanonicalUuid` и final canonical index
только для signed durable cursor, включая скрытые Rewind/suppression строки.
Merged live metadata и окно не доказывают canonical presence. Отмена, смена
владельца или отказ query не превращаются в отсутствие. Для ID вне find wire
limits SOURCE26.10 читает signed durable descriptors порциями до3 строк и только
поле UUID; подходящий текст сверяется по полным UTF16 units независимого leaf,
до1024 units за чтение. Non-owning probe не закрывает shared parent при отказе;
отмена/смена cut/UNKNOWN не дают false или повтор. Canonical hidden/suppressed
строки остаются членами, alias-only и merged-live строки — нет. Prepared native
metadata graph сохраняется для своих consumers; canonical renderer graph снят
отдельным validation fact. Legacy/composite Set прежний.

Prompt adoption имеет более узкую identity-семантику, чем общий final index:
только uuid/sourceIdentity и Array sourceIdentityAliases/sourceUuidAliases.
SOURCE26.10 отдельный `primary-prompt-identity` требует producer proof
`canonical-prompt-identity-v1`; generic find по новому имени поля недопустим —
старый worker мог успешно вернуть empty для отсутствующего поля. Index даёт
кандидатов, затем проверяются полные pre-overlay semantic fields; thin metadata
может не содержать alias. Для длинного ID signed scan cursor читается порциями,
а возвращается metadata descriptor точного canonical ordinal. Чужой token/cut,
старый protocol, UNKNOWN и отмена — ошибки, не negative proof и не fallback.

Обычный primary `hasDurablePrompt` с audit UUID/source identity использует этот
асинхронный point proof; все recovery decisions ожидают его результат. Отдельный
layout owner и demand cancellation отсеивают смену tab/session/header; body-only
уведомление не отменяет чтение. Локально branded read failure сохраняет pending,
останавливает fallthrough к новому query/refresh и не перезаписывает новый draft;
уже захваченный staged transfer восстанавливается прежним CURRENT merge. Только
полный известный negative допускает прежнее однократное fresh History чтение.
На этом срезе no-exact-ID text matching и оба metadata decoder оставались OPEN;
более поздние primary prompt adoption и canonical fact описаны выше. Legacy
по-прежнему использует свой native matcher.

Primary durable tool-result coverage также не выводится из thin metadata:
в ней нет полных actions. SOURCE26.10 существующий read-page protocol сверяет
до3 captured claims с held pre-overlay semantic actions. Signed key descriptor
и полный typed UTF16 SHA связывают proof с CURRENT результатом перед удалением;
внешняя смена owner/Map/cut/request или изменённое значение сохраняют новый результат.
Task canonical alias, strict raw-result/error и resultRef сохраняют разные
прежние predicates. Нет fallback/retry после ошибки, demand не закрывает root
или независимый Full. Пока это полный paged scan на claim, не O(1) lookup и не
устранение всех IDs/metadata либо одного большого native result.

Собственное retirement каждой страницы не должно заново запускать этот pass.
SOURCE26.10 держит текущую рабочую Map отдельно от неизменённой state-owned Map,
публикует валидный результат один раз при завершении/отмене и хранит только
точную receipt этой собственной публикации. Внешняя Map, новый header или owner
создают новую работу; body-only window revision её не перезапускает. На конечных
9 claims запросы9→3, публикации3→1; это Source work, не native latency.

Исторические Codex settings нельзя выводить из content-less durable stubs.
SOURCE26.10 `primary-effective-settings` читает held pre-overlay semantic rows
через тот же подписанный lease и возвращает до2 исходных slash-text descriptors
и глобальный max proofAt. Reader и renderer переиспользуют неизменённый reducer
из packaged `src/shared/codex-history-effective-settings.mjs`; settingsFact и
settings-before не заменяют его predicate. Root model готовит значение до adoption,
pure-view metadata hit сохраняет его identity без нового settings query/decode. Применение
по-прежнему сверяет текущий SID и более новые picker/history proofs. Полные
native content/timestamp одной slash-строки остаются явным OPEN single-value sink;
prepared metadata graph и global memory bounds этот settings-профиль не устраняет.

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
временные codec buffers могут занимать больше во время записи. Перезапуск
приложения и Build Install кэш НЕ сбрасывают: он переживает их, а смена сборки
создаёт новый каталог версии рядом. Цена промаха измерена на установленной
сборке31.10: `LOAD_APPLY elapsedMs=1457…1665` против `elapsedMs=56` при попадании. Save, удалённый
quota-prune, не подтверждает сохранение. Кэш можно потерять без потери истории.
Legacy payload caller без ожидаемого поколения всё равно проверяет текущий
источник до RAM/SSD-hit; отсутствие этого аргумента не разрешает старый текст.

Готовые rows, тяжёлые continuation/payload и компактные Timeline/source-proof
хранятся тремя независимыми SQLite families одного owner. Имя каталога версии
содержит хеш исходников парсера (`history-read-worker.js:69`,
`'1-' + sha256(все .js в src/main).slice(0,20)`), поэтому каждая сборка начинает
с пустого кэша, а каталог прежней сборки прочитать нельзя никогда. С31.10 prune
собирает такой каталог СРАЗУ, не дожидаясь давления по квоте, и удаляет
опустевший каталог версии; до этого мёртвые версии ждали квоты и занимали
14.4ГиБ из20 (замер31.10: 58 каталогов, непустых4 — 7457МБ и6932МБ мёртвых
против4763МБ текущей; `prune` печатал `diskBytes=21462978560`
`budgetBytes=21474836480` `evictedCount=0` `reason=within-budget`), то есть живая
сборка вытесняла собственные чтения ради нечитаемых данных. Файл под активным
чтением по-прежнему только помечается к удалению и собирается следующим проходом;
каталоги вне шаблона версии (`paged-read-plane`) не трогаются. Причины в
диагностике разделены: `obsolete-version` против `disk-quota` — иначе сбор мёртвой
версии выглядел бы как переполнение диска. Среди тяжёлых файлов prune учитывает
давность owner и защищает записываемый owner, у него checkpoint вытесняется
перед rows. Compact Timeline
и source certificate идут последними. Глобальное «все checkpoints первыми»
оставляло бы старые страницы ценой постоянного rebuild рабочей сессии при append.
Все tiers вместе ограничены общим quota (default20GiB); oversized/zero quota сохраняют canonical fallback.
Invalidation источника отзывает все tiers owner, включая незавершённый async
page-write. Corruption одной family не уничтожает независимую корректную family.
Диагностика отдаёт cacheTier и отдельные obsolete/state/rows/timeline eviction counts.

Подтверждение сбора мёртвых версий на установленной сборке (01.11, app.asar
00:58, boot `mvwpg60c`): каталог кэша21ГБ → **1.7ГБ**, из58 каталогов версий
остался один живой (`v1-68669387…`, 700МБ) плюс `paged-read-plane` (1025МБ).
Распределение внутри живой версии прежнего замера:ready rows 3015МБ,
heavy state 2172МБ, compact timeline 57МБ на20 owner. Объём источников для
оценки потолка: `~/.codex/sessions` 17.8ГБ в239 файлах (отдельные0.5–1ГБ),
`~/.claude/projects` 431МБ; разобранная форма занимает примерно треть источника
и только для реально открывавшихся вкладок, поэтому20ГиБ хватает с запасом.

Состав хеша версии: 132 модуля (весь `require.cache` воркера из `src/main`),
то есть правка ЛЮБОГО модуля main — включая не относящиеся к разбору истории —
обнуляет кэш. Статическое замыкание воркера146 модулей, из них к представлению
относятся80, то есть сузить хеш технически можно на66 модулей. Это НЕ сделано
намеренно: часть разбора Codex (`codex-result-reader`, `codex-root-*`,
`codex-rollout-*`, `codex-turn-outcome`) лежит вне «представленческого»
замыкания, и их правка меняет интерпретацию уже сохранённых строк. Сужение
хеша без явного перечня «модулей, влияющих на интерпретацию» вернуло бы ровно
тот класс бага, от которого хеш защищает — показ истории, разобранной чужой
версией. Цена промаха кэша измерена и ограничена: `LOAD_APPLY elapsedMs`
1457–1665ms против56ms на попадании, то есть это разовая задержка открытия
вкладки после установки, а не постоянная.

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
Для capability RPC SOURCE добавляет к прежней correlation только opaque lease,
известный page kind/Timeline operation и encoding fork. Это связывает ожидание
страницы с уже выданным root; node token и тела не читаются для диагностики.
Частота событий, квоты, FIFO/admission и source authority не меняются.
SOURCE26.10 installed root-capability reads упорядочиваются по проверенному
native lease вместо случайной общей очереди `[null,null]`. Иначе готовый frozen
Timeline мог ждать fork другого parent, который сам ожидал maintenance. Lookup
читает только существующий plane/state и не создаёт backing/source. Dispatch
повторно проверяет capability; ошибочный или освобождённый root идёт прежним путём.
Для allocator сохраняются обе predecessor edges — прежняя source/null и lease;
явные SID/CWD у capability тоже сохраняют source edge. Все edges публикуются
до await в прежней queue map. Cold/maintenance FIFO, byte credits, independent
document leases, cancellation и UNKNOWN не меняются. Конечный Source control
проверяет это с SQLite-adapter; native latency и общий peak RAM из него не следуют.
Следующий SOURCE cut допускает только проверенный уже установленный TEXT pin
мимо долгой maintenance preparation: backing и SQL должны быть готовы, открытой
транзакции и полного collector быть не должно. Все source/null+lease edges и
allocation classification остаются прежними. Полный collector удерживает это
исключение выключенным до своего success/error/cancel; новые fast pins иначе
сбрасывали бы mark на каждом yield. V8/unit/memo forks идут прежним admission.
Pin/install остаются в прежней quota-проверяемой SQL transaction с root-cap и
opening reservations. При rollback освобождается также локальный lease handle;
ошибка не превращается в повтор. Это не отменяет существующие query pins и не
доказывает global starvation/RAM bounds.
Finite HTTP read дополнительно связывает logical read и physical GET attempt с
этим RPC tuple исключительно через diagnostic envelope, не service payload.
Worker boot/import/DB-ready, source-epoch wait, session/cold admission и work/reply
имеют begin/progress; emitted и Main-received времена различаются. Diagnostic
callback не обходит final source fence: синхронный invalidation остаётся отказом
с прежними максимум тремя попытками. Disconnect HTTP не cancel-all worker.
Новые подробные фазы ограничены и включаются для HTTP, а не каждого desktop read;
их доставка через Main не является независимым свидетельством при его паузе.
HTTP finish, потери и проверка реальными host socket/Worker —
`fact-mobile-web.md::Конечные HTTP-чтения: подготовка не равна доставке`.
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
После ремонта19.09 default source-reader потоково извлекает root metadata, последний
структурный model/effort и точное наличие user-turns. Общие reducers сохраняют
pairing, Fork/compact/rollback и отказ на более новую неполную настройку;
tool/assistant/replacement-history payload не накапливается в массиве Resume.
У неизменной физической версии возвращается компактный proof без I/O. При
смене path/inode/size/mtime/ctime проход повторяется: один рост файла не
доказывает append, а произвольный хвост может не содержать последние настройки.
Fork сохраняет полный source для точного lineage snapshot.

22Oct обычный Resume отделён от этого полного пересчёта: launch-purpose reader
сначала проверяет64КиБ header +2МиБ tail на той же физической версии. В памяти
только bounded bytes и один canonical положительный user witness после последнего
rollback; body/UUID/локальный индекс окна не выдаются за полную историю. Последний
структурный settings-кандидат берётся прежним reducer; его source byte offset
известен, полный recordIndex=null. Whole-file counts остаютсяnull, exact views
этим результатом не заполняются. Малый файл/готовый exact cache идут прежним путём;
при недостаточном окне прежний streaming fallback сохраняет empty/thin/Fork/
rollback/settings capabilities. Поэтому full scan НЕ устранён для каждого файла.
Диагностика `CodexResumeSource launch-window` разделяет sourceBytes/read bytes/
counts unknown; `launch-fallback` называет причину. Повтор при изменившейся версии
может прочитать несколько окон, но не возвращает устаревшую пару.
Private Node22 discriminator: валидный33557342-byte файл с tool rows — прежний
код прочитал33557342B, launch-window2162688B. Это I/O proof на собственной finite
fixture, не замер установленного HH5957/CLI latency и не доказательство ремонта
его cold Send. Проверки — `codex-resume-launch-source.test.js` и Main-prefix
`codex-resume-source.main.test.js`; full/default parity тесты сохранены.

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

SOURCE28.10 ordinary desktop уменьшает прежний запас750строк с каждой стороны
и хвост300 до viewport-sized окна с запасом16 и хвостом32. Начальные16 всего
почти целиком занимались viewport и давали miss уже на втором обычном wheel;
32 включают экран и соседний запас. Широкий viewport
увеличивает radius до покрытия всех реально показанных членов/captions; скрытые
члены закрытой группы не создают две конкурирующие цели подгрузки. После смены
окна delta передаёт также новые stubs для прежних full rows: старые тела должны
исчезнуть из текущего snapshot, а не накапливаться по мере посещений. Явные
Timeline/search/caption запросы сохраняют exact UUID. Публичные Main defaults
и Full/Copy не сокращаются вместе с desktop request.

Покрытый viewport не строит новый all-history UUID Map при каждом скролле.
Только фактический visible miss переводится в raw positions одним проходом,
с временными ключами лишь текущего диапазона. Полный компактный positional
array остаётся отдельной стоимостью; это не universal O(viewport) или общий
RSS bound. Незавершённая работа может держать строки вне обычного окна.

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
Source-ремонт25.10 включает `updated_at` в hash и update-trigger: session lookup
читает кандидатов по этому полю, а для одинакового `entry_uuid` последний
кандидат побеждает. Поэтому один upsert без изменения chips способен поменять
видимую пометку. Прежнее исключение для timestamp-only update было неверным.
Memo принадлежит точному SQLite connection; замена соединения не наследует его.
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

Выбор уже bound timing идёт по UUID шире списка captured sessions. Поздний
primary interval либо alias в другой session может победить по `endTs`, поэтому
одних tab/session counters недостаточно. Source25.10 добавляет transactional
provider counter, включая primary/alias и joined interval insert/update/delete
с OLD/NEW связями; SQL-выбор не сужается ради кэша. Чужое UI-сохранение по-прежнему
не меняет attested scoped witness. Unknown/custom DDL остаётся консервативным,
а reader не выполняет миграции. Новый scalar-vector также участвует в typed
late-supersession: старый frozen view сохраняется, новый кандидат не публикуется.
Это подтверждено двумя реальными SQL counterexamples и Source-интеграцией;
не утверждение об уже обновлённой пользовательской установке.

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

Тот же getToolPayload проверяет exact row/ref/hash. Source22Oct direct physical
miss при сохранённом backend binding (owner/source/row/generation/hash и точный
origin call/line) читает и хеширует leaf частями, затем атомарно восстанавливает
payload cache. Source replacement/cancel/hash/storage failure не стирает прежний
committed body. Размер BLOB проверяется до bounded substr, не после native getter.
Без proof physical equivalence сохраняется canonical fallback;
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

SOURCE26.10 raw Codex append обходит полные строки непосредственно в уже
проверенном batch, без массива Buffer-view для всех строк. Порядок callbacks,
UTF-8 carry, точные byte spans и source-ticket guards сохраняются. Полный append
Buffer и одна большая физическая запись пока остаются native owners: устранение
массива ссылок не делает весь этот read path ограниченным по памяти.

См. `fact-timeline.md::Визуальный фидбек и навигация`, `fact-codex.md::Timeline и History`, `fact-mobile-web.md::Bridge pattern`.
