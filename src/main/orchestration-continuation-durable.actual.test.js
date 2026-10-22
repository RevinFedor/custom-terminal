'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { OrchestrationRunStore, classifyAgentSendReceipt } = require('./orchestration-runs');
const { createOrchestrationContinuationService } = require('./orchestration-continuation');
const { createContinuationInputReader } = require('./orchestration-continuation-input');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const registry = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { agentSendTargetPreconditionFailure } = require('../shared/agent-send-target-precondition.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = { log() {}, warn() {}, error() {} };
const web = ts.createSourceFile('web-server.js', fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8'), ts.ScriptTarget.Latest, true);
const sendCode = ['readScenarioDestination', 'durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
  'durableAgentSendFailure', 'runAgentSendScenario', 'runPreparedAgentSendScenario'].map(name => {
  const node = web.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(web);
}).join('\n');
const completionAdmissionCode = web.statements.find(item => ts.isVariableStatement(item)
  && item.declarationList.declarations.some(declaration => declaration.name.getText(web) === 'COMPLETION_ADMISSION')).getText(web);

// Real web dispatcher, FIFO, SQLite receipts and persisted run store. Only
// runtime/history facts and the renderer/provider boundary are controlled.
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-durable-'));
  const runFile = path.join(dir, 'runs.json'), receiptFile = path.join(dir, 'receipts.db');
  let runs = new OrchestrationRunStore(runFile), db, receipts, queue, context, service;
  const old = { provider: 'codex', sessionId: 'B', turnId: 'original', generation: 1, processId: '11', startedAt: 100 };
  const next = { ...old, turnId: 'continued', generation: 2, processId: '22', startedAt: Date.now() + 10000 };
  const tabs = Object.fromEntries(['A', 'B'].map(id => [id, { known: true, exists: true, toolType: 'codex',
    sessionId: id, cwd: dir, revision: id + ':1', busy: null, transitioning: false,
    processStatus: 'found', error: 'response_busy_unknown', backgroundWorkCount: 0 }]));
  const targets = Object.fromEntries(['A', 'B'].map(id => [id, { toolType: 'codex', sessionId: id,
    terminalInstanceId: 'instance:' + id, launchId: 'launch:' + id, lifecycleGeneration: 'generation:' + id }]));
  const controls = { audit: true, loseAck: false, beforeDispatch: null, beforeWrite: null, historyTurn: old };
  const calls = { bridge: 0, enter: 0, requests: [], deliveries: 0 };
  const readResponseState = async id => ({ ...tabs[id] });
  const readRuntimeSnapshot = async id => ({ coherent: true, toolType: 'codex', processStatus: 'found',
    status: 'active', inputReady: true, busy: false, lifecycleGeneration: targets[id].lifecycleGeneration,
    sendTarget: { ...targets[id] } });
  const readState = createContinuationInputReader({ readResponseState, readRuntimeSnapshot,
    readSendDestination: id => targets[id] });
  await runs.create({ runId: 'R', sourceTabId: 'A', targetTabId: 'B', sourceToolType: 'codex',
    targetToolType: 'codex', sourceSendTarget: { toolType: 'codex', sessionId: 'A' },
    targetExecutionContext: old, targetCwd: dir, promptHash: 'original-hash' });
  await runs.markDelivery('R', { sessionId: 'B', lifecycleGeneration: 'old-launch' });
  await runs.patch('R', { targetPromptProofAt: 100, targetPromptProofUserUuid: 'original-user', status: 'running' });
  await runs.beginRecovery('R', 'interrupted', 'turn_aborted');
  await runs.persistStrict();
  const intent = async () => (await runs.getInternal('R')).continuationIntent;
  const audit = (record, overrides = {}) => receipts.promoteFromAudit({ success: true,
    operationKey: record.operationKey, attemptId: record.attemptId, provider: 'codex', sessionId: 'B',
    actualHash: record.promptHash, expectedHash: record.promptHash, promptHash: record.promptHash,
    entryUuid: 'new-user', sourceIdentity: 'codex-user-source-B-200',
    auditTimestamp: new Date(next.startedAt).toISOString(), transcriptBoundary: { byteOffset: 200 },
    executionContext: next, queuedAtSubmit: false, ...overrides });

  function open() {
    db = new Database(receiptFile);
    receipts = createAgentSendReceiptStore(db);
    context = vm.createContext({ require, path, srcMainDir: __dirname, console: quiet,
      ...registry, AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES,
      ...require('./agent-send-preparation'),
      agentSendReceiptRegistry: registry.createAgentSendReceiptRegistry(), agentSendReceiptStore: receipts,
      agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000,
      promptAuditFingerprint, classifyAgentSendReceipt, crypto: require('node:crypto'), shortId: value => value,
      compactSendReceiptPresentation: require('./compact-send-settlement').compactSendReceiptPresentation,
      bindStructuredAuthoringPresentation: require('./structured-authoring').bindStructuredAuthoringPresentation,
      withPromptOriginPresentation: value => value, tabWorkContext: { activate() {}, settle() {} },
      findOrchestrationTabDescriptor: id => ({ ...targets[id], tabType: 'terminal' }),
      readAgentRuntimeSnapshot: readRuntimeSnapshot,
      scenarioDestination: require('./agent-message-identity').scenarioDestination,
      isLocalSlashCommandPrompt: require('./agent-history-send-receipt').isLocalSlashCommandPrompt,
      agentSendTargetPreconditionFailure,
      bridgeRequest: async (action, request) => {
        assert.equal(action, 'sendAgentPromptScenario');
        calls.bridge++;
        calls.requests.push(request);
        await controls.beforeWrite?.(request);
        const mismatch = agentSendTargetPreconditionFailure(request.expectedTarget, targets.B);
        if (mismatch) return mismatch;
        if (receipts.isDeliveryCancelled(request.sendOperationKey, request.sendAttemptId)) {
          return { success: false, submitted: false, pasteWritten: false, enterWritten: false, code: 'agent_send_cancelled' };
        }
        assert.equal(receipts.markAttemptState(request.sendOperationKey, request.sendAttemptId, 'enter-armed').ok, true);
        calls.enter++;
        const record = receipts.get(request.sendOperationKey);
        if (controls.audit) assert.equal(audit(record).promoted, true);
        if (controls.loseAck) throw Object.assign(new Error('controlled bridge ACK lost'), { dispatched: true });
        return { success: null, submitted: true, accepted: true, auditPending: true, status: 'audit-pending' };
      },
    });
    // Current sender also fences external-completion input. This fixture sends
    // an ordinary continuation and carries that real private symbol declaration.
    vm.runInContext(completionAdmissionCode + '\n' + sendCode, context);
    queue = new AgentSendQueue({ store: receipts, admit: async request => {
      await controls.beforeDispatch?.(request);
      return true;
    }, execute: request => context.runPreparedAgentSendScenario({ ...request, applicationQueueExecution: true,
      prepareSend: () => service.prepareRequest('R', request.handoffId.replace('orchestration-continue:', '')) }) });
    context.agentSendQueue = queue;
    service = createOrchestrationContinuationService({ store: runs, receipts, readState,
      readOriginal: async () => ({ found: true, sourceVerified: true, complete: false,
        userUuid: 'original-user', executionContext: old }),
      readLatest: async () => ({ subject: { targetExecutionContext: controls.historyTurn },
        result: { sourceVerified: true, executionContext: controls.historyTurn } }),
      send: request => context.runAgentSendScenario(request), reconcile: async () => {},
      deliver: async () => { calls.deliveries++; }, log: quiet });
  }
  open();
  t.after(async () => { queue.dispose(); await tick(); await runs.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { calls, controls, tabs, targets, intent, audit, old, next,
    get service() { return service; }, get receipts() { return receipts; }, get queue() { return queue; },
    get runs() { return runs; }, record: async () => receipts.get((await intent()).operationKey),
    reopen: async () => {
      queue.dispose(); await tick(); await runs.flush(); db.close();
      runs = new OrchestrationRunStore(runFile); await runs.initialize(); open();
      receipts.reconcileStartup(); queue.resume(); await tick();
    } };
}

test('restored input-ready continuation crosses actual web/FIFO/SQLite once and binds the exact audit', async t => {
  const h = await fixture(t);
  const [a, b] = await Promise.all([h.service.continueRequest('R'), h.service.continueRequest('R')]);
  assert.equal(a.resumed, true, JSON.stringify(a)); assert.equal(b.resumed, true);
  assert.equal(h.calls.enter, 1); assert.equal(h.calls.bridge, 1);
  const record = await h.record(), run = await h.runs.getInternal('R');
  assert.equal(record.state, 'confirmed'); assert.equal(record.receipt.exactAuditConfirmed, true);
  assert.equal(record.receipt.auditExecutionContext.turnId, h.next.turnId);
  assert.equal(run.targetExecutionContext.turnId, h.next.turnId);
  assert.equal(run.continuationIntent.state, 'bound'); assert.equal(run.resultComplete, false);
  assert.equal(h.queue.item(record.operationKey).state, 'completed');
  assert.equal(h.calls.requests[0].prompt, 'continue');
  assert.equal(h.calls.requests[0].expectedTarget.launchId, 'launch:B');
  await h.reopen(); await h.service.continueRequest('R'); assert.equal(h.calls.enter, 1);
});

test('lost ACK and reopened SQLite retain one attempt; only its late exact audit binds the new turn', async t => {
  const h = await fixture(t); h.controls.audit = false; h.controls.loseAck = true;
  assert.equal((await h.service.continueRequest('R')).pending, true);
  const before = await h.record();
  assert.notEqual(before.state, 'confirmed');
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_delivery_unknown');
  await h.reopen();
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_delivery_unknown');
  assert.equal((await h.record()).attemptId, before.attemptId); assert.equal(h.calls.enter, 1);
  assert.equal(h.audit(await h.record(), { attemptId: 'foreign-attempt' }).promoted, false);
  assert.equal((await h.service.reconcile('R')).confirmed, false);
  assert.equal(h.audit(await h.record()).promoted, true);
  assert.equal((await h.service.reconcile('R')).confirmed, true);
  assert.equal((await h.runs.getInternal('R')).targetExecutionContext.turnId, h.next.turnId);
  assert.equal(h.calls.enter, 1);
});

for (const change of ['source-history', 'latest-turn', 'writer-ABA', 'cancel']) {
  test('durable queue preparation rechecks ' + change + ' before any physical input', async t => {
    const h = await fixture(t);
    h.controls.beforeDispatch = async request => {
      if (change === 'source-history') h.tabs.A.sessionId = 'different-source';
      if (change === 'latest-turn') h.controls.historyTurn = { ...h.old, turnId: 'independent-turn' };
      if (change === 'writer-ABA') h.targets.B.launchId = 'another-launch';
      if (change === 'cancel') {
        const record = h.receipts.get(request.sendOperationKey);
        assert.equal(h.receipts.cancelDelivery({ operationKey: record.operationKey, tabId: record.tabId,
          handoffId: record.handoffId, attemptId: record.attemptId }).ok, true);
      }
    };
    const result = await h.service.continueRequest('R');
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(h.calls.enter, 0); assert.equal(h.calls.bridge, 0);
    const record = await h.record();
    assert.equal(record.state, 'not-submitted'); assert.equal(record.receipt.submitted, false);
    assert.equal((await h.runs.getInternal('R')).targetExecutionContext.turnId, h.old.turnId);
  });
}

test('physical owner replacement after preparation remains fenced by the persisted expectation', async t => {
  const h = await fixture(t);
  h.controls.beforeWrite = async () => { h.targets.B.launchId = 'replaced-after-prepare'; };
  const result = await h.service.continueRequest('R');
  assert.equal(result.ok, false); assert.equal(h.calls.bridge, 1); assert.equal(h.calls.enter, 0);
  assert.equal((await h.record()).receipt.code, 'agent_send_target_changed');
});

test('cancelling an unknown attempt preserves late historical receipt without resuming its run', async t => {
  const h = await fixture(t); h.controls.audit = false;
  await h.service.continueRequest('R');
  const record = await h.record();
  assert.equal(h.receipts.cancelDelivery({ operationKey: record.operationKey, tabId: record.tabId,
    handoffId: record.handoffId, attemptId: record.attemptId }).ok, true);
  assert.equal(h.audit(record).promoted, true);
  assert.equal((await h.service.reconcile('R')).confirmed, false);
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_cancelled');
  assert.equal((await h.runs.getInternal('R')).targetExecutionContext.turnId, h.old.turnId);
  assert.equal(h.calls.enter, 1);
});
