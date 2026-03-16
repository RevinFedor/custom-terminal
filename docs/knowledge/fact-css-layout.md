# UI CSS Layout

---

## 3. Font Loading Race Condition
**Файл-источник:** `fix-font-loading-race.md`

### Problem
Terminal text appears jittery, characters overlap, or cursor position is wrong. The terminal grid seems "broken".

### Symptoms
- Characters overlap or have gaps between them
- Cursor doesn't align with text
- `Char width: 8.4287109375` (fractional width indicates measurement issue)
- DevTools shows wrong font:
  ```
  Requested font: "JetBrainsMono NF", monospace
  Computed font: -apple-system, sans-serif  // WRONG!
  ```

### Root Cause
Electron/xterm.js initializes faster than the browser loads custom fonts. Sequence:
1. xterm.js creates terminal
2. xterm.js measures character width using current font
3. Font loads (too late!)
4. xterm.js already has wrong metrics, never recalculates

### Solution
1. **Bundle Font Locally**: Assets/fonts/JetBrainsMonoNerdFont-Regular.ttf.
2. **CSS font-display: block**: Blocks rendering until font loads.
3. **Wait for Font (renderer.js)**:
```javascript
async function init() {
  await document.fonts.ready;
  const fontLoaded = document.fonts.check("14px 'JetBrainsMono NF'");
  if (!fontLoaded) { await document.fonts.load("14px 'JetBrainsMono NF'"); }
  createTab();
}
```

---

## 4. Tabs Display Conflict (Specificity & !important)
**Файл-источник:** `fix-tabs-display-conflict.md`

### Problem
When switching between open projects (Level 1 tabs), tabs from ALL projects (Level 2 tabs) remain visible instead of showing only the active project's tabs.

### Root Cause
**CSS Specificity Conflict**: The `.active` class rule with `!important` overrides inline styles.
```css
.active { display: flex !important; }
```
When `renderTabsForProject()` tries to hide tabs via `style.display = 'none'`, it is IGNORED because of `!important`.

### Solution
Remove the `.active` class from **both** the tab element and wrapper when hiding.

---

## 5. UI Flickering (Hover vs Inline Styles)
**Файл-источник:** `fix-tab-hover-conflict.md`

### Проблема
При наведении курсора на активный таб или переключении между табами, фон (background) "дергался" или исчезал на мгновение.

### Причина
Конфликт между `hover:` классами Tailwind и Inline Styles.

### Решение
Полный переход на управление состоянием через React `useState`:
1. Введен флаг `isHovered`.
2. Создана функция `getBgColor()`, вычисляющая цвет: `isActive` > `isHovered` > `default`.
3. Все стили применяются **только** через Inline Styles.

---

## 15. MarkdownEditor Scroll: `height: 100%` не работает в глубокой flex-цепочке

### Проблема
Скроллбар в `@anthropic/markdown-editor` (CodeMirror) не появлялся в tab notes (InfoPanel) и project notes (NotesEditorModal), хотя в FilePreview всё работало корректно.

### Корневая причина
CSS пакета задаёт `.markdown-editor { height: 100% }`. В FilePreview цепочка короткая: `position: fixed` portal → `flex: 1` → `height: 100%` — работает. В InfoPanel цепочка **7 уровней flex-вложенности** — `height: 100%` резолвится в `auto`, редактор расширяется до размера контента, `.cm-scroller` не переполняется → скроллбар не появляется.

### Почему нельзя дедуцировать из кода
По CSS-спецификации `height: 100%` на child flex-item ДОЛЖЕН резолвиться. На практике в Electron/Chromium при глубокой flex-вложенности это ломается. Код выглядит корректным, все `min-h-0` и `flex-1` расставлены правильно.

### Решение: `position: absolute; inset: 0`
```tsx
// ✅ Правильно (InfoPanel.tsx, NotesEditorModal.tsx)
<div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
  <div style={{ position: 'absolute', inset: 0 }}>
    <MarkdownEditor ... />
  </div>
</div>

// ❌ Ловушка — height: 100% внутри пакета не резолвится
<div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
  <MarkdownEditor ... />
</div>
```

### Правило
Везде, где `@anthropic/markdown-editor` встраивается в глубокую flex-цепочку (3+ уровней), wrapper ОБЯЗАН использовать `position: absolute; inset: 0`. Прямой `flex: 1` без absolute — ловушка.

### Dual-Zone Layout (InfoPanel)
InfoPanel разделена на два контейнера:
1.  **Верхняя зона:** `overflow-y-auto min-h-0 shrink`. Сжимается и скроллится.
2.  **Нижняя зона:** `flex-1 min-h-0` + `position: relative` → `absolute inset-0` → MarkdownEditor.

---

## Layout Clipping / Nested Width Conflict

## Проблема
Правая панель инструментов (`NotesPanel`) обрезалась (clipping) на ~25 пикселей с правой стороны при включении Timeline. Контент внутри панели выглядел смещённым или неполным.

## Причина
Конфликт между фиксированной шириной родителя и ребёнка:
1.  **Родитель** (правая колонка в `Workspace.tsx`) имел ширину `notesPanelWidth`.
2.  **Внутренняя структура**: `Timeline` (32px) + `Resizer` (1px) + контейнер с панелями.
3.  **Ребёнок** (`NotesPanel.tsx`) ТАКЖЕ использовал `style={{ width: notesPanelWidth }}`.

Когда `Timeline` вклинивался в поток, он забирал 32px. Ребёнок, не зная об этом, пытался занять полную ширину `notesPanelWidth`, вылезая за границы родительского контейнера. Поскольку на родителе стоял `overflow: hidden`, лишняя часть панели просто обрезалась.

## Решение
Удаление дублирующего стейта ширины из дочерних компонентов.
- В `NotesPanel.tsx` удалено использование `notesPanelWidth`.
- Добавлены CSS-классы `w-full h-full`, позволяющие панели гибко занимать всё доступное пространство, которое ей выделил родитель (с учётом уже занятого места под Timeline).

### Timeline & Resizer Event Isolation
При расположении кастомного скроллбара Timeline рядом с компонентом `Resizer` возник конфликт событий мыши.
- **Симптом:** Попытка проскроллить Timeline кликом по скроллбару приводила к активации ресайза боковой панели.
- **Решение:** Скроллбар перенесен внутрь 32px-зоны Timeline и снабжен `pointer-events: none`. Это позволяет визуально отображать позицию скролла встык с ресайзером, но исключает перехват кликов, предназначенных для изменения размера панелей.

## Урок для проекта
Вложенные компоненты должны стремиться к использованию относительных размеров (`w-full`, `flex-1`). Использование глобального стейта ширины (`notesPanelWidth`) допустимо только для верхнеуровневого контейнера или портальных элементов (Tooltip), которым нужно знать точные координаты.

---

## 14. Sequential UI Disappearance (The Laggy Sidebar)

### Проблема
При переключении на Home сайдбар исчезал не мгновенно, а «поэтапно» (сначала таймлайн, потом кнопки).

### Причины
1.  **Layout Shift:** `Timeline` (шириной 32px) полностью удалялся из DOM. Это вызывало пересчет ширины всей правой колонки.
2.  **CSS Transitions:** Наличие `transition: all 0.3s` на кнопках и контейнерах заставляло элементы плавно менять прозрачность/цвет, что при массовом скрытии выглядело как задержка.

### Решение
1.  **Stay Mounted:** `Timeline` остается смонтированным всегда (сохраняя свои 32px), но скрывает содержимое через проп `isVisible`. Это убирает скачки верстки.
2. **Zero-Delay Policy:** Удаление `transition` у функциональных элементов (кнопки Claude/Gemini, Resizer), которые должны реагировать на смену глобального состояния мгновенно.
3. **Instant Portals:** Скрытие порталов (подсказок) должно быть принудительным и мгновенным при потере видимости родителя. Используйте `visibility: inherit`, чтобы дочерние элементы с явным `visible` не «пробивали» скрытого родителя.

---

## 7. Toast Positioning Conflict (macOS Traffic Lights)
**Файл-источник:** Сессия 2026-01-21

### Проблема
Уведомления (Toasts) перекрывались системными кнопками управления окном macOS (закрыть/свернуть) при использовании стандартных Tailwind классов `top-4 right-4`.

### Решение
Принудительное смещение вниз и использование **Inline Styles** для предотвращения конфликтов с JIT-компилятором:
```javascript
style={{
  position: 'fixed',
  top: '52px', // Смещение ниже системных кнопок
  right: '16px',
  zIndex: 9999,
  pointerEvents: 'none'
}}
```
Файл: `src/renderer/components/UI/Toast.tsx`.

---

## 16. Scrollable Absolute Overlays (Timeline Rewind Pulsations)

### Проблема
При откате в Timeline (Rewind) оверлеи анимаций (жёлтая пульсация выбранного диапазона, фиолетовая пульсация активной точки) должны были двигаться вместе с контентом при скролле. Вместо этого они "залипали" в viewport — оставались на месте, даже когда пользователь скроллил Timeline вверх/вниз.

### Корневая причина
Оверлеи использовали `position: absolute` напрямую внутри `overflow-y: auto` контейнера. По CSS-спецификации:
- `position: absolute` внутри скролл-контейнера привязывается к viewport (экран), а не к содержимому.
- Даже если родитель имеет `overflow: auto`, абсолютно позиционированный child останется прикреплен к экранным координатам.

### Решение: Relative Wrapper
Для привязки оверлеев к контенту (а не к экрану) требуется промежуточный контейнер с `position: relative`:

```tsx
// Скролл-контейнер с entries
<div style={{ overflow: 'auto', height: '100%' }}>
  {/* Relative wrapper охватывает весь скроллируемый контент */}
  <div style={{ position: 'relative' }}>
    {/* Entries (div'ы) */}
    {entries.map(entry => (
      <div key={entry.id} {...props}>
        {/* Оверлей — теперь привязан к relative wrapper */}
        <span style={{
          position: 'absolute',
          top: 0,
          left: 0,
          className: 'animate-pulse' // пульсация
        }} />
        {entry.content}
      </div>
    ))}
  </div>
</div>
```

### Invisible Intent
Relative wrapper **не изменяет размеры** — он просто служит якорем для абсолютного позиционирования. Размеры и overflow поведение контролируются скролл-контейнером и flex-слоем entries.

### Практическое применение
- **Timeline.tsx:** Все анимационные span'ы (range pulse, entry pulse) теперь находятся внутри relative wrapper.
- **Rewind Animations:** Желтая (`bg-yellow-400`) и фиолетовая (`bg-purple-400`) пульсации корректно движутся при скролле.
- **Fallback:** Если wrapper не нужен (оверлей не должен скроллиться), используйте `position: fixed` для привязки к экрану.
