# Fix: Claude Code 2.1.x phantom parentUuid в JSONL

### Симптомы
- После `claude --resume` контекст пропадает: в TUI видны только последние 2-5 сообщений, хотя в файле сотни записей.
- При попытке открыть закрытую сессию % контекста на старте 5-15% вместо ожидаемых 40-70%.
- В JSONL есть запись с `parentUuid` указывающим на UUID, которого нет нигде в файле (phantom reference).
- После `/compact` + Esc-rewind на старое сообщение Claude отвечает как с нуля («У меня нет доступа к прошлым диалогам») вместо использования compact summary.
- Двойной Esc на текущем prompt'е → новая ветка пишется с `parentUuid: null` → активная цепочка теряет связь с pre-compact историей.

---

## 1. Природа бага (на стороне Anthropic)

Это **архитектурный баг во всех версиях Claude Code 2.1.x**, не регрессия. Подтверждено комментариями в GitHub issues от v2.1.23 (январь 2026) до v2.1.146 (май 2026, текущая):
- [#21617](https://github.com/anthropics/claude-code/issues/21617) — earlier messages lost on resume
- [#22526](https://github.com/anthropics/claude-code/issues/22526) — *«this UUID does not exist anywhere in the file. It's a phantom reference»*
- [#21751](https://github.com/anthropics/claude-code/issues/21751) — assistant text blocks написаны в subagent file вместо main transcript
- [#24304](https://github.com/anthropics/claude-code/issues/24304) — messages missing on resume, два паттерна corruption
- [#36583](https://github.com/anthropics/claude-code/issues/36583) — file-history-snapshot messageId collision
- [#40352](https://github.com/anthropics/claude-code/issues/40352) — compaction race destroys transcript content на rate-limit
- [#61188](https://github.com/anthropics/claude-code/issues/61188) — наш repro c `/compact → resume → phantom parent`

**Корень бага** (несколько механизмов одновременно):
1. **Resume-time RAM-to-disk discontinuity** — при `--resume` Claude процесс восстанавливает state из RAM-snapshot предыдущего инстанса. UUID, на которые он опирается как на parents, могут не быть зафлашены на диск целиком. Первое user-сообщение после resume ссылается на phantom.
2. **Multiple parallel writers** — Claude CLI пишет в один JSONL из нескольких code-paths (user transcript, subagent results, file-history-snapshot, last-prompt metadata) без file lock. Строки склеиваются mid-character без `\n` между ними.
3. **SIGTERM mid-stream** — kill процесса (наш Stop button с raw SIGTERM, `pkill` от `build:install`, `--no-verify` exit) обрывает текущий flush в JSONL. Записи на диске остаются неполными, parentUuid цепочка с phantom referencee'ами.
4. **(Устранён 2026-05-23) Наш собственный EffortCleanup был четвёртым источником.** На `process-started` мы инжектили `/effort <level>` и через `fs.watch` ждали появления wrapper-записи в JSONL → стирали её + paired `<local-command-stdout>` в течение 0.5-1 секунды. Если юзер писал первый prompt **позже** чем cleanup отработал (40+ секунд на медленном старте) — Claude TUI записывал prompt с `parentUuid` указывающим на **только что удалённый** wrapper → orphan, красная зона в Timeline. Конкретный repro 2026-05-23: сессии `8f0a0b48`, `cb2e4c26`, `09351b71`, `e4be2fe0` все получили phantom-parent ровно этим путём. Лечится не «продлением жизни watcher'а», а **полным удалением cleanup'а** — wrapper остаётся в JSONL, Timeline всё равно его не рендерит через существующий tag-filter (`<command-name>` skip в `parseTimelineEntries`). См. [`fact-claude-tui-control.md::EffortInject — wrapper остаётся в JSONL`](fact-claude-tui-control.md), [`methodology/переносимый-дизайн.md::Не модифицируй чужой shared append-only файл во время работы владельца`](../methodology/переносимый-дизайн.md).

Anthropic знает о проблеме (issues открыты 5+ месяцев), **release notes не содержат fix**. Сообщество живёт на external repair tools ([`ymonster/cc_jsonl_fix`](https://github.com/ymonster/cc_jsonl_fix), [`wellofspirit/ClaudeUI`](https://github.com/wellofspirit/ClaudeUI), [`mantra.gonewx.com`](https://mantra.gonewx.com)). **Откат на старую версию НЕ помогает** — баг во всех 2.1.x.

---

## 2. Четырёхслойная защита (наша)

### Слой 1: Boot-time AutoRepair
`main.js::app.whenReady()` через 3 секунды после старта сканирует все `~/.claude/projects/**/*.jsonl` с mtime ≤ 14 дней, ищет orphan parentUuid и переписывает на UUID физического предшественника в файле. Atomic rename через `.tmp + os.rename()`. Backup создаётся как `<file>.autorepair-<unix-ts>`. Лог: `[Startup:AutoRepair] DONE pid=N scanned=M sessionsFixed=K totalDanglingRepaired=N`.

В renderer летит IPC `jsonl-auto-repair:summary` → info-toast «Auto-repair при старте: починили N orphan parentUuid в M сессиях» (только если `sessionsFixed > 0`).

**Пример работы (2026-05-23 12:38:27).** После `build:install` рестарта (sessions с накопленными phantom'ами от EffortCleanup race — см. источник #4 выше) Startup:AutoRepair прошёл по 1421 JSONL, нашёл 4 сессии с orphan'ами и переписал их за 5 секунд:

```
[JsonlAutoRepair] session=8f0a0b48 orphanUuid=0b37d2b7 missingParent=77717764 newParent=f50bef84
[JsonlAutoRepair] session=cb2e4c26 orphanUuid=0b37d2b7 missingParent=77717764 newParent=f50bef84  (форк от 8f0a0b48)
[JsonlAutoRepair] session=09351b71 orphanUuid=0c3ec535 missingParent=d3ae01f0 newParent=87e7245c
[JsonlAutoRepair] session=e4be2fe0 orphanUuid=085bb7f6 missingParent=4b8ba97e newParent=a8692617
[Startup:AutoRepair] DONE scanned=1421 sessionsFixed=4 totalDanglingRepaired=4
```

Юзер сразу после рестарта открыл вкладки — Timeline показал полную историю без красных зон. Phantom-источники типов 1-3 (Anthropic-side) автоматически чинятся таким же путём — слой остаётся актуальным даже после устранения нашего собственного источника #4.

### Слой 2: Pre-resume hook
В `App.tsx` AutoResume effect перед отправкой `claude --resume <sid>` в PTY вызывает `claude:repair-jsonl-before-resume` IPC → `repairJsonlChainBreaks(sessionId, cwd)`. Файл латается на лету **прежде чем Claude CLI его прочитает**. Если `repaired > 0` — info-toast «Перед открытием сессии починили N orphan parentUuid — без этого Claude обрезал бы историю».

### Слой 3: Live Timeline recovery
`claude:get-timeline` и `claude:get-full-history` в `claude-data.js` при backtrace натыкаются на missing UUID → прыжок на physical predecessor в том же файле (`_fromFile` + `_fileIndex - 1`). Также **compact passthrough** для случая когда `compact_boundary` имеет dead-end `logicalParentUuid` (указывает в уже посещённый узел) — прыгаем на физического предшественника compact'а, чтобы добраться до pre-compact истории. См. [`fact-backtrace-jsonl.md::2.3 Compact passthrough`](fact-backtrace-jsonl.md).

UI помечает зону до boundary красным фоном (`isChainBreakZone`), показывает оранжевый persistent toast при появлении нового boundary UUID. См. [`fact-timeline.md::Chain-break zone`](fact-timeline.md).

### Слой 4: Manual repair script
`scripts/orphan-repair/repair_orphans.py` для накопленного долга на сессиях, не открытых давно. Dry-run по умолчанию, `--apply` для записи. Атомарный rename + backup. `repair_current_session.sh` — обёртка с `lsof`-guard для активной сессии (не патчит если Claude CLI держит fd).

---

## 3. Что не покрыто и почему

**Live-chain-break в открытой сессии** залатать нельзя — Claude CLI держит fd на файл, atomic rename создаст новый inode, Claude продолжит писать в старый. Pre-resume hook покрывает только **момент** перед открытием сессии. Если в течение работы появился orphan — он зафиксируется при следующем закрытии-открытии вкладки.

**`/compact` race с rate-limit (#40352)** — это destructive corruption на стороне Claude (стирает content перед summary API call), recovery невозможен. Из защит только: не делать `/compact` при шатком интернете.

**`file-history-snapshot` collision** — отдельный класс corruption (snapshot uuid дублирует message uuid). У нас `fileCheckpointingEnabled: false` в `settings.json`, эта ветка не триггерится. Если включена — нужен дополнительный repair pattern (см. ymonster/cc_jsonl_fix).

---

## 4. Связанные правила

- [`methodology/переносимый-дизайн.md::Bug в зависимости = не откатываться, а workaround`](../methodology/переносимый-дизайн.md) — общий принцип защиты от внешних bug'ов.
- [`methodology/переносимый-дизайн.md::Multi-writer corruption на общий файл`](../methodology/переносимый-дизайн.md) — почему наш код больше не пишет в Claude JSONL автоматически (EffortInject kill-switch).
- [`methodology/переносимый-дизайн.md::Graceful exit через Ctrl+C, не SIGTERM первым`](../methodology/переносимый-дизайн.md) — почему все наши kill-paths теперь шлют `\x03` перед SIGTERM.
- [`fix-claude-busy-detection.md::3b Graceful Ctrl+C`](fix-claude-busy-detection.md) — конкретика kill-paths.
- [`fact-claude-tui-control.md::EffortInject kill-switch`](fact-claude-tui-control.md) — `effort=none` отключает единственный наш автоматический writer в Claude JSONL.

### Forensic grep
```bash
# Все orphan-починки и их источники
grep -E "Startup:AutoRepair|JsonlAutoRepair|JsonlChainDiag:ChainBreak|McpReconnect" \
  ~/Library/Logs/noted-terminal/production.log

# Graceful Ctrl+C события
grep -E "GracefulCtrlC|exited gracefully via Ctrl\+C|Ctrl\+C ignored" \
  ~/Library/Logs/noted-terminal/production.log
```
