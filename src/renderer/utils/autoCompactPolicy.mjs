export const UNPLACED_AUTOMATION_WORKFLOW = '__unplaced__';

export function normalizeAutoCompactPolicy(value = {}) {
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
