# Сборник решений: Стабильность и визуальный комфорт UI

Этот файл объединяет все решения, связанные с предотвращением дёргания (jitter), мерцания (flickering) и проблем с рендерингом терминала и вкладок.

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

#### 2. Сохранение инстансов (Persistent Terminals)
В `TerminalArea.tsx` логика изменена с фильтрации на скрытие:
-   Рендерим терминалы **всех** открытых проектов одновременно.
-   Используем `visibility: active ? 'visible' : 'hidden'` вместо условного рендеринга.
-   **Важно:** Используем именно `visibility: hidden`, а не `display: none`, так как `display: none` схлопывает контейнер в 0x0, что приводит к потере контекста WebGL и текстур в `xterm.js`.

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

### Результат
Терминал полностью игнорирует события и не претендует на активность, если пользователь находится в другом разделе приложения (Dashboard, Notes). Это повышает общую отзывчивость интерфейса при работе с тяжелыми AI-сессиями.
