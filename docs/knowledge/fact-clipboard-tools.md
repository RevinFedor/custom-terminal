# Feature: Clipboard & Pasted Blocks

## Intro
Инструменты для бесшовной передачи данных из буфера обмена в AI-исследователь.

## User Flow
1. Пользователь копирует произвольный текст/код.
2. **AI Research:** В панели Gemini нажимает кнопку **"Буфер"** → Research или Compact. Контент отправляется в чат.
3. **Log Compression:** В `ProjectToolbar` (справа вверху) нажимает кнопку **"Logs"**. 
   - Система читает буфер обмена.
   - Очищает логи (Grafana/Console) от мусора.
   - Записывает результат обратно в буфер.
   - Показывает Toast с информацией о проценте сжатия. См. `fact-log-compression.md`.

## Behavior Specs
- **:::pasted Syntax:** Для вставки в чат используется кастомный разделитель `:::pasted`.
- **Collapsible Blocks:** В чате блоки, помеченные как `pasted`, по умолчанию отображаются в свернутом виде с кнопкой Toggle. Это экономит место при работе с большими дампами кода.
- **Preprocessing:** `MarkdownRenderer` перехватывает `:::pasted` сегменты ДО парсинга основным Markdown-движком.

## Global Copy Settings
Настройки копирования сессии (`includeEditing`, `includeReading`, `fromStart`, + иерархические флаги ниже) вынесены в глобальное состояние (`useUIStore`) с персистенцией в `localStorage`.
- **Индикация:** Текущие настройки отображаются в виде цветных точек на иконке 📋 на самой кнопке Copy session (см. ниже).
- **Единый стандарт:** Любые операции копирования (кнопка Copy session, массовый экспорт, двойной клик по диапазону в Timeline, ПКМ-«Копировать» по одиночной точке) используют одни и те же правила фильтрации.

## Copy Session: размещение и UX
Кнопка переехала из ActionsPanel («жирная плашка» во вкладке Quick Actions) в `InfoPanel` под блок AI Session — компонент [`CopySessionButton.tsx`](../../src/renderer/components/Workspace/CopySessionButton.tsx). **Почему перенесли:** старая плашка занимала первый screen Quick Actions без частоты использования, который оправдал бы место; новое расположение контекстное — chip живёт рядом с источником данных (session-блоком), пользователь видит, что копирует **эту** сессию.

**Визуальная форма — сегментированный chip:** `[📋] | [Copy session]`. Две независимые hover-зоны, разделённые divider'ом 1px:
- **📋-половина** (settings): hover → accent-tinted фон + открывает Settings popup слева (тот же hierarchical-tree с тогглами).
- **Copy-половина** (label): hover → accent-tinted фон + текст белый + полужирный. Клик копирует сессию.

Каждая половина имеет собственный hover-state, не наследуется от другой — иначе непонятно, что именно сейчас будет нажато. См. [`methodology/design-bugs.md::7. Hover affordance`](../methodology/design-bugs.md).

**CMD+hover на chip → single-line input снизу для custom session ID.** Это замена развёрнутой textarea-«модалки» (раньше клик по `▶` открывал блок с textarea + кнопкой Copy). Сейчас:
- Просто `<input>` высотой 26px, без заголовка/описания/footer-кнопки. Enter = copy + close, Esc = close.
- Ширина **динамическая**: от `chipRect.left` до левого края Timeline-strip (`[data-timeline]`) минус 8px. Перемеряется на `window.resize`. Без этого статичные 320px клипались за сайдбар.
- Принцип «single-line input вместо модалки» см. [`methodology/design-bugs.md::Минимализм popup'ов`](../methodology/design-bugs.md).

**CSS-bridge между chip'ом и input'ом.** Wrapper позиционирован **вплотную** к низу кнопки (`top: chip.bottom`), визуальный 4px gap создаётся через `paddingTop: 4` ВНУТРИ wrapper'а. Если задать `top: chip.bottom + 4` — между chip'ом и wrapper'ом возникает 4px мёртвая зона, popup закрывается при движении курсора сверху вниз. См. [`methodology/design-bugs.md::2.3 Wrapper смещён вниз от триггера`](../methodology/design-bugs.md).

**Индикаторные точки на 📋** показывают только «не-дефолтные» флаги: красные — если User/Claude отключены, цветные — если Reading/Editing/Bash/Tools включены (по дефолту OFF), синий — если `fromStart=false`. Юзер видит «что в копии есть подозрительного» одним взглядом без открытия Settings.

### Hierarchical Copy Groups
UI настроек копирования организован в три верхних блока — **User**, **Claude**, **Subagent** — с дочерними фильтрами внутри Claude и Subagent. Это переход от плоских пяти тогглов к семантическому дереву.

**Структура флагов:**
| Уровень 1 | Уровень 2 (children) | Дефолт |
|---|---|---|
| `includeUser` | — | ON |
| `includeClaude` | `includeText`, `includeThinking`, `includeReading`, `includeEditing`, `includeBash`, `includeTools` | ON / ON,ON,prev,prev,OFF,OFF |
| Subagent (master) | `includeSubagentResult`, `includeSubagentHistory` | OFF, OFF |
| — | `fromStart` (range, не content) | true |

**Дефолты Bash/Tools = OFF.** Старые пользователи имели только Reading/Editing тогглы. После иерархического апгрейда Bash и Tools — новые группы с дефолтом OFF, чтобы существующие пайплайны не получили внезапно 200 KB Bash-логов в `clipboard.writeText()`. Если юзер явно включил Bash раньше через старый Editing (хак: до фикса Bash сидел внутри `includeEditing`), его поведение мигрирует не идеально — это сознательная цена за чистую семантику.

**Tool → group mapping (`getToolGroup` в `main.js`):**
- `reading` ← Read, NotebookRead
- `editing` ← Edit, Write, NotebookEdit
- `bash` ← Bash, **Monitor**, **Grep**, **Glob** — shell-flavoured commands. Monitor берёт shell-команду параметром и стримит её stdout, семантически это long-running Bash, не «tool». Отделение Grep/Glob в reading создавало рассинхрон с callsite-классификаторами в `claude-data.js` (там они всегда были bash), при котором Glob с `includeBash=ON, includeReading=OFF` проходил pre-filter callsite, но получал label-only внутри formatToolAction. См. Deep serialization секцию ниже.
- `subagent` ← Task, Agent
- `tools` ← всё остальное: `mcp__*`, WebFetch, WebSearch, Skill, Cron*, ScheduleWakeup, RemoteTrigger, PushNotification, EnterWorktree, ExitPlanMode, ListMcpResources*, AskUserQuestion. Новые tools по умолчанию попадают сюда — safe bucket.

**Почему MCP/Web/Agent не разделены на отдельные toggle:** дробление по семантике даёт 4-5 категорий с 1-2 вызовами в каждой. UI-сложность не оправдана. Если в будущем какая-то группа явно понадобится отдельно (например, Web для копирования web-research контекста без MCP-шума) — добавится подтоггл, структура расширяется.

**Master-toggle + incremental cascade.**
- Parent OFF → все children рендерятся `disabled` (значение сохраняется в store, UI-клик блокируется). Восстановление parent ON возвращает прежний выбор children.
- `Subagent` master синтезирован: `active = result || history`. Клик по нему: если оба OFF → включает только Result (минимальный полезный набор); если хоть один ON → выключает оба.
- Subagent.History ON форсирует Subagent.Result ON (история без финального результата теряет анкер для отображения). Subagent.Result OFF форсирует History OFF (зеркально). Принцип «incremental» сформулирован пользователем дословно: *«вкл туго последнее → выкл туго вся история, и наоборот»*. Принцип в `methodology/design.md::Master toggle + incremental children`.

**UI-лейблы child-тогглов = реальные имена tool из JSONL.** Раньше child назывались абстрактно (`Bash`, `Tools`) — пользователь не понимал разницу. Теперь рендерятся как код в monospace: `<code>Read</code> · <code>Grep</code> · <code>Glob</code>` для reading; `<code>Bash</code> · <code>Monitor</code>` + хинт `shell`; `<code>mcp__*</code> · <code>Web</code> · <code>Agent</code>` + хинт `MCP и прочее`. См. `methodology/design.md::Категориальные toggle — имена сущностей, не абстракции`.

**Indicator dot-логика на 📋:** красные точки при отклонении от дефолта в сторону «меньше» (User/Claude OFF — пользователь что-то намеренно исключил, потенциально неожиданно при копировании), цветные при отклонении в сторону «больше» (Bash/Tools/Sub-agent ON — добавлен extra-контент). Дефолтное состояние = ни одной точки.

**Невидимый контекст: callsites.** В Timeline все 4 IPC-вызова `copy-range` спредят единый объект `copyFlags` — добавление нового флага не требует обхода всех callsites. Rewind-path (`Phase 1: copy → Gemini compact`) намеренно НЕ передаёт `copyFlags` — для compact-сводки нужен полный контекст диалога, не отфильтрованный пользовательскими настройками.

## Unified Formatting (main.js)
Для обеспечения консистентности данных, логика формирования текста (обработка `thinking` блоков, форматирование `diff` и `tool_use`) вынесена в общую функцию `formatToolAction` в Main-процессе. 
- **Range Copy:** При двойном клике в Timeline система теперь не просто копирует префикс, а выполняет полноценный Backtrace для поиска `tool_result` и вставляет полное содержание файлов/диффов, если это включено в глобальных настройках.
- **Actions Block:** Форматирование списка действий (`**Actions:**`) унифицировано для всех видов экспорта.

## Markers row — inline chips под `Copy session`
Ряд миниатюрных chip'ов рядом с кнопкой `Copy session` зеркалит флаги копирования (User, Claude, text, thinking, read, edit, bash, mcp, ⑂fork, sub-/result). Каждый chip — одиночный toggle: клик переключает соответствующий `copyInclude*` флаг в `useUIStore`. Цвет ON = `#DA7756` (Claude brand), OFF = `#555`. Sub- chip — split-pill: левая половина включает/выключает субагент целиком, правая переключает режим `result ↔ full` (история).

**`ChipText` обязан жить на module-scope, не внутри render.** Раньше компонент был объявлен inline в IIFE рендера InfoPanel — React пересоздавал DOM-ноду каждой chip-кнопки на каждый рендер родителя, trusted-клик молча проглатывался (`pointerdown` приходил в старую ноду, `pointerup` — в новую, синтетический `click` event не выстреливал). Симптом: User и Claude иконки (прямой `<button>` в JSX) кликались, всё остальное — нет. Принцип — см. [`fix-inline-компонент-click.md`](fix-inline-компонент-click.md).

## Subagent tools: Task + Agent (Claude Code 2.1+ alias)
`Agent` инструмент в Claude Agent SDK ≥2.1 — переименованный `Task`. Тот же `agent_progress` stream через `parentToolUseID`, тот же input shape (`description`, `prompt`, `subagent_type`, `run_in_background`). Все классификаторы группы copy-export'а трактуют их одинаково: `getToolGroup(toolName)` отдаёт `'subagent'` для обоих, `formatToolAction` label `🧵 Субагент (...)` + Result/History ветки покрывают оба. Inline-классификаторы в `claude:copy-range` и `claude:export-clean-session` зеркалят то же mapping.

**Невидимый контекст:** жёстко зашитое `block.name === 'Task'` без alias'а делало `Agent` молчаливо невидимым в копии. Симптом: с тогглами «субагент → результат/история» ON юзер копировал диапазон с `Agent`-вызовом, в копии **ничего не появлялось** про сабагента. `Agent` уходил в fallback-категорию `'tools'`, при `includeTools = OFF` (дефолт) — полностью скрывался; при ON — выводился generic-меткой `⚙️ Agent` без `progressEntries` (потому что `taskProgress` собирался только для `Task`). Фикс приводит четыре места к общему mapping `'Task' || 'Agent' → subagent`.

## Deep serialization для MCP / Web / прочих default tools

До этой правки в `formatToolAction` (main.js) detail-блок (fenced content под label) был только у Read/Edit/Write/Bash/Task. Всё остальное — MCP-инструменты (`mcp__sc-desktop-tg-search__telegram_semantic_search`, `mcp__electron__electron_screenshot`, ...), `WebSearch`/`WebFetch`, `Glob`/`Grep`/`Monitor`, новые tools (`Skill`, `Cron*`, `ScheduleWakeup`, `RemoteTrigger`, `EnterWorktree`, `ExitPlanMode`, `AskUserQuestion`, ...) — попадало в `default: label = '⚙️ ' + toolName` и рендерилось одной строкой. Юзер видел в копии «`⚙️ mcp__knowledge__docs_search`» вместо квадратки с параметрами и ответом, при том что соответствующий toggle (`MCP и прочее` / `bash` / `shell`) был ON.

**Симптом:** «Я выбрал MCP в настройках копирования, но в результате только название инструмента, ни input, ни output не видно».

**Шейп detail-блока для default-tools** (всё, что НЕ Read/Edit/Write/Bash/Monitor/Task/Agent):
- Label: `🔌 MCP \`<server>\` / \`<method>\`` для `mcp__server__method`; `🌐 Web Search (query)` / `🌐 Web Fetch (url)`; `⚙️ <ToolName>` для остального.
- Detail: один fenced ```json блок с объектом `{ request, response }`. `request` — input tool_use с удалённым CLI-полем `caller: {type:"direct"}` (вечный шум на каждом вызове). `response` — нормализованный `tool_result.content` (string как есть; array — склейка text-блоков; image-блоки → placeholder `[image: <mime>, ~<N>KB base64 omitted]` чтобы не выгружать 200-килобайтные PNG в clipboard).
- Не truncate'ится — симметрия с Bash/Read, юзер сам решает что урезать.

**Двойной gate.** Tool_use проходит ДВА фильтра прежде чем получить detail-блок: (1) callsite pre-filter в `claude:copy-range` / `claude:export-clean-session` (inline-классификатор тула → группа → проверка `groupFlags`), (2) `shouldInclude` внутри `formatToolAction` (на основе `getToolGroup`). До этой правки эти две классификации **расходились** на Glob/Grep: inline-классификатор клал в `bash`, `getToolGroup` — в `reading`. Симптом: при `includeBash=ON, includeReading=OFF` Glob проходил callsite и НЕ получал detail, потому что внутренний gate срезал по reading. Фикс: `getToolGroup` синхронизирован с inline (`Glob`/`Grep` → `bash`). Симметрично UI-хинту в Settings popup («`Bash · Monitor` shell»).

**Image-блоки в screenshot.** `mcp__electron__electron_screenshot` возвращает массив `[{type:'text',text:'Screenshot saved.'},{type:'image',source:{data:'<base64 PNG>'}}]`. base64 в clipboard.writeText бесполезен для downstream LLM (нечитаемый шум 200KB+ на каждый скрин), но и пропускать факт скриншота нельзя — теряется контекст «что Claude увидел». Компромисс: image-блоки превращаются в `[image: image/png, ~195KB base64 omitted]` строку (с реальным размером, чтобы reader понимал масштаб), text-блоки идут как есть.

**Legacy callsite** (`claude:get-history` для mobile-web и MCP `get-history`) вызывает `formatToolAction` без `opts.flags`, на старых булевых `includeEditing`/`includeReading`. В legacy-fallback ветке `shouldInclude` для групп `bash`/`tools` остаётся `undefined` → label-only, как и было. Mobile-API не получает изменений в выдаче.

**Невидимый контекст:** при копировании диапазона из сессии где Claude активно работал через `mcp__electron__*` (E2E-тесты) или `mcp__sc-desktop-tg-search__*` (телеграм-ресёрч) — в clipboard был набор `⚙️ mcp__...` строк, бесполезный для downstream-нейросети, которая не могла увидеть ни параметры запроса, ни ответ. Юзер копировал «контекст работы», а получал «список имён».

## Label-always семантика тогглов (depth, not visibility)

До этой правки toggle group OFF делал tool_use **невидимым** в копии (pre-filter `if (!groupOn) continue;` в callsite). Симптом: юзер выключал `read_file` чтобы не дампать содержимое 200 файлов, а в копии исчезала и **сама хронология** «Claude прочитал X, Y, Z». Reader не знал что Claude вообще читал что-то — только текст ответов.

**Новая семантика:** `includeReading`/`includeBash`/`includeTools`/etc. контролируют **глубину** (есть ли fenced content-блок), а не **видимость** tool_use:
- Toggle OFF → 1-строчный label (`📄 Чтение (path)`, `🔌 MCP \`server\` / \`method\``, `🖥 Команда ("ls -la")`).
- Toggle ON → label + fenced detail (содержимое файла / diff / stdout / JSON-блок MCP).

**Видимость** по-прежнему контролируется master-тогглами: `includeClaude=OFF` скрывает весь assistant-блок целиком; `includeUser=OFF` скрывает все user-prompts.

**Почему это работает:** labels — дешёвые (одна строка ~30-150 chars), все ветки `formatToolAction` уже обрезают многострочные scalar'ы (`input.command` → substring 50, `input.prompt` → substring 60). 500 Read-labels = ~30KB, что меньше одного `tool_result` от Read большого файла. Никаких многострочных взрывов нет. Симметрия с UX-паттерном Timeline: tooltip всегда показывает labels, content раскрывается отдельно.

**Implementation note:** `formatToolAction` уже корректно возвращает label-only когда `shouldInclude=false` — старый pre-filter `if (!groupOn) continue;` в callsite был избыточен и блокировал label. Удалён в обоих callsite (`claude:copy-range`, `claude:export-clean-session`). Классификация `group` сохранилась — она нужна для оптимизации: поиск `toolResult` в активной истории делается ТОЛЬКО когда `groupOn=true` (когда detail-блок реально понадобится), иначе пропускается. На длинных диапазонах с 400+ tool_use экономит O(N×M) поиск.

