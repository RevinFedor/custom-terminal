export const UNPLACED_AUTOMATION_WORKFLOW = '__unplaced__';

/** Selection is the desktop switch. Legacy/API disabled policies may retain
 * remembered scope, but that memory is not an active checkmark or permission
 * to enable other workflows when the user picks just one. */
export function selectedAutoCompactScope(policy) {
  return {
    allWorkflows: policy.enabled === true && policy.allWorkflows === true,
    workflowIds: policy.enabled === true ? [...policy.workflowIds] : [],
    includeUnplaced: policy.enabled === true && policy.includeUnplaced === true,
  };
}

export function toggleAutoCompactScope(policy, action) {
  const scope = selectedAutoCompactScope(policy);
  if (action.kind === 'all') scope.allWorkflows = !scope.allWorkflows;
  else if (action.kind === 'unplaced') scope.includeUnplaced = !scope.includeUnplaced;
  else if (action.kind === 'workflow' && typeof action.id === 'string' && action.id) {
    scope.workflowIds = scope.workflowIds.includes(action.id)
      ? scope.workflowIds.filter(id => id !== action.id) : [...scope.workflowIds, action.id];
  } else throw new Error('auto_compact_scope_action_invalid');
  return { ...scope, enabled: scope.allWorkflows || scope.includeUnplaced || scope.workflowIds.length > 0,
    scopeInitialized: true };
}

export function normalizeAutoCompactPolicy(value = {}) {
  if (value.organizationVersion != null && value.organizationVersion !== 1) throw new Error('automation_forward_version');
  return {
    enabled: value.enabled === true,
    scopeInitialized: value.scopeInitialized === true,
    percent: Math.max(1, Math.min(100, Math.round(Number(value.percent) || 50))),
    allWorkflows: value.allWorkflows === true,
    workflowIds: [...new Set(Array.isArray(value.workflowIds)
      ? value.workflowIds.filter((id) => typeof id === 'string' && id) : [])],
    includeUnplaced: value.includeUnplaced === true,
    excludedTabIds: [...new Set(Array.isArray(value.excludedTabIds)
      ? value.excludedTabIds.filter((id) => typeof id === 'string' && id) : [])],
    armedAt: Number.isFinite(value.armedAt) ? value.armedAt : 0,
    ...(value.organizationVersion === 1 ? { organizationVersion: 1,
      migrationEligibility: value.migrationEligibility && typeof value.migrationEligibility === 'object'
        && !Array.isArray(value.migrationEligibility) ? value.migrationEligibility : {} } : {}),
  };
}

// Directory ownership is stable across window/focus changes. A guest tab in a
// different layout must not acquire a different automation policy on navigation.
export function automationWorkflowForProject(spaces, projectId) {
  return spaces.find((space) => space.projectIds?.includes(projectId))?.id
    || UNPLACED_AUTOMATION_WORKFLOW;
}

export function autoCompactIncludesTarget(policy, target) {
  if (!target || !['claude', 'codex'].includes(target.provider)) return false;
  if (policy.excludedTabIds.includes(target.tabId)) return false;
  const migration = policy.migrationEligibility?.[target.tabId];
  if (migration && migration.workflowId === target.workflowId
    && migration.membershipRevision === target.membershipRevision) return migration.included === true;
  return target.workflowId === UNPLACED_AUTOMATION_WORKFLOW
    ? policy.includeUnplaced
    : policy.allWorkflows || policy.workflowIds.includes(target.workflowId);
}

export function isAutoCompactTurnEligible({ policy, target, outcome, startedAt }) {
  return policy.enabled && autoCompactIncludesTarget(policy, target)
    && outcome.natural === true && outcome.compact !== true
    && outcome.live === true && Number.isFinite(outcome.at)
    && outcome.at >= Math.max(policy.armedAt, startedAt);
}

export function autoCompactContextDecision(snapshot, { sessionId, notBefore = 0, percent }) {
  if (snapshot?.exact !== true || snapshot.sessionId !== sessionId
    || typeof snapshot.pct !== 'number' || !Number.isFinite(snapshot.pct)
    || snapshot.pct < 0 || snapshot.pct > 100
    || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt < notBefore) return 'wait';
  return snapshot.pct >= percent ? 'compact' : 'skip';
}
