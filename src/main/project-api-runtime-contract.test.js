const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyAgentActionBridgeError,
  classifyAgentActionResult,
  validateFreshAgentRuntimeStatus,
} = require('./project-api-runtime-contract');

test('stop keeps proven absence distinct from an unknown process lookup', () => {
  const absent = classifyAgentActionResult('stop', {
    success: false,
    noProcess: true,
  });
  assert.equal(absent.statusCode, 200);
  assert.equal(absent.body.stopped, false);
  assert.equal(absent.body.processAbsent, true);
  assert.equal(absent.body.reason, 'no active session');

  const unknown = classifyAgentActionResult('stop', {
    success: false,
    error: 'process_lookup_failed',
    lookupUnknown: true,
    detail: 'ps timed out',
  });
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.body.stopped, false);
  assert.equal(unknown.body.lookupUnknown, true);
  assert.equal(unknown.body.detail, 'ps timed out');
});

test('interrupt bridge failures and timeouts never masquerade as absence', () => {
  const failure = classifyAgentActionBridgeError('interrupt', new Error('No window'));
  assert.equal(failure.statusCode, 502);
  assert.equal(failure.body.interrupted, false);
  assert.equal(failure.body.error, 'bridge_unavailable');
  assert.equal(failure.body.runtimeStateUnknown, true);
  assert.equal(failure.body.reason, undefined);

  const timeoutError = new Error('Bridge timeout: interruptAgentTurnScenario');
  timeoutError.code = 'bridge_timeout';
  const timeout = classifyAgentActionBridgeError('interrupt', timeoutError);
  assert.equal(timeout.statusCode, 504);
  assert.equal(timeout.body.error, 'bridge_timeout');
  assert.equal(timeout.body.runtimeStateUnknown, true);
});

test('a structured lookup failure survives a failed bridge reply', () => {
  const error = new Error('process_lookup_failed');
  error.bridgeData = {
    success: false,
    error: 'process_lookup_failed',
    lookupUnknown: true,
    detail: 'observer failed',
  };
  const outcome = classifyAgentActionBridgeError('stop', error);
  assert.equal(outcome.statusCode, 503);
  assert.equal(outcome.body.error, 'process_lookup_failed');
  assert.equal(outcome.body.lookupUnknown, true);
  assert.equal(outcome.body.detail, 'observer failed');
});

test('an unproven false action result is a failure, not successful absence', () => {
  const outcome = classifyAgentActionResult('stop', { stopped: false });
  assert.equal(outcome.statusCode, 409);
  assert.equal(outcome.body.success, false);
  assert.equal(outcome.body.stopped, false);
  assert.equal(outcome.body.processAbsent, undefined);
});

test('fresh readiness rejects exit or stop during startup-defaults wait', () => {
  const exited = validateFreshAgentRuntimeStatus({
    toolType: 'claude',
    status: 'inactive',
    inputReady: false,
  });
  assert.deepEqual(exited, {
    ok: false,
    statusCode: 409,
    error: 'runtime_exited_during_startup_defaults',
  });

  const stopping = validateFreshAgentRuntimeStatus({
    toolType: 'claude',
    status: 'stopping',
    inputReady: false,
  });
  assert.deepEqual(stopping, {
    ok: false,
    statusCode: 409,
    error: 'runtime_stopping_during_startup_defaults',
  });
});

test('fresh readiness accepts only a currently ready runtime snapshot', () => {
  assert.equal(validateFreshAgentRuntimeStatus({
    toolType: 'claude',
    status: 'active',
    inputReady: true,
  }).ok, true);

  assert.equal(validateFreshAgentRuntimeStatus({
    toolType: 'claude',
    status: 'starting',
    inputReady: true,
  }).ok, false);

  assert.equal(validateFreshAgentRuntimeStatus({
    toolType: 'codex',
    status: 'starting',
    inputReady: true,
  }).ok, true);

  const unknown = validateFreshAgentRuntimeStatus({
    toolType: 'codex',
    status: 'unknown',
    inputReady: false,
  });
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.error, 'runtime_state_unknown_after_startup_defaults');
});
