# Fix: Claude hook bridge silent-dropout при двух инстансах

## Симптомы

- Юзер открыл прод, в нём запущена Claude в Claude-табе. Параллельно где-то запущен dev (через `npm run dev` или MCP-агентом). Лоадер в проде висит 10+ минут после того как Claude давно закончил ответ, hook script fires Stop через ~5с после прихода последнего ответа но app-side в `production.log` нет `[ClaudeHook] Stop ...` строки.
- `+grab` в проде показывает красный toast `Helper never reported back — check ~/.claude/hooks/noted-code-grab.js` несмотря на то что `/tmp/noted-grab-helper.log` показывает helper отработал и `outcome=acked_0ms`.
- `system:dump-claude-state` показывает `claudeTurnBusy=true` для активного Claude-таба, `lastHookEvent.ageMs > 600000`. Никаких visible ошибок ни в renderer'е, ни в main.
- Через какое-то время «само проходит» — обычно когда один из инстансов закрыли или 60-минутный `CLAUDE_TURN_WATCHDOG_MS` сработал safety net'ом.

## Root cause: четыре слоя одной проблемы

Все четыре проявлялись поочерёдно одной и той же сессии — каждый фикс предыдущего слоя обнажал следующий.

### Слой 1: один socket-путь, два listener'а

`/tmp/noted-terminal-claude-hook.sock` был фиксированный на оба инстанса. Каждый main при `startClaudeHookServer` делал `try { fs.unlinkSync(SOCK) } catch {}` перед `listen()` — паттерн «удаляю свой stale-файл от прошлого запуска». Когда dev запускался после прода, **unlinkSync удалял живой socket прода**. Прод-`net.Server` остался держать inode на удалённый путь — клиенты по новому inode попадали к dev'у, по старому inode (если каким-то образом сохранился ref) — никуда. Hook script всегда видел `connect` успешным потому что dev принял, но dev не имел маппинга `session_id → tabId` (Claude же запустила прод) → `(no tab match)` → silently ничего не делал.

**Фикс — per-PID socket:** `/tmp/noted-terminal-claude-hook-<pid>.sock` уникален для каждого инстанса. Никто никого не перетирает. Дополнительно главный main публикует свой socket в `~/.noted-terminal/claude-hook-<pid>.json` с `{sock, pid, openProjectPaths, updatedAt}` — discovery для клиентов.

### Слой 2: legacy socket вернул баг через заднюю дверь

После Слоя 1 написал legacy listener: «для обратной совместимости со старыми hook-script'ами, ещё биндим `/tmp/noted-terminal-claude-hook.sock`». Сделал `try { unlinkSync } catch {} → legacyServer.listen(path)`. Это **снова #83**: dev стартует вторым, unlink удаляет прод-владельца легаси-пути, дев захватывает; прод-legacyServer уже listening, на него никто не приходит, дев-legacyServer ловит всех старых клиентов.

**Фикс — probe-before-unlink:** при EADDRINUSE на listen не делать unlink unconditional. Сначала probe: попытаться connect к этому пути. Если connect succeeds → сосед жив, оставляем путь ему. Если connect fails с `ECONNREFUSED` → socket file orphan (listener мёртв) → safe to unlink + retry listen. См. переносимый принцип `methodology/дизайн-принципы.md::Probe-before-unlink на shared paths`.

### Слой 3: cwd-routing не разрешает tie

После слоёв 1-2: hook-script знает что есть N инстансов, читает их discovery, делает longest-prefix match своего `cwd` (передан в payload) против `openProjectPaths` каждого. Когда у dev и prod **один cwd открыт** (`/Users/fedor/Desktop/custom-terminal`) — match длины одинаковый, tie не разрешён детерминированно. В loop'е выигрывает тот, кто оказался последним при `sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0))`. Юзер видит: Claude'ом в проде, hook идёт в dev, app-side прода логи пустые.

**Фикс — env-pinned routing:** Claude PTY env инжектим `NOTED_MAIN_PID=<process.pid>` именно того main'а, который spawn'ит этот Claude. Hook-script читает env, `pickInstance` смотрит priority order:
1. `NOTED_MAIN_PID` → ищет инстанс с этим PID, found → return immediately.
2. cwd longest-prefix — fallback когда env hint отсутствует (сторонние tool'ы из `/tmp`).
3. mtime — последний рубеж.

См. `methodology/дизайн-принципы.md::ID-pinned routing > cwd-routing`.

### Слой 4: lock-файл noted-grab-<claudePid>.json не указывал sock

Параллельный канал — `claude:grab-input` IPC из renderer'а пишет lock-файл по claudePID, затем шлёт Ctrl+G в PTY. Helper (`noted-code-grab.js`) запускается из-под Claude, читает lock, шлёт `GrabInput` envelope в **какой-то** socket. Sock-resolution был тем же что у turn-event-script'а (env priority → cwd → mtime).

Но **lock-файл всегда написан тем main'ом, который слал Ctrl+G**. Этот main и владеет `grabInputPending` Map с ожидающим Promise. Helper-script — единственный канал ответа. Если helper отправит в чужой main, чужой main acked + ничего не сделал, оригинальный main timeout'ит 3000ms → `editor_not_wired` toast.

**Фикс — sock в lock-payload:** main пишет `{mode, ts, sock: CLAUDE_HOOK_SOCK}` в lock. Helper читает lock, видит `sock`, connect ровно туда — **никакой cwd-discovery не нужен**. cwd-routing остаётся fallback для passthrough mode (без lock).

## Параллельный фикс: app-level ack для всего hook bridge

При раскопках Слоя 1 заметили в hook-script logs `outcome=sent` ~65 раз vs `[ClaudeHook] ...` ~9 раз в production.log за одно окно. Script видел kernel `client.write()` callback как success — а server-side `sock.on('data')` НЕ срабатывал. То есть OS принял bytes в accept queue, никто их не прочитал; для script'а различие незаметно.

Добавили двусторонний ack: server отвечает `ok\n` после **парсинга** envelope. Script читает ack — `outcome=acked_<latency>ms`. Если ack не пришёл за 150ms — `sent_no_ack` (server alive but reading-broken), за 250ms total — `timeout_250ms`. Теперь log'и helper-script'а различают:
- `acked_0ms` — все четыре слоя работают, message доехал.
- `sent_no_ack` — bytes ушли в kernel, server не парсит (был силент-dropout в Слое 1).
- `sock_err:ECONNREFUSED` — orphan socket file, listener мёртв.

См. `methodology/дизайн-принципы.md::App-level ack для silent socket transports`.

## Observability добавили в main

- `[ClaudeHook:Conn] open seq=N` / `close seq=N bytes=X lines=Y dur=Zms` — lifecycle на каждое connection. Diff `connections - logged events` мгновенно показывает silent-drop в Слое 1.
- `claudeHookConnSeq` + `claudeHookEventSeq` — running counters.
- `setInterval` 30с пишет `[ClaudeSnapshot] tabs=N Δconn=A Δevent=B totalConn=X totalEvent=Y | <per-tab>` с `claudeTurnBusy / claudeSpinnerBusy / lastHookEvent.ageMs`. **Δevent=0 при Δconn>0** = доказательство silent-dropout: коннекты приходят, но события не парсятся.
- `claudeHookLastEvent: Map<tabId, {event, ts, sessionId}>` — last-seen для dump'а и snapshot'а.
- `system:dump-claude-state` теперь включает `_hook: { connSeq, eventSeq, sockPath, serverAlive }` и `lastHookEvent.ageMs` per-tab.

## Code map

- `src/main/main.js::startClaudeHookServer()` — per-PID socket + legacy probe + ack-write.
- `src/main/main.js::bindLegacyHookServer()` — try-listen + probe-on-EADDRINUSE + orphan-unlink + retry.
- `src/main/main.js::writeClaudeHookDiscovery()` — `~/.noted-terminal/claude-hook-<pid>.json` после `listen()` callback.
- `src/main/main.js` shell env: `NOTED_MAIN_PID=process.pid` инжектится в Claude PTY рядом с `EDITOR=noted-code-grab.js`.
- `src/main/main.js::captureClaudeInput` — lock-файл теперь содержит `sock: CLAUDE_HOOK_SOCK`.
- `~/.claude/hooks/noted-turn-event.js::pickInstance` — priority: env PID → cwd → mtime.
- `~/.claude/hooks/noted-code-grab.js` — sock из lock-payload (если есть), иначе `resolveSockByCwd` (с тем же env priority).

## Что пробовали и почему отбросили

- **Полностью убрать legacy listener** — старые hook-script'ы в кэше юзеров продолжали бы пытаться connect на фиксированный путь, ловили бы `ENOENT`. Probe-and-claim сохраняет совместимость без preempt.
- **Использовать abstract socket path** (`@noted-terminal-hook`) — Linux-only, не работает в macOS.
- **Один shared socket с auth-token routing** — добавляет state, нагружает server-side routing, не решает Слой 4 (lock-файл всё равно должен указать кому ответить).
- **Передавать `mainPid` в каждом hook-payload через `--add-headers`** — Claude Code hook'и не принимают custom CLI args, только stdin JSON. Env var — единственный inheritance channel.

## Связанные

- `fact-claude-stop-hook.md` — общая архитектура hook → socket → renderer.
- `fact-mcp-routing.md::Priority order` — тот же env-hint паттерн в MCP HTTP server.
- `fact-prompt-queue.md::Lock-file dispatcher` — grab/copy/clear modes и роль sock-field.
- `methodology/дизайн-принципы.md::ID-pinned routing > cwd-routing` — переносимый принцип.
- `methodology/дизайн-принципы.md::Probe-before-unlink на shared paths` — переносимый принцип.
- `methodology/дизайн-принципы.md::App-level ack для silent socket transports` — переносимый принцип.
