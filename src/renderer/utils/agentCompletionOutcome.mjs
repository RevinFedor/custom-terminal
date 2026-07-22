/**
 * Workflow actions may run only after an authoritative, successful AI turn.
 * Reason-less false edges are the legacy Claude/Gemini success contract;
 * Codex reports task_complete explicitly. Every other explicit reason is
 * fail-closed unless a caller handles that reason as a non-turn event first.
 */
export function isNaturalAgentTurnEndReason(reason) {
  return !reason || reason === 'task_complete';
}
