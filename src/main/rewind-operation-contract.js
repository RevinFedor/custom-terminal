'use strict';

function createRewindOperationId(opId, toolType, {
  now = Date.now,
  random = Math.random,
} = {}) {
  const explicit = String(opId || '').trim();
  return explicit || (
    String(toolType || 'agent')
    + '-rewind-main-'
    + now()
    + '-'
    + random().toString(36).slice(2, 8)
  );
}

function claimRewindOperation(operations, {
  tabId,
  toolType,
  opId,
}, {
  now = Date.now,
  random = Math.random,
} = {}) {
  const existing = operations.get(tabId);
  if (existing) {
    return {
      success: false,
      error: 'rewind_already_in_progress',
      activeOpId: existing.opId,
    };
  }

  const operation = {
    tabId,
    toolType,
    opId: createRewindOperationId(opId, toolType, { now, random }),
    mutationStarted: false,
    protocolUiOpen: false,
    startedAt: now(),
  };
  operations.set(tabId, operation);
  return { success: true, operation };
}

function finishRewindOperation(operations, operation) {
  if (!operation || operations.get(operation.tabId) !== operation) return false;
  operations.delete(operation.tabId);
  return true;
}

function markRewindMutationStarted(operations, operation, { now = Date.now } = {}) {
  if (!operation || operations.get(operation.tabId) !== operation) return false;
  operation.mutationStarted = true;
  operation.mutationStartedAt = now();
  return true;
}

function classifyRewindCancel(operations, {
  tabId,
  toolType,
  opId,
} = {}) {
  const operation = operations.get(tabId);
  if (!operation) {
    return {
      status: 'not-active',
      operation: null,
      response: {
        success: false,
        accepted: false,
        alreadyFinished: true,
        error: 'rewind_operation_not_active',
      },
    };
  }

  if (!opId || operation.opId !== opId || (toolType && operation.toolType !== toolType)) {
    return {
      status: 'stale',
      operation,
      response: {
        success: false,
        accepted: false,
        stale: true,
        activeOpId: operation.opId,
        error: 'rewind_cancel_stale_operation',
      },
    };
  }

  if (operation.mutationStarted) {
    return {
      status: 'too-late',
      operation,
      response: {
        success: false,
        accepted: false,
        tooLate: true,
        error: 'rewind_cancel_too_late',
      },
    };
  }

  return {
    status: 'accepted',
    operation,
    response: { success: true, accepted: true },
  };
}

module.exports = {
  claimRewindOperation,
  classifyRewindCancel,
  createRewindOperationId,
  finishRewindOperation,
  markRewindMutationStarted,
};
