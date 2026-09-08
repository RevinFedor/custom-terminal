# Confirmed Max restored as old Ultra after returning to a tab

## Symptom and evidence

2026-09-08, tab-4196, writer 262df4bb-83cb-4271-bed2-d8c507eed16c.
The live terminal showed gpt-5.6-sol/max while ControlBar and GET /params showed
ultra. GET /params simultaneously reported requestedEffort=max,
settingsRevision=4, settingsAppliedRevision=4, settingsPending=false.
The production log records native thread_settings_applied at 11:34:35.733Z,
matching config proof and successful Max application at 11:34:35.751Z, followed
by the applied renderer event. This was not an unexecuted user choice.

## Cause

HistoryPanel guarded ordinary settings by session and proof time, but its
conversation-only Ultra branch bypassed the time check. Loading older history
could therefore put Ultra back over a newer picker result. The full History
projector also ignored native thread_settings_applied and projected settings
only from turn_context. Re-reading History is not a new settings command.

Two adjacent writers could destroy the ordering evidence: the reply acknowledging
only saved intent cleared the applied proof; a refreshed model catalog rewrote
the selected pair when it did not find a row. A keyless ControlBar additionally
merged revision counters from different tabs. A delayed native Ultra fallback
read checked only session identity and could reapply an obsolete live pair.

## Repair

- Ultra and normal settings share the same freshness barrier. Live conversation
  proof has its own non-persisted observation time; loading History preserves
  that time instead of stamping a new one. Different writers remain isolated.
- Full History reuses codex-source-settings extraction for native
  thread_settings_applied, preserving legacy partial turn_context support.
- Saved intent is separate from applied settings; its acknowledgement never
  rewrites the applied pair. Catalog refresh lists choices but does not change
  the running model. Provider-state revisions are scoped to the owning tab.
- A late native fallback read must still match the exact live pair and proof
  time it belongs to, not merely the same session.

Model/effort application activity is now projected from actual main-owned
operations. The UI has an immediate click guard, then follows main activity and
the revisioned Codex intent. A newer operation cannot be cleared by an older
completion, and returning to a tab re-reads its actual outstanding activity.
The renderer keeps a tab-keyed projection of main activity even while that
ControlBar is absent. Main starts activity before asynchronous config/process
preparation, not just before opening the picker. Applied values are published
before the event that releases the pending indicator; the old label must not
be unlocked while its replacement event is still in transit.
Stopped selection remains a next-launch choice, not an endless application
spinner. A failed application stops waiting with a visible unconfirmed warning;
it does not become success. External API settings still use the common queue.

This supersedes the previous "always clickable while applying" model/effort UI
contract per the user's explicit request. Busy replies/paste alone do not disable
choosing a setting. Once chosen, Model/Effort/Quick are disabled until the setting
operation settles; empty input and the save/Enter reply are not completion proof.
Manual Codex picker presentation requires a committed composer footer naming
model and effort before its activity ends; it does not label Escape as success.

A verified composer footer for the exact current launch may also satisfy a
matching saved model/effort intent. Writer adoption does not reopen a picker
whose pair is already proven in that launch. This path runs only after the
existing terminal/run/lifecycle/launch checks; it never upgrades writer
authorization. A different pair or generation still needs its own application.
The common main readiness transition wakes pending settings after an established
picker closes, not only at startup or on the next user turn.

For Claude a requested pair, including a model click that requires compatible
effort, holds one main write owner through both commands and both proofs.
External requests queue after the whole pair. A model-success/effort-failure
reports the applied subset rather than reverting the model label or calling the
pair successful. The same main activity is used by external settings-before-send.

## Verification boundaries

The actual HistoryPanel function and canonical projector failed the tab-4196
regression before repair. After repair: old Ultra cannot replace Max, a newer
Ultra remains transient, older normal settings cannot replace it, a newer Max
clears it, and another writer is rejected. Additional tests cover delayed
fallback reads, cross-tab revision merging, exact applied revision, outstanding
main operations, UI proof waiting and external Claude queue serialization.

Evidence: /private/tmp/noted-fork-repair-20260907.ZGoQNr/settings-tab4196-before.log,
settings-tab4196-after.log, settings-owner-expanded.log,
settings-controls-regressions.log, settings-manual-frame.log.
The isolated physical UI run is separate; source/unit PASS is not an installed
production or full CLI E2E claim.

The isolated run /private/tmp/custom-terminal-e2e-settings-ylbOSR exercised
Luna low→medium→high→medium with trusted clicks and tab switches. It retained
native settings events and DOM busy/disabled transitions. Its final screenshot
had the floating terminal closed: old hidden xterm accessibility text is not
proof of a different current CLI value. The publication-order and projection
cache changes followed this cutoff and still need a physical retake. The run
also omitted CLI-home isolation and improperly restored an old global config
backup; it must not be cited as proving CLI globals unchanged.

Retake /private/tmp/noted-settings-final-20260908.EcYs1s used a private CLI home
and trusted low→medium→high→medium clicks. During the final pending choice it
switched away and back: controls remained disabled/aria-busy with a spinner
until native settings proof. Three requested changes produced exactly three
applications; the freshly opened floating terminal and ControlBar both showed
Luna/medium. The global config hash remained unchanged. Its attempted headless
line extraction was empty because that API returns serialized ANSI, so use the
retained native events and fresh screenshot, not that empty line extraction.
The later shared-ready wake and Claude compatible-pair repair have separate
source regressions; this retake does not claim their physical acceptance or an
installed result.
