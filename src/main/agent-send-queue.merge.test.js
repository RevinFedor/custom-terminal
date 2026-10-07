'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { TabWorkContext } = require('./tab-work-context');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PromptQueueAssetStore } = require('./prompt-queue-assets');
const { createOwnedAttachmentSnapshot, prepareOwnedAttachmentTransport } = require('./owned-mobile-attachments');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, filename = ':memory:') {
  const db = new Database(filename), store = createAgentSendReceiptStore(db), sent = [], published = [];
  let ready = false;
  const context = new TabWorkContext({ db, listTabs: () => [{ tabId: 'T', projectId: 'P', cwd: '/private-fixture', commandType: 'codex', codexSessionId: 'S' }], onChanged() {} });
  const identity = request => ({ operationKey: request.sendOperationKey, tabId: 'T', handoffId: request.handoffId,
    surface: 'desktop-history', provider: request.provider, sessionId: null,
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length });
  const queue = new AgentSendQueue({ store, ready: () => ready, publishMerge: value => published.push(value),
    transferMergedContext: ({ tabId, requests, request }) => context.mergeHandoffs(tabId, requests, request),
    execute: async request => {
      sent.push(request); const start = store.beginAttempt(identity(request));
      store.settleAttempt(request.sendOperationKey, start.attemptId,
        { success: null, submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
      return store.get(request.sendOperationKey).receipt;
    } });
  const add = (id, prompt, extra = {}) => {
    const request = { tabId: 'T', provider: 'codex', handoffId: id, sendOperationKey: 'history:T:' + id,
      source: 'history-panel', sendSurface: 'desktop-history', prompt, expectedTarget: { toolType: 'codex', sessionId: 'S' },
      authoringSnapshot: { editorText: prompt, chips: [], imagePaths: [] }, ...extra };
    const result = queue.enqueue({ identity: identity(request), request }); assert.equal(result.ok, true); return result;
  };
  const command = (id = 'b', requestId = 'merge-one') => ({ ...queue.mergeGuard('history:T:' + id), requestId });
  t.after(async () => { queue.dispose(); await tick(); db.close(); });
  return { db, store, queue, context, sent, published, add, command,
    setReady: value => ready = value, identity };
}

test('two untouched user messages become one immutable replacement at the previous FIFO position', async t => {
  const f = fixture(t); f.add('a', 'first'); f.add('b', 'second'); f.add('c', 'third');
  const oldA = f.queue.item('history:T:a').request_json, oldB = f.queue.item('history:T:b').request_json;
  const request = f.command(), merged = await f.queue.mergeWaiting(request);
  assert.equal(merged.success, true); assert.equal(merged.record.receipt.promptText, 'first\n\nsecond');
  assert.equal(merged.record.applicationQueue.position, 1);
  assert.equal(f.queue.item('history:T:a').request_json, oldA); assert.equal(f.queue.item('history:T:b').request_json, oldB);
  assert.equal(f.store.get('history:T:a').state, 'not-submitted'); assert.equal(f.store.get('history:T:a').attemptId, null);
  assert.equal(f.queue.item('history:T:a').state, 'merged'); assert.equal(f.queue.item('history:T:c').predecessor_key, merged.operationKey);
  assert.equal(f.published.length, 1); assert.equal(f.sent.length, 0);
  assert.equal((await f.queue.mergeWaiting(request)).operationKey, merged.operationKey);
  assert.equal(f.db.prepare('SELECT count(*) n FROM agent_send_queue').get().n, 4);
  assert.equal((await f.queue.mergeWaiting({ ...request, requestHash: 'different' })).success, false);
  f.setReady(true); f.queue.resume(); await tick();
  assert.deepEqual(f.sent.map(value => value.prompt), ['first\n\nsecond']);
  assert.equal(f.sent[0].sendOperationKey, merged.operationKey); assert.equal(f.sent[0].source, 'history-panel');
});

test('same-text distinct messages are both retained, and a third merge keeps the original position', async t => {
  const f = fixture(t); f.add('a', 'same'); f.add('b', 'same'); f.add('c', 'tail');
  const first = await f.queue.mergeWaiting(f.command());
  assert.equal(first.record.receipt.promptText, 'same\n\nsame');
  const next = await f.queue.mergeWaiting(f.command('c', 'merge-two'));
  assert.equal(next.success, true); assert.equal(next.record.applicationQueue.position, 1);
  assert.equal(next.record.receipt.promptText, 'same\n\nsame\n\ntail');
  assert.equal(next.record.receipt.authoringSnapshot.editorText, 'same\n\nsame\n\ntail');
});

test('race with attempt/cancel, nonadjacent identity and changed settings never merge or write', async t => {
  for (const mode of ['attempt', 'cancel', 'wrong-previous', 'settings', 'service']) {
    const f = fixture(t); f.add('a', 'first'); f.add('b', 'second'); f.add('c', 'third');
    const request = f.command();
    if (mode === 'attempt') f.store.beginAttempt({ ...f.store.get('history:T:a') });
    if (mode === 'cancel') f.queue.cancelWaiting('T', 'a');
    if (mode === 'wrong-previous') request.previousOperationKey = 'history:T:c';
    if (mode === 'settings' || mode === 'service') {
      const row = f.queue.item('history:T:b'), body = JSON.parse(row.request_json);
      if (mode === 'settings') body.model = 'other'; else body.source = 'terminal-mcp';
      // Controlled adversarial store fixture, never a product mutation route.
      f.db.prepare('UPDATE agent_send_queue SET request_json=? WHERE operation_key=?').run(JSON.stringify(body), row.operation_key);
    }
    const result = await f.queue.mergeWaiting(request);
    assert.equal(result.success, false, mode); assert.equal(result.disposition, 'not-applied');
    assert.equal(f.db.prepare('SELECT count(*) n FROM agent_send_queue_merges').get().n, 0);
    assert.equal(f.sent.length, 0);
  }
});

test('an entered/unknown predecessor is never offered as a merge target', async t => {
  const f = fixture(t); f.add('head', 'entered'); f.add('a', 'first'); f.add('b', 'second');
  const r = f.store.get('history:T:head'), attempt = f.store.beginAttempt({ ...r });
  f.store.settleAttempt(r.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
  assert.equal(f.queue.mergeGuard('history:T:a'), null);
  assert.equal(f.queue.mergeGuard('history:T:b').previousOperationKey, 'history:T:a');
  const merged = await f.queue.mergeWaiting(f.command()); assert.equal(merged.success, true);
  f.setReady(true); f.queue.resume(); await tick(); assert.equal(f.sent.length, 0);
});

test('a failure during context transfer rolls back receipts, queue replacement and position', async t => {
  const f = fixture(t); f.add('a', 'first'); f.add('b', 'second');
  f.queue.transferMergedContext = () => { throw new Error('fixture rollback'); };
  const before = f.db.prepare('SELECT * FROM agent_send_queue ORDER BY id').all();
  const result = await f.queue.mergeWaiting(f.command());
  assert.equal(result.success, false); assert.deepEqual(f.db.prepare('SELECT * FROM agent_send_queue ORDER BY id').all(), before);
  assert.equal(f.store.get('history:T:a').state, 'reserved'); assert.equal(f.store.get('history:T:b').state, 'reserved');
  assert.equal(f.store.get('history:T:queued-merge:merge-one'), null); assert.equal(f.published.length, 0);
});

test('rich recovery reindexes colliding image/chip IDs and keeps both independent chip payloads', async t => {
  const f = fixture(t), image = { id: 1, path: '/private-fixture/a.png' };
  const chip = { id: 'chip', kind: 'prompt', sourceKey: 'same-source', text: 'context' };
  f.add('a', 'one [imagePath:/private-fixture/a.png]', { authoringSnapshot: { editorText: 'one [Image #1]', imagePaths: [image], chips: [chip] },
    presentationSnapshot: { imagePaths: [image], promptChips: [chip] } });
  f.add('b', 'two [imagePath:/private-fixture/b.png]', { authoringSnapshot: { editorText: 'two [Image #1]', imagePaths: [{ ...image, path: '/private-fixture/b.png' }], chips: [chip] },
    presentationSnapshot: { imagePaths: [{ ...image, path: '/private-fixture/b.png' }], promptChips: [chip] } });
  const result = await f.queue.mergeWaiting(f.command()); assert.equal(result.success, true);
  const authoring = result.record.receipt.authoringSnapshot;
  assert.equal(authoring.editorText, 'one [Image #1]\n\ntwo [Image #2]'); assert.deepEqual(authoring.imagePaths.map(ref => ref.id), [1, 2]);
  assert.equal(authoring.chips.length, 2); assert.notEqual(authoring.chips[0].id, authoring.chips[1].id);
  assert.equal(result.record.receipt.presentationSnapshot.promptChips.length, 2);
});

test('deferred context changes transfer once; old cancellation cannot return merged updates to pending', async t => {
  const f = fixture(t);
  const published = f.context.publish('T', { sourceTabId: 'other', requestId: 'context', title: 'Context', text: 'changed' });
  const first = await f.context.prepare('T', 'a', 'first'); const second = await f.context.prepare('T', 'b', 'second');
  f.add('a', first.prompt); f.add('b', second.prompt);
  const result = await f.queue.mergeWaiting(f.command()); assert.equal(result.success, true);
  f.context.release('T', 'a'); f.context.activate('T', 'a');
  assert.equal(f.db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(published.updateId).status, 'sending');
  f.context.assertContinuationScope('T', result.handoffId);
  f.context.confirm('T', result.handoffId, promptAuditFingerprint(result.record.receipt.promptText));
  assert.equal(f.db.prepare('SELECT status FROM tab_context_updates WHERE id=?').get(published.updateId).status, 'delivered');
});

test('replacement and SAME-ID merge receipt survive SQLite reopen without moving behind later messages', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-merge-reopen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'queue.db'), first = fixture(t, filename);
  first.add('a', 'first'); first.add('b', 'second'); first.add('c', 'last');
  const request = first.command(), result = await first.queue.mergeWaiting(request);
  first.queue.dispose();
  const reopened = fixture(t, filename);
  assert.equal(reopened.queue.readMerge(request.requestId, 'T').operationKey, result.operationKey);
  assert.equal(reopened.queue.readMerge(request.requestId, 'other'), null);
  assert.equal((await reopened.queue.mergeWaiting(request)).operationKey, result.operationKey);
  assert.equal(reopened.db.prepare('SELECT count(*) n FROM agent_send_queue').get().n, 4);
  reopened.setReady(true); reopened.queue.resume(); await tick();
  assert.deepEqual(reopened.sent.map(value => value.prompt), ['first\n\nsecond']);
});

test('dispatch during asynchronous preparation refuses the merge and does not add a second sender', async t => {
  const f = fixture(t); f.add('a', 'first'); f.add('b', 'second');
  const request = f.command(), pending = f.queue.mergeWaiting(request);
  f.setReady(true); f.queue.resume(); await tick();
  const result = await pending;
  assert.equal(result.success, false); assert.equal(result.code, 'send_queue_merge_no_longer_waiting');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].prompt, 'first');
  assert.equal(f.db.prepare('SELECT count(*) n FROM agent_send_queue_merges').get().n, 0);
});

test('two retained document versions at one deleted temp path keep exact bytes and ranges through merge', async t => {
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-merge-assets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'upload.pdf'), assetStore = new PromptQueueAssetStore({ rootDir: path.join(dir, 'assets') });
  const ids = [];
  for (const [id, bytes] of [['a', '%PDF-version-A'], ['b', '%PDF-version-B']]) {
    fs.writeFileSync(sourcePath, bytes);
    const handle = await fs.promises.open(sourcePath, 'r');
    const imported = await assetStore.importUploadHandle(handle, { kind: 'file', path: sourcePath, name: 'upload.pdf', mediaType: 'application/pdf' });
    await handle.close();
    const ref = { ...imported.ref, sourcePath, sourceKey: 'upload/upload.pdf', uploadId: 'upload', kind: 'file', name: 'upload.pdf' };
    ids.push(ref.assetId);
    const line = '- [file] upload.pdf: ' + sourcePath, prompt = id + '\n' + line, start = prompt.indexOf(sourcePath);
    const snapshot = createOwnedAttachmentSnapshot({ prompt, refs: [ref], fileRanges: [{ start, end: start + sourcePath.length, sourcePath, line }],
      tabId: 'T', handoffId: id, operationKey: 'history:T:' + id, requestFingerprint: 'owned-' + id });
    f.add(id, prompt, { ownedAttachments: snapshot }); imported.release();
  }
  fs.unlinkSync(sourcePath);
  const result = await f.queue.mergeWaiting(f.command()); assert.equal(result.success, true);
  const merged = f.store.get(result.operationKey), owned = merged.receipt.ownedAttachments;
  assert.deepEqual(owned.refs.map(ref => ref.assetId), ids);
  assert.deepEqual(owned.ranges.map(range => range.refIndex), [0, 1]);
  assert.deepEqual([...f.queue.referencedAssetIds()].sort(), [...ids].sort());
  const begun = f.store.beginAttempt({ ...merged });
  f.store.stageAttemptContext(merged.operationKey, begun.attemptId, { ownedAttachments: owned });
  const transport = await prepareOwnedAttachmentTransport({ record: f.store.get(merged.operationKey), prompt: merged.receipt.promptText,
    provider: 'codex', assetStore, authoringTransport: merged.receipt.presentationSnapshot.authoringTransport });
  assert.equal(fs.readFileSync(transport.projection.paths[0], 'utf8'), '%PDF-version-A');
  assert.equal(fs.readFileSync(transport.projection.paths[1], 'utf8'), '%PDF-version-B');
  assert.equal(transport.projection.attemptId, begun.attemptId);
  assert.ok(transport.text.includes(ids[0]) && transport.text.includes(ids[1]));
});

test('retiring old receipts/rows cannot re-enqueue a superseded original operation', async t => {
  const f = fixture(t); f.add('a', 'first'); f.add('b', 'second');
  const original = JSON.parse(f.queue.item('history:T:a').request_json);
  const merged = await f.queue.mergeWaiting(f.command()); assert.equal(merged.success, true);
  // The committed journal is still an exact read after its replacement receipt
  // retires; it must not reconstruct an unowned queued presentation.
  const savedRequest = { requestId: 'merge-one', tabId: 'T' };
  f.store.prune(Date.now() + 30 * 24 * 3600 * 1000);
  f.add('c', 'later'); // existing garbage collection retires the old queue rows
  assert.equal(f.queue.item(original.sendOperationKey), null);
  const blocked = f.queue.enqueue({ identity: f.identity(original), request: original });
  assert.equal(blocked.ok, false); assert.equal(blocked.code, 'send_queue_merged');
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.mergeGuard('history:T:b'), null);
  const saved = f.queue.readMerge(savedRequest.requestId, savedRequest.tabId);
  // The replacement remains pinned while waiting, so retire it explicitly
  // through its normal cancellation/dismissal owner before pruning.
  assert.equal(saved.operationKey, merged.operationKey);
  f.queue.cancelWaiting('T', 'c'); // follower no longer needs the predecessor proof
  f.queue.cancelWaiting('T', merged.handoffId, { dismiss: true });
  f.store.prune(Date.now() + 30 * 24 * 3600 * 1000);
  const retired = f.queue.readMerge(savedRequest.requestId, savedRequest.tabId);
  assert.equal(retired.operationKey, merged.operationKey);
  assert.equal(retired.record, null); assert.equal(retired.receiptRetired, true);
});
