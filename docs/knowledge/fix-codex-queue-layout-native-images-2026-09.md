# Codex: queue layout, native image metadata, late ready diagnostics

09.09.2026, root3314/SID1a45b851. Source repair; this iteration did NOT build
or install. User controls the next installation.

## Production causes, not hypotheses

Two Copy ID artifacts under `~/Library/Logs/noted-terminal/terminal-history-preview-diagnostics`:

- `76c2148c-c420-4335-bae4-841a834b63c9`, handoff `mtt56lrq-7zxqlo`:
  Codex paints a long token as `tab-` / `4553`, with both physical rows marked
  `wrapped:false`. Joining them with a space yields `tab- 4553`; prefix match
  fails although the user sees the right queue card. Exact JSONL arrived later
  at20:50:36UTC. No resend was needed.
- `a318e344-fccf-4487-9e0c-f79e1ec2eefd`, handoff `mtt5dvpg-2mujiz`:
  preview is `<pasted_content>`, heading, blank row, ellipsis. The parser stops
  at the blank and calls the extracted prefix non-truncated, so it requests
  full equality. The empty row is part of the three-line preview, not a card end.

`extractCodexQueuedMessageProofs` retains display rows. Only display boundaries
may omit/join a whitespace in the clipped matcher; spaces within a row stay
significant. Blank rows are crossed only into the same tinted/indented card.
No change to post-Enter lifecycle/mirror/input ownership, new-frame/new-count
guards, or exact durable SENT. Do not solve this by stripping all spaces,
matching assistant prose, pressing another Enter, or switching every send to
Ctrl+G. Both real snapshots were replayed; unit integration also rejects old
cards, changed generations and missing clipping evidence.

Native image message `codex-user-…-40904`,20:56:00UTC:
event offset424572516 has `local_images`, companion response offset424382205
has an image envelope plus input_image. Live History API returned no imagePaths.
The parser read text only; app receipts normally masked the omission.
The shared carrier reader now retains provider slot/path metadata in full,
paired and live/message projections. Recovery resolves a symlink to a managed
asset by realpath, not by guessing a basename. An external file with the same
name is not authorized as a managed image. The exact production record pair
replays as one image between the correct pasted-content parts.

History root image markers without a usable ref, and explicit imageError,
are error chips (same blue container, red image label, error preview on click).
Opaque pasted-content examples remain literal. Unknown availability is checked
by the existing managed-preview IPC; it is not equated to a successful load.

## Late restore and remaining evidence limit

4553 returned codex_input_not_ready for eight Interrupt/Escape actions at
20:08:00–09UTC. Native Escape at20:08:12 produced turn_aborted and readiness.
After the next restart, the20:22:24 AutoResume timeout left wasInterrupted;
the same writer later ran a Goal and was interrupted successfully20:23:20.
Current public status subsequently proved inputReady/live confirmed writer.

The source now invokes the existing readiness verifier from an assembled
committed composer of an already-started turn; raw spinner-only deltas cannot
be the only wake source. Interrupt refreshes a stale false readiness verdict,
then still checks exact terminal/lifecycle/turn under the same write lock.
The shutdown marker is consumed only after exact confirmed writer+inputReady,
including late ready after a bounded AutoResume failure. It is not the outcome
of the latest Goal turn. Tests cover actual observer and refusal boundaries.

Why the first auto-Enter at the cold Goal modal did not take effect is NOT
fully proven. Do not claim that the reaction fixes establish that cause. A
readiness timeout now captures an incident; the next physical hidden restore
must retain main stdout and paired screen/replay evidence. No blind retry.

## Automatic evidence

10.09 tab4410 exposed a remaining renderer wrapper: `readCodexDraftAuthority`
captured visual frame125 before awaiting main, then combined its positive hint
with current main-empty frame148. Main's other merge path already rejected old
frames; the wrapper normalized away frame identity and did not use that rule.
Both now consume `src/shared/codex-draft-frame-order.cjs`. Same/newer positive
frames and unknown main remain conservative; an older/unproven renderer cannot
override a committed main empty proof. The IPC also receives the captured
positive sample so main can classify why it was rejected.

10.09 tab3607 exposed an overbroad diagnostic condition: two preflight reads
compared renderer45/main93 and renderer86/main95 of the same generation, safely
rejected both old samples, but saved two full incidents anyway. The send was
durably confirmed. User explicitly chose ordinary logging for this explained
case, not hidden or visible full captures. Both main probe and renderer-sample
IPC now skip the reporter only after a successful authority merge retains
main empty proof and rejects an older same-generation frame. Equal/newer-frame
disagreement, unknown frame identity and generation mismatch retain the existing
diagnostic paths. Draft safety, send/receipt semantics and manual capture are
unchanged; do not suppress incidents just because delivery eventually succeeds.

The recovered exact-empty notification previously used error tone and omitted
`copyText`, so the shared Toast had no Copy button despite showing details.
It is now a persistent warning with a copyable report: tab, UTC/MSK time,
capture ID, input/lifecycle/mirror coordinates and artifact log lookup. This
reports preflight recovery, not delivered/SENT; it no longer claims an async
artifact was saved before that save has completed. Production615char send
`mtve7635-mcspw6` was subsequently confirmed exact at10:36:44.886UTC.

Live receipt -> delivery-unknown, unresolved main-empty/renderer-positive,
and startup-ready timeout trigger capture without Copy ID. Explained older
same-generation samples leave only the ordinary log. One incident per
attempt/unchanged renderer frame; persistent copyable warning. This is an
observation, never a send retry or permission to mutate PTY.

Packet includes main committed/live rows, renderer screen, serialized ANSI,
generation/geometry/cursor, renderer received/applied sequences, input ledger,
and two bounded replay windows of the bytes supplied to the headless mirror.
Each window has a serialized baseline; retain every chunk rather than only
composer transitions. Overflow and resize overlapping pending writes are
explicit gaps, not fabricated complete replays. Files use the existing private
diagnostic writer/retention (50 artifacts,14 days); later SENT does not erase
the incident. Capture/notification failure cannot fail or repeat the operation.

17Oct clarification: these are bounded headless-input replay windows, NOT a
full app-raw/kernel-byte journal. A long open DEC2026 interval can exceed their
retention before a new committed checkpoint and lose its prefix. Capture copies
only what remains before renderer-await; it does not reconstruct lost data or
implicitly pin future tail. New loss counters preserve omitted ranges/reasons.
Applied==flushed==renderer with an older committed seq is compatible with the
same still-open frame, not proof of parser desync. See the ongoing separately
budgeted recent+pin implementation and app acceptance in
[Main working state](../tmp/terminal-large-diff-20261017/RESULT.md).

Regression checkpoint:384 source tests +60 native-ABI receipt/recovery tests
PASS, plus exact production snapshot/record replay. No new full UI/CLI E2E,
build or install claimed. New files must ship together with callers:
terminal-incident-reporting.js and terminal-replay-journal.js.
