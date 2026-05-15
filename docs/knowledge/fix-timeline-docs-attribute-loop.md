# Fix: Docs-attribute look-ahead loop breaks on tool_result

## Symptoms
- User-prompt dot on Timeline stays default colour even when Claude clearly edited files in `docs/` or `CLAUDE.md` during that turn (no green `#4ade80`, no lime `#bef264`).
- Cmd+hover tooltip on the same dot does NOT show the green «Docs updated» block, although git status / file mtimes confirm the edits did happen during that user-turn.
- Symptom is *position-dependent*: prompts that resulted in a single Edit before any Read/Bash get the green colour; prompts that started with Read/Grep and edited files later in the same turn stay grey.
- Affects both `docsEdited[]` (green) and — to a lesser extent — `docsSearchQueries[]` (lime), but the search list is usually populated because `docs_search` typically fires before any Read.

## Root cause
`claude:get-timeline` in `src/main/ipc/claude-data.js` walks the active branch forward from each user entry and aggregates `Edit`/`Write` file paths and `mcp__knowledge__docs_search` queries from the assistants that follow, attaching them to the originating user-entry as `docsEdited[]` / `docsSearchQueries[]` (per `fact-timeline.md::Docs-индикаторы как атрибут user-entry`). The loop terminated on the FIRST entry with `type === 'user' && !isSidechain`.

But in Claude JSONL **`tool_result` entries also have `type: 'user'`** (the runtime models tool replies as user-side messages). So the loop broke at the first tool_result — usually right after the first Read — and any `Edit`/`Write` blocks emitted by later assistants in the same turn were silently skipped.

Concrete example from session `8c7805a5-4bb9-4bfb-85f6-ca8e9b156b66`, prompt «применяй» (active-branch idx 1974):
- Backend loop broke at idx 1977 (3 entries away) on a `tool_result` from the first `Read`.
- Real next user prompt was at idx 2035 (61 entries away).
- 6 `Edit`/`Write` calls into `docs/`/`CLAUDE.md` lived in the gap → all dropped → dot stayed grey.

This is the same forward-expand trap documented for edit-range cleanup (see `fact-timeline.md::Forward-expand ловушка`) — the fix was applied there, but the docs-attribute loop kept the old guard.

## Fix
Replace the bare break with a real-user check (matches the `removedUsers` accounting nearby in the same file at ~line 1163):

```js
if (next.type === 'user' && !next.isSidechain) {
  const nc = next.message?.content;
  const isToolResult = Array.isArray(nc) && nc.some(b => b && b.type === 'tool_result');
  const ncStr = typeof nc === 'string' ? nc : '';
  const isTaskNotif = ncStr.startsWith('<task-notification>');
  if (!isToolResult && !isTaskNotif) break;
}
```

Two filters needed:
- `tool_result` (array content with `type:'tool_result'` block) — fires constantly, every Read/Edit/Bash reply.
- `<task-notification>` (string content starting with the tag) — sub-agent auto-messages; without this guard, sub-agent-heavy turns (Gemini orchestration) also truncate early.

The same `responseTokens` / `responseModel` / `responseHasThinking` accumulators in the same loop were already unaffected — they only read assistant entries — so the bug was localised to docs-attribute collection.

## Why this hid for so long
- Many user prompts result in a single edit before any tool_result (e.g. small one-line patches). For those, the broken loop and the correct loop produce identical output → the green dot appeared, masking the bug for a class of prompts.
- The grey-dot symptom looks like «Claude just didn't touch docs this turn» — a *plausible* state, not an obvious bug. Discovered only by cross-checking JSONL contents against Timeline visuals on a known-edit prompt.

## Related
- `fact-timeline.md::Docs-индикаторы как атрибут user-entry` — feature spec, colour rules, tooltip layout.
- `fact-timeline.md::Forward-expand ловушка` — same trap, applied to edit-range orphan cleanup.
- `claude-data.js:~1163` — pre-existing real-user filter for `removedUsers` accounting; the canonical pattern for «is this a real user prompt or a tool/notification».
