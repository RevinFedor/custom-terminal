'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { createProcessTreeSnapshotSingleFlight } = require('./process-tree-snapshot-single-flight');
const { AI_PROCESS_LOOKUP_STATUS, AiProcessLookupError, inspectProcessLookup } = require('./ai-process-liveness');

// Actual Main verifier, process-cache gate, descendant traversal and scope guards.
// Only the OS snapshot, composer/settings proof and publication ports are controlled.
const source = fs.readFileSync(process.env.NOTED_READY_MAIN_SOURCE || path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const names = ['getProcessTreeSnapshot', 'findAiDescendantProcessesByTab',
  'inspectAiDescendantProcessesByTab', 'captureAiProcessLookupScope',
  'aiProcessLookupScopeCurrent', 'commandLooksLikeAiProcess',
  'aiProcessLookupCacheKey', 'markCodexTuiReadyAfterVerifiedComposer'];
const declarations = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(ast);
}).join('\n');

function fixture({ launch = true, established = false } = {}) {
  const state = { now: 100, alive: false, captures: [], logs: [], publications: [],
    lifecycle: 'physical:1', screenReady: true, settingsMatch: true, onCapture: null,
    onRefresh: null, captureError: null };
  const terminal = { pid: 10 };
  const launchPayload = { launchId: 'launch:1', startedAt: 50 };
  const events = new EventEmitter();
  const context = {
    path, AI_PROCESS_LOOKUP_STATUS, AiProcessLookupError, inspectProcessLookup,
    nodePerformance: { now: () => state.now, timeOrigin: 10000 },
    PROCESS_TREE_SNAPSHOT_TTL_MS: 750, processTreeSnapshotCache: null,
    terminals: new Map([['T', terminal]]),
    terminalCommandState: new Map([['T', { runSeq: 2, isRunning: true }]]),
    terminalProjectIds: new Map([['T', 'P']]), terminalProjects: new Map([['T', '/fixture']]),
    claudeLaunchGenerationByTab: new Map(),
    codexLastRunCommandPayload: new Map(launch ? [['T', launchPayload]] : []),
    codexPendingModelMigrations: new Set(), codexMcpStartupWatchdogs: new Map(),
    codexTuiReadyTabs: new Set(established ? ['T'] : []),
    codexTuiReadyBuffers: new Map(), codexTuiReadyRejectKeys: new Map(),
    codexTuiReadyLastNotReady: new Map(), codexTuiReadyMeta: new Map(),
    aiProcessLookupCache: new Map(),
    getTerminalLifecycleGeneration: () => state.lifecycle,
    beginPerfOp: () => 'fixture', endPerfOp() {},
    console: Object.fromEntries(['log', 'warn', 'error'].map(name => [name,
      (...args) => state.logs.push(args.join(' '))])),
    refreshCodexEmptyReadSource: async () => { await state.onRefresh?.(); },
    inspectCurrentCodexMcpStartupScreenWithTierIdentity: async () => ({ success: true,
      inspected: { ready: state.screenReady, reason: 'current-composer' }, currentFrameText: '' }),
    resolveCodexVerifiedCurrentFrameSettings: () => ({ model: 'fixture-model', effort: 'low' }),
    verifyCodexNextLaunchSettings: () => ({ matches: state.settingsMatch, error: 'settings-mismatch' }),
    armCodexCurrentLaunchSettingsProof() {}, clearCodexLaunchAcceptancePending() {},
    finishCodexStartupLifecycle: () => state.publications.push('finish-startup'),
    agentLaunchPreparations: { clearRejected() {} },
    getCurrentCodexServiceTierProofIdentity: () => ({ success: false }),
    getCodexProvisionalSettingsSnapshot: () => null,
    getCodexRuntimeSessionId: () => 'same-session', getCodexPublicWriterFields: () => ({}),
    _webBroadcast() {}, emitCodexTuiNotReadyState() {}, emitAgentReadinessChanged() {},
    mainWindow: null, ipcMain: events,
    broadcastCodexReadySnapshot: () => state.publications.push('ready'),
  };
  context.processTreeSnapshotSingleFlight = createProcessTreeSnapshotSingleFlight({
    now: () => state.now,
    capture: async ({ forceFresh }) => {
      state.captures.push({ forceFresh });
      await state.onCapture?.();
      if (state.captureError) throw state.captureError;
      const child = { pid: 11, ppid: 10, cmd: 'codex --no-alt-screen resume same-session' };
      const snapshot = { children: new Map(state.alive ? [[10, [child]]] : []),
        processesByPid: new Map(state.alive ? [[11, child]] : []),
        createdAt: state.now, psMs: 1, parseMs: 0, linesCount: 1 };
      context.processTreeSnapshotCache = snapshot;
      return snapshot;
    },
  });
  vm.createContext(context);
  const api = vm.runInContext(declarations + '\n({' + names.join(',') + '})', context);
  events.on('agent:tui-ready-internal', () => state.publications.push('internal-ready'));
  return { state, context, api,
    async seedPreLaunchAbsent() {
      assert.equal((await api.inspectAiDescendantProcessesByTab('T', 'codex')).status, 'absent');
      state.alive = true;
      state.now = 400; // The new process has rendered, but the pre-launch cache is still valid.
    },
    mark: options => api.markCodexTuiReadyAfterVerifiedComposer('T', 'headless-startup-frame', options),
  };
}

test('committed startup composer checks the live process instead of reusing the pre-launch absent snapshot', async () => {
  const h = fixture();
  await h.seedPreLaunchAbsent();
  assert.equal(await h.mark(), true);
  assert.equal(h.state.captures.length, 2, 'one new observation, no retry timer or deadline read');
  assert.equal(h.state.captures[1].forceFresh, true);
  assert.deepEqual(h.state.publications, ['finish-startup', 'internal-ready', 'ready']);
  assert.equal(h.context.codexTuiReadyTabs.has('T'), true);
});

test('concurrent startup verifiers share the same fresh physical observation', async () => {
  const h = fixture();
  await h.seedPreLaunchAbsent();
  let release;
  h.state.onCapture = () => new Promise(resolve => { release = resolve; });
  const first = h.mark(), second = h.mark();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.captures.length, 2);
  release();
  assert.equal(await first, true);
  assert.equal(await second, true);
});

for (const status of ['absent', 'unknown']) test('fresh ' + status + ' never promotes a composer to ready', async () => {
  const h = fixture();
  await h.seedPreLaunchAbsent();
  if (status === 'absent') h.state.alive = false;
  else h.state.captureError = new Error('ps timed out');
  assert.equal(await h.mark(), false);
  assert.equal(h.state.captures.length, 2);
  assert.equal(h.context.codexTuiReadyTabs.has('T'), false);
  assert.deepEqual(h.state.publications, []);
  assert.ok(h.state.logs.some(line => line.includes(status === 'absent'
    ? 'no-live-process' : 'process lookup unknown')));
});

for (const boundary of ['launch', 'terminal', 'run', 'lifecycle', 'cwd', 'project', 'stop']) {
  test(boundary + ' change during fresh process read cannot publish readiness', async () => {
    const h = fixture();
    await h.seedPreLaunchAbsent();
    h.state.onCapture = () => {
      if (boundary === 'launch') h.context.codexLastRunCommandPayload.set('T', { launchId: 'successor' });
      if (boundary === 'terminal') h.context.terminals.set('T', { pid: 20 });
      if (boundary === 'run') h.context.terminalCommandState.get('T').runSeq++;
      if (boundary === 'lifecycle') h.state.lifecycle = 'physical:2';
      if (boundary === 'cwd') h.context.terminalProjects.set('T', '/other');
      if (boundary === 'project') h.context.terminalProjectIds.set('T', 'other');
      if (boundary === 'stop') {
        h.context.codexLastRunCommandPayload.delete('T');
        h.context.terminalCommandState.get('T').isRunning = false;
      }
    };
    assert.equal(await h.mark(), false);
    assert.deepEqual(h.state.publications, []);
  });
}

for (const proof of ['screen', 'settings', 'late-launch', 'late-terminal', 'late-run', 'watchdog']) {
  test('fresh found process still requires current ' + proof + ' proof', async () => {
    const h = fixture();
    await h.seedPreLaunchAbsent();
    const watchdog = {};
    h.context.codexMcpStartupWatchdogs.set('T', watchdog);
    h.state.onRefresh = () => {
      if (proof === 'screen') h.state.screenReady = false;
      if (proof === 'settings') h.state.settingsMatch = false;
      if (proof === 'late-launch') h.context.codexLastRunCommandPayload.set('T', { launchId: 'other' });
      if (proof === 'late-terminal') h.context.terminals.set('T', { pid: 20 });
      if (proof === 'late-run') h.context.terminalCommandState.get('T').runSeq++;
      if (proof === 'watchdog') h.context.codexMcpStartupWatchdogs.set('T', {});
    };
    assert.equal(await h.mark({ expectedWatchdog: watchdog }), false);
    assert.equal(h.context.codexTuiReadyTabs.has('T'), false);
    assert.deepEqual(h.state.publications, []);
  });
}

for (const options of [{ launch: false }, { established: true }]) {
  test('ordinary established/non-launch verification retains its process-cache semantics ' + JSON.stringify(options), async () => {
    const h = fixture(options);
    h.state.alive = true;
    await h.api.getProcessTreeSnapshot();
    assert.equal(await h.mark(), true);
    assert.equal(h.state.captures.length, 1, 'no extra ps for a steady-state verification');
  });
}
