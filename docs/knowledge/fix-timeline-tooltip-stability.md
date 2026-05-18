# Fix: Timeline Tooltip Stability (Resize & Jump Protection)

## Symptoms
- Tooltip closes immediately after mouse release from the resize handle.
- Tooltip "jumps" or content overflows the wrapper after clicking "Expand".
- Mouse hover area becomes disconnected from the visible tooltip after resizing.

## Root Causes & Hidden Intent

### 1. The Transition-Measurement Conflict
**Problem:** `transition: max-height 0.2s` on the tooltip content div created a race condition with `useLayoutEffect`.
- When clicking "Expand", `useLayoutEffect` measured the height *instantly* (getting ~200px at the start of the animation).
- The transition then completed (e.g., reaching 500px), but since dependencies didn't change, the wrapper `height` remained locked at 200px.
- **Invisible Intent:** We completely removed `transition: max-height`. Fast, accurate measurement is more critical for stability than a smooth height animation.

### 2. Static Expanded Height (The Resize Jitter)
**Problem:** In expanded mode, every pixel change in width causes text reflow, which changes the content height. Constant re-measurement triggered re-positioning of the wrapper, causing the tooltip to "jitter" or jump away from the mouse cursor.
- **Solution:** In expanded mode, the wrapper uses a fixed height `60vh` (matching CSS `maxHeight`). 
- **Invisible Intent:** Avoiding measurement-based positioning during resize prevents the feedback loop where repositioning triggers an `onMouseLeave` event.

### 3. The Click-after-Resize Trap
**Problem:** Browsers often generate a `click` event at the end of a long `mousedown` -> `mousemove` (drag) -> `mouseup` sequence if the cursor stayed within reasonable bounds.
- Our `handleClickOutside` listener on `window` caught this "ghost" click. Since `isExpanded` was true, it interpreted it as a click outside the content and closed the tooltip.
- **Solution:** `handleClickOutside` now explicitly checks `tooltipContentRef.contains(e.target)`. Even if the browser fires a click after resize, we ignore it if it originated from the handle (which is inside the content).

### 4. Wrapper Movement & onMouseLeave
**Problem:** When the wrapper moves (due to height measurement updates), the mouse can suddenly be "outside" the new bounds without actually moving.
- **Solution:** `onMouseLeave` is gated by `!isResizingTooltipRef.current`. We also use a 2-frame cooldown after resize to let layout settle before re-enabling height measurement.

### 5. Layout-child bridge ловушка (8px visual gap)
**Problem:** Юзер видит постоянный отступ ~8px между правым краем visible tooltip-content и левым краем Timeline-strip, хотя `popupRightPx` математически прижимает popup вплотную. Изначальные подозрения — `box-shadow`, scrollbar, `marginRight`, padding-right в content'е — все мимо. Через `getBoundingClientRect()` логирование подтверждено: `wrapperWidth=308`, `contentWidth=300`, `wrapperRight === tlLeft`, `contentRight === tlLeft - 8`.

**Root cause:** outer wrapper'а с `display:flex flex-direction:row` имел **два** child'а, не один — `tooltipContent` + второй `<div style={{ width: 8, alignSelf: 'stretch' }}>` помеченный как «CSS Bridge» (для hover-corridor между content'ом и Timeline strip). Flex auto-shrink выбирает размер = `max(child.width)` по horizontal оси, поэтому wrapper тянулся на 8px правее content'а. Wrapper.right совпадал с Timeline.left, но content внутри был прижат к **left wrapper'а** через flex-start (default justify) — отсюда visual gap.

**Solution:** Удалён layout-bridge `<div>` целиком. CSS-overlap `+8` в формуле `popupRightPx` тоже удалён (он раньше компенсировал ту же 8px — теперь компенсировать нечего). Tooltip-wrapper'а имеет только один child (content) — auto-shrink даёт wrapper.width === content.width → визуально вплотную к Timeline.

**Что пробовали и почему не сработало (graveyard):**
- *Подозрение `box-shadow: -8px 8px 30px`* — shadow не входит в layout size, не растягивает родителя. Мимо.
- *Подозрение scrollbar* — у content `overflow: hidden`, scrollbar там не появляется.
- *Подозрение justify-content / alignItems перестановка* — `alignItems: vAlign` это **vertical** ось, не horizontal. Мимо.
- *Поиск visible 8px padding/margin на content'е* — `marginRight: 0px, paddingRight: 14px (внутри box, не снаружи)`. Мимо.
- Помогло только: лог всех children wrapper'а через `Array.from(node.children).map(getBoundingClientRect)`. Тогда сразу видно «kids=2», и второй child = 8px sibling справа.

**Если bridge всё-таки нужен** (на случай рассинхрона `mouseleave` при transit через щель): рендерить как **отдельный `position: fixed; right: tlLeft - 0px; width: 8px` с `pointer-events: auto`** — снаружи wrapper'а, не в layout-row. Тогда bridge не влияет на wrapper.width, но ловит курсор между content'ом и strip.

## Related Files
- `src/renderer/components/Workspace/Timeline.tsx` — tooltop logic.
- `knowledge/fact-timeline.md` — general timeline behavior (см. `Right-anchor через измеренный DOM (popupRightPx)`).
