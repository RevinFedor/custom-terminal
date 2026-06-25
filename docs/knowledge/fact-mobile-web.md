# Fact: Mobile / Project Terminal API

Этот файл про **общий REST/SSE contract Project Terminal API**, а не про актуальный React-клиент. `mobile-web/` — legacy SPA и сейчас не используется как пользовательский iOS-клиент; production iOS surface — нативный Habit Tracker Terminal mode (`/Users/fedor/Desktop/vs-code/habit-tracker`). Название файла историческое: здесь остаются серверные endpoint'ы, bridge-инварианты и legacy-шрамы, потому что ими пользуются и старый web-клиент, и native iOS.

Параллельный режим работы с проектными terminal-вкладками через native iOS и старый mobile-web. Сервер живёт в main process Electron (port 7878), canonical REST для Claude/Codex PTY — `/api/terminal-tabs/:tabId/*`. Старые `/api/projects/:id/sdk-tabs` и `/api/inbox/sdk-tabs` относятся только к созданию legacy Claude SDK tab; они не являются именем Project Terminal API.

## Почему НЕ cloud-хостинг

`query()` из `@anthropic-ai/claude-agent-sdk` запускает Claude Code subprocess **локально** с `cwd: project.path`, читает файлы пользователя, пишет JSONL в `~/.claude/projects/<slug>/`. На удалённой машине этот процесс не имеет доступа к локальной FS пользователя — а это и есть главный value (работа с реальными проектами с телефона). Поэтому сервер обязан быть локально, на том же устройстве где запущено приложение. Trade-off: ПК должен быть включён и в той же Wi-Fi что телефон.

## Bridge pattern: main ↔ renderer

Часть REST-эндпоинтов требует **живого renderer state** (Zustand store с открытыми проектами и табами). Main не имеет доступа к store напрямую. Решение — request/reply IPC bridge:

1. Main: `bridgeRequest(action, payload, timeoutMs=5000)` спавнит `requestId`, шлёт `web:bridge-request` в renderer, ждёт ответа на `web:bridge-reply` с тем же id.
2. Renderer: один listener в `App.tsx` диспатчит по action — `getOpenProjectIds`, `createSDKTab`, `sendSDKMessage`, `loadSDKHistory`, `forkToSDK`, `closeTab`, `renameTab`, `renameProject` (мобильный rename проекта → `useProjectsStore.updateProject{name}`), `getSDKParams`, `setSDKParams`, `getTabSessionInfo`, `getAppSettings`, `setAppSettings`. Расширение для PTY+Claude/Codex: `createClaudeTab` (legacy wrapper), `createAgentTab` (generic PTY agent), `resumeClaudeTab`, scenario-actions `sendAgentPromptScenario` / `stopAgentProcessScenario` / `interruptAgentTurnScenario` / `grabAgentDraftScenario` / `inspectAgentDraftScenario` / `rewindAgentTimelineScenario` с legacy aliases (`sendMessageAuto`, `stopClaudeTab`, `interruptClaudeTurn`, `grabAgentDraft`, `inspectAgentDraft`, `rewindAgentTimeline`), `getClaudeTabStatus`, `getClaudeTabStatusBatch`, `getProjectTabsLive` (отдаёт `sessionStatus`, project `icon`, `statusMarker`). Детали — `fact-mobile-claude-pty.md`.
3. На таймауте promise rejected — endpoint возвращает 409.

**Критично:** bridge нужен ТОЛЬКО для actions, требующих store. Чисто-серверные operations (timeline parse через `parseTimelineEntries`, projects list из SQLite через `projectManager.db.getAllProjects()`) идут напрямую без bridge — это и быстрее, и работает даже если renderer mounted с задержкой.

Transcript operations теперь отдельный pure-server слой: Timeline/History snapshots и Codex mobile messages идут через `SessionTranscriptService`, а не через renderer bridge и не через per-client polling. Bridge остаётся для tab/store actions; durable transcript read/invalidation принадлежит main process, потому что тем же данным пользуются desktop Timeline, Cmd+\ HistoryPanel, Project Terminal API и native iOS. См. `fact-transcript-сервис.md`.

Слой terminal primitives остаётся ниже API: нажать клавишу, вставить текст, остановить процесс, прочитать TUI draft/JSONL. Project API (`/api/terminal-tabs/:tabId/*`), History/iOS и Inbox API не должны заново собирать send-during-streaming, stopped-session rewind или draft-conflict из этих примитивов; web-server вызывает scenario-action, а тот уже доказывает readiness, решает ownership draft и ждёт durable terminal signal. Это защищает будущий iOS/History переход: при смене парсинга xterm/PTY или момента JSONL-audit внешний контракт меняется только если меняются сами статусы/поля API, а не из-за внутренней механики отправки.

## Synthetic user-message broadcast

Когда mobile шлёт `POST /api/terminal-tabs/:id/send`, main вызывает `sendAgentPromptScenario`. Для Claude/Codex PTY реальная user-запись в JSONL/rollout появляется **позже**, когда terminal runtime durable-примет prompt; для legacy SDK это всё ещё может пройти через `sdkStartQuery`. Phone не должен ждать durable-запись, чтобы показать локальный handoff, но durable JSONL/rollout остаётся источником истины для замены optimistic bubble.

Решение: при старте query main **сам** бродкастит synthetic message всем WS-подписчикам tabId:
```js
_webBroadcast(tabId, {
  type: 'message',
  message: {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    __webSynthetic: true,
  },
});
```
Это event летит ТОЛЬКО на WS — десктопный renderer его не видит (не подписан). Десктоп получает свой user-bubble через локальный `onNew` композера.

**Edge case:** когда отправка пришла **с phone**, десктоп `onNew` не вызвался. Renderer-bridge handler перед `claude-sdk:send-message` диспатчит CustomEvent `claude-sdk:external-prompt` — ClaudeSDKTab слушает и пушит свой user-bubble в локальный `setMessages`. Без этого десктоп показывал ответ Claude но не сам запрос.

**Mobile-side guard:** phone reducer **игнорирует** `__webSynthetic: true` входящие messages — иначе на phone был бы дубль user-bubble (synthetic + real-record когда дойдёт). Phone получает мгновенный feedback через **локальный optimistic push** в `send()` — `reducer.apply({type:'user', message:..., __pendingLocal: true})` сразу. Когда real-record прилетит из WS, dedupe-функция `adoptOrPush` в reducer находит последний user-bubble без uuid с тем же текстом и **adopt'ит** real uuid в существующую entry, не создаёт новую.

Тот же инвариант теперь обязателен для History и native iOS: локальная user-row появляется **до** ожидания `sendAgentPromptScenario`/JSONL audit со статусом `sending`, после принятия API может стать `sent/queued`, а durable JSONL/rollout row только adopt'ит её. Tool/MCP/thinking entries — это metadata следующего agent turn'а, не delivery feedback для пользовательского prompt'а. Пользовательский симптом нарушенного handoff'а: после Send первым видимым элементом становится `MCP`/`thinking`, а своего сообщения со статусом `sending` нет.

Если между локальным `sending` и durable row приходит canonical `/history` reload, клиент обязан смерджить pending handoff обратно в publish. Иначе heavy reload стирает optimistic user-row, и UI выглядит так, будто prompt исчез или заменился tool-событием. Source of truth всё равно durable transcript: локальный handoff живёт только до matching user entry / failed / cancelled.

Busy-send и Stop во время streaming имеют ещё один промежуточный случай: сервер может прислать queue-operation / handoff-ack раньше, чем canonical history reload увидит durable user-row. Для iOS это не момент снятия `queued/sending` с локальной строки. Маркер остаётся на месте до matching durable row, проверенного consumed-state или явного cancel; иначе пользователь видит старый prompt уже без очереди, а через секунду он "телепортируется" в конец истории. Логовая строка `handoff materialized` на queue-operation сама по себе означает только, что handoff принят сценарным слоем, а не что визуальная история уже догнала JSONL/rollout.

`thinking` — отдельная семантическая строка, а не tool-card. Pending `tool_use` без результата можно скрыть или дождаться результата, но нельзя на один кадр превращать thinking в `MCP thinking` с badge, chevron или раскрытием справа. Completed tool rows могут быть отдельными раскрываемыми карточками; этот contract не распространяется на thinking, потому что для пользователя это статус размышления агента, а не объект инструмента.

## History loader: НЕ getSessionMessages

`getSessionMessages` из Anthropic SDK возвращает **другой набор записей** чем `parseTimelineEntries` — uuids не пересекаются. Если history грузить через SDK-helper, GoTo из timeline (использует timeline uuids как anchors) никогда не находит цель. См. [`fix-mobile-history-uuid-mismatch.md`](fix-mobile-history-uuid-mismatch.md).

Решение: новый IPC `claude-sdk:active-branch-messages` читает JSONL напрямую, walks active branch (тот же алгоритм что в `parseTimelineEntries`), возвращает **все типы** в chain order — user, assistant, tool_use, tool_result. Mobile reducer обрабатывает их так же как стрим. Anchors совпадают.

## Slash-чип / compact-summary / XML wrappers в mobile reducer

Mobile receiver получает тот же поток raw SDK-сообщений что и десктоп — значит видит **все CLI/SDK-инъекции** которые на десктопе разруливаются в `ClaudeSDKTab` парсере: служебные XML-обёртки, slash-команды как user-bubble, compact-summary records с metrics. Без специальной обработки в mobile reducer'е (`mobile-web/src/messages.ts`) юзер видит сырой `<command-name>/compact</command-name>` как обычное сообщение, `<local-command-stdout>Compacted</local-command-stdout>` как user-реплику, а compact summary без оранжевой карточки и метрик.

Распознавание в `apply()` reducer'а:
- `type:'system' && subtype:'compact_boundary'` — стэшится `pendingCompactMetrics` (preTokens / postTokens / durationMs), сама запись не рендерится. Метрики прицепятся к следующей user-записи с compact-summary флагом.
- `<command-name>X</command-name>` + optional `<command-args>` → `kind:'slash'`, рендерится как фиолетовая (`rgba(129,140,248,*)`) compact-пилюля справа, моноширный шрифт, `userSelect:none`. Точная копия desktop UserMsg isSlashCommand-ветки.
- `<local-command-stdout>` / `<local-command-caveat>` / `<system-reminder>` / `<tool_result>` / `[tool_result]` → drop. CLI-артефакты, не пользовательский текст.
- `isCompactSummary === true` (authoritative SDK-флаг) или text начинается с `'This session is being continued from a previous conversation'` (fallback для старых сессий) → `kind:'compact-summary'`, прицепляются метрики из `pendingCompactMetrics`. Рендерится как orange-card (`#DA7756` border + bg `rgba(218,119,86,0.06)`), заголовок «COMPACT SUMMARY», метрики `preTokens → postTokens · Ns` моноширно, collapsible body с 600-char preview (`COMPACT_PREVIEW_CHARS`).
- `maybeSwapCompactPair()` — после push'а compact-summary или slash-чипа в `state.entries` пробует swap последних двух элементов если они `[compact-summary, slash('/compact')]`. JSONL пишет summary ДО следующей `<command-name>/compact</command-name>` записи, визуально chip должен быть выше — юзер ввёл команду, потом SDK сделал summary.

Dedup для slash/compact работает через `entryUuid` — WS replay после optimistic local apply не плодит дубликаты.

## Paste-chip flow на мобилке + EntryView как адаптер к пакету

Мобилка получила **полный paste-chip flow** — зеркало desktop SDK (порог 500, чип-бар над композером, tap → preview, `<pasted_content>`-обёртка каждого чипа при отправке, `UserText`-разбор обёртки в user-бабле). Раньше мобильный composer не имел `onPaste` вообще: длинный текст вваливался в textarea, `send()` слал сырьё, бабл рендерил его без разбора. Send активен при наличии чипа даже с пустым текстом (bare-paste = валидный промпт, как на десктопе).

Весь визуал строки чата теперь рисует `@noted/claude-blocks::ChatMessage` (см. `fact-claude-blocks-package.md::ChatMessage`). Мобильный `EntryView` стал **тонким адаптером**: `uiToChatEntry(UiEntry) → <ChatMessage ctx={mobileRenderCtx}>`. Все прежние per-kind карточки (`UserText`/`ThinkingCard`/`ToolCard`/`CompactSummaryCard`/`CollapsibleText`/`Markdown`-wrapper, ~150 строк) **удалены** — их форма ушла в пакет. `mobileRenderCtx` инжектит collapse-контроллер: `isOpen` читает persist-карту `_entryExpanded`, `toggle` оборачивает в `stickToggle` (bottom-stick) + глобальный re-render через `bumpGlobalToggle`/`useGlobalToggle` (virtua держит в DOM только видимые ряды, перерисуются лишь они). Бабл юзера при переезде перекрашен `#1f3a5f` → Claude-оранж (canon — десктоп). Под капотом lifecycle (SSE/JSONL/kill) остаётся у мобилы — пакет его не касается.

## File-tab Markdown preview bottom-sheet

File-tabs на mobile — это не chat route. Если `tabType === 'file'`, tap по строке должен открыть read-only preview sheet поверх списка проекта, а не вести в `ChatView` с пустым сообщением «No Claude session attached». Это тот же mental model, что у attached-chip preview: пользователь хочет быстро подсмотреть документ и вернуться к списку табов.

Контракт данных: `/api/projects/:id/tabs` отдаёт `filePath` для file-tab'ов. `cwd` остаётся рабочей директорией/legacy fallback и не должен использоваться как canonical file path, иначе сервер получит directory и вернёт `not a file`. Чтение файла идёт через `POST /api/file-preview {path}` прямо в `web-server.js`: absolute path required, `stat.isFile()`, cap 1MB, `utf8` read, ответ `{path,name,ext,size,content}`. Bridge в renderer тут не нужен — preview читает файловую систему, а не Zustand state; это быстрее и работает даже если renderer ещё не ответил на bridge.

UI: `MarkdownFileSheet` — bottom-sheet с backdrop, drag handle и swipe-down dismiss (`dragY` threshold), header filename/path/size и внутренний scroll для body. Рендер Markdown на mobile использует `@noted/claude-blocks::Markdown`, а не desktop `@gt-editor/markdown-editor`: mobile уже тащит chat Markdown renderer, а desktop editor heavy/local-file dependency не нужна в phone bundle. Если file-tab принадлежит группе, отдельной логики не требуется: server уже отдаёт тот же tab row с `groupId`, а preview открывается по `filePath` независимо от группировки.

## ParamsSheet (model/effort/think) — close-on-select + invisible-intent источники

Хедер-пилюля `model · effort ▾` открывает bottom-sheet `ParamsSheet` (SDK,
PTY-Claude и PTY-Codex табы). Четыре неочевидных факта:

- **Select = loader-in-pill → close по применению (НЕ по сырому тапу).** Тап по
  опции помечает её busy (спиннер на месте, `cursor: wait`), соседи тускнеют и
  блокируются (`busyKey`), и sheet закрывается **по резолву** `Api.setParams`;
  на reject — спиннер снят, sheet остаётся для повтора. Переносимый принцип —
  `methodology/переносимый-дизайн.md::Async single-select`. Предпосылка к этому —
  iOS touch-retarget: на iOS Safari тап по внутренней `<button>` баблится так,
  что голый `onClick={onDismiss}` на backdrop'е тоже срабатывал → выбор любого
  Model/Effort/Thinking **мгновенно** закрывал sheet (до применения, и SDK и PTY).
  Guard `onClick={(e) => { if (e.target === e.currentTarget && !busyKey)
  onDismiss(); }}` — закрытие только по тапу в сам backdrop, и только когда не
  busy. Браузерный синтетический click (десктоп) баг НЕ воспроизводит — нужен
  реальный тач, ловить живьём на телефоне.
- **Effort/Think для PTY = invisible-intent через window-карты.** PTY-Claude не
  транслирует effort/think обратно. `getSDKParams` (renderer-bridge в `App.tsx`)
  читает effort из `window.__effortSentForTab` (`{level}`, set'ится auto-inject'ом
  и ручными кликами, чистится на смерти Claude — см.
  [`fact-claude-tui-control.md::Auto-inject /effort`](fact-claude-tui-control.md)),
  think — из `window.__thinkStateForTab` (`Map<tabId,bool>`, default ON, пишется
  десктопным `toggleThink` И мобильным `setSDKParams`). Absent effort → `'?'`
  (а не врущее `high`). Это та же модель что десктопный ControlBar показывает в
  `effortLocal`/`thinkLocal` — единый cross-client источник, не пересчёт.
- **Codex params = tab-scoped intent + safe live apply.** Для Codex `getSDKParams`
  отдаёт `tab.codexModel/codexEffort` с fallback на app defaults, а `setSDKParams`
  ведёт себя как desktop ControlBar: если живой Codex idle и xterm-probe безопасен,
  применяет выбор через `codex:select-model-effort`; если Codex занят, input-state
  неизвестен или picker не подтвердился — возвращает ошибку и НЕ меняет tab-state,
  чтобы phone/desktop не показывали модель, которую TUI не получил. Если живого
  Codex нет, запись сохраняется как future intent на вкладке и пойдёт в следующий
  launch args.
- **Think — одна toggle-пилюля, не on/off-пара.** Mirror десктопной Think-кнопки:
  `Think ON`/`Think OFF`, тап флипает. Для PTY каждая смена шлёт
  `claude:toggle-thinking` (meta+t флип), и **только** если запрошенное состояние
  отличается от трекнутого (picker — toggle, не setter; повторный тап того же
  значения = no-op). Для SDK — `sdkThinking` boolean в Tab.

## Prompt Queue ("Run after") — mobile mirror, НЕ второй движок

Мобильная панель Run-after (иконка в правом верхнем углу хедера, рядом с timeline-бургером) — **зеркало** десктопного `PromptQueueOverlay`, не самостоятельная фича. Ключевой инвариант: **мобилка не владеет очередью**. Единственный источник правды — десктопный `usePromptQueueStore`, единственный движок исполнения — App-root синглтон `usePromptQueueRunner` (см. `fact-prompt-queue.md`). Мобилка только (1) читает live-core и (2) шлёт мутации; стрельбу промптов делает десктоп. Это та же модель, что у effort/think window-карт (мобилка — тонкий remote, не второе хранилище) — и прямое следствие принципа CLAUDE.md «переиспользуй существующий код, не переизобретай».

**Три канала (read / write / live), все через bridge:**
- **Read:** `GET /queue` → bridge `getPromptQueue` → renderer сериализует `serializePromptQueueCore(getQueue(tabId))` + список sibling AI-табов (для pivot-пикера «on tab», тот же предикат что десктопный `RunAfterTabPicker`: SDK / PTY-claude+sessionId / gemini+sessionId, self исключён).
- **Write:** любой контрол → `POST /queue {op,args}` → bridge `mutatePromptQueue` → вызывает **тот же store-метод** что десктопный оверлей (`addPrompt`/`updatePrompt(enabled)`/`setAutoRun`/`setStopAfter`/`setCloseAfter`/`setRunAfterTab`/`setFirstDelaySeconds`/`setPostPrompt*`/...). Все каскады (closeAfter⟹stopAfter, auto-disarm на manual empty-out по active-count, SQLite-persist, hint-arming) срабатывают идентично — мы **не реимплементим** логику очереди, только remote-invoke. Op-таблица `QueueOp` в `mobile-web/src/api.ts` — 1:1 с case-веткой в `App.tsx::mutatePromptQueue`.
- **Live:** любое изменение store (десктоп ИЛИ телефон) → `usePromptQueueWebSync` (App-root, рядом с runner) диффает per-tab core-JSON → `web:broadcast-queue` IPC → main `_webBroadcast(type:'queue-update')` → SSE → телефон обновляет мирор. `webBroadcast` no-op'ит без подписчиков, поэтому на desktop-only пути это один `JSON.stringify`+Map-дифф на мутацию и ничего больше.

**Owner = ТОЛЬКО PTY-claude (`canQueue = isClaudePtyTab`).** Runner стреляет через `claude:send-command`, а это **PTY-TUI paste** (`terminals.get(tabId)`, no-op на SDK-табах). SDK-owned очередь никогда бы не выстрелила. Поэтому иконка очереди на мобилке доступна только на PTY-claude-табах — **точно как десктопный оверлей** (`commandType==='claude' && claudeSessionId`). SDK/gemini-табы остаются валидными **pivot-таргетами** (у них есть turn-end edge), просто не owner'ами. Если будущий код добавит SDK-owner — сначала научить runner роутить SDK-ветку, иначе тихо-немая очередь.

**Почему web-sync на App-root, не в панели:** идентично runner'у — панель unmount'ится как только юзер ушёл с Claude-таба, но телефон может смотреть **фоновый** таб. Gated-by-active-tab бродкастер замолчал бы ровно когда телефон ждёт дельту. См. `fact-prompt-queue.md::Auto-runner — singleton hook, не в overlay`.

**UI-маппинг на десктопный оверлей (bottom-sheet, не right-panel — thumb-reach, как ParamsSheet/ActionSheet):** хедер-иконка = list-глиф + violet `[N]` когда armed; `[N]` считает только enabled items, как desktop. При открытой панели становится ✕ (закрывает и панель, и редактор). Две колонки настроек: левая — pivot «on tab» + delay-секунды; правая — Run after (violet) / Stop after split с power-иконкой Close-after (red) / Post split с карандашом. Список очереди (≈5 строк, потом скролл), тап по строке или «+ Add» → инлайн-редактор (Mirror Editing, ≈5 строк textarea, Save). Checkbox на строке шлёт `update(enabled)` и оставляет disabled item видимым с темно-малиновым фоном; это mirror skip-state, не mobile-only фильтр. `queue-update` SSE держит всё live без ре-фетча. Цвета — те же семантические роли что в `PromptQueueOverlay`: `#a78bfa` armed, `#8b5cf6` pivot-target, `#DA7756` stop/post, `#ef4444` close.

**Prod требует `build:install`** — `App.tsx::handleWebBridge` (новые actions) и `web-server.js` (новые routes) живут в asar; mobile-web Vite-dev итерирует только фронт. См. «Stale prod-app → silent bridge timeout» ниже.

## Native clients share the REST/SSE contract

`mobile-web` больше не основной потребитель этого сервера. Нативный iOS-клиент Habit Tracker (`fact-voice-chat-tab.md::Terminal mode`) ходит в те же REST/SSE endpoints и рисует Terminal сам на SwiftUI; React `mobile-web/` оставлен только как legacy/debug surface и не является целевым клиентом. Это не вторая модель terminal-control: source of truth остаётся в custom-terminal renderer/main, а native app только отображает снапшоты и шлёт команды.

App-level settings тоже принадлежат desktop app-state, а не каждому клиенту отдельно. Mobile-web settings sheet читает/пишет `streamerMode` через `/api/app-settings` → renderer bridge `getAppSettings/setAppSettings`; это тот же флаг, который скрывает desktop remote URL chip. Клиент может иметь локальный redaction fallback для собственного host-label, но если он управляет Noted Terminal state, запись должна идти в desktop app-state, иначе phone и desktop начнут расходиться: на телефоне включён privacy, а desktop продолжает светить URL в stream.

Следствие для контракта: всё, что native UI не может честно вывести из файлов на диске, должно приходить по API уже нормализованным. Project icon (`project.icon`), назначенный status marker (`statusId/statusColor`) и форма/размер marker (`statusMarker:{shape,sizePx}`) передаются сервером, потому что palette и настройка живут в desktop `useUIStore`, недоступном iOS. Runtime `sessionStatus` остаётся отдельным полем: это busy/active/inactive/starting/stopping процесса, а не user-assigned категория. `starting` — first-class runtime status: вкладка уже поднимает Claude/Codex, но composer ещё не input-ready, поэтому native не должен показывать обычный input или вручную выводить Resume. `stopping` — такой же first-class transitional status: stop уже принят, но exit ещё не доказан, поэтому native не должен показывать обычный input, Resume или Rewind до `inactive`. Клиент может по-своему резервировать место в строке или менять icon layout, но не должен смешивать эти две оси.

Для Codex `status` и SSE snapshot должны быть привязаны к актуальной runtime session после resume/start, а не к старому `sessionId`, который остался в layout metadata. Диагностический шрам 2026-06-20: iOS корректно показал `active`, потому что `/status` и SSE сами отдавали `active` для старой session, а desktop startup уже работал с новой Codex-сессией; после failed Rewind тот же API переключился в `starting`. Если native логи показывают такую цепочку, чинить нужно main/API session-binding и readiness, не iOS UI.

`GET /api/projects` для native клиентов отдаёт не просто SQLite `updated_at DESC`.
Открытые проекты сортируются по порядку `openProjects` из renderer — это тот же порядок,
в котором desktop project tabs стоят слева направо; телефон показывает его сверху вниз.
Закрытые проекты идут после открытых по freshness. Нативный клиент не должен повторно
сортировать этот ответ: порядок project tabs — пользовательская навигационная раскладка,
а не производная от времени последнего изменения проекта.

`Inbox` приходит в том же списке как system project (`isSystem:true`, `systemType:'inbox'`) и
сервер пинит его перед обычными проектами. После него обычные открытые проекты сохраняют
renderer-order; закрытые остаются архивом по freshness. Клиент может визуально разделять
`Active` и `All`, но внутри каждой группы обязан сохранять порядок, уже пришедший из API.
Не сортировать active-блок по `isActive` или `updatedAt`: это даёт пользовательский симптом
«на Mac порядок проектов нормальный, на телефоне другой», хотя bridge и `/api/projects`
работают корректно.

Изменение этого порядка — отдельный live-сигнал, не tab layout. Renderer `reorderProjects`
после `saveSession()` шлёт `project:order-changed`; следующий `project-activity` кадр несёт
`projectOrderChanged:true`, и native клиент должен тихо перезагрузить `/api/projects` после
своего quiet-window. Не пытайся кодировать новый порядок в `project-activity.projects`:
этот массив остаётся runtime-агрегатом активных проектов, а source of truth порядка —
свежий `/api/projects` через renderer bridge `getOpenProjectIds`.

Создание новых PTY-агентов для native идёт через `/api/projects/:id/agent-tabs {toolType:'claude'|'codex'}`. Этот route намеренно делегирует в renderer `createAgentTab`, но для native/API передаёт `startNow:true`: внешний клиент может никогда не смонтировать desktop `Terminal.tsx`, поэтому один `pendingAction` не запустит CLI и первый `/send` увидит `inactive/no session id`. Не заводить на iOS отдельный launch-path, который сам пишет command в PTY: запуск должен идти через общий renderer/main route, где применяются desktop guards, model/effort defaults, `starting` snapshot и session detection.

`startNow:true` означает не "tab row создан", а "PTY создан и agent launch принят". Если `terminal:create` не может открыть рабочую папку (например, проект всё ещё указывает на удалённый `/Users/fedor/Desktop/cli-tools`), route обязан вернуть structured failure (`409 working_directory_missing`) и не оставлять новый tab как будто он живой. Старый симптом: iOS открывал fresh Codex tab, видел `inactive/no session`, показывал обычный composer, первый send создавал optimistic user-row, а сервер переводил вкладку в fake `starting` без процесса. Для native fresh-agent composer разрешается только после runtime `active/inputReady`; до этого это экран запуска, а не готовый чат.

`GET /api/projects/:id/tabs` для native — это уже нормализованный layout snapshot, а не
сырой список процессов: вместе с tabs приходят `groups`, `statuses`, `statusMarker`,
`processBar`, `contextPct`, `filePath`, `groupId` и `visualParentTabId`. Нативный клиент
должен переиспользовать эту модель как mirror desktop sidebar'а. Не заводить отдельную iOS
схему групп, статусов или file-tab связей: иначе desktop DnD/status и phone list начнут
расходиться на первом же `project:layout-changed`.

Layout operations для native split'ятся от runtime activity. CRUD групп и статусы идут через
`/tab-groups/*`, reorder — через `/tab-layout` с `orderedIds`, `groupAssignments` и
`groupAnchorAssignments`; busy/loaders продолжают идти маленьким `project-activity`
snapshot'ом. Если смешать эти оси и перезагружать `/tabs` ради каждого busy-edge, phone снова
получит тяжёлые reload'ы во время навигации.

Native iOS также использует `GET /api/active-loaders` как preflight перед удалённым
`build:install`. Endpoint возвращает широкий snapshot live-состояний, но install UI блокирует
только элементы со `status=busy|running`. Важная граница: idle-alive Claude/Codex CLI — это
живой процесс в PTY, но не loader; такие tabs не должны попадать в `kind:"process"` blockers,
иначе iOS показывает ложный alert «Terminal занят» при полностью idle вкладках. AI tabs
блокируют install только через свои deterministic busy-сигналы (`claudeTurnBusy`/spinner/local
command, Codex rollout `task_started`, SDK query, Gemini busy); ordinary shell commands
блокируют через `terminalCommandState.isRunning`. Сам install endpoint при этом **не**
находится в custom-terminal — его держит Voice Record, потому что `build:install` закрывает
Noted Terminal и управляющий HTTP-сервер цели может исчезнуть в середине операции.

Native iOS Terminal transcript не должен рендерить REST history как «готовый список строк».
`/history` может вернуть 80 entries, но внутри будут tool results по 40k символов и compact
summary по 200k; если положить этот raw text в row body/diff/measurement, телефон фризит даже
без Timeline. Контракт native-клиента: сначала материализовать bounded display model
(preview, stable id, line-count/raw length, display kind), а полный payload хранить side-store
по entry id и доставать только для full sheet или явного раскрытия user prompt. Tool/bash/MCP
rows в transcript остаются стабильной высоты и открывают full sheet по tap; user prompt может
иметь inline `Show more`/`Show less`, но tap по самому prompt тоже открывает sheet с нативным
выделением текста. Счётчик справа у tool rows — строки, не payload chars: пользователь решает
«насколько большой вывод», а не отлаживает raw JSON size.

Для длинной истории native iOS грузит хвост (`last=80`) и расширяет окно вверх
инкрементально (`80 -> 160 -> 240...`). При таком prepend нельзя сохранять абсолютный
`contentOffset`: новые rows появляются выше, и старый offset начинает указывать на другой
логический текст. Перед reload клиент сохраняет первую видимую entry + delta от верхней
границы viewport, после reload восстанавливает эту же entry в той же точке экрана и повторяет
restore после self-sizing settle. Timeline в этом режиме префетчится при входе в чат; jump к
старой точке может загрузить around-target slice, закрыть drawer, проскроллить table к anchor и
коротко подсветить target row. Шрам и canary-логи: [`fix-ios-скролл-фриз.md`](fix-ios-скролл-фриз.md).

## Native iOS validation via Simulator/WDA

Simulator/WDA smoke не должен тестировать «красоту SwiftUI» отдельно от Project Terminal API:
ценность проверки в том, что один сценарий проходит через native gesture, REST/SSE contract,
runtime status и durable transcript. Рабочий baseline 2026-06-24: WDA создал Codex tab через
`/api/projects/:id/agent-tabs`, дождался `starting → active`, отправил первый prompt, увидел
`busy` в header и `In progress` loader, затем проверил completion через visible answer и
overseer/rollout. Для rollout-дедупа считать только conversation messages
(`response_item.payload.type === "message"` с role `user|assistant`); Codex `event_msg.user_message`
дублирует prompt как служебный event и не является второй строкой visible history.

Pull-to-refresh на native projects/tabs доказывается не одним screenshots. Минимальная цепочка:
`begin-drag` → `pull threshold armed=true` → `refresh begin`/`refresh pin` →
`GET /api/projects` или `/api/projects/:id/tabs` со статусом 200 →
`TerminalProjectSSE rest snapshot reason=pull-*` → `refresh end before` →
`refresh end next`. После `end-refresh` UIKit может ещё логировать `armed=true` и затем
`end-drag shouldRefresh=false` из-за deceleration/adjusted inset; это не второй refresh и не
ошибка само по себе, пока есть единственный `refresh begin` и корректный `refresh end`.

Foreground catch-up проверяется только пока turn ещё реально busy. Короткий prompt успевает
завершиться в фоне и не доказывает loader recovery. Надёжный smoke: отправить Codex prompt,
который выполняет `sleep 20`, увести Simulator в Settings на несколько секунд и вернуть
`com.habittracker.swift`. Сразу после foreground native должен показать `busy`, loader/Stop и
disabled model/effort controls; логи должны содержать `history load done reason=foreground-scene-active`
и `foreground catch-up done ... status=busy`, а после `task_complete` — `status=active`.

Если тесту нужны свежие native logs, сначала пробуй in-app `Copy Terminal and AI Chat log`.
Файлы `~/Library/Logs/voice-record/ios-chat.log` и repo-local `logs/ios-chat-latest.log` могут
быть устаревшими относительно текущего Simulator buffer; stale tail нельзя использовать как
отрицательное доказательство отсутствия `TerminalScroll`/`TerminalSSE` событий.

## Self-healing busy reconciliation (loader никогда не залипает навсегда)

**Проблема.** Мобильный loader («thinking…») управляется SSE-событиями `busy`/`done`. Но если `busy:false`/`done` **потерялся** — turn закончился путём, который не сделал `_webBroadcast busy:false` (например: на десктопе юзер **отклонил** AskUserQuestion → «Request interrupted by user for tool use» → turn оборвался через aborted_streaming), SSE-фрейм дропнулся, ИЛИ баг в самом мобильном коде неверно затрекал busy — phone **залипает** на «thinking…» навсегда. Юзер: *«нажал ⏺ → declined → но на мобилке всё равно идёт thinking… хотя thinking нет; нужен фолбэк, чтобы мобилка подхватывала реальное состояние с продакшена»*.

**Решение — периодический authoritative-поллинг, который ВСЕГДА побеждает.** `ChatView` для PTY-claude табов поллит `Api.claudeStatus` (`claude:get-presence`) на mount + при смене sessionId + **каждые 4с**, и **сверяет** `busy`:
```ts
const authoritativeBusy = d.status === 'busy';
setBusy(cur => cur !== authoritativeBusy ? authoritativeBusy : cur);
```
`get-presence` выводит `status` из `claudeTurnBusy` (Stop-hook pipeline — тот же authoritative источник, которому доверяет десктопный loader), поэтому рассинхрон лечится за ≤1 интервал поллинга, **независимо от причины**. Это и есть «реальное соединение с продом»: мобилка никогда не доверяет своему залипшему `busy` бесконечно — периодическое authoritative-чтение всегда корректирует. Forcing только при **расхождении** (`cur !== authoritativeBusy`), чтобы не драться с in-flight оптимистик-апдейтом в том же кадре. Раньше этот поллинг был **one-shot на mount** (обновлял только `claudeStatus`, не `busy`) — отсюда залипание. Переносимый принцип — [`methodology/переносимый-дизайн.md::Authoritative artifact > эвристика`] + «periodic reconcile для latched UI-state от lossy event-канала».

## Mobile composer: caret + permanent ring + selective scrollbar

Три неочевидных решения в `mobile-web/src/App.tsx::Composer`:

- **Orange visible caret** (`caretColor: '#FFB382'`). Раньше пробовал `caret-color: transparent` (юзер: «значок мигающий надо убрать»). Потом юзер репортил «не работает печать» — на самом деле работало, но он не видел каретки и не знал что инпут активен. Caret — единственный достоверный сигнал «текст идёт сюда» когда юзер начал печатать в полупустой инпут.
- **Permanent border `#FFB382`** (всегда, не `focus:border-*`). Юзер: *«просто рамка всегда активна»*, *«заново мигать рамкой тоже не надо»*. Раньше переключали `focus:border-[#555]` — каждый re-focus на mobile (touch tap → blur от scroll → re-focus) давал визуальный flicker рамки. Постоянная оранжевая рамка читается как «вот THE инпут».
- **Conditional orange scrollbar**: textarea автоэкспандится до 40vh; пока content не достиг кап, `overflowY: hidden` (никакого скролла в одну строку); как только превысил — `overflowY: auto` + класс `composer-textarea--scroll` который **переписывает глобальное** `::-webkit-scrollbar { width:0 }` на `width:6px` с `thumb: #FFB382` (orange, отделено от history-скролла который остаётся скрытым). Юзер: *«у инпута, если у нас одна строка, не должен отображаться scroll, и также scroll у инпута сделай отдельно, оранжевым»*.
- **Mic-dictation (Soniox)**: 🎤-кнопка в row 2 composer'а, тот же движок что в десктопном `MicButton` (`mobile-web/src/dictation.ts` — копия `src/renderer/utils/dictation.ts`, два независимых Vite-билда не могут шарить через alias). При старте — `prefixRef.current = text` снимает снэпшот того что юзер успел напечатать, потом `onUpdate` пишет `prefix + final + partial` в textarea. Без снэпшота транскрипт затирал бы пользовательский текст. По stop — `prefixRef.current = ''` для следующей сессии. Floating window над кнопкой реализован прямо в composer'е (не делегируется внешнему компоненту). Token mint — `Api.sonioxToken()` → `POST /api/soniox-token` → main process с `SONIOX_API_KEY` из env. **Требует secure context**: `navigator.mediaDevices` существует только на HTTPS/localhost. Phone грузит mobile-web по plain `http://<lan-ip>:7878` в **dev** → `mediaDevices === undefined` → мик не работает («needs HTTPS» в `onError`, явный guard в `dictation.ts` вместо загадочного «Cannot read getUserMedia of undefined»). На **Prod** (HTTPS через VPS-туннель, `fact-remote-access.md`) — работает; WKWebView сам грантит мик через `allowsInlineMediaPlayback`. Тот же `MediaStreamAudioDestinationNode`-фикс от SIGSEGV что на десктопе — см. [`fix-mic-renderer-sigsegv.md`](fix-mic-renderer-sigsegv.md).

## Endpoint map

```
GET  /api/me                                   → ping, проверка токена
GET  /api/projects                             → SQLite + isOpen/isActive + project icon из renderer bridge
GET  /api/inbox                                → system Inbox project metadata
POST /api/inbox/runs                           → внешний Codex run в system Inbox: create/reuse tab по conversationKey, wait TUI-ready, send prompt, return runId/tabId/eventsUrl
POST /api/inbox/runs/:runId/stop               → остановка внешнего Codex run тем же stop-flow, что desktop/PTY Codex
POST /api/projects/:id/rename                  → renameProject (через bridge → updateProject{name} → project:save-metadata)
GET  /api/projects/:id/tabs                    → tabs + groups + statuses + timelineCount + live state + statusMarker/processBar/contextPct
POST /api/inbox/sdk-tabs                       → createSDKTab в system Inbox, без projectId у клиента
POST /api/projects/:id/sdk-tabs                → createSDKTab (через bridge)
POST /api/terminal-tabs/:tabId/send                 → sendAgentPromptScenario; project ownership, TUI draft conflict не очищается
POST /api/terminal-tabs/:tabId/stop                 → stopAgentProcessScenario; для legacy SDK fallback query.close()
POST /api/terminal-tabs/:tabId/close                → closeTab (через bridge, body {aiBusy?})
POST /api/terminal-tabs/:tabId/rename               → renameTab (через bridge)
POST /api/tabs/:tabId/fork-to-sdk                   → forkToSDK (через bridge → fork-from-session); legacy route вне Project Terminal API
GET  /api/terminal-tabs/:tabId/history              → JSON or NDJSON (Accept-driven)
                                               → query params: ?last=N (tail), ?after=<uuid> (delta sync), ?before=<uuid> (prefix backfill)
                                               → Accept: application/x-ndjson → streamed line-by-line, Brotli-4
POST /api/terminal-tabs/:tabId/truncate              → drop everything ≥ targetUuid (Edit/Repeat)
GET  /api/terminal-tabs/:tabId/timeline             → parseTimelineEntries
POST /api/terminal-tabs/:tabId/rewind               → native rewind/backtrack через общий agent scenario; при stopped session сначала resume + readiness
GET  /api/terminal-tabs/:tabId/params               → параметры модели/effort/think для agent tab
POST /api/terminal-tabs/:tabId/params               → применить параметры через runtime-specific path
POST /api/terminal-tabs/:tabId/interrupt            → soft interrupt текущего turn'а (PTY Esc / SDK close warm)
GET  /api/terminal-tabs/:tabId/draft                → authoritative чтение TUI composer после interrupt
GET  /api/terminal-tabs/:tabId/draft-state          → read-only preflight состояния TUI composer перед mobile send
GET  /api/terminal-tabs/:tabId/queue                 → getPromptQueue (core + sibling aiTabs)
POST /api/terminal-tabs/:tabId/queue                 → mutatePromptQueue ({op, args})
GET  /api/terminal-tabs/:tabId/pending-question      → текущий AskUserQuestion (connect mid-question)
POST /api/terminal-tabs/:tabId/answer-question       → answerClaudeQuestion ({source, answers, stop})
GET  /api/active-loaders                       → live loaders snapshot для external install preflight
GET  /api/project-activity                     → full project activity snapshot для native project badges
GET  /api/events?scope=projects                → SSE только project-activity, без tab transcript watcher'ов
POST /api/file-preview                         → read-only file-tab preview по absolute path, cap 1MB
GET  /api/prompts[?etag=X]                     → getPrompts + getPromptGroups (no bridge); ?etag match → { etag, unchanged: true }
GET  /api/agent-models                         → { codex:[{id,label,efforts}], claude:[{id,label}] } каталог моделей (no bridge; codex из live `codex debug models`). Прямой роут до `let m` — см. «Гочи let m». Детали — fact-mobile-claude-pty.md::Контекст-% и список моделей
GET  /api/app-settings                         → app-level settings через renderer bridge (`streamerMode`)
POST /api/app-settings                         → mutate app-level settings (`streamerMode`) через desktop source of truth
POST /api/log/client                           → mobile diagnostic logs → console.log → dev.log
GET  /api/events?token=&tabId=                 → SSE (text/event-stream) — ОСНОВНОЙ live-канал. snapshot/message/busy/done/bridge-update/queue-update/ask-question/question-cancelled. Не блокируется anti-tracker'ами как ws://. См. секцию «SSE transport».
WS   /ws?token=&tabId=                          → тот же набор events. Legacy-канал для permissive-браузеров; на Yandex/Chrome с Protect не работает (ws:// к private-IP режется молча).
POST /api/projects/:id/claude-tabs              → legacy alias на native-safe `/agent-tabs` для Claude; тоже стартует CLI без ожидания mounted Terminal
POST /api/inbox/agent-tabs                      → создать PTY+Claude/Codex таб в system Inbox; body {toolType}
POST /api/projects/:id/agent-tabs               → создать PTY+Claude/Codex таб; body {toolType:'claude'|'codex'}
POST /api/projects/:id/tab-groups               → create group row через renderer bridge
POST /api/projects/:id/tab-groups/:gid/rename   → rename group
POST /api/projects/:id/tab-groups/:gid/toggle-collapsed → collapse/expand group
POST /api/projects/:id/tab-groups/:gid/status   → assign/clear group session status
POST /api/projects/:id/tab-groups/:gid/delete   → delete group container, keep tabs
POST /api/projects/:id/tab-layout               → reorder tabs/groups + group assignments/anchors
POST /api/terminal-tabs/:tabId/resume                → resume в existing PTY; 200 только после input-ready/ready, timeout = 504 success:false ready:false
GET  /api/terminal-tabs/:tabId/status                → status строка (inactive/starting/active/busy/stopping) + sessionId + commandType
```

Для Claude/Codex PTY-табов расширение mobile-web — см. `fact-mobile-claude-pty.md`. `/send`, `/stop`, `/interrupt`, `/draft`, `/draft-state` и `/rewind` роутятся через общий scenario layer: backend сам выбирает Claude PTY/Codex PTY runtime, а endpoint остаётся Project Terminal API. Legacy SDK fallback существует только для старых SDK-табов, не как модель нового API.

`/resume` — часть того же Project Terminal API, а не сырой bridge proxy. Успешный ответ доказывает готовность composer'а к следующей команде; bridge failure/readiness timeout возвращаются как non-success JSON. Native клиент после такой ошибки должен снять локальный `starting`, а не ждать следующего poll/SSE snapshot'а, потому что `starting busy=false` после failed resume часто является stale startup state.

Если resume/startup завершился ошибкой, API обязан вернуть/разослать явный failure-state, который клиент может показать в той же blocking-поверхности. Пропажа resume-overlay без успеха недопустима: для пользователя исчезновение окна означает «готово», а не «ошибка ушла в лог». Поэтому ошибка readiness/watchdog должна быть видимой (`startupError`/non-success JSON/SSE), пока пользователь не закроет или не повторит действие.

`/draft-state` — preflight только для защиты чужого текста в terminal composer, а не команда
активации desktop UI. Если renderer видит mounted xterm, он инспектирует Claude/Codex input и
возвращает `hasDraft=true/false`. Если вкладка скрыта и terminal-компонент не смонтирован,
ответ должен быть `source:"no-terminal"` / `hasDraft:null`, без `showWorkspace`,
`setProjectView` или `switchTab`: phone не имеет права переключать проект/вкладку на Mac ради
проверки draft. Для runtime без main-side proof нативный iOS-клиент трактует этот случай как
«draft неизвестен потому что поверхность не mounted» и может продолжить send без desktop
draft-protection; ambiguous error или timeout остаются стоп-сигналом. Пользовательский симптом
нарушенного контракта: отправка с iPhone внезапно переносит Mac в другой проект/таб.

Для Codex это правило после 2026-06-20 стало строже: скрытая вкладка не должна автоматически
давать `source:"no-terminal"`, пока main-side headless xterm mirror может классифицировать
composer. Renderer bridge action обязан сначала вызвать общий `codex:get-draft-state`, который
читает main/headless proof и только потом переходит к mounted renderer. `no-terminal` для
живого Codex теперь означает «оба proof-канала не смогли дать ответ», а не разрешение молча
пропустить guard. Это сохраняет background Rewind/History/API без фокуса Mac-вкладки.

`POST /api/terminal-tabs/:tabId/send` следует той же границе совместимости: при реальном
terminal draft он возвращает `409 terminal_draft_conflict`, но не вызывает
`grabAgentDraft` и не очищает TUI composer. Для Codex active/send path сначала пытается получить
main/headless draft proof; если он доказал empty composer, send продолжает PTY/audit-путь и
сверяется уже по rollout/JSONL. Если proof неизвестен, это ambiguity/error для клиента, а не
повод переключать desktop UI или фокусить вкладку на Mac. Для fresh/resume сессий это послабление
не действует — startup/readiness по-прежнему обязателен, иначе prompt можно отправить в экран запуска или MCP-confirmation.
Нормальная отправка с native iOS не должна перед этим вызывать destructive `GET /draft` как обязательный gate: `/draft` нужен после interrupt/Rewind или явного "забрать input", а не как проверка "можно ли отправлять". Такой preflight дублирует scenario layer и даёт ложный `claude_busy` в момент, когда `/send` сам умеет решить busy/queue/draft-conflict. Если клиенту нужна только защита от чужого текста, использовать read-only `/draft-state`; окончательное решение всё равно принимает `/send`.
Это важно для native iOS и старых project/tab-клиентов: они управляют конкретной вкладкой,
поэтому источник текста остаётся в терминале до явного действия пользователя. Противоположный контракт только у
`/api/inbox/runs`: Inbox-клиент владеет своим chat composer, поэтому Noted Terminal
может забрать draft, очистить terminal input и вернуть `draftText` наружу для rollback.

Все pathname-параметры (`:id`, `:tabId`) ОБЯЗАТЕЛЬНО прогоняются через `decId()` (`decodeURIComponent`) перед использованием — см. секцию «URL-encoded path параметры» ниже.

Публичный URL вместо LAN-IP — см. [`fact-remote-access.md`](fact-remote-access.md). С phone'а через интернет endpoint-map тот же, отличается только хост в URL.

**Гочи: общий `let m` в цепочке роутов = TDZ на вставке нового роута выше.** Хендлер строит роуты последовательными `m = parsed.pathname.match(...)`, но переменная `m` объявляется через `let` **один раз** — исторически на роуте `/tabs` где-то в середине файла. Если добавить новый роут (как project-rename) **выше** этой `let`-строки и написать там `m = match()`, JS temporal dead zone роняет вызов: `Cannot access 'm' before initialization` — и не только новый роут, а **все** роуты от точки вставки и ниже отдают 500 (исключение прерывает хендлер). Симптом был коварный: `/api/projects` (отдаётся выше вставки) работал 200, а `/api/projects/:id/tabs` и `/rename` (ниже) — 500, на iOS «переименование откатилось, на десктопе ничего». Правило при вставке роута: первый по файлу `m = match()` обязан быть `let m =`; всё ниже — голые присваивания. Перенёс объявление `let m` на самый верхний роут (project-rename), бывший `let m` у `/tabs` стал `m =`.

## URL-encoded path параметры (`=` в base64-id)

ProjectId формируется как `base64(path)`. Короткие пути (`/Users/fedor/Desktop/vs-code/agrotech/uav` → `L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvdnMtY29kZS9hZ3JvdGVjaC91YXY=`) оканчиваются на `=`, который в URL сериализуется как `%3D`. Tab-id наследует base64-префикс от projectId, тот же эффект.

**Симптом:** `HTTP 404: {"error":"project not found","projectId":"…%3D"}` только на проектах с коротким именем; длинные имена (`custom-terminal`) с padding `0` или `==` без `=` работают сразу.

**Причина:** regex-захват `parsed.pathname.match(/^\/api\/projects\/([^/]+)\/tabs$/)` возвращает **URL-encoded** строку. `projectManager.db.getProjectById('…%3D')` ищет в SQLite по дословному ключу, а в БД — декодированный `=`. Не находит → 404.

**Решение:** helper `decId(s) { try { return decodeURIComponent(s); } catch { return s; } }` обязательно применяется к каждому `m[1]` / `m[2]` в `web-server.js::handleApi`. Это покрывает не только `=`, но и кириллицу, пробелы, любой символ который mobile-web кодирует в URL. Когда добавляешь новый route с pathname-параметром — `decId(m[1])`, не голый `m[1]`.

## Live-fallback для `/api/projects/:id/tabs` через Zustand-bridge

`getProjectById` в `database.js` ходит **только в SQLite**. Проблема: проекты бывают **dashboard-only / draft** — открытые в Zustand `openProjects` Map, но ещё не записанные через `saveTabs` в БД. До этой правки таких проектов с phone'а нельзя было открыть — 404.

**Логика endpoint'а теперь двухступенчатая:**
1. `projectManager.db.getProjectById(projectId)` — основной путь (persisted проекты).
2. Если `null` → `bridgeRequest('getProjectTabsLive', { projectId })` — renderer проверяет `state.openProjects.get(projectId)` в Zustand и отдаёт live-snapshot табов.
3. Если и там нет → 404 с диагностическим логом `[WebServer] 404 project not found: <id> (not in DB, not in live Zustand)`.

Bridge-action `getProjectTabsLive` в `App.tsx::handleWebBridge` возвращает табы в том же shape что SQLite-путь, чтобы phone не отличал. Один из крайних случаев: если проект **открыт в UI и одновременно есть в БД с другим набором табов** — live из Zustand берёт верх (первый ступень нашла, ко второй не пошли). Это правильно — Zustand authoritative для активного состояния.

## Stale prod-app → silent bridge timeout (5s)

**Самый дорогой класс багов с phone-доступом.** Если в `App.tsx::handleWebBridge` или `web-server.js::bridgeRequest` сделана правка, но **не запущен `build:install`** — prod-app продолжает работать со старой сборкой в asar. С позиции web-server'а bridge-вызов уходит в `webContents.send('web:bridge-request', …)`, renderer его получает, но **handler с нужным action'ом не зарегистрирован** в старой версии → reply не приходит → ровно через `timeoutMs` (5000 по умолчанию) web-server отдаёт 500 `Bridge timeout: <action>`.

**Симптомы:**
- `[WebTiming] /history ERROR Bridge timeout: loadSDKHistory total=5000ms` (или другой action ровно по таймауту).
- Phone показывает бесконечный loader, через ~15с — пустой чат с composer'ом «Send something below».
- `/timeline` тоже валится в `bridge=1500ms` (там короче timeout на `getOpenProjectIds`), но **продолжает работать** через fallback на пустой openIds + чтение JSONL напрямую → юзер видит таймлайн при пустом чате, что особенно сбивает.

**Диагностика — мгновенные парные логи в трёх точках:**
- `web-server.js::bridgeRequest` пишет `[BridgeDiag] SEND action=… rid=… wins=…` на отправке, `[BridgeDiag] REPLY action=… elapsedMs=…` на приёме, `[BridgeDiag] TIMEOUT action=…` при истечении, `[BridgeDiag] REPLY_DROPPED rid=…` если ответ пришёл уже после timeout.
- `App.tsx::handleWebBridge` пишет `[BridgeDiag:R] RECV rid=…` на входе и `[BridgeDiag:R] REPLY rid=… ok=… elapsedMs=…` перед `ipcRenderer.send('web:bridge-reply', …)`.

Сценарии чтения:
- `SEND` без последующего `RECV` (через ~50ms gap) → renderer не получает IPC. Window-mismatch, dead webContents, или handler не зарегистрирован.
- `SEND + RECV + REPLY:R + REPLY (main)` все есть → всё ок, замерь `elapsedMs`.
- `SEND + RECV + REPLY:R` но `REPLY_DROPPED` в main → ответ опоздал, поднять `timeoutMs` для этого action'а в `bridgeRequest`.
- `SEND + RECV` но **нет** `REPLY:R` → handler упал silent внутри `await` (например `ipcRenderer.invoke('claude-sdk:active-branch-messages', …)` на огромном JSONL).

**Правило:** любая правка `App.tsx::handleWebBridge` или `web-server.js::bridgeRequest` требует `npm run build:install` перед тестом с phone'а — иначе симптом всегда будет «Bridge timeout» вне зависимости от качества правки. Это занудно, но иначе час уйдёт на отладку не того процесса. Mobile-web Vite dev (`cd mobile-web && npm run dev`) НЕ решает — фронт можно итерировать без билда, но `web-server.js` живёт в Electron main, его правки требуют `build:install` всё равно.

**`build:install` теперь собирает мобилку сам.** Цепочка: `graceful-quit → build:markdown → build:mobile (cd mobile-web && npm run build) → electron-vite build → electron-builder → install`. Electron-builder **копирует** `mobile-web/dist/**` в asar (`build.files`), но НЕ собирает — раньше пёк устаревший dist, если забыл пересобрать вручную. Каждый `npm run <step>` изолирован (npm всегда cwd=package-root), поэтому внутренние `cd` в `build:markdown`/`build:mobile` не утекают в следующий шаг. `build:mobile` — отдельный скрипт, можно дёрнуть в одиночку для быстрой пересборки только фронта.

## Wire protocol (общий для SSE и WS)

Один и тот же JSON-envelope летит и через SSE (`data: <json>\n\n`), и через WS (`ws.send(<json>)`) — `webBroadcast` транспортно-агностичен (см. «SSE transport»). Server → client:
```
{ type:'snapshot',     tabId, sessionId, busy, sessionStatus?, inputReady? }   — на connect и при lifecycle-сменах
{ type:'message',      tabId, message, sessionId }                              — каждое SDK или JSONL-сообщение
{ type:'busy',         tabId, busy }                                            — переключение busy (SDK + PTY-Claude + Codex)
{ type:'done',         tabId, sessionId }                                       — окончание turn'а
{ type:'bridge-update', tabId, sessionId, model, contextPct }                   — PTY-Claude: StatusLine bridge.json обновился
{ type:'queue-update',  tabId, queue }                                          — Run-after очередь изменилась (десктоп или другой телефон); `queue` = PromptQueueCore
{ type:'ask-question',  tabId, source, toolUseID, questions }                   — Claude задал AskUserQuestion; source=pty|sdk
{ type:'question-cancelled', tabId, source }                                    — вопрос отвечен/прерван/turn оборвался
```

Вопросы (`ask-question`/`question-cancelled`): десктоп показывает AskUserQuestion в Ink TUI, мобилка TUI не имеет — main бродкастит **контент** вопроса, телефон рисует свой пикер. PTY-ответ драйвит Ink клавишами, SDK резолвит parked `canUseTool` Promise. Полная механика — `fact-claude-awaiting-input.md::Мобильное расширение`.

`sessionStatus` / `inputReady` / `bridge-update` появились с расширением mobile-web на CLAUDE-PTY-табы — см. `fact-mobile-claude-pty.md::WS protocol`.

Client → server: `{ type: 'subscribe', tabId }` для смены подписки на лету (текущая mobile-сборка не использует — переподключается).

## Token & paths

- Файл токена: `~/.noted-terminal/web-token.txt`, генерируется `crypto.randomBytes(24).toString('hex')` при первом старте, mode 0o600.
- Auth: `Authorization: Bearer <token>` для REST. WS не может отправить custom headers из браузера → токен идёт в query `?token=...`. Сервер проверяет оба.
- Mobile сохраняет токен в localStorage первый раз когда видит `?token=...` в URL, потом чистит через `history.replaceState` (чтобы он не светился в адресной строке). См. `mobile-web/src/api.ts::bootstrapToken`.

## Production packaging: `mobile-web/dist/**/*` обязателен в `build.files`

Production `web-server.js` раздаёт SPA по `path.resolve(__dirname, '../../mobile-web/dist')`. Из `app.asar/src/main` это резолвится в `app.asar/mobile-web/dist` — но если в `package.json::build.files` нет `mobile-web/dist/**/*`, директории внутри asar нет, и phone получает text-ответ «mobile-web/dist not built. Run: cd mobile-web && npm run build» (этот fallback в `serveStatic` при ENOENT). Electron-овский патченный fs прозрачно читает файлы из asar — никакого `asarUnpack`/`extraResources` не нужно, достаточно include. Билд порядок: сначала `cd mobile-web && npm run build`, потом electron-builder.

## Module loading: srcMainDir, не relative

`web-server.js` лежит в `src/main/`, **не** в `dist/main/`. Electron-vite бандлит только `main.js`, sibling-модули копируются как raw .js. Поэтому загружать через:
```js
const webServer = require(path.join(srcMainDir, 'web-server'));
```
а **не** `require('./web-server')` — relative resolve смотрит относительно `dist/main/main.js`, файла там нет → `Cannot find module './web-server'`.

Тот же паттерн применён для `_webBroadcast` lazy-require в `sdkStartQuery`.

## Mobile diagnostic logs

`POST /api/log/client { tag, msg, data }` → `console.log('[' + tag + '] ' + msg + ...)` → попадает в `logs/dev.log` через стандартный console interceptor. Используется когда поведение надо отлаживать с phone (touch-events, scroll, focus): `Api.log('TimelineGoTo', 'jump', { targetTop, currentScroll })`. Без этого с iPhone Safari отладочную информацию не достать.

## Code map (неочевидные связи)

- Mobile-web `prefetch timeline on ChatView mount` (а не on drawer-open) → к моменту тапа на ☰ entries уже в state, drawer открывается instantly. Critical для UX на 200+ entries.
- Drawer mount-pattern: `display: none` вместо `{open && ...}` → scrollTop сохраняется браузером бесплатно, не нужен manual save/restore.
- `webServer.start({ sdkSessions })` принимает Map by reference. Если declaration `sdkSessions` находится **ниже** call-site `webServer.start()`, получишь TDZ ReferenceError. Декларацию держать в верхней секции `main.js` рядом с `srcMainDir`/`projectManager`, а не возле SDK-обработчиков.
- `parseTimelineEntries` фильтрует тот же noise что desktop Timeline: `<command-name>`, `<system-reminder>`, `<task-notification>`, `<local-command-stdout>`, `<local-command-stderr>`, `[Request interrupted]`. Без этого первые 5 timeline-entries — это model-switch slash-команды.

## Routing (HashRouter)

URL-схема: `#/projects/:projectId/chat/:tabId[?ro=1]`. HashRouter а не BrowserRouter — node-static в `web-server.js` не имеет SPA-fallback'а на произвольные pathnames; hash на сервер не уходит, фрагмент читается клиентом. Reload на любой странице → попадаешь обратно туда же. Deep-link (нет `state.tab` в `history.state`) → `Api.listTabs(projectId)` ищет TabInfo по `tabId`, либо показывает «Tab not found» с кнопкой назад. См. `methodology/переносимый-дизайн-mobile.md::Deep-link routing`.

## History pipeline (NDJSON streaming + IDB delta sync + virtuoso)

**Архитектура (заменила window-render + JSON two-phase в мае 2026):**

```
Mount ChatView
  ↓
[Phase 0] readCachedHistory(sid) → IDB hit?
   yes → reducer.reset + apply ALL cached → paint immediately, historyLoading=false
   no  → continue
  ↓
[Phase 1] streamHistory(?last=200) — NDJSON over Brotli-4
   meta {total, returned, firstUuid, lastUuid, etag}
   message...message...message  (one JSON per \n)
   done {written}
   ↓ each message: reducer.apply, scheduleFlush per rAF
  ↓
[Phase 2 — only if cold and total > returned] streamHistory(?before=<firstTailUuid>)
   ↓ collect into prefixBuffer
   ↓ on done: prefixMergeLockRef = true
   ↓        reducer.reset → apply(prefix + tail) → drain wsDeferredQueue
   ↓        prefixMergeLockRef = false
   ↓        flush
  ↓
[Persist] writeFullHistory(sid, rawHistoryBufferRef, etag, total, lastUuid)
```

Warm-cache путь: только одна фаза `?after=<cachedLastUuid>` — сервер вернёт пустой стрим (silent revalidation) или дельту с момента последнего mount'а.

**NDJSON wire format:**
- `Accept: application/x-ndjson` → server отвечает `Content-Type: application/x-ndjson`, `Content-Encoding: br` (если accepted)
- Line 1: `{"type":"meta", total, returned, truncated, dropped, sessionId, etag, firstUuid, lastUuid}`
- Lines 2..N+1: один SDK-message JSON на строку
- Last line: `{"type":"done", written}` — sentinel для clean stream end vs cut-off

Клиент-парсер: ручной `response.body.getReader()` (Safari нет async-iterable bodies до 26.x), `TextDecoder({stream: true})` для multi-byte chars across chunks, split по `\n` с carry-over remainder.

**Virtuoso вместо window-slice:** DOM bounded ~15-30 items независимо от total. **Удалили:** `renderStart/renderEnd`, "Load older" кнопку, full-screen GoTo overlay, `fullLoading` state, "N new below" marker, ручной scroll-restore. GoTo через `virtuosoRef.scrollToIndex({index, align:'center'})` — instant, без force-render.

**IDB record store** (idb 8.x):
- `meta` store keyed by `sessionId`: `{lastUuid, etag, total, updatedAt}`
- `messages` store keyed by `[sessionId, ord]`: одна запись на сообщение, secondary index `by-uuid`
- Read returns structured-cloned live objects — **нет JSON.parse на хот-пути** (vs 30ms parse 20MB blob каждый mount)
- Delta sync: meta.lastUuid → server `?after=<lastUuid>` → дописываем appendDelta. Полный rewrite только когда нет cache.

## SWR-кэш списков проектов/табов (мгновенный заход в проект)

**Проблема:** заход в проект показывал full-screen «Loading…» пока `Api.listTabs`
не вернётся целиком — а он тянет live-статус по каждой вкладке (N+1, задача #42),
поэтому «крайне долго». То же на экране всех проектов.

**Решение — stale-while-revalidate** через generic `kv`-store в том же IDB
(`idb.ts`, DB **v2**, additive upgrade — chat-history stores НЕ тронуты):
- `kv` keyed by string: `'projects'`, `'tabs:<projectId>'`. Хелперы `readKv`/`writeKv`
  (best-effort, `try/catch` — private-mode IDB недоступен → фоллбэк на сеть).
- `ProjectRoute`: на mount читает `tabs:<id>` из кэша → `setData` мгновенно (paint
  табов за ~18ms, измерено), параллельно фоновый `listTabs` → overwrite + `writeKv`.
  Inline-спиннер (`InlineSpinner`, серый, в `right`-слоте `Header`) виден ТОЛЬКО пока
  идёт фоновый refresh (`revalidating` флаг) — табы остаются видимы и кликабельны.
- `ProjectsView` (все проекты): seed из `kv:'projects'` на mount + `writeKv` на каждом
  4s-poll. Full-screen «Loading projects…» только при cold-open с пустым кэшом.
- `ChatRoute` deep-link reload: резолвит таб сперва из `tabs:<id>` кэша (instant),
  потом подтверждает сетью. Историю чата дальше красит свой IDB-кэш истории.

Known edge 2026-06-14: если project-card loader на экране всех проектов не горит при уже активном desktop turn, но после захода в проект tab-row loader виден и после возврата project-card тоже начинает гореть, не чини Codex/Claude streaming заново. In-tab SSE уже жив; рассинхрон находится между child tab runtime/revalidation и parent `ProjectsView` aggregate/cache adoption. Симптом важен для поиска: «loader на проекте появляется только после открытия проекта».

## Project activity snapshot для native iOS badges

Для нативного iPhone Terminal project list нужен не transcript и не live-канал каждой вкладки,
а маленький агрегированный снимок по проектам. Контракт: `GET /api/project-activity` отдаёт
полный snapshot вида `{projects:[{projectId,count,streaming,tabs:[{tabId,status,streaming}]}],ts}`.
Тот же payload летит первым событием и последующими обновлениями через
`GET /api/events?scope=projects` (`projectActivity=1` оставлен как совместимый alias). Это
отдельный subscriber topic, не `tabId`: scope=projects не запускает Claude JSONL watcher,
не подписывается на N вкладок и не получает `message`/token events.

Snapshot намеренно полный, а не дельты `+1/-1`. iOS может потерять событие, уйти в background
или поймать zombie-SSE; следующий full snapshot исправляет count/loader без ручного захода в
проект. Heartbeat остаётся обычным `: hb`, reconnect на клиенте всегда делает REST seed.
Отсутствующий project или tab в snapshot означает inactive/zero, а не «оставь старое».

`computeProjectActivity()` собирает агрегат из живых runtime maps: Claude PTY, Codex, Gemini,
SDK и safety-net `activityOpenIntervals` на случай, когда edge уже открыт, а конкретный engine
карта ещё не успела обновиться. Это не второй детектор busy-state: все входы всё равно идут от
тех же lifecycle/busy send'ов, что рисуют desktop/mobile loaders и пишут Agent Activity.
`broadcastProjectActivity(reason)` debounced (~80ms) и no-op без subscribers; триггеры —
busy/done/snapshot, `_notifyClaudeSession`, `recordActivity` open/close. Не слать это событие
на каждый token/message: project badge интересуют только переходы состояния.

`tabs[]` в snapshot — компактный runtime patch для native project-tabs page. Он нужен, чтобы
телефон, стоящий на списке вкладок проекта, увидел busy-loader без входа в chat и без
фонового `/api/projects/:id/tabs` refresh во время свайпа. Полные tab metadata, порядок,
statusMarker, processBar и contextPct остаются ответственностью `/api/projects/:id/tabs`;
project-activity патчит только `status/streaming`.

Completion notification использует тот же project-activity канал, но это отдельная ось от
busy. Если desktop bell сработал на скрытой AI-вкладке, snapshot включает
`notificationCount` на project item и компактные tab-поля
`completionNotificationFired/FiredAt/Mode`; проект остаётся в `projects[]` даже когда
`count=0` и `streaming=false`. `GET /api/projects` дублирует агрегат как
`completionNotificationCount`, а `GET /api/projects/:id/tabs` отдаёт per-tab
`completionNotificationPersistent/Armed/Fired/FiredAt`, чтобы native мог показать root badge,
project glow и tab glow без захода в transcript.

Foreground/local notification и background/locked notification — разные каналы. Если native
iOS уже держит `project-activity` SSE/REST, он сам создаёт local notification и дедупит её по
`tabId:firedAt`. Когда app свернут, suspended или телефон заблокирован, этот stream нельзя
считать delivery-механизмом: desktop `tab-notification:fired` должен параллельно отправить
remote APNs alert по зарегистрированным iOS token'ам. Push payload несёт тот же canonical
`kind=terminal-completion`, `projectId`, `tabId`, `tabName`, `firedAt`, `mode`; iOS применяет
его в local unread-state до навигации. Если APNs credentials или iOS token отсутствуют,
сервер только логирует причину и сохраняет обычный foreground путь через project-activity.
Это сознательный fallback, не доказательство что locked-phone flow работает.

`POST /api/terminal-tabs/:tabId/completion-notification/clear` — idempotent acknowledgement
для native: повторный clear или уже закрытая вкладка возвращают success, потому что тап по
iOS notification может догнать desktop clear/reload. Endpoint чистит fired/armed mirror, но
не обязан выключать persistent watch (`keepPersistent`): persistent — подписка на будущие
busy-edge, а acknowledgement относится к уже сработавшему unread. Пустой
`project-activity.projects` после clear означает authoritative zero; native не должен
оставлять старый badge из прошлого `/api/projects` seed.

`starting` в project-activity — тоже runtime patch, а не layout metadata. Вкладка в `starting`
считается live для project badge/count, но `streaming=false`: процесс запускается или
восстанавливается, пользовательский turn ещё не идёт. Нельзя сворачивать это в `active` до
input-ready — иначе iOS показывает composer/input для вкладки, где desktop ещё ждёт startup
prompt, `/model`/`/effort` defaults или Codex MCP readiness. Нельзя и делать global blocker
по одному `starting` tab: список проектов и History должны оставаться доступными, меняется
только статус конкретной вкладки.

У Codex `starting` может появиться до rollout session id: `codex:run-command` сразу seed'ит
runtime/project-activity из launch payload, чтобы iOS/API не показывали `input` или `Resume`
пока hidden tab проходит update/trust/directory/MCP startup. Этот payload не является
персистентным статусом и должен исчезать на stop/kill/exit/command-finished; иначе старый
launch переживёт ручное вмешательство и вернёт вкладку в ложный `starting`.

`commandRunning=true` у AI-вкладки в mobile/control-bar логах означает «жив процесс или
стартовый process strip», а не обязательно busy-loader пользовательского turn'а. Для
`/active-loaders` AI-вкладка блокирует install/deploy только по deterministic busy-сигналам
или обычному shell-процессу; `starting`/process strip нужен для видимости состояния вкладки,
но не должен превращаться в глобальный install blocker.

Layout changes идут отдельным полем snapshot'а `layoutChangedProjectIds`. Renderer вызывает
`project:layout-changed` при изменении структуры или metadata вкладок конкретного проекта:
create, close, reopen, rename, изменение групп, статусов и tab-layout reorder. Server добавляет
id проекта в следующий project-activity кадр, чтобы native клиент запланировал `/tabs` reload
после своего quiet-window. Это не license таскать полный tabs metadata в project-activity:
activity остаётся маленьким runtime-каналом, а structural reload происходит отдельным путём.

Project order — соседний, но другой structural signal: `projectOrderChanged:true` означает
«перезагрузи `/api/projects`», а не «перезагрузи `/tabs` выбранного проекта». Это нужно для
симптома «на Mac поменял порядок проектов, на iPhone список остался старым»: per-project
`layoutChangedProjectIds` здесь бессмысленен, потому что изменилась сама последовательность
project rows, а не содержимое одного проекта.

**Error-policy (важно):** ошибка сети показывается full-screen ТОЛЬКО когда показать
нечего (`error && !data`). Если кэш есть — стейл-табы остаются, ошибка глотается, next
poll восстановит. Иначе мигающий «Failed» поверх рабочего списка.

**Bump DB-версии безопасен:** `upgrade()` создаёт `kv` только если его нет
(`if (!db.objectStoreNames.contains('kv'))`) — `meta`/`messages` не пересоздаются,
кэш переписок юзера переживает миграцию.

**Race protection (prefix-merge lock):** между `reducer.reset()` и `apply(merged)` в phase-2 могут прийти WS messages. Раньше они применялись в `reset → empty → WS apply (без context) → merge replace` → live message терялся. Теперь:
- `prefixMergeLockRef.current = true` перед reset
- WS handler: `if (prefixMergeLockRef.current) wsDeferredQueueRef.push(msg); return`
- После apply(merged): drain wsDeferredQueue → reducer.apply каждый → flush → release lock

## SSE transport (заменил WebSocket в live-канале)

**Корень почему не WS:** Yandex Browser (его встроенный Protect) и Chrome anti-tracker расширения **молча блокируют `ws://` к private-IP** (`192.168.x`, `127.0.0.1`). Детерминированно (горело 2026-05-28): из браузера `fetch('/api/me')` → 200, а `new WebSocket('ws://192.168.0.103:7979/ws')` → `readyState` навсегда `0` (CONNECTING), ни `open`, ни `error`, ни `close`, и на сервер **не приходит ни одного upgrade-запроса**. При этом `curl` с тем же URL даёт `101 Switching Protocols` — сервер исправен, режет именно браузер. WS-события `error readyState=3 + close 1006` мгновенно если расширение рвёт после конструктора. Симптом для юзера: «WebSocket подключается…», Resume жмётся но «ничего не происходит» (бэкенд работает, broadcast'ы падают в `[WebBcast:DROP] noSubscribers`).

**Решение — Server-Sent Events** (`GET /api/events?token=&tabId=`, `EventSource` на клиенте). SSE едет поверх обычного HTTP GET (`text/event-stream`), который anti-tracker'ы не трогают. Проверено в реальном Яндексе: `EventSource` → `OPEN@5ms` + snapshot, там где ws:// висел вечно.

Серверная механика — **транспортно-агностичный Sink** в `web-server.js`:
- `subscribers: Map<tabId, Set<Sink>>`, `Sink = { kind:'ws'|'sse', send(str), isAlive(), close() }`.
- `wsSink(ws)` оборачивает WebSocket; SSE-route создаёт inline-sink (`send` пишет `data: <json>\n\n`, `isAlive` = `!res.writableEnded`).
- `webBroadcast(tabId, payload)` фанит на оба транспорта одинаково — main.js не знает какой транспорт у клиента. **WS-эндпоинт оставлен** для permissive-браузеров (десктоп, Safari) — оба регистрируются в один реестр.
- SSE-route: `Content-Type: text/event-stream`, `X-Accel-Buffering: no` (отрубить прокси-буфер), `retry: 2000` (EventSource auto-reconnect), heartbeat-комментарий `: hb\n\n` каждые 25s (держит сокет тёплым за радиомодемами), `req.on('close')` → `unsubscribeAll(sink) + releaseClaudeWatchersIfOrphan()`.
- **gzip не трогает SSE** — `sendJson` (где gzip) не вызывается, route пишет `res.write` напрямую. Глобального gzip-middleware в `createServer` нет.

При subscribe на tab transcript web-server также регистрирует consumer в `SessionTranscriptService` и освобождает его, когда у tab больше нет WS/SSE subscribers. Сервис шлёт `transcript-changed` как invalidation; для Codex live `message` отсюда не фанится. Единственный live-владелец Codex rows — CodexTurn watcher в `main.js`, а Transcript Service остаётся snapshot/invalidation layer. Шрам 2026-06-21: когда оба слоя слали `message`, native iOS показывал отправленный с desktop prompt дважды; второй event имел другой uuid и часто `session=nil blocks=0 textLen=0`, потому что пришёл из другой нормализации. Claude PTY live tail watcher из `fact-mobile-claude-pty.md` пока остаётся отдельным каналом live-message; общий сервис не должен ломать его guards по `entry.inflight/leftover`.

Клиент: `EventSource` имеет **встроенный** auto-reconnect — рукодельный backoff/watchdog/visibilitychange (которые были у WS) удалены, браузер сам реконнектит. `esRef`, `eventsUrl()` в `api.ts`. Парсинг сообщений тот же (общий JSON-envelope).

**`webBroadcast` логирование — lifecycle-first, но `message` тоже трассируется metadata-only:** `type:'message'` может лететь десятками раз за turn, поэтому в лог не пишется chat text/content. Но SEND/DROP для `message` логируются с коротким summary (`role/content-types`, `noSubscribers`, `to=N/N`), потому что иначе баг «iOS не видит live text, но история появляется после переоткрытия» не отличить от parser-регрессии. Lifecycle-типы (`snapshot`, `busy`, `done`, `bridge-update`, `queue-update`, questions) продолжают логироваться всегда.

**Loader'ы Resume/Stop — строго по SSE-событию, без таймаутов:**
- Resume: `setResuming(true)` на клик, HTTP-ответ (~15ms) loader НЕ гасит. Гаснет `useEffect` когда `claudeStatus → active|busy` (SSE snapshot от `Bridge:Fresh`/`ClaudePromptReady`, ~1.1s). Edge: bridge вернул `alreadyRunning:true` (Claude уже жив, stale mobile-статус) → нового snapshot не будет → гасим loader сразу в `onResume` + `setClaudeStatus('active')`, иначе вечный спиннер.
- Stop: `setStopping(true)` на клик, гаснет когда `claudeStatus → inactive` (SSE snapshot от `clearBridgeTab` после реальной смерти процесса, ~500ms). Edge: `stop` вернул `{stopped:false}` (процесса уже не было) → нет PTY-exit → гасим loader сразу + `setClaudeStatus('inactive')`.
- `InlineSpinner` — `transform:rotate` (не opacity), UPPERCASE лейбл «RESUMING…»/«STOPPING» — детектируется на видеозаписи (CLAUDE.md::AI-Optimized UI).

После 2026-06-20 Stop loader опирается не только на локальный mobile flag: server публикует `sessionStatus:'stopping'` сразу после `terminal:stop-ai-process`, до финального `inactive`. Это нужно для native iOS, History и внешних API-клиентов, которые не нажимали кнопку в mobile-web и не имеют локального `setStopping(true)`. Любой клиент, увидевший `stopping`, обязан блокировать send/resume/rewind и ждать следующего lifecycle snapshot; `busy:false` при этом не означает готовность composer'а.

**Регрессия-canary:** `[WebSSE:Open/Close]`, `[WebSub:Subscribe/Unsubscribe]`, `[WebBcast:SEND/DROP]` (metadata-only для lifecycle/message), `[MobResume]/[MobStop] click/reply-ok/loader-cleared`, `[MobWS] snapshot/busy/done` (имя `MobWS` историческое, канал теперь SSE). Если loader виснет — grep `loader-cleared` отсутствует → SSE-событие смены статуса не пришло (проверь `[WebBcast:SEND] to=N/N` на сервере и `EventSource` readyState на клиенте).

**Stream idle watchdog:** 30s без bytes → abort + onError. Без этого Electron-crash mid-stream → phone forever pending без сигнала.

**Synthetic broadcast skip on mobile:** main.js шлёт `__webSynthetic: true` user message через WS чтобы desktop рендер показал bubble на mobile-prompt'ах. Phone reducer **игнорирует** synthetic — иначе phone получит дубль (synthetic + real-record). Mobile получает мгновенный feedback через **локальный optimistic push** в `send()`, real-record adopt'ит свой uuid в существующую entry (dedupe by text).

См. `methodology/переносимый-дизайн-mobile.md::Tail-first loading`, `knowledge/fix-mobile-history-bottleneck.md` (история отладки до streaming), `knowledge/fix-mobile-scroll-jitter-virtuoso.md` (CV+virtuoso антипаттерн), `knowledge/fix-mobile-scroll-teleport.md` (resize-shrink → false-positive atBottom → followOutput pin).

## Expanded state map (across virtuoso re-mount)

`_entryExpanded: Map<entryId, boolean>` в module scope `mobile-web/src/App.tsx`. Hook `useEntryExpanded(id, defaultOpen)` подписывается на per-id version counter. Используется в ThinkingCard и ToolCard. Cleanup в `clearEntryExpandedForIds` срабатывает на ChatView unmount — иначе Map течёт по entry.id'ам всех когда-либо открытых чатов.

См. `methodology/переносимый-дизайн-mobile.md::Persistent expanded state across virtual list re-mount`.

## Dev-port isolation (parallel production)

Production app (installed `/Applications/Noted Terminal.app`) слушает 7878. `npm run dev` устанавливает `NOTED_WEB_PORT=7979` через npm script — поднимает свой web-server на 7979, оба работают параллельно. Phone подключается на нужный порт (production URL стабильный, dev URL = тестовая копия).

**Port-walk fallback при EADDRINUSE.** Если preferred port (7878 или явный `NOTED_WEB_PORT`) занят — server инкрементирует и пробует следующий, до `PREFERRED + 20`. Раньше второй инстанс просто молча умирал с `EADDRINUSE` через `console.error`, mobile-web был доступен ровно у первого запустившегося. Теперь оба живые на разных портах. Реальный bound порт пишется в `~/.noted-terminal/web-server-<pid>.json` (`{port, pid, lanIp, updatedAt}`) — discovery для StatusBar mobile-chip'а и любого внешнего инспектора. `getInfo()` отдаёт `resolvedPort`, не const — без этого QR-код и copy-URL показывали 7878 на инстансе который реально на 7879.

Mobile-web Vite dev (`cd mobile-web && npm run dev`) — `host: '0.0.0.0'`, port 5180. Proxy `/api` и `/ws` на :7878. Используется когда нужен HMR на phone при правках `mobile-web/src/*.tsx`.

Token общий — `~/.noted-terminal/web-token.txt` читается обоими инстансами.

## Prompt cache (etag-revalidation)

`localStorage['noted-prompts-cache:v1']` = `{ etag: string, data: { groups, prompts } }`. PromptPickerSheet hydrate'ится синхронно из cache на mount → UI рисуется в первый кадр без spinner'а. Параллельно `Api.prompts(cachedEtag)` — server считает sha-1 от canonical JSON, если совпало — `{ etag, unchanged: true }` (~50 байт). Network failure при наличии cache → silent fallback.

Версия ключа `:v1` бампается **только** при backwards-incompatible изменении схемы (новые поля в prompt — нет, переименование — да). Контентные изменения отлавливает etag сам.

## Performance instrumentation

Server: `[WebTiming]` теги — каждый `/timeline`, `/history` пишет `bridge=Xms find=Yms parse=Zms total=Wms`, `[WebGzip] origB → gzipB (N%) in Tms` для крупных payloads (>64KB).

Client: `[History] streamFetch / streamMeta / streamDone / prefixMerged / idbWrote / cacheHit` через `Api.log()` → `POST /api/log/client` → `console.log` → `dev.log`. Каждый шаг с `*Ms` для blame'а. `[TimelineGoTo] click / done / NOT FOUND` для timeline-навигации. `[WS] open / close` с code/reason/backoffMs для reconnect диагностики. `[ScrollDiag] flushReducer / followOutput / atBottomStateChange / isScrolling / scroll {delta:N}` — для отладки scroll-jitter (см. `fix-mobile-scroll-jitter-virtuoso.md` для CV-кейса, `fix-mobile-scroll-teleport.md` для shrink+false-atBottom-кейса). `atBottomStateChange` несёт `{isScrolling}` тегом — gate в коде дропает true пока юзер тащит палец.

**Архивные теги (устарели):** `tailFetch / tailFetched / fullFetch / fullFetched / fullApplied` использовались в JSON two-phase архитектуре, удалены вместе с ней.

## gzip threshold

`sendJson` — gzip только для payloads ≥ 4KB **и** только если client прислал `Accept-Encoding: gzip`. Уровень 6 (баланс ratio/CPU). На 20MB JSON history даёт 60-65% сжатие (7-8MB), 250ms server CPU — приемлемо когда альтернатива 4-15 сек transfer на phone. Под threshold'ом overhead не оправдан (gzip header + CPU > saved bytes).
