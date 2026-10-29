'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { AgentSendQueue } = require('./agent-send-queue');
const { projectInstallEligibility } = require('./build-install-eligibility');

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE agent_send_receipts(operation_key TEXT PRIMARY KEY,tab_id TEXT,state TEXT,
    handoff_id TEXT,attempt_id TEXT,provider TEXT,session_id TEXT,receipt_json TEXT,input_lease_json TEXT);
    CREATE TABLE agent_send_queue(operation_key TEXT PRIMARY KEY,state TEXT,slot_release_json TEXT,release_json TEXT);`);
  const queue = { db, running: new Set() };
  const legacy = { startupReconciliation: { source: 'startup', decision: 'unknown', reason: 'transcript-unreadable' },
    promptText: 'frozen payload; not projected as an input guard' };
  function add(key, { state = 'delivery-unknown', provider = 'codex', receipt = legacy,
    inputLease = null, queueState = null, retired = false } = {}) {
    db.prepare('INSERT INTO agent_send_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(
      key, 'T', state, key, 'attempt-' + key, provider, 'saved-SID',
      typeof receipt === 'string' ? receipt : JSON.stringify(receipt), inputLease && JSON.stringify(inputLease));
    if (queueState) db.prepare('INSERT INTO agent_send_queue VALUES(?,?,?,NULL)').run(key, queueState,
      retired ? JSON.stringify({ kind: 'input-slot-retired', reason: 'physical-process-absent' }) : null);
  }
  return { db, queue, add, legacy, read: () => AgentSendQueue.prototype.installBlockers.call(queue) };
}

test('43 historical unqueued startup UNKNOWN outcomes are retained byte-for-byte without input actors', t => {
  const h = fixture(t);
  for (let i = 0; i < 43; i++) h.add('old-' + i, { provider: i < 13 ? 'claude' : 'codex' });
  const before = h.db.prepare('SELECT * FROM agent_send_receipts ORDER BY operation_key').all();
  assert.deepEqual(h.read(), []);
  assert.deepEqual(h.db.prepare('SELECT * FROM agent_send_receipts ORDER BY operation_key').all(), before);
});

test('a queued unknown and an executing input remain blockers beside legacy history', t => {
  const h = fixture(t); h.add('old'); h.add('current', { queueState: 'awaiting-receipt' });
  h.queue.running.add('executing-T');
  assert.deepEqual(h.read().map(x => x.operationKey || x.status), ['preparing', 'current']);
});

test('current legacy calls without a startup receipt remain guarded in every uncertain phase', t => {
  const h = fixture(t);
  for (const state of ['preparing', 'in-flight', 'enter-armed', 'audit-pending', 'delivery-unknown', 'evicted-unknown']) {
    h.add(state, { state, receipt: { submitted: null } });
  }
  assert.equal(h.read().length, 6);
});

test('stored input leases and native queue generations are never discarded by the legacy projection', t => {
  const h = fixture(t);
  h.add('lease', { inputLease: { version: 1, lifecycleGeneration: 'G', runSeq: 1 } });
  h.add('native', { receipt: { ...h.legacy, providerQueue: { evidence: { lifecycleGeneration: 'G', runSeq: 1 } } } });
  assert.equal(h.read().length, 2);
});

test('malformed or foreign startup evidence fails closed', t => {
  const h = fixture(t); h.add('bad-json', { receipt: '{' });
  h.add('other-source', { receipt: { startupReconciliation: { source: 'runtime', decision: 'unknown' } } });
  h.add('wrong-state', { state: 'enter-armed' });
  h.add('wrong-decision', { receipt: { startupReconciliation: { source: 'startup', decision: 'found' } } });
  assert.equal(h.read().length, 4);
});

test('physical input, unknown runtime and current turns still close install admission', t => {
  const h = fixture(t); h.add('old');
  for (const physical of [{ kind: 'input', status: 'physical-input' }, { kind: 'input', status: 'runtime-unknown' }]) {
    assert.equal(projectInstallEligibility({ runtime: { idle: true, loaders: [] }, input: [...h.read(), physical], runs: [] }).eligible, false);
  }
  assert.equal(projectInstallEligibility({ runtime: { idle: false, loaders: [{ kind: 'codex', status: 'busy' }] }, input: h.read(), runs: [] }).eligible, false);
});

test('Claude reconciliation is explicitly unsupported and cannot scan or publish input', async () => {
  const { createAgentSendReceiptReconciler } = require('./agent-send-receipt-reconcile');
  const record = { operationKey: 'old', attemptId: 'A', tabId: 'T', provider: 'claude', state: 'delivery-unknown' };
  let scans = 0, publications = 0;
  const reconcile = createAgentSendReceiptReconciler({ store: { get: () => record },
    scan: async () => { scans++; throw Error('must not scan'); }, publishAudit: () => { publications++; } });
  await assert.rejects(reconcile({ tabId: 'T', operationKey: 'old', attemptId: 'A' }), /provider_unsupported/);
  assert.equal(scans, 0); assert.equal(publications, 0);
});

test('missing canonical prompt is an unchanged UNKNOWN, before any transcript read or follower wake', async () => {
  const { createAgentSendReceiptReconciler } = require('./agent-send-receipt-reconcile');
  const record = { operationKey: 'old', attemptId: 'A', tabId: 'T', provider: 'codex', state: 'delivery-unknown',
    requestFingerprint: 'F', promptHash: 'a'.repeat(64), promptLength: 10, sessionId: null, receipt: {} };
  const original = JSON.stringify(record); let publications = 0;
  const reconcile = createAgentSendReceiptReconciler({ store: { get: () => record, listAuditReferences: () => [] },
    publishAudit: () => { publications++; } });
  const result = await reconcile({ tabId: 'T', operationKey: 'old', attemptId: 'A' });
  assert.equal(result.reconciliation.reason, 'receipt-prompt-text-missing');
  assert.equal(result.reconciliation.promoted, false); assert.equal(publications, 0);
  assert.equal(JSON.stringify(record), original);
});
