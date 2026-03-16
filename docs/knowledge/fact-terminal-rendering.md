# UI Terminal Rendering

---

## 1. Ink/TUI Render Tearing & Synchronized Output (Input Jitter)
**Файл-источник:** `fix-ink-tui-render-tearing.md`, `fix-terminal-jitter.md`

### Problem
When running CLI tools built with Ink framework (e.g., Claude Code CLI, Gemini CLI), the input bar at the bottom of the terminal jitters/flickers during typing or when the tool is "thinking".

### Symptoms
- Input field visually "jumps" or "shakes"
- Text briefly disappears and reappears
- Cursor position seems unstable
- Problem is specific to Ink-based CLIs, not regular commands
- **NEW (Feb 2026):** Viewport "drifts" or entire screen jumps mid-write due to uncontrolled sync frame rendering

### Root Cause
#### Traditional Ink Issue
Ink framework updates the terminal UI at very high frequency (~100 writes/sec, 9ms gaps between updates). Each update sends a sequence:
1. `ESC[2K` - Erase line
2. `ESC[1A` - Move cursor up
3. Write new content

When xterm.js processes these as separate frames:
- Frame 1: Empty line (after erase)
- Frame 2: New content (after write)

The human eye perceives the empty frame as a "flash" or "jitter".

#### Modern Synchronized Output (DEC 2026)
Claude Code CLI (Feb 2026+) uses **DEC mode 2026 (Synchronized Output)** to wrap each differential frame:
- `\x1b[?2026h` marks frame start
- Multiple intermediate updates occur (cursor moves, line erases)
- `\x1b[?2026l` marks frame end
- **xterm.js 5.5.0 does NOT natively buffer these frames** — renders each escape sequence immediately
- Result: viewport "jitters" as intermediate cursor positions become visible, causing cascading redraws

### Solution
Implement a **Sync Frame-Aware Write Buffer** that:
1. **Detects DEC 2026 markers** in PTY output
2. **Batches writes** across complete sync frames (from `\x1b[?2026h` to `\x1b[?2026l`)
3. **Flushes atomically** ensuring xterm.js never renders intermediate states

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

#### Why FLUSH_DELAY = 16ms (Updated Feb 2026)?
- 60fps = 16.67ms per frame
- Originally 10ms, increased to 16ms to align exactly with one frame
- 16ms ensures we batch multiple Ink updates into single frame
- Works in tandem with **Synchronized Output (DEC 2026)** protocol:
  - Claude Code wraps each differential frame in `\x1b[?2026h` ... `\x1b[?2026l`
  - Write buffer holds data until sync frame closes, preventing intermediate renders
  - 16ms then flushes the complete, atomic frame to xterm.js
- For details on sync frame awareness, see [`fix-terminal-jitter.md`](fix-terminal-jitter.md)

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

### 11.2. The isInverse() Mystery (SGR 7)

### Проблема
В приложении (xterm.js) некоторые части интерфейса Claude/Gemini (например, префиксы промпта) выглядят как текст с закрашенным фоном, однако при захвате сырого ANSI-вывода (`node-pty`) соответствующие коды фонового цвета (`\x1b[48;...m`) отсутствуют.

### Причина
Использование флага **Reverse Video (SGR 7)**: `\x1b[7m`. 
Этот флаг велит терминалу визуально поменять местами цвета текста (Foreground) и фона (Background). В результате:
- Текст становится цветом фона.
- Фон становится цветом текста.

### Значимость
Это объясняет, почему попытки найти границы сообщений по явным кодам Background RGB провалились — визуальный "фон" создаётся через SGR 7, а не через `\x1b[48;...m`. Подход с анализом фоновых цветов был **отброшен** в пользу OSC 7777 маркеров (Claude) и текстового поиска (Gemini). `cell.isInverse()` в текущем коде не используется.

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

## 19. Idempotent Resize (SIGWINCH Storm Protection)

### Проблема: Лишние сигналы при переключении табов
При каждом переключении на вкладку терминала вызывался метод `fit()`, который отправлял IPC-сообщение `terminal:resize` в Main процесс. Main процесс, в свою очередь, вызывал `pty.resize()`, что порождало системный сигнал `SIGWINCH`.

**Следствие:** Даже если физический размер окна не менялся, Claude CLI (Ink TUI) получал сигнал о ресайзе. Это заставляло его полностью перерисовывать интерфейс, генерируя новые sync-маркеры. Это ломало логику ожидания в `safePasteAndSubmit` (см. `knowledge/fix-stale-sync-markers.md`).

### Решение: Проверка изменений (Safe Fit)
В функцию `safeFit` добавлена проверка текущих размеров.

```javascript
const safeFit = () => {
  if (!xtermInstance.current || !containerRef.current) return;
  const { cols, rows } = fitAddon.current.proposeDimensions();

  // 🛡️ Фильтр: не шлем resize если размеры те же
  if (cols === lastSize.current.cols && rows === lastSize.current.rows) {
    return;
  }

  lastSize.current = { cols, rows };
  fitAddon.current.fit();
  ipcRenderer.send('terminal:resize', tabId, cols, rows);
};
```

### Результат
Переключение вкладок стало "бесшумным" для процессов внутри терминала. Claude CLI больше не ловит ложных ресайзов, что стабилизирует работу всех автоматизаций (модели, форки, откаты).
