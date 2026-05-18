# Feature: ClaudeControlBar (per-tab bottom strip под Terminal)

## Intro

30px-полоса под Terminal-колонкой, видимая когда активная вкладка — Claude (PTY или SDK). Раньше Provider/Model/Effort/Think + Continue/Stop/Refresh/Fork + Copy-prompt + Ctx-meter жили в правой `InfoPanel`-колонке (см. `fact-workspace.md::Two-Column Layout`). Правая колонка удалена; контролы переехали в bar под терминалом, чтобы они были общим знаменателем для PTY и SDK табов, и чтобы Timeline (правее) сохранял полную высоту колонки.

Bar ложится **под** контентом Terminal-колонки, но не растягивается под Timeline'ом — `Timeline` отрисовывается соседом справа от vertical stack `[Terminal | ClaudeControlBar]`, не под ним.

## Layout

Две зоны, разделённые `flex: 1` спейсером:

**Left cluster.** Триплет `[⎘ session-id | Continue/Stop chip | ↻ refresh-timeline]`, форки (`⑂→▭` в новую PTY-вкладку, `⑂→SDK` в новый SDK-таб — только для Claude), Copy-prompt split-pill (`⎘ prompt | + clear` — только для Claude, использует IPC `claude:copy-input`/`claude:clear-input`), context %-meter.

**Right cluster.** Provider (PTY only — SDK гоняет напрямую в Anthropic), Model dropdown, Effort dropdown, Think toggle. Popup'ы открываются **вверх** (`bottom: calc(100% + 4px)`) как плоский ряд пилюль — bar сам внизу, вниз раскрытие некуда. **Right-anchored** (`right: 0`, не `left: 0`) — popup растёт влево от триггера. Без этого Effort popup (последний триггер у правого края окна) обрезался на узких окнах; ширина popup'а зависит от количества effort'ов модели (`low/medium/high/xhigh` или подмножество для DeepSeek), формула «куда умещается» дала бы mid-session flip направления при resize. См. `methodology/design.md::Геометрия popup` (последний абзац про right-anchor для правого cluster'а).

Layout одинаковый для PTY и SDK, но набор контролов разный: для SDK скрыты Provider и (когда DeepSeek) Effort с особыми caps'ами (`getSupportedEffortsForAlias`), Continue превращается в фокус на composer вместо `claude --resume` команды.

## Per-tab state и selectors

Tab-метаданные (`tabType`, `sdkModel`, `sdkEffort`, `sdkThinking`) читаются через **отдельные** primitive Zustand-селекторы на каждое поле. **НЕ** единый композитный селектор — он возвращал бы свежий объект `{}` на каждом рендере, Zustand видит новую ссылку и фурит компонент в бесконечный re-render. Это та же ловушка что в CLAUDE.md anti-pattern «Не подписывайся на Map целиком» (Zustand fingerprint pattern).

PTY-only: `effortLocal` и `thinkLocal` — local UI mirror, который **не** персистится. Раз в life-cycle PTY-процесса (`claude:process-started`) `effortLocal` подтягивается из `useUIStore.defaultClaudeEffort` (auto-inject делает то же самое в TUI). `terminal:command-finished` сбрасывает оба обратно в `undefined` — следующий запуск Claude начнёт с дефолтов из settings, а не унаследует значения от прошлого процесса. См. `fact-claude-tui-control.md::Effort auto-inject`.

## Context % bridge: два разных канала для PTY и SDK

PTY: `claude:bridge-update` IPC event с payload `{tabId, model, contextPct}` — обновляется на каждом ассистентском chunk'е, парсится из bridge JSONL.

SDK: нет IPC. `ClaudeSDKTab` хранит `lastContextUsedTokens` в локальном React-стейте и диспатчит `window.CustomEvent('sdk-context-update', {detail: {tabId, contextPct, model}})` на каждом ассистентском SSE. ControlBar слушает window-event. Мотивация: добавлять новый IPC channel + поле в Tab interface ради одного UI-меридиана — overkill. Window CustomEvent дешевле и не трогает SQLite-схему. Тот же паттерн уже использован для `history-panel:loading`.

## Busy-overlay вместо disabled на правом кластере

Когда команда из правого кластера в полёте (`claude:send-command /model haiku`, `provider:switch`, `claude:toggle-thinking`), кластер визуально маркируется shimmer-полоской через CSS `::after` (`.control-bar-busy-overlay` + `@keyframes control-bar-busy-sweep` в `globals.css`) и блокирует клики через `pointer-events: none` на обёртке.

**Не делать так.** Раньше каждый триггер в кластере имел `disabled={isBusy}` + `opacity: 0.5` в style. Проблемы: (а) `disabled` с серой полупрозрачной заливкой выглядит как «функция сломана/недоступна», а не «занят, подожди»; (б) триггеры с динамическим label'ом (Model, Effort) меняют ширину при изменении значения, плюс disabled на soome платформах меняет padding/border визуально — суммарно блок «съёживается». Юзер: *«сейчас он меняет ширину когда становится дизайблнутым; нужно сделать лоадер, при этом не менял ширину; сделать и дизельблуд, и мигающим красиво»*. Принцип переносимый — см. `methodology/design.md::Busy-overlay вместо disabled`.

## Graveyard

**`setSdkModelCaps({})` в effect с `sdkModelCaps` в deps → infinite re-render loop.** Кэш model-caps загружается через `ipcRenderer.invoke('claude-sdk:get-model-caps')` один раз при mount'е SDK-таба. Изначально dep'ы effect'а были `[isSDKTab, sdkModelCaps]`. Когда main возвращал `{success:true, caps:{}}` (пустой кэш в первой версии endpoint'а), `setSdkModelCaps({})` создавал новую ссылку → effect re-fire → новый invoke → новый `{}` → бесконечно. Симптом — React error boundary с `Maximum update depth exceeded`, render-counter `[CB:R]` рос монотонно. Фикс: убрать `sdkModelCaps` из deps + добавить `Object.keys(r.caps).length > 0` guard (не записывать пустой объект). Принцип переносимый — *empty-object setState в effect deps создаёт ref-loop*, см. CLAUDE.md anti-pattern «Zustand: Не подписывайся на Map целиком» как родственный.

**`provider:get-state` IPC не существовал.** Правильный канал — `provider:get-status` с `{tabId}` payload. AI восстановит из grep по main/ipc — но если повторно столкнёшься с тем что provider state не читается — ищи имя канала, не реализацию.
