/**
 * Workflow actions may run only after an authoritative, successful AI turn.
 * Reason-less false edges are the legacy Claude/Gemini success contract;
 * Codex reports task_complete explicitly. Every other explicit reason is
 * fail-closed unless a caller handles that reason as a non-turn event first.
 */
export function isNaturalAgentTurnEndReason(reason) {
  return !reason || reason === 'task_complete';
}

/**
 * A recoverable user-level interruption pauses a target turn but does not
 * settle work that another tab explicitly waits on. The interrupted tab's
 * one-shot queue still fails closed; pivoted Run After and its repeating Loop
 * survive to observe the next natural completion.
 */
export function isRecoverableAgentTurnInterruption(reason) {
  return reason === 'interrupt' || reason === 'turn_aborted';
}
