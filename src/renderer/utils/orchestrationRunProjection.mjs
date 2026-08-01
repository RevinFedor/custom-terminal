const INHERITED_ACTIVE = new Set([
  'creating',
  'starting',
  'sending',
  'sent',
  'queued',
  'running',
  'waiting_descendants',
]);

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const SOURCE_FOLLOWUP_DELIVERY_STATUSES = new Set(['pending', 'sending', 'sent', 'queued']);
const SOURCE_NOTIFICATION_PROBLEM_STATUSES = new Set(['waiting-for-input', 'failed', 'unconfirmed']);

export function isOrchestrationResultProofPending(run) {
  return run?.status === 'completed' && run.resultComplete === false;
}

function isSeparateSourceRun(run) {
  return Boolean(run?.sourceTabId && run.sourceTabId !== run.targetTabId);
}

function isSourceFollowupPending(run) {
  return TERMINAL_STATUSES.has(run?.status)
    && isSeparateSourceRun(run)
    && run.notificationSuppressed !== true
    && run.sourceFollowupPending === true
    && !run.sourceFollowupStartedAt
    && SOURCE_FOLLOWUP_DELIVERY_STATUSES.has(run.notificationStatus || '');
}

function isSourceNotificationBlocked(run) {
  return TERMINAL_STATUSES.has(run?.status)
    && isSeparateSourceRun(run)
    && run.notificationSuppressed !== true
    && SOURCE_NOTIFICATION_PROBLEM_STATUSES.has(run.notificationStatus || '');
}

export function isOrchestrationInheritedActivity(run) {
  if (!isSeparateSourceRun(run)) return false;
  if (run?.resumeAwaitingNewTurn === true) return false;
  return INHERITED_ACTIVE.has(run.status)
    || isOrchestrationResultProofPending(run)
    || isSourceFollowupPending(run);
}

export function isOrchestrationCompletionBlocking(run) {
  if (!isSeparateSourceRun(run)) return false;
  return INHERITED_ACTIVE.has(run.status)
    || run.status === 'waiting_recovery'
    || isOrchestrationResultProofPending(run)
    || isSourceFollowupPending(run)
    || isSourceNotificationBlocked(run);
}

export function shouldRetainOrchestrationRun(run) {
  return INHERITED_ACTIVE.has(run?.status)
    || run?.status === 'waiting_recovery'
    || isOrchestrationResultProofPending(run)
    || isSourceFollowupPending(run)
    || isSourceNotificationBlocked(run);
}
