# Feature: ClaudeControlBar (per-tab bottom strip под Terminal)

## Intro

30px-полоса под Terminal-колонкой, видимая когда активная вкладка — Claude (PTY или SDK). Раньше Provider/Model/Effort/Think + Continue/Stop/Refresh/Fork + Copy-prompt + Ctx-meter жили в правой `InfoPanel`-колонке (см. `fact-workspace.md::Two-Column Layout`). Правая колонка удалена; контролы переехали в bar под терминалом, чтобы они были общим знаменателем для PTY и SDK табов, и чтобы Timeline (правее) сохранял полную высоту колонки.

Bar ложится **под** контентом Terminal-колонки, но не растягивается под Timeline'ом — `Timeline` отрисовывается соседом справа от vertical stack `[Terminal | ClaudeControlBar]`, не под ним.

## Layout

Две зоны, разделённые `flex: 1` спейсером:

**Left cluster.** Триплет `[⎘ session-id | Continue/Stop chip | ↻ refresh-timeline]`, форки (`⑂→▭` в новую PTY-вкладку, `⑂→SDK` в новый SDK-таб — только для Claude), Copy-prompt split-pill (`⎘ prompt | + clear` — только для Claude), context %-meter.

**Copy-prompt split-pill: две кнопки, два IPC.** Левая `⎘ prompt` шлёт `claude:copy-input` — helper читает tempfile, отправляет text в socket, **не truncate'ит** input (юзер видит свой draft). Правая `+ clear` шлёт `claude:grab-input` — тот же helper в `mode='grab'` truncate'ит tempfile **до** отправки text в socket (атомарно copy+clear в одном Ctrl+G round-trip). См. `fact-prompt-queue.md::Focus terminal перед clear-input` про refocus terminal для немедленного re-read'а Claude'ом пустого tempfile.

**Graveyard: двухступенчатый copy + clear.** До переключения на `grab-input` "+ clear" шёл двумя последовательными IPC: `claude:copy-input` (Ctrl+G) → `claude:clear-input` (второй Ctrl+G ~5ms спустя). На быстрых turn'ах второй Ctrl+G падал в input как литерал `^G` потому что Claude ещё был в external-editor cycle от первого. Плюс `claude:clear-input` имел дополнительный guard `if (claudeTurnBusy === true) return claude_busy` которого нет у `copy-input` (см. `fix-claude-hook-silent-dropouts.md`) — асимметрия: copy успевал mid-turn, clear silently dropped. Симптом юзера: *«копирует, но не очищает окно промпта»*, в production-логе видно `[capture-input:copy]` без последующего `[clear-input]`. Atomic `grab-input` устраняет оба корня — один helper-run труncate'ит файл при отправке text в socket.

**Right cluster.** Provider (PTY only — SDK гоняет напрямую в Anthropic), Model dropdown, Effort **inline pill-row** (не dropdown), Think toggle. Popup'ы Provider/Model открываются **вверх** (`bottom: calc(100% + 4px)`) как плоский ряд пилюль — bar сам внизу, вниз раскрытие некуда. **Right-anchored** (`right: 0`, не `left: 0`) — popup растёт влево от триггера. Без этого Model popup у правого края окна обрезался на узких окнах; формула «куда умещается» дала бы mid-session flip направления при resize. См. `methodology/переносимый-дизайн.md::Геометрия popup` (последний абзац про right-anchor для правого cluster'а).

**Effort inline, Provider только иконка — разные стратегии для разных триггеров.** Effort row рендерит все 5 пилюль (`low/med/high/xhi/max`) прямо в баре, активная подсвечена `#DA7756` — выбор постоянно виден без раскрытия, один клик переключает. Provider trigger в свёрнутом виде показывает **только иконку** провайдера (без текстового имени Claude/Zen/DeepSeek), имя осталось в `title` и в раскрытом popup'е. Расхождение намеренное: Effort = 5 значений с близкой семантикой, нужно постоянное визуальное сравнение «активный vs остальные»; Provider = 3 значения с сильным брендингом, иконка `<activeProvider.Icon>` уже различима, текст имени дублирует. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Dropdown vs inline`. До этой переделки Effort был dropdown'ом с триггером `Effort: max ▴` — popup открывался **только** при клике/⌘+наведении, юзер не видел в свёрнутом виде какие уровни доступны, и **не мог** сравнить активный с соседним без раскрытия.

Layout одинаковый для PTY и SDK, но набор контролов разный: для SDK скрыты Provider и (когда DeepSeek) Effort с особыми caps'ами (`getSupportedEffortsForAlias`), Continue превращается в фокус на composer вместо `claude --resume` команды.

## Per-tab state и selectors

Tab-метаданные (`tabType`, `sdkModel`, `sdkEffort`, `sdkThinking`) читаются через **отдельные** primitive Zustand-селекторы на каждое поле. **НЕ** единый композитный селектор — он возвращал бы свежий объект `{}` на каждом рендере, Zustand видит новую ссылку и фурит компонент в бесконечный re-render. Это та же ловушка что в CLAUDE.md anti-pattern «Не подписывайся на Map целиком» (Zustand fingerprint pattern).

PTY-only: `effortLocal` и `thinkLocal` — local UI mirror, который **не** персистится. Раз в life-cycle PTY-процесса (`claude:process-started`) `effortLocal` подтягивается из `useUIStore.defaultClaudeEffort` (auto-inject делает то же самое в TUI). `terminal:command-finished` сбрасывает оба обратно в `undefined` — следующий запуск Claude начнёт с дефолтов из settings, а не унаследует значения от прошлого процесса. См. `fact-claude-tui-control.md::Effort auto-inject`.

## Context % bridge: два разных канала для PTY и SDK

PTY: `claude:bridge-update` IPC event с payload `{tabId, model, contextPct}` — обновляется на каждом ассистентском chunk'е, парсится из bridge JSONL.

SDK: нет IPC. `ClaudeSDKTab` хранит `lastContextUsedTokens` в локальном React-стейте и диспатчит `window.CustomEvent('sdk-context-update', {detail: {tabId, contextPct, model}})` на каждом ассистентском SSE. ControlBar слушает window-event. Мотивация: добавлять новый IPC channel + поле в Tab interface ради одного UI-меридиана — overkill. Window CustomEvent дешевле и не трогает SQLite-схему. Тот же паттерн уже использован для `history-panel:loading`.

## sdkBusy mirror — отдельная подписка для SDK таб'ов

PTY-табы получают `isCommandRunning` от Workspace через OSC 133 D/B (см. `fact-terminal-core.md::OSC 133`). SDK-табы PTY не имеют — этот канал всегда возвращает `false`, и chip/right-cluster никогда не узнают что query сейчас идёт. Решение — ControlBar **локально** подписывается на `claude:busy-state` IPC (main forward'ит туда `claude-sdk:busy-state` через одну общую шину) с guard'ом `isSDKTab && data.tabId === tabId`. Полученный `sdkBusy` подаётся в `SessionActionChip` вместо `isCommandRunning` (только для SDK-режима); для PTY режима остаётся OSC-канал. Это единственный способ узнать busy-state для SDK таб'а на уровне ControlBar, не таская дополнительный prop из Workspace.

## Right cluster для SDK всегда enabled

PTY-режим: правый кластер (Provider/Model/Effort/Think) затемнён когда `!isCommandRunning` — без живого TUI slash-команды улетят в мёртвый shell и потеряются. SDK-режим: параметры применяются **аргументом** при следующем `query()` вызове (см. `fact-claude-sdk-tab.md::Effort gating`), не slash-командой в живой TUI. Юзер может выбрать модель/effort/think **до** первого сообщения, настройки персистятся в `Tab.sdk*` полях, в первый же submit пойдут.

Гард в коде — `const canControl = isSDKTab ? true : isCommandRunning;`. Без этого SDK таб без session_id показывал кластер с `opacity: 0.4` + `pointer-events: none`, юзер видел disabled кнопки и не мог поменять модель до отправки первого prompt'а.

## Visibility guards для clipboard-fork chips

Кнопки `+SDK` (`startNewSDKTab`), `⑂ Claude-F`, `⑂ SDK-F` (fork-from-clipboard) показываются на pristine табах — `!hasAnySession && !isSDKTab`. К этому guard'у добавлен **третий**: `!isCommandRunning`. Без него существовал window между `claude:process-started` (PTY запустил claude) и первой записью bridge'а в `Tab.claudeSessionId` (1-3 сек) — в этом окне юзер видел fork-кнопки одновременно с живым процессом, *«у меня в этой вкладке запущен процесс клода, но одновременно отображаются Claude-F и SDK-F, какого хуя»*. С `!isCommandRunning` guard'ом кнопки прячутся как только OSC 133 D говорит «команда запущена».

## Карта visibility всех кнопок

В исходном коде `ClaudeControlBar.tsx` перед `return` JSX'а лежит ASCII-таблица состояний всех 9 кнопок (`copy-session-id`, `SessionActionChip`, `refresh-timeline`, `⑂→▭`, `⑂→SDK`, `+SDK`, `⑂ Claude-F`, `⑂ SDK-F`, `copy-prompt`) по 6 столбцам (PTY new/running/idle × SDK new/running/idle). Источник правды для UI-state. **При любом изменении guard'а** — обновляй таблицу в коде синхронно (иначе следующий разработчик прочтёт устаревшую карту и сделает противоречивый guard). Юзер: *«можешь в этом компоненте как-то комментариями пометить, чтоб мы на будущее эту хуйню не сохраняли»* — карта нужна именно для предотвращения регресса.

## Busy-overlay вместо disabled на правом кластере

Когда команда из правого кластера в полёте (`claude:send-command /model haiku`, `provider:switch`, `claude:toggle-thinking`), кластер визуально маркируется shimmer-полоской через CSS `::after` (`.control-bar-busy-overlay` + `@keyframes control-bar-busy-sweep` в `globals.css`) и блокирует клики через `pointer-events: none` на обёртке.

**Не делать так.** Раньше каждый триггер в кластере имел `disabled={isBusy}` + `opacity: 0.5` в style. Проблемы: (а) `disabled` с серой полупрозрачной заливкой выглядит как «функция сломана/недоступна», а не «занят, подожди»; (б) триггеры с динамическим label'ом (Model, Effort) меняют ширину при изменении значения, плюс disabled на soome платформах меняет padding/border визуально — суммарно блок «съёживается». Юзер: *«сейчас он меняет ширину когда становится дизайблнутым; нужно сделать лоадер, при этом не менял ширину; сделать и дизельблуд, и мигающим красиво»*. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Busy-overlay вместо disabled`.

## Graveyard

**`setSdkModelCaps({})` в effect с `sdkModelCaps` в deps → infinite re-render loop.** Кэш model-caps загружается через `ipcRenderer.invoke('claude-sdk:get-model-caps')` один раз при mount'е SDK-таба. Изначально dep'ы effect'а были `[isSDKTab, sdkModelCaps]`. Когда main возвращал `{success:true, caps:{}}` (пустой кэш в первой версии endpoint'а), `setSdkModelCaps({})` создавал новую ссылку → effect re-fire → новый invoke → новый `{}` → бесконечно. Симптом — React error boundary с `Maximum update depth exceeded`, render-counter `[CB:R]` рос монотонно. Фикс: убрать `sdkModelCaps` из deps + добавить `Object.keys(r.caps).length > 0` guard (не записывать пустой объект). Принцип переносимый — *empty-object setState в effect deps создаёт ref-loop*, см. CLAUDE.md anti-pattern «Zustand: Не подписывайся на Map целиком» как родственный.

**`provider:get-state` IPC не существовал.** Правильный канал — `provider:get-status` с `{tabId}` payload. AI восстановит из grep по main/ipc — но если повторно столкнёшься с тем что provider state не читается — ищи имя канала, не реализацию.

## Брендирование Claude/Gemini

Два движка имеют закреплённые цвета: Claude — saffron orange `#DA7756`, Gemini — blue `#4E86F8`. Цвет активируется автоматически по типу сессии активной вкладки и распространяется на Timeline-точки, рамку и аксессуары `ActionsPanel`, статус-сообщения, Stop-кнопку (`Stop Claude` / `Stop Gemini`). Resume/Continue chip подстраивается под тип активной сессии — оранжевый текст для Claude, синий для Gemini, чтобы пользователь без чтения лейбла видел, какой движок будет восстановлен. Тот же brand-tint в split-кнопке Stop при multi-select (см. `fact-tabs.md::Multi-select Stop с majority badge`), в Provider-row, в `ApiSettingsModal`, в командных Status Styles (`<code>` тег, фон `#1a1a1a`, hover underline) — единая палитра по всему проекту, без локальных вариаций.

## ActionsPanel адаптируется под движок

Для Gemini-табов скрываются Claude-only опции в `ActionsPanel`: переключатели «Include Reading», «Include Editing», «From Start». Эти концепты завязаны на структуру JSONL Claude (`type: 'user'` с `tool_result`, fork-сегменты, /compact branches) — Gemini-сессии устроены иначе, тогглы для них семантически пустые. Без скрытия юзер видел бы непонятные опции, не дающие эффекта.

Подзаголовок `Copy session` меняется на `Claude JSONL → clipboard` или `Gemini JSON → clipboard` в зависимости от активной вкладки. Юзер видит формат источника без раскрытия dropdown'а — disambiguation в один взгляд.
