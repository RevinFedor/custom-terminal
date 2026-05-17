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

**Чего НЕ делаем:**
- Не следим за `\x1b` / `\x03` в `terminal:input` — все варианты прерывания (Esc, Ctrl+C, /interrupt, submit-interrupt) одинаково пишут запись в JSONL.
- Не используем StopFailure hook — он fires только на API errors (rate_limit, auth), не на user interrupt.
- Не используем OSC 133 D с exit 130 — он fires на смерть Claude процесса, а не на прерывание turn'а (Claude после Esc продолжает жить).

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
