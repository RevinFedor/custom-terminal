// Desktop and public metadata use the same policy, never two status lists.
import policy from '../../shared/orchestration-activity.cjs';
export const { isOrchestrationResultProofPending, isOrchestrationInheritedActivity,
  isOrchestrationCompletionBlocking, shouldRetainOrchestrationRun } = policy;
