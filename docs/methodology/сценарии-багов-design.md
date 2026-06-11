# Design Bugs — типовые ошибки UI разработки

Каталог багов, которые повторно возникают при разработке интерфейсов. Не «как должно быть» (это `переносимый-дизайн.md`), а **«что обычно ломается и как это починить»**. Открывай перед проектированием нового компонента — большинство «новых» багов здесь уже описаны.

Группы:
1. [Геометрия и обрезка](#1-геометрия-и-обрезка)
2. [Hover-bridge: popup закрывается при движении к нему](#2-hover-bridge-popup-закрывается-при-движении-к-нему)
3. [CMD/Ctrl-hover edge cases](#3-cmdctrl-hover-edge-cases)
4. [Click-outside и пути к escape'у](#4-click-outside-и-пути-к-escape)
5. [Рассинхрон видимости и состояния](#5-рассинхрон-видимости-и-состояния)
6. [Z-index конфликты](#6-z-index-конфликты)
7. [Hover affordance: непонятно, что кликабельно](#7-hover-affordance-непонятно-что-кликабельно)
8. [Auto-focus и фокус-ловушки](#8-auto-focus-и-фокус-ловушки)
9. [Динамический layout и измерение в момент рендера](#9-динамический-layout-и-измерение-в-момент-рендера)
10. [Portal и обрезка overflow](#10-portal-и-обрезка-overflow)
11. [Минимализм popup'ов: single-control = `<input>`, не «модалка»](#11-минимализм-popupов-single-control--input-не-модалка)
12. [Tri-state кнопка действия: idle / continue / stop](#12-tri-state-кнопка-действия-idle--continue--stop)
13. [Чек-лист перед мержем UI-фичи](#13-чек-лист-перед-мержем-ui-фичи)

---

## 1. Геометрия и обрезка

### 1.1. Popup уезжает за правый/нижний край

**Симптом.** Popup частично за границей viewport либо за сайдбаром. Пользователь не видит правый/нижний край.

**Причины.**
- Позиционирование по `left` или `top` фиксированной формулой (`left: chipRect.left`), но триггер близко к правому краю.
- Width у popup'а статическая (`minWidth: 320`), свободного места осталось 150.
- `position: fixed` от `body` не знает про сайдбар (Timeline strip, file explorer) — статика не учитывает что справа физически занято 32–160px.

**Фиксы.**

```tsx
// ПЛОХО — улетает вправо
style={{ left: chipRect.left, top: chipRect.bottom + 4 }}

// ХОРОШО — right-anchor (для триггеров в правой части UI)
style={{ right: window.innerWidth - chipRect.right, top: chipRect.bottom + 4 }}
```

Для popup'ов с большим контентом — **динамическая ширина** через `useLayoutEffect`:
```tsx
const sidebar = document.querySelector('[data-timeline]') as HTMLElement | null;
const sidebarLeft = sidebar ? sidebar.getBoundingClientRect().left : window.innerWidth;
const rightLimit = Math.min(sidebarLeft, window.innerWidth) - 8;
setWidth(Math.max(MIN_WIDTH, rightLimit - anchorRect.left));
```
Перемеряй на `window.resize`. Источник правды о границе сайдбара — стабильный `data-attr`, не магические числа.

### 1.2. Smart-flip ниже/выше

Если popup ниже триггера обрезается по нижнему краю — переключайся выше:
```ts
const spaceBelow = window.innerHeight - rect.bottom;
const showAbove = spaceBelow < 160;
```
См. `useCmdHoverPopover::getPopoverPosition`.

### 1.3. Popup в status bar всегда раскрывается вверх

Status bar в самом низу. Использовать `bottom: window.innerHeight - chipRect.top + 4`, не `top: chipRect.bottom + …`. Детерминировано — smart-flip не нужен.

---

## 2. Hover-bridge: popup закрывается при движении к нему

### 2.1. Симптом и причина

Пользователь видит popup, движет курсор к нему, но при пересечении gap'а popup пропадает. **Причина:** `onMouseLeave` срабатывает в gap'е, потому что между двумя DOM-элементами курсор «нигде».

Никакая логика типа «проверь, не идёт ли курсор в сторону popup'а» не работает надёжно. Нужен **хитбокс**, покрывающий gap.

### 2.2. Три фикса по убыванию простоты

**(а) CSS-bridge через wrapper с явной высотой.** Popup — не `position: fixed` на голом контенте, а wrapper, занимающий gap, с видимым контентом внутри:
```tsx
const wTop = Math.min(clampedTop, eCenterY - 20);
const wH = Math.max(...) - wTop;
return { clampedTop, wTop, wH, offset: clampedTop - wTop };
```
Wrapper — `top: wTop, height: wH`. Видимый popup внутри сдвинут через `marginTop: offset`. `onMouseLeave` теперь на wrapper'е — курсор должен выйти из всей совокупной области.

**(б) Bridge через padding (для коротких popup'ов).** Внешний div с `paddingTop: GAP`:
```tsx
<div style={{ position: 'fixed', top: trigger.bottom + 4, paddingTop: 4 }}>
  <input … />
</div>
```
Визуально 4px gap, но hit-area от триггера.

**(в) Geometric hit-test (если расстояние большое, два независимых Portal'а).** Document-level `mousemove` + rect-математика:
```tsx
useEffect(() => {
  if (!popupOpen) return;
  const onMove = (e: MouseEvent) => {
    const t = triggerRef.current?.getBoundingClientRect();
    const p = popupRef.current?.getBoundingClientRect();
    if (!t || !p) return;
    const { clientX: x, clientY: y } = e;
    const inT = x >= t.left && x <= t.right && y >= t.top && y <= t.bottom;
    const inP = x >= p.left && x <= p.right && y >= p.top && y <= p.bottom;
    const inBridge =                                    // popup СЛЕВА от триггера
      x >= p.right && x <= t.left &&
      y >= Math.min(p.top, t.top) - 8 &&
      y <= Math.max(p.bottom, t.bottom) + 8;
    if (!inT && !inP && !inBridge) setPopupOpen(false);
  };
  document.addEventListener('mousemove', onMove);
  return () => document.removeEventListener('mousemove', onMove);
}, [popupOpen]);
```

Direction варьируется: popup слева от триггера → bridge между `p.right` и `t.left`; popup сверху → между `p.bottom` и `t.top`.

### 2.3. Особый случай: wrapper смещён вниз от триггера

**Реальный баг (Copy session popup).** Popup ниже кнопки на 4px. Wrapper позиционирован `top: button.bottom + 4`, внутри `paddingTop: 4`. Снаружи — `position: fixed` на этих 4px ничего не лежит.

```tsx
// ПЛОХО — 4px gap снаружи wrapper'а — мёртвая зона:
<div style={{ position: 'fixed', top: button.bottom + 4, paddingTop: 4 }}>
  <input … />
</div>
```

Курсор едет от кнопки вниз → пересекает эти 4px → `onMouseLeave` кнопки уже отработал, в wrapper ещё не вошли → popup закрывается. `paddingTop` внутри wrapper'а **не** помогает — он начинается **после** offset'а сверху.

```tsx
// ХОРОШО — wrapper вплотную к кнопке, gap создаётся padding'ом ВНУТРИ:
<div style={{ position: 'fixed', top: button.bottom, paddingTop: 4 }}>
  <input … />
</div>
```
Теперь зона hover'а wrapper'а смыкается с зоной hover'а кнопки. Курсор пересекает gap, оставаясь в `paddingTop` wrapper'а. Это и есть «invisible CSS-bridge» в правильной форме.

**Правило.** `top` wrapper'а = координата границы триггера (никаких +N). Визуальный gap = padding **внутрь** wrapper'а в нужную сторону. Применимо в обе стороны: popup сверху → `bottom: window.innerHeight - trigger.top` + `paddingBottom: GAP`.

### 2.4. Антипаттерн: elementFromPoint

В gap'е `elementFromPoint` возвращает то что **под** wrapper'ом и popup'ом (terminal, body). Поэтому `el.closest('[data-bridge]')` фейлит, popup закрывается. **Координатный hit-test (вариант в) — единственно надёжный**, если работаешь не с DOM-обёрткой.

### 2.5. Tooltip залипает после leave-from-tip (асимметрия cancel-on-enter / no-reset-on-leave)

Двухсекционные hover-state'ы (trigger + portal-tip) с hide-таймером ломаются на сценарии «trigger → tip → выход с tip-а в сторону». Канонический сценарий: trigger hover-state `hovering = true`, leave с trigger планирует `hide-timer` который сбросит `hovering = false` через N мс. Tip onPointerEnter отменяет timer (правильно — иначе tip пропадёт пока курсор переходит через GAP) и ставит `inTip = true`. Tip onPointerLeave наивно делает `setInTip(false)` — и тут залипание: `hovering` всё ещё `true` (timer был отменён и больше не выстрелит), `inTip = false`, но `visible = hovering || inTip` остаётся `true`. Tip не закрывается даже когда курсор уже далеко.

Симптом — *«если я навёлся на тултип и потом с него увёлся, тултип не закрывается»*. Курсор может быть где угодно на экране, tip висит до клика, переключения вкладки или перезагрузки. Узнаётся по тому что **bare-hover trigger leave работает** (timer срабатывает), а **leave из tip-а** нет. Любая логика типа «через 5 секунд автоматически закрой» — не фикс, это hack поверх.

Правильно — leave-from-tip терминален: сбрасывает оба флага и чистит timer.
```tsx
onPointerLeave={() => {
  if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  setInTip(false);
  setHovering(false);   // ← забытая строка, ключевая
}}
```
Возврат курсора на trigger корректно поднимет `hovering = true` через onPointerEnter триггера — flow не сломан. Альтернатива «не отменять timer на tip-enter, тогда timer всё равно выстрелит» провальна — пока курсор на tip-е, timer выстрелит и tip пропадёт под курсором. См. `src/renderer/components/UI/Tooltip.tsx::onPointerLeave`.

### 2.6. Debug-визуализация bridge'ов

В режиме разработки удобно видеть невидимые bridge'ы. Хранится в `useUIStore.debugHoverBridges` (тогглер в `StatusBar`). Компонент `HoverBridgeDebug` рисует красный прозрачный rect поверх bridge-области с `pointer-events: none`. Если в проде popup закрывается «непонятно когда» — включи флаг и увидишь, что курсор реально вышел из всех зон.

Файл: `src/renderer/components/HoverBridgeDebug.tsx`.

### 2.7. Lazy popover wrapper: близкие popover'ы пропадают между chip-ом и собой

Когда popover рендерится через conditional `{open && <Portal>…</Portal>}`, его DOM-узел не существует пока `open === false`. На `onMouseLeave` chip-а ставится `setOpen(false)` — wrapper unmount'ится **в том же тике**, до того как курсор успевает пересечь gap. Соответственно `mouseenter` на wrapper'е не выстреливает (узел уже снят со страницы), popover не реoткроется. Wrapper-CSS-bridge из 2.2(а) тут не помогает — он есть в JSX, но не в DOM в момент перехода. Симптом — *«я не могу навестись на эту модалку»* при том что в DOM wrapper отрисован корректно перед закрытием.

Единственно рабочий путь — **geometric hit-test через global `mousemove` listener** (2.2 вариант в), активный только пока `open=true`. Listener тестирует курсор против `getBoundingClientRect()` обоих узлов (chip + popover) с tolerance ±2px и закрывает popover только когда курсор **вне обоих**. `onMouseLeave` с chip-а и popover-а **не вешать совсем** — они отрабатывают раньше глобального listener'а и убивают popover до того как hit-test может его удержать.

```tsx
useEffect(() => {
  if (!open) return;
  const onMove = (e: MouseEvent) => {
    const c = chipRef.current?.getBoundingClientRect();
    const p = popoverRef.current?.getBoundingClientRect();
    const inRect = (r?: DOMRect, pad = 2) =>
      !!r && e.clientX >= r.left - pad && e.clientX <= r.right + pad
        && e.clientY >= r.top - pad && e.clientY <= r.bottom + pad;
    if (!inRect(c) && !inRect(p)) setOpen(false);
  };
  window.addEventListener('mousemove', onMove);
  return () => window.removeEventListener('mousemove', onMove);
}, [open]);
```

Распространённая ошибка — поставить `onMouseLeave` «на всякий случай» рядом с глобальным listener'ом. На быстром движении он срабатывает за миллисекунды до того как глобальный listener успевает решить «курсор в popover'е» — popover мигает и пропадает. Если используешь geometric hit-test — убери **всё** `onMouseLeave`-управление видимостью; открытие держи только на `onMouseEnter`. См. реализацию в `Timeline.tsx::renderBreakdownBody` и `fact-clipboard-tools.md::Range Token Estimate + Breakdown popover`.

---

## 3. CMD/Ctrl-hover edge cases

### 3.1. Popup пропадает при отпускании CMD

**Симптом.** Зажал CMD, навёлся, popup появился. Отпустил CMD — popup исчез, хотя курсор всё ещё на нём.

**Фикс.** `visible = isCmdPressed || isPinned`. Курсор зашёл на popup — `isPinned = true`. См. `useCmdHoverPopover::popoverProps`.

### 3.2. Залипание popup'а после window blur

**Симптом.** Зажал CMD, переключился через Cmd+Tab в другое приложение, CMD отпустил **в чужом окне** — `keyup` не приходит. Возвращается — popup залип, потому что флаг pressed остался `true`.

**Фикс.** `window.addEventListener('blur', () => setPressed(false))`. См. `useCmdKey`.

### 3.3. Случайные popup'ы при дрейфе курсора с зажатым CMD

**Симптом.** Юзер двигает курсор по экрану с CMD (готовится к hotkey) — над каждым элементом мигают popup'ы.

**Фикс.** Bridge-timeout — popup появляется не мгновенно, а после 100–150мс непрерывного hover'а с CMD. См. `useCmdHoverPopover(bridgeTimeout = 150)`.

### 3.4. Synthetic keydown с metaKey не работает в Electron 27+

**Симптом.** `dispatchEvent(new KeyboardEvent('keydown', { metaKey: true }))` приходит к слушателю с `e.metaKey === false`.

**Фикс.** На уровне приложения — полагайся на реальные нажатия. В автоматизации (тесты, MCP) — используй CDP-debugger или `mcp__electron__electron_keyboard` с `action:'down'`, а не synthetic events.

---

## 4. Click-outside и пути к escape'у

### 4.1. Принцип

В любом «модальном» режиме popup'а пользователь должен мочь закрыть его кликом мимо. Это **более фундаментальный** жест, чем mouse-leave.

### 4.2. Ловушка: confirm-режим заперт

**Симптом.** Popup в режиме `deleteConfirm` или `postPrompt` — `mouseLeave` отключён (защита от случайного hover-выхода). Но **и** click-outside выключен, чтобы случайный клик не отменил подтверждение. Юзер заперт.

**Фикс.** Отключай **только** `mouseLeave` в опасных режимах, **никогда** не выключай click-outside.

### 4.3. e.stopPropagation на root popup'а

Если document-listener на `mousedown` (capture или bubble) — у внутренних кликов popup'а должен быть `e.stopPropagation()` ИЛИ listener должен проверять `if (popupRef.contains(e.target)) return`. Выбери один путь и держи единый стиль во всём проекте, не миксуй.

### 4.4. Portal-кнопка + handleClickOutside родителя = мгновенный сброс стейта

Симптом — кнопка внутри React Portal обновляет стейт, и тот же стейт сбрасывается в том же тике. Юзер кликает, ничего не происходит, никаких ошибок.

Причина — кнопка внутри Portal живёт в `document.body`, **вне** ref'а родительского компонента. Если у родителя есть `window.addEventListener('click', handleClickOutside)` с проверкой `containerRef.current.contains(e.target)` — клик по Portal-кнопке вызывает `onClick` → стейт устанавливается, но затем событие bubbles до `window` → `containerRef.contains(target)` = `false` (Portal physically не внутри ref) → стейт сбрасывается. Capture-on-parent не помогает: capture идёт сверху вниз и съедает событие до самой кнопки внутри Portal.

Правило универсальное — любая интерактивная кнопка в Portal, меняющая родительский стейт, обязана делать `e.stopPropagation()` на bubble-фазе. `onClick` внутри Portal **продолжает** bubble'ить вверх по React virtual tree (не по DOM tree) — поэтому document-listener всё равно ловит событие, даже когда визуально Portal в `body`. Это часто принимается за «click-outside работает автоматически если в Portal» — нет, проверять явно.

### 4.5. Esc обязателен дополнительно

Click-outside и Esc — два независимых пути. Esc нужен для ситуаций когда мыши под рукой нет, или когда click-outside случайно перехватывается (например, popup занимает весь viewport).

См. `переносимый-дизайн.md::Click-outside как universal escape, mouse-leave опционален`.

### 4.6. mousedown bubble'ит раньше click — `stopPropagation` нужен на оба

Когда родительский popup закрывается по `window.addEventListener('mousedown', closeIfOutside)` (а не по `click`), а внутри него живёт вложенный popover-portal с своими кнопками — `e.stopPropagation()` только на `onClick` **не работает**. Mousedown проходит first, родитель уже сбросил state до того как handler кнопки выстрелит. Симптом — *«кнопка тупо не работает»*: визуально нажимается, но эффект не виден, потому что родитель закрыл popover в момент mousedown, и `onClick` (если успевает) обновляет state уже несуществующего UI.

Применимо ко всем nested popover'ам внутри другого click-outside-aware popup'а. Правило: на корневом div'е popover'а **обе** проп'ы:
```tsx
onMouseDown={(e) => e.stopPropagation()}
onClick={(e) => e.stopPropagation()}
```
Без mousedown — родительский listener закрывает родителя; popover-узел в Portal'е остаётся, но его `open`-стейт привязан к state родителя и обнуляется тоже. Симптом: первый клик мимо, требуется второй (после реоткрытия родителя). См. `Timeline.tsx::breakdownPopoverRef`/`singleBreakdownPopoverRef` обёртки.

### 4.7. Sticky pin не должен сбрасываться общим click-outside handler'ом

Popover с двумя уровнями pin'а (light = клик-закреп к текущему контексту, sticky = ⌘⇧-закреп переживает всё) часто реализуется одним `useEffect`-ом с условием `if (clicked || sticky)` и общим закрытием обоих state'ов в onDown. Mousedown по соседней вкладке / по любой части UI вне popover'а тогда сбрасывает **оба** — sticky-пин теряется при первом же клике, контракт «переживёт смену табов и проектов» нарушен. Юзер ждёт что sticky прибит навсегда до повторного ⌘⇧, видит исчезновение и решает что фича сломана.

Фикс — handler работает только в режиме light pin (`if (!clicked || sticky) return`). Sticky снимается только тремя путями: повторный ⌘⇧, клик по самому триггеру (чтобы можно было закрыть popover без mouse-trip к чипу), explicit unmount компонента. Esc тоже не снимает sticky — это инстинктивный жест и пользователь часто его жмёт по привычке, прибитое окно должно его игнорировать.

Применимо к любому popover'у с reactive content (см. `переносимый-дизайн.md::Sticky pin: snapshot vs reactive content`) — там sticky особенно важен, потому что окно реагирует на смену active state и закрыть его при смене вкладок = убить смысл sticky-режима. Базовая механика ⌘⇧-закрепа — global `tooltip-resize-modal.md::Закреп`.

### 4.8. Backdrop click после drag внутри модалки

**Симптом.** Cropper/resize-модалка закрывается, когда пользователь начал жест внутри контента, потащил мышь и отпустил над backdrop. Для пользователя это не click-outside, а продолжение drag-жеста; потеря модалки читается как случайное закрытие и может выбросить незавершённое кадрирование.

**Фикс.** Backdrop dismiss срабатывает только если `mousedown` начался на overlay **и** финальный `click` тоже пришёл по overlay. Храни `mouseDownOnOverlay` в ref, сбрасывай после click. Одного `onClick={(e) => e.target === e.currentTarget && close()}` недостаточно: browser синтезирует click по release-target, а intent жеста определялся в момент mouse down. В custom-terminal это применено в `IconCropper`: drag внутри crop-area не должен закрывать окно при release на полупрозрачном фоне.

---

## 5. Рассинхрон видимости и состояния

### 5.1. UI показывает X, но данные — Y

**Симптом.** Пользователь переключил backend → UI обновился → ответ пришёл от **старого** backend (запрос ушёл до переключения). Badge в UI новый, контент старый.

**Фикс.** Источник правды для post-factum индикации — **ответ сервера**, не локальный UI-флаг. Каждое сообщение в истории помечается метаданными из response (`message.model`, `provider`, `region`). Live-индикатор «куда сейчас отправляется» — отдельный (можно из UI-state), не путать с post-factum badge.

См. `переносимый-дизайн.md::Truth from server response, not local UI flag`.

### 5.2. Множественный hover из-за неполного селектора активности

**Симптом.** Несколько компонентов одновременно в состоянии «активный» (одинаковый z-index, glow), потому что каждый проверял только `activeTabId === tabId` и не учитывал `activeProjectId`.

**Фикс.** В Zustand-селекторе для local-active проверяй **и** `state.activeProjectId === projId` **и** `workspace.activeTabId === tabId`. См. `knowledge/fix-performance-lags.md` Section 5.

### 5.3. Стайл одного элемента «прыгает» когда монтируется другой

**Симптом.** Открыл sidebar — координаты popup'а в соседнем компоненте сместились на 300px, popup улетел в стену.

**Причина.** Popup кэширует `getBoundingClientRect()` один раз при показе. Sidebar открывается — основная разметка сжимается — popup продолжает считать что anchor там же.

**Фикс.** ResizeObserver на body (или на container) + перемеряй. Не кэшируй геометрию между ре-рендерами родительского layout'а.

---

## 6. Z-index конфликты

### 6.1. Таблица слоёв проекта

| Слой | z-index | Кто |
|---|---|---|
| Page content | 0–40 | Terminal, sidebar, regular UI |
| Resize-handle | 50 | Тянем границу панели |
| Tooltip (hover на dot) | 10010 | Timeline tooltip wrapper |
| Range action menu | 10020 | ПКМ-выделение → Копировать/Удалить |
| Context menu (ПКМ) | 10001 | Single-entry copy/note/rewind |
| Settings popup | 10000 | Copy session settings, API settings |
| Bridge debug overlay | 99999 | Поверх всего, `pointer-events: none` |

**Правило.** Если новый popup появляется поверх старого — у нового z-index выше. **Симптом нарушения:** видишь panel, но не можешь кликнуть — её перекрывает невидимая (или прозрачная) другая. Использовать DevTools → Layers, чтобы понять что сверху.

### 6.2. Bridge debug всегда выше всего

`HoverBridgeDebug` рендерит overlay с `z-index: 99999, pointer-events: none`. Это безопасно — он не блокирует клики, но всегда видим. Не понижай его «чтобы не мешал» — он специально такой.

См. `knowledge/fact-timeline.md::Z-index и геометрия popup`.

### 6.3. UI поверх canvas: Portal или Layering Pattern, не голый z-index

Большие canvas-компоненты (xterm.js, WebGL, video) создают локальные stacking context'ы через `transform`/`filter`/`opacity` родителей, ломая `z-index` соседей. UI-элементы, которые должны быть «поверх» canvas, оказываются под ним или не получают клики. Симптом — кнопка визуально видна на canvas, но клики «проходят сквозь неё» в xterm; либо кнопка вообще не видна, хотя в DOM существует с положительным z-index.

Если overlay полностью отделён от canvas (модалка, file picker, screen-wide overlay) — `createPortal` в `document.body` обходит локальные stacking context'ы целиком, проблема не возникает.

Если overlay должен жить **внутри** родительского контейнера canvas — нужен Layering Pattern: соседние absolute-слои с явным разделением хитбоксов.
```tsx
<div className="absolute inset-0">
  <div ref={canvasRef} className="absolute inset-0" />  {/* Слой 1: canvas */}
  <div className="absolute inset-0 pointer-events-none z-10">  {/* Слой 2: UI */}
    {showButton && <button className="pointer-events-auto">↓</button>}
  </div>
</div>
```
`absolute inset-0` на обоих слоях избегает конфликтов размеров — canvas чувствителен к flex/grid sizing. `pointer-events-none` на UI-контейнере + `pointer-events-auto` на конкретных интерактивных элементах: клики проходят сквозь пустые места к canvas, но кнопки кликабельны. Явный `z-index` на UI-слое — иначе порядок зависит от непредсказуемого DOM-order'а. См. `knowledge/fact-settings.md` про capture-phase listener для overlay'ев поверх xterm — это та же проблема под другим углом (canvas жадно ловит pointer events, нужно перехватывать в capture-фазе).

---

## 7. Hover affordance: непонятно, что кликабельно

### 7.1. Симптом

Пользователь видит кнопку, но не понимает что она делает / что кликабельно / есть ли скрытые зоны. Меняется только `cursor: pointer` — этого недостаточно.

### 7.2. Что добавлять

- Фон меняется на hover (минимум 0.08 → 0.28 alpha от accent-цвета). Это **обязательно**, а не nice-to-have.
- Текст на hover — становится белым / полужирным, если фон тёмный (фон+цвет — это две разные подсказки в одно нажатие).
- Не используй чистую `animate-pulse` (opacity) для индикаторов на тёмном фоне — H.264 codec её съедает (см. CLAUDE.md AI-Optimized UI). Используй `background-color` glow.

**Реальный симптом из живой сессии:** *«непонятно что значит копировать, то есть должен как-то бэкграунд меняться. Меняемся только лишь курсор пойнтера»* — pointer без фона юзер не воспринимает как affordance. Курсор-only — не affordance.

### 7.3. Сегментированные кнопки: независимые hover-зоны

Если кнопка разделена на две (или больше) функциональные зоны (например, `📋-settings | Copy session-label`), каждая зона должна иметь **собственный** hover-state. Outer container прозрачный, каждая половина — свой `backgroundColor` на hover, разделённые 1px divider'ом. Юзер видит, **куда именно** сейчас попадёт клик.

**Антипаттерн.** Outer-container получает hover-фон всей кнопки целиком → обе половины подсвечиваются одновременно → непонятно, на какую зону наведён курсор и что произойдёт по клику.

**Реализация.**
```tsx
<div className="inline-flex items-center rounded overflow-hidden" style={{ border: 'accent' }}>
  <span onMouseEnter={() => setIconHovered(true)} onMouseLeave={() => setIconHovered(false)}
        style={{ backgroundColor: iconHovered ? 'accent/0.28' : 'transparent' }}>
    📋
  </span>
  <span style={{ width: 1, height: '70%', backgroundColor: 'accent/0.25' }} />  {/* divider */}
  <span onMouseEnter={() => setLabelHovered(true)} onMouseLeave={() => setLabelHovered(false)}
        style={{ backgroundColor: labelHovered ? 'accent/0.28' : 'transparent' }}>
    Copy session
  </span>
</div>
```

Outer container остаётся прозрачным (`backgroundColor: accent/0.08` максимум), весь видимый hover-эффект — на половинах.

### 7.4. Размер не меньше 16x16

Кликабельные иконки в плотных UI — минимум 16x16px hit area (даже если visual size 12x12 — добавь padding). Иначе пользователю придётся целиться.

См. `methodology/переносимый-дизайн.md::Edit affordance в каждой точке входа в просмотр`, `knowledge/fact-clipboard-tools.md::Copy Session: размещение и UX`.

---

## 8. Auto-focus и фокус-ловушки

### 8.1. Открыл modal — focus уехал в случайное место

**Фикс.** При монтировании modal — `setTimeout(() => inputRef.current?.focus(), 30)`. Без setTimeout React не успевает завершить commit, и фокус не закрепляется.

### 8.2. Запертый фокус в modal

**Симптом.** Юзер в modal'е, нажал Tab — фокус ушёл в задний фон (на основное окно). Tab loop сломан.

**Фикс.** Либо react-focus-lock, либо `onKeyDown` на root modal'а: ловишь Tab, проверяешь focusable элементы внутри, циклишь.

### 8.3. Закрыл modal — фокус не вернулся туда, где был

**Фикс.** Перед открытием modal'а — `previousFocus.current = document.activeElement`. На unmount — `previousFocus.current?.focus()`.

### 8.4. Open != focus

Modal открыт, но input не сфокусирован — типичный баг. **Каждый** modal с input'ом должен сфокусировать его сам, не полагаясь что юзер кликнет.

См. `переносимый-дизайн.md::Auto-focus при открытии`.

---

## 9. Динамический layout и измерение в момент рендера

### 9.1. Hard-coded размеры в формуле позиционирования

**Симптом.** `right: notesPanelWidth + (treeMode ? 160 : 32) - 8` — формула «по дизайну». Меняется один из элементов, popup съезжает.

**Фикс.** Измеряй через `ResizeObserver` + `getBoundingClientRect`:
```tsx
useLayoutEffect(() => {
  const measure = () => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setRightPx(window.innerWidth - rect.left + 8);
  };
  measure();
  const ro = new ResizeObserver(measure);
  ro.observe(document.body);
  if (containerRef.current) ro.observe(containerRef.current);
  window.addEventListener('resize', measure);
  return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
}, []);
```
Формула умирает — измерение живёт.

См. `переносимый-дизайн.md::Геометрия popup — от измерения, не от формулы`.

### 9.2. Процентное позиционирование в списках с динамической высотой

**Симптом.** `top: 65%` в списке где элементы имеют `flex-grow` или условные маркеры — overlay визуально рассинхронизирован с целевой строкой.

**Фикс.** Используй `offsetTop` / `offsetHeight` целевого элемента через ref. См. `CLAUDE.md::Dynamic List Overlays`.

---

## 10. Portal и обрезка overflow

### 10.1. Симптом

Два разных проявления одной CSS-механики:

**(а) Клиппинг.** Popup рендерится внутри родителя с `overflow: hidden` (scroll-area, sidebar) — обрезается по границе родителя.

**(б) `position:fixed` улетает не туда / клики проходят сквозь.** Popup с `position:fixed; top:<...>; right:<...>` рендерится не относительно viewport'а, а относительно ancestor'а с `transform`, `filter`, `perspective`, `will-change` или `backdrop-filter` — CSS-spec: эти свойства делают ancestor containing block для fixed-потомков. Coords пересчитываются от него, а не от окна — popup улетает за пределы или прилипает в неожиданном месте. Симптом особо коварный: trigger reagа́ет на клик, `open=true` в state, но визуально ничего не появляется — *«меню тупо не открывается»*. Поймано в picker'е Run-after: panel-родитель имел `backdrop-filter: blur(8px)`, slideout с `position:fixed; right: window.innerWidth - panelRect.left + 6` улетал в отрицательные координаты.

### 10.2. Фикс

`createPortal(<popup/>, document.body)` — popup рендерится в `body`, escape'ит и `overflow: hidden`, и containing-block-родителя. См. `SettingsPortal`, `TooltipPortal` в проекте; для desktop slideout-кейса — `PromptQueueOverlay::RunAfterTabPicker` (slideout портируется в `document.body` именно из-за `backdrop-filter` на panel root'е). Sibling-overlay в той же panel-обёртке (если рендерится как direct child панель-фрагмента, не descendant) работает без портала — поэтому editor slideout в overlay'е работал, а picker slideout требовал портал. Правило: всё что position:fixed и должно быть viewport-relative — портируй, не полагайся на «парент не имеет transform'ов» (HMR + CSS-in-JS легко добавят их незаметно).

### 10.3. Event handlers и Portal

`onClick` внутри Portal **продолжает** bubble'ить вверх по React virtual tree (не по DOM tree!). Поэтому document-listener на `mousedown` всё равно ловит клики в Portal. Если popup в Portal — это **не означает** что click-outside автоматически работает. Проверяй явно через `popupRef.contains(e.target)`.

---

## 11. Минимализм popup'ов: single-control = `<input>`, не «модалка»

### 11.1. Симптом

Popup, который имеет **один** основной интерактивный элемент (одна textarea / один input / одна кнопка действия), оформлен как полноценная модалка: заголовок («Custom session ID», «Введите путь к файлу»), описание-подсказка («⌘+Enter — copy · Esc — close»), footer-кнопка действия.

**Признак ошибки.** Юзер говорит *«не должно быть модалки полноценной, должен быть просто input»* — единственный реальный control (input) утоплен в чрезмерной chrome.

### 11.2. Правило

Если popup содержит **один** input/textarea и одно действие — **отрисуй только сам control**. Никаких заголовков (label уже виден через placeholder), никаких описаний (`Enter/Esc` — общеизвестно), никакой кнопки Copy (Enter копирует, тогда зачем кнопка).

**ДО (модалка):**
```tsx
<div className="modal">
  <h4>Custom session ID</h4>
  <textarea placeholder="Введите UUID..." />
  <div className="footer">
    <span>⌘+Enter — copy · Esc — close</span>
    <button>Copy</button>
  </div>
</div>
```

**ПОСЛЕ (просто input):**
```tsx
<input type="text" placeholder="Session ID или текст с cwd: /path…"
       onKeyDown={(e) => { if (e.key === 'Enter' && val) onCopy(); }} />
```

### 11.3. Когда полноценная модалка оправдана

- Несколько входных полей (форма, не одиночный ввод).
- Деструктивное действие (требует confirm-кнопку с явным текстом).
- Контент-просмотр (нужен заголовок чтобы юзер понимал, что смотрит).

### 11.4. Не подменять минимализм визуальным «уплощением»

Если убрал заголовок/описание, но оставил `padding: 20px; minHeight: 200px` — это всё ещё «модалка», просто без текста. Минимализм = реальная экономия места **и** контента. Высота popup'а должна быть как у самого control'а (input 26px → wrapper 26px+4px padding-bridge, не 50px+).

---

## 12. Tri-state кнопка действия: idle / continue / stop

### 12.1. Симптом

Кнопка управления процессом (Continue, Stop, Resume) — отдельный chip справа от label'а («Claude  Continue» / «Gemini  Stop»). Когда состояние процесса меняется (запустился / остановился), кнопка появляется/исчезает или меняется на соседнюю — layout прыгает, элементы правее сдвигаются.

### 12.2. Правило

Объединяй label + действие в **одну** fixed-width кнопку с tri-state поведением:

| Состояние | Hover-label | Click action |
|---|---|---|
| idle (нет hover) | `Claude` / `Gemini` (тип сессии) | Копировать sessionId (fallback) |
| hover + сессия есть + процесс **не** запущен | `Continue` | resume сессии |
| hover + процесс **запущен** | `Stop` (красный) | прервать процесс (Ctrl+C, не kill) |

Ширина **фиксирована** (e.g. 64px) — иначе при смене label'а с `Claude` (44px) на `Continue` (60px) на `Stop` (32px) кнопка прыгает, соседние элементы дёргаются.

### 12.3. Цвет = семантика, не симметрия

Stop — **красный** (`#ef4444`), даже если accent проекта оранжевый. Цвет несёт смысл (опасно/прерывает), не следует общей палитре.

### 12.4. Stop = Ctrl+C, не kill

Семантически «остановить процесс» ≠ «убить таб». Stop посылает `\x03` через `terminal:input` (Ctrl+C → SIGINT процессу внутри PTY). Процесс умирает, PTY и таб живут. `terminal:kill` оставь для отдельной кнопки **закрыть таб**.

### 12.5. Сигнал «нужен tri-state» из диалога

Если пользователь говорит «*кнопку X сделай в N состояниях, при наведении меняется на Y*» — он сам уже сформировал паттерн и просит его зафиксировать. Это самый сильный сигнал methodology — он называет паттерн до того как ты его назовёшь. Не пропускай. См. также `переносимый-дизайн.md` про обратный self-check «не родился ли methodology-принцип?».

### 12.6. Матрица состояний = lifecycle модели, не универсальная кнопка

Tri-state (Start / Continue / Stop) корректен для систем где между запусками процесса есть **«сессия в БД, процесса нет»** — например, PTY-claude/gemini CLI: pid жив пока процесс работает, после exit'а sessionId остаётся в db, click `Continue` шлёт `claude --resume`. У таких систем три осмысленных состояния и три разных action'а.

У систем без концепции «процесс между turn'ами» (Anthropic Agent SDK, любой request/response API) lifecycle другой: query живёт ровно один turn (от submit до response), между turn'ами процесса физически нет — но юзер в любой момент может написать следующее сообщение, и это новый turn. `Continue` тут не имеет семантики (нечего возобновлять, новый prompt и есть continue), `Start` тоже не имеет (таб создан, query запустится первым же submit'ом). Остаётся **2-state**: idle (label = название сессии, click → focus composer) и running (hover показывает `Stop`, click → cancel current query). Юзер сам сформулировал границу: *«должна отображаться просто кнопка „Claude“, которая никакого функционала не выполняет [потому что процесс не запущен]»* — для SDK именно так.

Реализация — `mode: 'pty' | 'sdk'` prop на chip-компоненте, не if-разветвление внутри. PTY-матрица 3-state, SDK-матрица 2-state, click handler для SDK при idle делает focus-composer (не Continue), при running — Stop. См. `knowledge/fact-ai-sessions.md::SessionActionChip mode` для конкретики, `knowledge/fact-claude-control-bar.md::sdkBusy mirror` про источник `isCommandRunning` для SDK (нет OSC 133 — приходится подписываться на `claude:busy-state` локально).

См. `knowledge/fact-ai-sessions.md::SessionActionChip` для конкретной реализации в Claude/Gemini-чипе.

---

## 13. Чек-лист перед мержем UI-фичи

Прогоняй перед PR'ом для каждого нового popup/modal/dropdown/tooltip:

- [ ] **Position.** Не уезжает за viewport справа/снизу при разных размерах окна?
- [ ] **Sidebar awareness.** Если справа есть Timeline / file explorer — popup не заходит за него?
- [ ] **Width.** Динамическая? Если статическая — точно ли влезет в 800x600?
- [ ] **CSS-bridge.** Если popup на расстоянии от триггера — есть ли механизм «доехать» курсором без потери hover?
- [ ] **Bridge debug.** Невидимый bridge подсвечивается при `debugHoverBridges`?
- [ ] **Click-outside.** Закрывается кликом мимо? Работает в **любом** под-режиме (включая confirm/post-prompt)?
- [ ] **Esc.** Закрывается клавишей Esc?
- [ ] **CMD-hover** (если применимо). После отпускания CMD не пропадает, если курсор на popup'е?
- [ ] **Window blur reset.** Если есть key-tracker — на `window.blur` сбрасывается?
- [ ] **Z-index.** Не перекрывается соседями? Не перекрывает то, что должно быть кликабельно сверху?
- [ ] **Portal.** Рендерится через `createPortal(…, document.body)` — иначе overflow-hidden родителя обрежет?
- [ ] **Hover affordance.** Кнопки/кликабельные зоны меняют фон/текст на hover (не только курсор)?
- [ ] **Auto-focus.** Input в modal сфокусирован при открытии?
- [ ] **Focus restore.** После закрытия modal'а фокус вернулся туда, где был?
- [ ] **Activity selector.** Если есть «активный» state — проверяется И `projectId`, И `tabId`?
- [ ] **Динамика layout.** Popup перепозиционируется при resize окна / открытии sidebar?
- [ ] **Truth from server.** Post-factum badge (модель/провайдер/регион) рендерится из ответа сервера, не из локального UI-флага?

## 14. Voice/media capture в Electron renderer

`getUserMedia` + `WebSocket(wss://)` + `AudioWorklet` — три места где Electron сам режет фичу до того как macOS успеет показать системный prompt. Когда «mic-кнопка нажимается, ничего не происходит, в DevTools пусто или AbortError» — корень почти всегда в одном из трёх:

`getUserMedia` reject'ит `AbortError: The user aborted a request` (юзер ничего не делал — это Electron deny по умолчанию). Лечится `session.defaultSession.setPermissionRequestHandler` в main process для `media`/`audioCapture`/`microphone` → `callback(true)` + `setPermissionCheckHandler` для тех же permission names. macOS-уровень разрешения всё равно спросится при первом capture — это нормальный системный prompt, отдельный от Electron-уровня. WebSocket к внешнему домену даёт `Refused to connect` если в CSP нет `connect-src wss://your.domain` — стандартный `default-src 'self'` это запрещает. AudioWorklet через `addModule(blob:URL)` режется на `script-src 'self' 'unsafe-inline'` (нужно добавить `blob:` в `script-src`, `worker-src`, `child-src`). Альтернатива — deprecated `ScriptProcessorNode` работает без CSP-расширений и без blob-инфры; для голоса latency 4096-sample буфера (~85 мс @ 48 kHz) незаметна.

CSP в `<meta http-equiv>` подхватывается только после Cmd+R окна — hot-reload renderer не обновляет head meta. Permission handler в main требует рестарта main process (electron-vite не перегружает main на правки).

В проекте: `knowledge/fact-dictation.md::CSP и permission — два обязательных пререквизита`.
