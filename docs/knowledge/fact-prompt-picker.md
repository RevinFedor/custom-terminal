# Feature: Prompt Picker (Opt+V)

## Intro
Двухколонный keyboard-first picker для вставки промпта в активный таб. Заменил native macOS `Menu.popup({positioningItem})` который раньше открывался на Cmd+E как нативное контекстное меню с пунктом *Insert Prompt*. Те же данные из SQLite (`prompts` + `prompt_groups`), но рендерится React-portal'ом в `document.body`. Открывается одним хоткеем — **Opt+V**. Раньше существовал alias **Cmd+E**, но 16.05.2026 слот переназначен на toggle Tab Notes Slideout (см. `fact-notes.md`); Opt+V остаётся единственным keyboard-входом в picker.

## Why not native menu
- Native menu **не настраивается визуально** — нельзя поменять шрифт, паддинги, скрыть фон.
- На Cmd+E переключение фокуса на пункт работает через `positioningItem` (placement относительно курсора), и на коротких окнах меню вылезало в неудобное место.
- Кастомный picker = одна React-компонента + один store-флаг (`promptPickerOpen`); не нужно дёргать `ipcMain → Menu.buildFromTemplate` на каждое открытие.

## Behavior

### Keyboard navigation (master-detail)
Левая колонка — flat-список групп + ungrouped промптов (сортировка по `position`, как в native menu). Правая — промпты выбранной группы.

- **↑ / ↓** — навигация по левой колонке (если фокус там) или по правой (если фокус на промптах группы).
- **→** на группе — вход в правую колонку, фокус на первом промпте.
- **←** на правой колонке — возврат фокуса на группу (правая остаётся видимой, но dim).
- **←** на левой колонке — закрытие picker'а (как Esc).
- **Enter** на ungrouped промпте — вставка + закрытие.
- **Enter** на группе с промптами — равнозначно `→`.
- **Enter** на промпте справа — вставка + закрытие.
- **Esc** — закрытие.

При входе фокус автоматически на первой строке, `pickerLevel='group'`. Mouse hover тоже двигает selection (left/right level переключается по hover-зоне).

### Layout reservation: правая панель не сжимает левую
Правая колонка имеет **слот фиксированной ширины** даже когда содержимое скрыто:

```tsx
<div style={{ width: RIGHT_W, flexShrink: 0 }}>
  {selectedLeftItem?.kind === 'group' && <div style={panelStyle}>…</div>}
</div>
```

Когда выделен ungrouped промпт — внутреннего `panelStyle`-блока нет, но wrapper держит ширину, и левая колонка не центрируется в overlay'е. Без этого при движении ↓ через смешанный список «группа → ungrouped промпт → группа» основное окно прыгало бы влево-вправо. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Layout reservation`.

Для пустой группы (есть группа, нет промптов в ней) внутри слота показывается placeholder *«пусто»* — отдельное состояние от «не группа выбрана».

### Capture-phase listener: arrow keys в picker, не в xterm
Все keyboard-handler'ы picker'а навешены через `window.addEventListener('keydown', onKey, true)` (capture). До bubble phase, на которой работают xterm `attachCustomKeyEventHandler` и assistant-ui textarea. Иначе:
- Стрелочки `↑/↓` уходят в Claude TUI как навигация по history.
- `Enter` отправляет в PTY пустой `\r` (тогда как picker должен был вставить промпт).
- `Esc` закрывает только модалку assistant-ui (если она была видна), а picker остаётся.

После reading store-флага `promptPickerOpen=true` listener делает `e.preventDefault() + e.stopPropagation() + e.stopImmediatePropagation()` и не пускает событие дальше. Double-safety: оба xterm `attachCustomKeyEventHandler` в `Terminal.tsx` тоже проверяют `useUIStore.getState().promptPickerOpen` и возвращают `false` на arrow/Enter/Esc — если capture-flow по какой-то причине пропустит событие, xterm всё равно его не пошлёт в PTY. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Global shortcut в capture phase`.

### Layout-agnostic шорткаты через `event.code`
Открытие picker'а: `e.altKey && e.code === 'KeyV'` (Opt+V). Не `e.key === 'v'` — на Mac Opt+V в QWERTY-layout это символ `√` (option layer), а в Cyrillic-layout — `М`. `e.code` указывает физическую клавишу, не глиф. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Layout-agnostic shortcuts`. Cmd+E больше не открывает picker (см. Intro).

Стрелочки/Enter/Esc — non-printable, `e.key` для них одинаков везде, можно проверять по `key`.

## Settings: font + scale + geometry
Шрифт picker'а вынесен в Settings → Шрифты («Prompt picker», default 12, диапазон 9-20). Все размеры панелей и паддингов скейлятся пропорционально:
- `LEFT_W = max(140, fontSize * 15)` ≈ 180px на 12px шрифте
- `RIGHT_W = max(160, fontSize * 17)` ≈ 204px на 12px
- `ROW_PAD_Y = max(3, fontSize * 0.33)` ≈ 4px
- `ROW_PAD_X = max(6, fontSize * 0.66)` ≈ 8px

Стор: `useUIStore.promptPickerFontSize` / `setPromptPickerFontSize`. Persist в `localStorage('noted-terminal-prompt-picker-font-size')`. Слайдер рендерится тем же `<FontSizeSlider>` что и остальные шрифты UI в `SettingsModal.tsx`.

Геометрия fallback-якоря (bottom-center, см. ниже) управляется тремя слайдерами в той же секции:
| Поле стора | localStorage | Default | Диапазон | Назначение |
|---|---|---|---|---|
| `promptPickerBottomOffsetPx` | `noted-terminal-prompt-picker-bottom-offset` | 50 | 0..400 | Расстояние от нижнего края viewport'а до низа picker'а |
| `promptPickerLeftOffsetPx`   | `noted-terminal-prompt-picker-left-offset`   | 0  | 0..2000 | `>0` → прижатие к левому краю с этим отступом |
| `promptPickerRightOffsetPx`  | `noted-terminal-prompt-picker-right-offset`  | 0  | 0..2000 | `>0` → прижатие к правому краю; **приоритет над left** |

Приоритет горизонтального якоря: `right>0` побеждает `left>0`, оба `0` → центр. Right выигрывает, чтобы юзер мог использовать только один слайдер и понимать что он точно сработал — второй остаётся `0` как «не важно».

## Tab-type routing для вставки
Picker сам резолвит куда вставлять через `getEffectiveTabId()` (sub-agent aware) + `tab.tabType`:
- `claude-sdk` → `window.dispatchEvent(new CustomEvent('claude-sdk:composer-insert', { detail: { tabId, text } }))` — тот же event что использует right-click SDK menu.
- иначе (PTY: claude/gemini/bash) → `ipcRenderer.send('terminal:input', tabId, content)` + `ipcRenderer.invoke('terminal:paste', …)` для file_paths. Идентично существующему `cmd === 'insert-prompt'` handler'у в `App.tsx`.

## Focus restore при закрытии (обязательно)

`closePicker()` после `setOpen(false)` диспатчит `nt:window-refocus-active` через `requestAnimationFrame`. Без этого DOM-focus оставался на `<body>` после закрытия — клик по строке picker'а (это `<div>`, не focusable) блюрит xterm-textarea в `body`, а Esc/click-outside никогда не возвращали фокус назад. Симптом: после Opt+V → выбор промпта (или Esc) курсор пропадает из Claude TUI, юзер вынужден кликать в терминал руками. Юзер: *«мне приходится вручную нажимать лишний клик, чтобы поставить курсор обратно в input терминала»*.

Все пути закрытия проходят через единственный `closePicker` callback (Esc, ArrowLeft на левой колонке, click-outside, вставка промпта) — фикс в одном месте покрывает все. Переиспользуется существующая шина `nt:window-refocus-active` (Terminal.tsx + SDKComposer уже слушают, см. [`fact-cmd-tab-refocus.md`](fact-cmd-tab-refocus.md)), не изобретается своя focus-логика. `requestAnimationFrame` критичен — portal должен сначала unmount'иться, а SDK composer-insert отработать, прежде чем мы заберём focus; синхронный dispatch внутри того же тика фокуснул бы элемент который picker ещё перекрывает. Подтверждено живьём: до фикса `document.activeElement === body` после реального клика по строке, после фикса — `xterm-helper-textarea`.

## Backdrop отсутствует
Полупрозрачной подложки нет — только click-outside listener на `mousedown` capture phase (см. `App.tsx::onDown` для других overlay'ев — палитра, контекст-меню). Юзер прямо: *«оверлей быть тоже не должно»* — picker должен открываться поверх UI без визуального dimming.

## Anchor: SDK caret или bottom-center fallback
Якорь решается **один раз** при открытии — picker не следует ни за чем пока висит, иначе arrow-навигация ломает mental model «окно стоит, я в нём двигаюсь стрелочками». Mouse-cursor tracking удалён полностью — раньше picker пытался открыться у мыши с проверкой свежести `mousemove` (≤ 1500мс), но это конфликтовало с типичным сценарием «фокус в input → жму Opt+V» где мышь могла быть где угодно. Новая стратегия — основана исключительно на типе активного таба:

| Случай | Якорь | Координаты |
|---|---|---|
| Активный таб — `claude-sdk` И его textarea видима И есть selectionEnd | `sdk-caret` | Справа-вниз от текстового курсора в textarea: `left = caret.x + 6`, `top = caret.y + lineHeight + 4` |
| Иначе (терминал, нет таргета, скрытый SDK, etc.) | `bottom-center` | `top = vh - height - bottomOffsetPx`, `left` по правилам приоритета `right > left > center` |

### SDK caret measurement
Координаты текстового курсора в `<textarea>` получаем через mirror-div technique (inlined, без зависимости от `textarea-caret-coordinates` пакета):
1. Клонируем computed style текстарии в скрытый `<div>` (whitespace, шрифт, padding, border, размеры — всё что влияет на text wrap).
2. Кладём в div префикс `ta.value.substring(0, selectionEnd)` + маркер `<span>`.
3. `span.offsetLeft/offsetTop - ta.scroll{Left,Top}` + `ta.getBoundingClientRect()` → viewport-relative позиция каретки.
4. Удаляем mirror-div.

`lineHeight` берётся из `getComputedStyle`; fallback на `fontSize * 1.2` если CSS вернул `'normal'`.

### Visible-tab guard (ловушка)
**SDK табы НЕ unmount'ятся** при переключении — они переключаются через `display: none|flex` под одинаковым root'ом `.absolute.inset-0.flex.flex-col`. Прямой `document.querySelector('textarea')` находит первую textarea в DOM, включая **скрытые** SDK табы — их `getBoundingClientRect` = `{0,0,0,0}`, и picker уезжал в верхний-левый угол viewport'а.

`findSDKTextarea()` обязан фильтровать по `style.display !== 'none'` (или `getComputedStyle(root).display`) и defense-in-depth проверяй `width===0 && height===0` на самой textarea. Симптом неправильной фильтрации: «picker всегда в (0,0) на SDK табе независимо от того где я».

### Главный picker — только вниз, без mirror-up
Главная (левая) колонка picker'а **никогда** не зеркалится вверх от каретки. Если каретка слишком близко к низу viewport'а, picker клампится по нижнему краю (`top = vh - measuredH - margin`) и перекрывает несколько пикселей инпута — это приемлемо. Юзер прямо: *«ее можно просто пережать вниз и всё, в этом ничего страшного нет»*.

Mirror-up зарезервирован **только** для правой (групповой) колонки — см. ниже.

### Right panel flip-up
Правая колонка (содержимое группы) рендерится `position: absolute` внутри обёртки фиксированной ширины:
- По умолчанию `top: 0` (растёт вниз от верха picker'а).
- Если её высота больше левой И `top + rightH + margin > vh` — переключается на `bottom: 0` (растёт вверх от низа). Левая колонка не двигается, picker root не меняет высоту — flip-аются только внутренности правого слота.

Это **единственный** legit-сценарий mirror-flip в picker'е: когда выбранная группа содержит сильно больше промптов чем виден потолок левой колонки.

### Bottom-center fallback geometry
Когда якорь `bottom-center` — горизонтальная позиция определяется приоритетом:
- `rightOffsetPx > 0` → `left = vw - measuredW - rightOffsetPx`
- иначе `leftOffsetPx > 0` → `left = leftOffsetPx`
- иначе → `left = round(vw/2 - measuredW/2)` (центр)

Right выигрывает у left умышленно: юзер часто использует только один слайдер; знать что «правый всегда побеждает» проще чем разбираться какой настроенный.

### Viewport clamp + измерение
После выбора начальных `left/top` обе оси клемпятся в viewport (`margin = 8`). Реальный размер picker'а измеряется через `useLayoutEffect` + `rootRef.current.offsetWidth/offsetHeight` — оценка `LEFT_W + GAP + RIGHT_W` используется как fallback до того, как DOM смерил себя. Принцип переносимый — см. `methodology/переносимый-дизайн.md::Геометрия popup — от измерения, не от формулы`.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `src/renderer/components/Workspace/PromptPickerOverlay.tsx` | Сам компонент. Mounted один раз в App.tsx. |
| `src/renderer/App.tsx::handlePickerOpenCapture` | Window keydown capture для Opt+V. |
| `src/renderer/store/useUIStore.ts` | `promptPickerOpen`, `promptPickerFontSize`, `promptPickerBottomOffsetPx`, `promptPickerLeftOffsetPx`, `promptPickerRightOffsetPx` + сеттеры. Все persist в localStorage. |
| `src/renderer/components/Workspace/Terminal.tsx` (оба `attachCustomKeyEventHandler`) | Double-safety guard: блокирует Opt+V и navigation keys, когда picker open. |
| `src/renderer/components/UI/SettingsModal.tsx` | Четыре слайдера в секции «Шрифты интерфейса»: «Prompt picker» (шрифт), «Picker — отступ снизу/слева/справа». |

## Что НЕ удалили (умышленно)
- **Right-click context menu** на терминале/SDK — open'ится через `ipcMain.on('show-terminal-context-menu')` / `show-sdk-context-menu`. Native menu всё ещё нужен для правого клика, потому что macOS context-menu имеет правильный mouse-pointer-binding и кастомный picker мы туда не привязывали. Removed только клавиатурное открытие native menu (раньше — Cmd+E с `focusInsertPrompt:true`).
- **`focusInsertPrompt` параметр и `_insertPromptAnchor` маркер** в `main.js::show-*-context-menu` handler'ах — пока оставлены на случай, если решим вернуть keyboard-open native menu отдельным хоткеем.

## Что пробовали и не сработало
- **Capture-listener BEZ `stopImmediatePropagation`** — stopPropagation останавливает bubble, но не другие listeners на том же phase. Если bubble-listener xterm уже сам зарегистрирован на capture (что у xterm.js именно так), он получит событие. `stopImmediatePropagation` блокирует все остальные listeners на этом же event.
- **Listener в bubble phase на window** — xterm и assistant-ui textarea получают keydown первыми (они подписаны на nested DOM-элементы, по DOM-flow bubble идёт snizu вверх). Capture фaza идёт сверху вниз — window-handler срабатывает раньше.
- **Backdrop с `background: rgba(0,0,0,0.18)`** — был в первой версии, юзер потребовал убрать («оверлей быть тоже не должно»). Заменён на чистый click-outside.
- **`top: 50%` (по центру)** — picker конкурировал со statusbar'ом на коротких окнах. Промежуточный fallback `top: 22%` тоже был удалён вместе со всей mouse-tracking веткой — теперь fallback всегда `bottom-center` (см. секцию Anchor).
- **Anchor у курсора мыши** (вся ветка с `lastMouseRef`, `mousemove` listener, `Date.now() - t <= 1500` свежесть, fallback на `top: 22%`) — конфликтовал с типичным сценарием «фокус в SDK input → Opt+V» где мышь могла быть в произвольной точке экрана. Picker выскакивал далеко от того места где юзер реально работал. Заменено на детерминированный якорь от типа активного таба: SDK caret или bottom-center.
- **`document.querySelector('textarea')` для SDK caret** — находит первую textarea в DOM включая **скрытые** SDK табы (они переключаются через `display:none|flex`, не unmount'ятся). Их `getBoundingClientRect = {0,0,0,0}` → caret = (0,0) → picker в верхнем-левом углу viewport'а. Симптом «picker появляется в углу независимо от позиции каретки» = `findSDKTextarea` не фильтрует по `display !== 'none'`.
- **Mirror-up главного picker'а при нехватке места снизу** — изначально при `top + measuredH + margin > vh` picker зеркалился вверх от каретки SDK. Юзер: *«ее можно просто пережать вниз и всё»* — открытие вверх ломало mental model «выбираю промпт под местом где печатаю», даже если перекрытие нескольких пикселей инпута визуально менее красиво. Mirror-up оставлен только для правой групповой панели.
- **Правая панель условным рендерингом без wrapper'а** — без зарезервированной обёртки левая колонка при `selectedLeftItem.kind === 'prompt'` центрировалась в overlay'е. Решение — обёртка с `flexShrink: 0` + `width: RIGHT_W` всегда в DOM, content внутри условный.
- **Правая панель `position: relative` внутри flex-row** — при flip-up левая колонка тоже сжималась/растягивалась по высоте правой, переанкорив весь picker. Решение — правая панель `position: absolute` внутри обёртки `position: relative + alignSelf: stretch`, переключение `top: 0` ↔ `bottom: 0`. Picker root всегда занимает высоту левой колонки, правая overflow'ит выше/ниже не двигая ничего.
