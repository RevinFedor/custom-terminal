'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const { runKeyedExclusive } = require('./codex-writer-ownership');
const { createAgentLaunchPreparationRegistry } = require('./agent-launch-preparation');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { normalizeAgentLaunchSource } = require('./ai-lifecycle-authority');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const { createCodexLaunchPendingResult, classifyCodexLaunchPreparationResult } = require('./codex-runtime-contract');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const parsed = new Map();
function declaration(source, name) {
  if (!parsed.has(source)) parsed.set(source,
    ts.createSourceFile('source.js', source, ts.ScriptTarget.Latest, true));
  const ast = parsed.get(source);
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, 'actual caller declaration: ' + name);
  return node.getText(ast);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function harness(t, { holdInner = null, resumeGoalPreference = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-join-'));
  const orchestrationStore = new OrchestrationRunStore(path.join(directory, 'runs.json'));
  t.after(async () => {
    holdInner?.resolve();
    await orchestrationStore.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const tabId = 'same-tab';
  const request = { tabId, command: 'codex-c', sessionId: 'source-session', cwd: '/fixture/project' };
  const term = {};
  const preparationChanges = [];
  const preparations = createAgentLaunchPreparationRegistry({
    onChange: state => preparationChanges.push(state),
  });
  const admissionReached = deferred();
  const innerReached = deferred();
  const innerCalls = [];
  const writes = [];
  let context;
  const webContext = vm.createContext({
    getOrchestrationRunStore: () => { admissionReached.resolve(); return orchestrationStore; },
    emitOrchestrationRun() {}, scheduleOrchestrationPolicyTimer() {},
  });
  vm.runInContext(declaration(web, 'admitAgentLifecycleLaunch'), webContext);
  const installPending = ({ launchId = 'exact-launch', sessionId = request.sessionId } = {}) => {
    const state = context.terminalCommandState.get(tabId);
    context.terminalCommandState.set(tabId, { ...state, isRunning: true });
    const proof = {
      ...request, sessionId, launchId, terminalToken: context.terminals.get(tabId),
      runSeq: state.runSeq, lifecycleGeneration: context.getTerminalLifecycleGeneration(tabId),
      materializedFresh: false, resumePausedGoal: resumeGoalPreference,
    };
    context.codexLastRunCommandPayload.set(tabId, proof);
    context.codexLaunchAcceptancePending.set(tabId, launchId);
    return proof;
  };
  context = vm.createContext({
    path, crypto, srcMainDir: __dirname, console: { log() {}, warn() {} },
    require: file => file === path.join(__dirname, 'web-server') ? webContext : require(file),
    runKeyedExclusive, normalizeAgentLaunchSource,
    createCodexLaunchPendingResult, classifyCodexLaunchPreparationResult,
    agentLaunchPreparations: preparations,
    codexLaunchInflight: new Map(), aiLifecycleActionInflight: new Map(),
    terminals: new Map([[tabId, term]]),
    terminalLaunchFenceOrders: new WeakMap(), nextTerminalLaunchFenceOrder: 0,
    historyMutationInput: createHistoryMutationInputGate(),
    terminalCommandState: new Map([[tabId, { runSeq: 7, isRunning: false }]]),
    terminalLifecycleEpochs: new WeakMap([[term, 'terminal-epoch']]),
    getTerminalStopRevision: () => 0,
    terminalProjects: new Map([[tabId, request.cwd]]),
    aiStoppingTabs: new Set(), codexLastRunCommandPayload: new Map(),
    codexLaunchAcceptancePending: new Map(), codexKnownSessions: new Map(),
    codexWriterProofs: new Map(), codexResumeSourceLeases: new Map(),
    isCodexTuiEffectivelyReady: () => false,
    // The only mocked execution boundary. A non-join must still reach the
    // existing launch/shell guard; no actual process, PTY or CLI is started.
    runCodexCommandFromPayloadInner: async (_sender, payload) => {
      innerCalls.push(payload);
      innerReached.resolve();
      if (context.terminalCommandState.get(tabId)?.isRunning || context.aiStoppingTabs.has(tabId)) {
        return { success: false, accepted: false, error: 'shell_not_idle', reason: 'existing-launch-guard' };
      }
      if (holdInner) await holdInner.promise;
      writes.push({ command: payload.command, sessionId: payload.sessionId });
      const state = context.terminalCommandState.get(tabId);
      context.terminalCommandState.set(tabId, { ...state, runSeq: state.runSeq + 1 });
      const proof = installPending({ sessionId: payload.sessionId });
      return createCodexLaunchPendingResult({ tabId, command: payload.command,
        launchId: proof.launchId, resumeSourceSessionId: payload.sessionId });
    },
  });
  vm.runInContext([
    'captureAgentLaunchFence', 'withAgentLaunchFence', 'assertAgentSendLaunchCurrent', 'returnAgentSendLaunchRefusal',
    'runAgentLaunchIntentAttempt',
    'getTerminalLifecycleGeneration', 'getCodexWriterProofSnapshot',
    'getCodexResumeSourceLeaseForTab', 'getCodexResumeReadIdentityLeaseForTab',
    'currentCodexAcceptedResumeSourceProof', 'admitAiLifecycleLaunch',
    'runCodexCommandAfterLifecycleAdmission', 'reuseCurrentCodexResumeLaunch',
    'runCodexCommandWithinLifecycle', 'runCodexCommandFromPayload',
  ].map(name => declaration(main, name)).join('\n'), context);
  return { context, request, term, orchestrationStore, preparations, preparationChanges,
    admissionReached, innerReached, innerCalls, writes, installPending,
    run: (patch = {}) => context.runCodexCommandFromPayload(null, { ...request, ...patch }),
  };
}

function assertNoInputReadinessClaim(result) {
  for (const key of ['inputReady', 'ready', 'submitCapability', 'tuiReady']) {
    assert.equal(Object.hasOwn(result, key), false, 'Resume joining does not prove ' + key);
  }
}

test('actual AutoResume + History callers share one physical Resume and one preparation', async t => {
  const release = deferred();
  const h = harness(t, { holdInner: release });
  const auto = h.run({ launchSource: 'auto-resume' });
  await h.innerReached.promise;
  const history = h.run({ launchSource: 'history-source' });
  await Promise.resolve();
  assert.equal(h.innerCalls.length, 1);
  assert.equal(h.preparations.get(h.request.tabId).preparing, true);
  release.resolve();
  const [first, second] = await Promise.all([auto, history]);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(second.joined, true);
  assert.equal(first.launchId, second.launchId);
  assert.equal(second.accepted, null);
  assert.equal(second.acceptancePending, true);
  assert.equal(second.writerConfirmed, false);
  assert.equal(second.sessionId, null);
  assert.equal(h.innerCalls.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.preparationChanges.filter(s => s.preparing).length, 1);
  assert.equal(h.preparationChanges.filter(s => !s.preparing && s.accepted).length, 1);
  assert.equal(h.preparations.get(h.request.tabId), null, 'duplicate does not leave a rejected loader');
  assert.equal(h.context.codexLaunchInflight.size, 0);
  assert.equal(h.context.aiLifecycleActionInflight.size, 0);
  assertNoInputReadinessClaim(first);
  assertNoInputReadinessClaim(second);
});

for (const preference of [false, null]) test('after-restart first + AutoResume join preserves existing Goal policy ' + preference, async t => {
  const release = deferred();
  const h = harness(t, { holdInner: release, resumeGoalPreference: preference });
  const queuedStart = h.run({ launchSource: 'explicit' });
  await h.innerReached.promise;
  const auto = h.run({ launchSource: 'auto-resume' });
  release.resolve();
  const [first, second] = await Promise.all([queuedStart, auto]);
  assert.equal(first.success, true);
  assert.equal(second.success, true, 'same already-written Resume is not another foreground command');
  assert.equal(second.joined, true);
  assert.equal(second.acceptancePending, true);
  assert.equal(second.launchId, first.launchId);
  assert.equal(second.sessionId, null, 'a pending Resume is not a proven writer');
  assert.equal(h.writes.length, 1);
  assert.equal(h.innerCalls.length, 1);
  assert.equal(h.preparationChanges.filter(s => s.preparing).length, 1);
  assert.equal(h.preparationChanges.filter(s => s.preparing === false && s.accepted === false).length, 0);
  assert.equal(h.preparations.get(h.request.tabId), null, 'no red rejected-preparation snapshot');
  assert.equal(h.context.codexLastRunCommandPayload.get(h.request.tabId).resumePausedGoal, preference,
    'joining never changes the policy selected by the original launch');
  assertNoInputReadinessClaim(second);
});

test('explicit different Resume Goal intent still refuses an in-flight Leave-paused launch', async t => {
  const h = harness(t, { resumeGoalPreference: false });
  h.installPending();
  const result = await h.run({ resumePausedGoal: true });
  assert.equal(result.success, false);
  assert.equal(result.joined, undefined);
  assert.equal(h.writes.length, 0);
});

test('actual AutoResume caller joins queue-started Leave paused, waits for ready and emits no failure toast', async t => {
  const h = harness(t, { resumeGoalPreference: false });
  const first = await h.run({ launchSource: 'explicit' });
  assert.equal(first.success, true);
  const { classifyInterruptedRestoreRuntime, isTransientInterruptedRestoreAdmission,
    buildInterruptedRestoreIncidentReport } = await import('../renderer/utils/interruptedAutoRestore.mjs');
  const { resolvePtyAgentOwner } = await import('../renderer/utils/ptyAgentOwner.mjs');
  const state = { tabId: h.request.tabId, cwd: h.request.cwd, tabType: 'terminal',
    commandType: 'codex', codexSessionId: h.request.sessionId, wasInterrupted: false };
  const store = { getState: () => ({ openProjects: new Map([['P', { tabs: new Map([[state.tabId, state]]) }]]) }),
    subscribe: () => () => {} };
  const readyEntered = deferred(), ready = deferred();
  t.after(() => ready.resolve({ success: false, ready: false, error: 'test-cleanup' }));
  let cleared = 0;
  const source = fs.readFileSync(path.join(__dirname, '../renderer/utils/continueInterruptedSession.ts'), 'utf8');
  const tree = ts.createSourceFile('continue.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = tree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n')
    .replace("await import('../store/useWorkspaceStore')", 'await importWorkspaceStore()');
  const ipc = { invoke: async (channel, payload) => {
    if (channel === 'codex:get-runtime-projection') return { success: true, liveLifecycle: true,
      sessionStatus: 'starting', writerConfirmed: false, sessionId: null,
      readIdentitySource: 'unresolved', readSessionId: null, launchId: first.launchId,
      lifecycleGeneration: h.context.getTerminalLifecycleGeneration(state.tabId) };
    if (channel === 'codex:run-command') return h.run(payload);
    if (channel === 'agent:wait-start-ready') {
      assert.equal(payload.expectedOwner.launchId, first.launchId);
      assert.equal(payload.expectedOwner.lifecycleGeneration, h.context.getTerminalLifecycleGeneration(state.tabId));
      readyEntered.resolve(); return ready.promise;
    }
    throw Error('unexpected controlled IPC: ' + channel);
  } };
  // Admission transport/store/readiness ports are controlled. The actual
  // renderer caller, Main queues/guard/registry, join helper and App toast
  // consumer run; this is not a packaged UI or physical provider acceptance.
  const context = vm.createContext({ exports: {}, console: { log() {}, warn() {} }, AbortController,
    window: { require: name => { assert.equal(name, 'electron'); return { ipcRenderer: ipc }; } },
    terminalRegistry: { get: () => null }, clearPendingResume() {}, markPendingResume() {},
    buildCodexRunPayload: payload => payload, resolvePtyAgentOwner,
    classifyInterruptedRestoreRuntime, isTransientInterruptedRestoreAdmission,
    importWorkspaceStore: async () => ({ useWorkspaceStore: store }),
    createAgentLaunchAdmission: () => ({ run: (channel, payload) => ipc.invoke(channel, payload),
      finish: async () => {}, snapshot: () => ({}) }) });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS } }).outputText, context);
  const pending = context.exports.continueInterruptedSession({ ...h.request, projectId: 'P', engine: 'codex',
    clearInterruptedState: () => { cleared++; }, launchSource: 'auto-resume', waitUntilReady: true });
  const phase = await Promise.race([readyEntered.promise.then(() => 'waiting'), pending.then(() => 'settled')]);
  assert.equal(phase, 'waiting', 'joined is not a false startup error or a readiness claim');
  assert.equal(cleared, 0);
  assert.equal(h.writes.length, 1);
  assert.equal(h.preparationChanges.filter(row => row.accepted === false).length, 0);
  ready.resolve({ success: true, ready: true, status: { inputReady: true } });
  const result = await pending;
  assert.equal(result.success, true); assert.equal(result.ready, true); assert.equal(cleared, 1);
  const app = fs.readFileSync(path.join(__dirname, '../renderer/App.tsx'), 'utf8');
  const begin = app.indexOf('for (const { item, result } of startResults)');
  const end = app.indexOf('const startedCount =', begin);
  assert(begin > 0 && end > begin);
  const toasts = [];
  vm.runInNewContext(app.slice(begin, end), { startResults: [{ item: { ...h.request, engine: 'codex' }, result }],
    showToast: (...args) => toasts.push(args), buildInterruptedRestoreIncidentReport, Date });
  assert.equal(toasts.length, 0);
});

const nonJoinCases = [
  ['foreign session', { sessionId: 'foreign-session' }],
  ['fork', { command: 'codex-f' }],
  ['fresh launch', { command: 'codex', sessionId: null }],
  ['materialized fresh', { materializedFresh: true }],
  ['next-launch settings intent', { settingsIntent: 'next-launch', model: 'other-model' }],
  ['model migration', { modelMigrationPending: true }],
  ['different cwd', { cwd: '/fixture/other' }],
  ['different explicit launch', { launchId: 'other-launch' }],
  ['paused-goal mutation', { resumePausedGoal: false }],
  ['new developer instructions', { developerInstructions: 'new instructions' }],
  ['startup replacement', { _mcpStartupRecoveryHandoff: { phase: 'stopped' } }],
  ['explicit restart', { restartReason: 'user-restart' }],
  ['replaced terminal', {}, h => h.context.terminals.set(h.request.tabId, {})],
  ['changed run', {}, h => h.context.terminalCommandState.get(h.request.tabId).runSeq++],
  ['changed generation', {}, h => h.context.terminalLifecycleEpochs.set(h.term, 'replaced-epoch')],
  ['Stop', {}, h => h.context.aiStoppingTabs.add(h.request.tabId)],
  ['different acceptance owner', {}, h => h.context.codexLaunchAcceptancePending.set(h.request.tabId, 'other-launch')],
];
for (const [name, patch, change] of nonJoinCases) {
  test('non-identical Resume keeps the existing guard: ' + name, async t => {
    const h = harness(t);
    h.installPending();
    change?.(h);
    const result = await h.run(patch);
    assert.equal(result.success, false);
    assert.equal(result.accepted, false);
    assert.equal(result.joined, undefined);
    assert.equal(result.error, 'shell_not_idle');
    assert.equal(h.innerCalls.length, 1, 'non-join falls through to the original guard');
    assert.equal(h.writes.length, 0);
  });
}

test('owner is read after awaited lifecycle admission, including a newly appeared exact launch', async t => {
  const h = harness(t);
  const gate = deferred();
  h.orchestrationStore.reservationChain = gate.promise;
  const resultPromise = h.run();
  await h.admissionReached.promise;
  h.installPending({ launchId: 'appeared-during-admission' });
  gate.resolve();
  const result = await resultPromise;
  assert.equal(result.joined, true);
  assert.equal(result.launchId, 'appeared-during-admission');
  assert.equal(h.innerCalls.length, 0);
  assert.equal(h.preparationChanges.length, 0);
  assertNoInputReadinessClaim(result);
});

test('an owner replaced during awaited admission cannot reuse the pre-await proof', async t => {
  const h = harness(t);
  h.installPending();
  const gate = deferred();
  h.orchestrationStore.reservationChain = gate.promise;
  const resultPromise = h.run();
  await h.admissionReached.promise;
  h.context.terminals.set(h.request.tabId, {});
  gate.resolve();
  const result = await resultPromise;
  assert.equal(result.joined, undefined);
  assert.equal(result.error, 'agent_launch_cancelled');
  assert.equal(h.innerCalls.length, 0, 'the existing terminal/Stop fence now rejects before the shell executor');
  assert.equal(h.writes.length, 0);
});

test('exact pending Resume cannot bypass an authoritative automatic Stop admission', async t => {
  const h = harness(t);
  h.installPending();
  await h.orchestrationStore.create({
    runId: 'stop-owner', sourceTabId: 'source-tab', sourceProjectId: 'project',
    targetTabId: h.request.tabId, targetProjectId: 'project', targetCreated: true,
    promptHash: 'exact-prompt', targetPromptAuditHash: 'exact-audit', promptChars: 12,
  });
  await h.orchestrationStore.patch('stop-owner', {
    status: 'completed', resultComplete: true, completedAt: Date.now() - 1000,
    autoStopAt: Date.now() - 500, autoStopStatus: 'scheduled',
  });
  const result = await h.run({ launchSource: 'auto-resume' });
  assert.equal(result.suppressed, true);
  assert.equal(result.accepted, false);
  assert.equal(result.joined, undefined);
  assert.equal(result.reason, 'orchestration-auto-stop-pending');
  assert.equal(h.preparationChanges.length, 0);
  assert.equal(h.innerCalls.length, 0);
  assert.equal(h.writes.length, 0);
});

test('accepted source → child writer joins after startup payload cleanup without claiming input readiness', async t => {
  const h = harness(t);
  const pending = h.installPending();
  const writer = { ...pending, valid: true, sourceSessionId: pending.sessionId,
    sessionId: 'accepted-child' };
  writer.acceptedResumeSource = h.context.currentCodexAcceptedResumeSourceProof(h.request.tabId, writer);
  assert.equal(writer.acceptedResumeSource.sessionId, h.request.sessionId);
  h.context.codexKnownSessions.set(h.request.tabId, writer.sessionId);
  h.context.codexWriterProofs.set(h.request.tabId, writer);
  h.context.codexLastRunCommandPayload.clear();
  h.context.codexLaunchAcceptancePending.clear();
  for (const sessionId of [h.request.sessionId, writer.sessionId]) {
    const result = await h.run({ sessionId });
    assert.equal(result.success, true);
    assert.equal(result.joined, true);
    assert.equal(result.accepted, true);
    assert.equal(result.acceptancePending, false);
    assert.equal(result.writerConfirmed, true);
    assert.equal(result.sessionId, 'accepted-child');
    assert.equal(result.launchId, pending.launchId);
    assertNoInputReadinessClaim(result);
  }
  assert.equal(h.innerCalls.length, 0);
  assert.equal(h.preparationChanges.length, 0);
  assert.equal(h.writes.length, 0);
  writer.valid = false;
  assert.equal((await h.run()).error, 'shell_not_idle', 'retained source alone is not a live writer');
});

test('ready TUI with an exact Resume read lease joins before the first writer, but stale lease cannot', async t => {
  const h = harness(t);
  const pending = h.installPending();
  h.context.codexResumeSourceLeases.set(h.request.sessionId, {
    tabId: h.request.tabId, launchId: pending.launchId,
    readIdentity: { ...pending, tabId: h.request.tabId },
  });
  h.context.codexLastRunCommandPayload.clear();
  h.context.codexLaunchAcceptancePending.clear();
  h.context.isCodexTuiEffectivelyReady = () => true;
  const result = await h.run();
  assert.equal(result.joined, true);
  assert.equal(result.launchId, pending.launchId);
  assert.equal(result.accepted, true);
  assert.equal(result.writerConfirmed, false);
  assert.equal(result.sessionId, null);
  assert.equal(h.writes.length, 0);
  assertNoInputReadinessClaim(result);
  h.context.codexResumeSourceLeases.get(h.request.sessionId).readIdentity.runSeq++;
  assert.equal((await h.run()).error, 'shell_not_idle');
  assert.equal(h.writes.length, 0);
});
