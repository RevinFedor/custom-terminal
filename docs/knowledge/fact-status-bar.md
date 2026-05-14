# Feature: Status Bar

VSCode-style полоса по всей нижней границе окна (поверх terminal + sidebar + Timeline). Высота 22px, шрифт 12px. Реализация в [`StatusBar.tsx`](../../src/renderer/components/StatusBar.tsx), подключён в `App.tsx` между Workspace и Global UI (Toasts).

**Зачем существует.** Глобальный хост для индикаторов и переключателей, которые:
- применимы ко **всему** приложению (не привязаны к конкретному табу/проекту);
- редко используются — не хочется отдавать им место в InfoPanel/TabBar;
- должны быть всегда видны (debug-флаги, default-настройки).

## Что живёт сейчас (правая зона)

| Элемент | Назначение | Persistence |
|---|---|---|
| `Effort: <value>` chip + popup | Default Claude effort для будущих сессий (`none / auto / low / med / high / max`) | `localStorage` ключ `noted-terminal-default-claude-effort` |
| `● bridges` toggle | Подсвечивать невидимые hover-мосты красным (через `HoverBridgeDebug`) | `localStorage` ключ `noted-terminal-debug-hover-bridges` |

Левая зона зарезервирована под будущие git/branch/lints/etc — пока пустая.

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
- **Right-anchor**: `right: window.innerWidth - chipRect.right`. Не left-anchor — иначе popup уходит вправо за Timeline-strip и обрезается. См. [`methodology/design-bugs.md::1.1 Popup уезжает за правый/нижний край`](../methodology/design-bugs.md).
- CSS-bridge через `paddingBottom: 4` ВНУТРИ popup-wrapper'а — gap от popup до chip покрыт hit-area'ой popup'а, курсор может ехать через эти 4px не теряя hover. Wrapper вплотную к chip'у (`bottom: window.innerHeight - chipRect.top`, **без** offset'а).

**Применение к runtime сессии — пока НЕ реализовано.** Селектор только сохраняет выбор. Hookup «при создании нового Claude-таба автоматически отправить `/effort <level>` после handshake'а» отложен — добавится отдельно, когда понадобится. Сейчас юзер просто фиксирует предпочтение, чтобы оно не терялось между перезапусками.

## Bridges debug toggle

При включении выставляется `useUIStore.debugHoverBridges = true`. Подписанные компоненты подсвечивают свои hover-bridge области:
- В `Timeline.tsx` — обёртки tooltip wrapper'ов (tooltip над dot, note-tooltip, fork-tooltip) получают `backgroundColor: rgba(239,68,68,0.30) + outline dashed`. Эти wrapper'ы — это и есть мост (растягиваются по высоте между entry на Timeline и видимой плашкой тултипа).
- Для popup'ов с **отдельным** bridge-rect (Timeline contextMenu, Copy session settings popup) рендерится отдельный `<HoverBridgeDebug>` с pointer-events:none поверх bridge-area.

`HoverBridgeDebug` принимает `containerRef` + `menuRef` + `direction: 'left' | 'right' | 'above' | 'below'`, перемеряется через `requestAnimationFrame` (плавно при изменении размеров). См. [`HoverBridgeDebug.tsx`](../../src/renderer/components/HoverBridgeDebug.tsx).

**Зачем юзеру это** — отладка «popup закрывается, когда курсор должен был остаться в hover-зоне». Включил тогл → увидел красный rect → понятно, куда курсор должен идти и где реально мёртвая зона.

## Расширение status bar

При добавлении новых toggle'ов:
- Используй `<StatusToggle>` (точка-индикатор + лейбл, с glow при ON) для bool-флагов.
- Для multi-value селекторов — pattern из `EffortSelector` (chip-trigger + popup).
- Каждый persistent-флаг — отдельный `load/save` helper в `useUIStore.ts` + ключ `noted-terminal-<feature>`. **Не** объединяй несколько toggle'ов в один JSON-объект — следующий разработчик может добавить флаг и забыть про migration.
- Правая зона — для debug/defaults. Левая — для status-info (git branch, lint counts, тип activeAreas).
- Шрифт 12px унаследуется через root style; кнопки внутри popup'ов могут оставлять свой размер (например, Effort-кнопки 10px согласованы с такими же в InfoPanel).
