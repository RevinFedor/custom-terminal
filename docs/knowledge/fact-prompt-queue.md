# Факт: Prompt Queue overlay + External Editor hijack

## Зачем
Юзер пишет промпт, AI-таб отвечает, юзер хочет следующий промпт отправить **автоматически после окончания ответа**. Очередь промптов справа-вверху Claude/Codex PTY-таба + auto-runner на busy→idle событии. Без поллинга, без таймаутов — на штатный конец turn'а pop'аем head.

Вторая сторона — **захват текущего ввода AI TUI** для перекладки в очередь / clipboard / просто очистки. Без danger zone (Ctrl+C single press = clear input, но Claude/Codex TUI может handle'ить его как exit/interrupt → можно случайно убить сессию).

## Архитектура — три блока

### 1. Store (`usePromptQueueStore.ts`)
Per-tab очередь: `Map<tabId, { items: QueuedPrompt[], autoRun: boolean, stopAfter: boolean, panelCollapsed: boolean, previewId: string | null }>`.
- `autoRun` — на каждый busy:true→false pop'аем head и шлём команду в runtime owner-таба (`claude:send-command` или `codex:send-command`). После последнего prompt'а **auto-disarm** (`setAutoRun(false)` если очередь стала пустой).
- `stopAfter` — после следующего turn-end если очередь пуста, вызывает `terminal:stop-ai-process` (SIGTERM по PID). One-shot: disarm после первого срабатывания. Независим от `autoRun` — можно использовать "пиши промпт сам → ответ → авто-стоп".
- `QueuedPrompt.enabled` — per-card skip-state. `false` оставляет карточку видимой, но runner и счётчики активных элементов её пропускают; `undefined` у legacy-записей читается как enabled, чтобы старые очереди после hydrate не стали молча выключенными.

**SQLite persistence через `app:setState`.** `items` / `autoRun` / `stopAfter` / `closeAfter` / `runAfterTabId` / first-delay / post-prompt / `panelCollapsed` / `previewId` per-tab сохраняются в `app_state` под ключом `promptQueueByTab`; `enabled` живёт внутри `items`, а не отдельной таблицей. Throttle 250мс на каждый mutator — drag-reorder и быстрый ввод не должны писать SQLite 60 раз/сек, но последнее значение перед unmount-ом гарантированно flush'нется. `previewId` — persisted pointer на закреплённый editor: hydrate восстанавливает его только если item с таким id ещё существует, иначе сбрасывает. Активный countdown, first-chip hint и close-arm memory — UI-only, не персистятся. Cold tabs дропаются только если нет очереди, нет armed-state, нет настроек, `previewId=null` и `panelCollapsed=false`; collapsed empty tab сохраняется, потому что это ручная layout-настройка вкладки, а не состояние очереди. Hydrate один раз через `hydratePromptQueueStore()` в `App.tsx::useEffect([])` — fire-and-forget, runner ниже терпит появление items после mount'а через subscribe-механизм (см. cold-start).

**Restore/hydrate race guard.** `hydratePromptQueueStore()` может загрузить очереди раньше, чем `restoreSession()` наполнит `openProjects`. В этом окне runner НЕ имеет права считать owner/target вкладки закрытыми: нельзя вызывать `cleanupClosedTab`, сбрасывать `runAfterTabId` как stale или сохранять пустой snapshot до завершения hydrate/workspace restore. Живой симптом был после build-install: в UI был один-два Run-after чипа, при рестарте `promptQueueByTab` в SQLite стал `{}` и меню открылось пустым. Поэтому validation запускается только когда `!useWorkspaceStore.isRestoring` и есть реальные `openProjects`, а store skip'ает pre-hydrate empty save/sync save.

**First-chip hint без auto-arm.** Когда `items.length === 0 && autoRun === false` и юзер дергает `+ grab` или `+ add`, store НЕ включает `autoRun` автоматически. Вместо этого ставится UI-only `firstChipHintActive`: Run after pill мигает красным один раз и остаётся приглушённо-красным до явного Run after / ручного empty-out очереди. Модель намерения: положить задачу в очередь = staging, а не согласие на автозапуск; запуск остаётся явным кликом по Run after. Ранняя версия auto-arm'ила первый chip, но это конфликтовало с ожиданием «я просто сохранил задачу на потом» и визуально путало hint с active-state.

### 2. Overlay UI (`PromptQueueOverlay.tsx`)
Sticky 240px справа-вверху Claude/Codex PTY-таба. Гейтится тремя условиями:
- `commandType === 'claude' | 'codex'` (не bash/gemini)
- `tab.claudeSessionId` или `tab.codexSessionId` существует (есть зарегистрированная сессия)
- процесс реально жив в PTY (`claudeProcessAlive` legacy-state переиспользуется как общий alive-флаг для Claude/Codex). **Когда AI процесс умирает (Stop кнопка) — оверлей мгновенно пропадает**, иначе остался бы по session id (он persistit после exit для /resume).

**Шрам: OSC 133 `B` теряется → оверлей висит HIDDEN пока Claude жив.** `claudeProcessAlive` ставится в `true` ТОЛЬКО по OSC 133 `command-started` (B). Но этот маркер **пропускается**, когда Claude ожил способом, не прошедшим через нашу подписку на OSC: восстановление при старте приложения, запуск в **фоновом** табе (компонент Terminal ещё не смонтирован), `--resume` руками без хоткея claude-c (он один force-эмитит `command-started`). Тогда `getCommandState` при маунте возвращает `isRunning:false` → `alive=false` → оверлея нет, **хотя Claude отвечает**. Появляется только после Stop+«продолжить» (claude-c принудительно шлёт сигнал). Симптом юзера: *«Claude отвечает — окна Run after нет; жму Стоп — окно появляется»* (инверсия). Поймано на проде 10:42:43: `alive=false → HIDDEN` без предшествующего `command-finished`/StopAI, затем claude-c → `alive=true → SHOWN`.

**Фикс — bridge-alive как авторитетный fallback.** `bridgeKnownSessions` = «CLI жив в этом табе, держится до kill терминала» (в отличие от `claudeCliActive` = «сейчас обрабатывает», пуст на idle — см. коммент у `before-quit`). Решение:
1. `terminal:getCommandState` (main) возвращает `isRunning: oscRunning || bridgeKnownSessions.has(tabId)` — если мост знает живую сессию, Claude жив независимо от того, поймали ли мы OSC `B`.
2. `Terminal.tsx`: `handleSessionDetected` и `handleProcessStarted` ставят `setClaudeProcessAlive(true)` (functional updater — deps эффекта `[tabId]`, прямое чтение стейта было бы stale). Ловит случай «мост обнаружил Claude уже ПОСЛЕ маунта/initial-sync».

Диагностика (можно удалить позже): `[RunAfterDiag]` на OSC B/D + `getCommandState` логирует `bridgeAlive` vs `oscRunning` расхождение.

### 2a. Run after pivot to other tab (`runAfterTabId`)

Поверх обычного `autoRun` (= «по окончании ТЕКУЩЕГО turn-а отправь head» — слушает busy→idle на собственном табе) добавлен опциональный pivot: дропдаун `[on tab ▾]` слева от Run after pill позволяет выбрать **другую** AI-вкладку из любого открытого проекта. Когда выбрана `runAfterTabId = T`, runner ждёт busy→idle на T, а не на queue-owner. Use case: в одном проекте открыт Gemini-таб с длинным research'ем, в другом/текущем Claude-табе сложился промпт «обсуди результат» — арм Run after, на Gemini → когда Gemini закончит, Claude получит промпт.

**Список target'ов = AI-вкладки всех openProjects, не runtime owner'а и не только текущего workspace.** Если меню открыто в Codex-очереди, в dropdown всё равно должны быть Claude PTY, Claude SDK, Codex и Gemini вкладки; если меню открыто в Claude-очереди — Codex тоже доступен; если нужная loader-вкладка живёт в другом открытом проекте — она тоже доступна. Пользователь выбирает «после какой работы продолжить», а не «какому провайдеру/проекту принадлежит это меню». Это была явная правка пользователя: доступность target'ов не должна зависеть от места открытия меню.

**Project chips вверху picker'а — фильтр контекста, не часть target value.** По умолчанию выбран текущий project owner'а очереди; если уже выбран target из другого проекта, picker открывается на проекте target'а, чтобы пользователь видел текущий выбор. Чипы горизонтально скроллятся без видимого scrollbar'а: места мало, но project-переключение должно быть доступно без превращения picker'а в широкий dashboard. Колёсико над rail'ом сразу мапится в `scrollLeft` без Shift: внутри picker'а горизонтальность уже очевидна, требовать Shift значит прятать навигацию. Внутри выбранного проекта порядок вкладок ровно как в терминальном списке, без сортировки по busy/name — иначе выбор «после той вкладки, которая у меня третья сверху» ломается.

Выбор target-таба — explicit arm: если пользователь кликнул вкладку в picker'е, `runAfterTabId` становится non-null и `autoRun` включается автоматически. Это не конфликтует с first-chip staging-моделью: staging действует на простое добавление чипа, а выбор `on tab` уже является согласием «ждать именно эту вкладку и отправить очередь». Одновременно гасится first-chip hint, чтобы UI не показывал красное “не armed” рядом с только что выбранным target.

**Default list = только loader-вкладки, toggle `loader/all` раскрывает архив.** Picker открывается в режиме «только вкладки, где сейчас есть loader», потому что основной use case — привязать очередь к уже идущей работе. Idle AI-вкладки остаются доступны через маленькую кнопку счёта `busy/total` в header'е; повторный клик возвращает loader-only. Выбранный target всегда остаётся видимым даже если он idle, иначе пользователь не понимает что уже выбрано. Строки `No Target` нет: очистка target'а — повторный клик по уже выбранной строке (single-select toggle-off), а пустой выбор является нормальным состоянием по умолчанию.

**Источник busy для T = унифицированный.** Runner подписан на три IPC сразу — `claude:busy-state` (PTY claude + SDK через forward `claude-sdk:busy-state` → `claude:busy-state` в main.js:11559), `codex:busy-state`, `gemini:busy-state`. Все три пишут в общий `Map<tabId, boolean> prevBusyRef`. Pivot не различает «какой агент работает на T», только «есть ли там сейчас активный спиннер».

**UI-статус target-таба — 2 состояния (определяется в `statusFor()`):**

| Состояние target | Иконка справа от имени |
|---|---|
| `busy` (агент сейчас думает/стримит) | спиннер (svg arc, 9px, `pq-spin 0.9s linear infinite`) |
| `idle` (всё остальное) | ничего |

Семантика лоадера = «агент в этом табе **сейчас отвечает**» — зеркало shimmer-пульсации вкладки в TabBar (`isBusy`). Idle-но-живой таб → ничего; не запущен → его вообще нет в списке (`aiTabs` фильтрует по наличию сессии).

**Реактивность статуса — собственный `busyMap`, НЕ `isTabBusyNow` + polling.** Picker держит `const [busyMap, setBusyMap] = useState<Map<string,boolean>>()` и подписывается на те же IPC, что TabBar — `claude:busy-state` + `codex:busy-state` + `gemini:busy-state` (focus-независимые broadcast'ы из main, долетают для **фоновых** табов — а target по определению не сфокусирован). `statusFor(id) = busyMap.get(id)===true ? 'busy' : 'idle'`. Никакого `setInterval`.

**Что было до и почему сломалось (горело):** статус читался из `isTabBusyNow(id)` — это **не-реактивный** module-Map (`prevBusyRef`) runner'а, поэтому picker перерисовывался только по `setInterval(force, 750)`, который вдобавок был gated `if (!runAfterTabId && !open) return` — при закрытом pill без выбранного target интервал вообще не запускался. Спиннер «не крутился». Плюс третий статус `inactive = (activeTabId !== id)` означал «это не сфокусированный таб» (а не «не запущен») → `!`-кружок горел почти на **каждой** строке (в проекте >1 AI-таба только один == activeTabId). Юзер: *«везде восклицательный знак, что это значит; лоадер не крутится»*. Фикс: убрать `activeTabId`-концепцию и `isTabBusyNow`+poll целиком, статус сделать реактивным от собственного `busyMap` (зеркало TabBar). **Runner'ский `prevBusyRef` НЕ трогаем** — auto-run firing по-прежнему зависит от него; picker просто перестал его читать. Ловушка на будущее: `isTabBusyNow` нереактивен — любой UI, читающий его в рендере, обязан иметь собственный реактивный источник (busyMap/store), а не polling. SDK-таб в фоне: busy-edge может потеряться если компонент unmount'ится (latent, см. `fix-claude-busy-detection.md::3a`) — наследуется и TabBar'ом, фикс не ухудшает.

**Где firing:**
- Owner tab: `fireQueueOwner(ownerTabId, triggerTabId)` поп'ит head из очереди ownerTabId и пошлёт команду в runtime **owner'а** (`claude:send-command` для Claude owner, `codex:send-command` для Codex owner). Trigger используется только в логе (стрелка `↩` = self, `⇒` = pivot) и никогда не решает, куда отправлять prompt.
- `findOwnersWaitingOn(triggerTabId)` обходит все queues при каждом busy event, ищет те у кого `runAfterTabId === triggerTabId` (или `runAfterTabId === null && triggerTabId === ownerTabId` для default).

**Target chain-drain: pivot owner ждёт не первый idle-edge, а quiescent target.** Если вкладка A ждёт `runAfterTabId = B`, а у вкладки B в этот момент есть свой runnable Run-after, B получает приоритет: runner сначала стреляет очередь B и **не** fan-out'ит внешних owner'ов, ожидающих B. A получит свой prompt только на следующем natural busy→idle B, когда у B уже нет runnable continuation. Пользовательский контракт: «жду вкладку B» означает «жду пока B закончит свою цепочку», а не «первую итерацию B».

Runnable continuation у target — это не только `runAfterTabId === null`. Если очередь B сама pivoted на C и C уже имеет idle snapshot, B может продолжиться прямо сейчас, значит внешние владельцы B тоже ждут. Если C ещё busy или вообще не был seen-busy в текущей сессии, B не считается quiescence blocker'ом для idle-edge B — иначе A завис бы из-за armed toggle, который ждёт другой источник.

**Success→busy gap считается частью цепочки.** После успешного `send-command` очередь уже может снять head, но агент ещё не успел прислать `busy:true`. На этот короткий промежуток ставится `queueAwaitingBusyStart`: pivoted owners видят target как «queued turn starting» и ждут первый `busy:true`, а не проскальзывают между commit'ом prompt'а и началом нового turn'а. Ошибка/отказ send снимает marker и disarm'ит autoRun/stopAfter как раньше; таймаута для «подождать busy» нет, источник истины — только событие runtime.

**Stale target — lazy validation.** Target валиден если вкладка существует в любом `openProjects` и это не сам owner (`ownerTabId !== targetTabId`). Если target-таб закрыли или он совпал с owner'ом — runner делает `setRunAfterTab(owner, null)` и фоллбэк на own-tab. Не валидируем в store (создало бы зависимость store→workspaceStore). Validation повторяется на каждом busy event и в cold-start subscription.

**UI layout — 2 равных колонки в header (`1fr 1fr`).** Грид с `grid-template-columns: 1fr 1fr; columnGap: 6`. Левая колонка: trigger «on tab» + delay seconds input. Правая колонка: Run after row / Stop after split / Post split — каждая `width:100%` от своей колонки. Все элементы внутри колонок `width:100% + box-sizing:border-box + minWidth:0` чтобы grid реально схлопывал ячейки. Раньше пробовал `90px 1fr` — правая колонка получалась в 2-3 раза шире левой, кнопки выглядели «непропорционально огромными», input «сек» был хардкод 56px и не подтягивался под колонку. Юзер: *«ширина у инпута и триггера одинаковая, и обе равны кнопкам справа»*.

**Фиксированная ширина + drag-resize (не `fit-content`).** Раньше panel был `width: 'fit-content'` с clamp `minWidth/maxWidth [240, 360]` — ширина **прыгала** при каждом добавлении +grab-чипа или смене лейбла кнопки (юзер: *«когда я плюс граб добавляю промт, ширина меняется — она должна быть фиксированная»*). Теперь ширина **фиксированная**, хранится глобально в `useUIStore.promptQueueWidth` (localStorage `noted-terminal-prompt-queue-width`, clamp `[240, 600]`, default 300 — внутри старого fit-content-диапазона, чтобы первый рендер после миграции не дёрнулся; зеркало `timelineWidth`-паттерна, один привычный размер на всё приложение). Drag-resize меняет **только ширину** (высота — это `chipLineClamp` из Settings, её не трогаем). Во время drag рендер идёт из локального `dragWidth` (60fps без store-churn), коммит в store на mouseup.

**Collapsed rail — default surface, panel — раскрываемая деталь.** Run-after root стоит у правой грани терминала, слева от Timeline. В свёрнутом состоянии rail показывает два слоя: верхняя строка — круглые кнопки Timeline (`Cmd+]`) и History (`Cmd+\`), ниже — раскрытие Run after, статус/размер очереди и `+grab`. Статус/счётчик не read-only: клик по нему переключает тот же `autoRun`, что и основной Run after pill, чтобы в свёрнутом и раскрытом состоянии не было двух разных ментальных моделей.

Rail — не мини-панель очереди: сама панель выезжает влево под rail, а rail остаётся постоянной control-strip поверх терминала. Поэтому у него плотная непрозрачная подложка и одинаковые круглые кнопки; прозрачный rail теряется на чёрном терминале/Timeline, а кнопки без общей подложки выглядят разрозненно. Анимация раскрытия короткая (100ms) и именно slide-out, не fade-pop; chevron меняет направление синхронно с движением, чтобы стрелка не врала о текущей фазе. Opening-анимация запускается только после явного клика expand/collapse; при переключении на вкладку, где панель уже была открыта, remount восстанавливает layout без повторного выезда.

Collapsed/expanded state принадлежит вкладке: default = expanded, но если пользователь свернул Run after в конкретном табе, это сохраняется при переключении вкладок и после restart до ручного expand. Collapse записывается в store сразу на click, а closing-анимация остаётся локальной; иначе быстрый переход на другую вкладку в первые 100ms мог бы потерять намерение пользователя.

Когда Timeline раскрыт через `Cmd+]`, root сдвигается левее на ширину раскрытого Timeline минус его collapsed-slot: правая грань Run after примыкает к левой границе expanded Timeline, а не остаётся под ним. Когда открыт `Cmd+\` HistoryPanel, Run after остаётся в той же правой зоне и рендерится поверх HistoryPanel; для этого overlay вынесен из terminal isolation-wrapper'а и получает z-index выше панели истории. Без выноса наружу `z-index` дочернего элемента проигрывает родительскому `isolation:isolate`, и визуально меню оказывается под HistoryPanel при корректных числах z-index внутри себя.

Unpinned Timeline (`timelinePinned=false`) — overlay, а не зарезервированная колонка. Если он раскрыт и пользователь кликает по терминалу, сайдбару или другой обычной области Workspace, `Workspace.tsx` закрывает `timelineTreeModeTabs[tabId]` обратно в rail. Исключение обязательно для `[data-history-timeline-pin-toggle]`: клик по StatusBar pin должен успеть превратить текущий overlay в pinned layout, а не сначала закрыть Timeline на capture-mousedown. Pinned Timeline (`timelinePinned=true`) не закрывается outside-click'ом — это уже layout mode.

- **Resize-handle на СВОБОДНОЙ грани, не на опорной.** Panel раскрывается влево от rail: опорная правая грань остаётся у Timeline, не двигается → handle на ЛЕВОЙ грани, drag влево растит панель (dx инвертируется). Это прямое следствие `🧩 Code-Patterns/.../tooltip-resize-modal.md::Resize только в сторону, противоположную опорной`. Handle на опорной грани оторвал бы панель от якоря.
- **`ANCHOR_SIDE: 'left' | 'right'` — 1-флип-параметр на будущее.** Юзер заложил: меню в будущем может переехать влево. `ANCHOR_SIDE` управляет тремя вещами разом: какая грань pinned (`right:0` vs `left:0` внутри терминальной области), на какой грани handle (`left:0` vs `right:0`), и знак дельты в drag (`right` → `-dx`, `left` → `+dx`). При переезде меню — поменять одну константу, handle и направление роста подстроятся сами. Принцип «resize учитывает визуальное расположение, расширяется только в доступную сторону».
- **Handle flush-inside (`left:0`, width 6), НЕ снаружи (`-3`).** Panel имеет `overflow:hidden` — offset наружу клипнулся бы в тонкую полоску. 6px-зона лежит над левым padding'ом header'а, не над интерактивными контролами. `data-cmd-hover-popover` на handle — чтобы mousedown не закрывал Cmd+Shift-пиннутый popover в другом месте.

**Slideout через `createPortal(menu, document.body)` — обязательно.** Раньше picker рендерил slideout inline (`position:fixed` внутри JSX picker'а). Это **не работало**: panel root имеет `backdrop-filter: blur(8px)`, что по CSS-spec делает его containing block для **любого** `position:fixed` потомка. Coords `top: panelRect.top; right: window.innerWidth - panelRect.left + 6` пересчитывались **от panel'я, не от viewport'а** → менюшка улетала за пределы экрана, клики провалились в пустоту, симптом «кнопка тупо не открывается» (`open=true` в state, нет визуала). Editor slideout не страдает потому что он — sibling panel'я, не descendant; picker живёт **внутри** header'а panel'я, поэтому нуждается в портале. Anchor сейчас передаётся через `panelRef` prop напрямую (не walk-up до `position:absolute` ancestor'а — этот walk был фрагилен: HMR / CSS-in-JS объект-стиль не выставляет inline `style.position`, walk доходил до BODY, fallback anchor был мусором). См. `methodology/сценарии-багов-design.md::10` (Portal-кейсы) и `methodology/переносимый-дизайн.md::position:fixed × ancestor transform`.

**Click-toggle-off в picker'е.** Повторный клик по уже-выбранной строке в dropdown сбрасывает target обратно в null. Без этого юзер для отмены выбора должен скроллить к верхней строке `— no target —`, что для пары AI-табов нормально, для проектов с 10+ табами — раздражает. Реализация в onClick row'а: `setRunAfterTab(tabId, isSelected ? null : t.id)`. Канонический паттерн single-select — см. `methodology/переносимый-дизайн.md::Click-toggle-off на single-select pill`.

**Цвет дотика по AI-runtime, не по `tab.color`.** Раньше я использовал `tab.color` как ключ (`claude → #DA7756, gemini → #4E86F8`), но это давало одинаковую саффрон-точку и PTY Claude, и SDK Claude — юзер: *«отображаются все вкладки терминала, хотя клода не запущен... отметь соответствующим кружочком, SDK ≠ PTY»*. Сейчас отдельный enum `AiTabKind: claude-pty | claude-sdk | codex | gemini` и `AI_KIND_COLOR` map: PTY = `#DA7756` (saffron), SDK = `#D28C5A` (terracotta, ровно как в TabItem.tsx:425 SDK override), Codex = `#10A37F`, Gemini = `#4E86F8`. Источник истины для kind — детектор:
- `tabType === 'claude-sdk'` → `claude-sdk` (regardless of commandType/sessionId — SDK-таб AI-предназначения by definition)
- иначе `commandType === 'claude' && claudeSessionId` → `claude-pty`
- иначе `commandType === 'codex' && codexSessionId` → `codex`
- иначе `commandType === 'gemini' && geminiSessionId` → `gemini`
- иначе таб ВООБЩЕ не показывается в списке (фильтр против bash/run-dev — в них нет turn-end edge, бессмысленно ждать)

**Fingerprint Pattern в селекторе.** Подписка на `openProjects` через селектор возвращающий объект ломает Zustand: `set({openProjects: new Map(...)})` каждый busy event → Object.is видит новую ссылку → re-render → селектор создаёт новый объект → infinite loop → `Maximum update depth exceeded`. Фикс: селектор возвращает строку-фингерпринт (id+name AI-табов), shape деривируется через `useMemo([fingerprint, tabId])` с `useWorkspaceStore.getState()` внутри useMemo. Этот шрам ловится моментально через React HMR, но симптом ругательский (стэк-overflow + бесконечный лог) — см. `fix-performance-lags.md::Fingerprint Pattern`.

### 3. External Editor hijack
Claude Code TUI имеет хоткей `Ctrl+G` → `chat:externalEditor` → `execSync($EDITOR <tempfile>)`. Мы перехватываем это:
- В `pty.spawn` инжектим `EDITOR=~/.claude/hooks/noted-code-grab.js`
- Helper script читает tempfile, шлёт текст в наш Unix socket, опционально truncate'ит файл → инпут Claude очищается

## Lock-file dispatcher — 4 mode помощника

`~/.claude/hooks/noted-code-grab.js` диспетчер по lock-file `/tmp/noted-grab-<claudePID>.json`. Main process пишет lock **перед** отправкой Ctrl+G в PTY:

| mode | Что делает | Lifecycle tempfile |
|---|---|---|
| `grab` | Читает → шлёт в socket → **truncate** | пусто (input Claude очищается) |
| `copy` | Читает → шлёт в socket → **не трогает** | как было (input сохраняется) |
| `clear` | Truncate, **не шлёт в socket** | пусто |
| `<no lock>` | passthrough на `$NOTED_ORIGINAL_EDITOR` (user's Sublime/vim) | редактор юзера управляет |

**Lock потребляется на чтении** (`unlinkSync`) — стейл не может выстрелить случайно на следующий Ctrl+G.

**Поле `sock` в lock-payload — authoritative routing к owner-main'у.** Lock-файл пишет тот main, который отправил Ctrl+G в PTY и держит `grabInputPending[tabId]` Promise. Helper-script обязан вернуть `GrabInput` envelope именно этому main'у, иначе oригинальный main timeout'ит на 3000ms. Раньше helper резолвил sock через cwd-discovery — это ломалось когда dev+prod open'или один cwd (longest-prefix tie, выбирался arbitrarily). Теперь main кладёт в lock `{mode, ts, sock: CLAUDE_HOOK_SOCK}`, helper читает `sock` и connect'ится ровно туда без discovery. cwd-routing остаётся fallback ТОЛЬКО для passthrough-mode (когда lock'а нет — manual Ctrl+G юзера, ожидающего свой Sublime). См. `fix-claude-hook-silent-dropouts.md::Слой 4`.

**Truncate FIRST в `grab` mode:** перед socket-write. Если socket упадёт — инпут Claude всё равно очистится. Recoverable. В `copy` mode — наоборот, **не** truncate, user должен видеть свой текст обратно.

## Имя скрипта — `code` в basename важно

Claude classifies `$EDITOR` по basename:
- содержит `code|cursor|windsurf|codium|subl|atom|gedit|notepad++|notepad` → GUI editor → `inkInstance.pause()` + `suspendStdin()` (тихо, без вспышки)
- иначе → терминальный → `\x1b[?1049h` alt-screen flash, видно как мерцание

`noted-code-grab.js` начинается с `code` → GUI path. Без флэша.

Источник: `packages/claude-code-src/utils/editor.ts:20-30`, `:49-52`.

**`EDITOR_OVERRIDES` ловушка:** Claude дописывает `-w` для `code/subl` (`promptEditor.ts:68`). Lookup **exact**, поэтому `noted-code-grab` не получит `-w` — basename совпадение через `includes`, но override map по точному имени.

## Защита от user-zshrc clobber

У юзера в `~/.zshrc` может быть `export EDITOR="/usr/local/bin/subl -w"`. Когда наш shell-integration source'ит user-zshrc — он **затирает** наш EDITOR injection. Решение в `setupShellIntegration`:

```bash
__ct_injected_editor="$EDITOR"      # сохраняем наш до source'а user-zshrc
source "$HOME/.zshrc"               # user-zshrc может затереть EDITOR
# Восстанавливаем наш ТОЛЬКО если path указывает на наш helper:
if [[ -n "$__ct_injected_editor" && "$__ct_injected_editor" == *noted-code-grab* ]]; then
  export EDITOR="$__ct_injected_editor"
fi
# Параллельно сохраняем user'ский EDITOR в NOTED_ORIGINAL_EDITOR для passthrough mode:
if [[ -n "$EDITOR" && "$EDITOR" != *noted-code-grab* ]]; then
  export NOTED_ORIGINAL_EDITOR="$EDITOR"
fi
```

Guard `*noted-code-grab*` — не трогаем случайные пользовательские настройки. Только наши перезаписываем.

## getExternalEditor memoize — рестарт Claude обязателен

`getExternalEditor()` в Claude **memoize'ан на первом вызове** (`utils/editor.ts:164-183`). EDITOR должен быть в env **до** spawn'а Claude. Существующие табы запущенные ДО env injection не получат фичу до перезапуска Claude в табе.

**Pre-flight check в `claude:grab-input`:** через `ps -p <claudePid> -wwwE | grep EDITOR=` — если EDITOR ≠ наш → return `wrong_editor` error code → toast `"Restart Claude in this tab — grab needs our editor helper"`. Без этого юзер кликает grab, Sublime открывается в стороне, никаких ошибок — недоумение.

## Auto-runner — singleton hook, не в overlay

Auto-runner живёт в `src/renderer/hooks/usePromptQueueRunner.ts` и **монтируется один раз в App root** (`App.tsx`), не внутри `PromptQueueOverlay`.

```ts
// App.tsx (mount once)
usePromptQueueRunner();

// Внутри runner:
const prevBusyRef = useRef<Map<string, boolean>>(new Map());
ipcRenderer.on('claude:busy-state', ({ tabId, busy }) => {
  const wasBusy = prevBusyRef.current.get(tabId) ?? false;
  prevBusyRef.current.set(tabId, busy);
  if (wasBusy && !busy) {
    // pop next + send-command, или stopAfter если очередь пуста
  }
});
```

`claudeBusy` приходит из `claude:busy-state` который authoritative от Stop hook (см. `fact-claude-stop-hook.md::Интеграция в claude:busy-state`). Никаких setTimeout, никакого spinner-эвристики — pure event chain.

### Auto-run стреляет ТОЛЬКО на штатный конец turn'а — `reason` на busy-state (горело)

Runner реагирует на фронт `busy:true→false` канала `claude:busy-state`. Но «turn закончился» ≠ «Claude штатно ответил»: turn может оборваться на **API-ошибке** (StopFailure, напр. `API Error: 500`), на **Escape/Ctrl+C** (InterruptStop), или зависнуть и быть сброшенным **watchdog'ом** (60 мин). Все эти исходы технически дают `busy:false` — и если runner их не отличает, он **заливает следующий промпт в сломанный/прерванный turn**. Юзер: *«если выпала ошибка или я нажал Escape — run-after не должен срабатывать, а наоборот деактивироваться»*.

**Ловушка двух каналов.** Различие успех/ошибка (`event`, `success: event !== 'StopFailure'`) main шлёт **только** на `claude:turn-state`. Loader-канал `claude:busy-state` исторически слал **голый `{tabId, busy:false}` без reason** для ВСЕХ исходов — natural Stop, StopFailure, InterruptStop, watchdog неотличимы. Runner слушает `busy-state` (не `turn-state`), поэтому видел только `busy:false` и стрелял очередью на каждом. Изначально скипался лишь `reason === 'manual-stop'` (кнопка Stop) — единственный путь, который reason проставлял (`terminal:stop-ai-process` → `stopBusyState()`, main.js).

**Фикс — протянуть `reason` на busy-state на всех аномальных концах** (зеркало `manual-stop`-паттерна), runner скипает весь набор:
- `manual-stop` — кнопка Stop / context-menu / двойной Esc (был).
- `error` — `event === 'StopFailure'` (API/inference error). main.js Stop-hook: `reason = (!busy && event === 'StopFailure') ? 'error' : undefined` — **только** на busy:false-конце; natural Stop и busy:true-старт остаются reason-less.
- `interrupt` — Esc/Ctrl+C: оба пути (JSONL-marker watcher `[Request interrupted by user]` + idle-probe для «Esc до первой записи в JSONL»).
- `watchdog` — Stop не пришёл за `CLAUDE_TURN_WATCHDOG_MS`, turn завис/мёртв.

Runner: `const SKIP_REASONS = ['manual-stop','error','interrupt','watchdog'];` — **allowlist, не `reason !== 'natural'` catch-all** (fail-safe: будущий reason-less или явно-natural путь по-прежнему стреляет, регрессий auto-run нет).

**Ignored non-turn reasons (`spinner`, `local-command`) + исключение `/compact`.** Не каждый `claude:busy-state busy:false` с `reason` означает «turn завершился ненатурально». Два reason'а существуют только для UI-liveness:
- `spinner` — PTY glyph heuristic, может флапать между thinking phases. Renderer может сгладить его визуально, но runner не должен ни fire, ни disarm.
- `local-command` — bracket для inline slash-команды. По умолчанию completion/cancel такой команды не является successful assistant turn-end и не должен ни fire, ни disarm.

Успешный `/compact` — намеренное исключение. Main стартует watcher только для `/compact`, шлёт `busy:true reason:'local-command'`, а на durable marker (`compact_boundary`, `isCompactSummary`, stdout `Compacted`, fallback `pty-output-compacted`) закрывает busy как `reason:'local-command', localCommand:'/compact', localCommandReason:<marker>`. Runner проверяет именно эту пару и продолжает обычный firing path: для пользователя compact — часть цепочки очереди, после него должен уйти следующий prompt. `timeout`, `input-escape`, `input-ctrl-c`, другой slash-command или `local-command` без `localCommand:'/compact'` остаются ignored non-turn edge: loader гаснет, очередь остаётся armed, но ничего не отправляется.

Шрам 2026-06-15: пользователь поставил Run after, первым item ушёл `/compact`, loader Claude корректно погас после compact, но следующий prompt не отправился до ручного действия примерно в 13:30 МСК. Корень был в старом blanket-guard'е: runner видел `reason:'local-command'` и всегда делал `return`, хотя compact уже завершился durable boundary. Поэтому в этой секции важно не возвращать старую формулу «local-command никогда не fire» — она верна для cancel/timeout, но неверна для successful `/compact`.

**DISARM, не skip-once (вторая половина фикса, доделана позже).** Изначально на `SKIP_REASONS` runner делал `return` — пропускал ОДИН запуск, но `autoRun` оставался `true`. Этого мало: юзер жал Escape чтобы вмешаться → autoRun жив → следующий **натуральный** Stop (reason-less) стрелял очередью в контекст, куда юзер уже влез. Юзер: *«если нажал Escape чтобы уточнить — run-after должен ВЫКЛЮЧИТЬСЯ, а не молча продолжить»*. Поэтому на любом `reason` из `SKIP_REASONS` теперь **disarm**: для каждой затронутой owner-очереди `setAutoRun(false)` + `setStopAfter(false)` (каскадит `closeAfter→false`) + `clearFirstDelayCountdown` (гасит «секундомер» first-delay). Затем `return` (firing-пути ниже не достигаются). Натуральный Stop (reason-less) проходит мимо disarm-блока и стреляет как раньше.
- **Fan-out disarm'а = fan-out firing'а:** цикл по `queues`, `effectiveTrigger = q.runAfterTabId ?? ownerTabId; if (effectiveTrigger !== tabId) continue` — та же логика что `findOwnersWaitingOn`. Значит обрыв **target**-таба disarm'ит **owner**-очередь (pivoted), симметрично тому как завершение target'а её бы запустило. Own-tab (`runAfterTabId === null`) — тоже.
- **Почему НЕ перехватываем клавиши вручную (Escape/Ctrl+C/Ctrl+]):** причина остановки уже классифицирована в `reason` (main: `interrupt` = Esc/Ctrl+C через JSONL-marker watcher + idle-probe; `manual-stop` = кнопка; `error` = StopFailure; `watchdog` = зависание). Слушаем **причину**, не keystroke — единый сигнал вместо ручного парсинга. Это и есть «отслеживать по какой причине была остановка Claude».
- **Решение «любой обрыв → disarm»** (не «только ручные → disarm, ошибки → skip») — выбор юзера: максимально предсказуемо, после любого ненатурального конца тумблер off, переармить вручную.
- **Store-безопасность:** до 3 сеттеров × N owner = всё равно ОДНА debounced SQLite-запись (`scheduleSave` 250ms, shared timer). Итерация по снапшоту `queues` безопасна — сеттеры строят `new Map`, не мутируют итерируемый объект. Gemini: `gemini:busy-state` всегда reason-less → guard `if (reason && ...)` ложен → natural gemini-конец никогда не disarm'ится.

**Тонкости которые держать в голове:**
- Гард стоит **выше** обоих путей (step-1 pivot + step-2 own-tab) → pivoted-очередь (`runAfterTabId`) тоже НЕ стреляет если оборвался **target**-таб. Симметрично `manual-stop`.
- **Аддитивно к loader'у:** `prevBusyRef.set(tabId, busy)` пишется ДО гарда; все консьюмеры (`App.tsx`, `TabBar`, `InfoPanel`, `ClaudeControlBar`, picker `busyMap`) читают только `{tabId, busy}` и игнорят `reason` → спиннер гаснет на всех исходах как раньше.
- **Натуральные reason-less пути НЕ трогаем:** SDK-форвард `claude-sdk:busy-state` (нет error-канала), PTY-onExit / `terminal:kill` cleanup (таб/PTY уже мёртв — send в мёртвый таб no-op), legacy reason-less cleanup paths. Все они = natural → стреляют. Reasoned `spinner` уже отфильтрован выше как UI-liveness, не turn-end. **Gemini:** `gemini:busy-state` имеет только spinner-on/off, нет StopFailure/Interrupt-канала → каждый `busy:false` натуральный, fix Claude-only.
- **Codex:** `task_complete` — штатный конец turn'а и должен стрелять Run after, даже если внутри ответа были approval/question/tool стадии. `turn_aborted`, `send-command-failed` и `send-command-error` — ненатуральные исходы, они disarm'ят очередь тем же путём что Claude interrupt/error. Важная граница: для Prompt Queue не нужно знать, «писал ответ» Codex или «ждал выбор стрелочками» — пока streaming/turn продолжается, это один busy-state.
- **Codex Escape считается только через rollout-событие:** физическую клавишу `Escape` runner напрямую не парсит. Если Codex записал `turn_aborted`, очередь disarm'ится; если визуально остановился без `turn_aborted`, Claude-style idle-probe fallback для Codex пока не включён. Не добавлять его «для симметрии» без реального симптома — текущая архитектура намеренно держится на high-level JSONL-событиях.
- **Send commit после успешного IPC:** runner больше не удаляет head до отправки. Он сначала берёт snapshot head, вызывает `claude:send-command` / `codex:send-command`, и только после success делает commit того же id. Если handler отказал (`no_codex_session`, `send-command-failed`, shell/PTY не тот) — prompt остаётся в очереди, но autoRun/stopAfter disarm'ятся. Это защищает от потери чипа при мёртвом AI-процессе и от вставки в обычный shell.
- **Закрытые owner/target табы чистятся из очередей:** `closeTab` / `closeProject` и lazy runner-cleanup удаляют queue закрытого owner'а и сбрасывают `runAfterTabId` у очередей, которые на него смотрели. Target теперь валиден во всех открытых проектах, но только если вкладка реально существует в `openProjects` и не совпадает с owner'ом. Иначе pivot мог ждать busy→idle закрытой вкладки бесконечно или замкнуться на самого себя.
- **Schema-drift риск:** тег `'error'` висит на строковой константе `event === 'StopFailure'`. Если Claude переименует событие — путь регрессирует к firing (как и `success`-флаг на turn-state, та же единственная константа).

См. `fact-claude-stop-hook.md` (Stop/StopFailure/InterruptStop события) и `fix-claude-aborted-streaming-loader.md` (aborted_streaming не fires hook → JSONL-marker watcher).

### Почему не в overlay (первая реализация была там и сломалась)

Overlay рендерится через гейт `effectiveActive && isClaudeTab && hasClaudeSession && claudeProcessAlive`. `effectiveActive` становится `false` как только юзер уходит на другой таб / Dashboard / Home view → React unmount'ит overlay → `useEffect` cleanup → `prevBusyRef` теряется.

**Симптом который мы поймали:** юзер армит "Run after", уходит на gemini-таб работать, Claude в фоне закончил turn → `claude:busy-state busy=false` приходит → **никто не слушает** (overlay unmounted) → следующий промпт не отправляется. Возвращается на Claude-таб → overlay re-mounts → `prevBusyRef.current = claudeBusy` (текущее значение, не old) → пропустили edge transition → **ничего не происходит**. Юзер думает что фича сломана.

**Решение:** singleton hook на верхнем уровне, не зависит от того что показано на экране. State хранится в `useRef<Map<tabId, boolean>>` — per-tab busy tracking без React state churn. Идентичная семантика, но **глобальный scope**.

### Cold-start через store subscription

Когда юзер добавляет промпт через `+ grab` / `+ add` в **idle** Claude таб — autoRun должен сразу отправить, не ждать первого busy→idle цикла (которого никогда не будет если Claude уже idle).

Реализация: вторая часть hook'а подписывается на `usePromptQueueStore.subscribe` и ловит **два независимых edge'а**, любой из которых триггерит fire когда `claude is idle && queue.autoRun && items.length > 0`:

- `items 0 → N` — юзер добавил chip когда autoRun уже армлен.
- `autoRun false → true` — юзер только что нажал «Run after» когда items уже стояли в очереди (например, Claude закончил отвечать, юзер забыл нажать Run after до отправки промптов, потом вспомнил).

Второй edge — реальный шрам: без него юзер арм-ал Run after поверх готовой очереди и ничего не запускалось до следующего вручную отправленного промпта (которого он не собирался отправлять — для этого и была очередь). Re-entrancy guard `firing = true/false` защищает от двойного fire (popNext → state change → ещё один subscribe-callback → потенциальная рекурсия).

### Auto-disarm

Когда последний элемент покинул очередь, `setAutoRun(false)` — pulsing pill гаснет визуально. Юзер видит что очередь завершилась. Реализуется через `beforePop === 1` check (читаем длину **до** popNext, если была 1 → теперь будет 0 → disarm).

## Toast UX — `Copied: "first 20 chars…"`

Сразу после copy/grab показываем превью того что попало в clipboard/queue. Одна строка, 20 символов, ellipsis. Multi-line schлёпывается в single-line через `text.replace(/\s+/g, ' ')`.

**Зачем:** юзер не видел финальный вид (Claude collapse'ит paste в `[Pasted text #N +M lines]`). Toast = подтверждение **что именно** ушло. Если ушло что-то не то — юзер замечает через 1.5 секунды, может поправить.

## Post-prompt: per-tab суффикс для каждого элемента очереди

В шапке очереди живёт сплит-кнопка `▣ Post | ✎`: левая зона — per-tab toggle `postPromptEnabled`, правая (✎ карандашик) открывает slideout-редактор в режиме `isPostPromptMode`. Когда toggle включён — runner аппендит `\n\n${postPromptText}` к **каждому** элементу очереди прямо перед `claude:send-command`. Per-tab — у разных Claude-табов могут быть свои post-prompt'ы (типовой сценарий: в одной вкладке гоняем рефакторинг с системным «не трогай тесты», в другой пишем тесты с «всегда добавляй edge case for null»). Empty text + toggle ON = no-op (suffix не аппендится), но визуально toggle всё ещё «active» с tooltip-намёком «click ✎ чтобы наполнить» — иначе юзер думает «включил, ничего не работает».

**Replay (▶ на чипе) намеренно обходит post-prompt.** Replay = «верни текст в композер чтобы посмотреть глазами и отправить руками»; auto-аппенд суффикса там сломал бы инвариант «вижу ровно то что отправлю». Runner-аппенд только для авто-pop'аемых элементов очереди.

## First-chip armed hint: красный blink + приглушённый pending-state

Когда `items.length === 0 && autoRun === false` и юзер дёргает `+grab` / `+add` — Run after pill получает один красный `pq-hint-blink` (0.7s), а затем остаётся в очень приглушённом красном состоянии до явного acknowledgement: пользователь либо нажал Run after, либо вручную удалил последний элемент очереди. Hover больше не гасит hint: наведение = inspection, не согласие. Это состояние также отражается на свёрнутой rail-кнопке со счётчиком, иначе в default-collapsed режиме пользователь не увидит что очередь есть, но Run after не armed.

Смысл цвета — не error и не destructive, а unresolved pending: «у тебя есть queued work, но автоматический запуск ещё не включён». Поэтому base-state специально слабый (`low-red` фон/рамка/текст), а яркий `#ef4444` живёт только в коротком blink-overlay. Анимация перезапускается на каждом re-arm'е через `key={blinkKey}` remount span-overlay'я (иначе React не дропнет завершённый animation state). Принцип переносимый — см. `methodology/переносимый-дизайн.md::Animation-driven hint: blink для внимания, tint для нерешённого состояния`.

**Шрам про палитру.** Первая реализация использовала янтарный `#d97706` (типичный «attention» цвет в проекте). Юзер прочитал его как «оранжевый» и спутал с **уже** оранжевым активным состоянием Run after — hint визуально неотличим от state. Переделали в чистый красный `#ef4444`: красный нигде больше в panel-кластере не задействован, читается однозначно как «обрати внимание». Принцип переносимый — см. `methodology/переносимый-дизайн.md::Hint colour ≠ active colour`.

**Шрам про длительность.** Первая версия — 5×0.5s = 2.5s — юзер прочитал как «слишком долго мельтешит» (*«около 5 раз мигает красная кнопка [...] она должна мигать где-то секунды 2, то есть покороче»*). Вторая версия — 2×0.7s = 1.4s и auto-consume после окончания — убирала красный полностью, но теряла смысл «очередь есть, Run after не включён». Текущий контракт: blink один раз, дальше не яркий красный latch-state до Run after / empty queue.

## Replay (▶) на чипе + guard от bash/zsh

Слева на каждом чипе — кнопка ▶. Клик пастит текст чипа в input owner-runtime через IPC `claude:append-input` или `codex:append-input`, которые внутри вызывают `safePasteAndSubmit({submit:false, stashFirst:false, ctrlCFirst:false})`. Без `submit:true` — текст ложится в композер без Enter, юзер ревьюит и сабмитит сам. Без `stashFirst` — текущий draft TUI не трогается (мы аппендим к existing input, не замещаем).

Cmd+hover по ▶ меняет кнопку в «send now» состояние, а Cmd+click пастит и сразу отправляет Enter. Это не новый action рядом с Replay, а ускоренный вариант того же переноса: обычный клик = «положи в input на ревью», Cmd+click = «я уже уверен, отправь». В renderer есть fallback на случай dev-HMR рассинхрона: если новый renderer передал `{submit:true}`, но старый Electron main ещё не перезапущен и вернул success без `submitted:true`, renderer через короткую паузу шлёт `terminal:input '\r'` сам. Пользовательский симптом этого рассинхрона: «вставка сработала, но Enter после не сработал» — по логам видно start append fast=true без последующего `Sent Enter`.

**На success — чип удаляется из очереди** (`removePrompt(tabId, it.id)` в renderer-handler). Семантика replay = **переезд** промпта в input, а не копия. Юзер сформулировал: *«если перемещение прошло успешно — у нас он должен из очереди удаляться»*. Без удаления тот же текст потом мог бы повторно выстрелить через auto-run drain — двойная отправка. На error (`!res.success` или исключение в IPC) — чип остаётся, юзер ретрайнет. Дополнительный side-effect: если это был **последний** чип очереди, removePrompt на transition 1→0 каскадно гасит `stopAfter/closeAfter` через store-mutator (см. секцию Stop/Close split ниже) — replay = «я сам этим займусь дальше», promise-state X-after становится беспочвенным.

**Spinner on the button while IPC is in flight.** Replay roundtrip — ~400-800ms (Ctrl+G grab → helper write → main IPC paste). Без видимой in-flight индикации юзер двойным кликом ставит вторую `claude:append-input` параллельно, потом `removePrompt` дважды — второй уже на несуществующем id. Guard через `replayingIds: Set<string>` в локальном state'е: на entry в handler добавляем id, кнопка для этого chip'а рендерится с `<span class="pq-spinner" />` вместо `▶` + `disabled` + статичный hover-палитра. Hover-handlers `if (replayingIds.has(it.id)) return;` чтобы стиль не дёргался при движении курсора. В `finally` удаляем id из set'а (на success чип всё равно уже исчез через removePrompt — set-операция no-op).

**Hard guard в main-handler — источник liveness = `bridgeKnownSessions`, НЕ `claudeCliActive`.** Без guard'а вообще: Claude exit-нулся между renderer-снимком и приходом IPC → bracketed paste чипа улетает в живой shell-parent PTY (bash/zsh). Современный zsh поддерживает bracketed paste mode → весь чип становится **одной shell command-line**. Чип `rm -rf node_modules` отрабатывает мгновенно, чип `sudo apt remove ...` запрашивает пароль. Handler сразу `return { success: false, error: 'no_claude_session' }` если сессии нет; renderer показывает toast «No Claude session for replay». Тело чипа открывает редактор по клику; ▶ и × используют `data-chip-action` + `stopPropagation`, чтобы клик не пробил в тело.

**Шрам: guard был на `claudeCliActive` → Replay падал на AutoResume'нутых табах, хотя auto-run работал.** Первая версия гейтила `if (!claudeCliActive.get(tabId))`. Это **неверный флаг** для liveness: `claudeCliActive` = «Claude *сейчас обрабатывает* turn», ставится **только** explicit-spawn путями (`claude:run-command`, MCP, handshake), пуст на idle-prompt'е и — ключевое — **никогда не ставится при AutoResume**. AutoResume пишет `claude --resume <id>` прямо в PTY через `terminal:input` (renderer, `App.tsx`); этот путь наполняет `bridgeKnownSessions` через `handleSessionDetected`, но `claudeCliActive` не трогает вообще.

Результат — **three-way асимметрия guard'ов на одном живом PTY**: три хендлера, пишущие в один и тот же Claude-инпут, проверяли разные источники:

| Handler | UI-триггер | Guard | На resumed-табе |
|---|---|---|---|
| `claude:send-command` | auto-run, Model/Effort | (нет guard'а) | ✅ работает |
| `captureClaudeInput` | grab / copy | `bridgeKnownSessions` | ✅ работает |
| `claude:append-input` | **Replay ▶** | `claudeCliActive` ❌ | ❌ `no_claude_session` |

Симптом юзера: *«run after сам работает в авторежиме корректно, но при нажатии на эту кнопку вручную вставка в инпут не хочет работать»* + красный тост `Replay failed: no_claude_session`. Прод-подтверждение (tab-5, сессия `59cf2ebf`, 2026-06-03): таб AutoResume'нут в 19:10:17 (`[AutoResume] Resumed … claude --resume`), `bridgeKnownSessions` знает сессию (auto-run `send-command` отрабатывал), но `claudeCliActive` пуст. В 19:34:36–44 — **4× `[append-input] ❌ Claude not active`**; в 19:34:48 (12 секунд спустя, тот же таб, тот же живой Claude) — `send-command` паста прошла за 247ms. Один и тот же инстанс Claude: append-input отказывает, send-command работает.

**Фикс:** guard `claude:append-input` переведён на `bridgeKnownSessions.has(tabId)` — тот же источник liveness, что у sibling-хендлера `captureClaudeInput`. Anti-`rm -rf` интент сохранён: чистый bash/zsh-таб без зарегистрированной Claude-сессии в `bridgeKnownSessions` по-прежнему отклоняется. Переносимый принцип: **liveness-guard для записи в Claude PTY = `bridgeKnownSessions` (процесс жив), не `claudeCliActive` (процесс занят turn'ом).** `claudeCliActive` ≠ liveness — это документировано и в CLAUDE.md (anti-pattern про `claudeCliActive` = «currently processing», пуст на idle) и в `fact-claude-tui-control.md` / комментарии `claude:get-presence` (main.js: «liveness belongs to hasBridge, never to isBusy»). Любой новый PTY-write handler обязан гейтить на `bridgeKnownSessions`, а не `claudeCliActive`.

**Codex replay guard — не bridge, а живой descendant process.** У Codex нет Claude-style `bridgeKnownSessions`, поэтому `codex:append-input` не может копировать guard один-в-один. Правильная проверка: под PTY shell должен быть живой Codex descendant; если его нет, handler возвращает `no_codex_session`, чтобы чип не улетел в обычный zsh/bash как shell-команда. Это та же anti-`rm -rf` граница, но с другим источником liveness: у Claude durable bridge подтверждает TUI, у Codex подтверждает дерево процессов.

## Stop/Close split: каскад stopAfter ↔ closeAfter

Бывший «Stop after» pill стал сплит-кнопкой. Левая зона — `stopAfter` (SIGTERM по окончанию очередного turn-а когда очередь пуста, one-shot disarm). Правая — `closeAfter` (после SIGTERM ещё и закрывает таб через `useWorkspaceStore.closeTab(tabId, { skipProcessCheck: true, forceCleanup: true })` — без модалки подтверждения). closeAfter невозможен без stopAfter: закрытие таба при живом Claude процессе бессмысленно. Поэтому `setCloseAfter(true)` каскадно ставит `setStopAfter(true)`; обратно — `setStopAfter(false)` каскадно гасит `setCloseAfter(false)` (orphan "close but don't stop" — недопустимая комбинация). Лейбл переключается «Stop after» ↔ «Close after» в одной CSS-grid ячейке (обе строки в `grid-template-columns: auto`, неактивная `visibility: hidden`) — ширина блока не дёргается. Каждая зона со своим border-radius'ом и border'ом: когда только stopAfter включён, левая зона оранжевая, правая остаётся серой на всех сторонах (не должна наследовать оранж от соседа через общий outer-frame).

**Pre-arm memory: `stopBeforeCloseArm`.** Клик ⏻ из baseline `(stop=off, close=off)` поднимает обе зоны (cascade). Повторный клик ⏻ должен **вернуть к baseline**, а не оставлять `(stop=on, close=off)` — иначе orange-зона зависает без обоснования. Хранится UI-only slot `stopBeforeCloseArm: boolean` (не персистится). `setCloseAfter(true)` пишет `stopBeforeCloseArm: cur.stopAfter` (записываем что было ДО форса); `setCloseAfter(false)` восстанавливает `stopAfter: cur.stopBeforeCloseArm`, обнуляет слот. `setStopAfter(any)` обнуляет slot всегда — клик по левой зоне = новый baseline, прошлая память невалидна. Таблица:

| Старт | Клик ⏻ | Клик ⏻ повторно |
|---|---|---|
| `stop=OFF, close=OFF` | `stop=ON, close=ON` | `stop=OFF, close=OFF` ✓ |
| `stop=ON,  close=OFF` | `stop=ON, close=ON` | `stop=ON,  close=OFF` ✓ |

**Auto-disarm при ручном empty-out очереди.** Если последний чип уходит **руками** (× или ▶ Replay), `removePrompt` на transition `items.length === 1 → 0` дополнительно гасит `autoRun/stopAfter/closeAfter/stopBeforeCloseArm` и активный first-delay countdown. Причина: Run-after/X-after без очереди превращается в зомби-promise, юзер потом удивляется когда будущий turn внезапно запускает новый prompt или убивает агента. Юзер: *«если включен run after, а я удалил последний из очереди элементов — run after должен быть остановлен»*. **Граница против `popNext`** — там очередь опустошается естественно (autoRun-runner отстрелял последний промпт в AI), X-after должен **остаться** armed, чтобы runner на следующем busy→idle edge выстрелил `terminal:stop-ai-process`. Если бы `popNext` тоже триггерил disarm — main use case «отправь N промптов и убей агента» сломался бы. Различие в store-mutator: `removePrompt` гасит, `popNext` не трогает.

**Seam-фикс правой рамки.** Раньше: левая `borderRight: none`, правая `borderLeft: 1px BORDER` (grey 0.08-alpha) — seam рисовала **правая** через свою левую границу. На retina + темном фоне 0.08-alpha 1px-border попадает в subpixel rounding compositing → Chromium периодически дропает draw при relayout (tab-switch overlay mounted, props меняются). На клик-relayout восстанавливается. Плюс `transition: all 0.15s` анимировал смену border-color между табами → 150ms fade orange→grey = «подёргивание внутри». Юзер: *«при переключении вкладок она просто-напросто, блять, пропадает, потом если я заново нажимаю кнопку, она появляется»*. Фикс — перенёс ownership seam'а на **левую** кнопку: full `1px solid` со всех 4 сторон (включая seam = `borderRight`), правая кнопка имеет `borderLeft: 'none'` + три остальные стороны. Seam теперь integer-pixel border-right с непрозрачным цветом, Chromium не теряет. Цвет seam = `leftBorder` (orange/red/grey), семантически правильно — active-зона «прокрашивает» seam своим цветом. `transition` убран — на tab-switch снапит мгновенно. Hover-handler правой кнопки трогает только три свои стороны, seam под управлением leftBorder. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Split-button seam: один owner draws border, не adjacency`.

**Hover policy: только color, не border/background.** На idle-зоне hover красит **только** `color` (текст «Stop after» → orange, ⏻ icon → red). Background и border-color **не трогаются** — они закреплены за state-сигналом. Юзер: *«фон и рамку менять не надо»*. На активной зоне (stop armed → левая orange; close armed → обе red) hover вообще no-op — state уже даёт сильный цвет. Без этого правила hover-эхо конфликтует с armed-эхом (юзер не отличает «hover-orange» от «armed-orange»). См. `methodology/переносимый-дизайн.md::Hover-isolation для split-button` (расширение секции).

Принцип каскада переносимый — см. `methodology/переносимый-дизайн.md::Toggle cascade: dependent ⇒ parent`. Скрытое-но-резервированное «Close after» расширение grid-ячейки — частный случай `methodology/переносимый-дизайн.md::Layout reservation для toggle-able children` (там добавлен абзац про variable-label). Auto-disarm при manual empty-out — `methodology/переносимый-дизайн.md::Promise-state auto-disarm: manual context-drop vs pipeline-drain`.

## Image-paths resolution из grabbed `[Image #N]`

Когда юзер пастит картинку в Claude TUI через Cmd+V (или drag-and-drop), Claude Code не отправляет её сразу — она живёт в **двух местах**:

1. В RAM Claude как `pastedContents: Record<number, PastedContent>` под ключом `pasteId` (счётчик `nextPasteIdRef++`).
2. В тексте input'а — плейсхолдер `[Image #N]` в позиции курсора (`formatImageRef(pasteId)`).
3. На диске — асинхронно через `storeImage()` в `~/.claude/image-cache/<sessionId>/<N>.<ext>`, режим `0o600`, расширение `mediaType.split('/')[1]` (`png|jpeg|jpg|gif|webp|bmp`). Размер cap в RAM: 200 файлов с FIFO eviction. Источник: декомпиленный `packages/claude-code-src/utils/imageStore.ts`.

**Файлы не удаляются в течение жизни сессии.** Удаление плейсхолдера через бэкспейс пруньет **только** in-memory `pastedContents`, файл на диске остаётся. `cleanupOldImageCaches()` запускается ровно один раз — при boot'е Claude — и сносит **все** session-папки **кроме текущей**. Внутри текущей сессии очистки нет.

При финальном submit в API `processUserInput.ts::storeImages` идемпотентно гарантирует что все картинки на диске (повторно пишет если что-то пруньнули) и шлёт `image_url` content-blocks. Это значит: пока live sessionId — все `[Image #N]` имеют живые файлы рядом.

**Наш resolver `resolveGrabbedImagePaths(sessionId, text)`** парсит регексом `\[Image\s+#?(\d+)\]` плейсхолдеры из grabbed-текста (helper приходит с `[Image #N]` дословно — `expandPastedTextRefs` Claude'а раскрывает text-refs, image-refs оставляет литералом). Для каждого id перебирает расширения, ищет файл, отдаёт `{id, path, mediaType, size}` если существует. В `claude:grab-input` resolve добавляем `imagePaths` к ответу, кладём в `QueuedPrompt.imagePaths` через `addPrompt(tabId, text, images, imagePaths)`. Лог `[GrabImages] tab=... sessionId=... refs=N resolved=[#1:46KB,#2:MISSING]` — `MISSING` = ссылка в тексте есть, файл нет (Claude был рестартован после paste, image-cache папка ещё не очищена но текущий sessionId уже другой; либо grab случился в момент когда file write ещё не флашнулся — редко).

Codex устроен иначе: если вставить в live Codex composer быстрым PTY-write голый путь `/var/.../file.png`, Rust TUI считает это paste-burst'ом локального image-path и превращает его во внутренний attachment `[Image #N]`. Это правильный первый UX: пользователь должен видеть нативный Codex image chip, а не транспортный маркер `[imagePath: /tmp/...]`. Проблема для очереди в том, что `+grab` через external editor возвращает уже только placeholder без пути, поэтому Codex image paste отдельно stage'ит путь по `tabId`: bitmap clipboard сохраняется в temp `noted-terminal/codex-images/<tabId>/...png`, text clipboard с локальным image-path регистрируется как уже существующий файл. В live composer всё равно пишется **голый путь**, чтобы TUI сам превратил его в `[Image #N]`.

Fallback для уже съеденного Codex placeholder'а тоже привязан к tabId: `codex:save-clipboard-image` / `codex:stage-image-path` кладут свежий путь в короткий in-memory список, а `GrabInput agent=codex` заменяет пришедший `[Image #N]` на `[imagePath: <staged path>]` уже в тексте очереди/Run after. Если свежего пути нет, текст становится `[imageError: codex_image_path_unavailable #N]`; это намеренно видимая ошибка в позиции картинки, а не суффикс в конце prompt'а. Диагностические маркеры: `[CodexImagePaste:keydown] decision=intercept-bitmap|intercept-text-path`, `[codex:stage-image-path] tab=... path=...`, `[CodexImagePaste:inject] payload=<bare path>`, `[GrabImages:Codex] refs=N pathResolved=M`.

**Граница persistence.** `QueuedPrompt.imagePaths` хранится в очереди вместе с текстом, переживает app restart через `app:setState`. **Но** если Claude в этом табе рестартовали — `cleanupOldImageCaches` снёс старую sessionId-папку, пути валидны на диске только пока live тот же sessionId что был при grab'е. После рестарта Claude в табе chip'ы со старыми imagePaths становятся «текст + сломанные ссылки». UI это пока не визуализирует — индикатор «📎N» рисуется из `it.images` (count), не из `it.imagePaths?.length`.

Для Codex источник истины разделён по фазам. В live composer пользователь видит `[Image #N]`, а путь живёт в tab-scoped staging list; после `+grab` / Run after путь фиксируется в тексте очереди как `[imagePath: ...]`. Если пользователь удалил image chip из input до `+add/+grab`, картинка не считается частью задачи. Если item уже добавлен в очередь, текущий input больше не важен — очередь хранит свой текстовый маркер. Но файл лежит во временной папке; для долгоживущих очередей, переживающих очистку temp, при `Add` нужно будет копировать PNG в стабильное хранилище очереди.

**Что НЕ делает** текущая фича: re-paste картинок при Replay (▶). Кнопка вставляет только текст с плейсхолдерами `[Image #N]` в input Claude — Claude увидит ссылки на несуществующие в его новой `pastedContents` map'е id (если delete-range / fork session). Полноценный image re-attach требует либо (a) копировать файл в clipboard + симулировать Cmd+V в PTY (нужен native paste hook со стороны Claude), либо (b) `/file <path>` команды если она есть. Отдельный pipeline на будущее.

## Editor surface: hover-preview + blur-save

Чип очереди имеет два независимых слоя: `text` = payload, который уйдёт в terminal input; `title` = label карточки. В store на создании есть fallback-label `[N символов]`, но пока AI-title реально генерируется UI показывает маленький title-loader вместо временного текста: fallback нужен для persistence/failure, не как первая «версия названия». `+grab` сначала пытается распознать сохранённый Insert Prompt: если grabbed-текст начинается тем же содержимым (для длинных prompt'ов — exact match первых 50 символов, для коротких — полный prefix), title берётся из сохранённого prompt'а и AI-название не запускается. Это защищает сценарий «вставил готовый prompt через контекстное меню, дописал детали, потом +grab»: пользователь ожидает уже известное имя prompt'а, а не loader и позднее переименование. Если match не найден — `+grab` запускает AI-название, а `+add` запускает его если title input остался пустым на blur/outside-save. Источник — встроенный Settings → AI prompt `Run After Title` (`run-after-title`), поэтому пользователь может менять prompt/model/thinking так же, как для остальных AI prompts. Late response перечитывает текущий item из store и skip'ается если `titleManual=true`: ручная правка title всегда выигрывает у async-генерации. Если API key/model недоступны, fallback `[N символов]` остаётся честным size-marker'ом, а не ошибочным «названием».

ПКМ по карточке открывает маленькое item-menu, а не общий overlay: `Отправлять из очереди` работает как checkbox/toggle для `enabled`, `Обновить название` заново запускает `Run After Title` для текущего `text` с force-режимом. Выключенная карточка остаётся в списке и редактируется как обычно, но runner берёт первый `items.find(enabled !== false)`, а badge/count/empty-out считают только enabled items. Если пользователь выключил последний активный item, это эквивалентно manual empty-out для armed state: `autoRun`/`stopAfter`/`closeAfter` должны погаснуть, иначе UI показывает активную очередь без runnable prompt'а. Визуально disabled — тёмно-малиновый фон + светлый приглушённый текст без ярко-красной рамки: это skip-state, не delete/error. Переносимый принцип — `methodology/переносимый-дизайн.md::Выключенный элемент списка = visible skip-state, не удаление`.

`▶` — альтернативный вход в ту же сущность, поэтому hover по нему открывает **тот же** editor surface, что body-чип / `+add`, а не отдельный tooltip. Визуально editor намеренно состоит только из `input title` → divider → `textarea body`: без header, footer, Cancel/Save и Escape-текста. Save происходит по blur/outside-click; пустой chrome вокруг двух полей здесь вреден, потому что главный контракт поверхности — быстро поправить label/body и уйти кликом в приложение.

Hover-open не autofocus'ит editor, иначе случайный проход мышью по `▶` ворует focus у терминала. Focus ownership начинается только после явного клика/фокуса внутри title или textarea; пока editor focus-owned, mouse-leave из trigger/editor не закрывает его. Клик по самой карточке/чипу переводит editor в pinned-mode с приглушённой серой рамкой: рамка говорит «закреплено», но не должна быть такой же яркой как текст. Hover по `▶` уже не двигает и не закрывает окно. Повторный клик по тому же активному чипу = toggle-close, как outside-click; open-handler обязан подавить same-click reopen, иначе окно исчезает на кадр и тут же появляется снова.

Pinned-mode переживает навигацию через persisted `previewId`: кликнул чип, ушёл на другую вкладку/проект, вернулся — editor должен восстановиться на той же карточке. Но это не означает «игнорировать любой outside click». Ordinary outside-click по терминалу, сайдбару или пустой области делает blur-save, закрывает editor и очищает `previewId`; navigation-click по tab/project/Home делает blur-save без очистки, чтобы возврат восстановил pinned editor. Клик по самой карточке, которая закрывает editor, тоже сохраняет правки title/body перед закрытием.

`+add` использует ту же editor surface, но якорится к началу list/empty-block, а не к верхушке всей панели: визуально это действие добавления элемента в список, а не настройка header'а. Повторный клик по активной `+add` закрывает editor и показывает active-state на самой кнопке. Важный шрам: click-outside listener висит на `window.mousedown`, поэтому trigger-кнопки editor'а помечены как editor-trigger и исключены из outside-close; без этого mousedown закрывает editor, а следующий click тут же открывает его снова.

Editor resize повторяет глобальный паттерн anchored modal, но только по ширине: правый верхний угол закреплён, левая грань и левый нижний угол работают как hit-area для горизонтального drag'а. Нижней ручки больше нет. Высота всегда content-driven: сколько строк получилось после переноса в текущую ширину, настолько вниз и идёт нижняя граница, пока не упрётся в доступное место viewport'а; дальше скроллится textarea внутри. При изменении ширины высота переизмеряется заново, потому что перенос строк меняет scrollHeight. Это возвращает ожидаемую модель «нижняя граница по контенту как раньше» и не даёт ручному resize высоты оставить пустую коробку под коротким prompt'ом.

Для unfocused hover-preview закрытие идёт через global `mousemove` geometric hit-test по rect'ам replay button + editor, а не через `onMouseLeave` на lazy-mounted popover — иначе cursor не успевает перейти в только что смонтированный DOM.

Save существующего изменённого чипа даёт один короткий зелёный flash на самой карточке. Новый чип с ручным title или без AI-title входит зелёной left-to-right wipe-анимацией. Новый чип, у которого сразу стартовал AI-title, входит нейтрально с title-loader'ом и получает зелёный flash только один раз — когда финальное название реально записалось. Иначе пользователь видит два success-сигнала подряд: сначала на временный `[N символов]`, потом на придуманное название, хотя сохранение по смыслу одно. Явное удаление через Trash-кнопку подсвечивает **всю** карточку красным на hover и задерживает `removePrompt` до right-to-left exit-анимации. Replay-success по `▶` удаляет чип сразу: prompt уже перемещён в input, и анимация удаления не должна задерживать runner-семантику.

Stale-closure gotcha: blur-save и следующий click могут произойти в одном пользовательском жесте до React re-render. Поэтому replay click и open-editor обязаны читать актуальный item через `usePromptQueueStore.getState()` в момент клика, а не использовать `it.text` / `items` из JSX closure. Иначе пользователь меняет body, сразу жмёт `▶` или другой чип — и действие применяет старый payload.

## Focus terminal перед `clear-input`

После `copy-input` тут же шлём `clear-input` IPC → main посылает Ctrl+G → helper truncate'ит tempfile → Claude перечитывает → инпут гаснет. **Но** если фокус был на InfoPanel-кнопке, Ink render-loop в неактивной browser-вкладке throttled → "Save and close editor..." flash проигрывается **только когда юзер кликнет в терминал**. Симптом: юзер копирует → инпут стоит → кликает в терминал → инпут мгновенно гаснет ("какой-то flash был, потом стёр").

Фикс: `focusActiveTerminal()` **между** showToast и `clear-input` IPC. RAF-обёртка → фокус → Ctrl+G в активный render-loop → мгновенная обработка.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `~/.claude/hooks/noted-code-grab.js` | Helper script, lock-file dispatcher |
| `/tmp/noted-grab-<claudePID>.json` | Mode lock-file, consumed on read |
| `/tmp/noted-terminal-claude-hook.sock` | Unix socket для GrabInput payload |
| `src/main/main.js::captureClaudeInput` | Shared между `claude:grab-input` и `claude:copy-input`. Делает `process.kill(claudePid, 0)` alive-probe перед всем — если кэш PID мёртвый, возвращает `stale_pid` сразу, не пишет lock и не шлёт Ctrl+G. См. [`fix-prompt-queue-stale-pid.md`](fix-prompt-queue-stale-pid.md). |
| `src/main/main.js::claude:clear-input` | Fire-and-forget вариант без socket roundtrip |
| `src/renderer/store/usePromptQueueStore.ts` | Per-tab queue + autoRun + stopAfter state |
| `src/renderer/components/Workspace/PromptQueueOverlay.tsx` | UI overlay (gated by active tab) — only renders pills/chips/editor, NO runner logic |
| `src/renderer/hooks/usePromptQueueRunner.ts` | Singleton auto-runner. Mounted in App.tsx, fires regardless of which tab is visible |
| `src/renderer/hooks/usePromptQueueWebSync.ts` | Singleton store-subscriber. Диффает per-tab core-JSON, шлёт `web:broadcast-queue` IPC → SSE `queue-update` на телефон. App-root по той же причине что runner (фоновый таб). |
| `App.tsx::handleWebBridge` (`getPromptQueue`/`mutatePromptQueue`) | Read/write мост для мобильного мирора. mutate вызывает те же store-методы (каскады идентичны). |

## Мобильный мирор (Run after с телефона)

Десктопный store — **единственный источник правды**, runner — **единственный движок**. Мобилка читает core через `getPromptQueue`, мутирует через `mutatePromptQueue` (1:1 на store-методы), live-дельты через SSE `queue-update` (пушит `usePromptQueueWebSync`). Owner очереди сейчас может быть Claude PTY или Codex PTY; runner сам выбирает `claude:send-command` / `codex:send-command` по owner-runtime, а mobile mirror только передаёт store-операции. Полная архитектура — `fact-mobile-web.md::Prompt Queue ("Run after") — mobile mirror`. **Любой новый store-метод, меняющий очередь, автоматически доступен с телефона** если добавить его в op-таблицу `mutatePromptQueue` + `QueueOp` (mobile-web/src/api.ts) — реимплементировать логику не нужно.

Для title/body split bridge обязан передавать optional `title` / `titleManual` вместе с core item и update-op. Мобильный список показывает title или fallback, но не запускает AI-title сам и не пересчитывает runner-логику: desktop store остаётся owner'ом правил `titleManual`, AI-generation и remove/replay semantics. Если добавляется новое persistent-поле queue item'а, проверяй сразу три слоя: desktop store, `App.tsx::mutatePromptQueue`, `mobile-web/src/api.ts` + render fallback.

## Что пробовали и почему отбросили

- **Ctrl+C для clear input** — single press в Claude TUI = "clear input" но **также** взводит "Press Ctrl-C again to exit" danger zone. Race: если в момент клика юзера на + grab юзер случайно дёрнет Ctrl+C через keyboard — два подряд → exit Claude. Стало через external editor mode=clear — безопасно, не трогает stdin keystrokes.
- **`/edit` slash command** — нет такого в Claude Code (`packages/claude-code-src/commands/`). `/copy` и `/export` работают над assistant response, не над draft.
- **Stash flow (Ctrl+S)** — кладёт draft в `stashedPrompt` slot, инпут визуально пуст. Но stash восстанавливается **при следующем обычном submit** — если юзер потом напишет `hello\r`, Claude вернёт `<stashed>` + `hello`. Не работает для нашего случая.
- **Double Ctrl+S (stash → pop)** — `handleStash` bi-directional, второй Ctrl+S попнет stash **в инпут**, не очистит. Тупик.
- **Auto-runner внутри PromptQueueOverlay компонента** — первая реализация. Слушал `claudeBusy` prop, делал `wasBusy → !claudeBusy` edge detection через `useRef`. Падало когда юзер переключался на другой таб: overlay unmount'ится по гейту `effectiveActive`, runner с ним умирает, следующий busy→idle transition в фоне не ловится. Переехал в `usePromptQueueRunner` hook на App root. Урок переносимый — любой listener для **глобальных** событий (IPC от main, OS-level signals) не должен жить в gated-by-active-tab компонентах. См. `methodology/переносимый-дизайн.md::Singleton listener для global events, не в conditionally-rendered компонентах`.
- **Silent 3s timeout без specific error code** — был один код `editor_not_wired` на ВСЁ что пошло не так после `term.write('\x07')`. Helper не запустился, ppid не сматчился, socket упал — всё превращалось в одинаковый toast «Helper not reachable» через 3 секунды. Юзер не знал что делать. Прод-лог за 13:20-13:21 показал что одинаковый симптом приходил из **двух** разных источников (мёртвый cached PID + слишком ранний клик после spawn) — оба молчали 3 секунды и оба выдавали тот же toast. Фикс: `stale_pid` отдельным кодом с прямой инструкцией «close & reopen this tab». См. [`fix-prompt-queue-stale-pid.md`](fix-prompt-queue-stale-pid.md), общий принцип — `methodology/переносимый-дизайн.md::Cached external resource: alive-probe перед использованием`.
- **Per-chunk `waitForRender` на slow-mode paste из очереди** — давал 57с гэп между cold-start `popNext()` и фактическим UserPromptSubmit для 50KB payload (56 чанков × 1000ms timeout). Юзер думал что очередь сломана. Root cause: Ink батчит рендеры до `\x1b[201~`, sync marker эмитит один раз в конце, не на каждом промежуточном чанке. Фикс: single write для slow-mode (chunks.length === 1 by construction), один post-write `waitForRender`. См. [`fix-claude-paste-stuck-queue.md`](fix-claude-paste-stuck-queue.md).
- **Stash-detect через `tail.slice(-40)` + `stripVTControlCharacters` + `.includes('Stashed (auto-restores after submit)')`** — первая реализация helper'а который ждёт появления stash-маркера в output buffer перед тем как считать команду применённой. Поймала задокументированный Ink-баг сразу (см. `fact-claude-tui-control.md::Ink TUI: пробелы как ANSI-команды`): Ink эмитит inline-пробелы как `\x1b[<N>C` (cursor-forward escape), `stripVTControlCharacters` сносит их вместе с реальными ANSI-кодами → литерал склеивается в `"Stashed(auto-restoresaftersubmit)"`, `.includes` не матчится. Плюс маркер может лечь через границу `data.split('\n')` (две физические строки в одном PTY chunk'е), плюс длинный стрим assistant-ответа выталкивает stash-маркер за хвост 40-строчного окна. Фикс: сканируем **весь** `terminalOutputBuffer` (cap 500 строк — bounded, не растёт бесконечно), join → один strip-pass → tolerant regex `/Stashed\s*\(\s*auto-restores\s*after\s*submit\s*\)/`. Регекс с `\s*` терпит и схлопывание пробелов после strip, и сохранившиеся реальные пробелы — оба варианта валидны.
- **Pre-block grab по `claudeSpinnerBusy`** — первая попытка фикса misleading `editor_not_wired` toast'а во время стрима. Логика: если Claude стримит ответ, Ctrl+G no-op'нется в TUI (`chat:externalEditor` binding неактивен mid-turn) → helper не запустится → timeout → красный toast. Решение «не пускать grab вообще пока spinner busy» казалось правильным. Юзер прямо возразил: *«нет, +grab наоборот должен работать когда стриминг — это и есть его смысл, поставить промпт в очередь пока Claude думает»*. Откатили pre-block, остался только hook-confirmed `claudeTurnBusy === true` (короткое окно когда Stop hook ещё не пришёл). Замена для misleading toast'а — diagnostic-on-timeout: snapshot'им size `/tmp/noted-grab-helper.log` ДО `term.write('\x07')` и после 3с timeout. Если log не вырос — helper не запустился (Ctrl+G ate by TUI) → resolve `claude_busy` toast «Claude is busy…». Если log вырос — helper отработал но не достиг socket → `editor_not_wired` остаётся. См. `methodology/переносимый-дизайн.md::Action валиден mid-state — не блокировать по чужому busy-флагу` и `methodology/переносимый-дизайн.md::Diagnose with instrumentation, not guesses`.
