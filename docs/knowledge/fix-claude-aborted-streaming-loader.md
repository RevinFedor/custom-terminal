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
- 60-минутный `CLAUDE_TURN_WATCHDOG_MS` — на случай полного зависания Claude без Stop hook. Если Claude жив и даёт свежие артефакты активности, watchdog не должен сбрасывать turn сразу, а должен продлеваться. См. секцию ниже.
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

**Почему это не нарушает принцип `methodology/переносимый-дизайн.md::Authoritative artifact > input-heuristic`.** Старый watchdog'a отвергнут потому что он принимал решение **только по input-keystroke** через таймаут — unconditional reset через 2s после `\x1b`. Это и есть классическая input-heuristic, которая в 2026 порождала false-positives на стрелках. Новый probe:
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

## Регрессия июня 2026: watchdog принял живой 60+ минут turn за abort

### Симптомы
- Длинная Claude-сессия работает больше часа, потом на долю секунды "сбрасывается": вертикальный loader в табе гаснет и тут же загорается снова.
- Если включён run-after / stop-after, после такого флапа может сработать нежелательный auto-run: PromptQueue видит `busy=false` не как промежуточный шум, а как "turn закончился".
- В production-логах сигнатура характерная: сначала ровно через `3600.0s` закрывается interval активности, затем идёт `[ClaudeHook] Watchdog fired...`, потом каждые ~2 секунды чередуются spinner BUSY/IDLE при всё ещё живом Claude-процессе.

### Корневая причина

Первый watchdog был безопасен только для настоящего silent-stop: "если за 60 минут не пришёл Stop hook, turn мёртв". На очень длинных реальных turn'ах это неверно. Claude мог продолжать жить внутри tool-run или долгого reasoning, обновляя TUI spinner и иногда дописывая JSONL, но hook `Stop` ещё не имел права прийти.

Как только watchdog в такой момент делал `claudeTurnBusy=false`, suppression spinner-эвристики отключался. После этого PTY-спиннер снова становился видимым источником `claude:busy-state` и начинал шуметь на каждом thinking-phase. Для UI это выглядело как "лоадер прервался"; для автоматики хуже: PromptQueueRunner получал ложный turn-end и мог disarm/run после живого Claude.

### Исправление

Watchdog перестал быть безусловным одноразовым таймером.

1. На каждом видимом Claude spinner-frame сохраняется `claudeSpinnerLastSeenAt`.
2. При срабатывании watchdog проверяет два artifact-side сигнала:
   - жив ли Claude-процесс;
   - был ли свежий spinner (<30s) или свежий `mtime` JSONL (<10min).
3. Если процесс жив и хотя бы один артефакт свежий, watchdog **не** делает `busy=false`, а продлевает себя ещё на 15 минут.
4. Жёсткий `reason:'watchdog'` остаётся только когда и процесс/артефакты затухли.

Это сохраняет исходный смысл safety-net'а ("silent turn правда умер") и убирает ложный disarm на легитимных 60+ минутных turn'ах.

### Важная защита для автоматики

PTY spinner остаётся только эвристикой. Его `claude:busy-state` теперь идёт с `reason:'spinner'`, и PromptQueueRunner обязан **игнорировать** такие edge'ы. Иначе даже после исправленного watchdog любая heuristic-flap будет читаться как end-of-turn. Авторитетными сигналами для очереди остаются `Stop`, `StopFailure`, JSONL `InterruptStop` и настоящий `reason:'watchdog'`.

### Диагностика

Нормальное продление длинного turn'а:
```text
[ClaudeHook] Watchdog extended for tab ... (Claude still active; spinnerAge=8s jsonlAge=97s)
```

Настоящий мёртвый turn:
```text
[ClaudeHook] Watchdog fired for tab ... (Stop never arrived; liveProcess=false spinnerAge=none jsonlAge=7421s)
```

**Связанные:**
- [`fact-claude-stop-hook.md`](fact-claude-stop-hook.md) — общая архитектура Stop hook bridge, секция «Известные ограничения» п.5 описывает дыру `aborted_streaming`.
- [`fix-stale-sync-markers.md`](fix-stale-sync-markers.md) — другой источник Claude-side state desync.
- `methodology/переносимый-дизайн.md::Authoritative artifact > эвристика на input-side, когда первичный сигнал недоступен` — переносимый принцип, выведенный из этого фикса.
