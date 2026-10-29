'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const { buildSync } = require('esbuild');
const { handleTabMessageApi, compactTabMessage } = require('./tab-message-api');
const { TabMessageService } = require('./tab-messages');
async function fixture(t, options = {}) {
  const root = options.disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'noted-message-batch-')) : null;
  const file = root ? path.join(root, 'private.sqlite') : ':memory:';
  let db = new Database(file);
  const calls = [];
  const tabs = new Map(['A', 'B', 'C'].map(tabId => [tabId, { tabId, tabName: tabId,
    projectId: 'P', projectName: 'P', provider: 'codex', sessionId: 'S-' + tabId, cwd: '/fixture' }]));
  const args = { db, resolveTab: async id => tabs.get(id), cancelDelivery: () => ({ ok: true }),
    send: async message => { calls.push(message); return { state: message.kind === 'reply' ? options.replyState || 'confirmed' : 'confirmed' }; } };
  let service = new TabMessageService(args); await service.initialize();
  const drain = async () => { while (service.lanes.size) await Promise.all([...service.lanes.values()]); };
  t.after(() => { service.dispose(); db.close(); if (root) fs.rmSync(root, { recursive: true }); });
  return { get db() { return db; }, calls, get service() { return service; }, drain, resolveTab: args.resolveTab,
    ask: async (key, source = 'A') => { const r = await service.sendMessage({ source, target: 'B', text: key, requestId: key });
      await drain(); return r.message.messageId; },
    reopen: async () => { service.dispose(); if (root) { db.close(); db = new Database(file); args.db = db; }
      service = new TabMessageService(args); await service.initialize(); } };
}
test('full-contract: mixed answered/waiting/hidden questions receive one common delivery and keep every explicit link', async t => {
  const h = await fixture(t), q1 = await h.ask('Q1'), q2 = await h.ask('Q2'), q3 = await h.ask('Q3');
  const first = await h.service.replyToMessage({ responder: 'B', messageId: q1, text: 'old answer', requestId: 'R1' }); await h.drain();
  h.service.dismissMessage({ tabId: 'A', messageId: q3 });
  const before = h.calls.length, request = { responder: 'B', messageIds: [q1, q2, q3], text: 'one shared answer', requestId: 'BATCH' };
  const result = await h.service.replyToMessage(request); await h.drain();
  assert.equal(h.calls.length, before + 1); assert.equal(result.results[0].status, 'already-answered');
  const r2 = h.service.getMessage(q2).reply, r3 = h.service.getMessage(q3).reply;
  assert.equal(r2.messageId, r3.messageId); assert.deepEqual(r2.replyToIds, [q2, q3]);
  assert.equal(h.service.getMessage(q1).reply.messageId, first.message.messageId);
  assert.equal(h.service.getMessage(q3).message.sourceDismissedAt != null, true);
  await h.reopen(); const again = await h.service.replyToMessage(request); await h.drain();
  assert.equal(again.deduplicated, true); assert.equal(h.calls.length, before + 1);
});
test('full-contract: three waiting questions and concurrent retries create one atomic shared Reply', async t => {
  const h = await fixture(t), ids = [await h.ask('Q1'), await h.ask('Q2'), await h.ask('Q3')];
  const request = { responder: 'B', messageIds: ids, text: 'same', requestId: 'SAME' };
  const results = await Promise.all([h.service.replyToMessage(request), h.service.replyToMessage(request)]); await h.drain();
  assert.equal(new Set(ids.map(id => h.service.getMessage(id).reply.messageId)).size, 1);
  assert.equal(h.calls.filter(m => m.kind === 'reply').length, 1);
  assert.equal(results.filter(r => r.deduplicated).length, 1);
});
test('full-contract: saved UNKNOWN, foreign and missing IDs are independent outcomes; no old answer is replaced', async t => {
  const h = await fixture(t, { replyState: 'audit-pending' }), pending = await h.ask('P'), waiting = await h.ask('W');
  const old = await h.service.replyToMessage({ responder: 'B', messageId: pending, text: 'old pending', requestId: 'OLD' }); await h.drain();
  const foreign = (await h.service.sendMessage({ source: 'A', target: 'C', text: 'foreign', requestId: 'F' })).message.messageId; await h.drain();
  const result = await h.service.replyToMessage({ responder: 'B', messageIds: [pending, foreign, 'absent', waiting], text: 'new shared', requestId: 'MIXED' }); await h.drain();
  assert.deepEqual(result.results.map(r => r.status), ['reply-pending', 'foreign', 'not-found', 'reply-created']);
  assert.equal(h.service.getMessage(pending).reply.messageId, old.message.messageId);
  assert.equal(h.calls.filter(m => m.kind === 'reply').length, 2);
  await h.reopen(); await h.service.replyToMessage({ responder: 'B', messageIds: [pending, foreign, 'absent', waiting], text: 'new shared', requestId: 'MIXED' }); await h.drain();
  assert.equal(h.calls.filter(m => m.kind === 'reply').length, 2, 'no UNKNOWN replay');
});
test('full-contract: all answered means zero new input, and changed text/list conflicts under the old request ID', async t => {
  const h = await fixture(t), ids = [await h.ask('A1'), await h.ask('A2')];
  await h.service.replyToMessage({ responder: 'B', messageIds: ids, text: 'old', requestId: 'FIRST' }); await h.drain();
  const before = h.calls.length, request = { responder: 'B', messageIds: ids, text: 'new', requestId: 'SECOND' };
  const result = await h.service.replyToMessage(request); await h.drain();
  assert.equal(result.messages.length, 0); assert.ok(result.results.every(r => r.status === 'already-answered'));
  assert.equal(h.calls.length, before);
  await assert.rejects(h.service.replyToMessage({ ...request, text: 'changed' }), /different reply list or text/);
  await assert.rejects(h.service.replyToMessage({ ...request, messageIds: ids.slice(0, 1) }), /different reply list or text/);
});
test('full-contract: competing overlapping answers keep exactly one answer per question', async t => {
  const h = await fixture(t), ids = [await h.ask('A1'), await h.ask('A2'), await h.ask('A3')];
  const results = await Promise.all([
    h.service.replyToMessage({ responder: 'B', messageIds: ids, text: 'winner', requestId: 'ONE' }),
    h.service.replyToMessage({ responder: 'B', messageIds: ids.slice(1), text: 'other', requestId: 'TWO' }),
  ]); await h.drain();
  const replies = ids.map(id => h.service.getMessage(id).reply);
  assert.equal(new Set(replies.slice(1).map(r => r.messageId)).size, 1, 'overlapping questions are never answered twice');
  assert.equal(h.calls.filter(m => m.kind === 'reply').length, new Set(replies.map(r => r.messageId)).size);
  assert.equal(h.db.prepare("SELECT count(*) n FROM tab_messages WHERE kind='reply'").get().n, results.reduce((n, r) => n + r.messages.length, 0));
});
test('full-contract: SQLite EIO rolls back all links and reply reservation, not a partial batch', async t => {
  const h = await fixture(t), ids = [await h.ask('A1'), await h.ask('A2')];
  h.db.exec(`CREATE TRIGGER refuse_link BEFORE UPDATE OF replyMessageId ON tab_messages
    WHEN NEW.messageId='${ids[1]}' BEGIN SELECT RAISE(ABORT,'EIO-link'); END`);
  const request = { responder: 'B', messageIds: ids, text: 'shared', requestId: 'FAIL' };
  await assert.rejects(h.service.replyToMessage(request), /EIO-link/);
  for (const id of ids) assert.equal(h.service.getMessage(id).reply, null);
  assert.equal(h.db.prepare("SELECT count(*) n FROM tab_messages WHERE kind='reply'").get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) n FROM tab_message_reply_requests').get().n, 0);
  h.db.exec('DROP TRIGGER refuse_link'); await h.service.replyToMessage(request); await h.drain();
  assert.equal(h.calls.filter(m => m.kind === 'reply').length, 1);
});
test('full-contract: ambiguous old cancellation stays explicit and never creates another input', async t => {
  const h = await fixture(t), id = await h.ask('legacy');
  h.db.prepare("UPDATE tab_messages SET cancelledAt='2026-01-01',cancelOrigin=NULL WHERE messageId=?").run(id);
  const result = await h.service.replyToMessage({ responder: 'B', messageIds: [id], text: 'late', requestId: 'LATE' });
  assert.equal(result.results[0].status, 'legacy-cancel-ambiguous'); assert.equal(result.messages.length, 0);
  assert.equal(h.service.getMessage(id).message.cancellationOrigin, 'legacy-unknown');
});
test('full-contract: explicit cancellation of one included Q cannot revoke the shared transport for its neighbour', async t => {
  const h = await fixture(t), ids = [await h.ask('A1'), await h.ask('A2')];
  const result = await h.service.replyToMessage({ responder: 'B', messageIds: ids, text: 'shared', requestId: 'COMMON' });
  h.service.cancelMessage({ tabId: 'A', messageId: ids[0] });
  assert.equal(h.service.assertDeliveryActive(result.message.messageId).messageId, result.message.messageId);
  await h.drain(); assert.equal(h.service.getMessage(ids[1]).reply.deliveryState, 'sent');
  assert.equal(h.calls.filter(m => m.kind === 'reply').length, 1);
});

for (const answered of [false, true]) test('audit: batch requestId with zero new replies rejects a changed single after physical SQLite reopen ' + answered, async t => {
  const h = await fixture(t, { disk: true });
  let ids = ['absent'];
  if (answered) {
    ids = [await h.ask('old-Q')];
    await h.service.replyToMessage({ responder: 'B', messageIds: ids, text: 'old R', requestId: 'old-R' }); await h.drain();
  }
  const batch = await h.service.replyToMessage({ responder: 'B', messageIds: ids, text: 'fixed text', requestId: 'same-request' });
  assert.equal(batch.messages.length, 0);
  const before = h.calls.length;
  await h.reopen(); await h.drain();
  let response;
  await handleTabMessageApi({ method: 'POST' }, null, { pathname: '/api/tab-messages', query: {} }, {
    service: h.service, resolveTab: h.resolveTab,
    readBody: async () => ({ sourceTabId: 'B', sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'B' },
      targetTabId: 'C', text: 'different single payload', requestId: 'same-request' }),
    sendJson: (_res, status, body) => { response = { status, body }; },
  });
  await h.drain();
  assert.equal(response.status, 409, JSON.stringify(response));
  assert.equal(response.body.code, 'tab_message_request_conflict');
  assert.equal(h.calls.length, before, 'a saved request key cannot admit another transport');
});

test('audit: desktop remount retains active questions and pending replies beyond the bounded History list', async t => {
  const h = await fixture(t), old = await h.ask('old unanswered');
  const web = fs.readFileSync(require.resolve('./web-server'), 'utf8'), tree = ts.createSourceFile('web.js', web, 99, true);
  let expression;
  function visit(node) { if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'listTabMessages') expression = node.initializer.getText(tree); ts.forEachChild(node, visit); }
  visit(tree); assert.ok(expression);
  const project = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'projectMessageWait').getText(tree);
  const list = vm.runInNewContext(project + '; (' + expression + ')', {
    getTabMessageService: () => h.service, compactTabMessage, messageLoopWaits: null,
  });
  const compiled = { exports: {} };
  const code = buildSync({ entryPoints: [path.join(__dirname, '../renderer/utils/tabMessageProjection.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  new Function('module', 'exports', code)(compiled, compiled.exports);
  const { mergeTabMessages, tabMessageThreads, tabMessageVisibleInTracker } = compiled.exports;
  const live = mergeTabMessages({}, await list('A'));
  for (let i = 0; i < 50; i++) {
    const id = await h.ask('Q' + i);
    await h.service.replyToMessage({ responder: 'B', messageId: id, text: 'R' + i, requestId: 'R' + i }); await h.drain();
  }
  assert.equal(h.service.listForTab('A').length, 100, 'generic bounded list remains compatible');
  const rows = await list('A');
  for (const index of [mergeTabMessages(live, rows), mergeTabMessages({}, rows)]) {
    const thread = tabMessageThreads(index, 'A').find(row => row.question.messageId === old);
    assert.ok(thread, 'active Q must survive empty-index remount');
    assert.equal(tabMessageVisibleInTracker(thread, 'A'), true);
  }
  const reply = await h.service.replyToMessage({ responder: 'B', messageId: old, text: 'late answer', requestId: 'late' }); await h.drain();
  // This list-only fixture models pending delivery; it is not native receipt proof.
  for (const id of [old, reply.message.messageId]) h.db.prepare("UPDATE tab_messages SET createdAt='2000-01-01' WHERE messageId=?").run(id);
  h.db.prepare("UPDATE tab_messages SET deliveryState='unconfirmed' WHERE messageId=?").run(reply.message.messageId);
  const pending = tabMessageThreads(mergeTabMessages({}, await list('A')), 'A').find(row => row.question.messageId === old);
  assert.equal(pending.reply.messageId, reply.message.messageId);
  assert.equal(pending.reply.deliveryState, 'unconfirmed');
  h.service.dismissMessage({ tabId: 'A', messageId: old });
  assert.equal((await list('A')).some(row => row.messageId === old), false);
  assert.equal((await list('B')).some(row => row.messageId === old), true, 'source hide cannot delete target inventory');
});
