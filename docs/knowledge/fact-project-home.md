# Feature: Общий архив, избранное и legacy Project Home

## Общий вход после workflow cutover

Home теперь отвечает за Storage и создание workflow. Закрытые вкладки и favorites
доступны через прежнюю History-кнопку в центральной рабочей области: архив не
перекрывает shell, Home или sidebar, отдельной кнопки Archive в titlebar нет.
Список компактный и виртуализированный, с цветом/status, числом итераций и датой;
wide preview отделён сохраняемым divider, narrow layout переходит в один поток.
Фильтры workflow/cwd/провайдера, read-only History/Timeline и явный Restore
сохранены. Query/выбор/ширина переживают закрытие страницы; кэш результатов
повторно связывается со свежими exact archive records до любого действия.
Iteration-hit выделяется по namespace/historyId/entryUuid, тогда как mutation
адресуется записью. Смена provider отменяет результаты прежнего поиска.
Прежний ProjectHome UI ниже — историческая поверхность; его
индексы и адресные archive records сохраняются в новом входе. Preview/search сами
не запускают provider; favorite и history не дедуплицируются по имени.

Архив адресуется exact namespace + historyId, не cwd или workflow. Restore
сохраняет execution snapshot и накладывает актуальные редактируемые name/notes,
включая пустую заметку. First claim хранит metadata baseline до materialization:
lease release/restart перед первым sync не превращает последующую правку архива
в уже перенесённую. Независимая более новая live-правка вызывает конфликт с
сохранением обеих версий. Архив потребляется только после owner/files/metadata
ACK; finish имеет durable same-ID receipt.

Очистка показывает полный storage scope namespace: число и все cwd, включая
file history rows, которые обычный список скрывает. Confirmation замораживает
scope/IDs/hash и requestId; изменение selector не меняет подтверждаемое действие.
Main проверяет полный состав/notes и активные restore leases до удаления.
Except-notes сохраняет whitespace notes, удаляя только NULL/пустые. Unknown ACK
повторяется с тем же запросом и receipt reader; новый ID не проверяет старый исход.

## Legacy ProjectHome

Следующие UI-описания относятся к ProjectHome до cutover. Они не определяют
расположение общего архива или Favorites в новом shell.

## Intro
Центральный экран управления текущим проектом, сейчас сфокусирован на истории закрытых вкладок и read-only предпросмотре содержимого. Home больше не пытается быть мини-дашбордом Active/Favorites/History: основной use case — быстро найти закрытую вкладку по названию или итерации, посмотреть History/Timeline без открытия терминала, затем явно восстановить её.

## User Flow
1. **Активация:** Пользователь нажимает кнопку «История» в полоске инструментов боковой панели вкладок (`SidebarToolsRow`) или закрывает все вкладки терминала.
2. **Skeleton-load:** пока IPC `project:get-tab-history` грузит историю, отображается skeleton в форме финального single-column layout'а. Active/Favorites и старый Semantic Search не монтируются на Home, поэтому начальный render не ждёт вторую колонку и не запускает `search:stats`.
3. **Split layout:** слева находится компактная колонка поиска и виртуализированного списка, справа постоянно зарезервирован read-only preview. Между колонками есть resize-divider. Пока строка не выбрана, справа пустое состояние; после выбора показываются History и узкая Timeline-рельса без терминала и без composer.
4. **История:** закрытые вкладки идут одной длинной колонкой, сортировка `closed_at DESC, id DESC`. Видимые заголовки групп убраны; временные бакеты (`Recent`, `This Week`, `This Month`, `Older`) используются только для fixed scroll-status над виртуализатором. Status показывает текущую группу и прогресс по ней (`N/M`) по нижнему видимому item'у.
5. **Навигация:** обычный клик по history-card выбирает preview и не удаляет запись из истории. Кнопка `Resume` внизу preview восстанавливает вкладку; Cmd/Ctrl-click делает тот же foreground restore сразу, middle-click — в фоне. Все точки входа используют общий reserve → create → durable save → commit flow: history-row удаляется только после сохранения replacement. Если сохранённый `cwd` больше не существует, Home остаётся видимым, запись сохраняется и пользователь видит toast. Для Codex auto-fallback в project root разрешён только при доказанной связи «тот же project/путь внутри project»; похожее обрезанное имя или ближайший существующий родитель требуют явного подтверждения, а корень `/` — выбора папки. Диагностика: `[ProjectHome:Restore]`, `[TabHistoryRestore]`, `[Archive:RestoreBegin/Finish]`.

## Active Tabs и Favorites

Active Tabs и Favorites временно не рендерятся отдельными колонками на Home. Это сознательная деградация поверхности: Home сейчас должен быть длинным восстановительным списком, а активные вкладки уже видны в TabBar/Sidebar. Старые handlers (`addActiveTabToFavorites`, `restoreFromFavorite`, `deleteFavorite`) могут оставаться в компоненте для context-menu путей и будущего возврата, но не должны снова тянуть `project:get-favorites` в начальный Home-flow без отдельного UX-решения.

Глобальный Dashboard и Project Home — разные поверхности. На глобальном Home
после `MCP servers` и перед `AI processes` находится collapsible `Storage`:
общий inventory Claude/Codex sessions, build outputs и app data. Он сканирует
filesystem только после раскрытия; Project Home по-прежнему отвечает только за
закрытые вкладки и read-only preview и не получает глобальный disk scan. Полный
контракт — [`fact-хранилище-сессий.md`](fact-хранилище-сессий.md).

Исторический rationale Favorites не удалён из данных: Favorites = semantic anchor («воспроизвести конфигурацию»), History = temporal anchor («недавно закрытое»), дубли между ними допустимы. Если Favorites возвращаются в UI, нельзя автоматически дедуплицировать их с History.

## History (Closed Tabs)
Единая колонка ProjectHome. Список виртуализирован, потому что реальная история проекта уже сотни строк (на проверке custom-terminal было 845 записей), а пользователь хочет один длинный scroll без ручного раскрытия месяцев.

### User Flow
1. **Закрытие вкладки:** При закрытии рабочий terminal/AI/browser-таб архивируется в SQLite через IPC `project:archive-tab`. Сохраняются все метаданные. `tabType='file'` исключён: это прикреплённый документ из sidebar, а не полноценная сессия, поэтому он не появляется в Home, Shift+Cmd+T и title/iteration индексах даже если старая polluted-запись уже есть в `tab_history`.
    - **Отказ архива отменяет закрытие целиком** — вкладка и процесс остаются. Это защита от «History указывает на одно, а живёт другое», но у неё есть цена: отказ происходит **после** confirm-шага, поэтому пользователь видит средний клик, который просто ничего не сделал, без единого диалога. Симптом читается как «вкладка не закрывается», а причина — в `[Archive:Close] snapshot rejected` и `[CloseTab] archive not committed`, не в close-логике.
    - Для Codex snapshot отдельно требовал **найденную строку вкладки** в `tabs`. Отсутствие строки трактовалось как опасность, хотя означает ровно обратное: вкладка создана в этой сессии и закрыта до первого сохранения, durable-сессии за ней нет и терять нечего. Теперь `row=missing` блокирует только при **живом** процессе (его identity записать некуда, а закрытие его убьёт); при idle такая вкладка архивируется с `source='unpersisted-tab'` и `codexSessionId=null`. Ошибка чтения строки (`status='error'`) по-прежнему блокирует всегда — там может лежать session id, который мы молча потеряем.
    - Реальная строка с `NULL` — не то же самое, что отсутствие строки: она авторитетна и означает «сессии действительно нет». Не сливать эти два состояния в одно.
2. **Скрытая структура групп:** `Recent` = сегодня+вчера, `This Week`, `This Month`, `Older` (`Старые месяцы`). Видимых секций и collapse-state больше нет: группировка нужна только для sticky progress header. Группировка по `closed_at`, не `created_at`.
3. **Карточка:** одна компактная row-карточка с полным `entry.name`, без ellipsis. Справа остаётся `DD.MM.YY | HH:MM`, optional RAG score и, если уже посчитан `message_count`, короткий счётчик `N it` слева от даты. Старые записи без счётчика backfill'ятся после загрузки Home малыми порциями и не блокируют первый render; когда main досчитал значение, он пушит точечное обновление строки в уже открытый Home, а не перезагружает весь список. CWD не выводится в строку: у большинства вкладок проекта он одинаковый и не помогает сканированию.
4. **Hover Popover (CMD+hover):** при зажатом ⌘ показывается metadata/notes split-popover. `Name` больше не дублируется в metaRows: полное имя уже видно прямо в карточке, а popover нужен для `Closed → Created → Path → Type → Messages` и заметок. На самой строке появляется зелёная `Resume`-плашка, потому что Cmd/Ctrl-click уже не preview, а немедленный restore. Bare-hover ничего не делает. Полная механика — `fact-tab-preview-popover.md`.
5. **Restore:** клик по записи открывает read-only preview; restore запускается только через кнопку `Resume`, Cmd/Ctrl-click или context menu. Альтернативный путь — глобальный хоткей **Shift+Cmd+T** (VS Code-стиль), который резервирует самую свежую запись активного проекта без открытия Home-вью. Home и хоткей идут через общий транзакционный flow, учитывают позицию, `group_id` и разные политики auto-Continue; история удаляется только после durable save новой вкладки. См. [`fact-reopen-last-closed-tab.md`](fact-reopen-last-closed-tab.md).

Restore из Home не дедуплицирует по имени. Одинаковые `tab-1`/`codex`/`claude` — валидные разные записи, особенно после форков и смены session id. Если вкладка не открылась, проверяй `[ProjectHome:Restore]`, `[TabHistoryRestore]` и `[Archive:RestoreBegin/Finish]`: запись должна остаться доступной для повтора. Для Claude/обычных терминалов отсутствующий cwd остаётся блокирующей ошибкой, потому что resume/шелл привязаны к конкретному рабочему дереву. Для Codex rollout хранит историю отдельно от cwd, но это не разрешение запускать Full Access в угаданной папке: equality/descendant project relation допускает auto-fallback, а похожий sibling-prefix или generic ancestor только предлагает точный путь для подтверждения. Отмена освобождает lease и сохраняет history-row.

Уточнение Restore24.09: Home возвращает сохранённые sidebar-соседей,
visual-parent/детей и место в прежнем существующем окне, как Cmd+Shift+T.
Background restore вставляет чип без смены показанного содержимого и фокуса.
Удалённые группы/окна не пересоздаются, архивы без метаданных расположения
сохраняют прежний fallback. Resume-policy Home по-прежнему `always`.

## Цвет сохранённой карточки не блокирует Home

Закрытая запись хранит цвет строкой, и эта строка может пережить версию
палитры. В инциденте05.10.2026 Home падал целиком при показе такой карточки:
локальная таблица возвращала undefined, а Virtuoso `itemContent` читал
`colorConfig.bgColor`. Installed stack указал именно history-row; прежний код
в приватном Electron воспроизвёл тот же TypeError на неизвестном цвете.
TypeScript `as TabColor` не проверяет пришедшую строку во время выполнения.

History, iteration results и Cmd-hover iteration preview используют общий
`getTabChromeColorConfig` через Home-boundary: неизвестный/пустой цвет рисуется
нейтральным. Нейтральный Home-fill остаётся прежним; известные оттенки берутся
из общего реестра, без второй палитры. Fallback меняет только отрисовку:
запись не удаляется, исходный color не переписывается, поиск/выбор остаются
доступны. Нельзя чинить этот сбой очисткой истории или скрытием всей карточки.

## Title Search

Верхний input в текущем Home — instant filter по `entry.name`. Он не ждёт Gemini/API и не меняет источник списка: пока iteration-search не активен, ввод просто сужает уже загруженную history-колонку по названию.

Title-only index хранится в SQLite (`tab_history_title_index`) как `history_id → name_hash → embedding`. Модель та же что в session semantic search (`gemini-embedding-001`, `outputDimensionality: 768`), но объём на порядки меньше: сотни/тысячи названий вместо десятков тысяч Q+A chunks. Поэтому search сканирует title embeddings в JS после загрузки rows, без sqlite-vec/native dependency.

Видимая кнопка `RAG` рядом с input сейчас принадлежит iteration-search; `Cmd+Enter` идёт туда же. Title-index остаётся отдельной maintenance-подсистемой с `{unindexed} new` и кнопкой `Index`. Если title semantic path возвращается в UI, ему нужен отдельный режим/чип: один и тот же `RAG` affordance не должен одновременно означать «искать по названию» и «искать по тексту итераций».

Во время индексации progress показывается в той же кнопке (`current/total`) со spinner'ом; отдельный большой progress panel не нужен. Это частный случай `methodology/дизайн-принципы.md::Async single-select` — индикатор живёт там, где был жест.

Settings → Системные может включить `Auto Title`: тогда новая history-запись после закрытия вкладки индексируется targeted по своему `history_id`, без полного прохода по старым unindexed rows. Переключатель действует только вперёд с момента включения, чтобы пользователь не получал внезапный backlog API-вызовов.

## Iteration Search

Вторая колонка контролов Home отвечает за поиск по user-итерациям внутри сохранённых Claude/Codex сессий. Кнопка `RAG` рядом с верхним input и `Cmd+Enter` используют текущий текст input как semantic query для iteration-search, а обычный ввод в input остаётся instant title-filter до явного запуска. Результат iteration-search заменяет обычный history stream: карточка сначала показывает найденную итерацию, затем имя вкладки, номер iteration, дату и score. Клик по результату открывает preview той же вкладки и просит HistoryPanel перейти к найденному `entryUuid`; Timeline остаётся read-only и не раскрывается в tree-layout.

Iteration results — отдельная поверхность, не обычная history-card. Обычный клик открывает preview и скроллит к найденному user prompt; Cmd/Ctrl-click **не** делает restore, потому что в этом режиме Cmd занят чтением результата. Cmd+hover показывает простой popover полного user prompt'а над карточкой: ширина равна карточке, высота примерно 2× карточки, внутри scroll. Старый metadata/notes popover с `Resume` здесь не используется — иначе пользователь видит два противоречивых смысла Cmd: «восстановить вкладку» и «прочитать найденную итерацию».

В header результатов есть локальный фильтр `all / codex / claude`. Он фильтрует уже найденную RAG-выдачу, а не запускает повторный semantic request: пользователь должен иметь возможность быстро отсечь один тип агента и вернуться на `all` без потери исходного результата.

Iteration index живёт отдельно от title index и использует уже существующие timeline parser'ы (`parseTimelineEntries` для Claude и Codex timeline builder), чтобы не расходиться с History/Timeline по uuid и parent chain. Индекс считает только user-сообщения и хранит `history_id`, `entry_uuid`, `iteration_index`, summary/content и embedding. Stats показывают реальное число обнаруженных user-итераций для уже распарсенных histories, а для ещё не индексированных histories временно используют `message_count` как approximate total.

После полного прохода индексатор помечает каждую просмотренную history-запись отдельной scan-отметкой, даже если в ней ноль user-итераций или исходный transcript недоступен. Без этой отметки `message_count` остаётся вечным approximate tail: пользователь видит `520/1981`, повторно нажимает Index, получает те же `520/1981`, хотя все доступные итерации уже обработаны. `Full` должен после первого полного прохода схлопнуть total к реально обнаруженным итерациям (`indexed/discovered`), а не продолжать считать недоступные истории как `new`.

В header блока `Iterations` есть collapsible date range. `Full` означает весь архив. При выборе даты подпись становится `YYYY-MM-DD - today`, stats/search/reindex ограничиваются `closed_at >= выбранная дата`. Раскрытый контрол компактный: preset-кнопка слева подставляет «за неделю» / «за месяц», дата редактируется как текст `YYYY-MM-DD`, check-кнопка сворачивает контрол и применяет диапазон; сворачивание открытого контролa делает то же самое. Loader показывается на месте счётчика `indexed/total` и держится достаточно долго, чтобы быстрый stats-ответ не скрывал feedback.

Состояние Home восстанавливается по проекту: title query, активный iteration query, найденные iteration results и фильтр `all/codex/claude` переживают переключение между проектами. Иначе пользователь запускает дорогой RAG-поиск, переходит в другой проект на секунду и возвращается в пустой Home, хотя смысловой результат уже был получен.

При клике по iteration-result правый preview закрывает History/Timeline оверлеем loader'а до события `history-panel:scrolled-to` для нужного uuid. HistoryPanel всё равно монтируется и скроллит за оверлеем; цель — скрыть промежуточный пустой state и дёрганье внутреннего scrollbar'а, а не заменить event-driven scroll фиксированным timeout. Safety timeout только снимает overlay если событие не пришло.

Settings → Системные может включить `Auto Iterations`: при archive новой Claude/Codex history-записи индексатор targeted-парсит только этот `history_id` и эмбеддит user-итерации с timestamp после момента включения. Live JSONL watcher для активной вкладки сюда не добавлен намеренно: текущий search/result shape опирается на `tab_history.history_id`, а активная вкладка ещё не является history item.

## Context Menu (ProjectHome)
Все элементы на Home View (Active, Favorite, History) поддерживают контекстное меню по правому клику:
- **Active/Favorite:** handlers сохраняются для совместимости, но карточки сейчас не рендерятся на Home.
- **History:** Restore, Add to Favorites, Delete.

`Обновить название` появляется для Claude/Codex active-tab карточки (если эта поверхность вернётся в UI) и для history-записи с `claude_session_id` или `codex_session_id`. Active path вызывает тот же явный override, что ПКМ по вкладке: обновление игнорирует прежний `nameSetManually`, показывает per-item loader `Название обновляется...`, а результат снова помечается ручным именем, чтобы будущий auto-title его не перетёр. History path не восстанавливает вкладку ради rename: он читает сессию напрямую, генерирует title по сохранённому session id/cwd и сохраняет только `tab_history.name`.

При изменении history-title обязательно инвалидируется `tab_history_title_index` для этой записи. Title-only index привязан к старому `name`; простое `UPDATE tab_history SET name` без удаления embedding оставит поиск по старому названию, хотя карточка уже показывает новое. После успешного rename Home обновляет локальные `history`/`semanticResults` и refresh'ит stats, чтобы кнопка `Index` могла пересобрать только устаревшую строку.

### Directory Management
Рядом с отображением текущего пути проекта в Home View находится иконка редактирования (карандаш/папка).
- Клик открывает системный диалог выбора папки.
- Обновление пути через `updateProject` мгновенно меняет корень для всех новых терминалов и файлового менеджера.

### Критическое правило: Immediate Injection при Restore
При восстановлении AI-вкладки `claudeSessionId` / `geminiSessionId` передаются в `createTab()` через `options`. Это гарантирует, что InfoPanel **мгновенно** видит ID сессии, без ожидания PTY или Sniper Watcher.

### Данные History Entry (SQLite)
```
id, project_id, name, cwd, color, notes,
command_type, tab_type, url,
created_at, closed_at,
claude_session_id, gemini_session_id,
codex_session_id, codex_model, codex_effort,
name_set_manually, session_status, group_id
```

## Behavior Specs
- **Visual Overlay:** Project Home рендерится как полноэкранный оверлей (`z-50`) внутри левой колонки. Он полностью перекрывает область терминала и **вкладки терминалов (TabBar)**, но оставляет видимым правый сайдбар.
- **Real-time Sync:** При редактировании названия проекта в табе (шапка), заголовок в Project Home обновляется мгновенно (через событие `project:name-sync`).
- **Auto-Redirect:** Если в проекте не осталось вкладок, система автоматически переключает вид на Home.
- **Visuals:** History больше не wrap-grid, а левая bounded-column рядом с постоянным preview. Полное имя видно в row; CMD+hover не дублирует name. Preview Timeline занимает только ширину collapsed Timeline-рельсы (~32px); не добавлять справа пустой декоративный блок. Selected/hover state карточек усиливает их собственный `TabColor` через alpha-step, а не красит всё в зелёный: зелёный уже занят Codex/Resume-семантикой. См. `methodology/дизайн-принципы.md::Контролы по контенту, не на всю ширину` и `methodology/дизайн-принципы.md::Semantic > symmetry: active через alpha-step`.
- **History Refetch:** История автоматически обновляется при изменении `tabs.length` (закрытие таба → refetch).
- **Session Search:** Старый collapsible `SemanticSearchSection` по JSONL-сессиям больше не рендерится на Home. Верхний input — instant title-filter, visible `RAG` — iteration-search, title-only index — отдельная maintenance-подсистема. См. [`fact-semantic-search.md`](fact-semantic-search.md).
- **Scroll:** Контейнер ProjectHome использует `h-full overflow-hidden flex flex-col`; виртуализатор владеет внутренним scroll (`flex-1 min-h-0`). Не возвращать внешний `overflow-y-auto` вокруг всего Home: он конфликтует с bounded list и sticky progress header.
- **Freeze diagnostics:** Home-flow логируется как цепочка, а не одним timestamp'ом. `[Perf:ProjectView]` / `[Perf:ProjectViewFrame]` показывают переключение terminal↔home на уровне workspace store; `[Perf:Home]` и `[Perf:HomeCommit]` отделяют IPC-загрузку history от render-to-frame. Старые `[Perf:HomeStatusSync]` по Active tabs и `search:stats` не должны появляться в нормальном Home-flow; если появились, значит кто-то вернул Active/Favorites или old SemanticSearch mount.
