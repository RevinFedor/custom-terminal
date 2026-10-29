'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { TabMessageService } = require('./tab-messages');
const { MessageLoopWaits, noticePrompt } = require('./message-loop-waits');
const { createHash } = require('node:crypto');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');

// Actual question/reply and wait journals. Physical input, runtime and native
// final observations are controlled leaves; no model or installed app is used.
async function fixture(t, options = {}) {
  const db = new Database(':memory:'), changes = [], notices = [], deliveries = new Map(), proofs = new Map();
  const tabs = new Map(['A', 'B', 'C'].map(tabId => [tabId, { known: true, tabId, projectId: 'P',
    provider: 'codex', sessionId: 'S-' + tabId, tabName: tabId, cwd: '/fixture',
    recoveryReady: true, readinessKey: 'ready-0' }]));
  let clock = 1000, owner;
  const messageCalls = [];
  const messages = new TabMessageService({ db, resolveTab: async id => tabs.get(id),
    requireLoopWait: true, loopWaitNow: () => clock, beforeDelivery: message => owner?.observe(message),
    send: async message => { messageCalls.push(message); return { state: options.questionState || 'confirmed' }; },
    cancelDelivery: () => ({ ok: true }), onChanged: message => owner?.observe(message) });
  await messages.initialize();
  let onSend = options.onSend, beforeCompletion = null;
  const timers = new Map(); let timerSeq = 0;
  const args = { db, messages, now: () => clock, waitMs: 500,
    readSource: async question => tabs.get(question.source.tabId) || { known: true },
    readDelivery: delivery => deliveries.get(delivery.operationKey) || { state: 'absent', provenNoInput: true },
    readCompletion: async (source, receipt) => { await beforeCompletion?.(); return proofs.get(receipt.operationKey) || { known: false }; },
    sendNotice: async (notice, source, ref) => {
      notices.push({ notice, source, ref });
      await onSend?.(notice);
      deliveries.set(notice.operationKey, { state: 'queued', operationKey: notice.operationKey });
    },
    cancelNotice: notice => { const current = deliveries.get(notice.operationKey); deliveries.set(notice.operationKey,
      { ...current, state: current?.state === 'confirmed' ? 'confirmed' : 'not-submitted', cancelled: true }); },
    changed: (entry, revision) => changes.push({ entry, revision }),
    setDeadline: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearDeadline: id => timers.delete(id) };
  owner = new MessageLoopWaits(args);
  t.after(() => { owner.dispose(); messages.dispose(); db.close(); });
  async function drain() { while (messages.lanes.size) await Promise.all([...messages.lanes.values()]); }
  const question = async (source = 'A', target = 'B', requestId = 'Q') => {
    const q = (await messages.sendMessage({ source, target, text: 'exact question', requestId })).message;
    await drain(); return q;
  };
  const reply = async q => {
    const r = (await messages.replyToMessage({ responder: q.targetTabId, messageId: q.messageId, text: 'exact reply', requestId: 'R-' + q.messageId })).message;
    await drain(); return r;
  };
  const canonical = delivery => {
    const receipt = { state: 'confirmed', operationKey: delivery.operationKey, handoffId: delivery.handoffId,
      attemptId: 'native-' + delivery.operationKey, sessionId: 'S-A', provider: 'codex',
      messageId: delivery.messageId, tabId: delivery.targetTabId || delivery.source?.tabId || 'A',
      promptHash: 'verified-prompt-' + delivery.operationKey, requestHash: 'verified-request-' + delivery.operationKey,
      auditTimestamp: new Date().toISOString(),
      userUuid: 'user-' + delivery.operationKey, sourceIdentity: 'source-' + delivery.operationKey };
    deliveries.set(delivery.operationKey, receipt); return receipt;
  };
  const finish = (delivery, turnId = 'return', outcomeTs = clock + 1) => {
    const receipt = canonical(delivery);
    const proof = { ...receipt, known: true, natural: true, outcomeTs,
      executionContext: { provider: 'codex', sessionId: receipt.sessionId, turnId } };
    proofs.set(delivery.operationKey, proof); return proof;
  };
  return { db, messages, changes, notices, messageCalls, deliveries, proofs, tabs, timers, question, reply, canonical, finish,
    get owner() { return owner; }, now: value => { clock = value; }, beforeCompletion: fn => { beforeCompletion = fn; },
    onSend: fn => { onSend = fn; },
    reopen: () => { owner.dispose(); owner = new MessageLoopWaits(args); return owner; } };
}

test('delivery-contract: exact native Reply completes the exchange while its source is still busy', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q);
  h.owner.readCompletion = () => { throw Error('No consuming-turn lookup is allowed'); };
  h.canonical(r);
  await h.owner.reconcile();
  const entry = h.owner.entrySnapshot(q.messageId);
  assert.equal(entry.state, 'settled'); assert.equal(h.owner.blocks('A'), false);
  assert.equal(entry.replyProcessed, undefined); assert.equal(entry.processed, undefined);
  assert.equal(entry.settlement.kind, 'reply-delivered');
  assert.equal(entry.settlement.receipt.attemptId, h.deliveries.get(r.operationKey).attemptId);
  h.now(100000); h.reopen(); await h.owner.restore();
  assert.equal(h.owner.blocks('A', { provider: 'codex', sessionId: 'S-A', turnId: 'parent', outcomeTs: 999 }), false);
  assert.equal(h.notices.length, 0); assert.equal(h.messageCalls.length, 2);
});
test('delivery-contract: four out-of-order Replies in one busy source turn settle only their exact questions', async t => {
  const h = await fixture(t), qs = [];
  for (let i = 0; i < 4; i++) qs.push(await h.question('A', 'B', 'Q' + i));
  const replies = [];
  for (const i of [2, 0, 3, 1]) replies.push(await h.reply(qs[i]));
  h.owner.readCompletion = () => { throw Error('No final'); };
  for (const r of replies) {
    h.canonical(r); await h.owner.reconcile();
    assert.equal(h.owner.entrySnapshot(r.replyTo).state, 'settled');
    for (const q of qs.filter(q => !h.deliveries.has('tab-message:' + h.messages.getMessage(q.messageId).reply.messageId))) {
      assert.notEqual(h.owner.entrySnapshot(q.messageId).state, 'settled');
    }
  }
  assert.equal(h.owner.blocks('A'), false); assert.equal(h.notices.length, 0); assert.equal(h.messageCalls.length, 8);
});
test('full-contract: outgoing X releases only its own wait; a late shared Reply delivers without resurrecting it', async t => {
  const h = await fixture(t), q1 = await h.question('A', 'B', 'Q1'), q2 = await h.question('A', 'B', 'Q2');
  h.messages.dismissMessage({ tabId: 'B', messageId: q1.messageId });
  assert.equal(h.owner.blocks('A'), true, 'incoming local X does not release the source');
  h.messages.dismissMessage({ tabId: 'A', messageId: q1.messageId });
  assert.equal(h.owner.entrySnapshot(q1.messageId).state, 'settled');
  assert.equal(h.owner.blocks('A'), true, 'Q2 remains independent');
  h.messages.dismissMessage({ tabId: 'A', messageId: q2.messageId });
  assert.equal(h.owner.blocks('A'), false); h.now(999999); await h.owner.reconcile();
  assert.equal(h.notices.length, 0);
  const batch = await h.messages.replyToMessage({ responder: 'B', messageIds: [q1.messageId, q2.messageId], text: 'shared late return', requestId: 'LATE' });
  while (h.messages.lanes.size) await Promise.all([...h.messages.lanes.values()]);
  assert.equal(batch.messages.length, 1); h.canonical(batch.messages[0]); await h.owner.reconcile();
  assert.equal(h.owner.blocks('A'), false); assert.equal(h.notices.length, 0);
  h.reopen(); await h.owner.restore(); assert.equal(h.owner.blocks('A'), false);
  for (const q of [q1, q2]) assert.equal(h.messages.getMessage(q.messageId).reply.messageId, batch.messages[0].messageId);
  assert.equal(h.messageCalls.length, 3, 'two questions and one answer, not two native answers');
});
test('full-contract: every included active question settles from one exact receipt, never source final', async t => {
  const h = await fixture(t), qs = [];
  for (let i = 0; i < 3; i++) qs.push(await h.question('A', 'B', 'B' + i));
  const batch = await h.messages.replyToMessage({ responder: 'B', messageIds: qs.map(q => q.messageId), text: 'one return', requestId: 'SHARED' });
  h.owner.readCompletion = () => { throw Error('No consuming final'); };
  await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), true);
  h.canonical(batch.messages[0]); await h.owner.reconcile();
  assert.equal(h.owner.blocks('A'), false);
  for (const q of qs) assert.equal(h.owner.entrySnapshot(q.messageId).settlement.receipt.operationKey, batch.messages[0].operationKey);
});
test('delivery-contract: unanswered timeout is finite without a mandatory status processing turn; late Reply remains exact', async t => {
  const h = await fixture(t), q = await h.question(); h.now(1501); await h.owner.reconcile();
  assert.equal(h.owner.entrySnapshot(q.messageId).state, 'settled');
  assert.equal(h.owner.entrySnapshot(q.messageId).disposition, 'reply_timeout');
  assert.equal(h.owner.blocks('A'), false); assert.equal(h.notices.length, 1);
  h.reopen(); await h.owner.restore(); assert.equal(h.notices.length, 1);
  const r = await h.reply(q); await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), true);
  h.canonical(r); await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), false);
  assert.equal(h.owner.entrySnapshot(q.messageId).settlement.kind, 'reply-delivered');
  assert.equal(h.notices.length, 1); assert.equal(h.messageCalls.length, 2);
});
test('delivery-contract: reopen migrates legacy delivered Reply without rewriting old proofs or frozen notice', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q); h.canonical(r);
  const old = h.owner.entries.get(q.messageId), proof = { known: true, natural: true, outcomeTs: 1001, legacy: 'kept' };
  const notice = h.owner.makeNotice(old, 'reply_processing_timeout');
  h.owner.save(old, { state: 'returning', disposition: 'reply_processing_timeout', notice, noticeProcessed: proof });
  h.owner.readCompletion = () => { throw Error('No historical proof'); };
  h.reopen(); await h.owner.restore();
  const after = h.owner.entrySnapshot(q.messageId);
  assert.equal(after.state, 'settled'); assert.equal(after.settlement.kind, 'reply-delivered');
  assert.deepEqual(after.noticeProcessed, proof); assert.equal(after.replyProcessed, undefined);
  assert.equal(h.owner.entries.get(q.messageId).notice.prompt, notice.prompt);
  assert.throws(() => h.owner.assertNotice({ questionId: q.messageId, noticeId: notice.id,
    operationKey: notice.operationKey, handoffId: notice.handoffId, logicalPrompt: notice.prompt }), /revoked/);
  assert.equal(h.notices.length, 0);
});

test('real confirmed receipt owner replays its existing attempt; port-swap controls do not establish a production replacement writer', async t => {
  const h = await fixture(t), store = createAgentSendReceiptStore(h.db), text = 'confirmed fixture';
  const identity = { operationKey: 'native-confirmed', surface: 'tab-message', tabId: 'A', handoffId: 'native-confirmed',
    provider: 'codex', sessionId: 'S-A', requestFingerprint: 'same-fixed-request', promptHash: promptAuditFingerprint(text), promptLength: text.length };
  const begun = store.beginAttempt(identity);
  store.settleAttempt(identity.operationKey, begun.attemptId, { status: 'audit-pending', submitted: true, auditPending: true });
  const promoted = store.promoteFromAudit({ success: true, operationKey: identity.operationKey, attemptId: begun.attemptId,
    provider: 'codex', sessionId: 'S-A', expectedHash: identity.promptHash, actualHash: identity.promptHash,
    entryUuid: 'native-confirmed-user', sourceIdentity: 'native-confirmed-source', auditTimestamp: new Date().toISOString() });
  assert.equal(promoted.promoted, true);
  const replay = store.beginAttempt(identity);
  assert.equal(replay.action, 'replay'); assert.equal(replay.record.attemptId, begun.attemptId);
  assert.equal(store.get(identity.operationKey).state, 'confirmed');
});
test('stale RAM snapshots cannot overwrite a newer durable cancel even through direct save', async t => {
  const h = await fixture(t), q = await h.question(), stale = h.owner.entries.get(q.messageId);
  h.messages.cancelMessage({ tabId: 'A', messageId: q.messageId });
  assert.equal(h.owner.save(stale, { state: 'returning' }), null);
  h.reopen(); await h.owner.restore(); assert.equal(h.owner.entrySnapshot(q.messageId).state, 'cancelled');
});
test('a conflicting SQLite revision poisons the old writer instead of publishing a release', async t => {
  const h = await fixture(t), q = await h.question(), entry = h.owner.entries.get(q.messageId);
  h.db.prepare('UPDATE tab_message_loop_waits SET revision=revision+100 WHERE questionId=?').run(q.messageId);
  assert.throws(() => h.owner.save(entry, { state: 'settled' }), /persistence_conflict/);
  assert.throws(() => h.owner.blocks('A'), /persistence_unknown/);
  h.reopen(); assert.equal(h.owner.blocks('A'), true);
});
test('delivery error returns a status without waiting for unanswered deadline', async t => {
  const h = await fixture(t, { questionState: 'not-submitted' }); const q = await h.question();
  await h.owner.reconcile(); assert.equal(h.notices.length, 1);
  assert.equal(h.owner.entrySnapshot(q.messageId).disposition, 'question_delivery_failed');
  assert.equal(h.messageCalls.length, 1);
});
test('acceptedResumeSourceSessionId alone cannot rebind the outgoing question; existing app-owned restart proof is required', async t => {
  const h = await fixture(t), q = await h.question(), reference = h.messages.questionWaitReference(q.messageId);
  h.tabs.set('A', { ...h.tabs.get('A'), sessionId: 'resume-child', acceptedResumeSourceSessionId: 'S-A' });
  await assert.rejects(h.messages.resolveWaitSource(reference), /changed/);
  let current = true;
  h.messages.readRestartBinding = async ({ phase, role, message, expected, live }) => {
    assert.equal(phase, 'delivery'); assert.equal(role, 'source'); assert.equal(message.messageId, q.messageId);
    assert.ok(message.requestFingerprint); assert.equal(expected.sessionId, 'S-A'); assert.equal(live.sessionId, 'resume-child');
    return { bindingId: 'exact-install-binding', fromSessionId: expected.sessionId,
      sessionId: live.sessionId, isCurrent: () => current };
  };
  const result = await h.messages.resolveWaitSource(reference);
  assert.equal(result.sessionId, 'resume-child'); assert.equal(result.restartBinding.isCurrent(), true);
  current = false; await assert.rejects(h.messages.resolveWaitSource(reference), /changed/);
  assert.equal(h.messages.getMessage(q.messageId).message.sourceSessionId, 'S-A', 'old address is immutable');
});
test('journal write failure cannot publish a release or acquire empty authority after reopen', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q); h.finish(r);
  h.db.exec(`CREATE TRIGGER refuse_wait_update BEFORE UPDATE ON tab_message_loop_waits BEGIN SELECT RAISE(ABORT,'EIO'); END`);
  await assert.rejects(h.owner.reconcile(), /EIO/);
  assert.throws(() => h.owner.blocks('A'), /persistence_unknown/);
  h.db.exec('DROP TRIGGER refuse_wait_update'); h.reopen();
  assert.equal(h.owner.blocks('A'), true); await h.owner.restore(); assert.equal(h.owner.blocks('A'), false);
});
test('a saved modern reply cannot become legacy-done after a failed wait checkpoint/restart; strict guard writes no reply input', async t => {
  const h = await fixture(t), q = await h.question();
  h.db.exec(`CREATE TRIGGER refuse_wait_update BEFORE UPDATE ON tab_message_loop_waits BEGIN SELECT RAISE(ABORT,'EIO'); END`);
  await assert.rejects(h.reply(q), /wait checkpoint/);
  assert.equal(h.messageCalls.length, 1, 'reply input waits for its durable source-wait checkpoint');
  const savedReply = h.messages.getMessage(q.messageId).reply; assert.ok(savedReply);
  assert.equal(savedReply.deliveryState, 'pending');
  h.db.exec('DROP TRIGGER refuse_wait_update'); h.reopen(); await h.owner.restore();
  assert.equal(h.owner.blocks('A'), true);
  await h.messages.wake('A'); assert.equal(h.messageCalls.length, 2);
  h.finish(savedReply); await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), false);
});
test('modern answered rows retain their required-wait marker even if the optional owner checkpoint was lost', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q);
  h.db.exec('DELETE FROM tab_message_loop_waits'); h.reopen(); await h.owner.restore();
  assert.equal(h.owner.blocks('A'), true, 'sent reply is not automatically classified as historical already-processed');
  assert.equal(h.owner.entrySnapshot(q.messageId).deadlineAt, 1500, 'restart cannot renew the absolute wait clock');
  h.finish(r); await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), false);
});
test('actual Web related-return cancellation shares the message transaction: EIO gives no cancel ACK, retry commits both exact owners', async t => {
  const h = await fixture(t), q = await h.question(); h.now(1600); await h.owner.reconcile();
  const notice = h.notices[0].notice, store = createAgentSendReceiptStore(h.db), effects = [];
  store.reserveOrGet({ operationKey: notice.operationKey, surface: 'tab-message', tabId: 'A', handoffId: notice.handoffId,
    provider: 'codex', sessionId: 'S-A', requestFingerprint: 'controlled-fingerprint',
    promptHash: promptAuditFingerprint(notice.prompt), promptLength: notice.prompt.length });
  const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const tree = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true); let callback;
  function visit(node) {
    if (ts.isNewExpression(node) && node.expression.getText(tree) === 'TabMessageService') {
      callback = node.arguments[0].properties.find(property => property.name.getText(tree) === 'cancelRelatedDeliveries').initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(callback);
  const context = vm.createContext({ require, path, srcMainDir: __dirname,
    getMessageLoopWaits: () => h.owner, tabMessageService: h.messages, agentSendReceiptStore: store,
    agentSendQueue: { store, cancelDelivery: (...args) => effects.push(args) } });
  h.messages.cancelRelatedDeliveries = vm.runInContext('(' + callback + ')', context);
  h.db.exec(`CREATE TRIGGER refuse_outcome_cancel BEFORE UPDATE OF delivery_control_json ON agent_send_receipts
    BEGIN SELECT RAISE(ABORT,'EIO'); END`);
  assert.throws(() => h.messages.cancelMessage({ tabId: 'A', messageId: q.messageId }), /EIO/);
  assert.equal(h.messages.getMessage(q.messageId).message.cancelledAt, null);
  assert.equal(store.isDeliveryCancelled(notice.operationKey), false); assert.equal(effects.length, 0);
  h.db.exec('DROP TRIGGER refuse_outcome_cancel');
  assert.equal(h.messages.cancelMessage({ tabId: 'A', messageId: q.messageId }).cancelled, true);
  assert.equal(store.isDeliveryCancelled(notice.operationKey), true); assert.equal(effects.length, 1);
  assert.equal(store.get(notice.operationKey).attemptId, null);
  assert.equal(h.owner.entrySnapshot(q.messageId).state, 'cancelled');
});
test('new independent questions have independent deadlines and one absolute timer, not a global MCP count', async t => {
  const h = await fixture(t); await h.question(); h.now(1100); await h.question('C', 'B', 'other');
  assert.equal(h.owner.blocks('A'), true); assert.equal(h.owner.blocks('C'), true); assert.equal(h.owner.blocks('B'), false);
  assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 400);
});
test('a transient FIFO reservation projection is not delivery failure and creates no operational source input', async t => {
  const h = await fixture(t, { questionState: 'not-submitted' }), q = await h.question();
  h.deliveries.set(q.operationKey, { state: 'preparing' }); await h.owner.reconcile();
  assert.equal(h.notices.length, 0); assert.equal(h.owner.blocks('A'), true);
});
test('proven no-input status resumes only after a fresh semantic readiness key, with the same frozen IDs and body', async t => {
  const h = await fixture(t), q = await h.question(); h.now(1600); await h.owner.reconcile();
  const first = h.notices[0].notice;
  h.deliveries.set(first.operationKey, { state: 'not-submitted', provenNoInput: true, attemptId: 'first-no-input', code: 'input_not_ready' });
  await h.owner.reconcile(); await h.owner.reconcile(); assert.equal(h.notices.length, 1);
  h.tabs.set('A', { ...h.tabs.get('A'), readinessKey: 'ready-1' }); await h.owner.reconcile();
  assert.equal(h.notices.length, 2); assert.equal(h.notices[1].notice.id, first.id);
  assert.equal(h.notices[1].notice.prompt, first.prompt); assert.equal(h.notices[1].notice.handoffId, first.handoffId);
  assert.equal(h.notices[1].notice.retryNoInputAttemptId, 'first-no-input');
  assert.equal(h.messageCalls.length, 1); assert.equal(h.messages.getMessage(q.messageId).reply, null);
});

test('unconfirmed/native-queued receipt never completes the exchange or creates a processing timeout', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q);
  for (const state of ['reserved', 'preparing', 'queued', 'audit-pending', 'enter-armed', 'delivery-unknown']) {
    h.deliveries.set(r.operationKey, { state, attemptId: 'same-uncertain-attempt' });
    await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), true);
    assert.equal(h.owner.entrySnapshot(q.messageId).settlement, null);
  }
  h.now(1600); await h.owner.reconcile();
  assert.equal(h.owner.blocks('A'), false);
  assert.equal(h.owner.entrySnapshot(q.messageId).disposition, 'reply_delivery_timeout');
  assert.doesNotMatch(h.notices[0].notice.prompt, /Outcome: reply_processing_timeout|finished processing/);
  assert.equal(h.deliveries.get(r.operationKey).state, 'delivery-unknown');
  assert.equal(h.messageCalls.length, 2);
});
for (const [field, value] of [
  ['operationKey', 'foreign'], ['handoffId', 'foreign'], ['attemptId', null],
  ['tabId', 'foreign'], ['messageId', 'other-reply'], ['provider', 'claude'],
  ['sessionId', 'other-SID'], ['promptHash', null], ['requestHash', null],
]) test('delivery identity: invalid ' + field + ' cannot complete a different question', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q), receipt = h.canonical(r);
  h.deliveries.set(r.operationKey, { ...receipt, [field]: value });
  await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), true); assert.equal(h.notices.length, 0);
});
for (const field of ['attemptId', 'userUuid', 'sourceIdentity', 'userUuidAliases', 'sourceIdentityAliases', 'promptHash', 'requestHash']) {
  test('receipt reread fences asynchronous ' + field + ' replacement before delivery commit', async t => {
    const h = await fixture(t), q = await h.question(), r = await h.reply(q); h.canonical(r);
    const read = h.owner.readDelivery; let reads = 0;
    h.owner.readDelivery = async delivery => {
      const value = read(delivery);
      if (delivery.operationKey === r.operationKey && ++reads === 1) {
        h.deliveries.set(r.operationKey, { ...value, [field]: field.endsWith('Aliases') ? ['changed'] : 'changed' });
      }
      return value;
    };
    await h.owner.reconcileEntry(q.messageId);
    assert.equal(h.owner.blocks('A'), true); assert.equal(h.owner.entrySnapshot(q.messageId).replyProcessed, undefined);
    assert.equal(h.owner.entrySnapshot(q.messageId).settlement, null);
  });
}
for (const phase of [1, 2]) test('cancel wins at delivery await ' + phase + ', including reopen', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q); h.canonical(r);
  const read = h.owner.readDelivery; let reads = 0;
  h.owner.readDelivery = async delivery => {
    const receipt = read(delivery);
    if (delivery.operationKey === r.operationKey && ++reads === phase) h.messages.cancelMessage({ tabId: 'A', messageId: q.messageId });
    return receipt;
  };
  await h.owner.reconcileEntry(q.messageId);
  assert.equal(h.owner.entrySnapshot(q.messageId).state, 'cancelled');
  h.reopen(); await h.owner.restore(); assert.equal(h.owner.entrySnapshot(q.messageId).state, 'cancelled');
  assert.equal(h.notices.length, 0);
});
test('Reply arriving during timeout lookup invalidates the entire old reason/cut', async t => {
  const h = await fixture(t), q = await h.question(); h.now(1501);
  const read = h.owner.readDelivery; let once = false, reply;
  h.owner.readDelivery = async delivery => {
    if (!once && delivery.messageId === q.messageId) { once = true; reply = await h.reply(q); h.canonical(reply); }
    return read(delivery);
  };
  await h.owner.reconcileEntry(q.messageId); assert.equal(h.notices.length, 0);
  await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), false);
});
test('unknown status input/lost ACK keeps its O/H/A across reopen without keeping an exchange-processing hold', async t => {
  const h = await fixture(t, { onSend: async () => { throw Object.assign(Error('lost ACK'), { code: 'transport_unknown' }); } });
  const q = await h.question(); h.now(1501); await h.owner.reconcile();
  const notice = h.notices[0].notice, unknown = { state: 'enter-armed', attemptId: 'uncertain' };
  h.deliveries.set(notice.operationKey, unknown); h.reopen(); await h.owner.restore(); await h.owner.reconcile();
  assert.equal(h.notices.length, 1); assert.equal(h.owner.blocks('A'), false);
  assert.deepEqual(h.deliveries.get(notice.operationKey), unknown);
  assert.equal(h.owner.entrySnapshot(q.messageId).replyProcessed, undefined);
});
test('unknown source has one durable finite outcome and no expired-deadline spin or unsafe Send', async t => {
  const h = await fixture(t), q = await h.question();
  h.tabs.set('A', { ...h.tabs.get('A'), known: false }); h.now(1600); await h.owner.reconcile();
  assert.equal(h.owner.entrySnapshot(q.messageId).disposition, 'reply_timeout');
  assert.equal(h.owner.blocks('A'), false); assert.equal(h.timers.size, 0); assert.equal(h.notices.length, 0);
  h.tabs.set('A', { ...h.tabs.get('A'), known: true }); await h.owner.reconcile(); assert.equal(h.notices.length, 1);
});
test('obsolete legacy notice is durably revoked even if FIFO cleanup fails; confirmed Reply is not sent again', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q); h.canonical(r);
  const before = h.owner.entries.get(q.messageId), notice = h.owner.makeNotice(before, 'reply_processing_timeout');
  h.owner.save(before, { state: 'returning', notice, contract: null });
  let cleans = 0;
  h.owner.cancelNotice = () => { cleans++; throw Error('cleanup-EIO'); };
  await assert.rejects(h.owner.reconcile(), /cleanup-EIO/);
  assert.equal(h.owner.blocks('A'), false);
  assert.ok(h.owner.entries.get(q.messageId).notice.retiredAt);
  h.reopen(); h.owner.cancelNotice = () => { cleans++; }; await h.owner.restore();
  assert.equal(h.owner.entrySnapshot(q.messageId).settlement.kind, 'reply-delivered');
  assert.equal(h.notices.length, 0); assert.equal(h.messageCalls.length, 2); assert.equal(cleans, 2);
});
test('answered transport stays complete after current SID replacement; native receipt must still match its original destination', async t => {
  const h = await fixture(t), q = await h.question(), r = await h.reply(q); h.canonical(r);
  h.tabs.set('A', { ...h.tabs.get('A'), sessionId: 'new-SID', known: false });
  h.owner.readSource = () => { throw Error('Do not look up a consuming turn for delivered input'); };
  await h.owner.reconcile(); assert.equal(h.owner.blocks('A'), false);
  assert.equal(h.owner.entrySnapshot(q.messageId).settlement.receipt.sessionId, 'S-A');
});
test('outcome copy names the application, distinguishes no reply from delivery timeout, and forbids replay', () => {
  const q = { messageId: 'Q', targetTabId: 'B', targetTabName: 'Target' };
  const prompt = noticePrompt(q, 'reply_timeout');
  assert.match(prompt, /Origin: Noted Terminal \(application, not another tab\)/);
  assert.match(prompt, /No reply was saved/); assert.match(prompt, /Do not resend it or change messageId\/requestId/);
  assert.match(noticePrompt({ ...q, reply: { deliveryState: 'unconfirmed' } }, 'reply_delivery_timeout'),
    /delivery back to your tab was not confirmed/);
});
