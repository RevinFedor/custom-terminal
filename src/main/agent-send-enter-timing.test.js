'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { writeWithSendEnterTiming } = require('./agent-send-enter-timing');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');

test('clock is captured on actual Enter call, not its return or later confirmation', () => {
  let now = 1000, recorded, calls = 0;
  const result = writeWithSendEnterTiming(() => { calls++; now = 3000; return 'return'; }, at => { recorded = at; }, () => now);
  assert.equal(result, 'return'); assert.equal(calls, 1); assert.equal(recorded, 1000);
});
test('possible Enter throw retains timestamp and the original exception; diagnostics cannot replace it', () => {
  const original = Error('write outcome unknown'); let recorded;
  assert.throws(() => writeWithSendEnterTiming(() => { throw original; }, at => { recorded = at; }, () => 1000), e => e === original);
  assert.equal(recorded, 1000);
  assert.equal(writeWithSendEnterTiming(() => 7, () => { throw Error('controlled diagnostic failure'); }), 7);
});
test('SQLite timing enriches only exact H/O/A, preserves first time and all delivery/slot fields', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const store = createAgentSendReceiptStore(db);
  const identity = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', provider: 'codex',
    surface: 'desktop-history', requestFingerprint: 'immutable', promptHash: 'hash', promptLength: 6 };
  const attemptId = store.beginAttempt(identity).attemptId;
  store.markAttemptState(identity.operationKey, attemptId, 'enter-armed');
  const before = store.get(identity.operationKey);
  assert.equal(store.recordEnterAttempt({ ...identity, attemptId: 'old', enterAttemptAt: 1100 }), null);
  assert.equal(store.recordEnterAttempt({ ...identity, handoffId: 'other', attemptId, enterAttemptAt: 1100 }), null);
  assert.equal(store.recordEnterAttempt({ ...identity, attemptId, enterAttemptAt: 1200 }), 1200);
  assert.equal(store.recordEnterAttempt({ ...identity, attemptId, enterAttemptAt: 9000 }), 1200);
  const after = store.get(identity.operationKey);
  assert.equal(after.receipt.enterAttemptAt, 1200);
  assert.deepEqual({ ...after, receipt: before.receipt }, before);
  store.settleAttempt(identity.operationKey, attemptId, { submitted: true, status: 'audit-pending', auditPending: true });
  assert.equal(store.get(identity.operationKey).receipt.enterAttemptAt, 1200);
});
