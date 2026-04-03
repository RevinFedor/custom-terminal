---
name: Terminal Scroll Fix (TERM_PROGRAM + Sync Frame Protection)
description: Scroll position resets during Claude Code output. Two-part fix — TERM_PROGRAM=vscode triggers Ink's xterm.js-optimized rendering (eliminates most jitter), protectedWrite handles remaining CSI 3J/2J edge cases. 40+ failed approaches documented.
type: fix
---

# Terminal Scroll Fix

## Симптомы
- Терминал **прыгает наверх** (viewportY=0) при работе Claude Code
- При скролле вверх для чтения истории — позиция сбрасывается
- Scrollbar дёргается при каждом ответе Claude
- При скролле вниз к active area во время output — дёрганье (snap-back)

## Root Cause

Ink renderer (React для CLI) имеет **разные rendering paths** в зависимости от `TERM_PROGRAM`:

- **Native terminals** (iTerm, Ghostty): агрессивный proportional scroll drain, DECSTBM hardware scroll, частый CSI 3J
- **xterm.js** (VS Code, Cursor): адаптивный drain (2-3 строки/кадр, cap 30), без aggressive CSI 3J

Мы передавали `TERM_PROGRAM: 'CustomTerminal'` → Ink не распознавал терминал → использовал native path с агрессивным drain + CSI 3J каждый кадр.

**CSI 3J** (Clear Scrollback) — главная причина jump-ов. Уничтожает весь scrollback, viewportY прыгает к нулю.

Обнаружено через анализ исходников Claude Code (`packages/claude-code-src/ink/terminal.ts`): функция `isXtermJs()` проверяет `TERM_PROGRAM === 'vscode'`.

## Решение: два слоя

### Слой 1: TERM_PROGRAM=vscode (main.js)
Одна строка в `shellEnv` при создании PTY:
```javascript
TERM_PROGRAM: 'vscode', // Triggers xterm.js-optimized rendering in Claude Code's Ink
```
**Эффект**: Ink переключается на адаптивный drain, перестаёт слать агрессивный CSI 3J. Убирает 90% проблемы — scroll вверху стабилен, история сохраняется.

**Почему vscode**: Ink проверяет `TERM_PROGRAM === 'vscode'` для определения xterm.js. Наш терминал — xterm.js 5.5.0, поведение идентично VS Code terminal.

### Слой 2: protectedWrite (Terminal.tsx, commit c6553c0)
Для оставшихся edge cases (sync frames с CSI 2J/3J):

1. **Sync Frame Buffering** — BSU/ESU данные накапливаются и пишутся атомарно
2. **Conditional CSI 3J Strip** — стрипается только при `userScrollTopRef !== null` (scrolled up). При bottom — проходит, буфер self-heals
3. **overflow:hidden** — на viewport во время sync frame write, предотвращает Chromium scrollTop clamp
4. **scrollToLine + Echo Detection** — restore позиции в callback. `lastRestoredYRef` фильтрует паразитные scroll events
5. **Immediate ref clear on scroll-down** — когда пользователь скроллит вниз до bottom, ref очищается сразу (без debounce), protectedWrite перестаёт snap'ить

## Оставшийся баг
При скролле вниз к active area во время активного output Claude — лёгкое дёрганье. Причина: protectedWrite snap'ит к сохранённой позиции пока ref не обновлён. Фикс: scroll handler обновляет ref немедленно при скролле вниз, очищает при достижении bottom.

## Кладбище подходов (40+ итераций)

### Не работает: борьба с последствиями на уровне DOM
| Подход | Почему провалился |
|---|---|
| **scrollTop save/restore** | Browser clamp scrollTop между flushes (async reflow) |
| **Double-rAF restore** | xterm's rAF перезаписывает scrollTop. 2-frame flicker |
| **minHeight pin** | xterm clampит ydisp на buffer level, минуя DOM |
| **MutationObserver на scroll-area** | Локит height → пользователь не может скроллить дальше |
| **Object.defineProperty** | Chromium Blink clampит scrollTop на C++ уровне |
| **CSS scrollbar-thumb: transparent** | Прячет дёрганье, но UX хуже |

### Не работает: вмешательство в xterm.js
| Подход | Почему провалился |
|---|---|
| **Monkey-patch syncScrollArea** | CSI handlers fire AFTER xterm обработал данные |
| **xterm 6.0 upgrade** | Canvas renderer убран, scrollTop API сломано |
| **xterm 5.5.0 fork** | DI injection ломает Viewport конструктор |

### Не работает: фильтрация данных
| Подход | Почему провалился |
|---|---|
| **Strip ALL CSI 2J** | Текст поверх старого, артефакты |
| **Strip ALL CSI 3J** | Буфер растёт неограниченно |
| **Stateful CSI 2J strip** | Oscillation — cursor-up + erase тоже shrinkят buffer |
| **Cursor-up clamp** | Cursor-up=7, viewport=55. Не наша проблема |

### Не работает: scroll tracking
| Подход | Почему провалился |
|---|---|
| **Debounce clear 1s** | Ref обнуляется при buffer shrink (false positive isAtBottom) |
| **"Upward only" ref save** | Блокирует scroll down |
| **isWritingRef на rAF** | Блокирует user scroll events |
| **Двухуровневая защита** | Light → drift, Full → oscillation |

### Не работает: альтернативные архитектуры
| Подход | Почему провалился |
|---|---|
| **Headless xterm.js diff-render** | ANSI edge cases, scrollback не растёт |
| **Rust pty-proxy** | vt100 output несовместим с xterm.js |
| **SK6=500** | Грубый throttle, текст чанками |
| **scroll-fix.cjs via NODE_OPTIONS** | Нативный Node может игнорировать NODE_OPTIONS |

## Ключевые инсайты

### TERM_PROGRAM — самый эффективный фикс
Одна env переменная убрала 90% проблемы. Обнаружена через анализ исходников Claude Code (`packages/claude-code-src/ink/terminal.ts`). 40+ итераций патчинга xterm.js были не нужны — проблема была на стороне передатчика (Ink), не приёмника (xterm.js).

### Тесты обманывали
E2E тест проверял snapshot viewportY. При oscillation snapshot попадал на "хорошее" значение → PASS. Правило: проверять **логи** (отсутствие JUMP delta > 100), не snapshot.

### Не ломать работающее ради косметики
commit `c6553c0` решал проблему. 40+ итераций пытались убрать drift 2-5 строк. Каждая ломала базовый функционал.

## Related
- `packages/claude-code-src/ink/terminal.ts` — `isXtermJs()` detection
- `packages/claude-code-src/ink/render-node-to-output.ts` — adaptive vs proportional scroll drain
- `anthropics/claude-code#35683` — scroll-fix plugin
- `anthropics/claude-code#34503` — meta-issue scroll-to-top
