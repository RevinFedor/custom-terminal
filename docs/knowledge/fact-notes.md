# Feature: Tab Notes (per-tab)

## Intro
Система заметок, привязанных к **каждой вкладке** (`tab.notes`), а не к проекту целиком. Project-level fullscreen modal (`NotesEditorModal.tsx`) удалён в пользу per-tab slideout — глобальные project notes больше не существуют как сущность в UI. У каждой вкладки своя независимая заметка.

## User Flow
1. **Slideout-режим — единственный surface для записи** — `Cmd+E` или клик по иконке `StickyNote` (indigo-tinted) на вкладке в `TabSidebar`. По дефолту кнопка видна на активной вкладке; при зажатом `Cmd` (cursor в TabSidebar) появляется также на всех вкладках где **есть заметка** — peek-mode, можно открыть slideout на не-активной вкладке без переключения active (см. `### Кнопка-заметки` ниже). Открывается ресайзабельная панель **слева-направо** (anchor — правый край TabSidebar). Закрывается клик-outside, Esc или повторный `Cmd+E`. Раньше был ещё inline preview в нижней части `InfoPanel`-сайдбара — удалён вместе с самой правой колонкой (см. `fact-workspace.md::Two-Column Layout`).
2. **AI Paste** (`Cmd+/` → `📋 AI Paste` → `Cmd+V`):
   - В editor вставляется `^^ ⏳` placeholder и сворачивается.
   - Параллельно `onGenerateTitle(text)` уходит в Gemini (см. секцию AI Paste ниже).
   - Когда title возвращается — `⏳` заменяется на него.

## Behavior
- **Per-tab persistence:** `tab.notes` хранится в `useWorkspaceStore.openProjects[].tabs[].notes`. Save через `setTabNotes(tabId, content)`. Сохраняется в SQLite через стандартный tab-persist pipeline.
- **Per-tab open state:** `useUIStore.notesPanelOpenTabs: Record<tabId, boolean>` — каждая вкладка имеет независимое состояние «открыт slideout или нет».
- **Cmd+E:** toggle slideout заметок текущей вкладки. Слот менялся: исторически жил Insert Prompt (native menu) → потом был alias на Opt+V prompt-picker → c 16.05.2026 окончательно перенесён на toggle заметок (раньше тут стоял `Cmd+J`, удалён). Хендлер живёт в `Workspace.tsx`, layout-agnostic (`e.code === 'KeyE'`).
- **Cmd+B:** toggle file-explorer sidebar.
- **Opt+V:** открывает кастомный двухколонный prompt-picker (groups | prompts), keyboard-first, рендерится React Portal. Это единственный keyboard-shortcut на picker (`Cmd+E` больше не alias). Native macOS Menu.popup используется только для правого клика (`show-terminal-context-menu` / `show-sdk-context-menu`). Детали — `fact-prompt-picker.md`.
- **Improved Scroll:** редактор использует `min-h-0` в flex-контейнере и `overflow-x: hidden` для CodeMirror.

## Tab Notes Slideout (per-tab панель)

Контент хранится в `tab.notes` (per-tab), не в `project.notes` — у каждой вкладки своя независимая заметка. Триггер — `<button data-tab-notes-open-trigger data-tab-id={tab.id}>` с иконкой `StickyNote` справа от имени вкладки в `TabItem`. Видимость определяется тремя условиями (см. `### Кнопка-заметки` ниже), не одним `isActive`. Раньше триггер был widening header'ом `← Open Заметки вкладки ✦` в нижней части правой `InfoPanel`-сайдбара — после удаления правой колонки переехал в TabItem (см. `methodology/design.md::Активный элемент списка несёт контекстную affordance`). Per-tab open state — `useUIStore.notesPanelOpenTabs: Record<tabId, boolean>`, но **at most one entry is true** (см. `### One-at-a-time` ниже).

### Кнопка-заметки: три условия видимости, peek через Cmd, solid-фон при открытом slideout
Кнопка `StickyNote` рендерится если выполнено **хотя бы одно**:
1. **`slideoutOpenHere`** — slideout сейчас якорится к этой вкладке. Solid-indigo фон (`#6366f1` + белая иконка), кнопка видна всегда, независимо от active/peek. Это якорь — пока slideout открыт, юзер должен видеть «откуда он растёт».
2. **`showNotesPeek`** = `isCmdPressed && isMouseInTabBar && hasNotes` — Cmd зажат, курсор в TabSidebar, у вкладки непустые заметки. Tinted-indigo фон, кликабельна — клик открывает slideout на этой вкладке (без переключения active, `e.stopPropagation()` на onClick).
3. **default-on-active** — `isActive && !anySlideoutOpen && !cmdPeekMode`. Active вкладка показывает кнопку **только** если (a) slideout не открыт где-то ещё и (b) сейчас не peek-mode. Второе подавление обязательно: при Cmd-peek юзер ждёт «кнопки только там где есть заметки», и default-on-active на active без заметки сломал бы это правило (см. `methodology/design.md::Peek через модификатор`).

Раньше peek-режим был оранжевой dot'кой 5×5px в правом-верхнем углу `TabItem` — она показывала «здесь есть заметка», но не была кликабельна; открыть slideout можно было только переключившись на эту вкладку. Заменили потому что dot в peek-режиме всё равно требовал переключения active → лишний жест; кликабельная peek-кнопка позволяет открыть содержимое на любой вкладке за один клик с зажатым Cmd.

### One-at-a-time: opening on X closes Y
`setNotesPanelOpen(X, true)` пишет в стор `{[X]: true}` целиком, не `prev[X] = true` — это закрывает slideout на любой другой вкладке. У slideout'а один физический инстанс с геометрическим якорем (anchor по `[data-tab-id]` кнопки), две одновременные привязки невозможны технически. Open на B пере-якоривает overlay с A на B, кнопка на A теряет solid-indigo (slideoutOpenHere = false), на B зажигается. Закрытие slideout (Esc / клик-outside) сбрасывает open-state, кнопка возвращается на active (default-on-active правило снова активно). Принцип переносимый — см. `methodology/design.md::Один экземпляр overlay на N триггеров`.

`TabNotesSlideout` derive'ит `activeTabId` из стора (первый ключ с `true` в `notesPanelOpenTabs`), не получает его prop'ом — это важно, иначе клик при Cmd на не-active вкладке B открыл бы state, но slideout продолжал бы рендериться для предыдущего active A.

### Bottom-anchor к кнопке открытия (в TabItem)
Низ модалки прибит к нижней кромке `[data-tab-notes-open-trigger]` плюс пользовательский сдвиг `notesPanelOffsetY`.

```
top = openButton.getBoundingClientRect().bottom - panelHeight + notesPanelOffsetY
```

Mental model пользователя: «модалка живёт у кнопки, через которую я её открыл». Кнопка теперь живёт в активной вкладке TabSidebar — при vertical resize окна позиция активной строки в общем потоке TabBar'а сохраняется (вкладки шиномонтажно прижаты к верху колонки), значит и низ модалки остаётся стабильным. Раньше anchor был на header InfoPanel-сайдбара справа (нижняя часть flex-1 контейнера) — flip триггера сохранил тот же DOM-based-anchor паттерн, просто `[data-tab-notes-open-trigger]` теперь живёт по другому пути в DOM.

**Фильтр по `data-tab-id` обязателен.** QuerySelector — `[data-tab-notes-open-trigger][data-tab-id="${activeTabId}"]`, а не голый `[data-tab-notes-open-trigger]`. В peek-mode (Cmd зажат, мышь в TabSidebar) кнопки появляются на нескольких вкладках одновременно; без фильтра `document.querySelector` берёт первую попавшуюся в DOM — обычно это вкладка сверху списка, не та на которой реально открыт slideout, и anchor уезжает на чужую строку. Этот фильтр — конкретная реализация принципа «singleton-overlay с N-кандидат-якорями» (см. `methodology/design.md::Один экземпляр overlay на N триггеров`).

Принцип переносимый — см. `methodology/design.md::Геометрия popup — от измерения, не от формулы`.

### Flip: anchor-LEFT, направление слева-направо
Раньше панель открывалась справа-налево, прижимаясь правым краем к левому краю `InfoPanel`-сайдбара (`[data-info-aside]`). После удаления правой колонки anchor переехал на правый край `TabSidebar` (`[data-tabbar-vertical]`), панель открывается **слева-направо**. Handle-mapping зеркально переразложен (см. `methodology/design.md::Slideout-якорь к chip'у` дополнение про flip):
- **правый край** — `'right'` resize ширины (раньше был левый);
- **левый край** — `'left-move'` vertical drag позиции (раньше был правый), физически рядом с триггером в активной вкладке;
- **top/bottom** — height (симметрично, без изменений);
- **corner-tr / corner-br** — height+width на стороне противоположной anchor'у (раньше были `corner-bl`/`corner-br`).

Motion (framer-motion) тоже flip: `initial={{ x: -20 }}` → `animate={{ x: 0 }}` (раньше был `+20 → 0`). При drag'е `dx` теперь positive-grow (раньше был negative — `startW - dx`), потому что anchor сменился с правого на левый.

### notesPanelOffsetY — пользовательский сдвиг от anchor'а
Drag-handle на левом крае модалки (cursor `ns-resize`, edge `'left-move'`). dx игнорируется, dy сдвигает всю модалку по Y без изменения размера. `offsetY = 0` — низ модалки ровно у trigger'а. Отрицательные значения двигают вверх, положительные — вниз.

**Persistence:** `localStorage` (`noted-terminal-notes-panel-offset-y`) + SQLite через IPC `app:setState` с ключом `notesPanelOffsetY`. Hydrate на старте — `app:getState` (рядом с hydrate'ом `notesPanelSize`).

### Drag-preview буфер: store-flush только на mouseup
Все изменения size / offsetY во время drag'а пишутся в local React state `dragPreview` (внутри `TabNotesSlideout`). В Zustand store (`setNotesPanelSize` / `setNotesPanelOffsetY`) флушатся **один раз на mouseup**. Принцип переносимый — см. `methodology/design.md::Drag-state буфер`.

### Header hit-area (исторический контекст)
Раньше триггер был widening header-блоком `«← Open  Заметки вкладки  ✦»` (весь контейнер кликабельный, не только Open-чип) — паттерн `hit-area > visual button` из `methodology/design.md`. После миграции триггера в TabItem header'а больше нет, остаётся одиночная кнопка-иконка. Принцип сохранён в methodology — следующая фича с widening hit-area может его переиспользовать; конкретная история про `data-notes-header-interactive` атрибут на ✦-кнопке (для предотвращения bubbling) больше не актуальна.

### Single source of truth: оба editor'а на одном `tab.notes`
Slideout-editor `TabNotesSlideout` и Cmd-hover preview в `TabPreviewPopover` подписаны на **одно** поле `tab.notes` через reactive Zustand selector. Локальных mirror'ов нет — единственный источник истины это `tab.notes`. Любая правка идёт через `setTabNotes(tabId, content)`. Раньше был ещё inline editor в `InfoPanel` (третий surface), удалён вместе с правой колонкой — но проблема ping-pong'а между двумя CodeMirror-инстансами актуальна и для slideout+preview, см. ниже.

**Шрам:** в InfoPanel один раз mirror возвращался (`useState('') + useEffect(setTabNotes(liveTabNotes))`) — pattern затирал параллельные правки слайдаута во время async-handler'а Generate Description. InfoPanel-editor с тех пор удалён полностью, но принцип «никаких local mirror'ов на reactive store-source» остаётся актуальным для slideout+preview пары. См. `fix-infopanel-tabnotes-mirror.md` (исторический), `fix-codemirror-controlled-editor.md` (актуальный фикс через `userEvent: 'external-sync'`).

**Font / padding — те же поля для всех трёх surface'ов.** `notesEditorFontSize` / `notesEditorPaddingX` / `notesEditorPaddingY` — единый набор. Раньше inline+preview и slide-out читали разные поля (`tabNotes*` vs `notesEditor*`) — один контент рендерился с тремя разными шрифтами; см. `fix-notes-font-fragmentation.md`.

**Line numbers — on в slideout и Cmd-hover preview.** `showLineNumbers={true}` (дефолт `@gt-editor/markdown-editor`) во всех editor-инстансах заметки: slideout + probe-editor для measure + main popover preview. Раньше явно стоял `false` чтобы не отвлекать на коротких заметках — но при росте заметок и появлении `^^` свёрток номера дают навигацию (например, чтобы сослаться на строку из чата). Свёртка `^^` прячет номера под фолдом автоматически — это поведение `createLineNumbersWithVirtual` (использует `foldedRanges`), не нужно отдельных правок.

Без правильной обработки концепт «один store-source, два editor'а» вызывает ping-pong: dispatch в одном editor → react reactive → другой editor видит новый prop → его внутренний replaceAll dispatch → его CodeMirror updateListener вызывает onChange echo → ещё запись в store → бесконечный цикл, кончающийся `Position N is out of range`. См. `fix-codemirror-controlled-editor.md` про root cause и фикс через `userEvent: 'external-sync'` annotation.

Принцип переносимый — см. `methodology/design.md::Controlled editor: пометь свои dispatch'и`.

### AI Paste: onGenerateTitle через Gemini Flash
`MarkdownEditor` принимает callback `onGenerateTitle(text): Promise<string>`. При AI Paste (`Cmd+/` → `📋 AI Paste` → `Cmd+V`) editor вставляет `^^ ⏳` placeholder, асинхронно вызывает callback, потом заменяет `⏳` на returned title.

В custom-terminal callback живёт в `src/renderer/utils/generateAITitle.ts` и подключён в TabNotesSlideout (InfoPanel inline editor удалён вместе с правой колонкой). Использует Gemini API через `process.env.GEMINI_API_KEY` со списком fallback-моделей:

```
gemini-2.0-flash-lite → gemini-2.0-flash-exp → gemini-1.5-flash-latest → gemini-2.0-flash
```

Каждая следующая модель пробуется только на quota error (`429 Resource exhausted`). На non-quota error (400, network) — цепочка останавливается, чтобы не спамить ключ.

**Char-count `[N]` суффикс — только в fallback.** Если AI вернул title — `[N]` **не** добавляется, title несёт смысл сам. Если все модели в quota → fallback `paste text [N]` с char-count'ом (чтобы юзер хотя бы видел размер вставки).

ProjectHome MarkdownEditor — `readOnly` preview, AI Paste не нужен, callback не передаётся.

### Что пробовали и почему не сработало (graveyard)
- **`ro.observe(document.body)` для anchor measure.** Модалка рендерится в Portal к `document.body`. Любое её движение (drag, resize) — body mutation — ResizeObserver re-fire — `setAnchorBottomY(...)` — re-render — drag handler читает свежий anchorRect → новый top → перерисовка → ещё mutation. Feedback loop, видимый симптом — дёрганый drag. Лекарство: наблюдать только саму кнопку Open + `window.resize`. Body не нужен — при ресайзе окна сама Open кнопка меняет позицию, ResizeObserver на ней это ловит.
- **Прямая запись в store на каждый mousemove.** `setNotesPanelOffsetY(d.startOffsetY + dy)` внутри `onMove` → setter пишет в localStorage + IPC `app:setState` → SQLite. 60 sync writes/sec. Combined с body-observer'ом выше — двойной удар. Решение: live state в local React, persist на mouseup.


