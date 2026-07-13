# Факт: пакет `@noted/claude-blocks` (переносимые блоки рендера Claude-диалога)

## Что это
Локальный source-пакет `packages/claude-blocks/` — единый источник визуала для
рендера Claude-диалога (tool-карточки Bash/Read/Edit/Write/MultiEdit/Generic,
дифф, thinking-блок, markdown-проза с code-блоками). Потребляется **пятью**
местами: десктопным SDK-табом (`ClaudeSDK/ClaudeSDKTab.tsx`), мобилкой
(`mobile-web/src/App.tsx`), **JSONL-history окном** (`Workspace/HistoryPanel.tsx`,
по Cmd+]), и — из **соседнего проекта voice-record** — его десктоп-оверлеем
(`voice-record/src/renderer/prompt.tsx`) и его mobile-web (`voice-record/mobile-web`).
Source-alias работает кросс-проектно: voice-record указывает на
`../custom-terminal/packages/claude-blocks/src`. Поэтому правка в пакете задевает
**оба** проекта — voice-record был драйвером части изменений ниже (bash-ellipsis,
`SparklesIcon`). До пакета весь визуал жил инлайн в `ClaudeSDKTab.tsx`
(5800 строк), мобилка имела **свою divergent**-копию (catppuccin `#a6e3a1`/
`#f38ba8`, system-шрифт, без подсветки), а HistoryPanel — **третью** (plain-text
bash обрезанный до 60 char, naive old/new дифф) — теперь все три рендерят один
канон (десктопный SDK).

### HistoryPanel (Cmd+]) — потребитель №3
JSONL-парсер в main (`src/main/ipc/claude-data.js`, `claude:get-full-history`)
**пре-форматировал** tool-calls в строки/типизированные объекты (терял команду
Bash после 60 символов, не тянул результаты для не-Task тулзов). Чтобы пакет мог
рисовать настоящие карточки, парсер теперь к каждому **не-Task** tool_use крепит
сырой носитель `{ tool: '__raw__', rawTool: {toolName, args, result, isError} }`
(полный input + результат через generic `findToolResult()`). HistoryPanel рендерит
их через `ToolCallPart`, thinking → `ThinkBlock`, текст → `Markdown`. **Субагенты
(Task) НЕ тронуты** — остаются на legacy `SubAgentBlock` (просьба «субагентов пока
не трогаем»). Legacy-shape'ы (`FileAction`/string — Gemini/старый кэш) сохранены как
фоллбэк, рендерятся в исходном порядке (turn чередует Bash→Edit→Task). Пакетные
компоненты **context-free** (ноль зависимостей от Zustand/контекста) — поэтому
безопасны вне SDK-таба. **Главное правило при правках парсера:** main-процесс не
hot-reload'ится — нужен рестарт Electron (dev: рестарт `npm run dev`-таба; prod:
`build:install`), иначе `rawTool` не появится и HistoryPanel молча уйдёт в legacy-
фоллбэк.

Codex History использует тот же `ToolCallPart`, поэтому верхнеуровневый `exec` нельзя
«чинить визуально» внутри пакета: это transport-envelope нового rollout, а не новый
вид пользовательского действия. Codex adapter обязан до пакета развернуть вложенные
`tools.*(...)` в канонические Bash/Read/Edit/Write/MultiEdit/MCP shape'ы и связать
отложенный `wait(cell_id)` с исходными карточками. Пакет получает уже смысл действия;
если в History снова виден `EXEC const ...`, проверять нужно parser boundary, не
`ToolCard`/CSS. Конкретный rollout-контракт — `fact-codex.md::Timeline и History`.

## Копирование выделения сохраняет markdown-структуру
react-markdown рендерит markdown в семантический HTML (`<li>`, `<strong>`,
заголовки). При копировании выделения **мышью** браузер сериализует отрисованный
DOM в текст и теряет структуру: маркер списка `-`/`1.` исчезает (рисуется CSS-
буллетом, не текстом), пустые строки между блоками пропадают (margin вместо `\n`),
отступы схлопываются. Симптом: «скопировал список — получил сплошные строки без
тире».

Фикс — `onCopy`-хендлер на `.cb-prose` (`Markdown.tsx` + `selectionMarkdown.ts`):
на copy-событии берёт `Range.cloneContents()` выделения и сериализует обратно в
markdown (`<li>`→`- `/`N. `, заголовки→`#`, `<pre>`→```` ``` ````-fence, блоки через
`\n\n`, вложенные списки с отступом). Работает для полного И частичного выделения
(cloneContents даёт ровно выбранный поддерево-срез). Применяется **автоматически
ко всем трём потребителям** (SDK / HistoryPanel / mobile) — все рендерят через
`CBMarkdown`. Кнопочное копирование SDK (`ActionBarPrimitive.Copy`, берёт raw-text
напрямую) не задето — `onCopy` срабатывает только на non-collapsed выделении внутри
prose. **Inline-маркеры `**`/`` ` `` НЕ ре-инжектятся** — копируется читаемый текст
(strong/code разворачиваются в их текст), не markdown-сырец, чтобы paste совпадал с
тем что юзер видит.

## Block-spacing `.cb-prose` = 8px (не 2px)
Изначально `p { margin: 2px }` (плотность Claude TUI) — но в HistoryPanel парсер
склеивает все text-блоки turn'а в один prose через `\n\n`, и 2px между абзацами
читались как «сплошной текст». Поднято до `p/ul/ol { margin: 8px }`, `li { 2px }`,
`line-height: 1.5`. Видимый воздух между блоками, общий для всех потребителей.

## Два слоя (по принципу «гамма в переменных» + «правила отображения»)
- **`src/theme.css`** — дизайн-токены. Все цвета/шрифты/размеры как CSS-переменные
  `--cb-*` (префикс не конфликтует с проектом). Перекрасить под другой проект =
  переопределить горстку токенов в своём `:root` **после** импорта (later wins).
- **`src/blocks.css`** — правила отображения блоков. Чистый CSS (БЕЗ Tailwind!),
  классы `cb-*`, цвета только через `var(--cb-*)`.
- **`src/styles.css`** — агрегатор (`@import` обоих). Потребитель импортит одной
  строкой: `import '@noted/claude-blocks/styles.css';`.
- **Компоненты** (`src/components/`, `src/icons/`, `src/helpers.ts`,
  `src/rehypeHexHighlight.ts`) — React-кирпичи, читают `.cb-*` классы.

Почему НЕ Tailwind внутри пакета: arbitrary-классы (`text-[#...]`) физически не
переносятся — они существуют только если у проекта-потребителя тот же Tailwind v4
со сканером, который их увидит (известный шрам — `fact-rendering-styles.md`). Чистый
CSS + токены переносится в любой проект as-is.

## Почему иконки заинлайнены SVG, не lucide
mobile-web **не тянет** `lucide-react`. Встроенный SVG (`src/icons/index.tsx`,
геометрия из lucide) — единственный переносимый путь. Цвет через `currentColor`.

## Подключение: Vite source-alias, НЕ npm-publish, НЕ dist/rsync
Это апгрейд над схемой `@gt-editor/markdown-editor` (который опубликован на npm +
ручной `build:markdown` rsync-костыль, см. `fix-vite-prebundle-cache.md`). Здесь —
**алиас на исходник**, Vite компилит TSX пакета вживую как свой файл:

- **desktop** (`electron.vite.config.js`, renderer.resolve.alias): `@noted/claude-blocks`
  → `packages/claude-blocks/src`. Стоит **перед** алиасом `@` (приоритет). React
  внутри пакета резолвится через тот же alias-блок (`dedupe: ['react','react-dom']`)
  → единый инстанс.
- **mobile** (`mobile-web/vite.config.ts`): тот же find-алиас на
  `../packages/claude-blocks/src` + **`server.fs.allow: [REPO_ROOT]`** (пакет лежит
  ВЫШЕ mobile-web/, без этого Vite dev не прочитает файлы за пределами root) +
  **react/react-dom alias на `mobile-web/node_modules` + `dedupe`** — иначе пакет,
  резолвясь от repo-root, притащит ВТОРОЙ инстанс React → краш «invalid hook call».

**Команды НЕ меняются.** `npm run dev` и `build:install` работают как раньше —
алиас прозрачен, пакет бандлится в renderer как любой свой модуль. Нет отдельного
`build:claude-blocks`, нет dist, нет rsync, нет чистки `.vite`. Правка в пакете =
мгновенный HMR в обоих потребителях.

## Зависимости
Пакет требует (peer): `react-markdown`, `remark-gfm`, `react-syntax-highlighter`,
`unist-util-visit`. Десктоп их уже имел. **mobile-web доустановлен**
`react-syntax-highlighter@^16` + `@types/...` + `unist-util-visit` (lucide НЕ нужен —
SVG инлайн). Версия highlighter совпадает с root (16.1.0) ради единого Prism-стиля
`oneDark`.

## Collapse-механизм — внедряемый (ключевая развязка desktop/mobile)
Раскрытие tool-карточек/thinking у десктопа и мобилки **разное** и его нельзя
вшивать в пакет:
- desktop — scroll-stable toggle (`useStableCollapseToggle`, flushSync +
  scroll-compensation внутри Virtuoso, чтобы при раскрытии не дёргался скролл);
- mobile — персист в module-level Map (`useEntryExpanded`), переживает re-mount
  virtua при scroll-out/scroll-back.

Решение: `ToolCard`/`ThinkBlock`/`ToolCallPart` принимают **опциональные**
`open`/`onToggle`/`anchorRef` (controlled-режим). Если переданы — компонент
управляемый, потребитель внедряет свой персист. Если нет — внутренний `useState`
(для голого потребителя). `ToolCallPart` рендерит ровно ОДНУ карточку, поэтому
одной пары `open/onToggle` достаточно. `defaultOpenForTool(name)` (Edit/Write/
MultiEdit → open) экспортируется, чтобы оба сидела seed'или начальное состояние
одинаково.

## Шрам внутри: `-webkit-font-smoothing: antialiased` на `.cb-prose`
Симптом: «обычный (не-bold) текст в SDK выглядит жирнее обычной прописи». Причина —
markdown-контейнер НЕ имел `-webkit-font-smoothing` (его ставил только
`.terminal-instance` в globals.css). На macOS дефолтный subpixel-AA рендерит
моно-шрифт на ~полвеса тяжелее. `.cb-prose { -webkit-font-smoothing: antialiased }`
возвращает нормальный вес. Проверяется: `getComputedStyle($('.cb-prose'))
.webkitFontSmoothing === 'antialiased'`, `p` weight = 400.

## Маппинг shape данных (важно для мобилки)
Мобильный `UiEntry{kind:'tool', tool, input, result, isError}` → package-пропы
`ToolCallPart{toolName, args, result, isError}`. То есть `tool→toolName`,
`input→args`. Десктоп зовёт `ToolCallPart` напрямую из `MessagePrimitive.Content`
tools.Fallback с теми же именами.

## `ChatMessage` — рендер ВСЕГО сообщения (расположение + содержимое)
Раньше пакет рендерил только **содержимое** блока (markdown/code/think/tool), а
**расположение** (user справа, assistant на всю ширину, бабблы, фон, бейджи,
слэш-чипы, compact-карточка, панель действий) жило копипастой у каждого
потребителя. Юзер: *«мне нужно, чтобы он рендерил весь чат… SDK должен отвечать
за расположение элементов»*. Теперь `ChatMessage` рисует **строку чата целиком**.

- **Data-driven**, не runtime. Принимает нормализованную `ChatEntry`
  (`kind: user|assistant|thinking|tool|slash|compact-summary|system|error` +
  поля). Каждый потребитель **нормализует свой источник** в `ChatEntry`:
  мобила — `UiEntry → ChatEntry` (тривиальный маппинг, shape почти совпадает,
  только `tool→tool/input`), gt-editor — свой turn → `ChatEntry`, десктоп SDK
  остаётся на assistant-ui runtime (см. ниже почему).
- **Поведение внедряется** через `ChatRenderContext`:
  - `collapse?: CollapseController` (`isOpen(id,def)` + `toggle(id,next)`) —
    потребитель оборачивает в свою scroll-логику. Мобила: persist
    `_entryExpanded` + `stickToggle` (bottom-stick) + глобальный re-render
    (`useGlobalToggle`/`bumpGlobalToggle` — virtua держит только видимые ряды,
    перерисуются лишь они). Без контроллера — локальный `useState`
    (gt-editor по умолчанию работает без настройки).
  - `actions?: MessageActions` (`onCopy`/`onRepeat`/`onEdit`) — кнопка
    рендерится только если соответствующий колбэк передан. Не передал — нет
    кнопки (gt-editor может начать без действий).
  - `anchorRefFor?(id)` — десктопу нужен ref-якорь для scroll-compensation.
- **Owns весь визуал**: `.cb-row-*` (выравнивание по роли), `.cb-user-bubble`
  (Claude-оранж, tail-corner `border-bottom-right-radius:4px`), `.cb-slash-chip`
  (violet), `.cb-queued-badge`, `.cb-stopped-badge`, `.cb-paste-chip` (с
  preview-раскрытием), `.cb-compact-card`, `.cb-msg-actions`/`.cb-copy-btn`.
  Все цвета — токены `--cb-*` (перекрашивается под бренд).
- **НЕ owns**: скролл-контейнер/виртуализацию (расходится Virtuoso vs virtua —
  остаётся у потребителя, пакет рисует ОДИН ряд), composer, выбор модели,
  lifecycle процесса (SSE/JSONL/kill — дело потребителя).

### Почему десктоп SDK НЕ переведён на `ChatMessage`
Десктоп **runtime-driven** (assistant-ui `MessagePrimitive`/`useMessage`): его
`UserMsg`/`AssistantMsg` тянут роль/текст/части из рантайма, имеют inline edit-
mode и runtime part-dispatch (`MessagePrimitive.Content` с Text/Reasoning/tools).
Конвертировать в data-driven = переписать рабочий, тяжело-оттестированный код с
риском регрессий (edit, repeat, queued, stopped). Десктоп остаётся **визуальным
каноном**, который `ChatMessage` зеркалит; он уже потребляет блоки пакета
(Markdown/ThinkBlock/ToolCallPart). Портабельный «весь чат» нужен для НОВЫХ
потребителей (gt-editor) и мобилы — там `ChatMessage` и применён.

### Мобила: EntryView стал тонким адаптером
Все per-kind карточки мобилы (`UserText`/`ThinkingCard`/`ToolCard`/
`CompactSummaryCard`/`CollapsibleText`/`Markdown`-wrapper) **удалены** (~150
строк). `EntryView` теперь: `uiToChatEntry(entry)` → `<CBChatMessage ctx=
{mobileRenderCtx}/>`. Бабл юзера перекрашен `#1f3a5f` → Claude-оранж (canon).

## Bash-заголовок: ellipsis в шапке + полный заголовок при раскрытии
Шрам узкого экрана (драйвер — voice-record mobile). `.cb-tool-desc` (LLM-овская
скобка-описание, напр. Bash `description`) был `flex-shrink:0` без ellipsis — на узком
вьюпорте описание держало полную ширину и **выталкивало саму команду за экран**, а в
раскрытом теле показывался только вывод, описание не показывалось нигде. Фиксы (оба в
пакете, поэтому чинят все 5 потребителей):
- `blocks.css`: `.cb-tool-desc` → `flex-shrink:1; min-width:0; max-width:45%;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis` — описание **ужимается**
  с многоточием, команда (`.cb-tool-preview`, `flex:1 1 0`) всегда получает место.
- `BashCard` (`ToolCards.tsx`): в раскрытом теле первым рисуется `<div class="cb-bash-desc">`
  с **полным** описанием (wrap), затем команда, затем вывод — то, что ужалось в шапке,
  всегда восстановимо на раскрытии. Border-условие результата сменено `cmd ?` →
  `(cmd || description) ?`.

Только `BashCard` передаёт `description` в `ToolCard`; `GenericToolCard` его не шлёт
(описание идёт в `preview`). Поэтому `.cb-tool-desc` ужимается **только** у Bash, где
есть парный `cb-bash-desc` для раскрытия — несоответствия «ужали в шапке, но негде
раскрыть» нет. На широком десктопе `max-width:45%` режет длинные описания раньше, чем
есть место — приемлемо (полный текст на раскрытии); при желании сделать `clamp()`.

## `SparklesIcon` — иконка prompt-чипа
Добавлена `SparklesIcon` (`icons/index.tsx`, экспорт в `index.ts`) — геометрия sparkles
из десктопного prompt-чипа voice-record, чтобы prompt-чип выглядел одинаково на десктопе
и в mobile-web (там стоял текстовый «✦»-плейсхолдер). Имя не конфликтует с `lucide`-
`Sparkles` (другой модуль). Потребитель — `voice-record/mobile-web`.

## API пакета (`src/index.ts`)
Компоненты: `ChatMessage` (весь чат), `Markdown`, `MarkdownCodeBlock`,
`ThinkBlock`, `ToolCard`, `ColoredToolIcon`, `DiffView`, `ToolCallPart`,
`BashCard/ReadCard/EditCard/GenericToolCard`. Иконки: `TerminalIcon/FileEditIcon/
RefreshCwIcon/PencilIcon/XIcon/SparklesIcon/.../toolIcon`. Хелперы: `detectLanguage, lineDiff,
countDiffStats, extractRawText, toolStatusFrom, defaultOpenForTool, resultToText,
copyText`, `rehypeHexHighlight, selectionToMarkdown`. Типы: `ChatEntry,
ChatEntryKind, CompactMetrics, CollapseController, MessageActions,
ChatRenderContext, DiffEntry, ToolStatus, CollapseInjection, ToolCardProps, ...`.
Файлы: `src/messageTypes.ts` (форма + injection-точки), `src/components/
ChatMessage.tsx` (диспетчер по kind).

## Что НЕ переносили (специфичное, осталось у потребителя)
- desktop: `useStableCollapseToggle` (scroll-compensation), `CompactSummaryMsg`,
  `UserMsg`, slash-overlay, copy-button, эффорт-лейбл thinking — это не «блок
  рендера сообщения», а обвязка таба.
- mobile: `CompactSummaryCard`, `CollapsibleText`, `ResultPreview`-логика
  (теперь вывод режет сам package через maxHeight+overflow), tab-list, композер.
- `copyText()` в пакете host-agnostic: пробует Electron-clipboard, фоллбэк на
  `navigator.clipboard` — работает и в десктопе, и в мобилке.

## Связанные файлы
- `packages/claude-blocks/` — сам пакет.
- `electron.vite.config.js` (renderer.resolve.alias), `mobile-web/vite.config.ts`
  (alias + fs.allow + react dedupe).
- **Кросс-проект:** `voice-record/docs/knowledge/fact-chat-agent.md` (десктоп-оверлей —
  потребитель) и `fact-mobile-bridge.md` (voice-record mobile-web — потребитель). Оба
  source-alias'ят этот пакет из соседнего чекаута. При правке пакета держать в уме оба
  проекта.
- `src/renderer/main.tsx` / `mobile-web/src/main.tsx` — импорт `styles.css`.
- `fix-vite-prebundle-cache.md` — чем этот подход (source-alias) лучше схемы
  md-editor (publish + rsync).
- `fact-rendering-styles.md` — почему arbitrary Tailwind не переносится (мотивация
  чистого CSS в пакете).
- `methodology/переносимый-дизайн.md::Зеркальный клиент наследует раскладку
  источника` — мобилка как зеркало десктопа.
