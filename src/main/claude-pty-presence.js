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
    inputReady: (status === 'active' || status === 'busy')
      // A real running turn proves that Claude is already on its operational
      // TUI surface. The startup settings gate still blocks an idle composer,
      // but it must not revoke type-ahead/queued input for an accepted turn.
      && (startupGatePending !== true || turnBusy === true)
      && (promptReady === true || turnBusy === true),
  };
}

module.exports = {
  projectClaudePtyPresence,
};
