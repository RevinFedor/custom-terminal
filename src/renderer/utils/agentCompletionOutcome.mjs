/**
 * Workflow actions may run only after an authoritative, successful AI turn.
 * Reason-less false edges are the legacy Claude/Gemini success contract;
 * Codex reports task_complete explicitly. Every other explicit reason is
 * fail-closed unless a caller handles that reason as a non-turn event first.
 */
export function normalizeAgentTurnEndReason(reason) {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value === 'rollout-task_complete') return 'task_complete';
  if (value === 'rollout-turn_aborted') return 'turn_aborted';
  return value;
}

export function isNaturalAgentTurnEndReason(reason) {
  const normalized = normalizeAgentTurnEndReason(reason);
  return !normalized || normalized === 'task_complete';
}

/**
 * A recoverable user-level interruption pauses a target turn but does not
 * settle work that another tab explicitly waits on. The interrupted tab's
 * one-shot queue still fails closed; pivoted Run After and its repeating Loop
 * survive to observe the next natural completion.
 */
export function isRecoverableAgentTurnInterruption(reason) {
  const normalized = normalizeAgentTurnEndReason(reason);
  return normalized === 'interrupt' || normalized === 'turn_aborted';
}
