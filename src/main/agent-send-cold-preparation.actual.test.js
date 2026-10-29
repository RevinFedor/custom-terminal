'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const preparation = require(path.join(process.env.COLD_PREPARATION_SOURCE_DIR || __dirname, 'agent-send-preparation'));

// Actual durable-reader/factory, controlled clock and already-staged receipt.
// No process, PTY or live receipt is used by this finite policy test.
function fixture(kind = 'cold-codex', provider = 'codex') {
  let now = 1000;
  const identity = { operationKey: 'O', attemptId: 'A', tabId: 'T', handoffId: 'H', provider };
  const scope = preparation.createSendPreparationScope(identity, now, kind);
  const record = { ...identity, state: 'in-flight', receipt: { preflightScope: scope } };
  const store = { get: key => key === 'O' ? record : null };
  const options = { sendOperationKey: 'O', sendAttemptId: 'A', handoffId: 'H' };
  const read = startup => preparation.readAgentSendPreparation(store, 'T', options, startup, () => now);
  return { identity, scope, record, options, store, read, setNow: value => { now = value; } };
}

test('cold Codex receives exactly120s once, not the warm60s', () => {
  const h = fixture();
  assert.equal(h.scope.preparation.startedAt, 1000);
  assert.equal(h.scope.preparation.deadlineAt, 121000);
  assert.equal(h.scope.preparation.version, 2);
  assert.equal(h.scope.preparation.kind, 'cold-codex');
  assert.equal(Object.isFrozen(h.scope.preparation), true);
});

test('cold preparation still permits current proof at the actual61.4s incident point', () => {
  const h = fixture(); h.setNow(62400);
  assert.equal(h.read({ deadlineAt: 91000 }).failure(), null);
  assert.equal(h.read().remainingMs(), 58600);
  assert.equal(h.record.receipt.preflightScope, h.scope);
});

test('cold scope expires exactly at120s and rereads cannot renew it', () => {
  const h = fixture(), window = h.read(); h.setNow(121000);
  assert.equal(window.failure().code, 'agent_send_preparation_expired');
  h.setNow(121001);
  assert.equal(h.read().failure().code, 'agent_send_preparation_expired');
  assert.equal(h.scope.preparation.deadlineAt, 121000);
});

for (const provider of ['codex', 'claude']) test(provider + ' warm scope retains exact legacy shape and60s', () => {
  const h = fixture('warm', provider);
  assert.deepEqual(h.scope.preparation, { version: 1, startedAt: 1000, deadlineAt: 61000 });
  h.setNow(61000);
  assert.equal(h.read().failure().code, 'agent_send_preparation_expired');
});

test('cold Codex option does not increase Claude or another provider lifetime', () => {
  for (const provider of ['claude', 'other']) {
    const h = fixture('cold-codex', provider);
    assert.equal(h.scope.preparation.deadlineAt, 61000);
  }
});

test('old persisted60s receipt cannot be upgraded by cold caller metadata', () => {
  const h = fixture('warm'); h.setNow(62400);
  h.options.preflightScope = { ...h.scope, preparation: { version: 2, kind: 'cold-codex', startedAt: 1000, deadlineAt: 121000 } };
  assert.equal(h.read().failure().code, 'agent_send_preparation_expired');
  assert.equal(h.record.receipt.preflightScope.preparation.deadlineAt, 61000);
});

test('earlier startup deadline still caps the same cold attempt', () => {
  const h = fixture(); h.setNow(63000);
  assert.equal(h.read({ deadlineAt: 91000 }).remainingMs(), 28000);
  h.setNow(91000);
  assert.equal(h.read({ deadlineAt: 91000 }).failure().code, 'agent_send_preparation_expired');
});

for (const change of ['cancel', 'attempt', 'scope', 'deadline', 'state']) test('cold policy preserves durable refusal on ' + change, () => {
  const h = fixture(), observer = h.read();
  if (change === 'cancel') h.record.deliveryControl = { cancelledAt: 1200 };
  if (change === 'attempt') h.record.attemptId = 'other-A';
  if (change === 'scope') h.record.receipt.preflightScope = { ...h.scope, id: 'other-scope' };
  if (change === 'deadline') h.record.receipt.preflightScope = { ...h.scope,
    preparation: { ...h.scope.preparation, deadlineAt: 121001 } };
  if (change === 'state') h.record.state = 'delivery-unknown';
  assert.equal(observer.failure().code, change === 'cancel' ? 'agent_send_cancelled' : 'agent_send_preparation_superseded');
});

for (const bad of [
  { version: 1, startedAt: 1000, deadlineAt: 121000 },
  { version: 2, kind: 'warm', startedAt: 1000, deadlineAt: 121000 },
  { version: 2, kind: 'cold-codex', startedAt: 1000, deadlineAt: 241000 },
]) test('unsupported window refuses: ' + JSON.stringify(bad), () => {
  const h = fixture(); h.record.receipt.preflightScope = { ...h.scope, preparation: bad };
  assert.equal(h.read().failure().code, 'agent_send_preparation_superseded');
});
