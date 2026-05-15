# Feature: Notes Management

## Intro
Система ведения заметок проекта, интегрированная непосредственно в рабочий процесс терминала. Позволяет быстро фиксировать мысли в боковой панели или разворачивать полноэкранный Markdown-редактор для глубокой работы.

## User Flow
1. **Быстрая фиксация:** Пользователь вводит текст в поле "Заметки проекта" на боковой панели (вкладка Info). Сохранение происходит автоматически при потере фокуса (Blur) или нажатии `Cmd+Enter`.
2. **Развертывание редактора:**
   - Пользователь нажимает иконку "Maximize" в заголовке заметок или нажимает `Cmd+E`.
   - Открывается "floating sheet" с полноценным Markdown-редактором.
3. **Редактирование и сохранение:**
   - **Autofocus:** При открытии курсор автоматически устанавливается в редактор, позволяя сразу начать печатать. Реализовано через `onEditorView` callback из `MarkdownEditor`.
   - Пользователь пишет текст с поддержкой Markdown.
   - Изменения сохраняются автоматически при закрытии редактора (`Esc` или `Cmd+E`) или вручную через `Cmd+S`.
   - При сохранении состояние синхронизируется между всеми компонентами UI (боковая панель мгновенно обновляется).

## 2. Behavior Specs
- **Project Binding:** Заметки привязаны к `projectId`. При переключении проектов редактор автоматически сохраняет изменения и загружает контент нового проекта.
- **Full-screen Mode:** Переключается через `Cmd+E`. Использует `z-index: 50` для наложения поверх терминала.
- **Auto-save:** Сохранение происходит при закрытии редактора, переключении проекта или нажатии `Cmd+S`.
- **Improved Scroll:** Редактор использует `min-h-0` в flex-контейнере и `overflow-x: hidden` для CodeMirror, обеспечивая корректный вертикальный скролл без горизонтального дребезга.

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

### Что пробовали и почему не сработало (graveyard)
- **`ro.observe(document.body)` для anchor measure.** Модалка рендерится в Portal к `document.body`. Любое её движение (drag, resize) — body mutation — ResizeObserver re-fire — `setAnchorBottomY(...)` — re-render — drag handler читает свежий anchorRect → новый top → перерисовка → ещё mutation. Feedback loop, видимый симптом — дёрганый drag. Лекарство: наблюдать только саму кнопку Open + `window.resize`. Body не нужен — при ресайзе окна сама Open кнопка меняет позицию, ResizeObserver на ней это ловит.
- **Прямая запись в store на каждый mousemove.** `setNotesPanelOffsetY(d.startOffsetY + dy)` внутри `onMove` → setter пишет в localStorage + IPC `app:setState` → SQLite. 60 sync writes/sec. Combined с body-observer'ом выше — двойной удар. Решение: live state в local React, persist на mouseup.


