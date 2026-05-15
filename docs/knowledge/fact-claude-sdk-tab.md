# Fact: Claude SDK Tab

Параллельный режим работы с Claude в отдельной вкладке через `@anthropic-ai/claude-agent-sdk` — без PTY, без TUI, поверх React/assistant-ui. Живёт рядом с обычными PTY-Claude табами, но это **другая система**: свой JSONL, свой lifecycle, свой набор инструментов.

## Tool-call rendering: семантика `result`

`assistant-ui` определяет, рендерить ли спиннер на tool-call'е, по полю `result`. **`result === undefined` → "running", любое определённое значение (включая пустую строку) → "done".** Это не баг рендерера — это семантика модели данных.

Ловушка: при первом написании `loadHistory` (парсинг JSONL через `getSessionMessages`) tool_use-блоки получали `result: undefined`, потому что наивный парсер не подтягивал tool_result. На UI все Bash/Read/Edit за всю историю горели оранжевым со спиннером, как будто всё ещё выполняются — хотя файл закрыт, процесс мёртв, ничего не идёт.

**Что было невидимо:** в Claude JSONL `tool_result` живёт **не в той же записи** где `tool_use`. Tool_use лежит внутри `type: 'assistant'`, а tool_result — в **отдельной записи** `type: 'user'` с `content: [{ type: 'tool_result', tool_use_id, content }]`. Это **та же ловушка**, что описана в `fact-backtrace-jsonl.md::Timeline backtrace` (типизация ответов tool как user-сообщений), но в SDK-стриме она проявляется ещё нагляднее, потому что нет PTY-слоя который её скрывает.

**Решение:** двухпроходный паринг. Pass 1 проходит по всем записям, собирает `Map<tool_use_id, {result, isError}>`. Pass 2 парсит tool_use-блоки и для каждого подтягивает result из map. Если результата нет — `result: ''` (пустая строка), статус `done` — потому что JSONL это past-tense, всё что в нём — завершено.

Streaming-путь имеет **ту же ловушку**, но динамическую. SDK выдаёт сообщения через async iterator; когда инструмент завершается, прилетает событие с `msg.type === 'user'` и tool_result-блоками в content. На этом моменте надо обновить статусы tool_call'ов **по всем accumulated assistant-сообщениям** (не только в текущем `streaming-<tabId>`-плейсхолдере), потому что `tool_use_id` мог быть выписан раньше в более раннем чанке.

## MCP-серверы: SDK не наследует `~/.claude.json`

Claude Code CLI автоматически читает `mcpServers` из `~/.claude.json`. **Agent SDK (`query()`) — нет.** По умолчанию `options.mcpServers` пустой, агент крутится без инструментов. Без явной пробрасывания это легко принять за фичу — «SDK работает», просто без browser/terminal/yougile.

**Решение:** один раз при первом вызове `sdkStartQuery` читаем `~/.claude.json`, кэшируем в module-level переменной (`_sdkMcpServersCache`), прокидываем во все последующие `query()` через `options.mcpServers`. Per-process cache — конфиг меняется редко, рестарт Electron'а перечитывает.

**Лайфсайкл MCP в SDK-табе:** каждая активная SDK-сессия спавнит **свой набор** stdio-MCP-серверов как дочерние процессы Electron main. При `session.query.close()` (закрытие таба, явный Stop) они умирают вместе с агентом. Это **те же серверы** что у Claude Code CLI/Desktop — параллельно может работать несколько инстансов, MCP-протокол это поддерживает.

**Browser-mcp как edge case:** browser-mcp многослойный — per-client `index.js` процесс + singleton `bridge.js` на порту 3458 + расширение Chrome. SDK спавнит свой `index.js`, он подключается к **тому же** bridge-у что и Claude Code CLI. Bridge маршрутизирует ответы по `commandId` per client socket — изоляция на уровне команд есть, состояние браузера общее (вкладки видны всем клиентам).

См. `methodology/design.md::Silent platform downgrade → toast` про то, как мы сигнализируем юзеру когда SDK что-то делает иначе, чем он ожидает.

## Effort gating + auto-downgrade

Anthropic API **не падает** при невалидной комбинации `(model, effort)`. Он **тихо понижает уровень**. Юзер выбрал `xhigh` на Sonnet 4.6 → API ответил на `high`, ошибки нет, в UI пилюля всё ещё на `xhigh`. Это самая опасная категория багов — нет detection-сигнала.

**Источник правды — `query.supportedModels()` из SDK**, не хардкод. Метод возвращает `ModelInfo[]` где каждая модель имеет `supportedEffortLevels: ('low'|'medium'|'high'|'xhigh'|'max')[]`. Получаем один раз при старте Electron main (`loadSdkModelCapabilities()` в `main.js`), кэшируем на process lifetime, отдаём в renderer через IPC `claude-sdk:get-model-caps`. **Хардкод-таблица была удалена** (раньше жила в `ClaudeSDKTab.tsx::isEffortSupportedForAlias`) — каждый Anthropic-release её устаревал, теперь обновление SDK автоматически приносит свежий manifest.

**Получение manifest'а — нюанс:** `supportedModels()` это **Query-instance метод**, не top-level export. Чтобы дёрнуть, нужна streaming-input query (control-request методы доступны только в этом режиме). Открываем минимальную query с never-yielding async iterable, вызываем `supportedModels()`, закрываем query — net cost ~200ms один раз за весь сеанс Electron'а.

**Реализация в UI (InfoPanel.tsx):**

- **Visual disabled на неподдерживаемых пилюлях.** `getSupportedEffortsForAlias(alias, caps)` возвращает `Set<string>` или `null` (null = «не знаем» = fall open). Пилюля рендерится с `opacity: 0.3, cursor: not-allowed, disabled={true}`, hover-title *«max не поддерживается моделью haiku»*. Клик заблокирован native HTML disabled.
- **Auto-downgrade при смене модели.** Юзер был на `(opus, max)`, переключил модель на `haiku` → текущий effort невалиден. UI **немедленно** даунгрейдит до ближайшего поддерживаемого (`max → xhigh → high → medium → low`, первый из supported wins), показывает короткий info-toast *«effort: max → high (haiku не поддерживает max)»*.

**Граница: alias `'default'` не gating'ится.** SDK сам выберет модель — мы не знаем какую. Все 5 пилюль остаются enabled. Если активный effort окажется несовместимым с реально выбранной моделью — поймает следующий слой.

**Runtime mismatch** (`detectModelFamilyMismatch`): safety net на случай server-side подмены. На первом `assistant`-чанке сравниваем `lastRequestRef.modelAlias` (что просили) с `msg.message.model` (что вернул API). Если family отличается (`opus` → `sonnet`) — toast `warning` *один раз на turn* (`modelMismatchToastedRef`).

**Что не покрыли:** активный effort после server-side silent downgrade. SDK 0.3 кладёт его в hook-контекст (`PreToolUse`/`PostToolUse`), мы хуки не регистрируем. С capability gating'ом этот gap менее критичен — невалидные пары теперь недостижимы из UI, остаётся только редкий случай server-side capacity overflow.

**Принцип** — см. `methodology/design.md::Несовместимость параметров — гасить в точке выбора, не в момент отправки`.

## Thinking как параметр SDK

`thinking: { type: 'adaptive' | 'enabled' | 'disabled' }`. У `enabled` есть optional `budgetTokens` (legacy).

**Что было невидимо:** на Opus 4.7 **manual `enabled` уже не поддерживается** — только `adaptive` или `disabled`. Это написано мелким шрифтом в Anthropic docs. На Opus 4.6 ещё работает, но deprecated. Для нашего use-case это значит: думать на новых моделях можно только через `adaptive` (sdk сам разруливает по effort) или вообще выключить.

UI-пилюля Think маппится так: `tab.sdkThinking === false` → `{type: 'disabled'}`, иначе `{type: 'adaptive'}`. Manual budget не используем — он только запутает (юзер выбрал `effort: high` + manual budget 5K, агент берёт adaptive по effort'у, budget игнорируется).

Раньше Think была **UI-only** — пилюля переключала `tab.sdkThinking`, но `main.js::sdkStartQuery` не передавал параметр в `query()`. Багу можно было поймать только сравнением behavior двух сессий — нет error, нет визуального сигнала. Поправили — теперь `main.js` всегда пишет `thinking: { type: thinkingMode }`, логирует значение в `[ClaudeSDK]`.

## Single source of truth для model aliases

`SDK_MODEL_MAP` в `ClaudeSDKTab.tsx` маппит UI-алиасы (`opus`, `sonnet`, `haiku`, `default`) на актуальные Anthropic model IDs. **Не дублируется** — два места которые читали маппинг (`onNew` и `truncateAndResend`) теперь оба идут через `resolveSdkModel()`. См. `methodology/design.md::Single source of truth для third-party shipping values` — здесь то же правило что для `claudeLevels.ts`, только специфично к SDK-табу.

**Ловушка:** при следующем Anthropic-апдейте (например выйдет Opus 4.8) ровно одна правка — добавить новый id в `SDK_MODEL_MAP`. Если забыть — старая модель тихо `404`-ится в API, ошибка приходит как `result.is_error`, юзер видит красный toast «Claude SDK: model not found». На UI пилюля показывает `opus` как активную — это правда (юзер выбрал), но id мёртв.

## Сворачивание длинных user-сообщений

`CollapsibleText` в `ClaudeSDKTab.tsx`: text > 600 символов рендерится как preview (первые 400 + `…`) + кнопка `Раскрыть полностью (N символов) / Свернуть`. Применяется только к plain-text части user-сообщения; `<pasted_content>`-чипы оставлены как есть (у них своя свёртка).

**Мотивация:** SDK не имеет input length limit'а — юзер может вставить 30K символов одним сообщением. Без свёртки тред становится непроходимым: один user-message занимает три экрана, ответы Claude задавлены вниз. Порог 600/400 эмпирический — ниже 600 текст ещё читается inline, выше 600 нужна свёртка чтобы тред листался.

**Toggle сверху и снизу в expanded state.** В collapsed — toggle только снизу (естественное продолжение preview). В expanded — toggle дублируется и **сверху** (`mb-1` под верхом блока), и снизу. Оба `<button>` оборачиваются одним `<div ref={anchorRef}>` чтобы `useStableCollapseToggle` мог сделать viewport-restore. Без top-toggle юзер на 800-3000 символов вынужден скроллить через весь bubble чтобы свернуть — превращает «свернуть» в «забить и проскроллить мимо». См. `methodology/design.md::Toggle для expanded long content`.

## Tool-call rendering: специализированные карточки + LCS-diff

После общего перехода с inline-пилюль на карточный layout (см. `methodology/design.md::Tool call = карточка, не сообщение`), `ToolCallPart` стал **диспетчером по `toolName`** на 4 подкомпонента: `BashCard`, `ReadCard`, `EditCard`, `GenericToolCard` (fallback). Общая шапка живёт в `ToolCard` каркасе, специализация — только в body.

**Read preview через extension → Prism language map.** Файл `package.json` подсветится как JSON, `*.ts/.tsx` как TypeScript/TSX, `*.py` как Python и т.д. Карта `EXT_LANG` короткая (~25 расширений) — больше и не надо: oneDark из react-syntax-highlighter качественно стилизует только эти языки, остальные fall back на `text` без визуального проигрыша. **Контент рендерится целиком** в SyntaxHighlighter с `maxHeight: '480px', overflow: 'auto'` — никакого preview-N-lines + expand toggle. Раньше был preview 8 строк + `FullContentToggle` который раскрывал полный контент в **втором** code-блоке — оба паттерна делали то же что встроенный scroll: показывали что ниже. Удалили as redundant (см. `methodology/design.md::collapse только когда scroll невозможен`).

**Edit diff — собственная LCS реализация (не lib).** Anthropic Edit-tool отдаёт `args.old_string` и `args.new_string`. Установка `diff`/`fast-diff` npm-пакета не оправдана (Bundle + edge cases) — простой DP по LCS на ~50 строк делает то же самое. `lineDiff(old, new)` возвращает `Array<{tag: 'eq'|'add'|'del', line}>`, renderer проходит по entries и рисует `+/-` sign-gutter + цветной bg. **Для Write** — `args.content.split('\n')` целиком как adds (вся файла новая). **Для MultiEdit** — батч hunks через `─`-разделитель. `defaultOpen={true}` для всех diff-карточек: суть вызова — в diff'е, скрывать его за chevron'ом контрпродуктивно. **Diff также без expand-toggle**: контейнер `max-h: 480px overflow-y: auto`, длинные diff'ы скроллятся внутри. Removed `DIFF_COLLAPSED_LINES = 24` + кнопка `Раскрыть полностью` — те же причины что в Read.

**StatusDot вместо trailing-spinner.** До: spinner после имени tool'а (running) или ничего (done). После: dot слева — зелёный (done), красный (error), вращающийся Loader2 (running). Один визуальный slot вместо двух — глаз быстрее парсит статус всего треда «сколько идёт / сколько готово».

**`mr-[60px]` на root ToolCard и ReasoningPart.** Карточки уже окружающей prose ассистента на 60px справа. Это даёт scroll-зону для мыши (правый край — гарантированно main thread scroll, не внутренности карточки) и визуальное разделение «речь vs действие». Принцип — `methodology/design.md::Action-карточки уже prose`.

См. `methodology/design.md::Tool call = карточка, не сообщение` для принципа. Конкретные пороги превью/diff (8 / 24 / 10 строк) — см. `methodology/design.md::Generalisation: тот же приоритет для любого user-generated long content`.

## Smart Cancel: сохранение vs откат по содержимому streaming

Cancel-кнопка в composer'е работает в одном из двух режимов, выбор по факту наличия частичного результата (принцип — `methodology/design.md::Smart cancel`).

**Pipeline:**
1. На вход — snapshot `messages` в момент клика. Ищем последний `streaming-<tabId>` placeholder + ближайший user-message перед ним.
2. `hasContent = streaming.text.trim() || streaming.thinking?.trim() || streaming.toolCalls.length`. Три байта проверок.
3. Контент есть → переименовать `streaming-<tabId>` в стабильный `msg-<ts>`, оставшиеся `running` tools пометить `done` (safety net). Composer остаётся пустой.
4. Контента нет → удалить локально оба сообщения (`prev.slice(0, cutoff)`), отправить `claude-sdk:composer-insert {tabId, text, replace: true}` чтобы вернуть user-text в input. Если user-message уже залегло в JSONL (persisted id) — позвать `claude-sdk:truncate-history` для отката записи. `composer-insert {replace: true}` это новый shape — отличается от default-append'а (как Insert-Prompt из ПКМ): default дописывает к существующему тексту, replace перезаписывает целиком.

**Edge case: tool_result прилетел после cancel.** Если cancel вызван в момент когда assistant уже отправил tool_use но tool_result ещё в полёте — он прилетит после нашего setState. Без обработки tool_call останется в `running` навсегда. Решение в pass 3: `m.toolCalls.map(t => t.status === 'running' ? {...t, status: 'done'} : t)` для **всех assistant-сообщений**, не только `streaming-<tabId>`. Это финализирует любой висящий running, даже из более раннего чанка.

## SDK 0.3.x миграция: query() вместо unstable_v2_*, обязательный allowDangerouslySkipPermissions

`@anthropic-ai/claude-agent-sdk` bumped 0.2.59 → 0.3.142. **Два breaking-change'а** ломают наш код:

1. **`unstable_v2_createSession` / `unstable_v2_resumeSession` удалены.** Раньше использовались в `src/main/claude-agent.js::_doSend` — отдельный manager для параллельного non-SDK-tab pipeline (через `mcp:agent-adopted` flow). Миграция: `sdk.query({ prompt, options: { resume: sessionId } })` для resume, без `resume` для new. `tab.session` теперь хранит `Query` instance (есть `.close()`), не custom session-объект. `session.send()` + `session.stream()` слиты в один async iterator из `query()`.

2. **`allowDangerouslySkipPermissions: true` обязателен** при `permissionMode: 'bypassPermissions'`. SDK 0.3 закрывает «случайное» bypass через double-confirm: если просишь bypass — должен явно подтвердить флагом. CLI отказывается стартовать без него. Не косметика — runtime error при handshake. Добавлен в обе точки query() в `main.js` (sdkStartQuery + supportedModels-probe) и в `claude-agent.js` (как defensive — на случай если permissionMode там станет bypass позже).

**Что не сломалось:** `getSessionMessages()` (используется в `loadHistory`) совместим без изменений. `query.supportedModels()` тоже на месте.

**Что появилось нового, но мы пока не используем:**
- `forkSession()` / `renameSession()` / `tagSession()` / `deleteSession()` / `listSessions()` — полноценный session-management API. Сейчас мы парсим JSONL вручную. Кандидат на следующую сессию.
- `getSubagentMessages()` / `listSubagents()` — стримы sub-агентов.
- `resolveSettings()` — read merged settings без spawn'а CLI.
- `InMemorySessionStore` + `importSessionToStore()` — in-memory сессии для transient flow.
- `TodoWrite` tool переименован в `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`. У нас в src/ упоминаний нет — fine.

## Композитор прижат снизу через flex-1 messages, без sticky overlay

Composer (`SDKComposer`) — child `ThreadPrimitive.Viewport`, последний flex-элемент. Перед ним messages-div с `flex-1`. При коротком чате `flex-1` растягивает messages → composer прижат к низу. При длинном — composer едет вверх вместе с scroll'ом, **не остаётся overlay'ем над контентом** (принцип — `methodology/design.md::Composer внутри scroll-flow`).

**Graveyard:**
1. **`sticky bottom-0 border-t shrink-0`** — выглядело правильно, но при scroll up composer оставался прибит к низу окна, **накрывая diff/контент** в верхней части. Юзер не мог прочитать раскрытое содержимое — оно пряталось под input. Удалили `sticky`.
2. **Вытащить composer наружу `ThreadPrimitive.Viewport`** (`<Viewport>{messages}</Viewport><div>{composer}</div>` в Root) — провалилось runtime'ом: `ComposerPrimitive.Input` читает Thread-контекст через React.Context, hoisting за пределы Viewport → `must be used within ThreadPrimitive.Viewport`. Это **structural constraint** assistant-ui, не наш выбор. Не повторять.

## Footer pill: `[Model] N% context` — захват usage + window-table

Под composer'ом — две части: слева `[Opus 4.7 (1M context)] N%`, справа `Session: xxx…` (dim grey). Видно когда есть хоть что-то одно.

**Источник model'а — две стратегии:**
1. **`lastResolvedModel`** — real model id из `msg.message.model` (SSE chunk). Captured в `handleMessage` при `msg.type === 'assistant'`. Это truth от Anthropic — может отличаться от UI-alias если был silent downgrade.
2. **`sdkModelAlias`** fallback — `tab.sdkModel || 'default'` через `resolveSdkModel()`. Используется когда ещё не было ни одного assistant-чанка (новый таб без turn'ов).

Helper `formatModelLabel(realModel, alias)` → `"Opus 4.7 (1M context)"` / `"Sonnet 4.5"`. Family + version из regex по id (`-4-7` / `-4.5`). `(1M context)` суффикс только для Opus 4.7.

**Источник context %:**
- `lastContextUsedTokens` — захватываем `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (полный context, не только uncached). Из той же `msg.message.usage` где трэкается mismatch model'а.
- `getModelContextWindow(realModel, alias)` — таблица: Opus 4.7 = 1M, Sonnet/Haiku/прочие Opus = 200K. Anthropic не shipping'ит это в SDK, hardcode по доке.
- `% remaining = 100 - (used / window) * 100`. Clamp [0, 100].

**Цветовое gating:**
- `>= 25%` — серый `#7a7a7a` (нейтрально).
- `< 25%` — янтарный `#f59e0b` (внимание).
- `< 10%` — красный `#ef4444` (срочно).

Только цвет процента, не всего pill'а — model-label остаётся читаемым `#bdbdbd`. Параллельно с pill `Cost` или `Tokens used` не показываем — оставшийся context — главный actionable сигнал для юзера («когда ждать compact'а»).

## Font-size root + em-потомки

SDK-таб root получает `style={{ fontSize: ${useUIStore.terminalFontSize}px }}`. Все `text-[Npx]` в дереве переведены на `text-[Nem]` (base 13): 9px→0.7em, 10px→0.77em, 11px→0.85em, 12px→0.92em, 13px→1em, 14px→1.08em. SyntaxHighlighter `customStyle.fontSize` тоже em ('0.92em'). Cmd+/− в Terminal-настройке теперь меняет шрифт **во всём** SDK-табе пропорционально.

Подробности — `methodology/design.md::UI-тематический font-size наследуется от пользовательской настройки`.

## `useStableCollapseToggle`: flushSync + wasAtBottom + findScrollParent

Хук стабилизирует scroll при раскрытии collapsed-блока **выше текущего viewport'а**. Реализация и принцип — `methodology/design.md::flushSync + sync layout-read`.

**Что было невидимо:**
1. **Почему не `useLayoutEffect`:** хук generic, не имеет своего state — owner-компонент держит `[open, setOpen]`, мы получаем только callback. layout-effect нельзя повесить на «когда callback изменит state у консьюмера» — мы не знаем когда это случится. flushSync даёт ту же sync-commit гарантию изнутри click-handler'а.
2. **`findScrollParent`** ищет ближайшего предка с `overflow-y: auto|scroll` И `scrollHeight > clientHeight`. Второй чек важен: если предок имеет `overflow-y: auto` но контент **помещается**, у него нет scroll'а и компенсация не нужна (пропускаем).
3. **`wasAtBottom` rule** — 4px tolerance. Меньше — флапает на pixel-rounding (anti-aliased scroll). Больше — выходит из «у самого низа» включая случаи когда user реально читает 1-2 строки выше дна и не хочет автоскролл.

Применён к 5 toggle-точкам: `ToolCard` (chevron в шапке), `ReasoningPart` (thinking), `FullContentToggle` (Read full content), `DiffLines` expand (diff > 24 строк), `CollapsibleText` (user-prompt > 600 символов).

## Ctrl+[ как alias Escape

Стандартная Claude Code TUI muscle memory — Ctrl+[ эмулирует Escape (терминалы посылают `\x1b` для обоих). Обработчик внутри `isRunning && isVisible` useEffect (handler не должен fire'иться когда турн уже идёт у другого таба или скрыт за Dashboard'ом). Detection: `e.ctrlKey && !e.metaKey && !e.altKey && e.key === '['` || `e.key === 'Escape'`. `preventDefault()` обязательно — иначе Cmd-палитра может перехватить.

## Code map (неочевидные связи)

- `~/.claude.json::mcpServers` → `main.js::loadGlobalMcpServers` → `options.mcpServers` в `query()`. Конфиг читается лениво, кэшируется на life process Electron main.
- `tab.sdkModel` (UI alias) → `resolveSdkModel()` → `options.model` в SDK. `tab.sdkEffort` → `options.effort` напрямую. `tab.sdkThinking` (bool) → `{type: 'adaptive'|'disabled'}`.
- `lastRequestRef` (renderer ref) — что отправили. `msg.message.model` (SSE) — что ответили. Сравнение → toast на mismatch.
- В JSONL SDK-сессии `tool_result` живёт в `type: 'user'` записях с `tool_use_id` ссылкой. Это **необходимый bridge** для UI чтобы знать что tool завершился — single-pass parser его пропустит.
- `useUIStore.terminalFontSize` → root `<div style={{ fontSize: px }}>` SDK-таба → em-потомки. Cmd+/− триггерит rescale всего дерева через CSS-каскад (нет React-state ниже root).
- Cancel flow: `onCancel` → snapshot messages → если контент `streaming-<tabId>` → rename + done. Если нет → `setMessages(slice)` → `composer-insert {replace:true}` event → SDKComposer's effect → `writeComposerValue` (DOM-setter + native input event для assistant-ui re-sync) → JSONL `claude-sdk:truncate-history` если persisted id. **Никогда не теряем user-input при cancel.**

## External clients (mobile-web)

SDK-таб может управляться не только локальным renderer'ом, но и удалённым клиентом через `web-server.js` (port 7878, см. [`fact-mobile-web.md`](fact-mobile-web.md)). Два специальных hook'а в `sdkStartQuery` для синхронизации обоих UI:

**Synthetic user broadcast.** `_webBroadcast(tabId, { type:'message', message:{type:'user', __webSynthetic:true, ...}})` шлётся **сразу** при старте query. Реальная user-запись в JSONL появится позже (когда SDK дойдёт до неё в потоке) — phone не должен ждать. Десктопный renderer этот broadcast не видит (не подписан на WS), его user-bubble идёт через локальный `onNew` композера.

**External-prompt event для desktop.** Когда mobile отправляет prompt через REST → renderer-bridge `sendSDKMessage` action **перед** `claude-sdk:send-message` invoke диспатчит `window.dispatchEvent('claude-sdk:external-prompt', { tabId, text })`. ClaudeSDKTab слушает event и пушит свой user-bubble в локальный `setMessages`. Без этого десктоп показывал ответ Claude но не сам запрос — `onNew` срабатывает только когда **локальный** композер submit'ит.

**History loader для external клиентов — не `getSessionMessages`.** Anthropic SDK helper отдаёт другой набор uuid'ов чем `parseTimelineEntries`, GoTo из mobile timeline никогда не находит anchor. Mobile грузит history через отдельный IPC `claude-sdk:active-branch-messages` (тот же backtrace что в `parseTimelineEntries`, но возвращает все типы записей). См. [`fix-mobile-history-uuid-mismatch.md`](fix-mobile-history-uuid-mismatch.md).
