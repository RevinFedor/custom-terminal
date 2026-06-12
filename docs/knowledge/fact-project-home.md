# Feature: Project Home View

## Intro
Центральный экран управления текущим проектом, отображающий все активные терминалы в виде наглядных карточек и историю закрытых вкладок. Позволяет быстро ориентироваться в сложной структуре открытых вкладок и восстанавливать прошлые AI-сессии.

## User Flow
1. **Активация:** Пользователь нажимает кнопку «Home» в правой верхней части (`ProjectToolbar`) или закрывает все вкладки терминала.
2. **Skeleton-load:** Пока IPC `project:get-tab-history` + `project:get-favorites` идут параллельно (Promise.all, типичное время 200-500ms на большой истории), отображаются пульсирующие placeholder'ы в форме финального двух-колоночного layout'а. Skeleton имеет ту же вертикальную высоту что и финальный контент, чтобы layout не прыгал после загрузки. Semantic Search и контентные секции (Active/Favorites/History) **не показываются** до момента `isLoaded === true`. До фикса Search успевал отрендериться раньше истории — юзер кликал в пустой Search и думал что приложение зависло.
3. **Двух-колоночный layout:**
   - **Левая колонка (flex-1, min-w-0):** История закрытых вкладок, сгруппированная по времени.
   - **Resizable divider (5px hit-area, 1px визуальная линия):** Pointer-based drag — тянем налево → правая колонка расширяется, направо → история. Ширина persist в `localStorage::noted-terminal-project-home-right-col-width` — этот префикс попадает в `MIRROR_PREFIXES` (см. `src/renderer/utils/persistedStorage.ts`), который синхронно зеркалит запись в SQLite `app_state` через `app:mirrorLocalStorageSync` IPC. Глобально на машине, переживает Vite dev-port shuffle (каждый `npm run dev` берёт следующий свободный порт → новый localStorage origin — без мирора настройки терялись бы). Старое имя ключа `project-home:right-col-width` (вне префикса, не зеркалилось) автоматически мигрируется в новый при первом чтении: read old → write new → delete old. Диапазон 140-480px, default **220px**. Migration-guard в loader'е: значения ≥ 320 (старый дефолт под 140px-карточки) сбрасываются в новый default при первом монтировании — иначе у существующих юзеров правая колонка будет с dead space справа, и они не догадаются что divider можно тянуть.
   - **Правая колонка (220px default, resizable):** Active Tabs + Favorites сверху вниз.
   - **Под колонками (full-width):** Semantic Search.
4. **Группы истории:** `Recent` (сегодня+вчера объединены, лейбл «Вкладки за сегодня — вчера»), `На этой неделе`, `Этот месяц`, `Старее`. Первые две — всегда открыты, последние две — collapsed по умолчанию. Объединение Today+Yesterday мотивировано тем, что пользователи редко проводят границу «то что вчера было» — обе категории воспринимаются как «вот только что закрытое».
5. **Навигация:** Клик по карточке переключает интерфейс в режим терминала (`currentView: 'terminal'`) и делает выбранную вкладку активной (для Active) или создает новую (для Favorites/History).
6. **Управление:** В конце списка Active всегда отображается кнопка «New Tab».

## Active Tabs (правая колонка)
Карточки активных терминалов **мимикрируют под оригинальные табы в TabBar** — одна строка `[Terminal icon] [name truncate] [● green dot]`, без CWD-строки. До этого карточка была двухстрочной с CWD под именем — два визуальных языка для одной и той же сущности (таб в TabBar vs карточка в Home), юзер вынужден учить оба. Сейчас Home-карточки выглядят как уменьшенная копия TabBar-таба.

Green dot (`#4ade80`, glow `0 0 4px rgba(74, 222, 128, 0.5)`) появляется когда CLI-процесс жив. Источник правды — те же события что у TabBar (`terminal:command-started` / `terminal:command-finished`), ProjectHome подписан **локально** (не через store): подписка живёт только пока компонент смонтирован, при возврате в terminal-view dispose'ится — нет смысла тащить состояние в Zustand и подписывать всё дерево.

CWD доступен только через CMD+hover popover (см. ниже) — bare-hover показывает только то что в карточке. Это сознательно: bare-hover Tooltip с CWD-строкой будет дублировать вторую строку оригинального TabBar таба, которая там не существует — снова два визуальных языка.

## Favorites (Закрепленные табы)
Правая колонка под Active Tabs. Карточки с полной непрозрачностью и цветной левой границей.
- **Действие:** Клик по карточке создает новую вкладку на базе сохраненных метаданных (CWD, Session ID и т.д.). Исходный фаворит при этом не удаляется.
- **ContextMenu:** Правый клик позволяет открыть таб или удалить из избранного.
- **Middle-click:** Быстрое удаление из списка избранного.
- **Дубли с History допустимы:** Один и тот же таб (одна и та же запись в `tab_history` по `name`+`cwd`) может одновременно сидеть в Favorites справа и в Recent/Week слева. Это сознательно — Favorites = «я хочу быстро воспроизвести эту конфигурацию» (semantic anchor), History = «вот недавно закрытое» (temporal anchor). Две разные ментальные модели поиска, дедуп замешал бы их.
- **Вторая строка карточки — `created_at` дата в формате `DD.MM.YY | HH:MM`, не cwd.** Идентичный формат и стиль (`text-[9px] text-[#aaa] font-mono`, marginLeft/Right -3, разделитель `|` цвета `#555`) что у Recent-карточек в History. Юзер: *«надо Favorites колонку сделать в статистике такой же как вкладку сегодня и вчера»*. Cwd одинаковый для большинства фаворитов в одном проекте — не помогает disambiguation. Дата добавления решает кейс same-named фаворитов (*«sdk-оптим... custom-terminal»* × 2 → теперь видно когда какой). Cwd доступен через CMD+hover popover.

## History (Closed Tabs)
Левая колонка ProjectHome. Плоский список групп по времени, сортируется по `closed_at DESC`.

### User Flow
1. **Закрытие вкладки:** При закрытии таб архивируется в SQLite через IPC `project:archive-tab`. Сохраняются все метаданные.
2. **Структура групп (русские лейблы):**
   - **«Вкладки за сегодня — вчера (N)»:** объединённый `Recent` бакет = `[yesterdayStart, now)`. Всегда развёрнут.
   - **«На этой неделе (N)»:** `[weekStart, yesterdayStart)`. Всегда развёрнут.
   - **«Этот месяц (N)»:** `[monthStart, weekStart)`. Collapsed по умолчанию.
   - **«Старее (N)»:** `< monthStart`. Collapsed по умолчанию.
   Группировка по `closed_at`, не `created_at` — для пользователя «недавно закрытая» вкладка важнее «недавно созданной» (последняя могла быть открыта неделю и закрыта только что).
3. **Управление (Clear):** Кнопка очистки истории («Clear») и опция «Keep with notes» отображаются только напротив старых (сворачиваемых) групп, чтобы подчеркнуть их статус архива.
4. **Вторая строка карточки — `DD.MM.YY | HH:MM` (closed_at), не CWD.** Раньше показывали `getFolderName(cwd)` приглушённым цветом `#666` — но юзер ищет в History не *«откуда таб был»* (CWD одинаковый для большинства табов проекта), а *«когда я его закрыл»*. Disambiguation для same-named tabs: `claude-03` закрытый дважды раньше выглядел двумя одинаковыми карточками. Теперь это `claude-03 / 15.05.26 | 08:42` и `claude-03 / 16.05.26 | 02:58`. Цвет `#aaa` — заметно ярче CWD-сигнала, моноширный шрифт чтобы цифры не прыгали. CWD доступен через CMD+hover popover. Бар `|` отдельным `<span>` с `margin: 0 2px` (стандартные word-spaces вокруг бара съедали ~12px, дата не влезала в 100px карточку). Вся стейт-строка получает `marginLeft/Right: -3px` — вылезает за card padding на 3px с каждой стороны, +6px полезной ширины **только второй строке** (имя сверху не задето).
5. **Hover Popover (CMD+hover):** При зажатом ⌘ и наведении на карточку появляется panel. Bare-hover (без ⌘) ничего не делает — Tooltip с крестиком/«Копировать» был отвергнут юзером (*«у нас уже есть моталка которая появляется при зажатии Command»*, *«удали этот Tooltip нахуй»*). **Split-mode**: два независимых блока вокруг карточки. **Над** карточкой — markdown notes (read-only). **Под** карточкой — metadata `Closed → Created → Path → Type → Messages`. Размеры — **не фиксированные**: алгоритм autobalance подгоняет ширину/высоту под форму контента в пределах cap'ов из Settings (макс. ширина, макс. высота, целевая пропорция). На Home обе панели имеют `pointer-events: none` — курсор проходит сквозь к карточке под/над, hover-эффект переключается на соседа в сетке. Закреп через CMD+Shift (белая рамка, см. `fact-tab-preview-popover.md::Закреп`) автоматически возвращает интерактивность. Restore выполняется **кликом по самой карточке** — кнопка «Восстановить вкладку» внутри popover'а была удалена как нарушение «один primary action = один жест». Полная механика — `fact-tab-preview-popover.md`.
6. **Restore:** Клик по записи восстанавливает вкладку и удаляет её из истории. Альтернативный путь — глобальный хоткей **Shift+Cmd+T** (VS Code-стиль), который popает самую свежую запись для активного проекта без открытия Home-вью. Учитывает позицию вкладки в TabBar и `processWasRunning`-флаг для авто-Continue Claude. См. [`fact-reopen-last-closed-tab.md`](fact-reopen-last-closed-tab.md).

## Context Menu (ProjectHome)
Все элементы на Home View (Active, Favorite, History) поддерживают контекстное меню по правому клику:
- **Active:** Switch to Tab, Add to Favorites, Close Tab.
- **Favorite:** Open, Remove from Favorites.
- **History:** Restore, Add to Favorites, Delete.

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
claude_session_id, gemini_session_id
```

## Behavior Specs
- **Visual Overlay:** Project Home рендерится как полноэкранный оверлей (`z-50`) внутри левой колонки. Он полностью перекрывает область терминала и **вкладки терминалов (TabBar)**, но оставляет видимым правый сайдбар.
- **Real-time Sync:** При редактировании названия проекта в табе (шапка), заголовок в Project Home обновляется мгновенно (через событие `project:name-sync`).
- **Auto-Redirect:** Если в проекте не осталось вкладок, система автоматически переключает вид на Home.
- **Visuals:** Все карточки (Active, Favorite, History) — **фикс-ширина 100px**, одна строка для Active и две (имя + дата/cwd) для Favorite/History. До этого было `maxWidth: 140 / minWidth: 90` — короткие имена (`tab-1`) рендерились в 90px, длинные (`worker-search`) в 140px, в одной wrap-строке колонки получались рваные. Карточки уменьшены до 100px (~-28%) по запросу юзера; полное имя всплывает в CMD+hover popover'е, не в bare-hover Tooltip'е. См. `methodology/переносимый-дизайн.md::Фикс-ширина для wrap-grid карточек`.
- **History Refetch:** История автоматически обновляется при изменении `tabs.length` (закрытие таба → refetch).
- **Session Search:** Collapsible секция ниже History — семантический поиск по всем сессиям Claude через embeddings. Фильтры: дата, проект. Настраиваемый лимит индексации. См. [`fact-semantic-search.md`](fact-semantic-search.md).
- **Scroll:** Контейнер ProjectHome использует `h-full overflow-y-auto` (не `flex-1`) — обязательно для скролла внутри `absolute inset-0` обёртки в Workspace.
- **Freeze diagnostics:** Home-flow логируется как цепочка, а не одним timestamp'ом. `[Perf:ProjectView]` / `[Perf:ProjectViewFrame]` показывают переключение terminal↔home на уровне workspace store; `[Perf:Home]` и `[Perf:HomeCommit]` отделяют IPC-загрузку history/favorites от render-to-frame; `[Perf:HomeStatusSync]` показывает параллельные `terminal:getCommandState` по Active tabs; `[Perf:HomeAction] active-tab-click` фиксирует клик по active-карточке перед `switchTab`. Если пользователь видит задержку сразу после клика Home, смотри ProjectView/HomeCommit; если задержка при возврате в таб — HomeAction + TabSwitchFrame2; если подвисает список active-карточек — HomeStatusSync/GetCommandState. `*Abs` поля нужны для корреляции с `[Perf:InputDelayContext]` и main-side `[Perf:MainLoopGap]`; без них Home можно ошибочно обвинить в задержке, которая случилась до доставки click event.
- **Semantic Search stats в Home-flow:** После `isLoaded === true` монтируется `SemanticSearchSection`, и она вызывает `search:stats` даже если пользователь не раскрывал поиск. Поэтому freeze сразу после Home может быть не в `HomeCommit` и не в `HomeStatusSync`, а в main-side stats IPC. Сигнатура: `[Perf:IpcSlow] channel=search:stats` + `[Perf:MainLoopGap] ... ipcAgg5s=search:stats:n=1:sum=...`. Норма после partial index — `search:stats` не появляется в slow IPC; если появляется, см. [`fact-semantic-search.md::Stats path на ProjectHome`](fact-semantic-search.md).
