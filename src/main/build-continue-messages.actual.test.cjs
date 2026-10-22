'use strict';
// Production message owner + restart journal + FIFO/receipt SQLite factories.
// Node SQLite adapter and native/provider/OS facts are explicit controlled leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { TabMessageService, TABLE_NAME } = require('./tab-messages');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const drained = async service => { while (service.lanes.size) await Promise.all([...service.lanes.values()]); };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-continue-messages-'));
  const db = new NodeSqlite(path.join(root, 'private.sqlite'));
  db.exec('CREATE TABLE state(value TEXT)');
  const parties = new Map(['P', 'W'].map(id => [id, { tabId: id, tabName: id, projectId: 'project-' + id,
    projectName: id, cwd: root, provider: 'codex', sessionId: id + '-A' }]));
  const states = new Map([...parties].map(([id, party]) => [id, { known: true, exists: true, toolType: 'codex',
    sessionId: party.sessionId, cwd: root, processStatus: 'found', busy: false, transitioning: false,
    revision: 'R', backgroundWorkCount: 0 }]));
  const context = { provider: 'codex', sessionId: 'W-A', turnId: 'work-T', generation: 1 };
  const subject = { kind: 'codex-execution', toolType: 'codex', sessionId: 'W-A', targetExecutionContext: context };
  const native = createAgentSendReceiptStore(db), queue = new AgentSendQueue({ store: native, ready: () => false });
  const calls = [], inputs = [], controls = {};
  let operations, messages;
  function makeMessages() {
    return new TabMessageService({ db, resolveTab: async id => parties.get(id),
      send: async message => { calls.push(message); return { state: 'confirmed', operationKey: message.operationKey }; },
      readRestartBinding: request => operations?.messageBinding(request) });
  }
  messages = makeMessages(); await messages.initialize();
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'instance-' + pid, now: () => 1000,
    read: () => { const row = db.prepare('SELECT value FROM state').get(); return row ? JSON.parse(row.value) : null; },
    write: value => { db.prepare('DELETE FROM state').run(); db.prepare('INSERT INTO state VALUES (?)').run(JSON.stringify(value)); },
    readRuns: async () => [], readMessages: () => messages.restartReferences(),
    captureTabs: () => [...parties].map(([id, party]) => ({ tabId: id, known: true, toolType: 'codex',
      sessionId: id + '-A', projectId: party.projectId, cwd: root, busy: id === 'W', revision: 'capture',
      executionContext: id === 'W' ? context : null, subject: id === 'W' ? subject : null })),
    readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
      targets: [{ tabId: 'W', provider: 'codex', sessionId: 'W-A' }] }),
    readState: async id => { await controls.readState?.(); return { ...states.get(id) }; },
    captureOne: id => states.get(id),
    readOriginal: async () => ({ found: true, sourceVerified: true, complete: false, executionContext: context }),
    readLatest: async () => ({ result: { sourceVerified: true }, subject }),
    readReceipt: key => native.get(key), readQueued: key => queue.item(key),
    send: async request => {
      await request.prepareSend(); inputs.push(request); const frozen = JSON.parse(JSON.stringify(request));
      const identity = { operationKey: request.sendOperationKey, tabId: 'W', provider: 'codex', sessionId: 'W-A',
        handoffId: request.handoffId, surface: 'desktop-history', promptHash: promptAuditFingerprint('continue'),
        promptLength: 8, requestFingerprint: fingerprintAgentSendRequest(frozen) };
      assert.equal(queue.enqueue({ identity, request: frozen }).ok, true);
      const attempt = native.beginAttempt(identity);
      assert.equal(native.stageAttemptContext(identity.operationKey, attempt.attemptId, { sessionId: 'W-B' }).ok, true);
      native.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
      assert.equal(native.promoteFromAudit({ success: true, operationKey: identity.operationKey, attemptId: attempt.attemptId,
        provider: 'codex', sessionId: 'W-B', entryUuid: 'native-continue-user', promptHash: identity.promptHash,
        actualHash: identity.promptHash, auditTimestamp: new Date(2000).toISOString(), transcriptBoundary: { byteOffset: 1 },
        executionContext: { provider: 'codex', sessionId: 'W-B', turnId: 'continued-T', generation: 2 } }).promoted, true);
      return { success: true, status: 'sent' };
    },
  });
  operations = make(11);
  t.after(() => { messages.dispose(); operations.dispose(); queue.dispose(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { parties, states, inputs, calls, controls, native, db, get operations() { return operations; }, get messages() { return messages; },
    question: async id => { const q = await messages.sendMessage({ source: 'P', target: 'W', text: 'Exact question', requestId: id }); await drained(messages); return q.message.messageId; },
    restart: async () => { await operations.capture('message-restart-one', 11); operations.dispose(); operations = make(22);
      Object.assign(parties.get('W'), { sessionId: 'W-B', acceptedResumeSourceSessionId: 'W-A' });
      Object.assign(states.get('W'), { sessionId: 'W-B', acceptedResumeSourceSessionId: 'W-A' });
      operations.activate('message-restart-one'); await operations.reconcile('message-restart-one');
      await operations.reconcile('message-restart-one'); },
    reopen: async () => { messages.dispose(); messages = makeMessages(); await messages.initialize(); },
  };
}

test('delivered A→captured restart→one confirmed continuation B permits one exact reply, frozen delivery A unchanged', async t => {
  const h = await fixture(t), id = await h.question('q-one');
  const old = h.db.prepare('SELECT * FROM tab_messages WHERE messageId=?').get(id);
  assert.equal(old.deliverySessionId, 'W-A'); await h.restart(); assert.equal(h.inputs.length, 1);
  const reply = await h.messages.replyToMessage({ responder: 'W', messageId: id, text: 'One answer', requestId: 'reply-one' });
  await drained(h.messages);
  assert.equal(reply.message.sourceSessionId, 'W-B'); assert.match(reply.message.sourceRestartBindingId, /^restart-message:/);
  const current = h.db.prepare('SELECT * FROM tab_messages WHERE messageId=?').get(id);
  assert.equal(current.targetSessionId, old.targetSessionId); assert.equal(current.deliverySessionId, old.deliverySessionId);
  assert.equal(current.frozenPrompt, old.frozenPrompt);
  await h.reopen();
  const recovered = await h.messages.replyToMessage({ responder: 'W', messageId: id, text: 'One answer', requestId: 'reply-one' });
  await drained(h.messages);
  assert.equal(recovered.message.messageId, reply.message.messageId); assert.equal(h.calls.length, 2);
  assert.equal(h.inputs.length, 1, 'no second build continue and no new question/reply');
});

test('bare alias and a question outside this operation cannot obtain responder authority', async t => {
  const h = await fixture(t), id = await h.question('q-bare');
  Object.assign(h.parties.get('W'), { sessionId: 'W-B', acceptedResumeSourceSessionId: 'W-A' });
  await assert.rejects(h.messages.replyToMessage({ responder: 'W', messageId: id, text: 'not allowed', requestId: 'bare' }),
    { code: 'tab_message_foreign_responder' });
  assert.equal(h.inputs.length, 0); assert.equal(h.calls.length, 1);
});

test('replacement after proof await refuses reservation and leaves original question unanswered', async t => {
  const h = await fixture(t), id = await h.question('q-race'); await h.restart();
  h.controls.readState = () => { h.controls.readState = null;
    Object.assign(h.parties.get('W'), { sessionId: 'W-C' }); Object.assign(h.states.get('W'), { sessionId: 'W-C', revision: 'new' }); };
  await assert.rejects(h.messages.replyToMessage({ responder: 'W', messageId: id, text: 'stale answer', requestId: 'race' }),
    { code: 'tab_message_foreign_responder' });
  assert.equal(h.messages.getMessage(id).reply, null); assert.equal(h.calls.length, 1);
});
