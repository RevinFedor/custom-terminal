# Feature: проектные промпты из файлов

## Независимые roots после workflow cutover

Каталог остаётся производным от дисковых `.prompt.md`; пользовательские Projects
больше не задают доступность. Реестр roots независим от живых вкладок/архива,
а effective bindings принадлежат exact tabId. Миграция сохраняет порядок,
provenance и прежнюю область, а не объединяет roots всех cwd внутри workflow.
Source-child наследует точный набор; explicit empty binding остаётся пустым.
Удалённый/отсутствующий root не исчезает после неудачного scan. Future opaque
scope копируется с исходной version, без молчаливого downgrade.

Workflow settings → Sources заменяет прежний редактор источников в prompt picker.
Внутри явно выбирается target-вкладка; Save меняет только её bindings по прежним
revision/CAS. Manage folders открывает тот же независимый registry, Add folder
не связывает root автоматически со всеми вкладками workflow. Неизвестный ACK
повторяется с тем же request, поздний read после смены target не перетирает выбор.
Sources показывает полный Root и эффективный Search `<root>/docs` у каждой
регистрации; `docs` остаётся общей фиксированной политикой, а не новой папкой
поиска в tab bindings. При выборе search-папки уже зарегистрированного root
Add переиспользует его exact ID. Явно зарегистрированный root с именем `docs`
имеет приоритет; неизвестный путь не заменяется его родителем автоматически.
Opt+V
фиксирует исходную вкладку до await, использует тот же каталог и watchers;
обычная Insert Prompt library остаётся отдельной. Legacy project endpoints и
project usage labels в GT Editor сохраняют wire compatibility как provenance,
а не новую organizational authority. Legacy описание ниже не означает возвращение
обязательного Project для создания вкладки.

## Legacy модель данных и совместимость

Проект хранит не копии промптов, а упорядоченный список корневых директорий в
SQLite-таблице `project_prompt_sources`. Каталог всегда производный от диска:
для каждого root Custom Terminal рекурсивно читает только
`<root>/docs/**/*.prompt.md`. Содержимое файлов не записывается в таблицу
`prompts` и читается только в момент вставки.

Это разделяет два вида библиотеки:

- обычные prompts/groups принадлежат Custom Terminal и управляются в Settings;
- project prompts принадлежат рабочим репозиториям и следуют за файлами на диске.

## Прежние настройки проекта

Один `EditProjectModal` используется независимо от точки входа в настройки
проекта. В секции «Промпты» root можно вставить абсолютным путём и подтвердить
Enter либо выбрать через нативный directory picker. Для основного пути проекта
есть короткое действие «Использовать папку проекта».

При сохранении:

- `~` разворачивается, пути нормализуются до абсолютных;
- symlink и его real path считаются одним источником;
- одинаковые, вложенные и перекрывающиеся roots отвергаются как
  `overlapping_prompt_sources`, иначе один файл мог бы появиться несколько раз;
- написание выбранного пользователем пути сохраняется для ключа общей раскладки
  sidebar, даже если canonical identity вычислен через `realpath`;
- отсутствующий root или `docs` не удаляется молча: источник остаётся bound с
  missing facts. CURRENT Source46 наблюдает ближайший существующий parent
  NON-recursive sentinel и продвигается внутрь после появления root/docs; read
  также заново проверяет их bounded async facts. Settings/CAS остаются sync.

## Сканирование и порядок

Сканер игнорирует dot-entries, symlink-ветки и каталоги с точным именем
`node_modules` до рекурсивного чтения. Снимки/outputs внутри `docs/tmp` могут
содержать физические копии package prompts: одинаковые title/bytes не делают
их пользовательскими промптами. Исключается dependency-ветка, не сам `docs/tmp`
и не совпадающие имена/хэши настоящих файлов; disk bytes сохраняются. Это policy
только prompt discovery: обычный файловый explorer сохраняет свои действия.
Суффикс `.prompt.md` проверяется без учёта регистра. Заголовок
промпта — имя файла без этого суффикса.

Sources показываются по естественной алфавитной сортировке display-name. Если у
двух roots одинаковый basename, к имени добавляется parent path. Внутри source
порядок совпадает с общим file explorer:

- сначала применяется persisted layout из
  `~/.noted-terminal/shared/file-layout.db` для точного root;
- учитываются ручной sibling order и visual file-parent связи;
- для ещё не разложенных элементов fallback — директории перед файлами и
  natural filename order.

В CURRENT Source46 `ProjectPromptCatalogService` содержит один async metadata
preparer и source slot на resolved CONFIGURED spelling. Alias и real root —
разные ключи; namespace, labels и consumer membership не принадлежат snapshot.
Snapshot хранит полный ordered inventory metadata, source-local position и
root/docs/layout/policy/watch observations, без file bodies или tab prompt arrays.
Natural/manual/visual порядок сохраняется, включая ordinary file parents и
легитимные одноимённые prompt files. Sort/visual/map/usage stages cooperative:
<=256 elementary steps или около2ms до setImmediate. Неделимая длинная операция
не обрезается, maxUnit/maxSlice фиксируются; это targets, не hard latency limits.
Async FS ports opendir/stat/lstat/realpath явные, общий небольшой limiter;
handle закрывается до descent, unknown/read/close failure не становится ready.

`listTab/listProject/usageForRoot` возвращают Promises. Read не запускает recursive
scan или watcher reconciliation: cold/stale планирует одну source preparation и
возвращает `prompt_catalog_preparing`; failed/unavailable explicit. Explicit-empty
и no-enabled bindings сразу ready-empty. TTL удалён; updatedAt — время наблюдения.
Открытие после1501ms или позднее само не вызывает scan. Constructors и совместимый
refreshWatchers только schedule; background jobs имеют handled errors.
Publication — одна reference replacement после полного результата с current
lifetime/slot/token/desired epoch, physical root/docs, layout/policy и watch owner.
Obsolete latest epoch уходит в конец очереди; unrelated sources не голодают.

Usage по-прежнему обрабатывает fresh open/archive bindings и project labels,
поэтому не O(1). SQL scopes/bindings/registrations читаются bounded keyset pages
в прежнем ordering, без all-scopes .all или iterator/transaction через await.
Sources reader переиспользует statements, не ответы; connection/schema swap
сбрасывает compiled ports. Exact selected authority читается до metadata и
повторно перед return. Connection/schema, relevant committed epoch и external
SQLite data_version fenced. Из-за неполной notification coverage local
`total_changes()` — conservative recheck hint (включая rollback), не authority:
он допускает одну дополнительную authority pass, затем `prompt_catalog_changed`,
и НЕ инвалидирует FS inventory из-за unrelated History writes. Settings и durable
CAS/replay receipts никогда не ждут preparation и не становятся async unknown.

Usage не создаёт pruned candidate: source inventory всегда полный. Query root и
unique leaves канонизируются request-local заново в каждом read. Неуспешный leaf
realpath сохраняет lexical configured-path fallback, включая directory-known /
leaf-UNKNOWN alias. Required root/docs resolution UNKNOWN — явный unavailable,
не false-ready/empty. Future scope/layout errors не скрываются disjoint filter.
Сам DTO остаётся `project-prompt:<ORIGINAL namespace>:sha1(CONFIGURED path)[0:16]`,
content='', собственный file_paths, исходные source-local positions. Labels
вычисляются из ALL described sources до enabled filter; records detached.

Watcher callback синхронно отзывает epoch.180ms coalesces start от ПЕРВОГО event,
не разрешает старые rows current и не переносит deadline бесконечно. Content-only
prompt change проверяется lstat/probes перед решением не rebuild; directory/normal
file rename и null filename требуют reconciliation. Ignore лишь proven excluded
entries/dependency descendants. Loss/close/error, inode replacement и alias retarget
отзывают coverage; old callback/timer/completion проверяют exact owner/token.
Shared non-recursive parent/alias sentinels восстанавливают missing roots/docs.
После успешного layout store.put parent вызывает synchronous
`catalog.onLayoutCommitted(rootPath)`: revokes только exact configured source key,
queued rebuild, без FS/SQL в самом seam. Committed CAS result не меняется даже
при observer error; cold/unbound source не сканируется eager. Main wrapper и
external GT/Voice layout-commit signal — отдельные parent integration seams.
`refreshWatchers({recovery:true})` синхронно revokes и заменяет owners после resume/
observation gap/explicit recovery. Event-only FS не доказывает обнаружение тихо
потерянного nested event без такого сигнала; TTL/readiness polling не возвращаются.
`close()` seals old lifetime; явное reuse создаёт новый preparer, old callbacks мертвы.
Unknown consumers notification omits tabIds; [] значит «нет tabs», не broadcast.

THREE IPC read handlers await внутри try; Settings/CAS sync. HTTP
`GET /api/project-prompt-usage` await-ит usage перед success body и сохраняет
preparing/changed/failed code/status; async lifetime использует causal.run,
не syncWork. Fixed scalar stages/counts/max units/loss не логируют paths/body/query.
Diagnostic correlation использует operation.fields из общего causal context и
существующие spanId/parentSpanId. Чтение actionId/readId непосредственно из
operation теряет связь с запросом. requestId/actionId/readId проходят прежний
safeFields; это один scalar summary на read, без packet на каждый шаг.

**Граница подтверждения14Oct:** Source46 backend finite Node/tempFS + declared
Node builtin SQLite substitute/controlled watch/transport controls. Сборка,
real app/native ABI/installed latency и полная вставка НЕ подтверждены. До paired
build должны быть согласованы owner4929 menu/UI и parent composition/commit/resume
hooks. Historical installed версия могла ещё иметь TTL1500 и foreground recursive
catalog work (production6956ms/4822ms Main CPU). Это не обещание measured speedup.

## Opt+V и контекстная вставка

Если у активной вкладки есть project prompts, первой строкой левой колонки
picker идёт проект: его изображение либо фиолетовая `MessageSquareQuote`, затем
имя проекта. Обычные groups/ungrouped prompts остаются ниже в прежнем порядке.
Справа project prompts разделены компактными заголовками source-директорий.
Пустой проект не создаёт декоративную строку.

Prepared consumer отделяет global library от каталога вкладки. Listener
`project-prompts:changed` подключается до первого чтения; событие синхронно отзывает
отдельный catalog sequence, не поколение picker/начатой вставки. Cold/preparing,
stale и failed не превращаются в известный пустой список. Globals доступны отдельно;
старые project rows не выбираются. Без отдельного authority stamp DTO consumer
не показывает last-good после неизвестного изменения binding. Error.code сохраняется,
omitted tabIds означает неизвестных consumers, `[]` — отсутствие consumers.
Sidebar показывает отдельный usage-state и сохраняет обычное файловое дерево.

Native builder синхронный и pure: preparing/failed — disabled project row плюс
обычная global library. Владельцы native request await каталог, затем скалярно
проверяют origin intent через прежний sender-fenced renderer bridge. Штамп появляется
до первых caller awaits и отзывается при replacement/presentation loss/Escape/blur;
keyboard focus другой видимой панели сам не делает source недоступным. Перед popup
повторно проверяются request/sender, tab binding и physical lifecycle/PTY/SDK instance;
turnBusy не является menu readiness. Publication не открывает закрытое native menu.
После валидного выбора App вставляет в captured tabId через file-read await, а не
в новый effective tab. Legacy unstamped payload сохраняет compatibility path;
SDK остаётся у своего tab-bound listener, без второго App writer.

Тот же каталог используется в Opt+V и в prompt-ветке контекстного меню. Target
фиксируется при открытии picker: последующее переключение вкладки не должно
перенаправить вставку. Обычный выбор читает актуальный `.prompt.md` с диска и
вставляет содержимое через существующий безопасный prompt pipeline. Cmd-клик
вставляет только голый абсолютный путь как обычный редактируемый текст: без
prompt-чипа и без Claude-специфичного `@"…"`. Несколько путей разделяются
переносами строк. Сам catalog row хранит `file_paths`, а не дублированный текст.

## Чипы в файловом дереве

Для каждого видимого root `usageForRoot` строит компактное соответствие
`файл → проекты`. У project prompt под именем файла показывается фиолетовый
read-only chip с `MessageSquareQuote` и именем проекта. Он не участвует в DnD и
не заменяет существующие кликабельные chips, которыми файл привязан к AI-tab.

Тот же usage доступен GT Editor через авторизованный HTTP endpoint
`GET /api/project-prompt-usage?root=...`, поэтому обозначение одинаково в обоих
приложениях без чтения чужой SQLite.

## Основные точки и тесты

- catalog: `src/main/project-prompt-catalog.js`, `prompt-catalog-preparation.js`,
  `prompt-catalog-source.js`, `prompt-catalog-cooperative.js`;
- persistence: `src/main/database.js::project_prompt_sources`;
- IPC: `src/main/ipc/project-prompts.js`;
- settings: `src/renderer/components/UI/EditProjectModal.tsx`;
- picker: `src/renderer/components/Workspace/PromptPickerOverlay.tsx`;
- chips: `src/renderer/components/Workspace/Sidebar.jsx`;
- unit: `project-prompt-catalog.test.js`, `prompt-menu-template.test.js`.
