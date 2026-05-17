# Fix: Forward-expand in claude:copy-range truncated at first tool_result

## Symptoms
- Selecting a range of two (or more) user messages on Timeline and clicking «Копировать» yields output that ends mid-turn — last line is a `tool_use` command (Bash/Grep/Read…) instead of Claude's final answer for that turn.
- Symptom is *position-dependent on the FINAL selected user-message's turn*: if Claude's first action in that turn is a `tool_use`, output stops right after it; if the turn starts with plain text and then runs tools, the leading text gets in but later tool output and final answer disappear.
- Range that spans across `/compact` (auto-compact) is most affected — user expects «from first message up to compact», receives only «first message + part of last selected turn».
- Single-point copy via ПКМ → «Копировать» does not exhibit the bug because backend forward-expand from a single user prompt is rarely interrupted by `tool_result` (single-point already worked by accident in many turns; multi-range exposes the tail of the LAST turn where tools are common).

## Reproduction (session 047792b1-658b-4bae-9945-fc444089e52f)
- Selected `USER 23:46 a4d92915…` and `USER 00:04 3e60b540…` (two prompts before auto-compact).
- Expected: full transcript from `a4d92915` up to `compact_boundary` (line 3909 in JSONL), including Claude's final «Применено: …» summary at line 3893.
- Got: transcript ending at line 3861 (`tool_use grep -nE "Toggle для expanded…"`) — Claude's 30+ subsequent assistant entries dropped, including the final answer with file applications.

## Root cause
`claude:copy-range` in `src/main/ipc/claude-data.js` performs a forward-expand from `maxIdx` to pull in all assistants and tool-results belonging to the LAST selected user prompt's turn. The original termination check was:

```js
if (entry.type === 'user' || (entry.type === 'system' && entry.subtype === 'compact_boundary')) {
  break;
}
```

But in Claude JSONL **`tool_result` entries are stored with `type: 'user'`** (the Anthropic runtime models tool replies as user-side messages). The naïve check breaks on the FIRST tool_result inside the LAST turn — usually one or two entries after the last assistant tool_use, far short of the real next user prompt.

Same trap surfaced in three other places already, each fixed independently:
- `claude:get-timeline` docs-attribute look-ahead — see `fix-timeline-docs-attribute-loop.md`.
- Edit-range orphan cleanup — see `fact-timeline.md::Forward-expand ловушка` (also covers `<task-notification>`).
- Rewind tail-cleanup (different shape, same root) — see `fact-timeline.md::Tail Cleanup при rewind «до конца»`.

The copy-range path kept the old guard. Four classes of `type: 'user'` entries can sit inside one turn and **must not** terminate forward-expand:
1. `tool_result` — array content with a `type: 'tool_result'` block. Every Read/Edit/Bash reply.
2. `<task-notification>` — string content starting with the tag. Sub-agent auto-messages (Gemini orchestration).
3. **Synthetic command wrappers** — `<command-name>`, `<local-command-stdout>`, `<local-command-caveat>`, `<bash-notification>`, `<system-reminder>`, `Caveat: …` banner. These are emitted by Claude CLI itself when the user types a slash-command (`/effort`, `/compact` etc.) — they live inside a turn together with the surrounding assistant entries. Without this filter, slash-commands issued at the end of a long turn (very common before auto-compact) would also clip the range short, even on sessions with no tool_use.
4. **Image-meta wrappers** — array content where **every** block is `{type: 'text', text: "[Image: source: <path>]"}`. When the user pastes a prompt with one or more attachments, Claude Code splits the turn into TWO consecutive user-entries in JSONL: (a) the real prompt with inline `{type: 'image', source: {type: 'base64', ...}}` blocks, then (b) a synthetic sibling whose blocks are pure-text references to the local image-cache (`/Users/.../image-cache/<sid>/N.png`). Detection: text-array, length ≥ 1, every block matches `/^\s*\[Image: source: /`. Without this filter a single-click copy on the real prompt terminates forward-expand on (b), producing output with just the user prompt and zero assistant entries. Detected by content shape (regex on every block), not by a tag — Claude doesn't wrap these in `<...>`. Render-step filter mirrors the same shape and `continue`s.

The render step lower in the same handler already filters these synthetic wrappers out (`rawContent.includes('<command-name>')`, etc.), so adding the same filter to the forward-expand guard does not change what gets emitted — it only fixes what stays inside `range[]`.

## Fix
Replace the bare break in `claude:copy-range` (claude-data.js:548) with a real-user check matching the canonical pattern from `fix-timeline-docs-attribute-loop.md`, extended for synthetic command wrappers:

```js
for (let i = maxIdx + 1; i < activeHistory.length; i++) {
  const entry = activeHistory[i];
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') break;
  if (entry.type === 'user' && !entry.isSidechain) {
    const nc = entry.message?.content;
    const isToolResult = Array.isArray(nc) && nc.some(b => b && b.type === 'tool_result');
    const ncStr = typeof nc === 'string' ? nc : '';
    const isTaskNotif = ncStr.startsWith('<task-notification>');
    const isSyntheticCmd = ncStr.startsWith('<command-name>')
      || ncStr.startsWith('<local-command-stdout>')
      || ncStr.startsWith('<local-command-caveat>')
      || ncStr.startsWith('<bash-notification>')
      || ncStr.startsWith('<system-reminder>')
      || ncStr.startsWith('Caveat: The messages below');
    if (!isToolResult && !isTaskNotif && !isSyntheticCmd) break;
  }
  maxIdx = i;
}
```

The render step (≈line 575) already iterates the resulting `range` and skips synthetic-command entries by string-prefix — they do not pollute the output. Forward-expand only needed teaching to not stop on them.

## Why this hid for so long
- Single-message copy (ПКМ → «Копировать» on one dot) walks the same code path but starts from `maxIdx = startIndex`, and most one-prompt turns don't run a tool_use as the LAST action — the bare guard «accidentally» worked for the common case.
- Multi-selection makes the LAST selected prompt's turn the failure point, and that turn is typically the longest/most tool-heavy in the range. Bug is structurally biased toward exactly the cases users want copied.
- Auto-compact sessions sit synthetic `/effort` and `/compact` wrappers between the last real prompt and `compact_boundary`. The old guard breaks on any of them too — even if the tool_result trap somehow didn't apply, the synthetic-command trap would.
- Image-meta wrapper sits ONE entry after the real prompt — single-click copy on a prompt with attachments stopped on entry +1 (the image-meta sibling), so the range was just 2 entries with no assistant in between. Verified on session 7e755d65 entry b3500009 in production.log 20:40 UTC: forward-expand stopped after maxIdx+1 (size 2), while the active branch continued for 47 entries (16 assistants, 10 tool_use/result rounds) before hitting the next real user prompt 9c997e72.

## Related
- `fix-timeline-docs-attribute-loop.md` — same trap in `claude:get-timeline` docs-attribute aggregation. Canonical pattern source.
- `fact-timeline.md::Forward-expand ловушка` — same trap in edit-range orphan cleanup (covers tool_result + `<task-notification>` already; synthetic-command wrappers are a copy-range-only concern because that code emits user-visible text).
- `fact-clipboard-tools.md::Невидимый контекст: callsites` — list of all 4 IPC callers of `copy-range` (they share the same `copyFlags` object; the fix applies to every caller transparently).
- `fact-timeline.md::Range Copy & Edit Range` — UI side of the feature.
