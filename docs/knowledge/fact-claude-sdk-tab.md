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

**Где такой же шаблон не повторился.** Mobile-web parser (`mobile-web/src/messages.ts`) обрабатывает `for (const block of content)` в одном проходе и push'ит entries в `state.entries` в encounter-order — каждый блок становится отдельной UI-entry, порядок сохраняется естественно. **Латентный риск** в `src/main/ipc/claude-data.js:2638-2647` (sub-agent Task history dump для Sessions/Timeline превью): тот же split-by-type `mc.filter(text)` + `mc.filter(tool_use)`. Сейчас это превью-формат (читается человеком в read-only панели), не баг. При попытке отрендерить sub-agent history как полноценный чат — переделать на ordered parts. Принцип — `methodology/переносимый-дизайн.md::Ordered model output → ordered UI`.

## History prefetch в `restoreSession`

При cold start `useWorkspaceStore.restoreSession` восстанавливает N SDK-табов из персистенции. Каждый `ClaudeSDKTab` вызывает `loadHistory` в `useEffect` после того как `storeSessionId` резолвится из store — но `RestoreLoader` снимается **раньше** чем эти IPC-запросы возвращаются. Юзер видит «Restoring sessions» → blank chat-shell → через 200-500мс прилетает контент. Эффективно две фазы загрузки подряд: первая видимая, вторая невидимая. Принцип — `methodology/переносимый-дизайн.md::Глобальный startup-loader охватывает готовность контента`.

**Решение.** Module-level Map cache `_prefetchCache: Map<"tabId::sessionId", any[]>` в `src/renderer/utils/sdkHistoryPrefetch.ts`. Внутри `restoreSession` пока `isRestoring=true`, для каждого восстановленного SDK-таба параллельным `Promise.all` запускается `claude-sdk:active-branch-messages` IPC, результат складывается в cache через `setPrefetched(tabId, sessionId, messages)`. Только после `await Promise.all` снимается `isRestoring=false`. `loadHistory` в табе на mount первым делом проверяет cache через `consumePrefetched(tabId, sessionId)` — если хит, синхронно использует rawMessages без IPC, если мисс, идёт по живому пути.

**Single-shot semantics — критично.** `consumePrefetched` **удаляет** значение из Map при чтении. Это значит reload-чип в InfoPanel, fork operation, session-id rotation после `/compact` — все они идут по живому IPC, потому что cache уже опустошён первым `loadHistory`. Без self-delete'а второй `loadHistory` после rotation вернул бы stale messages для нового session-id, потому что ключ-то старый.

**Lazy data в pre-fetch не закидывать.** Timeline entries, search index, file-tree — это контент, который рендерится отложенно, юзер не видит его на первом кадре. Если включить их в `Promise.all` — startup-loader будет висеть лишние 1-2 секунды для данных, которые всё равно не блокируют первый кадр активного контекста.

## MCP-серверы: SDK не наследует `~/.claude.json`

Claude Code CLI автоматически читает `mcpServers` из `~/.claude.json`. **Agent SDK (`query()`) — нет.** По умолчанию `options.mcpServers` пустой, агент крутится без инструментов. Без явной пробрасывания это легко принять за фичу — «SDK работает», просто без browser/terminal/yougile.

**Решение:** один раз при первом вызове `sdkStartQuery` читаем `~/.claude.json`, кэшируем в module-level переменной (`_sdkMcpServersCache`), прокидываем во все последующие `query()` через `options.mcpServers`. Per-process cache — конфиг меняется редко, рестарт Electron'а перечитывает.

**Лайфсайкл MCP в SDK-табе:** каждая активная SDK-сессия спавнит **свой набор** stdio-MCP-серверов как дочерние процессы Electron main. При `session.query.close()` (закрытие таба, явный Stop) они умирают вместе с агентом. Это **те же серверы** что у Claude Code CLI/Desktop — параллельно может работать несколько инстансов, MCP-протокол это поддерживает.

**Browser-mcp как edge case:** browser-mcp многослойный — per-client `index.js` процесс + singleton `bridge.js` на порту 3458 + расширение Chrome. SDK спавнит свой `index.js`, он подключается к **тому же** bridge-у что и Claude Code CLI. Bridge маршрутизирует ответы по `commandId` per client socket — изоляция на уровне команд есть, состояние браузера общее (вкладки видны всем клиентам).

См. `methodology/переносимый-дизайн.md::Silent platform downgrade → toast` про то, как мы сигнализируем юзеру когда SDK что-то делает иначе, чем он ожидает.

## Effort: gating отменён, ultracode через settings

Anthropic API **не падает** при невалидной комбинации `(model, effort)` — **тихо понижает уровень**. Раньше из этого был сделан вывод, что надо гейтить пилюли по модели. **Это оказалось ошибкой и откачено** (2026-05-29). Реальный Claude Code **не гейтит effort по модели**: его слайдер `/effort` предлагает `low…max + ultracode` для **любой** модели, включая Haiku, и принимает любой уровень. Юзер показал скриншот (Haiku + `/effort max` → «Set effort level to max»). `supportedModels().supportedEffortLevels` — **не жёсткий гейт доступности** (Haiku возвращает его пустым, но слайдер всё равно даёт max). Матчить поведение референс-платформы важнее, чем вводить свой строгий гейт — см. `methodology/переносимый-дизайн.md::Несовместимость параметров — гасить в точке выбора, не в момент отправки` (раздел про границу «свой источник правды vs зеркалирование чужого UI»).

Итог по UI: все уровни всегда видны и кликабельны для всех моделей. Пилюли НЕ disabled, кластер НЕ скрывается, авто-даунгрейда при смене модели НЕТ.

**Что пробовали и почему откатили (graveyard):** добавляли per-model гейтинг через `query.supportedModels()` — `getSupportedEffortsForAlias()` возвращал `Set` поддерживаемых уровней, UI рисовал неподдерживаемые пилюли `disabled`, `hideEffortCluster` прятал весь кластер для Haiku (`supportedEffortLevels` пустой), ultracode дизейблился на не-xhigh моделях, при смене модели был авто-даунгрейд. Всё удалено. Параллельно убран и `loadSdkModelCapabilities()`-fetch из ControlBar (лишний IPC + спавн throw-away query). Сам IPC `claude-sdk:get-model-caps` + `supportedModels()`-probe в `main.js` оставлены (могут пригодиться), но в UI больше не используются.

**ultracode — НЕ уровень effort, а session-режим.** ultracode = `xhigh` + standing dynamic-workflow orchestration (Claude сам решает запускать workflow на каждый существенный таск). Транспортная асимметрия между PTY и SDK:
- **PTY** шлёт `/effort ultracode` напрямую — интерактивный slider-парсер CLI принимает `[low|medium|high|xhigh|max|ultracode|auto]`. Работает.
- **SDK** через `options.effort` уходит в флаг `--effort`, а его zod-енум **закрыт** на `[low|medium|high|xhigh|max]` — `ultracode` роняет процесс с exit 1 (форензика: tab-3197, `effort=ultracode → exited code 1`, тут же `effort=max → ok`). Поэтому в `sdkStartQuery` транслируем: `effort === 'ultracode'` → `effort: 'xhigh'` + `extraArgs: { settings: JSON.stringify({ enableWorkflows: true, ultracode: true }) }`. `ultracode`/`enableWorkflows` — поля **Settings-схемы**, не `query()` Options (top-level молча отбрасываются), `--settings` ложится в flag-слой и не затирает `~/.claude`. См. `fact-claude-sdk-workflows.md`.

**Runtime mismatch** (`detectModelFamilyMismatch`): safety net на случай server-side подмены модели (не effort'а). На первом `assistant`-чанке сравниваем `lastRequestRef.modelAlias` с `msg.message.model`. Family отличается (`opus` → `sonnet`) → toast `warning` один раз на turn (`modelMismatchToastedRef`).

## Thinking как параметр SDK

`thinking: { type: 'adaptive' | 'enabled' | 'disabled' }`. У `enabled` есть optional `budgetTokens` (legacy).

**Что было невидимо:** на Opus 4.7 **manual `enabled` уже не поддерживается** — только `adaptive` или `disabled`. Это написано мелким шрифтом в Anthropic docs. На Opus 4.6 ещё работает, но deprecated. Для нашего use-case это значит: думать на новых моделях можно только через `adaptive` (sdk сам разруливает по effort) или вообще выключить.

UI-пилюля Think маппится так: `tab.sdkThinking === false` → `{type: 'disabled'}`, иначе `{type: 'adaptive'}`. Manual budget не используем — он только запутает (юзер выбрал `effort: high` + manual budget 5K, агент берёт adaptive по effort'у, budget игнорируется).

Раньше Think была **UI-only** — пилюля переключала `tab.sdkThinking`, но `main.js::sdkStartQuery` не передавал параметр в `query()`. Багу можно было поймать только сравнением behavior двух сессий — нет error, нет визуального сигнала. Поправили — теперь `main.js` всегда пишет `thinking: { type: thinkingMode }`, логирует значение в `[ClaudeSDK]`.

## Single source of truth для model aliases

`SDK_MODEL_MAP` в `ClaudeSDKTab.tsx` маппит UI-алиасы (`opus`, `sonnet`, `haiku`, `default`) на то, что отдаём в `query()` options.model. **Не дублируется** — два места которые читали маппинг (`onNew` и `truncateAndResend`) теперь оба идут через `resolveSdkModel()`. См. `methodology/переносимый-дизайн.md::Single source of truth для third-party shipping values`.

**Передаём АЛИАСЫ, не полные id.** Проверено живым `supportedModels()`: бинарь отдаёт как выбираемые `value` именно алиасы — `default / sonnet / sonnet[1m] / haiku / opus[1m]` (НЕ полные id, НЕ голый `opus`). Поэтому `SDK_MODEL_MAP.opus = 'opus[1m]'` (Opus 4.8, 1M) — CLI сам резолвит алиас в текущую shipping-модель + цепляет 1M-бету из суффикса `[1m]`.

**1M определяется суффиксом `[1m]`, не версией модели.** Это правило из декомпила (`has1mContext(m) = /\[1m\]/i.test(m)` → цепляет beta `context-1m-2025-08-07`). Поэтому `opus` без `[1m]` = фактически 200K, даже если футер пишет «1M» — **именно такой латентный баг был**: до этой сессии `SDK_MODEL_MAP.opus = 'claude-opus-4-7'` (без суффикса И устаревшая версия). Любая правка модели — ровно одна строка в `SDK_MODEL_MAP`; забыл `[1m]` → молча урезанный контекст; забыл версию → старый id `404`-ится (`result.is_error` → красный toast «model not found»), на UI пилюля показывает `opus` как активную (это правда — юзер выбрал — но id мёртв).

## Ctrl+C в композере — только clear input

Первая версия делала TUI-style двухступенчатую эскалацию `clear → stop`: Ctrl+C на непустом input'е чистил буфер, второй Ctrl+C (или Ctrl+C на пустом буфере) звал `onSessionStop` → `claude-sdk:stop` IPC + overlay «Process stopped — history preserved». Логика была скопирована с поведения Claude TUI. Юзер: *«при Ctrl+C разве у нас просто не должен очищаться input? нажимаю ещё раз — input убирается, а зачем если процесс и так не запущен»*.

В UI композере с явной Stop-кнопкой (chip в ControlBar / TabBar dot / двойной Esc) Ctrl+C **только чистит input**, ничего больше. Если процесс не идёт — Ctrl+C проходит как обычное keystroke (native browser default), не интерсептим. Если идёт — preventDefault + clear текстового поля. Stop процесса — отдельный жест с явным визуальным affordance. Этот принцип переносим в любые UI с text-input + explicit process control — см. `methodology/переносимый-дизайн.md::Ctrl+C в UI композере = clear input, не stop process`.

Window-level handler (Escape / Ctrl+[ / Ctrl+C) на стороне ClaudeSDKTab.tsx остался — он вызывает `onCancel()` только когда `isRunning`. Этот путь покрывает классический TUI-muscle-memory (Esc отменяет turn), но **не** интерсептит Ctrl+C на текстовом поле — keydown handler у композера запускается до window listener, и если он сделал early-return (`!isRunning` или пустой текст), Ctrl+C дойдёт до window'а только когда юзер действительно хочет cancel turn.

## Markdown inline-code: цвет permission-blue + strip backtick

`AssistantTextPart` рендерит markdown через react-markdown с классами `prose prose-invert` (`@tailwindcss/typography`). Inline `` `code` `` стилизуется **только цветом** — `#b1b9f9` (это значение `permission` из dark-темы Claude Code, `packages/claude-code-src/utils/markdown.ts::codespan` → `color('permission')` = `rgb(177,185,249)`). Никакого фона, рамки, скруглений. Раньше был серый pill `bg-[#0d0d0d] border border-white/5` — юзер: *«убрать плашку, чистый синий, скопируй цвета из исходников Claude Code»*. Разворот прежнего принципа inset-фона — см. `methodology/переносимый-дизайн.md::Inset content на dark theme`.

**Обратные кавычки видны из-за typography plugin, не из markdown.** `@tailwindcss/typography` инжектит `` ` `` через CSS `code::before { content: "\`" }` + `code::after` (см. `node_modules/@tailwindcss/typography/src/styles.js`). react-markdown сам кавычки strip'ает — они приходили от prose-класса. Симптом: *«в блоках кода всё равно отображаются обратные кавычки, синие»*. Лечение — `[&_code]:before:content-none [&_code]:after:content-none` в className обёртки. Без знания что источник — typography-плагин, а не наш renderer, дебаг уходит в неправильную сторону (правка `code` компонента react-markdown ничего не даёт).

**Body-текст `#e8e8e8` (не `#d4d4d4`).** Подняли яркость основного текста — юзер: *«текст менее чёткий, фон сделать белее»*. Заголовки наследуют (`prose-headings:text-inherit`), иерархия только через `font-bold` + `mt`-зазоры. Калибровка отступов: `prose-p:my-0.5` (плотно внутри секции) + `prose-h*:mt-3/mt-4` (зазор между секциями), таблицы `[&_th/td]:px-3 py-1.5`.

## Paste-chip: распаковать в композер vs удалить — две affordance

Ручной paste становится chip'ом над композером только когда длиннее общей настройки `Чип после N символов` (default 800). Выбор сохранённого prompt через Opt+V/контекстное меню всегда становится prompt-чипом независимо от длины: это сохраняет происхождение и label, а повторный выбор той же prompt-вариации обновляет существующий чип по stable source key. Одинаковый ручной paste не дедуплицируется — пользователь мог намеренно вставить его дважды. Ветка `replace` после rewind/edit остаётся обычным текстом для правки.

Тело chip'а раскрывает preview, стрелка возвращает полный текст в текущую selection/caret, корзина удаляет его. Возврат в конец с автоматически придуманным `\n` был неверной моделью: чип является свёрнутым участком авторского текста, а не attachment с единственной позицией. При отправке prompt-чипы сериализуются обычным текстом, paste-чипы — как `<pasted_content>`, затем идёт textarea; chip-only draft валиден и по Enter, и во время type-ahead.

SDK-вкладки не unmount'ятся при переключении, поэтому composer chips нельзя держать в одном глобальном window-slot. Последний отрендеренный скрытый tab тогда подменяет payload активного, а общий clear-event стирает чипы всех вкладок. Authoring-state адресуется по `tabId` и зеркалится в самой вкладке; тот же реальный composer остаётся смонтированным, когда AskUserQuestion, slash-output или task detail визуально занимает его место. Скрытие — не clear/unmount, но скрытый textarea не имеет права перехватывать global keyboard/focus.

На границе отправки SDK хранит две формы отдельно: transport-текст и авторский snapshot `raw text + chips`. Type-ahead recall и ошибка до принятия возвращают именно авторскую форму, поэтому prompt-chip не превращается в плоский сериализованный текст; если пользователь уже начал следующий draft, оба объединяются без overwrite. Consume/clear происходит только после успешного ответа send-boundary и удаляет ровно неизменившийся snapshot отправленных чипов. Поздняя ошибка удаляет оптимистичный user-блок и возвращает draft, но новый чип, добавленный во время ожидания, не стирается. Это tab-scoped authoring bridge, не общий runtime и не durable Run After: очередь History в SDK не переносится.

## Сворачивание длинных user-сообщений

`CollapsibleText` в `ClaudeSDKTab.tsx`: text > 600 символов рендерится как preview (первые 400 + `…`) + кнопка `Раскрыть полностью (N строк) / Свернуть`. Применяется только к plain-text части user-сообщения; `<pasted_content>`-чипы оставлены как есть (у них своя свёртка).

**Мотивация:** SDK не имеет input length limit'а — юзер может вставить 30K символов одним сообщением. Без свёртки тред становится непроходимым: один user-message занимает три экрана, ответы Claude задавлены вниз. Порог 600/400 эмпирический — ниже 600 текст ещё читается inline, выше 600 нужна свёртка чтобы тред листался.

**Toggle сверху и снизу в expanded state.** В collapsed — toggle только снизу (естественное продолжение preview). В expanded — toggle дублируется и **сверху** (`mb-1` под верхом блока), и снизу. Оба `<button>` оборачиваются одним `<div ref={anchorRef}>` чтобы `useStableCollapseToggle` мог сделать viewport-restore. Без top-toggle юзер на 800-3000 символов вынужден скроллить через весь bubble чтобы свернуть — превращает «свернуть» в «забить и проскроллить мимо». См. `methodology/переносимый-дизайн.md::Toggle для expanded long content`.

## Tool-call rendering: специализированные карточки + LCS-diff

После общего перехода с inline-пилюль на карточный layout (см. `methodology/переносимый-дизайн.md::Tool call = карточка, не сообщение`), `ToolCallPart` стал **диспетчером по `toolName`** на 4 подкомпонента: `BashCard`, `ReadCard`, `EditCard`, `GenericToolCard` (fallback). Общая шапка живёт в `ToolCard` каркасе, специализация — только в body.

**Read preview через extension → Prism language map.** Файл `package.json` подсветится как JSON, `*.ts/.tsx` как TypeScript/TSX, `*.py` как Python и т.д. Карта `EXT_LANG` короткая (~25 расширений) — больше и не надо: oneDark из react-syntax-highlighter качественно стилизует только эти языки, остальные fall back на `text` без визуального проигрыша. **Контент рендерится целиком** в SyntaxHighlighter с `maxHeight: '480px', overflow: 'auto'` — никакого preview-N-lines + expand toggle. Раньше был preview 8 строк + `FullContentToggle` который раскрывал полный контент в **втором** code-блоке — оба паттерна делали то же что встроенный scroll: показывали что ниже. Удалили as redundant (см. `methodology/переносимый-дизайн.md::collapse только когда scroll невозможен`).

**Edit diff — собственная LCS реализация (не lib).** Anthropic Edit-tool отдаёт `args.old_string` и `args.new_string`. Установка `diff`/`fast-diff` npm-пакета не оправдана (Bundle + edge cases) — простой DP по LCS на ~50 строк делает то же самое. `lineDiff(old, new)` возвращает `Array<{tag: 'eq'|'add'|'del', line}>`. **Для Write** — `args.content.split('\n')` целиком как adds (вся файла новая). **Для MultiEdit** — батч hunks через `─`-разделитель. `defaultOpen={true}` для всех diff-карточек: суть вызова — в diff'е, скрывать его за chevron'ом контрпродуктивно. **Diff без expand-toggle**: контейнер `max-h: 480px overflow-y: auto`, длинные diff'ы скроллятся внутри.

**Diff-строка: gutter номеров + per-line Prism для add/eq, white для del.** Каждая строка — flex `[№ gutter 3.5em][±/space marker 16px][code]`. Общий renderer умеет показывать канонические old/new координаты каждого hunk, но SDK-вызов с одними `old_string/new_string` их не доказывает: в таком случае gutter остаётся пустым, а не выдаёт порядковые `1..N` за номера исходного файла. `Write` нового файла начинается с 1; точные координаты Edit/MultiEdit разрешены только если host передал их из авторитетного результата инструмента. Код add/eq-строк прогоняется через `<SyntaxHighlighter PreTag="span" customStyle={{background:'transparent'}}>` per-line — `const` синий, `return` красный, строки зелёные; bg-tint строки (add 12% / del 14% alpha) просвечивает сквозь прозрачный Prism. **Del-строки — белый `#fafafa`, Prism OFF**: на красном фоне Prism-цвета (зелёные строки, оранжевые keyword'ы) нечитаемы, плюс удалённый код не нуждается в семантической подсветке. Юзер на скриншоте Claude-thread'а: *«текст не серым, а полноценным цветом кода — return красным, const синим; у красного белым; писать количество строк»*.

**Borderless layout (chevron убран, иконка на левом крае, hover = trigger).** `ToolCard` каркас и `ReasoningPart` НЕ имеют рамки/фона. Строка-шапка: `[colored tool-icon][UPPERCASE label][badges][(description)][preview…]`, выровнена по левому краю окружающей prose (`-mx-1 px-1` резервирует место под hover-tint не сдвигая контент). Chevron-disclosure убран — вся строка `cursor-pointer hover:bg-white/[0.03]`, hover-tint несёт affordance раскрытия. Иконка **голая**, без chip-фона (фон вокруг неё был лишним шумом когда карточек несколько подряд). Раскрытое body индентится под строкой через **absolute `border-l` который останавливается за 6px до низа** (`bottom: 6px`) — между двумя соседними `Update` карточками (`my-3` зазор) видна чёткая граница, а не одна сплошная вертикаль во всю высоту треда. Юзер: *«отдельный бэкграунд для иконки убрать, сместить на одну линию с текстом; вертикальная полоса не должна идти до конца — из-за неё непонятно разделение между блоками»*. Принцип — `methodology/переносимый-дизайн.md::Strip-chip vs card-chip` (обобщён на tool-карточки).

**Edit/Update subtitle вместо badge.** Line-count для Edit/Write/MultiEdit идёт **под** шапкой отдельной dim-строкой `Added N lines, removed M lines` (цифры цветные), не `+N −M` badge'ем в самой шапке. Повторяет формат Claude-thread'а — читается прозой, не кластером компактных значков. `ToolCard` получил slot `subtitle?: React.ReactNode`.

**Preview команды/пути — `whitespace-nowrap truncate`, ровно одна строка.** Bash-команда в шапке `BashCard` никогда не переносится на второй визуальный ряд (раньше длинная команда wrap'илась рядом с одно-строчным label'ом — выглядело сломано), обрезается многоточием, полный текст в раскрытом body. Юзер: *«баш-команды должны быть в одну строку, как сейчас с MCP-вызовами»*.

**StatusDot вместо trailing-spinner.** Tool-иконка слева сама несёт статус: зелёная (done), красная (error), вращающийся Loader2 (running). Один визуальный slot, глаз быстрее парсит «сколько идёт / сколько готово».

**`mr-[60px]` на root ToolCard и ReasoningPart.** Карточки уже окружающей prose на 60px справа — scroll-зона для мыши + визуальное разделение «речь vs действие». Принцип — `methodology/переносимый-дизайн.md::Action-карточки уже prose`.

См. `methodology/переносимый-дизайн.md::Tool call = карточка, не сообщение` и `::Diff на dark theme` для переносимых принципов.

## Smart Cancel: сохранение vs откат по содержимому streaming

Cancel-кнопка в composer'е работает в одном из двух режимов, выбор по факту наличия частичного результата (принцип — `methodology/переносимый-дизайн.md::Smart cancel`).

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

## Общая оболочка composer, отдельный SDK runtime

SDK и PTY History используют одну stateless-оболочку `top bar + chips + input slot + overlay`: поэтому status, свёрнутые prompt/paste-чипы, явное раскрытие и настройки размеров выглядят одинаково. Оболочка не знает про SDK queue, AskUserQuestion, streaming, rollback и lifecycle; их по-прежнему держит SDK adapter. Это граница против «универсального composer-store», который сломал бы tab-scoped ownership постоянно смонтированных SDK-вкладок.

Реальный `ComposerPrimitive.Input` остаётся внутри `ThreadPrimitive.Viewport`: это обязательный React-context assistant-ui. Общая оболочка принимает его как slot, а не переносит наружу и не создаёт второй textarea. При коротком чате messages-div с `flex-1` прижимает карточку к низу; размещение внутри scroll-flow остаётся SDK-спецификой, тогда как primary History размещает ту же оболочку своим absolute/footer-spacer layout.

**Graveyard:**
1. **`sticky bottom-0 border-t shrink-0`** — выглядело правильно, но при scroll up composer оставался прибит к низу окна, **накрывая diff/контент** в верхней части. Юзер не мог прочитать раскрытое содержимое — оно пряталось под input. Удалили `sticky`.
2. **Вытащить composer наружу `ThreadPrimitive.Viewport`** (`<Viewport>{messages}</Viewport><div>{composer}</div>` в Root) — провалилось runtime'ом: `ComposerPrimitive.Input` читает Thread-контекст через React.Context, hoisting за пределы Viewport → `must be used within ThreadPrimitive.Viewport`. Это **structural constraint** assistant-ui, не наш выбор. Не повторять.

## Model/context идут в общую нижнюю панель, не в footer composer

Отдельный `[Model] N% context · Session` под SDK composer удалён: модель и состояние уже видны в общей нижней control bar, а session id доступен в диагностике. Дублирующий footer заставлял читать один контекст дважды и делал SDK визуально отдельным продуктом. Данные не удалены: SDK продолжает публиковать model/context в control bar и показывает их в служебных slash-overlay.

**Источник model'а — две стратегии:**
1. **`lastResolvedModel`** — real model id из `msg.message.model` (SSE chunk). Captured в `handleMessage` при `msg.type === 'assistant'`. Это truth от Anthropic — может отличаться от UI-alias если был silent downgrade.
2. **`sdkModelAlias`** fallback — `tab.sdkModel || 'default'` через `resolveSdkModel()`. Используется когда ещё не было ни одного assistant-чанка (новый таб без turn'ов).

Helper `formatModelLabel(realModel, alias)` → `"Opus 4.8 (1M context)"` / `"Sonnet 4.6"`. Family из id, версия — из real-model SSE-эхо (`claude-opus-4-8`), а не из alias (`opus[1m]` цифр версии не несёт). `(1M context)` определяется **суффиксом `[1m]` ИЛИ Opus ≥ 4.8** (1M by-default на API с 4.8), НЕ хардкодом конкретной версии — `has1mTag = /\[1m\]/.test(src)`. Так футер перестал врать: раньше суффикс хардкодился на «Opus 4.7», и `opus` без `[1m]` (200K) подписывался как 1M.

**Источник context %:**
- `lastContextUsedTokens` — захватываем `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` (полный context, не только uncached). Из той же `msg.message.usage` где трэкается mismatch model'а.
- `getModelContextWindow(realModel, alias)` — 1M когда: явный суффикс `[1m]` (в real-model id ИЛИ в alias — alias несёт `[1m]`, real id нет) ИЛИ Opus ≥ 4.8 (1M by-default). Иначе 200K. Смотрит на ОБА (real id + alias), потому что суффикс живёт на alias'е, а версия — на real id. Anthropic не shipping'ит окно в SDK, эвристика по доке.
- `% remaining = 100 - (used / window) * 100`. Clamp [0, 100].

## Общая типографика AI-поверхностей

SDK transcript берёт тот же размер «История», textarea — «Поле ввода», status/chips/preview — меньший размер вторичных элементов, что и PTY History. Переключение транспорта не должно менять визуальный масштаб одного класса сообщений. Terminal font больше не является root-размером SDK-чата; он остаётся настройкой raw xterm и тех контролов, которые действительно принадлежат терминалу.

## `useStableCollapseToggle`: flushSync + wasAtBottom + findScrollParent

Хук стабилизирует scroll при раскрытии collapsed-блока **выше текущего viewport'а**. Реализация и принцип — `methodology/переносимый-дизайн.md::flushSync + sync layout-read`.

**Что было невидимо:**
1. **Почему не `useLayoutEffect`:** хук generic, не имеет своего state — owner-компонент держит `[open, setOpen]`, мы получаем только callback. layout-effect нельзя повесить на «когда callback изменит state у консьюмера» — мы не знаем когда это случится. flushSync даёт ту же sync-commit гарантию изнутри click-handler'а.
2. **`findScrollParent`** ищет ближайшего предка с `overflow-y: auto|scroll` И `scrollHeight > clientHeight`. Второй чек важен: если предок имеет `overflow-y: auto` но контент **помещается**, у него нет scroll'а и компенсация не нужна (пропускаем).
3. **Две ветки по `wasAtBottom`** (4px tolerance — `BOTTOM_PIN_PX`):
   - **был у самого низа** (`scrollHeight − scrollTop − clientHeight ≤ 4px`) → после toggle через 2×rAF делаем `scrollTop = scrollHeight` (re-stick к новому низу). Покрывает И expand, И collapse. Зачем: turn можно остановить mid-stream, и раскрывающийся блок (thinking / tool-карточка / дифф / промпт) окажется внизу — при раскрытии его тело должно остаться видимым, а не уехать под фолд.
   - **не у низа** → anchor-pin: держим top кликнутого блока на той же viewport-Y (старая логика, чтобы при раскрытии блока выше глаз не прыгал).

   **Шрам:** ветку `wasAtBottom` однажды **выпилили при рефакторинге** (остался только anchor-pin), коммент про неё в коде остался — рассинхрон «доки обещают, код не делает». Симптом: раскрыл свой промпт внизу — тело раскрылось ВНИЗ под фолд, надо доскролливать вручную. Вернули обе ветки. Любая правка хука — проверь что обе ветки на месте.

Применён ко всем toggle-точкам через инжект `open/onToggle/anchorRef` в пакетные `CBToolCallPart`/`CBThinkBlock` + локальные `CollapsibleText`/`CompactSummaryMsg`.

**Мобилка — свой `stickToggle`** (`mobile-web/src/App.tsx`): пакетные компоненты те же, но scroll-контейнер (`scrollParentRef`) живёт в `ChatView`, а карточки — глубоко в virtua-списке. Решение: `ChatView` регистрирует контейнер в module-level `_scrollContainer` (`registerScrollContainer`), любой toggle карточки зовёт `stickToggle(fn)` — snapshot `wasAtBottom` (порог 80px, не 4 — touch-scroll rounding) → `fn()` → 2×rAF `scrollTop = scrollHeight` если был внизу. Те же три toggle-сайта (ThinkingCard / ToolCard / CollapsibleText).

**Стриминг-автоскролл — асимметрия desktop/mobile.** Desktop: Virtuoso `followOutput="auto"` + `atBottomStateChange` — из коробки. Mobile (virtua): `followOutput` **нет**; комменты обещали «equivalent», но реально был только одноразовый `didInitialScrollRef` (скролл один раз при загрузке), поэтому чат **не следовал** за стримингом. Фикс — effect на `[entries, atBottom]`: на КАЖДОЙ смене `entries` (новый tail ИЛИ рост текста последнего блока — `flushReducer('append')` каждый чанк отдаёт новый массив) если `atBottom` → `scrollToIndex(last, {align:'end'})`. `atBottom` (порог 120px) считается в `onScroll` outer-div'а через virtua-handle (`scrollSize − scrollOffset − viewportSize`).

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

См. `methodology/переносимый-дизайн.md::In-memory ephemeral state ≠ persistent identifier source` для общего принципа.

## Context indicator (used %, не remaining)

Header pill и mobile composer показывают **% использования** контекстного окна (filled-bar semantic), не % остатка. Цвета: серый 0-75% / амбер 75-90% / красный 90-100%. Раньше формула была `100 - usedPct` — юзер читал `92%` как «92% полно» хотя это было «92% свободно». См. `methodology/переносимый-дизайн.md::Прогресс = заполнение, не остаток`.

Для `tabType !== 'claude-sdk'` (terminal табы) индикатор скрыт — формула не имеет смысла для PTY-Claude (нет SDK usage events).

## Initial scroll

`didInitialScrollRef = useRef<string | null>(null)` хранит **sessionId** для которого scroll-to-bottom уже сделан. Один раз на смену сессии (включая после `/rewind` / fork когда меняется uuid), не на focus tab. Без этого юзер при возврате в чат каждый раз скакал в начало истории. См. `methodology/переносимый-дизайн-mobile.md::Initial scroll = once-per-context`.

## Composer button slot (Send / Stop)

Send (`↑`) и Stop (`■`) жили в **одном** `<button>` slot composer'а, переключались по `busy`. Раньше Stop сидел в header справа от burger'а — два muscle path'а для одного действия. См. `methodology/переносимый-дизайн.md::Send / Stop = одна muscle path`.

**Обновление май 2026: Send-кнопка удалена целиком.** Composer теперь чистый textarea без кнопки. Enter = submit, Escape/Ctrl+C/Ctrl+[ = cancel. Юзер: «убери кнопку отправки, у нас за остановку будут отвечать клавиши». Это завершение муscle-path стянутого до клавиатуры — для PTY-Claude муscle-path тот же, для SDK теперь identical.

## JSONL shape для compact: camelCase + флаги

Anthropic SDK пишет JSONL поля compactim'а в **camelCase**, а stream-events в SDK iterator — в **snake_case**. Обе формы поддерживаем (`compactMetadata` ?? `compact_metadata`, `preTokens` ?? `pre_tokens`). Authoritative маркер compact-summary записи — флаг **`isCompactSummary: true`**, не `isReplay`/`isSynthetic` (тех на summary НЕ выставляются). Fallback на canonical phrase `"This session is being continued from a previous conversation"` — для старых сессий или edge-cases. Запись также носит `isVisibleInTranscriptOnly: true` — служебный флаг что эту запись CLI отображает в transcript, мы аналогично рендерим (но как orange divider, а не user-bubble).

Записи `<local-command-stdout>Compacted </local-command-stdout>` — это CLI-артефакт завершения `/compact`-команды (CLI пишет `chalk.dim('Compacted ' + summary)` в stdout). В SDK chat не нужен — дропаем целиком. Аналогично `<local-command-caveat>` (служебная обёртка для replay-context).

Что было невидимо: я неделю искал `isReplay`/`isSynthetic` на summary-записях — их там НЕТ. SDK 0.3 поменял shape: только `isCompactSummary` + `isVisibleInTranscriptOnly`. Без вычитки сырого JSONL это невозможно определить — types в `sdk.d.ts` шипят generic `SDKMessage` без полного field-listing'а.

## Compact summary: ride-on-assistant role + id-prefix discrimination

assistant-ui runtime не позволяет добавлять custom `role` — допустимы только `user/assistant/system/data`. Мы храним записи как `SDKChatMessage.role: 'compact-summary'`, в `convertMessage()` маппим в `role: 'assistant'` **+ id-prefix `compact-summary-`**. `AssistantMsg` проверяет prefix первой строкой — если match, делегирует в `CompactSummaryMsg` (orange-bordered bubble с метриками `pre→post tokens · Ns`, collapsible toggle сверху+снизу при >600 char'ов, padding и border в brand-orange tinted).

Метрики не сериализуются через `ThreadMessageLike` (поля кастомные не пропускаются) — храним в module-level `_compactMetricsByMsgId Map<string, Metrics>`, заполняем при `convertMessage`, читаем в `CompactSummaryMsg` через `getCompactMetricsForMsg(id)`. Это **edge-case ID-маркера** — id служит и идентификатором, и discriminator'ом типа. См. `methodology/переносимый-дизайн.md::Type variant = visual marker, не rename` — здесь та же логика: тип передаётся через id-prefix потому что contract'а custom-role нет.

## Compact summary order swap в loadHistory post-pass

JSONL пишет `compact_boundary` → `isCompactSummary` user-record **раньше** `<command-name>/compact</command-name>` chip-записи. То есть для юзера это «summary появилась, потом юзер ввёл /compact» — наоборот хронологии его действий. Post-pass в `loadHistory` свапает соседние `compact-summary` + `user`-text-`/compact` → chip всегда выше summary. Без этого UX-чтение неправильное: «откуда summary, я ещё не давал команду».

## Compact loader: fake-progress (SDK не отдаёт прогресс через API)

CLI Ink-renderer рисует «5%  ▰▰▱▱▱  Next: H. Documentation» — это **только в Ink**. Agent SDK 0.3 в iterator emit'ит ровно три маркера: `{type:'system', subtype:'status', status:'compacting'}` (start) → 30-60s тишины → `{...status:null, compact_result:'success'}` (end) → `{type:'system', subtype:'compact_boundary', compactMetadata:{...}}` (summary metrics). Никаких процентов / per-step событий. `onCompactProgress` callback из `compact.ts` работает только внутри `ToolUseContext` CLI'а, в SDK не пробрасывается.

Решение: indeterminate progress bar (CSS keyframes `sdk-compact-bar`, gradient slide 1.8s loop) + live elapsed timer. Не врём конкретными процентами. Принцип — `methodology/переносимый-дизайн.md::Fake progress > врать конкретными цифрами когда API не отдаёт`.

## Slash autocomplete popup

Манифест команд получаем **двумя путями**, merge с приоритетом live:

1. **Live** — из `system:init` сообщения активной сессии (поле `slash_commands`, нормализуем shape). Это AUTHORITATIVE для **этой** сессии: включает `/status`, локальные skills (`/check`, `/loop`), session-specific команды которые зависят от модели/аккаунта.
2. **Probe-fallback** — `claude-sdk:probe-commands` IPC через throw-away `query()`. Используется пока нет активной сессии (новый таб). Throw-away query спавнится с `async function*() { await new Promise(() => {}); }` — без never-resolving promise SDK мгновенно tear down'ит ProcessTransport и `getContextUsage()` / `mcpServerStatus()` падают с «Query closed before response».

Live перезаписывает probe по имени, probe-only добавляет недостающие → юзер всегда видит максимально полный список.

**Filter**: ranked startsWith > includes по name И aliases. Юзер вводит `/us` → сначала `/usage`, потом `/extra-usage` (раньше plain `includes` смешивал, `/extra-usage` оказывался первым).

**Popup geometry**: `absolute bottom-full mb-1 z-30` НАД composer'ом — не двигает thread, перекрывает items внутри Virtuoso. Композер остаётся на месте. Принцип — `methodology/переносимый-дизайн.md::Popup поверх контента — absolute`.

**Keydown через refs**: `slashIdxRef` / `filteredCommandsRef` / `showSlashPopupRef` обновляются на каждый render. `handleComposerKeyDown` мемоизирован на `[composerText, writeComposerValue, isRunning, ...]` — без refs ArrowDown/Enter ловят **stale** значения slashIdx/filteredCommands (handler не пересоздаётся на каждый keystroke потому что иначе теряется focus). `e.stopPropagation()` обязателен — assistant-ui ловит Enter глобально и сабмитит.

**Commit = submit, не insert**. Click/Enter в popup → `composerRuntime.send()` сразу (если не isRunning). Раньше различал required (`<>`) vs optional (`[]`) args и блокировал submit для команд с argumentHint — но у Claude SDK почти все hint'ы в `<...>` даже для optional args (`/compact <optional summary>`, `/clear [name]`). Юзер: «если выбрал стрелочками — Enter сразу запускает». Если хочет добавить args — печатает их вместо выбора из popup'а (пробел закрывает popup, далее обычный ввод). Принцип — `methodology/переносимый-дизайн.md::Selected autocomplete item: Enter = submit`.

**MouseDown preventDefault**: на root popup'а — иначе клик мышкой теряет фокус textarea (blur срабатывает перед click handler'ом).

## Slash command renders as user-chip, не диалоговая реплика

JSONL пишет `<command-name>/compact</command-name>\n<command-args>…</command-args>` как `type:'user'` record. Парсер детектит обёртку, strip'ит leading slashes (CLI sometimes пишет `<command-name>/usage</command-name>`, sometimes `<command-name>usage</command-name>`), реконструирует `text = '/' + name + (args ? ' ' + args : '')`. Role остаётся `'user'`.

В `UserMsg` детект `^/\w[\w-]*(?:\s|$)` без newlines → рендер как фиолетово-синий chip справа (фон `rgba(129,140,248,0.08)`, color `#a5b4fc`, border `rgba(129,140,248,0.25)`). Без edit/repeat hover-кнопок — повтор slash-команды проще через композер.

Раньше chip имел chevron `>` слева. Удалён — chevron в UI означает «раскроется» (см. ReasoningPart, ToolCard), а slash-chip нечего раскрывать. Принцип — `methodology/переносимый-дизайн.md::Chevron = expand-affordance, не декор`. Также `methodology/переносимый-дизайн.md::Slash invocation = action-chip` про сам факт визуального отделения служебного от диалогового.

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

Принцип в `methodology/переносимый-дизайн.md::flushSync + sync layout-read для стабильного scroll` остаётся правильный, но для virtualized lists требует double-rAF wait.

## Smart Cancel: hasContent читает parts[] напрямую

Раньше `hasContent = streaming.text.trim() || streaming.thinking?.trim() || streaming.toolCalls.length > 0`. Не покрывало случай когда первый чанк был **только thinking** — `streaming.thinking` ставится через `assembleMessageFields()`, но если запись добралась до setMessages с пустым plain field (rare race), `hasContent === false` → Escape триггерил rollback и удалял юзер-message + partial thinking. Юзер: «получил thinkblock и нажал Escape → удалился thinkblock И мой запрос, должно было остаться оба».

Расширил: `hasContent` дополнительно проверяет `Array.isArray(streaming.parts) && streaming.parts.some(p => ...)` — любой непустой text/thinking/tool блок в ordered parts. parts[] — authoritative source, плоские поля derived. Принцип — `methodology/переносимый-дизайн.md::Destructive cancel зависит от прогресса`.

## Model footer: SDK_DEFAULT + alias-first + reset on alias-change

Три источника правды смешивались плохо:
1. `lastResolvedModel` — real model id из `msg.message.model` SSE-чанка (truth).
2. `tab.sdkModel` alias — что юзер выбрал в InfoPanel (`'default'/'sonnet'/'opus'/'haiku'`).
3. `resolveSdkModel(alias)` — `SDK_MODEL_MAP[alias]` (для 'default' → `undefined`!).

Старая формула `src = realModel || resolveSdkModel(alias) || alias || ''`. При cold start (нет ни одного assistant-чанка): realModel=null, alias='default', resolveSdkModel→undefined → `src='default'` → `.includes('opus/sonnet/haiku')` все false → return realModel (null) → **footer пуст**.

При смене alias в sidebar: realModel держит старое значение из ПОСЛЕДНЕГО SSE → формула возвращает его → footer показывает Opus пока юзер уже выбрал Sonnet, до первого нового turn'а.

Фикс:
1. **`SDK_DEFAULT_MODEL_ID = 'claude-opus-4-8'`** — fallback когда alias='default' И realModel=null (cold start). SDK default = whatever Anthropic ships under 'default' parameter; сейчас Opus 4.8 (28 мая 2026, 1M by-default). При смене shipping default — обновить константу.
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

`'typing'` — это **не** loading-state в UX-смысле; tracking'уется чтобы callers могли отличить «активно отдаёт токены» от «ничего». UI скрывает loader для `typing` AND `idle`. Принцип близок к `methodology/переносимый-дизайн.md::Status indicator: signal-on-change, не permanent label` — теперь signals дифференцированы.

**Loader-stomp при stop→resend.** Любой код который сначала останавливает живой query (`claude-sdk:stop`), а потом стартует новый, должен ставить `'fetching'` **после** await stop, не до: `stop` эмитит `claude-sdk:done` → `handleDone` гасит state в `'idle'`, и преждевременный fetching будет затёрт. Конкретный шрам — `## Repeat/Edit::Loader-stomp`.

## Enter во время turn'а: mid-stream type-ahead (single-slot)

**Обновление 2026-05: midstream теперь поддержан.** Раньше тут был hard-gate «SDK 0.3 не поддерживает midstream, блокируем ввод» — это **больше не так**. Через long-lived input-channel с `priority:'next'` сообщение, отправленное во время стриминга, доезжает до Claude на ближайшей block-boundary (как нативный TUI). Полная механика, три фазы chip (queued→sent→landed), JSONL-watcher для позиции, channel race fix, drop-on-interrupt — в [`fix-sdk-midstream-typeahead.md`](fix-sdk-midstream-typeahead.md).

Текущая политика — **single-slot**, не полная очередь: одновременно может висеть **один** mid-stream chip. Пока он есть (любого состояния), второй Enter не отправляется:
1. **`handleComposerKeyDown`** — Enter при `isRunning` И `queued != null` → `preventDefault` + toast + chip-flash + early return. Если chip'а нет — enqueue в type-ahead.
2. **`commitSlash`** — если isRunning, slash-команду set'аем в текстарею, но НЕ дёргаем `composerRuntime.send()`. Юзер сам нажмёт Enter когда turn закончится.

**chip-flash при отклонённом втором Enter**: chip вспыхивает (CSS `sdk-chip-flash`, key-remount), toast объясняет почему (`queued` → «edit/discard chip»; `sent` → «in flight to Claude»). Без visual signal'а Enter тихо no-op'ится — юзер считает что клавиатура сломалась. Это **destructive-feedback ≥ 1 секунда**, тот же класс что `methodology/переносимый-дизайн.md::Anti-mash guard на любой repeating input`.

## Focus + selection coordination в чате

Тема прошла ~12 итераций и два deep-research'а. **Текущая архитектура — пять компонентов**: virtuoso scroller без tabindex (через custom `components.Scroller` который деструктурирует Virtuoso'вский `tabIndex` props и не форвардит), caret snapshot на document-mousedown capture phase, active recovery на document-mouseup capture phase с threshold `selLen ≥ 5`, global keydown listener для печати при `activeElement = body`, и `onMouseDown.preventDefault()` на non-edit кнопках внутри истории (Scroll-FAB, compact toggle, tool-card header).

**Три WHATWG-инварианта** делают наивные подходы тупиковыми: `mousedown.preventDefault()` монолитен (отменяет focus И selection одновременно — один `defaultPrevented` gate), `tabindex="-1"` всё равно click-focusable, `ta.focus()` коллапсит `window.getSelection()` (focusing-step 7). Полный разбор симптомов, спецификаций, кладбища отброшенных подходов (range save/restore, focusin redirect, MutationObserver на tabindex, conditional preventDefault, setTimeout refocus в onBlur) — `fix-controlled-textarea-focus-selection.md`.

**CDP test-side note.** `electron_keyboard.type` через MCP не апдейтит React controlled-input (CDP `dispatchKeyEvent` не входит в Blink editor commit path). Для E2E использовать `electron_keyboard.insertText` или новый `electron_insert_text` MCP tool. Реальный OS keystroke от юзера идёт через trusted-event path, всё работает. Drag-select через MCP-mouse тоже не запускает Blink selection-controller — добавлен `electron_select_text` tool (Range API).

## Soft interrupt vs hard kill: процесс переживает прерывание хода

Стоп в SDK-табе расщеплён на два жеста (переносимый принцип — `methodology/переносимый-дизайн.md::Прервать текущий ход ≠ убить процесс`). `claude-sdk:stop` принимает флаг `hard`:

- **SOFT (по умолчанию)** — `await query.interrupt()` и **всё**. НЕ зовём `abortController.abort()`, `channel.end()`, `query.close()`, `stopJsonlWatcher`, `sdkSessions.delete`, и НЕ `stopTask` фоновых агентов. Процесс паркуется живым, stream-loop продолжает крутиться, следующий промпт продолжает ту же сессию через mid-stream push. Это нативный Esc Claude TUI: прервать foreground-ход, фон оставить. Маршрутизируется сюда: Escape (onCancel branch A), точка на вкладке, ctx-menu Stop, двойной Ctrl+C.
- **HARD (`hard:true`)** — после interrupt'а ещё `stopTask` каждого running-таска (чистый `task_notification{stopped}` до смерти транспорта) → `abort()` → `channel.end()` → `query.close()` → delete. Маршрутизируется сюда: кнопка-индикатор процесса, закрытие вкладки, Правка/Повтор (truncate JSONL под живым процессом портит цепочку — сначала kill).

**Почему именно так / A/B-доказательство (2026-05-29, один бинарь 2.1.156).** Стартовали с гипотезы что субагенты надо `stopTask`'ать потому что `close()` их не убивает (старый текст ниже это утверждал — он **неверен**, см. graveyard). Живой probe: streaming-query, прерванный через `interrupt()` БЕЗ close, **выживает** — push второго сообщения запускает новый ход (ответил `ALIVE`), итератор не падает. Контрольный A/B на JSONL-маркер: `interrupt()→close()` ⇒ `[Request interrupted by user]` на диске; `abort()+close()` ⇒ нет (транспорт срублен до flush'а). Значит durable-метка прерывания (на которой держится «stopped»-плашка) появляется только на graceful-пути.

**Подавление ожидаемой ошибки прерывания.** `interrupt()` заставляет CLI эмитить `result{subtype:'error_during_execution', is_error:true}` (диагностический `[ede_diagnostic] result_type=user`) и затем **бросить** ту же ошибку в наш `for await`. На user-stop это НЕ настоящий сбой — иначе на каждый Escape всплывал бы красный тост. `session.userInterrupted=true` ставится перед `interrupt()`; stream-loop и его catch проверяют флаг и глушат и forward результата, и throw. Флаг сбрасывается в `false` на следующем mid-stream push (новый ход — настоящие ошибки снова проходят). Проверено probe: с suppression на стоп ничего не доходит до рендерера, маркер на диске, итератор завершается чисто.

**Warm-start: клик по «остановлен» поднимает процесс вхолостую.** `claude-sdk:warm-start` зовёт `sdkStartQuery` с `prompt:null` — канал открывается **без** seed-сообщения, CLI-процесс спавнится и паркуется, `process-state alive:true` фаерит → индикатор «остановлен»→«активен» без отправки сообщения. С `resume:<sid>` тёплый процесс держит полную память + тот же JSONL на первом pushed-ходе (probe: вспомнил факт из прошлого хода, sessionId не сменился). Фантомных записей пока процесс припаркован НЕ пишется — sessionId не создаётся до первого реального сообщения (probe: `parked no-sid-yet`, маркер сессии пришёл только после push). На warm-start пропускаем web-broadcast `busy:true` + user-bubble — хода нет, это была бы ложь.

## «⊘ stopped» badge: durable из JSONL-маркера

Прерванный ответ получает приглушённо-янтарную плашку `⊘ stopped` **снизу** под содержимым (ответ обрывается в конце — там и метка). Источник — durable, переживает полный перезапуск (принцип — `methodology/переносимый-дизайн.md::Durable artifact определяет UI-историю`).

Детектор — запись-маркер, которую CLI пишет на прерывании: `type:'user'` с единственным text-блоком из набора `[Request interrupted by user]` / `… for tool use` / `[Request interrupted]` (контент бывает строкой ИЛИ `[{type:'text'}]`-массивом, оба shape'а). На диске байт-в-байт одинаков для PTY (`entrypoint:'cli'`) и SDK (`sdk-ts`/`sdk-cli`) — единственное отличие `entrypoint`. Это тот же маркер что PTY-watcher (`INTERRUPT_TEXTS` в `main.js`), хардкод английский, не локализуется.

Two-tier (как PTY-фикс прерывания):
1. **Durable (reopen)** — `loadHistory` детектит маркер-запись, не рендерит её как user-бабл, навешивает `interrupted:true` на assistant-сообщение, на которое она ссылается по `parentUuid` (НЕ по соседству в массиве — пре-pass резолвит parentUuid вверх до ближайшего assistant; маркер может ссылаться на любую из смерженных в один turn записей, флаг OR'ится при merge). Флаг переносится через module-level `Set` (как `_compactMetricsByMsgId` — `ThreadMessageLike` кастомные поля роняет).
2. **Live (без reload)** — `onCancel` branch A ставит флаг сразу на сохранённый partial; `claude-sdk:interrupted` IPC (из `_processJsonlTail` когда маркер лёг) ставит для жестов, не идущих через onCancel (точка вкладки). `_processJsonlTail` обязан детектить маркер **до** Path-B ветки промоушена чипа — маркер shape'ом совпадает с sdk-cli mid-stream push'ем и иначе ложно-промоутится как queued-чип.

Удалён прежний overlay «Process stopped — history preserved» + Resume: SDK не висит в фоне, «возобновлять» нечего (resume-кнопка лишь прятала overlay), а сам overlay врал про паузу процесса. После стопа композер просто остаётся доступен.

## Процесс-индикатор состояния (работает/активен/остановлен)

В `ClaudeControlBar` на месте старого SessionActionChip для SDK-таба — индикатор состояния процесса тремя состояниями: `работает` (жив + busy, пульсация `animate-glow-yellow`), `активен` (жив, простаивает — возможно фон работает), `остановлен` (серый). Шрифт chip'а (`text-xs font-medium`). Клик-семантика: в `активен`/`работает` → hard-kill; в `остановлен` → warm-start (поднять процесс) + фокус композера; в transient `останавливаю…` инертен.

Единый сигнал с плашкой активности на вкладке: оба читают `tab.sdkProcessAlive` + busy (принцип — `methodology/переносимый-дизайн.md::Один сигнал состояния — все его поверхности`). `sdkProcessAlive` ставит main: `alive:true` при старте query, `alive:false` только в `finally` stream-loop'а (hard kill / естественный конец / закрытие вкладки) — soft-interrupt loop не завершает, поэтому процесс остаётся `активен` между ходами. Слушатель `claude-sdk:process-state` живёт в always-mounted `App.tsx`, не в табе, — плашка вкладки обновляется даже когда таб неактивен (компонент размонтирован).

Транзиентный лоадер «останавливаю процесс…» при hard-kill из Правки/Повтора: `claude-sdk:stopping` window-event → и индикатор, и статус-строка композера показывают его ~1.2с (гаснет по таймеру или когда новый ход пошёл в `работает`). Без него остановка процесса перед переписыванием истории читалась как зависание.

## Background tasks: bar + detail-pane + stream events (SDK 0.3.x)

В SDK-таб встроен живой трекер запущенных subagent'ов (Agent tool) и фоновых bash-команд. Реализация: тонкий strip-bar **под** composer'ом с chip'ами для каждого running task'а, клик по chip'у заменяет composer на 300px detail-pane (live stdout для bash, read-only mini-thread для агента через переиспользование `UserMsg`/`AssistantMsg`/`ToolCard` из основного чата). Завершённый task сразу пропадает из bar — он уже виден в main thread как обычная BashCard/GenericToolCard, дублировать его статичным chip'ом избыточно. Принцип — `methodology/переносимый-дизайн.md::Live tracker ≠ history`.

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

**Stop running task: subagent — in-process генератор, НЕ отдельный subprocess.** Критическая поправка к прежнему тексту (см. graveyard): субагент/workflow-агент исполняется как **in-process async-генератор внутри того же одного CLI-subprocess'а**, что и родитель (декомпил: `runAgent.ts` — `export async function*`, abort через `createChildAbortController`, «backgrounded» = флаг состояния `isBackgrounded`, не отдельный процесс). Поэтому `hard`-путь (`abortController.abort()` каскадит на child-контроллеры + `query.close()` рубит единственный subprocess) **убивает и субагентов разом** — отдельный per-agent kill не нужен для самого факта остановки. `stopTask(taskId)` зовём в hard-пути **до** close ради чистого `task_notification{stopped}` на каждый таск (а не ради того что иначе worker выживет). На **soft**-пути `stopTask` НЕ зовём — фоновые агенты намеренно продолжают (нативное Esc-поведение).

Сбор running task_id для hard-стопа: renderer flatten'ит и контейнер workflow-таска, и его `agents[]` в состоянии `progress`/`start` (id-space совпадает с тем что шлёт WorkflowPanel KeyX), иначе живые workflow-агенты не попадают в `stopTask`-список. Принцип — `methodology/переносимый-дизайн.md::Прервать текущий ход ≠ убить процесс`.

**«Обратный callback по завершении фона» — нативная фича, но только пока сессия жива.** Юзерская модель «остановил Claude → фоновый агент дорабатывает → присылает результат обратно» верна **для конца хода при живой сессии**: CLI придерживает `result` (`heldBackResult`), крутит drain-loop пока есть running bg-task, по завершении инжектит синтетический `<task_notification>` user-turn в тот же диалог. Но это НЕ переживает закрытие сессии: bg-агент — child-генератор, `close()`/SIGKILL единственного процесса забирает его с собой, и канала для late-notification больше нет. Reattach-API нет (`resumeAgent` читает транскрипт с диска и стартует новый query). Поэтому в нашем SDK-табе: soft Escape оставляет агента работать и его notification долетает (loop жив); hard kill / закрытие вкладки — агент мёртв, ничего не «отзвонится».

**Что пробовали и почему было неверно (graveyard).** Прежняя версия этого файла (и комментарий в коде `main.js`) утверждала: «subagent — отдельный CLI subprocess со своим Query, `close()` его не убивает, нужен `stopTask`». Это **опровергнуто** декомпилом + живым тестом (Escape мягко прерывает foreground, агенты переживают — значит они дети сессии, не автономные процессы; а hard-`close()` их забирает). Источник заблуждения — вывод по `.d.ts`-доке `stopTask` без проверки процессной модели. Зависший workflow в реальной сессии оказался не «живым runaway-процессом», а **UI-трупом**: на диске `status:"killed"`, ни одного живого процесса, просто чип в интерфейсе никто не погасил после teardown (отдельный баг реконсиляции чипов).

## TaskListPanel: табло задач текущего turn'а

Сворачиваемая карточка над composer'ом показывает TaskCreate/TaskUpdate/TodoWrite живым списком (как нативный TUI в `expandedView:'tasks'`). Источник — поток tool_use-блоков из `messages[*].parts[*]`, чистый renderer-side агрегат (`aggregateTasksFromMessages`), без IPC — все данные уже в треде.

**Scope = последний turn, не вся сессия.** Агрегатор кормится не всем `messages`, а `messages.slice(lastUserIdx)` — от последнего `role:'user'` и до конца. Без этого панель накапливала задачи за всю сессию: на длинном чате с десятками промптов набегало 141 «✓»-строка, табло превращалось в нечитаемый журнал. Юзер: *«нахуй мне отображать все задачи, которые были за сессию»*. Новый prompt обнуляет панель (как нативный Claude, где TodoWrite/TaskCreate видны пока актуальны), завершённый turn уходит в историю треда. Принцип — `methodology/переносимый-дизайн.md::Live tracker ≠ history` (временной scope живого трекера).

Агрегатор stateless и идемпотентен — гоняется заново на каждую мутацию `messages` (включая streaming-чанки), линейный проход по parts[]. `TaskCreate` резолвит реальный `Task #<id>` из tool_result (до него — stub-id `create:<tool_use_id>`), `TaskUpdate status:'deleted'` убирает строку, legacy `TodoWrite` (full-replace, шлёт весь массив) — `allDone` стирает табло целиком. `TaskList`/`TaskGet` read-only, игнорируются.

`Tab.claudeSessionId` для SDK табов **до 2026-05-18** записывался в Zustand-store через `updateSDKState({claudeSessionId})`, но **в SQLite не персистился** — `saveTabs` дёргал только `setClaudeSessionId` (PTY-табы), для SDK был обходной путь. Симптом: после `restart_process` dev-сервера или явного Electron-restart юзер открывал свои SDK-табы и видел *"Waiting for session"* в InfoPanel, хотя JSONL на диске целый. В SQLite колонка `claude_session_id` для этих табов была пустая.

Решение: в `useWorkspaceStore::updateSDKState` добавлен guard — если в патче меняется `claudeSessionId` (т.е. `sidChanged === true`), после `Object.assign(tab, state)` дёргается `saveTabs(workspace.projectId, workspace.tabs)`. Ephemeral state (`sdkState`/`sdkMessages`) save не триггерят — это спам в SQLite на каждый assistant chunk. Принцип — anti-pattern в `CLAUDE.md::Разделённые update-paths для одного persistent поля`.

**Что пробовали и почему не сработало.** Первая мысль была — добавить вызов `s.setClaudeSessionId(tabId, sid)` поверх `updateSDKState` в renderer (handleMessage SDK iterator). Не сработало: `setClaudeSessionId` имеет guard `if (tab.claudeSessionId === sessionId) return` и сбрасывает overlay-флаги (`wasInterrupted`/`overlayDismissed`) — для SDK таба эти сбросы случайны и могут схлопнуть Interrupted Session Recovery overlay вместо PTY-таба. Решение через `updateSDKState` локальнее: одно место, одно поведение, save-side effect только когда sid реально меняется.

## Repeat/Edit: идемпотентный re-send по позиции user'а

Обе кнопки (↻ Repeat — переотправить как есть, ✎ Edit — отредактировать и отправить) идут через одну функцию `truncateAndResend(uiMsgId, newText)`. Контракт: **N кликов на тот же чип сводят тред к одному и тому же состоянию** — первые N−1 user-prompt'ов остаются, N-ный переотправляется. Принцип идемпотентности и почему моделируем по позиции — `methodology/переносимый-дизайн.md::Повторный replace/destructive = идемпотентность`.

**Gate: недоступны во время стрима И пока жив фоновый агент.** Контекст `UserMsgActions.busy = actionBusy || isRunning || bgAgentRunning` дизейблит обе кнопки (серые, `cursor:not-allowed`, hover-эффекты off, клик не проходит, tooltip объясняет). Причина: truncate переписывает JSONL, а под живым процессом это портит parentUuid-цепочку — как нативный `/rewind`, который делают только между ходами, не на середине ответа. `bgAgentRunning` — гранулярный селектор `bgTasks.some(status==='running')`; Правка при живом workflow-агенте недоступна, потому что переписать историю можно только убив процесс (а это оборвёт агента). Сам hard-kill перед truncate сопровождается «останавливаю процесс…» индикатором (см. `## Процесс-индикатор`). Переносимый принцип — `methodology/переносимый-дизайн.md::Не модифицируй чужой shared append-only файл` (UI-следствие).

**Cursor disabled — условный className, не `disabled:` variant.** `disabled:cursor-not-allowed` Tailwind-вариант перебивался базовым `cursor-pointer` (одинаковая специфичность, побеждал порядок) — курсор не менялся, кнопка выглядела активной. Лечение: курсор/hover/opacity гоним через тернарник по `actions?.busy`, не через `disabled:`-вариант.

**Адресация — позиция user'а, не msgId.** В renderer считаем `userPos` = сколько `role:'user'` сообщений идёт **до** кликнутого в `messagesRef.current`. Это инвариант: после re-send тот же визуальный prompt получает новый placeholder-id, но его порядковый номер в треде не меняется. Передаём `claude-sdk:truncate-history { sessionId, userPosition }` — main строит активную ветку (тот же parentUuid-backtrace что в Timeline), находит N-ный `type:'user'`-record (пропуская sidechain и `parent_tool_use_id` — subagent-prompt'ы не в счёт) и сносит его + всё после inclusive. Затем `send-message resume` дописывает свежий turn от обрезанного tip'а. Старый `targetUuid`-режим (+ legacy `truncateAfter`) в хендлере остался для обратной совместимости, но Repeat/Edit его больше не используют.

**Что пробовали и почему не сработало (3 итерации, каждая со своим шрамом).**

1. *Развилка persisted/placeholder по `isPersistedMsgId`.* Persisted → truncate JSONL по uuid, placeholder → пропуск truncate, local-only срез. Сломалось на **повторном клике**: после первого re-send тот же prompt висел с новым placeholder-id `user-<ts>` → второй клик уходил в placeholder-ветку → truncate пропускался → на диск дописывался дубликат → в Timeline 3 ответа вместо 2. Развилка по эфемерному id неидемпотентна by design. Заменено на единый userPosition-путь.

2. *Click-storm.* Гард `actionBusy`/`isRunning` — это React state, ставится через setter. Быстрые повторные клики (юзер реально кликал ~20 раз за 2с пока UI «не реагировал») все проходили с `actionBusy=false`, потому что React батчит и не успевает flush'нуть первый `setActionBusy(true)` до следующего onClick → 20 параллельных `send-message`. Лечится **синхронным** `actionInFlightRef` (useRef): флипается в первой строке хендлера до любого setState, сбрасывается в `finally`. State-гард для re-entry бесполезен, нужен ref. См. `methodology/переносимый-дизайн.md::State-mirror через useState+useEffect`.

3. *Loader-stomp.* Лоадер (`sdkState`) пропадал на 2-м клике. Причина: `truncateAndResend` ставил `setIsRunning(true)` + `sdkState:'fetching'` **до** `await claude-sdk:stop`. `stop` на main делает `query.close()`, что эмитит `claude-sdk:done` → renderer-handler `handleDone` гасит `isRunning=false` + `sdkState:'idle'` поверх только что выставленного fetching. На первом клике stop не звался (`has-active-session=false`) и баг не проявлялся. Лечение — выставлять loader **после** stop+truncate, прямо перед send: к этому моменту late `done` от закрытого query уже отработал.

Невидимая связь: `onRepeat` нельзя писать как `setMessages(prev => { truncateAndResend(prev.find().text); return prev })` — outer-updater вернёт `prev` и затрёт оптимистичный trim из inner-setMessages. Читать текст через `messagesRef.current`. См. `methodology/переносимый-дизайн.md::React StrictMode`.

Action-bar (↻/✎) показывается и для `user-*` placeholder'ов тоже (`showActions = isPersisted || isPlaceholderUser`) — чтобы упавший `send-message` (нативный бинарь не нашёлся `fix-sdk-asar-spawn.md`, MCP-токен сорвался, network 5xx) оставлял retry-точку, а не висячее сообщение без кнопок. Юзер: *«слева от сообщения в паре пикселях должна быть кнопка либо «отредактировать», либо «перезагрузки», чтобы переотправить промпт»*. Принцип — `methodology/переносимый-дизайн.md::Failed optimistic-action оставляет retry-точку в UI`.

## Hex chip подсветка в `AssistantTextPart`

Hex-цвета (`#FFF` / `#DA7756` / `#DA775680`) в ответе ассистента оборачиваются в chip со своим `background-color` и контрастным `color` по YIQ-формуле — юзер просил «менять bg текста под цвет где решетка и 6 символов», чтобы цвет считывался глазом, а не ментально декодировался. Реализовано не через кастомный `code` mapper в `ReactMarkdown` (тот видит только ``…``), а через rehype-плагин — основной кейс это **plain text** ассистента (`#DA7756` без backtick'ов), его mapper'ом не дотянуться. Поэтому подсветка работает одинаково в plain `<p>`, inline-code и в блочном коде (CSS/SCSS включительно — «без разницы какая будет разметка, нужно отображать background»).

Единственное исключение — `language-diff` блоки: там +/- и токены имеют собственную смысловую раскраску, юзер сам её и формулировал («исключение только сделать сообщение которое не текстовое, например diff»). Плагин по `className === 'language-diff'` пропускает text-узлы без замены.

Невидимая связь с code-mapper'ом: после плагина внутри блочного `<code class="language-*">` `children` уже **React-tree** с `<span data-hex-chip>` обёртками, а не строка. Прежний паттерн `String(children).replace(/\n$/, '')` отдавал бы `SyntaxHighlighter` мусор со `[object Object]`. Решение — рекурсивный `extractRawText(children)` который проходит по дереву и собирает только text-leaves. Реализация: `src/renderer/components/Workspace/ClaudeSDK/rehypeHexHighlight.ts` и `extractRawText` в `ClaudeSDKTab.tsx` рядом с `AssistantTextPart`.

## Code map: background tasks

- `src/main/main.js::sdkStartQuery` → `options.agentProgressSummaries:true` + `options.forwardSubagentText:true`. Без них iterator получает только start+end events для subagent'ов.
- `src/main/main.js::ipcMain.handle('claude-sdk:stop', {hard})` → SOFT: только `await session.query.interrupt()` (+ tail-read для durable-маркера), сессия/loop/фон живут. HARD: `stopTask` каждого running + `abort()` + `channel.end()` + `query.close()` + delete. `userInterrupted` флаг глушит ожидаемый `error_during_execution`-результат и throw на обоих путях. Субагенты — in-process дети, `close()` их забирает (НЕ отдельные процессы). Новый `claude-sdk:warm-start` (`prompt:null`) поднимает процесс idle с `resume`. См. `## Soft interrupt vs hard kill`.
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx::handleMessage` → 5 новых case'ов на `system:task_*` + `tool_progress`. Фильтр subagent leak'а `(user|assistant) && (parent_tool_use_id || subagent_type) → return` до того как чанк попадёт в `streaming-<tabId>` placeholder. Фильтр child bash в `task_started`: `task_type === 'local_bash' && !subagent_type → return`.
- `src/renderer/components/Workspace/ClaudeSDK/BackgroundTasksBar.tsx` — strip-chip bar под composer'ом, видим только когда `bgTasks.filter(running).length > 0`. Auto-close detail-pane'а через useEffect когда expandedTaskId уходит из running списка.
- `src/renderer/components/Workspace/ClaudeSDK/TaskDetailPane.tsx::AgentDetail::messagesWithPrompt` → prepend synthetic user-bubble из `task.initialPrompt` если JSONL ещё не флашнут (или вернул пустой массив user-сообщений).
- `src/renderer/components/Workspace/ClaudeSDK/sdkHistoryParser.ts::parseSubagentMessages` — выделенный helper из `ClaudeSDKTab::loadHistory` чтобы pane'овский AgentDetail переиспользовал тот же JSONL-парсер.
- `src/renderer/store/useWorkspaceStore.ts::updateSDKState` → `if (sidChanged) saveTabs(workspace.projectId, workspace.tabs)` — без этого SDK таб теряет `claudeSessionId` после Electron restart.
- `src/main/main.js::resolveClaudeBinaryPath` → один helper для всех трёх SDK-входов (`loadSdkModelCapabilities`, `sdkStartQuery`, `claude-sdk:probe-commands`). Резолвит путь к native `claude`-бинарю, переписывает `app.asar/` → `app.asar.unpacked/`, отдаёт через `options.pathToClaudeCodeExecutable`. Без этого packaged-сборка падает по `ENOTDIR` в `child_process.spawn`. См. `fix-sdk-asar-spawn.md`.
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx::truncateAndResend` → единый путь по `userPosition` (счёт `role:'user'` до кликнутого в `messagesRef`). Синхронный `actionInFlightRef` против click-storm; loader (`fetching`) ставится после `await stop`, не до. См. `## Repeat/Edit` про 3 шрама (persisted/placeholder развилка, storm, loader-stomp).
- `src/main/main.js::ipcMain.handle('claude-sdk:truncate-history')` → принимает `userPosition` (N-ный `type:'user'` в активной ветке, inclusive cut) ИЛИ legacy `targetUuid` (+`truncateAfter`). userPosition идемпотентен между повторными Repeat-кликами, targetUuid — нет (id меняется после re-send).
- `src/main/main.js::ipcMain.handle('claude-sdk:has-active-session')` → лёгкий предикат `{active}` для renderer: нужно ли звать stop перед resend.

## AskUserQuestion via canUseTool (интерактивный вопрос в SDK-табе)

В **PTY** интерактивный диалог `AskUserQuestion` рисует сам Claude (Ink-TUI), input при этом перекрыт. В **SDK диалог рисуем мы** — SDK отдаёт вопрос через `options.canUseTool` callback, и хост обязан вернуть ответ. Без обработки вопрос в SDK-табе авто-резолвится (под `bypassPermissions`) и юзер не может ответить.

### Почему canUseTool срабатывает даже под bypassPermissions
SDK-таб стартует с `permissionMode:'bypassPermissions'`. Казалось бы, bypass должен пропускать все permission-промпты мимо `canUseTool`. Но `AskUserQuestion.requiresUserInteraction() === true`, а в резолвере CLI (`packages/claude-code-src/utils/permissions/permissions.ts`) гард `requiresUserInteraction` возвращает `behavior:'ask'` на шаге 1e — **до** bypass-short-circuit (шаг 2a). Поэтому вопрос НЕ глотается bypass'ом и маршрутизируется в наш callback. **Менять `permissionMode` НЕ нужно** — достаточно самого факта наличия `canUseTool`: SDK тогда спавнит CLI с `--permission-prompt-tool stdio` (control-protocol маршрут). **Нельзя** одновременно ставить `permissionPromptTool` — взаимоисключающи, SDK кидает исключение.

### Архитектура (event-driven, без таймаутов)
```
SDK iterator → main canUseTool('AskUserQuestion', {questions}, {toolUseID, signal})
  → НЕ AskUserQuestion → {behavior:'allow', updatedInput:input}  (no-op bypass для всех прочих тулзов — без регрессии)
  → AskUserQuestion:
      pendingQuestions.set(`${tabId}:${toolUseID}`, {resolve, signal, onAbort})
      send 'claude-sdk:ask-question' {tabId, toolUseID, questions}
      send 'claude:awaiting-input' {awaiting:true}   ← переиспользуем фиолетовый glow (PTY-фича)
      return await new Promise(resolve => …)          ← ПАРКУЕТСЯ, таймера нет ни у нас, ни у SDK
  ↓ renderer
ClaudeSDKTab: setActiveQuestion({toolUseID, questions}) → <SDKAskQuestion> ЗАМЕНЯЕТ <SDKComposer>
  (footer-тернарник, activeQuestion — outermost arm → печатать нельзя, как в PTY)
  ↓ юзер ответил / стоп
invoke 'claude-sdk:answer-question' {tabId, toolUseID, questions, answers, stop}
  ↓ main
  answer → resolve({behavior:'allow', updatedInput:{questions, answers, annotations?}})
  stop   → session.userInterrupted=true; resolve({behavior:'deny', message, interrupt:true})
  send 'claude:awaiting-input' {awaiting:false}
```

### Ключевые инварианты (легко сломать)
- **`updatedInput` ПОЛНОСТЬЮ заменяет input** (`queryHelpers.ts` — без merge). Поэтому в allow обязательно **эхо `questions`** обратно: strict-схема тула требует `questions.min(1)`, `{answers}`-only невалиден на `tool.call`. Ответы — `answers: Record<questionText, label>`, multiSelect — join через `", "` (запятая+пробел, как в `outputSchema`).
- **stop = `deny`+`interrupt`** прерывает turn через `abortController.abort()` (PermissionPromptToolResultSchema), а **не** через `claude-sdk:stop`-хендлер → `session.userInterrupted` остаётся false → существующее подавление `error_during_execution` (`main.js` result-handler) НЕ сработает → юзер увидит красный error-toast. **Лечение:** в `answer-question` при `stop` ставим `session.userInterrupted=true` ПЕРЕД resolve. Переиспользуем существующую interrupt-машинерию, не дублируем детекцию (CLAUDE.md anti-pattern).
- **Leak/hang guard:** на каждом выходе `canUseTool` promise обязан зарезолвиться. Сайты: (1) answer, (2) stop — через IPC-хендлер; (3) `signal.abort` (turn оборвался иначе) — `onAbort` резолвит `deny` без interrupt; (4) stream `finally` — проходит `pendingQuestions` по `tabId`, резолвит `deny` (закрытие таба / смерть процесса). Пропустишь любой → SDK-процесс висит вечно (таймера нет).

### Tab-switch НЕ теряет диалог
SDK-табы **не unmount'ятся** при переключении — скрываются через `display:none` (`ClaudeSDKTab.tsx`, Virtuoso mount-gating, `isVisible = active && isActiveProject`). React-state `activeQuestion` переживает переключение, диалог возвращается на switch-back. **Rehydrate-handler не нужен** (в черновике плана была ложная посылка про unmount — отвергнута верификатором по `TerminalArea.tsx::workspace.tabs.forEach`).

### Glow off для SDK
`claude:awaiting-input` consumers (App.tsx, TabBar) keyed по `tabId`, generic. Авто-сброс `awaiting⊆busy` слушает `claude:busy-state`, который SDK форвардит из `claude-sdk:busy-state` (`main.js`), плюс явные `awaiting:false` на каждом выходе canUseTool — двойное покрытие.

### UI (`SDKAskQuestion.tsx`)
Навигация как в Ink: ↑↓ — опции вопроса, ←→ — между вопросами + Submit-вкладка, Enter — выбор/submit, Esc — стоп. Верхний nav-bar: чипы `☐ Header / ✔ Header` (✔ когда отвечено) + `Submit`, обрамлён `← →`. Submit-вкладка («Review your answers» + «не на все вопросы ответили») **только при ≥2 вопросах**; один вопрос — Enter сразу сабмитит. multiSelect → `☒/☐`, single → `◉/○`. **«Type something»** оставлен = **стоп** (deny+interrupt + фокус в композер для ручного ввода — продуктовое решение юзера, НЕ инлайн free-text как в нативном Claude). **«Chat about this» убран**. Preview опции (markdown/ascii-box) рендерится `<pre white-space:pre-wrap>` под single-select опциями.

### Известные ограничения
- **Хуки/опции читаются при старте сессии** — фича подхватится только на **рестарт SDK-процесса** (новый таб / `--resume`). Уже запущенный SDK-таб не получит `canUseTool` пока процесс жив.
- **Resume сессии с висевшим вопросом:** `pendingQuestions` живёт только в памяти main. После рестарта пусто, в JSONL — `tool_use` без `tool_result` (неотвеченный тул), Claude обычно переспрашивает на следующем turn'е. Ничего особого не делаем.
- **mobile-web вне scope:** диалог не рендерится на телефоне; протокол пробрасывается (`_webBroadcast {type:'ask-question'}`), но мобильный клиент висит в «running» пока десктоп не ответит/не остановит. Отдельная фича.
- **Runtime gate:** load-bearing допущение (`canUseTool` fires под bypass) подтверждено из декомпила, но финальная проверка — живой лог `[ClaudeSDK] canUseTool fired tool=AskUserQuestion` на реальном turn'е после рестарта main.

**Code map:**
- `src/main/main.js::sdkStartQuery options.canUseTool` — park + emit (scoped на AskUserQuestion, иначе auto-allow).
- `src/main/main.js::ipcMain.handle('claude-sdk:answer-question')` — resolve allow/deny+interrupt, `userInterrupted` на stop.
- `src/main/main.js` stream `finally` — cleanup parked questions по tabId.
- `src/renderer/components/Workspace/ClaudeSDK/SDKAskQuestion.tsx` — UI диалога.
- `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx` — `activeQuestion` state, `ask-question`/`question-cancelled`/`done` listeners, `answerQuestion` helper, footer-arm, focus-composer на stop.
