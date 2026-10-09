'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const identity = (extra = {}) => ({ operationKey: 'project:T:H', surface: 'project-api',
  tabId: 'T', handoffId: 'H', provider: 'codex', sessionId: 'S',
  requestFingerprint: 'request-hash', promptHash: 'body-hash', promptLength: 4, ...extra });
function fixture(t, filename = ':memory:') {
  const db = new Database(filename), store = createAgentSendReceiptStore(db, { now: () => 100, settledRetentionMs: 10 });
  t.after(() => db.close());
  const request = identity(); store.reserveOrGet(request);
  const cancel = (attemptId, extra = {}) => store.cancelDelivery({ ...request, attemptId,
    reason: 'tab-message-cancel', presentationDismissed: true, ...extra });
  return { db, store, request, cancel };
}

test('cancel before attempt is durable intent, not fabricated delivery evidence', t => {
  const f = fixture(t), before = f.store.get(f.request.operationKey);
  const result = f.cancel(null);
  assert.equal(result.ok, true);
  assert.equal(result.record.state, 'reserved');
  assert.equal(result.record.receipt, before.receipt);
  assert.equal(f.store.beginAttempt(f.request).action, 'replay');
  assert.equal(f.store.get(f.request.operationKey).attemptId, null);
  assert.equal(f.cancel(null).idempotent, true);
});

test('cancelled handoff cannot return after settled receipt pruning and actual SQLite reopen', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-intent-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'test.sqlite'), f = fixture(t, filename);
  f.cancel(null); f.store.settleQueuedNoWrite(f.request.operationKey, { cancelled: true });
  f.store.prune(1000);
  assert.equal(f.store.get(f.request.operationKey), null);
  const reopened = fixture(t, filename);
  const replay = reopened.store.beginAttempt(f.request);
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'agent_send_cancelled');
  assert.equal(reopened.store.isDeliveryCancelled(f.request.operationKey), true);
  assert.equal(reopened.store.beginAttempt(identity({ requestFingerprint: 'different' })).code, 'agent_send_handoff_conflict');
});

test('cancel races preparation: pre-Enter durable arm rejects even without the in-memory registry', t => {
  const f = fixture(t), start = f.store.beginAttempt(f.request);
  f.cancel(start.attemptId);
  assert.equal(f.store.markAttemptState(f.request.operationKey, start.attemptId, 'enter-armed').reason, 'delivery-cancelled');
  assert.equal(f.store.get(f.request.operationKey).state, 'in-flight');
  assert.equal(f.store.isDeliveryCancelled(f.request.operationKey, 'old-attempt'), false);
});

test('cancel after Enter preserves unknown and late exact delivery, but never reopens intent', t => {
  const f = fixture(t), start = f.store.beginAttempt(f.request);
  f.store.markAttemptState(f.request.operationKey, start.attemptId, 'enter-armed');
  f.store.settleAttempt(f.request.operationKey, start.attemptId, { submitted: true, status: 'delivery-unknown', deliveryUnknown: true });
  const before = f.store.get(f.request.operationKey);
  f.cancel(start.attemptId);
  assert.deepEqual(f.store.get(f.request.operationKey).receipt, before.receipt);
  assert.equal(f.store.get(f.request.operationKey).state, 'delivery-unknown');
  const audit = f.store.promoteFromAudit({ success: true, operationKey: f.request.operationKey,
    attemptId: start.attemptId, provider: 'codex', sessionId: 'S', promptHash: 'body-hash',
    actualHash: 'body-hash', expectedHash: 'body-hash', entryUuid: 'user-1', sourceIdentity: 'source-1' });
  assert.equal(audit.promoted, true);
  assert.equal(f.store.get(f.request.operationKey).state, 'confirmed');
  assert.ok(f.store.get(f.request.operationKey).deliveryControl.cancelledAt);
  assert.equal(f.store.beginAttempt(f.request).action, 'replay');
});

test('foreign cancellation and old callback cannot cancel another operation/attempt', t => {
  const f = fixture(t), start = f.store.beginAttempt(f.request);
  assert.equal(f.cancel(start.attemptId, { tabId: 'foreign' }).ok, false);
  assert.equal(f.cancel('old').reason, 'stale-attempt');
  assert.equal(f.store.get(f.request.operationKey).deliveryControl, null);
});

test('input lease is durable and immutable on the exact Enter boundary', t => {
  const f = fixture(t), start = f.store.beginAttempt(f.request);
  const lease = { version: 1, tabId: 'T', provider: 'codex', lifecycleGeneration: 'G', runSeq: 1 };
  assert.equal(f.store.markAttemptState(f.request.operationKey, start.attemptId, 'enter-armed', { inputLease: { ...lease, tabId: 'foreign' } }).ok, false);
  assert.equal(f.store.get(f.request.operationKey).inputLease, null);
  assert.equal(f.store.markAttemptState(f.request.operationKey, start.attemptId, 'enter-armed', { inputLease: lease }).ok, true);
  assert.deepEqual(f.store.get(f.request.operationKey).inputLease, lease);
  assert.equal(f.store.markAttemptState(f.request.operationKey, start.attemptId, 'enter-armed', { inputLease: { ...lease, lifecycleGeneration: 'B' } }).reason, 'input-lease-changed');
});
