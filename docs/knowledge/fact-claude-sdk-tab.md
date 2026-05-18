# Fact: Claude SDK Tab

Параллельный режим работы с Claude в отдельной вкладке через `@anthropic-ai/claude-agent-sdk` — без PTY, без TUI, поверх React/assistant-ui. Живёт рядом с обычными PTY-Claude табами, но это **другая система**: свой JSONL, свой lifecycle, свой набор инструментов.

## Tool-call rendering: семантика `result`

`assistant-ui` определяет, рендерить ли спиннер на tool-call'е, по полю `result`. **`result === undefined` → "running", любое определённое значение (включая пустую строку) → "done".** Это не баг рендерера — это семантика модели данных.

Ловушка: при первом написании `loadHistory` (парсинг JSONL через `getSessionMessages`) tool_use-блоки получали `result: undefined`, потому что наивный парсер не подтягивал tool_result. На UI все Bash/Read/Edit за всю историю горели оранжевым со спиннером, как будто всё ещё выполняются — хотя файл закрыт, процесс мёртв, ничего не идёт.

**Что было невидимо:** в Claude JSONL `tool_result` живёт **не в той же записи** где `tool_use`. Tool_use лежит внутри `type: 'assistant'`, а tool_result — в **отдельной записи** `type: 'user'` с `content: [{ type: 'tool_result', tool_use_id, content }]`. Это **та же ловушка**, что описана в `fact-backtrace-jsonl.md::Timeline backtrace` (типизация ответов tool как user-сообщений), но в SDK-стриме она проявляется ещё нагляднее, потому что нет PTY-слоя который её скрывает.

**Решение:** двухпроходный паринг. Pass 1 проходит по всем записям, собирает `Map<tool_use_id, {result, isError}>`. Pass 2 парсит tool_use-блоки и для каждого подтягивает result из map. Если результата нет — `result: ''` (пустая строка), статус `done` — потому что JSONL это past-tense, всё что в нём — завершено.

Streaming-путь имеет **ту же ловушку**, но динамическую. SDK выдаёт сообщения через async iterator; когда инструмент завершается, прилетает событие с `msg.type === 'user'` и tool_result-блоками в content. На этом моменте надо обновить статусы tool_call'ов **по всем accumulated assistant-сообщениям** (не только в текущем `streaming-<tabId>`-плейсхолдере), потому что `tool_use_id` мог быть выписан раньше в более раннем чанке.

## Tool-call rendering: ordered `parts[]` для сохранения порядка блоков

Claude JSONL пишет один turn assistant'а как **N отдельных записей**, каждая содержит **один** content-блок (`{type:'thinking'}` ИЛИ `{type:'tool_use'}` ИЛИ `{type:'text'}`). Реальная последовательность в одном turn'е — `thinking → tool → tool → thinking → tool → text`, не сгруппирована по типу. Стриминг-чанки тоже могут содержать любую смесь блоков в произвольном порядке.

**Что было невидимо.** Первая версия парсера на каждой assistant-записи делала три параллельных filter'а — `text`-блоки в `text: string`, `tool_use`-блоки в `toolCalls: []`, `thinking`-блоки в `thinking: string | null`. Информация о порядке между ними **умирала прямо в filter'ах**. `convertMessage` потом всегда выкладывал три стопки в фиксированном порядке `thinking → text → tools` — поэтому все вызовы инструментов сваливались в конец сообщения, разорванный «think → call → reflect → call → reply» ритм Claude'а превращался в стену текста + хвост из карточек тулзов.

**Решение.** `SDKChatMessage.parts: AssistantPart[]` — ordered source of truth для рендера ассистента. Каждый блок (`{type:'thinking'|'text'} | ToolCallPart`) пушится в `parts[]` в том порядке, в котором встретился в JSONL/чанке. `convertMessage` итерирует `parts[]` напрямую и эмитит assistant-ui blocks в той же последовательности. Старые поля `text/thinking/toolCalls` **остались** как derived через helper `assembleMessageFields(parts)` — search snippets, smart cancel `hasContent` check, filter empty assistant, findIndex для timeline scroll-to-entry, всё это читает плоские поля и не должно знать о parts. Все 4 точки которые мутируют сообщение (loadHistory pass-2, streaming reducer assistant-чанк, tool_result reducer, finalize-result safety net + cancel-hasContent branch) обновляют `parts[]` и пересобирают плоские поля одним вызовом.

**Где такой же шаблон не повторился.** Mobile-web parser (`mobile-web/src/messages.ts`) обрабатывает `for (const block of content)` в одном проходе и push'ит entries в `state.entries` в encounter-order — каждый блок становится отдельной UI-entry, порядок сохраняется естественно. **Латентный риск** в `src/main/ipc/claude-data.js:2638-2647` (sub-agent Task history dump для Sessions/Timeline превью): тот же split-by-type `mc.filter(text)` + `mc.filter(tool_use)`. Сейчас это превью-формат (читается человеком в read-only панели), не баг. При попытке отрендерить sub-agent history как полноценный чат — переделать на ordered parts. Принцип — `methodology/design.md::Ordered model output → ordered UI`.

## History prefetch в `restoreSession`

При cold start `useWorkspaceStore.restoreSession` восстанавливает N SDK-табов из персистенции. Каждый `ClaudeSDKTab` вызывает `loadHistory` в `useEffect` после того как `storeSessionId` резолвится из store — но `RestoreLoader` снимается **раньше** чем эти IPC-запросы возвращаются. Юзер видит «Restoring sessions» → blank chat-shell → через 200-500мс прилетает контент. Эффективно две фазы загрузки подряд: первая видимая, вторая невидимая. Принцип — `methodology/design.md::Глобальный startup-loader охватывает готовность контента`.

**Решение.** Module-level Map cache `_prefetchCache: Map<"tabId::sessionId", any[]>` в `src/renderer/utils/sdkHistoryPrefetch.ts`. Внутри `restoreSession` пока `isRestoring=true`, для каждого восстановленного SDK-таба параллельным `Promise.all` запускается `claude-sdk:active-branch-messages` IPC, результат складывается в cache через `setPrefetched(tabId, sessionId, messages)`. Только после `await Promise.all` снимается `isRestoring=false`. `loadHistory` в табе на mount первым делом проверяет cache через `consumePrefetched(tabId, sessionId)` — если хит, синхронно использует rawMessages без IPC, если мисс, идёт по живому пути.

**Single-shot semantics — критично.** `consumePrefetched` **удаляет** значение из Map при чтении. Это значит reload-чип в InfoPanel, fork operation, session-id rotation после `/compact` — все они идут по живому IPC, потому что cache уже опустошён первым `loadHistory`. Без self-delete'а второй `loadHistory` после rotation вернул бы stale messages для нового session-id, потому что ключ-то старый.

**Lazy data в pre-fetch не закидывать.** Timeline entries, search index, file-tree — это контент, который рендерится отложенно, юзер не видит его на первом кадре. Если включить их в `Promise.all` — startup-loader будет висеть лишние 1-2 секунды для данных, которые всё равно не блокируют первый кадр активного контекста.

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

**History loader для external клиентов — не `getSessionMessages`.** Anthropic SDK helper отдаёт другой набор uuid'ов чем `parseTimelineEntries`, GoTo из mobile timeline никогда не находит anchor. Mobile **И desktop** грузят history через отдельный IPC `claude-sdk:active-branch-messages` (тот же backtrace что в `parseTimelineEntries`, но возвращает все типы записей). См. [`fix-mobile-history-uuid-mismatch.md`](fix-mobile-history-uuid-mismatch.md). Desktop переключился с `getSessionMessages` после того как тот стал возвращать `success:true rawCount:0` для свежеротированных сессий — наш JSONL-parser работает напрямую с диском.

## Resume contract (sessionId rotation handling)

Claude SDK ротирует sessionId на каждом session-loss / fresh-start (отказ resume, `/compact`, JSONL aging). Ловушки которые вылезли в bug-марафоне 2026-05-15 (см. [`fix-sdk-session-amnesia.md`](fix-sdk-session-amnesia.md)):

- **caller передаёт `resumeSessionId` явно**, не полагаясь на in-memory `sdkSessions` Map (она очищается в `finally` каждого turn'а — между turn'ами Map пустой). Renderer кладёт `tab.claudeSessionId` в payload `claude-sdk:send-message`. Mobile bridge handler берёт `tab.claudeSessionId` из Zustand store.
- **`sessionIdRef.current` всегда обновляется** при `data.sessionId !== sessionIdRef.current` — guard `if (!ref)` фиксировал первый и игнорировал rotation, store оставался со stale uuid → каждый prompt resume'ился на мёртвый id.
- **Pre-flight `isResumableSession`** через `findSessionFile(sessionUuid, cwd)` — НЕ hand-rolled slug. Hand-rolled `'-' + cwd.replace(/\//g, '-')` давал двойной leading dash для абсолютных путей (`--Users-fedor-...`), `existsSync` всегда false → каждая resume помечалась stale.
- **Runtime fallback на `No conversation found`**: если SDK всё равно вернул error в iterator (race condition / SDK не знает наш freshly-rotated id), mid-stream detection → silent retry без resume + send `claude-sdk:stale-resume-cleared` event в renderer чтобы tab чистил `claudeSessionId`. Юзер видит обычный ответ от свежей сессии, без error toast.

См. `methodology/design.md::In-memory ephemeral state ≠ persistent identifier source` для общего принципа.

## Context indicator (used %, не remaining)

Header pill и mobile composer показывают **% использования** контекстного окна (filled-bar semantic), не % остатка. Цвета: серый 0-75% / амбер 75-90% / красный 90-100%. Раньше формула была `100 - usedPct` — юзер читал `92%` как «92% полно» хотя это было «92% свободно». См. `methodology/design.md::Прогресс = заполнение, не остаток`.

Для `tabType !== 'claude-sdk'` (terminal табы) индикатор скрыт — формула не имеет смысла для PTY-Claude (нет SDK usage events).

## Initial scroll

`didInitialScrollRef = useRef<string | null>(null)` хранит **sessionId** для которого scroll-to-bottom уже сделан. Один раз на смену сессии (включая после `/rewind` / fork когда меняется uuid), не на focus tab. Без этого юзер при возврате в чат каждый раз скакал в начало истории. См. `methodology/design-mobile.md::Initial scroll = once-per-context`.

## Composer button slot (Send / Stop)

Send (`↑`) и Stop (`■`) жили в **одном** `<button>` slot composer'а, переключались по `busy`. Раньше Stop сидел в header справа от burger'а — два muscle path'а для одного действия. См. `methodology/design.md::Send / Stop = одна muscle path`.

**Обновление май 2026: Send-кнопка удалена целиком.** Composer теперь чистый textarea без кнопки. Enter = submit, Escape/Ctrl+C/Ctrl+[ = cancel. Юзер: «убери кнопку отправки, у нас за остановку будут отвечать клавиши». Это завершение муscle-path стянутого до клавиатуры — для PTY-Claude муscle-path тот же, для SDK теперь identical.

## JSONL shape для compact: camelCase + флаги

Anthropic SDK пишет JSONL поля compactim'а в **camelCase**, а stream-events в SDK iterator — в **snake_case**. Обе формы поддерживаем (`compactMetadata` ?? `compact_metadata`, `preTokens` ?? `pre_tokens`). Authoritative маркер compact-summary записи — флаг **`isCompactSummary: true`**, не `isReplay`/`isSynthetic` (тех на summary НЕ выставляются). Fallback на canonical phrase `"This session is being continued from a previous conversation"` — для старых сессий или edge-cases. Запись также носит `isVisibleInTranscriptOnly: true` — служебный флаг что эту запись CLI отображает в transcript, мы аналогично рендерим (но как orange divider, а не user-bubble).

Записи `<local-command-stdout>Compacted </local-command-stdout>` — это CLI-артефакт завершения `/compact`-команды (CLI пишет `chalk.dim('Compacted ' + summary)` в stdout). В SDK chat не нужен — дропаем целиком. Аналогично `<local-command-caveat>` (служебная обёртка для replay-context).

Что было невидимо: я неделю искал `isReplay`/`isSynthetic` на summary-записях — их там НЕТ. SDK 0.3 поменял shape: только `isCompactSummary` + `isVisibleInTranscriptOnly`. Без вычитки сырого JSONL это невозможно определить — types в `sdk.d.ts` шипят generic `SDKMessage` без полного field-listing'а.

## Compact summary: ride-on-assistant role + id-prefix discrimination

assistant-ui runtime не позволяет добавлять custom `role` — допустимы только `user/assistant/system/data`. Мы храним записи как `SDKChatMessage.role: 'compact-summary'`, в `convertMessage()` маппим в `role: 'assistant'` **+ id-prefix `compact-summary-`**. `AssistantMsg` проверяет prefix первой строкой — если match, делегирует в `CompactSummaryMsg` (orange-bordered bubble с метриками `pre→post tokens · Ns`, collapsible toggle сверху+снизу при >600 char'ов, padding и border в brand-orange tinted).

Метрики не сериализуются через `ThreadMessageLike` (поля кастомные не пропускаются) — храним в module-level `_compactMetricsByMsgId Map<string, Metrics>`, заполняем при `convertMessage`, читаем в `CompactSummaryMsg` через `getCompactMetricsForMsg(id)`. Это **edge-case ID-маркера** — id служит и идентификатором, и discriminator'ом типа. См. `methodology/design.md::Type variant = visual marker, не rename` — здесь та же логика: тип передаётся через id-prefix потому что contract'а custom-role нет.

## Compact summary order swap в loadHistory post-pass

JSONL пишет `compact_boundary` → `isCompactSummary` user-record **раньше** `<command-name>/compact</command-name>` chip-записи. То есть для юзера это «summary появилась, потом юзер ввёл /compact» — наоборот хронологии его действий. Post-pass в `loadHistory` свапает соседние `compact-summary` + `user`-text-`/compact` → chip всегда выше summary. Без этого UX-чтение неправильное: «откуда summary, я ещё не давал команду».

## Compact loader: fake-progress (SDK не отдаёт прогресс через API)

CLI Ink-renderer рисует «5%  ▰▰▱▱▱  Next: H. Documentation» — это **только в Ink**. Agent SDK 0.3 в iterator emit'ит ровно три маркера: `{type:'system', subtype:'status', status:'compacting'}` (start) → 30-60s тишины → `{...status:null, compact_result:'success'}` (end) → `{type:'system', subtype:'compact_boundary', compactMetadata:{...}}` (summary metrics). Никаких процентов / per-step событий. `onCompactProgress` callback из `compact.ts` работает только внутри `ToolUseContext` CLI'а, в SDK не пробрасывается.

Решение: indeterminate progress bar (CSS keyframes `sdk-compact-bar`, gradient slide 1.8s loop) + live elapsed timer. Не врём конкретными процентами. Принцип — `methodology/design.md::Fake progress > врать конкретными цифрами когда API не отдаёт`.

## Slash autocomplete popup

Манифест команд получаем **двумя путями**, merge с приоритетом live:

1. **Live** — из `system:init` сообщения активной сессии (поле `slash_commands`, нормализуем shape). Это AUTHORITATIVE для **этой** сессии: включает `/status`, локальные skills (`/check`, `/loop`), session-specific команды которые зависят от модели/аккаунта.
2. **Probe-fallback** — `claude-sdk:probe-commands` IPC через throw-away `query()`. Используется пока нет активной сессии (новый таб). Throw-away query спавнится с `async function*() { await new Promise(() => {}); }` — без never-resolving promise SDK мгновенно tear down'ит ProcessTransport и `getContextUsage()` / `mcpServerStatus()` падают с «Query closed before response».

Live перезаписывает probe по имени, probe-only добавляет недостающие → юзер всегда видит максимально полный список.

**Filter**: ranked startsWith > includes по name И aliases. Юзер вводит `/us` → сначала `/usage`, потом `/extra-usage` (раньше plain `includes` смешивал, `/extra-usage` оказывался первым).

**Popup geometry**: `absolute bottom-full mb-1 z-30` НАД composer'ом — не двигает thread, перекрывает items внутри Virtuoso. Композер остаётся на месте. Принцип — `methodology/design.md::Popup поверх контента — absolute`.

**Keydown через refs**: `slashIdxRef` / `filteredCommandsRef` / `showSlashPopupRef` обновляются на каждый render. `handleComposerKeyDown` мемоизирован на `[composerText, writeComposerValue, isRunning, ...]` — без refs ArrowDown/Enter ловят **stale** значения slashIdx/filteredCommands (handler не пересоздаётся на каждый keystroke потому что иначе теряется focus). `e.stopPropagation()` обязателен — assistant-ui ловит Enter глобально и сабмитит.

**Commit = submit, не insert**. Click/Enter в popup → `composerRuntime.send()` сразу (если не isRunning). Раньше различал required (`<>`) vs optional (`[]`) args и блокировал submit для команд с argumentHint — но у Claude SDK почти все hint'ы в `<...>` даже для optional args (`/compact <optional summary>`, `/clear [name]`). Юзер: «если выбрал стрелочками — Enter сразу запускает». Если хочет добавить args — печатает их вместо выбора из popup'а (пробел закрывает popup, далее обычный ввод). Принцип — `methodology/design.md::Selected autocomplete item: Enter = submit`.

**MouseDown preventDefault**: на root popup'а — иначе клик мышкой теряет фокус textarea (blur срабатывает перед click handler'ом).

## Slash command renders as user-chip, не диалоговая реплика

JSONL пишет `<command-name>/compact</command-name>\n<command-args>…</command-args>` как `type:'user'` record. Парсер детектит обёртку, strip'ит leading slashes (CLI sometimes пишет `<command-name>/usage</command-name>`, sometimes `<command-name>usage</command-name>`), реконструирует `text = '/' + name + (args ? ' ' + args : '')`. Role остаётся `'user'`.

В `UserMsg` детект `^/\w[\w-]*(?:\s|$)` без newlines → рендер как фиолетово-синий chip справа (фон `rgba(129,140,248,0.08)`, color `#a5b4fc`, border `rgba(129,140,248,0.25)`). Без edit/repeat hover-кнопок — повтор slash-команды проще через композер.

Раньше chip имел chevron `>` слева. Удалён — chevron в UI означает «раскроется» (см. ReasoningPart, ToolCard), а slash-chip нечего раскрывать. Принцип — `methodology/design.md::Chevron = expand-affordance, не декор`. Также `methodology/design.md::Slash invocation = action-chip` про сам факт визуального отделения служебного от диалогового.

## SlashCommandOverlay для /usage /cost /stats /status /context /insights

Эти команды в CLI открывают полноэкранный Settings panel (LocalJSXCommandCall с `<Settings defaultTab="Usage" />`). React-дерево живёт **только в Ink runtime CLI**, до SDK iterator'а доходит **только текстовый fallback** через `SDKLocalCommandOutputMessage { type:'system', subtype:'local_command_output', content: string }`. Для /usage это `"You are currently using your subscription to power your Claude Code usage"` — больше ничего.

Решение: при отправке info-команды из whitelist (`INFO_SLASH_CMDS`) ставим `activeSlashCmdRef = name` + открываем `SlashCommandOverlay` (500px панель **заменяет** композер). Следующий assistant-message с text-only blocks захватывается в `slashOutput` через ref-guard и **не** падает в thread. На `result` event ref сбрасывается; overlay остаётся открытым пока юзер не закроет (`Escape` / `Ctrl+C` / `Ctrl+[`). В thread остаётся только chip `/usage` как маркер «команда выполнена».

Дополнительно overlay показывает **локальный breakdown** для `/usage /cost /stats`: total cost USD, duration, num turns — кумулятивный трекер по `result.total_cost_usd / duration_ms / num_turns` всех turn'ов сессии. SDK эти значения шипит per-turn, мы суммируем в `cumCostRef`. CLI делает то же самое внутри своего `formatTotalCost()`. Это **70-80%** того что показывает CLI Settings panel; subscription/limits info (`Resets May 20 4am`) не доступны через SDK API surface — это CLI-specific endpoint к биллингу.

## filteredMessages allowlist для compact-summary

Фильтр в `filteredMessages` useMemo раньше: `if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') return false`. **`compact-summary` молча отбрасывался**: записи доходили до `messages` state (6 штук с правильными metrics), но `useExternalStoreRuntime(messages: filteredMessages, ...)` получал отфильтрованный массив без них → assistant-ui store не знал о них → CompactSummaryMsg не рендерился → юзер видел пустоту между `/compact` chip и следующим turn'ом.

Через double-walk fiber memoizedState'а нашёл: `messages.length === 53, compactSummaries=6`, `filteredMessages.length === 35, compactSummaries=0`. Без MCP-инспекции в реальном UI этот тип бага найти **невозможно** — парсер дёргает `console.log`, видишь что summary распарсилась, потом следишь только до выхода loadHistory, дальше теряешь.

**Правило для добавления новых role'ей**: при создании любого нового role'а в SDKChatMessage **обязательно** обновить allowlist в `filteredMessages.filter`. Это hidden gate между data model и render pipeline.

## CompactSummaryMsg: hooks ordering до early return

Изначально была `useMessage` + early `return null` если id null, **затем** `useState/useRef/useStableCollapseToggle`. Это нарушает rules-of-hooks: если на одном render id == null (sync-window) и компонент возвращается null до hooks → на следующем render id != null → React видит больше hooks → mismatch → throw + silent crash. Все hooks должны быть **до** условного early return. Конкретно здесь edge-case всплыл из-за useMessage селектора, который кратко даёт null во время /compact session-rotation — без sync-window'а баг не воспроизводился, поэтому до запуска /compact всё работало нормально.

## useMessage/useAuiState sync-window guard

Во время `/compact` SDK ротирует sessionId → срабатывает `SessionSync` useEffect → `loadHistory(новый)` → `setMessages(...)` полная замена. В этот момент `useExternalStoreRuntime` синкается через useEffect (tick'ом позже), а `useAuiState((s) => s.thread.messages.length)` возвращает **старую** длину. Virtuoso запрашивает `MessageByIndexProvider(index=32)` → store.tapClientLookup throw `Index 32 out of bounds (length: 32)` → ErrorBoundary.

Все наши `useMessage((s) => s.field)` и `useAuiState` selectors обёрнуты в **try/catch внутри selector'а**: `useMessage((s: any) => { try { return s.id; } catch { return null; } })`. Возвращаем null-маркер вместо throw — компонент рендерит `return null`, Virtuoso перерисует следующим кадром с актуальной длиной.

Try/catch **внутри** selector'а, не вокруг hook-call'а: hook-call всегда должен выполняться (rules-of-hooks).

## Stable scroll при collapse-toggle внутри Virtuoso

`useStableCollapseToggle` раньше: `anchorY-before` → `flushSync(toggle)` → `anchorY-after` → `scrollTop += delta`. **Не работает** внутри Virtuoso: virtualizer re-measure'ит item через ResizeObserver, **1+ кадр delay**. На момент `anchorY-after` size ещё старый → `delta === 0`. Дальше Virtuoso перемеряет → items сдвигаются → юзер видит «открылось внизу экрана» вместо «осталось где было».

Решение: **double-rAF** + **scroller-relative offset**. Захватываем `targetOffsetFromScroller = anchorTopBefore - scrollerTopBefore` до toggle. После toggle ждём 2 rAF (React commit → Virtuoso ResizeObserver emit → known-size updated → layout settled). Тогда читаем новый offset, вычисляем delta, компенсируем `scroller.scrollTop`.

Graveyard:
1. **Single rAF после flushSync** — не помогает, Virtuoso re-measure'ит ещё на следующий кадр.
2. **`scrollIntoView({block:'start'})` на anchorRef** — работает для top-collapse-кнопки, но фиксирует viewport-Y на 0 (top), а юзер мог быть в middle блока.
3. **anchor.getBoundingClientRect() сразу после flushSync** — Virtuoso ещё не пересчитал, delta=0.

Принцип в `methodology/design.md::flushSync + sync layout-read для стабильного scroll` остаётся правильный, но для virtualized lists требует double-rAF wait.

## Smart Cancel: hasContent читает parts[] напрямую

Раньше `hasContent = streaming.text.trim() || streaming.thinking?.trim() || streaming.toolCalls.length > 0`. Не покрывало случай когда первый чанк был **только thinking** — `streaming.thinking` ставится через `assembleMessageFields()`, но если запись добралась до setMessages с пустым plain field (rare race), `hasContent === false` → Escape триггерил rollback и удалял юзер-message + partial thinking. Юзер: «получил thinkblock и нажал Escape → удалился thinkblock И мой запрос, должно было остаться оба».

Расширил: `hasContent` дополнительно проверяет `Array.isArray(streaming.parts) && streaming.parts.some(p => ...)` — любой непустой text/thinking/tool блок в ordered parts. parts[] — authoritative source, плоские поля derived. Принцип — `methodology/design.md::Destructive cancel зависит от прогресса`.

## Model footer: SDK_DEFAULT + alias-first + reset on alias-change

Три источника правды смешивались плохо:
1. `lastResolvedModel` — real model id из `msg.message.model` SSE-чанка (truth).
2. `tab.sdkModel` alias — что юзер выбрал в InfoPanel (`'default'/'sonnet'/'opus'/'haiku'`).
3. `resolveSdkModel(alias)` — `SDK_MODEL_MAP[alias]` (для 'default' → `undefined`!).

Старая формула `src = realModel || resolveSdkModel(alias) || alias || ''`. При cold start (нет ни одного assistant-чанка): realModel=null, alias='default', resolveSdkModel→undefined → `src='default'` → `.includes('opus/sonnet/haiku')` все false → return realModel (null) → **footer пуст**.

При смене alias в sidebar: realModel держит старое значение из ПОСЛЕДНЕГО SSE → формула возвращает его → footer показывает Opus пока юзер уже выбрал Sonnet, до первого нового turn'а.

Фикс:
1. **`SDK_DEFAULT_MODEL_ID = 'claude-opus-4-7'`** — fallback когда alias='default' И realModel=null (cold start). SDK default = whatever Anthropic ships under 'default' parameter; сейчас Opus 4.7. При смене shipping default — обновить константу.
2. **Alias-first priority при manual selection**: если `alias !== 'default'` И `resolveSdkModel(alias)` returns id — используем его (не realModel). RealModel wins только когда alias='default'.
3. **Reset `lastResolvedModel = null` через useEffect** на изменение `sdkModelAlias`. Без этого после смены модели формула застревает на старом realModel.

Это **тройной 3-way merge** — обычно избегаем (одна truth), но тут нет: alias = намерение юзера, realModel = факт, default = unknown intent. Все три нужны.

## Phase machine sdkState: fetching / thinking / typing / tool_use

Loader виден только пока **активно ждём**. До этого state был `'thinking' | 'tool_use'` flat — что неинформативно: thinking-фаза включала и network-fetch до первого event'а, и реальное extended thinking, и интервалы между tools.

Расширил Zustand type до `'idle' | 'fetching' | 'thinking' | 'typing' | 'tool_use' | 'error'`:
- `onNew` → `'fetching'` (отправили IPC, ещё не получили никакого SDK event'а)
- `system:init` → `'thinking'` (round-trip завершён, ждём первого assistant chunk'а)
- Assistant chunk c text → `'typing'` (loader **уходит**, content стримится в bubble)
- Assistant chunk только thinking → `'thinking'` (loader остаётся active)
- Tool_use без result → `'tool_use'`
- `result` event → `'idle'` / `'error'`

`'typing'` — это **не** loading-state в UX-смысле; tracking'уется чтобы callers могли отличить «активно отдаёт токены» от «ничего». UI скрывает loader для `typing` AND `idle`. Принцип близок к `methodology/design.md::Status indicator: signal-on-change, не permanent label` — теперь signals дифференцированы.

## Hard gate на Enter во время turn'а + rejectFlash

SDK 0.3 не поддерживает midstream приём нового prompt'а — попытка вызовет race с активной query. У нас уже есть PromptQueue для PTY-Claude (см. `fact-prompt-queue.md`), для SDK будем потом — пока самый безопасный путь блокировать ввод.

Три точки блокировки:
1. **`handleComposerKeyDown`** — Enter (без Shift) при `isRunning` → `preventDefault` + `triggerRejectFlash()` + early return.
2. **`onNew`** — guard в начале: `currentlyRunning = isRunning || sdkState in ['thinking','tool_use']` → silently drop. Two sources of truth (local stream-state + Zustand) проверяются OR — один может lag'ать.
3. **`commitSlash`** — если isRunning, slash-команду set'аем в текстарею, но НЕ дёргаем `composerRuntime.send()`. Юзер сам нажмёт Enter когда turn закончится.

**rejectFlash**: 1-секундный border-red + bg-#2a1414 на composer'е. Юзер: «должно мигать на 1 секунду одно мигание». Без visual signal'а Enter тихо no-op'ится — юзер считает что клавиатура сломалась. Это **destructive-feedback ≥ 1 секунда**, см. `methodology/design.md::Persistent state across UI transitions` — тот же класс UX-проблем.

## Focus + selection coordination в чате

Тема прошла ~12 итераций и два deep-research'а. **Текущая архитектура — пять компонентов**: virtuoso scroller без tabindex (через custom `components.Scroller` который деструктурирует Virtuoso'вский `tabIndex` props и не форвардит), caret snapshot на document-mousedown capture phase, active recovery на document-mouseup capture phase с threshold `selLen ≥ 5`, global keydown listener для печати при `activeElement = body`, и `onMouseDown.preventDefault()` на non-edit кнопках внутри истории (Scroll-FAB, compact toggle, tool-card header).

**Три WHATWG-инварианта** делают наивные подходы тупиковыми: `mousedown.preventDefault()` монолитен (отменяет focus И selection одновременно — один `defaultPrevented` gate), `tabindex="-1"` всё равно click-focusable, `ta.focus()` коллапсит `window.getSelection()` (focusing-step 7). Полный разбор симптомов, спецификаций, кладбища отброшенных подходов (range save/restore, focusin redirect, MutationObserver на tabindex, conditional preventDefault, setTimeout refocus в onBlur) — `fix-controlled-textarea-focus-selection.md`.

**CDP test-side note.** `electron_keyboard.type` через MCP не апдейтит React controlled-input (CDP `dispatchKeyEvent` не входит в Blink editor commit path). Для E2E использовать `electron_keyboard.insertText` или новый `electron_insert_text` MCP tool. Реальный OS keystroke от юзера идёт через trusted-event path, всё работает. Drag-select через MCP-mouse тоже не запускает Blink selection-controller — добавлен `electron_select_text` tool (Range API).

## Background tasks: bar + detail-pane + stream events (SDK 0.3.x)

В SDK-таб встроен живой трекер запущенных subagent'ов (Agent tool) и фоновых bash-команд. Реализация: тонкий strip-bar **под** composer'ом с chip'ами для каждого running task'а, клик по chip'у заменяет composer на 300px detail-pane (live stdout для bash, read-only mini-thread для агента через переиспользование `UserMsg`/`AssistantMsg`/`ToolCard` из основного чата). Завершённый task сразу пропадает из bar — он уже виден в main thread как обычная BashCard/GenericToolCard, дублировать его статичным chip'ом избыточно. Принцип — `methodology/design.md::Live tracker ≠ history`.

**Opt-in флаги обязательны.** В `sdkStartQuery::options` без `agentProgressSummaries: true` + `forwardSubagentText: true` SDK iterator родителя получает только `task_started` и `task_notification` (start+end), `task_progress.summary` пустой, live subagent text-чанков нет — UI показывает агента в running-состоянии без visible статуса. С флагами прилетают AI-generated краткие описания (`Running grep ... | wc -l`) на каждый шаг + текстовые дельты subagent'а. CHANGELOG SDK подтверждает: `agentProgressSummaries` появился в 0.2.72, `forwardSubagentText` в 0.2.119.

**Пять message-shape'ов из iterator'а:**
- `system:task_started` — `{ task_id, tool_use_id, description, subagent_type?, task_type:'local_agent'|'local_bash', prompt }`. Для Agent — есть `subagent_type` и `prompt` (initial instruction родителя). Для Bash в background — `task_type:'local_bash'`, нет `subagent_type`.
- `system:task_progress` — `{ task_id, description (live status), usage:{total_tokens, tool_uses, duration_ms}, last_tool_name, summary }`. Шлётся примерно раз в 5-10s пока агент работает.
- `system:task_updated` — `{ task_id, patch:{ status?: 'running'|'completed'|'failed'|'killed', end_time?, is_backgrounded? } }`. Главный маркер `is_backgrounded=true` (ушёл из foreground turn'а в фон).
- `system:task_notification` — финал, `{ task_id, status:'completed'|'failed'|'stopped', output_file, summary, usage }`. `output_file` для bash — путь типа `/private/tmp/claude-501/<dir>/<session>/tasks/<task_id>.output`, читается через offset'ный IPC.
- `tool_progress` (top-level type, не subtype) — `{ tool_use_id, tool_name, elapsed_time_seconds, task_id }`. Live tick для уже started tool'а.

**Двойной task_started для агента с bash-child'ом.** SDK на одну Agent-tool инвокацию шлёт **два** `task_started`: первый — сам агент (`task_type:'local_agent'`, есть `subagent_type`), второй — каждая внутренняя Bash subagent'а как отдельный таск (`task_type:'local_bash'`, нет `subagent_type`, но `tool_use_id` ссылается на parent Agent tool_use). Если показывать оба chip'а в bar — пользователь видит дубликат («general-purpose» + рядом «bash: ls ...»). Решение: в renderer'е (`ClaudeSDKTab::handleMessage`) фильтр `task_type === 'local_bash' && !subagent_type → return` — child bash живёт внутри subagent transcript'а (видим через `getSubagentMessages` в pane), отдельный bar-chip не нужен.

**Subagent stream leak: user И assistant.** SDK 0.3.x leak'ает в parent iterator не только `user`-записи subagent'а (initial prompt, tool_results), но и **`assistant`**-чанки subagent'а с его собственными tool_use'ами. Все они помечены `parent_tool_use_id` (= id parent'овского Agent tool_use block'а) и/или `subagent_type`. Без фильтра все Bash/Read/Edit subagent'а **дублируются**: один раз внутри pane (как должно быть), второй раз в main thread как ghost-карточки рядом с настоящим вызовом Agent tool. Раньше у меня был фильтр только для `type === 'user'`, что закрывало половину утечки. Правильный фильтр: `(msg.type === 'user' || msg.type === 'assistant') && (msg.parent_tool_use_id || msg.subagent_type) → return`. После — в main thread рендерится только parent's Agent-карточка (одна на subagent), subagent's содержимое доступно через клик по ней (или через chip в bar пока running).

**Initial prompt subagent'а: JSONL flush lag.** Первая `user`-запись внутри `agent-<id>.jsonl` — это initial instruction parent'а. Pane показывает её первым bubble. Но JSONL пишется **с задержкой** (sometimes 200-500ms после `task_started`); если pane открыли через секунду после старта, polling `getSubagentMessages` вернёт пустой массив или массив без user-bubble (subagent сразу полез в Bash, только tool_use). Решение: в `BgTask.initialPrompt` (renderer store) хранится `task_started.prompt` синхронно при первом event'е, `TaskDetailPane::AgentDetail::messagesWithPrompt` prepend'ит синтетический `user`-сообщение в начало если в загруженном JSONL уже нет user-bubble с тем же текстом. После того как JSONL флашнется и polling его подцепит — синтетический заменяется реальным (тот же текст, не двойной).

**SDK auto-backgrounds long-running bash.** Эмпирически: subagent с prompt'ом «Sleep 90 seconds via bash, then echo done» отрапортовал `task_notification status:'completed'` через **10.6s** (не 90). Что произошло: SDK сам перевёл `sleep 90` в background (видимо эвристика по длительности или по `&` syntax), agent получил background notification в свой контекст, считает что job started, возвращает результат parent'у. Реальный bash при этом продолжает работать — `task_updated status:'completed'` для bash task_id прилетает через 90s. Следствие: visible status агента в bar исчезает до того как его child bash дофинишировал. Это **не баг** нашей системы, это поведение SDK; UI отражает корректно (agent для пользователя завершён, его background bash — это внутреннее дело subagent'а).

**Stop running task: stopTask + abort + close.** `query.close()` рвёт только parent transport-сокет. Subagent-worker запускается SDK как **отдельный subprocess**, `close()` его не убивает — он доедет до своего естественного конца сам. Чтобы реально остановить subagent при Escape/Cancel — renderer собирает список running task_id из `tab.bgTasks`, шлёт в `claude-sdk:stop` payload `{ tabId, runningTaskIds }`, main вызывает `await query.stopTask(taskId)` для каждого **перед** `abortController.abort()` + `query.close()`. Подтверждено логом `[BgProbe:STOP] stopTask(a0319245) ok` после которого subagent эмитит `task_notification status:'stopped'`. Принцип — `methodology/design.md::Stop = stop tree`.

**Что пробовали и почему не сработало.** Изначально `claude-sdk:stop` дёргал только `query.close()` — рассчитывая что cascading abort через AbortController остановит и subagent. Не сработало: SDK 0.3.x спавнит subagent как отдельный CLI subprocess со своим `Query`-инстансом, у parent'а нет дескриптора для его abort. Тест с subagent'ом запущенным на 20+ Read'ов: после `close()` parent stream'а subagent продолжал отрабатывать в логах ещё ~30s (`task_progress` events приходили через event-channel который не закрывался по `close()`). Только `query.stopTask(taskId)` (control-request method) реально вызывает teardown subagent'а — это документированный путь в SDK 0.3.x.

## SDK session ID persistence через `updateSDKState`

`Tab.claudeSessionId` для SDK табов **до 2026-05-18** записывался в Zustand-store через `updateSDKState({claudeSessionId})`, но **в SQLite не персистился** — `saveTabs` дёргал только `setClaudeSessionId` (PTY-табы), для SDK был обходной путь. Симптом: после `restart_process` dev-сервера или явного Electron-restart юзер открывал свои SDK-табы и видел *"Waiting for session"* в InfoPanel, хотя JSONL на диске целый. В SQLite колонка `claude_session_id` для этих табов была пустая.

Решение: в `useWorkspaceStore::updateSDKState` добавлен guard — если в патче меняется `claudeSessionId` (т.е. `sidChanged === true`), после `Object.assign(tab, state)` дёргается `saveTabs(workspace.projectId, workspace.tabs)`. Ephemeral state (`sdkState`/`sdkMessages`) save не триггерят — это спам в SQLite на каждый assistant chunk. Принцип — anti-pattern в `CLAUDE.md::Разделённые update-paths для одного persistent поля`.

**Что пробовали и почему не сработало.** Первая мысль была — добавить вызов `s.setClaudeSessionId(tabId, sid)` поверх `updateSDKState` в renderer (handleMessage SDK iterator). Не сработало: `setClaudeSessionId` имеет guard `if (tab.claudeSessionId === sessionId) return` и сбрасывает overlay-флаги (`wasInterrupted`/`overlayDismissed`) — для SDK таба эти сбросы случайны и могут схлопнуть Interrupted Session Recovery overlay вместо PTY-таба. Решение через `updateSDKState` локальнее: одно место, одно поведение, save-side effect только когда sid реально меняется.

## Code map: background tasks

- `src/main/main.js::sdkStartQuery` → `options.agentProgressSummaries:true` + `options.forwardSubagentText:true`. Без них iterator получает только start+end events для subagent'ов.
- `src/main/main.js::ipcMain.handle('claude-sdk:stop')` → `await session.query.stopTask(taskId)` для каждого `runningTaskIds[]` **перед** `abortController.abort()` + `query.close()`. `query.close()` сам не убивает subagent workers.
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx::handleMessage` → 5 новых case'ов на `system:task_*` + `tool_progress`. Фильтр subagent leak'а `(user|assistant) && (parent_tool_use_id || subagent_type) → return` до того как чанк попадёт в `streaming-<tabId>` placeholder. Фильтр child bash в `task_started`: `task_type === 'local_bash' && !subagent_type → return`.
- `src/renderer/components/Workspace/ClaudeSDK/BackgroundTasksBar.tsx` — strip-chip bar под composer'ом, видим только когда `bgTasks.filter(running).length > 0`. Auto-close detail-pane'а через useEffect когда expandedTaskId уходит из running списка.
- `src/renderer/components/Workspace/ClaudeSDK/TaskDetailPane.tsx::AgentDetail::messagesWithPrompt` → prepend synthetic user-bubble из `task.initialPrompt` если JSONL ещё не флашнут (или вернул пустой массив user-сообщений).
- `src/renderer/components/Workspace/ClaudeSDK/sdkHistoryParser.ts::parseSubagentMessages` — выделенный helper из `ClaudeSDKTab::loadHistory` чтобы pane'овский AgentDetail переиспользовал тот же JSONL-парсер.
- `src/renderer/store/useWorkspaceStore.ts::updateSDKState` → `if (sidChanged) saveTabs(workspace.projectId, workspace.tabs)` — без этого SDK таб теряет `claudeSessionId` после Electron restart.
