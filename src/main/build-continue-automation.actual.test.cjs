'use strict';
// Actual web admission + FIFO/SQLite + renderer pending-receipt reconciler.
// Store UI access, native writer/readiness and OS restart are controlled.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { createBuildContinueOperations } = require('./build-continue-operation');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const automation = require('../shared/build-continue-automation.cjs');
function actual(file, names) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const code = names.map(name => { const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert(fn, name); return fn.getText(tree).replace(/^export\s+/, ''); }).join('\n');
  return ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
}
async function fixture(t) {
  const db = new NodeSqlite(), receipts = createAgentSendReceiptStore(db);
  const context = { provider: 'codex', sessionId: 'S', turnId: 'captured-own', generation: 1 };
  let saved = null, operation, ready = false, queue;
  const inputs = [];
  const env = vm.createContext({ require, path, srcMainDir: __dirname,
    fingerprintAgentSendRequest,
    agentSendReceiptStore: receipts, getBuildContinueOperations: () => operation,
    isPromptLoopAutomationSource: require('./prompt-queue-source').isPromptLoopAutomationSource,
    buildInstallAutomationBlocked: () => false, historyMutationInput: null,
    loopSendAdmission: () => false, });
  vm.runInContext(actual('web-server.js', ['admitQueuedAgentSend', 'runAgentSendScenario', 'readBuildContinueDeferredReceipt', 'durableAgentSendReplay']), env);
  const enqueue = request => {
    const plain = JSON.parse(JSON.stringify(request)), identity = { operationKey: request.sendOperationKey,
      tabId: request.tabId, provider: request.provider, sessionId: 'S', handoffId: request.handoffId,
      surface: 'desktop-history', requestFingerprint: fingerprintAgentSendRequest(plain),
      promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
    return queue.enqueue({ identity, request: plain });
  };
  queue = new AgentSendQueue({ store: receipts, ready: () => ready, admit: request => env.admitQueuedAgentSend(request),
    projectPresentation: record => env.readBuildContinueDeferredReceipt(record),
    execute: async request => { inputs.push(request.source); return { success: false, submitted: false,
      pasteWritten: false, enterWritten: false, status: 'not-submitted', code: 'controlled-native-port' }; } });
  env.agentSendQueue = queue;
  const oldRequest = { tabId: 'T', provider: 'codex', prompt: 'check remaining work', source: 'prompt-loop',
    handoffId: 'old-loop-cause', sendOperationKey: 'history:T:old-loop-cause', expectedTarget: { toolType: 'codex', sessionId: 'S' } };
  assert(enqueue(oldRequest).ok);
  const capturedAt = Date.now();
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'instance-' + pid, now: () => capturedAt,
    read: () => saved, write: value => { saved = JSON.parse(JSON.stringify(value)); }, readRuns: async () => [],
    captureTabs: () => [{ tabId: 'T', known: true, toolType: 'codex', sessionId: 'S', busy: true, executionContext: context,
      subject: { kind: 'codex-execution', toolType: 'codex', sessionId: 'S', targetExecutionContext: context } }],
    readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: capturedAt + 1, shutdownPid: 11,
      targets: [{ tabId: 'T', provider: 'codex', sessionId: 'S' }] }),
    readState: async () => ({ known: true, exists: true, toolType: 'codex', sessionId: 'S', busy: false,
      processStatus: 'found', transitioning: false, revision: 'ready', backgroundWorkCount: 0 }),
    readOriginal: async () => ({ found: true, sourceVerified: true, complete: false, executionContext: context }),
    readLatest: async () => ({ result: { sourceVerified: true }, subject: { targetExecutionContext: context } }),
    readQueued: key => queue.item(key), readReceipt: key => receipts.get(key),
    send: async request => { await request.prepareSend(); const result = enqueue(request); assert(result.ok); return result.receipt; } });
  operation = make(11); await operation.capture('automation-restart-one', 11); operation.dispose(); operation = make(22);
  t.after(() => { operation.dispose(); queue.dispose(); db.close(); });
  return { db, receipts, queue, inputs, env, oldRequest, get operation() { return operation; },
    async activate() { operation.activate('automation-restart-one'); await operation.reconcile('automation-restart-one'); },
    async dispatch() { ready = true; queue.resume(); await queue.result('history:T:old-loop-cause');
      const target = operation.get('automation-restart-one').targets[0]; await queue.result(target.operationKey); },
  };
}

test('new automatic Loop is deferred before reservation; its ON/card ownership is retained', async t => {
  const h = await fixture(t); await h.activate();
  const result = await h.env.runAgentSendScenario({ ...h.oldRequest, handoffId: 'new-loop', sendOperationKey: 'history:T:new-loop' });
  assert.equal(result.deferred, true); assert.equal(result.success, false); assert.equal(result.submitted, false);
  assert.equal(h.receipts.get('history:T:new-loop'), null); assert.equal(h.queue.item('history:T:new-loop'), null);
});

test('old never-attempted Loop retires causally, frees FIFO, and actual passive renderer restore keeps ON/autoRun/card', async t => {
  const h = await fixture(t); await h.activate(); await h.dispatch();
  assert.deepEqual(h.inputs.map(source => source.split(':')[0]), ['build-install-continue']);
  const record = h.queue.projectRecord(h.receipts.get('history:T:old-loop-cause'));
  assert.equal(record.attemptId, null); assert.equal(record.receipt.deferred, true);
  const liveCaller = h.env.durableAgentSendReplay(h.receipts.get(record.operationKey));
  assert.equal(liveCaller.deferred, true); assert.equal(liveCaller.submitted, false, 'live caller uses the existing deferred/ON-preserving branch');
  assert.equal(h.queue.item(record.operationKey).state, 'cancelled');
  let writes = 0;
  const q = { loopPromptEnabled: true, autoRun: true, items: [{ id: 'same-card' }], pendingDelivery: {
    kind: 'loop', handoffId: record.handoffId, operationKey: record.operationKey, causeKey: 'old-cause' } };
  const store = { getQueue: () => q, setPendingDelivery(_tab, value) { q.pendingDelivery = value; },
    setLoopPromptEnabled() { writes++; }, setAutoRun() { writes++; } };
  const runner = vm.createContext({ queueReceiptReads: new Set(), queueSendInflight: new Set(), console,
    usePromptQueueStore: { getState: () => store }, ipcRenderer: { invoke: async () => ({ success: true, records: [record] }) },
    buildContinueDeferredReceipt: automation.buildContinueDeferredReceipt,
    latestLoopCauseByOwner: new Map([['T', 'old-cause']]), settleHistoryPromptHandoff() {},
    historyPromptHandoffAuditProofFromSendResult: () => null, persistPromptQueueDeliveryPointer: async () => {}, signalContinuationRelease() {} });
  vm.runInContext(actual('../renderer/store/usePromptQueueStore.ts', ['queueSendOutcome'])
    + '\n' + actual('../renderer/hooks/usePromptQueueRunner.ts', ['reconcilePromptQueuePendingDelivery']), runner);
  assert.equal(await runner.reconcilePromptQueuePendingDelivery('T'), true);
  assert.equal(q.pendingDelivery, null); assert.equal(q.loopPromptEnabled, true); assert.equal(q.autoRun, true);
  assert.equal(q.items[0].id, 'same-card'); assert.equal(writes, 0);
});

for (const state of ['in-flight', 'enter-armed', 'delivery-unknown', 'confirmed']) test('retirement cannot negate ' + state, async t => {
  const h = await fixture(t); await h.activate(); const identity = h.receipts.get(h.oldRequest.sendOperationKey);
  const attempt = h.receipts.beginAttempt(identity);
  if (state === 'enter-armed') h.receipts.markAttemptState(identity.operationKey, attempt.attemptId, state);
  const record = h.receipts.get(identity.operationKey);
  assert.equal(h.operation.staleLoopAdmission(h.oldRequest), null);
  assert.equal(automation.buildContinueDeferredReceipt({ ...record, state,
    deliveryControl: { cancelledAt: 1, reason: automation.PREFIX + 'automation-restart-one' },
    receipt: { source: 'prompt-loop' } }), null);
  assert.equal(h.queue.item(identity.operationKey).state, 'waiting');
});

test('missing attempt does not negate an explicitly unknown stored input', () => {
  assert.equal(automation.buildContinueDeferredReceipt({ state: 'reserved', attemptId: null,
    deliveryControl: { cancelledAt: 1, reason: automation.PREFIX + 'automation-restart-one' },
    receipt: { source: 'prompt-loop', deliveryUnknown: true } }), null);
});
