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
- `tool_result`, Codex `function_call_output`/`custom_tool_call_output`, `<local-command-stdout>`, `<system-reminder>`, caveat/stdout wrappers → service-noise, не History и не Timeline.

Шрам 2026-07: live Codex projection уже считал `reasoning` и tool output transient, но REST `getMessages` возвращал их как обычные сообщения. После reload/iOS snapshot History видел строки, которых live-путь не показывал. Правило: REST snapshot обязан применять ту же display-классификацию, что live SSE; reasoning/tool-output можно логировать как процесс выполнения, но нельзя превращать в пользовательскую историю.

Команда и аргумент рендерятся раздельно (`/model haiku`, `/effort low`), а не склеиваются в camel-case (`/modelHaiku`). Источник ввода тоже не часть display-семантики: если manual slash и auto/default slash дают одну и ту же durable-запись, History показывает их одинаково. Route (`manual`, startup defaults, iOS, History) можно логировать как source для диагностики, но нельзя делать по нему другой UI.

Старый шрам: во время streaming пользователь отправил `Stop`, а iOS показал это слово как часть assistant-ответа, потому что live SSE классифицировал raw `tool_result`/queued payload не по пользовательскому смыслу. Обратный шрам: `/model haiku` и `/effort low` на fresh Claude появлялись как фиолетовые строки и исчезали после reload, потому что live-путь и `/history` фильтровали по-разному. Любое новое display-событие должно пройти один server-side projection path, иначе iOS, Inbox и History снова начнут расходиться.

## Границы миграции

Claude full History пока остаётся на совместимом `claude:get-full-history` path, потому что там есть отдельная recovery-логика parentUuid/backtrace/chain-break. Нельзя заменить его на простой `parseTimelineEntries` ради унификации: сначала нужно доказать парность recovery с HistoryPanel. Сервис уже может invalidation/watch для Claude и timeline snapshot, но robust Claude full-history — отдельная миграция.

Codex, наоборот, должен идти через сервис для Timeline/History/message snapshots: rollout shape один и тот же для desktop, Project API и iOS, а `agent-transcript:get-timeline/get-history/get-messages` защищают от расхождения между поверхностями. Legacy `codex:get-timeline` / `codex:get-full-history` могут оставаться compatibility entrypoints, но новый код не должен добавлять третий независимый polling reader.

## Resolved-path memo (правый клик и переключение вкладок)

Discovery файла сессии (`findCodexSessionFile` — полный walk `~/.codex/sessions` с чтением metadata-head; сотни rollout, десятки >100MB) стоит ~400мс main-loop. Прод-шрам 2026-07-25: каждый ВОЗВРАТ на вкладку платил этот walk заново — уход с вкладки снимает последнего consumer, `_closeState` закрывает state, resolved path терялся; правый клик по вкладке, попавший в это окно, открывал контекстное меню через 200-380мс (замерено бимодально: 75мс вне окна / 200-380мс внутри). Фикс — memo на двух уровнях: `resolvedPathCache` в самом сервисе (`toolType:sessionId → filePath`, переживает teardown state) и `codexSessionFilePathMemo` внутри `findCodexSessionFile` (закрывает остальные call-sites: timeline, hover, history, overseer). Обоснование безопасности: rollout/JSONL никогда не переезжает после создания; existence перепроверяется `fs.access` перед reuse, исчезнувший файл падает на обычный walk. После фикса повторные переключения дают 57-85мс на открытие меню.

Атрибуция «медленного subscribe»: `[Perf:IpcSlow] channel=agent-transcript:subscribe` меряет invoke→ответ, то есть включает очередь за чужим main-блокером. Проба `[TranscriptService:SubscribeSlow] ensureMs=…` печатается только когда СОБСТВЕННАЯ работа handler'а превысила 50мс: IpcSlow без этой строки рядом = виноват сосед (искать по `MainLoopGap.ops`), с ней = реальный медленный `_ensureState`.

## Тёплая пауза наблюдения (park/unpark)

Уход последнего consumer'а раньше немедленно уничтожал state — и возврат на вкладку заново читал тот же файл целиком, хотя фоновая подписка секунду назад держала данные актуальными (прод: девять переключений за 11с → LongTask 1088мс на полных перечитках при готовом кэше). Теперь state переходит в «тёплую паузу» на 90с: файл не перечитывается, но и НЕ публикуется наружу — иначе фоновая сессия кормила бы событиями подсистемы, для которых её никто не показывает. Возврат внутри окна забирает то же состояние и один раз догоняет пропущенный хвост. Спящих сессий максимум восемь, самая старая вытесняется. Логи: `[TranscriptService:Park] reason=no-consumers graceMs=90000` / `[TranscriptService:Unpark] idleMs=`.

Дешёвая проверка ревизии на возврате — отдельный слой и он работал ещё до park (за сутки 142 обновления с токеном ревизии, 73 ответа «не менялось»); park лечит именно случай реально изменившегося файла, где ревизия не спасает. Stats-only пути «не изменилось» для Claude (probe истории, unchanged timeline) — см. `fact-история-производительность.md::Main-процесс`.

## Codex incremental cache

Codex rollout читается инкрементально: unchanged `size+mtimeMs` возвращает cache, append читает только новые байты, незавершённая строка переносится через `leftover`, shrink/rewrite делает полный reread, concurrent callers одного файла получают один inflight promise. Это нужно не ради микрооптимизации, а чтобы один и тот же большой rollout не парсился заново для Timeline, History, iOS и tooltip/hover запросов.

Холодный/rewrite-путь тоже chunked, а не `readFile(..., 'utf8')`: live rollout 582+ MB воспроизводимо падал с `RangeError: Invalid string length` ещё до группировки. Chunked reader сохраняет physical line numbering, incomplete UTF-8/JSONL tail и коммитит append-записи в cache только после успешного EOF. Async I/O сам по себе не защищает от string-limit и allocation spike.

Полный records-cache ограничен LRU в шесть файлов и 768 MiB raw bytes. Лимит три файла вытеснял активный 73-MB rollout между его собственными History/Timeline/usage-запросами, превращая каждый append в новый полный parse. Один oversized active rollout может превысить byte-budget и остаться в cache: выкидывать его значило бы повторять сотни мегабайт при каждом клике. Discovery не использует этот cache: он читает bounded metadata-head до первой non-metadata записи. Эти два пути нельзя снова сводить в один parser.

Размер файла на диске отдельно ограничен 1.5 GiB, но главный memory-repair происходит раньше JSON.parse. В top-level `compacted` inline `data:image/...` заменяется на `[image omitted]` прямо в сырой строке: эти картинки и так никогда не показывались, а рекурсивные compact-снимки копировали один screenshot много раз. На реальном rollout 1340 MB это снизило дополнительную память разбора примерно с 1725 до 532 MB при том же числе записей. Обычные user-image не режутся. Parsed/UI-слой и persistence-слой намеренно различаются: Fork/Edit/Delete потоково восстанавливают raw data URL по file byte ranges + SHA-256 и fail-closed при изменившемся source; запись literal `[image omitted]` в child делает его не-resumable. Точный write-контракт — `fact-codex.md::Timeline и History`.

Логи для диагностики: `[CodexJsonlCache] full/append`, `[TranscriptService:Subscribe]`, `[TranscriptService:WatchStart/WatchStop]`, `[TranscriptService:Changed]`, `[TranscriptService:CodexDelta]`. Если iOS видит loader, но не видит новые строки, разделяй два слоя: `transcript-changed` доказывает invalidation snapshot'а, а `[WebBcast:SEND] type=message` от CodexTurn watcher доказывает live fan-out конкретных rows. Для Codex `TranscriptService:CodexDelta sent=0` вместе с `suppressedLiveMessages`/`skippedLiveUsers` — ожидаемое состояние, не ошибка: сервис увидел append и инвалидировал snapshots, но не стал вторым live-stream.

## Ресурсная модель большой сессии

Пользовательский симптом: dev Electron в один момент занял около 19 GB, а при открытии известной длинной сессии Timeline несколько секунд выглядел пустым. Сам пик 19 GB не был снят live-sample'ом, поэтому нельзя писать, что он полностью объяснён или что controlled stress-test уже прошёл.

Механизм умножения памяти доказан отдельно. Инцидентный rollout был около 609 MB / 32 тысяч records; streaming-аудит нашёл около 169 MB raw tool-result и 268 MB raw `replacement_history`, а eager History projection содержала около 179 MB текста ещё **до** JS object overhead, IPC structured clone и renderer state. В логе полный cache-read был около 511 110 KiB, Timeline snapshot занял 2.27 с, рядом main RSS был около 2.3 GB и heap около 1.6 GB. Другие boot-проходы полностью читали 1.3–1.75 GB посторонних rollout ради discovery.

Виртуализация History ограничивает DOM, но не parser cache, не full projection, не IPC-копию и не удержанные renderer snapshots. Поэтому `Virtuoso`, `startTransition` и GPU-spinner не являются memory-fix. Так же LRU не убирает базовую стоимость одного active 609-MB файла; он убирает неограниченное накопление чужих sessions.

Текущий capability-preserving repair убирает множители:

- discovery и full parsing разделены, full cache bounded;
- Timeline, History и Codex presence держат один request в полёте и максимум одну trailing reconciliation. Invalidation, пришедшая во время активного чтения, не считается уже покрытой первым snapshot: watcher запоминает её и запускает ровно одно дополнительное чтение после завершения первого. То же правило действует при смене presence-generation во время IPC: текущий flight сам взводит повторное чтение, иначе спокойная остановленная вкладка навсегда остаётся в `Checking` до remount. Read-only presence берётся из main-owned event projection; тяжёлое process/materialization observation не является UI-refresh endpoint. Удалить trailing или молча отбросить такое событие значит оставить последний append или lifecycle edge невидимым до следующего внешнего изменения;
- History не держит вторую полную server-entry copy только ради Rewind convergence; для membership достаточен UUID set;
- повторное открытие History сначала показывает renderer snapshot, а main проверяет durable revision до parse/projection; unchanged-ответ не переносит полный массив через IPC;
- Timeline показывает owner-keyed initial loader до первого snapshot, а background refresh оставляет уже известные rows видимыми;
- History публикует новый surface owner только вместе с его rows/loading. Раздельные state-переходы давали один кадр `новый owner + пустые старые rows + loader уже скрыт`, поэтому пользователь видел белую пустоту вместо объяснимого ожидания;
- Prompt Summary генерируется последовательно, а не сотнями параллельных AI-вызовов.

Renderer snapshot ключуется всей identity `tab + tool + session + cwd` и ограничен одновременно 64 MiB, 40 тысячами rows и восемью owners. Вытесняется целый least-recent owner, а не хвост отдельной истории: молчаливое усечение внутри session изменило бы смысл History. Snapshot сохраняет уже построенные сырые server rows без второй глубокой копии.

Текущая row-window модель desktop не является возвращением удалённых display-only окон. Позиционный массив всегда полный; вне читаемого диапазона тяжёлый payload заменён identity-stub, поэтому UUID-порядок, scrollbar, restore и Timeline addressing не меняются. Tail и незавершённая фоновая работа остаются полными, а перемещение окна проходит обычной delta. Группировка обязана быть структурно одинаковой на stubs и full rows.

Byte-limit не должен создавать cliff на больших сессиях. Обычный LRU остаётся строго ограниченным, а отдельный oversized-pool хранит не больше трёх последних exact-snapshot без копирования массивов и имеет собственный общий byte-budget 360 MiB. Три слота нужны именно для A → B → C → A между реально большими сессиями; 240 MiB не удерживал наблюдаемую пару примерно по 150 MiB, и два resume/fork owner вытесняли друг друга. Четвёртый oversized owner вытесняет least-recent целиком. Повышать обычный budget или оставлять oversized-chain без независимых лимитов означало бы вернуть неограниченное накопление памяти.

Streaming projection обязана одновременно замечать содержательные изменения и сохранять identity неизменившихся строк. Сравнение History-row включает tool result/status, thinking, actions и остальные поля presentation: сравнение только по `uuid/type/content` оставляло pending-карточку вечной после прихода результата. Но полностью пересоздавать все объекты на каждом append тоже нельзя — Virtuoso заново рендерит большую ленту. Для Codex pending и completed tool-card получают UUID из исходного call identity; output-line не создаёт новую карточку, иначе раскрытие и локальное состояние теряются в момент завершения.

Desktop History не добавляет live-события в полный durable snapshot и не копирует его на каждый append. Вместо отдельного footer-overlay durable- и live-записи собираются в один presentation-массив Virtuoso: durable выигрывает по физической source identity, а только ещё не материализованные live-записи остаются обычными строками того же списка. Один assistant-source получает стабильный ключ, поэтому переход live → durable не создаёт промежуточную пустую поверхность. Отдельный footer был отброшен: высокий live-ответ мог удерживать будущую durable-строку вне overscan и тем самым блокировать собственный DOM-handoff. Результат инструмента связывается с durable action через одинаковый канонический `toolUseId`; потеря этого поля в parser заставляет live-строку остаться unmatched и повторять тяжёлые refresh, хотя карточка уже существует.

Порядок локальной очереди является частью той же проекции. Prompt, поставленный во время busy-turn, располагается после текущего live-ответа; после доказанного перехода в `sent` он получает exact rollout source identity и занимает место по физическому byte offset, а не по времени появления optimistic-карточки. Это важно для auto-compact: top-level `compacted` может физически появиться между Enter и следующим `user_message`, поэтому CodexTurn watcher сразу отдаёт History лёгкий compact-marker без тяжёлого `replacement_history`; durable compact затем заменяет его по той же identity. Полный History во время busy-turn ради этого не перечитывается. Иначе единый список устраняет моргание, но причинно переставляет compact, вопрос и ответ до следующего remount.

Нормальный streaming-follow имеет одного владельца — `Virtuoso followOutput`. Параллельные ручной `scrollToIndex` и отложенный pixel-scroll создавали разные clocks до и после измерения высоты строки и визуальное движение вниз-вверх-вниз. Они не участвуют в live-streaming: отдельный scheduler остаётся только для изменения высоты composer, а двухэтапный переход — для явной пользовательской навигации. Пользователь, ушедший вверх, прекращает follow; пользователь у хвоста остаётся у нового конца без дополнительного таймера.

Durable revision строится из identity и метаданных реально прочитанных JSONL/rollout sources (`path + size + mtime`). Для Claude в неё также входят topology resume/clear-context chain, discovery-состояние директории и editable-last-prompt presentation state: неизменившийся primary JSONL сам по себе не доказывает, что не появился child или не изменился SQLite link. Проверка переживает restart main process и не зависит от watcher counter в памяти.

Локальные `sending/queued/sent`, rewind marker, handoff metadata и временные suppression не входят в durable snapshot. Они живут в отдельном LRU-overlay с лимитами восемь owners / 512 элементов / 2 MiB и восстанавливаются при переключении вкладки. Смешать их с server rows опасно в обе стороны: локальный prompt пропадёт на remount до записи в transcript, а suppression-filtered server array может навсегда скрыть строку после истечения TTL. Ближайшее истечение suppression запускает одноразовую reconciliation из raw snapshot; постоянный timer polling не нужен.

Timeline не снимает busy-дефер этого сервиса ради одного нового prompt. После
exact SENT targeted History projection дополняет общий handoff canonical UUID
до presentation consume, и Timeline временно добавляет только bounded
user-marker. Следующий обычный snapshot заменяет его по UUID/source alias. Это
presentation-overlay, а не второй transcript reader и не отдельный polling
clock.

Каждая committed привязка History к owner получает монотонное поколение. Проверка только по owner-key недостаточна для A → B → A: поздний ответ первого A снова совпадёт по ключу и перетрёт более новый A. Любая state/cache write после async должна подтвердить и key, и generation.

**Дегидрация тяжёлых payload (реализовано).** Tool-результаты/thinking/compact больше порога (16KB) покидают main как превью 2KB + детерминированная ссылка (`result:<tool_use_id>` / `thinking:<uuid>` / `compact:<uuid>`); полный текст renderer получает по требованию через `history:get-tool-payload` при раскрытии карточки (render-cap 4MB на один проход, «сколько скрыто» пишется в самом превью). Это не молчаливое truncation: preview+identity сохраняют доступ к полному результату. Оригиналы — в общем byte-bounded stash (`history-payload-dehydrate.js`, LRU 192MiB); stash-miss для Codex перезапускает проекцию (records LRU-кэшированы), для Claude — точечный re-extract из recordMap включая склейку background-notification (`rebuildHistoryPayloadStash`), потому что payload identity детерминирована per source record. **Дегидрация строго opt-in per call** (`dehydrate: true` шлёт только desktop HistoryPanel): web/iOS/Timeline потребители тех же каналов получают полные payload, пока не заведут собственный rehydration-путь — молча выдать им превью было бы capability downgrade. Compact у Claude не дегидрируется (короткая проза + branch look-ahead extraction); у Codex — дегидрируется (replacement_history бывает сотни MB). Смежное правило для live-overlay: durable-строка с `resultRef` покрывает live tool-result по факту наличия ссылки, не по равенству текста — иначе превью никогда не совпадёт с полным live-текстом и reconcile зациклит refreshes.

**Кладбище: tail-window и reading-window (реализованы 25.07, удалены 26.07).** Две механики «показать короткий массив мгновенно, затем подменить целым» — хвост ~120 записей и mini-кэш видимого фрагмента. Они почти не экономили parse, но создавали шов с тёмным кадром, прыжком viewport и порчей позиции; оба пути также обходили viewport-proof. Не путать их с нынешними stubs полного позиционного массива: там нет подмены списка и перенумерации. Допустимый display-only survivor — rewind-префикс внутри одной вкладки с writer proof. Не возвращать короткие массивы «для скорости» без замера реального bottleneck.

## Связанные поверхности

Timeline и HistoryPanel подписываются отдельно, но на один service-key. HistoryPanel сохраняет свои локальные handoff rows и prompt merge через `loadHistory(true)`; сервис не должен знать о presentation-state. Project Terminal API использует тот же слой как pure-server read path: bridge нужен для Zustand/tab actions, но не для чтения durable transcript. Claude PTY live-message watcher из `fact-mobile-claude-pty.md` остаётся отдельным live tail каналом до полной миграции; не смешивай его с shared invalidation contract.

См. `fact-timeline.md::Визуальный фидбек и навигация`, `fact-codex.md::Timeline и History`, `fact-mobile-web.md::Bridge pattern`.
