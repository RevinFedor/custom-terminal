'use strict';
// Production operation/continuation owners, structural parser/projector and
// FIFO/native receipt SQLite. Provider, process/readiness and app restart are
// controlled; this is Source/private, not physical Send/installed acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture: indexFixture, turn } = require('./fixtures/build-continue-index.cjs');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { createOrchestrationContinuationService } = require('./orchestration-continuation');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { TabMessageService } = require('./tab-messages');
const copy = value => JSON.parse(JSON.stringify(value));

async function fixture(t, options = {}) {
  const index = indexFixture(t, { parent: options.parent ?? options.agent !== true, middle: options.manual
    ? [...turn('callback-first', 'first callback'), ...turn('manual', 'new user work')] : [], malformed: options.gap });
  const loaded = await index.prime(), original = { ...loaded.original, found: true };
  const old = { ...original.executionContext, generation: 1, processId: '123' };
  const latest = { subject: { kind: 'codex-historical-execution', targetExecutionContext: loaded.latest.executionContext },
    result: { ...loaded.latest, found: true } };
  const db = new NodeSqlite(), receipts = createAgentSendReceiptStore(db), queue = new AgentSendQueue({ store: receipts, ready: () => false });
  const outgoing = [{ runId: 'external-last', runKind: 'external-research', sourceTabId: 'worker', targetTabId: null,
    createdAt: 77, sourceSendTarget: { toolType: 'codex', sessionId: old.sessionId }, externalResearchJobId: 'same-SC-job', status: 'running' }];
  if (options.manual) outgoing.push({ ...outgoing[0], runId: 'external-first', externalResearchJobId: 'same-first-job' });
  if (options.sharedMessage) outgoing.length = 0;
  let operation, saved = null;
  let state = { known: true, exists: true, toolType: 'codex', sessionId: 'B', acceptedResumeSourceSessionId: old.sessionId,
    cwd: index.root, busy: false, transitioning: false, processStatus: 'found', revision: 'callback-final', backgroundWorkCount: 0 };
  const store = new OrchestrationRunStore(require('node:path').join(index.root, 'runs.json'), { readRecoveryHold: run => operation?.recoveryHold(run),
    readRestartSourceFollowup: request => operation?.sourceFollowupBinding(request) });
  if (options.agent) {
    await store.create({ runId: 'incoming-own-task', sourceTabId: 'parent', targetTabId: 'worker', sourceToolType: 'codex', targetToolType: 'codex',
      sourceSendTarget: { toolType: 'codex', sessionId: 'parent-S' }, targetExecutionContext: old, targetCwd: index.root, promptHash: 'old-intent' });
    await store.markDelivery('incoming-own-task', { sessionId: old.sessionId, lifecycleGeneration: 'launch' });
    await store.patch('incoming-own-task', { status: 'running', targetPromptProofAt: 100,
      targetPromptProofUserUuid: original.userUuid, resultPromptProofUserUuid: original.userUuid });
  }
  if (options.sourceFollowup) {
    for (const run of outgoing) {
      const row = await store.create({ ...run, sourceExecutionContext: old, parentRunId: 'incoming-own-task' });
      Object.assign(run, await store.getInternal(row.runId));
    }
  }
  function recordInput(request, proof) {
    const plain = copy(request), identity = { operationKey: request.sendOperationKey, tabId: request.tabId,
      provider: 'codex', sessionId: old.sessionId, surface: 'desktop-history', handoffId: request.handoffId,
      requestFingerprint: fingerprintAgentSendRequest(plain), promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
    assert.equal(queue.enqueue({ identity, request: plain }).ok, true);
    const attempt = receipts.beginAttempt(identity);
    receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { sessionId: 'B' });
    receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true, status: 'delivery-unknown' });
    assert.equal(receipts.promoteFromAudit({ success: true, operationKey: identity.operationKey, attemptId: attempt.attemptId,
      provider: 'codex', sessionId: 'B', promptHash: identity.promptHash, actualHash: identity.promptHash,
      entryUuid: proof.userUuid, sourceIdentity: proof.sourceIdentity, executionContext: proof.executionContext,
      auditTimestamp: new Date(2000).toISOString(), transcriptBoundary: { byteOffset: 1 }, queuedAtSubmit: false }).promoted, true);
    return identity;
  }
  const messages = new TabMessageService({ db,
    cancelDelivery: () => ({ ok: true }),
    resolveTab: async id => ({ tabId: id, projectId: 'project', provider: 'codex',
      sessionId: id === 'worker' ? old.sessionId : 'parent-S', cwd: index.root }),
    send: async message => {
      if (message.kind === 'reply') {
        require('node:fs').writeFileSync(index.file, require('./fixtures/build-continue-index.cjs').encode(turn('callback', message.prompt)));
        const result = await index.latest();
        recordInput({ tabId: 'worker', provider: 'codex', prompt: message.prompt,
          expectedTarget: { toolType: 'codex', sessionId: old.sessionId }, handoffId: message.handoffId,
          source: 'tab-message:' + message.messageId, sendOperationKey: message.operationKey }, result);
      }
      return { state: 'confirmed' }; // Controlled native leaf; SQL/receipt/parser owners are actual.
    },
  });
  await messages.initialize();
  const sharedIds = [];
  if (options.sharedMessage) for (let i = 0; i < 2; i++) {
    sharedIds.push((await messages.sendMessage({ source: 'worker', target: 'parent', text: 'Q' + i, requestId: 'Q' + i })).message.messageId);
    while (messages.lanes.size) await Promise.all([...messages.lanes.values()]);
  }
  const sent = [], next = { provider: 'codex', sessionId: 'B', turnId: 'own-continued', generation: 3, processId: null, startedAt: 3000 };
  const send = async request => {
    await request.prepareSend(); sent.push(request);
    if (options.agent) {
      recordInput(request, { userUuid: 'one-own-continue-user', executionContext: next });
      state = { ...state, revision: 'own-continued', busy: true, executionContext: next };
    } else {
      const plain = copy(request);
      assert.equal(queue.enqueue({ identity: { operationKey: request.sendOperationKey, tabId: request.tabId,
        provider: 'codex', sessionId: old.sessionId, surface: 'desktop-history', handoffId: request.handoffId,
        requestFingerprint: fingerprintAgentSendRequest(plain), promptHash: promptAuditFingerprint(request.prompt),
        promptLength: request.prompt.length }, request: plain }).ok, true);
    }
    return { success: true, status: 'application-queued', submitted: options.agent === true };
  };
  const readLatest = async () => {
    const result = await index.latest(); latest.subject.targetExecutionContext = result.executionContext;
    latest.result = { ...result, found: result.success === true,
      ...(controls.latestUnverified ? { sourceVerified: false } : {}) }; return latest;
  };
  const continuation = createOrchestrationContinuationService({ store, receipts, now: () => 2000,
    readState: async id => id === 'parent' ? { ...state, sessionId: 'parent-S', busy: false, revision: 'parent' } : copy(state),
    readInfo: async () => ({ sessionId: 'B', lifecycleGeneration: 'launch' }), readOriginal: async () => original, readLatest,
    readRestartHistoryProof: request => operation.restartHistoryForRun(request), send, reconcile: async () => {}, deliver: async () => {},
    log: { warn() {}, log() {} } });
  const controls = {};
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'instance-' + pid, now: () => 1000,
    read: () => saved, write: value => { saved = copy(value); },
    readRuns: async () => [...new Map([...await store.installSnapshot(), ...copy(outgoing)].map(run => [run.runId, run])).values()],
    readMessages: () => messages.restartReferences(), readMessage: id => messages.restartReference(id),
    captureTabs: () => [{ tabId: 'worker', known: true, toolType: 'codex', sessionId: old.sessionId, cwd: index.root,
      projectId: 'project', busy: true, executionContext: old, subject: { kind: 'codex-execution', toolType: 'codex',
        sessionId: old.sessionId, targetExecutionContext: old } }],
    readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
      targets: [{ tabId: 'worker', provider: 'codex', sessionId: old.sessionId }] }),
    readState: async () => copy(state), readOriginal: async () => original, readLatest,
    readInputInterval: async () => { controls.interval?.(); return index.interval(); },
    continueRun: (id, options) => continuation.continueRequest(id, options), reconcileRunContinuation: id => continuation.reconcile(id),
    getRun: async id => outgoing.find(run => run.runId === id) || store.getInternal(id),
    readReceipt: key => { const record = receipts.get(key); if (record && controls.wrongAttempt) record.auditIdentity.attemptId = 'foreign'; return record; },
    readCallbackExecution: async record => {
      const context = record.receipt?.auditExecutionContext || null;
      if (controls.changedProof && ++controls.proofReads % 2 === 0) return { ...context, turnId: 'different-proof' };
      return context;
    },
    readQueued: key => queue.item(key), send,
  });
  operation = make(11); await operation.capture('callback-first-restart', 11);
  if (options.sharedMessage) {
    await messages.replyToMessage({ responder: 'parent', messageIds: sharedIds, text: 'one common answer', requestId: 'shared-R' });
    while (messages.lanes.size) await Promise.all([...messages.lanes.values()]);
    if (options.cancelPrimary) messages.cancelMessage({ tabId: 'worker', messageId: sharedIds[0] });
  }
  for (const run of outgoing) {
    const first = run.runId === 'external-first';
    const result = first ? await index.reader.loadHistoricalObservedExecution({ ...index.request,
      targetExecutionContext: { provider: 'codex', sessionId: 'B', turnId: 'callback-first', generation: null } }) : loaded.latest;
    const handoffId = 'orchestration-complete:' + run.runId;
    recordInput({ tabId: 'worker', provider: 'codex', prompt: first ? 'first callback' : 'saved callback',
      expectedTarget: { toolType: 'codex', sessionId: old.sessionId }, handoffId,
      source: options.wrongSource ? 'manual-other-operation' : 'orchestration-completion:' + run.runId,
      sendOperationKey: 'history:worker:' + handoffId }, { userUuid: result.userUuid,
        sourceIdentity: result.sourceIdentity, executionContext: result.executionContext });
    if (options.sourceFollowup) {
      await store.patch(run.runId, { status: 'completed', resultComplete: true, resultAvailable: true, outcome: 'success', resultProofStatus: 'complete',
        notificationPromptHash: 'logical-callback', notificationPromptAuditHash: promptAuditFingerprint(first ? 'first callback' : 'saved callback'),
        notificationHandoffId: handoffId, notificationAttemptedAt: 1500 });
      await store.markNotification(run.runId, 'queued');
    }
  }
  if (options.agent) await store.beginRecovery('incoming-own-task', 'interrupted', 'turn_aborted');
  operation.dispose(); operation = make(22);
  t.after(async () => { messages.dispose(); operation.dispose(); queue.dispose(); await store.flush(); db.close(); });
  return { index, controls, outgoing, sent, store, receipts, queue, old, latest, next,
    get operation() { return operation; }, get state() { return state; }, set state(value) { state = value; },
    activate: async () => { operation.activate('callback-first-restart'); await operation.reconcile('callback-first-restart'); } };
}

for (const cancelPrimary of [false, true]) test('audit: captured Q references accept ONE shared Reply after restart; cancel primary=' + cancelPrimary, async t => {
  const h = await fixture(t, { sharedMessage: true, cancelPrimary });
  await h.activate();
  const target = h.operation.get('callback-first-restart').targets[0];
  assert.equal(h.sent.length, 1, JSON.stringify(target));
  assert.equal(target.historyProof.covered, true);
  assert.equal(target.historyProof.inputs.length, 1);
  assert.match(target.historyProof.inputs[0].operationKey, /^tab-message:/);
  await h.operation.reconcile('callback-first-restart'); assert.equal(h.sent.length, 1);
});
for (const changed of ['wrongAttempt', 'changedProof']) test('audit: shared Reply restart refuses ' + changed + ' facts instead of collapsing their identity', async t => {
  const h = await fixture(t, { sharedMessage: true });
  h.controls[changed] = true; h.controls.proofReads = 0;
  await h.activate(); assert.equal(h.sent.length, 0);
});

test('own+external: real callback is FIFO first, then ONE continue across exact parent A→child B', async t => {
  const h = await fixture(t); await h.activate();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].prompt, require('./build-continue-prompt').RESTART_PROMPT);
  assert.equal(h.sent[0].expectedTarget.sessionId, 'A');
  const callback = h.queue.item('history:worker:orchestration-complete:external-last'), own = h.queue.item(h.sent[0].sendOperationKey);
  assert(callback.id < own.id, 'shared FIFO retains callback before continue');
  assert.equal(h.outgoing[0].externalResearchJobId, 'same-SC-job');
  await h.operation.reconcile('callback-first-restart'); assert.equal(h.sent.length, 1, 'admitted unknown is not replayed');
});

test('verified complete input interval retains its existing authority when latest reader alone is unverified', async t => {
  const h = await fixture(t); h.controls.latestUnverified = true; await h.activate();
  assert.equal(h.sent.length, 1, 'the new positive supersession path must not narrow the existing callback interval path');
  assert.equal(h.operation.get('callback-first-restart').targets[0].historyProof.covered, true);
});

for (const kind of ['manual', 'wrongSource', 'gap', 'wrongAttempt', 'replacement-during-read']) test(kind + ' refuses restart continuation after callback', async t => {
  const h = await fixture(t, { [kind]: true });
  if (kind === 'wrongAttempt') h.controls.wrongAttempt = true;
  if (kind === 'replacement-during-read') h.controls.interval = () => { h.state = { ...h.state, sessionId: 'foreign', revision: 'foreign' }; };
  await h.activate(); assert.equal(h.sent.length, 0);
});

test('restored FIFO prepare checks the complete interval again after a later manual prompt', async t => {
  const h = await fixture(t); await h.activate(); assert.equal(h.sent.length, 1);
  const item = h.queue.item(h.sent[0].sendOperationKey);
  require('node:fs').appendFileSync(h.index.file, require('./fixtures/build-continue-index.cjs').encode(turn('late-manual', 'new work')));
  await assert.rejects(h.sent[0].prepareSend(), { code: 'build_continue_newer_input' });
  assert.equal(h.receipts.get(item.operation_key).attemptId, null);
  assert.equal(h.sent.length, 1, 'no second sender and no physical input after history change');
});

test('incoming delegation cannot adopt callback busy/final; sole canonical owner continue binds old task', async t => {
  const h = await fixture(t, { agent: true });
  const callback = h.latest.result.executionContext;
  h.state = { ...h.state, busy: true, executionContext: callback, revision: 'callback-busy' };
  await h.activate(); assert.equal(h.sent.length, 0);
  await h.store.applyLifecycle('worker', { type: 'busy', busy: true, toolType: 'codex', sessionId: 'B', lifecycleGeneration: 'launch', executionContext: callback });
  assert.equal((await h.store.getInternal('incoming-own-task')).status, 'waiting_recovery');
  const interim = await h.store.applyLifecycle('worker', { type: 'done', reason: 'task_complete', toolType: 'codex', sessionId: 'B',
    lifecycleGeneration: 'launch', executionContext: callback });
  assert.equal(interim.settled.length, 0, 'callback final is not original own-task final');
  h.state = { ...h.state, busy: false, executionContext: null, revision: 'callback-final' };
  await h.operation.reconcile('callback-first-restart');
  const run = await h.store.getInternal('incoming-own-task');
  assert.equal(h.sent.length, 1, JSON.stringify(h.operation.get('callback-first-restart')));
  assert.match(h.sent[0].source, /^orchestration-continue:/); assert.equal(run.continuationIntent.state, 'bound');
  assert.equal(run.targetExecutionContext.turnId, 'own-continued'); assert.equal(run.sourceTabId, 'parent');
  assert.equal(h.operation.get('callback-first-restart').targets[0].state, 'confirmed');
  await h.operation.reconcile('callback-first-restart'); assert.equal(h.sent.length, 1);
});

for (const resumeChild of [false, true]) test('exact child source-followup preserves captured parent, Resume child=' + resumeChild, async t => {
  const h = await fixture(t, { agent: true, sourceFollowup: true, parent: resumeChild });
  h.state = { ...h.state, busy: true, executionContext: h.latest.result.executionContext, revision: 'callback-busy' };
  await h.activate();
  const record = h.receipts.get('history:worker:orchestration-complete:external-last');
  const result = await h.store.confirmSourceFollowup('external-last', { kind: 'prompt-audit', sourceTabId: 'worker',
    toolType: 'codex', sessionId: 'B', source: 'orchestration-completion:external-last', handoffId: record.handoffId,
    actualHash: record.promptHash, submitted: true, userUuid: record.auditIdentity.entryUuid,
    sourceIdentity: record.auditIdentity.sourceIdentity, executionContext: h.latest.result.executionContext,
    auditTimestamp: record.auditIdentity.auditTimestamp });
  assert.equal(result.confirmed, true, JSON.stringify(result));
  const parent = await h.store.getInternal('incoming-own-task');
  assert.equal(parent.targetExecutionContext.turnId, 'old', 'callback is delivered; own interrupted task still owns its original input');
  assert.equal(parent.status, 'waiting_recovery');
  assert.equal((await h.store.getInternal('external-last')).sourceFollowupRestartOperationId, 'callback-first-restart');
  h.state = { ...h.state, busy: false, executionContext: null, revision: 'callback-final' };
  await h.operation.reconcile('callback-first-restart'); assert.equal(h.sent.length, 1);
  assert.equal((await h.store.getInternal('incoming-own-task')).targetExecutionContext.turnId, 'own-continued');
});

for (const race of ['wrong-receipt', 'cancel-during-proof']) test('source-followup refuses ' + race + ' before parent/child mutation', async t => {
  const h = await fixture(t, { agent: true, sourceFollowup: true });
  h.state = { ...h.state, busy: true, executionContext: h.latest.result.executionContext, revision: 'callback-busy' };
  await h.activate();
  if (race === 'wrong-receipt') h.controls.wrongAttempt = true;
  else {
    const reader = h.store.readRestartSourceFollowup;
    h.store.readRestartSourceFollowup = async request => {
      const binding = await reader(request); await h.store.cancel('incoming-own-task', { suppressNotification: true }); return binding;
    };
  }
  const record = h.receipts.get('history:worker:orchestration-complete:external-last');
  const result = await h.store.confirmSourceFollowup('external-last', { kind: 'prompt-audit', sourceTabId: 'worker',
    toolType: 'codex', sessionId: 'B', source: 'orchestration-completion:external-last', handoffId: record.handoffId,
    actualHash: record.promptHash, submitted: true, userUuid: record.auditIdentity.entryUuid,
    sourceIdentity: record.auditIdentity.sourceIdentity, executionContext: h.latest.result.executionContext,
    auditTimestamp: record.auditIdentity.auditTimestamp });
  assert.equal(result.confirmed, false); assert.equal(h.sent.length, 0);
  assert.equal((await h.store.getInternal('incoming-own-task')).targetExecutionContext.turnId, 'old');
  assert.equal((await h.store.getInternal('external-last')).sourceFollowupStartedAt, null);
});
