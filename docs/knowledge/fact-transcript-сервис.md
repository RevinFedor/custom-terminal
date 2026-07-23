# Fact: Transcript Service

`SessionTranscriptService` — main-process слой инвалидации и snapshot-чтения для AI-транскриптов. Он появился не как ещё один parser, а как архитектурная граница: desktop Timeline, Cmd+] HistoryPanel, Project Terminal API и native iOS должны смотреть на один durable источник (`~/.claude/...jsonl` или `~/.codex/...rollout-*.jsonl`), а не держать собственные polling-loop'и с разной частотой и разными cache-предположениями.

Пользовательский симптом старой модели на больших сессиях: Timeline кликался быстро, но на историях в несколько сотен итераций переход в History иногда «ничего не делал», а после успешного перехода немедленный ручной scroll мог дёргаться. Отдельный desktop polling (Timeline ~2с, History ~3с) и mobile/API чтение создавали несколько независимых readers одного файла; на Codex rollout это особенно больно, потому что один `replacement_history` или длинный tool-output превращает полный read/parse в заметную паузу main process.

## Контракт

- Ключ подписки — `toolType + sessionId + cwd`, consumer — явный `consumerId` (`timeline:<tabId>`, `history:<tabId>`, web subscriber). Один файл получает один watcher и ref-count по consumers; последний unsubscribe закрывает watcher.
- Сервис шлёт lightweight invalidation, а не готовый UI-state: renderer получает `agent-transcript:changed`, web/iOS получает SSE/WS событие `transcript-changed`. После этого surface сам запрашивает нужный snapshot (`get-timeline`, `get-history`, `get-messages`) и сохраняет свою локальную логику merge/optimistic rows.
- Для Codex live-chat `type:'message'` не входит в контракт Transcript Service. Его единственный владелец — CodexTurn watcher в `main.js`, который нормализует `event_msg.user_message` и `response_item` в SSE `message`; Transcript Service для Codex только держит cache/watch и шлёт `transcript-changed`. Если оба слоя параллельно фанят `message`, native iOS получает дубль одного prompt'а с разными uuid.
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

## Codex incremental cache

Codex rollout читается инкрементально: unchanged `size+mtimeMs` возвращает cache, append читает только новые байты, незавершённая строка переносится через `leftover`, shrink/rewrite делает полный reread, concurrent callers одного файла получают один inflight promise. Это нужно не ради микрооптимизации, а чтобы один и тот же большой rollout не парсился заново для Timeline, History, iOS и tooltip/hover запросов.

Холодный/rewrite-путь тоже chunked, а не `readFile(..., 'utf8')`: live rollout 582+ MB воспроизводимо падал с `RangeError: Invalid string length` ещё до группировки. Chunked reader сохраняет physical line numbering, incomplete UTF-8/JSONL tail и коммитит append-записи в cache только после успешного EOF. Async I/O сам по себе не защищает от string-limit и allocation spike.

Полный records-cache ограничен LRU в три файла и 768 MiB raw bytes. Один oversized active rollout может превысить byte-budget и остаться в cache: выкидывать его значило бы повторять 600-MB parse при каждом клике. Discovery не использует этот cache: он читает bounded metadata-head до первой non-metadata записи. Эти два пути нельзя снова сводить в один parser.

Логи для диагностики: `[CodexJsonlCache] full/append`, `[TranscriptService:Subscribe]`, `[TranscriptService:WatchStart/WatchStop]`, `[TranscriptService:Changed]`, `[TranscriptService:CodexDelta]`. Если iOS видит loader, но не видит новые строки, разделяй два слоя: `transcript-changed` доказывает invalidation snapshot'а, а `[WebBcast:SEND] type=message` от CodexTurn watcher доказывает live fan-out конкретных rows. Для Codex `TranscriptService:CodexDelta sent=0` вместе с `suppressedLiveMessages`/`skippedLiveUsers` — ожидаемое состояние, не ошибка: сервис увидел append и инвалидировал snapshots, но не стал вторым live-stream.

## Ресурсная модель большой сессии

Пользовательский симптом: dev Electron в один момент занял около 19 GB, а при открытии известной длинной сессии Timeline несколько секунд выглядел пустым. Сам пик 19 GB не был снят live-sample'ом, поэтому нельзя писать, что он полностью объяснён или что controlled stress-test уже прошёл.

Механизм умножения памяти доказан отдельно. Инцидентный rollout был около 609 MB / 32 тысяч records; streaming-аудит нашёл около 169 MB raw tool-result и 268 MB raw `replacement_history`, а eager History projection содержала около 179 MB текста ещё **до** JS object overhead, IPC structured clone и renderer state. В логе полный cache-read был около 511 110 KiB, Timeline snapshot занял 2.27 с, рядом main RSS был около 2.3 GB и heap около 1.6 GB. Другие boot-проходы полностью читали 1.3–1.75 GB посторонних rollout ради discovery.

Виртуализация History ограничивает DOM, но не parser cache, не full projection, не IPC-копию и не удержанные renderer snapshots. Поэтому `Virtuoso`, `startTransition` и GPU-spinner не являются memory-fix. Так же LRU не убирает базовую стоимость одного active 609-MB файла; он убирает неограниченное накопление чужих sessions.

Текущий capability-preserving repair убирает множители:

- discovery и full parsing разделены, full cache bounded;
- Timeline, History и Codex presence держат один request в полёте и максимум одну trailing reconciliation. Invalidation, пришедшая во время активного чтения, не считается уже покрытой первым snapshot: watcher запоминает её и запускает ровно одно дополнительное чтение после завершения первого. Удалить trailing или молча отбросить такое событие значит иногда оставить последний append невидимым до следующего внешнего изменения;
- History не держит вторую полную server-entry copy только ради Rewind convergence; для membership достаточен UUID set;
- повторное открытие History сначала показывает renderer snapshot, а main проверяет durable revision до parse/projection; unchanged-ответ не переносит полный массив через IPC;
- Timeline показывает owner-keyed initial loader до первого snapshot, а background refresh оставляет уже известные rows видимыми;
- Prompt Summary генерируется последовательно, а не сотнями параллельных AI-вызовов.

Renderer snapshot ключуется всей identity `tab + tool + session + cwd` и ограничен одновременно 64 MiB, 40 тысячами rows и восемью owners. Вытесняется целый least-recent owner, а не хвост отдельной истории: молчаливое усечение внутри session изменило бы смысл History. Snapshot сохраняет уже построенные сырые server rows без второй глубокой копии.

Streaming projection обязана одновременно замечать содержательные изменения и сохранять identity неизменившихся строк. Сравнение History-row включает tool result/status, thinking, actions и остальные поля presentation: сравнение только по `uuid/type/content` оставляло pending-карточку вечной после прихода результата. Но полностью пересоздавать все объекты на каждом append тоже нельзя — Virtuoso заново рендерит большую ленту. Для Codex pending и completed tool-card получают UUID из исходного call identity; output-line не создаёт новую карточку, иначе раскрытие и локальное состояние теряются в момент завершения.

Нормальный streaming-follow имеет одного владельца — `Virtuoso followOutput`. Параллельный delayed smooth-scroll создаёт второй независимый clock и визуальное подёргивание при частых append. Пользователь, ушедший вверх, прекращает follow; пользователь у хвоста остаётся у нового конца без дополнительного таймера.

Durable revision строится из identity и метаданных реально прочитанных JSONL/rollout sources (`path + size + mtime`). Для Claude в неё также входят topology resume/clear-context chain, discovery-состояние директории и editable-last-prompt presentation state: неизменившийся primary JSONL сам по себе не доказывает, что не появился child или не изменился SQLite link. Проверка переживает restart main process и не зависит от watcher counter в памяти.

Локальные `sending/queued/sent`, rewind marker, handoff metadata и временные suppression не входят в durable snapshot. Они живут в отдельном LRU-overlay с лимитами восемь owners / 512 элементов / 2 MiB и восстанавливаются при переключении вкладки. Смешать их с server rows опасно в обе стороны: локальный prompt пропадёт на remount до записи в transcript, а suppression-filtered server array может навсегда скрыть строку после истечения TTL. Ближайшее истечение suppression запускает одноразовую reconciliation из raw snapshot; постоянный timer polling не нужен.

Каждая committed привязка History к owner получает монотонное поколение. Проверка только по owner-key недостаточна для A → B → A: поздний ответ первого A снова совпадёт по ключу и перетрёт более новый A. Любая state/cache write после async должна подтвердить и key, и generation.

Базовая память одной огромной active History ещё не устранена. Следующая архитектурная граница — один streaming-проход, который строит lightweight rows и detail index (`byteStart/byteLength/sourceLine/hash`), после чего full tool-output/compact читается по явному expand/Copy. Это не молчаливое truncation: preview+identity сохраняют доступ к полному результату. Desktop, Project API и native/web callers общего full endpoint требуют явной compatibility migration; этот слой пока только план, не текущий факт.

## Связанные поверхности

Timeline и HistoryPanel подписываются отдельно, но на один service-key. HistoryPanel сохраняет свои локальные handoff rows и prompt merge через `loadHistory(true)`; сервис не должен знать о presentation-state. Project Terminal API использует тот же слой как pure-server read path: bridge нужен для Zustand/tab actions, но не для чтения durable transcript. Claude PTY live-message watcher из `fact-mobile-claude-pty.md` остаётся отдельным live tail каналом до полной миграции; не смешивай его с shared invalidation contract.

См. `fact-timeline.md::Визуальный фидбек и навигация`, `fact-codex.md::Timeline и History`, `fact-mobile-web.md::Bridge pattern`.
