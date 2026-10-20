# Feature: проектные промпты из файлов

## Директории рабочего пространства

Прямое уточнение18.10: пользователь настраивает директории рабочего пространства,
а не каждой вкладки. Общий каталог строится из `<defaultCwd>/docs/**/*.prompt.md`
и `docs/**/*.prompt.md` каждой дополнительной `promptDirectories`. Этот набор
одинаков для всех участников workflow — новых v2, legacy, reserve и hidden.
Membership и metadata workflow читаются в Main; tab.cwd/execution namespace
сохраняют прежнего владельца и не выбирают папки каталога. В FlowTab пример —
`hh-tool/docs/methodology/тестирование-расширения.prompt.md`: наличия файла мало,
если код вместо директории workflow читает прежние индивидуальные bindings.

В настройках нет Sources, выбора вкладки, флажков реестра или Save. Пользователь
указывает основную директорию, добавляет/удаляет дополнительные. Все изменения
сохраняются при уходе из поля, а закрытие по фону, X и Escape дожидается сохранения
последнего ввода через прежний organization committer. Ошибка/unknown ACK оставляет
окно с черновиком открытым; позднее завершение не закрывает настройки другого
workflow. Имя показывается один раз, в редактируемом поле под заголовком «Настройки».
Основная директория по-прежнему задаёт стартовый cwd новых вкладок; изменение
настройки не переписывает cwd уже запущенных сессий.

Директории не надо отдельно регистрировать или копировать в каждую вкладку.
Прежние tab-owned bindings хранятся для legacy API/истории, но не участвуют в
каталоге организованного workflow. Workflow без директорий даёт готовый пустой
каталог, а не наследует случайные папки execution namespace. Legacy проектные
эндпоинты и вкладки без workflow сохраняют прежнее чтение; их version/CAS не
переписываются и данные не удаляются.

Opt+V фиксирует адрес вставки до await. Изменение membership или списка директорий
отзывает старое чтение, не переназначает ввод. Новый общий каталог будит читателя
по готовности даже до фонового пересчёта consumer inventory. Изменение директорий
и перенос вкладки будят прежнюю подготовку metadata без foreground scan, polling,
нового background owner или копирования тел файлов. Обычная сохранённая библиотека
Insert Prompt остаётся отдельной; текст файлов читается только при явной вставке.

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
Одновременные одинаковые stat/lstat/realpath делят только незавершённый syscall;
после его завершения запись удаляется. Это не TTL-кэш и не замена свежей binding
authority. Directory handles не разделяются. Диагностика различает active/waiting,
rejected и `fs_queue_full`; configured paths и содержимое файлов не логируются.

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
Одновременные usage requests делят одну pending inventory. Последующие reads
могут переиспользовать одну SQL ownership/order projection только под exact
connection-local certified catalog epoch; source label сам не сертификат.
Незаверенная schema/connection/future proof возвращает полную fresh assembly.
Retained projection не содержит paths/canonical leaf proofs: каждый получатель
заново проверяет configured sources/FS/layout/watch/policy и physical leaves,
final fence/diagnostic settle/lifetime, создаёт собственный detached результат.
SQL ownership имеет отдельную завершённую проверку authority до ожидания FS:
медленная или failed physical preparation остаётся explicit unavailable, но не
заставляет заново читать все tab headers. Reconciliation переиспользует только
тот же certified consumer/order projection; registrations, FS/layout/watch probes
и before/after fence остаются свежими. Unknown certificate сохраняет полный проход.
Usage собирает metadata paths по source, не неиспользуемые authoring DTO на каждую
вкладку. Равные project labels, overlap/alias и полный scope order сохраняются.
Sources reader переиспользует statements, не ответы; connection/schema swap
сбрасывает compiled ports. Exact selected authority читается до metadata и
повторно перед return; certified ownership hit доказывает ту же неизменность
SQL через current epoch, не повторяет все headers. Для retained SQL projection
посторонний commit другой connection может обновить только external fence, если
current certificate доказывает прежние catalog inputs. Полный API-result так
не переиспользуется: до/после чтения и await external `data_version` по-прежнему
проверяется вместе с connection/schema и relevant committed epoch. Из-за неполной notification coverage local
`total_changes()` остаётся conservative fallback (включая rollback), не authority.
19.10 owning schema composition устанавливает derived `catalog-read-epoch-v2`:
триггеры следят за exact catalog inputs, включая direct SQL writes без notify;
History/status/layout updates этот epoch не меняют. До/после await остаются fresh
fence и exact selections. Неизвестные schema/connection/epoch/trigger definitions
возвращают прежний fallback, reader не создаёт и не чинит authority. Известный v1
обновляет только schema owner атомарно; future/неизвестные определения не заменяет.
Source root/org versions проверяются при каждом чтении: row-only смена версии
не обязана менять SQLite schema cookie. Duplicate/escaped execution JSON keys
консервативно инвалидируют projection: JavaScript берёт последний duplicate,
SQLite может читать первый. Обычные уникальные keys сохраняют fast path.
Одна смена
допускает повторную pass, затем `prompt_catalog_changed`; unrelated writes не
инвалидируют FS inventory. Prepared statements — ports, не cached SQL answers.
Settings и durable
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
Постороннее sibling-событие такого sentinel, отвергнутое всеми source slots,
не планирует общий consumer reconcile. Null filename, затронутый root/ancestor
и неожиданно доставленный descendant сохраняют прежнюю консервативную проверку.
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

Повторные content-change events объединяются одним verifier на source и одним
preparing wake; epoch всё равно отзывается синхронно. Сканер запоминает regular
dirent facts обычных файлов: изменение их тела тоже не требует обхода docs.
Prompt identity, regular-file type, root/docs/layout и exact watcher owner
перепроверяются до возврата ready. Больше256 разных pending paths либо rename/
unknown/type change переходят в одну полную preparation, без обрезки inventory.
Старый verifier не публикует snapshot после нового dirty epoch/смены watcher.
Это исправляет прежний unbounded fanout: по одному async verifier на КАЖДЫЙ
event могло переполнить FS queue и оставить source failed с `unavailable`.

Граница Source19Oct:73 finite Node/SQL/VM/SSR checks; реальный HH docs и
`сообщения-обновления.prompt.md` прочитаны CURRENT scanner через контролируемые
workflow bindings.8 повторных открытий дали0 discovery scans. Это не проверка
новой installed версии или native latency.

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

В Opt+V есть общий раздел `Workflow`, справа — компактные
группы по директориям. Обычные сохранённые groups/ungrouped prompts остаются
отдельно в прежнем порядке. Папки выбираются настройками workflow; адрес вставки
остаётся exact вкладкой, в composer которой пользователь открыл меню.
Строка `Workflow` однострочная: subtitle отсутствует; при cold/preparing/stale
SVG loader заменяет ведущую иконку в том же15px слоте. Failed не показывает
бесконечный loader; код ошибки сохраняется у consumer, дочерний placeholder
сообщает отказ.

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
