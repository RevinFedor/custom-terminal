const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeTurnInterrupt } = require('./claude-turn-interrupt');

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

test('delivered interrupt request is successful without claiming an observed interruption', () => {
  const requested = {
    success: true, interrupted: false, interruptRequested: true, interruptConfirmed: false,
    status: 'requested', turnId: 'claude:1',
  };
  const outcome = classifyAgentActionResult('interrupt', requested);
  assert.equal(outcome.statusCode, 200);
  assert.deepEqual(outcome.body, { ...requested, ok: true });
});

test('actual Claude helper preserves the legacy HTTP request ACK only after the owned write', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const terminal = {};
  let writes = 0;
  const snapshot = { terminal, busy: true, stopping: false, turnId: 'claude:1',
    runSeq: 1, lifecycleGeneration: 'pty:1', launchGeneration: 'L1', processId: '100' };
  const interrupt = createClaudeTurnInterrupt({
    getSnapshot: () => snapshot,
    withWriteLock: (_terminal, write) => gate.then(write),
    writeEscape: () => { writes += 1; },
    now: () => 1000,
  });
  let httpResponse = null;
  const waiting = interrupt('T').then(receipt => {
    httpResponse = classifyAgentActionResult('interrupt', receipt);
    return httpResponse;
  });
  await Promise.resolve();
  assert.equal(writes, 0);
  assert.equal(httpResponse, null, 'no success or legacy ACK before the PTY write');
  release();
  const response = await waiting;
  assert.equal(writes, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.interrupted, true, 'legacy field still acknowledges the delivered request');
  assert.equal(response.body.interruptRequested, true);
  assert.equal(response.body.interruptConfirmed, false, 'request delivery is not proof the provider ended its turn');
  assert.equal(response.body.status, 'requested');
  assert.equal(snapshot.busy, true);

  snapshot.busy = false;
  const idle = classifyAgentActionResult('interrupt', await interrupt('T'));
  assert.equal(idle.statusCode, 200);
  assert.equal(idle.body.interrupted, false);
  assert.equal(idle.body.interruptRequested, false);
  assert.equal(idle.body.interruptConfirmed, false);
  assert.equal(writes, 1);
});

test('idle or already-requested interrupt skip is a successful no-op, not a 409 or invented interruption', () => {
  for (const skipped of ['idle-composer', 'target-turn-changed', 'interrupt-already-requested']) {
    const outcome = classifyAgentActionResult('interrupt', {
      success: true, interrupted: false, interruptRequested: false, skipped,
    });
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.body.success, true);
    assert.equal(outcome.body.interrupted, false);
    assert.equal(outcome.body.interruptRequested, false);
    assert.equal(outcome.body.skipped, skipped);
  }
});

test('interrupt request metadata cannot mask a failed write or unknown process lookup', () => {
  for (const failure of [
    { success: false, interrupted: false, interruptRequested: true, error: 'write-failed' },
    { success: true, ok: false, interrupted: false, skipped: 'idle-composer' },
    { success: true, interrupted: false, interruptRequested: true, lookupUnknown: true },
  ]) {
    const outcome = classifyAgentActionResult('interrupt', failure);
    assert.equal(outcome.body.success, false);
    assert.equal(outcome.body.interrupted, false);
    assert.equal(outcome.statusCode, failure.lookupUnknown ? 503 : 409);
  }
});

test('legacy Codex requested receipt and confirmed provider receipt keep their explicit fields', () => {
  for (const receipt of [
    { success: true, interrupted: true, interruptRequested: true, turnId: 'C1' },
    { success: true, interrupted: true, interruptConfirmed: true, turnId: 'C2' },
  ]) {
    const outcome = classifyAgentActionResult('interrupt', receipt);
    assert.equal(outcome.statusCode, 200);
    assert.deepEqual(outcome.body, { ...receipt, ok: true });
  }
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

  assert.equal(validateFreshAgentRuntimeStatus({
    toolType: 'codex',
    status: 'busy',
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
