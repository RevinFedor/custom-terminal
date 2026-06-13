# Fix: Codex export duplicated prompts after compact

## Symptoms
- Full Codex Copy Session export could show the same prompt multiple times.
- The duplication got worse in transcripts with several compaction points: later compacts re-emitted already existing prompts, so a copied `.md` looked like one prompt appeared several times.
- The export still looked structurally valid, so the bug was easy to miss until someone compared prompt counts or the selected range against the real rollout.

## Root cause
`buildCodexCleanEntries()` treated `record.type === 'compacted'` as a compact snapshot, but the old path also recursively expanded `payload.replacement_history`.

In Codex JSONL that field is the compacted model snapshot, not a new set of user-visible turns. Recursing through it on every compact re-materialized old prompts that were already present in the surrounding rollout records, so every later compact inflated the export again.

## Fix
For clean export, a top-level `compacted` record is now a single compact marker. It keeps the compact title/text, but it does not recurse into `replacement_history`.

Range copy keeps using the already-clean timeline and then filters by the selected `turnIndex` / compact UUID, so a deliberately trimmed start still omits earlier turns by design. That is selection scope, not missing data.

## Why this was non-obvious
`replacement_history` looks authoritative because it is verbose and complete. For export, though, the authoritative chronology is the rollout stream itself. The nested snapshot is useful for display and compact summaries, but not for replaying the transcript as if it were fresh turns.

