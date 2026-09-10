# Feature: Prompt Picker (Opt+V)

## Intro
Двухколонный keyboard-first picker для вставки промпта в активный таб. Заменил native macOS `Menu.popup({positioningItem})` который раньше открывался на Cmd+E как нативное контекстное меню с пунктом *Insert Prompt*. Те же данные из SQLite (`prompts` + `prompt_groups`), но рендерится React-portal'ом в `document.body`. Keyboard-вход один — **Opt+V**. Раньше существовал alias **Cmd+E**, но 16.05.2026 слот переназначен на toggle Tab Notes Slideout (см. `fact-notes.md`).

## Why not native menu
- Native menu **не настраивается визуально** — нельзя поменять шрифт, паддинги, скрыть фон.
- На Cmd+E переключение фокуса на пункт работает через `positioningItem` (placement относительно курсора), и на коротких окнах меню вылезало в неудобное место.
- Кастомный picker = одна React-компонента + один store-флаг (`promptPickerOpen`); не нужно дёргать `ipcMain → Menu.buildFromTemplate` на каждое открытие.

## Behavior

### Keyboard navigation (master-detail)
Левая колонка — flat-список групп + ungrouped промптов (сортировка по `position`, как в native menu). Правая — промпты выбранной группы.

- **↑ / ↓** — навигация по левой колонке (если фокус там) или по правой (если фокус на промптах группы).
- **→** на группе — вход в дочернюю колонку, когда цепочка раскрывается вправо; если из-за правой границы viewport дочерняя колонка раскрыта слева, вход зеркально выполняется через **←**.
- Обратная стрелка возвращает на родительский уровень: **←** при раскрытии вправо, **→** при раскрытии влево.
- На первом уровне эта же обратная стрелка закрывает picker (как Esc).
- **Enter** на ungrouped промпте — вставка + закрытие.
- **Enter** на группе с промптами — равнозначно `→`.
- **Enter** на промпте справа — вставка + закрытие.
- **Esc** — закрытие.

При входе фокус автоматически на первой строке, `pickerLevel='group'`. Mouse hover тоже двигает selection (left/right level переключается по hover-зоне).

### Иерархия prompt → наследование содержимого

`visual_parent_id`, который Settings меняет горизонтальным drag, является не
только отступом: выбор вложенного prompt раскрывает всю валидную цепочку
`root → leaf`. Picker строит дерево через тот же `promptOutlineModel`, что
Settings, поэтому проверка циклов, одинаковой группы и максимальной глубины не
дублируется. В строках видны `│ / ├─ / └─`; выбранный leaf подсвечен ярко, его
предки — приглушённо. Hover и клавиатурный selection используют одну цепочку.
Последний горизонтальный сегмент ветки визуально сжат до 80%, а между его концом
и названием остаётся только 1.5px: иерархия читается, но ребёнок не выглядит
искусственно оторванным от своей ветки.

History и SDK получают каждый элемент цепочки отдельным prompt-chip в порядке
от корня к выбранному prompt: `[родитель] [↳ ребёнок]`. Это одна пользовательская
вставка, но не один непрозрачный составной чип: каждую часть можно раскрыть,
вернуть в текст или удалить. Уже присутствующий ancestor не дублируется —
stable `sourceKey` обновляет его на месте. Transport wrapper сохраняет
`inheritance-depth` и непосредственного родителя, поэтому `↳` не теряется после
reload, Copy или восстановления только из transcript. Raw PTY не имеет chip-layer
и получает ту же цепочку одним paste с разделителями `\n\n`.

Пустой prompt — ошибка настройки, а не осмысленная ступень наследования. Строка
приглушается; клик, Cmd+клик, Enter, Copy и выбор потомка через неполную цепочку
не закрывают picker и показывают toast с названием первой пустой ступени. Нельзя
тихо выбрасывать пустой узел и вставлять только оставшуюся часть цепочки: тогда
видимый выбор обещал бы одну инструкцию, а агент получил другую.

Правый клик Copy по вложенному prompt копирует разрешённую цепочку целиком.
Cmd+выбор собирает уникальные file paths со всех ancestors и leaf; если файлов
во всей цепочке нет, остаётся обычная вставка содержимого.

### History context level

Правый клик по History composer открывает тот же picker на один уровень выше: `Insert Prompt` ведёт в существующие group/prompt колонки, `Scripts` показывает `npm run <name>` из `package.json` и видимые `*.sh` как `./file.sh`. Выбор скрипта вставляет точный текст без newline/`CR`, ничего не исполняет и не меняет lifecycle вкладки.

Context-menu захватывает `tabId`, координаты и fallback cwd в момент правого клика. Перед чтением Scripts запрашивается live cwd PTY: пользователь мог сделать `cd` после создания вкладки. Последующий tab switch не перенаправляет вставку, а старое асинхронное чтение prompt-файлов не закрывает и не refocus'ит picker, открытый позже: каждый open имеет своё поколение.

Двухстрочный root `Insert Prompt / Scripts` измеряется и clamp'ится только по собственной геометрии и остаётся у точки правого клика. Group/script и prompt-колонки — независимые absolute-поверхности: каждая якорится к своей parent-row, отдельно сдвигается в доступную высоту viewport и при нехватке места справа вся цепочка раскрывается влево. Высота потомка не участвует в позиции root; общий flex-measure раньше заставлял первый уровень «телепортироваться» вверх при раскрытии длинной группы.

Направление является единым контрактом геометрии, клавиатуры и значков. При раскрытии цепочки влево все submenu-chevron в родительских панелях остаются в правом слоте строки, но смотрят влево; **←** открывает следующий уровень, **→** возвращает назад. При раскрытии вправо сохраняется обычная зеркальная схема.

### Layout reservation: правая панель не сжимает левую
Правая колонка имеет **слот фиксированной ширины** даже когда содержимое скрыто:

```tsx
<div style={{ width: RIGHT_W, flexShrink: 0 }}>
  {selectedLeftItem?.kind === 'group' && <div style={panelStyle}>…</div>}
</div>
```

Когда выделен ungrouped промпт — внутреннего `panelStyle`-блока нет, но wrapper держит ширину, и левая колонка не центрируется в overlay'е. Без этого при движении ↓ через смешанный список «группа → ungrouped промпт → группа» основное окно прыгало бы влево-вправо. Принцип переносимый — см. `methodology/дизайн-принципы.md::Layout reservation`.

Для пустой группы (есть группа, нет промптов в ней) внутри слота показывается placeholder *«пусто»* — отдельное состояние от «не группа выбрана».

### Capture-phase listener: arrow keys в picker, не в xterm
Все keyboard-handler'ы picker'а навешены через `window.addEventListener('keydown', onKey, true)` (capture). До bubble phase, на которой работают xterm `attachCustomKeyEventHandler` и assistant-ui textarea. Иначе:
- Стрелочки `↑/↓` уходят в Claude TUI как навигация по history.
- `Enter` отправляет в PTY пустой `\r` (тогда как picker должен был вставить промпт).
- `Esc` закрывает только модалку assistant-ui (если она была видна), а picker остаётся.

После reading store-флага `promptPickerOpen=true` listener делает `e.preventDefault() + e.stopPropagation() + e.stopImmediatePropagation()` и не пускает событие дальше. Double-safety: оба xterm `attachCustomKeyEventHandler` в `Terminal.tsx` тоже проверяют `useUIStore.getState().promptPickerOpen` и возвращают `false` на arrow/Enter/Esc — если capture-flow по какой-то причине пропустит событие, xterm всё равно его не пошлёт в PTY. Принцип переносимый — см. `methodology/дизайн-принципы.md::Global shortcut в capture phase`.

### Layout-agnostic шорткаты через `event.code`
Открытие picker'а: `e.altKey && e.code === 'KeyV'` (Opt+V). Не `e.key === 'v'` — на Mac Opt+V в QWERTY-layout это символ `√` (option layer), а в Cyrillic-layout — `М`. `e.code` указывает физическую клавишу, не глиф. Принцип переносимый — см. `methodology/дизайн-принципы.md::Layout-agnostic shortcuts`. Cmd+E больше не открывает picker (см. Intro).

Стрелочки/Enter/Esc — non-printable, `e.key` для них одинаков везде, можно проверять по `key`.

## Settings: font + scale + geometry
Шрифт picker'а вынесен в Settings → Размеры → «Меню промптов» («Шрифт», default 12, диапазон 9-20). Все размеры панелей и паддингов скейлятся пропорционально:
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

Обе колонки библиотеки меняют ширину независимо. Первая колонка (группы,
корневые и ungrouped prompt) хранится в
`noted-terminal-prompt-picker-primary-panel-width`, дочерняя prompt-колонка — в
`noted-terminal-prompt-picker-panel-width`. При открытии вправо ручки находятся
справа, при зеркальном открытии влево — слева; первая ручка двигает только
границу первой колонки, вторая — внешний край дочерней. Двухстрочный context-root
`Insert Prompt / Scripts` остаётся фиксированным. Оба значения клампятся по
viewport и собственной минимальной ширине, зависящей от шрифта.

## Cmd-вставка ссылкой вместо содержимого

Обычный выбор промпта читает привязанные файлы и вставляет их текст. Cmd+клик и Cmd+Enter вставляют **только абсолютные пути привязанных файлов** как обычный редактируемый текст в input. Собственный текст сохранённого промпта в Cmd-режиме не добавляется, prompt-чип не создаётся, агентская `@`-ссылка не формируется.

Разница не косметическая: при вставке содержимым приложение читает файл и пропускает его через `sanitizeFileForPrompt` (раскрытие `@include`, вырезание `@ai`-блоков). В Cmd-режиме приложение файл вообще не читает — в input остаётся короткий путь на диск, который пользователь может отредактировать или отправить как обычный текст.

| Поверхность | Что уходит |
|---|---|
| History / SDK composer | голый абсолютный путь обычным текстом, без prompt-чипа |
| PTY (Claude/Codex/gemini/bash) | один paste с голыми абсолютными путями |

Если у промпта несколько файлов, каждый путь занимает отдельную строку. Путь сохраняется как текст, включая пробелы и emoji; приложение не оборачивает его в кавычки и не добавляет хвостовой пробел. В PTY весь набор уходит **одним paste**, чтобы пользователь получил тот же редактируемый текст, что в composer.

History и SDK получают отдельный generic source `prompt-picker-file-path`, который намеренно не совпадает с `prompt-picker`: обработчики считают его обычной вставкой в input и не превращают путь в сохранённый prompt-чип.

Если первый вставляемый путь имеет точную case-sensitive форму `/Users/...` и попадает в начало History/SDK-поля (до него нет видимого текста), renderer добавляет перед ним `~`: `~/Users/...`. Это не даёт общей проверке leading slash принять путь за slash-команду и показать `Terminal only`. `/users/...`, `/User/...` и путь после уже набранного текста не меняются. Для сырого PTY это преобразование не применяется: renderer не владеет его фактической позицией курсора и не должен её угадывать.

**Значок и его резерв.** Строки промптов с непустым `file_paths` всегда рендерят слот фиксированной ширины с SVG `Link2` из `lucide-react`. Cmd меняет только `opacity` и цвет значка: приглушённый серый становится более глубоким синим `#3b82f6`. Размер активного и неактивного SVG одинаков — примерно на 20% больше базового размера текста, поэтому при нажатии модификатора строка не дёргается. Фон выбранной строки всё время остаётся фиолетовым `#9333ea`; появление модификатора не должно перекрашивать или дёргать строку. Постоянный слот не переобрезает названия прямо во время жеста (см. `methodology/дизайн-принципы.md::Layout reservation`). У промптов без файлов слота нет вообще.

Состояние Cmd — derived из keydown/keyup, не из hover: пользователь зажимает Cmd при неподвижном курсоре, и `onMouseEnter` повторно не стреляет (см. `methodology/дизайн-принципы.md::Cmd+Hover`). Обязателен сброс на `window.blur` — иначе Cmd+Tab наружу и обратно оставляет picker в убеждении, что Cmd всё ещё зажат. Cmd+Enter читает модификатор **с самого события**, а не из state: keydown с Cmd приходит раньше, чем успевает обновиться отслеживаемое состояние.

## Tab-type routing для вставки
Picker сам резолвит куда вставлять через `getEffectiveTabId()` (sub-agent aware) + `tab.tabType`:
- видимый History composer → обычный выбор создаёт prompt-чип в tab-scoped History draft, Cmd-вставка пишет путь прямо в текст; floating xterm того же tab остаётся нетронутым;
- `claude-sdk` → обычный выбор создаёт prompt-чип конкретного SDK tab, Cmd-вставка адресно дописывает обычный текст;
- иначе (PTY: claude/gemini/bash) → обычный выбор использует `terminal:input` + `terminal:paste` для содержимого файлов, Cmd-вставка делает один `terminal:paste` с путями и `submit:false`.

Для History/SDK **обычно выбранный** сохранённый prompt остаётся чипом независимо от длины, потому что origin важнее text threshold; приложенные prompt-файлы читаются до доставки и входят в тело того же чипа. Cmd-режим — отдельная операция «вставить путь», поэтому он не наследует identity сохранённого промпта и остаётся обычным редактируемым текстом.

Target для Opt+V тоже фиксируется один раз при open. Если History был видим в этот момент, завершившееся позже чтение attached prompt-файлов доставляет чип туда же даже после переключения tab; mounted composer подтверждает доставку синхронно, а при его unmount чип записывается прямо в сохранённый History draft.

## Focus restore при закрытии (обязательно)

`closePicker()` после `setOpen(false)` возвращает focus той поверхности, которая была target при открытии: History получает свой tab-scoped focus event, SDK/terminal — общую шину `nt:window-refocus-active`. Без этого DOM-focus оставался на `<body>` после закрытия, а floating xterm мог украсть focus у History composer того же tab.

Все пути закрытия проходят через единственный `closePicker` callback (Esc, обратная по геометрии стрелка, click-outside, вставка). `requestAnimationFrame` критичен — portal должен сначала unmount'иться, а composer-insert отработать, прежде чем возвращать focus. Подтверждено живьём для terminal: до фикса `document.activeElement === body`, после — `xterm-helper-textarea`.

## Backdrop отсутствует
Полупрозрачной подложки нет — только click-outside listener на `mousedown` capture phase (см. `App.tsx::onDown` для других overlay'ев — палитра, контекст-меню). Юзер прямо: *«оверлей быть тоже не должно»* — picker должен открываться поверх UI без визуального dimming.

## Anchor: точка курсора в момент открытия
Якорь и направление решаются **один раз** при открытии — picker не следует за мышью пока висит, иначе hover и arrow-навигация двигают само окно под пользователем. ПКМ получает точные `clientX/clientY` из события. У keyboard-входа координат нет, поэтому `PromptPickerOverlay` непрерывно хранит последнюю реальную позицию pointer в ref и снимает её snapshot при `Opt+V`; последующие движения относятся только к следующему открытию.

| Случай | Якорь | Координаты |
|---|---|---|
| ПКМ History composer | `point` | Точная точка клика; ближайшая грань root остаётся в 2px от курсора |
| `Opt+V`, pointer уже наблюдался | `point` | Последняя позиция мыши; весь двухколоночный блок открывается в доступную сторону |
| Pointer ещё ни разу не наблюдался | surface fallback | History composer → его рамка; видимый SDK → caret; иначе `bottom-center` |

У границы viewport меню не «прижимается» так, чтобы курсор оказался внутри. Если вниз не помещается, оно растёт вверх с нижней гранью у курсора; если справа не помещается, вся цепочка зеркалится влево, а первая колонка остаётся ближайшей к курсору. Когда ни одна вертикальная сторона не вмещает естественную высоту, выбирается более просторная и панель получает внутренний scroll вместо переноса root.

В shortcut-режиме внешний двухколонный footprint сохраняется и для группы, и для одиночного prompt. Меняется содержимое зарезервированной дочерней колонки, а не ширина root: hover «группа → одиночный prompt → группа» не имеет права телепортировать окно вправо-влево. Пока асинхронно загружаются prompt-группы, shortcut-picker измеряется невидимо; paint разрешается только позиции, измеренной уже с финальным контентом. Иначе короткий `Loading…` сначала помещался вниз, а готовый список через кадр перебрасывал root вверх.

### SDK caret measurement для редкого fallback
Координаты текстового курсора в `<textarea>` получаем через mirror-div technique (inlined, без зависимости от `textarea-caret-coordinates` пакета):
1. Клонируем computed style текстарии в скрытый `<div>` (whitespace, шрифт, padding, border, размеры — всё что влияет на text wrap).
2. Кладём в div префикс `ta.value.substring(0, selectionEnd)` + маркер `<span>`.
3. `span.offsetLeft/offsetTop - ta.scroll{Left,Top}` + `ta.getBoundingClientRect()` → viewport-relative позиция каретки.
4. Удаляем mirror-div.

`lineHeight` берётся из `getComputedStyle`; fallback на `fontSize * 1.2` если CSS вернул `'normal'`.

### Visible-tab guard (ловушка)
**SDK табы НЕ unmount'ятся** при переключении — они переключаются через `display: none|flex` под одинаковым root'ом `.absolute.inset-0.flex.flex-col`. Прямой `document.querySelector('textarea')` находит первую textarea в DOM, включая **скрытые** SDK табы — их `getBoundingClientRect` = `{0,0,0,0}`, и picker уезжал в верхний-левый угол viewport'а.

`findSDKTextarea()` обязан фильтровать по `style.display !== 'none'` (или `getComputedStyle(root).display`) и defense-in-depth проверяй `width===0 && height===0` на самой textarea. Симптом неправильной фильтрации: «picker всегда в (0,0) на SDK табе независимо от того где я».

### SDK caret fallback — только вниз, без mirror-up
Если до открытия не было ни одного pointer-события и сработал SDK caret fallback, главная колонка picker'а **никогда** не зеркалится вверх от каретки. Если каретка слишком близко к низу viewport'а, picker клампится по нижнему краю (`top = vh - measuredH - margin`) и может перекрыть несколько пикселей input.

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
После выбора начальных `left/top` обе оси клемпятся в viewport (`margin = 8`). Реальный размер picker'а измеряется через `useLayoutEffect` + `rootRef.current.offsetWidth/offsetHeight` — оценка `LEFT_W + GAP + RIGHT_W` используется как fallback до того, как DOM смерил себя. Принцип переносимый — см. `methodology/дизайн-принципы.md::Геометрия popup — от измерения, не от формулы`.

## Библиотека промптов через внешний API

Insert Prompt / Opt+V принадлежит Noted Terminal. Библиотека Voice Record отдельная: отсутствие метода в установленном Terminal не разрешает создать одноимённую копию в другом приложении или переписать его внутреннюю SQLite извне.

`GET /api/prompt-library` отдаёт компактный каталог групп, stable IDs, связей и revisions без тел промптов и чтения вложенных файлов. `POST /api/prompt-library/read` принимает явный набор `promptIds` и режим: `own` нужен для редактирования собственной записи, `resolved` - для проверки того, какой текст получится при вставке. Разрешённая цепочка идёт от корня к выбранному потомку и включает собственный текст и файлы каждого узла. Нельзя записывать этот собранный результат обратно в own text ребёнка: возникнет дубль родителей и вложений. Пустая ступень делает resolved-цепочку неполной, как в picker; own-чтение остаётся доступным для исправления записи.

CRUD промптов проходит через `/api/prompts` и `/api/prompts/:stableId`; перенос и смена родителя - через `/api/prompts/:stableId/move`. Группы обслуживаются `/api/prompt-groups` и `/api/prompt-groups/:id`. Terminal MCP предоставляет `list_prompt_catalog`, `read_prompts`, `create_prompt`, `get_prompt`, `update_prompt`, `move_prompt`, `delete_prompt` и методы `*_prompt_group`. Старые клиенты сохраняют `GET /api/prompts`, а MCP на новой версии использует компактное обнаружение и адресное чтение.

Перед изменением, переносом или удалением клиент читает объект и передаёт его revision. Устаревшая revision даёт 409 вместо перезаписи новых данных. Операция выполняется одной транзакцией; записываются только созданные, изменённые и удалённые строки. Для переименования не применяется старый whole-library `prompts:save`: его замена таблицы не является внешним протоколом точечной правки.

Родитель и ребёнок принадлежат одной группе. Перенос родителя между группами переносит его поддерево; попытка поместить узел внутрь собственного потомка отклоняется. Удаление промпта отсоединяет непосредственных детей, более глубокие потомки остаются под своими родителями. Удаление группы переводит её промпты в ungrouped, сохраняя текст и родственные связи. Изменение родителя меняет наследуемые инструкции, поэтому это содержательная операция, а не только отступ в списке.

Внешняя правка обновляет открытую библиотеку и picker по stable ID. Чистые поля редактора получают новые значения, несохранённый пользовательский текст сохраняется. Структурное изменение списка не должно переносить черновик на другую строку: адрес редактируемого промпта - его stable ID, а не прежний индекс массива.

Новая API-поверхность требует соответствующей версии приложения и Terminal MCP. Отсутствующий endpoint старой установки означает необходимость обновления; `saved_prompt_not_found` или `prompt_group_not_found` на новой API означает отсутствие конкретного объекта. Эти случаи не исправляются одинаковым советом перезапустить приложение. Граница source/установленной версии фиксируется в рабочем файле задачи, а не выводится из наличия обработчика в репозитории.

## Path-зависимости

| Файл | Что делает |
|---|---|
| `src/renderer/components/Workspace/PromptPickerOverlay.tsx` | Сам компонент. Mounted один раз в App.tsx. |
| `src/renderer/components/UI/promptOutlineModel.mjs` | Общая валидированная иерархия Settings + picker. |
| `src/renderer/utils/composerChips.mjs` | Отдельные inherited chips, transport metadata и восстановление History. |
| `src/renderer/App.tsx::handlePickerOpenCapture` | Window keydown capture для Opt+V. |
| `src/renderer/store/useUIStore.ts` | `promptPickerOpen`, `promptPickerFontSize`, `promptPickerBottomOffsetPx`, `promptPickerLeftOffsetPx`, `promptPickerRightOffsetPx` + сеттеры. Все persist в localStorage. |
| `src/renderer/components/Workspace/Terminal.tsx` (оба `attachCustomKeyEventHandler`) | Double-safety guard: блокирует Opt+V и navigation keys, когда picker open. |
| `src/renderer/components/UI/SettingsModal.tsx` | Четыре слайдера в Settings → Размеры → «Меню промптов»: шрифт и отступы снизу/слева/справа. |

## Что НЕ удалили (умышленно)
- **Right-click context menu** на terminal/SDK — open'ится через `ipcMain.on('show-terminal-context-menu')` / `show-sdk-context-menu`. Native menu там остаётся. Исключение — History composer: его правый клик намеренно открывает кастомный `Insert Prompt / Scripts`, потому что вставка принадлежит видимому History input, а не hidden xterm.
- **`focusInsertPrompt` параметр и `_insertPromptAnchor` маркер** в `main.js::show-*-context-menu` handler'ах — пока оставлены на случай, если решим вернуть keyboard-open native menu отдельным хоткеем.

## Что пробовали и не сработало
- **Capture-listener BEZ `stopImmediatePropagation`** — stopPropagation останавливает bubble, но не другие listeners на том же phase. Если bubble-listener xterm уже сам зарегистрирован на capture (что у xterm.js именно так), он получит событие. `stopImmediatePropagation` блокирует все остальные listeners на этом же event.
- **Listener в bubble phase на window** — xterm и assistant-ui textarea получают keydown первыми (они подписаны на nested DOM-элементы, по DOM-flow bubble идёт snizu вверх). Capture фaza идёт сверху вниз — window-handler срабатывает раньше.
- **Backdrop с `background: rgba(0,0,0,0.18)`** — был в первой версии, юзер потребовал убрать («оверлей быть тоже не должно»). Заменён на чистый click-outside.
- **`top: 50%` (по центру)** — picker конкурировал со statusbar'ом на коротких окнах. Промежуточный fallback `top: 22%` тоже был удалён вместе со всей mouse-tracking веткой — теперь fallback всегда `bottom-center` (см. секцию Anchor).
- **Cursor anchor с freshness-timeout** (`Date.now() - t <= 1500`, затем fallback на `top: 22%`) — один и тот же жест менял геометрию только из-за давности последнего `mousemove`: то открывался у мыши, то внезапно над input. Текущий контракт не использует время как доказательство: последняя pointer-позиция хранится до следующего реального события, фиксируется при open и после этого не двигает уже открытый picker.
- **`document.querySelector('textarea')` для SDK caret** — находит первую textarea в DOM включая **скрытые** SDK табы (они переключаются через `display:none|flex`, не unmount'ятся). Их `getBoundingClientRect = {0,0,0,0}` → caret = (0,0) → picker в верхнем-левом углу viewport'а. Симптом «picker появляется в углу независимо от позиции каретки» = `findSDKTextarea` не фильтрует по `display !== 'none'`.
- **Mirror-up главного picker'а при нехватке места снизу** — изначально при `top + measuredH + margin > vh` picker зеркалился вверх от каретки SDK. Юзер: *«ее можно просто пережать вниз и всё»* — открытие вверх ломало mental model «выбираю промпт под местом где печатаю», даже если перекрытие нескольких пикселей инпута визуально менее красиво. Mirror-up оставлен только для правой групповой панели.
- **Правая панель условным рендерингом без wrapper'а** — без зарезервированной обёртки левая колонка при `selectedLeftItem.kind === 'prompt'` центрировалась в overlay'е. Решение — обёртка с `flexShrink: 0` + `width: RIGHT_W` всегда в DOM, content внутри условный.
- **Правая панель `position: relative` внутри flex-row** — при flip-up левая колонка тоже сжималась/растягивалась по высоте правой, переанкорив весь picker. Решение — правая панель `position: absolute` внутри обёртки `position: relative + alignSelf: stretch`, переключение `top: 0` ↔ `bottom: 0`. Picker root всегда занимает высоту левой колонки, правая overflow'ит выше/ниже не двигая ничего.
