'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { createAutomaticSendFrameGate } = require('./automatic-send-frame-gate');
const { createCodexResumeReadIdentityLease, resolveCodexReadIdentity } = require('./codex-runtime-contract');
const { isAutomaticPromptQueueRequest, hasPromptQueueContextConditionKey } = require('../shared/prompt-queue-send-intent.cjs');
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web.js', source, ts.ScriptTarget.Latest, true);
const admitSource = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'admitQueuedAgentSend').getText(ast);
const tick = () => new Promise(resolve => setImmediate(resolve));
const storeSource = fs.readFileSync(path.join(__dirname, '../renderer/store/usePromptQueueStore.ts'), 'utf8');
const storeAst = ts.createSourceFile('store.ts', storeSource, ts.ScriptTarget.Latest, true);
const keySource = ts.transpileModule(['normalizeQueuedPromptContextCondition', 'queuedPromptContextConditionKey']
  .map(name => storeAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)
    .getText(storeAst).replace(/^export /, '')).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const conditionKey = vm.runInNewContext(keySource + ';queuedPromptContextConditionKey;');

function fixture(t) {
  const db = new Database(':memory:'), store = createAgentSendReceiptStore(db);
  const mirror = { complete: true, writeSeq: 176, flushedSeq: 176, pendingResizeWriteSeq: null,
    redrawTrace: { synchronizedOutputOpen: true }, synchronizedFrameWaiters: new Set() };
  const gate = createAutomaticSendFrameGate({ getMirror: () => mirror });
  let root = { ready: true }, runtime = { status: 'active', inputReady: true, busy: false,
    writerStatus: 'provisional-source', sessionId: null };
  const writes = [], logs = [];
  const context = vm.createContext({ isAutomaticPromptQueueRequest, hasPromptQueueContextConditionKey, automaticSendAdmissionDiagnostics: new Map(),
    console: { log: line => logs.push(line) }, bridgeRequest: async () => root,
    coherentPublicRuntimeSnapshot: async () => runtime, readAutomaticSendFrame: gate.read });
  const admit = vm.runInContext(admitSource + ';admitQueuedAgentSend;', context);
  const request = { tabId: 'T', provider: 'codex', handoffId: 'H', sendOperationKey: 'history:T:H',
    source: 'prompt-queue', prompt: 'продолжить', promptQueueIntent: { version: 1, kind: 'queue',
      itemId: 'I', armedAt: 1, triggerTabId: 'T', conditionKey: conditionKey(undefined), triggerKey: 'null' } };
  const identity = { operationKey: request.sendOperationKey, surface: 'desktop-history', tabId: 'T',
    provider: 'codex', handoffId: 'H', requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: fingerprintAgentSendRequest(request.prompt), promptLength: request.prompt.length, sessionId: null };
  const queue = new AgentSendQueue({ store, admit, execute: async req => {
    const sendIdentity = req.handoffId === 'H' ? identity : { ...identity, operationKey: req.sendOperationKey,
      handoffId: req.handoffId, requestFingerprint: fingerprintAgentSendRequest(req),
      promptHash: fingerprintAgentSendRequest(req.prompt), promptLength: req.prompt.length };
    const begun = store.beginAttempt(sendIdentity);
    assert.equal(begun.action, 'attempt-started'); writes.push(req);
    store.markAttemptState(sendIdentity.operationKey, begun.attemptId, 'enter-armed');
    store.settleAttempt(sendIdentity.operationKey, begun.attemptId,
      { success: true, submitted: true, status: 'audit-pending', auditPending: true });
    return store.get(sendIdentity.operationKey).receipt;
  } });
  context.agentSendQueue = queue;
  t.after(async () => { gate.dispose(); queue.dispose(); await tick(); db.close(); });
  return { store, queue, mirror, writes, logs, context, request, record: () => store.get(identity.operationKey),
    addManual: () => {
      const manual = { ...request, handoffId: 'M', sendOperationKey: 'history:T:M', source: 'history-panel', prompt: 'manual follow-up' };
      delete manual.promptQueueIntent;
      return queue.enqueue({ request: manual, identity: { ...identity, operationKey: manual.sendOperationKey,
        handoffId: 'M', requestFingerprint: fingerprintAgentSendRequest(manual),
        promptHash: fingerprintAgentSendRequest(manual.prompt), promptLength: manual.prompt.length } });
    },
    add: () => queue.enqueue({ identity, request }), root: value => root = value,
    runtime: value => runtime = value,
    flush: () => { for (const check of Array.from(mirror.synchronizedFrameWaiters)) check(); } };
}

test('actual FIFO retains one reserved receipt during a long resume frame; one close wakes one exact Send', async t => {
  const f = fixture(t); f.add(); await tick();
  assert.equal(f.record().attemptId, null); assert.equal(f.record().state, 'reserved');
  assert.equal(f.writes.length, 0); assert.equal(f.mirror.synchronizedFrameWaiters.size, 1);
  for (let n = 0; n < 100; n++) f.flush();
  await tick(); assert.equal(f.writes.length, 0); assert.equal(f.logs.length, 1);
  f.mirror.redrawTrace.synchronizedOutputOpen = false; f.mirror.writeSeq++;
  f.flush(); await tick(); assert.equal(f.writes.length, 0);
  f.mirror.flushedSeq = f.mirror.writeSeq; f.flush(); await tick();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].handoffId, 'H');
  assert.equal(f.writes[0].prompt, 'продолжить'); assert.ok(f.record().attemptId);
  for (let n = 0; n < 10; n++) f.queue.notifyRuntime('T');
  await tick(); assert.equal(f.writes.length, 1, 'an unknown/audit-pending result is not replay permission');
});

test('Pause or exact cancellation before the frame closes cannot resurrect the waiting handoff', async t => {
  for (const cancelDirectly of [false, true]) {
    const f = fixture(t); f.add(); await tick();
    if (cancelDirectly) assert.equal(f.queue.cancelWaiting('T', 'H').count, 1);
    else f.root({ cancel: true, reason: 'automatic-intent-changed' });
    f.mirror.redrawTrace.synchronizedOutputOpen = false; f.flush(); await tick();
    assert.equal(f.writes.length, 0); assert.equal(f.record().attemptId, null);
    assert.equal(f.record().receipt.enterWritten, false); assert.ok(f.record().deliveryControl.cancelledAt);
    assert.equal(f.record().deliveryControl.reason, cancelDirectly ? 'user-cancel' : 'automatic-intent-changed');
  }
});

test('frame close during the pending admission is not lost; a new Goal still blocks it', async t => {
  const f = fixture(t); f.add(); await tick();
  const read = f.context.readAutomaticSendFrame;
  f.context.readAutomaticSendFrame = (tab, wake) => {
    const answer = read(tab, wake);
    f.mirror.redrawTrace.synchronizedOutputOpen = false; f.flush();
    f.runtime({ status: 'active', inputReady: true, goalWork: { version: 1, pending: true } });
    return answer;
  };
  f.queue.notifyRuntime('T'); await tick();
  assert.equal(f.writes.length, 0); assert.equal(f.record().attemptId, null);
  assert.match(f.logs.at(-1), /goal-work-pending/);
  f.context.readAutomaticSendFrame = read;
  f.runtime({ status: 'active', inputReady: true }); f.queue.notifyRuntime('T'); await tick();
  assert.equal(f.writes.length, 1);
});

test('real Store no-condition key allows first Resume Send; its canonical receipt releases the manual follower while busy', async t => {
  const f = fixture(t); assert.equal(f.request.promptQueueIntent.conditionKey, '-');
  f.request.promptQueueIntent.contextProof = { provider: 'codex', sessionId: 'saved-source', pct: 60 };
  f.mirror.redrawTrace.synchronizedOutputOpen = false;
  f.add(); f.addManual(); await tick();
  assert.deepEqual(f.writes.map(x => x.handoffId), ['H']);
  f.runtime({ status: 'busy', inputReady: true, busy: true, sessionId: 'actual-writer' });
  const r = f.record();
  assert.equal(f.store.promoteFromAudit({ success: true, operationKey: r.operationKey, attemptId: r.attemptId,
    provider: 'codex', sessionId: 'actual-writer', promptHash: r.promptHash, actualHash: r.promptHash,
    expectedHash: r.promptHash, entryUuid: 'exact-user-H', sourceIdentity: 'codex-user-source-H',
    auditTimestamp: new Date().toISOString() }).promoted, true);
  await tick(); assert.deepEqual(f.writes.map(x => x.handoffId), ['H', 'M']);
});

function provisionalContextRuntime(patch = {}) {
  const terminalToken = {};
  const readLease = createCodexResumeReadIdentityLease({ tabId: 'T', sourceSessionId: 'S', launchId: 'L',
    terminalToken, terminalRunSeq: 1, terminalLifecycleGeneration: 'G' });
  // Process/open-file/source observations are controlled ports. The actual
  // Main read-identity contract validates all of them; writer SID stays null.
  const read = resolveCodexReadIdentity({ tabId: 'T', liveLifecycle: true,
    persistedSessionId: 'S', savedSessionId: 'S', writerStatus: 'provisional-source',
    observedWriterSessionId: 'S', resumeReadLease: readLease,
    intent: { sourceMode: 'resume', sourceSessionId: 'S', launchId: 'L', sourceRunSeq: 1, sourceLifecycleGeneration: 'G' },
    resumeLease: { sourceSessionId: 'S', tabId: 'T', launchId: 'L' },
    sourceTurn: { sessionId: 'S', sourceObservationLaunchId: 'L', processGeneration: 'G' },
    terminalToken, terminalRunSeq: 1, terminalLifecycleGeneration: 'G',
    processRunning: true, processPids: [123], ...patch });
  return { status: 'active', inputReady: true, busy: false, writerStatus: 'provisional-source',
    sessionId: null, sendTarget: { sessionId: null }, readSessionId: read.sessionId,
    canCopySessionId: read.available === true, readIdentityReason: read.reason };
}

test('real context condition uses proven Main read identity before the first writer row, not a saved or injected writer SID', async t => {
  const f = fixture(t); f.mirror.redrawTrace.synchronizedOutputOpen = false;
  f.request.promptQueueIntent.conditionKey = conditionKey({ kind: 'context-used', operator: 'gte', percent: 50 });
  f.request.promptQueueIntent.contextProof = { provider: 'codex', sessionId: 'S', pct: 60 };
  f.add(); await tick(); assert.equal(f.writes.length, 0); assert.equal(f.record().attemptId, null);
  assert.match(f.logs[0], /context-owner-changed/);
  f.runtime({ status: 'active', inputReady: true, sessionId: 'S' }); f.queue.notifyRuntime('T'); await tick();
  assert.equal(f.writes.length, 0, 'a saved/matching public SID alone is not a read-owner proof');
  const runtime = provisionalContextRuntime();
  assert.equal(runtime.canCopySessionId, true); assert.equal(runtime.sessionId, null);
  f.runtime(runtime); f.queue.notifyRuntime('T'); await tick();
  assert.equal(f.writes.length, 1);
});

for (const [name, patch] of [['source changed', { persistedSessionId: 'OTHER' }],
  ['process observation missing', { processPids: [] }], ['terminal replaced', { terminalToken: {} }],
  ['submit already reserved', { provisionalSubmitReserved: true }]]) {
  test('context admission keeps the exact Main read guard: ' + name, async t => {
    const f = fixture(t); f.mirror.redrawTrace.synchronizedOutputOpen = false;
    f.request.promptQueueIntent.conditionKey = conditionKey({ kind: 'context-used', operator: 'gte', percent: 50 });
    f.request.promptQueueIntent.contextProof = { provider: 'codex', sessionId: 'S', pct: 60 };
    const runtime = provisionalContextRuntime(patch);
    assert.equal(runtime.canCopySessionId, false);
    f.runtime(runtime); f.add(); await tick();
    assert.equal(f.writes.length, 0); assert.equal(f.record().attemptId, null);
  });
}
