# UI/UX Stability & Interface Patterns\n
\n---\n## File: ui-ux-stability.md\n
# Сборник решений: Стабильность и визуальный комфорт UI

Этот файл объединяет все решения, связанные с предотвращением дёргания (jitter), мерцания (flickering) и проблем с рендерингом терминала и вкладок.

---

## 18. Browser Tab Navigation (Contextual UX)

### Проблема: Разрыв контекста при клике по ссылке
В обычных терминалах Cmd+клик открывает ссылку в системном браузере ОС. Однако внутри «Браузерной вкладки» (BrowserTab) ожидаемое поведение иное: если пользователь запустил dev-сервер в этой же вкладке, он хочет видеть результат рядом. Открытие внешней ссылки разрушало этот контекст.

### Решение: Перехват и внутренняя навигация
Реализован проброс callback-а `onLinkClick` в компонент Terminal. 
- **Motivation:** Мы разделяем «внешние» ссылки (открываются в ОС) и «контекстные» (в браузере, открываются внутри). Это превращает вкладку в полноценную IDE-подобную среду для веб-разработки.
- **Invisible Intent (Refresh):** Кнопка Refresh в браузере принудительно вызывает `setBrowserActiveView(tabId, 'browser')`. Это решение основано на паттерне «ожидаемого результата»: после ручного обновления страницы пользователь в 100% случаев хочет видеть UI, а не терминал, где он только что перезапустил сервер.

---

## 1. Ink/TUI Render Tearing (Input Jitter)
**Файл-источник:** `fix-ink-tui-render-tearing.md`

### Problem
When running CLI tools built with Ink framework (e.g., Claude Code CLI, Gemini CLI), the input bar at the bottom of the terminal jitters/flickers during typing or when the tool is "thinking".

### Symptoms
- Input field visually "jumps" or "shakes"
- Text briefly disappears and reappears
- Cursor position seems unstable
- Problem is specific to Ink-based CLIs, not regular commands

### Root Cause
Ink framework updates the terminal UI at very high frequency (~100 writes/sec, 9ms gaps between updates). Each update sends a sequence:
1. `ESC[2K` - Erase line
2. `ESC[1A` - Move cursor up
3. Write new content

When xterm.js processes these as separate frames:
- Frame 1: Empty line (after erase)
- Frame 2: New content (after write)

The human eye perceives the empty frame as a "flash" or "jitter".

### Solution
Implement a **Write Buffer** that batches PTY output before sending to xterm.

#### Key Code (renderer.js)
```javascript
const FLUSH_DELAY = 10; // ms - aligns with 60fps
const MAX_BUFFER_SIZE = 4096; // safety valve

ipcRenderer.on('terminal:data', (event, tabId, data) => {
  const tabData = tabs.get(tabId);
  tabData.writeBuffer += data;

  if (!tabData.pendingWrite) {
    tabData.pendingWrite = setTimeout(() => {
      tabData.terminal.write(tabData.writeBuffer);
      tabData.writeBuffer = '';
      tabData.pendingWrite = null;
    }, FLUSH_DELAY);
  }

  // Flush immediately if buffer too large
  if (tabData.writeBuffer.length > MAX_BUFFER_SIZE) {
    clearTimeout(tabData.pendingWrite);
    tabData.terminal.write(tabData.writeBuffer);
    tabData.writeBuffer = '';
    tabData.pendingWrite = null;
  }
});
```

#### Why FLUSH_DELAY = 10ms?
- 60fps = 16.67ms per frame
- 10ms ensures we batch multiple Ink updates into single frame
- Lower values (5ms) may still cause tearing
- Higher values (20ms+) may feel laggy

---

## 2. Terminal Jitter & Project Switching
**Файл-источник:** `fix-terminal-jitter.md`

### Проблема
При создании нового терминала или переключении между проектами наблюдалось визуальное "дёргание" интерфейса. Это происходило по двум причинам:
1.  **Race Condition при рендеринге:** Терминал `xterm.js` сначала рендерится с дефолтными размерами, и только через короткий промежуток времени (setTimeout 100ms) вызывается `fitAddon.fit()`, что вызывает резкое изменение размера.
2.  **Unmount/Mount при смене проекта:** Раньше `TerminalArea` рендерил только табы активного проекта. При смене проекта старые терминалы уничтожались, а новые создавались с нуля, что вызывало лаги и потерю состояния WebGL.

### Решение

#### 1. Скрытие до готовности (Opacity Strategy)
В компоненте `Terminal.tsx` введены два механизма:
-   `isVisible` state: Начально установлен в `false`.
-   `opacity: isVisible ? 1 : 0` с коротким `transition`.
Терминал становится видимым только ПОСЛЕ того, как выполнится первый `safeFit()`. Это делает появление терминала плавным.

#### 2. Персистентные слои (Persistent Layers)
В приложении используется стратегия «Смонтирован навсегда» для всех тяжелых компонентов:
-   **Terminal:** Рендерим терминалы **всех** открытых проектов одновременно. Используем `visibility: active ? 'inherit' : 'hidden'`.
-   **Workspace:** Компонент `Workspace` в `App.tsx` остается смонтированным при переходе на Dashboard. Скрытие управляется через `visibility`.
-   **Почему:** Любой unmount `xterm.js` приводит к потере WebGL-контекста и визуального буфера. Пересоздание занимает 1-3с, что неприемлемо для быстрого переключения.
-   **Важно:** Используем именно `visibility: hidden`, а не `display: none`, так как `display: none` схлопывает контейнер в 0x0, что приводит к потере текстур в `xterm.js`. См. также раздел 11.1 про ловушку `visible`.

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

## 6. Перехват системного Zoom (Cmd+/-)
**Файл-источник:** `fix-zoom-override.md`

### Проблема
По умолчанию Electron масштабирует всё окно (Zoom), что ломит верстку.

### Решение
В `App.tsx` добавлен перехват `keydown` для `Cmd+Plus` и `Cmd+Minus`, который вызывает `incrementTerminalFontSize()` / `decrementTerminalFontSize()` вместо системного зума.

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

## 8. Event Loop Starvation (execSync Locks)
**Файл-источник:** Сессия 2026-01-21 (Performance Fix)

### Проблема
Интерфейс "замирал" (фризил) на 1-3 секунды при закрытии вкладок или переключении проектов.

### Причина
Использование `execSync` в Main процессе для проверки дочерних процессов терминала (`pgrep`, `ps`, `lsof`). `execSync` — это блокирующая операция. Пока системная команда выполняется (или ждет таймаута в 1000мс), весь Main процесс Electron стоит на месте, не обрабатывая IPC-сообщения от рендерера (клики, ввод).

### Решение
Полная замена всех системных вызовов на асинхронные с использованием промисов:
```javascript
const execAsync = (cmd, timeout = 1000) => {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    exec(cmd, { encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
};
```
Это позволяет Main процессу оставаться свободным и отзывчивым даже во время выполнения тяжелых системных запросов.

---

## 9. Отказ от WebGL в пользу Canvas
**Файл-источник:** Сессия 2026-01-21 (GPU Optimization)

### Проблема
Первое переключение на "лениво" инициализированный терминал вызывало лаг в 2-3 секунды.

### Технические причины
1. **Shader Compilation (Warm-up):** При создании `WebglAddon` GPU должен скомпилировать шейдеры и создать атлас текстур для шрифта. Это тяжелая операция, блокирующая поток на время "прогрева".
2. **WebGL Context Limit:** Chromium имеет жесткий лимит (обычно 16) на количество активных WebGL контекстов. При открытии 17-го таба один из предыдущих контекстов уничтожается, вызывая краш или пустой экран терминала.

### Как делают "большие" (VS Code, Hyper, Warp)
- **VS Code** использует WebGL, но с очень сложной системой управления контекстами. Они не держат WebGL активным во всех табах — динамически включают/выключают его для активного таба, а для фоновых используют DOM/Canvas рендер.
- **Hyper/Warp** — кастомные форки xterm.js с собственной оптимизацией.
- Реализовывать такую логику (`oldTab.loadAddon(canvas)`, `newTab.loadAddon(webgl)`) самому — сложно и не оправдано для нашего use case.

### Почему WebGL не нужен для работы с AI
- **Скорость вывода LLM:** Gemini и Claude выдают текст со скоростью чтения (~100 токенов/сек). Для Canvas это смешная нагрузка.
- **Когда WebGL реально нужен:** Компиляция C++/Rust (`make -j12`), где строки бегут быстрее чем глаз видит. LLM так не делают.
- **Качество текста:** На некоторых экранах (особенно не Retina) WebGL может "мылить" шрифты из-за особенностей sub-pixel antialiasing.

### Решение
Полный отказ от `WebglAddon` в пользу стандартного **Canvas рендерера**.

### Результат
- Мгновенное переключение табов (нет warm-up)
- Отсутствие лимита на количество открытых терминалов
- Стабильная отрисовка шрифтов
- Упрощение кодовой базы (нет логики управления WebGL контекстами)

---

## 10. Font Rendering & Smoothing (iTerm Style)
**Файл-источник:** Сессия 2026-01-22 (Visual Polish)

### Проблема
Шрифт в терминале выглядел слишком жирным, "рыхлым" или менее четким по сравнению с нативными терминалами (iTerm2) или VS Code, особенно при использовании ярких цветов.

### Решение

#### 1. CSS Antialiasing
Для достижения "эффекта тонкого шрифта" в macOS необходимо принудительно включить сглаживание на уровне CSS для всех слоев терминала (включая Canvas):
```css
/* src/renderer/styles/globals.css */
.terminal-instance,
.terminal-instance .xterm-screen,
.terminal-instance .xterm-screen canvas {
  -webkit-font-smoothing: antialiased !important;
  -moz-osx-font-smoothing: grayscale !important;
}
```

#### 2. xterm.js Bold/Bright Logic
По умолчанию xterm.js может отрисовывать "яркие" цвета (bright colors) жирным шрифтом, что создает визуальный шум. Для чистоты интерфейса это поведение отключено:
```javascript
// src/renderer/components/Workspace/Terminal.tsx
const term = new XTerminal({
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  drawBoldTextInBrightColors: false, // Запрещает ярким цветам быть жирными по умолчанию
  // ...
});
```

### Результат
Текст стал более четким, тонким и профессиональным, сохраняя читаемость даже при мелком кегле.

---

## 11. Background Terminal Throttling (currentView)
**Файл-источник:** Сессия 2026-02-08

### Проблема
Терминалы в фоновых вкладках или при переключении на Dashboard/Notes продолжали считаться "активными" в логике `TerminalArea.tsx`, что могло приводить к лишним перерисовкам или конфликтам фокуса.

### Решение
Введена зависимость состояния `isActive` таба от глобального состояния `currentView` (из `useUIStore`).

```javascript
// src/renderer/components/Workspace/TerminalArea.tsx
const currentView = useUIStore((s) => s.currentView);

// ... внутри useMemo ...
const isActive = isActiveProject && workspace.activeTabId === tab.id && currentView === 'terminal';
```

---

## 11.1. Stale Canvas After View Switch (fit.fit() No-Op Trap)

### Ловушка xterm.js
`FitAddon.fit()` внутри проверяет `if (this.cols === newCols && this.rows === newRows) return` — если размеры контейнера не менялись, метод **ничего не делает**: ни `_renderService.clear()`, ни repaint. Это не баг xterm.js, а оптимизация, но она ломает рендеринг после `visibility:hidden`.

### Почему ломается
Пока терминал скрыт (Home view), данные из PTY продолжают писаться в буфер xterm.js. Canvas renderer накапливает stale state. При возврате `safeFit()` вызывает `fit.fit()`, но размеры те же → no-op → canvas не обновляется → Ink CLI (Gemini/Claude) рисует мусор (прогресс-бары переносятся, строки дублируются).

### Решение
В `Terminal.tsx`, useEffect активации (`[effectiveActive, isActiveProject, tabId]`), после `safeFit()`:
```javascript
// Форсированная очистка и перерисовка
if (xtermInstance.current) {
  const term = xtermInstance.current;
  const core = (term as any)._core;
  if (core?._renderService) {
    core._renderService.clear(); // Помечает все строки dirty
  }
  term.refresh(0, term.rows - 1); // Форсирует repaint canvas
}
```

### ⚠️ ЛОВУШКА: Visibility Visible Override
Если дочерний элемент имеет стиль `visibility: visible`, он **перекрывает** `visibility: hidden` родителя.
- **Проблема:** При переходе на Dashboard весь Workspace скрывался через `hidden`, но терминалы (имея `visible`) продолжали «просвечивать» поверх главного экрана.
- **Решение:** Использовать `visibility: inherit` (или `visibility: visible` только при условии видимости родителя). Это заставляет детей подчиняться состоянию верхнего слоя.

### ⚠️ ОПАСНО: Resize Cycle (Trap)
Попытка форсировать пересчет через `term.resize(cols-1)` -> `term.resize(cols)` является **ловушкой**.
- **Эффект:** Это заставляет xterm.js пересчитать буфер, но так как это происходит внутри приложения, PTY не получает `SIGWINCH` (или получает их слишком быстро).
- **Результат:** В Ink-based CLI (Gemini) это намертво ломает позицию курсора. Курсор остается на строке ввода, но Ink продолжает считать, что он в другом месте, что приводит к "фантомным" строкам при каждом обновлении TUI.
- **Вывод:** Используйте только `_renderService.clear()` и `refresh()`. Это не трогает логические размеры терминала и курсор, но принудительно обновляет визуальный слой Canvas.

---

## 12. Фокусировка активной области (onMouseDown)

### Проблема
При клике на терминал фокус приложения (стейт `activeArea`) не всегда переключался на `'workspace'`. Из-за этого горячие клавиши (например, `Cmd+T`) продолжали интерпретироваться в контексте проектов (создавался новый проект вместо нового таба).

### Причина
Эмулятор терминала `xterm.js` использует Canvas для отрисовки. Он активно перехватывает события мыши для обработки выделения и кликов. Стандартное React-событие `onClick` на родительском контейнере могло не срабатывать, так как терминал мог останавливать всплытие (propagation) или поглощать событие раньше.

### Решение
Переход на использование `onMouseDown` на родительском контейнере `Workspace`.
- Событие `onMouseDown` срабатывает раньше `onClick` и `mouseup`.
- Оно гарантированно фиксирует намерение пользователя взаимодействовать с областью терминала до того, как эмулятор начнет свои внутренние расчеты.

### Результат
Мгновенное и надежное переключение контекста горячих клавиш при клике в любую точку рабочей области.

---

## 13. React Reconciliation Trap (Index Shift)

### Проблема
При переключении между Terminal и Home видом в проекте все терминалы внезапно уничтожались (`DISPOSE`) и создавались заново, хотя они находятся в разных ветках DOM.

### Причина
React выполняет реконсиляцию (сравнение) детей по их индексу, если не заданы ключи. 
**В `Workspace.tsx` была структура:**
```tsx
<div className="flex flex-col">
  {currentView === 'home' && <ProjectHome />} // Элемент [0]
  <TabBar />      // Элемент [1] или [0]
  <TerminalArea /> // Элемент [2] или [1]
</div>
```
Когда `ProjectHome` (индекс [0]) появлялся или исчезал, у `TabBar` и `TerminalArea` **смещались индексы**. React видел, что на месте [0] теперь другой компонент, и уничтожал всё дерево ниже по каскаду.

### Решение
1.  **Stable Indexing:** Условные оверлеи должны рендериться **последними** в списке детей.
2.  **Absolute Positioning:** Использование `absolute inset-0` позволяет оверлею физически находиться в конце списка детей (не влияя на индексы соседей), но визуально перекрывать их.

---

## 14. Sequential UI Disappearance (The Laggy Sidebar)

### Проблема
При переключении на Home сайдбар исчезал не мгновенно, а «поэтапно» (сначала таймлайн, потом кнопки).

### Причины
1.  **Layout Shift:** `Timeline` (шириной 24px) полностью удалялся из DOM. Это вызывало пересчет ширины всей правой колонки.
2.  **CSS Transitions:** Наличие `transition: all 0.3s` на кнопках и контейнерах заставляло элементы плавно менять прозрачность/цвет, что при массовом скрытии выглядело как задержка.

### Решение
1.  **Stay Mounted:** `Timeline` остается смонтированным всегда (сохраняя свои 24px), но скрывает содержимое через проп `isVisible`. Это убирает скачки верстки.
2. **Zero-Delay Policy:** Удаление `transition` у функциональных элементов (кнопки Claude/Gemini, Resizer), которые должны реагировать на смену глобального состояния мгновенно.
3. **Instant Portals:** Скрытие порталов (подсказок) должно быть принудительным и мгновенным при потере видимости родителя. Используйте `visibility: inherit`, чтобы дочерние элементы с явным `visible` не «пробивали» скрытого родителя.

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

## 16. Multi-select Persistence (data-keep-selection)

### Проблема
При выборе нескольких вкладок (Shift+Click) любой клик по интерфейсу вне TabBar (например, в поле ввода промпта в ActionsPanel) приводил к сбросу выделения. Это делало невозможным массовое обновление документации с кастомным промптом.

### Решение: Exclusion Attribute
В `TabBar.tsx` (обработчик `mousedown` на `document`) добавлена проверка атрибута `data-keep-selection`.
- На контейнеры `ActionsPanel` добавлен этот атрибут.
- Если `e.target` или любой его родитель имеет этот атрибут — сброс выделения (`clearSelection`) **игнорируется**.
Это позволяет пользователю выделять вкладки, а затем свободно взаимодействовать с инструментами в боковой панели, не теряя контекст выбора.

---

## 17. Double Debounce Strategy (Timeline Performance)

### Проблема
Timeline должен отслеживать видимость сообщений во вьюпорте и их наличие в полном буфере. Прямая проверка на каждый скролл или вывод данных (onWriteParsed) вызывает сотни тяжелых строковых операций в секунду.

### Решение: Трёхуровневая задержка
1.  **Viewport Highlight (100ms):** Легкая операция. Проверяет только те строки, что видны на экране. Срабатывает быстро, обеспечивая отзывчивость "черточки".
2.  **Reachability Check (500ms):** Тяжелая операция. Сканирует **весь** буфер терминала (включая scrollback). Выполняется реже, чтобы не нагружать процессор при активном выводе текста.
3.  **Data Sync (2000ms):** Самая тяжелая. Загрузка JSONL с диска и перестроение дерева Backtrace.
Такое разделение позволяет Timeline выглядеть "живым" без ущерба для производительности терминала.


\n---\n## File: ui-ux-stability.md\n
# Fact: UI/UX Polishing Details

Сборник мелких, но важных улучшений интерфейса, направленных на повышение информативности и плавности.

## 1. Компактные пути (Dashboard)
Чтобы не забивать интерфейс длинными строками типа `/Users/fedor/Projects/Web/my-app`, реализована функция сокращения пути.
- **Логика:** В карточке проекта отображаются только последние две директории.
- **Реализация:** `parts.slice(-2).join('/')`.

## 2. Мгновенные тултипы (Project Paths)
Поскольку сокращенный путь может быть неоднозначным, внедрен механизм мгновенного показа полного пути.
- **Behavior:** При наведении на сокращенный путь в `ProjectCard` полный адрес всплывает без задержки.
- **Implementation:** Использование стандартного атрибута `title` в сочетании с кастомным `Tooltip` компонентом для консистентности.

## 3. Живая валидация путей (Edit Modal)
Для предотвращения ошибок при ручном вводе или переименовании путей внедрена фоновая проверка.
- **Mechanism:** IPC-хендлер `project:validate-path` использует `fs.existsSync`.
- **UI:** Иконка ✅ появляется, если путь валиден, и ⚠️ — если папка не найдена.

## 4. Фоновая подготовка (Prepare-before-show)
Для устранения «эффекта белого экрана» при создании или переключении проекта:
1. Система сначала генерирует ID и создает записи в БД.
2. Инициализирует PTY-сессии.
3. Дожидается готовности рендерера терминала.
4. Только после этого убирает `RestoreLoader` и показывает проект.
\n---\n## File: ui-ux-stability.md\n
# ОПЫТ: Устранение мерцания (flicker) AI-интерфейса

## Problem
При использовании Rollback или создании форка, правая панель (InfoPanel) на короткое время (300-500мс) показывала состояние "Нет активной сессии", хотя сессия восстанавливалась.

## Symptoms
- Визуальный "прыжок" интерфейса.
- Скрытие кнопок управления сессией сразу после нажатия Rollback.

## Cause: Race Condition
1. `closeTab()` обнуляет `geminiSessionId` в сторе.
2. `createTab()` создает пустой таб.
3. InfoPanel через поллинг видит `null` и рендерит пустой экран.
4. `executePendingAction` в `Terminal.tsx` срабатывает только ПОСЛЕ готовности PTY.
5. Только тогда вызывается `setGeminiSessionId()`, и InfoPanel "просыпается".

## Solution: Immediate Injection
Изменен метод создания вкладок для AI-команд. Теперь `geminiSessionId` / `claudeSessionId` передается в `options` метода `createTab` или `createTabAfterCurrent`.
- Таб создается **уже** с ID сессии.
- InfoPanel видит ID мгновенно, не дожидаясь готовности PTY.

### Применение паттерна
1. **Fork/Rollback:** При создании форка или отката ID сессии передаётся в `createTab()` напрямую.
2. **History Restore:** При восстановлении вкладки из History (ProjectHome) `claudeSessionId` / `geminiSessionId` берутся из SQLite и передаются в `createTab()`. Sniper Watcher **не нужен** — ID уже известен. См. `features/project-home.md`.

## Результат
Бесшовный переход между вкладками и мгновенное отображение статуса сессии после отката или восстановления из истории.
\n---\n## File: ui-ux-stability.md\n
# Experience: Interactive Hover Zones (The Bridge Pattern)

## Проблема
При использовании **React Portals** (например, для тултипов или превью сообщений) всплывающий элемент рендерится в конце `<body>`, вне иерархии DOM триггера. Это делает невозможным использование `relatedTarget` в `onMouseLeave`, так как для браузера это абсолютно разные ветки.

**Следствие:** При попытке переместить курсор от "точки" (триггера) к "окну" (превью) оно мгновенно закрывается, так как между ними есть физический разрыв.

## Решение: Invisible Bridge
Для создания плавного перехода используется стратегия "Невидимого мостика":

1.  **Прозрачный слой:** Внутри портала вокруг контента создаётся невидимый контейнер (padding или отдельный div), который физически перекрывает расстояние до триггера.
2.  **Directional Closing:** Вместо таймеров используется проверка направления движения мыши в `onMouseLeave` триггера:
    -   Если мышь ушла "влево" (в сторону портала) — игнорируем закрытие.
    -   Если в любую другую сторону — закрываем мгновенно.
3.  **No Scale Policy:** Триггеры, открывающие сложные интерактивные зоны, не должны использовать `transform: scale` при hover. Изменение размеров элемента "на лету" меняет его `getBoundingClientRect`, что создаёт микро-разрывы между триггером и "мостиком".

## Примеры реализации
- `docs/features/timeline.md`: Превью сообщений.
- `src/renderer/components/Workspace/panels/ActionsPanel.tsx`: Меню настроек копирования (📋).

## Когда применять
Всегда, когда пользователю нужно взаимодействовать с контентом всплывающего окна, которое открывается по hover.
\n---\n## File: ui-ux-stability.md\n
# ОПЫТ: Решение проблем наложения UI (Layering & Portals)

## Проблема: "WebGL Canvas съедает мой интерфейс"
При использовании `xterm.js` (даже в режиме Canvas) и сложных UI-компонентов (модалки, кнопки поверх терминала), возникали две критические проблемы:
1. **Stacking Context:** Элементы с `position: fixed` и высоким `z-index` оказывались *под* терминалом или некорректно позиционировались из-за `transform` или `filter` у родительских контейнеров.
2. **Event Blocking:** Кнопки поверх терминала не реагировали на клики, либо клики проваливались "сквозь" них в терминал.

## Решение 1: React Portals
Для элементов, которые должны быть гарантированно поверх всего (FileExplorer, FilePreview), используется `createPortal`.

### Почему это помогло
Порталы рендерят компоненты напрямую в `document.body`, полностью игнорируя DOM-иерархию воркспейса. Это выводит их за пределы локальных контекстов наложения (Stacking Contexts), созданных Flex-контейнерами или анимациями.

```tsx
return createPortal(
  <motion.div style={{ position: 'fixed', zIndex: 99999 }}>
    {/* контент */}
  </motion.div>,
  document.body
);
```

## Решение 2: Layering Pattern (Слоеный пирог)
Для элементов внутри терминала (кнопка "Scroll to bottom", Restart Zone), где Portal не применим, используется паттерн соседних слоев.

### Структура (Terminal.tsx):
```tsx
<div className="absolute inset-0"> 
  {/* Слой 1: Тяжелый рендеринг терминала */}
  <div ref={terminalRef} className="terminal-instance absolute inset-0" />
  
  {/* Слой 2: Прозрачный UI слой поверх */}
  <div className="absolute inset-0 pointer-events-none z-10">
    {showScrollButton && (
      <button className="pointer-events-auto">↓</button>
    )}
  </div>
</div>
```

### Ключевые моменты:
- **`absolute inset-0`**: Вместо `relative w-full h-full`, чтобы избежать конфликтов с размерами `xterm.js`.
- **`pointer-events-none`** на контейнере слоя и **`pointer-events-auto`** на самих элементах (кнопках). Это позволяет кликать по кнопкам, но пропускать клики в терминал, если нажатие произошло в пустом месте слоя.
- **`zIndex`**: Явное указание `z-index` для UI-слоя заставляет браузер рисовать его после (поверх) холста терминала.

## Решение 3: Lock на инициализацию (isCreatingRef)
Чтобы избежать Race Condition при монтировании (когда React вызывает `useEffect` дважды или быстро переключает табы), введен флаг-замок `isCreatingRef`. Он гарантирует, что один и тот же DOM-узел не будет инициализирован терминалом дважды, что предотвращает краши отрисовки.
\n---\n## File: ui-ux-stability.md\n
# Experience: Layout Clipping (Nested Width Conflict)

## Проблема
Правая панель инструментов (`NotesPanel`) обрезалась (clipping) на ~25 пикселей с правой стороны при включении Timeline. Контент внутри панели выглядел смещённым или неполным.

## Причина
Конфликт между фиксированной шириной родителя и ребёнка:
1.  **Родитель** (правая колонка в `Workspace.tsx`) имел ширину `notesPanelWidth`.
2.  **Внутренняя структура**: `Timeline` (24px) + `Resizer` (1px) + контейнер с панелями.
3.  **Ребёнок** (`NotesPanel.tsx`) ТАКЖЕ использовал `style={{ width: notesPanelWidth }}`.

Когда `Timeline` вклинивался в поток, он забирал 24px. Ребёнок, не зная об этом, пытался занять полную ширину `notesPanelWidth`, вылезая за границы родительского контейнера. Поскольку на родителе стоял `overflow: hidden`, лишняя часть панели просто обрезалась.

## Решение
Удаление дублирующего стейта ширины из дочерних компонентов.
- В `NotesPanel.tsx` удалено использование `notesPanelWidth`.
- Добавлены CSS-классы `w-full h-full`, позволяющие панели гибко занимать всё доступное пространство, которое ей выделил родитель (с учётом уже занятого места под Timeline).

## Урок для проекта
Вложенные компоненты должны стремиться к использованию относительных размеров (`w-full`, `flex-1`). Использование глобального стейта ширины (`notesPanelWidth`) допустимо только для верхнеуровневого контейнера или портальных элементов (Tooltip), которым нужно знать точные координаты.
\n---\n## File: ui-ux-stability.md\n
# Сборник решений: Ввод, UX и Модальные окна

Этот файл объединяет решения проблем с вводом команд и заменой стандартных браузерных диалогов.

---

## 1. Enter Key Not Working in Auto-Commands
**Файл-источник:** `fix-enter-not-working.md`

### Problem
Commands sent via `terminal:executeCommand` (like `/chat save`) appeared in terminal but didn't execute (Enter was ignored).

### Root Causes
1. **Raw Mode Conflict**: Sending text + `\r` too fast causes CLI to treat it as a "paste", ignoring newlines for safety.
2. **Bracketed Paste Mode**: `\x1b[?2004h` wraps text, requiring manual Enter confirmation.

### Solution: Split writes with delay
In `main.js`:
term.write(command);
await new Promise(r => setTimeout(r, 150)); // Allow CLI to process text
term.write('\r'); // Now send Enter separately

---

## 2. Fix: Large Text Input (Buffer Overflow)
**Файл-источник:** `terminal-core.md`

### Problem
Вставка текста > 4KB (длинные промпты) обрывается из-за ограничений буфера TTY в ОС.

### Solution
Реализована функция `writeToPtySafe` с разбиением на чанки по 1KB и использованием **Bracketed Paste Mode**. Подробности в `knowledge/terminal-core.md`.

---

## 3. Fix: prompt() and alert() Not Supported in Electron
**Файл-источник:** `fix-prompt-alert-fix.md`

### Problem
App crashed with `Error: prompt() is and will not be supported` because Electron renderer doesn't support blocking browser dialogs.

### Solution
1. **Custom Modal**: Created a reusable HTML/CSS modal in `index.html`.
2. **showPromptModal()**: A Promise-based wrapper.
```javascript
const sessionKey = await showPromptModal('Title', 'Label', 'Placeholder');
if (sessionKey) { ... }
```
3. **Toasts**: Replaced `alert()` with non-blocking toast notifications for better UX.

---

## 3. Global Terminal Selection Sync
**Файл-источник:** Сессия 2026-01-21

### Проблема
Компоненты (например, GeminiPanel) не могли получить выделенный в терминале текст без прямого доступа к инстансу `xterm.js`. Кнопки поиска не знали, когда текст выделен, и не могли быть заблокированы (disabled).

### Решение
Внедрен глобальный стейт `terminalSelection` в `useUIStore`.
1.  **Terminal.tsx:** Слушает событие `onSelectionChange` и обновляет глобальный стейт.
2.  **Context Menu:** Принудительно вызывает `getSelection()` перед открытием меню.
3.  **UI:** Кнопки поиска используют `terminalSelection` для управления состоянием `disabled` и отображения счетчика символов.
См. также: `knowledge/terminal-core.md`.

---

## 4. UI Responsiveness (React 19 startTransition)
**Файл-источник:** Сессия 2026-01-21 (Performance Optimization)

### Проблема
При переключении между "тяжелыми" проектами или открытии новых вкладок интерфейс замирал, не реагируя на клики, пока новый терминал не отрисуется полностью.

### Решение
Использование API `startTransition` в React 19 для всех операций смены контекста (`switchTab`, `showWorkspace`).
```javascript
import { startTransition } from 'react';

const switchTab = (tabId) => {
  startTransition(() => {
    set({ activeTabId: tabId });
  });
};
```

### Результат
React помечает обновление как "низкоприоритетное". Это позволяет браузеру продолжать обработку анимаций и кликов (например, подсветку таба при наведении), пока тяжелая работа по рендерингу сетки терминала происходит в фоновом потоке.

```\n---\n## File: ui-ux-stability.md\n
# ОПЫТ: Состояние Interrupted Overlay (Persistence)

## Проблема
Приложение автоматически помечает активные сессии как `wasInterrupted = true` перед закрытием (`beforeunload`), чтобы предложить восстановление при следующем запуске.
Однако, если пользователь закрывал оверлей вручную (Escape или клик) и обновлял страницу, оверлей **появлялся снова**. Это происходило потому, что `beforeunload` срабатывал повторно и видел, что сессия всё ещё привязана к табу.

## Решение: Флаг `overlayDismissed`
В систему введено состояние "Осознанного закрытия":

1. **В Tab (SQLite):** Добавлена колонка `overlay_dismissed` (0/1).
2. **В UI:** При закрытии оверлея вызывается `dismissInterruptedSession()`, который ставит `overlayDismissed = true`.
3. **При закрытии:** Метод `markAllSessionsInterrupted()` теперь проверяет `if (hasSession && !overlayDismissed)`.
4. **Сброс флагов:** Флаги `wasInterrupted` и `overlayDismissed` сбрасываются в следующих случаях:
   - При нажатии кнопки "Продолжить" (Continue)
   - При полной очистке сессии таба
   - **При запуске НОВОЙ AI сессии** (`setClaudeSessionId`/`setGeminiSessionId`) — это гарантирует что overlay покажется снова если новая сессия будет прервана

## Жизненный цикл флагов

```
┌─────────────────────────────────────────────────────────────────┐
│  Запуск Claude/Gemini                                           │
│    setClaudeSessionId(tabId, newId)                             │
│    → wasInterrupted = false                                     │
│    → overlayDismissed = false   ← СБРОС при новой сессии        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Закрытие приложения (beforeunload)                             │
│    markAllSessionsInterrupted()                                 │
│    if (hasSession && !overlayDismissed)                         │
│      → wasInterrupted = true                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Следующий запуск                                               │
│    if (wasInterrupted && claudeSessionId)                       │
│      → Показать Overlay "Восстановить сессию?"                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌───────────────────────────┬─────────────────────────────────────┐
│  Пользователь нажал       │  Пользователь закрыл Overlay        │
│  "Continue"               │                                     │
│    → claude --resume ID   │    → overlayDismissed = true        │
│    → wasInterrupted=false │    → Overlay не появится снова      │
│                           │      (пока не запустит НОВУЮ сессию)│
└───────────────────────────┴─────────────────────────────────────┘
```

## Результат
Пользователь видит оверлей только один раз за сессию. Если он его закрыл — выбор сохраняется. Но при запуске **новой** AI сессии флаги сбрасываются и цикл начинается заново.
\n---\n## File: ui-ux-stability.md\n
# ОПЫТ: Manual Bounds Check для Hover-состояний

## Проблема
В компоненте `BookmarkCard` при открытии выпадающего меню (троеточие) создается «бэкдроп» (`fixed inset-0`), который перекрывает всю область экрана. Когда пользователь кликает по бэкдропу, чтобы закрыть меню, браузер не генерирует событие `onMouseLeave` для карточки, так как мышь технически перешла на слой выше, но не «выехала» за границы элемента. В результате после закрытия меню карточка ошибочно оставалась в состоянии «Hover» (зеленый оверлей).

## Решение: Ручная проверка границ (Manual Bounds Check)

Вместо того чтобы полагаться на стандартные события браузера, была внедрена логика ручной проверки координат в момент клика.

### Алгоритм:
1. К компоненту привязывается `ref` (`cardRef`).
2. При клике на бэкдроп вызывается функция `handleBackdropClick(e)`.
3. Функция получает координаты клика: `clientX`, `clientY`.
4. Получает границы карточки через `cardRef.current.getBoundingClientRect()`.
5. Сравнивает координаты. Если клик произошел **вне** прямоугольника карточки, состояние `isHovered` принудительно сбрасывается в `false`.

```typescript
const isOutside =
  e.clientX < rect.left ||
  e.clientX > rect.right ||
  e.clientY < rect.top ||
  e.clientY > rect.bottom;

if (isOutside) {
  setIsHovered(false);
}
```

## Результат
Интерфейс ведет себя предсказуемо: если пользователь закрыл меню, кликнув в пустую область экрана, карточка мгновенно теряет фокус. Если кликнул внутри границ — фокус сохраняется.
\n---\n## File: ui-ux-stability.md\n
# ЛОВУШКА: Portal + handleClickOutside = мгновенный сброс стейта

## Проблема
Кнопки внутри `TooltipPortal` (React Portal в `document.body`) при клике немедленно сбрасывают стейт, который они только что установили.

## Механизм бага
1. Компонент имеет `window.addEventListener('click', handleClickOutside)`.
2. `handleClickOutside` проверяет `containerRef.current.contains(e.target)`.
3. Кнопка "Начать копирование" рендерится через Portal → живёт в `document.body`, **вне** `containerRef`.
4. Клик по кнопке:
   - `onClick` → `setSelectionStartId("uuid-123")` ✅
   - Event bubbles to `window` → `handleClickOutside` → `contains()` = `false` → `setSelectionStartId(null)` ❌
5. Итог: стейт устанавливается и **мгновенно сбрасывается** в одном цикле.

## Решение
`e.stopPropagation()` на всех `onClick` кнопок внутри Portal:
```tsx
<button onClick={(e) => { e.stopPropagation(); startRangeSelection(entry); }}>
```

## Правило
Любая кнопка внутри Portal, которая меняет стейт родительского компонента, **обязана** вызывать `e.stopPropagation()`. Иначе `handleClickOutside` на `window` убьёт изменение.
\n---\n## File: ui-ux-stability.md\n
# ЛОВУШКА: useCallback + Auto-Refresh = Stale Closure

## Проблема
В компоненте Timeline `entries` обновляется каждые 2 секунды (auto-refresh). Функция `handleEntryClick`, обёрнутая в `useCallback([tabId])`, захватывает `finishRangeSelection` из рендера, когда `tabId` последний раз менялся. `finishRangeSelection` в свою очередь захватывает `entries` из того же рендера.

Результат: при вызове `finishRangeSelection` через 10+ секунд после создания `handleEntryClick`, `entries` содержит устаревший массив (часто пустой `[]`). UUID не находятся → `findIndex` = `-1`.

## Симптомы
- `entries.findIndex(e => e.uuid === startId)` возвращает `-1`
- IPC вызов `claude:copy-range` возвращает `{ success: false }`
- Баг воспроизводится нестабильно (зависит от тайминга refresh)

## Решение
1. **Не оборачивать в `useCallback`** функции, которые читают часто меняющийся стейт (`entries`, `sessionId`). Для `<div>` элементов (не мемоизированных компонентов) пересоздание функции на каждый рендер не влияет на производительность.
2. **Использовать ref** для значений, которые нужны в обработчиках И в async-функциях: `selectionStartIdRef.current` вместо замыкания над `selectionStartId`.

## Pattern: State + Ref
```tsx
const [selectionStartId, setSelectionStartId] = useState<string | null>(null);
const selectionStartIdRef = useRef<string | null>(null);

// При установке — обновляем ОБА:
selectionStartIdRef.current = entry.uuid;
setSelectionStartId(entry.uuid);

// В обработчиках — читаем из ref (всегда актуальный):
if (selectionStartIdRef.current) { ... }
```
\n---\n## File: ui-ux-stability.md\n
# ФАКТ: navigator.clipboard ненадёжен в Electron

## Проблема
`navigator.clipboard.writeText()` в Electron renderer-процессе работает нестабильно:
- Требует фокус окна (если окно потеряло фокус во время async/await — промис "теряется")
- Возвращает Promise, который может отклониться без видимой причины
- Баг проявляется intermittently (то работает, то нет)

## Решение
Использовать синхронный `clipboard` из Electron:
```typescript
const { ipcRenderer, clipboard } = window.require('electron');

// ❌ Ненадёжно
await navigator.clipboard.writeText(text);

// ✅ Надёжно
clipboard.writeText(text);
```

## Где применено
- `Timeline.tsx`: копирование range, копирование текста сообщения, кнопка "Копировать" в тултипе.

