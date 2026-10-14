'use strict';

// Executes the actual Main capture/public runtime/reader and web continuation
// adapter. The process/source/physical-send/receipt ports are CONTROLLED here.
// This is not the native SQLite, provider parser, PTY, or FIFO integration suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { continuationOwnerKey } = require('./orchestration-continuation');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { agentSendTargetPreconditionFailure } = require('../shared/agent-send-target-precondition.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

const declarationCache = new Map();
function declarations(file, names) {
  const key = file + ':' + names.join(',');
  if (declarationCache.has(key)) return declarationCache.get(key);
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const code = names.map(name => {
    const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, file + ':' + name);
    return node.getText(tree);
  }).join('\n');
  declarationCache.set(key, code);
  return code;
}

// The canonical receipt shape comes from the existing continuation tests.
// This port can delay/withhold a receipt; it does not implement the publisher.
class ControlledReceipts {
  constructor() { this.records = new Map(); this.cancelled = new Set(); this.pins = new Map(); }
  get(key) { return this.records.get(key); }
  isDeliveryCancelled(key) { return this.cancelled.has(key); }
  cancelDelivery({ operationKey }) { this.cancelled.add(operationKey); }
  pinForOwner(key, owner) { if (!this.pins.has(owner)) this.pins.set(owner, new Set()); this.pins.get(owner).add(key); }
  unpinForOwner(key, owner) { this.pins.get(owner)?.delete(key); }
  listOwnerPins(owner) { return [...(this.pins.get(owner) || [])]; }
  enter(request) {
    assert.equal(this.records.has(request.sendOperationKey), false, 'one controlled physical attempt per operation');
    const record = { operationKey: request.sendOperationKey, handoffId: request.handoffId,
      tabId: request.tabId, provider: request.provider, sessionId: request.sessionId,
      attemptId: 'attempt:' + request.sendOperationKey, state: 'delivery-unknown',
      promptHash: promptAuditFingerprint(request.prompt) };
    this.records.set(record.operationKey, record);
    return record;
  }
  audit(record, context) {
    record.state = 'confirmed';
    record.auditIdentity = { attemptId: record.attemptId, provider: 'codex', sessionId: context.sessionId,
      entryUuid: 'canonical-user:' + record.handoffId, sourceIdentity: 'canonical-source:' + record.handoffId,
      promptHash: record.promptHash, auditTimestamp: new Date(context.startedAt).toISOString() };
    record.receipt = { success: true, submitted: true, accepted: true, provider: 'codex', sessionId: context.sessionId,
      exactAuditConfirmed: true, actualHash: record.promptHash, expectedHash: record.promptHash, actualLen: 8, expectedLen: 8,
      auditExecutionContext: context };
  }
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-main-adapter-'));
  const file = path.join(dir, 'runs.json');
  let store = new OrchestrationRunStore(file);
  const old = { provider: 'codex', sessionId: 'B', turnId: 'old-turn', processId: '11', generation: 1, startedAt: 100 };
  const next = { ...old, turnId: 'new-turn', processId: '321', generation: 2, startedAt: Date.now() + 10000 };
  await store.create({ runId: 'R', sourceTabId: 'A', targetTabId: 'B', sourceToolType: 'codex', targetToolType: 'codex',
    sourceSendTarget: { toolType: 'codex', sessionId: 'A' }, promptHash: 'original-hash',
    targetExecutionContext: old, targetCwd: dir });
  await store.markDelivery('R', { sessionId: 'B', lifecycleGeneration: 'old-launch' });
  await store.patch('R', { targetPromptProofAt: 100, targetPromptProofUserUuid: 'original-user', status: 'running' });
  await store.beginRecovery('R', 'interrupted', 'turn_aborted');
  await store.persistStrict();
  const receipts = new ControlledReceipts();
  const tabs = new Map(['A', 'B'].map(id => [id, { known: true, exists: true, sessionId: id, provider: 'codex', cwd: dir,
    ready: true, processStatus: 'found', processPid: 321, generation: 'L:' + id, input: 1, stop: 0, epoch: 1,
    instance: 'instance:' + id, launch: 'launch:' + id, background: 0, writer: true }]));
  const controls = { originalComplete: false, latestTurn: 'old-turn', sourceVerified: true, latestTerminal: 'turn_aborted',
    autoAudit: true, originalReads: 0, latestReads: 0, beforeOriginal: null, beforeLatest: null,
    beforeRuntime: null, beforePrepare: null };
  const calls = { sends: [], physical: 0, delivered: [], logs: [], reconciles: [] };
  const turns = new Map();
  const terminalObjects = new Map(['A', 'B'].map(id => [id, {}]));
  const watcher = id => ({ busy: false, outcomeKnown: id === 'A', liveTurnEvents: 0,
    sessionId: id, processGeneration: tabs.get(id).generation, currentTurnId: null, lastOutcomeTurnId: null });
  const env = vm.createContext({ require, path, srcMainDir: __dirname,
    console: { log() {}, warn: line => calls.logs.push(line) },
    projectManager: { db: { db: { prepare: () => ({ get: id => tabs.get(id)?.exists ? { tab_id: id } : undefined }) } } },
    captureConversationOwner: id => {
      const a = tabs.get(id); return { known: a.known, provider: a.provider, sessionId: a.sessionId, cwd: a.cwd,
        instanceId: a.instance, terminalId: 'terminal:' + id, launchId: a.launch, runSeq: 1 };
    },
    conversationOwners: { stored: id => ({ epoch: tabs.get(id).epoch, revision: tabs.get(id).epoch }),
      current: id => ({ ownerToken: 'owner:' + id, ownerOrder: tabs.get(id).epoch }) },
    sdkSessions: new Map(), terminals: terminalObjects, ptyActiveWriteOperation: new Map(),
    codexPromptInFlight: new Map(), claudePendingPrompt: new Map(), aiStoppingTabs: new Map(),
    taskCompletionIntents: { getTurn: id => turns.get(id) },
    codexTurnWatchers: new Map(['A', 'B'].map(id => [id, watcher(id)])), codexProviderSemanticSources: new Map(),
    claudeTurnBusy: new Map(), claudeLocalCommandWatchers: new Map(), claudeHookLastEvent: new Map(),
    bridgeKnownSessions: new Map(), codexKnownSessions: new Map(), codexLateMcpProofPending: new Map(),
    getCodexRuntimeSessionId: id => tabs.get(id).sessionId,
    getTerminalLifecycleGeneration: id => tabs.get(id).generation,
    getTerminalInputRevision: id => tabs.get(id).input, getTerminalStopRevision: id => tabs.get(id).stop,
    getCombinedTabBackgroundWorkCount: id => tabs.get(id).background, tabBackgroundWorkRevisionByTab: new Map(),
    codexTurnStateSnapshot: state => state, projectCodexPolicyRuntime: value => value,
    isCodexTuiEffectivelyReady: id => tabs.get(id).ready,
    hasCodexEstablishedComposerLifecycle: () => true, getCodexLiveInputControl: () => null,
    isCodexWriterUsableForMutation: id => tabs.get(id).writer, hasCodexEstablishedWriterUiLifecycle: () => true,
    getCodexPublicWriterFields: () => ({}), getCodexTuiReadyState: async () => ({}),
    claudeStartupGateRevisions: new Map(), codexRuntimePolicies: null, codexLiveSettingsObserver: null,
    currentClaudeStartupDefaultsGate: () => null,
    captureAiProcessLookupScope: id => ({ cwd: tabs.get(id).cwd, generation: tabs.get(id).generation,
      scopeKey: JSON.stringify([tabs.get(id).instance, tabs.get(id).launch, tabs.get(id).stop]) }),
    aiProcessLookupScopeCurrent: (id, scope) => scope.generation === tabs.get(id).generation
      && scope.scopeKey === JSON.stringify([tabs.get(id).instance, tabs.get(id).launch, tabs.get(id).stop]),
    resolveAiToolTypeForTab: id => tabs.get(id).provider,
    AI_PROCESS_LOOKUP_STATUS: { FOUND: 'found', ABSENT: 'absent' },
    inspectAiDescendantProcessesByTab: async id => ({ status: tabs.get(id).processStatus,
      matches: [{ pid: tabs.get(id).processPid, processName: tabs.get(id).provider }] }),
    selectAiProcessForStop: matches => matches[0],
    currentAiLifecycleIdentity: (id, facts) => ({ ...facts, terminalRunSeq: 1, inputRevision: tabs.get(id).input }),
    readAgentSendDestinationAtWriteBoundary: id => {
      const a = tabs.get(id);
      return a.writer ? { toolType: a.provider, sessionId: a.sessionId, terminalInstanceId: a.instance,
        launchId: a.launch, lifecycleGeneration: a.generation } : null;
    },
    _loadSessionTurns() { throw new Error('Codex continuation must not materialize History'); },
    readObservedTranscriptResponse() { throw new Error('Codex continuation must not use a generic prompt reader for latest'); },
    codexDataModule: { _api: { loadLatestCodexObservedExecution: async request => {
      controls.latestReads++;
      assert.equal(request.sessionId, tabs.get('B').sessionId);
      assert.equal(request.resultReadMode, 'authoritative');
      assert.equal(request.maxChars, 500);
      assert.equal(typeof request.resolveSource, 'function');
      await controls.beforeLatest?.();
      return { success: true, sourceVerified: controls.sourceVerified,
        executionContext: { provider: 'codex', sessionId: controls.latestSession || tabs.get('B').sessionId,
          turnId: controls.latestTurn, generation: null },
        complete: controls.latestTerminal === 'task_complete', terminalEvent: controls.latestTerminal,
        proofDefinitive: !!controls.latestTerminal, assistantText: 'DO NOT EXPOSE THIS IN IDENTITY READ',
        turnIndex: 3 };
    } } },
    transcriptService: { resolveCodexResultSource() { throw new Error('source parser port is controlled in this suite'); } },
  });
  vm.runInContext(declarations('codex-runtime-contract.js', ['projectCodexPublicRuntimeProjection', 'projectCodexRuntimeStatus'])
    + '\nlet agentResponseObservationReader = null;\n'
    + declarations('main.js', ['getActiveAgentExecutionContext', 'captureAgentResponseReadState', 'getAgentResponseObservationReader',
      'readMainAgentStartReadiness', 'readMainPublicRuntimeSnapshot', 'readAiLifecycleIdentityForTab', 'getCodexPublicRuntimeProjection']), env);
  env.projectCodexRuntimeSnapshotFromEvents = id => ({ ...env.getCodexPublicRuntimeProjection(id), sessionId: tabs.get(id).sessionId });
  const reader = env.getAgentResponseObservationReader();
  Object.assign(env, {
    agentSendReceiptStore: receipts, getOrchestrationRunStore: () => store,
    getAgentResponseState: id => reader.getAgentResponseState(id),
    readAgentObservedResponse: args => reader.readAgentObservedResponse(args),
    readAgentRuntimeSnapshot: async id => { await controls.beforeRuntime?.(id); return env.readMainPublicRuntimeSnapshot(id); },
    readAgentSendDestination: id => env.readAgentSendDestinationAtWriteBoundary(id),
    resolveAgentSessionInfo: async id => ({ sessionId: tabs.get(id).sessionId, lifecycleGeneration: tabs.get(id).generation }),
    reconcileAgentSendReceiptForApi: async () => {},
    readAgentContinuationOriginalProof: null,
    getAgentTurnResult: async () => {
      controls.originalReads++; await controls.beforeOriginal?.(controls.originalReads);
      return { found: true, sourceVerified: true, complete: controls.originalComplete, userUuid: 'original-user',
        executionContext: old, ...(controls.originalComplete ? { terminalEvent: 'task_complete' } : {}) };
    },
    buildOrchestrationResultLookup: require('./orchestration-runs').buildOrchestrationResultLookup,
    orchestrationPresentationSnapshot: () => null, agentSendBridgeTimeoutMs: 1000,
    reconcileOrchestrationRun: async id => { calls.reconciles.push(id); },
    sendOrchestrationCompletionNotification: async run => { calls.delivered.push(run.runId); },
    emitOrchestrationChanges() {}, createReplacementOrchestrationRequest() { throw new Error('not a replacement task'); },
    dispatchDeferredOrchestrationRun() { throw new Error('not a replacement task'); },
    runAgentSendScenario: async request => {
      calls.sends.push(request); await controls.beforePrepare?.(request);
      await request.prepareSend();
      const actual = env.readAgentSendDestinationAtWriteBoundary('B');
      const mismatch = agentSendTargetPreconditionFailure(request.expectedTarget, actual);
      if (mismatch) return mismatch;
      calls.physical++;
      const record = receipts.enter(request);
      tabs.get('B').input++;
      Object.assign(env.codexTurnWatchers.get('B'), { busy: true, outcomeKnown: false, currentTurnId: next.turnId, liveTurnEvents: 1 });
      turns.set('B', { ...next, active: true });
      if (controls.autoAudit) receipts.audit(record, next);
      return { submitted: true, deliveryUnknown: !controls.autoAudit };
    },
  });
  vm.runInContext('let orchestrationContinuationService = null;\n'
    + declarations('web-server.js', ['getOrchestrationContinuationService']), env);
  t.after(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { env, reader, tabs, controls, calls, receipts, old, next, turns, dir,
    get service() { return env.getOrchestrationContinuationService(); }, get store() { return store; },
    reopen: async () => { await store.flush(); store = new OrchestrationRunStore(file); await store.initialize();
      vm.runInContext('orchestrationContinuationService = null;', env); },
    history: () => reader.readAgentObservedResponse({ tabId: 'B', expectedSessionId: tabs.get('B').sessionId,
      purpose: 'continuation-history', maxChars: 500 }) };
}

test('actual restored Main busy=null reaches both continuation checks, sends once, and binds only the canonical new turn', async t => {
  const h = await fixture(t), before = copy(await h.store.getInternal('R'));
  const state = await h.reader.getAgentResponseState('B');
  const runtime = await h.env.readMainPublicRuntimeSnapshot('B');
  assert.equal(state.busy, null); assert.equal(state.processStatus, 'found');
  assert.equal(runtime.coherent, true); assert.equal(runtime.inputReady, true); assert.equal(runtime.status, 'active');
  assert.equal((await h.reader.readAgentObservedResponse({ tabId: 'B', expectedSessionId: 'B' })).code, 'response_busy_unknown');
  const result = await h.service.continueRequest('R');
  assert.equal(result.resumed, true, JSON.stringify(result));
  assert.equal(h.calls.physical, 1); assert.equal(h.controls.latestReads, 2, 'admission AND prepare revalidate latest');
  assert.equal(h.calls.sends[0].expectedTarget.launchId, 'launch:B');
  const run = await h.store.getInternal('R');
  assert.equal(run.targetExecutionContext.turnId, 'new-turn');
  assert.equal(run.continuationIntent.state, 'bound'); assert.equal(run.resultComplete, false);
  for (const key of ['runId', 'promptHash', 'sourceTabId', 'targetTabId', 'targetCwd', 'targetPromptProofUserUuid']) assert.deepEqual(run[key], before[key], key);
  await h.service.continueRequest('R'); assert.equal(h.calls.physical, 1);
});

for (const terminal of ['turn_aborted', null, 'task_complete']) test('historical identity only, including ' + String(terminal) + ', never certifies a response', async t => {
  const h = await fixture(t); h.controls.latestTerminal = terminal;
  const result = await h.history();
  assert.equal(result.subject?.targetExecutionContext.turnId, 'old-turn', JSON.stringify(result));
  assert.equal(result.result.sourceVerified, true); assert.equal(result.result.complete, undefined);
  assert.equal(result.result.assistantText, undefined);
  assert.equal((await h.reader.getAgentResponseState('B')).busy, null);
  assert.equal((await h.reader.readAgentObservedResponse({ tabId: 'B', expectedSessionId: 'B' })).code, 'response_busy_unknown');
});

for (const failure of ['no-runtime-port', 'writer-unproven', 'input-not-ready', 'process-unknown']) {
  test('restored input fails closed: ' + failure, async t => {
    const h = await fixture(t);
    if (failure === 'no-runtime-port') h.env.readAgentRuntimeSnapshot = null;
    if (failure === 'writer-unproven') h.tabs.get('B').writer = false;
    if (failure === 'input-not-ready') h.tabs.get('B').ready = false;
    if (failure === 'process-unknown') h.tabs.get('B').processStatus = 'unknown';
    const result = await h.service.continueRequest('R');
    assert.equal(result.code, 'continuation_runtime_unknown', JSON.stringify(result)); assert.equal(h.calls.physical, 0);
  });
}

for (const boundary of ['catch-up', 'binding-conflict', 'suppressed', 'pending-prompt', 'pending-write', 'stopping', 'another-turn']) {
  test('input-ready cannot bypass actual Main ' + boundary, async t => {
    const h = await fixture(t), watcher = h.env.codexTurnWatchers.get('B');
    if (boundary === 'catch-up') watcher.catchUpPending = true;
    if (boundary === 'binding-conflict') watcher.manualBindingConflict = { source: 'test' };
    if (boundary === 'suppressed') watcher.publicTurnStateSuppressed = true;
    if (boundary === 'pending-prompt') h.env.codexPromptInFlight.set('B', true);
    if (boundary === 'pending-write') h.env.ptyActiveWriteOperation.set(h.env.terminals.get('B'), {});
    if (boundary === 'stopping') h.env.aiStoppingTabs.set('B', { toolType: 'codex' });
    if (boundary === 'another-turn') watcher.busy = true;
    const result = await h.service.continueRequest('R');
    assert.equal(result.ok, false); assert.equal(h.calls.physical, 0);
  });
}

for (const work of ['active', 'attention', 'attention_required', 'children']) test('existing Goal/background gate: ' + work, async t => {
  const h = await fixture(t);
  if (work === 'children') h.tabs.get('B').background = 2;
  else h.env.codexTurnWatchers.get('B').goalWork = { status: work };
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_background_work'); assert.equal(h.calls.physical, 0);
});

for (const party of ['A', 'B']) test('changed ' + party + ' history cannot send', async t => {
  const h = await fixture(t); h.tabs.get(party).sessionId = 'foreign';
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_history_changed'); assert.equal(h.calls.physical, 0);
});

test('coherent runtime join rejects owner ABA between its actual response-state samples', async t => {
  const h = await fixture(t);
  h.controls.beforeRuntime = async id => { if (id === 'B') h.tabs.get('B').epoch += 2; };
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.physical, 0);
});

for (const where of ['original', 'latest']) test('input ABA during ' + where + ' read invalidates continuation', async t => {
  const h = await fixture(t);
  const change = () => { h.tabs.get('B').input += 2; };
  if (where === 'original') h.controls.beforeOriginal = change; else h.controls.beforeLatest = change;
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.physical, 0);
});

for (const field of ['launch', 'instance', 'generation']) test('same SID replacement after claim cannot pass preparation: ' + field, async t => {
  const h = await fixture(t); h.controls.beforePrepare = () => { h.tabs.get('B')[field] += ':replacement'; };
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.physical, 0);
});

for (const changed of ['different-turn', 'goal-no-user-execution', 'unverified-source', 'closed']) test('historical selection rejects ' + changed, async t => {
  const h = await fixture(t);
  if (changed === 'different-turn' || changed === 'goal-no-user-execution') h.controls.latestTurn = changed;
  if (changed === 'unverified-source') h.controls.sourceVerified = false;
  if (changed === 'closed') h.tabs.get('B').exists = false;
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.physical, 0);
});

test('receipt-only cancellation during the awaited prepare history read cannot cross the sender port', async t => {
  const h = await fixture(t);
  h.controls.beforeOriginal = async number => { if (number === 2) {
    const intent = (await h.store.getInternal('R')).continuationIntent;
    h.receipts.cancelDelivery({ operationKey: intent.operationKey });
  } };
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.physical, 0);
});

test('unknown delivery plus store reopen preserves the same operation and never replays input', async t => {
  const h = await fixture(t); h.controls.autoAudit = false;
  assert.equal((await h.service.continueRequest('R')).pending, true);
  const operation = (await h.store.getInternal('R')).continuationIntent.operationKey;
  await h.reopen();
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_delivery_unknown');
  assert.equal((await h.store.getInternal('R')).continuationIntent.operationKey, operation); assert.equal(h.calls.physical, 1);
});

test('delayed canonical ACK binds the exact new turn without a second send', async t => {
  const h = await fixture(t); h.controls.autoAudit = false;
  assert.equal((await h.service.continueRequest('R')).pending, true);
  const intent = (await h.store.getInternal('R')).continuationIntent;
  const record = h.receipts.get(intent.operationKey);
  h.receipts.audit(record, h.next);
  record.auditIdentity.attemptId = 'foreign-attempt';
  assert.equal((await h.service.reconcile('R')).confirmed, false);
  record.auditIdentity.attemptId = record.attemptId;
  await h.reopen();
  assert.equal((await h.service.reconcile('R')).confirmed, true); assert.equal(h.calls.physical, 1);
  assert.equal((await h.store.getInternal('R')).targetExecutionContext.turnId, h.next.turnId);
});

test('late canonical ACK cannot resurrect a cancelled run', async t => {
  const h = await fixture(t); h.controls.autoAudit = false; await h.service.continueRequest('R');
  const intent = (await h.store.getInternal('R')).continuationIntent;
  await h.store.cancel('R'); h.receipts.cancelDelivery({ operationKey: intent.operationKey });
  h.receipts.audit(h.receipts.get(intent.operationKey), h.next);
  assert.equal((await h.service.reconcile('R')).confirmed, false);
  assert.equal((await h.store.get('R')).status, 'cancelled'); assert.equal(h.calls.physical, 1);
});

test('same run concurrent retry joins one accepted operation', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred();
  h.controls.beforePrepare = async () => { entered.resolve(); await release.promise; };
  const first = h.service.continueRequest('R');
  assert.equal(await Promise.race([entered.promise.then(() => 'entered'), first.then(() => 'refused')]), 'entered');
  const second = h.service.continueRequest('R'); assert.equal(first, second);
  release.resolve(); assert.equal((await first).resumed, true); assert.equal(h.calls.physical, 1);
});

test('strict prepared checkpoint reuses the same operation after reopen', async t => {
  const h = await fixture(t), run = copy(await h.store.getInternal('R'));
  const claimed = await h.store.beginRequestContinuation('R', { ownerKey: continuationOwnerKey(run),
    sourceExpected: run.sourceSendTarget, targetExpected: { toolType: 'codex', sessionId: 'B' },
    promptHash: require('./claude-prompt-carriers').promptFingerprint('continue'), auditHash: promptAuditFingerprint('continue'), now: Date.now() });
  await h.reopen();
  assert.equal((await h.service.continueRequest('R')).resumed, true);
  assert.equal((await h.store.getInternal('R')).continuationIntent.operationId, claimed.intent.operationId);
  assert.equal(h.calls.physical, 1);
  assert.deepEqual(copy(h.calls.sends[0].expectedTarget), claimed.intent.targetExpected, 'same persisted send fingerprint');
});

test('another target execution retains the existing store ownership/FIFO guard', async t => {
  const h = await fixture(t);
  await h.store.create({ runId: 'R2', sourceTabId: 'A', targetTabId: 'B', targetToolType: 'codex', promptHash: 'other' });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation-target-claimed'); assert.equal(h.calls.physical, 0);
});

test('exact original final is handed off despite parent busy and child input blocked; no continuation is sent', async t => {
  const h = await fixture(t); h.controls.originalComplete = true; h.tabs.get('B').ready = false;
  h.env.codexTurnWatchers.get('A').busy = true;
  assert.equal((await h.service.continueRequest('R')).resultReady, true);
  assert.equal(h.calls.physical, 0); assert.deepEqual(h.calls.delivered, ['R']);
});

test('stopped incomplete history still uses the original launch-capable sender without a restored-live lease', async t => {
  const h = await fixture(t); h.tabs.get('B').processStatus = 'absent'; h.tabs.get('B').ready = false;
  h.env.getCodexPublicRuntimeProjection = id => id === 'B'
    ? { sessionStatus: 'inactive', inputReady: false } : { sessionStatus: 'active', inputReady: true };
  h.controls.latestTerminal = null;
  assert.equal((await h.service.continueRequest('R')).resumed, true);
  assert.equal(h.calls.sends[0].statusAtSend, 'inactive');
  assert.equal(h.calls.sends[0].expectedTarget.launchId, undefined); assert.equal(h.calls.physical, 1);
});


test('missing exact turn and missing UUIDs never count as matching historical identity', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { targetExecutionContext: null, targetPromptProofUserUuid: null });
  h.env.getAgentTurnResult = async () => ({ found: true, sourceVerified: true, complete: false });
  h.controls.latestTurn = 'unrelated-no-user-goal';
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_history_changed');
  assert.equal(h.calls.physical, 0);
});

test('missing compact latest reader has a named failure, no History or response fallback', async t => {
  const h = await fixture(t);
  delete h.env.codexDataModule._api.loadLatestCodexObservedExecution;
  const identity = await h.history();
  assert.equal(identity.code, 'codex_latest_observed_execution_reader_unavailable');
  assert.equal(identity.result, undefined);
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.physical, 0);
});


test('adopted writer can use its existing exact lifecycle scope without fabricated launch/instance fields', async t => {
  const h = await fixture(t);
  const destination = h.env.readAgentSendDestinationAtWriteBoundary;
  h.env.readAgentSendDestinationAtWriteBoundary = id => {
    const value = destination(id);
    delete value.terminalInstanceId; delete value.launchId;
    return value;
  };
  assert.equal((await h.service.continueRequest('R')).resumed, true);
  assert.equal(h.calls.sends[0].expectedTarget.lifecycleGeneration, 'L:B');
  assert.equal(h.calls.sends[0].expectedTarget.launchId, undefined);
  assert.equal(h.calls.physical, 1);
});

test('input readiness with an unscoped sendTarget never authorizes the restored bridge', async t => {
  const h = await fixture(t);
  h.env.readAgentSendDestinationAtWriteBoundary = id => ({ toolType: 'codex', sessionId: id });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_runtime_unknown');
  assert.equal(h.calls.physical, 0);
});


test('cwd change after claim is rejected by preparation even with the same SID and launch', async t => {
  const h = await fixture(t);
  h.controls.beforePrepare = () => { h.tabs.get('B').cwd = path.join(h.dir, 'different-root'); };
  assert.equal((await h.service.continueRequest('R')).ok, false);
  assert.equal(h.calls.physical, 0);
});

test('unknown process cannot borrow a busy level to adopt an old execution', async t => {
  const h = await fixture(t);
  h.tabs.get('B').processStatus = 'unknown';
  h.env.codexTurnWatchers.get('B').busy = true;
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_runtime_unknown');
  assert.equal(h.calls.physical, 0);
});

for (const accepted of [true, false]) test('linked resumed writer requires exact current launch proof: ' + accepted, async t => {
  const h = await fixture(t);
  h.tabs.get('B').sessionId = 'linked-B';
  h.next.sessionId = 'linked-B';
  h.controls.latestSession = 'B';
  const destination = h.env.readAgentSendDestinationAtWriteBoundary;
  h.env.readAgentSendDestinationAtWriteBoundary = id => ({ ...destination(id),
    ...(id === 'B' && accepted ? { acceptedResumeSourceSessionId: 'B' } : {}) });
  const result = await h.service.continueRequest('R');
  if (accepted) {
    assert.equal(result.resumed, true, JSON.stringify(result));
    assert.equal(h.calls.physical, 1);
    assert.equal(h.calls.sends[0].expectedTarget.sessionId, 'B', 'original intended session remains immutable');
    assert.equal((await h.store.getInternal('R')).targetExecutionContext.sessionId, 'linked-B');
  } else {
    assert.equal(result.code, 'continuation_history_changed');
    assert.equal(h.calls.physical, 0);
  }
});
