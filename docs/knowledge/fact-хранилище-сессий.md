# Хранилище AI-сессий и очистка диска

## Почему сессии занимали десятки гигабайт

Проблема состоит из двух множителей. В длинном Codex rollout каждый top-level
`compacted` хранит `replacement_history` — новый снимок накопленного контекста.
В измеренной сессии размером 1,40 ГБ 64 compact-записи занимали 1,32 ГБ, то
есть 94,1% файла. Затем обычный Fork, Resume-child, Edit Range, Delete Range и
Rewind создают следующий rollout и снова переносят уже накопленные snapshots.

Снимок 23 августа после первой ручной очистки: 2 134 Codex-файла занимали
63,2 ГБ; 899 файлов с `forked_from_id` содержали 57,6 ГБ. 180 файлов крупнее
100 МБ занимали 44,7 ГБ. Prompt images занимали только 122 МБ и не были
причиной переполнения.

Claude хранит transcript в `~/.claude/projects`: primary JSONL, sidechain
subagents, `tool-results` и многочисленные `.bak`/`autorepair`/manual recovery
копии. В том же снимке 484 primary/subagent JSONL плюс recovery/sidecar data
занимали около 2,4 ГБ. Поэтому Storage является provider-neutral поверхностью,
хотя удаление у Claude и Codex физически различается.

## Защита сессий и текущая реализация Storage

- Все сессии открытых вкладок сохраняются без таймера.
- Физические source-файлы, необходимые открытой thin-fork сессии, считаются
  частью открытой сессии и тоже защищены.
- Claude subagent открытой родительской сессии защищён для инспекции.
- Все остальные session-файлы получают полный срок после доказанной потери
  защиты: по умолчанию не раньше 24 часов, не по старому возрасту JSONL.
  Полный Close имеет собственный срок: после него запись исчезает из History
  и больше не участвует в Restore/Shift+Cmd+T. Файлы удаляются прежним provider
  pipeline; источник, нужный другой открытой ветке, остаётся защищён.
- Таймер можно переопределить по группе: 1/3/7/30 дней либо Never.
  Общий `Auto-delete delay` в часах задаёт минимальную отсрочку после потери
  защиты; более длинный срок группы сохраняется, Never отключает автоматическое
  удаление этой группы. Снятие chip с окна при сохранении вкладки в workflow/
  reserve вообще не снимает защиту.
- Expiration переиспользует тот же classifier группы, а не складывает fork/dev
  сроки. Если файл уже отсутствует, происхождение не доказано и relevant группа
  имеет Never, запись сохраняется с `retention-group-unknown`, не угадывается.
- Renderer не решает, что безопасно удалить. Main отдаёт `deletable`,
  `protectedReason`, closure и opaque item ID, затем повторно проверяет версии
  выбранных физических файлов и полный подтверждённый состав удаления.

RAG сохраняется: `storage_expired_tab_history` потребляет право восстановления,
а минимальная исходная строка `tab_history` остаётся владельцем FK поискового
индекса. Retention не вызывает каскадный `DELETE tab_history` и не копирует
embeddings. Крупные restore-поля/планы/notes/snapshot и file-link manifest
очищаются; оригиналы прикреплённых файлов не удаляются. Обычная History,
count/latest/by-id/window undo и архивный title/iteration search исключают
истёкшие записи; независимый transcript RAG не меняется. Отсутствие provider
файла не оставляет вечную запись History, а отказ его удаления не становится
правом raw unlink: оставшиеся источники перечисляются отдельно.

«Убрать из окна» меняет только размещение: вкладка остаётся в боковом списке
workflow/reserve и защищает разговор. Полный Close Tab архивирует вкладку,
убирая её из окон и бокового списка. Эти два действия нельзя смешивать при
объяснении срока хранения. Проверяется весь active membership всех workflow,
включая reserve и stopped, а не видимость окна. SQL membership сам по себе не
доказывает открытость: V2 сохраняет его после Full Close; требуется текущая
execution row с `execution_archived!=1`, как в `catalog-v1`. Один SID в другой
открытой вкладке защищает разговор, не старую закрытую запись с другим tab ID.
Restore lease/созданный restore-owner и живой exact tab повторно проверяются
после awaited audit, внутри транзакции expiration.

Отсутствие сессии в текущей prod DB само по себе не является доказательством
«мусор»: dev/prod имеют разные SQLite, standalone CLI/worktree/subagent могут
использовать общий `CODEX_HOME`. Это не блокирует принятую политику удаления
закрытых данных, но требует provider-side deletion и проверки живых writer
locks вместо raw `unlink`.

## Home UI

Storage живёт на глобальном Home между `MCP servers` и `AI processes`.
Порядок секций отражает причинность: сначала внешние servers, затем их данные
на диске, затем живые процессы. Все три секции используют фон самого Home,
тонкие горизонтальные границы и одинаковые заголовки; отдельной внешней
«window/card» вокруг Storage нет.

Это только визуальный порядок, не общая загрузочная транзакция. Storage
монтируется независимо от process discovery и начинает filesystem scan только
после раскрытия; зависший поиск MCP/AI-процессов не имеет права скрыть disk UI.

Storage имеет четыре вкладки с английскими названиями:

1. `Sessions` — provider switch `All / Codex / Claude`, поиск и сортировка по
   size/date/iterations.
2. `Codex builds` — Cargo debug/release targets, worktree builds, packaged app
   и защищённый installed runtime.
3. `Noted Terminal data` — DB backups, active databases, Chromium caches и
   prompt images.
4. `Test runs` — registered private Noted test profiles, включая packaged `.app`:
   Databases / Conversations / Application builds / Cache, sources & evidence.
   Это учёт всего стенда, не число JSONL и не разрешение удалить остановленный,
   но ещё нужный acceptance profile.

Полностью private E2E публикует небольшой `noted-test-run.v1.json` в своём
дереве; ручных отметок вкладок/новых launch-согласований нет. Existing проверенные
roots могут быть добавлены accounting receipt без запуска приложения.
Discovery идёт по receipts, bounded по directories/depth/profiles; не следует
symlinks, не читает SQLite/содержимое разговоров и не угадывает ownership по
имени папки. Асинхронные readdir/stat/du принадлежат прежнему single-flight
inventory, не новому History reader. Суммы allocated/CoW не обещают такой же
reclaimed размер. Partial scan обозначается явно. Whole-profile delete отсутствует.

Session groups также пользовательские, а не внутренние:

- `Open now`;
- `Regular sessions`;
- `Forks`;
- `Rewinds & edits`;
- `Subagents`;
- `Dev sessions` — session ID есть только в development DB; production на них
  не опирается;
- `Outside Noted Terminal`;
- `Recovery copies`.

`Home History` не является группой: это значение `Source = Noted Terminal` на
карточке. V2 lineage также не отдельная группа; source получает понятное
`Required by an open session`. При Cmd-hover общий `ControlHint/Tooltip`
объясняет определение группы и текущий timer.

`Open now` означает сохранённые открытые вкладки, включая stopped agents,
а также защищённые родительские файлы и subagents. Сумма не является размером
только работающих процессов. Текущий локальный pre-filter консервативно
объединяет `parent_thread_id` и `forked_from_id`, поэтому может удерживать и
источник самостоятельной копии. Это не доказательство физической зависимости.
У Codex 0.147 каскад `thread/delete` идёт по spawn-графу субагентов; одно
происхождение fork не делает копию частью этого каскада. Отдельный `history_base`
или manifest действительно требует сохранения источника.
`Forks` показывает закрытые ветки; открытые уже входят в `Open now`.

Суммы имеют явные подписи `total / can delete / protected`; `Can delete only`
убирает protected rows из списка, сохраняя общий размер категории. Это ответ
на задачу очистки, не изменение защиты. Footer `All categories` и
`Clean all ready` обозначают общий охват. В `Codex builds` порог возраста
подписан `Ready after` рядом с `Manual cleanup`: он по-прежнему настраивает
состав `Clean all ready`, но автоматический sweep build directories не удаляет.

Developer post-build уборка SC/Voice/WebODM — другой механизм, не этот session
sweep и не разрешение удалить Cargo/transcript по возрасту. Граница, prepared
packages и rollback — [очистка сборок](fact-очистка-сборок.md).

Строка показывает title/UUID, source, date и size. Правая область лениво
дочитывает iteration count только после явного выбора сессии: раскрытие Storage,
смена provider или сортировки не выбирают самый большой файл автоматически и
общий scan не парсит гигабайтные transcript. Там же видны полный path, parent,
retention, protection reason и размер provider deletion closure.

Над виртуализированным списком есть inclusive date range `From / To` по той же
дате, которая показана в колонке. Checkbox в заголовке и `Select all N`
выбирают **весь отфильтрованный массив**, а не только смонтированные Virtuoso
rows. Shift+Click берёт два ID, находит их индексы в этом массиве и добавляет
все deletable ID между ними; protected rows пропускаются. Смена provider/group/
query/date/`Can delete only` очищает набор, чтобы Delete не затронул скрытые прежним фильтром
строки. Сортировка size/date переключается кликом по заголовку
`desc ↔ asc`: выбранные ID сохраняются, но Shift-якорь и открытое подтверждение
сбрасываются, потому что позиционный порядок изменился. `Delete selected`
всегда проходит тот же inline confirm и показывает item-progress от main.

Раскрытие Storage — глобальное persisted UI-state. Renderer хранит один
ограниченный snapshot metadata между размонтированиями Dashboard: возврат
Home → Workspace → Home сразу рисует прежнюю таблицу без `Scanning storage…`.
Это не History cache: JSONL content, display-units и DOM rows туда не входят.
Автоматического revalidate при возврате нет: первый вариант тихо запустил scan
на 4,77 с и дал main-loop gap 262 мс, хотя таблица не показывала loader. Новый
disk read происходит только по ручному Refresh, settings/delete либо штатному
retention sweep; initial disclosure после нового запуска честно показывает
локальный loader.

Открытая вкладка и её transcript имеют разный lifecycle. После retention или
legacy-удаления строка `tabs` может сохраниться вместе с названием, цветом,
задачами, заметками и последним `context_pct`, хотя provider-файла больше нет.
Карточка в этом случае не становится «удалённой вкладкой»: её собственный цвет
сохраняется, справа появляется малиновая полоса + `ArchiveX`, а session-derived
показатели (последний context %, Fast) сереют только когда нет живого runtime.
Статусы/задачи остаются цветными, process/busy сигнал живого процесса не
гасится. History показывает явное missing-state; Resume и Copy Session
disabled с объяснением. Неизвестность или первая материализация не окрашиваются
как потеря.

Доступность вычисляет main пакетно для всех видимых session bindings через
`agent-session:get-availability-batch`. Renderer не сканирует диск из каждой
карточки: module-level tracker дедуплицирует одинаковые `tab + provider +
session`, опрашивает main одним batch и раздаёт примитивные snapshots всем
поверхностям (`TabSidebar`, pane chip, Ctrl+Tab, Run after). Main проверяет
Claude primary JSONL, Codex active + archived rollout и Gemini session JSON;
для Codex V2 thin-fork дополнительно проверяются exact physical source IDs из
lineage manifest. Возможные исходы: `available`, `archived`, `partial`,
`missing`, `checking`, `unknown`. Новый живой writer получает 15 секунд на
первую материализацию; ранее видимый либо точно удалённый файл становится
`missing` без этой отсрочки.

Удаление через Storage уже знает фактические provider IDs из
`thread/deleted`/Claude result, поэтому сразу инвалидирует ровно эти session ID
и прикладывает source/operation/time. Внешнее удаление обнаруживается
ограниченной сверкой path-cache при focus/visibility и периодическом batch;
признак отсутствия не сохраняется навсегда в `tabs`, потому что восстановленный
из backup файл должен автоматически вернуть обычное состояние. Тот же
materialization verdict управляет `canResume` в Project API: сохранённый UUID
без доступной Codex/Claude conversation больше не рекламируется внешним
клиентам как возобновляемая сессия.

## Main-owned inventory

Один bounded scan использует только:

- async directory traversal и `stat`;
- первые 512 КБ session-файла для session meta/первого prompt;
- `tabs`, `tab_history`, `favorites` и `session_history_events` current DB плюс
  read-only sibling prod/dev DB. Канонический userData захватывается до
  `NOTED_USER_DATA_DIR`: изолированный dev с временной базой всё равно обязан
  доказать production-ссылки из настоящей `noted-terminal.db`;
- main-owned runtime session IDs;
- `du -sk` только для агрегированных build/app directories.

Scan single-flight/cache сохраняет общий generation fingerprint списка.
Legacy callers без per-item revisions всё ещё проходят прежнюю проверку всей
generation. Исключения protected growth оказалось недостаточно: новые или
растущие deletable файлы в другом разделе делали неизменную выбранную сборку
stale. Production03.10: disclosure02.10 → Delete03.10 дважды остановился на
prepare, до mutation. Конкретный изменившийся посторонний ID старый log не писал.

Desktop теперь передаёт main-owned `deletionRevision` каждого выбранного item.
Main сравнивает physical path/inode, size/mtime, provider/session и protection,
затем подписывает V2 token с версиями всех известных затрагиваемых файлов,
включая provider descendants. Confirmation хранит возвращённую main generation,
а не подставляет более поздний UI snapshot. Изменение постороннего файла не
отзывает пользовательский выбор; изменение выбранного/затрагиваемого файла,
расширение provider closure и новый runtime/DB reference по-прежнему запрещают
удаление. Непосредственный runtime/`tabs` recheck и durable audit сохранены.

Claude tool-results учитываются в размере primary session и удаляются вместе с
ней. Recovery JSONL с тем же session ID остаётся отдельным item и не становится
защищённым только из-за открытого primary файла.

Production inventory помечает ссылки, найденные только в dev DB, группой
`Dev sessions` и не смешивает их с truly external CLI. Обратная граница
строже: development instance считает любую prod-referenced session защищённой,
даже если она не открыта в текущем dev renderer. Dev fork event помечает и
child, и его exact source segments; source, одновременно нужный production,
получает обе environment-ссылки и не становится disposable dev-only.

Автоматическим общим retention владеет только canonical packaged production.
Обычный dev и packaged app с посторонним userData не получают общий timer.
Явное ручное удаление из dev разрешается только когда каноническая production
DB открыта read-only; отсутствие этой authority возвращает
`storage_production_authority_unavailable` до scan/provider mutation. E2E
runtime не получает общую destructive authority даже при доступной production DB.
Исключение — полностью private E2E с физически проверенными userData,
CODEX_HOME и CLAUDE_CONFIG_DIR внутри собственного isolation root: те же сроки
применяются только к его собственным закрытым данным. Fresh path guards и
`mutationRoot` запрещают выход наружу; audit тоже остаётся в private userData.
Перед test Codex delete provider `thread/read(includeTurns:false)` обязан
подтвердить physical rollout path каждого затрагиваемого SID внутри root и
exact path выбранного файла. Скопированный state.sqlite может содержать
абсолютный путь к исходному профилю: одного private CODEX_HOME недостаточно.
Unknown/null path — отказ удаления, не fallback к unlink. Production provider
flow от этого test guard не меняется. Сохранённые открытые вкладки sibling dev
DB тоже защищаются; archived native row не является open.

После перехода к workflow размер текущих разговоров считают по canonical
bindings, включая reserve: `catalog-v1.executionRefs[*].savedSessions.codex`
и живые `sessionId/savedSessionId`. `tab-catalog.nativeRow.codex_session_id`
перекрывает serialized snapshot при restore, в том числе для V2. Старый SID
в `record.records`/`record.codexSessionId` может быть прежним снимком той же
вкладки; `archived:false` там описывает момент миграции, не свежесть сегодня.
Это различие объясняет лишние гигабайты в union всех aliases, но не заменяет
проверку физических зависимостей и живых операций перед удалением.

`thread.historyMode="paginated"` обозначает формат хранения, а не наличие
заимствованного префикса. Полная независимая ветка тоже может иметь этот mode.
Защищать всю цепочку `forkedFromId` только по этому полю — значит удерживать
уже ненужные копии. Обратное также неверно: отсутствие fork в лёгком diagnostics
не доказывает независимость, если актуальный manifest ещё не восстановлен.
Нужны canonical source segments и отдельная проверка native references ниже.

## Удаление и retention

- Claude primary/recovery JSONL удаляется exact unlink после main preflight;
  owned `tool-results` directory удаляется вместе с primary.
- Codex canonical session удаляется через installed app-server
  `thread/delete`; raw unlink запрещён. Перед mutation Noted запрашивает
  provider-owned active+archived closure через `thread/list` с
  `ancestorThreadId`, сопоставляет каждый ID с runtime и production/dev DB и
  отказывает, если root либо любой потомок защищён. Старый local rollout graph
  остаётся только presentation/pre-filter и не является delete authority.
- Для `ancestorThreadId` не передавать `sourceKinds:[]`: в 0.147 отсутствие
  фильтра с relation-query включает spawned descendants, а явный пустой список
  возвращает default interactive sources и скрывает субагентов. Проверка на
  одном живом parent дала 9 descendants без поля и 0 с пустым массивом.
- Spawn-leaf ещё может быть источником чужого `history_base`. Provider отдельно
  сканирует rollout references и отказывает `forked history still references it`
  **до** удаления history rows/файлов. Такой отказ не обходить raw unlink.
  Native dependency может продолжаться за непосредственным physical segment
  Noted manifest; проверка одной UI-проекции не доказывает весь native resume.
- Automatic retention удаляет только provider-доказанный leaf. Ручная операция
  сначала вызывает `storage:prepare-delete`: main получает exact closure,
  пересчитывает count/bytes и возвращает короткоживущий подписанный token.
  Второй клик Delete обязан предъявить этот token; новый descendant либо другая
  версия затрагиваемого файла делают confirmation stale до mutation. Так дополнительные нити не
  могут появиться после уже показанного пользователю состава.
- После успеха Noted собирает фактические `thread/deleted` notifications.
  Поэтому в результате и аудите перечислены все реально удалённые provider
  session ID, а не только выбранный root.
- Build directories удаляются только явным Dashboard confirmation. Automatic
  sweep пока не трогает их, потому что другой worktree может компилироваться без
  main-owned build lease.
- DB recovery backup можно удалить exact unlink; active DB/Chromium/prompt
  assets защищены своими владельцами.

Отказ проверки/удаления использует общий persistent toast с `Copy`. Короткое
сообщение отделено от отчёта: phase, operation ID, shown/current generation,
exact selected IDs/paths и changed-item reasons. Отказ до mutation явно
сообщает «Nothing was deleted»; частичный результат не выдаётся за нулевое
удаление. Повторный Delete при in-flight operation блокируется синхронно.

Automatic sweep стартует у canonical production/private test owner через
90 секунд после app-ready. Shared dev не владеет таймером. Один проход ограничен
25 items либо примерно 2 ГБ и повторяется через 15 минут, пока есть eligible
leaves; спокойный интервал — шесть часов. Expiration History обрабатывает отдельно
до250 записей; при backlog следующий bounded проход через секунду. Изменение
settings перевзводит sweep только у разрешённого owner. `Clean all ready` и `Delete now` используют inline
two-step confirmation и показывают точный count/bytes.

Большой batch не выглядит зависшим: `storage:delete-progress` несёт
`completed/total/removed/failed/reclaimedBytes` после каждого item. Main всё
равно revalidates каждый target; progress — presentation, не разрешение удалить.

Перед первым необратимым действием main обязан успешно дописать `attempt` в
`<canonical userData>/storage-deletion-audit.jsonl`; если audit недоступен,
delete не начинается. Затем туда append-only пишутся `removed`, `failed` или
`already-missing`: UTC time, operation/source/environment, opaque item ID,
provider session ID, group/path/bytes, provider closure и фактические deleted
IDs. Те же ID попадают в `[StorageCleanup:Item]` production log; агрегат
`requested/removed/bytes` остаётся только summary, не forensic evidence.

### Отсрочка после потери защиты

Пользователь уточнил: закрытая старая вкладка не должна исчезать при ближайшей
очистке только потому, что её JSONL давно не изменялся. Прежний fallback
`closedAt || modifiedAt` смешивал возраст данных и время возникновения права
на автоматическое удаление. Main теперь хранит отдельный `unprotectedSince`:
первый успешный inventory без защиты даёт полный новый срок внешним файлам. Это консервативное
наблюдение, не обещание удаления ровно через N часов после клика; sweep может
обнаружить закрытие позже. При первом запуске новой версии и при потере clock
старые внешние сессии тоже получают новый срок, не считаются уже просроченными.

Сама History истекает от committed Close независимо от доступности provider-файла.
У физического файла остаётся отдельная безопасная отсрочка после доказанной
потери защиты: старый close/mtime/birthtime не доказывает identity после recovery
или копирования с сохранением timestamps. На первом обновлении ранее ошибочно
защищённые V2 архивы могут получить новые сутки для удаления файла; это не
оставляет истёкшую запись в History и не разрешает трогать текущую вкладку.

Clock переживает restart в отдельной SQLite-таблице storage owner. Возврат
saved binding, физическая замена/изменение файла либо новое закрытие отменяют
старый отсчёт. SQL-trigger привязки и exact lineage sources нужен потому, что
Restore → Full Close может целиком пройти между двумя inventory: один только
UI close callback или следующий scan не доказывает непрерывную потерю защиты.
V2 `execution_archived:1→0` и создание membership тоже инвалидируют clock:
Restore может сохранить SID, не вызвав прежний binding-trigger.
Recovery copy с тем же SID остаётся отдельным физическим объектом. Reconcile
читает clock после async scan в одной транзакции; перед mutation после await
audit/provider снова проверяются текущий clock, settings и stat. Истёкший срок
не отменяет прежние runtime/production/closure guards и provider leaf proof.

Рядом с `Auto-delete on/off` — `Auto-delete delay [24] hours`, минимум один час;
изменение сохраняется по Enter/blur. Старые group preferences сохраняются:
deadline — более поздний из group-age threshold и `unprotectedSince + delay`.
Явный `Delete now` остаётся ручным подтверждённым действием, не ждёт отсрочку.
`Never=null` нельзя заменять fallback regular: иначе UI обещает сохранение,
а main снова использует один день. Базовый filesystem inventory сам по себе
не является готовым retention decision: действующий DTO проходит service clock.
Новых polling/reader/History loops нет — reconcile только на прежнем scan.

## Служебные снимки workflow и проверка без UI

`workflow_org_generations` раньше бесконечно сохраняла полный `readState()`
на каждую publication. Это копии состояния всех вкладок, не разговоры JSONL.
Source17.10 удерживает первый migration snapshot и два последних; worker
запускается с backlog от восьми и удаляет старые rows малыми транзакциями вне
Main. Current tables, migration source и immutable mutation receipts не
очищаются. Busy/ошибка откладывает prune до следующей publication; ошибка
maintenance не превращает committed действие в failed ACK. Test DB path
проверяется отдельно: physical file/identity, не symlink/hardlink наружу.

Освободившиеся SQLite pages переиспользуются. У старой DB с auto_vacuum=0
файл сам не уменьшается: это не обещание немедленных свободных гигабайт.
Новые DB создаются с INCREMENTAL; существующие не переписываются при старте.
Блокирующий live VACUUM/подмена рабочей DB в этот flow не входят.

Application API `storageMaintenance.version=1`: GET `/api/storage/inventory`,
`/api/storage/plan`, `/api/storage/database-space`; POST `/api/storage/cleanup`
с обязательным operationId, GET `/api/storage/cleanup/:operationId` — receipt.
Started/unknown не переисполняется. API вызывает прежний service и runtime
guards, не произвольный SQL. `scripts/storage-cleanup.mjs` по умолчанию dry-run;
на старом app сообщает update-required, не открывает SQLite напрямую.
Проверка source17.10 — `scripts/storage-retention-dry-run.cjs`: реальные own
SQLite/worker/V2 Close/expiration/RAG bytes, fake provider; без UI/моделей/install.

## Инцидент 25.08: изолированный dev удалял production history

Production `tab-490` сохраняла session `019fc6f5…`, а её 540,8-МБ rollout ещё
читался в 07:53 МСК. В 08:01 и 08:26 запускался dev с
`NOTED_USER_DATA_DIR=/tmp/...`, общим `~/.codex` и без `NOTED_E2E_TEST=true`.
Старый код искал `noted-terminal.db` внутри временного userData, не находил её,
но всё равно включал default one-day retention. К 09:09 rollout уже отсутствовал;
production sweep в 09:14 был слишком поздним и не являлся причиной.

Старый aggregate log не содержал успешные session ID, поэтому exact строка
удаления `019fc6f5…` недоказуема постфактум. Однако causal capability была
реальной: временная пустая DB классифицировала общий production rollout как
`Outside`, а dev timer мог вызывать provider delete. Ремонт — single production
owner + canonical production authority + provider closure + durable per-ID
audit. Возвращать исключение «dev просто не чистит этот один ID» запрещено:
граница установлена для всего shared storage.

## Шрам первой ручной очистки

До появления этого сервиса четыре явно разрешённые пользователем неоткрытые V1
full-copy были удалены raw unlink (5,65 ГБ). Они self-contained и не затронули
96 открытых Codex rows, но upstream thread metadata/session_history_events могли
сохранить missing parent. Автоматически «чинить» эти записи прямой DB-правкой
нельзя; reader должен fail-visible, а будущая deletion идёт только через
provider API.

Параллельно `cargo clean --profile dev` удалил 46 261 generated files / 15 GiB
из root Codex target. Installed runtime оставался в
`~/.noted-terminal/bin/codex`; source checkout не удалялся.

24 августа второй явно разрешённый maintenance-run взял live production IDs
через Project API, защитил 106 session ID и их physical parents, затем удалил
773 старейших `Outside` leaves за 22.02–23.07.2026 через текущий provider
contract. Результат: 0 failures, logical reclaimed 9,00 GiB; фактический `du`
Codex+Claude уменьшился примерно на 8,92 GiB. После прохода осталось 1713
external items / 29,74 GiB. Это не новый raw-unlink шрам: Codex шёл только
через `codex delete --force`, Claude — через exact preflight path.
Post-check нашёл physical files у 97/106 API ID; оставшиеся девять уже были
metadata-only/missing и не могли попасть в delete set: runtime ID повышает
любой существующий matching item до protected до выбора кандидатов, а Codex
batch брал только leaves без descendants.

## Неочевидная карта реализации

- Global Dashboard → `StorageBrowser` → `storage:*` IPC; renderer получает
  готовую классификацию и не передаёт filesystem path для удаления.
- `storage-inventory.js` соединяет filesystem meta с Noted DB и строит open
  dependency closure.
- `storage-cleanup-service.js` владеет generation check, retention и
  provider-specific deletion.
- MCP/AI process blocks и Storage используют один Home visual grammar и общий
  Cmd-tooltip, но process Stop и file Delete остаются разными контрактами.
