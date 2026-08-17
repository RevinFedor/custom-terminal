'use strict';

function mergeDeliveryWake(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  return {
    reason: next.reason || previous.reason,
    targetStatus: next.targetStatus || previous.targetStatus || null,
  };
}

function createOrchestrationDeliverySingleFlight({ onEvent = null } = {}) {
  const active = new Map();

  async function run(runId, request, execute) {
    if (!runId) return execute(request || {});
    const existing = active.get(runId);
    if (existing) {
      existing.trailing = mergeDeliveryWake(existing.trailing, request || {});
      onEvent?.('queued', { runId, request: existing.trailing });
      return existing.promise;
    }

    const state = {
      promise: null,
      trailing: null,
    };
    active.set(runId, state);
    state.promise = (async () => {
      let current = request || {};
      let result = null;
      while (current) {
        result = await execute(current);
        const trailing = state.trailing;
        state.trailing = null;
        if (!trailing || result?.dispatched === true || result?.deferred !== true) break;
        current = trailing;
        onEvent?.('replay', { runId, request: current });
      }
      return result;
    })();

    try {
      return await state.promise;
    } finally {
      if (active.get(runId) === state) active.delete(runId);
    }
  }

  return {
    run,
    isActive: (runId) => active.has(runId),
  };
}

module.exports = {
  createOrchestrationDeliverySingleFlight,
  mergeDeliveryWake,
};
