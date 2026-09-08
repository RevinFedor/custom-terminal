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

function harness(t, { holdInner = null } = {}) {
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
      materializedFresh: false, resumePausedGoal: true,
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
    terminalCommandState: new Map([[tabId, { runSeq: 7, isRunning: false }]]),
    terminalLifecycleEpochs: new WeakMap([[term, 'terminal-epoch']]),
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
  assert.equal(result.error, 'shell_not_idle');
  assert.equal(h.innerCalls.length, 1);
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
