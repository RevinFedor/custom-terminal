'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createOrchestrationDeliverySingleFlight,
  mergeDeliveryWake,
} = require('./orchestration-delivery-single-flight');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a readiness wake received during an unknown admission gets one trailing dispatch', async () => {
  const firstAttempt = deferred();
  const attempts = [];
  let sends = 0;
  const gate = createOrchestrationDeliverySingleFlight();
  const execute = async (request) => {
    attempts.push(request);
    if (attempts.length === 1) {
      await firstAttempt.promise;
      return { dispatched: false, deferred: true, reason: 'target-not-idle' };
    }
    sends += 1;
    return { dispatched: true, deferred: false, reason: null };
  };

  const stale = gate.run('run-1', {
    reason: 'request',
    targetStatus: { status: 'unknown', inputReady: false },
  }, execute);
  const exact = gate.run('run-1', {
    reason: 'startup-defaults-ready',
    targetStatus: { status: 'active', inputReady: true, sessionId: 'session-1' },
  }, execute);

  assert.equal(gate.isActive('run-1'), true);
  firstAttempt.resolve();
  assert.deepEqual(await Promise.all([stale, exact]), [
    { dispatched: true, deferred: false, reason: null },
    { dispatched: true, deferred: false, reason: null },
  ]);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].targetStatus.sessionId, 'session-1');
  assert.equal(sends, 1);
  assert.equal(gate.isActive('run-1'), false);
});

test('a successful first dispatch does not replay a cosmetic trailing wake', async () => {
  const firstAttempt = deferred();
  let attempts = 0;
  const gate = createOrchestrationDeliverySingleFlight();
  const execute = async () => {
    attempts += 1;
    await firstAttempt.promise;
    return { dispatched: true, deferred: false, reason: null };
  };

  const first = gate.run('run-2', { reason: 'request' }, execute);
  const concurrent = gate.run('run-2', {
    reason: 'ready-snapshot',
    targetStatus: { status: 'active', inputReady: true },
  }, execute);
  firstAttempt.resolve();
  await Promise.all([first, concurrent]);
  assert.equal(attempts, 1);
});

test('a later status replaces stale status while a reason-only wake preserves it', () => {
  const exact = mergeDeliveryWake(
    { reason: 'first', targetStatus: { status: 'unknown' } },
    { reason: 'ready', targetStatus: { status: 'active', inputReady: true } },
  );
  assert.deepEqual(exact, {
    reason: 'ready',
    targetStatus: { status: 'active', inputReady: true },
  });
  assert.deepEqual(mergeDeliveryWake(exact, { reason: 'done' }), {
    reason: 'done',
    targetStatus: { status: 'active', inputReady: true },
  });
});
