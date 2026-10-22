'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { TabMessageService, formatTabMessagePrompt, TABLE_NAME } = require('./tab-messages');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const sha = (text) => createHash('sha256').update(text).digest('hex');
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function tab(id, extra = {}) {
  return { tabId: id, tabName: `Tab ${id}`, projectId: `project-${id}`,
    projectName: `Project ${id}`, cwd: `/tmp/${id}`, provider: 'codex', sessionId: `session-${id}`, ...extra };
}

async function fixture(t, options = {}) {
  const db = options.db || new Database(':memory:');
  const tabs = new Map(['A', 'B', 'C'].map((id) => [id, tab(id)]));
  const receipts = new Map();
  const calls = [];
  const changes = [];
  const logs = [];
  const service = new TabMessageService({
    db,
    resolveTab: options.resolveTab || (async (id) => tabs.get(id)),
    send: async (message) => {
      calls.push(message);
      assert.equal(db.prepare(`SELECT deliveryState FROM ${TABLE_NAME} WHERE messageId = ?`).get(message.messageId).deliveryState, 'sending');
      return options.send ? options.send(message) : { state: 'confirmed', operationKey: message.operationKey };
    },
    getReceipt: options.getReceipt || ((key) => receipts.get(key) || null),
    receiptRequiredBeforeSend: options.receiptRequiredBeforeSend === true,
    releaseReceipt: options.releaseReceipt,
    onChanged: (message, reason) => { changes.push({ message, reason }); options.onChanged?.(message, reason); },
    log: (event, metadata) => logs.push({ event, metadata }),
  });
  t.after(() => { service.dispose(); if (!options.db) db.close(); });
  await service.initialize();
  return { db, tabs, receipts, calls, changes, logs, service,
    question: (source = 'A', text = 'Same visible text', requestId = 'q-1', target = 'B') => service.sendMessage({ source, target, text, requestId }),
    message: (id) => service.getMessage(id)?.message,
  };
}

// Wait for service work, not arbitrary delays or live app lifecycle.
async function drained(service) {
  while (service.lanes.size) await Promise.all([...service.lanes.values()]);
}

test('cancelled application FIFO message is terminal across wakes, retry and reopen', async t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let cancelled;
  const h = await fixture(t, { db, send: async message => {
    cancelled = { state: 'not-submitted', operationKey: message.operationKey,
      receipt: { submitted: false, code: 'agent_send_queue_cancelled' } };
    return cancelled;
  }, getReceipt: () => cancelled });
  const q = (await h.question()).message; await drained(h.service);
  assert.equal(h.message(q.messageId).deliveryState, 'failed');
  const frozen = h.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId);
  for (let i = 0; i < 3; i++) await h.service.wake('B');
  await h.service.reconcile();
  assert.equal(h.calls.length, 1);
  assert.equal(h.db.prepare(`SELECT retryAllowed FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId).retryAllowed, 0);
  assert.equal(h.db.prepare(`SELECT frozenPrompt FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId).frozenPrompt, frozen.frozenPrompt);
  h.service.dispose();
  const reopened = await fixture(t, { db, getReceipt: () => cancelled });
  await reopened.service.wake('B'); await drained(reopened.service);
  assert.equal(reopened.calls.length, 0);
});

test('a provisional target is durably addressed by exact launch without inventing a SID, then one canonical receipt materializes it', async t => {
  const pin = { toolType: 'codex', terminalInstanceId: 'I', launchId: 'L' };
  const h = await fixture(t, { send: async message => ({ state: 'audit-pending', operationKey: message.operationKey,
    receipt: { submitted: true, status: 'queued' } }) });
  h.tabs.set('B', tab('B', { sessionId: null, sendTarget: pin, runtimeTarget: pin }));
  const question = await h.question(); await drained(h.service);
  assert.equal(question.message.targetSessionId, null);
  assert.deepEqual(h.calls[0].targetSendTarget, pin);
  const message = h.message(question.message.messageId);
  const receipt = { state: 'confirmed', operationKey: message.operationKey, tabId: 'B', provider: 'codex',
    handoffId: message.handoffId, attemptId: 'exact-attempt', sessionId: 'born-session',
    promptHash: promptAuditFingerprint(h.calls[0].prompt),
    receipt: { expectedTarget: pin }, auditIdentity: { provider: 'codex', sessionId: 'born-session',
      attemptId: 'exact-attempt', entryUuid: 'canonical-user' } };
  h.service.observeReceipt(message.operationKey, receipt);
  assert.equal(h.message(message.messageId).targetSessionId, 'born-session');
  assert.equal(h.message(message.messageId).deliveryState, 'sent');
  assert.equal(h.message(message.messageId).targetSendTarget, undefined);
  assert.equal(h.calls.length, 1);
});

test('same launch can adopt its first writer, but replacement/foreign receipts cannot retarget a provisional message', async t => {
  const pin = { toolType: 'codex', terminalInstanceId: 'I', launchId: 'L' };
  let entered;
  const gate = deferred();
  const h = await fixture(t, { send: async message => { entered = message; await gate.promise; return { state: 'audit-pending' }; } });
  h.tabs.set('B', tab('B', { sessionId: null, sendTarget: pin, runtimeTarget: pin }));
  const result = await h.question();
  await Promise.resolve();
  const id = result.message.messageId;
  gate.resolve(); await drained(h.service);
  h.service.observeReceipt(entered.operationKey, { state: 'confirmed', operationKey: entered.operationKey,
    tabId: 'B', provider: 'codex', handoffId: entered.handoffId, sessionId: 'foreign', promptHash: 'wrong',
    attemptId: 'A', auditIdentity: { provider: 'codex', sessionId: 'foreign', attemptId: 'A' },
    receipt: { expectedTarget: { ...pin, launchId: 'foreign-launch' } } });
  assert.equal(h.message(id).targetSessionId, null);
  assert.equal(h.message(id).deliveryState, 'unconfirmed');
  h.tabs.set('B', tab('B', { sessionId: 'born-session', runtimeTarget: { ...pin, sessionId: 'born-session' } }));
  const reply = await h.service.replyToMessage({ responder: 'B', messageId: id, text: 'reply', requestId: 'R' });
  assert.equal(reply.message.sourceSessionId, 'born-session');
});

test('a first writer needs the exact frozen hash and canonical address, not generic confirmed', async t => {
  const pin = { toolType: 'codex', terminalInstanceId: 'I', launchId: 'L' };
  const h = await fixture(t, { send: async () => ({ state: 'audit-pending', receipt: { submitted: true } }) });
  h.tabs.set('B', tab('B', { sessionId: null, sendTarget: pin, runtimeTarget: pin }));
  const q = (await h.question()).message; await drained(h.service);
  const receipt = { state: 'confirmed', operationKey: q.operationKey, tabId: 'B', provider: 'codex',
    handoffId: q.handoffId, attemptId: 'attempt', sessionId: 'born-session',
    promptHash: promptAuditFingerprint(h.calls[0].prompt), receipt: { expectedTarget: pin },
    auditIdentity: { provider: 'codex', attemptId: 'attempt', sessionId: 'born-session', entryUuid: 'canonical' } };
  for (const invalid of [{ ...receipt, promptHash: 'wrong-hash' },
    { ...receipt, auditIdentity: { ...receipt.auditIdentity, entryUuid: null } },
    { state: 'confirmed', operationKey: q.operationKey }]) {
    h.service.observeReceipt(q.operationKey, invalid);
    assert.equal(h.message(q.messageId).targetSessionId, null);
    assert.equal(h.message(q.messageId).deliveryState, 'unconfirmed');
  }
  h.service.observeReceipt(q.operationKey, receipt);
  assert.equal(h.message(q.messageId).targetSessionId, 'born-session');
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
  assert.equal(h.calls.length, 1);
});

test('a known conversation waits through a null writer snapshot and wakes once with the same frozen message', async t => {
  const pin = { toolType: 'codex', terminalInstanceId: 'I', launchId: 'L' };
  const h = await fixture(t);
  const original = h.tabs.get('B');
  const q = (await h.question()).message; await drained(h.service);
  // Reuse a durable pre-input row to model preparation blocked by identity proof.
  const pending = (await h.question('A', 'second exact body', 'q-2')).message;
  h.tabs.set('B', { ...original, sessionId: null, sendTarget: pin, runtimeTarget: pin });
  await drained(h.service);
  assert.equal(h.message(pending.messageId).deliveryState, 'pending');
  assert.equal(h.message(pending.messageId).code, 'tab_message_identity_pending');
  assert.equal(h.calls.length, 1);
  const before = h.db.prepare(`SELECT frozenPrompt FROM ${TABLE_NAME} WHERE messageId = ?`).get(pending.messageId);
  h.tabs.set('B', { ...original, runtimeTarget: { ...pin, sessionId: original.sessionId } });
  await h.service.wake('B'); await drained(h.service);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].messageId, pending.messageId);
  assert.equal(h.calls[1].prompt, before.frozenPrompt);
  assert.equal(h.message(pending.messageId).deliveryState, 'sent');
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
});

test('replacement of a pinned provisional launch during draft wait never gets the old message', async t => {
  const pin = { toolType: 'codex', terminalInstanceId: 'I', launchId: 'L' };
  const h = await fixture(t, { send: async () => ({ state: 'not-submitted', receipt: {
    submitted: false, code: 'input_draft_conflict', status: 'waiting-for-input' } }) });
  h.tabs.set('B', tab('B', { sessionId: null, sendTarget: pin, runtimeTarget: pin }));
  const q = (await h.question()).message; await drained(h.service);
  const before = h.db.prepare(`SELECT frozenPrompt, targetAddressJson FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId);
  h.tabs.set('B', tab('B', { sessionId: null, sendTarget: { ...pin, launchId: 'replacement' },
    runtimeTarget: { ...pin, launchId: 'replacement' } }));
  await h.service.wake('B'); await drained(h.service);
  assert.equal(h.calls.length, 1);
  assert.equal(h.message(q.messageId).deliveryState, 'failed');
  assert.equal(h.message(q.messageId).code, 'tab_message_address_changed');
  assert.deepEqual(h.db.prepare(`SELECT frozenPrompt, targetAddressJson FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId), before);
});

test('provisional return address survives SQLite reopen and binds only the same source launch for the reply', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provisional-message-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'messages.sqlite');
  const db = new Database(file);
  const pin = { toolType: 'codex', terminalInstanceId: 'source-instance', launchId: 'source-launch' };
  const h = await fixture(t, { db });
  h.tabs.set('A', tab('A', { sessionId: null, sendTarget: pin, runtimeTarget: pin }));
  const q = (await h.question()).message; await drained(h.service);
  h.service.dispose(); db.close();
  const reopenedDb = new Database(file);
  t.after(() => reopenedDb.close());
  const r = await fixture(t, { db: reopenedDb });
  assert.deepEqual(r.message(q.messageId).sourceSendTarget, pin);
  assert.equal(r.calls.length, 0, 'reopen must not replay the question');
  r.tabs.set('A', tab('A', { sessionId: 'born-source', runtimeTarget: { ...pin, sessionId: 'born-source' } }));
  const answer = (await r.service.replyToMessage({ responder: 'B', messageId: q.messageId, text: 'one final answer', requestId: 'reply-exact' })).message;
  await drained(r.service);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].messageId, answer.messageId);
  assert.equal(r.message(answer.messageId).targetSessionId, 'born-source');
  assert.equal(r.message(answer.messageId).deliveryState, 'sent');
  assert.equal(r.message(q.messageId).sourceSessionId, null, 'the original captured address is preserved');
});

test('two callers reserve before a busy target finishes accepting, reply out of order, and never create task dependencies', async (t) => {
  const gate = deferred();
  const entered = deferred();
  let attempts = 0;
  const h = await fixture(t, { send: async (message) => {
    if (message.kind === 'question' && ++attempts === 1) { entered.resolve(); await gate.promise; }
    return { operationKey: message.operationKey, state: 'audit-pending', receipt: {
      submitted: true, status: 'queued', providerQueueAccepted: true,
    } };
  } });
  const first = await h.question('A');
  await entered.promise;
  const second = await h.question('C');
  assert.equal(h.db.prepare(`SELECT count(*) n FROM ${TABLE_NAME}`).get().n, 2);
  assert.equal(h.calls.length, 1);
  assert.equal(second.message.deliveryState, 'pending');
  gate.resolve();
  await drained(h.service);
  assert.equal(h.calls.length, 2);
  const replyC = await h.service.replyToMessage({ responder: 'B', messageId: second.message.messageId, text: 'Same visible text', requestId: 'r-C' });
  const replyA = await h.service.replyToMessage({ responder: 'B', messageId: first.message.messageId, text: 'Same visible text', requestId: 'r-A' });
  await drained(h.service);
  assert.equal(replyC.message.targetTabId, 'C');
  assert.equal(replyA.message.targetTabId, 'A');
  assert.equal(replyC.message.replyTo, second.message.messageId);
  assert.equal(replyA.message.replyTo, first.message.messageId);
  assert.equal(new Set(h.calls.map((m) => m.messageId)).size, 4);
  for (const m of h.calls) {
    assert.equal(m.operationKey, `tab-message:${m.messageId}`);
    assert.equal(m.handoffId, m.operationKey);
    assert.equal(h.message(m.messageId).deliveryState, 'queued');
    assert.equal(Object.hasOwn(m, 'parentRunId'), false);
    assert.equal(Object.hasOwn(m, 'waitForDescendants'), false);
  }
  assert.equal(h.service.getMessage(first.message.messageId).reply.messageId, replyA.message.messageId);
  assert.ok(h.message(first.message.messageId).answeredAt);
});

test('a reverse question can be accepted while the first target transport is still busy', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const h = await fixture(t, { send: async (message) => {
    if (message.targetTabId === 'B') { entered.resolve(); await gate.promise; }
    return { state: 'confirmed' };
  } });
  await h.question();
  await entered.promise;
  const reverse = await h.question('B', 'clarify', 'reverse', 'A');
  await h.service.lanes.get('A');
  assert.equal(h.message(reverse.message.messageId).deliveryState, 'sent');
  gate.resolve();
  await drained(h.service);
});

test('concurrent exact request retries reserve only once; changed text or target conflicts', async (t) => {
  const h = await fixture(t);
  const results = await Promise.all([h.question(), h.question(), h.question()]);
  await drained(h.service);
  assert.equal(new Set(results.map((r) => r.message.messageId)).size, 1);
  assert.equal(results.filter((r) => !r.deduplicated).length, 1);
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.question('A', 'changed'), (error) => {
    assert.equal(error.code, 'tab_message_request_conflict');
    assert.equal(error.messageId, results[0].message.messageId);
    assert.equal(Object.hasOwn(error, 'text'), false);
    assert.equal(Object.hasOwn(error, 'body'), false);
    return true;
  });
  await assert.rejects(h.question('A', 'Same visible text', 'q-1', 'C'), { code: 'tab_message_request_conflict' });
  assert.equal(h.db.prepare(`SELECT count(*) n FROM ${TABLE_NAME}`).get().n, 1);
});

test('caller identity is pinned on acceptance but exact retries keep the old reservation across drift', async (t) => {
  const h = await fixture(t);
  const source = { ...h.tabs.get('A') };
  const target = { ...h.tabs.get('B') };
  await h.service.sendMessage({ source, target, text: 'payload', requestId: 'identity' });
  await drained(h.service);
  h.tabs.set('B', { ...target, tabName: 'Renamed' });
  const retried = await h.service.sendMessage({ source, target: h.tabs.get('B'), text: 'payload', requestId: 'identity' });
  assert.equal(retried.deduplicated, true);
  const repeated = await h.service.sendMessage({ source: { ...source, sessionId: 'foreign' }, target, text: 'payload', requestId: 'identity' });
  assert.equal(repeated.deduplicated, true);
  assert.equal(repeated.message.sourceSessionId, source.sessionId);
  await assert.rejects(h.service.sendMessage({ source: { ...source, sessionId: 'foreign' }, target, text: 'payload', requestId: 'new' }), { code: 'tab_message_address_changed' });
});

test('self questions and missing request IDs are rejected before persistence', async (t) => {
  const h = await fixture(t);
  await assert.rejects(h.question('A', 'hello', 'self', 'A'), { code: 'tab_message_self_question' });
  await assert.rejects(h.service.sendMessage({ source: 'A', target: 'B', text: 'hello' }), { code: 'tab_message_invalid_input' });
  assert.equal(h.db.prepare(`SELECT count(*) n FROM ${TABLE_NAME}`).get().n, 0);
});

test('foreign tab, changed responder session and provider cannot answer; final answer has exact retry semantics', async (t) => {
  const h = await fixture(t);
  const q = (await h.question()).message;
  await drained(h.service);
  await assert.rejects(h.service.replyToMessage({ responder: 'C', messageId: q.messageId, text: 'fake', requestId: 'r' }), { code: 'tab_message_foreign_responder' });
  const original = h.tabs.get('B');
  for (const change of [{ sessionId: 'replacement', acceptedResumeSourceSessionId: original.sessionId }, { provider: 'claude' }]) {
    h.tabs.set('B', { ...original, ...change });
    await assert.rejects(h.service.replyToMessage({ responder: 'B', messageId: q.messageId, text: 'fake', requestId: 'r' }), { code: 'tab_message_foreign_responder' });
  }
  h.tabs.set('B', original);
  const request = { responder: 'B', messageId: q.messageId, text: 'answer', requestId: 'r' };
  const replies = await Promise.all([h.service.replyToMessage(request), h.service.replyToMessage(request)]);
  await drained(h.service);
  assert.equal(replies[0].message.messageId, replies[1].message.messageId);
  assert.equal(replies[1].deduplicated, true);
  await assert.rejects(h.service.replyToMessage({ ...request, text: 'changed' }), { code: 'tab_message_request_conflict' });
  await assert.rejects(h.service.replyToMessage({ ...request, requestId: 'second-answer' }), { code: 'tab_message_already_answered' });
  await assert.rejects(h.service.replyToMessage({ ...request, messageId: replies[0].message.messageId, requestId: 'reply-to-reply' }), { code: 'tab_message_not_question' });
});

test('failed reverse delivery preserves full response and immutable original return address', async (t) => {
  const h = await fixture(t);
  const q = (await h.question()).message;
  await drained(h.service);
  h.tabs.set('A', tab('A', { sessionId: 'new-source-session' }));
  const answer = 'full answer\n'.repeat(5000);
  const reply = await h.service.replyToMessage({ responder: 'B', messageId: q.messageId, text: answer, requestId: 'r' });
  await drained(h.service);
  const result = h.service.getMessage(q.messageId);
  assert.equal(result.message.replyMessageId, reply.message.messageId);
  assert.equal(result.reply.text, answer);
  assert.equal(result.reply.targetSessionId, 'session-A');
  assert.equal(result.reply.deliveryState, 'failed');
  assert.equal(result.reply.code, 'tab_message_address_changed');
  assert.equal(h.calls.length, 1);
});

test('reply reservation and answered marker roll back together on SQLite failure', async (t) => {
  const h = await fixture(t);
  const q = (await h.question()).message;
  await drained(h.service);
  h.db.exec(`CREATE TRIGGER reject_answer BEFORE UPDATE OF replyMessageId ON ${TABLE_NAME}
    BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END;`);
  await assert.rejects(h.service.replyToMessage({ responder: 'B', messageId: q.messageId, text: 'answer', requestId: 'r' }), /controlled write failure/);
  assert.equal(h.db.prepare(`SELECT count(*) n FROM ${TABLE_NAME}`).get().n, 1);
  assert.equal(h.message(q.messageId).replyMessageId, null);
  assert.equal(h.calls.length, 1);
});

test('draft block is durable and retries only on wake, with the same prepared prompt and IDs', async (t) => {
  let service;
  let attempt = 0;
  const h = await fixture(t, { send: async (message) => {
    attempt += 1;
    if (attempt === 1) {
      const prepared = `${message.prompt}\nPrepared attached context`;
      service.updateFrozenPrompt(message.messageId, prepared);
      assert.equal(h.db.prepare(`SELECT frozenPrompt FROM ${TABLE_NAME} WHERE messageId = ?`).get(message.messageId).frozenPrompt, prepared);
      return { submitted: false, code: 'agent_send_draft_conflict' };
    }
    assert.match(message.preparedPrompt, /Prepared attached context$/);
    return { state: 'confirmed' };
  } });
  service = h.service;
  const q = (await h.question()).message;
  await drained(service);
  assert.equal(h.message(q.messageId).deliveryState, 'waiting-for-input');
  await service.reconcileReceipts('B');
  assert.equal(attempt, 1);
  assert.equal((await h.question()).deduplicated, true);
  assert.equal(attempt, 1);
  await service.wake('B', 'input-cleared');
  assert.equal(attempt, 2);
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
  assert.equal(h.calls[0].operationKey, h.calls[1].operationKey);
  assert.throws(() => service.updateFrozenPrompt(q.messageId, 'changed'), { code: 'tab_message_prompt_frozen' });
});

test('target drift on draft wake never sends to a replacement session or provider', async (t) => {
  const h = await fixture(t, { send: async () => ({ submitted: false, code: 'draft_conflict' }) });
  const q = (await h.question()).message;
  await drained(h.service);
  h.tabs.set('B', tab('B', { sessionId: 'new-B' }));
  await h.service.wake('B');
  assert.equal(h.message(q.messageId).deliveryState, 'failed');
  assert.equal(h.message(q.messageId).code, 'tab_message_address_changed');
  assert.equal(h.calls.length, 1);
});

test('only an authoritative exact target Resume alias permits delivery and receipt reconciliation', async (t) => {
  let service;
  let attempts = 0;
  const h = await fixture(t, { send: async (message) => {
    if (++attempts === 1) return { submitted: false, code: 'draft_conflict' };
    assert.equal(message.targetSessionId, 'session-B');
    return { operationKey: message.operationKey, provider: 'codex', sessionId: 'resumed-B', state: 'confirmed' };
  } });
  service = h.service;
  const q = (await h.question()).message;
  await drained(service);
  h.tabs.set('B', tab('B', { sessionId: 'resumed-B', acceptedResumeSourceSessionId: 'session-B' }));
  await service.wake('B');
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
  assert.equal(attempts, 2);
});

test('responder must match the proven delivery session after exact target Resume', async (t) => {
  let attempts = 0;
  const h = await fixture(t, { send: async (message) => {
    if (++attempts === 1) return { submitted: false, code: 'draft_conflict' };
    return { state: 'confirmed', sessionId: message.kind === 'question' ? 'resumed-B' : 'session-A' };
  } });
  const q = (await h.question()).message;
  await drained(h.service);
  h.tabs.set('B', tab('B', { sessionId: 'resumed-B', acceptedResumeSourceSessionId: 'session-B' }));
  await h.service.wake('B');
  await assert.rejects(h.service.replyToMessage({ responder: tab('B'), messageId: q.messageId, text: 'stale caller', requestId: 'stale' }), { code: 'tab_message_address_changed' });
  const reply = await h.service.replyToMessage({ responder: h.tabs.get('B'), messageId: q.messageId, text: 'answer', requestId: 'r' });
  await drained(h.service);
  assert.equal(reply.message.sourceSessionId, 'resumed-B');
  assert.equal(reply.message.targetSessionId, 'session-A');
  assert.equal(h.message(reply.message.messageId).deliveryState, 'sent');
});

test('generic lineage is not a Resume alias, and source identity never uses a Resume alias', async (t) => {
  for (const [id, extra] of [['B', { sessionHistory: ['session-B'], acceptedResumeSourceSessionId: 'unrelated' }],
    ['A', { acceptedResumeSourceSessionId: 'session-A' }]]) {
    const h = await fixture(t, { send: async () => ({ submitted: false, code: 'draft_conflict' }) });
    const q = (await h.question()).message;
    await drained(h.service);
    h.tabs.set(id, tab(id, { sessionId: 'new-session', ...extra }));
    await h.service.wake('B');
    assert.equal(h.calls.length, 1);
    assert.equal(h.message(q.messageId).deliveryState, 'failed');
  }
});

test('unknown ACK and transport rejection never trigger a blind retry, even on wake', async (t) => {
  for (const send of [async () => null, async () => { throw new Error('private prompt must not enter logs'); }]) {
    const h = await fixture(t, { send });
    const q = (await h.question()).message;
    await drained(h.service);
    assert.equal(h.message(q.messageId).deliveryState, 'unconfirmed');
    await h.service.wake('B');
    await h.service.reconcileReceipts('B');
    assert.equal(h.calls.length, 1);
    h.receipts.set(q.operationKey, { operationKey: q.operationKey, state: 'confirmed' });
    await h.service.reconcileReceipts('B', 'canonical-audit');
    assert.equal(h.message(q.messageId).deliveryState, 'sent');
    assert.equal(h.calls.length, 1);
  }
});

test('durable not-submitted permits retry only after an explicit wake', async (t) => {
  let attempts = 0;
  const h = await fixture(t, { send: async () => ++attempts === 1 ? null : { state: 'confirmed' } });
  const q = (await h.question()).message;
  await drained(h.service);
  h.receipts.set(q.operationKey, { operationKey: q.operationKey, state: 'not-submitted', receipt: { submitted: false } });
  await h.service.reconcileReceipts('B');
  assert.equal(h.calls.length, 1);
  assert.equal(h.message(q.messageId).deliveryState, 'failed');
  await h.service.wake('B');
  assert.equal(h.calls.length, 2);
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
});

test('explicit pre-transport failure is retryable, but a contradictory deliveryUnknown flag is not', async (t) => {
  for (const unknown of [false, true]) {
    let attempt = 0;
    const h = await fixture(t, { send: async (message) => {
      if (++attempt === 1) throw Object.assign(new Error('private failure body'), {
        submitted: false, deliveryUnknown: unknown, code: 'message_receipt_store_unavailable',
      });
      h.service.updateFrozenPrompt(message.messageId, `${message.prompt}\nPrepared after availability restored`);
      return { state: 'confirmed' };
    } });
    const q = (await h.question()).message;
    await drained(h.service);
    assert.equal(h.message(q.messageId).deliveryState, unknown ? 'unconfirmed' : 'failed');
    await h.service.reconcileReceipts('B');
    assert.equal(h.calls.length, 1);
    await h.service.wake('B', 'available');
    assert.equal(h.calls.length, unknown ? 1 : 2);
    assert.equal(h.message(q.messageId).deliveryState, unknown ? 'unconfirmed' : 'sent');
    assert.equal(JSON.stringify(h.logs).includes('private failure body'), false);
  }
});

test('late negative receipts and old send callbacks cannot regress sent', async (t) => {
  const entered = deferred();
  const gate = deferred();
  const h = await fixture(t, { send: async () => { entered.resolve(); return gate.promise; } });
  const q = (await h.question()).message;
  await entered.promise;
  h.service.observeReceipt(q.operationKey, { operationKey: q.operationKey, state: 'confirmed' });
  gate.resolve({ submitted: false, code: 'draft_conflict' });
  await drained(h.service);
  const settledAt = h.message(q.messageId).updatedAt;
  h.service.observeReceipt(q.operationKey, { state: 'audit-pending' });
  h.service.observeReceipt(q.operationKey, null);
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
  assert.equal(h.message(q.messageId).updatedAt, settledAt);
  await h.service.wake('B');
  assert.equal(h.calls.length, 1);
});

test('a mismatched receipt never confirms an operation; stale attempts are ignored', async (t) => {
  const h = await fixture(t, { send: async () => null });
  const q = (await h.question()).message;
  await drained(h.service);
  for (const extra of [{ operationKey: 'other' }, { sessionId: 'foreign' }, { provider: 'claude' }, { tabId: 'C' },
    { promptHash: 'foreign' }, { promptLength: 99999 }]) {
    h.service.observeReceipt(q.operationKey, { state: 'confirmed', ...extra });
    assert.equal(h.message(q.messageId).deliveryState, 'unconfirmed');
  }
  h.service.observeReceipt(q.operationKey, { state: 'queued', attempt: 2, updatedAt: '2026-10-03T10:00:00.000Z' });
  h.service.observeReceipt(q.operationKey, { state: 'not-submitted', attempt: 1, updatedAt: '2026-10-03T09:00:00.000Z' });
  assert.equal(h.message(q.messageId).deliveryState, 'queued');
  h.service.observeReceipt(q.operationKey, { state: 'confirmed', attempt: 2 });
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
});

test('UI events and lists are compact; full text and response are available only by ID; diagnostics never include text', async (t) => {
  const h = await fixture(t);
  const text = 'private-answer-body-'.repeat(1000);
  const q = (await h.question('A', text)).message;
  await drained(h.service);
  await h.service.replyToMessage({ responder: 'B', messageId: q.messageId, text, requestId: 'r' });
  await drained(h.service);
  for (const message of [...h.service.listForTab('A'), ...h.changes.map((event) => event.message)]) {
    assert.equal(Object.hasOwn(message, 'text'), false);
    assert.equal(Object.hasOwn(message, 'frozenPrompt'), false);
    assert.equal(message.textChars, text.length);
    assert.equal(message.textPreview.length, 200);
  }
  assert.equal(h.service.getMessage(q.messageId).message.text, text);
  assert.equal(h.service.getMessage(q.messageId).reply.text, text);
  assert.equal(h.service.listForTab('A', { limit: 1 }).length, 1);
  assert.equal(h.service.getMessage('missing'), null);
  assert.equal(JSON.stringify(h.logs).includes('private-answer-body'), false);
  assert.ok(h.logs.some(({ metadata }) => metadata.textHash === sha(text)));
});

test('dismissal is independent per question participant, accepts a reply ID, and changes only presentation metadata', async (t) => {
  const h = await fixture(t);
  const q = (await h.question('A', 'private-dismiss-question')).message;
  await drained(h.service);
  const reply = (await h.service.replyToMessage({ responder: 'B', messageId: q.messageId,
    text: 'private-dismiss-answer', requestId: 'r' })).message;
  await drained(h.service);
  const readRows = () => h.db.prepare(`SELECT * FROM ${TABLE_NAME} ORDER BY rowid`).all();
  const [beforeQuestion, beforeReply] = readRows();
  const eventStart = h.changes.length;
  h.tabs.clear();
  for (const method of ['resolveTab', 'send', 'getReceipt', 'releaseReceipt', '_enqueue']) {
    h.service[method] = () => assert.fail(`dismissal must not call ${method}`);
  }

  const source = h.service.dismissMessage({ tabId: 'A', messageId: reply.messageId });
  assert.equal(source.deduplicated, false);
  assert.equal(source.message.messageId, q.messageId);
  assert.equal(source.message.kind, 'question');
  assert.ok(source.message.sourceDismissedAt > beforeQuestion.updatedAt);
  assert.equal(source.message.updatedAt, source.message.sourceDismissedAt);
  assert.equal(source.message.targetDismissedAt, null);
  assert.deepEqual(readRows(), [{ ...beforeQuestion,
    sourceDismissedAt: source.message.sourceDismissedAt, updatedAt: source.message.updatedAt }, beforeReply]);
  assert.equal(h.changes.length, eventStart + 1);
  assert.equal(h.changes.at(-1).reason, 'dismissed');
  assert.equal(h.changes.at(-1).message.sourceDismissedAt, source.message.sourceDismissedAt);

  const logCount = h.logs.length;
  for (const messageId of [reply.messageId, q.messageId]) {
    assert.deepEqual(h.service.dismissMessage({ tabId: 'A', messageId }), { ...source, deduplicated: true });
  }
  assert.equal(h.changes.length, eventStart + 1, 'exact repeats do not publish another event');
  assert.equal(h.logs.length, logCount, 'exact repeats do not log another transition');

  const target = h.service.dismissMessage({ tabId: 'B', messageId: q.messageId });
  assert.equal(target.deduplicated, false);
  assert.equal(target.message.sourceDismissedAt, source.message.sourceDismissedAt);
  assert.ok(target.message.targetDismissedAt > source.message.updatedAt);
  assert.equal(target.message.updatedAt, target.message.targetDismissedAt);
  assert.deepEqual(readRows(), [{ ...beforeQuestion, sourceDismissedAt: source.message.sourceDismissedAt,
    targetDismissedAt: target.message.targetDismissedAt, updatedAt: target.message.updatedAt }, beforeReply]);
  assert.equal(h.calls.length, 2);
  assert.equal(h.changes.length, eventStart + 2);
  for (const tabId of ['A', 'B']) {
    const list = h.service.listForTab(tabId);
    assert.equal(list.length, 2, 'dismissed questions and replies remain in history');
    const listed = list.find((message) => message.messageId === q.messageId);
    assert.equal(listed.sourceDismissedAt, source.message.sourceDismissedAt);
    assert.equal(listed.targetDismissedAt, target.message.targetDismissedAt);
    assert.equal(listed.updatedAt, target.message.updatedAt);
    assert.equal(Object.hasOwn(listed, 'text'), false);
  }
  assert.deepEqual(h.service.getMessage(q.messageId).message, target.message);
  assert.equal(h.service.getMessage(q.messageId).reply.text, reply.text);
  const diagnostic = h.logs.at(-1).metadata;
  assert.equal(diagnostic.sourceDismissedAt, source.message.sourceDismissedAt);
  assert.equal(diagnostic.targetDismissedAt, target.message.targetDismissedAt);
  assert.equal(diagnostic.updatedAt, target.message.updatedAt);
  assert.equal(JSON.stringify(h.logs).includes('private-dismiss-'), false);
});

test('dismissal rejects missing and foreign participants without changing a question or its reply', async (t) => {
  const h = await fixture(t);
  const q = (await h.question()).message;
  await drained(h.service);
  const reply = (await h.service.replyToMessage({ responder: 'B', messageId: q.messageId,
    text: 'answer', requestId: 'r' })).message;
  await drained(h.service);
  const before = h.service.getMessage(q.messageId);
  const events = h.changes.length;
  for (const messageId of [q.messageId, reply.messageId]) {
    assert.throws(() => h.service.dismissMessage({ tabId: 'C', messageId }),
      { code: 'tab_message_foreign_participant', statusCode: 403 });
  }
  for (const payload of [{ tabId: '', messageId: q.messageId }, { tabId: 'A', messageId: '' },
    { messageId: q.messageId }, { tabId: 'A' }]) {
    assert.throws(() => h.service.dismissMessage(payload), { code: 'tab_message_invalid_input', statusCode: 400 });
  }
  assert.throws(() => h.service.dismissMessage({ tabId: 'A', messageId: 'missing' }),
    { code: 'tab_message_not_found', statusCode: 404 });
  assert.deepEqual(h.service.getMessage(q.messageId), before);
  assert.equal(h.changes.length, events);
  assert.equal(h.calls.length, 2);
});

test('dismissal survives preparation, late transport callbacks and a live reply with monotonic question events', async (t) => {
  const entered = deferred();
  const gate = deferred();
  const h = await fixture(t, { send: async (message) => {
    if (message.kind === 'question') { entered.resolve(); return gate.promise; }
    return { state: 'confirmed' };
  } });
  t.after(() => gate.resolve(null));
  const q = (await h.question()).message;
  await entered.promise;
  const future = '2100-01-01T00:00:00.000Z';
  h.db.prepare(`UPDATE ${TABLE_NAME} SET updatedAt = ? WHERE messageId = ?`).run(future, q.messageId);
  const eventStart = h.changes.length;
  const dismissed = h.service.dismissMessage({ tabId: 'A', messageId: q.messageId }).message;
  assert.ok(dismissed.updatedAt > future);
  assert.equal(dismissed.deliveryState, 'sending');
  assert.equal(dismissed.replyMessageId, null);
  const prepared = h.service.updateFrozenPrompt(q.messageId, h.calls[0].prompt + '\nAttached context');
  assert.equal(prepared.sourceDismissedAt, dismissed.sourceDismissedAt);
  assert.ok(prepared.updatedAt > dismissed.updatedAt);
  h.service.observeReceipt(q.operationKey, { state: 'queued' });
  gate.resolve({ state: 'audit-pending' });
  await drained(h.service);
  assert.equal(h.message(q.messageId).deliveryState, 'queued');
  assert.equal(h.calls.length, 1, 'dismissal never adds a send');

  const reply = (await h.service.replyToMessage({ responder: 'B', messageId: q.messageId,
    text: 'Answer arriving after dismissal', requestId: 'late-reply' })).message;
  await drained(h.service);
  h.service.observeReceipt(q.operationKey, { state: 'confirmed' });
  const answered = h.service.getMessage(q.messageId);
  assert.equal(answered.message.sourceDismissedAt, dismissed.sourceDismissedAt);
  assert.equal(answered.message.targetDismissedAt, null);
  assert.equal(answered.message.replyMessageId, reply.messageId);
  assert.equal(answered.message.deliveryState, 'sent');
  assert.equal(answered.reply.text, reply.text);
  assert.equal(answered.reply.deliveryState, 'sent');
  assert.equal(h.calls.length, 2);
  let previous = future;
  for (const { message } of h.changes.slice(eventStart).filter(({ message }) => message.messageId === q.messageId)) {
    assert.equal(message.sourceDismissedAt, dismissed.sourceDismissedAt);
    assert.equal(message.targetDismissedAt, null);
    assert.ok(message.updatedAt > previous);
    previous = message.updatedAt;
  }
  h.service.observeReceipt(q.operationKey, { state: 'not-submitted' });
  assert.deepEqual(h.service.getMessage(q.messageId), answered, 'late negative delivery cannot undo dismissal');
});

test('dismissing a waiting question neither retries nor cancels the existing delivery', async (t) => {
  let attempts = 0;
  const h = await fixture(t, { send: async () => ++attempts === 1
    ? { submitted: false, code: 'draft_conflict' } : { state: 'confirmed' } });
  const q = (await h.question()).message;
  await drained(h.service);
  const before = h.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId);
  assert.equal(before.deliveryState, 'waiting-for-input');
  assert.equal(before.retryAllowed, 1);
  h.service.dismissMessage({ tabId: 'A', messageId: q.messageId });
  const dismissed = h.service.dismissMessage({ tabId: 'B', messageId: q.messageId }).message;
  await drained(h.service);
  assert.equal(attempts, 1);
  assert.deepEqual(h.db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId),
    { ...before, sourceDismissedAt: dismissed.sourceDismissedAt,
      targetDismissedAt: dismissed.targetDismissedAt, updatedAt: dismissed.updatedAt });
  await h.service.wake('B', 'input-cleared');
  assert.equal(attempts, 2, 'the ordinary wake still delivers a dismissed question');
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
  assert.equal(h.message(q.messageId).sourceDismissedAt, dismissed.sourceDismissedAt);
  assert.equal(h.message(q.messageId).targetDismissedAt, dismissed.targetDismissedAt);
  assert.equal(h.calls[1].operationKey, h.calls[0].operationKey);
  assert.equal(h.calls[1].prompt, h.calls[0].prompt);
});

test('prompt includes full answer, bounded original label, explicit question identity and no auto reply', () => {
  const base = { messageId: 'm-1', sourceTabName: 'Owner', sourceTabId: 'B', text: 'full response\n'.repeat(10000) };
  const question = formatTabMessagePrompt({ ...base, kind: 'question' });
  assert.match(question, /reply_to_message\(\{messageId:"m-1"/);
  assert.match(question, /not task delegation/);
  const reply = formatTabMessagePrompt({ ...base, kind: 'reply', replyTo: 'q-1' }, { text: 'long question '.repeat(10000) });
  assert.ok(reply.endsWith(base.text));
  assert.match(reply, /Reply to: q-1/);
  assert.match(reply, /No automatic reply is requested/);
  assert.ok(reply.length - base.text.length < 500);
});

test('legacy table migration is additive and per-side dismissal survives SQLite reopen with history intact', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-message-dismiss-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new Database(file);
  const databases = [db];
  t.after(() => {
    for (const database of databases) if (database.open) database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE tab_messages (
    messageId TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('question', 'reply')),
    replyTo TEXT UNIQUE REFERENCES tab_messages(messageId),
    sourceTabId TEXT NOT NULL, sourceTabName TEXT NOT NULL,
    sourceProjectId TEXT NOT NULL, sourceProjectName TEXT NOT NULL, sourceCwd TEXT,
    sourceProvider TEXT NOT NULL, sourceSessionId TEXT NOT NULL,
    targetTabId TEXT NOT NULL, targetTabName TEXT NOT NULL,
    targetProjectId TEXT NOT NULL, targetProjectName TEXT NOT NULL, targetCwd TEXT,
    targetProvider TEXT NOT NULL, targetSessionId TEXT NOT NULL,
    text TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
    deliveryState TEXT NOT NULL CHECK(deliveryState IN
      ('pending','sending','queued','sent','waiting-for-input','unconfirmed','failed')),
    error TEXT, code TEXT, replyMessageId TEXT, answeredAt TEXT,
    operationKey TEXT NOT NULL UNIQUE, handoffId TEXT NOT NULL UNIQUE,
    requestId TEXT NOT NULL, requestFingerprint TEXT NOT NULL,
    frozenPrompt TEXT NOT NULL, promptPrepared INTEGER NOT NULL DEFAULT 0,
    attemptCount INTEGER NOT NULL DEFAULT 0, retryAllowed INTEGER NOT NULL DEFAULT 0,
    receiptAttempt INTEGER NOT NULL DEFAULT 0, receiptUpdatedAt TEXT, deliverySessionId TEXT,
    UNIQUE(sourceTabId, requestId)
  );`);
  const timestamp = '2026-01-01T00:00:00.000Z';
  const insert = db.prepare(`INSERT INTO tab_messages (
    messageId, kind, replyTo, sourceTabId, sourceTabName, sourceProjectId, sourceProjectName,
    sourceProvider, sourceSessionId, targetTabId, targetTabName, targetProjectId, targetProjectName,
    targetProvider, targetSessionId, text, createdAt, updatedAt, deliveryState,
    operationKey, handoffId, requestId, requestFingerprint, frozenPrompt, attemptCount
  ) VALUES (@messageId, @kind, @replyTo, @source, @source, 'project', 'Project', 'codex', @source,
    @target, @target, 'project', 'Project', 'codex', @target, @text, @timestamp, @timestamp, 'sent',
    @operationKey, @operationKey, @messageId, @fingerprint, @prompt, 1)`);
  for (const row of [
    { messageId: 'legacy-question', kind: 'question', replyTo: null, source: 'A', target: 'B', text: 'Original question' },
    { messageId: 'legacy-reply', kind: 'reply', replyTo: 'legacy-question', source: 'B', target: 'A', text: 'Original answer' },
  ]) {
    insert.run({ ...row, timestamp, operationKey: `tab-message:${row.messageId}`,
      fingerprint: sha(row.text), prompt: `Frozen legacy envelope\n${row.text}` });
  }
  db.prepare(`UPDATE tab_messages SET replyMessageId = 'legacy-reply', answeredAt = ? WHERE messageId = 'legacy-question'`)
    .run(timestamp);
  const legacyRows = db.prepare('SELECT * FROM tab_messages ORDER BY rowid').all();
  const oldColumns = db.prepare('PRAGMA table_info(tab_messages)').all().map(({ name }) => name);
  assert.equal(oldColumns.includes('sourceDismissedAt'), false);
  assert.equal(oldColumns.includes('targetDismissedAt'), false);
  const first = await fixture(t, { db });
  assert.deepEqual(db.prepare('SELECT * FROM tab_messages ORDER BY rowid').all(),
    legacyRows.map((row) => ({ ...row, sourceDismissedAt: null, targetDismissedAt: null,
      sourceAddressJson: null, targetAddressJson: null, cancelledAt: null, cancelledByTabId: null, sourceRestartBindingId: null })));
  assert.equal(db.prepare('PRAGMA table_info(tab_messages)').all().length, oldColumns.length + 7);
  assert.equal(first.calls.length, 0);
  assert.equal(first.changes.length, 0);
  const source = first.service.dismissMessage({ tabId: 'A', messageId: 'legacy-reply' }).message;
  await first.service.initialize();
  assert.equal(first.message('legacy-question').sourceDismissedAt, source.sourceDismissedAt);
  first.service.dispose();
  db.close();

  const reopenedDb = new Database(file);
  databases.push(reopenedDb);
  const reopened = await fixture(t, { db: reopenedDb,
    send: () => assert.fail('reopen must not resend'), resolveTab: () => assert.fail('reopen must not resolve tabs') });
  assert.deepEqual(reopened.service.getMessage('legacy-question').message, source);
  assert.equal(reopened.service.listForTab('B').find((m) => m.messageId === 'legacy-question').targetDismissedAt, null);
  assert.deepEqual(reopened.service.dismissMessage({ tabId: 'A', messageId: 'legacy-question' }),
    { message: source, deduplicated: true });
  assert.equal(reopened.changes.length, 0);
  const target = reopened.service.dismissMessage({ tabId: 'B', messageId: 'legacy-reply' }).message;
  assert.equal(target.sourceDismissedAt, source.sourceDismissedAt);
  assert.ok(target.targetDismissedAt > source.updatedAt);
  reopened.service.dispose();
  reopenedDb.close();

  const finalDb = new Database(file);
  databases.push(finalDb);
  const final = await fixture(t, { db: finalDb,
    send: () => assert.fail('reopen must not resend'), resolveTab: () => assert.fail('reopen must not resolve tabs') });
  const pair = final.service.getMessage('legacy-question');
  assert.deepEqual(pair.message, target);
  assert.equal(pair.message.text, 'Original question');
  assert.equal(pair.reply.text, 'Original answer');
  assert.equal(pair.reply.messageId, 'legacy-reply');
  assert.equal(pair.reply.sourceDismissedAt, null, 'presentation metadata belongs to the question');
  assert.equal(pair.reply.targetDismissedAt, null);
  for (const tabId of ['A', 'B']) {
    const list = final.service.listForTab(tabId);
    assert.equal(list.length, 2);
    const listed = list.find((m) => m.messageId === 'legacy-question');
    assert.equal(listed.sourceDismissedAt, target.sourceDismissedAt);
    assert.equal(listed.targetDismissedAt, target.targetDismissedAt);
    assert.equal(listed.updatedAt, target.updatedAt);
    assert.equal(final.service.dismissMessage({ tabId, messageId: 'legacy-reply' }).deduplicated, true);
  }
  assert.deepEqual(finalDb.prepare('SELECT * FROM tab_messages ORDER BY rowid').all(), [
    { ...legacyRows[0], sourceDismissedAt: target.sourceDismissedAt,
      targetDismissedAt: target.targetDismissedAt, updatedAt: target.updatedAt, sourceAddressJson: null, targetAddressJson: null,
      cancelledAt: null, cancelledByTabId: null, sourceRestartBindingId: null },
    { ...legacyRows[1], sourceDismissedAt: null, targetDismissedAt: null, sourceAddressJson: null, targetAddressJson: null,
      cancelledAt: null, cancelledByTabId: null, sourceRestartBindingId: null },
  ]);
  assert.equal(final.calls.length, 0);
  assert.equal(final.changes.length, 0);
});

test('SQLite restart recovers an in-flight message from the exact durable receipt without send', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-message-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.sqlite');
  const db = new Database(file);
  const store = createAgentSendReceiptStore(db);
  const entered = deferred();
  const gate = deferred();
  let started;
  let sent;
  const first = new TabMessageService({ db, resolveTab: async (id) => tab(id), getReceipt: (key) => store.get(key),
    send: async (message) => {
      sent = message;
      started = store.beginAttempt({ operationKey: message.operationKey, surface: 'tab-message',
        tabId: message.targetTabId, handoffId: message.handoffId, provider: message.targetProvider,
        sessionId: message.targetSessionId, requestFingerprint: sha(message.prompt),
        promptHash: promptAuditFingerprint(message.prompt), promptLength: message.prompt.length });
      entered.resolve();
      return gate.promise;
    },
  });
  await first.initialize();
  const q = (await first.sendMessage({ source: 'A', target: 'B', text: 'persist me', requestId: 'persisted' })).message;
  await entered.promise;
  store.settleAttempt(q.operationKey, started.attemptId, { submitted: true, success: true, status: 'sent' });
  assert.equal(store.get(q.operationKey).state, 'confirmed');
  first.dispose();
  db.close();
  const reopened = new Database(file);
  const recoveredStore = createAgentSendReceiptStore(reopened);
  let sends = 0;
  const second = new TabMessageService({ db: reopened, resolveTab: async (id) => tab(id),
    getReceipt: (key) => recoveredStore.get(key), send: async () => { sends += 1; },
  });
  t.after(() => { second.dispose(); reopened.close(); });
  await second.initialize();
  assert.equal(second.getMessage(q.messageId).message.deliveryState, 'sent');
  assert.equal(sends, 0);
  assert.equal(reopened.prepare(`SELECT frozenPrompt FROM ${TABLE_NAME} WHERE messageId = ?`).get(q.messageId).frozenPrompt, sent.prompt);
  assert.equal((await second.sendMessage({ source: 'A', target: 'B', text: 'persist me', requestId: 'persisted' })).deduplicated, true);
  gate.resolve({ submitted: false });
  await drained(first);
  assert.equal(second.getMessage(q.messageId).message.deliveryState, 'sent');
});

test('restart with missing/audit/queued/not-submitted receipt never blindly replays a sending row', async (t) => {
  for (const record of [null, { state: 'audit-pending' }, { state: 'queued' }, { state: 'not-submitted' }]) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const gate = deferred();
    const entered = deferred();
    const first = await fixture(t, { db, send: async () => { entered.resolve(); return gate.promise; } });
    const q = (await first.question()).message;
    await entered.promise;
    first.service.dispose();
    let sends = 0;
    const second = new TabMessageService({ db, resolveTab: async (id) => tab(id), getReceipt: () => record,
      send: async () => { sends += 1; return { state: 'confirmed' }; } });
    t.after(() => second.dispose());
    await second.initialize();
    assert.equal(sends, 0);
    const expected = record?.state === 'queued' ? 'queued' : record?.state === 'not-submitted' ? 'failed' : 'unconfirmed';
    assert.equal(second.getMessage(q.messageId).message.deliveryState, expected);
    await second.wake('B');
    assert.equal(sends, record?.state === 'not-submitted' ? 1 : 0);
    gate.resolve(null);
    await drained(first.service);
  }
});

test('strict receipt-before-input invariant recovers crash before reservation but never crash after Enter', async (t) => {
  for (const afterEnter of [false, true]) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const receiptStore = createAgentSendReceiptStore(db);
    const entered = deferred();
    const gate = deferred();
    const first = await fixture(t, { db, receiptRequiredBeforeSend: true,
      getReceipt: (key) => receiptStore.get(key), send: async (message) => {
        if (afterEnter) {
          const started = receiptStore.beginAttempt({ operationKey: message.operationKey, surface: 'tab-message',
            tabId: message.targetTabId, handoffId: message.handoffId,
            provider: message.targetProvider, sessionId: message.targetSessionId,
            requestFingerprint: sha(message.prompt), promptHash: promptAuditFingerprint(message.prompt), promptLength: message.prompt.length });
          receiptStore.settleAttempt(message.operationKey, started.attemptId, {
            submitted: true, deliveryUnknown: true, enterWritten: true, status: 'delivery-unknown',
          });
        }
        entered.resolve();
        return gate.promise;
      },
    });
    const q = (await first.question()).message;
    await entered.promise;
    first.service.dispose();
    let sends = 0;
    const second = new TabMessageService({ db, receiptRequiredBeforeSend: true,
      resolveTab: async (id) => tab(id), getReceipt: (key) => receiptStore.get(key),
      send: async (message) => {
        sends += 1;
        assert.equal(message.messageId, q.messageId);
        assert.equal(message.operationKey, q.operationKey);
        return { state: 'confirmed' };
      },
    });
    t.after(() => second.dispose());
    await second.initialize();
    await drained(second);
    assert.equal(sends, afterEnter ? 0 : 1);
    assert.equal(second.getMessage(q.messageId).message.deliveryState, afterEnter ? 'unconfirmed' : 'sent');
    await second.wake('B');
    assert.equal(sends, afterEnter ? 0 : 1);
    gate.resolve(null);
    await drained(first.service);
  }
});

test('strict receipt absence never replays queued proof and receipt lookup failure is not absence', async (t) => {
  const h = await fixture(t, { receiptRequiredBeforeSend: true, send: async () => ({ state: 'queued' }) });
  const q = (await h.question()).message;
  await drained(h.service);
  await h.service.reconcileReceipts('B');
  await h.service.wake('B');
  assert.equal(h.message(q.messageId).deliveryState, 'queued');
  assert.equal(h.calls.length, 1);

  const missing = await fixture(t, { receiptRequiredBeforeSend: true,
    send: async () => null, getReceipt: () => { throw new Error('database unavailable'); } });
  const other = (await missing.question()).message;
  await drained(missing.service);
  await missing.service.wake('B');
  assert.equal(missing.message(other.messageId).deliveryState, 'unconfirmed');
  assert.equal(missing.calls.length, 1);
});

test('late pre-submit failures cannot turn native queue acceptance into a retry', async (t) => {
  const gate = deferred();
  const entered = deferred();
  const h = await fixture(t, { send: async () => { entered.resolve(); return gate.promise; } });
  const q = (await h.question()).message;
  await entered.promise;
  h.service.observeReceipt(q.operationKey, { state: 'queued' });
  gate.resolve({ submitted: false, code: 'draft_conflict' });
  await drained(h.service);
  h.receipts.set(q.operationKey, { state: 'not-submitted' });
  await h.service.wake('B');
  assert.equal(h.message(q.messageId).deliveryState, 'queued');
  assert.equal(h.calls.length, 1);
  h.service.observeReceipt(q.operationKey, { state: 'provider-not-accepted' });
  assert.equal(h.message(q.messageId).deliveryState, 'failed');
  h.receipts.clear();
  await h.service.wake('B');
  assert.equal(h.calls.length, 1);
});

test('a reserved or preparing receipt proves no Enter and can resume only on explicit wake', async (t) => {
  for (const state of ['reserved', 'preparing']) {
    let attempts = 0;
    const h = await fixture(t, { send: async () => ++attempts === 1 ? null : { state: 'confirmed' } });
    const q = (await h.question()).message;
    await drained(h.service);
    h.receipts.set(q.operationKey, { state });
    await h.service.reconcileReceipts('B');
    assert.equal(h.calls.length, 1);
    assert.equal(h.message(q.messageId).deliveryState, 'failed');
    await h.service.wake('B');
    assert.equal(h.calls.length, 2);
    assert.equal(h.message(q.messageId).deliveryState, 'sent');
  }
});

test('observer exceptions cannot roll back accepted messages or prevent delivery', async (t) => {
  const h = await fixture(t, { onChanged: () => { throw new Error('observer failed'); } });
  const q = (await h.question()).message;
  await drained(h.service);
  assert.equal(h.message(q.messageId).deliveryState, 'sent');
  assert.ok(h.logs.some(({ event }) => event === 'tab-message-observer-error'));
});

test('receipt pins are released only after sent is committed, once per transition', async (t) => {
  const pins = new Set();
  const releases = [];
  const h = await fixture(t, {
    send: async (message) => {
      pins.add(message.operationKey);
      return { state: message.requestId === 'sent' ? 'confirmed' : 'queued' };
    },
    releaseReceipt: (operationKey) => {
      assert.equal(h.db.prepare(`SELECT deliveryState FROM ${TABLE_NAME} WHERE operationKey = ?`).get(operationKey).deliveryState, 'sent');
      releases.push(operationKey);
      pins.delete(operationKey);
    },
    onChanged: (message) => {
      if (message.deliveryState === 'sent') assert.equal(pins.has(message.operationKey), false);
    },
  });
  const sent = (await h.question('A', 'delivered', 'sent')).message;
  const queued = (await h.question('A', 'still queued', 'queued')).message;
  await drained(h.service);
  assert.deepEqual(releases, [sent.operationKey]);
  assert.deepEqual([...pins], [queued.operationKey]);
  h.service.observeReceipt(sent.operationKey, { state: 'confirmed' });
  h.service.observeReceipt(sent.operationKey, { state: 'not-submitted' });
  assert.deepEqual(releases, [sent.operationKey]);
  h.service.observeReceipt(queued.operationKey, { state: 'confirmed' });
  assert.deepEqual(releases, [sent.operationKey, queued.operationKey]);
  assert.equal(pins.size, 0);
});

test('startup releases stale sent pins using keys only, with no sent body reads or events', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const pins = new Set();
  const h = await fixture(t, { db, send: async (message) => {
    pins.add(message.operationKey);
    return { state: message.requestId === 'sent' ? 'confirmed' : 'queued' };
  } });
  const sent = (await h.question('A', 'already delivered body', 'sent')).message;
  const queued = (await h.question('A', 'queued body', 'queued')).message;
  await drained(h.service);
  h.service.dispose();
  const changes = [];
  const releases = [];
  const second = new TabMessageService({ db,
    resolveTab: async (id) => tab(id),
    send: async () => { assert.fail('restart must not resend'); },
    onChanged: (message) => changes.push(message),
    releaseReceipt: async (operationKey) => { releases.push(operationKey); pins.delete(operationKey); },
  });
  t.after(() => second.dispose());
  const readRow = second._row.bind(second);
  second._row = (id) => {
    assert.notEqual(id, sent.messageId, 'startup must not materialize the sent message body');
    return readRow(id);
  };
  await second.initialize();
  assert.deepEqual(releases, [sent.operationKey]);
  assert.deepEqual([...pins], [queued.operationKey]);
  assert.deepEqual(changes, []);
  assert.equal(readRow(sent.messageId).deliveryState, 'sent');
  await second.initialize();
  assert.deepEqual(releases, [sent.operationKey], 'initialize is idempotent within one service');
});

test('sync and async receipt release failures preserve sent and retry cleanup on restart', async (t) => {
  for (const asyncFailure of [false, true]) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const releases = [];
    const releaseReceipt = (operationKey) => {
      releases.push(operationKey);
      const error = Object.assign(new Error('private release failure body'), { code: 'pin_store_unavailable' });
      if (asyncFailure) return Promise.reject(error);
      throw error;
    };
    const h = await fixture(t, { db, releaseReceipt });
    const first = (await h.question('A', 'first delivered body', 'first')).message;
    const second = (await h.question('A', 'second delivered body', 'second')).message;
    await drained(h.service);
    assert.equal(h.message(first.messageId).deliveryState, 'sent');
    assert.equal(h.message(second.messageId).deliveryState, 'sent');
    assert.deepEqual(releases, [first.operationKey, second.operationKey]);
    assert.equal(h.logs.filter(({ event }) => event === 'tab-message-receipt-release-error').length, 2);
    assert.equal(JSON.stringify(h.logs).includes('private release failure body'), false);
    h.service.dispose();

    const recovered = new TabMessageService({ db, releaseReceipt,
      resolveTab: async (id) => tab(id), send: async () => { assert.fail('sent must never retry'); },
    });
    t.after(() => recovered.dispose());
    await recovered.initialize();
    assert.equal(releases.length, 4, 'one failing release does not stop the sent-key sweep');
    assert.equal(recovered.getMessage(first.messageId).message.deliveryState, 'sent');
    assert.equal(recovered.getMessage(second.messageId).message.deliveryState, 'sent');
  }
});

test('startup automatically resumes exact reserved/preparing operations before Enter', async (t) => {
  for (const state of ['reserved', 'preparing']) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    const receipts = createAgentSendReceiptStore(db);
    const entered = deferred();
    const gate = deferred();
    const first = await fixture(t, { db, send: async (message) => {
      receipts.reserveOrGet({ operationKey: message.operationKey, surface: 'tab-message',
        tabId: message.targetTabId, handoffId: message.handoffId,
        provider: message.targetProvider, sessionId: message.targetSessionId,
        requestFingerprint: sha(message.prompt), promptHash: promptAuditFingerprint(message.prompt), promptLength: message.prompt.length });
      if (state === 'preparing') receipts.markPreparing(message.operationKey);
      entered.resolve();
      return gate.promise;
    } });
    const q = (await first.question()).message;
    await entered.promise;
    first.service.dispose();
    let sends = 0;
    const restarted = new TabMessageService({ db, resolveTab: async (id) => tab(id),
      getReceipt: (key) => receipts.get(key), send: async (message) => {
        sends += 1;
        assert.equal(message.operationKey, q.operationKey);
        assert.equal(receipts.get(q.operationKey).state, state);
        return { state: 'confirmed' };
      },
    });
    t.after(() => restarted.dispose());
    await restarted.initialize();
    await drained(restarted);
    assert.equal(sends, 1);
    assert.equal(restarted.getMessage(q.messageId).message.deliveryState, 'sent');
    gate.resolve(null);
    await drained(first.service);
  }
});

test('state and preparation updates advance timestamps even when the wall clock trails the row', async (t) => {
  const h = await fixture(t, { send: async () => ({ submitted: false, code: 'draft_conflict' }) });
  const q = (await h.question()).message;
  await drained(h.service);
  const future = '2100-01-01T00:00:00.000Z';
  h.db.prepare(`UPDATE ${TABLE_NAME} SET updatedAt = ? WHERE messageId = ?`).run(future, q.messageId);
  const eventStart = h.changes.length;
  await h.service.wake('B');
  const transitions = h.changes.slice(eventStart).map(({ message }) => message.updatedAt);
  assert.equal(transitions.length, 2);
  assert.ok(transitions[0] > future);
  assert.ok(transitions[1] > transitions[0]);
});

test('tracker list projects bounded metadata in SQL, without text or frozen prompt bodies', async (t) => {
  const h = await fixture(t);
  const text = '\u{1F680}'.repeat(500_000);
  const q = (await h.question('A', text, 'large-body')).message;
  await drained(h.service);
  const prepare = h.db.prepare;
  let projected;
  let listSql;
  h.db.prepare = function (sql) {
    listSql = sql;
    const statement = prepare.call(this, sql);
    const all = statement.all.bind(statement);
    statement.all = (...args) => { projected = all(...args); return projected; };
    return statement;
  };
  let list;
  try { list = h.service.listForTab('A'); }
  finally { h.db.prepare = prepare; }
  assert.doesNotMatch(listSql, /SELECT\s+\*/i);
  assert.doesNotMatch(listSql, /frozenPrompt/);
  assert.match(listSql, /substr\(text, 1, 200\)/);
  assert.equal(Object.hasOwn(projected[0], 'text'), false);
  assert.equal(Object.hasOwn(projected[0], 'frozenPrompt'), false);
  assert.ok(JSON.stringify(projected).length < 2500, 'SQLite-to-JS projection remains bounded');
  assert.ok(JSON.stringify(list).length < 2000);
  assert.equal(list[0].textPreview.length, 200);
  assert.equal(list[0].textChars, 500_000, 'SQL metadata count uses Unicode code points');
  assert.equal(h.service.getMessage(q.messageId).message.text, text, 'full read remains byte-for-byte exact');
});
