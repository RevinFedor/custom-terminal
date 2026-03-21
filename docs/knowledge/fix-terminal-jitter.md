---
name: Terminal Scroll Jitter Fix (Sync Frame Protection + Conditional CSI 3J)
description: Scroll position jumps and content drift during Claude Code output. Root cause: Ink's CSI 3J destroys scrollback, CSI 2J causes buffer shrink. Fix uses BSU/ESU sync frame buffering, conditional CSI 3J stripping, overflow:hidden, and echo detection.
type: fix
---

# Terminal Scroll Fix: Sync Frame Protection

## Симптомы
- При работе Claude Code терминал **прыгает** при скролле вверх
- Scrollbar дёргается на тысячи пикселей при каждом ответе Claude
- Контент "ползёт" (drift) — viewportY стабилен, но видимые строки меняются
- Особенно при file reads, tool calls, обновлениях Ink TUI
- Проблема затрагивает **все терминалы** — upstream issue

## Root Cause

Ink renderer (React для CLI) использует DEC Mode 2026 (Synchronized Output) для обновления UI:

1. `\x1b[?2026h` (BSU) — Begin Synchronized Update
2. `\x1b[2J` (CSI 2J, ED2) — Clear visible area (cells in-place, NO line deletion)
3. Redraw content
4. `\x1b[3J` (CSI 3J, ED3) — Clear scrollback (`trimStart(scrollBackSize)`, destroys ALL history)
5. `\x1b[?2026l` (ESU) — End Synchronized Update

**CSI 3J** — главная причина scroll jumps. Вызывает `trimStart()`, удаляя весь scrollback. viewportY прыгает от сотен к нулю.

**CSI 2J** — временно "сжимает" буфер (очищает видимые ячейки). Chromium кламмпит scrollTop к новому scrollHeight. Если не защитить, viewport уезжает.

xterm.js 5.x игнорирует DEC 2026 (поддержка только в 6.x), поэтому BSU/ESU обрабатываются как no-op.

## Решение: 5 слоёв защиты

### 1. Sync Frame Buffering (BSU → ESU)
Данные между BSU и ESU накапливаются в `syncFrameBufferRef` и пишутся одним `term.write()`. CSI 2J + redraw обрабатываются **атомарно** — промежуточные состояния не видны.

```typescript
// Data pipeline splits at BSU/ESU boundaries
const BSU = '\x1b[?2026h';
const ESU = '\x1b[?2026l';
// Normal data → writeBufferRef (flushed every 16ms)
// Sync data → syncFrameBufferRef (flushed on ESU, atomically)
```

### 2. Conditional CSI 3J Strip
CSI 3J стрипается **только когда пользователь скроллен вверх** (`userScrollTopRef !== null`).

- **Scrolled up**: strip CSI 3J → защита позиции, буфер растёт временно
- **At bottom**: CSI 3J проходит → буфер bounded, нет scrollbar jumps
- **Self-heal**: когда пользователь возвращается вниз, следующий frame's CSI 3J убирает накопленные строки

```typescript
const cleaned = savedLine !== null
  ? data.replace(/\x1b\[3J/g, '')
  : data;
```

### 3. overflow:hidden + overflowLocks
Для sync frames: `overflow: hidden` на `.xterm-viewport` предотвращает Chromium от clamp'а scrollTop при buffer shrink от CSI 2J.

`overflowLocksRef` (счётчик) предотвращает race condition при наложении нескольких sync frames.

`isFitBlockedRef` блокирует `ResizeObserver → fitAddon.fit()` пока overflow hidden — иначе scrollbar исчезает → ширина меняется → word wrap recalculation → reflow.

### 4. Echo Detection (lastRestoredYRef)
После `scrollToLine(X)`, браузер стреляет паразитный scroll event с `viewportY ≈ X`. Без фильтрации это "лаундерит" позицию — scroll handler захватывает echo и перезаписывает ref.

```typescript
if (lastRestoredYRef.current !== null) {
  const echoDistance = Math.abs(buf.viewportY - lastRestoredYRef.current);
  if (echoDistance <= 1) { lastRestoredYRef.current = null; return; }
  lastRestoredYRef.current = null;
}
```

### 5. Normal Writes без защиты
Данные вне sync frames (normal writes) пишутся через голый `t.write(data)`. xterm.js нативно сохраняет scroll position при append-at-bottom. Никаких флагов, overflow, scrollToLine. Это убирает jitter при пользовательском скролле.

### 6. Buffer Trim Compensation
Когда scrollback заполняется (>10000 строк), xterm.js декрементирует `ybase` и `ydisp`. `userScrollTopRef` становится stale. onTrim handler компенсирует:

```typescript
coreBuf.lines.onTrim((amount: number) => {
  trimCountRef.current += amount;
  if (userScrollTopRef.current !== null) {
    userScrollTopRef.current = Math.max(0, userScrollTopRef.current - amount);
  }
});
```

## Тестовые метрики (E2E, 15 секунд Claude output)
- **viewportY spread**: 0 (930 samples, 16ms interval)
- **Content mismatches**: 0 (first 5 visible lines checked)
- **scrollTop spread**: 2px
- **Buffer trims**: 0 (CSI 3J stripped while scrolled up)
- **ScrollFix drift logs**: 0 (all Δ=0)
- **Screenshots**: anchor, 5s, 15s — визуально идентичны

## Кладбище подходов (>10 итераций)

1. **Cursor-up clamp (scroll-fix.cjs)** — Regex на `\x1b[{n}A`, бюджет = rows. Работает для iTerm/Terminal.app, но не решает CSI 3J проблему в xterm.js
2. **Strip ALL CSI 2J + CSI 3J** — Текст рисуется поверх старого, scrollback растёт неконтролируемо. "Лекарство хуже болезни"
3. **Always strip CSI 3J** — Защищает scroll, но буфер растёт неограниченно (920→7000 за 15с). Scrollbar прыгает на тысячи пикселей
4. **Offset-from-bottom tracking** — Каждый normal write увеличивает baseY на 1, offset пересчитывается → viewportY сдвигается на 1 строку за сообщение
5. **Time Shield (50ms isRestoring)** — Writes каждые 16ms, shield 50ms = shield никогда не сбрасывается. Scroll trap — пользователь не может скроллить
6. **"Upward only" scroll tracking** — Пользователь не может скроллить ВНИЗ. Fatal UX
7. **xterm 6.0 upgrade** — Canvas renderer убран, `.xterm-viewport.scrollTop` always 0 (ScrollableElement). Откат
8. **defineProperty патч `_innerRefresh`** — Ломает пользовательский скролл
9. **rAF scroll restore** — Race condition с xterm's rAF
10. **SK6=500 env throttle** — Грубый workaround, текст чанками

## Ключевые инсайты

- **CSI 2J** в xterm.js 5.x очищает ячейки in-place, НЕ удаляет строки. ybase не меняется.
- **CSI 3J** вызывает `trimStart(scrollBackSize)` — удаляет ВСЁ из scrollback. Это корень проблемы.
- **CircularList.push() trim**: когда буфер полон, каждая новая строка сдвигает `_startIndex` и файрит `onTrimEmitter(1)`.
- **overflow:hidden** убирает scrollbar → ширина меняется → ResizeObserver → fit() → word wrap reflow. Блокируем fit через `isFitBlockedRef`.
- **Normal writes** не нужно защищать — xterm нативно держит позицию при append-at-bottom.
- **Sync frame = atomic**: BSU...ESU буферизуется целиком, один term.write(). Промежуточные CSI 2J + redraw невидимы.

## Related
- `anthropics/claude-code#35683` — scroll-fix plugin (cursor-up clamping, upstream)
- `anthropics/claude-code#34503` — meta-issue со всеми дубликатами
- `microsoft/terminal#14774` — Terminal scroll issue
