'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const identity = { operationKey: 'inbox:R', surface: 'inbox', runId: 'R', tabId: 'T', handoffId: 'external-run:R',
  requestFingerprint: 'exact-fingerprint', provider: 'codex', sessionId: null, promptHash: 'hash', promptLength: 4 };
const setup = { runId: 'R', reservedTabId: 'T', handoffId: 'external-run:R', executionId: 'execution-A',
  conversationKey: 'chat-A', source: 'fixture' };
const result = { tabId: 'T', projectId: '__noted_inbox__', toolType: 'codex', launchId: 'launch-A', lifecycleGeneration: 'generation-A' };

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-inbox-setup-'));
  let db;
  try { db = new Database(path.join(root, 'fixture.sqlite')); }
  catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Electron ABI'); return null; } throw error;
  }
  let store = createAgentSendReceiptStore(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.reserveOrGet(identity); store.markPreparing(identity.operationKey);
  return { get store() { return store; }, init: input => store.recordInboxSetup(identity.operationKey, identity.requestFingerprint, input || setup),
    update: patch => store.updateInboxSetup(identity.operationKey, setup.executionId, patch),
    reopen: () => { db.close(); db = new Database(path.join(root, 'fixture.sqlite')); store = createAgentSendReceiptStore(db); } };
}

test('original creation request/result survive observation, beginAttempt and SQLite reopen without a new creator', t => {
  const h = harness(t); if (!h) return;
  assert.equal(h.init().ok, true);
  h.update({ creationRequestId: 'bridge-A', dispatched: true, observedExpired: true });
  assert.equal(h.store.beginAttempt(identity).action, 'replay', 'pending creator cannot claim Send');
  h.update({ creationState: 'created', creationResult: result });
  const saved = h.store.get(identity.operationKey).inboxSetup;
  assert.equal(h.store.beginAttempt(identity).action, 'attempt-started');
  h.reopen();
  assert.deepEqual(h.store.get(identity.operationKey).inboxSetup, saved);
  assert.equal(h.store.beginAttempt(identity).action, 'replay');
  assert.equal(h.init({ ...setup, executionId: 'execution-B' }).ok, false);
});

test('foreign scope/execution/request/receipt cannot replace the original proof', t => {
  const h = harness(t); if (!h) return;
  for (const field of ['runId', 'reservedTabId', 'handoffId']) assert.equal(h.init({ ...setup, [field]: 'FOREIGN' }).ok, false);
  assert.equal(h.store.recordInboxSetup(identity.operationKey, 'other-fingerprint', setup).ok, false);
  h.init(); h.update({ creationRequestId: 'bridge-A', dispatched: true });
  assert.equal(h.init({ ...setup, conversationKey: 'FOREIGN' }).ok, false);
  assert.equal(h.store.updateInboxSetup(identity.operationKey, 'execution-B', { creationState: 'refused' }).ok, false);
  assert.equal(h.update({ creationRequestId: 'bridge-B' }).ok, false);
  for (const field of ['tabId', 'toolType', 'projectId']) assert.equal(h.update({ creationState: 'created', creationResult: { ...result, [field]: 'OTHER' } }).ok, false);
  assert.equal(h.update({ creationState: 'created' }).ok, false);
  h.update({ creationState: 'created', creationResult: result });
  assert.equal(h.update({ creationState: 'refused' }).ok, false);
  assert.equal(h.update({ creationResult: { ...result, launchId: 'OTHER' } }).ok, false);
});

test('unknown cannot yield no-write or a new Send; exact creator refusal has explicit persisted no-write', t => {
  const h = harness(t); if (!h) return;
  h.init(); h.update({ creationRequestId: 'bridge-A', dispatched: true, creationState: 'unknown' });
  assert.equal(h.store.settleInboxSetupNoWrite(identity.operationKey, setup.executionId).ok, false);
  assert.equal(h.store.beginAttempt(identity).action, 'replay');
  h.reopen(); assert.equal(h.store.get(identity.operationKey).inboxSetup.creationState, 'unknown');
  // Only a subsequently captured SAME exact reply can strengthen unknown.
  h.update({ creationState: 'refused' });
  const refused = h.store.settleInboxSetupNoWrite(identity.operationKey, setup.executionId, { code: 'fixture_refusal' });
  assert.equal(refused.ok, true);
  assert.equal(refused.record.inboxSetup.noSubmitProof.kind, 'no-submit');
  assert.equal(refused.record.receipt.pasteWritten, false); assert.equal(refused.record.receipt.enterWritten, false);
  const saved = refused.record; h.reopen(); assert.deepEqual(h.store.get(identity.operationKey), saved);
  assert.equal(h.update({ creationRequestId: 'bridge-B', dispatched: true }).ok, false);
  assert.equal(h.store.beginAttempt(identity).action, 'replay');
});

test('no-write is bound to pre-Send setup, never to a newer provider attempt or a legacy null attempt', t => {
  const h = harness(t); if (!h) return;
  assert.equal(h.store.settleInboxSetupNoWrite(identity.operationKey, setup.executionId).ok, false, 'legacy preparing is not proof');
  h.init(); h.update({ creationState: 'created', creationResult: result });
  assert.equal(h.store.settleInboxSetupNoWrite(identity.operationKey, 'FOREIGN').ok, false);
  h.store.beginAttempt(identity);
  assert.equal(h.store.settleInboxSetupNoWrite(identity.operationKey, setup.executionId).ok, false);
});
