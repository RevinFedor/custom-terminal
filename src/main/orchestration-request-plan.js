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

function resolveOrchestrationDeliveryAdmission(status = {}) {
  const lifecycle = status?.status || status?.sessionStatus || 'unknown';
  const busy = status?.busy === true
    || status?.turnBusy === true
    || status?.isBusy === true
    || lifecycle === 'busy';

  if (busy) {
    return {
      canDispatch: false,
      statusAtSend: lifecycle,
      requiresRuntimeLaunch: false,
      reason: 'target-not-idle:' + lifecycle,
    };
  }

  if (lifecycle === 'inactive') {
    return {
      canDispatch: true,
      statusAtSend: 'inactive',
      requiresRuntimeLaunch: true,
      reason: null,
    };
  }

  if (lifecycle === 'active'
    && status?.inputReady === true
    && status?.starting !== true
    && status?.stopping !== true) {
    return {
      canDispatch: true,
      statusAtSend: 'active',
      requiresRuntimeLaunch: false,
      reason: null,
    };
  }

  return {
    canDispatch: false,
    statusAtSend: lifecycle,
    requiresRuntimeLaunch: false,
    reason: 'target-not-idle:' + lifecycle,
  };
}

function isOrchestrationDeliveryIdentityCompatible(run = {}, status = {}) {
  const expectedTool = run.targetToolType || null;
  const observedTool = status.toolType || status.commandType || null;
  if (expectedTool && observedTool && expectedTool !== observedTool) return false;

  const expectedSession = run.sessionId || null;
  const observedSession = status.sessionId || null;
  if (expectedSession && observedSession && expectedSession !== observedSession) return false;

  const expectedLifecycleGeneration = run.targetLifecycleGeneration || null;
  const observedLifecycleGeneration = status.lifecycleGeneration || null;
  if (expectedLifecycleGeneration
    && observedLifecycleGeneration
    && expectedLifecycleGeneration !== observedLifecycleGeneration) return false;

  const expectedLaunchGeneration = run.targetLaunchGeneration || null;
  const observedLaunchGeneration = status.launchGeneration || null;
  if (expectedLaunchGeneration
    && observedLaunchGeneration
    && expectedLaunchGeneration !== observedLaunchGeneration) return false;
  return true;
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
  isOrchestrationDeliveryIdentityCompatible,
  normalizePlacement,
  resolveOrchestrationDeliveryAdmission,
  resolveNewAgentTabPlacement,
  resolveOrchestrationSendOptions,
};
