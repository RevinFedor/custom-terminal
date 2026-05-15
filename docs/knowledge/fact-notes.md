# Feature: Tab Notes (per-tab)

## Intro
Система заметок, привязанных к **каждой вкладке** (`tab.notes`), а не к проекту целиком. Project-level fullscreen modal (`NotesEditorModal.tsx`) удалён в пользу per-tab slideout — глобальные project notes больше не существуют как сущность в UI. У каждой вкладки своя независимая заметка.

## User Flow
1. **Inline preview** в нижней части `InfoPanel` — Markdown editor c content из `tab.notes`. Кликнул, печатаешь, сохранение автоматическое (через store update).
2. **Slideout-режим** — нажимаешь header «← Open Заметки вкладки» (или `Cmd+E`), открывается ресайзаб­ельная панель слева от sidebar'а с тем же контентом. Закрывается клик-outside, Esc или повторный `Cmd+E`.
3. **AI Paste** (`Cmd+/` → `📋 AI Paste` → `Cmd+V`):
   - В editor вставляется `^^ ⏳` placeholder и сворачивается.
   - Параллельно `onGenerateTitle(text)` уходит в Gemini (см. секцию AI Paste ниже).
   - Когда title возвращается — `⏳` заменяется на него.

## Behavior
- **Per-tab persistence:** `tab.notes` хранится в `useWorkspaceStore.openProjects[].tabs[].notes`. Save через `setTabNotes(tabId, content)`. Сохраняется в SQLite через стандартный tab-persist pipeline.
- **Per-tab open state:** `useUIStore.notesPanelOpenTabs: Record<tabId, boolean>` — каждая вкладка имеет независимое состояние «открыт slideout или нет».
- **Cmd+E:** toggle slideout текущей вкладки. Раньше Cmd+E открывал fullscreen modal — теперь только slideout.
- **Cmd+B:** toggle file-explorer sidebar (Cmd+E больше за это не отвечает).
- **Improved Scroll:** редактор использует `min-h-0` в flex-контейнере и `overflow-x: hidden` для CodeMirror.

## Tab Notes Slideout (per-tab панель)

Отдельная сущность от project notes выше: контент хранится в `tab.notes` (per-tab), не в `project.notes`. Общий MarkdownEditor, разные модели данных и разные триггеры открытия. Открывается кнопкой `[data-tab-notes-open-trigger]` («← Open») в нижней части `InfoPanel`. Per-tab open state — `useUIStore.notesPanelOpenTabs: Record<tabId, boolean>`.

### Bottom-anchor к кнопке Open
Низ модалки прибит к нижней кромке кнопки Open плюс пользовательский смещение `notesPanelOffsetY`.

```
top = openButton.getBoundingClientRect().bottom - panelHeight + notesPanelOffsetY
```

Mental model пользователя: «модалка живёт у кнопки, через которую я её открыл». Симптом нарушения — *«при vertical resize окна расстояние от низа модалки до кнопки Open меняется»*. Anchor-from-DOM держит связь стабильной независимо от того, как ресайзится окно (Open находится в нижней части flex-1 InfoPanel'и — при уменьшении высоты окна сверху InfoPanel сжимается сверху, кнопка остаётся на месте, низ модалки тоже).

Принцип переносимый — см. `methodology/design.md::Геометрия popup — от измерения, не от формулы`.

### notesPanelOffsetY — пользовательский сдвиг от anchor'а
Drag-handle на правом крае модалки (cursor `ns-resize`). dx игнорируется, dy сдвигает всю модалку по Y без изменения размера. `offsetY = 0` — низ модалки ровно у Open. Отрицательные значения двигают вверх, положительные — вниз.

**Persistence:** `localStorage` (`noted-terminal-notes-panel-offset-y`) + SQLite через IPC `app:setState` с ключом `notesPanelOffsetY`. Hydrate на старте — `app:getState` (рядом с hydrate'ом `notesPanelSize`).

### Drag-preview буфер: store-flush только на mouseup
Все изменения size / offsetY во время drag'а пишутся в local React state `dragPreview` (внутри `TabNotesSlideout`). В Zustand store (`setNotesPanelSize` / `setNotesPanelOffsetY`) флушатся **один раз на mouseup**. Принцип переносимый — см. `methodology/design.md::Drag-state буфер`.

### Header hit-area
Триггер открытия — **весь** header-блок `«← Open  Заметки вкладки  ✦»`, не только кнопка. Атрибут `data-tab-notes-open-trigger` мигрировал с `<button>` Open на родительский `<div>`-header. Open-чип внутри — теперь `<span pointer-events-none>`, его цвет управляется `notesHeaderHover` state'ом контейнера. ✦-кнопка (generate description) помечена `data-notes-header-interactive` + `e.stopPropagation()` на её onClick — иначе клик по ней через bubbling попадал бы в header-onClick и открывал/закрывал slideout. `TabNotesSlideout`-ный outside-click-guard ищет `target.closest('[data-tab-notes-open-trigger]')` — после миграции атрибута на `<div>` работает без изменений.

Принцип переносимый — см. `methodology/design.md::Hit-area > visual button`.

### Single source of truth: оба editor'а на одном `tab.notes`
Inline editor в `InfoPanel` и slideout-editor `TabNotesSlideout` подписаны на **одно** поле `tab.notes` через reactive Zustand selector. Локальных mirror'ов нет — единственный источник истины это `tab.notes`. Любая правка идёт через `setTabNotes(tabId, content)`.

Без правильной обработки это вызывает ping-pong: dispatch в одном editor → react reactive → другой editor видит новый prop → его внутренний replaceAll dispatch → его CodeMirror updateListener вызывает onChange echo → ещё запись в store → бесконечный цикл, кончающийся `Position N is out of range`. См. `fix-codemirror-controlled-editor.md` про root cause и фикс через `userEvent: 'external-sync'` annotation.

Принцип переносимый — см. `methodology/design.md::Controlled editor: пометь свои dispatch'и`.

### AI Paste: onGenerateTitle через Gemini Flash
`MarkdownEditor` принимает callback `onGenerateTitle(text): Promise<string>`. При AI Paste (`Cmd+/` → `📋 AI Paste` → `Cmd+V`) editor вставляет `^^ ⏳` placeholder, асинхронно вызывает callback, потом заменяет `⏳` на returned title.

В custom-terminal callback живёт в `src/renderer/utils/generateAITitle.ts` и подключён в InfoPanel inline editor + TabNotesSlideout. Использует Gemini API через `process.env.GEMINI_API_KEY` со списком fallback-моделей:

```
gemini-2.0-flash-lite → gemini-2.0-flash-exp → gemini-1.5-flash-latest → gemini-2.0-flash
```

Каждая следующая модель пробуется только на quota error (`429 Resource exhausted`). На non-quota error (400, network) — цепочка останавливается, чтобы не спамить ключ.

**Char-count `[N]` суффикс — только в fallback.** Если AI вернул title — `[N]` **не** добавляется, title несёт смысл сам. Если все модели в quota → fallback `paste text [N]` с char-count'ом (чтобы юзер хотя бы видел размер вставки).

ProjectHome MarkdownEditor — `readOnly` preview, AI Paste не нужен, callback не передаётся.

### Что пробовали и почему не сработало (graveyard)
- **`ro.observe(document.body)` для anchor measure.** Модалка рендерится в Portal к `document.body`. Любое её движение (drag, resize) — body mutation — ResizeObserver re-fire — `setAnchorBottomY(...)` — re-render — drag handler читает свежий anchorRect → новый top → перерисовка → ещё mutation. Feedback loop, видимый симптом — дёрганый drag. Лекарство: наблюдать только саму кнопку Open + `window.resize`. Body не нужен — при ресайзе окна сама Open кнопка меняет позицию, ResizeObserver на ней это ловит.
- **Прямая запись в store на каждый mousemove.** `setNotesPanelOffsetY(d.startOffsetY + dy)` внутри `onMove` → setter пишет в localStorage + IPC `app:setState` → SQLite. 60 sync writes/sec. Combined с body-observer'ом выше — двойной удар. Решение: live state в local React, persist на mouseup.


