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

Inline rename становится manual ownership только если значение реально изменилось. Fresh tab может быть создан в режиме редактирования имени; клик по кнопке Claude/Codex блюрит input, но unchanged `tab-N` не должен вызывать `renameTab` и ставить `nameSetManually=true`. Флаг manual-name персистится вместе с табом и историей закрытых вкладок, поэтому Cmd+Shift+T должен восстановить именно прежний ownership: вручную названная вкладка остаётся защищённой, unchanged auto-name остаётся доступным для первого AI auto-title.

### AI auto-title по первому пользовательскому prompt
Claude/Codex вкладка может получить человекочитаемое имя через встроенный prompt `tab-title` из Settings → AI. Prompt редактируемый пользователем; приложение только передаёт в Gemini первое **реальное** user-сообщение из Timeline/Codex rollout и применяет короткий ответ как название вкладки. Служебные команды (`#pack`, `#effort`, `#usage`, slash-команды модели/статуса/help/compact/exit и т.п.) не считаются первым prompt'ом — иначе вкладка получит название по настройке runtime, а не по задаче пользователя.

Автоназвание — не постоянный watcher Timeline, а одноразовый side-effect свежего запуска. При старте Claude/Codex launch-path должен сначала создать `AiLaunchSnapshot`, затем явно пометить его `autoTitleEligible`, и только когда впервые записывается materialized session id (`claudeSessionId` от bridge или `codexSessionId` от fresh rollout detection), store армит transient pending `{tabId, toolType, sessionId}`. Timeline consume'ит pending на первой подходящей user-entry и сразу удаляет его. Pending живёт только в памяти: восстановление вкладки из БД, Cmd+Shift+T, app restart, закрытие/открытие History-tab или обычный `--resume` не должны переименовывать старую вкладку только потому что Timeline заново прочитал первый user prompt.

`nameSetManually` сильнее AI: если пользователь переименовал вкладку до запуска агента, auto-title не армится; если переименовал после запуска, pending consume'ится без Gemini-вызова. ПКМ по любой Claude/Codex вкладке → `Обновить название` — отдельный явный override: он читает текущий Timeline напрямую, показывает per-tab loader `Название обновляется...`, применяет с `overrideManualName:true` и затем помечает результат как ручное имя, чтобы будущие автоматические запуски его не перетёрли.

Шрам из production: fresh Codex вкладка `tab-2` получила session id `019ebbb1-76ef-79e1-a0ea-e2c4615742e0`, первый prompt был про настройку GPT-5.4/1M context, но auto-title не стартовал; ручное `Обновить название` сразу сработало и переименовало вкладку в `Настройка контекста 1М в Codex`. Логи показали, что запуск шёл через отдельный `ClaudeControlBar.startCodexTab`: `setTabCommandType` создал snapshot, но этот путь не вызывал `markAiLaunchAutoTitle`, поэтому `setCodexSessionId(..., reason:'detected')` не видел eligible snapshot и не армил pending. Любой новый launch-entrypoint для Claude/Codex обязан помечать auto-title eligibility там же, где он превращает pristine tab в AI tab; resume/fork/restore paths, наоборот, должны писать session id с reason, который auto-title не армит.

Второй prod-шрам: вкладка `019ebd84-a092-7f70-9dd9-be05e37b8a66` (`tab-1`, Codex, session id записался, первый prompt был отправлен) осталась с generic именем, хотя пользователь имя не менял; ПКМ `Обновить название` позже сработал. Трасса показала свежий tab в inline rename, затем клик запуска Codex: blur старого rename submit'ил unchanged `tab-1` как ручное имя, и auto-title skip'ался по manual guard. Защита двойная: TabBar сравнивает edit value с исходным и не вызывает rename на unchanged blur/Enter, а `renameTab` сам no-op'ит unchanged trim; auto-title arm логирует skip-reason (`manual-name`, `existing-session`, `no-snapshot` и т.п.), чтобы следующий такой случай не выглядел как «Gemini не вызвался без причины».

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
   - **Пустой запуск откатывается:** Если Claude/Codex был запущен, но остановлен до первого materialized transcript/session id, вкладка возвращает прежние auto-name и auto-color. Это не «сессия без истории», а отсутствие durable artifact: Continue не должен появляться, а зелёный/оранжевый AI-цвет не должен застревать на обычной shell-вкладке. Ручные имя/цвет (`nameSetManually` / `colorSetManually`) не трогаются.

## Шрам: вывод AI downgrade'ил commandType AI→devServer (2026-05)

**Симптом:** в зелёной (devServer) вкладке запустил `claude` или `codex` → Run-after оверлей не показывается, хотя AI активен; цвет/тип вкладки остался devServer. Для Claude после Stop+claude-c оверлей появлялся; для Codex симптом был тем же классом — старый зелёный контекст выигрывал у свежего AI запуска.

**Корень (прод-лог tab-700 15:23:26, детерминированно):** Claude, будучи живым, выполнял Bash-tool `npm run dev` и **рендерил в свой TUI** строку `⏺ Bash(NODE_ENV=development npm run dev > /tmp/dev8.log…)`. Enter-key handler в `Terminal.tsx` читает `getCurrentCommand(term)` и матчит `devServerMatch = /\b(npm|...)\s+(run\s+)?(dev|...)\b/i` — регекс попал на **вывод Claude**, не на shell-команду юзера → `setTabCommandType(claude→devServer)`. Оверлей Run-after гейтится `commandType==='claude'` (`isClaudeTab`) → стал false → оверлей пропал. `bufType=normal` потому что Claude Code работает в normal-буфере (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`), поэтому alt-buffer guard не ловил.

**Двойственность бага:** (1) тип вкладки **деградировал** от вывода живого агента; (2) при запуске AI в зелёной вкладке тип вообще **не менялся** на AI если детект не сработал или если старая строка `npm run dev` на экране матчилась раньше нового `codex`.

**Фикс (два слоя):**
1. **Guard против деградации.** Оба detection-блока (`initTerminal` + `reattach` в `Terminal.tsx`) проверяют синхронный `claudeProcessAliveRef.current` — пока AI-процесс жив, `getCurrentCommand` читает его **вывод**, не shell-команду, поэтому devServer/gemini/codex авто-детект **подавляется**. `claudeProcessAliveRef` — legacy-name, но теперь это общий alive gate для Claude/Codex overlay. Headless-проверка: вход `⏺ Bash(npm run dev…)` при claudeAlive=true → action=none ✓; `npm run dev` при shell → devServer ✓.
2. **AI-команды приоритетнее devServer-матча.** Если screen-line содержит и старый `npm run dev`, и новый `codex`, detector выбирает `codex` (`Codex → Gemini → devServer`), а не первый regex-match. Это закрывает зелёный-tab edge: запустить Codex после devServer должно превращать вкладку в Codex, даже если в xterm-буфере ещё виден предыдущий npm-текст.
3. **Promote зелёную вкладку → AI.** `handleSessionDetected` / fresh-PID paths зовут `setTabCommandType` на соответствующий AI runtime — когда bridge/PID/session watcher видит живого Claude/Codex, тип становится AI независимо от способа запуска (typed в зелёной вкладке, restore, claude-c/codex-c). **Guard от I/O-шторма:** `setTabCommandType` всегда делает `set(new Map)+saveTabs` (SQLite write); повторные sync-события вызывают промоут только если тип реально другой (иначе re-render+write storm, см. CLAUDE.md Zustand anti-pattern).

**Что НЕ откатывается:** после exit Claude/Codex с materialized session id вкладка остаётся AI-вкладкой (семантика «здесь была сессия», как `claudeSessionId` / `codexSessionId` persist'ит для resume). Цвет/имя зелёной вкладки при promote НЕ перезаписываются (`color='green'` уже set, `shouldAutoColor` false; auto-rename только на `isFirstRun`). Исключение — запуск, остановленный до записи transcript/session id: он откатывается по snapshot'у как несостоявшийся, иначе пользователь получает Continue на UUID, которого CLI потом не находит.

См. [`fact-prompt-queue.md`](fact-prompt-queue.md) (гейт оверлея), [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) (OSC/bridge alive-сигналы).
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
- **Project process badge:** если дочерняя вкладка проекта показывает process-bar или AI-shimmer, project tab агрегирует этот сигнал круглым зелёным count-badge, а не повторяет вертикальный edge-strip session-вкладки. Родительский уровень показывает масштаб фоновой работы в проекте; shape остаётся прежним «кружок с цифрой», чтобы не спутать project tab с обычной session tab. См. [`fact-process-bar.md`](fact-process-bar.md).
- **Project icon:** вкладка проекта в titlebar показывает `project.icon` перед названием, если иконка задана в Settings → Проекты. ПКМ по project tab даёт пункт `Иконка проекта`, который открывает Settings сразу на нужной вкладке; это одна editing surface для всех project icons, а не отдельный inline-editor в titlebar. Детали metadata и порядка списка — `fact-workspace.md::Project Icons`.
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
    - Row 1: `[+ add new]` (= Cmd+T, `createTabAfterCurrent` с CWD активного таба, prepends к текущему) + `[■ Stop Claude/Gemini/Codex]` или `[● Stop <script>]` (видим только когда есть running процесс).
    - Row 2: `[Rename]` + `[Close Tab]` (text-only `#f87171`, без bg-tint — bg-tint сделал бы Close визуально однородным с `#dc2626` Stop Script, см. далее).
    Дальше — Color/Collapse/Scripts submenu и Copy/Favorites как раньше.
    **Почему именно 4 кнопки в grid'е:** четыре самых частых действия должны быть достижимы одним кликом, без открытия submenu. `+ add new` подняли наверх потому что многие пользователи открывают контекст-меню *именно* чтобы сделать копию таба-соседа — раньше для этого нужно было закрыть меню и нажать Cmd+T. Layout 2×2 даёт ровно один клик от ПКМ до новой вкладки.
    **Цвет Close Tab — только текст, не фон.** `#f87171` text on hover-tinted bg. Bg-fill сделал бы Close семантически однородным со Stop Script (`#dc2626`), а это разные действия (Stop оставляет таб живым, Close его уничтожает) — равная визуальная масса путала бы.

    **Stop pill всегда рендерится — disabled-серый когда нет процесса.** Раньше Stop был conditional (виден только при running CLI), grid визуально разваливался: первая строка превращалась в `[+ add new]` на всю ширину, divider съезжал относительно второй строки `[Rename | Close Tab]`. Сейчас вторая половина рендерит disabled-Stop (`#444` точка, текст `Stop` цветом `#555`, `cursor: not-allowed`, tooltip *«No active process to stop»*) — grid 2×2 геометрически стабилен независимо от состояния процесса. Это переносимый принцип: см. `methodology/сценарии-багов-design.md::Чек-лист` про слот-стабильность контролов в grid.

    **Симметрия колонок через `flex-1 basis-0`.** Все 4 кнопки получают `flex-1 basis-0 min-w-0` + `whitespace-nowrap` + ужатый `px-2/px-3` — divider строго по центру меню, левая/правая колонка одинаковой ширины независимо от длины лейбла. До этого правая Stop pill была `px-3` (по контенту), левая `+ add new` была `flex-1` (растягивалась) — divider смещался влево, юзер репортил как «они как-то некорректно поставлены».
- **Split Close+Stop (multi-select fallback):** При Shift-выделении нескольких табов меню вырождается обратно в одну строку `[Close N Tabs] [■ Stop N]` без Rename/+add new (они не имеют смысла для batch'а). Правая часть SIGTERM'ит CLI-процессы не закрывая табы; цвет фона подсказывает кому именно адресован сигнал (Claude `#DA7756`, Gemini `#4E86F8` — те же канонические цвета что в TAB_COLORS, Provider row InfoPanel, ApiSettingsModal, ActionsPanel). **Почему SIGTERM, не двойной Ctrl+C:** Ctrl+C в PTY зависит от состояния Ink TUI (dropdown, danger-zone «again to exit», picker model/effort, thinking spinner — каждое реагирует по-своему), и требует guessing prompt-текста для второго нажатия. SIGTERM по PID минует Ink целиком — kernel доставляет напрямую, Claude корректно сбрасывает JSONL и выходит за ~600ms; SIGKILL fallback через 800ms если процесс завис. PID находится BFS-ом один уровень вглубь от shell-PID (нескан вглубь намеренно — внутренние bash-tool/MCP-children не убиваем, они каскадно очистятся после exit парента). Для bash/dev-server scope не расширяем: у dev-server уже есть middle-click Stop в RestartZone (зелёная точка), у bash нет graceful stop hook.

- **Multi-select Stop с majority badge:** При Shift-выделении нескольких табов в той же split-кнопке показывается счётчик AI-табов, с разделением majority/minority. Подсчёт идёт **только по табам с running процессом** (`processStatus.get(id)`) и `commandType === 'claude' | 'gemini' | 'codex'` — bash/dev-server/idle AI-табы пропускаются. Цвет базы = majority-тип; badge `+N` рядом — minority в другом цвете. Примеры: 2 Claude + 1 Gemini → оранжевая кнопка `Stop 2` + синий `+1`; 1 Claude + 2 Codex → зелёная кнопка `Stop 2` + оранжевый `+1`; 1 Claude + 1 Gemini + 1 Codex → база по первому majority sort, tooltip обязан перечислить все типы. **Мотивация (Invisible Intent):** при batch-операции пользователь видит на одной кнопке (а) сколько процессов реально умрёт (`majorCount + minorCount` через сумму), (б) разнородность — что в выделении есть Claude/Gemini/Codex табы, не однотипный набор. Без такого визуального разделения пользователь может думать что Stop трогает только майоритарный тип, и удивиться когда minor-AI тоже умрёт. Сигналы посылаются параллельно (`Promise.all`), main обрабатывает grace+escalation per PID — итоговое время = max(per-process), не sum.

- **Split Close+Stop для script-табов** — расширение того же паттерна на devServer / bash с живым PID **не**-AI типа. Mutex с AI-веткой: если в target табах есть claude/gemini/codex → показывается AI-Stop (SIGTERM по PID); если только scripts → script-Stop. Tint **cherry-red `#dc2626`** — намеренно НЕ совпадает с зелёным running-dot слева от имени таба. Раньше тут был зелёный (`#4ade80`, тот же что у running-dot) с обоснованием «зрительная связь с дотом» — отвергнуто живым use-case'ом: пользователь читал зелёную Stop-кнопку как продолжение/подтверждение «процесс жив», а не как destructive action. Принцип: см. `methodology/переносимый-дизайн.md::Destructive action ≠ цвет status-indicator`. Stop Claude / Stop Gemini / Stop Codex остаются на engine-tints (orange `#DA7756` / blue `#4E86F8` / green `#10A37F`) — там destructive-семантика передаётся через явный лейбл `Stop` + квадратную точку (квадратная = stop-button иконография, отделяет от круглой running-dot формы). Форма точки у script-Stop осталась **круглая с glow shadow** — невербально отделяет от AI-стопа. **Killing path — Ctrl+C через `terminal:input`**, не SIGTERM. Причина: zsh/bash forwards SIGINT в foreground process group → npm/vite/dev-server корректно ловят → graceful exit + cleanup. SIGTERM по PID лишний — у shell нет TUI state-чувствительности как у Claude. Дополнительно если **kill dev-ports** toggle включён (см. `fact-statusbar-toggles.md`), после Ctrl+C инжектится видимая shell-line `lsof -ti:PORTS | xargs kill -9` — Ctrl+C только foreground убивает, а leak'нутые children (vite preview server detached, electron-fork) могут продолжить держать порт. Старая "Stop: <name>" entry в Scripts submenu удалена — теперь единственная точка через split-pill в title row.

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
- **Close warnings для AI tabs:** наличие `claudeSessionId` / `geminiSessionId` / `codexSessionId` само по себе не причина для confirmation dialog. Idle Claude PTY, Claude SDK, Gemini и Codex закрываются сразу: session id означает историю/Continue, а не живой риск. Warning появляется только когда AI реально busy/streaming (`aiBusy`, `claudeBusy`, `sdkState`) или когда во вкладке запущен обычный foreground process не-AI типа (`npm run dev`, script, bash child). При закрытии живого AI foreground без warning всё равно выполняется graceful stop перед PTY kill, а title временно становится `остановка сессии...`, чтобы пользователь видел что close ждёт flush/teardown. Для Codex проверка foreground-AI обязана смотреть не только `comm`, но и full command-line из `terminal:hasRunningProcess`: wrapper часто выглядит как `node /opt/homebrew/bin/codex` или содержит `@openai/codex`, и без command-line idle/AI/script ветки перепутаются.
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

PTY-процесс жив (claude CLI запущен, npm run dev, bash, gemini/codex CLI) или SDK runtime жив → 3px `tab-process-bar-static` у края вкладки. AI «думает»/стримит (`claude:busy-state` / `gemini:busy-state` / `codex:busy-state` / `claude-sdk:busy-state`) → `tab-process-bar-ai-shimmer-overlay` внутри этой же полоски. Сосуществуют независимо:

- PTY claude в думанье → оба активны (base strip + shimmer)
- SDK claude в думанье → SDK process-alive strip + shimmer
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

### Tab-группы и visual-child вкладки

В `TabSidebar` есть две независимые иерархии. `groupId` + `tabGroups` — реальные группы сайдбара: group-row существует как отдельная строка, хранит имя, может быть переименован double-click'ом/ПКМ → Rename, закрыт middle-click'ом или через ПКМ → Close Group, либо удалён как контейнер через ПКМ → Delete Group. Close Group закрывает вкладки группы и потом удаляет контейнер; Delete Group сохраняет вкладки, только очищает у них `groupId`. Group-row намеренно использует те же `tabsFontSize`, `tabGeometry`, padding/minHeight/radius и click-target, что и обычная вкладка: группа отличается цветом, иконкой и стилем, но не плотностью строки.

Создание group-row через EmptyDropZone → `New Group` сразу открывает inline rename, как `Cmd+T`/double-click для новой вкладки. Дефолтное имя группы — только временный draft, пользовательский следующий жест почти всегда «назвать контейнер», поэтому cursor/focus должен оказаться в названии без отдельного double-click.

Сворачивание группы — отдельный локальный control на folder-иконке, не жест всей draggable-строки. Folder-button перехватывает `mousedown`/`click`/`doubleClick`/`contextmenu`, чтобы быстрый клик не запускал drag и не входил в rename. Cmd/Ctrl-click по всей group-row — ускоренный collapse/expand режим: на время модификатора drag и rename отключаются, cursor становится pointer, а body сворачивается через короткую grid-анимацию (~150ms). В collapsed состоянии hidden body не участвует в DnD geometry и не ловит pointer events.

Group-row поддерживает те же пользовательские visual metadata, что и обычная вкладка: `sessionStatus` рисуется тем же marker shape/size слева, `color` выбирает background/folder accent из `TAB_COLORS`. ПКМ по группе зеркалит tab-context menu для Status и Background: повторный клик по выбранному статусу снимает его, а пустой список статусов показывает тот же hint про Settings → Системные. Статусы групп живут в `tabGroups` JSON, а не в `tabs`/`tab_history`.

`visualParentTabId` — только визуальная связь вкладка→вкладка для thread/fork-структуры. Не использовать для этого `parentTabId`: `parentTabId` уже занят MCP sub-agent'ами и такие вкладки скрываются из основного `TabBar`, потому что живут в `SubAgentBar`. Visual-child остаётся обычной видимой вкладкой со своим session id. Split-стрелки в tab context menu привязывают вкладку к ближайшему видимому соседу сверху/снизу; `setTabVisualParent` защищает от циклов и нормализует `groupId` ребёнка под группу родителя.

Drag-семантика различает parent и child: перетаскивание parent-вкладки тянет её visual-children как один блок, а перетаскивание child отдельно отвязывает `visualParentTabId`. Fork из текущей Claude/Codex/Gemini/SDK-вкладки создаёт fork как visual-child исходной вкладки, потому что пользователь хочет видеть причинную связь «из этой сессии родилась эта». Clipboard-fork по произвольному UUID остаётся плоским: source-tab может быть неизвестен, и привязка к активной вкладке была бы ложной.

Закрытая вкладка помнит `groupId` в `tab_history` и при Restore/Home/Shift+Cmd+T возвращается в группу только если group-row ещё существует. Если контейнер удалён через Delete/Close Group, restore деградирует в плоскую вкладку: история восстанавливает саму рабочую сессию, но не воскресает удалённую папку.

### Vertical DnD через snapshot геометрии

Вертикальный DnD использует `@atlaskit/pragmatic-drag-and-drop` как транспорт событий, но preview/drop решаются своей моделью: на drag-start фиксируется static geometry (`captureVerticalDragGeometry`), а каждый pointer-move пересчитывает layout от base-order через `resolveStaticVerticalPreview`. Не считать от live DOM: inline-preview сам меняет порядок строк, высоту групп и границы body/header, поэтому следующий hit-test видит уже мутировавшую карту и начинает дёргаться на верхней границе элемента или группы.

Симптомы, которые закрывает snapshot-модель: элемент у group/header boundary прыгает то внутрь группы, то перед неё; вкладка уходит в конец группы при плавном движении по верхней границе; чёрная insertion-line не совпадает с итоговым drop; native ghost создаёт вторую визуальную вкладку у курсора. Текущая модель показывает полноценный inline-preview в списке, скрывает native ghost, а source-row во время удержания получает lift/scale и `grabbing`, чтобы пользователь видел активный drag-state до первого движения мыши.

Collapsed group body исключается из snapshot: hidden tab rows не должны оставаться невидимыми drop targets. Иначе пользователь ведёт вкладку по видимому списку, а preview прыгает в закрытое тело группы, которого на экране нет.

### EmptyDropZone в vertical

Пустая область ниже последнего row — техническая зона для append/drop и быстрых жестов, но не отдельная визуальная команда. Double-click по ней создаёт новую terminal-вкладку в конце списка; ПКМ открывает контекст с `New Terminal Tab` и `New Group`. Отдельный dashed `+ New tab` placeholder и нижний hover-background убраны: пользователь воспринимал подсвеченную нижнюю область как специальную drop-цель, хотя действие там означает только «нести ниже, в конец».

Bottom-drop считается относительно последнего **визуального row**, а не последнего tab-id. Если последняя строка — пустая group-row или группа, которая станет пустой после выноса её единственной dragged-вкладки, drop в нижнюю область должен назначить dragged tab этой группе. Иначе группа остаётся последней structural row без tab-id, а вкладка визуально оказывается предпоследней, хотя курсор был в самом низу.

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
