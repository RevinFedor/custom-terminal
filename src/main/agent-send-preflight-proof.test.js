'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { classifyAgentSendReceipt } = require('./orchestration-runs');

function fixture(t, disk = false) {
  const dir = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'noted-preflight-proof-')) : null;
  const file = dir ? path.join(dir, 'receipt.sqlite') : ':memory:';
  let db = new Database(file), store = createAgentSendReceiptStore(db);
  const identity = { operationKey: 'operation', surface: 'project-api', tabId: 'T', handoffId: 'H',
    requestFingerprint: 'immutable-request', provider: 'codex', sessionId: 'S', promptHash: 'hash', promptLength: 12 };
  const begun = store.beginAttempt(identity);
  const scope = { version: 1, id: 'main-issued-invocation', operationKey: identity.operationKey,
    attemptId: begun.attemptId, tabId: identity.tabId, handoffId: identity.handoffId, provider: identity.provider };
  assert.equal(store.stageAttemptContext(identity.operationKey, begun.attemptId, { preflightScope: scope }).ok, true);
  const receipt = () => ({ success: null, accepted: null, submitted: null, deliveryUnknown: true,
    status: 'delivery-unknown', operationKey: identity.operationKey, attemptId: begun.attemptId,
    code: 'agent_send_target_changed', preflightRefusal: { version: 1, scope: { ...scope },
      phase: 'ensuring-ready', providerOperationStarted: false, launchStage: 'no-launch',
      launchWritten: false, launchAccepted: false, launchIntentId: 'launch:fixture:1',
      launchToken: 1, launchAttempt: 1, reason: 'process_lookup_unknown' } });
  t.after(() => { db.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  return { identity, scope, begun, receipt, get store() { return store; },
    settle: value => store.settleAttempt(identity.operationKey, begun.attemptId, value),
    reopen() { db.close(); db = new Database(file); store = createAgentSendReceiptStore(db); } };
}

test('verified preflight outcome and exact identity survive SQLite close/reopen', t => {
  const h = fixture(t, true);
  const settled = h.settle(h.receipt());
  assert.equal(settled.record.state, 'not-submitted');
  assert.equal(classifyAgentSendReceipt(settled.record.receipt).state, 'not-submitted');
  h.reopen();
  const record = h.store.get(h.identity.operationKey);
  assert.equal(record.state, 'not-submitted');
  assert.equal(record.attemptId, h.begun.attemptId);
  assert.equal(record.requestFingerprint, h.identity.requestFingerprint);
  assert.equal(record.receipt.preflightRefusal.verified, true);
  assert.deepEqual(record.receipt.preflightScope, h.scope);
});

for (const field of ['id', 'operationKey', 'attemptId', 'tabId', 'handoffId', 'provider']) {
  test('foreign preflight proof cannot change delivery: ' + field, t => {
    const h = fixture(t), receipt = h.receipt();
    receipt.preflightRefusal.scope[field] = 'foreign';
    assert.equal(h.settle(receipt).record.state, 'delivery-unknown');
  });
}

test('an issued scope cannot be replaced within the same attempt', t => {
  const h = fixture(t);
  const changed = h.store.stageAttemptContext(h.identity.operationKey, h.begun.attemptId,
    { preflightScope: { ...h.scope, id: 'replacement' } });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'preflight-scope-changed');
  assert.deepEqual(h.store.get(h.identity.operationKey).receipt.preflightScope, h.scope);
});

for (const mode of ['provider-phase', 'written', 'boundary', 'already-unknown', 'no-proof']) {
  test('preflight refinement requires positive no-provider proof: ' + mode, t => {
    const h = fixture(t), receipt = h.receipt();
    if (mode === 'provider-phase') receipt.preflightRefusal.phase = 'provider-operation';
    if (mode === 'written') receipt.pasteWritten = true;
    if (mode === 'boundary') h.store.stageAttemptContext(h.identity.operationKey, h.begun.attemptId,
      { transcriptBoundary: { sessionId: 'S', fileSize: 12 }, transportText: 'original' });
    if (mode === 'already-unknown') h.settle({ submitted: null, deliveryUnknown: true, status: 'delivery-unknown' });
    if (mode === 'no-proof') delete receipt.preflightRefusal;
    assert.equal(h.settle(receipt).record.state, 'delivery-unknown');
  });
}

test('negative proof never removes durable cancellation or grants a replacement attempt', t => {
  const h = fixture(t);
  h.store.cancelDelivery({ ...h.identity, attemptId: h.begun.attemptId, reason: 'user-cancel' });
  const settled = h.settle(h.receipt());
  assert.equal(settled.record.state, 'not-submitted');
  assert.ok(settled.record.deliveryControl.cancelledAt);
  assert.equal(h.store.beginAttempt(h.identity).action, 'replay');
});
