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
const { classifyInputSlotRetirement } = require('./agent-send-input-slot');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, { filename = ':memory:', read, ready = () => true } = {}) {
  const db = new Database(filename), store = createAgentSendReceiptStore(db), writes = [], observations = [];
  let generation = 'G1';
  const queue = new AgentSendQueue({ store, ready,
    readInputSlot: async record => { observations.push(record.operationKey); return read ? read(record) : observation(generation); },
    execute: async request => {
      writes.push(request.handoffId);
      const begun = store.beginAttempt(identity(request));
      assert.equal(begun.action, 'attempt-started');
      store.markAttemptState(request.sendOperationKey, begun.attemptId, 'enter-armed', { inputLease: {
        version: 1, tabId: 'T', provider: 'codex', lifecycleGeneration: generation, runSeq: 1,
      } });
      store.settleAttempt(request.sendOperationKey, begun.attemptId, { submitted: true, status: 'delivery-unknown', deliveryUnknown: true });
      return store.get(request.sendOperationKey).receipt;
    } });
  function identity(request) { return { operationKey: request.sendOperationKey, tabId: 'T', handoffId: request.handoffId,
    surface: 'desktop-history', provider: 'codex', sessionId: 'S', requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: fingerprintAgentSendRequest(request.prompt), promptLength: request.prompt.length }; }
  const add = (id, extra = {}) => { const request = { tabId: 'T', provider: 'codex', handoffId: id,
    sendOperationKey: 'history:T:' + id, prompt: 'immutable-' + id, expectedTarget: { toolType: 'codex', sessionId: 'S' }, ...extra };
  return queue.enqueue({ identity: identity(request), request }); };
  t.after(async () => { queue.dispose(); await tick(); if (db.open) db.close(); });
  return { db, store, queue, add, writes, observations, generation: value => { generation = value; } };
}
function observation(generation, extra = {}) {
  return { version: 1, kind: 'main-input-slot', tabId: 'T', known: true, ownerStable: true,
    processStatus: 'found', inputReady: true, owner: { lifecycleGeneration: generation, runSeq: 1 },
    isCurrent: () => true, ...extra };
}

test('ready/idle alone cannot retire a same-owner uncertain attempt', async t => {
  const h = fixture(t); h.add('a'); h.add('b'); await tick(); await tick();
  await h.queue.retireObsoleteInputSlot('T');
  assert.deepEqual(h.writes, ['a']);
  assert.equal(h.queue.item('history:T:a').state, 'awaiting-receipt');
});

test('exact replacement input retires only the old slot; original receipt and attempt stay unknown', async t => {
  let current = observation('G1');
  const h = fixture(t, { read: () => current }); h.add('a'); h.add('b'); await tick(); await tick();
  const before = h.store.get('history:T:a');
  current = observation('G2', { inputReady: false }); await h.queue.retireObsoleteInputSlot('T');
  assert.deepEqual(h.writes, ['a']);
  current = observation('G2'); h.generation('G2');
  assert.equal(await h.queue.retireObsoleteInputSlot('T'), true); await tick(); await tick();
  assert.deepEqual(h.writes, ['a', 'b']);
  assert.deepEqual(h.store.get('history:T:a'), before);
  assert.equal(h.queue.queueInfo('history:T:a').inputSlot.state, 'retired');
  assert.equal(h.queue.item('history:T:b').state, 'awaiting-receipt');
});

test('unknown lookup, unstable owner and foreign observation cannot retire any slot', async t => {
  let current = observation('G1'); const h = fixture(t, { read: () => current });
  h.add('a'); h.add('b'); await tick(); await tick();
  for (const invalid of [observation('G2', { known: false }), observation('G2', { ownerStable: false }),
    observation('G2', { tabId: 'foreign' }), observation('G2', { isCurrent: () => false }),
    observation('G2', { processStatus: 'unknown' }), observation('G2', { isCurrent: null })]) {
    current = invalid; assert.equal(await h.queue.retireObsoleteInputSlot('T'), false);
    assert.deepEqual(h.writes, ['a']);
  }
});

test('old observer returning after exact receipt promotion cannot retire the successor', async t => {
  const gate = deferred(); let held = false;
  const h = fixture(t, { read: () => held ? gate.promise : observation('G1') });
  h.add('a'); h.add('b'); await tick(); await tick();
  held = true; const pending = h.queue.retireObsoleteInputSlot('T'); await tick();
  const a = h.store.get('history:T:a');
  h.store.promoteFromAudit({ success: true, operationKey: a.operationKey, attemptId: a.attemptId,
    provider: 'codex', sessionId: 'S', promptHash: a.promptHash, actualHash: a.promptHash,
    expectedHash: a.promptHash, entryUuid: 'user-a', sourceIdentity: 'source-a' });
  await tick(); assert.deepEqual(h.writes, ['a', 'b']);
  held = false; gate.resolve(observation('G2')); assert.equal(await pending, false);
  assert.equal(h.queue.item('history:T:b').state, 'awaiting-receipt');
});

test('runtime changes during an observation are coalesced but not lost; identical publication cannot poll', async t => {
  const gate = deferred(); let hold = false, current = observation('G1');
  const h = fixture(t, { read: () => hold ? gate.promise : current });
  h.add('a'); h.add('b'); await tick(); await tick();
  hold = true; h.queue.notifyRuntime('T', 'starting-G2'); await tick();
  const count = h.observations.length;
  for (let i = 0; i < 20; i++) h.queue.notifyRuntime('T', 'starting-G2');
  assert.equal(h.observations.length, count);
  h.queue.notifyRuntime('T', 'ready-G2'); h.generation('G2'); current = observation('G2'); hold = false;
  gate.resolve(observation('G2', { inputReady: false })); await tick(); await tick(); await tick();
  assert.deepEqual(h.writes, ['a', 'b']);
  const settledCount = h.observations.length;
  await tick(); await tick(); assert.equal(h.observations.length, settledCount, 'no timer or repeated self-read');
});

test('retired slot survives SQLite reopen and never replays old input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-slot-reopen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, 'queue.sqlite');
  let current = observation('G1'), ready = true;
  const first = fixture(t, { filename, ready: () => ready, read: () => current });
  first.add('a'); first.add('b'); await tick(); await tick();
  ready = false; current = observation('G2');
  assert.equal(await first.queue.retireObsoleteInputSlot('T'), true);
  first.queue.dispose(); first.db.close();
  const next = fixture(t, { filename }); next.store.reconcileStartup(); next.queue.resume(); await tick(); await tick();
  assert.deepEqual(next.writes, ['b']);
  assert.equal(next.store.get('history:T:a').state, 'delivery-unknown');
});

test('a proved absent process frees admission; absence is never inferred from a failure', async t => {
  let current = observation('G1'); const h = fixture(t, { read: () => current });
  h.add('a'); h.add('b'); await tick(); await tick();
  current = observation(null, { processStatus: 'absent' });
  assert.equal(await h.queue.retireObsoleteInputSlot('T'), true);
  current = observation('G1'); await tick(); await tick(); assert.deepEqual(h.writes, ['a', 'b']);
});

test('legacy native-queue generation is reusable, but missing legacy identity is not guessed', () => {
  const record = { tabId: 'T', provider: 'codex', state: 'delivery-unknown', attemptId: 'A', receipt: {
    providerQueue: { evidence: { lifecycleGeneration: 'G1', runSeq: 1 } } } };
  assert.equal(classifyInputSlotRetirement(record, observation('G2')).retire, true);
  assert.equal(classifyInputSlotRetirement({ ...record, receipt: {} }, observation('G2')).retire, false);
});

test('cancelled unknown retains bytes; late canonical proof completes only its retired row', async t => {
  const h = fixture(t);
  h.add('a', { authoringSnapshot: { imagePaths: [{ id: 1, path: '/synthetic.png', assetId: 'asset-a' }] } });
  h.add('b'); await tick(); await tick();
  h.queue.cancelDelivery('T', 'a', { dismiss: true }); await tick(); await tick();
  assert.deepEqual(h.writes, ['a', 'b']);
  assert.ok(h.queue.referencedAssetIds().has('asset-a'), 'unknown input is still an asset owner');
  const record = h.store.get('history:T:a');
  h.store.promoteFromAudit({ success: true, operationKey: record.operationKey, attemptId: record.attemptId,
    provider: 'codex', sessionId: 'S', promptHash: record.promptHash, actualHash: record.promptHash,
    expectedHash: record.promptHash, entryUuid: 'user-a', sourceIdentity: 'source-a' });
  assert.equal(h.queue.item(record.operationKey).state, 'completed');
  assert.equal(h.queue.queueInfo(record.operationKey).inputSlot.state, 'retired');
  assert.equal(h.queue.item('history:T:b').state, 'awaiting-receipt');
  assert.equal(h.queue.referencedAssetIds().has('asset-a'), false);
  assert.ok(h.store.get(record.operationKey).deliveryControl.cancelledAt);
  await tick(); assert.deepEqual(h.writes, ['a', 'b']);
});

test('dismissed no-input cancellation releases only its own recoverable asset ownership', async t => {
  const h = fixture(t, { ready: () => false });
  const image = id => ({ authoringSnapshot: { imagePaths: [{ id: 1, path: '/' + id + '.png', assetId: id }] } });
  h.add('a', image('asset-a')); h.add('b', image('asset-b'));
  assert.equal(h.queue.cancelDelivery('T', 'a', { dismiss: true }).cancelled, true);
  assert.equal(h.store.get('history:T:a').state, 'not-submitted');
  assert.equal(h.queue.referencedAssetIds().has('asset-a'), false);
  assert.equal(h.queue.referencedAssetIds().has('asset-b'), true);
  assert.deepEqual(h.writes, []);
});

for (const physical of ['absent', 'replacement']) {
  test('renderer loss preserves uncertainty but not a permanent slot after exact ' + physical + ' proof', async t => {
    let current = observation('G1');
    const h = fixture(t, { read: () => current });
    h.add('a'); h.add('b'); await tick(); await tick();
    const original = h.store.get('history:T:a');
    h.store.cancelDelivery({ operationKey: original.operationKey, tabId: 'T', handoffId: 'a',
      attemptId: original.attemptId, provider: 'codex', reason: 'send-renderer-owner-lost' });
    await tick(); await tick();
    assert.deepEqual(h.writes, ['a'], 'automatic input revocation is not a release grant');
    const fenced = h.store.get(original.operationKey);
    current = physical === 'absent' ? observation(null, { processStatus: 'absent' }) : observation('G2');
    h.generation('G2');
    assert.equal(await h.queue.retireObsoleteInputSlot('T'), true);
    await tick(); await tick();
    assert.deepEqual(h.writes, ['a', 'b'], 'same follower, not replay of old input');
    assert.deepEqual(h.store.get(original.operationKey), fenced, 'slot release must not rewrite delivery or cancellation');
    assert.equal(h.queue.queueInfo(original.operationKey).inputSlot.reason,
      physical === 'absent' ? 'physical-process-absent' : 'physical-input-owner-replaced');
    assert.equal(h.store.get(original.operationKey).state, 'delivery-unknown');
  });
}

test('renderer-loss retirement still requires fresh exact physical proof, not merely a cancellation marker', async t => {
  let current = observation('G1');
  const h = fixture(t, { read: () => current }); h.add('a'); h.add('b'); await tick(); await tick();
  const original = h.store.get('history:T:a');
  h.store.cancelDelivery({ operationKey: original.operationKey, tabId: 'T', handoffId: 'a',
    attemptId: original.attemptId, provider: 'codex', reason: 'send-renderer-owner-lost' });
  await tick(); await tick();
  for (const invalid of [observation('G1'), observation('G2', { inputReady: false }),
    observation('G2', { known: false }), observation('G2', { ownerStable: false }),
    observation('G2', { tabId: 'foreign' }), observation('G2', { processStatus: 'unknown' }),
    observation('G2', { isCurrent: () => false }), observation('G2', { isCurrent: null })]) {
    current = invalid;
    assert.equal(await h.queue.retireObsoleteInputSlot('T'), false);
    assert.deepEqual(h.writes, ['a']);
  }
});
