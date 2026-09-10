# Feature: Clipboard & Pasted Blocks

## Intro
Инструменты для работы с буфером обмена: сжатие логов и свёртка вставленных блоков. `:::pasted`-рендеринг живёт в `MarkdownRenderer` и используется HistoryPanel + EditRangePanel (Timeline edit-range preview).

## User Flow
1. Пользователь копирует произвольный текст/код.
2. **Log Compression:** В полоске инструментов боковой панели вкладок нажимает кнопку **"Logs"**. 
   - Система читает буфер обмена.
   - Очищает логи (Grafana/Console) от мусора.
   - Записывает результат обратно в буфер.
   - Показывает Toast с информацией о проценте сжатия. См. `fact-log-compression.md`.

## Behavior Specs
- **:::pasted Syntax:** Кастомный разделитель `:::pasted` помечает вставленные блоки в markdown-контенте.
- **Collapsible Blocks:** Блоки `pasted` по умолчанию отображаются свёрнутыми с кнопкой Toggle — экономит место при больших дампах кода. Рендерятся в HistoryPanel и EditRangePanel (Timeline edit-range preview).
- **Preprocessing:** `MarkdownRenderer` перехватывает `:::pasted` сегменты ДО парсинга основным Markdown-движком (избегает конфликта с ``` внутри вставленного контента).

## Global Copy Settings
Настройки копирования сессии (сообщения, семантические action-family, subagent mode и `fromStart`) вынесены в глобальное состояние (`useUIStore`) с персистенцией в `localStorage`.
- **Индикация:** Текущие настройки отображаются в виде цветных точек на иконке 📋 на самой кнопке Copy session (см. ниже).
- **Единый стандарт:** Любые операции копирования (кнопка Copy session, массовый экспорт, двойной клик по диапазону в Timeline, ПКМ-«Копировать» по одиночной точке) используют одни и те же правила фильтрации.

## Copy Session: размещение и UX
Кнопка переехала из панели действий («жирная плашка» во вкладке Quick Actions; сама панель удалена 2026-08-18) в `InfoPanel` под блок AI Session — компонент [`CopySessionButton.tsx`](../../src/renderer/components/Workspace/CopySessionButton.tsx). **Почему перенесли:** старая плашка занимала первый screen Quick Actions без частоты использования, который оправдал бы место; новое расположение контекстное — chip живёт рядом с источником данных (session-блоком), пользователь видит, что копирует **эту** сессию.

**Визуальная форма — сегментированный chip:** `[📋] | [Copy session]`. Две независимые hover-зоны, разделённые divider'ом 1px:
- **📋-половина** (settings): hover → accent-tinted фон + открывает Settings popup слева (тот же hierarchical-tree с тогглами).
- **Copy-половина** (label): hover → accent-tinted фон + текст белый + полужирный. Клик копирует сессию.

Каждая половина имеет собственный hover-state, не наследуется от другой — иначе непонятно, что именно сейчас будет нажато. См. [`methodology/сценарии-багов-design.md::7. Hover affordance`](../methodology/сценарии-багов-design.md).

**CMD+hover на chip → single-line input снизу для custom session ID.** Это замена развёрнутой textarea-«модалки» (раньше клик по `▶` открывал блок с textarea + кнопкой Copy). Сейчас:
- Просто `<input>` высотой 26px, без заголовка/описания/footer-кнопки. Enter = copy + close, Esc = close.
- Ширина **динамическая**: от `chipRect.left` до левого края Timeline-strip (`[data-timeline]`) минус 8px. Перемеряется на `window.resize`. Без этого статичные 320px клипались за сайдбар.
- Принцип «single-line input вместо модалки» см. [`methodology/сценарии-багов-design.md::Минимализм popup'ов`](../methodology/сценарии-багов-design.md).

**Не путать с `⎘ session-id-copy` в ControlBar.** Там Cmd-hover — read-only tooltip сверху с текущим UUID, без input и без копирования другой сессии. Здесь Cmd-hover — намеренный override: пользователь вставляет чужой session id / текст с `cwd:` и копирует не активную вкладку, а указанную сессию. Два жеста похожи, но семантика разная: preview identity vs custom source. См. `fact-claude-control-bar.md::Session-id copy`.

**CSS-bridge между chip'ом и input'ом.** Wrapper позиционирован **вплотную** к низу кнопки (`top: chip.bottom`), визуальный 4px gap создаётся через `paddingTop: 4` ВНУТРИ wrapper'а. Если задать `top: chip.bottom + 4` — между chip'ом и wrapper'ом возникает 4px мёртвая зона, popup закрывается при движении курсора сверху вниз. См. [`methodology/сценарии-багов-design.md::2.3 Wrapper смещён вниз от триггера`](../methodology/сценарии-багов-design.md).

**Индикаторные точки на 📋** показывают только «не-дефолтные» флаги: красные — если User/Claude отключены, цветные — если Reading/Editing/Bash/Tools включены (по дефолту OFF), синий — если `fromStart=false`. Юзер видит «что в копии есть подозрительного» одним взглядом без открытия Settings.

### Hierarchical Copy Groups
Popup рендерит один provider-neutral `CopySessionFilterPanel`: transport Claude/Codex влияет только на accent, но не на названия и состав категорий. Вверху четыре независимых вида содержимого — **Запрос пользователя**, **Ответ агента**, **Рассуждение**, **Действия агента**. Под Actions находятся переключатели глубины Read/Search/Edit/Run/Git/MCP/Web/Plan/Other и отдельный Subagent mode.

**Структура флагов:**
| Уровень 1 | Уровень 2 (children) | Дефолт |
|---|---|---|
| Messages | `includeUser`, `includeText`, `includeThinking` | ON, ON, ON |
| Actions (master) | `includeActions` | ON — краткие строки действий |
| Action detail | `includeReading`, `includeSearch`, `includeEditing`, `includeRun`, `includeGit`, `includeMcp`, `includeWeb`, `includePlan`, `includeOther` | Editing ON; остальные OFF либо migrated legacy |
| Subagent | `includeSubagentResult`, `includeSubagentHistory` | OFF, OFF; зависит от Actions |
| — | `fromStart` (range, не content) | true |

**Дефолты action-detail в основном OFF.** Editing сохраняет прежний ON; остальные payload-группы не должны внезапно добавить сотни KB вывода. v3 мигрирует старый Bash в Search+Run+Git, Tools в MCP, Tool Search в Plan, Other в Other. Старый provider-master OFF превращается в выключенные Answer/Reasoning/Actions, а не теряется после удаления provider-строки из UI.

**Raw call → action mapping:** один источник — shared `history-action-grammar`. Claude `tool_use` классифицируется напрямую; Codex сначала проходит через `codexHistoryActionsForCall`, который раскладывает `apply_patch`, вложенный `exec`, MCP и plan calls в canonical actions. Затем общий `copy-action-format.js` даёт family и label/detail.

- `read`: Read/NotebookRead и shell-чтение (`cat`, `sed`, `head` без записи);
- `search`: Grep/Glob/rg/grep/find/ls — локальный поиск;
- `edit`: Edit/Write/MultiEdit/apply patch, доказанная Python/pathlib-запись, `sed -i`, `tee`, явная cat/echo/printf redirection, cp/mv/rm/touch;
- `run`: оставшиеся terminal-команды — build/test/process/script execution;
- `git`: Git-команды;
- `mcp`: любой `mcp__*` call, даже если browser-MCP внутри ходит в интернет;
- `web`: native WebSearch/WebFetch/web call и явные curl/wget/http requests;
- `plan`: plan/question/wait/tool-catalog и управление задачей;
- `agent`: Task/Agent и Codex collaboration;
- `other`: редкие и неизвестные будущие действия.

**Почему MCP/Web/Tool Search/Other разделены:** после появления Codex JSONL `tool_search` и `web_search` стали похожими по имени, но разными по смыслу. Web — внешний интернет-контент, MCP — проектные/локальные инструменты (`docs_search`, Electron, browser), Tool Search — поиск доступных tools и schema, Other — редкие служебные вызовы. Если держать их в одном `Tools`, пользователь не понимает почему включение «Web» тянет MCP или почему `tool_search` не равен web search.

**Master-toggle + incremental cascade.**
- Parent OFF → все children рендерятся `disabled` (значение сохраняется в store, UI-клик блокируется). Восстановление parent ON возвращает прежний выбор children.
- `Subagent` master синтезирован: `active = result || history`. Клик по нему: если оба OFF → включает только Result (минимальный полезный набор); если хоть один ON → выключает оба.
- Subagent.History ON форсирует Subagent.Result ON (история без финального результата теряет анкер для отображения). Subagent.Result OFF форсирует History OFF (зеркально). Принцип «incremental» сформулирован пользователем дословно: *«вкл туго последнее → выкл туго вся история, и наоборот»*. Принцип в `methodology/дизайн-принципы.md::Master toggle + incremental children`.

**UI никогда не перечисляет transport methods.** `apply_patch`, `exec_command`, `write_stdin` и `tool_search` — parser details, а не пользовательские категории. Full rows говорят «Чтение», «Поиск», «Правки», «Команды», «Git», «MCP», «Web», «План и управление», «Прочее» и объясняют, какой payload добавит включённый detail toggle. Описание «План и управление» не пересказывает внутренний класс общими словами, а перечисляет точные History-labels: `Plan`, `Task create`, `Task update`, `Task list`, `Todo write`, `Tool search`, `Ask user question`, `Wait`. Quick row использует те же `read/search/edit/run/git/mcp/web/plan/other`, созданные одним module-scope компонентом.

**Indicator dot-логика на 📋:** красные точки при отклонении от дефолта в сторону «меньше» (User/Claude OFF — пользователь что-то намеренно исключил, потенциально неожиданно при копировании), цветные при отклонении в сторону «больше» (Bash/Tools/Sub-agent ON — добавлен extra-контент). Дефолтное состояние = ни одной точки.

**Невидимый контекст: callsites.** В Timeline все 4 IPC-вызова `copy-range` спредят единый объект `copyFlags` — добавление нового флага не требует обхода всех callsites. Rewind-path (`Phase 1: copy → Gemini compact`) намеренно НЕ передаёт `copyFlags` — для compact-сводки нужен полный контекст диалога, не отфильтрованный пользовательскими настройками.

## Codex Copy Session export

Codex Copy Session строится из rollout JSONL (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), а не из Claude backtrace. User turns берутся из `event_msg.user_message`, ответы — из `response_item.message`, thinking — из `response_item.reasoning`, compact — из top-level `type: "compacted"`. `thread_rolled_back` удаляет последние turns из уже собранного export'а, потому что Codex rollback физически оставляет старые записи в файле.

Служебные `role=user` carriers не становятся USER-блоками clean copy: целый `environment_context`, автоматически приложенные `# AGENTS.md/CLAUDE.md instructions for …` и subagent notifications отбрасываются. В History AGENTS/CLAUDE instructions могут оставаться отдельным открываемым chip — это другая presentation-задача. Если Timeline сохраняет такой chip как адресуемый turn, clean projector обязан увеличить структурный `turnIndex`, не добавляя текста: удаление одновременно текста **и координаты** сдвигает все следующие selected turns, а последняя точка даёт `Selected range has no copyable content`.

Codex compact — структурная Timeline-точка и остаётся выбираемой в single/range действиях, но encrypted body никогда не является копируемым текстом. Любой clean/range/single export пишет ровно одну строку: `Context compacted (encrypted)`. Если есть authoritative postTokens — добавляется размер результата; если известны одновременно pre и post — строка показывает `664k → 11k tokens, −653k (encrypted)`. Один preTokens без post не выдаётся за размер результата. `replacement_history`, retained user messages и `[encrypted compaction state]` не разворачиваются ни при каком виде Copy.

Timeline selection и Copy projection намеренно разделены: compact участвует в подсветке диапазона, Delete/Edit и raw JSONL metrics, но в clipboard занимает одну мета-строку. Trailing compact не скрывается вместе с последней semantic group; attribute entry остаётся самостоятельной display-unit даже когда владеющая группа закрыта.

Tool-result boundary отличается от HistoryPanel raw cards: для чистого export'а canonical output — `response_item.function_call_output` / `custom_tool_call_output` / `tool_search_output`. `event_msg.mcp_tool_call_end` не используется как второй источник результата: там есть server/tool/duration/result, но если смешать оба слоя, MCP-вызов легко задублировать или получить два разных shape'а одного ответа. Для downstream LLM важен один блок `request/response`, не телеметрия lifecycle'а.

Codex raw names не образуют собственную taxonomy. `apply_patch` раскладывается на Edit по файлам; `exec_command` может стать Read/Search/Edit/Run/Git/Web по команде; namespace `mcp__*` остаётся MCP; `web_search_call` становится Web; `tool_search` относится к Plan/management; collaboration — Subagent. `tool_search_output` при включённой глубине всё равно ужимается до namespace/function list, чтобы schema dump не забивал clipboard.

Если добавляешь новый Codex `response_item.type`, сначала реши: это содержательный user/assistant/tool event или telemetry. Содержательное должно попасть в export под одним из существующих toggles или в `other_tools`; telemetry остаётся в History/Timeline diagnostics, но не в clean copy. Пользовательский симптом неправильной классификации — включил категорию в Copy Settings, а в копии либо пусто, либо raw service dump вместо полезного контекста.

## Unified Formatting (main.js)
Для обеспечения консистентности действий Claude и Codex используют `copy-action-format.js`; transport normalization остаётся у provider parser, а family/headline берутся из shared History grammar.
- **Claude Range Copy:** При двойном клике в Timeline система теперь не просто копирует префикс, а выполняет полноценный Backtrace для поиска `tool_result` и вставляет полное содержание файлов/диффов, если это включено в глобальных настройках.
- **Codex Range Copy:** тот же жест в Timeline открывает popup с `Копировать`, но backend идёт через `codex:copy-range` и режет уже собранный Codex timeline по выбранным `turnIndex` / compact UUID.
- **Actions Block:** Форматирование списка действий (`**Actions:**`) унифицировано для всех видов экспорта.

## Quick filters в `Copy Settings`
Ряд миниатюрных chip'ов живёт в верхней части popup'а `Настройки копирования`. Для обоих провайдеров он одинаков: `user · answer · reasoning · actions`, затем `read · search · edit · run · git · mcp · web · plan · other · sub-result/full`. Provider меняет только accent (`#DA7756` Claude, `#10A37F` Codex). `actions` — master видимости; дочерние action-чипы управляют глубиной payload. Sub split-pill сохраняет режим result/full.

**`ChipText` обязан жить на module-scope, не внутри render.** Раньше компонент был объявлен inline в IIFE рендера InfoPanel — React пересоздавал DOM-ноду каждой chip-кнопки на каждый рендер родителя, trusted-клик молча проглатывался (`pointerdown` приходил в старую ноду, `pointerup` — в новую, синтетический `click` event не выстреливал). Симптом: User и Claude иконки (прямой `<button>` в JSX) кликались, всё остальное — нет. Принцип — см. [`fix-inline-компонент-click.md`](fix-inline-компонент-click.md).

## Subagent tools: Task + Agent (Claude Code 2.1+ alias)
`Agent` инструмент в Claude Agent SDK ≥2.1 — переименованный `Task`. `copyActionFamily` трактует оба как `agent`; Claude progress и Codex collaboration adapter передают их одному formatter’у с режимами Result/History.

**Невидимый контекст:** жёстко зашитое `block.name === 'Task'` без alias'а делало `Agent` молчаливо невидимым в копии. Симптом: с тогглами «субагент → результат/история» ON юзер копировал диапазон с `Agent`-вызовом, в копии **ничего не появлялось** про сабагента. `Agent` уходил в fallback-категорию `'tools'`, при `includeTools = OFF` (дефолт) — полностью скрывался; при ON — выводился generic-меткой `⚙️ Agent` без `progressEntries` (потому что `taskProgress` собирался только для `Task`). Фикс приводит четыре места к общему mapping `'Task' || 'Agent' → subagent`.

## Deep serialization для MCP / Web / прочих default tools

Исторический старый formatter в `main.js` давал detail только Read/Edit/Write/Bash/Task. Всё остальное — MCP, Web, Glob/Grep/Monitor и новые tools — попадало в raw generic label. Текущий `copy-action-format.js` сериализует payload по semantic family и не выводит transport name как категорию.

**Симптом:** «Я выбрал MCP в настройках копирования, но в результате только название инструмента, ни input, ни output не видно».

**Шейп detail-блока для default-tools** (всё, что НЕ Read/Edit/Write/Bash/Monitor/Task/Agent):
- Label: `🔌 MCP \`<server>\` / \`<method>\`` для `mcp__server__method`; `🌐 Web Search (query)` / `🌐 Web Fetch (url)`; `⚙️ <ToolName>` для остального.
- Detail: один fenced ```json блок с объектом `{ request, response }`. `request` — input tool_use с удалённым CLI-полем `caller: {type:"direct"}` (вечный шум на каждом вызове). `response` — нормализованный `tool_result.content` (string как есть; array — склейка text-блоков; image-блоки → placeholder `[image: <mime>, ~<N>KB base64 omitted]` чтобы не выгружать 200-килобайтные PNG в clipboard).
- Не truncate'ится — симметрия с Bash/Read, юзер сам решает что урезать.

**Один semantic gate.** Callsite вызывает `copyActionFamily` только чтобы понять, стоит ли дорого искать tool_result. Тот же `actionDetailsEnabled` используется formatter’ом. Поэтому Glob/Grep, Python edit и Codex nested exec физически не могут попасть в разные buckets на двух стадиях.

**Image-блоки в screenshot.** `mcp__electron__electron_screenshot` возвращает массив `[{type:'text',text:'Screenshot saved.'},{type:'image',source:{data:'<base64 PNG>'}}]`. base64 в clipboard.writeText бесполезен для downstream LLM (нечитаемый шум 200KB+ на каждый скрин), но и пропускать факт скриншота нельзя — теряется контекст «что Claude увидел». Компромисс: image-блоки превращаются в `[image: image/png, ~195KB base64 omitted]` строку (с реальным размером, чтобы reader понимал масштаб), text-блоки идут как есть.

**Legacy callsite** (`claude:get-history` для mobile-web и MCP `get-history`) по-прежнему может передать старые `includeEditing/includeReading`; `formatSemanticToolAction` переводит их в минимальный semantic filter и вызывает тот же formatter. Отдельного legacy formatter больше нет.

**Невидимый контекст:** при копировании диапазона из сессии где Claude активно работал через `mcp__electron__*` (E2E-тесты) или `mcp__sc-desktop-tg-search__*` (телеграм-ресёрч) — в clipboard был набор `⚙️ mcp__...` строк, бесполезный для downstream-нейросети, которая не могла увидеть ни параметры запроса, ни ответ. Юзер копировал «контекст работы», а получал «список имён».

## Label-always семантика тогглов (depth, not visibility)

До этой правки toggle group OFF делал tool_use **невидимым** в копии (pre-filter `if (!groupOn) continue;` в callsite). Симптом: юзер выключал `read_file` чтобы не дампать содержимое 200 файлов, а в копии исчезала и **сама хронология** «Claude прочитал X, Y, Z». Reader не знал что Claude вообще читал что-то — только текст ответов.

**Новая семантика:** `includeActions` контролирует видимость action chronology целиком. При включённом master семейные `includeReading/includeSearch/includeEditing/includeRun/includeGit/includeMcp/includeWeb/includePlan/includeOther` контролируют **глубину** (есть ли fenced content-блок), а не видимость конкретного действия:
- Toggle OFF → 1-строчный label (`📄 Чтение (path)`, `🔌 MCP \`server\` / \`method\``, `🖥 Команда ("ls -la")`).
- Toggle ON → label + fenced detail (содержимое файла / diff / stdout / JSON-блок MCP).

**Видимость сообщений** независима: `includeUser`, `includeText` и `includeThinking`. Старый `includeClaude` остаётся только compatibility carrier; renderer выводит его из `answer || reasoning || actions` и больше не показывает provider-master в UI.

**Почему это работает:** semantic labels короткие и никогда не содержат полный command/prompt/pattern. 500 Read-labels значительно дешевле одного большого tool_result; payload появляется только по detail toggle. Симметрия с History: headline сообщает действие и субъект, исходный вызов живёт внутри.

**Implementation note:** Claude и Codex вызывают один `copy-action-format.js`; результат tool_use ищется только когда detail family включена. Это сохраняет label-always и не запускает дорогой result lookup ради краткой строки. Старые raw-флаги мигрируются один раз через `copySettingsVersion:3`; во время renderer/main version skew отправляются compatibility aliases, но новая классификация их не использует.

## Range Token Estimate + Breakdown popover

В Timeline range-action popup на чипе `↑XXK` (рядом с кнопкой «Копировать») показывается **верхняя оценка размера копии** — суммарные токены при условии что ВСЕ copy toggle'ы ON. Это не реальный размер текущей копии (toggle'ы могут срезать); это "максимум, который мог бы попасть в clipboard". При hover на чип открывается второй popover (под action menu, слева прижат к Timeline) с breakdown по категориям: User / Claude · text / Claude · thinking / Read / Edit · Write / Bash · shell / MCP · web · прочее / Субагент · result / Субагент · history / Compact summary. Категории с нулём токенов скрыты — чтобы не показывать 10 пустых строк.

**Backend:** IPC `claude:estimate-range-tokens` (claude-data.js). Реюзает тот же `resolveSessionChain` + backtrace + forward-expand что и `claude:copy-range`. Считает `chars` по тем же semantic families `Read/Search/Edit/Run/Git/MCP/Web/Plan/Other/Subagent/Compact` через `copyActionFamily`, затем конвертирует в токены формулой `Math.ceil(chars/3.5)`. `tool_use.input` сериализуется через `JSON.stringify` (минус CLI-шум `caller`), `tool_result.content`: string как есть, array — text-блоки склейкой, image-блоки → placeholder `[image: image/png, ~NKB base64 omitted]` (та же длина что в копии). Не дёргается на каждое движение мыши — только один раз при открытии rangeActionMenu.

**Frontend:** Timeline.tsx state `tokenEstimate: { total, downTotal, apiInputTokens, apiOutputTokens, categories }`, useEffect фетчит при изменении `rangeActionMenu.startUuid/endUuid`. Single-entry chip в Cmd+hover tooltip'е — lazy fetch на hover с кэшем по uuid (`singleCachedUuidRef`), чтобы хождение мышкой не дёргало backend. Popover в TooltipPortal: range — anchored right (`popupRightPx`), single — `left: chipRect.left`. `useLayoutEffect` flip-up logic: если `chipRect.bottom + popHeight > viewport.bottom - 10`, инвертируется (top: chipRect.top, transform: translateY(-100%)).

**Hit-test через глобальный mousemove, не onMouseLeave.** Popover монтируется conditional (`{open && <Portal>…</Portal>}`) — на `onMouseLeave` с chip-а wrapper unmount'ится в том же тике, до того как курсор пересечёт gap, и `mouseenter` на popover'е не выстреливает. Архитектура closing-логики: глобальный `window.addEventListener('mousemove', …)` активен только пока `open=true`, считает курсор внутри chip-rect ИЛИ popover-rect (с tolerance ±2px) → если вне обоих, `setOpen(false)`. `onMouseLeave` на chip-е и popover'е **не вешать** — они отрабатывают раньше и закрывают popover до того как hit-test может удержать. См. `methodology/сценарии-багов-design.md::2.7 Lazy popover wrapper`.

**mousedown stopPropagation на корневом div'е popover'а** (`onMouseDown={(e) => e.stopPropagation()}` + тот же `onClick`). Без этого клик по toggle-кнопке `JSONL`/`API` внутри popover'а закрывает родительский rangeActionMenu (родитель слушает `window.mousedown` для click-outside). `onClick` сам по себе не помогает: mousedown bubble'ит первым, родитель уже сбросил state до того как handler кнопки выстрелит. Симптом — *«кнопка тупо не работает»*. См. `methodology/сценарии-багов-design.md::4.6`.

**Gemini fallback:** `claude:estimate-range-tokens` доступен только для Claude-табов. Для Gemini `tokenEstimate=null`, чип показывает старую heuristic-оценку (сумма `entry.content.length/3.5` по user-prompt'ам в range), без breakdown — hover не открывает popover. Симметрично с copy-range backend'ом (Gemini идёт через `gemini:copy-range`, не делит на категории).

**Защита от закрытия action menu** при hover на breakdown popover: `onMouseLeave` rangeActionMenu делает геометрический hit-test против `breakdownPopoverRef.current.getBoundingClientRect()` — если курсор внутри popover'а, action menu не закрывается. То же для Cmd+hover entry tooltip'а — он слушает hit-test против `singleBreakdownPopoverRef`. Без этого пересечение gap между родителем и popover'ом убивает родительский overlay.

## Range Token Estimate: JSONL/API toggle в popover'е

В верху breakdown popover'а — две кнопки-таба `JSONL` / `API`, общий `breakdownMode` state для range и single popover'ов (выбор сохраняется в сессии, переключается раз).

**JSONL mode (default):** 10 категорий + total `В JSONL`. Считает суммарный вес записей в JSONL для диапазона. Отвечает на задачу юзера *«если я вырежу этот ответ, сколько сэкономлю относительно всего контекста»* — реальная экономия при delete-range/edit-range. См. принцип `methodology/дизайн-принципы.md::Метрика-инвариант`.

**API mode:** три статьи input + одна output. Раньше была одна строка `Input` = сумма всех трёх (uncached + cache_creation + cache_read), но это скрывало структуру биллинга. Сейчас:
- **Input billed** = `usage.input_tokens` (свежий промпт, full price)
- **↳ cached** = `cache_creation_input_tokens` (1.25×) + `cache_read_input_tokens` (0.1×). Indented под billed, dimmer цвет — это **дополнительный** input что попал под кэширование, не отдельный от billed.
- **Input (total)** = uncached + cached. Сумма с разделителем сверху. Это и есть «полный размер промпта как если бы кэша не было», та цифра что раньше показывалась как одиночный `Input`. Юзер: *«если эти два значения суммировать, то получится общий вес промпта, как если бы не было кэша»* — UI это отражает явно, через горизонтальную линию-сумму.
- **Output** = `output_tokens` (cache не применяется к output — Claude генерирует его заново каждый раз).

Backend (`claude:estimate-range-tokens`) возвращает три отдельных поля: `apiInputUncached`, `apiInputCacheCreate`, `apiInputCacheRead` — плюс aggregate `apiInputTokens` оставлен для backward compat (renderer падает на одну строку при отсутствии разбивки). Каждое слагаемое добавляется **только если поле есть** в JSONL — никакого zero-fill для отсутствующих. Юзер сформулировал явно: *«если кэш передаётся, считаем; если нет — не считаем»*.

`apiOutputTokens` дублирует `downTotal` (тот же `output_tokens`), но кладётся отдельным полем чтобы API-mode был self-contained блоком.

**Popover не должен схлопываться при переключении JSONL→API.** JSONL-mode рисует до 10 строк, API-mode — 3-4. Без `minHeight` на body popover'а высота просто сжимается на свитче, нижний край уползает выше курсора, mouseleave выстреливает, popover закрывается до того как юзер успел кликнуть. Юзер: *«когда я тыкаю на вторую вкладку, у меня меняется размер, и мгновенно это окно закрывается»*. Лечение — `minHeight: 180px` на оба popover'а (range и single). Если API-mode требует меньше — popover не сжимается, курсор остаётся над ним, bridge не рвётся. См. `methodology/дизайн-принципы.md::Layout reservation`.

**Почему `↓` убран с chip-а целиком.** Раньше chip показывал `↑XXK ↓YYK` — output_tokens API рядом с heuristic'ом JSONL-веса. Юзер: *«как мне это понимать?»* — `↑` и `↓` ходят по разным шкалам (JSONL chars/3.5 ≠ Anthropic billing tokens), их сумма не имеет смысла, разница тем более. Сейчас chip = одно число (`↑` = JSONL-вес), `↓` живёт только внутри API-mode popover'а как часть осознанного выбора режима. См. `methodology/дизайн-принципы.md::Метрика-инвариант`.

## Переименование `text` → `answer` в category labels

Категория Claude-ответа в Copy Settings popup, в InfoPanel mini-chip row и в breakdown popover теперь называется **«answer»**, не «text». Мотивация: `text` родовое — *«непонятно что такое текст, слишком общее описание»*. Под `text` могли неоднозначно подразумеваться thinking-блоки, текст внутри tool_use (input parameters), результаты tool_use; `answer` однозначно про финальный текст ответа Claude юзеру. См. принцип `methodology/дизайн-принципы.md::Категориальные toggle — имена сущностей, не абстракции`. Затронутые места — `CopySessionButton.tsx::ToggleRow «answer»`, `InfoPanel.tsx::ChipText «answer»`, `Timeline.tsx::renderBreakdownBody` (`Claude · answer`).
