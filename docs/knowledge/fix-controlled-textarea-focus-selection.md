# Fix: focus + selection в SDK chat с virtuoso

## Симптомы

- *«Клик в bubble — инпут не активируется, печать не идёт».*
- *«Выделил текст drag'ом — выделение мгновенно пропало после mouseup».*
- *«Напечатал слово, поставил каретку в середине, кликнул в bubble — каретка прыгнула в начало».*
- *«Выделил кусок в чате, нажимаю клавишу — ничего не печатается, нужно сначала кликнуть мимо чтобы убрать выделение».*
- *«Кликнул на раскрывалку tool-card / compact toggle — после этого keystroke не идёт в инпут».*

Все пять симптомов — разные грани одного и того же набора **трёх монолитных WHATWG-инвариантов** + один React-specific gotcha. После ~12 итераций фиксов, двух Claude/Perplexity deep-research'ей и детерминированной верификации через electron MCP установлена финальная архитектура.

## Три stacked WHATWG-инварианта (root cause)

1. **`preventDefault()` на `mousedown` монолитен.** В Blink `MouseEventManager::HandleMousePressEvent` имеет один `defaultPrevented` gate, который контролирует И click-focus pipeline (step 9 W3C UI Events), И selection-start pipeline. Отменить только одно нельзя — это **spec-level coupling**, подтверждено комментарием Chromium dev Rick Byers в blink-dev thread. Любой `e.preventDefault()` на mousedown в parent-scroller убивает оба: scroller не крадёт фокус, но и drag-to-select в descendants не стартует.

2. **`tabindex="-1"` всё равно делает div click-focusable.** WHATWG HTML Living Standard §6.6 (Focus): *«negative tabindex value causes the element to be focusable, indicates author would prefer the element to be click-focusable but not sequentially focusable».* Blink `Element::IsMouseFocusable()` следует спеке. Только полное **отсутствие** атрибута tabindex делает div non-focusable на mouse-click. `<div>` по умолчанию не focusable, `tabindex=0` делает click+keyboard, `tabindex=-1` оставляет click. Подтверждено через MCP eval: `tabIndex=-1` + `el.focus()` всё равно move'ает activeElement.

3. **`textarea.focus()` коллапсит `window.getSelection()`.** WHATWG focusing-steps §7: *«Apply any relevant platform-specific conventions for focusing new focus target. (For example, some platforms select the contents of a text control when that control is focused.)»* Blink convention: при focus на form-control селекшен в Document collapse'ится. Подтверждено через MCP: `selLen=370 → ta.focus() → selLen=0` в том же микротаске. `addRange()` после focus частично восстанавливает, но flickers и не работает в edge cases (детачнутые boundary-nodes).

## Дополнительный invariant из React/CDP

4. **CDP `Input.dispatchKeyEvent` не апдейтит React controlled input.** Это E2E-test-only артефакт, не баг продакшна. React патчит `value` setter на каждом mounted controlled-input — `inputValueTracking.js` хранит `currentValue` в closure, `ChangeEventPlugin` drop'ает `onChange` если tracker == DOM value. CDP `dispatchKeyEvent` шлёт keydown без вхождения в Blink editor commit path → `.value` не меняется → tracker и DOM остаются равными → React onChange не фурычит. Для тестов работает только `Input.insertText` (IME path) либо native value setter + InputEvent через `electron_insert_text` tool. Реальная OS-mouse keystroke идёт через trusted-event path, всё работает.

## Final архитектура

Файл `src/renderer/components/Workspace/ClaudeSDK/ClaudeSDKTab.tsx`.

**1) Custom virtuoso Scroller без tabindex.** `components.Scroller` в Virtuoso prop, declared на module scope (inline дефинишн каждый рендер переcreate'ит scroller и потеряет scroll-position). Деструктурируем `tabIndex` из `props` (Virtuoso кладёт `{tabIndex: 0}` через `...props`) и **не форвардим** — div рендерится без атрибута, non-click-focusable. Узкий `onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}` — backstop на клик в padding/gutter самого scroller'а, где есть голый chrome без content (там focus не должен делать ничего, и preventDefault не повредит selection потому что target == scroller-сам).

**2) Caret snapshot на document-level `mousedown` в capture phase.** Blink сбрасывает `textarea.selectionStart=0` ДО того как React успевает запустить onBlur handler — поэтому snapshot в onBlur уже считывает 0. Capturing listener на document с приоритетом перед native pipeline снимает `{start, end}` пока textarea ещё держит правильную позицию. Хранится в `savedCaretRef`.

**3) Active recovery на document-level `mouseup` в capture phase.** `setTimeout(0)` — даёт Blink дотащить mouseup default action и закоммитить selection. Затем проверка:
- `window.getSelection().toString().length >= 5 && !isCollapsed` → юзер дraj-select'нул осмысленный кусок → leave activeElement = body, не трогаем focus. Selection живёт.
- Меньше 5 символов или collapsed → click без drag, либо акцидентальный микро-drag → clear residual selection + `ta.focus({preventScroll:true})` + `setSelectionRange(savedCaretRef.start, savedCaretRef.end)`. Каретка восстановлена.

Threshold 5 chars: меньше — обычно случайный микро-drag в 1-2 символа во время click. Real selection почти всегда 10+.

**4) Global keydown listener (capture phase) для печати при `activeElement = body`.** Когда юзер драг-select'нул текст в чате и сразу нажал клавишу — `activeElement === body`, обычный React onChange не работает. Document-level keydown listener:
- `isVisibleRef` guard — каждый mounted SDK таб (5+ копий в DOM) вешает listener. Без guard буква пишется 5 раз.
- Fallback search: target внутри SDK-таба → use его textarea; target = body/html → find first visible SDK таб через `style.display === 'flex'`.
- Native value setter + InputEvent — обход React inputValueTracking. Маппит `Backspace`/`Delete`/`Enter`/printable single-char keys в манипуляцию `ta.value` через `slice + concat` относительно `selectionStart/End`.
- После первой keystroke когда `activeElement !== ta` — `window.getSelection().removeAllRanges()` + `ta.focus({preventScroll:true})` + `setSelectionRange(end, end)`. UX: «начал печатать → selection пропал, я в инпуте».

**5) Visible orange caret `#FFB382`.** Раньше пробовал `caret-color: transparent` (юзер: «значок мигающий надо убрать»). Юзер потом сказал «не работает печать» — на самом деле работало, но он не видел каретки и не знал что инпут активен. Caret = единственный достоверный сигнал «текст идёт сюда» когда юзер начал печатать.

**6) Non-edit кнопки в чате блокируют фокус через `onMouseDown.preventDefault()`.** Scroll-to-bottom FAB, compact-summary toggle, длинный user-prompt toggle, tool-card chevron header. Click срабатывает (он от mouseup). Edit/Repeat user-prompt buttons остались focusable — они ведут в редактирующий UI с другой textarea внутри bubble.

## Кладбище отброшенных подходов

Стандартное правило AI-to-AI: без этого секции следующий разработчик/AI повторно предложит ту же стопку провальных подходов.

- **`tabIndex={-1}` на scroller'е.** Не работает: WHATWG, click-focusable. Проверено через MCP — focus всё равно ловится.
- **`mousedown.preventDefault()` на scroller'е (любой scope).** Conditional `if (e.target === e.currentTarget)` — не fires на child clicks (target = `<p>`, не scroller). Unconditional — блокирует drag-to-select в `<p>` (тот же `defaultPrevented` gate).
- **`MutationObserver` на `[data-virtuoso-scroller]` re-asserting `tabIndex=-1`.** Маскирует проблему, не решает: tabindex=-1 всё равно click-focusable.
- **`focusin` document-listener с auto-redirect в textarea.** Срабатывает мгновенно после mousedown→focus, до mousemove → selection не успевает стартовать → drag broken. Юзер: «mouseup пришёл, selLen=0».
- **`onFocus` на Scroller с программным `ta.focus()` redirect.** Та же проблема — focus arrives до того как selection начала строиться.
- **Range save/restore через `addRange()` после `ta.focus()`.** Частично работает на первом frame, потом теряется при последующих re-render'ах. Edge cases с detached boundary-nodes из virtualization. Видим в логах flicker `selAfter=N → next-tick=0`.
- **`setTimeout` refocus в onBlur с relatedTarget guard.** Работает для click-без-выделения, но при наличии selection skip → keystroke не доходит до textarea (body active, React onChange не фурычит). Юзер: «надо сначала кликнуть мимо чтобы убрать выделение, потом печатать — слишком много шагов».
- **Snap caret в onBlur вместо mousedown capture.** К моменту onBlur Blink уже сбросил `selectionStart` в 0. Snap on mousedown capture phase — единственный путь поймать pre-reset значение.

## CDP test-side limitation (важное замечание)

`electron_keyboard.type` через CDP в Electron MCP **не апдейтит React controlled-input value**. Это test-artifact, не баг продакшна. Юзер ввод через OS keystroke работает (trusted event path). Для E2E через MCP использовать `electron_keyboard.insertText` или новый custom tool `electron_insert_text` (native value setter + InputEvent). Для drag-to-select через MCP — `electron_select_text` (Range API), потому что CDP `Input.dispatchMouseEvent` не запускает Blink selection-controller на синтетических move-событиях. См. `electron-e2e-testing` skill::CDP Input API limitations.

## Принципы

Переносимая часть — `methodology/design.md::Focus-vs-selection in scrollable text containers`, `::Suppress focus on non-edit buttons in scroll-content`, `::Global keystroke routing для selection-scope UI`.
