'use strict';

// Shared presentation policy, not completion/admission authority.
const INHERITED_ACTIVE = new Set(['creating', 'starting', 'sending', 'sent', 'queued', 'running', 'waiting_descendants']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SOURCE_FOLLOWUP_DELIVERY_STATUSES = new Set(['pending', 'sending', 'audit-pending', 'sent', 'queued']);
const SOURCE_NOTIFICATION_PROBLEM_STATUSES = new Set(['waiting-for-input', 'failed', 'unconfirmed']);
function isOrchestrationResultProofPending(run) { return run?.status === 'completed' && run.resultComplete === false; }
function isSeparateSourceRun(run) { return Boolean(run?.sourceTabId && run.sourceTabId !== run.targetTabId); }
function isSourceFollowupPending(run) {
  return TERMINAL_STATUSES.has(run?.status) && isSeparateSourceRun(run)
    && run.notificationSuppressed !== true && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt && SOURCE_FOLLOWUP_DELIVERY_STATUSES.has(run.notificationStatus || '');
}
function isSourceNotificationBlocked(run) {
  return TERMINAL_STATUSES.has(run?.status) && isSeparateSourceRun(run)
    && run.notificationSuppressed !== true && SOURCE_NOTIFICATION_PROBLEM_STATUSES.has(run.notificationStatus || '');
}
function isOrchestrationInheritedActivity(run) {
  if (!isSeparateSourceRun(run) || run?.resumeAwaitingNewTurn === true) return false;
  if (['queued', 'sending'].includes(run?.status) && !run.deliveryAcceptedAt && !run.targetPromptProofAt) return false;
  return INHERITED_ACTIVE.has(run.status) || isOrchestrationResultProofPending(run) || isSourceFollowupPending(run);
}
function isOrchestrationCompletionBlocking(run) {
  if (!isSeparateSourceRun(run)) return false;
  return INHERITED_ACTIVE.has(run.status) || run.status === 'waiting_recovery'
    || isOrchestrationResultProofPending(run) || isSourceFollowupPending(run) || isSourceNotificationBlocked(run);
}
function shouldRetainOrchestrationRun(run) {
  return INHERITED_ACTIVE.has(run?.status) || run?.status === 'waiting_recovery'
    || isOrchestrationResultProofPending(run) || isSourceFollowupPending(run) || isSourceNotificationBlocked(run);
}
module.exports = { isOrchestrationInheritedActivity, isOrchestrationResultProofPending,
  isOrchestrationCompletionBlocking, isSourceNotificationBlocked, shouldRetainOrchestrationRun };
