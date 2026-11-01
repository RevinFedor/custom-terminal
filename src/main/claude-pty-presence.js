'use strict';

function projectClaudePtyPresence({
  hasTerm = false,
  hasBridge = false,
  promptReady = false,
  cliActive = false,
  processAlive = false,
  processLookupUnknown = false,
  turnBusy = false,
  localCommandActive = false,
  stopping = false,
  startupIntentFresh = false,
  startupGatePending = false,
  startupGateFailed = false,
  startupGateNotDelivered = false,
} = {}) {
  // Startup /model and /effort are part of one launch transaction. A prompt
  // glyph rendered between those steps is not yet public input readiness and
  // the local slash command is not a user turn. A real UserPromptSubmit turn,
  // however, remains busy even if a stale startup gate is still present.
  const isBusy = turnBusy === true
    || (localCommandActive === true && startupGatePending !== true);
  let status;
  if (stopping === true) status = 'stopping';
  else if (hasTerm !== true) status = 'inactive';
  else if (turnBusy === true) status = 'busy';
  else if (startupGatePending === true) status = 'starting';
  else if (promptReady === true && (cliActive === true || processAlive === true)) status = isBusy ? 'busy' : 'active';
  else if (hasBridge === true) {
    if (isBusy) status = 'busy';
    else if (promptReady === true) status = 'active';
    else status = 'starting';
  // A provider process proven under THIS tab's PTY is already running even
  // when a fresh main process has not yet received its first bridge/statusline
  // record. It is not input-ready until the prompt is proven, but it must never
  // be projected as inactive — that would offer Resume over the live process.
  } else if (processAlive === true) status = 'starting';
  else if (startupIntentFresh === true) status = 'starting';
  // Lookup failure is not process absence. Keep Start/Resume disabled until a
  // later exact proof resolves the owner instead of launching into uncertainty.
  else if (processLookupUnknown === true) status = 'unknown';
  else status = 'inactive';

  return {
    status,
    isBusy,
    // A PENDING startup transaction owns the composer: `/model` and `/effort`
    // must land before the first prompt, and a glyph rendered between those
    // steps is not yet public readiness. A real running turn is already past
    // that and keeps its type-ahead/queued input.
    //
    // A FAILED startup transaction is terminal, and it is reported, not
    // enforced. The composer is the same proven idle composer; the only
    // consequence is that the setting is not applied. The old rule held input
    // hostage instead, and the failure is sticky until the process restarts:
    // on 2026-10-31 tab 2efc9b9b7a35 took a 429 on `/model` at 10:45:33, and
    // every later send was refused for 2h20m (three of them at 13:06:34,
    // 13:06:42, 13:06:59 with agent_send_startup_failed) until a restart
    // cleared the gate at 13:07:02. Dismissing the error never unblocked it,
    // and a manual retry hit the same limit.
    //
    // Trading away: a send can now use a model the user asked to change and
    // Claude did not change. The control bar shows the model actually in
    // effect and the settings card names the exact failure, so that state is
    // visible rather than silent — and the user decided a failed setting must
    // not disable the tab. `startupGateNotDelivered` stays available to tell a
    // local, never-delivered failure from a real provider verdict in
    // presentation and diagnostics.
    inputReady: (status === 'active' || status === 'busy')
      && (startupGatePending !== true || turnBusy === true)
      && (promptReady === true || turnBusy === true),
  };
}

module.exports = {
  projectClaudePtyPresence,
};
