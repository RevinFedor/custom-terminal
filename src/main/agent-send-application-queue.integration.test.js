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
const registry = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { compactSendReceiptPresentation } = require('./compact-send-settlement');
const { imagePresentationFromReceipt } = require('./history-authoring-projection');
const { isLocalSlashCommandPrompt } = require('./agent-history-send-receipt');
const { runtimeSnapshotCompletionFixture } = require('./test-helpers/runtime-snapshot-completion');
const web = fs.readFileSync(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'web-server.js'), 'utf8');
const ast = ts.createSourceFile('web-server.js', web, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
};
function exported(name) {
  let result;
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(result, name); return result;
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t, provider, options = {}) {
  const db = new Database(options.database || ':memory:');
  const store = createAgentSendReceiptStore(db);
  const writes = [], contexts = [];
  let targetSession = 'S';
  const context = vm.createContext({
    require, path, srcMainDir: __dirname,
    ...require('./agent-send-preparation'),
    ...registry, agentSendReceiptStore: store, agentSendReceiptRegistry: registry.createAgentSendReceiptRegistry(),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000,
    AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES,
    promptAuditFingerprint, isLocalSlashCommandPrompt, compactSendReceiptPresentation,
    crypto: require('node:crypto'), Buffer, console: { log() {}, warn() {}, error() {} },
    shortId: x => x, STRUCTURED_AUTHORING_LIMITS: { bytes: 8 * 1024 * 1024 },
    withPromptOriginPresentation: x => x,
    bindStructuredAuthoringPresentation: require('./structured-authoring').bindStructuredAuthoringPresentation,
    agentSendTargetPreconditionFailure: require('./agent-send-target-precondition').agentSendTargetPreconditionFailure,
    readAgentRuntimeSnapshot: null,
    findOrchestrationTabDescriptor: () => ({ projectId: 'P', toolType: provider, sessionId: targetSession }),
    scenarioDestination: require('./agent-message-identity').scenarioDestination,
    tabWorkContext: {
      prepare: async (_tab, handoff, prompt) => { contexts.push(['prepare', handoff]); return { prompt }; },
      activate: (_tab, handoff) => contexts.push(['activate', handoff]),
      settle: (_tab, handoff, result) => contexts.push(['settle', handoff, result?.submitted]),
    },
    bridgeRequest: async (action, payload) => {
      assert.equal(action, 'sendAgentPromptScenario');
      writes.push(payload);
      const { sendOperationKey: key, sendAttemptId: attempt } = payload;
      assert.ok(attempt); assert.equal(store.get(key).state, 'in-flight');
      store.markAttemptState(key, attempt, 'enter-armed');
      store.settleAttempt(key, attempt, { success: true, submitted: true, status: 'audit-pending', auditPending: true });
      store.markProviderQueueAccepted(key, attempt, { provider, sessionId: 'S',
        sourceIdentity: provider === 'codex' ? 'codex-tui-queue:' + payload.handoffId : 'claude-queue:' + payload.handoffId });
      return { success: true, accepted: true, submitted: true, status: 'queued',
        queued: true, providerQueueAccepted: true, auditPending: true };
    },
  });
  vm.runInContext(['durableRecordHasProviderQueueAcceptance','durableAgentSendReplay','publicAgentSendReceipt',
    'durableAgentSendFailure','runPreparedAgentSendScenario','runAgentSendScenario','readScenarioDestination'].map(declaration).join('\n'), context);
  vm.runInContext('var enqueueDesktopAgentPrompt = ' + exported('enqueueDesktopAgentPrompt'), context);
  vm.runInContext('var mergeQueuedAgentMessages = ' + exported('mergeQueuedAgentMessages'), context);
  const queue = new AgentSendQueue({ store, execute: request => context.runPreparedAgentSendScenario({
    ...request, applicationQueueExecution: true,
  }) });
  context.agentSendQueue = queue;
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('agent:enqueue-prompt'");
  const end = main.indexOf("ipcMain.handle('agent:send-queue-ready'", start);
  const handlers = new Map();
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    require: () => ({ enqueueDesktopAgentPrompt: context.enqueueDesktopAgentPrompt,
      mergeQueuedAgentMessages: context.mergeQueuedAgentMessages }), path, srcMainDir: __dirname,
  });
  const send = (id, extra = {}) => handlers.get('agent:enqueue-prompt')(null, {
    tabId: 'T', toolType: provider, sessionId: 'S', prompt: 'test ' + id, handoffId: id,
    source: 'history-panel', settingsIntent: { kind: 'none' }, ...extra,
  });
  const confirm = id => {
    const r = store.get('history:T:' + id);
    return store.promoteFromAudit({ success: true, operationKey: r.operationKey, attemptId: r.attemptId,
      provider, sessionId: 'S', promptHash: r.promptHash, expectedHash: r.promptHash, actualHash: r.promptHash,
      entryUuid: 'user-' + id, sourceIdentity: provider + '-user-source-' + id, auditTimestamp: new Date().toISOString() });
  };
  t.after(async () => { queue.dispose(); await tick(); db.close(); });
  return { context, queue, store, writes, contexts, send, confirm, physicalBridge: context.bridgeRequest,
    merge: request => handlers.get('agent:merge-queued-send')(null, request),
    setTarget: value => { targetSession = value; } };
}

for (const process of ['found', 'unknown']) test('snapshot completion: exact FIFO follower survives predecessor writer adoption during ' + process + ' lookup', async t => {
  const h = harness(t, 'codex');
  await h.send('head');
  await h.send('follower');
  await tick();
  assert.equal(h.writes.length, 1);
  const key = 'history:T:follower';
  const original = h.queue.item(key);
  const runtime = runtimeSnapshotCompletionFixture();
  runtime.state.onLookup = ordinal => {
    if (ordinal === 1) { runtime.adopt(); runtime.state.process = process; }
    else runtime.cleanupLaunch();
  };
  h.context.readAgentRuntimeSnapshot = runtime.snapshot;
  h.confirm('head');
  await h.queue.result(key);
  const record = h.store.get(key);
  assert.ok(record.attemptId, JSON.stringify(record.receipt));
  assert.notEqual(record.state, 'not-submitted');
  assert.deepEqual(h.writes.map(write => write.handoffId), ['head', 'follower']);
  assert.equal(h.queue.item(key).id, original.id);
  assert.equal(h.queue.item(key).request_json, original.request_json);
  assert.equal(runtime.state.lookups, 1);
});

for (const mode of ['native-v2-order', 'stop-during-reconcile', 'unconfirmed']) {
  test('snapshot reconcile refresh: actual FIFO keeps the original follower and guards ' + mode, async t => {
    const h = harness(t, 'codex');
    await h.send('head'); await h.send('follower'); await tick();
    const key = 'history:T:follower', original = h.queue.item(key);
    assert.equal(h.store.get(key).attemptId, null);
    const runtime = runtimeSnapshotCompletionFixture(); runtime.state.busy = true;
    runtime.context.getCodexRuntimeSessionSnapshot = async () => {
      if (mode !== 'unconfirmed') runtime.adopt();
      if (mode === 'stop-during-reconcile') runtime.state.stop++;
      return { sessionStatus: 'busy', liveLifecycle: true, inputReady: true,
        sessionId: null, savedSessionId: 'S', writerConfirmed: false };
    };
    runtime.state.onLookup = ordinal => {
      if (mode === 'native-v2-order' && ordinal === 2) runtime.cleanupLaunch();
      if (mode === 'stop-during-reconcile') runtime.state.writer = null;
    };
    h.context.readAgentRuntimeSnapshot = runtime.snapshot;
    if (mode === 'unconfirmed') h.context.bridgeRequest = async (_action, payload) => {
      // Queue admission may retain a provisional target. The unchanged
      // physical boundary still checks the original SID, not the relaxed hint.
      const failure = require('./agent-send-target-precondition').agentSendTargetPreconditionFailure(
        payload.expectedTarget, runtime.context.readAgentSendDestinationAtWriteBoundary('T', 'codex'));
      assert.equal(failure?.code, 'agent_send_target_changed');
      return failure;
    };
    h.confirm('head'); await h.queue.result(key);
    const record = h.store.get(key);
    assert.equal(h.queue.item(key).id, original.id);
    assert.equal(h.queue.item(key).request_json, original.request_json);
    if (mode === 'native-v2-order') {
      assert.ok(record.attemptId, JSON.stringify(record.receipt));
      assert.deepEqual(h.writes.map(write => write.handoffId), ['head', 'follower']);
      assert.equal(runtime.state.lookups, 1);
      assert.equal(h.confirm('follower').promoted, true);
      assert.equal(h.store.get(key).state, 'confirmed');
    } else {
      assert.equal(record.state, 'not-submitted');
      if (mode === 'unconfirmed') assert.ok(record.attemptId, 'original expectation is rechecked at the physical boundary');
      else assert.equal(record.attemptId, null);
      assert.deepEqual(h.writes.map(write => write.handoffId), ['head']);
    }
  });
}

test('snapshot completion: fresh foreign binding refuses the original FIFO follower before beginAttempt', async t => {
  const h = harness(t, 'codex');
  await h.send('head'); await h.send('follower'); await tick();
  const runtime = runtimeSnapshotCompletionFixture();
  runtime.state.onLookup = ordinal => {
    if (ordinal === 1) { runtime.state.sessionId = 'FOREIGN'; runtime.state.owner++; runtime.adopt(); }
  };
  h.context.readAgentRuntimeSnapshot = runtime.snapshot;
  h.confirm('head');
  await h.queue.result('history:T:follower');
  const record = h.store.get('history:T:follower');
  assert.equal(record.state, 'not-submitted');
  assert.equal(record.attemptId, null);
  assert.deepEqual(h.writes.map(write => write.handoffId), ['head']);
});

function completionHarness(t, { legacy = false } = {}) {
  const h = harness(t, 'codex');
  const run = { runId: 'completion-test', sourceTabId: 'T', targetTabId: 'other', status: 'completed',
    resultComplete: true, sourceSendTarget: { toolType: 'codex', sessionId: 'S' }, sourceToolType: 'codex' };
  const notificationStates = [];
  const content = { prompt: 'Frozen result body', metadata: { sourceSessionId: 'S' } };
  Object.assign(h.context, {
    orchestrationNotificationInflight: new Set(), isTerminalStatus: () => true,
    getOrchestrationRunStore: () => ({ getInternal: async () => run,
      markNotification: async (_id, status, extra = {}) => { Object.assign(run, extra, { notificationStatus: status }); notificationStates.push(status); return { changed: [run] }; },
      persistStrict: async () => {},
      bindNotificationSourceSession: async () => {} }),
    orchestrationNotificationText: () => content.prompt, prepareOrchestrationCompletionContent: async () => content,
    resolveAgentSessionInfo: async () => ({ sessionId: 'S', toolType: 'codex' }),
    resolveOrchestrationSourceNotificationSendOptions: () => ({ statusAtSend: 'active', queue: false }),
    releaseOrchestrationSourceProof: async () => {}, armOrchestrationSourceProof: async () => ({ success: true }),
    emitOrchestrationChanges() {}, finalizeSettledOrchestration: async () => {},
    orchestrationPresentationSnapshot: () => ({ semanticTags: [{ kind: 'orchestration', runId: run.runId }] }),
    promptFingerprint: promptAuditFingerprint, classifyAgentSendReceipt,
  });
  const prefix = '<saved_prompt name="Delta" context-update-id="exact">frozen context</saved_prompt>\n\n';
  h.context.tabWorkContext.prepare = async (_tab, _id, prompt) => ({ prompt: prefix + prompt });
  h.context.tabWorkContext.hasHandoff = () => false;
  const completion = declaration('sendOrchestrationCompletionNotification');
  vm.runInContext(legacy ? completion.replace(/^\s*sendOperationKey: `history:\$\{current.sourceTabId\}:\$\{notificationHandoffId\}`,\n/m, '')
    .replace(/^\s*sendSurface: 'desktop-history',\n/m, '') : completion, h.context);
  const rendererSource = fs.readFileSync(path.join(__dirname, '../renderer/utils/agentScenarios.ts'), 'utf8');
  const rendererAst = ts.createSourceFile('agentScenarios.ts', rendererSource, ts.ScriptTarget.Latest, true);
  const rendererFunction = rendererAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendAgentPromptScenario');
  const rendererCode = ts.transpileModule(rendererFunction.getText(rendererAst).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let reAdmissions = 0;
  const renderer = vm.createContext({
    isStandaloneAgentLocalCommand: () => false, agentSendSettingsContractError: () => null,
    ipcRenderer: { invoke: async (_channel, request) => { reAdmissions += 1; return h.context.enqueueDesktopAgentPrompt(request); } },
    enqueueAgentSendScenario: ({ run: execute }) => execute(),
    activateTabWorkContext: async () => {}, settleTabWorkContext: async () => {},
    runAgentPromptScenario: async request => h.physicalBridge('sendAgentPromptScenario', request),
  });
  vm.runInContext(rendererCode, renderer);
  h.context.bridgeRequest = async (action, payload) => {
    assert.equal(action, 'sendAgentPromptScenario');
    return renderer.sendAgentPromptScenario({ ...payload, toolType: 'codex', sessionId: 'S', cwd: '/fixture',
      settingsIntent: { kind: 'none' }, expectedTarget: { toolType: 'codex', sessionId: 'S' } });
  };
  return { ...h, run, content, prefix, reAdmissions: () => reAdmissions };
}

async function tabMessageQueueHarness(t, options = {}) {
  const h = harness(t, 'codex', options);
  const { TabMessageService, formatTabMessagePrompt } = require('./tab-messages');
  let status = 'inactive';
  const parties = new Map(['A', 'T'].map(tabId => [tabId, { tabId, tabName: tabId,
    projectId: 'P', provider: 'codex', sessionId: tabId === 'T' ? 'S' : 'source',
    cwd: '/fixture' }]));
  const service = new TabMessageService({ db: h.store.db, resolveTab: async id => parties.get(id),
    send: message => h.context.sendTabMessage(message),
    getReceipt: key => h.queue.projectRecord(h.store.get(key)), receiptRequiredBeforeSend: true });
  Object.assign(h.context, { getTabMessageService: () => service, formatTabMessagePrompt,
    resolveAgentSessionInfo: async () => ({ status }) });
  vm.runInContext(declaration('sendTabMessage'), h.context);
  h.queue.publish = record => service.observeReceipt(record.operationKey, record, 'send-queue-control');
  await service.initialize();
  t.after(() => service.dispose());
  const drained = async () => { while (service.lanes.size) await Promise.all([...service.lanes.values()]); };
  return { ...h, service, parties, drained, setStatus: value => { status = value; },
    question: () => service.sendMessage({ source: 'A', target: 'T', text: 'same frozen question', requestId: 'one-question' }),
  };
}

test('HH367: accepted tab message stays waiting in actual application FIFO without a false failed/retry state', async t => {
  const h = await tabMessageQueueHarness(t);
  h.queue.ready = () => false;
  const q = (await h.question()).message;
  await tick(); await tick();
  const current = h.service.getMessage(q.messageId).message;
  assert.equal(current.deliveryState, 'pending');
  assert.equal(current.code, null);
  assert.equal(h.writes.length, 0);
  const row = h.store.db.prepare('SELECT retryAllowed,attemptCount FROM tab_messages WHERE messageId=?').get(q.messageId);
  assert.equal(row.retryAllowed, 0);
  assert.equal(row.attemptCount, 1);
  h.queue.ready = () => true; h.queue.wake('T'); await h.drained();
  assert.equal(h.writes.length, 1);
  assert.equal(h.service.getMessage(q.messageId).message.deliveryState, 'queued');
});

test('HH367: known no-input message recovery reuses frozen request across inactive to busy, with one actual Enter', async t => {
  const h = await tabMessageQueueHarness(t);
  let attempts = 0;
  h.context.bridgeRequest = async (action, payload) => {
    if (++attempts === 1) return { success: false, submitted: false, pasteWritten: false,
      enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' };
    return h.physicalBridge(action, payload);
  };
  const q = (await h.question()).message; await h.drained();
  const first = h.store.get(q.operationKey);
  const original = h.queue.item(q.operationKey);
  assert.equal(first.state, 'not-submitted');
  assert.equal(h.writes.length, 0);
  h.setStatus('busy');
  await h.service.wake('T', 'input-ready'); await h.drained();
  const recovered = h.service.getMessage(q.messageId).message;
  assert.equal(recovered.deliveryState, 'queued', recovered.code);
  assert.equal(attempts, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(h.queue.item(q.operationKey).id, original.id);
  assert.equal(h.queue.item(q.operationKey).request_json, original.request_json);
  assert.notEqual(h.store.get(q.operationKey).attemptId, first.attemptId);
  for (let i = 0; i < 3; i++) await h.service.wake('T', 'runtime');
  assert.equal(h.writes.length, 1, 'native queued input is never repeated');
});

test('no-input recovery joins behind an existing FIFO owner and keeps its original question bytes', async t => {
  const h = await tabMessageQueueHarness(t);
  let refuse = true;
  h.context.bridgeRequest = async (action, payload) => {
    if (payload.sendOperationKey.startsWith('tab-message:') && refuse) {
      refuse = false;
      return { success: false, submitted: false, pasteWritten: false, enterWritten: false,
        code: 'agent_send_target_unresolved', status: 'not-submitted' };
    }
    return h.physicalBridge(action, payload);
  };
  const q = (await h.question()).message; await h.drained();
  const original = h.queue.item(q.operationKey);
  assert.equal(h.store.get(q.operationKey).state, 'not-submitted');
  await h.send('other');
  await h.queue.result('history:T:other');
  assert.equal(h.writes.length, 1);
  h.setStatus('busy');
  const recovery = h.service.wake('T', 'input-ready');
  await tick(); await tick();
  assert.equal(h.queue.item(q.operationKey).state, 'waiting');
  assert.ok(h.queue.item(q.operationKey).queue_position > h.queue.item('history:T:other').id);
  assert.equal(h.writes.length, 1);
  h.confirm('other'); await recovery; await h.drained();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].handoffId, q.handoffId);
  assert.equal(h.queue.item(q.operationKey).request_json, original.request_json);
});

test('ordinary same-ID replay of failed input does not rearm without the message owner recovery request', async t => {
  const h = await tabMessageQueueHarness(t);
  h.context.bridgeRequest = async () => ({ success: false, submitted: false, pasteWritten: false,
    enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' });
  const q = (await h.question()).message; await h.drained();
  const original = h.store.get(q.operationKey);
  const frozen = JSON.parse(h.queue.item(q.operationKey).request_json);
  const replay = await h.context.runAgentSendScenario(frozen);
  assert.equal(replay.submitted, false);
  assert.equal(h.queue.item(q.operationKey).state, 'failed');
  assert.equal(h.store.get(q.operationKey).attemptId, original.attemptId);
  const changed = await h.context.runAgentSendScenario({ ...frozen, prompt: frozen.prompt + ' changed',
    retryNoInputAttemptId: original.attemptId });
  assert.equal(changed.code, 'agent_send_handoff_conflict');
  assert.equal(h.queue.item(q.operationKey).state, 'failed');
});

test('stale retry attempt cannot rearm a newer no-input outcome', async t => {
  const h = await tabMessageQueueHarness(t);
  const failure = { success: false, submitted: false, pasteWritten: false,
    enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' };
  h.context.bridgeRequest = async () => failure;
  const q = (await h.question()).message; await h.drained();
  const original = h.store.get(q.operationKey);
  const replacement = h.store.beginAttempt(original);
  h.store.settleAttempt(q.operationKey, replacement.attemptId, failure);
  const frozen = JSON.parse(h.queue.item(q.operationKey).request_json);
  await h.context.runAgentSendScenario({ ...frozen, retryNoInputAttemptId: original.attemptId });
  assert.equal(h.queue.item(q.operationKey).state, 'failed');
  assert.equal(h.store.get(q.operationKey).attemptId, replacement.attemptId);
  assert.equal(h.writes.length, 0);
});

test('a pre-Enter failure that already pasted input is not an automatic message retry grant', async t => {
  const h = await tabMessageQueueHarness(t);
  let calls = 0;
  h.context.bridgeRequest = async () => { calls++; return { success: false, submitted: false,
    pasteWritten: true, enterWritten: false, code: 'input_draft_conflict', status: 'not-submitted' }; };
  const q = (await h.question()).message; await h.drained();
  const original = h.store.get(q.operationKey);
  await h.service.wake('T', 'runtime');
  assert.equal(calls, 1);
  assert.equal(h.store.get(q.operationKey).attemptId, original.attemptId);
});

test('Stop cancels a requeued no-input message before it gets a new attempt', async t => {
  const h = await tabMessageQueueHarness(t);
  let calls = 0;
  h.context.bridgeRequest = async () => { calls++; return { success: false, submitted: false,
    pasteWritten: false, enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' }; };
  const q = (await h.question()).message; await h.drained();
  const original = h.store.get(q.operationKey);
  h.queue.ready = () => false;
  const recovery = h.service.wake('T', 'input-ready'); await tick(); await tick();
  assert.equal(h.queue.item(q.operationKey).state, 'waiting');
  const cancelled = h.queue.cancelWaiting('T', q.handoffId);
  assert.equal(cancelled.cancelled, true, JSON.stringify(cancelled));
  await recovery;
  h.queue.ready = () => true; h.queue.wake('T'); await tick();
  await h.service.wake('T', 'runtime');
  assert.equal(calls, 1);
  assert.equal(h.store.get(q.operationKey).attemptId, original.attemptId);
  assert.equal(h.queue.item(q.operationKey).state, 'cancelled');
});

test('a no-input recovery requested before the old bridge finally waits, then runs once without another wake', async t => {
  const h = await tabMessageQueueHarness(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let calls = 0;
  const failure = { success: false, submitted: false, pasteWritten: false,
    enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' };
  h.context.bridgeRequest = async (action, payload) => {
    if (++calls === 1) {
      h.store.settleAttempt(payload.sendOperationKey, payload.sendAttemptId, failure);
      await gate;
      return failure;
    }
    return h.physicalBridge(action, payload);
  };
  const q = (await h.question()).message; await h.drained();
  assert.equal(h.queue.running.has('T'), true);
  const recovery = h.service.wake('T', 'input-ready'); await tick(); await tick();
  assert.equal(h.queue.item(q.operationKey).state, 'waiting');
  assert.equal(h.writes.length, 0);
  release(); await recovery; await h.drained();
  assert.equal(calls, 2);
  assert.equal(h.writes.length, 1);
  assert.equal(h.service.getMessage(q.messageId).message.deliveryState, 'queued');
});

test('reopened SQLite retains authorized no-input retry without renewing the payload or sending twice', async t => {
  const h = await tabMessageQueueHarness(t);
  h.context.bridgeRequest = async () => ({ success: false, submitted: false, pasteWritten: false,
    enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' });
  const q = (await h.question()).message; await h.drained();
  h.queue.ready = () => false;
  const recovery = h.service.wake('T', 'input-ready'); await tick(); await tick();
  const frozen = h.queue.item(q.operationKey).request_json;
  const database = h.store.db.serialize();
  h.service.dispose(); h.queue.dispose(); await recovery;
  const next = await tabMessageQueueHarness(t, { database });
  assert.equal(next.writes.length, 0);
  next.queue.resume(); await tick(); await tick(); await next.drained();
  assert.equal(next.writes.length, 1);
  assert.equal(next.queue.item(q.operationKey).request_json, frozen);
  assert.equal(next.service.getMessage(q.messageId).message.deliveryState, 'queued');
  await next.service.wake('T'); assert.equal(next.writes.length, 1);
});

for (const outcome of ['unknown', 'provider-rejection']) test('message recovery never resubmits ' + outcome, async t => {
  const h = await tabMessageQueueHarness(t);
  let calls = 0;
  h.context.bridgeRequest = async (_action, payload) => {
    calls++;
    h.store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, 'enter-armed');
    return outcome === 'unknown' ? { success: null, submitted: null, deliveryUnknown: true, status: 'delivery-unknown' }
      : { success: false, submitted: true, status: 'provider-not-accepted', providerAccepted: false, enterWritten: true };
  };
  const q = (await h.question()).message; await h.drained();
  const before = h.store.get(q.operationKey);
  h.setStatus('busy');
  for (let i = 0; i < 3; i++) await h.service.wake('T', 'runtime');
  assert.equal(calls, 1);
  assert.equal(h.store.get(q.operationKey).attemptId, before.attemptId);
});

test('HH367 combined message/FIFO/actual Main discovery and process cleanup sends once then publishes exact receipt', async t => {
  const h = await tabMessageQueueHarness(t);
  const fixtureSource = fs.readFileSync(path.join(__dirname, 'codex-submission-observation.integration.test.js'), 'utf8');
  const fixtureAst = ts.createSourceFile('fixture.js', fixtureSource, ts.ScriptTarget.Latest, true);
  const mainSource = fs.readFileSync(process.env.CODEX_OBSERVATION_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
  const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true);
  const names = ['harness', 'completedDiscoveryDuringSubmit', 'completedDiscoveryWithActualProcessRead'];
  const fixtureCode = names.map(name => fixtureAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(fixtureAst)).join('\n');
  const writer = vm.runInNewContext(fixtureCode
    + '\ncompletedDiscoveryWithActualProcessRead(undefined, undefined, {tabId:"T",sessionId:"S"})', {
    vm, ts, require, assert, ast: mainAst, quiet: { log() {}, warn() {}, error() {} }, setImmediate,
  });
  const input = [];
  writer.term.write = bytes => input.push(bytes);
  let bridgeCalls = 0;
  h.context.bridgeRequest = async (action, payload) => {
    bridgeCalls++;
    const observed = await writer.observe('send-target-revalidation');
    if (!observed.available) return { success: false, submitted: false, pasteWritten: false,
      enterWritten: false, code: 'agent_send_target_unresolved', status: 'not-submitted' };
    assert.equal(observed.sessionId, payload.expectedTarget.sessionId);
    h.store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, 'enter-armed');
    writer.term.write(payload.prompt); writer.term.write('\r');
    h.store.settleAttempt(payload.sendOperationKey, payload.sendAttemptId,
      { success: true, submitted: true, status: 'audit-pending', auditPending: true });
    h.store.markProviderQueueAccepted(payload.sendOperationKey, payload.sendAttemptId,
      { provider: 'codex', sessionId: 'S', sourceIdentity: 'codex-tui-queue:' + payload.handoffId });
    return { success: true, accepted: true, submitted: true, status: 'queued',
      queued: true, providerQueueAccepted: true, auditPending: true };
  };
  h.queue.ready = () => false;
  const q = (await h.question()).message; await tick(); await tick();
  assert.equal(h.service.getMessage(q.messageId).message.deliveryState, 'pending');
  h.setStatus('busy'); h.queue.ready = () => true; h.queue.wake('T'); await h.drained();
  assert.equal(h.service.getMessage(q.messageId).message.deliveryState, 'queued');
  assert.equal(bridgeCalls, 1); assert.equal(writer.reads(), 2);
  assert.deepEqual(input, [JSON.parse(h.queue.item(q.operationKey).request_json).prompt, '\r']);
  const record = h.store.get(q.operationKey);
  h.store.promoteFromAudit({ success: true, operationKey: q.operationKey, attemptId: record.attemptId,
    provider: 'codex', sessionId: 'S', promptHash: record.promptHash, actualHash: record.promptHash,
    expectedHash: record.promptHash, entryUuid: 'canonical-exact-user', sourceIdentity: 'codex-exact-user',
    auditTimestamp: new Date().toISOString() });
  assert.equal(h.service.getMessage(q.messageId).message.deliveryState, 'sent');
  for (let i = 0; i < 3; i++) await h.service.wake('T', 'runtime');
  assert.equal(bridgeCalls, 1); assert.equal(input.length, 2);
});

function manualRunAfterHarness(t) {
  const h = harness(t, 'codex');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils/agentScenarios.ts'), 'utf8');
  const sourceAst = ts.createSourceFile('agentScenarios.ts', source, ts.ScriptTarget.Latest, true);
  const scenario = sourceAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'sendAgentPromptScenario');
  const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  const appAst = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let branch;
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(appAst) === "action === 'sendMessageAuto' || action === 'sendAgentPromptScenario'") branch = node;
    ts.forEachChild(node, visit);
  };
  visit(appAst); assert.ok(branch);
  const renderer = vm.createContext({
    crypto: require('node:crypto'), isStandaloneAgentLocalCommand: () => false,
    agentSendSettingsContractError: () => null,
    ipcRenderer: { invoke: async (channel, input) => {
      assert.equal(channel, 'agent:enqueue-prompt'); return h.context.enqueueDesktopAgentPrompt(input);
    } },
    enqueueAgentSendScenario: ({ run }) => run(), activateTabWorkContext: async () => {}, settleTabWorkContext: async () => {},
    prepareTabWorkContext: async (_tab, _id, prompt) => ({ prompt }),
    describeAgentTab: () => ({ tab: { cwd: '/private-fixture', tabType: 'terminal' }, toolType: 'codex', runtime: {}, sessionId: 'S' }),
    runHistoryPromptHandoff: input => input.send(input.handoffId), createAgentSettingsIntent: () => ({ kind: 'none' }),
    maybeAutoTitleAfterMobileSend() {},
    reply: (ok, data, error) => { assert.equal(ok, true, error); return data; },
    runAgentPromptScenario: async input => h.physicalBridge('sendAgentPromptScenario', input),
  });
  const compile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(compile(scenario.getText(sourceAst).replace(/^export /, '')), renderer);
  vm.runInContext(compile('async function appDispatch(action, payload) {' + branch.getText(appAst) + '}'), renderer);
  h.context.bridgeRequest = (action, payload) => renderer.appDispatch(action, payload);
  return { ...h, renderer };
}

test('RunAfter explicit send-now survives actual renderer admission, durable FIFO, and App re-entry', async t => {
  const h = manualRunAfterHarness(t);
  const result = await h.renderer.sendAgentPromptScenario({ tabId: 'T', toolType: 'codex', sessionId: 'S',
    prompt: 'manual body', handoffId: 'manual-now', source: 'prompt-queue', promptQueueAction: 'send-now',
    queue: true, statusAtSend: 'busy', settingsIntent: { kind: 'none' } });
  assert.equal(result.submitted, true);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].promptQueueAction, 'send-now');
  assert.deepEqual(structuredClone(h.writes[0].preflightScope), h.store.get('history:T:manual-now').receipt.preflightScope);
  assert.ok(h.writes[0].preflightScope.id, 'Main scope survives actual App bridge and scenario re-entry');
  const frozen = JSON.parse(h.queue.item('history:T:manual-now').request_json);
  assert.equal(frozen.promptQueueAction, 'send-now');
  assert.equal(frozen.source, 'prompt-queue');
  assert.equal(frozen.prompt, 'manual body');
});

test('actual Main merge IPC replaces two waiting History sends then dispatches one through the original web scenario', async t => {
  const h = harness(t, 'codex'); h.queue.ready = () => false;
  await h.send('a'); await h.send('b'); await h.send('c');
  const original = ['a', 'b'].map(id => h.queue.item('history:T:' + id).request_json);
  const request = { ...h.queue.mergeGuard('history:T:b'), requestId: 'actual-ipc-merge' };
  const result = await h.merge(request); assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.record.receipt.promptText, 'test a\n\ntest b'); assert.equal(h.writes.length, 0);
  assert.deepEqual(['a', 'b'].map(id => h.queue.item('history:T:' + id).request_json), original);
  h.queue.execute = (request, scope) => h.context.runPreparedAgentSendScenario({ ...request,
    applicationQueueExecution: true, sendRequestFingerprint: scope.requestFingerprint });
  h.queue.ready = () => true; h.queue.resume(); await tick(); await tick();
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].prompt, 'test a\n\ntest b');
  assert.equal(h.writes[0].sendOperationKey, result.operationKey);
  assert.ok(h.writes[0].sendAttemptId); assert.equal(h.writes[0].source, 'history-panel');
  assert.equal((await h.merge(request)).operationKey, result.operationKey);
  assert.equal(h.writes.length, 1, 'same merge request never creates a second physical input');
});

test('RunAfter automatic admission keeps the old absent-marker fingerprint and does not acquire manual privileges', async t => {
  const h = manualRunAfterHarness(t);
  await h.renderer.sendAgentPromptScenario({ tabId: 'T', toolType: 'codex', sessionId: 'S', prompt: 'automatic body',
    handoffId: 'automatic', source: 'prompt-queue', queue: false, settingsIntent: { kind: 'none' } });
  const item = h.queue.item('history:T:automatic');
  const frozen = JSON.parse(item.request_json);
  assert.equal(Object.hasOwn(frozen, 'promptQueueAction'), false);
  assert.equal(Object.hasOwn(h.writes[0], 'promptQueueAction'), false);
  assert.equal(item.request_hash, registry.fingerprintAgentSendRequest(frozen));
  assert.equal(h.store.get('history:T:automatic').requestFingerprint, registry.fingerprintAgentSendRequest({
    prompt: 'automatic body', model: null, effort: null, thinking: null, cwd: null,
    source: 'prompt-queue', queue: false, ownership: 'project', expectedTarget: { toolType: 'codex', sessionId: 'S' },
  }));
});

function automaticWaitHarness(t, { legacy = false } = {}) {
  const h = harness(t, 'codex');
  let ready = true, busy = true, cancelled = false, inputWrites = 0;
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const tree = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
  const handler = tree.statements.find(node => ts.isExpressionStatement(node)
    && node.expression.expression?.getText(tree) === 'ipcMain.handle'
    && node.expression.arguments?.[0]?.text === 'codex:send-command');
  assert.ok(handler);
  const ipc = new Map();
  const frameFixture = require('./fixtures/codex-draft-request-observation.cjs');
  const ownerSource = ['captureAgentInputIdentity', 'agentSendExecutionFailure']
    .map(frameFixture.actualFunction).join('\n');
  vm.runInNewContext(frameFixture.startupFrameDeclarations() + '\n' + ownerSource + '\n' + handler.getText(tree), {
    ...require('./agent-send-preparation'), agentSendReceiptStore: h.store,
    ipcMain: { handle: (key, fn) => ipc.set(key, fn) }, path, srcMainDir: __dirname,
    require: () => ({ certifyAutomaticReadinessWait: (...args) => h.queue.certifyAutomaticReadinessWait(...args),
      readAutomaticSendAdmission: async () => ready }),
    console: { log() {}, warn() {}, error() {} }, nodePerformance: { now: () => Date.now() },
    terminals: new Map([['T', {}]]), terminalCommandState: new Map(),
    codexLastRunCommandPayload: new Map(), aiStoppingTabs: new Map(),
    getHeadlessTerminalMirror: () => null, getTerminalInputRevision: () => 0,
    getTerminalLifecycleGeneration: () => 'automatic-fixture', getTerminalStopRevision: () => 0,
    CODEX_STARTUP_NO_STATE_TIMEOUT_MS: 60000,
    isPromptQueueAutomationSource: require('./prompt-queue-source').isPromptQueueAutomationSource,
    isCodexOperationalInputReady: () => true,
    // This fixture owns the automatic busy gate; the native-question editor
    // controller is a separate port and its frame/keys are not exercised here.
    prepareCodexMainComposerForSend: async () => ({ success: true }),
    agentSendCancellations: { isCancelled: () => cancelled },
    getCodexRuntimeSessionSnapshot: async () => ({ liveLifecycle: true, sessionStatus: busy ? 'busy' : 'active', inputReady: true, busy }),
    agentSendRequestTargetFailure: () => null, CODEX_PASTE_AUDIT_TIMEOUT_MS: 100,
    safePasteAndSubmit: async (_term, _command, options) => {
      inputWrites++;
      return h.physicalBridge('sendAgentPromptScenario', { ...options, tabId: 'T' });
    },
  });
  h.context.bridgeRequest = (_action, payload) => ipc.get('codex:send-command')({ sender: {} }, 'T', payload.prompt, payload);
  h.queue.admit = async () => ready;
  Object.assign(h.context, require('../shared/prompt-queue-send-intent.cjs'));
  h.context.hasCanonicalSendConsumption = require('./agent-send-queue').hasCanonicalSendConsumption;
  vm.runInContext('var joinAutomaticAgentPrompt = ' + exported('joinAutomaticAgentPrompt'), h.context);
  const promptQueueIntent = { version: 1, kind: 'queue', itemId: 'head', armedAt: 100,
    triggerTabId: 'T', conditionKey: '', triggerKey: 'null' };
  return { ...h, promptQueueIntent, inputWrites: () => inputWrites,
    setReady: value => ready = value, setBusy: value => busy = value, setCancelled: value => cancelled = value,
    start: () => h.send('auto-wait', { source: 'prompt-queue', ...(legacy ? {} : { promptQueueIntent }) }),
  };
}

test('actual pre-paste busy gate parks the SAME new automatic intent, then one wake writes once', async t => {
  const h = automaticWaitHarness(t);
  let done = false;
  const pending = h.start().then(result => { done = true; return result; });
  await tick(); await tick();
  const key = 'history:T:auto-wait', first = h.store.get(key);
  assert.equal(first.state, 'not-submitted');
  assert.equal(first.receipt.automaticReadinessWait, 1);
  assert.equal(first.receipt.pasteWritten, false);
  assert.equal(h.queue.item(key).state, 'waiting');
  assert.equal(h.queue.projectRecord(first).applicationQueue.waitingBeforeInput, true);
  assert.equal(done, false); assert.equal(h.inputWrites(), 0);
  const immutable = h.queue.item(key).request_json;
  h.setReady(false); h.queue.notifyRuntime('T'); await tick();
  assert.equal(h.store.get(key).attemptId, first.attemptId);
  const joined = h.context.joinAutomaticAgentPrompt({ tabId: 'T', handoffId: 'auto-wait',
    prompt: 'not a write: a restored renderer has new context', promptQueueIntent: h.promptQueueIntent });
  h.setBusy(false); h.setReady(true); h.queue.notifyRuntime('T');
  const [result, read] = await Promise.all([pending, joined]);
  assert.equal(result.submitted, true); assert.equal(read.receipt.submitted, true);
  assert.notEqual(h.store.get(key).attemptId, first.attemptId);
  assert.equal(h.queue.item(key).request_json, immutable);
  assert.equal(h.inputWrites(), 1);
});

test('explicit cancellation parks no new input and preserves the last no-write physical receipt', async t => {
  const h = automaticWaitHarness(t), pending = h.start();
  await tick(); await tick();
  const key = 'history:T:auto-wait', first = h.store.get(key);
  assert.equal(h.queue.cancelWaiting('T', 'auto-wait').cancelled, true);
  await pending;
  assert.equal(h.queue.item(key).state, 'cancelled');
  assert.equal(h.store.get(key).attemptId, first.attemptId);
  assert.equal(h.store.get(key).receipt.submitted, false);
  h.setBusy(false); h.queue.notifyRuntime('T'); await tick();
  assert.equal(h.inputWrites(), 0);
});

test('legacy failed sends and an explicitly revoked attempt cannot acquire automatic wait permission', async t => {
  for (const mode of ['legacy', 'revoked']) {
    const h = automaticWaitHarness(t, { legacy: mode === 'legacy' });
    if (mode === 'revoked') h.setCancelled(true);
    const result = await h.start();
    assert.equal(result.submitted, false);
    assert.equal(h.queue.item('history:T:auto-wait').state, 'failed');
    assert.equal(h.store.get('history:T:auto-wait').receipt.automaticReadinessWait, undefined);
    h.setBusy(false); h.queue.notifyRuntime('T'); await tick();
    assert.equal(h.inputWrites(), 0);
  }
});

test('pre-dispatch automatic cancellation is accepted without an attempt or any provider write', async t => {
  const h = automaticWaitHarness(t);
  h.queue.admit = async () => ({ cancel: true });
  const result = await h.start();
  assert.equal(result.submitted, false);
  assert.equal(h.store.get('history:T:auto-wait').attemptId, null);
  assert.equal(h.queue.item('history:T:auto-wait').state, 'cancelled');
  assert.equal(h.inputWrites(), 0);
});

test('a new explicit arm cannot bypass an old unknown and may pass only a proven untouched predecessor', async t => {
  const h = automaticWaitHarness(t), base = 'old-queue-item';
  await h.send(base, { source: 'prompt-queue' }); // legacy busy refusal: no input
  const input = { tabId: 'T', handoffId: base + '-arm-200',
    promptQueueIntent: { ...h.promptQueueIntent, baseHandoffId: base, armedAt: 200 } };
  assert.equal((await h.context.joinAutomaticAgentPrompt(input)).found, false);
  const old = h.store.get('history:T:' + base);
  const retried = h.store.beginAttempt({ ...old });
  assert.equal(retried.action, 'attempt-started');
  h.store.settleAttempt(old.operationKey, retried.attemptId,
    { success: null, submitted: null, deliveryUnknown: true, status: 'delivery-unknown' });
  const blocked = await h.context.joinAutomaticAgentPrompt(input);
  assert.equal(blocked.found, true);
  assert.equal(blocked.receipt.code, 'automatic_previous_delivery_unresolved');
  assert.equal(h.inputWrites(), 0);
  assert.equal(h.queue.item('history:T:' + input.handoffId), null);
});

test('pre-fix completion reproduces the nested FIFO fingerprint conflict before provider writes', async t => {
  const h = completionHarness(t, { legacy: true });
  await h.context.sendOrchestrationCompletionNotification(h.run);
  assert.equal(h.run.notificationStatus, 'failed');
  assert.match(h.run.notificationError, /same handoffId.*different send request/);
  assert.equal(h.reAdmissions(), 1);
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get('history:T:orchestration-complete:completion-test').attemptId, null);
});

test('completion caller enters Main FIFO once before actual renderer re-entry, including prepared context', async t => {
  const h = completionHarness(t);
  const { run, prefix, content } = h;
  await h.context.sendOrchestrationCompletionNotification(run);
  assert.equal(run.notificationStatus, 'queued', run.notificationError);
  assert.equal(h.reAdmissions(), 0, 'renderer must not enqueue its own Main caller a second time');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].prompt, prefix + content.prompt);
  assert.ok(h.writes[0].sendAttemptId);
  assert.equal(h.writes[0].sendOperationKey, 'history:T:orchestration-complete:completion-test');
  await h.context.sendOrchestrationCompletionNotification(run);
  assert.equal(h.writes.length, 1, 'queued completion is not resent');
  Object.assign(run, { notificationStatus: 'failed', notificationSuppressed: true, parentConsumedAt: Date.now() });
  await h.context.sendOrchestrationCompletionNotification(run, { force: true });
  assert.equal(h.writes.length, 1, 'dismissed completions must stay suppressed');
});

test('completion reaches the common FIFO proof for an exact provisional launch without borrowing a saved writer', async t => {
  const h = completionHarness(t);
  h.setTarget(null);
  h.context.readAgentRuntimeSnapshot = async () => ({ coherent: true, status: 'active', toolType: 'codex',
    sendTarget: { toolType: 'codex', sessionId: null, terminalInstanceId: 'instance-I', launchId: 'launch-L' } });
  await h.context.sendOrchestrationCompletionNotification(h.run);
  assert.equal(h.run.notificationStatus, 'queued', h.run.notificationError);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].expectedTarget.sessionId, 'S', 'the original SID reaches final physical proof unchanged');
  assert.equal(h.writes[0].sendOperationKey, 'history:T:orchestration-complete:completion-test');
  assert.equal(h.reAdmissions(), 0);
});

test('completion for a replaced non-null source remains refused without provider input', async t => {
  const h = completionHarness(t);
  h.setTarget('foreign-session');
  await h.context.sendOrchestrationCompletionNotification(h.run);
  assert.equal(h.run.notificationStatus, 'failed');
  assert.equal(h.writes.length, 0);
});

test('a pre-upgrade unknown completion cannot create a second operation or cross Enter', async t => {
  const h = completionHarness(t);
  const prompt = h.prefix + h.content.prompt;
  const identity = { operationKey: 'history:T:orchestration-complete:completion-test', surface: 'desktop-history',
    tabId: 'T', handoffId: 'orchestration-complete:completion-test', provider: 'codex', sessionId: 'S',
    requestFingerprint: 'legacy-exact-fingerprint', promptHash: promptAuditFingerprint(prompt), promptLength: prompt.length };
  const attempt = h.store.beginAttempt(identity);
  h.store.markAttemptState(identity.operationKey, attempt.attemptId, 'enter-armed');
  h.store.settleAttempt(identity.operationKey, attempt.attemptId, { success: null, submitted: null,
    status: 'delivery-unknown', deliveryUnknown: true });
  await h.context.sendOrchestrationCompletionNotification(h.run, { force: true });
  assert.equal(h.writes.length, 0);
  assert.equal(h.store.get(identity.operationKey).state, 'delivery-unknown');
  assert.equal(h.store.list({ tabId: 'T' }).length, 1);
});

for (const provider of ['codex','claude']) {
  test(provider + ': actual IPC → shared web scenario → SQLite admission → existing physical bridge', async t => {
    const h = harness(t, provider);
    const admitted = [];
    for (let i = 0; i < 6; i++) admitted.push(await h.send('h' + i));
    assert.ok(admitted.every(r => r.applicationQueued && r.submitted === false && !r.exactAuditConfirmed));
    await tick(); assert.equal(h.writes.length, 1);
    assert.equal(h.contexts.some(x => x[0] === 'settle' && x[2] === false), false, 'queued admission must not return frozen context chips');
    const b = h.context.publicAgentSendReceipt(h.store.get('history:T:h1'));
    assert.equal(b.status, 'application-queued'); assert.equal(b.attemptId, null);
    assert.equal(b.applicationQueue.version, 1);
    const repeat = await h.send('h1'); assert.equal(repeat.applicationQueued, true);
    for (let i = 0; i < 6; i++) { assert.equal(h.confirm('h' + i).promoted, true); await tick(); }
    assert.equal(h.writes.length, 6);
    assert.deepEqual(h.writes.map(x => x.prompt), Array.from({ length: 6 }, (_, i) => 'test h' + i));
    const replay = await h.send('h1'); assert.equal(replay.exactAuditConfirmed, true);
    assert.equal(h.writes.length, 6);
  });
}

test('actual desktop admission freezes images/chips and passes only explicit settings to the shared dispatcher', async t => {
  const h = harness(t, 'codex');
  await h.send('a');
  await h.send('b', { settingsIntent: { kind: 'explicit-change', model: 'model-test', effort: 'max' },
    authoringSnapshot: { editorText: '[Image #1] hello', chips: [{ kind: 'prompt', text: 'context' }],
      imagePaths: [{ id: 1, path: '/var/exact.png' }] },
    presentationSnapshot: { imagePaths: [{ id: 1, path: '/var/exact.png' }] } });
  await tick(); h.confirm('a'); await tick();
  assert.equal(h.writes[1].model, 'model-test'); assert.equal(h.writes[1].effort, 'max');
  assert.equal(h.writes[1].authoringSnapshot.imagePaths[0].path, '/var/exact.png');
  assert.equal(h.writes[0].model, undefined);
});

test('actual HTTP response for durable application admission is 202 and never claims provider acceptance', async t => {
  const h = harness(t, 'claude');
  const result = await h.send('a');
  const begin = web.indexOf('      const sendReceipt = classifyAgentSendReceipt(data);', web.indexOf('// Send prompt to a project terminal tab.'));
  const end = web.indexOf('\n    } catch (e)', begin);
  Object.assign(h.context, { classifyAgentSendReceipt,
    sendJson: (_res, status, body) => ({ status, body }),
  });
  vm.runInContext(`function httpResponse(data) { const res = null, tabId='T', operationHandoffId='a';
    const sendPayload={attachments:[]}, promptPresentation={contextFiles:[]}; ${web.slice(begin,end)} }`, h.context);
  const response = h.context.httpResponse(result);
  assert.equal(classifyAgentSendReceipt(result).state, 'application-queued');
  assert.equal(response.status, 202); assert.equal(response.body.applicationQueued, true);
  assert.equal(response.body.submitted, false); assert.equal(response.body.providerQueueAccepted, false);
});

test('a queued request remains pinned to its original conversation; later explicit branch is not sent into', async t => {
  const h = harness(t, 'codex');
  await h.send('a'); await h.send('b'); await tick();
  h.setTarget('foreign'); h.confirm('a'); await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.store.get('history:T:b').state, 'not-submitted');
  assert.equal(h.store.get('history:T:b').receipt.code, 'agent_send_target_changed');
});

test('cold/provisional identity does not reject before readiness; original target reaches the physical scenario', async t => {
  const h = harness(t, 'codex');
  h.context.readAgentRuntimeSnapshot = async () => ({ coherent: true, status: 'starting', toolType: 'codex',
    sendTarget: { toolType: 'codex', sessionId: null, terminalInstanceId: 'I', launchId: 'L' } });
  await h.send('cold'); await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].expectedTarget.sessionId, 'S', 'defer proof; never remove the original target from physical admission');
});

test('actual Main stop during queued preparation refuses before bridge/attempt and retains the prompt', async t => {
  const h = harness(t, 'claude'); let release;
  const request = { tabId: 'T', provider: 'claude', prompt: 'owned text', handoffId: 'preparing',
    sendOperationKey: 'history:T:preparing', sendSurface: 'desktop-history',
    applicationQueueAcceptedResponse: true, source: 'history-panel',
    prepareSend: () => new Promise(resolve => { release = resolve; }) };
  const accepted = await h.context.runAgentSendScenario(request);
  assert.equal(accepted.applicationQueued, true); await tick();
  h.queue.stop('T'); release({}); await tick();
  assert.equal(h.writes.length, 0);
  const r = h.store.get(request.sendOperationKey);
  assert.equal(r.attemptId, null); assert.equal(r.state, 'not-submitted');
  assert.equal(r.receipt.promptText, 'owned text');
});

test('same-ID replay after a changed current target uses the admitted implicit target, not a fresh session hint', async t => {
  const h = harness(t, 'codex');
  const request = { tabId: 'T', provider: 'codex', prompt: 'API request', handoffId: 'api',
    sendOperationKey: 'project:T:api', sendSurface: 'project-api', applicationQueueAcceptedResponse: true };
  await h.context.runAgentSendScenario(request); await tick();
  h.setTarget('foreign');
  const replay = await h.context.runAgentSendScenario(request);
  assert.equal(replay.status, 'queued'); assert.equal(replay.providerQueueAccepted, true);
  assert.equal(h.writes.length, 1);
});

test('one App renderer going away cannot withdraw another live renderer readiness', () => {
  const context = vm.createContext({ sendQueueRendererOwners: new Set(), sendQueueRendererReady: false,
    agentSendQueue: { resume() {} } });
  vm.runInContext('var ready = ' + exported('markSendQueueRendererReady'), context);
  context.ready(true, 11); context.ready(true, 22);
  context.ready(false, 11); assert.equal(context.sendQueueRendererReady, true);
  context.ready(false, 22); assert.equal(context.sendQueueRendererReady, false);
});

test('actual SSE queue publisher is an exact compact wake, not a repeated prompt/context download', async t => {
  const h = harness(t, 'codex'); const events = [];
  let publisher;
  const visit = node => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'AgentSendQueue') {
      publisher = node.arguments[0].properties.find(p => p.name?.getText(ast) === 'publish').initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(publisher);
  Object.assign(h.context, { BrowserWindow: { getAllWindows: () => [] }, imagePresentationFromReceipt,
    webBroadcast: (tabId, payload) => events.push({ tabId, payload }) });
  vm.runInContext('var publishQueue = ' + publisher, h.context);
  await h.send('large', { prompt: 'private context '.repeat(1000) });
  h.context.publishQueue(h.queue.projectRecord(h.store.get('history:T:large')));
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.receipt.handoffId, 'large');
  assert.ok(JSON.stringify(events[0]).length < 1000);
  assert.equal(JSON.stringify(events[0]).includes('private context'), false);
});

async function coldLaunchRefusal(payload, mutate = () => {}) {
  const { runAgentSendFlow } = await import('../renderer/utils/agentSendFlow.mjs');
  const refusal = { success: false, accepted: false, launchWritten: false,
    protocolVersion: 1, launchStage: 'no-launch', launchAttempt: 1,
    launchIntent: { intentId: 'launch:fixture:1', token: 1, tabId: payload.tabId, toolType: 'codex' },
    code: 'agent_send_target_changed', reason: 'process_lookup_unknown',
    sendReceipt: { success: null, accepted: null, submitted: null, deliveryUnknown: true,
      status: 'delivery-unknown', code: 'agent_send_target_changed',
      operationKey: payload.sendOperationKey, attemptId: payload.sendAttemptId } };
  mutate(refusal);
  try {
    await runAgentSendFlow({ preflightScope: payload.preflightScope,
      prepareContext: async () => ({}),
      ensureReady: async () => { throw Object.assign(new Error('launch refused'), refusal); },
      proveComposer: () => assert.fail('refused launch must not reach composer'),
      runProviderOperation: () => assert.fail('refused launch must not reach provider') });
  } catch (error) { return error.sendReceipt; }
  assert.fail('launch refusal expected');
}

test('perf51: exact cold no-launch refusal settles this Send and releases only its existing FIFO follower', async t => {
  const h = harness(t, 'codex');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let bridgeCalls = 0;
  h.context.bridgeRequest = async (action, payload) => {
    bridgeCalls++;
    if (payload.handoffId !== 'cold') return h.physicalBridge(action, payload);
    entered(); await held;
    return coldLaunchRefusal(payload);
  };
  await h.send('cold'); await started; await h.send('follower');
  const first = h.store.get('history:T:cold');
  assert.equal(h.queue.item('history:T:follower').state, 'waiting');
  release(); await h.queue.result(first.operationKey); await tick();
  const record = h.store.get(first.operationKey);
  assert.equal(record.state, 'not-submitted');
  assert.equal(record.attemptId, first.attemptId);
  assert.equal(record.receipt.submitted, false);
  assert.equal(record.receipt.pasteWritten, false);
  assert.equal(record.receipt.enterWritten, false);
  assert.equal(record.receipt.preflightRefusal.phase, 'ensuring-ready');
  assert.equal(JSON.parse(h.queue.item(first.operationKey).request_json).prompt, 'test cold');
  assert.deepEqual(h.writes.map(x => x.handoffId), ['follower']);
  assert.equal(bridgeCalls, 2, 'one refusal and one already-admitted follower, no retry');
});

for (const mode of ['lost-launch-ack', 'wrong-attempt', 'wrong-invocation', 'enter-armed', 'cancelled-follower']) {
  test('cold preflight does not invent negative delivery or revive input: ' + mode, async t => {
    const h = harness(t, 'codex');
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    h.context.bridgeRequest = async (action, payload) => {
      if (payload.handoffId !== 'cold') return h.physicalBridge(action, payload);
      entered(); await held;
      if (mode === 'enter-armed') h.store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, 'enter-armed');
      const result = await coldLaunchRefusal(payload, refusal => {
        if (mode === 'lost-launch-ack') Object.assign(refusal, { launchWritten: null, accepted: null, launchOutcomeUnknown: true });
        if (mode === 'wrong-attempt') refusal.sendReceipt.attemptId = 'foreign-attempt';
      });
      if (mode === 'wrong-invocation' && result.preflightRefusal) result.preflightRefusal.scope.id = 'foreign-invocation';
      return result;
    };
    await h.send('cold'); await started; await h.send('follower');
    if (mode === 'cancelled-follower') h.queue.cancelWaiting('T', 'follower');
    release(); await h.queue.result('history:T:cold'); await tick();
    assert.equal(h.store.get('history:T:cold').state, mode === 'cancelled-follower' ? 'not-submitted' : 'delivery-unknown');
    assert.equal(h.writes.length, 0);
  });
}

test('post-begin context exception is recorded on the original attempt without invoking renderer', async t => {
  const h = harness(t, 'codex');
  h.store.stageAttemptContext = () => { throw Object.assign(new Error('controlled stage failure'), { code: 'stage-test-failed' }); };
  await h.send('stage-error'); await h.queue.result('history:T:stage-error');
  const r = h.store.get('history:T:stage-error');
  assert.equal(r.state, 'not-submitted'); assert.equal(r.receipt.code, 'stage-test-failed');
  assert.ok(r.attemptId); assert.equal(h.writes.length, 0);
});

test('bridge payload evaluation failure is not a dispatched timeout', async t => {
  const h = harness(t, 'codex');
  h.context.withPromptOriginPresentation = () => { throw Object.assign(new Error('controlled payload failure'), { code: 'payload-test-failed' }); };
  await h.send('payload-error'); await h.queue.result('history:T:payload-error');
  const r = h.store.get('history:T:payload-error');
  assert.equal(r.state, 'not-submitted'); assert.equal(r.receipt.code, 'payload-test-failed');
  assert.equal(h.writes.length, 0);
});

test('lost bridge ACK accepts a late exact preflight proof without replaying the original Send', async t => {
  const h = harness(t, 'codex'); let late, captured; let calls = 0;
  h.context.bridgeRequest = async (_action, payload, _timeout, options) => {
    calls++; captured = payload; late = options.onLateReply;
    throw Object.assign(new Error('controlled lost bridge ACK'), { code: 'bridge_timeout' });
  };
  await h.send('late'); await h.queue.result('history:T:late');
  const before = h.store.get('history:T:late');
  assert.equal(before.state, 'in-flight');
  await h.send('late'); assert.equal(calls, 1);
  await late({ ok: true, data: await coldLaunchRefusal(captured) });
  const after = h.store.get(before.operationKey);
  assert.equal(after.state, 'not-submitted'); assert.equal(after.attemptId, before.attemptId);
  assert.equal(calls, 1);
});

test('actual registry/store/FIFO keep an armed head after a weak late refusal, until exact audit', async t => {
  const h = harness(t, 'codex'); let late, calls = 0;
  h.context.bridgeRequest = async (_action, payload, _timeout, options) => {
    calls++;
    if (calls > 1) return h.physicalBridge('sendAgentPromptScenario', payload);
    late = options.onLateReply;
    h.store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, 'enter-armed');
    throw Object.assign(new Error('controlled lost ACK after durable arm'), { code: 'bridge_timeout' });
  };
  await h.send('armed'); await h.queue.result('history:T:armed');
  const head = h.store.get('history:T:armed');
  assert.equal(head.state, 'enter-armed');
  await h.send('follower');
  await late({ ok: true, data: { success: false, submitted: false, pasteWritten: false,
    enterWritten: false, status: 'not-submitted', deliveryUnknown: false, auditPending: false } });
  for (let i = 0; i < 3; i++) { h.queue.notifyRuntime('T'); await tick(); }
  assert.equal(h.store.get(head.operationKey).state, 'enter-armed');
  assert.equal(h.store.get(head.operationKey).attemptId, head.attemptId);
  assert.equal(calls, 1, 'a weak callback and ready wakes cannot release the physical head');
  assert.equal(h.store.get('history:T:follower').attemptId, null);
  assert.equal(h.confirm('armed').promoted, true);
  await tick(); await tick();
  assert.equal(calls, 2, 'exact canonical proof releases the existing follower once');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].handoffId, 'follower');
});

test('late canonical input proof outranks a preflight callback for the same attempt', async t => {
  const h = harness(t, 'codex'); let late, captured;
  h.context.bridgeRequest = async (_action, payload, _timeout, options) => {
    captured = payload; late = options.onLateReply;
    h.store.markAttemptState(payload.sendOperationKey, payload.sendAttemptId, 'enter-armed');
    throw Object.assign(new Error('controlled lost ACK'), { code: 'bridge_timeout' });
  };
  await h.send('canonical'); await h.queue.result('history:T:canonical');
  const before = h.store.get('history:T:canonical');
  h.confirm('canonical');
  assert.equal(h.store.get(before.operationKey).state, 'confirmed');
  await late({ ok: true, data: await coldLaunchRefusal(captured) });
  assert.equal(h.store.get(before.operationKey).state, 'confirmed');
  assert.equal(h.store.get(before.operationKey).attemptId, before.attemptId);
});

test('a stale preflight callback cannot settle a replacement attempt (ABA)', async t => {
  const h = harness(t, 'codex'); let late, captured;
  h.context.bridgeRequest = async (_action, payload, _timeout, options) => {
    captured = payload; late = options.onLateReply;
    throw Object.assign(new Error('controlled lost ACK'), { code: 'bridge_timeout' });
  };
  await h.send('aba'); await h.queue.result('history:T:aba');
  const before = h.store.get('history:T:aba');
  h.store.settleAttempt(before.operationKey, before.attemptId, { submitted: false, status: 'not-submitted' });
  const next = h.store.beginAttempt(before);
  assert.equal(next.action, 'attempt-started'); assert.notEqual(next.attemptId, before.attemptId);
  await late({ ok: true, data: await coldLaunchRefusal(captured) });
  assert.equal(h.store.get(before.operationKey).state, 'in-flight');
  assert.equal(h.store.get(before.operationKey).attemptId, next.attemptId);
});

test('preparation: active HEAD clock excludes FIFO residence and preserves the original item', async t => {
  const h = harness(t, 'codex'); let now = 1000;
  h.context.Date = class extends Date { static now() { return now; } };
  await h.send('head'); await h.send('follower'); await tick();
  const key = 'history:T:follower', item = h.queue.item(key);
  const first = h.store.get('history:T:head').receipt.preflightScope;
  assert.ok(first.preparation, 'active executor must issue one preparation deadline');
  assert.equal(first.preparation.startedAt, 1000);
  assert.equal(h.store.get(key).attemptId, null);
  now += 75000;
  h.confirm('head'); await h.queue.result(key);
  const next = h.store.get(key).receipt.preflightScope;
  assert.equal(next.preparation.startedAt, now);
  assert.equal(next.preparation.deadlineAt, now + 60000);
  assert.equal(h.queue.item(key).id, item.id);
  assert.equal(h.queue.item(key).request_json, item.request_json);
  assert.equal(h.store.get('history:T:head').receipt.preflightScope.preparation.deadlineAt, 61000);
  assert.deepEqual(h.writes.map(x => x.handoffId), ['head', 'follower']);
});

test('preparation: time inside active prepareSend is charged before beginAttempt and bridge dispatch', async t => {
  const h = harness(t, 'codex'); let now = 1000;
  h.context.Date = class extends Date { static now() { return now; } };
  await h.context.runPreparedAgentSendScenario({ tabId: 'T', handoffId: 'prepared',
    sendOperationKey: 'history:T:prepared', provider: 'codex', sessionId: 'S', prompt: 'frozen',
    source: 'history-panel', applicationQueueAcceptedResponse: true,
    prepareSend: async () => { now += 45000; return null; } });
  await h.queue.result('history:T:prepared');
  const record = h.store.get('history:T:prepared');
  assert.ok(record.receipt.preflightScope.preparation, 'prepareSend time must belong to the active deadline');
  assert.equal(record.receipt.preflightScope.preparation.startedAt, 1000);
  assert.equal(record.receipt.preflightScope.preparation.deadlineAt - now, 15000);
  assert.equal(h.writes.length, 1);
});

function actualOwnedBridge(t, h, { enter = false } = {}) {
  const { EventEmitter } = require('node:events');
  const { createFakeClock } = require('./fixtures/codex-draft-request-observation.cjs');
  const cancellations = require('./agent-send-cancellation').createAgentSendCancellationRegistry();
  const clock = createFakeClock(), sender = new EventEmitter(), ipcMain = new EventEmitter(), dispatched = [];
  sender.mainFrame = { processId: 41, routingId: 3 };
  sender.send = (_channel, message) => {
    dispatched.push(message);
    if (enter) h.store.markAttemptState(message.payload.sendOperationKey, message.payload.sendAttemptId, 'enter-armed');
  };
  h.queue.cancelAttempt = record => cancellations.cancel(record.tabId, record.handoffId, { attemptId: record.attemptId });
  // The actual existing frame identity function; no renderer authority stub.
  const frameSource = fs.readFileSync(path.join(__dirname, 'workspace-switcher-api.js'), 'utf8');
  const frameAst = ts.createSourceFile('workspace-switcher-api.js', frameSource, ts.ScriptTarget.Latest, true);
  const frameKey = frameAst.statements.find(n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText(frameAst) === 'frameKey')).getText(frameAst);
  Object.assign(h.context, { pendingBridge: new Map(), ipcMain,
    BrowserWindow: { getAllWindows: () => [{ webContents: sender, isDestroyed: () => false }] },
    LATE_BRIDGE_REPLY_RETENTION_MS: 10000, e2eBoundaryTestGate: null,
    setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    Date: class extends Date { static now() { return clock.now(); } } });
  vm.runInContext(frameKey + '\nvar switcherFrameKey = frameKey;\n'
    + ['bridgePayloadLabel', 'bridgeRequest', 'registerBridgeReplyHandler'].map(declaration).join('\n'), h.context);
  h.context.registerBridgeReplyHandler();
  t.after(() => { for (const p of h.context.pendingBridge.values()) p.dispose?.(); h.context.pendingBridge.clear(); clock.timers.clear(); });
  return { sender, ipcMain, clock, dispatched, cancellations,
    reply(message, data, from = sender, frame = sender.mainFrame) {
      ipcMain.emit('web:bridge-reply', { sender: from, senderFrame: frame },
        { requestId: message.requestId, ok: true, data });
    } };
}

test('preparation: expired active prepareSend cannot create an attempt or dispatch a late renderer launch', async t => {
  const h = harness(t, 'codex'); let now = 1000;
  h.context.Date = class extends Date { static now() { return now; } };
  await h.context.runPreparedAgentSendScenario({ tabId: 'T', handoffId: 'expired',
    sendOperationKey: 'history:T:expired', provider: 'codex', sessionId: 'S', prompt: 'frozen',
    source: 'history-panel', applicationQueueAcceptedResponse: true,
    prepareSend: async () => { now += 60000; return null; } });
  await h.queue.result('history:T:expired');
  const record = h.store.get('history:T:expired');
  assert.equal(record.state, 'not-submitted'); assert.equal(record.attemptId, null);
  assert.equal(h.writes.length, 0);
});

for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
  test('preparation: actual bridge owner ' + event + ' revokes future input and holds possible-Enter follower', async t => {
    const h = harness(t, 'codex'), b = actualOwnedBridge(t, h, { enter: true });
    await h.send('lost'); await h.send('follower'); await tick();
    assert.equal(b.dispatched.length, 1);
    const before = h.store.get('history:T:lost');
    b.sender.emit(event); await tick();
    assert.equal(b.cancellations.isCancelled('T', 'lost', before.attemptId), true);
    assert.equal(h.store.isDeliveryCancelled(before.operationKey, before.attemptId), true);
    assert.equal(h.store.get(before.operationKey).state, 'delivery-unknown');
    assert.equal(h.store.get('history:T:follower').attemptId, null);
    h.queue.resume(); b.clock.advance(60000); await tick();
    assert.equal(b.dispatched.length, 1);
    assert.equal(h.store.get(before.operationKey).attemptId, before.attemptId);
    assert.equal(b.sender.listenerCount('destroyed') + b.sender.listenerCount('render-process-gone')
      + b.sender.listenerCount('did-navigate'), 0);
    // A late exact canonical proof may enrich delivery; it cannot uncancel H.
    h.confirm('lost'); await tick();
    assert.equal(h.store.get(before.operationKey).state, 'confirmed');
    assert.equal(h.store.isDeliveryCancelled(before.operationKey, before.attemptId), true);
  });
}

test('preparation: actual bridge ignores foreign replies and blocked navigation, then accepts its exact owner', async t => {
  const h = harness(t, 'codex'), b = actualOwnedBridge(t, h);
  await h.send('owner'); await tick(); const message = b.dispatched[0];
  const refusal = { success: false, submitted: false, pasteWritten: false, enterWritten: false, status: 'not-submitted' };
  b.reply(message, refusal, {}); await tick();
  assert.equal(h.context.pendingBridge.size, 1);
  b.reply(message, refusal, b.sender, { processId: 99, routingId: 2 }); await tick();
  assert.equal(h.context.pendingBridge.size, 1);
  b.sender.emit('did-start-navigation', {}, 'https://blocked.example', false, true);
  assert.equal(h.context.pendingBridge.size, 1);
  assert.equal(h.store.isDeliveryCancelled(message.payload.sendOperationKey, message.payload.sendAttemptId), false);
  b.reply(message, refusal); await h.queue.result('history:T:owner');
  assert.equal(h.store.get('history:T:owner').state, 'not-submitted');
  assert.equal(h.context.pendingBridge.size, 0);
  assert.equal(b.sender.listenerCount('destroyed'), 0);
});

test('preparation: actual bridge timeout keeps unknown and late receipt ownership until bounded cleanup', async t => {
  const h = harness(t, 'codex'), b = actualOwnedBridge(t, h, { enter: true });
  await h.send('timeout'); await h.send('follower'); await tick();
  b.clock.advance(1000); await tick();
  assert.equal(h.store.get('history:T:timeout').state, 'enter-armed');
  assert.equal(h.store.get('history:T:follower').attemptId, null);
  assert.equal(h.context.pendingBridge.size, 1);
  b.clock.advance(10000); await tick();
  assert.equal(h.context.pendingBridge.size, 0);
  assert.equal(b.sender.listenerCount('destroyed'), 0);
  assert.equal(b.dispatched.length, 1);
});
