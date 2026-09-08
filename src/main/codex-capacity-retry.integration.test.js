'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const {
  classifyCodexCapacityRetryRecord,
  createCodexCapacityRetryRuntime,
} = require('./codex-capacity-retry-runtime');
const { CODEX_MODEL_CAPACITY_MESSAGE } = require('./codex-model-capacity-state');
const { classifyCodexTurnRecord } = require('./codex-turn-outcome');
const {
  OrchestrationRunStore,
  isTerminalStatus,
  isPausedRun,
  isResultProofPending,
} = require('./orchestration-runs');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');

const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const webSource = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
function part(source, name) {
  const marker = 'function ' + name + '(';
  const found = source.indexOf(marker);
  const start = source.slice(Math.max(0, found - 6), found) === 'async ' ? found - 6 : found;
  const end = source.indexOf('\n}\n', found) + 3;
  assert.ok(found >= 0 && end > found, name);
  return source.slice(start, end);
}
const timestamp = '2026-09-05T14:21:39.307Z';
const failure = (turnId, offset) => ({
  type: 'event_msg', timestamp, __byteOffset: offset,
  payload: { type: 'task_complete', turn_id: turnId,
    error: { message: CODEX_MODEL_CAPACITY_MESSAGE, codex_error_info: 'server_overloaded' } },
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function liveHarness({ limit = 2, submitted = true, enabled = true } = {}) {
  const state = { tabId: 'T', sessionId: 'S', busy: true, offset: 100, currentTurnId: 'E1', capacityRetryLiveAfterOffset: 100 };
  const terminal = {};
  const calls = [];
  const persisted = new Map();
  const config = { codexCapacityRetryEnabled: enabled, codexCapacityRetryLimit: limit };
  const ipcListeners = new Map();
  const context = vm.createContext({
    require: () => web,
    path,
    srcMainDir: __dirname,
    classifyCodexCapacityRetryRecord,
    createCodexCapacityRetryRuntime,
    CODEX_MODEL_CAPACITY_MESSAGE,
    isTerminalStatus,
    isPausedRun,
    getOrchestrationRunStore: () => ({ listForTab: async () => [] }),
    findOrchestrationTabDescriptor: () => ({ tabId: 'T', toolType: 'codex', sessionId: 'S' }),
    runAgentSendScenario: async options => {
      await options.prepareSend();
      calls.push({ type: 'send', options });
      return { submitted, deliveryUnknown: submitted === null };
    },
    performOrchestrationAction: () => assert.fail('untracked tabs do not need orchestration actions'),
    projectManager: { db: {
      getAppState: key => persisted.get(key),
      setAppState: (key, value) => persisted.set(key, JSON.parse(JSON.stringify(value))),
      getAllProjects: () => [{ id: 'P', tabs: [{ tabId: 'T', name: 'Test-owned Codex' }] }],
    } },
    resolveAuthoritativeTabProjectId: () => 'P',
    terminals: new Map([['T', terminal]]),
    codexTurnWatchers: new Map([['T', state]]),
    getTerminalLifecycleGeneration: () => 'G',
    aiStoppingTabs: new Map(),
    agentSendCancellations: { cancel: (...args) => calls.push({ type: 'cancel', args }) },
    setCodexLifecycleWarning: (_tabId, warning) => calls.push({ type: 'warning', warning }),
    aiBoundaryTestGate: { enabled: true },
    ipcMain: {
      emit: (...args) => calls.push({ type: 'external-notification', args }),
      on: (name, listener) => ipcListeners.set(name, listener),
    },
    mainWindow: { webContents: { send: (...args) => calls.push({ type: 'renderer', args }) } },
    console: { warn() {}, log() {} },
  });
  vm.runInContext('const codexCapacityContinuations = new Map();\n'
    + part(webSource, 'coordinateCodexCapacityContinuation') + '\n'
    + part(webSource, 'sendCodexCapacityContinuation'), context);
  const web = {
    getOrchestrationSettings: async () => ({ ...config }),
    sendCodexCapacityContinuation: args => context.sendCodexCapacityContinuation(args),
    coordinateCodexCapacityContinuation: (owner, operation) => context.coordinateCodexCapacityContinuation(owner, operation),
  };
  vm.runInContext('let codexCapacityRetryRuntime = null; const codexCapacityRetryOwners = new Map();\n'
    + part(mainSource, 'getCodexCapacityRetryRuntime') + '\n'
    + part(mainSource, 'observeCodexCapacityRetryRecord'), context);
  return {
    state, calls, persisted, config, context,
    observe: (record, suppressed = false) => context.observeCodexCapacityRetryRecord(state, record, suppressed),
    runtime: () => context.getCodexCapacityRetryRuntime(),
    sends: () => calls.filter(call => call.type === 'send'),
    alerts: () => calls.filter(call => call.type === 'renderer' && call.args[0] === 'tab-notification:force-fired'),
  };
}

test('actual main observer excludes old/suppressed JSONL and exact error replay sends only one literal continue', async () => {
  const h = liveHarness();
  h.observe(failure('historical', 99));
  h.observe(failure('suppressed', 101), true);
  h.observe({ ...failure('missing-offset', 102), __byteOffset: undefined });
  await tick();
  assert.equal(h.sends().length, 0);

  h.observe(failure('E1', 102));
  h.observe(failure('E1', 102));
  await tick();
  assert.equal(h.sends().length, 1);
  const options = h.sends()[0].options;
  assert.equal(options.prompt, 'continue');
  assert.equal(options.requireLive, true);
  assert.equal(options.ownership, 'project');
  assert.equal(options.provider, 'codex');
  assert.equal(options.model, undefined);
  assert.equal(options.effort, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(options.expectedTarget)), {
    toolType: 'codex', sessionId: 'S', turnId: 'E1', lifecycleGeneration: 'G',
  });
  assert.equal(h.runtime().snapshot('T').lastCapacityAt, 102, 'byte order, not shared timestamp, is authoritative');
});

test('actual callers ignore untyped/quoted errors and unknown delivery never replays the same error', async () => {
  const h = liveHarness({ submitted: null, limit: 1 });
  h.observe({ ...failure('wrong-kind', 101), payload: { ...failure('x').payload,
    error: { message: CODEX_MODEL_CAPACITY_MESSAGE, codex_error_info: 'unauthorized' } } });
  h.observe({ type: 'event_msg', timestamp, __byteOffset: 102,
    payload: { type: 'user_message', message: CODEX_MODEL_CAPACITY_MESSAGE } });
  h.observe({ type: 'response_item', timestamp, __byteOffset: 103,
    payload: { type: 'function_call_output', output: JSON.stringify(failure('quoted')) } });
  await tick();
  assert.equal(h.sends().length, 0);
  h.observe(failure('E1', 110));
  await tick();
  h.observe(failure('E1', 111));
  await tick();
  assert.equal(h.sends().length, 1);
  assert.equal(h.alerts().length, 0);
});

test('actual live main→runtime→Project API counts N failures and real busy assistant work replenishes the budget', async () => {
  const h = liveHarness({ limit: 2 });
  for (let n = 1; n <= 4; n++) {
    h.state.currentTurnId = 'E' + n;
    h.observe(failure('E' + n, 100 + n * 10));
    await tick();
  }
  assert.equal(h.sends().length, 2);
  assert.equal(h.alerts().length, 1);
  assert.equal(h.calls.filter(call => call.type === 'external-notification').length, 0, 'test gate forbids real Telegram/outbox events');
  h.state.busy = false;
  h.observe({ type: 'response_item', timestamp, __byteOffset: 150,
    payload: { type: 'message', role: 'assistant', content: [{ text: 'old idle recap' }] } });
  assert.equal(h.runtime().snapshot('T').attempts, 2);
  h.state.busy = true;
  h.observe({ type: 'event_msg', timestamp, __byteOffset: 160, payload: { type: 'task_started', turn_id: 'E5' } });
  h.observe({ type: 'event_msg', timestamp, __byteOffset: 170, payload: { type: 'user_message', message: 'continue' } });
  assert.equal(h.runtime().snapshot('T').attempts, 2);
  h.observe({ type: 'response_item', timestamp, __byteOffset: 180,
    payload: { type: 'message', role: 'assistant', content: [{ text: 'Now checking the requested file.' }] } });
  assert.equal(h.runtime().snapshot('T').attempts, 0);
  h.observe(failure('E5', 190));
  await tick();
  assert.equal(h.sends().length, 3);
});

test('disabled and replaced main owners receive no continuation or forced notification', async () => {
  const disabled = liveHarness({ enabled: false });
  disabled.observe(failure('E1', 110));
  await tick();
  assert.equal(disabled.sends().length, 0);
  assert.equal(disabled.alerts().length, 0);
  const replaced = liveHarness();
  replaced.context.codexTurnWatchers.set('T', { ...replaced.state });
  replaced.observe(failure('E1', 110));
  await tick();
  assert.equal(replaced.sends().length, 0);
});

test('physical write precondition rejects a newer turn and lifecycle generation before paste', () => {
  const expected = { toolType: 'codex', sessionId: 'S', turnId: 'E1', lifecycleGeneration: 'G' };
  for (const patch of [{ turnId: 'user-new-turn' }, { lifecycleGeneration: 'new-process' }]) {
    const result = agentSendTargetPreconditionFailure(expected, { ...expected, ...patch });
    assert.equal(result.submitted, false);
    assert.equal(result.pasteWritten, false);
    assert.equal(result.code, 'agent_send_target_changed');
  }
  const safePaste = part(mainSource, '_safePasteAndSubmitInner');
  assert.match(safePaste, /destinationBeforePaste = destinationFailure\(\)/);
  assert.match(part(mainSource, 'readAgentSendDestinationAtWriteBoundary'), /currentTurnId[\s\S]*lastOutcomeTurnId/);
});

test('main scanner calls recovery on its actual parsed record and seeds the boundary at attached file size', () => {
  assert.match(part(mainSource, 'processCodexTurnLine'), /observeCodexCapacityRetryRecord\(state, record, suppressPublications\)/);
  assert.match(part(mainSource, 'startCodexTurnWatcher'), /capacityRetryLiveAfterOffset: fileSize/);
  assert.match(part(mainSource, 'markAiStopping'), /codexCapacityRetryRuntime\?\.cancel\(tabId, reason\)/);
});

test('actual common readiness scenario forbids both fresh start and resume for automatic continuation', async () => {
  const preparation = fs.readFileSync(path.join(__dirname, '../renderer/utils/agentSendPreparation.ts'), 'utf8');
  const file = ts.createSourceFile('agentSendPreparation.ts', preparation, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'prepareAgentRuntimeForSend');
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const context = vm.createContext({
    exports: {},
    console: { log() {}, warn() {} },
    isCoordinatedAgentSendCancellationRequested: () => false,
    createAgentReadyWait: () => assert.fail('stopped automatic continuation must not wait for/restart a process'),
  });
  vm.runInContext(compiled, context);
  for (const sessionId of [null, 'S']) {
    await assert.rejects(context.prepareAgentRuntimeForSend({
      tabId: 'T', sessionId, requireLive: true,
      runtime: {
        label: 'Codex', toolType: 'codex', getPresence: async () => ({ status: 'inactive', inputReady: false }),
        resume: async () => assert.fail('automatic continuation must not resume a stopped session'),
        startFresh: async () => assert.fail('automatic continuation must not launch a fresh session'),
      },
      providerContract: { classifySubmitCapability: () => 'none' },
    }), error => error.code === 'agent_auto_continue_not_live');
  }
});

test('typed capacity failure cannot become successful completion from earlier final text', () => {
  const tracker = { currentTurnId: 'E1', currentTurnHasFinalResult: true, currentTurnFinalResultTurnId: 'E1' };
  for (const record of [failure('E1', 110), {
    ...failure('E1', 120), payload: { ...failure('E1').payload, last_agent_message: 'partial result carried by provider' },
  }]) {
    const outcome = classifyCodexTurnRecord(tracker, record);
    assert.equal(outcome.busy, false);
    assert.equal(outcome.hasFinalResult, false);
    assert.notEqual(outcome.reason, 'task_complete', 'Run After and orchestration must see a failure, not success');
  }
});

test('actual Project API continuation recovers the exact capacity-failed orchestration before sending', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-capacity-integration-'));
  const store = new OrchestrationRunStore(path.join(tempDir, 'runs.json'));
  const executionContext = { provider: 'codex', sessionId: 'S', turnId: 'E1', processId: 'pid', generation: 1, startedAt: 1 };
  const calls = [];
  try {
    await store.create({ runId: 'run', sourceTabId: 'source', sourceProjectId: 'P', targetTabId: 'T', targetProjectId: 'P',
      targetToolType: 'codex', targetExecutionContext: executionContext, targetLifecycleGeneration: 'G', promptHash: 'H', promptChars: 1 });
    await store.markDelivery('run', { sessionId: 'S' });
    await store.applyLifecycle('T', { type: 'busy', busy: true, sessionId: 'S', lifecycleGeneration: 'G', executionContext });
    const outcome = classifyCodexTurnRecord({}, failure('E1', 110));
    await store.applyLifecycle('T', { type: 'done', reason: outcome.reason, sessionId: 'S', lifecycleGeneration: 'G', executionContext });
    assert.equal((await store.get('run')).status, 'waiting_recovery');
    assert.equal((await store.get('run')).outcome, 'failed');
    const context = vm.createContext({
      getOrchestrationRunStore: () => store,
      isTerminalStatus, isPausedRun, isResultProofPending,
      findOrchestrationTabDescriptor: () => ({ toolType: 'codex', sessionId: 'S' }),
      resolveAgentSessionInfo: async () => ({ sessionId: 'S', lifecycleGeneration: 'G' }),
      releaseOrchestrationResultProof: async () => {},
      emitOrchestrationChanges() {}, emitOrchestrationRun() {},
      scheduleOrchestrationPolicyTimer: async () => {},
      withOrchestrationUrls: value => value,
      runAgentSendScenario: async options => { await options.prepareSend(); calls.push(options); return { submitted: true }; },
    });
    vm.runInContext(part(webSource, 'performOrchestrationAction') + '\n' + part(webSource, 'sendCodexCapacityContinuation'), context);
    const result = await context.sendCodexCapacityContinuation({ tabId: 'T', sessionId: 'S', turnId: 'E1', generation: 'G', handoffId: 'retry', isCurrent: async () => true });
    assert.equal(result.submitted, true, result.error);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, 'continue');
    assert.equal((await store.get('run')).resumeAwaitingNewTurn, true);
  } finally {
    await store.flush();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

async function capacityRunFixture(t, { reason = 'model_capacity', graceMs, paused = false } = {}) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-capacity-owner-'));
  const store = new OrchestrationRunStore(path.join(tempDir, 'runs.json'));
  t.after(async () => {
    await store.flush();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });
  if (graceMs !== undefined) await store.updateSettings({ failureGraceMs: graceMs });
  const executionContext = { provider: 'codex', sessionId: 'S', turnId: 'E1', processId: 'pid', generation: 1, startedAt: 1 };
  await store.create({ runId: 'run', sourceTabId: 'source', sourceProjectId: 'P', targetTabId: 'T', targetProjectId: 'P',
    targetToolType: 'codex', targetExecutionContext: executionContext, targetLifecycleGeneration: 'G', promptHash: 'H', promptChars: 1 });
  await store.markDelivery('run', { sessionId: 'S' });
  await store.applyLifecycle('T', { type: 'busy', busy: true, sessionId: 'S', lifecycleGeneration: 'G', executionContext });
  if (paused) await store.pause('run');
  else if (reason) await store.applyLifecycle('T', { type: 'done', reason, sessionId: 'S', lifecycleGeneration: 'G', executionContext });
  const proof = { tabId: 'T', sessionId: 'S', turnId: 'E1', lifecycleGeneration: 'G', handoffId: 'retry:E1' };
  return { store, executionContext, proof };
}

test('capacity recovery rejects changed turn/generation/session/tab and does not alter the saved request', async t => {
  const { store, proof } = await capacityRunFixture(t);
  const before = await store.get('run');
  for (const patch of [{ turnId: 'different-turn' }, { lifecycleGeneration: 'different-process' }, { sessionId: 'different-session' }, { tabId: 'different-tab' }]) {
    const result = await store.resolveRecovery('run', 'codex-capacity-retry', { ...proof, ...patch });
    assert.equal(result.error, 'capacity-recovery-owner-changed');
    assert.deepEqual(await store.get('run'), before);
  }
});

test('capacity recovery does not reopen unrelated provider failures or a manually paused request', async t => {
  for (const options of [{ reason: 'provider_error' }, { reason: 'codex-no-final-result' }, { paused: true }]) {
    const { store, proof } = await capacityRunFixture(t, options);
    const before = await store.get('run');
    const result = await store.resolveRecovery('run', 'codex-capacity-retry', proof);
    assert.equal(result.error, 'capacity-recovery-owner-changed');
    assert.deepEqual(await store.get('run'), before);
  }
});

test('capacity recovery can win the pre-done race, but neither old done nor late old final can settle its next turn', async t => {
  const { store, executionContext, proof } = await capacityRunFixture(t, { reason: null });
  assert.equal((await store.get('run')).status, 'running');
  const recovered = await store.resolveRecovery('run', 'codex-capacity-retry', proof);
  assert.equal(recovered.run.resumeAwaitingNewTurn, true);
  assert.equal(recovered.run.targetExecutionContext, null);
  const previousAttempt = recovered.run.recoveryAttempt;
  assert.equal((await store.resolveRecovery('run', 'codex-capacity-retry', proof)).idempotent, true);
  assert.equal((await store.get('run')).recoveryAttempt, previousAttempt);
  for (const reason of ['model_capacity', 'task_complete']) {
    const late = await store.applyLifecycle('T', { type: 'done', reason, sessionId: 'S', lifecycleGeneration: 'G', executionContext });
    assert.equal(late.completed.length, 0);
    assert.equal((await store.get('run')).resumeAwaitingNewTurn, true);
    assert.equal((await store.get('run')).status, 'queued');
  }
  const nextContext = { ...executionContext, turnId: 'E2', startedAt: recovered.run.resumeAfterAt + 1 };
  await store.applyLifecycle('T', { type: 'busy', busy: true, sessionId: 'S', lifecycleGeneration: 'G', executionContext: nextContext });
  assert.equal((await store.get('run')).status, 'running');
  assert.equal((await store.get('run')).targetExecutionContext.turnId, 'E2');
  await store.applyLifecycle('T', { type: 'done', reason: 'task_complete', sessionId: 'S', lifecycleGeneration: 'G', executionContext });
  assert.equal((await store.get('run')).status, 'running');
});

test('zero failure grace still permits exact capacity recovery before source handoff starts', async t => {
  const { store, proof } = await capacityRunFixture(t, { graceMs: 0 });
  assert.equal((await store.get('run')).status, 'failed');
  const result = await store.resolveRecovery('run', 'codex-capacity-retry', proof);
  assert.equal(result.error, undefined);
  assert.equal(result.run.resumeAwaitingNewTurn, true);
  assert.equal(result.run.status, 'queued');
});

function coordinatedLifecycleFixture(store) {
  const settled = [];
  const errors = [];
  const context = vm.createContext({
    getOrchestrationRunStore: () => store,
    emitOrchestrationChanges() {},
    finalizeSettledOrchestrations: async runs => settled.push(...runs),
    shouldRetryWaitingNotificationForSourceLifecycle: () => false,
    reconcileAwaitingSourceProofsAfterDone: async () => {},
    dispatchNextDeferredOrchestrationForTarget: async () => {},
    scheduleOrchestrationPolicyTimer: async () => {},
    shortId: value => value,
    console: { log() {}, warn: text => errors.push(text) },
  });
  vm.runInContext('const codexCapacityContinuations = new Map();\n'
    + part(webSource, 'coordinateCodexCapacityContinuation') + '\n'
    + part(webSource, 'processOrchestrationLifecycle'), context);
  return { context, settled, errors };
}

test('actual lifecycle coordinator holds busy:false and done before zero-grace finalization until the exact retry is reserved', async t => {
  const { store, proof, executionContext } = await capacityRunFixture(t, { reason: null, graceMs: 0 });
  const h = coordinatedLifecycleFixture(store);
  let release;
  const decisionGate = new Promise(resolve => { release = resolve; });
  let operations = 0;
  const owner = { tabId: 'T', sessionId: 'S', generation: 'G', turnId: 'E1' };
  const pending = h.context.coordinateCodexCapacityContinuation(owner, async () => {
    operations += 1;
    await decisionGate;
    return store.resolveRecovery('run', 'codex-capacity-retry', proof);
  });
  assert.equal(h.context.coordinateCodexCapacityContinuation(owner, () => assert.fail('same decision must be single-flight')), pending);
  const payload = {
    reason: 'model_capacity', sessionId: 'S', lifecycleGeneration: 'G', provider: 'codex',
    turnId: 'E1', processId: executionContext.processId, turnGeneration: 1, turnStartedAt: 1,
  };
  const busy = h.context.processOrchestrationLifecycle('T', { ...payload, type: 'busy', busy: false });
  const done = h.context.processOrchestrationLifecycle('T', { ...payload, type: 'done' });
  await tick();
  assert.equal((await store.get('run')).status, 'running');
  assert.equal(h.settled.length, 0, 'ordinary failure/source handoff cannot escape before retry decision');
  release();
  await Promise.all([pending, busy, done]);
  assert.equal(operations, 1);
  assert.equal((await store.get('run')).status, 'queued');
  assert.equal((await store.get('run')).resumeAwaitingNewTurn, true);
  assert.equal(h.settled.length, 0, 'old completion stays behind the next-turn barrier');
  assert.deepEqual(h.errors, []);
});

test('actual lifecycle coordinator releases ordinary failure after disabled/exhausted decisions instead of swallowing it', async t => {
  for (const decision of [{ ignored: true }, { exhausted: true }]) {
    const { store, executionContext } = await capacityRunFixture(t, { reason: null, graceMs: 0 });
    const h = coordinatedLifecycleFixture(store);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = h.context.coordinateCodexCapacityContinuation({ tabId: 'T', sessionId: 'S', generation: 'G', turnId: 'E1' }, async () => {
      await gate;
      return decision;
    });
    const done = h.context.processOrchestrationLifecycle('T', {
      type: 'done', reason: 'model_capacity', sessionId: 'S', lifecycleGeneration: 'G', executionContext,
    });
    await tick();
    assert.equal(h.settled.length, 0);
    release();
    await Promise.all([pending, done]);
    assert.equal((await store.get('run')).status, 'failed');
    assert.equal((await store.get('run')).error, 'model_capacity');
    assert.equal(h.settled.length, 1);
    assert.deepEqual(h.errors, []);
  }
});

test('an earlier TUI capacity frame updates presentation but cannot start a source failure handoff', async t => {
  const { store, executionContext } = await capacityRunFixture(t, { reason: null, graceMs: 0 });
  const h = coordinatedLifecycleFixture(store);
  for (const type of ['busy', 'done']) await h.context.processOrchestrationLifecycle('T', {
    type, busy: false, reason: 'model_capacity', capacitySurfaceOnly: true,
    sessionId: 'S', lifecycleGeneration: 'G', executionContext,
  });
  assert.equal((await store.get('run')).status, 'running');
  assert.equal(h.settled.length, 0);
  assert.match(part(mainSource, 'finishCodexModelCapacityOutcome'), /capacitySurfaceOnly: true/);
  const emissions = part(mainSource, 'emitCodexBusy');
  assert.equal((emissions.match(/capacitySurfaceOnly: true/g) || []).length, 2);
});

test('a late same-turn TUI frame cannot downgrade the red exhausted warning', () => {
  const warnings = new Map();
  const red = { type: 'model-capacity', code: 'codex_capacity_retry_exhausted', turnId: 'E', terminalLifecycleGeneration: 'G' };
  warnings.set('T', red);
  const context = vm.createContext({ codexLifecycleWarnings: warnings,
    getTerminalLifecycleGeneration: () => 'G', publishCodexLifecycleWarning() {}, console: { warn() {} } });
  vm.runInContext(part(mainSource, 'setCodexLifecycleWarning'), context);
  const yellow = { ...red, code: 'codex_model_at_capacity' };
  assert.equal(context.setCodexLifecycleWarning('T', yellow), red);
  assert.equal(context.setCodexLifecycleWarning('T', { ...yellow, turnId: 'new' }).code, 'codex_model_at_capacity');
});
