'use strict';

// Source/private causal integration; this is not an Electron UI or provider test.
// DESKTOP_COMPACT_SOURCE_ROOT may point at a complete PRE source snapshot.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

const root = process.env.DESKTOP_COMPACT_SOURCE_ROOT || path.resolve(__dirname, '../..');
const mainDir = path.join(root, 'src/main');
const rendererDir = path.join(root, 'src/renderer/utils');
const { fixture: nativeFixture, tick } = require(path.join(mainDir, 'fixtures/compact-preparation.cjs'));

function declarations(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name
      || ts.isVariableStatement(item) && item.declarationList.declarations.some(d => d.name.getText(ast) === name));
    assert.ok(node, path.basename(file) + ':' + name);
    return node.getText(ast).replace(/^export /, '');
  }).join('\n');
}

function exported(file, name) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let result;
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === name) result = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(result, name);
  return result;
}

function registration(file, channel) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(item => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression)
    && item.expression.expression.getText(ast) === 'ipcMain.handle' && item.expression.arguments[0]?.text === channel);
  assert.ok(node, channel);
  return node.getText(ast);
}

function webCompactBindings(file) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter(node => ts.isVariableStatement(node)
    && ((node.getText(ast).includes('isDesktopCodexCompactQueueRequest')
      && node.getText(ast).includes('agent-local-command.cjs'))
      || node.declarationList.declarations.some(d => d.name.getText(ast) === 'DESKTOP_COMPACT_ADMISSION')));
  assert.ok(selected.length === 0 || selected.length === 2, 'both exact production compact bindings');
  return selected.map(node => node.getText(ast)).join('\n');
}

function nativeTaskStartedBranch(file) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let branch;
  const visit = node => {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === "event === 'task_started'"
      && node.getText(ast).includes('pendingManualCompact = reconcileCodexManualCompactPendingOwner')) branch = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(branch, 'actual causal task_started branch');
  return branch;
}

function nestedDeclaration(file, name) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = node => {
    if (!found && ts.isVariableStatement(node)
      && node.declarationList.declarations.some(d => d.name.getText(ast) === name)) found = node.getText(ast);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(found, name); return found;
}

function nestedIf(file, expression, marker) {
  const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  const visit = node => {
    if (!found && ts.isIfStatement(node) && node.expression.getText(ast) === expression
      && node.getText(ast).includes(marker)) found = node.getText(ast);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(found, 'actual History conditional: ' + expression); return found;
}

async function freshHistoryProjection() {
  // Compile the real handoff module into a fresh owner, as on renderer reload;
  // its imports stay the real source modules and no DOM/UI is involved.
  const imports = {};
  for (const name of ['historyPromptPresentation.mjs', 'agentLocalCommand.mjs', 'historySendRecovery.mjs', 'historySendTiming.mjs']) {
    imports['./' + name] = await import(pathToFileURL(path.join(rendererDir, name)).href);
  }
  for (const name of ['prompt-queue-send-intent.cjs', 'agent-send-receipt-control.cjs', 'compact-send-delivery.cjs']) {
    const file = path.join(root, 'src/shared', name);
    if (fs.existsSync(file)) imports['../../shared/' + name] = require(file);
  }
  const code = ts.transpileModule(fs.readFileSync(path.join(rendererDir, 'historyPromptHandoffs.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, console,
    require: name => { assert.ok(imports[name], 'actual projection import ' + name); return imports[name]; } });
  vm.runInContext(code, context);
  return module.exports;
}

async function setup(t, { loseFirstAdmissionReply = false, holdFirstAdmissionReply = false, throwEnter = false } = {}) {
  // The native fixture closes SQLite in its own after-hook. Register our
  // disposal first so in-flight queue work cannot outlive that database.
  let cleanup = async () => {};
  t.after(async () => cleanup());
  const native = nativeFixture(t, { autoStart: false, throwEnter });
  // The extracted actual Main executor resolves its new shared verifier just
  // as the real Main module does; missing CommonJS globals would turn a
  // successful durable retry into a synthetic ReferenceError in this fixture.
  Object.assign(native.ctx, { require, path, srcMainDir: mainDir });
  native.ctx.agentSendCancellations = { isCancelled: (tabId, handoffId, attemptId) =>
    native.store.isDeliveryCancelled(`history:${tabId}:${handoffId}`, attemptId) };
  const modules = Object.assign({}, ...await Promise.all([
    'agentSendFlow.mjs', 'agentSendOutcome.mjs', 'agentDraftPreflight.mjs', 'agentDraftTransfer.mjs',
    'codexDraftAuthority.mjs', 'codexLocalSlashCommand.mjs', 'codexHistorySettingsPlan.mjs',
    'agentActionCoordinator.mjs', 'agentSendSequencer.mjs', 'agentLocalCommand.mjs',
  ].map(name => import(pathToFileURL(path.join(rendererDir, name)).href))));
  modules.resetCoordinatedAgentActionsForTests();
  const events = [], ipc = [], webCalls = [], nativeResults = [];
  let resolveReady, resolveTextDelivery, releaseAdmission;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const textDelivery = new Promise(resolve => { resolveTextDelivery = resolve; });
  const admissionGate = new Promise(resolve => { releaseAdmission = resolve; });
  const reg = require(path.join(mainDir, 'agent-send-receipt-registry'));
  const preparation = require(path.join(mainDir, 'agent-send-preparation'));
  const { AgentSendQueue } = require(path.join(mainDir, 'agent-send-queue'));
  const webFile = path.join(mainDir, 'web-server.js');
  const mainFile = path.join(mainDir, 'main.js');
  // Match the existing production publisher: a bound native start writes its
  // receipt before notifying the native command waiter and FIFO subscribers.
  vm.runInContext(declarations(mainFile, ['persistCompactSendReceipt', 'reconcileCodexManualCompactPendingOwner',
    'sameCodexManualCompactOwner']), native.ctx);
  const previousPublish = native.registry.publish;
  native.registry.publish = operation => { native.ctx.persistCompactSendReceipt(operation); previousPublish(operation); };
  native.ctx.readCodexManualInputOwner = () => ({ tabId: 'T', sessionId: 'S', generation: 'L1',
    terminal: native.term, promptSeq: 1 });
  native.ctx.Date = class extends Date { static now() { return native.clock.now(); } };
  vm.runInContext('function deliverControlledNativeEvent(state, record) { const event = record.payload.type; '
    + 'let pendingManualCompact = null; ' + nativeTaskStartedBranch(mainFile) + '\n}', native.ctx);
  const web = vm.createContext({
    require, path, srcMainDir: mainDir, Buffer, crypto: require('node:crypto'),
    Date: class extends Date { static now() { return native.clock.now(); } },
    COMPLETION_ADMISSION: Symbol('owned-external-completion-admission'),
    getBuildContinueOperations: () => ({ pending: () => false }), buildContinueOperations: null,
    ...preparation, ...reg,
    agentSendReceiptStore: native.store, agentSendReceiptRegistry: reg.createAgentSendReceiptRegistry(),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000,
    AGENT_SEND_RECEIPT_STATES: reg.RECEIPT_STATES,
    promptAuditFingerprint: require(path.join(mainDir, 'prompt-audit-fingerprint')).promptAuditFingerprint,
    isLocalSlashCommandPrompt: require(path.join(mainDir, 'agent-history-send-receipt')).isLocalSlashCommandPrompt,
    compactSendReceiptPresentation: require(path.join(mainDir, 'compact-send-settlement')).compactSendReceiptPresentation,
    compactSendDeliveryIdentity: require(path.join(root, 'src/shared/compact-send-delivery.cjs')).compactSendDeliveryIdentity,
    console: { log: (...a) => events.push(a.join(' ')), warn: (...a) => events.push(a.join(' ')), error: (...a) => events.push(a.join(' ')) },
    shortId: x => x, STRUCTURED_AUTHORING_LIMITS: { bytes: 8 * 1024 * 1024 },
    withPromptOriginPresentation: x => x,
    bindStructuredAuthoringPresentation: require(path.join(mainDir, 'structured-authoring')).bindStructuredAuthoringPresentation,
    agentSendTargetPreconditionFailure: require(path.join(mainDir, 'agent-send-target-precondition')).agentSendTargetPreconditionFailure,
    readAgentRuntimeSnapshot: null,
    findOrchestrationTabDescriptor: () => ({ projectId: 'P', toolType: 'codex', sessionId: 'S' }),
    tabWorkContext: { prepare: async (_tab, _handoff, prompt) => ({ prompt }), activate() {}, settle() {}, release() {} },
    bridgeRequest: async (action, payload) => {
      assert.equal(action, 'sendAgentPromptScenario');
      webCalls.push(payload);
      // Same renderer scenario is reached again with Main's immutable H/O/A.
      return renderer.sendAgentPromptScenario({ ...payload, toolType: 'codex', runtime,
        sessionId: 'S', settingsIntent: { kind: 'none' } });
    },
  });
  vm.runInContext(webCompactBindings(webFile) + '\n' + declarations(webFile, ['durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
    'publicAgentSendReceipt', 'durableAgentSendFailure', 'runPreparedAgentSendScenario', 'runAgentSendScenario',
    'runAfterCapacityBlocksNewSend', 'readScenarioDestination']), web);
  vm.runInContext('var enqueueDesktopAgentPrompt = ' + exported(webFile, 'enqueueDesktopAgentPrompt'), web);
  vm.runInContext('var projectQueuedSendReceipt = ' + exported(webFile, 'projectQueuedSendReceipt')
    + '; var applicationQueueInfo = ' + exported(webFile, 'applicationQueueInfo'), web);
  const queue = new AgentSendQueue({ store: native.store, now: native.clock.now,
    setTimer: native.clock.setTimer, clearTimer: native.clock.clearTimer,
    capturePreparationMode: () => 'cold-codex',
    execute: request => web.runPreparedAgentSendScenario({ ...request, applicationQueueExecution: true }) });
  web.agentSendQueue = queue;
  const handlers = new Map();
  vm.runInNewContext(registration(mainFile, 'agent:enqueue-prompt'), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, path, srcMainDir: mainDir,
    require: () => ({ enqueueDesktopAgentPrompt: web.enqueueDesktopAgentPrompt }), console: web.console,
  });
  vm.runInNewContext(registration(mainFile, 'agent:list-send-receipts'), {
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, path, srcMainDir: mainDir,
    require: name => name === path.join(mainDir, 'web-server') ? {
      projectQueuedSendReceipt: web.projectQueuedSendReceipt, applicationQueueInfo: web.applicationQueueInfo,
    } : require(name),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendReceiptStore: native.store,
    historySendReturnControl: require(path.join(mainDir, 'history-send-return')).historySendReturnControl,
    imagePresentationFromReceipt: require(path.join(mainDir, 'history-authoring-projection')).imagePresentationFromReceipt,
  });

  const renderer = vm.createContext({ ...modules,
    crypto: require('node:crypto'),
    console: { log: (...a) => events.push(a.join(' ')), warn: (...a) => events.push(a.join(' ')) },
    codexSendInflight: new Map(), shortTab: value => value,
    findTabRuntimeContext: () => ({ projectId: 'P' }), errorText: error => error?.message || String(error),
    useWorkspaceStore: { getState: () => ({ clearInterruptedState() {} }) },
    useUIStore: { getState: () => ({}) },
    terminalRegistry: { get: () => ({}), getDraftDiagnosticSnapshot: () => ({}),
      getCodexDraftState: () => ({ hasDraft: null, source: 'no-renderer', preview: '' }) },
    ipcRenderer: { invoke: async (channel, ...args) => {
      ipc.push({ channel, args });
      if (channel === 'agent:enqueue-prompt') {
        const result = await handlers.get(channel)(null, args[0]);
        if (holdFirstAdmissionReply) {
          holdFirstAdmissionReply = false;
          await admissionGate;
        }
        if (loseFirstAdmissionReply) {
          loseFirstAdmissionReply = false;
          throw new Error('controlled lost admission response after Main commit');
        }
        return result;
      }
      if (channel === 'codex:get-draft-state') return native.ctx.requestTerminalCodexDraftState(null, 'T',
        args[1].reason, args[1].timeoutMs, args[1]);
      if (channel === 'codex:send-live-slash-command') {
        const result = await native.ctx.executeCodexLiveSlashCommandRequest({ sender: null, ...args[0] });
        nativeResults.push(result);
        return result;
      }
      // This test stops at the ordinary-message IPC delivery boundary. Do not
      // forge a sender response or a user_message for the text follower.
      if (channel === 'codex:send-command') return textDelivery;
      assert.fail('unexpected IPC: ' + channel);
    } },
    prepareAgentRecordContext: async () => ({ complete: false, historyContextResult: null, restartPerformed: false }),
    prepareAgentRuntimeForSend: async () => { await ready; return { status: 'active', submitCapability: 'direct', presence: {} }; },
    prepareTabWorkContext: async (_tab, _handoff, prompt) => ({ prompt }),
    activateTabWorkContext: async () => {}, settleTabWorkContext: async () => {},
    agentSendSettingsContractError: () => null,
    getAgentSendProviderContract: () => ({ toolType: 'codex', carriesExactEmptyEvidence: false, passCancellationGuardToTransport: false }),
    showAgentDraftScreenContradictionToast() {}, isSubmittedCodexAuditTimeout: () => false,
  });
  const code = [
    declarations(path.join(rendererDir, 'agentSendPreparation.ts'), ['needsExactDraftCapture', 'buildDraftCaptureProof',
      'captureDraftWithOneCommittedFrameRefresh', 'proveAgentComposerForSend']),
    declarations(path.join(rendererDir, 'agentSendAdapter.ts'), ['createAgentSendAdapter']),
    declarations(path.join(rendererDir, 'historyAgentRuntimes.ts'), ['sendCodexPrompt', 'probeCodexDraft']),
    declarations(path.join(rendererDir, 'agentScenarios.ts'), ['normalizeStatus', 'runAgentPromptScenario',
      'sendAgentPromptScenario', 'stopAgentProcessScenario']),
  ].join('\n');
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText, renderer);
  const runtime = { toolType: 'codex', label: 'codex', probeDraft: renderer.probeCodexDraft,
    sendPrompt: renderer.sendCodexPrompt,
    grabDraft: async () => ({ success: true, text: 'untouched authoring', images: 0 }),
    copyDraft: async () => ({ success: true, text: 'untouched authoring', images: 0 }) };

  cleanup = async () => {
    queue.dispose();
    resolveReady(); releaseAdmission(); resolveTextDelivery({ success: false, submitted: false, pasteWritten: false,
      enterWritten: false, code: 'controlled-ipc-delivery-stopped' });
    native.change('stop'); await tick(200);
    modules.resetCoordinatedAgentActionsForTests();
  };
  function click(handoffId, prompt, extra = {}) {
    const started = modules.beginCoordinatedAgentSend('T', native.clock.now());
    if (!started.started) return { started };
    assert.equal(modules.bindCoordinatedAgentSendHandoff('T', started.token, handoffId).bound, true);
    const result = renderer.sendAgentPromptScenario({ tabId: 'T', toolType: 'codex', runtime, sessionId: 'S',
      prompt, handoffId, source: 'history-panel', statusAtSend: 'inactive', settingsIntent: { kind: 'none' },
      returnDraftOnConflict: true, coordinatedSendToken: started.token,
      presentationSnapshot: { promptChips: [], imagePaths: [] },
      authoringSnapshot: { editorText: prompt, chips: [], imagePaths: [] }, ...extra });
    return { started, result };
  }
  return { ...native, renderer, web, queue, modules, ipc, events, webCalls, nativeResults,
    click, resolveReady, resolveTextDelivery, releaseAdmission,
    readReceipt: async operationKey => {
      const result = await handlers.get('agent:list-send-receipts')(null, { tabId: 'T', operationKey });
      assert.equal(result.success, true); assert.equal(result.records.length, 1);
      return result.records[0];
    },
    taskStarted: ({ sessionId = 'S', processGeneration = 'L1', eventSequence = 6, byteOffset = 20 } = {}) =>
      native.ctx.deliverControlledNativeEvent({ tabId: 'T', sessionId, processGeneration },
        { payload: { type: 'task_started', turn_id: 'controlled-turn' }, __eventSequence: eventSequence, __byteOffset: byteOffset }) };
}

test('desktop History admits ordinary text while cold /compact still prepares', async t => {
  const h = await setup(t);
  const compact = h.click('compact', '/compact');
  assert.equal(compact.started.started, true);
  await tick(200);
  assert.equal(h.writes.length, 0, 'cold readiness is still unresolved');
  const follower = h.click('text', 'ordinary text');
  assert.equal(follower.started.started, true,
    'application ACK for /compact must release the actual History coordinator before CLI readiness');
  const ack = await follower.result;
  assert.equal(ack.applicationQueued, true, JSON.stringify(ack) + '\n' + h.events.join('\n'));
  assert.equal(ack.handoffId, 'text');
  assert.equal(ack.operationKey, 'history:T:text');
  assert.equal(h.store.get(ack.operationKey).attemptId, null);
  assert.equal(h.queue.item(ack.operationKey).preparation_started_at, null);
  const firstHead = h.store.get('history:T:compact');
  assert.ok(firstHead?.attemptId);
  const firstClock = firstHead.receipt.preflightScope.preparation;
  const replay = h.click('compact', '/compact');
  assert.equal(replay.started.started, true);
  await replay.result;
  await tick(100);
  assert.equal(h.webCalls.filter(call => call.handoffId === 'compact').length, 1,
    'the same H joins existing admission instead of another physical attempt');
  assert.equal(h.store.get('history:T:compact').attemptId, firstHead.attemptId);
  assert.deepEqual(h.store.get('history:T:compact').receipt.preflightScope.preparation, firstClock);
  const waitingRecord = await h.readReceipt(ack.operationKey);
  const beforeReload = await freshHistoryProjection();
  const firstProjection = beforeReload.hydrateHistoryPromptHandoffFromDurableReceipt(waitingRecord);
  assert.equal(firstProjection.hydrated, true);
  assert.equal(firstProjection.handoff.queueStatus, 'application-queued');
  assert.equal(firstProjection.handoff.sendAttemptId, null);
  const originalCompactProjection = beforeReload.hydrateHistoryPromptHandoffFromDurableReceipt(
    await h.readReceipt('history:T:compact'));
  assert.equal(originalCompactProjection.hydrated, true);
  const afterReload = await freshHistoryProjection();
  const restored = afterReload.hydrateHistoryPromptHandoffFromDurableReceipt(waitingRecord);
  assert.equal(restored.hydrated, true);
  assert.equal(restored.handoff.queueStatus, 'application-queued');
  assert.equal(restored.handoff.sendAttemptId, null);
  assert.equal(restored.handoff.text, 'ordinary text');
  const compactAck = await compact.result;
  assert.equal(compactAck.applicationQueued, true);
  assert.equal(compactAck.handoffId, 'compact');
  assert.equal(compactAck.operationKey, 'history:T:compact');
  assert.equal(h.webCalls.length, 1, 'only the compact is at physical HEAD');
  assert.equal(h.webCalls[0].handoffId, 'compact');
  assert.ok(h.webCalls[0].sendAttemptId);
  assert.equal(h.store.get(ack.operationKey).attemptId, null);
  const originalFollower = h.queue.item(ack.operationKey).request_json;
  h.clock.advance(30_000);
  assert.equal(h.queue.item(ack.operationKey).preparation_started_at, null,
    'a waiting follower does not spend its own HEAD preparation clock');
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1, h.events.join('\n'));
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1, h.events.join('\n'));
  assert.equal(h.store.get('history:T:compact').compactStartIdentity ?? null, null,
    'paste and Enter are not native start proof');
  assert.equal(h.store.get(ack.operationKey).attemptId, null);
  // Real provider acceptance has already removed the submitted slash from its
  // composer when task_started arrives. Both are controlled external signals.
  h.frame(''); h.taskStarted(); await tick(300);
  const storedCompact = h.store.get('history:T:compact');
  assert.ok(storedCompact.compactStartIdentity, 'the bound post-Enter task_started minted exact Main proof');
  assert.equal(storedCompact.auditIdentity, null, 'local command did not fabricate a canonical user message');
  assert.equal(h.registry.getActive('T', 'codex')?.active, true, 'compact final is deliberately withheld');
  const confirmedProjection = await h.readReceipt('history:T:compact');
  assert.deepEqual(confirmedProjection.compactStartIdentity, storedCompact.compactStartIdentity,
    'the actual Main IPC read preserves the private proof across hydration');
  const consumedCompact = beforeReload.hydrateHistoryPromptHandoffFromDurableReceipt(confirmedProjection);
  assert.equal(consumedCompact.reason, 'durable-history-local-command-confirmed');
  assert.equal(beforeReload.getHistoryPromptHandoffsSnapshot('T').some(row => row.handoffId === 'compact'), false,
    'the matching local handoff is consumed, not converted into a canonical SENT user row');
  const coldReload = await freshHistoryProjection();
  const coldResult = coldReload.hydrateHistoryPromptHandoffFromDurableReceipt(confirmedProjection);
  assert.equal(coldResult.hydrated, false);
  assert.equal(coldResult.reason, 'durable-history-local-command-confirmed');
  assert.equal(coldReload.getHistoryPromptHandoffsSnapshot('T').length, 0,
    'cold hydration cannot invent a new user row for the command');
  h.taskStarted(); await tick(100);
  assert.deepEqual(h.store.get('history:T:compact').compactStartIdentity, storedCompact.compactStartIdentity,
    'duplicate native event does not create another proof or input');
  await tick(300);
  assert.equal(h.queue.item(ack.operationKey).request_json, originalFollower);
  assert.ok(h.store.get(ack.operationKey).attemptId, 'the ordinary message is now Main HEAD');
  assert.equal(h.webCalls.filter(call => call.handoffId === 'text').length, 1);
  const messages = h.ipc.filter(call => call.channel === 'codex:send-command');
  assert.equal(messages.length, 1, h.events.join('\n'));
  assert.equal(messages[0].args[1], 'ordinary text');
  assert.equal(messages[0].args[2].sendOperationKey, ack.operationKey);
  assert.equal(messages[0].args[2].sendAttemptId, h.store.get(ack.operationKey).attemptId);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.resolveTextDelivery({ success: false, submitted: false, pasteWritten: false, enterWritten: false,
    code: 'controlled-ipc-delivery-stopped' });
  await tick(200);
});

test('History return before cold Compact input keeps the exact authoring and cannot late-write', async t => {
  const h = await setup(t);
  const control = require(path.join(mainDir, 'history-send-return')).historySendReturnControl(h.store);
  const owner = { tabId: 'T', handoffId: 'returned', token: 'user-return-token', provider: 'codex' };
  assert.equal(control.register(owner).success, true);
  const authoringSnapshot = { editorText: '/compact', chips: [], imagePaths: [] };
  const click = h.click('returned', '/compact', { authoringSnapshot });
  assert.equal((await click.result).applicationQueued, true);
  await tick(150);
  assert.equal(control.request(owner).returned, true);
  assert.deepEqual(h.queue.authoringSnapshot('T', 'returned'), authoringSnapshot);
  h.frame(''); h.resolveReady(); await tick(400);
  assert.equal(h.writes.length, 0, 'the real payload write remains fenced after return');
  assert.equal(h.store.get('history:T:returned').receipt.submitted, false);
  assert.deepEqual(h.queue.authoringSnapshot('T', 'returned'), authoringSnapshot);
});

test('lost application ACK and exact same-H retry do not duplicate Compact or renew its clock', async t => {
  const h = await setup(t, { loseFirstAdmissionReply: true });
  const first = h.click('lost', '/compact');
  const unknown = await first.result;
  assert.equal(unknown.code, 'agent_send_admission_ack_unknown');
  assert.equal(unknown.deliveryUnknown, true);
  await tick(200);
  const key = 'history:T:lost', original = h.store.get(key);
  assert.ok(original.attemptId);
  const scope = original.receipt.preflightScope.preparation;
  const initialRequest = h.queue.item(key).request_json;
  h.clock.advance(5000);
  const replay = h.click('lost', '/compact');
  await replay.result; await tick(200);
  const current = h.store.get(key);
  assert.equal(current.attemptId, original.attemptId);
  assert.deepEqual(current.receipt.preflightScope.preparation, scope);
  assert.equal(h.queue.item(key).request_json, initialRequest);
  assert.equal(h.webCalls.filter(call => call.handoffId === 'lost').length, 1);
  assert.equal(h.writes.length, 0);
  const follower = h.click('later', 'later text');
  assert.equal((await follower.result).applicationQueued, true);
  assert.equal(h.store.get('history:T:later').attemptId, null);
  assert.equal(h.queue.item('history:T:later').preparation_started_at, null);
});

test('cancelling a waiting History follower keeps its own authoring and never enters PTY after Compact start', async t => {
  const h = await setup(t);
  const compact = h.click('cancel-head', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const authoring = { editorText: 'keep me', chips: [], imagePaths: [] };
  const later = h.click('cancelled', 'keep me', { authoringSnapshot: authoring });
  assert.equal((await later.result).applicationQueued, true);
  const cancelled = h.queue.cancelWaiting('T', 'cancelled', { dismiss: false });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(h.queue.authoringSnapshot('T', 'cancelled'), authoring);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1, h.events.join('\n'));
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.frame(''); h.taskStarted(); await tick(300);
  assert.equal(h.store.get('history:T:cancelled').attemptId, null);
  assert.equal(h.webCalls.filter(call => call.handoffId === 'cancelled').length, 0);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-command').length, 0);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
});

test('unconfirmed Compact Enter holds the follower until a late exact start, without replay or clock renewal', async t => {
  const h = await setup(t);
  const compact = h.click('unknown', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const later = h.click('after-unknown', 'later text');
  assert.equal((await later.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1, h.events.join('\n'));
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const first = h.store.get('history:T:unknown');
  const originalAttempt = first.attemptId, originalClock = first.receipt.preflightScope.preparation;
  h.clock.advance(5000); await tick(400);
  const unconfirmed = h.store.get('history:T:unknown');
  assert.notEqual(unconfirmed.state, 'confirmed');
  assert.equal(unconfirmed.compactStartIdentity ?? null, null);
  assert.equal(h.registry.getPending('T', 'codex')?.operationId, 'codex:api:unknown');
  assert.equal(h.store.get('history:T:after-unknown').attemptId, null);
  assert.equal(h.queue.item('history:T:after-unknown').preparation_started_at, null);
  for (const invalid of [{ eventSequence: 5 }, { byteOffset: 9 },
    { sessionId: 'foreign-session' }, { processGeneration: 'foreign-generation' }]) {
    h.taskStarted(invalid); await tick(50);
    assert.equal(h.store.get('history:T:unknown').compactStartIdentity ?? null, null);
    assert.equal(h.store.get('history:T:after-unknown').attemptId, null);
  }
  const same = h.click('unknown', '/compact');
  await same.result; await tick(150);
  assert.equal(h.store.get('history:T:unknown').attemptId, originalAttempt);
  assert.deepEqual(h.store.get('history:T:unknown').receipt.preflightScope.preparation, originalClock);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.frame(''); h.taskStarted(); await tick(400);
  assert.ok(h.store.get('history:T:unknown').compactStartIdentity);
  assert.ok(h.store.get('history:T:after-unknown').attemptId);
  assert.equal(h.webCalls.filter(call => call.handoffId === 'after-unknown').length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.resolveTextDelivery({ success: false, submitted: false, pasteWritten: false, enterWritten: false,
    code: 'controlled-ipc-delivery-stopped' });
  await tick(200);
});

test('failed SQLite start publication recovers from the exact original native acknowledgement', async t => {
  const h = await setup(t);
  let failPrivateWrite = true;
  let privateWriteAttempts = 0;
  h.store.db.function('test_fail_compact_start_write', () => {
    privateWriteAttempts++;
    return failPrivateWrite ? 1 : 0;
  });
  h.store.db.exec(`CREATE TRIGGER test_fail_compact_start_write
    BEFORE UPDATE OF compact_start_identity_json ON agent_send_receipts
    WHEN NEW.compact_start_identity_json IS NOT NULL AND test_fail_compact_start_write() = 1
    BEGIN SELECT RAISE(ABORT, 'controlled_compact_start_write_failure'); END`);
  const compact = h.click('disk-fault', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const later = h.click('after-disk-fault', 'later text');
  assert.equal((await later.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.frame(''); h.taskStarted();
  assert.equal(privateWriteAttempts, 1, 'the first native publication really hit the injected SQLite fault');
  assert.equal(h.store.get('history:T:disk-fault').compactStartIdentity ?? null, null);
  failPrivateWrite = false; // Storage recovers before the actual renderer reply.
  await tick(400);
  const key = 'history:T:disk-fault', original = h.store.get(key);
  assert.notEqual(original.state, 'not-submitted', 'the already entered command is never reclassified as no-write');
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const exactActive = h.registry.getActive('T', 'codex');
  assert.equal(exactActive?.causalStartConfirmed, true);
  // No test-origin republish or completion: only the original physical
  // executor's native acknowledgement may recover this same observation.
  t.diagnostic(JSON.stringify({ stateAfterBridge: original.state, privateProof: !!original.compactStartIdentity,
    compactActive: exactActive.active, queueState: h.queue.item(key)?.state,
    followerAttempt: h.store.get('history:T:after-disk-fault')?.attemptId }));
  assert.ok(h.store.get(key).compactStartIdentity,
    'the pre-Enter-bound current operation must not be confused with an unproven historical display-only receipt');
  assert.equal(privateWriteAttempts, 2, 'the native executor retried this exact already-observed start once');
  assert.equal(original.compactStartIdentity.operationId, exactActive.operationId);
  assert.equal(original.compactStartIdentity.attemptId, original.attemptId);
  assert.equal(original.compactStartIdentity.taskStartedEventSequence, exactActive.causalStartEventSequence);
  assert.equal(original.compactStartIdentity.taskStartedByteOffset, exactActive.causalStartByteOffset);
  assert.equal(h.registry.getActive('T', 'codex')?.active, true, 'do not wait for Compact final');
  assert.ok(h.store.get('history:T:after-disk-fault').attemptId);
  assert.equal(h.webCalls.filter(call => call.handoffId === 'after-disk-fault').length, 1);
  const followerWrites = h.ipc.filter(call => call.channel === 'codex:send-command');
  assert.equal(followerWrites.length, 1, 'the same queued follower reaches its normal IPC boundary once');
  assert.equal(followerWrites[0].args[1], 'later text');
  assert.equal(followerWrites[0].args[2].sendAttemptId, h.store.get('history:T:after-disk-fault').attemptId);
  assert.equal(h.store.get(key).auditIdentity, null);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.resolveTextDelivery({ success: false, submitted: false, pasteWritten: false, enterWritten: false,
    code: 'controlled-ipc-delivery-stopped' });
  await tick(200);
});

test('persistent SQLite Compact start failure stays UNKNOWN and cannot release the follower', async t => {
  const h = await setup(t);
  let privateWriteAttempts = 0;
  h.store.db.function('test_keep_failing_compact_start_write', () => { privateWriteAttempts++; return 1; });
  h.store.db.exec(`CREATE TRIGGER test_keep_failing_compact_start_write
    BEFORE UPDATE OF compact_start_identity_json ON agent_send_receipts
    WHEN NEW.compact_start_identity_json IS NOT NULL AND test_keep_failing_compact_start_write() = 1
    BEGIN SELECT RAISE(ABORT, 'controlled_persistent_compact_start_write_failure'); END`);
  const compact = h.click('disk-still-faulty', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const follower = h.click('after-persistent-fault', 'later text');
  assert.equal((await follower.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.frame(''); h.taskStarted(); await tick(400);
  const key = 'history:T:disk-still-faulty';
  const record = h.store.get(key);
  const projection = await h.readReceipt(key);
  const publicReceipt = h.web.publicAgentSendReceipt(record);
  const history = await freshHistoryProjection();
  const hydration = history.hydrateHistoryPromptHandoffFromDurableReceipt(projection);
  t.diagnostic(JSON.stringify({ privateWriteAttempts, state: record.state, receiptStatus: record.receipt?.status,
    submitted: record.receipt?.submitted, publicStatus: publicReceipt.status, publicSubmitted: publicReceipt.submitted,
    exactAuditConfirmed: publicReceipt.exactAuditConfirmed, hydrationReason: hydration.reason,
    hydrationStatus: hydration.handoff?.queueStatus,
    queueState: h.queue.item(key)?.state,
    followerAttempt: h.store.get('history:T:after-persistent-fault')?.attemptId }));
  assert.equal(privateWriteAttempts, 2, 'the original observation and its single executor retry both failed');
  assert.equal(h.registry.getActive('T', 'codex')?.causalStartConfirmed, true);
  assert.equal(record.compactStartIdentity ?? null, null);
  assert.equal(record.state, 'delivery-unknown', 'missing durable native proof cannot become confirmed');
  assert.equal(record.receipt?.deliveryUnconfirmed, true, 'the actual executor reported its unconfirmed persistence');
  assert.equal(record.receipt?.deliveryUnknown, true);
  assert.equal(projection.state, record.state);
  assert.equal(publicReceipt.status, 'delivery-unknown');
  assert.notEqual(publicReceipt.exactAuditConfirmed, true);
  assert.equal(hydration.hydrated, true);
  assert.equal(hydration.handoff?.queueStatus, 'delivery-unknown');
  assert.equal(h.store.get('history:T:after-persistent-fault').attemptId, null);
  assert.equal(h.webCalls.filter(call => call.handoffId === 'after-persistent-fault').length, 0);
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-command').length, 0);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const Database = require('better-sqlite3');
  const snapshotDb = new Database(h.store.db.serialize());
  try {
    // SQLite serializes the test trigger, not its connection-local function.
    // Re-register the same fault on the reconstructed private connection.
    snapshotDb.function('test_keep_failing_compact_start_write', () => 1);
    const restored = require(path.join(mainDir, 'agent-send-receipt-store')).createAgentSendReceiptStore(snapshotDb);
    restored.reconcileStartup();
    assert.equal(restored.get(key).state, 'delivery-unknown', 'restart preserves an unconfirmed, not SENT, receipt');
    assert.equal(restored.get(key).compactStartIdentity ?? null, null);
    assert.equal(restored.get(key).receipt?.deliveryUnconfirmed, true);
    const dispatches = [];
    const restoredQueue = new (require(path.join(mainDir, 'agent-send-queue')).AgentSendQueue)({ store: restored,
      execute: request => { dispatches.push(request.handoffId); return new Promise(() => {}); } });
    restoredQueue.resume(); await tick(300); restoredQueue.dispose();
    assert.deepEqual(dispatches, []);
    assert.equal(restored.get('history:T:after-persistent-fault').attemptId, null);
  } finally { snapshotDb.close(); }
});

test('restart after Compact Enter but before native start preserves UNKNOWN instead of no-write', async t => {
  const h = await setup(t);
  const compact = h.click('crash-after-enter', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const later = h.click('after-crash', 'later text');
  assert.equal((await later.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const key = 'history:T:crash-after-enter', before = h.store.get(key);
  assert.equal(before.compactStartIdentity ?? null, null);
  const Database = require('better-sqlite3');
  const snapshotDb = new Database(h.store.db.serialize());
  try {
    const restored = require(path.join(mainDir, 'agent-send-receipt-store')).createAgentSendReceiptStore(snapshotDb);
    restored.reconcileStartup();
    const after = restored.get(key);
    const dispatches = [];
    const restoredQueue = new (require(path.join(mainDir, 'agent-send-queue')).AgentSendQueue)({ store: restored,
      // Observation boundary only: never claims that this follower was sent.
      execute: request => { dispatches.push(request.handoffId); return new Promise(() => {}); } });
    restoredQueue.resume(); await tick(300);
    t.diagnostic(JSON.stringify({ stateBeforeCrash: before.state, stateAfterRestart: after.state,
      submittedAfterRestart: after.receipt?.submitted, errorCode: after.receipt?.code,
      headQueueState: snapshotDb.prepare('SELECT state FROM agent_send_queue WHERE operation_key=?').get(key)?.state,
      followerAttempt: restored.get('history:T:after-crash')?.attemptId, resumedDispatches: dispatches }));
    restoredQueue.dispose();
    assert.equal(after.state, 'delivery-unknown',
      'a restart cannot infer no Enter after the bound native command may have received it');
    assert.notEqual(after.receipt?.submitted, false);
    assert.equal(restored.get('history:T:after-crash').attemptId, null);
    assert.deepEqual(dispatches, [], 'an unproven post-Enter head cannot release the next writer');
  } finally { snapshotDb.close(); }
});

test('failed durable Compact arm refuses Enter and preserves the original authoring', async t => {
  const h = await setup(t);
  h.store.db.exec(`CREATE TRIGGER test_refuse_compact_arm BEFORE UPDATE OF state ON agent_send_receipts
    WHEN NEW.state = 'enter-armed' BEGIN SELECT RAISE(ABORT, 'controlled_arm_write_failure'); END`);
  const authoring = { editorText: '/compact', chips: [], imagePaths: [] };
  const control = require(path.join(mainDir, 'history-send-return')).historySendReturnControl(h.store);
  const returnOwner = { tabId: 'T', handoffId: 'arm-refused', token: 'arm-refused-token', provider: 'codex' };
  assert.equal(control.register(returnOwner).success, true);
  const compact = h.click('arm-refused', '/compact', { authoringSnapshot: authoring });
  assert.equal((await compact.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  h.frame('/compact'); await tick(400);
  const record = h.store.get('history:T:arm-refused');
  t.diagnostic(JSON.stringify({ state: record.state, code: record.receipt?.code || record.receipt?.error,
    submitted: record.receipt?.submitted, rollback: record.receipt?.slashRollback,
    retainedInput: !!h.settingsQueue.getUnsubmittedInput(h.term) }));
  assert.equal(h.writes.filter(value => value === '\r').length, 0, 'no durable arm means no possible Enter');
  assert.notEqual(record.receipt?.submitted, true);
  assert.equal(record.receipt?.error, 'agent_send_enter_not_durably_armed',
    'a proven storage refusal must not be mislabeled as an unconfirmed native start');
  assert.equal(record.compactStartIdentity ?? null, null);
  assert.deepEqual(h.queue.authoringSnapshot('T', 'arm-refused'), authoring);
  assert.ok(record.receipt?.slashRollback?.cleared === true
    || record.receipt?.slashRollback?.serviceInputPending === true
    || !!h.settingsQueue.getUnsubmittedInput(h.term),
  'the owned slash is cleared or still retained under the existing native input owner');
});

test('Compact arm receipt-read failure refuses Enter with the precise storage reason', async t => {
  const h = await setup(t);
  const authoring = { editorText: '/compact', chips: [], imagePaths: [] };
  const compact = h.click('arm-read-refused', '/compact', { authoringSnapshot: authoring });
  assert.equal((await compact.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  const originalGet = h.store.get.bind(h.store);
  let readsFailed = 0;
  h.store.get = (...args) => {
    if (args[0] === 'history:T:arm-read-refused' && new Error().stack?.includes('writeOwnedEnter')) {
      readsFailed++;
      throw Object.assign(new Error('controlled_arm_read_failure'), { code: 'SQLITE_IOERR' });
    }
    return originalGet(...args);
  };
  try { h.frame('/compact'); await tick(400); }
  finally { h.store.get = originalGet; }
  const record = h.store.get('history:T:arm-read-refused');
  t.diagnostic(JSON.stringify({ readsFailed, state: record.state, code: record.receipt?.code,
    error: record.receipt?.error, submitted: record.receipt?.submitted,
    rollback: record.receipt?.slashRollback }));
  assert.equal(readsFailed, 1, 'fault hit the Main receipt read directly before the physical Enter');
  assert.equal(h.writes.filter(value => value === '\r').length, 0);
  assert.equal(record.state, 'not-submitted');
  assert.equal(record.receipt?.error, 'agent_send_enter_not_durably_armed');
  assert.equal(record.receipt?.submitted, false);
  assert.deepEqual(h.queue.authoringSnapshot('T', 'arm-read-refused'), authoring);
  assert.ok(record.receipt?.slashRollback?.cleared === true
    || record.receipt?.slashRollback?.serviceInputPending === true
    || !!h.settingsQueue.getUnsubmittedInput(h.term));
});

test('Compact Enter throw after durable arm remains UNKNOWN through restart and does not release the follower', async t => {
  const h = await setup(t, { throwEnter: true });
  const compact = h.click('enter-threw', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const follower = h.click('after-throw', 'later text');
  assert.equal((await follower.result).applicationQueued, true);
  let atPhysicalWrite;
  const originalWrite = h.term.write;
  h.term.write = function (value) {
    try { return originalWrite.call(this, value); }
    finally { if (value === '\r') atPhysicalWrite = h.store.db.serialize(); }
  };
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  h.frame('/compact'); await tick(400);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  assert.ok(atPhysicalWrite, 'snapshot is captured synchronously at the attempted write');
  const Database = require('better-sqlite3');
  const snapshotDb = new Database(atPhysicalWrite);
  try {
    const restored = require(path.join(mainDir, 'agent-send-receipt-store')).createAgentSendReceiptStore(snapshotDb);
    const before = restored.get('history:T:enter-threw');
    assert.equal(before.state, 'enter-armed');
    restored.reconcileStartup();
    const after = restored.get('history:T:enter-threw');
    assert.equal(after.state, 'delivery-unknown');
    assert.notEqual(after.receipt?.submitted, false);
    const dispatches = [];
    const restoredQueue = new (require(path.join(mainDir, 'agent-send-queue')).AgentSendQueue)({ store: restored,
      execute: request => { dispatches.push(request.handoffId); return new Promise(() => {}); } });
    restoredQueue.resume(); await tick(300); restoredQueue.dispose();
    assert.deepEqual(dispatches, []);
    assert.equal(restored.get('history:T:after-throw').attemptId, null);
  } finally { snapshotDb.close(); }
  const live = h.store.get('history:T:enter-threw');
  assert.notEqual(live.receipt?.submitted, false);
  assert.equal(live.compactStartIdentity ?? null, null);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
});

test('Compact autocomplete can perform its exact proof-owned second Enter after durable arm', async t => {
  const h = await setup(t);
  const compact = h.click('autocomplete', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const first = h.store.get('history:T:autocomplete');
  assert.equal(first.state, 'enter-armed');
  h.clock.advance(1000);
  h.frame('/compact'); await tick(300);
  const record = h.store.get('history:T:autocomplete');
  t.diagnostic(JSON.stringify({ state: record.state, error: record.receipt?.error || null,
    enterCount: h.writes.filter(value => value === '\r').length,
    firstLease: first.inputLease, currentLease: record.inputLease }));
  assert.equal(h.writes.filter(value => value === '\r').length, 2,
    'a newer exact committed owned slash frame authorizes the existing native autocomplete path');
  assert.deepEqual(record.inputLease, first.inputLease, 'the second Enter retains the original durable lease and clock');
  h.clock.advance(1000); h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 2,
    'further owned frames cannot authorize a third Enter');
  h.frame(''); h.taskStarted(); await tick(300);
  assert.ok(h.store.get('history:T:autocomplete').compactStartIdentity);
  assert.equal(h.writes.filter(value => value === '\r').length, 2);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
});

test('Compact second-Enter receipt-read failure cannot erase the first possible Enter', async t => {
  const h = await setup(t);
  const compact = h.click('second-arm-read-refused', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  const follower = h.click('after-second-arm-refused', 'later text');
  assert.equal((await follower.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const first = h.store.get('history:T:second-arm-read-refused');
  assert.equal(first.state, 'enter-armed');
  const originalGet = h.store.get.bind(h.store);
  let readsFailed = 0;
  h.store.get = (...args) => {
    if (args[0] === first.operationKey && new Error().stack?.includes('writeOwnedEnter')) {
      readsFailed++;
      throw Object.assign(new Error('controlled_second_arm_read_failure'), { code: 'SQLITE_IOERR' });
    }
    return originalGet(...args);
  };
  try { h.clock.advance(1000); h.frame('/compact'); await tick(400); }
  finally { h.store.get = originalGet; }
  const record = h.store.get(first.operationKey);
  assert.equal(readsFailed, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1, 'the failed second arm writes no Enter');
  assert.notEqual(record.state, 'not-submitted', 'the already attempted first Enter is not negative proof');
  assert.notEqual(record.receipt?.submitted, false);
  assert.equal(record.compactStartIdentity ?? null, null);
  assert.equal(h.store.get('history:T:after-second-arm-refused').attemptId, null);
  assert.equal(h.registry.getPending('T', 'codex')?.operationId, 'codex:api:second-arm-read-refused');
  h.frame(''); h.taskStarted(); await tick(300);
  assert.ok(h.store.get(first.operationKey).compactStartIdentity, 'late exact start can still settle the original operation');
  assert.equal(h.ipc.filter(call => call.channel === 'codex:send-command').length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.resolveTextDelivery({ success: false, submitted: false, pasteWritten: false, enterWritten: false,
    code: 'controlled-ipc-delivery-stopped' });
  await tick(200);
});

function runActualPanelReceiptBranch({ projection, record, receiptRead, receiptOwner, rows = [], meta = null }) {
  const panelFile = path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx');
  const panel = fs.readFileSync(panelFile, 'utf8');
  const anchor = panel.indexOf('// Project API/iOS/Terminal MCP own their external composer');
  const start = panel.indexOf("if (record?.surface !== 'desktop-history') continue;", anchor);
  const end = panel.indexOf('if (outcome.restorableDraft', start);
  assert.ok(anchor >= 0 && start > anchor && end > start, 'actual complete History capture/hydrate/removal branch');
  let entries = rows.slice();
  const presentationEntriesRef = { current: entries };
  const promptHandoffMetaRef = { current: new Map(meta ? [[record.handoffId, meta]] : []) };
  const context = vm.createContext({ ...projection, tabId: 'T', record, hydrated: 0, receiptOwner,
    scopeCurrent: () => receiptRead.isCurrent(), ownsRecord: () => receiptRead.isCurrent() && receiptOwner.isCurrent(),
    useCallback: fn => fn, getLocalPromptMetaOwner: value => value?.owner || null,
    historyOwnerKeyRef: { current: 'controlled-owner' }, historyOwnerGenerationRef: { current: 1 },
    historySnapshotOwner: {}, promptHandoffMetaRef, presentationEntriesRef,
    suppressedPromptsRef: { current: new Map() }, isLocalPromptEntry: value => value?.local === true,
    setEntries: update => { entries = update(entries); presentationEntriesRef.current = entries; },
    publishHistoryRows: (_next, current) => current(), persistVolatileOverlay() {},
    setPrimarySuppressionRevision() {}, historyDiag() {} });
  const code = ['captureLocalPromptRemoval', 'removeLocalPromptEntry', 'consumeLocalPromptEntry']
    .map(name => nestedDeclaration(panelFile, name)).join('\n')
    + '\nfor (const record of [globalThis.record]) {\n' + panel.slice(start, end) + '\n}';
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText, context);
  return { get entries() { return entries; }, promptHandoffMetaRef };
}

function runActualPanelDelayedAdmissionBranch({ projection, result, rows = [] }) {
  const panelFile = path.join(root, 'src/renderer/components/Workspace/HistoryPanel.tsx');
  const statusCalls = [];
  let entries = rows.slice();
  const context = vm.createContext({ ...projection, result, actionTabId: 'T', tabId: 'T',
    handoffId: result.handoffId, sessionId: 'S', sendOwnershipTransferred: false,
    sendTransferredQueueStatus: null, statusCalls, useCallback: fn => fn,
    removeHistorySendRecovery() {}, getLocalPromptMetaOwner: value => value?.owner || null,
    promptHandoffMetaRef: { current: new Map() }, primaryPromptAppendPendingRef: { current: new Map() },
    primaryPhysicalCandidate: false, primaryRootRef: { current: null },
    historySnapshotOwner: {}, rawServerEntriesRef: { current: [] },
    suppressedPromptsRef: { current: new Map() }, localPromptMetaOwnersRef: { current: new Map() },
    LOCAL_PROMPT_PREFIX: 'controlled-local:', isLocalPromptEntry: value => value?.local === true,
    serverHasPromptEntry: () => false, capturePrimaryPromptAdoption: () => null,
    primaryPromptPublicationFingerprint: () => '',
    setEntries: update => { entries = update(entries); }, publishHistoryRows: () => true,
    persistVolatileOverlay() {}, setPrimarySuppressionRevision() {}, historyDiag() {} });
  const branch = nestedIf(panelFile,
    'result?.applicationQueued === true && result?.applicationQueue?.version === 1', 'onPromptStatusChange');
  const code = nestedDeclaration(panelFile, 'updateLocalPromptEntry')
    + '\nconst onPromptStatusChange = (...args) => { statusCalls.push(args); return updateLocalPromptEntry(...args); };'
    + '\nfunction applyDelayedAdmission() {\n' + branch + '\n}\napplyDelayedAdmission();';
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText, context);
  return { entries, statusCalls, transferred: context.sendOwnershipTransferred };
}

async function compactHydrationReplacementRace(t, sameAttempt) {
  const h = await setup(t);
  const compact = h.click('panel-race', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  const projection = await freshHistoryProjection();
  const initial = projection.hydrateHistoryPromptHandoffFromDurableReceipt(await h.readReceipt('history:T:panel-race'));
  assert.equal(initial.hydrated, true);
  const originalAttempt = initial.handoff.sendAttemptId;
  assert.ok(originalAttempt);
  let replacement;
  const unsubscribe = projection.subscribeHistoryPromptHandoffs('T', (_snapshot, change) => {
    if (change.type === 'consume' && change.handoffId === 'panel-race' && !replacement) {
      replacement = projection.beginHistoryPromptHandoff({ tabId: 'T', handoffId: 'panel-race', toolType: 'codex',
        text: 'new owner', sessionIdHint: 'S', sendOperationKey: 'history:T:panel-race',
        sendAttemptId: sameAttempt ? originalAttempt : 'new-attempt', submittedAt: 2000, initialStatus: 'sending' });
    }
  });
  h.frame(''); h.taskStarted(); await tick(300);
  const record = await h.readReceipt('history:T:panel-race');
  assert.ok(record.compactStartIdentity);
  const receiptRead = projection.beginHistorySendReceiptRead('T', { observePendingHandoffChanges: true });
  assert.equal(receiptRead.adoptList(), true);
  const receiptOwner = projection.captureHistoryReceiptRecoveryOwner(record);
  assert.equal(receiptOwner.isCurrent(), true);
  runActualPanelReceiptBranch({ projection, record, receiptRead, receiptOwner });
  unsubscribe(); receiptOwner.dispose(); receiptRead.close();
  assert.ok(replacement, 'a real synchronous consume listener installed a replacement');
  const current = projection.getHistoryPromptHandoffsSnapshot('T').find(row => row.handoffId === 'panel-race');
  assert.equal(current, replacement,
    'the old receipt must never recapture and consume the new History owner');
}
for (const sameAttempt of [false, true]) {
  test('Compact hydration cannot recapture a reentrant replacement History owner with '
    + (sameAttempt ? 'same H/O/A' : 'different A'), t => compactHydrationReplacementRace(t, sameAttempt));
}

test('Compact hydration removes only exact cached rows when there is no live handoff owner', async t => {
  const h = await setup(t);
  const compact = h.click('cached-race', '/compact');
  assert.equal((await compact.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  h.frame('/compact'); await tick(300);
  h.frame(''); h.taskStarted(); await tick(300);
  const record = await h.readReceipt('history:T:cached-race');
  assert.ok(record.compactStartIdentity);
  const old = { local: true, handoffId: record.handoffId,
    sendOperationKey: record.operationKey, sendAttemptId: record.attemptId };
  const replacement = { ...old, sendAttemptId: 'replacement-attempt' };
  const newerMeta = { owner: {}, sendOperationKey: record.operationKey, sendAttemptId: 'replacement-attempt' };
  for (const item of [
    { rows: [old], expected: [] },
    { rows: [replacement], expected: [replacement] },
    { rows: [old, replacement], expected: [replacement] },
    { rows: [old], meta: newerMeta, expected: [old] },
  ]) {
    const projection = await freshHistoryProjection();
    assert.equal(projection.getHistoryPromptHandoffsSnapshot('T').length, 0);
    const receiptRead = projection.beginHistorySendReceiptRead('T', { observePendingHandoffChanges: true });
    assert.equal(receiptRead.adoptList(), true);
    const receiptOwner = projection.captureHistoryReceiptRecoveryOwner(record);
    const result = runActualPanelReceiptBranch({ projection, record, receiptRead, receiptOwner, ...item });
    assert.deepEqual(result.entries, item.expected,
      'an old receipt cannot remove a cached row or metadata belonging to a different attempt');
    if (item.meta) assert.equal(result.promptHandoffMetaRef.current.get(record.handoffId), newerMeta);
    receiptOwner.dispose(); receiptRead.close();
  }
});

test('late native result and delayed application ACK do not recreate a compact handoff already consumed by proof', async t => {
  const h = await setup(t, { holdFirstAdmissionReply: true });
  const projection = await freshHistoryProjection();
  let releaseNativeResult;
  const nativeResultGate = new Promise(resolve => { releaseNativeResult = resolve; });
  const appRun = projection.runHistoryPromptHandoff({ tabId: 'T', handoffId: 'late-compact-result',
    toolType: 'codex', sessionIdHint: 'S', text: '/compact', source: 'history-panel',
    send: () => nativeResultGate });
  assert.equal(projection.getHistoryPromptHandoffsSnapshot('T').length, 1);
  const click = h.click('late-compact-result', '/compact');
  await tick(200);
  h.frame(''); h.resolveReady(); await tick(300);
  h.frame('/compact'); await tick(300);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
  h.frame(''); h.taskStarted(); await tick(400);
  assert.equal(h.nativeResults.length, 1, 'the real extracted Main executor has returned its native result');
  assert.equal(h.nativeResults[0].compactStartConfirmed, true);
  const record = await h.readReceipt('history:T:late-compact-result');
  assert.ok(record.compactStartIdentity);
  const receiptRead = projection.beginHistorySendReceiptRead('T', { observePendingHandoffChanges: true });
  assert.equal(receiptRead.adoptList(), true);
  const receiptOwner = projection.captureHistoryReceiptRecoveryOwner(record);
  const localRow = { local: true, handoffId: record.handoffId, sendOperationKey: record.operationKey,
    sendAttemptId: record.attemptId };
  const localMeta = { owner: {}, sendOperationKey: record.operationKey, sendAttemptId: record.attemptId };
  const panel = runActualPanelReceiptBranch({ projection, record, receiptRead, receiptOwner,
    rows: [localRow], meta: localMeta });
  assert.equal(projection.getHistoryPromptHandoffsSnapshot('T').length, 0);
  assert.equal(panel.entries.length, 0, 'the actual receipt branch removed the already-present local row');
  assert.equal(panel.promptHandoffMetaRef.current.has(record.handoffId), false);
  receiptOwner.dispose(); receiptRead.close();
  releaseNativeResult(h.nativeResults[0]);
  await appRun;
  assert.equal(projection.getHistoryPromptHandoffsSnapshot('T').length, 0,
    'the late native result cannot recreate the consumed handoff in App');
  h.releaseAdmission();
  const applicationAck = await click.result;
  assert.equal(applicationAck.applicationQueued, true, 'the actual delayed reply is the original application ACK');
  const afterAck = runActualPanelDelayedAdmissionBranch({ projection, result: applicationAck, rows: panel.entries });
  assert.equal(afterAck.transferred, true);
  assert.equal(afterAck.statusCalls.length, 1, 'the real History status callback was actually exercised');
  assert.equal(afterAck.statusCalls[0][1], 'application-queued');
  assert.equal(afterAck.entries.length, 0, 'the actual History ACK/status branch cannot recreate the removed row');
  assert.equal(projection.getHistoryPromptHandoffsSnapshot('T').length, 0);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1);
  assert.equal(h.writes.filter(value => value === '\r').length, 1);
});

test('Stop after Compact paste revokes the original owner before Enter and cannot revive on a late frame', async t => {
  const h = await setup(t);
  const click = h.click('stopped', '/compact');
  assert.equal((await click.result).applicationQueued, true);
  h.frame(''); h.resolveReady(); await tick(300);
  assert.equal(h.writes.filter(value => value.includes('/compact')).length, 1, h.events.join('\n'));
  h.change('stop'); h.frame('/compact'); await tick(400);
  assert.equal(h.writes.filter(value => value === '\r').length, 0);
  assert.equal(h.registry.getPending('T', 'codex'), null);
  h.frame(''); h.taskStarted(); await tick(200);
  assert.equal(h.writes.filter(value => value === '\r').length, 0);
  assert.equal(h.store.get('history:T:stopped').compactStartIdentity ?? null, null);
});

for (const [label, prompt, extra] of [
  ['another local command', '/fast', {}],
  ['Claude Compact', '/compact', { toolType: 'claude' }],
  ['Project API caller', '/compact', { source: 'project-api' }],
  ['record without reply', '/compact', { recordWithoutReply: true }],
  ['attachment', '/compact', { presentationSnapshot: { imagePaths: [{ path: '/fixture/example.png' }] } }],
  ['prompt chip', '/compact', { presentationSnapshot: { promptChips: [{ kind: 'prompt', text: 'fixture' }] } }],
]) test('non-target ' + label + ' retains its prior local-command path', async t => {
  const h = await setup(t);
  const first = h.click('other', prompt, extra);
  assert.equal(first.started.started, true);
  await tick(200);
  assert.equal(h.ipc.filter(call => call.channel === 'agent:enqueue-prompt').length, 0,
    'this input must not use the special History Compact FIFO admission');
  assert.equal(h.click('next', 'ordinary text').started.started, false,
    'the existing coordinator remains the owner until this local action settles');
  assert.equal(h.writes.length, 0);
});

test('multiline /compact text is still ordinary application-queued authoring', async t => {
  const h = await setup(t);
  const click = h.click('multiline', '/compact\nexplain this');
  const result = await click.result;
  assert.equal(result.applicationQueued, true);
  assert.equal(h.queue.item('history:T:multiline') !== null, true);
  assert.equal(JSON.parse(h.queue.item('history:T:multiline').request_json).prompt, '/compact\nexplain this');
  assert.equal(h.writes.length, 0);
});
