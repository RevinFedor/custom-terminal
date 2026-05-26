# Feature: Status Bar

VSCode-style полоса по всей нижней границе окна (поверх terminal + sidebar + Timeline). Высота 24px, шрифт 12px. Реализация в [`StatusBar.tsx`](../../src/renderer/components/StatusBar.tsx), подключён в `App.tsx` между Workspace и Global UI (Toasts).

**Зачем существует.** Глобальный хост для индикаторов и переключателей, которые:
- применимы ко **всему** приложению (не привязаны к конкретному табу/проекту);
- редко используются — не хочется отдавать им место в InfoPanel/TabBar;
- должны быть всегда видны (debug-флаги, default-настройки).

## Что живёт сейчас (правая зона)

| Элемент | Назначение | Persistence |
|---|---|---|
| `Effort: <value>` chip + popup | Default Claude effort для будущих сессий (`none / auto / low / med / high / max`) | `localStorage` ключ `noted-terminal-default-claude-effort` |
| `● kill dev-ports` toggle | Перед каждым запуском npm-скрипта убивать занятые порты проекта | `localStorage` ключ `noted-terminal-free-ports-before-start` |
| `● bridges` toggle | Подсвечивать невидимые hover-мосты красным (через `HoverBridgeDebug`) | `localStorage` ключ `noted-terminal-debug-hover-bridges` |
| `! N` оранжевый chip | Счётчик невалидных файловых путей в AI-промптах (рендерится только если N > 0) | derived, не persist |
| `● freeze tooltips` toggle | Cmd-popup'ы Timeline (tooltip / note / fork) не закрываются по Cmd-release / mouseleave — для инспекции DOM в DevTools | **in-memory**, не persist |
| `⚙` Settings button | Открывает `SettingsModal` | — |

Левая зона зарезервирована под будущие git/branch/lints/etc — пока живёт только `WebServerChip` (LAN IP мобильного web-сервера).

**Чип лимитов Claude — не здесь.** Weekly% Anthropic подписки и per-tab token-cost живут в [`ProjectToolbar`](../../src/renderer/components/Workspace/ProjectToolbar.tsx), не в StatusBar. Причина: chip session-aware (читает `getEffectiveTabId` и активный проект), а status bar — глобальные toggle'ы без привязки к табу. См. [`fact-claude-usage-chip.md`](fact-claude-usage-chip.md).

## EffortSelector: tri-mode trigger

Chip-trigger в status bar открывает popup с 6 кнопками тремя путями:

| Trigger | Состояние | Закрытие |
|---|---|---|
| Клик по chip | pinned-open | Click-outside |
| CMD + наведение на chip | временно открыт | Отпускание CMD + увод курсора с chip и popup |
| Курсор на popup'е | popup_hovered | Увод курсора с popup |

Реализовано через `useCmdKey` + три hover-флага (`chipHover`, `popupHover`, `clicked`). Внешний клик закрывает только pinned-state. Внутри `useEffect` с document-`mousemove` пересчитывает hover-флаги по координатам — это нужно для CSS-bridge'а между chip и popup'ом (4px gap снизу popup'а до верха chip'а, см. ниже).

**Геометрия popup'а.**
- Раскрывается **вверх** (status bar внизу, popup растёт от него к экрану): `bottom: window.innerHeight - chipRect.top`.
- **Right-anchor**: `right: window.innerWidth - chipRect.right`. Не left-anchor — иначе popup уходит вправо за Timeline-strip и обрезается. См. [`methodology/сценарии-багов.md::1.1 Popup уезжает за правый/нижний край`](../methodology/сценарии-багов.md).
- CSS-bridge через `paddingBottom: 4` ВНУТРИ popup-wrapper'а — gap от popup до chip покрыт hit-area'ой popup'а, курсор может ехать через эти 4px не теряя hover. Wrapper вплотную к chip'у (`bottom: window.innerHeight - chipRect.top`, **без** offset'а).

**Применение к runtime сессии — пока НЕ реализовано.** Селектор только сохраняет выбор. Hookup «при создании нового Claude-таба автоматически отправить `/effort <level>` после handshake'а» отложен — добавится отдельно, когда понадобится. Сейчас юзер просто фиксирует предпочтение, чтобы оно не терялось между перезапусками.

## Bridges debug toggle

При включении выставляется `useUIStore.debugHoverBridges = true`. Подписанные компоненты подсвечивают свои hover-bridge области:
- В `Timeline.tsx` — обёртки tooltip wrapper'ов (tooltip над dot, note-tooltip, fork-tooltip) получают `backgroundColor: rgba(239,68,68,0.30) + outline dashed`. Эти wrapper'ы — это и есть мост (растягиваются по высоте между entry на Timeline и видимой плашкой тултипа).
- Для popup'ов с **отдельным** bridge-rect (Timeline contextMenu, Copy session settings popup) рендерится отдельный `<HoverBridgeDebug>` с pointer-events:none поверх bridge-area.

`HoverBridgeDebug` принимает `containerRef` + `menuRef` + `direction: 'left' | 'right' | 'above' | 'below'`, перемеряется через `requestAnimationFrame` (плавно при изменении размеров). См. [`HoverBridgeDebug.tsx`](../../src/renderer/components/HoverBridgeDebug.tsx).

**Зачем юзеру это** — отладка «popup закрывается, когда курсор должен был остаться в hover-зоне». Включил тогл → увидел красный rect → понятно, куда курсор должен идти и где реально мёртвая зона.

## Freeze tooltips toggle

Включает `useUIStore.freezeCmdPopups = true`. В Timeline три `useEffect`-а, которые закрывают Cmd-popup'ы при отпускании Cmd или уводе мыши с tooltip-area, читают этот флаг и **пропускают** ветку закрытия. То есть: открыл Cmd+hover → отпустил Cmd → tooltip остался → можно навестись курсором в любую точку UI (включая DevTools) и спокойно инспектировать DOM popup'а, селекторы, computed styles.

Без этого инспектировать tooltip практически невозможно: Cmd-keyup мгновенно скрывает popup, а попытка зажать Cmd и кликать в DevTools переключает фокус → blur-event → popup-state сброс. Использовался при отладке 8px-bridge ловушки (см. [`fix-timeline-tooltip-stability.md::Layout-child bridge ловушка`](fix-timeline-tooltip-stability.md)) — без freeze diagnostic-логи через `Array.from(children).map(getBoundingClientRect)` пришлось бы добавлять отдельным ref-callback'ом, что засоряло logs/dev.log.

**In-memory (не persist).** Diagnostic-флаги не должны переживать рестарт — иначе юзер забывает выключить, при следующем запуске Cmd-popup'ы «залипают» без явной причины и юзер думает что приложение сломалось.

## InvalidPathsChip — реактивная валидация путей в AI-промптах

Оранжевый chip `! N` слева от шестерёнки. Назначение — пассивно сигналить юзеру «в твоих AI-промптах N файловых путей указывают в никуда, открой Settings». Цвет `#DA7756` (Claude-orange, согласован со остальной accent-палитрой), фон `rgba(218,119,86,0.12)` идле / `0.22` hover. Клик открывает SettingsModal — без скролла к конкретному промпту (можно добавить позже, не приоритет).

**Источник данных:** `usePromptsStore.prompts` (массив AIPrompt с `filePaths[]`) + `useUIStore.docPrompt` (если `useFile === true`, его `filePath` тоже учитывается). При любом `savePrompt`/`deletePrompt` Zustand триггерит подписчиков — chip пересчитывает без какого-либо polling'а.

**Стабилизация ключа для useEffect.** Zustand возвращает новые ссылки на массивы при каждом `set()`, даже если содержимое не менялось — наивная зависимость `useEffect([prompts, docPrompt])` ловила бы re-run на любой мутации store, даже не связанной с путями. Поэтому через `useMemo` собирается плоский массив **всех путей** и сериализуется в JSON — это стабильная строка-ключ, useEffect срабатывает **только** когда реально появился/исчез/изменился хоть один путь.

**Debounce 300ms перед IPC.** Пользователь редактирует поле пути символ-за-символом → каждое нажатие триггерит save → JSON-key меняется → useEffect cleanup → setTimeout 300ms → IPC. Если за 300ms ещё нажатие — таймер сбрасывается. Без этого редактирование короткого пути из 30 символов даёт 30 IPC-round-trip'ов.

**IPC батч-проверка.** Один вызов `ai-prompts:check-paths` принимает массив путей и возвращает `{ missing: string[] }`. В main (`settings.js`) — простой цикл по `fs.existsSync`. Без батча было бы N round-trip'ов через `ai-prompts:check-file` (отдельный helper на один путь, оставлен для inline-feedback в SettingsModal — там как раз нужна точечная проверка одного значения).

**Render-when-N>0, не «всегда серый 0».** Если все пути валидны — chip **скрыт целиком**, а не показывается серой `! 0` плашкой. Принцип «context-irrelevant indicator = hide, не show as 0/N/A» — см. `methodology/переносимый-дизайн.md::Context-irrelevant indicator`. Серый zero шумит и тренирует юзера игнорировать индикатор; absence of chip — самый чистый сигнал «всё ок».

**Hover-подсказка через native `title`.** Содержимое — первые 5 путей с указанием `+N` если больше, и подсказка «Клик → Настройки». Юзер может убедиться какой именно файл сломан, не открывая Settings.

## Settings button (шестерёнка)

Lucide `Settings` size 14, stroke 1.75. Idle — серый `#bbb`, hover — белый + тинт `rgba(255,255,255,0.08)`. Клик открывает `SettingsModal` через prop `onOpenSettings` который пробрасывается из App.tsx. Сейчас это единственный способ открыть Settings из status bar — раньше Settings открывался только через горячую клавишу из Workspace, теперь discoverable.

## Расширение status bar

При добавлении новых toggle'ов:
- Используй `<StatusToggle>` (точка-индикатор + лейбл, с glow при ON) для bool-флагов.
- Для multi-value селекторов — pattern из `EffortSelector` (chip-trigger + popup).
- Каждый persistent-флаг — отдельный `load/save` helper в `useUIStore.ts` + ключ `noted-terminal-<feature>`. **Не** объединяй несколько toggle'ов в один JSON-объект — следующий разработчик может добавить флаг и забыть про migration.
- Правая зона — для debug/defaults + индикаторов проблем. Левая — для status-info (git branch, lint counts, тип activeAreas).
- Шрифт 12px унаследуется через root style; кнопки внутри popup'ов могут оставлять свой размер (например, Effort-кнопки 10px согласованы с такими же в InfoPanel).
- Если индикатор показывает «количество проблем» (как InvalidPathsChip) — render-when-N>0, не «серый 0».
