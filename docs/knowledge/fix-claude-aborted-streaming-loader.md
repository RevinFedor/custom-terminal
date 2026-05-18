# Fix: Loader залипает после прерывания Claude turn'а

### Симптомы
- Юзер нажимает Esc / Ctrl+C во время ответа Claude → стриминг останавливается, но spinner в табе продолжает мигать или loader залипает на час до 60-минутного watchdog'а.
- Альтернативно: точка в табе пульсирует когда Claude **продолжает работать** (например юзер случайно нажал стрелку, навигационную клавишу или Ctrl+]).
- В логах: после `[ClaudeInterrupt]` watchdog fired → последующий spinner BUSY/IDLE цикл шумит на каждом thinking phase.

### Корневая причина

Claude Code v2.1.88+ в `query.ts:1051` на пути `aborted_streaming` возвращает `{ reason: 'aborted_streaming' }` **без вызова handleStopHooks**. Это намеренное поведение — задокументировано в issues `anthropics/claude-code#29881`, `#17466`. На этот путь попадают:
- Esc / Ctrl+C в TUI
- Submit-interrupt (новый prompt пока идёт ответ)
- `/interrupt` команда

Из-за этого наш `Stop` hook **никогда не fires** на прерывании. `claudeTurnBusy` остаётся `true`, suppression spinner-эвристики продолжает блокировать `IDLE` события, loader залипает.

### Что было неправильно (откатили)

Раньше был `claudeInterruptWatchdog` — 2-секундный таймер, который ловил `\x1b` или `\x03` в `terminal:input` и принудительно ставил `busy=false` если за 2с Stop hook не пришёл.

Проблемы:
1. `\x1b` ≠ только Esc. Стрелки (`\x1b[A`), F-клавиши, `\x1bO...` тоже начинаются с `\x1b`. Любая навигация в Claude TUI → ложный disarm suppression.
2. 2 секунды — magic number, не привязан к детерминированному сигналу.
3. Считал turn прерванным даже когда Claude после этого продолжал работать.

### Авторитетное решение

Claude **сам пишет** в session JSONL когда юзер прервал стриминг — `type:"user"` запись с `message.content[0].type === "text"` и `text === "[Request interrupted by user]"` (или `"... for tool use"` вариант). Это детерминированный file-system сигнал, не зависящий от TUI-keystroke.

**Реализация** (`src/main/main.js`):

1. На `UserPromptSubmit` hook → `startInterruptWatcher(tabId, sessionId)`:
   - Резолвит JSONL путь: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`
   - `fs.watch` на этом файле + tail-reader от текущего byte offset
   - При каждом `change` event: читает дельту, парсит новые строки, ищет marker
2. На `Stop` hook → `stopInterruptWatcher(tabId)` (turn закончился нормально, watcher не нужен).
3. На marker hit → `claudeTurnBusy=false`, эмит `claude:busy-state busy=false` + `turn-state {event:'InterruptStop'}` для PromptQueueRunner.
4. На `clearBridgeTab` (закрытие таба, Claude exit) → tear down watcher.

**Что осталось как safety net:**
- 60-минутный `CLAUDE_TURN_WATCHDOG_MS` — на случай полного зависания Claude без JSONL writes.
- Idle-probe на pure Esc/Ctrl+C — см. секцию «Edge case» ниже.

**Чего НЕ делаем:**
- Не используем `\x1b` / `\x03` в `terminal:input` как **единственный** триггер сброса (это был запрещённый watchdog v1). Допустимо только в роли **первого guard'а** двойной проверки, где итоговое решение принимается через artifact-side check (mtime stale) — см. секцию «Edge case» ниже.
- Не используем StopFailure hook — он fires только на API errors (rate_limit, auth), не на user interrupt.
- Не используем OSC 133 D с exit 130 — он fires на смерть Claude процесса, а не на прерывание turn'а (Claude после Esc продолжает жить).

## Edge case: Esc до первой JSONL-записи

JSONL-watcher детерминирован для **большинства** прерываний, но не покрывает один пограничный случай: юзер нажал Esc **до того как Claude начал стримить** (короткий turn, или Esc прилетел в окно между UserPromptSubmit и первым `assistant`-chunk). Claude в этом случае **не пишет** `[Request interrupted by user]` в JSONL — файл остаётся с одной только UserPromptSubmit-meta записью, или вообще пустым. Watcher `fs.watch` сидит на пустом файле, ждёт marker, marker не приходит. `claudeTurnBusy` остаётся `true`, AI-shimmer на табе продолжает крутиться до 60-минутного watchdog'а.

Симптом — юзер: *«нажал Escape, а заливка продолжила работать»*. В логах есть `[ClaudeInterrupt:JSONL] watching ~/.claude/projects/.../<sid>.jsonl (offset=N)`, но `interruption record found` не появляется. Snapshot показывает `turn=1 spin=1 iw last=UserPromptSubmit:Xs` — watcher жив, но безрезультатно.

### Решение — двойной guard: pure-Esc + artifact mtime stale

`armInterruptIdleProbe(tabId)` в `main.js`. Триггер первого guard'а — `terminal:input` с `data === '\x1b'` (pure Esc, длина 1 байт) или `data === '\x03'` (Ctrl+C). Multi-byte ESC-sequences (`\x1b[A` стрелки, `\x1bO...` F-keys) **пропускаются** — это был корень провала старого watchdog'а. Probe ставит `setTimeout(checkIdle, 1500ms)`.

`checkIdle` — второй guard. Проверяет `fs.statSync(filePath).mtimeMs`. Если файл не менялся последние 1200ms И `claudeTurnBusy === true` → `mainWindow.webContents.send('claude:busy-state', { tabId, busy: false })` + `turn-state InterruptStop`. Если файл свежий (Claude продолжает писать) — probe ничего не делает, watcher по marker'у обрабатывает дальше.

**Почему это не нарушает принцип `methodology/design.md::Authoritative artifact > input-heuristic`.** Старый watchdog'a отвергнут потому что он принимал решение **только по input-keystroke** через таймаут — unconditional reset через 2s после `\x1b`. Это и есть классическая input-heuristic, которая в 2026 порождала false-positives на стрелках. Новый probe:
1. Использует **более узкий** input-filter (только pure 1-byte Esc/Ctrl+C, не любой ESC-prefix) — снимает false-positive на навигации.
2. **Не сбрасывает unconditional** — input только armит timer, реальное решение принимается через `fs.statSync().mtimeMs` (это artifact-check, не input-check).

Если Claude реально работает, mtime свежий → probe возвращает без действия. Если Claude не работает (прервался до записи или просто idle), mtime замораживается → probe сбрасывает. Authoritative artifact остался первичным источником правды, input-side выступает только триггером **когда запросить проверку артефакта**, не *что решить*.

### Диагностика probe-fallback'а

В логах после Esc на коротком turn'е:
```
[ClaudeInterrupt:Idle] tab=...-tab-NNN Esc/Ctrl+C без JSONL-записей за 1500ms — forcing busy=false
```

Если probe не сработал (Claude после Esc продолжил писать) — никакого `[ClaudeInterrupt:Idle]` лога нет, что корректно: turn реально продолжается, сбрасывать busy нельзя.

### Диагностика

В логах после прерывания должно быть:
```
[ClaudeInterrupt:JSONL] tab=...-tab-NNN watching ~/.claude/projects/<slug>/<sid>.jsonl (offset=NNNN)
... (юзер жмёт Esc) ...
[ClaudeInterrupt:JSONL] tab=...-tab-NNN interruption record found in transcript — forcing busy=false ([Request interrupted by user])
```

После этого spinner-эвристика снова разрешает свои IDLE-события, но `claudeTurnBusy=false` правомерно — turn реально завершён.

**Связанные:**
- [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) — общая архитектура Stop hook bridge, секция «Известные ограничения» п.5 описывает дыру `aborted_streaming`.
- [`fix-stale-sync-markers.md`](fix-stale-sync-markers.md) — другой источник Claude-side state desync.
- `methodology/design.md::Authoritative artifact > эвристика на input-side, когда первичный сигнал недоступен` — переносимый принцип, выведенный из этого фикса.
