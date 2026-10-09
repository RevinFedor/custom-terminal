'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { TabMessageService } = require('./tab-messages');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { prepareTabMessageDeliveryCancellation } = require('./tab-message-send-control');
const { handleTabMessageApi } = require('./tab-message-api');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const db = options.db || new Database(':memory:');
  const store = createAgentSendReceiptStore(db);
  let service;
  const writes = [], cancellations = [];
  const identity = req => ({ operationKey: req.sendOperationKey, surface: req.surface || 'tab-message',
    tabId: req.tabId, handoffId: req.handoffId, provider: 'codex', sessionId: 'session-B',
    requestFingerprint: fingerprintAgentSendRequest(req), promptHash: promptAuditFingerprint(req.prompt), promptLength: req.prompt.length });
  const queue = new AgentSendQueue({ store, readInputSlot: options.readInputSlot,
    cancelAttempt: record => cancellations.push(record.operationKey),
    projectPresentation: record => service?.receiptPresentation(record.operationKey, record.tabId),
    publish: record => { if (service?.initialized) service.observeReceipt(record.operationKey, record); },
    execute: async req => {
      const start = store.beginAttempt(identity(req));
      assert.equal(start.action, 'attempt-started');
      await options.beforeArm?.(req, start);
      const arm = store.markAttemptState(req.sendOperationKey, start.attemptId, 'enter-armed', {
        inputLease: { version: 1, tabId: req.tabId, provider: 'codex', lifecycleGeneration: 'G1', runSeq: 1 },
      });
      if (!arm.ok) {
        store.settleAttempt(req.sendOperationKey, start.attemptId, { success: false, submitted: false,
          pasteWritten: false, enterWritten: false, code: 'agent_send_cancelled' });
      } else {
        writes.push(req.handoffId);
        store.settleAttempt(req.sendOperationKey, start.attemptId, { success: null, submitted: true,
          status: 'delivery-unknown', deliveryUnknown: true });
        store.markProviderQueueAccepted(req.sendOperationKey, start.attemptId, { provider: 'codex',
          sessionId: 'session-B', sourceIdentity: 'codex-tui-queue:' + req.handoffId });
      }
      return store.get(req.sendOperationKey).receipt;
    } });
  service = new TabMessageService({ db,
    resolveTab: async id => {
      await options.beforeResolve?.(id);
      return { tabId: id, projectId: 'P', provider: 'codex', sessionId: 'session-' + id };
    },
    getReceipt: key => queue.projectRecord(store.get(key)), receiptRequiredBeforeSend: true,
    cancelDelivery: message => prepareTabMessageDeliveryCancellation({ store, queue, db }, message),
    send: async message => {
      await options.beforePrepare?.(message);
      service.assertDeliveryActive(message.messageId);
      const req = { tabId: message.targetTabId, handoffId: message.handoffId,
        sendOperationKey: message.operationKey, prompt: message.prompt, source: 'tab-message:' + message.messageId };
      const accepted = queue.enqueue({ identity: identity(req), request: req });
      assert.equal(accepted.ok, true);
      await queue.result(req.sendOperationKey);
      return queue.projectRecord(store.get(req.sendOperationKey));
    } });
  await service.initialize();
  t.after(async () => { service.dispose(); queue.dispose(); await tick(); if (!options.db) db.close(); });
  return { db, store, queue, service, writes, cancellations, identity,
    question: async () => (await service.sendMessage({ source: 'A', target: 'B', text: 'synthetic question', requestId: 'question' })).message,
    drain: async () => { while (service.lanes.size) await Promise.all([...service.lanes.values()]); await tick(); },
  };
}

test('cancel during deferred preparation prevents the actual queue/attempt and keeps its immutable question', async t => {
  const gate = deferred(), entered = deferred();
  const h = await fixture(t, { beforePrepare: async () => { entered.resolve(); await gate.promise; } });
  const q = await h.question(); await entered.promise;
  const before = h.service.getMessage(q.messageId).message.text;
  const first = h.service.cancelMessage({ tabId: 'B', messageId: q.messageId });
  assert.equal(first.cancelled, true);
  const stamp = first.message.updatedAt;
  assert.equal(h.service.cancelMessage({ tabId: 'A', messageId: q.messageId }).message.updatedAt, stamp);
  gate.resolve(); await h.drain();
  assert.equal(h.writes.length, 0);
  assert.equal(h.queue.item(q.operationKey), null);
  assert.equal(h.store.isDeliveryCancelled(q.operationKey), true);
  assert.equal(h.service.getMessage(q.messageId).message.text, before);
  await h.service.wake('B'); await h.drain(); assert.equal(h.writes.length, 0);
});

test('cancel while the admitted executor awaits before Enter rejects durable arm, not merely its UI', async t => {
  const entered = deferred(), gate = deferred();
  const h = await fixture(t, { beforeArm: async () => { entered.resolve(); await gate.promise; } });
  const q = await h.question(); await entered.promise;
  h.service.cancelMessage({ tabId: 'A', messageId: q.messageId });
  assert.deepEqual(h.cancellations, [q.operationKey]);
  gate.resolve(); await h.drain();
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get(q.operationKey).state, 'not-submitted');
  assert.equal(h.queue.item(q.operationKey).state, 'cancelled');
});

test('cancel after provider queue acceptance retires the quiescent input slot, not historical delivery evidence', async t => {
  const h = await fixture(t), q = await h.question(); await h.drain();
  const old = h.store.get(q.operationKey);
  h.service.cancelMessage({ tabId: 'B', messageId: q.messageId });
  await tick(); await tick();
  assert.deepEqual(h.writes, [q.handoffId]);
  assert.equal(h.store.get(q.operationKey).attemptId, old.attemptId);
  assert.equal(h.store.get(q.operationKey).state, old.state);
  assert.deepEqual(h.store.get(q.operationKey).receipt, old.receipt);
  assert.equal(h.queue.queueInfo(q.operationKey).inputSlot.state, 'retired');
  assert.ok(h.queue.projectRecord(h.store.get(q.operationKey)).receipt.presentationDismissedAt);
  const later = { tabId: 'B', handoffId: 'later', sendOperationKey: 'history:B:later', prompt: 'new user input', surface: 'desktop-history' };
  h.queue.enqueue({ identity: h.identity(later), request: later }); await tick(); await tick();
  assert.deepEqual(h.writes, [q.handoffId, 'later']);
  await h.service.wake('B'); await h.drain(); assert.deepEqual(h.writes, [q.handoffId, 'later']);
});

test('late saved reply to a cancelled question remains readable and never enters the receiver input', async t => {
  const gate = deferred(), entered = deferred();
  const h = await fixture(t, { beforePrepare: async () => { entered.resolve(); await gate.promise; } });
  const q = await h.question(); await entered.promise;
  h.service.cancelMessage({ tabId: 'A', messageId: q.messageId }); gate.resolve(); await h.drain();
  const r = await h.service.replyToMessage({ responder: 'B', messageId: q.messageId, text: 'saved late reply', requestId: 'reply' });
  await h.drain();
  assert.ok(r.message.cancelledAt);
  assert.equal(r.message.deliveryState, 'failed');
  assert.equal(h.service.getMessage(q.messageId).reply.text, 'saved late reply');
  assert.equal(h.writes.length, 0);
});

test('HTTP cancel validates participant, returns compact control ACK, and old dismiss remains presentation-only', async t => {
  const gate = deferred(), entered = deferred();
  const h = await fixture(t, { beforePrepare: async () => { entered.resolve(); await gate.promise; } });
  const q = await h.question(); await entered.promise;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    await handleTabMessageApi(req, res, { pathname: url.pathname, query: Object.fromEntries(url.searchParams) }, {
      service: h.service, resolveTab: async () => assert.fail('control requires no live resolve'),
      readBody: async request => { let value = ''; for await (const chunk of request) value += chunk; return JSON.parse(value); },
      sendJson: (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); },
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (action, tabId) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tab-messages/${q.messageId}/${action}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId }) });
    return { status: response.status, body: await response.json() };
  };
  const foreign = await request('cancel', 'C');
  assert.equal(foreign.status, 403); assert.equal(foreign.body.submitted, undefined);
  const hide = await request('dismiss', 'A'); assert.equal(hide.status, 200); assert.equal(hide.body.message.cancelledAt, null);
  const cancel = await request('cancel', 'B');
  assert.equal(cancel.status, 200); assert.equal(cancel.body.cancelled, true);
  assert.equal(cancel.body.message.text, undefined); assert.ok(cancel.body.message.cancelledAt);
  gate.resolve(); await h.drain(); assert.equal(h.writes.length, 0);
});
