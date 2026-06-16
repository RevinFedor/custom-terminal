# Fact: Mobile Web Access

Параллельный режим работы с SDK-табами через мобильный браузер. Сервер живёт в main process Electron (port 7878), фронт — отдельный мини-Vite SPA в `mobile-web/`, отдаётся как статика. Авторизация — bearer token в `~/.noted-terminal/web-token.txt`. Со смартфона можно создавать SDK-чаты, отправлять промпты, видеть стрим в реальном времени параллельно с десктопом.

## Почему НЕ cloud-хостинг

`query()` из `@anthropic-ai/claude-agent-sdk` запускает Claude Code subprocess **локально** с `cwd: project.path`, читает файлы пользователя, пишет JSONL в `~/.claude/projects/<slug>/`. На удалённой машине этот процесс не имеет доступа к локальной FS пользователя — а это и есть главный value (работа с реальными проектами с телефона). Поэтому сервер обязан быть локально, на том же устройстве где запущено приложение. Trade-off: ПК должен быть включён и в той же Wi-Fi что телефон.

## Bridge pattern: main ↔ renderer

Часть REST-эндпоинтов требует **живого renderer state** (Zustand store с открытыми проектами и табами). Main не имеет доступа к store напрямую. Решение — request/reply IPC bridge:

1. Main: `bridgeRequest(action, payload, timeoutMs=5000)` спавнит `requestId`, шлёт `web:bridge-request` в renderer, ждёт ответа на `web:bridge-reply` с тем же id.
2. Renderer: один listener в `App.tsx` диспатчит по action — `getOpenProjectIds`, `createSDKTab`, `sendSDKMessage`, `loadSDKHistory`, `forkToSDK`, `closeTab`, `renameTab`, `renameProject` (мобильный rename проекта → `useProjectsStore.updateProject{name}`), `getSDKParams`, `setSDKParams`, `getTabSessionInfo`. Расширение для PTY+Claude/Codex: `createClaudeTab` (legacy wrapper), `createAgentTab` (generic PTY agent), `resumeClaudeTab`, `stopClaudeTab`, `interruptClaudeTurn` (soft interrupt текущего turn'а), `grabAgentDraft` (authoritative чтение TUI composer после interrupt), `sendMessageAuto` (единая точка `/send` — сам роутит SDK vs PTY), `getClaudeTabStatus`, `getClaudeTabStatusBatch`, `getProjectTabsLive` (отдаёт `sessionStatus`, project `icon`, `statusMarker`). Детали — `fact-mobile-claude-pty.md`.
3. На таймауте promise rejected — endpoint возвращает 409.

**Критично:** bridge нужен ТОЛЬКО для actions, требующих store. Чисто-серверные operations (timeline parse через `parseTimelineEntries`, projects list из SQLite через `projectManager.db.getAllProjects()`) идут напрямую без bridge — это и быстрее, и работает даже если renderer mounted с задержкой.

## Synthetic user-message broadcast

Когда mobile шлёт `POST /api/sdk-tabs/:id/send` → main вызывает `sdkStartQuery`. Реальная user-запись в JSONL появляется **позже**, когда Claude Code SDK дойдёт до неё в потоке. Phone не должен ждать — bubble должен появиться мгновенно.

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

## ParamsSheet (model/effort/think) — close-on-select + invisible-intent источники

Хедер-пилюля `model · effort ▾` открывает bottom-sheet `ParamsSheet` (SDK и
PTY-Claude табы). Три неочевидных факта:

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

`mobile-web` больше не единственный потребитель этого сервера. Нативный iOS-клиент Habit Tracker (`fact-voice-chat-tab.md::Terminal mode`) ходит в те же REST/SSE endpoints и рисует Terminal сам на SwiftUI. Это не вторая модель terminal-control: source of truth остаётся в custom-terminal renderer/main, а native app только отображает снапшоты и шлёт команды.

Следствие для контракта: всё, что native UI не может честно вывести из файлов на диске, должно приходить по API уже нормализованным. Project icon (`project.icon`), назначенный status marker (`statusId/statusColor`) и форма/размер marker (`statusMarker:{shape,sizePx}`) передаются сервером, потому что palette и настройка живут в desktop `useUIStore`, недоступном iOS. Runtime `sessionStatus` остаётся отдельным полем: это busy/active/inactive процесса, а не user-assigned категория. Клиент может по-своему резервировать место в строке или менять icon layout, но не должен смешивать эти две оси.

`GET /api/projects` для native клиентов отдаёт не просто SQLite `updated_at DESC`.
Открытые проекты сортируются по порядку `openProjects` из renderer — это тот же порядок,
в котором desktop project tabs стоят слева направо; телефон показывает его сверху вниз.
Закрытые проекты идут после открытых по freshness. Нативный клиент не должен повторно
сортировать этот ответ: порядок project tabs — пользовательская навигационная раскладка,
а не производная от времени последнего изменения проекта.

Создание новых PTY-агентов для native идёт через `/api/projects/:id/agent-tabs {toolType:'claude'|'codex'}`. Этот route намеренно делегирует в renderer `createAgentTab`, чтобы Claude и Codex стартовали тем же `pendingAction` path, что desktop. Не заводить на iOS отдельный launch-path, который сам пишет command в PTY: он обойдёт desktop guards, model/effort defaults и session detection.

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
POST /api/projects/:id/rename                  → renameProject (через bridge → updateProject{name} → project:save-metadata)
GET  /api/projects/:id/tabs                    → tabs + timelineCount + live state + statusMarker
POST /api/projects/:id/sdk-tabs                → createSDKTab (через bridge)
POST /api/sdk-tabs/:tabId/send                 → sendSDKMessage + dispatch external-prompt
POST /api/sdk-tabs/:tabId/stop                 → query.close()
POST /api/sdk-tabs/:tabId/close                → closeTab (через bridge)
POST /api/sdk-tabs/:tabId/rename               → renameTab (через bridge)
POST /api/sdk-tabs/:tabId/fork-to-sdk          → forkToSDK (через bridge → fork-from-session)
POST /api/tabs/:tabId/fork-to-sdk              → ↑ alias для terminal табов
GET  /api/sdk-tabs/:tabId/history              → JSON or NDJSON (Accept-driven)
                                               → query params: ?last=N (tail), ?after=<uuid> (delta sync), ?before=<uuid> (prefix backfill)
                                               → Accept: application/x-ndjson → streamed line-by-line, Brotli-4
POST /api/sdk-tabs/:tabId/truncate              → drop everything ≥ targetUuid (Edit/Repeat)
GET  /api/sdk-tabs/:tabId/timeline             → parseTimelineEntries
GET  /api/sdk-tabs/:tabId/params               → getSDKParams
POST /api/sdk-tabs/:tabId/params               → setSDKParams
POST /api/sdk-tabs/:tabId/interrupt            → soft interrupt текущего turn'а (PTY Esc / SDK close warm)
GET  /api/sdk-tabs/:tabId/draft                → authoritative чтение TUI composer после interrupt
GET  /api/sdk-tabs/:tabId/queue                 → getPromptQueue (core + sibling aiTabs)
POST /api/sdk-tabs/:tabId/queue                 → mutatePromptQueue ({op, args})
GET  /api/sdk-tabs/:tabId/pending-question      → текущий AskUserQuestion (connect mid-question)
POST /api/sdk-tabs/:tabId/answer-question       → answerClaudeQuestion ({source, answers, stop})
GET  /api/active-loaders                       → live loaders snapshot для external install preflight
GET  /api/prompts[?etag=X]                     → getPrompts + getPromptGroups (no bridge); ?etag match → { etag, unchanged: true }
GET  /api/agent-models                         → { codex:[{id,label,efforts}], claude:[{id,label}] } каталог моделей (no bridge; codex из live `codex debug models`). Прямой роут до `let m` — см. «Гочи let m». Детали — fact-mobile-claude-pty.md::Контекст-% и список моделей
POST /api/log/client                           → mobile diagnostic logs → console.log → dev.log
GET  /api/events?token=&tabId=                 → SSE (text/event-stream) — ОСНОВНОЙ live-канал. snapshot/message/busy/done/bridge-update/queue-update/ask-question/question-cancelled. Не блокируется anti-tracker'ами как ws://. См. секцию «SSE transport».
WS   /ws?token=&tabId=                          → тот же набор events. Legacy-канал для permissive-браузеров; на Yandex/Chrome с Protect не работает (ws:// к private-IP режется молча).
POST /api/projects/:id/claude-tabs              → создать PTY+Claude таб (Terminal.tsx сам spawn'ит Claude по pendingAction)
POST /api/projects/:id/agent-tabs               → создать PTY+Claude/Codex таб; body {toolType:'claude'|'codex'}
POST /api/sdk-tabs/:tabId/resume                → claude --resume <sid> в existing PTY
GET  /api/sdk-tabs/:tabId/status                → status строка (inactive/starting/active/busy) + sessionId + commandType
```

Для CLAUDE-табов (commandType='claude' && tabType!='claude-sdk') расширение mobile-web — см. `fact-mobile-claude-pty.md`. `/send` и `/stop` теперь sumарно роутятся: backend сам выбирает SDK путь или PTY+paste путь по `tab.commandType`.

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

Клиент: `EventSource` имеет **встроенный** auto-reconnect — рукодельный backoff/watchdog/visibilitychange (которые были у WS) удалены, браузер сам реконнектит. `esRef`, `eventsUrl()` в `api.ts`. Парсинг сообщений тот же (общий JSON-envelope).

**`webBroadcast` логирование — lifecycle-first, но `message` тоже трассируется metadata-only:** `type:'message'` может лететь десятками раз за turn, поэтому в лог не пишется chat text/content. Но SEND/DROP для `message` логируются с коротким summary (`role/content-types`, `noSubscribers`, `to=N/N`), потому что иначе баг «iOS не видит live text, но история появляется после переоткрытия» не отличить от parser-регрессии. Lifecycle-типы (`snapshot`, `busy`, `done`, `bridge-update`, `queue-update`, questions) продолжают логироваться всегда.

**Loader'ы Resume/Stop — строго по SSE-событию, без таймаутов:**
- Resume: `setResuming(true)` на клик, HTTP-ответ (~15ms) loader НЕ гасит. Гаснет `useEffect` когда `claudeStatus → active|busy` (SSE snapshot от `Bridge:Fresh`/`ClaudePromptReady`, ~1.1s). Edge: bridge вернул `alreadyRunning:true` (Claude уже жив, stale mobile-статус) → нового snapshot не будет → гасим loader сразу в `onResume` + `setClaudeStatus('active')`, иначе вечный спиннер.
- Stop: `setStopping(true)` на клик, гаснет когда `claudeStatus → inactive` (SSE snapshot от `clearBridgeTab` после реальной смерти процесса, ~500ms). Edge: `stop` вернул `{stopped:false}` (процесса уже не было) → нет PTY-exit → гасим loader сразу + `setClaudeStatus('inactive')`.
- `InlineSpinner` — `transform:rotate` (не opacity), UPPERCASE лейбл «RESUMING…»/«STOPPING» — детектируется на видеозаписи (CLAUDE.md::AI-Optimized UI).

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
