# Feature: Project Home View

## Intro
Центральный экран управления текущим проектом, сейчас сфокусирован на истории закрытых вкладок. Home больше не пытается быть мини-дашбордом Active/Favorites/History: основной use case — быстро найти закрытую вкладку по названию, восстановить её или открыть контекстное меню.

## User Flow
1. **Активация:** Пользователь нажимает кнопку «Home» в правой верхней части (`ProjectToolbar`) или закрывает все вкладки терминала.
2. **Skeleton-load:** пока IPC `project:get-tab-history` грузит историю, отображается skeleton в форме финального single-column layout'а. Active/Favorites и старый Semantic Search не монтируются на Home, поэтому начальный render не ждёт вторую колонку и не запускает `search:stats`.
3. **Single-column layout:** рабочая область ограничена по ширине, центрирована и содержит сверху title-search row, ниже status row и виртуализированный список. Ограничение ширины не декоративное: реальные названия вкладок короткие (обычно `tab-1`, `run-dev`, `claude-02`), и full-width строки на широком экране визуально превращают короткое имя в «тонущую» карточку.
4. **История:** закрытые вкладки идут одной длинной колонкой, сортировка `closed_at DESC, id DESC`. Видимые заголовки групп убраны; временные бакеты (`Recent`, `This Week`, `This Month`, `Older`) используются только для fixed scroll-status над виртуализатором. Status показывает текущую группу и прогресс по ней (`N/M`) по нижнему видимому item'у.
5. **Навигация:** клик по history-card восстанавливает вкладку и удаляет её из истории; middle-click восстанавливает в фоне. Context menu остаётся точкой для Restore/Add to Favorites/Delete.

## Active Tabs и Favorites

Active Tabs и Favorites временно не рендерятся отдельными колонками на Home. Это сознательная деградация поверхности: Home сейчас должен быть длинным восстановительным списком, а активные вкладки уже видны в TabBar/Sidebar. Старые handlers (`addActiveTabToFavorites`, `restoreFromFavorite`, `deleteFavorite`) могут оставаться в компоненте для context-menu путей и будущего возврата, но не должны снова тянуть `project:get-favorites` в начальный Home-flow без отдельного UX-решения.

Исторический rationale Favorites не удалён из данных: Favorites = semantic anchor («воспроизвести конфигурацию»), History = temporal anchor («недавно закрытое»), дубли между ними допустимы. Если Favorites возвращаются в UI, нельзя автоматически дедуплицировать их с History.

## History (Closed Tabs)
Единая колонка ProjectHome. Список виртуализирован, потому что реальная история проекта уже сотни строк (на проверке custom-terminal было 845 записей), а пользователь хочет один длинный scroll без ручного раскрытия месяцев.

### User Flow
1. **Закрытие вкладки:** При закрытии таб архивируется в SQLite через IPC `project:archive-tab`. Сохраняются все метаданные.
2. **Скрытая структура групп:** `Recent` = сегодня+вчера, `This Week`, `This Month`, `Older` (`Старые месяцы`). Видимых секций и collapse-state больше нет: группировка нужна только для sticky progress header. Группировка по `closed_at`, не `created_at`.
3. **Карточка:** одна компактная row-карточка с полным `entry.name`, без ellipsis. Справа остаётся `DD.MM.YY | HH:MM` и optional RAG score. CWD не выводится в строку: у большинства вкладок проекта он одинаковый и не помогает сканированию.
4. **Hover Popover (CMD+hover):** при зажатом ⌘ показывается metadata/notes split-popover. `Name` больше не дублируется в metaRows: полное имя уже видно прямо в карточке, а popover нужен для `Closed → Created → Path → Type → Messages` и заметок. Bare-hover ничего не делает. Полная механика — `fact-tab-preview-popover.md`.
5. **Restore:** клик по записи восстанавливает вкладку и удаляет её из истории. Альтернативный путь — глобальный хоткей **Shift+Cmd+T** (VS Code-стиль), который popает самую свежую запись для активного проекта без открытия Home-вью. Учитывает позицию вкладки в TabBar, `processWasRunning`-флаг для авто-Continue Claude и `group_id`, если group-row ещё существует. См. [`fact-reopen-last-closed-tab.md`](fact-reopen-last-closed-tab.md).

## Title Search

Верхний поиск имеет два слоя:
- **Instant filter:** ввод в input синхронно фильтрует уже загруженную историю только по `entry.name`. Это не RAG и не fuzzy over transcript; задача — мгновенно сузить список по названию вкладки.
- **RAG:** `Cmd+Enter` или кнопка `RAG` запускает semantic search по отдельному title-only индексу. Индексируются только названия вкладок, не JSONL и не notes. Это сознательный trade-off: top-search должен быть быстрым и дешёвым, а глубокий поиск по transcript остаётся отдельной подсистемой session semantic search.

Индекс хранится в SQLite (`tab_history_title_index`) как `history_id → name_hash → embedding`. Модель та же что в session semantic search (`gemini-embedding-001`, `outputDimensionality: 768`), но объём на порядки меньше: сотни/тысячи названий вместо десятков тысяч Q+A chunks. Поэтому search сканирует title embeddings в JS после загрузки rows, без sqlite-vec/native dependency.

UI рядом с поиском показывает `{unindexed} new` и кнопку `Index`. Во время индексации progress показывается в той же кнопке (`current/total`) со spinner'ом; отдельный большой progress panel не нужен. Это частный случай `methodology/переносимый-дизайн.md::Async single-select` — индикатор живёт там, где был жест.

## Context Menu (ProjectHome)
Все элементы на Home View (Active, Favorite, History) поддерживают контекстное меню по правому клику:
- **Active/Favorite:** handlers сохраняются для совместимости, но карточки сейчас не рендерятся на Home.
- **History:** Restore, Add to Favorites, Delete.

`Обновить название` появляется для Claude/Codex active-tab карточки (если эта поверхность вернётся в UI) и для history-записи с `claude_session_id` или `codex_session_id`. Active path вызывает тот же явный override, что ПКМ по вкладке: обновление игнорирует прежний `nameSetManually`, показывает per-item loader `Название обновляется...`, а результат снова помечается ручным именем, чтобы будущий auto-title его не перетёр. History path не восстанавливает вкладку ради rename: он читает сессию напрямую, генерирует title по сохранённому session id/cwd и сохраняет только `tab_history.name`.

При изменении history-title обязательно инвалидируется `tab_history_title_index` для этой записи. Title-only RAG индекс привязан к старому `name`; простое `UPDATE tab_history SET name` без удаления embedding оставит поиск по старому названию, хотя карточка уже показывает новое. После успешного rename Home обновляет локальные `history`/`semanticResults` и refresh'ит stats, чтобы кнопка `Index` могла пересобрать только устаревшую строку.

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
- **Visuals:** History больше не wrap-grid, а bounded single-column stream. Карточки занимают всю ширину этой ограниченной колонки, но сама колонка не растягивается на весь viewport. Полное имя видно в row; CMD+hover не дублирует name. См. `methodology/переносимый-дизайн.md::Контролы по контенту, не на всю ширину`.
- **History Refetch:** История автоматически обновляется при изменении `tabs.length` (закрытие таба → refetch).
- **Session Search:** Старый collapsible `SemanticSearchSection` по JSONL-сессиям больше не рендерится на Home. Title search сверху — отдельная title-only подсистема. См. [`fact-semantic-search.md`](fact-semantic-search.md).
- **Scroll:** Контейнер ProjectHome использует `h-full overflow-hidden flex flex-col`; виртуализатор владеет внутренним scroll (`flex-1 min-h-0`). Не возвращать внешний `overflow-y-auto` вокруг всего Home: он конфликтует с bounded list и sticky progress header.
- **Freeze diagnostics:** Home-flow логируется как цепочка, а не одним timestamp'ом. `[Perf:ProjectView]` / `[Perf:ProjectViewFrame]` показывают переключение terminal↔home на уровне workspace store; `[Perf:Home]` и `[Perf:HomeCommit]` отделяют IPC-загрузку history от render-to-frame. Старые `[Perf:HomeStatusSync]` по Active tabs и `search:stats` не должны появляться в нормальном Home-flow; если появились, значит кто-то вернул Active/Favorites или old SemanticSearch mount.
