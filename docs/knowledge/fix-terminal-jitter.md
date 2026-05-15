---
name: Terminal Scroll Fix (TERM_PROGRAM)
description: Scroll position resets, viewport jitter, character salad in subagent streams. Single-layer fix — TERM_PROGRAM=vscode triggers Ink's xterm.js-optimized rendering. Claude Code v2.1.101 fixed remaining issues upstream; protectedWrite/sync-frame splitter removed (was causing its own bugs). 40+ failed approaches documented.
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

## Решение: один слой

### TERM_PROGRAM=vscode (main.js)
Одна строка в `shellEnv` при создании PTY:
```javascript
TERM_PROGRAM: 'vscode', // Triggers xterm.js-optimized rendering in Claude Code's Ink
```
**Эффект**: Ink переключается на адаптивный drain, перестаёт слать агрессивный CSI 3J. Убирает 90% проблемы — scroll вверху стабилен, история сохраняется.

**Почему vscode**: Ink проверяет `TERM_PROGRAM === 'vscode'` для определения xterm.js. Наш терминал — xterm.js 5.5.0, поведение идентично VS Code terminal.

### Layer 2 (protectedWrite) → удалён 2026-05-13
Существовал для оставшихся edge cases (sync frames с CSI 2J/3J). После upstream-fix Claude Code v2.1.101 стал избыточен и **сам начал генерировать баги** (каша символов у субагентов из-за разреза BSU/ESU между PTY-чанками). Удалён вместе с серией подпорок (cursor-based check, INPUT_ZONE=6, onData→ref clear, снятие isWritingRef guard). Подробности — секция «Upstream fix» ниже. Историческое описание Layer 2 и подпорок сохранено в «Кладбище подходов» и «Cursor-based bottom detection» для защиты от повторного изобретения.

См. также `methodology/design.md::Удаляй workaround сразу после upstream-fix`.

## Cursor-based bottom detection (2026-05-13)

### Симптом
Пост-streaming дрожание при вводе: после окончания ответа Claude/Gemini ввод любой буквы вызывает прыгание текста вверх-вниз. Visible cue: input bar находится «чуть ниже» дна, проскроллить до самого низа мышкой нельзя — только через кнопку scroll-to-bottom.

### Root Cause
Ink держит cursor на строке `rows-1` (последняя видимая), но **последняя строка с данными** в буфере может быть на 1-2 строки выше. То есть `baseY` указывает на последнюю заполненную строку, а `viewportY` на видимое окно — между ними структурный gap. Это подтверждено мейнтейнером xterm.js Tyriar в [#4842](https://github.com/xtermjs/xterm.js/issues/4842): «cursor лives only inside the mutable viewport region (bottom `rows` lines)» — cursor живёт в viewport-local координатах независимо от scroll.

Строгое условие `viewportY >= baseY` в bottom-check **никогда не становится true** в idle Ink TUI → debounce 1с не успевает очистить `userScrollTopRef` → каждый keystroke триггерит sync-frame redraw → `protectedWrite` снапит к stale savedLine → дрожание. «Стрелочка вниз» работает как воркэраунд через `scrollToBottom()` + `userScrollTopRef.current = null`.

### Fix (тройной)

**1. Cursor-based bottom check с `INPUT_ZONE=6`.** `Terminal.tsx:431`:
```javascript
const INPUT_ZONE = 6;
const inputBarVisible = buf.cursorY >= term.rows - INPUT_ZONE;
const atBottom = inputBarVisible || buf.viewportY >= buf.baseY;
```
`cursorY` находится в **viewport-local координатах** (xterm.js #4842). Claude TUI **не ставит cursor на последнюю строку viewport** — он на `rows-5` потому что снизу резервируется ~5 строк: input prompt (`▸▸ bypass permissions on`), token usage indicator (`[Opus 4.7 (1M context)] 37%`), hint text, blank lines. `INPUT_ZONE=6` покрывает этот реальный footprint.

**Цена ошибки:** при `rows-1` (строгая проверка) condition **никогда** не становится true в idle Claude → `userScrollTopRef` остаётся установленным → `protectedWrite` каждые 50ms делает `scrollToLine(N)`, и из-за sub-pixel округления landing position гуляет на ±14px → **видимое дрожание текста при наборе**. Подобрано через `[ScrollDiag:SNAP]` лог: `cursorY=39 rows=44 DOM.scrollTop 26932→26946` — стабильный osc 14px вокруг savedLine 1788. См. `methodology/design.md::Diagnose with instrumentation`.

Fallback на `viewportY >= baseY` для plain shell без Ink TUI.

**2. `term.onData → ref clear`.** При первом нажатии клавиши юзером очищаем `userScrollTopRef.current = null`. Семантика: пользовательский ввод = намерение работать с input bar внизу → отпускаем scroll-защиту, чтобы xterm встроенный `scrollOnUserInput: true` сработал и прижал viewport к низу. Срабатывает **только** через `term.onData` callback (real keyboard event), **не** через `ipcRenderer.send('terminal:input', ...)` — программный input минует callback. Streaming PTY output идёт через `term.write`, не `onData`, поэтому защита **не** снимается во время Claude response.

**3. Снять `isWritingRef`/`isRestoringRef` guard в scroll handler.** Раньше при `isWriting=true` scroll handler выходил рано и не обновлял `userScrollTopRef`. Во время streaming sync-frames идут каждые ~16ms → guard блокировал реальный user scroll → `protectedWrite` продолжал снапить к stale savedLine → юзер крутит колесо, viewport возвращается через 16ms. Echo detection (`lastRestoredYRef`) сама фильтрует наши `scrollToLine` отголоски (distance ≤ 1 line), а реальный user scroll (delta ≫ 1 line) проходит и обновляет ref.

### Verify (живой E2E)

**Воспроизведено симптома (до фикса):** сессия с 1101 JSONL records, юзер на дне с активным streaming.
- `[ScrollDiag:SNAP]` сыпался 60+ раз за 4 секунды:
  ```
  scrollToLine(1788) DOM.scrollTop 26796→26935 savedLine=1788 baseY=1789 cursorY=39 rows=44
  scrollToLine(1788) DOM.scrollTop 26796→26946
  scrollToLine(1788) DOM.scrollTop 26796→26932
  ```
- `cursorY=39, rows=44` → `rows-1=43`, cursor **не** на последней строке → старая проверка `cursorY >= rows-1` всегда false → ref никогда не чистится.
- DOM.scrollTop осциллирует ±14px → видимое дрожание текста и невозможность доскроллить до самого низа.

**После фикса:** новый сценарий — scrolled-up на 2592px от дна, юзер начинает печатать через real keyboard event (`InputEvent` на `.xterm-helper-textarea`).
- **Первый keystroke:** scrollTop прыгает с 33647 → 36240 (на дне), distance=-0.06px. Это **xterm `scrollOnUserInput`**, не наш код.
- **Следующие 44 keystroke:** range=0, scroll не двигается → нет дрожания.
- Log: один `[ScrollDiag] JUMP delta=172` — это и есть момент return-to-bottom (не баг).

**Подвох в тесте через MCP:** `ipcRenderer.send('terminal:input', ...)` отправляет напрямую в PTY, минуя `term.onData` callback → фикс **не сработает в таком тесте**, надо симулировать через `InputEvent` на `.xterm-helper-textarea`. Подробнее: `methodology/design.md::Reproduce by the real user path`.

### Поиск upstream (изучено)
- **xterm.js #3201**: канонический check — `baseY === viewportY` (строгий). Tolerance не endorsed.
- **xterm.js #4842**: cursor живёт только внутри viewport; `cursorY` — viewport-local.
- **claude-code #769** (303 коммента): связан с другим багом (полная перерисовка спиннером), не наш случай. Anthropic считает это багом Ink.
- **Ровно нашего бага (post-streaming keystroke jitter + scroll stuck below input)** — в public трекерах нет. Воркэраунд кастомный.

### Что НЕ работает
- **`buf.viewportY >= buf.baseY` (строгое)** — никогда не срабатывает в Ink idle, дрожание остаётся.
- **`buf.viewportY >= buf.baseY - N` (tolerance 1-5)** — работает но семантически неверно. Юзер-скролл на N строк вверх ошибочно интерпретируется как «на дне» → защита снимается → следующий write возвращает viewport вниз. Tolerance — гадание, cursor-check — точная семантика.
- **DOM scrollTop check** — рассматривалось, но обработчик уже работает в xterm-буфере, переход на DOM не даёт выигрыша по точности.

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

### Не работает: immediate ref clear + per-tab Zustand subscriptions (2026-04-21, откат)
Попытка убрать "лёгкое дёрганье вниз" из baseline `42fa7d1`. Откатили и заменили на правильную комбинацию (см. секцию Fix выше). Оставлено в кладбище как «что НЕ работает в одиночку».

| Изменение | Почему провалилось в одиночку |
|---|---|
| **Immediate clear `userScrollTopRef` на bottom-touch** (без 1s debounce) | Во время streaming sync-frame (DEC 2026) `baseY` временно shrinkается из-за CSI 2J. На один кадр `viewportY >= baseY` → ref мгновенно null → следующий `protectedWrite` идёт без `scrollToLine` восстановления → Chromium clamp scrollTop → viewport прыгает. **Auto-follow к новому ответу ломался** — нижние ~20 строк (input area Ink) рендерились в новой позиции, а scrollback выше оставался stale. Визуально: нижняя часть TUI выглядела "обрезанной", граница между активной областью и историей съезжала. **Сейчас работает в комбинации:** debounce 1с остался, но cursor-based check с `INPUT_ZONE=6` теперь корректно определяет «юзер видит input bar», и ref чистится только через debounce. |
| **`onData` → `userScrollTopRef.current = null`** (любой keypress чистит scroll-защиту) | Сам по себе **верный** механизм для прижатия viewport вниз при вводе, **но без `INPUT_ZONE=6`** проблема осталась: cursor-based check не срабатывал в Claude TUI (cursor на `rows-5`), debounce не чистил ref, **первый keystroke** разово прижимал вниз — но каждый sync-frame после этого продолжал снапить из-за `protectedWrite`. **Сейчас работает в комбинации:** `onData` чистит ref → `scrollOnUserInput` xterm срабатывает; cursor-check с zone=6 не даёт ref'у переустановиться. |
| **`active`/`isActiveProject` → Zustand-подписка внутри Terminal/BrowserTab/ClaudeSDKTab** (вместо props из TerminalArea.useMemo) | Zustand рассылает обновления подпискам **асинхронно по очереди**. При быстром переключении табов/проектов на один React-кадр оба Terminal получали `effectiveActive=true` (старый ещё не увидел false, новый увидел true). Оба получали `zIndex:1` + `visibility:visible` → z-index race → ResizeObserver на 0×0 контейнере → SIGWINCH storm → Ink перерисовывал только нижнюю активную область, scrollback Canvas оставался stale. Симптом юзера: "при быстрой смене терминала ~20 строк инпута снизу рендерятся, всё выше — мешанина, разметка ломается, границы неправильные". **Откатили окончательно** — оставили props через TerminalArea.useMemo. |

**Урок:** для атомарной видимости (`active`/`zIndex`/`visibility`) всех табов в одном React-кадре нужен **общий родительский useMemo с пропами**, а не индивидуальные подписки. Подписка-на-таб корректна для всего, кроме z-index/visibility координации.

**Урок 2:** debounce на 1с при bottom-touch — не косметика, а **buffer-shrink filter**. Sync-frame внутри DEC 2026 на 1 кадр делает `viewportY >= baseY` (false-positive "at bottom"), и без debounce это интерпретируется как реальный пользовательский скролл вниз.

**Урок 3:** одиночные фиксы scroll-логики не работают — нужна **комбинация** (cursor-based check + `INPUT_ZONE>1` + `onData` clear + снятый guard `isWritingRef`). Каждый по отдельности оставляет дыру в каком-то из сценариев (initial bottom-touch / first keystroke / ongoing keystrokes / scroll during streaming).

## Ключевые инсайты

### TERM_PROGRAM — самый эффективный фикс
Одна env переменная убрала 90% проблемы. Обнаружена через анализ исходников Claude Code (`packages/claude-code-src/ink/terminal.ts`). 40+ итераций патчинга xterm.js были не нужны — проблема была на стороне передатчика (Ink), не приёмника (xterm.js).

### Тесты обманывали
E2E тест проверял snapshot viewportY. При oscillation snapshot попадал на "хорошее" значение → PASS. Правило: проверять **логи** (отсутствие JUMP delta > 100), не snapshot.

### Не ломать работающее ради косметики
commit `c6553c0` решал проблему. 40+ итераций пытались убрать drift 2-5 строк. Каждая ломала базовый функционал.

## Upstream fix: Claude Code v2.1.101 (2026-04-10) → удалён весь Layer 2

[anthropics/claude-code#35403](https://github.com/anthropics/claude-code/issues/35403) — `ashwin-ant` (Anthropic):
> "Fixed in v2.1.101 — Stopped emitting ERASE_SCROLLBACK (CSI 3J) on full resets in non-fullscreen mode, so terminal scrollback is preserved instead of being wiped during streaming."

**Удалено в 2026-05-13:** весь sync-frame splitter + `protectedWrite` + связанные refs (`writeBufferRef`, `syncFrameBufferRef`, `insideSyncBlockRef`, `isWritingRef`, `isRestoringRef`, `overflowLocksRef`, `isFitBlockedRef`, `lastRestoredYRef`, `userScrollTopRef`, `pendingWriteRef`). Также сняты cursor-based bottom check и `onData → ref clear` — они существовали только чтобы `protectedWrite` правильно решал когда снапить.

**Почему удалили:**
1. Изначально splitter ловил BSU/ESU маркеры Ink'a и накапливал sync-frame целиком, чтобы `CSI 3J` внутри кадра не уничтожил scrollback. После v2.1.101 Anthropic не шлёт `CSI 3J` → splitter защищает от того чего нет.
2. **Хуже того, splitter ломался при разрезе BSU/ESU между PTY-чанками.** node-pty доставляет output произвольными фрагментами; `raw.indexOf('\x1b[?2026h')` ищет полную 7-байтовую строку в одном payload. Если BSU попадал на границу двух chunks, splitter промахивался → frame data с `CSI 2J` шёл в xterm как «normal data» → каша символов на экране. **Чаще всего проявлялось при субагентах** (Task tool stream шлёт много мелких быстрых чанков → высокая вероятность разреза). Симптом юзера: «при запуске субагентов терминал везде ругается и меняется, символы склеиваются в кашу».
3. Cursor-based bottom check / `INPUT_ZONE=6` / `onData → ref clear` / снятие `isWritingRef` guard — всё это была серия фиксов **для проблем которые создал сам `protectedWrite scrollToLine`**: он каждые ~50ms снапил viewport, провоцируя дрожание. Без `protectedWrite` эти фиксы не нужны — xterm сам корректно ведёт viewport на user input (`scrollOnUserInput: true` дефолт) и follow output (auto-scroll при write если на дне).

**Что осталось:**
- **Layer 1 (`TERM_PROGRAM=vscode`)** — единственный нужный слой. Переключает Ink на xterm.js-оптимизированный render path (адаптивный scroll drain, без агрессивного CSI 3J).
- `handleData` теперь просто: `term.write(payload.data)`. Без накопления, без markers, без snap-back'а.

Связанные релизные фиксы Claude Code (без действий с нашей стороны):
- v2.1.105 — scrollback duplication при resize
- v2.1.116, 2.1.121, 2.1.128 — дупликаты, «typing prompt → jump to bottom», флики

Полный changelog: <https://code.claude.com/docs/en/changelog>

## Related
- `packages/claude-code-src/ink/terminal.ts` — `isXtermJs()` detection
- `packages/claude-code-src/ink/render-node-to-output.ts` — adaptive vs proportional scroll drain
- [anthropics/claude-code#35683](https://github.com/anthropics/claude-code/pull/35683) — community scroll-fix plugin (unmerged, obsolete after v2.1.101)
- [anthropics/claude-code#34503](https://github.com/anthropics/claude-code/issues/34503) — meta-issue scroll-to-top (closed v2.1.81)
- [anthropics/claude-code#35403](https://github.com/anthropics/claude-code/issues/35403) — закрывающий комментарий с указанием v2.1.101

---

## Hidden tab: `viewportY` сбрасывается в 0 при write в скрытый терминал

### Симптом
При переключении между табами терминала, если в **скрытом** табе продолжают поступать данные (Claude пишет), при возврате на этот таб происходит «дёргание» — терминал показывает верх буфера вместо ожидаемой позиции.

### Root cause — xterm.js bug
Запись данных в терминал с `visibility: hidden` или unmounted ref'ом сбрасывает `viewportY` в 0, **хотя `baseY`** (размер буфера) продолжает расти:

```
viewportY=466 baseY=466 isAtBottom=true   ← до записи
viewportY=0   baseY=471 isAtBottom=false  ← после записи в скрытый терминал
```

Полагаться на `viewportY` после возврата на таб нельзя.

### Решение — сохранять флаг `wasAtBottom`, не позицию
```ts
const savedScroll = useRef<number | null>(null);
const wasAtBottom = useRef(true);

// При деактивации таба:
savedScroll.current = currentViewportY;
wasAtBottom.current = currentViewportY >= currentBaseY;

// При активации таба:
if (wasAtBottom.current) {
  term.scrollToBottom();          // игнорируем сброшенный viewportY
} else {
  term.scrollToLine(savedScroll.current); // юзер был проскроллен вверх
}
```

### Критическое правило
При восстановлении scroll position после переключения табов **нельзя полагаться на текущий `viewportY`** — он может быть сброшен из-за бага xterm.js. Используй сохранённый флаг `wasAtBottom` для решения «scroll to bottom» vs «restore specific line».

### Открытая проблема — потеря PTY-данных при unmount
Когда юзер переходит на другой экран, компонент Terminal **размонтируется** → буфер сериализуется через `serializeAddon`, listener `terminal:data` удаляется. Но **PTY в Main процессе продолжает работать**. Если Claude в этот момент выдаёт текст — данные **теряются**, при возврате на таб видна «дыра» в истории.

Концептуальное решение: глобальный listener `terminal:data` на уровне `App.tsx` или Store + аккумуляция в `Map<tabId, string>` для неактивных табов + конкатенация сериализованного буфера и «пропущенных» данных при mount.

Не реализовано — issue открыт, отложен до следующего цикла рефакторинга.
