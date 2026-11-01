'use strict';
// Actual Main capture + cut snapshot + SQLite FIFO/receipts + continuation owner.
// Native source/process/readiness/result, payload/Enter and audit are controlled
// leaves. This never opens the installed app, a user rollout or a provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { mainCaptureFixture } = require('./fixtures/build-continue-main-capture.cjs');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { capturedCodexSubject } = require('./build-continue-proofs');
const shutdown = require('./build-install-continue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const copy = value => JSON.parse(JSON.stringify(value));

for (const lostAck of [false, true]) test('private task with unknown writer -> actual cut/restart/FIFO -> ONE natural continuation, lost ACK=' + lostAck, async t => {
  const db = new NodeSqlite(':memory:'); db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT)');
  const read = () => { const row = db.prepare('SELECT value FROM app_state WHERE key=?').get('journal'); return row ? JSON.parse(row.value) : null; };
  const write = value => { db.prepare('INSERT INTO app_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('journal', JSON.stringify(value)); };
  const native = mainCaptureFixture(), oldContext = copy(native.registry.getTurn('T'));
  let snapshot, service, dispatchReady = false, attempt = null, requestPlain = null, writes = 0, sends = 0;
  let resolveExecuted; const executed = new Promise(resolve => { resolveExecuted = resolve; });
  const receipts = createAgentSendReceiptStore(db), newContext = { provider: 'codex', sessionId: 'S', turnId: 'continued-T', generation: 2 };
  const tracker = {};
  const state = { known: true, exists: true, toolType: 'codex', sessionId: 'S', cwd: '/fixture',
    busy: false, transitioning: true, processStatus: 'unknown', backgroundWorkCount: 0, revision: 'restoring' };
  const queue = new AgentSendQueue({ store: receipts, ready: () => dispatchReady, execute: async request => {
    await service.prepareInput('capture-natural-one', 'T', request.expectedTarget);
    requestPlain = copy(request);
    const identity = { operationKey: request.sendOperationKey, tabId: 'T', provider: 'codex', sessionId: 'S',
      surface: 'desktop-history', handoffId: request.handoffId,
      requestFingerprint: fingerprintAgentSendRequest(requestPlain), promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
    attempt = receipts.beginAttempt(identity);
    assert.equal(attempt.ok, true);
    receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { sessionId: 'S' });
    writes++; // Controlled physical payload+Enter sink, not a real PTY.
    receipts.settleAttempt(identity.operationKey, attempt.attemptId,
      { submitted: true, deliveryUnknown: true, status: 'delivery-unknown', pasteWritten: true, enterWritten: true });
    classifyCodexTurnRecord(tracker, { type: 'event_msg', payload: { type: 'task_started', turn_id: newContext.turnId } });
    Object.assign(state, { busy: true, executionContext: newContext, revision: 'native-started' });
    resolveExecuted();
    return { success: true, submitted: true, deliveryUnknown: true, status: 'audit-pending' };
  } });
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'private-main-' + pid, now: () => 1000,
    read, write, readRuns: () => [], captureTabs: () => { const v = native.capture(); return [{ ...v, projectId: 'P', subject: capturedCodexSubject(v) }]; },
    captureOne: () => native.capture(), readStartup: () => snapshot,
    readState: async () => copy(state), readReceipt: key => receipts.get(key), readQueued: key => queue.item(key),
    readInputFence: () => ({ terminalInstanceId: 'restored-physical', stopRevision: 0 }),
    readOriginal: async target => ({ found: true, sourceVerified: true, complete: false, executionContext: target.subject.targetExecutionContext }),
    readLatest: async target => ({ result: { sourceVerified: true }, subject: target.subject }),
    send: async request => {
      await request.prepareSend(); sends++;
      const plain = copy(request), identity = { operationKey: request.sendOperationKey, tabId: 'T', provider: 'codex', sessionId: 'S',
        surface: 'desktop-history', handoffId: request.handoffId, requestFingerprint: fingerprintAgentSendRequest(plain),
        promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
      const accepted = queue.enqueue({ identity, request: plain }); assert.equal(accepted.ok, true);
      if (lostAck) throw Error('controlled lost application ACK');
      return { success: true, submitted: false, status: 'application-queued' };
    },
  });
  service = make(11);
  t.after(() => { service.dispose(); queue.dispose(); db.close(); });
  const cut = await service.capture('capture-natural-one', 11);
  assert.equal(cut.targets.length, 1); assert.equal(native.publicView().executionContext, null);
  service.prepareTaskShutdown();
  const release = shutdown.registerBuildContinueShutdownBindings(() => service.taskShutdownBindings());
  const produced = shutdown.createShutdownInterruptedSnapshot(new Map([['T', { engine: 'codex', sessionId: 'S' }]]),
    { capturedAt: 1001, shutdownPid: 11, reason: 'before-quit' }); release();
  snapshot = shutdown.resolveStartupInterruptedSnapshot({ persistedSnapshot: produced, projects: [{ id: 'P', tabs: [
    { tabId: 'T', commandType: 'codex', codexSessionId: 'S', wasInterrupted: true, cwd: '/fixture' },
  ] }], resolvedAt: 1100 });
  assert.equal(snapshot.buildContinueBindings[0].captureDigest, cut.captureDigest);
  service.dispose(); service = make(22);
  service.activate(cut.id); await service.reconcile(cut.id);
  assert.equal(sends, 0, 'process restoration/registration is not Continue permission');
  assert.equal(writes, 0);
  Object.assign(state, { transitioning: false, processStatus: 'found', revision: 'ready' });
  await service.reconcile(cut.id);
  assert.equal(sends, 1); assert.equal(writes, 0, 'application admission is not native delivery');
  const frozen = service.get(cut.id).targets[0];
  dispatchReady = true; await queue.pump('T'); await executed;
  assert.equal(writes, 1);
  await service.reconcile(cut.id);
  assert.notEqual(service.get(cut.id).targets[0].state, 'confirmed', 'unconfirmed input stays UNKNOWN');
  service.dispose(); service = make(33); service.activate(cut.id); await service.reconcile(cut.id);
  assert.equal(sends, 1); assert.equal(writes, 1, 'a restart/lost ACK cannot create another input');
  const hash = promptAuditFingerprint(requestPlain.prompt);
  assert.equal(receipts.promoteFromAudit({ success: true, operationKey: frozen.operationKey, attemptId: attempt.attemptId,
    provider: 'codex', sessionId: 'S', promptHash: hash, actualHash: hash, entryUuid: 'native-continue-user',
    executionContext: newContext, auditTimestamp: new Date(2000).toISOString(), transcriptBoundary: { byteOffset: 1 }, queuedAtSubmit: false }).promoted, true);
  await service.reconcile(cut.id);
  assert.equal(service.get(cut.id).targets[0].state, 'confirmed');
  const final = classifyCodexTurnRecord(tracker, { type: 'event_msg', payload: {
    type: 'task_complete', turn_id: newContext.turnId, last_agent_message: 'finished continued work',
  } });
  assert.equal(final.hasFinalResult, true);
  Object.assign(state, { busy: false, revision: 'natural-final' });
  await service.reconcile(cut.id);
  assert.equal(sends, 1); assert.equal(writes, 1);
  assert.equal(service.get(cut.id).targets[0].handoffId, frozen.handoffId);
  assert.equal(service.get(cut.id).targets[0].subject.targetExecutionContext.turnId, oldContext.turnId);
});
