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

## Related Files
- `src/renderer/components/Workspace/Timeline.tsx` — tooltop logic.
- `knowledge/fact-timeline.md` — general timeline behavior.
