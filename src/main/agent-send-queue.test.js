'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t, provider = 'codex', filename = ':memory:') {
  const db = new Database(filename);
  const store = createAgentSendReceiptStore(db, { maxRecords: 3 });
  const sends = [], events = [];
  let response = 'queued';
  const request = (id, extra = {}) => ({ tabId: 'T', provider, handoffId: id,
    sendOperationKey: 'history:T:' + id, prompt: 'same text', source: 'history-panel', ...extra });
  const identity = req => ({ operationKey: req.sendOperationKey, surface: 'desktop-history',
    tabId: req.tabId, provider, handoffId: req.handoffId,
    requestFingerprint: fingerprintAgentSendRequest(req), promptHash: fingerprintAgentSendRequest(req.prompt),
    promptLength: req.prompt.length, sessionId: null });
  const execute = async req => {
    sends.push(req);
    const start = store.beginAttempt(identity(req));
    assert.equal(start.action, 'attempt-started');
    store.markAttemptState(req.sendOperationKey, start.attemptId, 'enter-armed');
    if (response === 'unknown') {
      store.settleAttempt(req.sendOperationKey, start.attemptId,
        { submitted: true, success: null, status: 'delivery-unknown', deliveryUnknown: true });
    } else {
      store.settleAttempt(req.sendOperationKey, start.attemptId,
        { success: true, submitted: true, auditPending: true, status: 'audit-pending' });
      store.markProviderQueueAccepted(req.sendOperationKey, start.attemptId, {
        provider, sessionId: 'S', sourceIdentity: provider === 'codex' ? 'codex-tui-queue:' + req.handoffId : 'claude-queue:' + req.handoffId,
      });
    }
    return store.get(req.sendOperationKey).receipt;
  };
  const queue = new AgentSendQueue({ store, execute, publish: event => events.push(event) });
  t.after(async () => { queue.dispose(); await tick(); db.close(); });
  const add = (id, extra) => { const req = request(id, extra); return queue.enqueue({ identity: identity(req), request: req }); };
  const confirm = id => {
    const record = store.get('history:T:' + id);
    return store.promoteFromAudit({ success: true, operationKey: record.operationKey,
      attemptId: record.attemptId, provider, sessionId: 'S',
      promptHash: record.promptHash, actualHash: record.promptHash, expectedHash: record.promptHash,
      entryUuid: 'user-' + id, sourceIdentity: provider + '-user-source-' + id,
      auditTimestamp: new Date().toISOString(), transcriptBoundary: { byteOffset: 100 } });
  };
  return { db, store, queue, sends, events, add, confirm, request, identity,
    response: value => { response = value; } };
}

for (const provider of ['claude', 'codex']) {
  test(provider + ': more than two sends; only canonical consumption releases the next while streaming', async t => {
    const h = harness(t, provider);
    for (let i = 0; i < 12; i++) assert.equal(h.add('h' + i).receipt.applicationQueued, true);
    assert.equal(h.sends.length, 0, 'commit precedes execution');
    await tick();
    assert.deepEqual(h.sends.map(r => r.handoffId), ['h0']);
    assert.equal(h.store.get('history:T:h0').state, 'audit-pending');
    assert.equal(h.queue.receipt('history:T:h1').submitted, false);
    for (let i = 0; i < 12; i++) {
      assert.equal(h.confirm('h' + i).promoted, true);
      await tick();
      assert.equal(h.sends.length, Math.min(i + 2, 12));
    }
    assert.deepEqual(h.sends.map(r => r.handoffId), Array.from({ length: 12 }, (_, i) => 'h' + i));
    assert.equal(h.db.prepare("SELECT count(*) n FROM agent_send_queue WHERE state = 'completed'").get().n, 12);
  });
}

test('exact duplicate joins; same text with different IDs remains separate; edited same-ID request conflicts', async t => {
  const h = harness(t);
  h.add('a'); h.add('b');
  assert.equal(h.add('a').replayed, true);
  assert.equal(h.add('a', { prompt: 'changed' }).code, 'agent_send_handoff_conflict');
  await tick();
  assert.equal(h.sends.length, 1);
  h.confirm('a'); await tick();
  assert.equal(h.sends.length, 2);
});

test('frozen text/images/chips survive editing the caller snapshot', async t => {
  const h = harness(t);
  h.add('a');
  const payload = { prompt: 'user B', presentationSnapshot: { imagePaths: [{ id: 1, path: '/var/image.png' }] },
    authoringSnapshot: { editorText: '[Image #1] user B', chips: [{ kind: 'prompt', text: 'context B' }] } };
  h.add('b', payload);
  payload.presentationSnapshot.imagePaths[0].path = '/foreign.png';
  payload.authoringSnapshot.chips[0].text = 'changed';
  await tick(); h.confirm('a'); await tick();
  assert.equal(h.sends[1].presentationSnapshot.imagePaths[0].path, '/var/image.png');
  assert.equal(h.sends[1].authoringSnapshot.chips[0].text, 'context B');
});

test('unknown and foreign audit do not release; cancelling a waiting item never touches head', async t => {
  const h = harness(t); h.response('unknown');
  h.add('a'); h.add('b'); h.add('c'); await tick();
  const a = h.store.get('history:T:a');
  assert.equal(h.store.promoteFromAudit({ success: true, operationKey: a.operationKey,
    attemptId: 'foreign', provider: 'codex', sessionId: 'S', actualHash: a.promptHash,
    expectedHash: a.promptHash, promptHash: a.promptHash, entryUuid: 'foreign' }).promoted, false);
  await tick(); assert.equal(h.sends.length, 1);
  assert.equal(h.queue.cancelWaiting('T', 'b').count, 1);
  assert.equal(h.store.get('history:T:b').attemptId, null);
  assert.equal(h.store.get('history:T:b').receipt.enterWritten, false);
  assert.equal(h.queue.cancelWaiting('T', 'a').count, 0);
  h.confirm('a'); await tick();
  assert.deepEqual(h.sends.map(r => r.handoffId), ['a', 'c']);
});

test('manual Stop cancels all not-yet-dispatched snapshots without resuming the provider', async t => {
  const h = harness(t); h.add('a'); h.add('b'); h.add('c'); await tick();
  assert.equal(h.queue.cancelWaiting('T').count, 2);
  h.confirm('a'); await tick();
  assert.equal(h.sends.length, 1);
  for (const id of ['b','c']) assert.equal(h.store.get('history:T:' + id).receipt.promptText, 'same text');
});

test('SQLite reopen keeps FIFO and unknown head; exact audit resumes one original pending request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-send-queue-'));
  const file = path.join(dir, 'queue.db');
  const h = harness(t, 'claude', file);
  h.add('a'); h.add('b'); h.add('c'); await tick();
  h.queue.dispose();
  // A second connection reproduces a new main owner without touching the
  // original test connection's receipt identity or weakening recovery rules.
  const h2 = harness(t, 'claude', file);
  h2.store.reconcileStartup(); h2.queue.resume(); await tick();
  assert.equal(h2.sends.length, 0);
  h2.confirm('a'); await tick();
  assert.deepEqual(h2.sends.map(r => r.handoffId), ['b']);
  assert.equal(h2.queue.receipt('history:T:c').status, 'application-queued');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
});

test('a completed audit cannot let the next scenario overlap the first bridge finally', async t => {
  const h = harness(t);
  let release;
  const a = h.request('a');
  h.queue.enqueue({ identity: h.identity(a), request: a, execute: async () => {
    const start = h.store.beginAttempt(h.identity(a));
    h.store.markAttemptState(a.sendOperationKey, start.attemptId, 'enter-armed');
    h.store.settleAttempt(a.sendOperationKey, start.attemptId, { submitted: true, auditPending: true });
    h.confirm('a');
    await new Promise(resolve => { release = resolve; });
    return h.store.get(a.sendOperationKey).receipt;
  } });
  h.add('b'); await tick(); assert.equal(h.sends.length, 0);
  release(); await tick(); assert.deepEqual(h.sends.map(r => r.handoffId), ['b']);
});

test('a generic success without exact canonical identity never frees the provider slot', async t => {
  const h = harness(t);
  const a = h.request('a');
  h.queue.enqueue({ identity: h.identity(a), request: a, execute: async () => {
    const begun = h.store.beginAttempt(h.identity(a));
    h.store.settleAttempt(a.sendOperationKey, begun.attemptId, { success: true, submitted: true });
    return h.store.get(a.sendOperationKey).receipt;
  } });
  h.add('b'); await tick();
  assert.equal(h.store.get(a.sendOperationKey).state, 'confirmed');
  assert.equal(h.queue.item(a.sendOperationKey).state, 'awaiting-receipt');
  assert.equal(h.sends.length, 0);
});

test('Stop cancels a head still preparing and its waiters get a durable negative result', async t => {
  const h = harness(t); let release; const signals = [];
  h.queue.cancelAttempt = record => signals.push(record.operationKey);
  const a = h.request('a');
  h.queue.enqueue({ identity: h.identity(a), request: a, execute: async () => {
    await new Promise(resolve => { release = resolve; });
    // The real web dispatcher performs this cancellation check before begin.
    assert.equal(h.queue.item(a.sendOperationKey).state, 'cancelled');
    return { submitted: false, error: 'cancelled' };
  } });
  h.add('b');
  const waiting = h.queue.result('history:T:b');
  await tick();
  assert.equal(h.queue.receipt(a.sendOperationKey).status, 'application-queued');
  h.queue.stop('T');
  assert.equal((await waiting).state, 'not-submitted');
  assert.deepEqual(signals, [a.sendOperationKey]);
  release(); await tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.get(a.sendOperationKey).receipt.enterWritten, false);
});

test('cold followers inherit exact consumed head conversation and pin that proof until their turn', async t => {
  const h = harness(t); h.add('a');
  const b = h.request('b'); let scope;
  h.queue.enqueue({ identity: h.identity(b), request: b, execute: async value => {
    scope = value;
    return { submitted: false, error: 'fixture stop before provider' };
  } });
  await tick(); h.confirm('a');
  // Even pruning during the handoff cannot remove the source of inherited scope.
  h.store.prune(Date.now() + 30 * 24 * 3600 * 1000);
  await tick();
  assert.equal(scope.expectedTarget.sessionId, 'S');
  assert.equal(scope.expectedTarget.toolType, 'codex');
  assert.equal(scope.requestFingerprint, h.identity(b).requestFingerprint);
});

test('independent task admission waits for the existing idle policy; runtime event wakes it without polling', async t => {
  const h = harness(t); let idle = false; let reads = 0;
  h.queue.admit = async request => { reads++; return request.sendSurface !== 'orchestration' || idle; };
  h.add('task', { sendSurface: 'orchestration' }); h.add('following');
  await tick(); assert.equal(h.sends.length, 0);
  assert.equal(h.queue.receipt('history:T:task').applicationQueued, true);
  const before = reads; await tick(); assert.equal(reads, before, 'no state polling');
  idle = true; h.queue.notifyRuntime('T'); await tick();
  assert.equal(h.sends.length, 1);
  h.confirm('task'); await tick(); assert.equal(h.sends.length, 2);
});

test('a runtime wake during an asynchronous admission read is not lost', async t => {
  const h = harness(t); let resolve; let reads = 0;
  h.queue.admit = async () => ++reads === 1 ? await new Promise(r => { resolve = r; }) : true;
  h.add('a'); await tick();
  h.queue.notifyRuntime('T'); resolve(false); await tick();
  assert.equal(reads, 2); assert.equal(h.sends.length, 1);
});

test('failed authoring and asset references outlive receipt retention until explicit dismissal', async t => {
  const h = harness(t);
  const r = h.request('failed', { authoringSnapshot: { editorText: 'own draft',
    imagePaths: [{ id: 1, path: '/asset.png', assetId: 'owned-image' }] } });
  h.queue.enqueue({ identity: h.identity(r), request: r,
    execute: async () => ({ submitted: false, success: false, error: 'preparation failed' }) });
  await tick();
  h.store.prune(Date.now() + 60 * 24 * 3600 * 1000);
  assert.ok(h.store.get(r.sendOperationKey));
  assert.equal(h.queue.referencedAssetIds().has('owned-image'), true);
  assert.equal(h.queue.dismissUnwritten('T', 'failed').cancelled, true);
  assert.equal(h.queue.referencedAssetIds().has('owned-image'), false);
  h.store.prune(Date.now() + 60 * 24 * 3600 * 1000);
  assert.equal(h.store.get(r.sendOperationKey), null);
});
