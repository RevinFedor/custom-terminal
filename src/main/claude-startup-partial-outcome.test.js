'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeStartupMainRuntime } = require('./claude-startup-main-runtime');
const { PROOF } = require('./claude-startup-transaction');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ settings = { model: 'unavailable', effort: 'max' }, proveCommand } = {}) {
  let generation = 'launch-1';
  let clock = 1;
  let operationOrder = 0;
  let ownerHeld = false;
  const sends = [];
  const gates = [];
  const runtime = createClaudeStartupMainRuntime({
    now: () => ++clock,
    currentLaunchGeneration: () => generation,
    resolveSettings: async () => settings,
    sendCommand: async ({ command }) => {
      assert.equal(ownerHeld, false, 'startup must not continue inside the manual PTY owner');
      sends.push(command);
      return { success: true, submitted: true };
    },
    proveCommand: proveCommand || (async ({ command }) => command === '/model unavailable'
      ? { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'OLD MODEL 429', failureCode: 'rate_limit' }
      : { outcome: PROOF.FOUND }),
    publishGate: gate => gates.push(gate),
  });
  const begin = (settingsKinds = ['model', 'effort']) => {
    const identity = {
      launchGeneration: generation,
      startupAttemptId: runtime.snapshot('tab-a').transaction?.attemptId || null,
      settingsOperationId: 'manual-' + (++operationOrder),
      settingsOperationOrder: operationOrder,
      settingsKinds,
    };
    assert.equal(runtime.admitManualSettingsOperation({ tabId: 'tab-a', runtime: identity }).admitted, true);
    return identity;
  };
  const sendManual = (identity, kind, requestedValue, status, actualValue = requestedValue) => {
    ownerHeld = true;
    const command = '/' + kind + ' ' + requestedValue;
    const token = runtime.claimManualSetting('tab-a', command, 'manual-pair', {
      ...identity, expectsSettlement: true, proofOwner: 'main',
    });
    assert.ok(token);
    sends.push(command);
    runtime.settleManualClaim('tab-a', token.claim.id,
      status === 'applied' || status === 'applied-different', 'fixture-proof', {
        status, requestedValue, ...(status.startsWith('applied') ? { actualValue } : {}),
      });
    return { kind, command, requestedValue, status, value: actualValue,
      claimId: token.claim.id, claimOrder: token.claim.admissionOrder, token };
  };
  const finish = async (identity, steps, status = 'applied', extra = {}) => {
    ownerHeld = false;
    return runtime.reconcileManualSettingsOutcome({
      tabId: 'tab-a', runtime: identity, steps, status,
      allowUnattemptedContinuation: status === 'applied', ...extra,
    });
  };
  return {
    runtime, sends, gates, begin, sendManual, finish,
    start: () => runtime.ensure({ tabId: 'tab-a', generation, trigger: 'tui-ready' }),
    setGeneration(value) { generation = value; },
  };
}

test('failed startup model → manual B success + effort 429 updates the same attempt without a second effort', async () => {
  const h = fixture();
  await h.start().promise;
  const oldGate = h.gates.at(-1);
  assert.equal(oldGate.error, 'OLD MODEL 429');
  const operation = h.begin();
  const model = h.sendManual(operation, 'model', 'model-B-id', 'applied', 'Model B');
  const effort = h.sendManual(operation, 'effort', 'max', 'rejected');
  const outcome = { failedCommand: effort.command, error: 'CURRENT EFFORT 429', errorCode: 'rate_limit' };
  // A tempting retry/ensure catch-path is forbidden even if it would make the
  // final snapshot look right after sending the setting twice.
  h.runtime.retry = () => assert.fail('partial outcome must not invoke retry');
  const result = await h.finish(operation, [model, effort], 'partial-failed', outcome);
  assert.equal(result.started, false);
  const snapshot = h.runtime.snapshot('tab-a');
  assert.equal(snapshot.transaction.attemptId, oldGate.attemptId);
  assert.equal(snapshot.transaction.result.failedCommand, '/effort max');
  assert.equal(snapshot.transaction.result.error, 'CURRENT EFFORT 429');
  assert.equal(snapshot.claims.model.value, 'Model B');
  assert.equal(snapshot.claims.model.requestedValue, 'model-B-id');
  assert.equal(snapshot.claims.model.actualValue, 'Model B');
  assert.equal(snapshot.claims.effort, null);
  const gate = h.gates.at(-1);
  assert.equal(gate.failedCommand, '/effort max');
  assert.equal(gate.error, 'CURRENT EFFORT 429');
  assert.ok(gate.failureRevision > oldGate.failureRevision);
  assert.notEqual(gate.failureId, oldGate.failureId, 'dismissed old model failure cannot hide the new effort failure');
  const gateCount = h.gates.length;
  assert.equal((await h.finish(operation, [model, effort], 'partial-failed', outcome)).reason, 'already-reconciled');
  assert.equal(h.gates.length, gateCount);
  await h.start().promise;
  assert.deepEqual(h.sends, ['/model unavailable', '/model model-B-id', '/effort max']);
});

test('full model replacement resumes only the original unattempted effort after owner release', async () => {
  const h = fixture();
  await h.start().promise;
  const attemptId = h.runtime.snapshot('tab-a').transaction.attemptId;
  const operation = h.begin();
  const model = h.sendManual(operation, 'model', 'B', 'applied');
  const recovery = await h.finish(operation, [model]);
  assert.equal(recovery.started, true);
  assert.equal((await recovery.promise).status, 'ready');
  assert.equal(h.runtime.snapshot('tab-a').transaction.attemptId, attemptId);
  assert.equal(h.gates.at(-1).status, 'ready');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort max']);
});

test('full explicit pair closes the failed startup without sending either setting again', async () => {
  const h = fixture();
  await h.start().promise;
  const operation = h.begin();
  const model = h.sendManual(operation, 'model', 'B', 'applied');
  const effort = h.sendManual(operation, 'effort', 'high', 'applied');
  const recovery = await h.finish(operation, [model, effort]);
  assert.equal(recovery.started, false);
  assert.equal(recovery.result.status, 'ready');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort high']);
});

test('model-only D does not supersede an older operation effort failure or revive its default', async () => {
  const h = fixture();
  await h.start().promise;
  const pair = h.begin(['model', 'effort']);
  const b = h.sendManual(pair, 'model', 'B', 'applied');
  const high = h.sendManual(pair, 'effort', 'high', 'rejected');
  const d = h.begin(['model']);
  const modelD = h.sendManual(d, 'model', 'D', 'applied');
  await h.finish(pair, [b, high], 'partial-failed', {
    failedCommand: high.command, error: 'high rejected', errorCode: 'rate_limit',
  });
  await h.finish(d, [modelD]);
  const snapshot = h.runtime.snapshot('tab-a');
  assert.equal(snapshot.transaction.result.status, 'failed');
  assert.equal(snapshot.transaction.result.failedCommand, '/effort high');
  assert.equal(snapshot.claims.model.value, 'D');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort high', '/model D']);
});

test('late effort proof remains applicable after an unrelated newer model-only choice', async () => {
  const h = fixture();
  await h.start().promise;
  const pair = h.begin(['model', 'effort']);
  const b = h.sendManual(pair, 'model', 'B', 'applied');
  const high = h.sendManual(pair, 'effort', 'high', 'unknown');
  await h.finish(pair, [b, high], 'unknown', { failedCommand: high.command, error: 'high pending' });
  const d = h.begin(['model']);
  const modelD = h.sendManual(d, 'model', 'D', 'applied');
  await h.finish(d, [modelD], 'applied', { allowUnattemptedContinuation: false });
  assert.equal(h.runtime.settleManualClaim('tab-a', high.token.claim.id, true, 'late-proof', {
    actualValue: 'high', requestedValue: 'high',
  }), true);
  const late = await h.finish(pair, [{ ...b, status: 'applied' }, { ...high, status: 'applied' }],
    'applied', { allowUnattemptedContinuation: false });
  assert.equal(late.result.status, 'ready');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'D');
  assert.equal(h.runtime.snapshot('tab-a').claims.effort.value, 'high');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort high', '/model D']);
});

test('explicit Retry repeats the displayed manual effort, never the configured default', async () => {
  const h = fixture();
  await h.start().promise;
  const pair = h.begin(['model', 'effort']);
  const b = h.sendManual(pair, 'model', 'B', 'applied');
  const high = h.sendManual(pair, 'effort', 'high', 'rejected');
  await h.finish(pair, [b, high], 'partial-failed', {
    failedCommand: high.command, error: 'high rejected', errorCode: 'rate_limit',
  });
  const before = h.sends.length;
  const retried = await h.runtime.retry('tab-a').promise;
  assert.equal(retried.status, 'ready');
  assert.deepEqual(h.sends.slice(before), ['/effort high']);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'B');
});

test('explicit Retry outranks only an older confirmed fallback, not its rejected newer intent', async () => {
  const h = fixture();
  await h.start().promise;
  const older = h.begin(['effort']);
  const low = h.sendManual(older, 'effort', 'low', 'applied');
  await h.finish(older, [low], 'partial-failed', {
    failedCommand: '/model unavailable', error: 'model still unavailable',
  });
  const pair = h.begin(['model', 'effort']);
  const b = h.sendManual(pair, 'model', 'B', 'applied');
  const high = h.sendManual(pair, 'effort', 'high', 'rejected');
  await h.finish(pair, [b, high], 'partial-failed', {
    failedCommand: high.command, error: 'high rejected', errorCode: 'rate_limit',
  });
  assert.equal(h.runtime.snapshot('tab-a').claims.effort.value, 'low');
  const before = h.sends.length;
  await h.runtime.retry('tab-a').promise;
  assert.deepEqual(h.sends.slice(before), ['/effort high']);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'B');
  assert.equal(h.runtime.snapshot('tab-a').claims.effort.value, 'high');
});

test('explicit Retry of applied-different repeats the requested model, not its observed value/default', async () => {
  const h = fixture({ settings: { model: 'unavailable' } });
  await h.start().promise;
  const operation = h.begin(['model']);
  const model = h.sendManual(operation, 'model', 'wanted-model', 'applied-different', 'other-model');
  await h.finish(operation, [model], 'failed', { failedCommand: model.command, error: 'different model' });
  assert.equal(h.runtime.snapshot('tab-a').claims.model.proofStatus, 'applied-different');
  const before = h.sends.length;
  await h.runtime.retry('tab-a').promise;
  assert.deepEqual(h.sends.slice(before), ['/model wanted-model']);
});

test('late explicit Retry proof cannot replace a newer admitted manual choice', async () => {
  const retryReached = deferred();
  const retryProof = deferred();
  const h = fixture({ settings: { model: 'unavailable' }, proveCommand: async ({ command, explicitRetry }) => {
    if (command === '/model unavailable') {
      return { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'unavailable' };
    }
    if (command === '/model B' && explicitRetry) {
      retryReached.resolve();
      return retryProof.promise;
    }
    return { outcome: PROOF.FOUND, actualValue: command.slice(command.indexOf(' ') + 1) };
  } });
  await h.start().promise;
  const failed = h.begin(['model']);
  const b = h.sendManual(failed, 'model', 'B', 'rejected');
  await h.finish(failed, [b], 'partial-failed', { failedCommand: b.command, error: 'B rejected' });

  const retry = h.runtime.retry('tab-a');
  await retryReached.promise;
  const newer = h.begin(['model']);
  const d = h.sendManual(newer, 'model', 'D', 'applied');
  retryProof.resolve({ outcome: PROOF.FOUND, actualValue: 'B' });
  assert.equal((await retry.promise).status, 'cancelled');
  await h.finish(newer, [d], 'applied', { allowUnattemptedContinuation: false });
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'D');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.via, 'manual-pair');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/model B', '/model D']);
});

for (const firstRetryOutcome of ['rejected', 'unknown']) {
  test('a second explicit Retry keeps the first Retry target after ' + firstRetryOutcome, async () => {
    const h = fixture({ proveCommand: async ({ command, explicitRetry }) => {
      if (command === '/model unavailable') {
        return { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'unavailable' };
      }
      if (command === '/effort high' && explicitRetry) {
        return firstRetryOutcome === 'rejected'
          ? { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'high rejected' }
          : { outcome: PROOF.UNRESOLVED, reason: 'high unknown' };
      }
      return { outcome: PROOF.FOUND, actualValue: command.slice(command.indexOf(' ') + 1) };
    } });
    await h.start().promise;
    const older = h.begin(['effort']);
    const low = h.sendManual(older, 'effort', 'low', 'applied');
    await h.finish(older, [low], 'partial-failed', { failedCommand: '/model unavailable' });
    const pair = h.begin(['model', 'effort']);
    const b = h.sendManual(pair, 'model', 'B', 'applied');
    const high = h.sendManual(pair, 'effort', 'high', 'rejected');
    await h.finish(pair, [b, high], 'partial-failed', { failedCommand: high.command, error: 'high rejected' });
    await h.runtime.retry('tab-a').promise;
    const beforeSecond = h.sends.length;
    await h.runtime.retry('tab-a').promise;
    assert.deepEqual(h.sends.slice(beforeSecond), ['/effort high']);
  });
}

test('successful Retry becomes the fallback between post-click choices and older A', async () => {
  const retryReached = deferred();
  const retryProof = deferred();
  const h = fixture({ settings: { model: 'A', effort: 'max' }, proveCommand: async ({ command, explicitRetry }) => {
    if (command === '/model A') return { outcome: PROOF.FOUND, actualValue: 'A' };
    if (command === '/effort max') return { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'effort rejected' };
    if (command === '/model B' && explicitRetry) { retryReached.resolve(); return retryProof.promise; }
    return { outcome: PROOF.FOUND, actualValue: command.slice(command.indexOf(' ') + 1) };
  } });
  await h.start().promise;
  const failedB = h.begin(['model']);
  const b = h.sendManual(failedB, 'model', 'B', 'rejected');
  await h.finish(failedB, [b], 'partial-failed', { failedCommand: b.command, error: 'B rejected' });
  const retry = h.runtime.retry('tab-a');
  await retryReached.promise;
  const dOperation = h.begin(['model']);
  const d = h.sendManual(dOperation, 'model', 'D', 'unknown');
  retryProof.resolve({ outcome: PROOF.FOUND, actualValue: 'B' });
  assert.equal((await retry.promise).status, 'cancelled');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'D');
  assert.equal(h.runtime.settleManualClaim('tab-a', d.token.claim.id, false, 'D rejected'), true);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'B');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.admissionOrder < d.token.claim.admissionOrder, true);
});

test('Retry fallback is inserted below every post-click choice and above pre-click A', async () => {
  const retryReached = deferred();
  const retryProof = deferred();
  const h = fixture({ settings: { model: 'A', effort: 'max' }, proveCommand: async ({ command, explicitRetry }) => {
    if (command === '/model A') return { outcome: PROOF.FOUND, actualValue: 'A' };
    if (command === '/effort max') return { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'effort rejected' };
    if (command === '/model B' && explicitRetry) { retryReached.resolve(); return retryProof.promise; }
    return { outcome: PROOF.FOUND, actualValue: command.slice(command.indexOf(' ') + 1) };
  } });
  await h.start().promise;
  const failedB = h.begin(['model']);
  const b = h.sendManual(failedB, 'model', 'B', 'rejected');
  await h.finish(failedB, [b], 'partial-failed', { failedCommand: b.command, error: 'B rejected' });
  const retry = h.runtime.retry('tab-a');
  await retryReached.promise;
  const dOperation = h.begin(['model']);
  const d = h.sendManual(dOperation, 'model', 'D', 'unknown');
  await h.finish(dOperation, [d], 'unknown', { failedCommand: d.command, error: 'D unknown' });
  const eOperation = h.begin(['model']);
  const e = h.sendManual(eOperation, 'model', 'E', 'unknown');
  retryProof.resolve({ outcome: PROOF.FOUND, actualValue: 'B' });
  await retry.promise;
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'E');
  assert.equal(h.runtime.settleManualClaim('tab-a', d.token.claim.id, false, 'D rejected'), false);
  assert.equal(h.runtime.settleManualClaim('tab-a', e.token.claim.id, false, 'E rejected'), true);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'B');
});

for (const finalStatus of ['applied', 'rejected', 'unknown']) {
  test('Retry of an older error joins newer pending D through ' + finalStatus, async () => {
    const h = fixture({ settings: { model: 'unavailable' } });
    await h.start().promise;
    const failed = h.begin(['model']);
    const b = h.sendManual(failed, 'model', 'B', 'rejected');
    await h.finish(failed, [b], 'partial-failed', { failedCommand: b.command, error: 'B rejected' });
    const dOperation = h.begin(['model']);
    const d = h.sendManual(dOperation, 'model', 'D', 'unknown');
    const attemptId = h.runtime.snapshot('tab-a').transaction.attemptId;
    const joined = h.runtime.retry('tab-a');
    assert.equal(joined.joined, true);
    assert.equal(joined.reason, 'newer-manual-operation-pending');
    assert.equal(h.runtime.snapshot('tab-a').transaction.attemptId, attemptId);
    if (finalStatus === 'applied') {
      h.runtime.settleManualClaim('tab-a', d.token.claim.id, true, 'D applied', {
        actualValue: 'D', status: 'applied',
      });
      await h.finish(dOperation, [{ ...d, status: 'applied' }], 'applied', {
        allowUnattemptedContinuation: false,
      });
    } else {
      if (finalStatus === 'rejected') h.runtime.settleManualClaim('tab-a', d.token.claim.id, false, 'D rejected');
      await h.finish(dOperation, [{ ...d, status: finalStatus }], finalStatus, {
        failedCommand: d.command, error: 'D ' + finalStatus,
      });
    }
    const result = await joined.promise;
    assert.equal(result.status, finalStatus === 'applied' ? 'ready' : 'failed');
    assert.notEqual(h.runtime.snapshot('tab-a').transaction?.result?.status, null);
  });
}

test('cached Retry join follows newer E outcome instead of an obsolete unknown continuation', { timeout: 3000 }, async () => {
  const oldEffortReached = deferred();
  const oldEffortProof = deferred();
  const h = fixture({ settings: { model: 'unavailable', effort: 'max' },
    proveCommand: async ({ command }) => {
      if (command === '/model unavailable') {
        return { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'unavailable' };
      }
      if (command === '/effort max') {
        oldEffortReached.resolve();
        return oldEffortProof.promise;
      }
      return { outcome: PROOF.FOUND, actualValue: command.slice(command.indexOf(' ') + 1) };
    } });
  await h.start().promise;
  const failed = h.begin(['model']);
  const b = h.sendManual(failed, 'model', 'B', 'rejected');
  await h.finish(failed, [b], 'partial-failed', { failedCommand: b.command, error: 'B rejected' });

  const dOperation = h.begin(['model']);
  const d = h.sendManual(dOperation, 'model', 'D', 'unknown');
  const joined = h.runtime.retry('tab-a');
  h.runtime.settleManualClaim('tab-a', d.token.claim.id, true, 'D applied', {
    actualValue: 'D', status: 'applied',
  });
  const continuation = await h.finish(dOperation, [{ ...d, status: 'applied' }]);
  assert.equal(continuation.started, true);
  await oldEffortReached.promise;

  const eOperation = h.begin(['model', 'effort']);
  const e = h.sendManual(eOperation, 'model', 'E', 'applied');
  const high = h.sendManual(eOperation, 'effort', 'high', 'applied');
  await h.finish(eOperation, [e, high]);
  assert.equal(h.runtime.snapshot('tab-a').transaction.result.status, 'ready');
  assert.equal((await joined.promise).status, 'ready');
  oldEffortProof.resolve({ outcome: PROOF.UNRESOLVED, reason: 'obsolete-proof' });
  await continuation.promise;
});

test('unknown keeps the claim; late success does not submit an unattempted suffix', async () => {
  const h = fixture();
  await h.start().promise;
  const operation = h.begin();
  const model = h.sendManual(operation, 'model', 'B', 'unknown');
  const suffix = { kind: 'effort', command: '/effort max', status: 'unattempted' };
  await h.finish(operation, [model, suffix], 'unknown', { failedCommand: model.command, error: 'proof pending' });
  assert.equal(model.token.status, 'unknown');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.id, model.token.claim.id);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.actualValue, null);
  assert.equal(h.runtime.snapshot('tab-a').transaction.steps[0].status, 'unknown');

  assert.equal(h.runtime.settleManualClaim('tab-a', model.token.claim.id, true, 'late-proof', { actualValue: 'B' }), true);
  await h.finish(operation, [{ ...model, status: 'applied' }, suffix], 'applied', { allowUnattemptedContinuation: false });
  assert.equal(h.runtime.snapshot('tab-a').claims.model.actualValue, 'B');
  assert.equal(h.gates.at(-1).failedCommand, '/effort max');
  assert.equal(h.gates.at(-1).errorCode, 'claude_startup_setting_unattempted');
  await h.start().promise;
  assert.deepEqual(h.sends, ['/model unavailable', '/model B']);

  const explicit = h.begin();
  const effort = h.sendManual(explicit, 'effort', 'max', 'applied');
  await h.finish(explicit, [effort]);
  assert.equal(h.gates.at(-1).status, 'ready');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort max']);
});

test('old operation settles historical proof but cannot replace a newer admitted model or gate', async () => {
  const h = fixture({ settings: { model: 'unavailable' } });
  await h.start().promise;
  const old = h.begin();
  const b = h.sendManual(old, 'model', 'B', 'unknown');
  await h.finish(old, [b], 'unknown');
  const next = h.begin();
  const c = h.sendManual(next, 'model', 'C', 'applied');
  const lastGate = h.gates.at(-1);
  assert.equal(h.runtime.settleManualClaim('tab-a', b.token.claim.id, true, 'late-proof', { actualValue: 'B' }), true);
  const stale = await h.finish(old, [{ ...b, status: 'applied' }]);
  assert.equal(stale.reason, 'stale-settings-operation');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'C');
  assert.equal(h.gates.at(-1), lastGate, 'new admission already owns the gate before its result');
  await h.finish(next, [c]);
  assert.equal(h.gates.at(-1).status, 'ready');
  await h.finish(old, [{ ...b, status: 'applied' }]);
  assert.equal(h.gates.at(-1).status, 'ready');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'C');
});

test('a new model choice does not replay an explicitly rejected effort from the previous partial outcome', async () => {
  const h = fixture();
  await h.start().promise;
  const first = h.begin();
  const b = h.sendManual(first, 'model', 'B', 'applied');
  const effort = h.sendManual(first, 'effort', 'max', 'rejected');
  await h.finish(first, [b, effort], 'partial-failed', { failedCommand: effort.command, error: 'effort rejected' });
  const next = h.begin();
  const c = h.sendManual(next, 'model', 'C', 'applied');
  await h.finish(next, [c]);
  assert.equal(h.gates.at(-1).failedCommand, '/effort max');
  assert.equal(h.gates.at(-1).error, 'effort rejected');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'C');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort max', '/model C']);
});

test('unknown in an earlier setting cannot be turned into an unattempted default by a suffix', async () => {
  const h = fixture();
  await h.start().promise;
  const first = h.begin();
  const b = h.sendManual(first, 'model', 'B', 'applied');
  const unknown = h.sendManual(first, 'effort', 'max', 'unknown');
  await h.finish(first, [b, unknown], 'unknown');
  const next = h.begin();
  const c = h.sendManual(next, 'model', 'C', 'applied');
  await h.finish(next, [c, { kind: 'effort', command: '/effort max', status: 'unattempted' }], 'unknown');
  assert.equal(h.runtime.snapshot('tab-a').transaction.steps.find(step => step.kind === 'effort').status, 'unknown');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort max', '/model C']);
});

test('Stop/relaunch and a replaced startup attempt reject stale outcome and stale claim', async () => {
  for (const relaunch of [false, true]) {
    const h = fixture({ settings: { model: 'unavailable' } });
    await h.start().promise;
    const old = h.begin();
    const b = h.sendManual(old, 'model', 'B', 'unknown');
    await h.finish(old, [b], 'unknown');
    h.runtime.clear('tab-a', 'stop-or-replacement');
    if (relaunch) h.setGeneration('launch-2');
    await h.start().promise;
    const newGate = h.gates.at(-1);
    assert.notEqual(newGate.attemptId, old.startupAttemptId);
    assert.equal(h.runtime.settleManualClaim('tab-a', b.token.claim.id, true, 'late-proof', { actualValue: 'B' }), false);
    assert.equal((await h.finish(old, [{ ...b, status: 'applied' }])).reconciled, false);
    assert.equal(h.gates.at(-1), newGate);
    assert.equal(h.runtime.snapshot('tab-a').claims.model, null);
  }
});

test('startup records observed model separately and a proven different value remains a failure', async () => {
  for (const requestSatisfied of [true, false]) {
    const h = fixture({
      settings: { model: 'requested-id' },
      proveCommand: async () => ({ outcome: PROOF.FOUND, actualValue: 'Observed Model', requestSatisfied }),
    });
    const result = await h.start().promise;
    assert.equal(result.status, requestSatisfied ? 'ready' : 'failed');
    assert.equal(h.runtime.snapshot('tab-a').claims.model.value, 'Observed Model');
    assert.equal(h.runtime.snapshot('tab-a').claims.model.requestedValue, 'requested-id');
    assert.equal(h.runtime.snapshot('tab-a').claims.model.actualValue, 'Observed Model');
    assert.deepEqual(h.sends, ['/model requested-id']);
  }
});

test('manual applied-different keeps the observed effect but neither clears startup nor repeats the command', async () => {
  const h = fixture();
  await h.start().promise;
  const operation = h.begin();
  const model = h.sendManual(operation, 'model', 'B', 'applied-different', 'Observed C');
  await h.finish(operation, [model], 'partial-failed', {
    failedCommand: model.command, error: 'requested B but observed C', errorCode: 'claude_setting_value_mismatch',
  });
  assert.equal(h.runtime.snapshot('tab-a').claims.model.actualValue, 'Observed C');
  assert.equal(h.gates.at(-1).error, 'requested B but observed C');
  assert.equal(h.gates.at(-1).status, 'failed');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B']);
});

test('late startup proof cannot overwrite a reconciled manual partial failure in the same attempt', async () => {
  const reached = deferred();
  const lateProof = deferred();
  const h = fixture({ proveCommand: async () => { reached.resolve(); return lateProof.promise; } });
  const startup = h.start();
  await reached.promise;
  const operation = h.begin();
  const model = h.sendManual(operation, 'model', 'B', 'applied');
  const effort = h.sendManual(operation, 'effort', 'max', 'rejected');
  await h.finish(operation, [model, effort], 'partial-failed', { failedCommand: effort.command, error: 'CURRENT EFFORT 429' });
  const gate = h.gates.at(-1);
  lateProof.resolve({ outcome: PROOF.FOUND, actualValue: 'Old A' });
  assert.equal((await startup.promise).status, 'cancelled');
  assert.equal(h.gates.at(-1), gate);
  assert.equal(h.runtime.snapshot('tab-a').claims.model.actualValue, 'B');
  assert.equal(h.runtime.snapshot('tab-a').transaction.result.error, 'CURRENT EFFORT 429');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort max']);
});

test('ordinary successful startup still sends the model and effort exactly once', async () => {
  const h = fixture({ settings: { model: 'B', effort: 'high' } });
  const startup = h.start();
  assert.equal((await startup.promise).status, 'ready');
  await h.start().promise;
  assert.deepEqual(h.sends, ['/model B', '/effort high']);
  assert.equal(h.gates.at(-1).status, 'ready');
});

test('a continuation finishing after a newer admission cannot make that newer operation look ready', async () => {
  const effortReached = deferred();
  const effortProof = deferred();
  const h = fixture({ proveCommand: async ({ command }) => {
    if (command.startsWith('/model')) return { outcome: PROOF.UNRESOLVED, terminal: true, outputText: 'OLD MODEL 429' };
    effortReached.resolve();
    return effortProof.promise;
  } });
  await h.start().promise;
  const first = h.begin();
  const b = h.sendManual(first, 'model', 'B', 'applied');
  const continuation = await h.finish(first, [b]);
  await effortReached.promise;
  const second = h.begin();
  const c = h.sendManual(second, 'model', 'C', 'applied');
  const effort = h.sendManual(second, 'effort', 'high', 'rejected');
  const pendingGate = h.gates.at(-1);
  effortProof.resolve({ outcome: PROOF.FOUND, actualValue: 'max' });
  assert.equal((await continuation.promise).status, 'cancelled');
  assert.equal(h.gates.at(-1), pendingGate);
  const outcome = await h.finish(second, [c, effort], 'partial-failed', {
    failedCommand: effort.command, error: 'NEW EFFORT REJECTED',
  });
  assert.equal(outcome.reconciled, true);
  assert.equal(h.gates.at(-1).failedCommand, '/effort high');
  assert.equal(h.gates.at(-1).error, 'NEW EFFORT REJECTED');
  assert.equal(h.runtime.snapshot('tab-a').claims.model.actualValue, 'C');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/effort max', '/model C', '/effort high']);
});

test('concurrent late reductions of one operation cannot re-publish an older unknown failure', async () => {
  const h = fixture({ settings: { model: 'unavailable' } });
  await h.start().promise;
  const operation = h.begin();
  const b = h.sendManual(operation, 'model', 'B', 'unknown');
  const unknown = h.finish(operation, [b], 'unknown');
  assert.equal(h.runtime.settleManualClaim('tab-a', b.token.claim.id, true, 'late-proof', { actualValue: 'B' }), true);
  const confirmed = h.finish(operation, [{ ...b, status: 'applied' }], 'applied', { allowUnattemptedContinuation: false });
  assert.equal((await unknown).reconciled, false);
  assert.equal((await confirmed).result.status, 'ready');
  assert.equal(h.gates.at(-1).status, 'ready');
  assert.deepEqual(h.sends, ['/model unavailable', '/model B']);
});

test('settling an unknown old token cannot mutate a replacement attempt even if the launch is unchanged', async () => {
  const h = fixture({ settings: { model: 'unavailable' } });
  await h.start().promise;
  const operation = h.begin();
  const b = h.sendManual(operation, 'model', 'B', 'unknown');
  await h.finish(operation, [b], 'unknown');
  // User Retry keeps the claim registry but replaces the startup attempt.
  const retry = h.runtime.retry('tab-a');
  await retry.promise;
  const gate = h.gates.at(-1);
  assert.notEqual(gate.attemptId, operation.startupAttemptId);
  assert.equal(h.runtime.settleManualClaim('tab-a', b.token.claim.id, true, 'late-proof', { actualValue: 'B' }), false);
  assert.equal((await h.finish(operation, [{ ...b, status: 'applied' }])).reconciled, false);
  assert.equal(h.gates.at(-1), gate);
  assert.deepEqual(h.sends, ['/model unavailable', '/model B', '/model B'],
    'explicit Retry repeats the displayed unresolved target, never a default');
});
