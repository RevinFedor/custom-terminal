---
name: Terminal Scroll Jitter Fix (Ink Cursor-Up Clamping)
description: Scroll snap-to-top during Claude Code output caused by Ink renderer cursor-up exceeding viewport height. Fix clamps CSI A sequences on PTY input. Graveyard of failed xterm-level approaches.
type: fix
---

# Terminal Scroll Fix: Ink Cursor-Up Clamping

## Симптомы
- При работе Claude Code терминал **прыгает на самый верх scrollback** (scrollTop=0)
- Особенно при file reads, tool calls, любом обновлении Ink TUI
- Если пользователь скроллит вверх на ~70px чтобы читать историю — позиция сбрасывается наверх и застревает
- Проблема появилась после обновления Claude Code ~февраль 2026 (Ink differential renderer)
- Затрагивает **ВСЕ терминалы**: iTerm2, Terminal.app, VS Code, Windows Terminal, tmux, Kitty

## Root Cause
Ink renderer (`eraseLines()`) генерирует N cursor-up (`\x1b[{N}A`) последовательностей, где **N = количество ранее отрендеренных строк**. Когда N > высоты viewport, терминал следует за курсором выше видимой области и прыгает на начало scrollback.

Это происходит внутри synchronized output блоков (DEC 2026), поэтому даже терминалы с поддержкой DEC 2026 не защищены — они следуют за **финальной позицией курсора** после flush.

Upstream: `anthropics/claude-code#34503`, `microsoft/terminal#14774`

## Решение: Clamp Cursor-Up на входе

Одна функция `clampCursorUp()` в `Terminal.tsx` — regex замена `\x1b[{n}A` с бюджетом = `term.rows` на каждый write-вызов. Применяется **до передачи данных в xterm**, на уровне PTY-данных.

Ключевой инсайт: **фикс на входе (1 regex на PTY data) vs. сложная машинерия scroll-restore на выходе (xterm internals)**. Не нужно сохранять/восстанавливать scrollTop, перехватывать rAF, патчить xterm — достаточно не давать курсору уходить выше viewport.

Подход взят из `anthropics/claude-code#35683` (scroll-fix plugin) — тот же clamp, но реализованный как `process.stdout.write` interceptor внутри Node.js. У нас — на уровне терминала-потребителя.

### Альтернативный workaround
`SK6=500` env variable при запуске Claude — тротлит Ink render с 16ms до 500ms. Текст приходит чанками, но скролл не дёргается. Грубый, но рабочий.

## Кладбище подходов (>10 итераций)

Все подходы ниже **боролись с последствиями** (xterm уже получил cursor-up, уже сломал ydisp/scrollTop) вместо причины (cursor-up не должен был приходить):

1. **Sync frame buffering** — буферизация между `\x1b[?2026h` / `\x1b[?2026l`. Убирала мелкий jitter от intermediate states, но не решала scroll-to-top (cursor-up внутри sync frame всё равно > viewport)
2. **defineProperty патч `_innerRefresh`** — перехват xterm Viewport через `Object.defineProperty`. scrollTop переставал обновляться, но и пользовательский скролл ломался
3. **rAF scroll restore** — сохранять scrollTop → записать → восстановить через requestAnimationFrame. Race condition: xterm свой rAF стреляет после нашего, перезаписывая значение. Double-rAF → 2-frame flicker
4. **Offset-from-bottom** — запоминать расстояние от низа вместо абсолютного scrollTop. Контент скроллился ВВЕРХ, потому что мы компенсировали рост буфера в неправильном направлении
5. **Settle timer** — 200-500ms пауза после Claude tool calls для "стабилизации" скролла. scrollToBottom срабатывал между вызовами инструментов
6. **isAtBottom на viewportY** — xterm `viewportY=0` (corrupted Ink-ом) → проверка всегда врала
7. **xterm 6.0 upgrade** — Canvas renderer убран в 6.x → garbled text. `.xterm-viewport.scrollTop` не работает. Откат
8. **xterm 5.5.0 fork (DI injection)** — добавление `@ICoreService` в конструктор Viewport сломало DI parameter ordering → wrong services injected → скролл полностью мёртв
9. **xterm 5.5.0 fork (globalThis)** — `globalThis.__xtermSyncOutput` guard на `syncScrollArea`. Vite pre-bundling + browser HTTP caching сделали отладку невозможной. Скролл сломан в dev mode
10. **attachCustomWheelEventHandler + pauseFrames** — перехват wheel для паузы rAF enforcement. Wheel events fire ДО того как браузер применяет scroll → невозможно корректно обработать

## Методологический урок: глубокое чтение upstream PR

Решение было найдено в **PR #35683** на `anthropics/claude-code`, который был в результатах поиска с самого начала. Ошибка: PR был найден, но прочитан поверхностно — только заголовок и описание, без полного диалога в комментариях и diff-а.

**Правило:** При поиске решений для проблем, связанных с upstream-зависимостями (Claude Code, xterm.js, Electron):
- Читать **полный диалог** PR/issue, не только описание — решение часто в комментариях, в обсуждении отброшенных подходов
- Читать **diff целиком** — один файл на 87 строк (scroll-fix.cjs) содержал полное решение
- Искать **связанные issues** — #34503 агрегировал 8+ дубликатов, каждый с дополнительным контекстом
- **Не бросаться писать свой фикс**, пока не исчерпан поиск существующих решений. Час чтения PR экономит дни патчинга xterm internals

Это особенно критично для проблем, затрагивающих все терминалы — если баг воспроизводится везде, решение почти наверняка уже обсуждается upstream.

## Related
- `fact-terminal-rendering.md` — архитектура рендеринга терминала
- `anthropics/claude-code#35683` — scroll-fix plugin (upstream)
- `anthropics/claude-code#34503` — meta-issue со всеми дубликатами
