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

## Принятый продуктовый контракт

- Все сессии открытых вкладок сохраняются без таймера.
- Физические source-файлы, необходимые открытой thin-fork сессии, считаются
  частью открытой сессии и тоже защищены.
- Claude subagent открытой родительской сессии защищён для инспекции.
- Все остальные session-файлы по умолчанию удаляются через один день после
  закрытия/последнего изменения. Home History row может остаться metadata-only:
  название, проект и дата видны, но Preview/Resume после удаления невозможны.
- Таймер можно переопределить по группе: 1/3/7/30 дней либо Never.
- Renderer не решает, что безопасно удалить. Main отдаёт `deletable`,
  `protectedReason`, closure и opaque item ID, затем повторно проверяет тот же
  scan generation перед записью.

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

Storage имеет три вкладки с английскими названиями:

1. `Sessions` — provider switch `All / Codex / Claude`, поиск и сортировка по
   size/date/iterations.
2. `Codex builds` — Cargo debug/release targets, worktree builds, packaged app
   и защищённый installed runtime.
3. `Noted Terminal data` — DB backups, active databases, Chromium caches и
   prompt images.

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
query/date очищает набор, чтобы Delete не затронул скрытые прежним фильтром
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

Scan single-flight/cache имеет immutable generation fingerprint по item ID,
size, mtime, protection и settings. Постоянно растущие protected transcripts в
fingerprint не входят: они никогда не являются delete-target, а раньше делали
любое подтверждение stale. Переход `deletable → protected` меняет fingerprint
и по-прежнему останавливает удаление. Действие передаёт opaque IDs и
generation; main заново сканирует и отказывает при изменении. Непосредственно
перед каждой session deletion он ещё раз проверяет runtime и `tabs`, чтобы
вкладка, открытая после confirmation, не была удалена.

Claude tool-results учитываются в размере primary session и удаляются вместе с
ней. Recovery JSONL с тем же session ID остаётся отдельным item и не становится
защищённым только из-за открытого primary файла.

Production inventory помечает ссылки, найденные только в dev DB, группой
`Dev sessions` и не смешивает их с truly external CLI. Обратная граница
строже: development instance считает любую prod-referenced session защищённой,
даже если она не открыта в текущем dev renderer. Dev fork event помечает и
child, и его exact source segments; source, одновременно нужный production,
получает обе environment-ссылки и не становится disposable dev-only.

Автоматическим retention владеет только packaged production. Обычный и
изолированный dev могут строить inventory, но не запускают фоновый timer.
Явное ручное удаление из dev разрешается только когда каноническая production
DB открыта read-only; отсутствие этой authority возвращает
`storage_production_authority_unavailable` до scan/provider mutation. E2E
runtime не получает destructive authority даже при доступной production DB.

## Удаление и retention

- Claude primary/recovery JSONL удаляется exact unlink после main preflight;
  owned `tool-results` directory удаляется вместе с primary.
- Codex canonical session удаляется через installed app-server
  `thread/delete`; raw unlink запрещён. Перед mutation Noted запрашивает
  provider-owned active+archived closure через `thread/list` с
  `ancestorThreadId`, сопоставляет каждый ID с runtime и production/dev DB и
  отказывает, если root либо любой потомок защищён. Старый local rollout graph
  остаётся только presentation/pre-filter и не является delete authority.
- Automatic retention удаляет только provider-доказанный leaf. Ручная операция
  сначала вызывает `storage:prepare-delete`: main получает exact closure,
  пересчитывает count/bytes и возвращает короткоживущий подписанный token.
  Второй клик Delete обязан предъявить этот token; новый descendant либо другая
  generation делают confirmation stale до mutation. Так дополнительные нити не
  могут появиться после уже показанного пользователю состава.
- После успеха Noted собирает фактические `thread/deleted` notifications.
  Поэтому в результате и аудите перечислены все реально удалённые provider
  session ID, а не только выбранный root.
- Build directories удаляются только явным Dashboard confirmation. Automatic
  sweep пока не трогает их, потому что другой worktree может компилироваться без
  main-owned build lease.
- DB recovery backup можно удалить exact unlink; active DB/Chromium/prompt
  assets защищены своими владельцами.

Automatic sweep стартует только в packaged production через 90 секунд после
app-ready. Dev и E2E не являются владельцами таймера. Один проход ограничен
25 items либо примерно 2 ГБ и повторяется через 15 минут, пока есть eligible
leaves; спокойный интервал — шесть часов. Изменение settings перевзводит sweep
только у production owner. `Clean ready` и `Delete now` используют inline
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
