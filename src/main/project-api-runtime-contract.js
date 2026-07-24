const {
  isCodexComposerReadyForGuardedSend,
} = require('./codex-runtime-contract');

const ACTION_RESULT_FIELD = Object.freeze({
  stop: 'stopped',
  interrupt: 'interrupted',
});

function actionResultField(action) {
  return ACTION_RESULT_FIELD[action] || 'completed';
}

function isProcessLookupUnknown(value) {
  return value?.lookupUnknown === true
    || value?.error === 'process_lookup_failed'
    || value?.code === 'process_lookup_failed';
}

function classifyAgentActionResult(action, data = {}) {
  const resultField = actionResultField(action);
  const result = data && typeof data === 'object' ? data : {};

  if (isProcessLookupUnknown(result)) {
    return {
      statusCode: 503,
      body: {
        ...result,
        ok: false,
        success: false,
        [resultField]: false,
        error: 'process_lookup_failed',
        lookupUnknown: true,
      },
    };
  }

  if (
    result.success === false
    || result.ok === false
    || result[resultField] === false
  ) {
    if (result.noProcess === true || result.processAbsent === true) {
      return {
        statusCode: 200,
        body: {
          ...result,
          ok: true,
          success: true,
          [resultField]: false,
          reason: result.reason || 'no active session',
          processAbsent: true,
        },
      };
    }
    return {
      statusCode: 409,
      body: {
        ...result,
        ok: false,
        success: false,
        [resultField]: false,
        error: result.error || result.code || (action + '_failed'),
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ...result,
      ok: true,
      success: true,
      [resultField]: true,
    },
  };
}

function classifyAgentActionBridgeError(action, error) {
  if (isProcessLookupUnknown(error?.bridgeData)) {
    return classifyAgentActionResult(action, error.bridgeData);
  }

  const resultField = actionResultField(action);
  const message = String(error?.message || error || 'Bridge failed');
  const timedOut = error?.code === 'bridge_timeout'
    || message.startsWith('Bridge timeout:');
  return {
    statusCode: timedOut ? 504 : 502,
    body: {
      ok: false,
      success: false,
      [resultField]: false,
      error: timedOut ? 'bridge_timeout' : 'bridge_unavailable',
      detail: message,
      runtimeStateUnknown: true,
    },
  };
}

function validateFreshAgentRuntimeStatus(status) {
  if (!status || typeof status !== 'object') {
    return {
      ok: false,
      statusCode: 503,
      error: 'runtime_snapshot_unavailable_after_startup_defaults',
    };
  }

  const runtimeStatus = status.status || status.sessionStatus || 'unknown';
  if (runtimeStatus === 'unknown') {
    return {
      ok: false,
      statusCode: 503,
      error: 'runtime_state_unknown_after_startup_defaults',
    };
  }
  if (runtimeStatus === 'inactive') {
    return {
      ok: false,
      statusCode: 409,
      error: 'runtime_exited_during_startup_defaults',
    };
  }
  if (runtimeStatus === 'stopping') {
    return {
      ok: false,
      statusCode: 409,
      error: 'runtime_stopping_during_startup_defaults',
    };
  }

  const codexProvisionalReady = runtimeStatus === 'starting'
    && isCodexComposerReadyForGuardedSend(status);
  const settledReady = (runtimeStatus === 'active' || runtimeStatus === 'busy')
    && status.inputReady === true;
  if (!settledReady && !codexProvisionalReady) {
    return {
      ok: false,
      statusCode: 409,
      error: 'runtime_not_ready_after_startup_defaults',
    };
  }

  return { ok: true, statusCode: 200, error: null };
}

module.exports = {
  classifyAgentActionBridgeError,
  classifyAgentActionResult,
  isProcessLookupUnknown,
  validateFreshAgentRuntimeStatus,
};
