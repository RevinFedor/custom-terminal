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

### 6. Nested popover закрывает РОДИТЕЛЯ при наведении на свой заголовок (one-shot point-test vs continuous guard)

**Симптом.** Cmd+hover entry-tooltip (`Timeline.tsx:4173`, gated by `activeTooltipIndex`) держит внутри footer'а ⚡-чип, hover по которому открывает вложенный single-entry breakdown popover (`Timeline.tsx:5251`, sibling-portal, gated by `singleBreakdownOpen`) с заголовком-тоглом `JSONL / API`. Когда курсор переезжает на этот заголовок — **родительский** tooltip «в какой-то момент» закрывается (интермиттентно). Юзер: *«когда навожусь на заголовок json/api основная модалка закрывается»*.

**Root cause.** Родитель закрывался через свой `onMouseLeave` (4177), keep-alive которого был **one-shot point-test**: на единичной координате leave-события проверял `singleBreakdownPopoverRef.getBoundingClientRect()` и возвращался рано только если курсор уже внутри. Это ровно антипаттерн `сценарии-багов-design.md §2.7`: когда узел уже держится глобальным `mousemove` hit-test'ом, `onMouseLeave` **нельзя** оставлять управлять видимостью — он выстреливает на несколько мс раньше сэмпла mousemove и читает rect, который **транзиентно устарел**. Для single-entry версии окно устаревания шире, чем у работающей range-версии (4858), по двум причинам, которых у range нет:
1. **Flip-up после first paint.** `singleBreakdownFlipUp` ставится `useLayoutEffect`'ом (703-712) ПОСЛЕ первого paint'а: popover монтируется ниже чипа (`top: chipRect.bottom`), затем перепрыгивает выше чипа (`top: chipRect.top` + `translateY(-100%)`). Чип в самом низу родителя → курсор к заголовку (верхняя строка popover'а) идёт ВВЕРХ, выходя за верхнюю границу родителя, ровно когда rect ещё пере-измеряется.
2. **Re-measure на JSONL↔API toggle.** `setBreakdownMode` (2838) — dep `useLayoutEffect`'а (712) → ещё один reposition-транзиент, в котором `onMouseLeave` читает stale rect. Поэтому баг привязан именно к заголовку-тоглу.

Когда point-test промахивается → `isMouseInTooltipRef=false` (4189) → `handleMouseLeaveTooltipArea()` → `setActiveTooltipIndex(null)`. Вложенный popover при этом выживает (его глобальный `mousemove` guard 670-684 родителя не трогает) — отсюда «ребёнок жив, родитель умер».

**Fix (доку-выровненный, §2.7).** Два edit'а:
- **(1)** В `onMouseLeave` родителя (4177): убран one-shot point-test; пока `singleBreakdownOpen` — **полный no-op** (`if (singleBreakdownOpen) return;`). Родитель больше не решает свою видимость по leave-событию во время жеста.
- **(2)** Существующий глобальный `mousemove` guard вложенного popover'а (670-703, который раньше делал только `setSingleBreakdownOpen(false)`) расширен: когда курсор вне чипа И popover'а — дополнительно hit-тестит `tooltipRef` (обёртка родителя = видимый контент + CSS-bridge коридор к Timeline-strip) и, если курсор вне неё тоже, закрывает родителя (`isMouseInTooltipRef=false` + `setHoveredIndex(null)` + `setActiveTooltipIndex(null)`, зеркало `handleMouseLeaveTooltipArea`). `setHoveredIndex(null)` обязателен — иначе CMD-sync эффект (1026: `if (isCmdHeld && hoveredIndex !== null)`) мгновенно реоткрыл бы родителя.

**TDZ-ловушка (поймана adversarial-verify, чуть не зашипилась).** Первая версия фикса добавляла `freezeCmdPopups` (decl 758) и `isLockedTooltip` (decl 820) в **deps array** эффекта на строке 670. Deps array вычисляется **eagerly при рендере** (≈684) — ссылка на `const` объявленный НИЖЕ → `ReferenceError: Cannot access 'X' before initialization` на КАЖДОМ рендере, краш всего Timeline. Closure-тело безопасно (бежит на mousemove, после строки 820), но deps — нет. Лечение: guard'ы читаются ВНУТРИ `onMove` через refs/`getState()` — `isResizingTooltipRef.current`, `isLockedTooltipRef.current`, `useUIStore.getState().freezeCmdPopups`; в deps только `isExpanded` (decl 309, до эффекта). **Правило: значение, объявленное после useEffect, нельзя класть в его deps array — читай через ref или store.getState() в теле closure.**

**Что НЕ трогаем.** Range-версия popover/menu (4858) использует тот же 4181-style guard, но работает (нет flip-up, нет re-measure на toggle) — оставлена как есть; латентный §2.7-шрам, если range-menu когда-нибудь начнёт флипаться. Fork tooltip (5272), note tooltip, resize (4231), lock/freeze, mousedown click-outside (1734) — не затронуты.

## Related Files
- `src/renderer/components/Workspace/Timeline.tsx` — tooltop logic (parent onMouseLeave ~4177, nested keep-alive ~670, single-entry popover ~5251).
- `knowledge/fact-timeline.md` — general timeline behavior (см. `Right-anchor через измеренный DOM (popupRightPx)`).
- `methodology/сценарии-багов-design.md §2.7` — lazy popover + global-mousemove hit-test, почему `onMouseLeave` нельзя миксовать с ним.
