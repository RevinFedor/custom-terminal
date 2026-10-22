'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createBuildInstallContinuations } = require('./build-install-continuation');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE state(value TEXT)');
  const receipts = createAgentSendReceiptStore(db);
  const source = { tabId: '753', projectId: 'P', toolType: 'codex', sessionId: 'S', cwd: '/private',
    expectedTarget: { toolType: 'codex', sessionId: 'S' } };
  const changes = [], inputs = [], reads = [];
  let complete = false, owner = 'S', coherent = true, failWrite = false;
  const queue = new AgentSendQueue({ store: receipts, ready: () => false, execute: async request => { inputs.push(request); } });
  const create = () => createBuildInstallContinuations({
    read: () => { const r = db.prepare('SELECT value FROM state').get(); return r ? JSON.parse(r.value) : null; },
    write: value => {
      if (failWrite) throw Error('fixture:EIO');
      db.transaction(() => { db.prepare('DELETE FROM state').run(); db.prepare('INSERT INTO state VALUES (?)').run(JSON.stringify(value)); })();
    }, receipts: () => receipts, readQueuedRequest: key => queue.item(key),
    readSource: async () => ({ coherent, toolType: 'codex', sessionId: owner, processStatus: 'found' }),
    readResult: async request => { reads.push(request); return { found: true, complete, userUuid: 'callback-user',
      sourceIdentity: 'callback-address', sourceVerified: true, executionContext: { turnId: 'callback-turn', sessionId: owner } }; },
    changed: entry => changes.push(entry),
  });
  let service = create();
  const begin = () => service.reserve({ requestId: 'I', jobId: 'J', source });
  const arm = () => service.armCallback({ requestId: 'I', jobId: 'J', prompt: 'continue original iteration' });
  const request = { tabId: '753', provider: 'codex', handoffId: 'build-install-return:J',
    prompt: 'continue original iteration', source: 'build-install-return', expectedTarget: source.expectedTarget };
  const identity = { operationKey: 'project:753:build-install-return:J', surface: 'project-api',
    tabId: '753', handoffId: request.handoffId, provider: 'codex', sessionId: 'S',
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
  const attempt = (patch = {}) => receipts.beginAttempt({ ...identity, ...patch });
  const promote = (attemptId, sessionId = 'S') => receipts.promoteFromAudit({ success: true, operationKey: identity.operationKey, attemptId,
    provider: 'codex', sessionId, promptHash: identity.promptHash, actualHash: identity.promptHash,
    entryUuid: 'callback-user', sourceIdentity: 'callback-address', auditTimestamp: '2026-10-20T00:01:00Z',
    transcriptBoundary: { byteOffset: 1 } });
  t.after(async () => { queue.dispose(); await tick(); db.close(); });
  return { db, receipts, inputs, reads, changes, source, begin, arm, attempt, promote,
    enqueueProvisional: () => queue.enqueue({ identity: { ...identity, sessionId: null }, request }),
    read: () => service.snapshot(), blocked: () => service.blocked('753'), reconcile: () => service.reconcile('753'),
    restore: () => { service = create(); }, complete: value => complete = value,
    owner: value => owner = value, coherent: value => coherent = value, failWrite: value => failWrite = value,
    reserve: value => service.reserve(value), callback: value => service.armCallback(value),
    settle: job => service.settleNoCallback(job),
    cancel: (request, status) => service.cancelConfirmedWait(request, status),
  };
}

test('install ACK/shutdown/restart and callback receipt preserve Loop hold; only exact callback result releases', async t => {
  const h = fixture(t); h.begin(); assert.equal(h.blocked(), true); h.restore(); assert.equal(h.blocked(), true);
  h.arm(); const attempt = h.attempt();
  h.receipts.markAttemptState('project:753:build-install-return:J', attempt.attemptId, 'enter-armed');
  h.receipts.settleAttempt('project:753:build-install-return:J', attempt.attemptId,
    { success: null, submitted: true, status: 'delivery-unknown', deliveryUnknown: true });
  await h.reconcile(); assert.equal(h.blocked(), true); assert.equal(h.reads.length, 0);
  assert.equal(h.promote(attempt.attemptId).promoted, true);
  await h.reconcile(); assert.equal(h.blocked(), true, 'canonical callback is not completed callback work');
  assert.equal(h.reads[0].promptUserUuid, 'callback-user');
  h.complete(true); h.owner('replacement'); await h.reconcile(); assert.equal(h.blocked(), true);
  h.owner('S'); h.coherent(false); await h.reconcile(); assert.equal(h.blocked(), true);
  h.coherent(true); await h.reconcile(); assert.equal(h.blocked(), false);
  const completed = h.read().entries[0]; assert.equal(completed.callbackProof.turnId, 'callback-turn');
  assert.equal(completed.outcomeFloorAt, Date.parse('2026-10-20T00:01:00Z'));
  h.restore(); await h.reconcile(); assert.equal(h.blocked(), false); assert.equal(h.inputs.length, 0);
  h.arm(); await h.reconcile(); assert.equal(h.inputs.length, 0, 'duplicate/late callback cannot create provider input');
});

function closeWaitRequest(h) {
  return { tabId: '753', requestId: 'I', id: 'J', fingerprint: h.read().entries[0].fingerprint };
}
function terminalStatus(patch = {}) {
  return { known: true, stale: false, jobs: [{ id: 'J', requestId: 'I', running: false,
    phase: 'finished', cancelled: true, installOutcomeUnknown: false,
    returnTo: { tabId: '753', sessionId: 'S' }, callback: { status: 'sent' }, ...patch }] };
}
test('explicit disposal of a confirmed return wait is durable cancellation, not natural completion or another Send', async t => {
  const h = fixture(t); h.begin(); h.arm(); const a = h.attempt(); h.promote(a.attemptId);
  const before = JSON.stringify(h.receipts.get('project:753:build-install-return:J'));
  const request = closeWaitRequest(h), result = h.cancel(request, terminalStatus());
  assert.equal(result.state, 'cancelled'); assert.equal(h.blocked(), false);
  assert.equal(result.callbackProof, undefined); assert.ok(result.outcomeFloorAt > 0);
  assert.equal(JSON.stringify(h.receipts.get('project:753:build-install-return:J')), before);
  assert.equal(h.reads.length, 0); assert.equal(h.inputs.length, 0);
  h.restore(); h.complete(true); await h.reconcile();
  assert.equal(h.read().entries[0].state, 'cancelled');
  assert.equal(h.cancel(request, terminalStatus()).state, 'cancelled');
  assert.throws(() => h.arm(), /already_settled/);
});
for (const what of ['running', 'unknown', 'unconfirmed', 'wrong-owner', 'stale']) {
  test('wait disposal rejects ' + what + ' without changing the receipt or guard', t => {
    const h = fixture(t); h.begin(); h.arm(); const a = h.attempt();
    if (what !== 'unconfirmed') h.promote(a.attemptId);
    const request = closeWaitRequest(h), status = terminalStatus();
    if (what === 'running') status.jobs[0].running = true;
    if (what === 'unknown') status.jobs[0].installOutcomeUnknown = true;
    if (what === 'wrong-owner') request.fingerprint = 'foreign';
    if (what === 'stale') status.stale = true;
    assert.throws(() => h.cancel(request, status), /cancel_(unproven|owner_changed)/);
    assert.equal(h.blocked(), true); assert.equal(h.read().entries[0].state, 'waiting-callback-turn');
    assert.equal(h.inputs.length, 0);
  });
}
test('failed cancellation persistence is not acknowledged and identical retry commits the retained intent', t => {
  const h = fixture(t); h.begin(); h.arm(); const a = h.attempt(); h.promote(a.attemptId);
  const request = closeWaitRequest(h); h.failWrite(true);
  assert.throws(() => h.cancel(request, terminalStatus()), /EIO/);
  assert.throws(h.blocked, /write_unconfirmed/);
  h.failWrite(false); assert.equal(h.cancel(request, terminalStatus()).state, 'cancelled');
  h.restore(); assert.equal(h.blocked(), false); assert.equal(h.inputs.length, 0);
});

test('positive installer cancellation preserves ON semantics without a fake completion or permanent hold', async t => {
  const h = fixture(t); h.begin();
  h.settle({ id: 'J', requestId: 'I', running: false, cancelled: true, finishedAt: 123,
    callback: { status: 'skipped' }, returnTo: { tabId: '753', sessionId: 'S' } });
  assert.equal(h.blocked(), false); assert.equal(h.read().entries[0].state, 'ended-without-callback');
  assert.equal(h.read().entries[0].outcomeFloorAt, 123); assert.equal(h.read().entries[0].callbackProof, undefined);
  assert.equal(h.inputs.length, 0);
});

test('common Resume child is accepted only through the original immutable FIFO request; unrelated writer cannot acquire it', async t => {
  const h = fixture(t); h.begin(); h.arm(); h.enqueueProvisional();
  const attempt = h.attempt({ sessionId: null });
  assert.equal(h.promote(attempt.attemptId, 'child-B').promoted, true);
  h.complete(true); h.owner('unrelated-C'); await h.reconcile(); assert.equal(h.blocked(), true);
  h.owner('child-B'); await h.reconcile(); assert.equal(h.blocked(), false);
  assert.equal(h.read().entries[0].callbackProof.sessionId, 'child-B'); assert.equal(h.inputs.length, 0);
});

test('same ID cannot retarget source/callback; dirty release never green-lights Loop and survives strict retry', async t => {
  const h = fixture(t); h.begin(); h.arm();
  assert.throws(() => h.reserve({ requestId: 'I', jobId: 'J', source: { ...h.source, tabId: 'sibling' } }), /identity_changed/);
  assert.throws(() => h.callback({ requestId: 'I', jobId: 'J', prompt: 'different' }), /callback_changed/);
  const attempt = h.attempt(); h.promote(attempt.attemptId); h.complete(true); h.failWrite(true);
  await assert.rejects(h.reconcile, /EIO/); assert.throws(h.blocked, /write_unconfirmed/);
  h.failWrite(false); await h.reconcile(); assert.equal(h.blocked(), false); assert.equal(h.inputs.length, 0);
});
