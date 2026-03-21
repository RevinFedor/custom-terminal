---
name: Terminal Scroll Fix (Sync Frame Protection)
description: Scroll position resets during Claude Code output. Root cause CSI 3J destroys scrollback. Fix uses BSU/ESU sync frame buffering, conditional CSI 3J strip, overflow:hidden, scrollToLine restore with echo detection. 40+ failed approaches documented.
type: fix
---

# Terminal Scroll Fix: Sync Frame Protection

## Симптомы
- Терминал **прыгает наверх** (viewportY=0) при работе Claude Code
- При скролле вверх для чтения истории — позиция сбрасывается
- Scrollbar дёргается при каждом ответе Claude
- При скролле на < rows строк вверх — контент внизу "плывёт" (Ink active area overlap)

## Root Cause

Ink renderer (React для CLI) использует DEC Mode 2026 (Synchronized Output):

1. `\x1b[?2026h` (BSU) — Begin Synchronized Update
2. `\x1b[2J` (ED2) — Clear visible area (cells in-place)
3. Redraw content
4. `\x1b[3J` (ED3) — **Clear scrollback** (`trimStart(scrollBackSize)`, уничтожает ВСЮ историю)
5. `\x1b[?2026l` (ESU) — End Synchronized Update

**CSI 3J** — главная причина. Вызывает `trimStart()`, удаляя весь scrollback. viewportY прыгает от сотен к нулю.

**Cursor-up (CSI A)** — НЕ проблема в нашем случае (max 7 при viewport 55). PR #35683 (cursor-up clamping) не помогает.

xterm.js 5.x игнорирует DEC 2026 (поддержка только в 7.x), BSU/ESU — no-op.

## Решение (commit c6553c0)

### 1. Sync Frame Buffering (BSU → ESU)
Данные между BSU и ESU накапливаются в `syncFrameBufferRef` и пишутся одним `term.write()`. `insideSyncBlockRef` — stateful tracking across data chunks.

### 2. Conditional CSI 3J Strip
CSI 3J стрипается **только когда пользователь скроллен вверх** (`userScrollTopRef !== null`). При возврате на bottom — CSI 3J проходит, буфер self-heals.

### 3. overflow:hidden + overflowLocks
`overflow: hidden` на viewport во время sync frame write предотвращает Chromium scrollTop clamp. `isFitBlockedRef` блокирует `fitAddon.fit()` пока overflow hidden (scrollbar исчезает → ширина меняется → reflow).

### 4. scrollToLine + Echo Detection
`scrollToLine(restoredLine)` в callback + rAF. `lastRestoredYRef` фильтрует паразитные scroll events после scrollToLine (browser стреляет scroll event с viewportY ≈ target).

### 5. isPushedToBottom Guard
Когда buffer shrinks (baseY падает ниже savedLine), `viewportY >= baseY` = true, но это не реальный "user at bottom". Guard: `if (savedPos > buf.baseY)` — не очищать ref.

### 6. Buffer Trim Compensation (onTrim)
При scrollback limit (10000 строк) xterm декрементирует ybase/ydisp. `onTrim` корректирует `userScrollTopRef`.

### 7. Normal Writes без защиты
Данные вне sync frames — голый `t.write(data)`. xterm нативно держит scroll position. Никаких флагов, overflow, scrollToLine.

## Известное ограничение
При скролле на < `rows` строк вверх, нижняя часть viewport'а пересекается с Ink active area (ybase..ybase+rows). Контент там меняется каждый Ink frame — это inherent поведение, не баг скролла. Для стабильного чтения — скроллить >= rows строк вверх.

Небольшой drift вниз (2-5 строк) и подёргивание scrollbar thumb при активном output — inherent ограничение xterm.js 5.x без нативного DEC 2026.

## Кладбище подходов (40+ итераций)

### Не работает: борьба с последствиями на уровне DOM
| Подход | Почему провалился |
|---|---|
| **scrollTop save/restore** | Browser clamp scrollTop между flushes (async reflow). К моменту restore scrollTop уже 0 |
| **Double-rAF restore** | xterm's rAF fires после нашего, перезаписывает scrollTop. Двойной rAF → 2-frame flicker |
| **minHeight pin на scrollArea** | Предотвращает DOM clamp, но xterm clampит ydisp на buffer level (ydisp = min(ydisp, ybase)). Не помогает |
| **MutationObserver на scroll-area height** | Локит height → пользователь не может скроллить дальше оригинального baseY. Тупик |
| **Object.defineProperty на scrollTop** | Chromium Blink clampит scrollTop на уровне C++ layout engine, минуя JS сеттеры |
| **CSS scrollbar-thumb: transparent** | Прячет дёрганье, но пользователь не видит scrollbar position |
| **overflow:hidden постоянно** | Блокирует весь user scroll на время active output |

### Не работает: вмешательство в xterm.js
| Подход | Почему провалился |
|---|---|
| **Monkey-patch syncScrollArea + _innerRefresh** | CSI handlers стреляют после xterm обработал данные. DI injection в Viewport ломает порядок аргументов |
| **xterm 6.0 upgrade** | Canvas renderer убран, scrollTop always 0 (ScrollableElement API). Полная поломка |
| **xterm 5.5.0 fork с globalThis guard** | Vite pre-bundling + browser HTTP caching. Скролл сломан в dev mode |
| **CSI handler для DEC 2026** | `prefix: '?', final: 'h'/'l'` — handlers fire AFTER xterm processes BSU. Бесполезно |

### Не работает: фильтрация данных
| Подход | Почему провалился |
|---|---|
| **Strip ALL CSI 2J** | Текст рисуется поверх старого. "Лекарство хуже болезни" |
| **Strip ALL CSI 3J** | Буфер растёт неограниченно (920→10000 за 15с). Scrollbar прыгает |
| **Stateful CSI 2J strip (only in sync blocks)** | Уменьшило oscillation, но не устранило — cursor-up + erase-line тоже shrinkят buffer |
| **Cursor-up clamp (scroll-fix.cjs)** | Cursor-up = 7, viewport = 55. Не наша проблема |

### Не работает: scroll tracking
| Подход | Почему провалился |
|---|---|
| **Persistent userScrollTopRef с debounce clear** | Ref обнуляется при каждом isAtBottom, даже при buffer shrink (false positive) |
| **"Upward only" ref save (viewportY >= prev)** | Блокирует scroll down. Fatal UX |
| **isWritingRef на rAF** | isWritingRef=true почти всё время → user scroll events заблокированы |
| **Двухуровневая защита (light vs full)** | Light protection для малых скроллов → без scrollToLine → drift. Full → oscillation |

### Не работает: альтернативные архитектуры
| Подход | Почему провалился |
|---|---|
| **Headless xterm.js diff-render** | serializeLine не обрабатывает все ANSI edge cases. Diff-render через cursor positioning не увеличивает scrollback |
| **Rust pty-proxy (vt100 crate)** | Несовместимость vt100 output с xterm.js. Полное разрушение разметки |
| **SK6=500 env throttle** | Текст чанками по 500ms. Грубый workaround, не решает CSI 3J |
| **NODE_OPTIONS --require scroll-fix.cjs** | Нативный Node в Claude может игнорировать NODE_OPTIONS |

## Методологический урок

### Тесты обманывали
E2E тест проверял snapshot viewportY в один момент (5s, 15s). При oscillation (viewportY прыгал 1076→550→1076 каждые ~50ms) snapshot попадал на "хорошее" значение → тест PASS. Реально пользователь видел постоянное дёрганье.

**Правило**: тест scroll stability должен проверять **логи** (отсутствие больших JUMP delta), не snapshot значения.

### Готовое решение было с самого начала
commit `c6553c0` решал проблему. 40+ итераций пытались убрать косметический drift (2-5 строк вниз) и дёрганье scrollbar. Каждая итерация ломала базовую функциональность. В итоге откатились к c6553c0.

**Правило**: когда базовый функционал работает, не ломать его ради косметики. Drift 2-5 строк ≠ jump на 1000 строк.

### Upstream PR читать целиком
PR #35683 был в результатах поиска с начала. Прочитан поверхностно (только заголовок). 10+ итераций патчинга xterm.js вместо чтения 87-строчного diff. Час чтения PR экономит дни.

## Related
- `anthropics/claude-code#35683` — scroll-fix plugin (cursor-up clamping)
- `anthropics/claude-code#34503` — meta-issue scroll-to-top
- `microsoft/terminal#14774` — Terminal scroll issue
- `copilot-cli#1805` — 4-layer scroll fix reference
