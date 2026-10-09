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
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
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

function harness(t, provider) {
  const db = new Database(':memory:');
  const store = createAgentSendReceiptStore(db);
  const writes = [], contexts = [];
  let targetSession = 'S';
  const context = vm.createContext({
    require, path, srcMainDir: __dirname,
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
  const result = await h.merge(request); assert.equal(result.success, true);
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
  vm.runInNewContext(handler.getText(tree), {
    ipcMain: { handle: (key, fn) => ipc.set(key, fn) }, path, srcMainDir: __dirname,
    require: () => ({ certifyAutomaticReadinessWait: (...args) => h.queue.certifyAutomaticReadinessWait(...args),
      readAutomaticSendAdmission: async () => ready }),
    console: { log() {}, warn() {}, error() {} }, nodePerformance: { now: () => Date.now() },
    terminals: new Map([['T', {}]]), terminalCommandState: new Map(),
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
