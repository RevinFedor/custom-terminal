# Feature: Tab Preview Popover (CMD+hover)

## Intro
Превью карточки таба, появляющееся при наведении с зажатым CMD. Унифицированный `TabPreviewPopover` для двух поверхностей: вкладки `TabBar` и карточки в `ProjectHome` (Active + History). Ширину юзер задаёт resize-ручкой на правом крае (персистится), высота динамическая под контент до потолка из Settings. Раньше была autobalance по пропорции — удалена (см. Sizing graveyard).

## User Flow

1. **Активация**: hover на вкладке/карточке + удержание ⌘. Появляется popover с заметкой.
2. **Контент**: markdown notes (read-only). В split-mode (Home) дополнительно metadata-блок (Path / Closed / Created / Type / Messages) **под** карточкой; notes — **над** карточкой. В TabBar — только notes под табом.
3. **Закрытие**: уход курсора с popover'а + отпускание ⌘.
4. **Закреп**: CMD+Shift над любым открытым popover'ом — popover «прибивается» (белая рамка 1px). CMD можно отпустить, курсор увести куда угодно, перенаведение на другие триггеры игнорируется. Снятие — повторный CMD+Shift или mousedown в любом месте приложения вне popover-обёртки (атрибут `data-cmd-hover-popover` защищает внутренние клики). Общая механика закрепа — в global `tooltip-resize-modal.md::Закреп: Cmd+Shift делает любой popover пинованным`.

## Sizing: resize-ширина + динамическая высота

Модель простая и предсказуемая: **ширину задаёт юзер перетаскиванием правого края превью, высота динамическая под контент**.

- `tabPreviewMaxWidth` (default 200px, 120-900px) — **потолок переноса текста**, его двигает resize-ручка на правом крае превью (не Settings — там оно disabled-отображением). Текст переносится в эту ширину.
- `tabPreviewMaxHeight` (default 250px, 80-900px) — потолок высоты, до которого коробка растёт построчно; дальше внутренний scroll. Активно редактируется в Settings.
- `ratio` удалён полностью (см. graveyard).

Алгоритм (`useLayoutEffect`, `measureAt(w)` через единый hidden probe-DOM):
1. Замер natural-width контента при `width: max-content + max-width: previewWidth`.
2. **Ширина** = `clamp(naturalW, NOTES_MIN_WIDTH, previewWidth)`. Контент короче потолка (заметка в одну строку) → коробка ужимается до natural-width — **нет пустого места справа**. Контент шире → ширина = потолок, текст переносится.
3. **Высота** = `measureAt(chosenW)`, обрезается `heightCap`. Динамическая построчно.
4. `heightCap = min(tabPreviewMaxHeight, доступное место до края экрана)`. Если вкладка близко к низу/верху и контент не влезает даже в maxHeight — scroll наступает раньше (`avail = max(spaceBelow, spaceAbove, 120)` — popover флипается туда где места больше, минимум 120px даже у самого края).

Никакой бисекции/балансировки — width фиксируется юзером, height просто меряется один раз. Эффект пере-запускается при изменении `previewWidth` (resize) и `heightCap` (rect/maxHeight).

### Resize-ручка
Узкая (7px) полоса по правому краю notes-карточки, `ew-resize`, подсветка индиго на hover (та же стилистика что resize-края slide-out заметок). Drag пишет `tabPreviewMaxWidth` в store **live** (store сам clamp'ит [120, 900]), эффект пере-меряет на каждое изменение. Тянуть **шире natural-width бессмысленно** — коробка уже = naturalW (короткий текст), потому ширина «не даётся в большую сторону пока есть запас справа»; реально расширение работает только когда текст переносится (naturalW > previewWidth). `resizingRef` глушит mouse-leave-close popover'а на время drag'а — иначе курсор, выехавший за край, закрыл бы превью. Только на notes (meta-only popover не ресайзится). Persist: `tabPreviewMaxWidth` зеркалится в SQLite (`app:setState`) + localStorage — переживает рестарт и vite port shuffle.

## Wait-for-stable measurement

MarkdownEditor (react-markdown) рендерит markdown-блоки **асинхронно** через несколько микрозадач. Один-проходный `useLayoutEffect`-замер видит partial-state: первые 1-3 кадра `scrollWidth` возвращает 0, или одно слово, или остаток предыдущего hover'а (probe-DOM переиспользуется React'ом). В логах было `naturalW: 200 → 75 → 0` между hover'ами одной и той же заметки — итоговые размеры менялись от replay к replay.

Решение:
- **rAF-loop ждёт стабильности**: `scrollWidth > 0 && равен предыдущему 3 кадра подряд` → можно использовать. `MAX_FRAMES = 40` страховка от бесконечного цикла.
- **`key={notes}` на probe-MarkdownEditor**: при смене контента React делает hard-remount probe-DOM, никакого leftover внутреннего state. Это убивает «300px остался от прошлой заметки» когда `widthBefore` после первого measure был установлен, а React не diff'ил inline-style на следующий render.
- **Inline-style сбрасывается на каждом тике settle**: `probe.style.width = ''` перед чтением `scrollWidth`. Без этого предыдущий measure оставил фиксированную ширину, и `scrollWidth` возвращал зажатое значение.

Логи (`[TabPreviewSize:enter]`, `[TabPreviewSize:settle]`, `[TabPreviewSize:final]` с полями source / framesUsed / targetRatio / actualRatio) можно включить временно для диагностики — текущий код не пишет ничего в продакшене после успешной стабилизации.

## Layout & позиционирование

**TabBar horizontal mode** (legacy): popover открывается под табом, **только notes** (без metadata — у активных табов cwd/type видны из контекста, дублировать нет смысла).

**TabBar vertical mode (TabSidebar)**: popover открывается **справа от таба** (`placement='right'`), вертикально центрирован относительно середины таба (`top: rect.top + rect.height/2; transform: translateY(-50%); paddingLeft: 6px`). Fallback — flip-left когда viewport справа меньше popover-width (`rect.right + width > viewport.width`). Юзер: *«при наведении и зажатии в CMD у нас открывается модалка с описанием заметки. Ее нужно теперь, чтобы она открывалась справа по центру»*. `data-cmd-hover-popover` атрибут сохраняется на wrapper'е — закреп Cmd+Shift работает идентично below/above режимам.

**ProjectHome split-mode** (CMD+hover на Active/History карточках): **два независимых wrapper'а** вокруг карточки. Верхний — notes выше карточки через `top: rect.top + translateY(-100%)`. Нижний — metadata block ниже карточки через `top: rect.bottom`. Оба используют общий `popoverProps` (onMouseEnter/Leave) — переход курсором с одной части на другую через карточку держит popover открытым, уход куда-то ещё закрывает обе одновременно. Mental model: «заметка вверху, описание внизу относительно карточки».

**Empty-notes skip**: верхний wrapper не рендерится если у вкладки нет заметки. Без этой проверки выше карточки появлялась тонкая полоска от `border: 1px + padding` пустой card — выглядела как баг. Условие: split → `hasNotes`; single → `hasNotes || metaRows`.

**Что пробовали и почему не сработало**: сначала был single-wrapper popover с порядком `title → metadata → notes`, открывался под карточкой. Юзер: *«заметка должна быть над вкладкой, описание под»*. Перенесли в single-wrapper above-режим — нарушалась mental model. Только split на два wrapper'а закрывает требование. Title-блок (bold имя вкладки сверху popover'а) тоже удалили — имя на trigger-карточке (TabBar таб / Home card) уже читается, в popover'е дублирование.

## Pointer-through на Home

На Project Home карточки выложены сеткой 4×N. При наведении на одну сверху и снизу появляются info-блоки — путь курсора к карточке под/над текущей перегораживается. Контент popover'а на Home read-only и некликабелен, интерактивность не нужна. Поэтому Home передаёт `pointerThrough` → оба wrapper'а получают `pointer-events: none`, hover-эффект проходит сквозь весь блок к карточке под ним, при наведении на следующую карточку popover моментально переключается.

В TabBar `pointerThrough` НЕ применяется — там popover один, перекрывать нечего, выделение текста должно работать.

Закреп (CMD+Shift) автоматически снимает pointer-through: закреплённый popover на Home становится интерактивным (текст можно выделить, ссылки внутри markdown кликаются). Реализация: `pointerThrough && !isLocked ? pointer-events: none : null` в обоих wrapper-стилях.

Принцип — в `methodology/переносимый-дизайн.md::Pointer-through для info-popover'ов перегораживающих hover-grid`.

## Закреп: CMD+Shift

Универсальный механизм через `useCmdHoverPopover` hook (см. `useCmdHoverPopover.tsx::toggleLock`). При зажатом CMD нажатие Shift над открытым popover'ом → `isLocked = true`. В locked-режиме:
- popover больше не закрывается ни от ухода курсора, ни от отпускания CMD.
- перенаведение на другие триггеры **игнорируется** (`setHovered`, `triggerProps.onMouseEnter`, `popoverProps.onMouseLeave` — все возвращают рано если `isLocked`).
- белая рамка 1px (`border: '1px solid #fff'` вместо `#333` на главной card; `#fff` вместо `rgba(59,130,246,0.3)` или `rgba(168,85,247,0.3)` на синем/фиолетовом tooltip'ах Timeline).
- pointer-events возвращаются если был `pointerThrough`.

Снятие — два пути:
- Повторный CMD+Shift из любой точки экрана. Глобальный keydown listener в `useCmdHoverPopover` ловит независимо от positions.
- mousedown в любой части приложения вне popover-обёртки. Все wrapper'ы помечены `data-cmd-hover-popover` атрибутом, глобальный mousedown handler через `closest('[data-cmd-hover-popover]')` пропускает события внутри popover'а — выделение текста, скролл, клики по ссылкам lock не снимают.

Аналогично работает в Timeline (entry / note / fork tooltip'ы) — единая methodology, разные компоненты. Старый `freezeCmdPopups` toggle в StatusBar (жёлтый чип «freeze tooltips» для DevTools-инспекции) работает параллельно — это режим для разработки, оставлен нетронутым.

Подробнее про закреп вообще — `~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/tooltip-resize-modal.md::Закреп`.

## Persistence settings

`tabPreviewMaxWidth` / `tabPreviewMaxHeight` / `tabPreviewRatioW` / `tabPreviewRatioH` в `useUIStore`. Ключи `noted-terminal-tab-preview-max-{width,height}` / `noted-terminal-tab-preview-ratio-{w,h}` зеркалятся в SQLite через стандартный localStorage mirror (`app:mirrorLocalStorageSync` в main.js).

Settings UI: модалка → секция «Заметки вкладки». Один блок включает:
- 3 шрифта (sidebar / expanded / tooltip — см. секцию ниже).
- Padding X/Y.
- **Макс. ширина [resize]** — `FontSizeSlider disabled`: показывает текущее значение read-only (без +/−, dimmed), потому что ширину юзер задаёт перетаскиванием правого края превью, а не в Settings. Лейбл с `[resize]` сигнализирует канал ввода.
- **Макс. высота** — обычный editable `FontSizeSlider`: до неё растёт высота, дальше scroll.
- Пропорция (RatioRow) удалена.

Числовые инпуты в `FontSizeSlider` (кроме disabled) — editable: на focus убирает suffix (`12px` → `12`), select-all, Enter/blur коммитит clamped значение, Escape откатывает. Кнопки +/− по бокам для нудж'ей. `disabled`-вариант рендерит просто значение-пилюлю без кнопок.

## Шрифт: один из трёх по density-контексту

`fontSize` берётся из `notesTooltipFontSize` — отдельный от `notesSidebarFontSize` (inline в InfoPanel) и `notesExpandedFontSize` (slide-out). Раньше был один общий `notesEditorFontSize` — мелкий в превью либо громоздкий в раскрытом, юзер не выбирал между плотностями. Раздельные шрифты — не per-surface, а по семантике плотности окружения (сайдбар тесный → мельче, раскрытый просторный → крупнее, попап над курсором → отдельная балансировка). Принцип — `methodology/переносимый-дизайн.md::Один контент в нескольких density-контекстах`.

`paddingX` / `paddingY` единые (`notesEditorPaddingX/Y`) — это визуальный отступ редактора, не диктуется плотностью.

Migration: при отсутствии новых ключей (`noted-terminal-notes-{sidebar,expanded,tooltip}-font-size`) читаем legacy `noted-terminal-notes-editor-font-size` (или ещё более старый `noted-terminal-tab-notes-font-size`) и подставляем во все три. Юзер не теряет значение которое накопил годами.

## Что сняли и почему (graveyard)

Эта компонента прошла через 600+ строк инфраструктуры drag-resize'а который потом полностью убрали. Записано для защиты от регрессии — следующий цикл редизайна не должен возвращать каждый из этих шагов.

- **5 resize handles (right / left / bottom + 2 угла) + drag-state буфер**: юзер тянет handle → live React preview каждый mousemove → один flush в store на mouseup. Работало корректно, но bypass'илось логикой задачи: hover-popover живёт секунды, ручной resize этого времени не оправдывает. Заменено на autobalance.
- **`localLeftShift` (drag за левый край, popover растёт влево)**: persistence-боль — после закрытия popover'а leftShift сбрасывался, при следующем open позиция = `rect.left + viewport clamp`. Persisting его привёл бы к тому что popover открывается в неожиданном месте relative к новой trigger-карточке. С удалением handles вопрос отпал.
- **StrictMode previewRef mirror**: `setState(prev => { captured = prev; return null })` в React 19 StrictMode invokes функцию дважды, второй раз с `prev = null` — captured затирался. Лекарство было: параллельный `useRef` зеркало state'а, обёртка `setDragPreview` обновляла оба. Принцип переносим — оставлен в `methodology/переносимый-дизайн.md::React StrictMode`. Конкретное место (drag-buffer попапа) больше не существует.
- **isDraggingRef + grace period 200ms + elementFromPoint check**: защита от закрытия popover'а посреди drag'а (курсор уходил за wrapper-rect → mouseLeave → unmount). Без drag'а защищать нечего.
- **wrapper padding 8px со всех сторон**: чтобы handles на offset -5px физически попадали внутрь `wrapper.boundingClientRect()` (иначе triggerProps.onMouseLeave timer убивал popover до drag'а). С удалением handles padding не нужен — popover примыкает к trigger'у плотно.
- **Float-значения в store + Math.round только в Settings**: чтобы рамка не прыгала на mouseup из-за subpixel-mismatch'а между live-preview и rounded store. Без drag'а — целые числа.
- **CSS-ловушки три**: `overflow:hidden` обрезал handles на `-5px` → нужен был card-wrap без overflow. `flex:1 + maxHeight: limit` давал effective `min(natural, limit)` → drag-up не реагировал визуально на коротком content → нужен был `height: limit + flex: 0 0 auto`. `Math.round(dy/lineHeight)` создавал discrete-step jitter → нужен был float. Все три пропали вместе с handles. Принцип остаётся в `methodology/переносимый-дизайн.md::Drag-state буфер`.
- **Autobalance по target-ratio (бисекция W в [MIN, maxWidth] под `ratioW/ratioH`)**: пришла на смену тем handles, прожила недолго и тоже снята. Баг, по которому сняли: при пропорции 6:2 и max 400×400 длинный текст давал коробку **уже** maxWidth и высокую — фактическое W/H ≈ 1.07 вместо целевого 3.0. Причина: ветка «коробка слишком плоская» **сужала** chosenW (242→157) ради ratio, хотя был запас до 400; настройка maxWidth почти не работала, алгоритм сам отказывался её использовать. Плюс `min(naturalH, maxHeight)` накладывался ПОСЛЕ выбора ширины — ratio не «видел» что лишнюю высоту срежет scroll, и сужал ширину зря. Юзер: *«ширина меньше 400, хотя и ширина и высота 400, а пропорция 6:2»*. Заменено на resize-ширина + динамическая высота (см. Sizing). `tabPreviewRatioW/H` + `setTabPreviewRatio` + `RatioRow` удалены из store/Settings; localStorage-ключи `noted-terminal-tab-preview-ratio-{w,h}` осиротели (никто не читает, безвредны).

Невозврат: **не возвращать проекционную autobalance** (бисекцию под пропорцию) — она душит ширину и делает настройку maxWidth бесполезной. Resize-ширина вернулась намеренно (юзер сам попросил: предсказуемая фикс-ширина + обрезка пустого места справа на коротком тексте), но **только по ширине** — высота остаётся динамической. Resize info-popover оправдан здесь потому что превью часто закрепляют (CMD+Shift lock) и читают долго; для короткоживущего hover он избыточен, но lock меняет режим. См. global `tooltip-resize-modal.md::Tooltip с resize`.

## Связи

- `methodology/переносимый-дизайн.md::Popover sizing переменного контента` — фикс-ширина (resize) + динамическая высота; почему autobalance по пропорции отвергнут.
- `methodology/переносимый-дизайн.md::Pointer-through для info-popover'ов` — почему на Home сквозь, на TabBar нет.
- `methodology/переносимый-дизайн.md::Один контент в нескольких density-контекстах` — три fonts по семантике.
- `fact-project-home.md::Hover Popover (CMD+hover)` — конкретные карточки Home, split-mode на месте.
- `fact-notes.md::Tab Notes Slideout` — drag-resize в slide-out (единственный оставшийся в проекте после rewrite'а превью).
- `fix-notes-font-fragmentation.md` — предыдущая итерация (схлопывание в один шрифт) и постскриптум о пересмотре.
- `~/Global-Templates/🧩 Code-Patterns/docs-projects/ux-паттерны/tooltip-resize-modal.md` — глобальный mental model для всех всплывающих окон с привязкой.
