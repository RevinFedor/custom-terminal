# Feature: Tab Preview Popover (CMD+hover)

## Intro
Превью карточки таба, появляющееся при наведении с зажатым CMD. Унифицированная компонента `TabPreviewPopover` для двух поверхностей: вкладки `TabBar` и карточки в `ProjectHome` (Active + History). До рефактора TabBar и ProjectHome использовали разные popover-обёртки (`CmdHoverPopover` базовый), визуальный язык расходился — единая компонента устранила это.

## User Flow
1. **Активация**: hover на вкладке/карточке + удержание ⌘.
2. **Контент**: markdown notes (read-only MarkdownEditor) → metadata block (Path / Closed / Created / Type / Messages — состав зависит от поверхности). **Title-блок (имя вкладки bold сверху) удалён** — имя уже видно на самой trigger-карточке, дублировать его в popover'е было visual noise (юзерский запрос).
3. **Resize**: 5 handles (right / left / bottom edges + 2 corners — BR + BL). Тянем — высота notes и ширина popover'а меняются. Width + maxLines персистятся в Zustand (`tabPreviewWidth`, `tabPreviewMaxLines`).
4. **Закрытие**: уход курсора с popover'а + отпускание ⌘.

## Layout & позиционирование

**TabBar popover** (CMD+hover на табах): открывается под табом, содержит только notes (без metadata — для активных табов нет смысла дублировать cwd/type которые видны из контекста).

**ProjectHome split-mode** (CMD+hover на Active/History карточках): **два независимых wrapper'а** вокруг карточки. Верхний — notes (resizable) выше карточки через `top: rect.top + translateY(-100%)`. Нижний — metadata block ниже карточки через `top: rect.bottom`. Оба используют общий `popoverProps` (onMouseEnter/Leave) — переход курсором с одной части на другую через карточку держит popover открытым, уход куда-то ещё закрывает обе одновременно.

**Что пробовали и почему не сработало**: сначала был single-wrapper popover с порядком `title → metadata → notes`, открывался под карточкой. Юзер: *«заметка должна быть над вкладкой, описание под»*. Перенесли в single-wrapper above-режим (notes + metadata в одном блоке выше карточки) — нарушалась mental model «заметка вверху, описание внизу относительно карточки». Только split на два wrapper'а закрывает требование. Финально title-блок (bold имя вкладки сверху popover'а) удалили в обеих поверхностях — имя на trigger-карточке (TabBar/Home-card) и так читается, в popover'е дублирование.

## Persistence

`tabPreviewWidth` (240–900px) и `tabPreviewMaxLines` (2–40) живут в `useUIStore`, ключи `noted-terminal-tab-preview-width` / `-max-lines` зеркалятся в SQLite через стандартный localStorage mirror (mainprocess `app:mirrorLocalStorageSync`). **Хранятся как float**, не int. Юзер тянет до 5.487 строк → store сохраняет ровно 5.487 → рамка на mouseup НЕ скачет. Раньше `Math.round` в setter'е создавал визуальный jump на ~0.5 lineHeight (см. секцию ниже).

Settings stepper (модалка → «Шрифты» → «Превью таба (Cmd+hover)») отображает `Math.round(value)`, onChange передаёт целое — +/- работают шагом в 1. Дробное значение в store видно только при ручном drag.

**localLeftShift не персистится** — только в local React state. При drag за левый край popover растёт влево, фиксируем правую границу. После закрытия popover'а leftShift сбрасывается, при следующем open позиция = `rect.left + viewport clamp`. Это сознательно — persisting leftShift привело бы к тому что popover открывается в неожиданном месте relative к новой trigger-карточке.

## Shrift и padding наследуются от inline notes

`fontSize`, `paddingX`, `paddingY` берутся из `notesEditorFontSize` / `notesEditorPaddingX` / `notesEditorPaddingY` — единого набора для всех трёх surface'ов где рендерится `tab.notes` (inline в `InfoPanel`, slide-out `TabNotesSlideout`, этот popover). Single source of truth: меняешь шрифт в Settings (раздел «Заметки вкладки») → одновременно меняется во всех трёх местах. `lineHeight` для расчёта высоты = `fontSize * 1.5` (MarkdownEditor использует 1.5em line-height для prose). Раньше было два независимых набора полей (`tabNotes*` для inline+preview, `notesEditor*` для slide-out) — рассинхрон шрифта; см. `fix-notes-font-fragmentation.md`.

## Resize handles

5 handles на card-wrap'е (не на card напрямую — card имеет `overflow: hidden` для скруглённых углов, это обрезало бы handles на offset -5px). card-wrap — промежуточный div с `position: relative`, без overflow.

- **right** edge → ширина
- **left** edge → ширина растёт влево, popover сдвигается на `appliedDelta` чтобы правый край стоял на месте (`localLeftShift`)
- **bottom** edge → maxLines (через delta = `dy / lineHeight`, дробное во время drag)
- **corner-br** → width + maxLines (BR — растяжка)
- **corner-bl** → leftShift + maxLines

Подсветка через `data-resize-handle-active='true'` атрибут на mousedown + CSS селектор + `:hover` для покоя — см. `methodology/design.md::Hover-подсветка resize handle через data-attribute`. Удержание подсветки во время drag когда курсор уехал за handle area + корректное состояние после mouseup.

Notes-блок имеет **фиксированную высоту** `maxLines * lineHeight` (`height` + `flex: 0 0 auto`, не `flex:1 + maxHeight`). Без этого короткие notes (5 строк) не реагировали на drag → пользователь видел `+1 строка` в Settings но визуально ничего не происходило. См. `methodology/design.md::Drag-state буфер` секция про CSS-ловушки.

## Drag closure: isDraggingRef + grace period

Wrapper-`onMouseLeave` обычно убивает popover (через `popoverProps.onMouseLeave` из `useCmdHoverPopover`). Во время drag курсор уходит за wrapper-rect → mouseLeave → popover unmount-ится посреди drag'а. Защита:
- `isDraggingRef.current = true` на mousedown handle → блокирует mouseLeave пока drag активен.
- `graceUntilRef.current = Date.now() + 200ms` на mouseup → 200ms grace period, в течение которого случайный mouseLeave от микро-jitter мыши на границе игнорируется.
- На mouseup проверяем `document.elementFromPoint(release.x, release.y)` — если курсор реально вне popover'а, симулируем `popoverProps.onMouseLeave` (иначе popover залипнет с не зажатым CMD, потому что `isPinned` остался `true`).

Также wrapper имеет `padding: 8px` со всех сторон чтобы handles (offset -5) физически попадали внутрь `wrapper.boundingClientRect()`. Без padding mousedown на handle регистрировался как «вне wrapper'а» → 150ms `triggerProps.onMouseLeave` timer убивал popover до того как drag даже стартовал.

## Hover bridge debug

Toggle «bridges» в StatusBar активирует `HoverBridgeDebug` overlay, который подсвечивает зону между trigger-карточкой и popover'ом красной полупрозрачной областью. Triger получает synthetic ref-shim (HoverBridgeDebug читает только `getBoundingClientRect`, не нужны DOM-методы — достаточно объект с `getBoundingClientRect: () => rect`). Direction = `above` если `pos.showAbove`, иначе `below`.

## StrictMode pitfall (важно для maintainers)

`setDragPreview` обёрнут в `useCallback` который синхронно пишет в `previewRef.current` и потом вызывает `_setDragPreview`. Прямое использование `setDragPreview((prev) => { captured = prev; return null })` ломается под StrictMode — updater вызывается дважды, второй раз с `prev = null`, captured затирается. Захват только через `previewRef.current`, никаких side-effects в updater'е. См. `methodology/design.md::React StrictMode: functional updater вызывается дважды`.

## Связи

- `methodology/design.md::Drag-state буфер` — общий паттерн live preview + flush on mouseup, плюс CSS-ловушки (overflow:hidden обрезает handles, height vs maxHeight).
- `methodology/design.md::Hover-подсветка resize handle через data-attribute` — паттерн `data-resize-handle-active`.
- `methodology/design.md::React StrictMode...` — про `previewRef`.
- `fact-project-home.md` секция «Hover Popover (CMD+hover)» — про конкретные карточки Home.
- `fact-notes.md` — `TabNotesSlideout` использует те же паттерны drag-buffer (более старая реализация).
- `fact-settings.md` секция «Шрифты интерфейса» — новые controls «Превью таба» (Ширина + Макс. строк).
