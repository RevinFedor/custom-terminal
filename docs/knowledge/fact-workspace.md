# Feature: Workspace, workflow и каталоги

## Intro
Workflow организует окна и вкладки независимо от их рабочих директорий.
Это source-контракт перехода07.10; отметка внедрения принадлежит версии приложения,
а не успешной компиляции или приватному тесту.

## Workflow, вкладка и исполнение

Цветные группы оконной полосы хранятся в metadata workflow `stripColorGroups`
(version/revision/groups), независимо от глобальных sidebar-групп. CURRENT Source20Oct
записывает их прежним `commitWorkspace`/mutation journal: explicit
`stripColorGroupEdits` с точным field basis меняет definition. Source22Oct также
принимает explicit ordinary release intent: Main сам вычисляет IN/OUT moving roots
по raw basis/owner/activity, сохраняя order+membership той же transaction.
Incidental полный snapshot сохраняет более свежий Main field, даже если renderer
уже принял latest organization revision. Unknown/null/future basis не означает
пустой набор; потерянный ACK восстанавливается тем же mutation ID.

CREATE gather и цвет принимаются одной transaction. Main сверяет exact window и
исходный порядок до применения; stale source отвергает оба изменения без journal
или сдвига clocks. ACK применяет metadata и slots одной публикацией, без focus/
activate/remount; более новая локальная перестановка не откатывается. Recolor не
переставляет окна/вкладки, reorder не меняет execution namespace или color revision.
Активная проекция исключает только явно inactive участников, не меняя raw
definition/basis. Recolor сохраняет прежних закрытых участников того же workflow;
CREATE требует active membership, unknown/foreign не превращаются в ready-empty.
Эта authority не разрешает Send/Stop/Full и не меняет общий global-group CAS.

Поздняя публикация A не заменяет синхронно принятую local release pair B.
Неизвестный preflush, ещё не submitted command и submitted UNKNOWN различаются;
очередь хранит exact preparation/frozen continuation и восстанавливает прежний
request/key. Оба session writers сохраняют recovery envelope, но queued intent
без command key после restart не даёт права автоматически отправить новый key.
При настоящем foreign basis/owner/activity конфликте B остаётся unreconciled.
Свежий canonical read и проверенный `stripReleaseDeferrals` позволяют сохранить
независимое U; receipt `deferredStripReleases` явно называет несохранённые поля B.
Успех U в таком случае не означает durable успех B. Номинальный согласованный
B+U сохраняется полностью. Проверка допуска читает directory identity profile,
без извлечения чужих `record_json`; это не общий предел памяти каталога.

Source21Oct optional `group.collapsed` — часть того же field/group CAS; toggle
повышает definition revision, не меняя raw tabIds/color/unknown fields. Incidental
snapshot не может сбросить его. OPEN-fit использует отдельный `arrange` intent в
прежнем `stripColorGroupEdits`: exact owner/before-slots/basis и перестановка только
representative среди своих placed members. Цвет/group revision при этом прежние.
Main сохраняет canonical extensions slots; ACK adopt применяет этот order только
к captured window при отсутствии более нового локального order. Navigation/close
отзывают reveal, но не переписывают уже принятый durable результат. Source не
восстанавливает старый состав из order-only drop presentation или после await.

Source22Oct selected-first selection использует тот же representative-only
arrange и не меняет color/group revision. Перед решением «уже первый, no-op»
существующая очередь сначала восстанавливает прежний accepted/unknown arrange;
иначе select2 с потерянным ACK, затем select1 теряет последнее намерение.
Rebase разрешён только exact witness той же операции/basis/owner/before/order,
не произвольной более новой DnD-публикацией. Ожидание обычной activation/readiness
не удерживает organization lane; поздняя смерть UI отзывает reveal/focus, но не
усвоение уже принятого durable результата. Направление absolute-ряда — read-only
geometry metadata, не новый membership/order proof и не исполнение вкладки.

Пользователь отказался от Projects как обязательных контейнеров директорий:
одно окно может содержать вкладки разных cwd, а один репозиторий — участвовать
в нескольких workflow. Поэтому принадлежность вкладки хранится один раз в Main,
а её размещение и исполнение имеют отдельные владельцы. Смена организации не
перезапускает PTY, не пересоздаёт SID/tabId и не меняет принятые requests/receipts.
Удаление workflow переводит оставшихся участников в системный Inbox; архив,
groups, roots, favorites и exports имеют собственный срок жизни.

Full Close сохраняет `workflow_org_memberships` как происхождение для Restore.
Поэтому membership row не равна текущей вкладке: active catalog требует
resolved execution row, `execution_archived!=1` и существующий workflow.
Storage17.10 использует ту же границу; окна/sidebar/reserve/stopped внутри
active membership сохраняются, закрытые native rows не попадают в Open now.
Истёкший архив не восстанавливается через latest/by-id/window undo; его
минимальная search source identity сохраняется отдельно от restore payload.

Полные `workflow_org_generations.snapshot_json` — служебные диагностические
копии, не authority новых операций. После накопления восьми отдельный worker
оставляет первый migration snapshot и два последних. Current organization,
prepared migration source и immutable mutation request/response receipts не
подчищаются. Maintenance error не отзывает committed publication. Подробности
сроков, private-test границ и SQLite free pages — `fact-хранилище-сессий.md`.

Старые `projectId`/namespace — адреса legacy исполнения, а не новые workflow IDs.
Один namespace может адресовать вкладки разных workflow/cwd. Существующие v1
guards project/cwd сохраняются; новый v2 subject не требует Project row/FK.
Организационная миграция не разрешает удалить адресные aliases или ослабить
writer guards. Saved/read SID по-прежнему не доказывает право писать.

Пустой typed execution namespace (`executionScopeVersion:2`) при restore/open
остаётся пустым; legacy правило «нет вкладок → Terminal 1» к нему не относится.
12.10 оно создало неперсистентный `__tab_catalog_v2__-tab-0`, который затем
попадал в общий snapshot рядом с новым v2 subject. Exact-address guard правильно
отвергал весь save. Исправляется источник лишней строки, не фильтрация неизвестных
записей, создание скрытого Project или ослабление CAS. Старые реальные Projects
сохраняют прежний default-tab flow.

Read-only metadata тоже следует этому разделению. Batch History freshness не должен
отбрасывать standalone tab из-за отсутствия legacy Project: INNER JOIN раньше терял его
read descriptor, хотя прямой History уже возвращал known proof. Project даёт только
fallback cwd; собственный cwd/SID вкладки остаётся доступным без Project row. Проверки
фактического read owner и источника сохраняются, descriptor сам по себе не означает fresh.

Bulk organization readers (`listGlobalTabs`/`listMembers`) переиспользуют подготовленные
SQL-statements только внутри одного read transaction. Они каждый раз читают текущие
native/legacy execution rows и membership; это не кеш строк по revision и не runtime
proof. Подготовка не должна повторяться для каждой вкладки: на каталоге666 строк
адресный SQLite-control сократил2664PREPARE до5, сохранив parity с отдельными getTab.
ЧислоPREPARE не равно числуSELECT, все нужные live metadata по-прежнему читаются.

Порядок workflow разрешает один shared `orderedWorkflows`: опубликованный
`publication.metadata.workflowOrder`, затем конечный numeric `metadata.order`
для неуказанных ID, затем стабильный входной порядок; Inbox всегда последний.
Отсутствующий order не равен нулю. Шрам F7: новый workflow без order появлялся
между A/B в renderer, а explicit Main reorder игнорировался. Main list, renderer
projection и phone DTO теперь используют один resolver. Refresh/ACK меняет
локальный порядок лишь пока он равен последнему принятому publication; новый
локальный drag и существующие объекты layout/focus/MRU не затираются.

Полный phone inventory отличается от desktop reserve только отбором участников:
в `catalog-v1` входят все active memberships, включая placed/hidden/dormant/profile,
stopped/unstarted/shell/file. Shared selection/tree/group intersection не вычитает
окна для этого клиента. Порядок вкладок сначала берёт `reserveOrder`, fallback
повторяет cold hydration: сохранённый порядок namespace в workspace-session и
прежний per-namespace row order, без сортировки по имени/cwd/MRU. Mixed root order
остаётся `reserveRootOrder`; visual parent и physical parent передаются отдельно.
Wire, clocks и capability — `fact-mobile-web.md::Каталог workflow для native`.

Catalog-v2 сохраняет этот full membership/tree, отделяя лёгкий index от materialized
details: первые5canonical leaf files под tab-parent, затем20; все обычные rows доступны.
Raw parent не заменяет canonical group/tree ownership. Этот Core read не является
window placement projection (`windowPresentation:false`) и не меняет namespace,
writer/drag или политику скрытых/profile участников.

## Резерв, окна и переходы

Sidebar показывает резерв выбранного workflow и пересечение глобальных групп
с ним. Невыбранный chip, скрытое окно, dormant layout и другое display profile
остаются размещением. Группа не удаляется, когда все её участники размещены.
Detach меняет размещение; same-workflow действия сохраняют automation eligibility.
Перенос между workflow меняет scope будущего inventory, не frozen queue targets.

Пустое окно не наследует `activeTabId` общего execution namespace: путь sidebar
берётся из текущего chooser либо workflow default. Выбранная настоящая вкладка
показывает собственный cwd. New из пустого места sidebar и новый оконный chooser
начинаются с workflow default, затем с cwd показанного участника при отсутствии
default; explicit chooser directory и source-addressed API сохраняют свой приоритет.
Выбранная папка не меняется от перехода в другой workflow во время await.
Ошибки операций sidebar и меню групп идут одним событием в прежний верхний правый
Toast до явного закрытия, не хранятся красной строкой в retained sidebar/меню.
Copy сохраняет исходный workflow/name/action, UTC, target IDs, mutation ID,
expected/current group/publication revisions и known-rejection против unknown ACK;
ошибка после перехода в другой workflow не получает адрес текущего экрана.
Перенос ошибки в Toast не означает исправление её причины или разрешение повтора.

Ревизия глобальных групп независима от organization revision. Создание участника
группы в `registerTabArtifacts` продвигает её publication без изменения definition
revision самой группы; allocation ACK не содержит этой publication. Шрам12.10:
renderer не принимал groups из обычного organization ACK, а отказ group-mutate
не перечитывал группы — следующие клики повторяли устаревший expectedRevision.
`workflowGroupExpansion` перед записью читает Main publication и сверяет прежнюю
definition revision точного group ID. Несвязанная новая membership допустима,
чужой rename/collapse/delete не перезаписывается. Main сохраняет обе точные CAS;
гонка после чтения отклоняется с обновлением UI для следующего явного действия.
Все публикации groups принимаются по собственной монотонной revision, включая
organization read и старый receipt. `workflowGroupClient` восстанавливает потерянный
ACK через прежний durable receipt (`workflow:group-mutation`) либо exact retry
неизменённого запроса. Unknown держит очередь; dwell cancel ждёт этот исход,
после подтверждения использует новую ревизию. Таймера/polling/сброса CAS нет.

Фоновая дочерняя MCP-вкладка без явного окна получает membership workflow
источника и появляется в его резерве. Отдельной подписи `↳ <родитель>` под
карточкой нет: пользователь09.10 отверг такое несогласованное оформление.
Sidebar показывает карточки и иерархические связи текущего дерева; отсутствие
другого участника в reserve не добавляет текстовую строку. `contextParent` в
модели остаётся техническим контекстом проекции/drag guards, не UI-требованием.
Запуск сессии без membership не делает
её участником списка. Предварительная reservation ID не является восстановлением
существующей вкладки: детали — `fact-terminal-mcp.md::Workflow-aware target`.

Перед tab-card и серией chips одного execution namespace нет иконки директории
или дополнительного межпроектного зазора. Пользователь выбрал одну принадлежность:
при переносе в другой workflow вкладка становится его участником, без отдельной
«зоны ответственности». WorkflowChip продолжает обозначать сам workflow.
В desktop ПКМ вкладки убраны Group и Move; DnD остаётся способом переноса и
иерархии. Группы как сохранённые контейнеры и native API этим не удаляются.

Над списком нет отдельной шапки «Резерв» и дублирующих кнопок folder/plus.
Прежняя TabLocationLine показывает cwd выбранной вкладки либо будущий cwd
chooser; это не директория workflow. Создание Terminal/Claude/Codex и Group
доступно прежним общим меню по ПКМ на пустом месте; double-click создаёт вкладку,
правая зона строки меню выбирает окно. Настроенный sidebar gap сохраняется.

Обычный клик по вкладке desktop reserve добавляет chip в фокусное окно,
сохраняя соседей. Уже размещённая вкладка раскрывается по прежнему адресу.
В контекстном меню `Open beside` открывает отдельное окно (использует свободное
видимое место, если есть). По решению пользователя от 11.10.2026 пункт
`Replace current` убран из меню вкладок, связанных файлов и файлового дерева.
Это один `openTabById` с явным `windowAction` и прежний window writer, без новой
сессии/копии. Адрес фокуса до async подготовки проверяется до размещения;
поздний ACK не возвращает фокус. `add new` из меню существующей вкладки убран,
создание осталось через + и пустую область.

Обычный клик по строке прикреплённого файла в popup/reserve и по нижнему chip
открывает тот же owned reader у вкладки-владельца; повтор закрывает его. Даже
если file-tab отдельно размещён в другом workflow, просмотр не следует туда
и не добавляет chip. Шрам11.10: замена callback на `openTabById(file.id)` вызвала
лишние chips и переход в Inbox16:05; возвращён прежний preview ingress. Middle
и явный `Open beside` остаются самостоятельным размещением, Unlink — отдельным.

Файл дискового sidebar открывает свой chip. Дисковый путь переиспользует
однозначный существующий file-tab; иначе прежний
factory создаёт самостоятельный file-tab в выбранном workflow, без PTY и без
привязки к случайному агенту. Одновременные клики разделяют создание, ушедший
пользователь не получает поздний foreground. Middle по file-row открывает сбоку,
по оконному chip снимает placement; Unlink остаётся отдельным действием.

Любая вторичная ссылка к tabId открывает существующее точное окно/workflow.
Скрытое окно возвращается в последнюю колонку/строку, где его показывали на
текущем дисплее этого workflow; занимающее место окно целиком скрывается.
Если такого места ещё нет или колонка исчезла, используется окно перехода.
Portal-чип оркестрации передаёт своего tab-owner, поэтому соседний глобальный
фокус не подменяет место клика. Явный picker по-прежнему заменяет выбранное окно.
Если размещения нет, вкладка добавляется в последнее фокусное окно своего
запомненного workflow, сохраняя соседей. Это устраняет повторявшийся баг:
Rewind-ready/MCP переход заменял текущий chip и показывал чужой workflow.
Нет component-level fallback на «текущий проект». Только подтверждённый async
`true` завершает переход; уход пользователя отменяет поздний foreground reveal.
Explicit add-here/DnD сохраняют собственный смысл.

Пустой workflow при переключении, как и при startup, материализует vacant window.
Последний activeTabId общего execution namespace не является выбором этого
workflow: иначе Inbox показывает чужую карточку и добавляет её рядом с первой
открытой вкладкой. Сохранённые parked chips остаются в пустом окне без неявного
выбора; сохранённый собственный activeSpaceTab восстанавливается обычным путём.

Групповой drag фиксирует выбор на pickup: более поздний selection не добавляет
участников. Перенос в резерв раскрывает visual forest, а оконный placement
оставляет визуальные AI-children самостоятельными; physical children и файлы
следуют своему точному owner. Hover лишь меняет видимый workflow. Один release
сохраняет показанный результат с исходными guards, не превращается в Project
transfer и не переписывает runtime. Причины и границы —
[`fact-tabs.md::Structured outline DnD`](fact-tabs.md#structured-outline-dnd-во-вкладках).

## Home, файлы и контекст

ПКМ по workflow открывает настройки именно этого ID, независимо от активного
workflow. В них одна редактируемая подпись/иконка, основная и дополнительные
директории. Их `docs/**/*.prompt.md` общие для всех вкладок workflow, включая
новые вкладки общего execution namespace. Sources и выбора отдельной вкладки нет.
Закрытие по фону, X и Escape сохраняет текущий ввод без Save; отказ сохранения
держит окно открытым. Каталог следует membership; живой cwd сессий не меняется.
Иконка редактируется у workflow, а не у cwd-регистрации. Модалка имеет отдельный
ephemeral UI owner: фоновые tab-команды, Opt+V, reopen и font shortcuts не
перехватывают её ввод; Tab остаётся внутри, Escape не закрывает вкладку под ней.

Home показывает Storage и создание workflow. На широкой области оба находятся
слева, подробности выбранного объекта — справа; на узкой области сохраняется
один поток. Storage имеет одного владельца selection при смене ширины.
История/избранное открываются привычной History-кнопкой в центральной области,
с доступными Home, workflow strip и sidebar. Общие resource/process/MCP chips имеют одного владельца в shell и доступны
на Home и Workspace. Клик по уже выбранному workflow с Home возвращает его layout.
Inbox системный, определяется kind/стабильным ID, стоит справа и не удаляется;
общий WorkflowChip отличает его tray-иконкой и янтарной палитрой.
Создание workflow не требует cwd. Его optional defaultCwd — начальный каталог
для New: explicit cwd → source-tab cwd → workflow default → прежний fallback.
Desktop fallback на показанную вкладку допускается только в том же workflow.
Изменение default не меняет cwd/subject существующих вкладок. Context menu
`Path: <basename>` копирует полный defaultCwd, а не cwd последней вкладки;
если default не задан, действие недоступно. Root registry не является разрешением
работать в директории и не переписывает cwd живой вкладки.

Меню workflow шириной190px: `Rename`, `Settings`, `Path`, `Stop idle | Stop all`,
`Delete`, с ведущими SVG. Stop занимает одну разделённую строку; Path копирует
полный defaultCwd, длинное имя ограничено ellipsis, полный путь остаётся в title.
Первое действие завершает живые свободные сессии, пропуская собственную работу,
подготовку Send/paste, ожидание MCP и неизвестное idle-состояние. Второе завершает
все живые процессы этого workflow, включая работающие. Область — полное active
membership Main, включая reserve и скрытые окна; execution namespace каждой
вкладки сохраняется. Остановка сохраняет вкладки, историю и оконное размещение.
Main фиксирует цели до первого await и перед Stop сверяет membership/subject,
живого владельца и для первого режима снова idle. Новый процесс/перенос/busy
после capture не становится целью старого клика. Цвет счётчика сам по себе не
разрешение на Stop. Механика — `fact-ai-sessions.md::Остановка сессий workflow`.

Пустой organization-ready workflow может иметь activeProjectId=null: это отсутствие
выбранного исполнения, а не отсутствие workspace. Общая оболочка с sidebar,
vacant pane/New и TerminalArea остаётся смонтированной. Legacy guard по наличию
project раньше возвращал пустой div и размонтировал все удерживаемые History/xterm;
при возврате данные ещё попадали в cache, но готовый DOM уже приходилось строить
заново с loader. Ветка early-return применима только до workflow cutover.

Прикреплённые файлы — точные связи: меню проходит по файловым потомкам, без
транзитивного присвоения файлов AI-child родителю. Фиолетовый чип располагается абсолютно у нижнего края карточки:
название с файлом сдвинуто на1px ниже прежнего положения. Измеряется общий для
шрифта cap/descender envelope, а не CSS line box или отдельное имя: все карточки
имеют одинаковую минимальную высоту, независимо от наличия файлов. Нижние
выносные элементы могут касаться чипа; файл рисуется выше текста. При большом
padding название и чип смещаются вместе. CURRENT Source20Oct сохраняет
геометрию file chip от прежнего6px gutter, а оконный ряд резервирует7px:
нижний край файла оставляет2px до следующего ряда для двух1px групповых рамок;
неиспользованный запас идёт на уменьшение общей высоты. Ширина, размер
шрифта/чипа сохраняются. В reserve sidebar чип не дублируется: файл уже показан
самостоятельной строкой дерева. Нижняя
полоса task-квадратов убрана, данные задач и отдельный availability
signal сохранены. Боковой status marker выровнен по строке названия.
Чип показывает открытый/последний открытый файл владельца, до первого открытия —
первый в сохранённом порядке; начало имени с ellipsis и отдельное несжимаемое +N.
Нехватка ширины больше не заменяет имя голым числом. Строки popup имеют ширину
собственного имени/иконки, ограниченную viewport, а не ширину самой длинной строки.
Единственный attachment chip открывается левым кликом; hover также показывает его строку меню.
Имя chip повторным кликом закрывает тот же reader; +N отдельно открывает/закрывает меню.
Левый клик именно по строке этого меню открывает самостоятельный chip файла.
Компактное Y/X-дерево с file glyph появляется и скрывается сразу; bridge и
контекстное меню файла удерживают общий hover без таймера. Hover увеличивает чип
только transform от нижнего края, сохраняя1px до следующего ряда. Hover файла не красит
родительскую карточку. Дублирующий header и directory subtitle отсутствуют.
Выбранный файл и его owner получают связанные состояния; Preview использует
существующий reader нужной панели. Middle по popup/sidebar file открывает его сбоку,
по оконному chip снимает только placement; отдельное окно отмечено inset-линией.
Строки popup имеют высоту общего TabCard/sidebar при минимальной внешней рамке.
Unlink закрывает связь/file tab и сохраняет
disk bytes; отдельный Delete File сначала подтверждает Trash, затем удаляет exact
связь. Порядок/иерархия меню общие с reserve, root-outdent не выходит из владельца.
Passive navigate-mode для chooser не открывает вложенное меню при hover. Детали —
`fact-tabs.md::Файловые вкладки как visual-child`. Контекстная и управляющая строки заметок имеют локальный hover;
существующие New/collapse/undo/архив остаются прежним flow.

Первый font read у retained/portalled host не всегда описывает его окончательную
отрисовку. Замер требует подключённого DOM и повторяется при изменении размеров
строки/загрузке шрифта; baseline probe кэшируется по профилю шрифта. Иначе тест
отдельной карточки может пройти, а в полной шапке верх имени окажется обрезан.
Hover и движение указателя не являются поводом для нового замера.

Canvas/context для этих замеров переиспользуется только внутри своего Document.
Каждое чтение по-прежнему берёт текущий computed font и измеряет ink: кэш baseline
не заменяет свежий размер текста. Перед назначением font восстанавливается исходный
canvas font, чтобы непринятое значение не наследовало шрифт предыдущей карточки.
При том же последнем назначенном font приватный context не сбрасывается повторно;
свежий measureText всё равно выполняется, включая изменение ink до loadingdone.
Потерянный/недоступный context создаётся заново; loadingdone очищает профили и
последнее назначение, поэтому следующий замер снова применяет font.
Private Electron сравнение проверяет геометрию, но само не доказывает latency
полного workspace. Формула layout и существующие font/resize observers сохранены.

## Совместимость прежнего Project UI

Разделы ниже описывают поверхность до workflow cutover и legacy implementation.
Они объясняют сохранённые data/API paths, но не разрешают вернуть Projects в
новую навигацию. Текущий contract организации и переходов находится выше.

## Legacy user flow: Управление проектами
1. **Переключение:** Пользователь видит список открытых проектов в самом верху окна (Project Tabs).
   - Активный проект имеет белый фон.
   - **Quick Rename:** Двойной клик по названию проекта в Title Bar позволяет мгновенно изменить имя без захода в настройки.
2. **Редактирование (Edit Modal):**
   - Можно изменить не только имя, но и системный **путь** проекта.
   - **System Picker:** Кнопка выбора папки открывает нативный диалог ОС.
   - **Live Validation:** Статус пути проверяется в реальном времени (✅ существует / ⚠️ не найден).
3. **Dashboard:** Отображает все проекты из БД.
   - **Compact Paths:** В карточках отображаются только последние две папки пути (например, `vs-code/my-app`).
   - **Instant Tooltip:** При наведении на сокращенный путь мгновенно всплывает полный адрес.
3. **Файлы:** Пользователь открывает Sidebar (`Cmd+B`) — общий Noted file explorer, не компонент GT Editor.
   - Проводник открывается поверх терминала через React Portal (см. `methodology/сценарии-багов-design.md::6.3. UI поверх canvas: Portal или Layering Pattern`).
   - Поддержка: общий structured DnD файлов и иерархии, rename, create, delete, context menu, multi-select (Cmd/Shift+Click). Terminal включает обычный Y/перенос и folder-hover без Cmd; Cmd разрешает только X-вложенность. У общего файлового renderer это host opt-in, не смена default GT Editor.
   - Ширина sidebar ресайзится drag handle (min 180px, max 500px), сохраняется в localStorage глобально.
   - Пользователь делает `Cmd+Click` по пути файла в терминале -> файл открывается в **File Preview**.
4. **Заметки:** Пользователь открывает заметку текущей вкладки в slide-out (`Cmd+E` или иконка `StickyNote` справа в активной вкладке TabSidebar). Подробнее: [`knowledge/fact-notes.md`](notes.md).

## Legacy behavior и сохраняемые независимые поверхности
### Настройки проекта: «Только значок»

В окне настроек проекта, на строке с названием справа, стоит переключатель «Только значок». Включённый — в шапке от карточки остаётся один значок, без подписи.

Скрыта именно ПОДПИСЬ, а не имя: оно остаётся в подсказке при наведении, в доступности (`sr-only`), в поиске и во всех списках. Карточка, на которой ничего не написано, не должна быть ещё и неопознаваемой.

**Без значка настройка невозможна** — карточка стала бы пустым прямоугольником. Переключатель в таком случае не исчезает, а гаснет и объясняет причину: исчезнувшая настройка выглядит как «её тут не бывает», погасшая — как «сначала поставьте значок» (значок задаётся отдельно, Настройки → Значки). Правило стоит на ОБОИХ концах — в интерфейсе и на чтении из базы (`hide_name === 1 && !!icon`): значок можно убрать позже, и одно лишь выключение галочки в интерфейсе этого не переживёт.

Хранится в `projects.hide_name`, идёт тем же путём, что имя и значок (`project:save-metadata`).

- **Two-Column Layout:** `TabSidebar` (вертикальные вкладки + drag-resize ширины) слева + Terminal-колонка справа. Раньше была третья правая колонка `NotesPanel` (InfoPanel + Resizer) — удалена. Project tools поднялись наверх (сначала в полосу `ProjectToolbar`, с 2026-08-18 — в полоску инструментов боковой панели и правую часть шапки, см. [`fact-верхняя-полоса.md`](fact-верхняя-полоса.md)), Claude-контролы (Provider/Model/Effort/Think + Continue/Stop/Fork) переехали в `ClaudeControlBar` под Terminal (см. [`fact-claude-control-bar.md`](fact-claude-control-bar.md)), заметки переехали в slide-out (Cmd+E).
- **Sidebar Stability:** `TabSidebar` (левая колонка) остаётся смонтированной при переключении между Терминалом и Home. Компоненты (Timeline) не удаляются из DOM, а скрываются через `visibility`, что предотвращает Layout Shifts.
- **Persistent Mounting:** Workspace остается смонтированным всегда после первого открытия. Переход Dashboard ↔ Workspace осуществляется через CSS-скрытие. См. `knowledge/fact-terminal-rendering.md` (раздел 2).
- **Navigation History:** При закрытии активного проекта система не выбрасывает пользователя на Dashboard, а переключает на предыдущий проект из истории (Stack-based navigation).
- **Home / DEV environment marker:** Это один navigation-toggle с одной геометрией. В production он показывает оранжевые `⌂ Home` из палитры приложения; в development — фиолетовые `⌂ DEV`. Dev определяется не только по `localhost`: built-renderer E2E идёт через `file://`, поэтому runtime также читает `import.meta.env.DEV` и main-owned `NODE_ENV=development`. Поведение клика, active Dashboard border и размеры карточки не меняются между средами.
- **Project-указатели и workflow membership различаются.** Legacy `activeProjectId` и `focusedProjectId` сохраняются для project-owned поверхностей. Активация вкладки согласует оба указателя; явный просмотр другого проекта может временно припарковать боковое меню. Cmd-прицеливание окна сохраняет эту парковку. Эти указатели не заменяют текущий workflow reserve/membership. История решения и исключения — [`fact-рабочая-область.md`](fact-рабочая-область.md).
- **Project Focus:** При активации области проектов (`activeArea`), панель получает подсветку `bg-white/[0.05]`, а активный проект — скругленную рамку `ring-1 ring-white/50`. Но запомненный `activeArea` не является доказательством владения клавишами: Left/Right переключают проекты только если физический `event.target` не принадлежит xterm, `.gt-composer-editor`, input/textarea/select/button или contenteditable. Поэтому клик по терминалу/composer защищает их стрелки даже при устаревшем `activeArea=projects`; модифицированное либо уже обработанное событие также не перехватывается.
- **VSCode-style Creation:**
    - При `Cmd+T` или двойном клике создается проект "Новый проект".
    - Если пользователь отменяет ввод (`Esc`, клик мимо) или оставляет имя дефолтным — проект **автоматически удаляется** из БД и закрывается.
    - Система запоминает `previousProjectId` и возвращает пользователя назад при отмене.
- **Project Tabs UI:** Высота 40px, шрифт регулируется в настройках. Убраны лишние отступы и скругления для строгого вида.
- **Inbox system workspace:** `Inbox` закреплён между Home и обычными проектами как project-like workspace, а не как отдельная Home-страница. Это дефолтный контейнер для API-созданных и «непривязанных» agent-вкладок: он использует ту же поверхность Workspace/ProjectHome/Timeline/History/Run after, чтобы tabs/groups/status не расходились во второй модели. Отличается только chrome: нет файлового sidebar, browser/editor/index/docs-кнопок, rename/delete/close как у обычного проекта. Общие чипы ресурсов, MCP-хаба и usage доступны как в обычном workspace; Git определяется по каталогу показанной вкладки, без исключения для Inbox (см. `fact-верхняя-полоса.md`). Перетаскивание live-вкладок в Inbox — это перенос владения через существующий cross-project move, не clone/copy PTY/SDK-сессии; безопасного клона live-сессии в проекте нет.
- **Project + Workflow Icons:** Идентичность берётся из точного исходного 64×64 project raster. Workflow хранит цветную копию в `spaces[].icon`, project metadata (`projects.icon`) — свой original; обе поверхности всегда показывают исходные цвета без глобального grayscale-фильтра. Семь built-in PNG закреплены SHA-256 тестом как production icons ДО первой workflow migration; ручные нарисованные SVG удалены. Проект без собственной картинки получает цветную папку, поэтому пользователь может включить «Только значок» без пустой/count-only карточки; имя остаётся в tooltip и accessibility.
    - Редактирование живёт в одном компактном дереве Settings → Проекты: workflow → project chips, плюс секция «Без workflow». Один project имеет одного workflow-родителя; workflow может иметь несколько projects, первый является default. Выбор image/SVG идёт через общий cropper → async 64×64 PNG → `updateProject({icon})` либо `updateWorkspaceSpaceMetadata({icon})`.
    - Production migration v2 заменяет предыдущие generated icons точными PNG и создаёт отсутствующие workflows `gt-editor` и `mac-electron` в фоне через live store (`addWorkspaceSpace` + metadata update), не прямой записью DB. GT/Mac project ownership переносится атомарно правилом одного workflow-родителя. Системный Inbox исключён уже из входа migration planner: он root-level workspace, а не directory-project и не может стать дочерним chip какого-либо workflow. Иначе planner ожидал `main + Inbox`, live store правильно сохранял только `main`, а post-write verify бесконечно повторял уже корректную миграцию.
    - **Project order ownership:** Порядок открытых проектов принадлежит renderer `openProjects` Map, а не SQLite `updated_at`. Drag reorder вызывает `reorderProjects`, сохраняет session order и шлёт `project:order-changed` для native clients. Mobile/iOS после этого заново читает `/api/projects`; он не должен выводить порядок из project-activity runtime списка.
    - **CSP prerequisite:** Иконки хранятся как PNG либо пользовательский SVG `data:` URL, поэтому renderer CSP обязан разрешать `img-src 'self' data: blob:`. Симптом отсутствующего `img-src`: metadata непустая и картинка валидна, но `<img>` показывает broken-image placeholder, `naturalWidth=0`, а DevTools Security пишет CSP refusal. Для production одной правки данных недостаточно: установленный `app.asar` должен быть пересобран/переустановлен.
- **Explorer (Sidebar):** Автоматически открывается в CWD активного терминала. Renderer и DnD приходят из нейтрального `../noted-shared`; локальных PragmaticFileTree-копий и re-export shims больше нет. Custom Terminal оставляет у себя filesystem IPC, file-tab и `Link File` как адаптеры продукта.
    - Клик по названию текущего корня открывает Finder для выбора новой рабочей папки именно этой вкладки. До подтверждения живого `cd` заголовок показывает процесс, но старый корень остаётся на экране. Для сохранённой Claude/Codex-сессии после подтверждения создаётся ветка в новой папке; остальные вкладки проекта не перезапускаются.
    - Ручной порядок и visual-parent связи синхронизируются с GT Editor через `~/.noted-terminal/shared/file-layout.db`, keyed по абсолютному корню проекта. CAS revision защищает одновременные записи двух Electron-процессов; focus/visible polling подхватывает чужое изменение.
    - Открытость sidebar, карта раскрытых папок и вертикальный scroll принадлежат конкретному project record и восстанавливаются из SQLite при переключении и перезапуске. Два проекта с одинаковым filesystem path сохраняют эти состояния независимо; selection и keyboard-focus остаются краткоживущим состоянием смонтированного viewport.
    - **Уход из проекта — не click-outside.** Overlay-close слушает `mousedown` на window, поэтому клик по project tab, Inbox или Home/Dashboard раньше засчитывался как «мимо sidebar»: покидаемый проект закрывал свой sidebar и писал этот `false` в SQLite. Симптом читался как «состояние не сохраняется», хотя сохранялось именно закрытие. Любой элемент, уводящий из проекта, помечен `data-project-navigation` и исключён из close-теста; клик по терминалу закрывает sidebar как раньше.
    - **Раскрытые папки: durable-состояние не привилегия first mount.** У дерева две памяти — durable из project record (`initialExpandedDirs`) и in-memory map, keyed по `folderPath`. Восстановление из durable раньше стояло под условием `!prevFolderPathRef.current`, то есть работало только на первом монтировании; любая последующая смена корня уходила в пустую in-memory ветку и схлопывала все папки. Правило теперь приоритетное, а не одноразовое: непустая in-memory → durable → пусто. Пустая in-memory-запись **не** побеждает сохранённые папки. `initialExpandedDirs` читается через ref, не через dependency: каждое сохранение отдаёт новый объект, и зависимость перезагружала бы всё дерево на каждый expand.
    - **Ложный корень на кадр переключения проекта.** `resolvedExplorerPath` вычисляется асинхронно (`app:check-path-exists`), поэтому после смены проекта кадр держит корень предыдущего — для Inbox это `getInboxProjectPath()` → `$HOME`. Для дерева это обычная смена `folderPath` со всеми последствиями. В логах видно парой: `TREE LOAD /Users/fedor` (32 элемента), через 370 мс `TREE LOAD <project>` (42). Resolved-значение принимается только пока совпадает с `rawExplorerPath`/`projectRootPath` текущего проекта, иначе берётся сырой путь.
    - **Cleanup устаревших путей не пишет тотальную очистку.** Загрузчик дерева удаляет из expand-state пути, которых нет в дереве, и сохраняет результат. При чужом корне не совпадает **ни один** путь, и в SQLite уезжал пустой объект — сохранённые папки терялись уже необратимо. Полное обнуление непустого состояния теперь считается признаком несовпадения корня: из текущего рендера пути убираются, но запись в project record пропускается (`Skipped saving cleared expand-state — root mismatch`). Явный `handleCollapseAll` сохраняет пустоту как раньше — это намерение пользователя, а не побочный эффект.
    - **Scroll переживает выход.** Позиция пишется throttle'ом (150 мс), а `beforeunload` не доживает до async `invoke` — последний сдвиг терялся, и после рестарта дерево открывалось на устаревшем месте. Shutdown-flush отправляет pending-значения через синхронный канал (тот же приём, что `project:save-tabs-sync`). Проверено живьём: scroll 512 → `beforeunload` → в SQLite сразу 511.66, без ожидания интервала.
    - Shared DB может иметь непустую revision с пустым payload после очистки/E2E restore. Это не ручная сортировка: manual mode включается только при реальном order/visual-parent entry.
    - Каждый consumer явно принимает одну версию `noted-shared`; build прекращается при несовпадении либо возвращении app-local копии. Renderer-код бандлится Vite из нейтрального checkout, а main-process layout/atomic-move модули копируются в production resources явно. React, `lucide-react` и `react-icons` резолвятся из consumer: общий source не может принести второй React или случайный minor UI-runtime.
    Ключевые адаптации приложения:
    - Pending `pointerdown` не захватывает pointer до movement-threshold, поэтому обычный click доходит до файла/папки и вложенных контролов. После доказанного drag общий слой подавляет только post-drag click.
    - Любой обычный click по неинтерактивной части folder-row сразу переключает раскрытие, включая два быстрых click подряд; rename папки доступен только через ПКМ. У файла первый click открывает/фокусирует preview, второй быстрый запускает rename и не повторяет host-действие открытия, поэтому уже открытый preview не закрывается как побочный эффект double-click.
    - Файл и папка используют тот же outline-контракт: файл может быть visual-parent, папка остаётся физическим parent. Общий preview показывает будущую иерархию до release, а host решает, нужен ли layout-only commit или filesystem batch.
    - `window.electronAPI` bridge создаётся в renderer (nodeIntegration: true) вместо preload, т.к. custom-terminal не использует contextIsolation.
    - Базовые пункты ПКМ, их порядок, viewport-clamp и Rename pencil принадлежат общему menu shell; наличие action callback является capability. `Open in Finder` остаётся OS reveal через host callback, а не открытием file preview. Для файла Finder выделяет сам файл; для папки — саму папку в родителе. Та же операция должна быть доступна у прикреплённой file-tab, чтобы “найти файл в Finder” не требовало возвращаться в дерево.
    - ПКМ по файлу содержит `Link File`, который открывает тот же AI-tab inventory picker, что `Run after` / `Restart after`, но в context-row режиме. Выбор не открывает editor внутри дерева, а создаёт `tabType='file'` рядом с выбранной Claude/Codex/SDK-вкладкой и связывает его через `visualParentTabId`. Это сделано для рабочего просмотра “нужный файл рядом с сессией”: пользователь не должен каждый раз открывать `Cmd+B`, если файл нужен как постоянный референс. Детали tab-side поведения — [`fact-tabs.md::Файловые вкладки как visual-child`](fact-tabs.md).
    - `Link File` является host-only extension общего меню и больше не имеет собственного списка/геометрии submenu. Он зависит от `RunAfterTabPicker`: workflow/`Не размещены`, project-owned группы и порядок вкладок должны совпадать с остальными AI-target picker'ами, а outside-click root menu обязан игнорировать клики внутри picker portal. Горизонтальный workflow rail прокручивается обычным колесом без Shift. В GT Editor этой команды нет по контракту, а не потому что она вручную скрыта стилями.
- **Empty State:** Если в проекте нет вкладок, отображаются быстрые кнопки (Claude, Gemini, New Tab).

## User Flow: Dashboard

Dashboard является стартовым экраном приложения, ориентированным на быстрый доступ к проектам и глобальный мониторинг AI-активности.

- **Project Selection:** Клик по карточке проекта загружает его контекст (терминалы, вкладки). ProjectCard компактная: первая строка держит иконку, имя и маленький счётчик вкладок; счётчик показывается всегда, даже если активных процессов нет. Вторая строка — короткий path более светлым серым, без лишней третьей строки.
- **Card Actions:** destructive/delete и settings живут в правом верхнем углу поверх названия и не резервируют ширину в layout. У них приоритет над текстом при hover, потому что это редкие точечные действия; основной клик по карточке остаётся открытием проекта.
- **Reserved Directories удалены:** отдельной сущности Bookmarks/Reserved Directories на Dashboard больше нет. Не возвращать `Add Directory` / `Reserved Directories` как быстрый способ создания проекта без нового продуктового решения.
- **Electron Dev processes:** сразу после Projects показываются лаконичные одно-строчные карточки dev Electron-приложений. Stop должен убивать root process + descendants, но не текущий `process.pid`; основной кейс — закрыть зависший Electron dev-процесс, чей parent terminal уже умер и который сам показывает бесконечные error modal.
- **Process Monitoring:** ниже идут Claude, Gemini и Codex секциями. Каждая секция ограничивает высоту и scroll локально; раскрытие показывает ограниченное число процессов, а не растягивает весь Dashboard. Protected процессы другого dev/prod instance видны с owner badge, но batch action помечен `external only` и не трогает их.
- **MCP servers:** список MCP ограничен по ширине и высоте, счётчик процессов читаемый. Orphan-логика связана с ownership всех живых custom-terminal instance, а не только текущего окна.
- **Navigation chrome на Home:** project tools и workflow strip имеют одного
  App-owned владельца над развилкой Dashboard/Workspace. Поэтому titlebar
  projects, полный `SpaceStrip` и сокращённый до `История` directory-row остаются
  при переходе на глобальный Home и являются теми же DOM/component instances,
  а не копиями. History-клик с Home сначала выбирает internal Project Home и
  возвращает Workspace; workflow DnD/menu/switch работают на месте.
- **Cleanup:** Из Dashboard удалены все вкладки (Prompts, Quick Commands), так как управление ими перенесено в настройки приложения.
