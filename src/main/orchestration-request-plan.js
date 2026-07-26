'use strict';

function normalizePlacement(value) {
  if (value == null || value === '') return 'child';
  if (value === 'child' || value === 'root') return value;
  const error = new Error('placement must be child or root');
  error.status = 400;
  error.statusCode = 400;
  error.code = 'invalid_tab_placement';
  throw error;
}

function resolveNewAgentTabPlacement({
  placement,
  parentTabId,
  sourceTabId,
  sourceProjectId,
  targetProjectId,
} = {}) {
  const requestedPlacement = normalizePlacement(placement);
  if (requestedPlacement === 'root') {
    return {
      placement: 'root',
      visualParentTabId: null,
      afterTabId: null,
    };
  }

  const explicitParent = typeof parentTabId === 'string' && parentTabId.trim()
    ? parentTabId.trim()
    : null;
  const defaultParent = !explicitParent
    && sourceTabId
    && sourceProjectId
    && targetProjectId
    && sourceProjectId === targetProjectId
    ? sourceTabId
    : null;
  const visualParentTabId = explicitParent || defaultParent;

  return {
    placement: visualParentTabId ? 'child' : 'root',
    visualParentTabId,
    afterTabId: visualParentTabId,
  };
}

function resolveOrchestrationSendOptions({
  targetCreated,
  targetToolType,
  baselineStatus,
  queueRequested,
  model,
  effort,
  thinking,
} = {}) {
  const settingsAppliedAtLaunch = targetCreated === true && targetToolType === 'codex';
  return {
    model: settingsAppliedAtLaunch ? undefined : model,
    effort: settingsAppliedAtLaunch ? undefined : effort,
    thinking,
    queue: baselineStatus === 'busy' && queueRequested !== false,
    settingsAppliedAtLaunch,
  };
}

function isAgentStatusBusyForClose(status) {
  const lifecycle = status?.status || status?.sessionStatus || 'unknown';
  return status?.busy === true
    || status?.turnBusy === true
    || status?.isBusy === true
    || lifecycle === 'busy'
    || lifecycle === 'starting'
    || lifecycle === 'stopping';
}

function buildDelegationResultTarget(run) {
  return {
    targetTabId: run?.targetTabId || null,
    targetProjectId: run?.targetProjectId || null,
    targetProjectPath: run?.targetProjectPath || null,
    targetCreated: run?.targetCreated === true,
  };
}

module.exports = {
  buildDelegationResultTarget,
  isAgentStatusBusyForClose,
  normalizePlacement,
  resolveNewAgentTabPlacement,
  resolveOrchestrationSendOptions,
};
