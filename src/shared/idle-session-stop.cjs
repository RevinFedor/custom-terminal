'use strict';

function normalizeIdleSessionStopPolicy(value = {}) {
  return {
    workflowIds: [...new Set(Array.isArray(value.workflowIds)
      ? value.workflowIds.filter(id => typeof id === 'string' && id) : [])],
    allWorkflows: value.allWorkflows === true,
    minutes: Math.max(1, Math.min(10080, Math.round(Number(value.minutes) || 10))),
    includeAlreadyIdle: value.includeAlreadyIdle !== false,
    armedAt: Number.isFinite(value.armedAt) ? value.armedAt : 0,
  };
}
function idleSessionStopIncludes(policy, workflowId) {
  return !!workflowId && (policy.allWorkflows || policy.workflowIds.includes(workflowId));
}
module.exports = { normalizeIdleSessionStopPolicy, idleSessionStopIncludes };
