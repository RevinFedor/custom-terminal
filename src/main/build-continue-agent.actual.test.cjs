'use strict';
// Real RunStore + continuation owner + FIFO/receipt SQLite + build operation.
// Physical writer, provider result/readiness and OS restart are controlled.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { OrchestrationRunStore, buildOrchestrationResultLookup } = require('./orchestration-runs');
const { createOrchestrationContinuationService } = require('./orchestration-continuation');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');

test('incoming delegated task has ONE owner continuation, bound new turn and original return address across restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-continue-agent-'));
  const db = new NodeSqlite(path.join(root, 'receipts.sqlite')), receipts = createAgentSendReceiptStore(db);
  const queue = new AgentSendQueue({ store: receipts, ready: () => false });
  const sourceTarget = { toolType: 'codex', sessionId: 'parent-S' };
  const old = { provider: 'codex', sessionId: 'worker-A', turnId: 'original-T', generation: 1, processId: null, startedAt: 100 };
  const next = { provider: 'codex', sessionId: 'worker-B', turnId: 'continued-T', generation: 2, processId: null, startedAt: 2000 };
  let operation, saved = null, current = { known: true, exists: true, toolType: 'codex', sessionId: 'worker-B',
    acceptedResumeSourceSessionId: 'worker-A', cwd: root, busy: false, revision: 'restored', processStatus: 'found',
    transitioning: false, backgroundWorkCount: 0 };
  const store = new OrchestrationRunStore(path.join(root, 'runs.json'), { readRecoveryHold: run => operation?.recoveryHold(run) });
  await store.create({ runId: 'same-delegation', sourceTabId: 'parent', targetTabId: 'worker', sourceToolType: 'codex',
    targetToolType: 'codex', sourceSendTarget: sourceTarget, targetExecutionContext: old, targetCwd: root, promptHash: 'original-hash' });
  await store.markDelivery('same-delegation', { sessionId: 'worker-A', lifecycleGeneration: 'old-launch' });
  await store.patch('same-delegation', { status: 'running', targetPromptProofAt: 100, targetPromptProofUserUuid: 'original-user' });
  const input = [], deliveries = [];
  const continuation = createOrchestrationContinuationService({ store, receipts, now: () => 1000,
    readState: async tabId => tabId === 'parent' ? { known: true, exists: true, toolType: 'codex', sessionId: 'parent-S',
      busy: false, revision: 'parent', processStatus: 'found', backgroundWorkCount: 0 } : ({ ...current }),
    readInfo: async () => ({ sessionId: 'worker-B', lifecycleGeneration: 'new-launch' }),
    readOriginal: async () => ({ found: true, sourceVerified: true, complete: false, userUuid: 'original-user', executionContext: old }),
    readLatest: async () => ({ subject: { kind: 'codex-historical-execution', targetExecutionContext: old }, result: { sourceVerified: true } }),
    reconcile: async () => {}, deliver: async id => deliveries.push(id),
    send: async request => {
      await request.prepareSend(); input.push(request);
      const plain = JSON.parse(JSON.stringify(request)), identity = { operationKey: request.sendOperationKey, tabId: request.tabId,
        provider: 'codex', sessionId: 'worker-A', surface: 'desktop-history', handoffId: request.handoffId,
        requestFingerprint: fingerprintAgentSendRequest(plain), promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
      assert.equal(queue.enqueue({ identity, request: plain }).ok, true);
      const attempt = receipts.beginAttempt(identity);
      receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { sessionId: 'worker-B' });
      receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
      assert.equal(receipts.promoteFromAudit({ success: true, operationKey: identity.operationKey, attemptId: attempt.attemptId,
        provider: 'codex', sessionId: 'worker-B', promptHash: identity.promptHash, actualHash: identity.promptHash,
        entryUuid: 'one-continue-user', executionContext: next, auditTimestamp: new Date(next.startedAt).toISOString(),
        transcriptBoundary: { byteOffset: 1 }, queuedAtSubmit: false }).promoted, true);
      current = { ...current, busy: true, executionContext: next, revision: 'new-turn' };
      return { success: true, submitted: true };
    }, log: { log() {}, warn() {} },
  });
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'instance-' + pid, now: () => 1000,
    read: () => saved, write: value => { saved = JSON.parse(JSON.stringify(value)); }, readRuns: () => store.installSnapshot(),
    captureTabs: () => [{ tabId: 'worker', known: true, toolType: 'codex', sessionId: 'worker-A', projectId: 'project', cwd: root,
      busy: true, revision: 'capture', executionContext: old,
      subject: { kind: 'codex-execution', toolType: 'codex', sessionId: 'worker-A', targetExecutionContext: old } }],
    readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
      targets: [{ tabId: 'worker', provider: 'codex', sessionId: 'worker-A' }] }),
    readState: async () => ({ ...current }), continueRun: id => continuation.continueRequest(id), getRun: id => store.getInternal(id),
    readReceipt: key => receipts.get(key), readQueued: key => queue.item(key),
    send: () => assert.fail('must not create a second generic build continue'),
  });
  operation = make(11);
  t.after(async () => { operation.dispose(); queue.dispose(); await store.flush(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await operation.capture('agent-restart-one', 11);
  await store.beginRecovery('same-delegation', 'interrupted', 'turn_aborted');
  operation.dispose(); operation = make(22); operation.activate('agent-restart-one'); await operation.reconcile('agent-restart-one');
  const bound = await store.getInternal('same-delegation');
  assert.equal(input.length, 1); assert.equal(input[0].handoffId, bound.continuationIntent.handoffId);
  assert.match(input[0].source, /^orchestration-continue:/);
  assert.equal(bound.continuationIntent.state, 'bound'); assert.equal(bound.targetExecutionContext.turnId, 'continued-T');
  assert.equal(buildOrchestrationResultLookup(bound).promptUserUuid, 'one-continue-user');
  assert.equal(operation.get('agent-restart-one').targets[0].state, 'confirmed');
  assert.deepEqual(bound.sourceSendTarget, sourceTarget); assert.equal(bound.sourceTabId, 'parent');
  operation.dispose(); operation = make(33); operation.activate('agent-restart-one'); await operation.reconcile('agent-restart-one');
  assert.equal(input.length, 1); assert.equal((await store.listAll()).length, 1);
  const final = await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete', sessionId: 'worker-B', toolType: 'codex',
    lifecycleGeneration: 'new-launch', executionContext: next });
  assert.equal(final.settled[0]?.runId, 'same-delegation');
  assert.equal(final.settled[0]?.sourceTabId, 'parent');
});
