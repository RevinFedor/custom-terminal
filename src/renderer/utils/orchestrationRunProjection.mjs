// Desktop and public metadata use the same policy, never two status lists.
import policy from '../../shared/orchestration-activity.cjs';
export const { isOrchestrationResultProofPending, isOrchestrationInheritedActivity,
  isOrchestrationCompletionBlocking, shouldRetainOrchestrationRun } = policy;

export function mergeOrchestrationRuns(snapshot, updates) {
  const byId = new Map();
  for (const run of Array.isArray(snapshot) ? snapshot : []) {
    if (typeof run?.runId === 'string' && run.runId) byId.set(run.runId, run);
  }
  for (const run of Array.isArray(updates) ? updates : []) {
    if (typeof run?.runId !== 'string' || !run.runId) continue;
    const previous = byId.get(run.runId);
    const previousAt = Number(previous?.updatedAt);
    const incomingAt = Number(run.updatedAt);
    if (previous && Number.isFinite(previousAt) && Number.isFinite(incomingAt) && previousAt > incomingAt) continue;
    byId.set(run.runId, run);
  }
  return [...byId.values()];
}
