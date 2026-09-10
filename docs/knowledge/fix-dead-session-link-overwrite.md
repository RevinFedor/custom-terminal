# Fix: Dead session_links → Timeline overwrites store with non-existent UUID

## Symptoms
- Manual ✎ replace session ID accepted, store updates, then within ~1-2 seconds reverts to a different UUID by itself — user's input never sticks.
- Timeline becomes empty (0 entries) right after the StatusLine Bridge captured a fresh sessionId. Dev log shows the freshly-bound id immediately overwritten: `[Timeline:ChainResolve] OVERWRITE session ... 047792b1 → c4fae19d (Timeline resolved chain)` followed by an endless loop of `[SessionChain] File not found for: c4fae19d` / `[Timeline:Backtrace] No lastRecord for session: c4fae19d`.
- Running `claude --resume <uuid>` from inside the app via UI buttons works, but the right sidebar / Timeline drifts to an unrelated UUID that has no `.jsonl` on disk — only a stray subagent directory of the same name.
- After fork-flow inside Claude TUI (`/btw + F`), the new fork lives correctly in its own JSONL, but Timeline of the **parent** session keeps trying to «resolve forward» to a dead descendant for the rest of the session lifetime.

## Root cause
Three independent pieces conspired:

1. **Subagent fork-flow creates `<uuid>/subagents/` directories** under `~/.claude/projects/<slug>/`, not JSONL files. Looks like a session UUID, but `<uuid>.jsonl` never exists.
2. **`saveSessionLink(parent, child)` in `database.js`** writes any sessionId rotation Bridge observes into the `session_links` SQLite table — without checking the child has a real `.jsonl` on disk. After enough subagent runs, the table fills with rows pointing at directories.
3. **`resolveLatestSessionInChain` (claude-data.js)** walks the chain forward via `getSessionChild()` and returns the **tip** UUID to the renderer as `latestSessionId`. Timeline compares to current `sessionId`, sees mismatch, calls `useWorkspaceStore.setClaudeSessionId(tabId, <dead-uuid>)` — overwriting whatever the user just typed in ✎ or whatever Bridge just established.

The combination is silent: each individual write looks correct in isolation, but the chain resolves to a UUID that never had a JSONL. Next poll cycle reads from disk, fails, but the store stays poisoned because nothing rechecks liveness.

## Production audit (2026-05-15)
In a real user DB (`noted-terminal.db`): 45 rows in `session_links`, **44 of them dead** — child UUID existed only as a directory. Going back at least to 2026-03 (oldest survivor stamp). Every time the user opened a parent session from those rows, Timeline silently rerouted to nothing. Manual ✎ edits «flapped back» because the next 2s Timeline poll re-applied the dead child.

## Fix
Three layers, all with `findSessionFile(uuid, cwd)` as the liveness probe (it returns `null` when no `<uuid>.jsonl` is found anywhere under `~/.claude/projects/`).

**1. `database.js::saveSessionLink`** — refuse to insert a row whose child has no JSONL:
```js
if (!_sessionUuidHasJsonlFile(childId)) {
  console.warn('[DB] saveSessionLink: SKIPPING dead child', childId.substring(0, 8), '(no JSONL file — likely subagent directory)');
  return;
}
```
Helper `_sessionUuidHasJsonlFile` is module-level (avoids circular require with `claude-data.js`) and scans `~/.claude/projects/*/<uuid>.jsonl` with `fs.statSync().isFile()`.

**2. `claude-data.js::resolveLatestSessionInChain`** — when consulting `getSessionChild()`, verify the candidate before walking into it:
```js
const sqliteChild = _projectManager.db.getSessionChild(currentId);
if (sqliteChild && !visited.has(sqliteChild)) {
  if (!findSessionFile(sqliteChild, cwd)) {
    console.warn('[SessionChain] SQLite forward link →', sqliteChild.substring(0, 8), 'has no JSONL on disk — skipping (dead link)');
    break;
  }
  currentId = sqliteChild;
  continue;
}
```

**3. `claude-data.js::resolveSessionChain`** — same guard for the backward chain (`getSessionParent`). Defensive: prevents future fallout if a dead parent ever appears.

**4. One-time cleanup of the live DB:**
```bash
# (Backup made automatically: noted-terminal.db.backup-<timestamp>)
sqlite3 noted-terminal.db "SELECT child_session_id FROM session_links;" | \
  while read child; do
    if ! find ~/.claude/projects -maxdepth 3 -name "${child}.jsonl" -type f | grep -q .; then
      sqlite3 noted-terminal.db "DELETE FROM session_links WHERE child_session_id = '$child';"
    fi
  done
```
On the affected machine: 44 dead rows deleted, 1 valid survived (`ef421728 → 8f8623dc`, both confirmed JSONL).

## Debugging path (why it took several gestures)
1. First suspicion: Sniper Watcher picked the wrong file → false. Sniper logs show the correct UUID captured.
2. Second: StatusLine Bridge wrote a foreign sessionId → false. `[Bridge] Tab ... -> session: 047792b1` is right.
3. Third (correct): grep `production.log` for the suspect UUID `c4fae19d` shows the smoking gun pair — Bridge wrote `047792b1`, then 60ms later `[Timeline:ChainResolve] OVERWRITE` flipped it to `c4fae19d`. Only the **Timeline** path had write authority via `latestSessionId` round-trip.

Pattern to remember: when two writes for the same store key happen within 100ms and the second wins, log the **caller stack** for `setClaudeSessionId` (already done — store logs `caller=` from `new Error().stack`). The caller fingerprint distinguishes Bridge from ChainResolve from manual ✎ instantly.

## Why we don't disable `latestSessionId` overwrite outright
The mechanism is legitimately useful for Clear Context chains: parent session ends with a bridge entry pointing into child JSONL, Timeline forwards to the child so the user keeps reading without manual tab-switch. Removing the forward-walk would break that flow. The guard preserves the feature for valid chains and short-circuits only when the chain points into the void.

## Related
- `fact-session-detection.md::Dead session_links + chain resolve trap` — short user-facing description and link back here.
- `fact-session-capture.md::Manual session ID entry (✎)` — why the manual edit «flapped» before this fix.
- `methodology/дизайн-принципы.md::Cached external resource: alive-probe перед использованием` — same family of bug (cached cross-process/cross-DB reference that outlived its referent), here applied to SQLite `session_links` table rather than PID cache.
