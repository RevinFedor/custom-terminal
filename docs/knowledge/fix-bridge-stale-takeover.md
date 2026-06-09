# Fix: Stale ~/.claude/bridge/*.json takeover — wrong sessionId stamped on freshly resumed tab

## Symptoms

- User opens app, AutoResume re-launches `claude --resume <correctSessionId>` for an
  interrupted tab. Within ~2 seconds the tab's `claudeSessionId` silently flips to a
  completely different UUID. Timeline tries to load the new one, fails with
  `[SessionChain] File not found for: <foreignSid>` and `[Timeline:Backtrace] No
  lastRecord for session: <foreignSid>`.
- The "wrong" UUID often belongs to a session the user worked on **weeks or months
  earlier** — same project root or a parent directory.
- Subsequent in-app actions (Continue button, manual `claude --resume <X>`) keep
  drifting the tab's sessionId between several historical UUIDs before the user gives
  up. SQLite persists each drift; after the next restart AutoResume fires with the
  poisoned value.
- Inverse failure mode (CwdGuard too strict): tab "knows" no session at all after
  restart. `production.log` shows `[Bridge:Fresh]` for the tab but no follow-up
  `[Bridge] Tab ... -> session: <sid>` and no `[Store:setClaudeSessionId]` on the
  renderer side. PTY was created in cwd `A` but user `cd`'d to `B` inside the shell
  before launching claude. See [`fix-cwdguard-session-not-detected.md`](fix-cwdguard-session-not-detected.md).

## Concrete incident (2026-05-18)

Tab «мобилка» (custom-terminal, `tab-524`, cwd `mobile-web/`) was on session
`e4969482` for 5 hours of dictation work. App was killed at 17:25:27 UTC; tab
correctly persisted as `wasInterrupted=true, claudeSessionId=e4969482`. New process
started at 17:26:37 UTC; AutoResume wrote `claude --resume e4969482\r` to the new
PTY at 17:26:38.834 UTC.

1.073 seconds later at **17:26:39.887 UTC** SessionBridge fired
`[Bridge:Fresh] tab=tab-524 claudePid=11565 session=284faa4c`. The bridge
JSON `~/.claude/bridge/284faa4c-...json` had `updated_at: 1772271214`
(**2026-02-28 09:33:34 UTC — 2.5 months earlier**) and pointed to a JSONL that
no longer existed on disk. PID 11565 happened to resolve via `ps -p` to a shell
PID matching the freshly-spawned tab-524 shell (PID reuse). `Bridge:CwdGuard`
saw `bridge.cwd=custom-terminal` vs `tabCwd=custom-terminal/mobile-web` —
related paths (one is ancestor of the other), so the guard let it through and
even overwrote `terminalProjects.set(tabId, bridge.cwd)`.

Result: `[R] [Terminal:Bridge] OVERWRITE session for tab tab-524: e4969482 → 284faa4c`
on the renderer side, persisted to SQLite. Real Claude CLI was still starting
(no JSONL yet) when bridge handler had already stamped the dead UUID. The user
saw Timeline error, hit Continue → AutoResume fired the now-poisoned `284faa4c`,
which failed too — and then user-typed `claude --resume <X>` x4 each picked a
random historical session, persisting each.

Lost work was recoverable only by grepping `production.log` for
`[Store:setTabCommandType] tab=-tab-524 claude=<id>` and finding the long run of
`e4969482` between 14:20 and 17:26 UTC.

## Root cause: three independent failures combined

1. **Claude CLI never deletes its bridge JSON files**. `~/.claude/bridge/<sid>.json`
   files accumulate forever — files months old sit next to live ones. Our scanner
   re-reads them on every fs.watch event and on every Electron startup.
2. **PID resolution had no liveness/identity check**. `processFile()` did
   `ps -p <bridge.ppid> -o ppid=` without inspecting the process command name and
   without checking `bridge.transcript_path` existence. On PID reuse (a new shell
   gets the recycled number) we silently match an ancient bridge to a fresh tab.
3. **CwdGuard's "path-prefix tolerance"** was too generous: any ancestor↔descendant
   match was accepted, AND on accept `terminalProjects.set(tabId, bridge.cwd)`
   would clobber the canonical tab cwd with the stale value, making subsequent
   checks even more lax.
4. **Renderer Bridge handler had no guard against AutoResume races**. The Bridge
   IPC event won unconditionally, even when AutoResume had just written
   `claude --resume <Y>` to the PTY but no live bridge file existed yet for `<Y>`.
5. **CwdGuard blocked `claude:session-detected` broadcast even for legitimate sessions**
   (added 2026-05-23). The unrelated-path branch did a blanket `return`, which prevented
   not only `terminalProjects.set` / `bridgeKnownSessions.set` (the real takeover
   vectors) but also the renderer broadcast that writes `Tab.claudeSessionId` to
   SQLite. Outcome: if PTY was created in cwd `A` but the user did `cd B` inside
   the shell before launching `claude`, the renderer never learned the sessionId.
   Across `build:install` restart the tab restored with `claudeSessionId=null`,
   AutoResume couldn't fire, the tab lost its session. Fix lives in
   [`fix-cwdguard-session-not-detected.md`](fix-cwdguard-session-not-detected.md):
   emit `session-detected` once per new sessionId even on CwdGuard refusal, but
   keep main-side caches untouched.

## Fix (5 layers, all required)

### 1. `src/main/main.js::processFile` — liveness checks

Before resolving PID:

```js
// Transcript existence
if (data.transcript_path && !fs.existsSync(data.transcript_path)) {
  console.warn('[Bridge:DeadTranscript] ...'); return;
}
// updated_at freshness (10 minutes)
const nowSec = Math.floor(Date.now() / 1000);
if (typeof data.updated_at === 'number' && (nowSec - data.updated_at) > BRIDGE_STALE_SECONDS) {
  console.warn('[Bridge:StaleSkip] ...'); return;
}
```

Both warnings are deduped via module-level `bridgeStaleLogged` Set — one per file,
forever. Avoids log spam.

### 2. `src/main/main.js::processFile` — command-name validation

Replace blind `ps -p <ppid> -o ppid=` with `ps -p <ppid> -o ppid=,command=` and
reject if the command line doesn't contain `claude`. Protects against PID reuse
where a random non-claude process got the recycled number.

### 3. `src/main/main.js::processFile` — never overwrite terminalProjects on cwd drift

Remove the `terminalProjects.set(tabId, data.cwd)` inside the path-prefix branch.
Accept the bridge event for THIS update only, but keep the canonical tab cwd
intact so subsequent checks remain strict.

### 4. `src/renderer/utils/pendingResume.ts` (NEW) + Terminal.tsx + App.tsx

Module-level Map `tabId → {sessionId, at}` populated by every code path that
fires `claude --resume <X>`:

- AutoResume (`App.tsx` ~L1244)
- Direct user `claude --resume X` interception (`Terminal.tsx` Case 5 + Case 2)
- Fork flow (`Terminal.tsx` claude-f handlers)
- Mobile-initiated Resume (`App.tsx::handleWebBridge::resumeClaudeTab`) — фон от phone тоже шлёт `claude --resume` в PTY и обязан помечать, иначе stale bridge stomp'нет sessionId на mobile-resumed табе. См. `fact-mobile-claude-pty.md::Resume guard rails`.
- **Continue chip** (`ClaudeControlBar.tsx::onContinue`, `claude-c`) — SessionActionChip.
- **Interrupted-overlay Continue** (`TerminalArea.tsx::handleContinueSession`).
- **Resume-all** (`ProjectToolbar.tsx::handleResumeAll`) — bulk, высокий blast-radius (N табов разом).

⚠️ **Ловушка (горело — pty-streaming audit 2026-06):** изначально пометить `markPendingResume` помнили только автоматические/typed пути; **три UI-кнопки Continue/Resume** (чип, overlay, resume-all) писали `claude --resume` БЕЗ пометки → guard их не защищал, и ровно сценарий этого инцидента (stale bridge → OVERWRITE на мёртвый sessionId → `[SessionChain] File not found`) воспроизводился через них. Правило абсолютное: **любая** новая affordance, дергающая resume (UI-кнопка, hotkey, IPC, mobile) — первой строкой `markPendingResume(tabId, sessionId)`, до `terminal:input`/`claude:run-command`.

`Terminal.tsx::handleSessionDetected` consults `isStaleAgainstPending(tabId, incoming)`
before writing — drops bridge events whose sessionId disagrees with the in-flight
resume for 15 seconds. On successful match (or after TTL) the flag is cleared.

**Второй потребитель guard'а — context-meter.** `ClaudeControlBar.tsx`'s
`claude:bridge-update` handler тоже консультирует `isStaleAgainstPending(tabId,
data.sessionId)` перед тем как показать/заперсистить model+%+cache. Без этого во
время resume-гонки чужая (мёртвая) сессия штамповала свой контекст-% на таб И
писала его в SQLite (`tab:persist-context-pct`) — Terminal.tsx отвергал чужой
sessionId-write, но meter всё равно врал. main шлёт `sessionId` в payload
`bridge-update` (main.js ~L1011) именно для этого. Плюс: live-кадр `contextPct === 0`
(sub-1% зафлоренный `cut -d. -f1`, или отсутствующее `.used_percentage` → jq `// 0`)
больше НЕ затирает известный ненулевой meter — `setContextPct` симметричен
`persistContextPct`'s `pct <= 0` guard.

### 5. `tabs.claude_session_history` column + history-aware setClaudeSessionId

- New TEXT column (JSON array, capped at 5 entries) — `{sessionId, reason, at}`
- `setClaudeSessionId(tabId, newSid, reason)` records the OUTGOING value before
  overwriting; `reason` is supplied by every caller from a sealed union
  (`bridge`, `autoResume`, `userIntercept`, `userManual`, `timelineChain`,
  `fork`, `restoredFromDb`, `userRevert`, `unknown`).
- TabBar right-click menu surfaces the history as "Revert Session ›" with each
  entry's sessionId + reason + relative time. One click writes back, recording
  the operation as `userRevert` in turn.

The user-facing UI is the line of defense if all four guards still let a wrong
write through.

## Why not a more aggressive refactor (e.g. a SessionService)

The audit (see commit history) showed 7 writers of `tab.claudeSessionId`. Five
of them are well-behaved domain operations with their own UX context (Timeline
chain, manual entry, fork, /status interception, restored-from-DB).
Only two conflict in practice: SessionBridge and AutoResume. A full
service+priority queue would impose ceremony on the five clean paths to fix the
two messy ones — net negative under SOLID's "no premature generalization".

If a sixth conflicting writer ever appears, the path forward is clear: this
file documents the contract and the guards live in one focused module each
(`pendingResume.ts`, `processFile`'s liveness probes).

## Verification

- Stale bridge file: `touch -d '2 months ago' ~/.claude/bridge/<sid>.json` →
  on next startup `[Bridge:StaleSkip]` once, never overwrites again.
- Dead transcript: rename the `<sid>.jsonl` while bridge.json still exists →
  `[Bridge:DeadTranscript]` once.
- Race: type `claude --resume A` then within 5 seconds simulate stale bridge
  event for `B` → renderer logs `[Terminal:Bridge] IGNORE stale session ...`.
- History UX: change session 3 times, right-click tab → "Revert Session" lists
  3 entries with correct reasons; clicking restores instantly.

## Related

- `fact-claude-sessions.md` — overall session detection architecture
- `fact-session-detection.md` — broader detection flow
- `fix-dead-session-link-overwrite.md` — sibling fix for the Timeline chain resolver
  (subagent-directory UUIDs in `session_links` table; same shape of "automated
  overwrite eats user state")
