# Feature: Tab Management

## Intro
Система вкладок в стиле VSCode с разделением на зоны (Main/Utils), поддержкой интеллектуального именования и автоматического окрашивания. В 2026-05 переехала из горизонтального TabBar (над терминалом) в постоянный левый сайдбар (`TabSidebar` 200px default, drag-resize 140-400 через handle на правом краю). Root layout: `[Titlebar] / [ProjectToolbar — full width] / [TabSidebar | TerminalArea | TabNotesSlideout]`. Горизонтальный TabBar остался как fallback-режим в utility-зоне (dropdown collapsed-табы), полное удаление пока не сделано — единая компонента отдаёт оба layout'а через `layout='vertical'` prop.

## Tab Naming Patterns
### Auto-generated Names
- `tab-1`, `tab-2`, ... — стандартные новые вкладки (непустой стек счетчика)
- `docs-01`, `docs-02`, ... — вкладки обновления документации (Gemini анализ + Claude редактирование). **Общий счетчик** для обоих потоков.
- `claude-1`, `gemini-1` — AI сессии (только если не переименованы вручную через `nameSetManually`)

### Persistence Guard
При создании таба через `createTabAfterCurrent` с опциями `{ nameSetManually: true }` флаг сохраняется в БД и блокирует авто-переименование в `setTabCommandType`. Это критично для вкладок типа `docs-XX`, которые не должны перезаписываться на `claude`/`gemini` при запуске AI.

## User Flow: Жизненный цикл таба
1. **Создание:** Пользователь нажимает `Cmd+T` или делает двойной клик на пустом месте TabBar.
   - Система ищет первое свободное число для имени (`tab-1`, `tab-2`).
   - Новый таб наследует `cwd` текущего активного таба. См. `knowledge/fact-fact-terminal-core.md`.
   - **Сброс выделения:** При создании нового таба через `Cmd+T` или интерфейс, текущее множественное выделение вкладок автоматически сбрасывается.
   - **Switch to Terminal:** Если пользователь находится в Home View, нажатие `Cmd+T` или клик по любому табу в `TabBar` автоматически переключает вид на терминал.
   - **DnD & Focus Movement (Intelligent UX):** При перетаскивании активного таба на другой проект (или в SubAgentBar как часть адоптации) фокус приложения автоматически перемещается вместе с табом. Это предотвращает "состояние лимба", когда вкладка исчезает из `TabBar` в текущем проекте, но пользователь остается на пустом экране. **UX-психология:** Человеческий взгляд следует за объектом действия. Если пользователь "забрасывает" таб в SubAgentBar, система гарантирует, что этот таб останется видимым и активным, предотвращая диссоциацию интерфейса.
2. **Запуск процесса:** Пользователь вводит `npm run dev`.
   - Таб мгновенно переименовывается в `run-dev` (если не был переименован вручную — `nameSetManually`).
   - Цвет таба меняется на зеленый (если не был задан вручную — `colorSetManually`).
   - Появляется кнопка **Smart Restart (↻)** в левой части таба (Restart Zone).
3. **AI Сессия:** Пользователь вводит `claude`.
   - Таб становится оранжевым (`#DA7756`).
   - Кнопка Restart скрывается, так как для AI она не актуальна.
   - **Ручное имя сохраняется:** Если пользователь переименовал таб ДО запуска AI, имя НЕ перезаписывается на `claude`/`gemini`. Флаг `nameSetManually` (персистентный, хранится в БД) блокирует auto-rename в `setTabCommandType`.
4. **Управление:** 
   - Пользователь делает правый клик (ПКМ). Открывается меню: **Close Tab** -> **Rename** -> **Color** (подменю).
   - **Multi-Select:** Поддержка выбора нескольких вкладок через `Shift+Click` (диапазон) или `Cmd+Click` (по одной). При этом контекстное меню адаптируется, скрывая инструменты переименования. См. [`knowledge/fact-data-persistence.md`](knowledge/fact-data-persistence.md).
       - **Multi-Tab DnD:** Выделенные вкладки можно перетаскивать группой. При перетаскивании на другой проект в Title Bar появляется кастомный превью-индикатор с бейджем `+N`, показывающим количество переносимых вкладок.
       - **Group Close:** Если выбрано несколько вкладок:
           - Нажатие `Cmd+W` закрывает всю группу.
           - Клик колесиком мыши (middle click) по любой *выделенной* вкладке закрывает всю группу.
           - Клик колесиком по *невыделенной* вкладке закрывает только её, сохраняя остальное выделение.
       - **Sub-Agent Viewing (Cmd+W):** Если пользователь просматривает суб-агента через `SubAgentBar`, нажатие `Cmd+W` не закрывает вкладку, а возвращает вьюпорт к родительскому Gemini-табу.
       - **Favorites:** Пользователь может сохранить конфигурацию таба (путь, имя, цвет, AI-сессию) в «Избранное» через контекстное меню таба или терминала. Избранные табы отображаются в Home View.
       - **Sub-agent Visibility:** Табы с установленным `parentTabId` (суб-агенты) автоматически скрываются из всех зон `TabBar`. Они доступны только через `SubAgentBar` над терминалом. Система использует сквозной поиск по всем открытым проектам, гарантируя видимость агентов даже при их ошибочной привязке к другому воркспейсу.
       - **Normalization:** Метод `setTabParent` в сторе принудительно нормализует пустые строки `''` в `undefined`. Это критично для корректной работы фильтров `!t.parentTabId`, так как пустая строка в JS является falsy, но часто сохраняется в БД как значение.
       - **Сброс выделения:** Клик вне области `TabBar` (например, по терминалу или боковой панели) автоматически снимает множественное выделение.
       - Пользователь может закрыть таб колесиком мыши. **Исключение:** middle-click по RestartZone (зелёная точка/↻) останавливает процесс (Ctrl+C) вместо закрытия вкладки — `onAuxClick` с `stopPropagation` перехватывает событие до TabItem.
   
   ## User Flow: Управление проектами
   
Вкладки проектов в шапке приложения ведут себя аналогично терминальным табам.
- **Drag-and-Drop:** Пользователь может перетаскивать проекты для изменения их порядка.
- **Empty Zone:** При наведении на пустое место справа от проектов, индикатор перемещения прилипает к последней вкладке.
- **Индикаторы процессов:** Бейджи на вкладках проектов показывают количество активных процессов (зелёный) и прерванных AI-сессий (синий).
- **RestartZone Pulse:** Зеленая точка на табе начинает пульсировать (opacity 1.0 -> 0.3) когда AI-агент (Claude или Gemini) находится в состоянии `busy` (думает или пишет). 
    - Детекция состояния busy для Claude выполняется контентно после очистки OSC-последовательностей.
    - Для Gemini используется детекция Braille-спиннеров.
    - Данные транслируются через унифицированный механизм `busy-state` IPC. 
    - См. [`fix-claude-busy-detection.md`](knowledge/fix-claude-busy-detection.md) и [`fact-gemini-automation.md`](knowledge/fact-gemini-automation.md).
- **SubAgentBar: Бесшовный лейбл.** Панель sub-агентов использует лейбл с фиксированной шириной `min-width: 68px`. При переключении между "Sub-agents:" и "← Back" позиция вкладок sub-агентов не меняется (отсутствие Layout Shift).
- **SubAgentBar: Dashboard & Monitoring.** Панель видна всегда при наличии хотя бы одного связанного агента. Бейдж справа отображает суммарную активность. 
    - **Dashboard Dropdown:** Открывает расширенный список всех агентов. Позволяет мгновенно переключаться между ними кликом по строке.
    - **Pin Logic:** Кнопка-иголка в меню позволяет закрепить панель в открытом состоянии. Это отключает `onMouseLeave` закрытие, позволяя пользователю держать список статусов перед глазами.
- **SubAgentBar: Reactive Logic.** Компонент использует строковые ключи для селекторов (String Key Pattern), чтобы избежать бесконечных рендеров при обновлении списка суб-агентов. Валидация всей цепочки (Gemini → Claude Sub-agent) выполняется E2E тестом `auto/sandbox/test-sub-agent-state.js`.
- **SubAgentBar: Visual Indicators.** Статус субагента отображается комбинацией символов и прозрачности:
    - **● (Filled):** Claude CLI запущен и активен (через `claudeActive`).
    - **◌ (Empty):** Claude CLI не запущен (шелу активен, но агент ждет resume). Элемент получает `opacity: 0.6`.
    - **Индикаторы Interceptor:** В состоянии Busy цвет точки ● меняется:
        - 🟣 **Purple pulsing:** ARMED (перехват включен). Ответ будет доставлен в Gemini.
        - 🔴 **Red pulsing:** DISARMED (выключен). Ответ будет проигнорирован.
    - **Статус-текст:** Динамически меняется между `working...`, `✗ error`, `N tasks` (счетчик итераций) или `done`.
- **ContextMenu:** Правый клик по вкладке позволяет не только закрыть проект, но и выполнить **"Copy ID/Path"** — копирование UUID сессии и полного пути в буфер обмена.
- **2×2 grid контекст-меню (single-tab):** Верхние два ряда меню — grid из четырёх действий:
    - Row 1: `[+ add new]` (= Cmd+T, `createTabAfterCurrent` с CWD активного таба, prepends к текущему) + `[■ Stop Claude/Gemini]` или `[● Stop <script>]` (видим только когда есть running процесс).
    - Row 2: `[Rename]` + `[Close Tab]` (text-only `#f87171`, без bg-tint — bg-tint сделал бы Close визуально однородным с `#dc2626` Stop Script, см. далее).
    Дальше — Color/Collapse/Scripts submenu и Copy/Favorites как раньше.
    **Почему именно 4 кнопки в grid'е:** четыре самых частых действия должны быть достижимы одним кликом, без открытия submenu. `+ add new` подняли наверх потому что многие пользователи открывают контекст-меню *именно* чтобы сделать копию таба-соседа — раньше для этого нужно было закрыть меню и нажать Cmd+T. Layout 2×2 даёт ровно один клик от ПКМ до новой вкладки.
    **Цвет Close Tab — только текст, не фон.** `#f87171` text on hover-tinted bg. Bg-fill сделал бы Close семантически однородным со Stop Script (`#dc2626`), а это разные действия (Stop оставляет таб живым, Close его уничтожает) — равная визуальная масса путала бы.

    **Stop pill всегда рендерится — disabled-серый когда нет процесса.** Раньше Stop был conditional (виден только при running CLI), grid визуально разваливался: первая строка превращалась в `[+ add new]` на всю ширину, divider съезжал относительно второй строки `[Rename | Close Tab]`. Сейчас вторая половина рендерит disabled-Stop (`#444` точка, текст `Stop` цветом `#555`, `cursor: not-allowed`, tooltip *«No active process to stop»*) — grid 2×2 геометрически стабилен независимо от состояния процесса. Это переносимый принцип: см. `methodology/сценарии-багов.md::Чек-лист` про слот-стабильность контролов в grid.

    **Симметрия колонок через `flex-1 basis-0`.** Все 4 кнопки получают `flex-1 basis-0 min-w-0` + `whitespace-nowrap` + ужатый `px-2/px-3` — divider строго по центру меню, левая/правая колонка одинаковой ширины независимо от длины лейбла. До этого правая Stop pill была `px-3` (по контенту), левая `+ add new` была `flex-1` (растягивалась) — divider смещался влево, юзер репортил как «они как-то некорректно поставлены».
- **Split Close+Stop (multi-select fallback):** При Shift-выделении нескольких табов меню вырождается обратно в одну строку `[Close N Tabs] [■ Stop N]` без Rename/+add new (они не имеют смысла для batch'а). Правая часть SIGTERM'ит CLI-процессы не закрывая табы; цвет фона подсказывает кому именно адресован сигнал (Claude `#DA7756`, Gemini `#4E86F8` — те же канонические цвета что в TAB_COLORS, Provider row InfoPanel, ApiSettingsModal, ActionsPanel). **Почему SIGTERM, не двойной Ctrl+C:** Ctrl+C в PTY зависит от состояния Ink TUI (dropdown, danger-zone «again to exit», picker model/effort, thinking spinner — каждое реагирует по-своему), и требует guessing prompt-текста для второго нажатия. SIGTERM по PID минует Ink целиком — kernel доставляет напрямую, Claude корректно сбрасывает JSONL и выходит за ~600ms; SIGKILL fallback через 800ms если процесс завис. PID находится BFS-ом один уровень вглубь от shell-PID (нескан вглубь намеренно — внутренние bash-tool/MCP-children не убиваем, они каскадно очистятся после exit парента). Для bash/dev-server scope не расширяем: у dev-server уже есть middle-click Stop в RestartZone (зелёная точка), у bash нет graceful stop hook.

- **Multi-select Stop с majority badge:** При Shift-выделении нескольких табов в той же split-кнопке показывается счётчик AI-табов, с разделением majority/minority. Подсчёт идёт **только по табам с running процессом** (`processStatus.get(id)`) и `commandType === 'claude' | 'gemini'` — bash/dev-server/idle Claude-табы пропускаются. Цвет базы = majority-тип; badge `+N` рядом — minority в другом цвете. Примеры: 2 Claude + 1 Gemini → оранжевая кнопка `Stop 2` + синий `+1`; 1 Claude + 2 Gemini → синяя `Stop 2` + оранжевый `+1`. Ничья (1+1, 2+2) разрешается в пользу Claude (project default). **Мотивация (Invisible Intent):** при batch-операции пользователь видит на одной кнопке (а) сколько процессов реально умрёт (`majorCount + minorCount` через сумму), (б) разнородность — что в выделении есть и Claude и Gemini табы, не однотипный набор. Без такого визуального разделения пользователь может думать что Stop трогает только майоритарный тип, и удивиться когда minor-AI тоже умрёт. Сигналы посылаются параллельно (`Promise.all`), main обрабатывает grace+escalation per PID — итоговое время = max(per-process), не sum.

- **Split Close+Stop для script-табов** — расширение того же паттерна на devServer / bash с живым PID **не**-AI типа. Mutex с AI-веткой: если в target табах есть claude/gemini → показывается AI-Stop (SIGTERM по PID); если только scripts → script-Stop. Tint **cherry-red `#dc2626`** — намеренно НЕ совпадает с зелёным running-dot слева от имени таба. Раньше тут был зелёный (`#4ade80`, тот же что у running-dot) с обоснованием «зрительная связь с дотом» — отвергнуто живым use-case'ом: пользователь читал зелёную Stop-кнопку как продолжение/подтверждение «процесс жив», а не как destructive action. Принцип: см. `methodology/переносимый-дизайн.md::Destructive action ≠ цвет status-indicator`. Stop Claude / Stop Gemini остаются на brand-tints (orange `#DA7756` / blue `#4E86F8`) — там destructive-семантика передаётся через явный лейбл `Stop` + квадратную точку (квадратная = stop-button иконография, отделяет от круглой running-dot формы). Форма точки у script-Stop осталась **круглая с glow shadow** — невербально отделяет от AI-стопа. **Killing path — Ctrl+C через `terminal:input`**, не SIGTERM. Причина: zsh/bash forwards SIGINT в foreground process group → npm/vite/dev-server корректно ловят → graceful exit + cleanup. SIGTERM по PID лишний — у shell нет TUI state-чувствительности как у Claude. Дополнительно если **kill dev-ports** toggle включён (см. `fact-statusbar-toggles.md`), после Ctrl+C инжектится видимая shell-line `lsof -ti:PORTS | xargs kill -9` — Ctrl+C только foreground убивает, а leak'нутые children (vite preview server detached, electron-fork) могут продолжить держать порт. Старая "Stop: <name>" entry в Scripts submenu удалена — теперь единственная точка через split-pill в title row.

## Behavior Specs
- **Effective Context (Sub-agents):** При клике на суб-агента в `SubAgentBar` приложение переходит в режим "просмотра" (`viewingSubAgentTabId`).
    - **UI Logic:** Хотя физически активным табом в `TabBar` остается Gemini, вся "инфраструктура" (Timeline, Поиск Cmd+F, History Panel, Tab Notes в InfoPanel) автоматически переключается на контекст суб-агента.
    - **Hotkeys:** Хоткеи создания вкладок (`Cmd+T`) и открытия VS Code (`Cmd+.`) используют CWD суб-агента, если он в данный момент виден на экране.
- **Horizontal Scroll:** Таб-бар поддерживает прокрутку колесиком мыши без зажатого Shift. Используется `onWheel` с `{ passive: false }` для корректного предотвращения нативного скролла.
- **Auto-Scroll:** При переключении или создании вкладок система автоматически прокручивает `TabBar` так, чтобы активная вкладка всегда была видна. При перетаскивании таба к левому или правому краю также срабатывает автоматический скролл. Используется `@atlaskit/pragmatic-drag-and-drop-auto-scroll`.
- **Gap Separation:** Между вкладками используется физический разрыв `gap-[1px]`, что предотвращает слипание индикаторов активности и рамок при наведении.
- **Stable Resizing:** Размер терминала подстраивается под контейнер через `ResizeObserver`. Реализована защита от stale closure и **Idempotent Resize** (запрет отправки `SIGWINCH` в PTY, если размеры не изменились), что критично для стабильности AI-интерфейсов при переключении вкладок. См. [`knowledge/fact-fact-terminal-core.md`](../knowledge/fact-fact-terminal-core.md).
- **LRU Navigation:** Система поддерживает стек истории посещения табов. При закрытии активной вкладки фокус переходит на ту, которая была активна до неё (Last Recently Used), а не просто на соседнюю.
- **Unified Multi-Close:** При закрытии группы выделенных табов система собирает информацию обо всех активных процессах и показывает ОДНО окно подтверждения со списком, вместо серии отдельных алертов. Каждый `closeTab` в цикле вызывается с `forceCleanup: true`, чтобы safety guard не блокировал удаление при последовательном закрытии 3+ табов.
- **Silent Tab Closure (skipProcessCheck):** Программные инструменты автоматизации (MCP `close_sub_agent`, Update API pipeline, орхестрация суб-агентов) используют флаг `skipProcessCheck: true` в `closeTab()` для бесшовного закрытия табов с активными процессами без диалоговых окон. Это позволяет отменять автоматизированные операции и восстанавливать сессии без спама алертов. Обычное закрытие пользователем (Cmd+W, middle-click) по-прежнему показывает подтверждение. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Silent automation cleanup`.
- **Browser Tabs:** Поддержка вкладок типа `browser` для работы с локальными веб-интерфейсами (например, документация или дев-серверы).
    - **Link Interception:** Cmd+клик по ссылке во встроенном терминале браузерной вкладки перехватывается. Вместо открытия во внешнем браузере, URL подставляется в адресную строку текущей вкладки, вид переключается на `browser`, и страница загружается в `webview`.
    - **Smart Refresh:** Кнопка обновления (Refresh) автоматически переключает вид на `browser`. Это избавляет от необходимости вручную переключаться с терминала (где перезапускался сервер) обратно в браузер.
- **Persistent Naming:** Тип команды и уникальный `tab_id` сохраняются в БД, что предотвращает сброс кастомных имен и разрыв связей суб-агентов при перезапуске. См. [`knowledge/fix-tab-persistence.md`](../knowledge/fix-tab-persistence.md).
- **Safe Persistence:** Метод `saveTabs` использует targeted DELETE по `tab_id` вместо `DELETE ALL`. Включён safety guard: если количество табов резко уменьшается (>2), удаление "лишних" записей из БД пропускается и логируется ошибка. Это защищает от потери суб-агент табов при неполном in-memory Map. См. [`knowledge/fix-save-tabs-data-loss.md`](../knowledge/fix-save-tabs-data-loss.md).
- **Activity Throttling:** Терминал считается активным только в том случае, если текущий вид (`currentView`) установлен в `'terminal'`. Это предотвращает лишнюю нагрузку и конфликты, когда пользователь находится в Dashboard или полноэкранном редакторе заметок.
- **Tab History (закрытые табы на Dashboard):** При закрытии таба запись добавляется в `tab_history` через `archiveTab`. Каждое закрытие = новая запись. Restore из Dashboard идёт по `id` записи (юзер кликает конкретную карточку), не по имени. Помимо клика по карточке доступен хоткей **Shift+Cmd+T** — атомарный pop последней записи (VS Code-стиль). Учитывает позицию вкладки в TabBar на момент закрытия и `processWasRunning` для авто-Continue Claude. См. [`fact-reopen-last-closed-tab.md`](fact-reopen-last-closed-tab.md).

    **Ловушка для пользователя — клон-таб с чужой сессией:** Карточки в Tab History показывают только имя + папку, не sessionId. Если у таба менялся `claudeSessionId` (форк создал новый sessionId, потом таб закрылся, потом снова открыли и закрыли) — в истории накапливается несколько записей под **тем же именем** с разными sessionId. Юзер кликает первую попавшуюся → восстанавливается старая сессия вместо актуальной форк-копии. Симптом: "у меня два таба-клона, у них одна история, хотя должна быть разная". Решение на уровне UX (показывать sessionId в карточке) пока не сделано.

    **Отброшенный подход:** дедупликация через `DELETE FROM tab_history WHERE project_id=? AND name=?` перед INSERT. Нельзя — имя таба не уникальный ключ. У юзера нормально иметь несколько табов с именем "claude", "bash", "gemini" в одном проекте. DELETE WHERE name= уничтожал бы валидную историю несвязанных табов.
- **Cross-Project Move (Multi-Tab):** Вкладки (одна или несколько) могут быть перетащены на любую вкладку проекта в Title Bar.
    - Логика: `moveTabsToProject` в `useWorkspaceStore`.
    - PTY процессы сохраняются, меняется только привязка к проекту в БД.
    - **forceCleanup:** При переносе 3+ табов `saveTabs` вызывается с `forceCleanup: true`, обходя safety guard (иначе guard блокировал бы удаление «перенесённых» записей из source project).
    - Визуальное затемнение: При перетаскивании все вкладки, входящие в группу переноса, получают `opacity: 0.5`.
- **Sync:** Порядок проектов сохраняется в `Map` внутри `useWorkspaceStore`.
- **Title Bar Integration:** Пустая зона для дропа (`ProjectEmptyDropZone`) поддерживает `WebkitAppRegion: drag`, когда не активен процесс перетаскивания, позволяя двигать окно приложения за шапку.


## Vertical mode (TabSidebar)

Permanent left sidebar шириной 140-400px (drag-resize handle на правом краю, default 200, ключ `tabSidebarWidth` в localStorage). Все вкладки одинаково растягиваются на 100% ширины колонки. Тот же TabBar.tsx-компонент через `layout='vertical'` prop.

### Активность через bg-saturation, не top-border

В горизонтальном TabBar активность кодировалась `border-top: 2px solid ${borderColor}` сверху таба. В vertical mode это плохо: занимает 2px из дефицитной вертикали в плотной колонке, и читается как самостоятельный визуальный язык (interrupted=dashed-blue, selected=dashed-white всё ещё используют border'ы — путаница).

Решение — активность через alpha-step фонового цвета самой вкладки. PTY claude (saffron orange):
- inactive 0.20 alpha → `#49352F` на `#252526` panel
- hover    0.28 alpha → `#5C3F35`
- active   0.45 alpha → `#764A3C`

SDK claude (terracotta):
- inactive 0.30 alpha → `#664F42`
- hover    0.38 alpha → `#76594A`
- active   0.55 alpha → `#9D7359`

Hover-step для SDK выше чем для PTY (`+0.08` vs `+0.08`, но от более высокой базы) — SDK не имеет PTY-bar в качестве дополнительного активности-сигнала, поэтому весь акцент состояния идёт через alpha. Не путать с inactive-step: раньше неактивные coloured tabs дополнительно дамперились (`base - 0.10`) чтобы активная вкладка доминировала; юзер три итерации репортил *«не яркость, а прозрачность — даже когда вкладка неактивна, цвет должен быть более яркий»* — дампер убран, inactive теперь равен **прошлому hover'у**, hover поднят отдельным `+0.08` step'ом.

Для uncoloured (browser tabs, новые fresh tabs) — белая подложка 4% inactive → 12% hover → 20% active. **Полностью transparent inactive запрещён**: вкладка сливается с панелью, граница теряется. Минимальный alpha-floor 4% обязателен. См. `methodology/переносимый-дизайн.md::Активность через насыщенность фона`.

### SDK claude — distinct hue от PTY claude

PTY claude tabs используют saffron `#DA7756` (brand-tint Claude). SDK tabs тоже `color: 'claude'` в данных, но отдельный override в TabItem chrome: `bgColor: rgba(210, 140, 90, 0.30)`, `borderColor: '#D28C5A'` — терракотовый, явно жёлтее/светлее saffron. Юзер: *«вкладки SDK я вообще не могу различать с PTY, они слишком тусклые»*.

**Что пробовали и почему не сработало:**
- Peach `rgba(255, 178, 130, 0.14)` (изначальный SDK override) — слишком светлый, при active 0.39 alpha белый текст сливался с фоном. Контраст ≈ 4.0, на границе читаемости.
- Peach `rgba(255, 178, 130, 0.30)` — alpha подняли, контраст inactive стал ок, но юзер: *«белый цвет сливается с ним даже когда вкладка активная»*. Корень: подняли только alpha, RGB остался `(255,178,130)` — слишком близкий к белому (`#FFB382` light salmon). При наложении на panel с alpha 0.55 итог уходит в светлую область где белый text contrast падает.
- Финал terracotta `rgba(210, 140, 90, 0.30)` — изменили RGB, не alpha. `(210,140,90)` = `#D28C5A` (тёплый коричнево-янтарный), контраст с белым текстом ≈ 5.7 на любом alpha-step. PTY (более красно-рыжий saffron `#DA7756`) vs SDK (более жёлто-коричневый terracotta `#D28C5A`) отличаются **тоном**, не только насыщенностью — на одном `#252526` фоне глаз ловит «два разных runtime'а» без необходимости запоминать какой ярче.

### Два независимых индикатора активности

PTY-процесс жив (claude CLI запущен, или npm run dev) → 3px `tab-process-bar` у края вкладки. AI «думает»/стримит (claude:busy-state / gemini:busy-state / claude-sdk:busy-state) → `tab-ai-busy-shimmer` (full-width horizontal sweep через `::after`). Сосуществуют независимо:

- PTY claude в думанье → оба активны (bar + shimmer)
- SDK claude в думанье → только shimmer (нет PTY)
- npm run dev → только bar
- idle taб → ни одного

См. `methodology/переносимый-дизайн.md::Два независимых сигнала на одной зоне` (почему нельзя через OR) и `knowledge/fact-process-bar.md` (полная конфигурация bar).

### Configurable session statuses

Status marker 8px (dot или square, sizePx 4..16) рисуется absolute на `left: 5px`, `top: calc(50% + 1px)` слева от текста. `+1px` к геометрическому центру — оптическая компенсация baseline-шифта строчных букв в названиях табов (`claude-03`, `tab-1`, `bash` — все без descender'ов, текст «садится» чуть ниже геометрического центра контейнера). Без сдвига маркер кажется немного выше текста. См. `methodology/переносимый-дизайн.md::Baseline-шифт оптической центровки`.

Назначается через ПКМ → Status submenu. Список статусов полностью кастомизируется юзером в Settings → Системные (label, hex, добавление, удаление). Tab.sessionStatus хранит **id** статуса, не label — переименование сохраняет ассоциацию. Удаление статуса не чистит Tab.sessionStatus (graceful degrade: возврат статуса с тем же id оживляет все вкладки). Подробности — `knowledge/fact-session-status.md`.

ПКМ Status submenu имеет preview трёх первых статусов inline справа от лейбла `Status ›` — юзер видит «вот эти точки это про статусы» без открытия submenu. См. `methodology/переносимый-дизайн.md::Submenu trigger показывает preview содержимого`. Toggle-семантика: повторный клик по активному статусу снимает его. Color submenu из ПКМ удалён — юзер не использовал.

### Revert Session submenu

ПКМ → «↶ Revert Session ›» появляется только на claude-табах, у которых непустой `tab.claudeSessionHistory` (последние до 5 предыдущих значений sessionId с reason и timestamp). Submenu отрисовывает каждую запись короткой строкой: `<8-char sessionId monospace> · <relative time>` и под ней `<reason>` мелким текстом. Клик возвращает значение — записывается обратно через `setClaudeSessionId(tabId, sid, 'userRevert')` (значит сам revert тоже попадает в историю; можно отменить отмену).

Назначение — last line of defense когда автоматический writer всё-таки перетёр sessionId таба не на тот: stale bridge file проскочил защиты, AutoResume отработал на испорченный state из SQLite, Timeline chain resolver нашёл мёртвую ссылку. Без UI revert юзер должен grep'ать `~/Library/Logs/noted-terminal/production.log` по `[Store:setTabCommandType] tab=...claude=...` чтобы вспомнить какие sessionId раньше сидели на вкладке. См. полный контракт `SessionWriteReason` и список 9 источников записи — `knowledge/fact-session-capture.md::SessionWriteReason contract` и `knowledge/fact-session-detection.md::Stale bridge files + pendingResume guard`.

### Wheel handler gotcha

`handleWheel` в TabBar.tsx ранее форсировал `scrollLeft += deltaY` на overflowX:hidden контейнере для горизонтального wheel-скролла без Shift. В vertical mode этот же useEffect блокирует нативный вертикальный скролл колесом — деление `scrollLeft` ничего не делает (overflowX:hidden), но `e.preventDefault()` глотает событие до того как браузер обработает scrollTop. Симптом: «вкладки не скроллятся колесом в sidebar».

Фикс — `if (isVerticalLayout) return;` early-return в useEffect перед `addEventListener`. Не удалять весь handler — горизонтальный legacy-режим в utility-dropdown ещё использует.

### CMD+hover preview справа

В vertical layout TabPreviewPopover открывается справа от таба (`placement='right'`) вертикально центрированным. Детали — `knowledge/fact-tab-preview-popover.md::Layout & позиционирование`.

### EmptyDropZone affordance в vertical

Пустая зона ниже последнего таба — drop-target для cross-project переноса, плюс double-click создаёт новую вкладку. В horizontal mode эта зона тянется вправо до края TabBar; юзер ассоциирует её с пустым местом справа от табов и понимает что туда можно дропать. В vertical mode пустая зона занимает всю остаточную высоту колонки, никаких визуальных подсказок что в неё «можно». Симптом — юзер с пустым sidebar'ом не знает как создать первую вкладку (ПКМ → +add new требует знания контекст-меню).

Решение — dashed-border плейсхолдер `+ New tab` в начале vertical empty zone, click = создать таб. Drop-target остаётся на всей зоне как раньше. Hover-state на плейсхолдере подсвечивает border + text → юзер визуально опознаёт «это кликабельно». Horizontal mode без affordance: там empty zone узкая, явный «+» вкладкой сделает её визуально похожей на full-fledged tab при разном hover-state — путаница. См. `methodology/переносимый-дизайн.md::Empty zone в vertical нужно явный placeholder для discoverability`.

## Multi-select persistence через `data-keep-selection`

Document-level `mousedown` handler в `TabBar.tsx` сбрасывал multi-select при любом клике вне `TabBar`. Это убивало основной use case — Shift'ом выделил несколько табов, ушёл в `ActionsPanel` редактировать кастомный промпт для batch-Update Docs, выделение пропало на первом же клике в textarea. Юзер вынужден был помнить «не кликать в боковые панели, пока не отправил действие» — невидимое ограничение, читалось как баг.

Решение — exclusion-атрибут: handler проверяет `e.target` и всех родителей через `closest('[data-keep-selection]')` перед вызовом `clearSelection`. На обёртки `ActionsPanel` (и любых будущих панелей, где multi-select должен выживать клики) навешен этот атрибут. Атрибут вместо `useUIStore.preserveSelection` boolean'а сознательно: state приходилось бы синхронизировать на mount/unmount компонентов, легко desync'нуть. Атрибут на DOM-узле живёт ровно столько, сколько компонент в DOM, и checkable in-place без подписки.

Уход курсора в терминал, в Timeline, в любую другую панель **без** атрибута — `clearSelection` срабатывает как раньше: multi-select имеет смысл только пока юзер работает с инструментами над табами. Сценарий целиком — `methodology/сценарии-использования.md::Multi-select Persistence`.

## Code Map
- **UI:** `src/renderer/components/Workspace/TabBar.tsx` — логика меню, `RestartZone`, `onGenerateDragPreview` для multi-drag и `useEffect` для авто-скролла.
- **Floating Panels:** `src/renderer/components/Workspace/panels/ActionsPanel.tsx` — позиционирование "Параметров" и "Настроек" через CSS-трансформации (`translate(-100%, -50%)`).
- **Logic:** `src/renderer/store/useWorkspaceStore.ts` — функции `getNextAvailableName`, `setTabCommandType`, `moveTabsToProject` (batch move).
- **IPC:** `main.js` — хендлеры `project:add-favorite`, `project:get-favorites`, `project:delete-favorite`.
- **Terminal:** `src/renderer/components/Workspace/Terminal.tsx` — перехват ввода для детекции типа процесса и блокировки дублирующих AI сессий.
- **InfoPanel:** `src/renderer/components/Workspace/panels/InfoPanel.tsx` — кнопки claude/claude-c/claude-f также вызывают `setTabCommandType`.
- **Knowledge:** [`knowledge/fact-data-persistence.md`](../knowledge/fact-data-persistence.md) — детали реализации массового переноса.