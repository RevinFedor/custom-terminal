# Факт: Claude Code Stop hook → Unix socket → main process

## Проблема
Нужен **детерминированный** сигнал конца turn'а Claude Code (CLI). Эвристики на PTY (исчезновение спиннера `✢`, появление `╰` в инпут-боксе) ненадёжны: внутри одного turn Claude может думать → вывести текст → снова думать → вызвать tool → снова думать → финальный текст. Spinner gone после первой thinking-фазы ≠ конец turn'а.

## Решение
**Stop hook** Claude Code — единственный officially-документированный сигнал, fired ровно один раз на полный turn (после всех tool rounds). Источник в декомпиле: `packages/claude-code-src/query.ts:1062` — `handleStopHooks` вызывается только когда `!needsFollowUp` (model API call вернул без новых `tool_use` блоков).

### Архитектура

```
[Claude turn ends inside query.ts loop]
       ↓ fork() child process
[node ~/.claude/hooks/noted-turn-event.js]
       ↓ читает JSON со stdin
       ↓ resolveSock(): NOTED_MAIN_PID env → cwd-discovery → legacy fallback
       ↓ Unix socket connect
[/tmp/noted-terminal-claude-hook-<pid>.sock — net.Server в Electron main]
       ↓ парсит JSON, write "ok\n" обратно (ack)
       ↓ lookup session_id → tabId через bridgeKnownSessions
[mainWindow.webContents.send('claude:turn-state', ...)]
       ↓
[Renderer InfoPanel / Loader]
```

Per-PID socket путь означает что каждый main listens на свой `claude-hook-<pid>.sock` и публикует его в `~/.noted-terminal/claude-hook-<pid>.json` discovery (`{sock, pid, openProjectPaths, updatedAt}`). Hook-script читает все живые discovery, выбирает инстанс через priority: env `NOTED_MAIN_PID` (Claude PTY env пишется тем main'ом что spawn'ил Claude) → longest-prefix cwd match → most-recent updatedAt. Legacy `/tmp/noted-terminal-claude-hook.sock` тоже биндится «вторым server'ом» через try-listen + probe-before-unlink, для совместимости со старыми hook-script'ами без discovery-логики. Сервер на каждое envelope пишет `ok\n` обратно — script-side выходит с `acked_<latency>ms` outcome. Latency обычно 0-1ms; `sent_no_ack` за 150ms = read-path сломан, `sock_err` = listener мёртв. См. [`fix-claude-hook-silent-dropouts.md`](fix-claude-hook-silent-dropouts.md).

### Зарегистрированные события

В `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "Stop":               [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "StopFailure":        [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "PreToolUse":         [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "PostToolUse":        [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }],
  "PostToolUseFailure": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/noted-turn-event.js" }] }]
}
```

- **UserPromptSubmit** → `busy: true` (turn начался)
- **Stop** → `busy: false, success: true` (turn завершился успешно)
- **StopFailure** → `busy: false, success: false` (turn упал на API error: rate_limit / auth / server_error)
- **PreToolUse / PostToolUse / PostToolUseFailure** (matcher `AskUserQuestion`) → `claude:awaiting-input` `{awaiting:true|false}` — детерминированный бракет «Claude задал вопрос и ждёт ответа человека». Тот же скрипт, тот же сокет. PreToolUse(AskUserQuestion) = вопрос появился; Post*(AskUserQuestion) = ответил/отменил. Matcher гарантирует ноль спавнов скрипта на Read/Bash/Edit. Полная механика — [`fact-claude-awaiting-input.md`](fact-claude-awaiting-input.md).

### IPC payload в renderer

```ts
ipcRenderer.on('claude:turn-state', (_, data: {
  tabId: string;
  sessionId: string;
  event: 'UserPromptSubmit' | 'Stop' | 'StopFailure';
  busy: boolean;
  success: boolean;
  lastAssistantMessage: string | null;  // финальный текст ответа Claude (с v2.1.47)
}) => { ... });
```

## Детерминизм — эмпирическая проверка

Headless test через `claude -p "Read 3 files and summarize"`:
- 1 user prompt → 3 tool_use rounds (Read) → 1 финальный summary text
- В логе ровно **2 события**: UserPromptSubmit + Stop. Никаких промежуточных Stop между tool calls.
- Latency Stop hook → нашему сокету: < 5ms (Unix socket на localhost).

## Маппинг hook → tabId

Известный `session_id` из `bridgeKnownSessions` остаётся главным доказательством. Но у fresh Claude первый `UserPromptSubmit` и даже короткий `Stop` могут прийти раньше StatusLine/JSONL-привязки. Для этого окна main использует только заранее доказанный Claude PID из process-tree конкретного PTY: PID резервируется после принятого launch и повторно проверяется непосредственно перед внешним Enter. После появления session binding маршрутизация снова идёт по `session_id`; неизвестный PID или уже закрытая вкладка не могут принять hook чужого Claude.

Эта ранняя привязка нужна не только loader'у. Без неё orchestration-run может получить `Stop`, не увидев собственного `UserPromptSubmit`, а первый completion prompt source-вкладки останется временной History-строкой рядом с уже записанной durable user-записью.

## Известные ограничения (по версии 2.1.x, май 2026)

1. **Silent tool stop / hook dropout** (bug #29881 class): turn может закончиться без `Stop` или hook-script может не добежать. **Mitigation:** main-process watchdog на `claudeTurnBusy`. С июня 2026 это не "жёсткий reset через 60 минут", а liveness-check: если Claude-процесс жив и есть свежий spinner-frame (<30s) или свежий `mtime` JSONL (<10min), watchdog продлевается ещё на 15 минут. Жёсткий `busy:false` остаётся только когда оба artifact-сигнала затухли.
2. **JSONL writes стопаются после auto-update mid-session** (#16, open). Не affects hook (hook fires из самого процесса), но affects JSONL fallback.
3. **`stop_reason: null` в JSONL** (#27361) — поле всегда null, нельзя tail'ить JSONL по нему. Hook — единственный надёжный канал.
4. **CLAUDE_CODE_NO_FLICKER=1** (с v2.1.89) — fullscreen mode, ломает ANSI-эвристики типа «появление `╰` в нижней строке». Stop hook этим не задет.
5. **Aborted streaming не fires hook** — путь `query.ts:1051` для user-initiated interrupt (Esc, Ctrl+C, submit-interrupt новым промптом во время стрима) возвращает `{ reason: 'aborted_streaming' }` **без вызова handleStopHooks**. Это намеренное поведение Claude, не баг (issues #29881, #17466). **Mitigation:** JSONL interruption watcher — `fs.watch` на сессионный JSONL, ищем запись `type:"user"` с `text:"[Request interrupted by user]"` (или `... for tool use` вариант), которую Claude гарантированно пишет на abort. Отдельно важно: spinner fallback после этого остаётся только эвристикой; его `claude:busy-state` идёт с `reason:'spinner'` и не должен использоваться как authoritative end-of-turn в автоматиках вроде PromptQueueRunner. См. [`fix-claude-aborted-streaming-loader.md`](fix-claude-aborted-streaming-loader.md) и переносимый принцип `methodology/переносимый-дизайн.md::Authoritative artifact > эвристика на input-side`.
6. **Multi-instance silent-dropout** — dev + prod одновременно открыли один cwd → hook events из прод-Claude'а попадали в dev silently (cwd routing tie не разрешался). Закрыто через per-PID socket + ack-протокол + `NOTED_MAIN_PID` env. Симптомы и полная цепочка из четырёх слоёв — [`fix-claude-hook-silent-dropouts.md`](fix-claude-hook-silent-dropouts.md).

## Hook script (`~/.claude/hooks/noted-turn-event.js`)

Минимальный node-скрипт: читает JSON со stdin, отправляет envelope в socket, exits с timeout 200ms. Fail-silent — если main не запущен (socket файла нет), всё равно exit 0 (Claude должен продолжить).

## Re-entrancy guard `stop_hook_active`

В payload приходит `stop_hook_active: true` когда Stop hook уже исполняется. Наш скрипт не возвращает `{"decision": "block"}` — то есть никогда не заставляет Claude continue, поэтому re-entrancy не происходит. Поле просто пропускается в envelope.

## Интеграция в claude:busy-state

Hook теперь **authoritative source** для loader'а. Поток:

```
UserPromptSubmit → claudeSpinnerBusy.set(tabId, true) + emit claude:busy-state busy=true
              ↓
Stop / StopFailure → cancel pending spinner-idle-timer
                  → claudeSpinnerBusy.set(tabId, false) + emit claude:busy-state busy=false
```

**Спиннер-детектор подавлен пока turn активен:**
- `claudeSpinnerBusy IDLE timer` проверяет `if (claudeTurnBusy.get(tabId) === true) return;` — не shipит false-IDLE между thinking phases.
- Это убирает классический баг "loader выключился после первой фазы".

**Watchdog 60 минут + продление по liveness:** safety net на silent-tool-stop (#29881), упавший hook script, killed claude process. На happy path у длинного turn'а он не должен ложно сработать: свежий spinner или свежий JSONL `mtime` продлевают окно ещё на 15 минут. Жёсткий `reason:'watchdog'` остаётся только когда и процесс, и артефакты затихли.

## Fresh-process detection — `claude:process-started`

`claude:session-detected` fires **на каждом bridge re-sync** (statusline-script у Claude дёргается раз в 1-2 секунды). Для одноразовых side effects типа auto `/effort` это плохо: session_id остаётся прежним при перезапуске Claude (`claude --resume <id>`), guard `if (currentId !== data.sessionId)` всегда `false` для перезапущенной сессии. Эффект — `/effort` инжектится только при первом запуске Claude в жизни таба, при перезапуске молча пропускается.

**Решение:** отдельный event `claude:process-started` fires когда `bridgePidCache` видит **новый Claude PID** для tab'а — это происходит ровно один раз на каждый реальный spawn процесса. PID меняется при каждом запуске binary, даже если sessionId тот же.

Renderer:
```ts
ipcRenderer.on('claude:process-started', (_, { tabId, sessionId, claudePid }) => {
  // Одноразовые side effects: auto-inject /effort, /think и т.п.
});
```

Использовать для всего что должно случиться **один раз на спавн** и которому нужен PID/sessionId: welcome-toast, регистрация в аналитике. **Не использовать** для отслеживания sessionId (для этого session-detected).

**`/effort` инжект больше НЕ висит на этом сигнале как на главном.** `claude:process-started` (= `Bridge:Fresh`) лагает 3-6с после старта Claude — bridge.json должен появиться, пережить DeadTranscript-guard (у свежей сессии JSONL ещё не на диске), затем PID зарезолвиться. За это время prompt в TUI уже нарисован; юзер видел готовую строку без effort'а и кликал руками → дубль. Главный сигнал для `/effort` теперь `claude:tui-ready` (Claude нарисовал `⏵` в PTY, ~0.8с), `process-started` оставлен **fallback'ом** под once-per-process sentinel. Полная механика — `fact-claude-tui-control.md::Auto-inject /effort`, принцип выбора сигнала — `methodology/переносимый-дизайн.md::Liveness ≠ readiness`.

## Prompt Queue — grab-input flow

`Ctrl+G` в Claude TUI → действие `chat:externalEditor` → Claude execSync'ом запускает `$EDITOR <tempfile>`. Мы инжектим `EDITOR=~/.claude/hooks/noted-code-grab.js` в env PTY-процесса.

Helper script:
1. Читает содержимое tempfile (с раскрытыми pasted-text refs)
2. Через тот же сокет шлёт `{event:'GrabInput', ppid, text}`
3. Truncate'ит tempfile в пустую строку
4. exit 0

Claude после нашего exit'а перечитывает файл → видит пустой input → инпут очищается.

**Маппинг ppid → tabId:** через `bridgePidCache` (заполняется SessionBridge'ем, Claude PID → tabId).

**Caveats:**
- Image attachments через editor всё ещё приходят как `[Image #N]` placeholder'ы, но это не plain text: main резолвит файл в `~/.claude/image-cache/<sessionId>/<N>.<ext>` и сохраняет image-slot рядом с History draft. Если файл найден, History показывает семантический `[Image #N]` и блокирует тихую отправку как обычного текста; если файл потерян, в draft остаётся явный `imageError`. Не возвращать поведение «просто вставить placeholder и считать prompt восстановленным».
- Имя скрипта **должно начинаться с "code"** (`noted-code-grab`) — Claude classifies basename: если содержит `code|cursor|windsurf|codium|subl|atom`, GUI-path (silent), иначе alt-screen flash. См. `editor.ts:20-30` в декомпиле.
- `getExternalEditor` в Claude **memoize'ан** — EDITOR должен быть установлен ДО spawn'а Claude. Существующие табы запущенные до изменения env не получат фичу до рестарта Claude процесса.
- `getExternalEditor` проверяет `VISUAL` ПЕРЕД `EDITOR` — мы инжектим оба для надёжности.
