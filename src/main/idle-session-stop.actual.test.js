'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createIdleSessionStop } = require('./idle-session-stop');
const { activeWorkflowSessionMember, workflowSessionScopeKey, createSdkStopObservation, observeSdkStopMessage } = require('./workflow-session-stop');
function functions(file, names) {
  const tree = ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, file), 'utf8'), ts.ScriptTarget.Latest, true);
  assert.equal(tree.parseDiagnostics.length, 0);
  return names.map(name => {
    const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name); return node.getText(tree);
  }).join('\n');
}
test('actual Main capture uses complete selected membership, saved completion and current input readiness', () => {
  const makeRow = (id, workflowId = 'work') => ({ tabId: id, membership: { workflowId, revision: 1 },
    nativeRow: { id, tab_type: 'terminal' }, executionResolved: true, executionSubject: { subjectId: id } });
  const rows = ['idle', 'hidden', 'reserve', 'busy', 'starting', 'sdk', 'script'].map(id => makeRow(id));
  rows.push(makeRow('foreign', 'other'));
  const context = vm.createContext({ path, srcMainDir: __dirname, activeWorkflowSessionMember, workflowSessionScopeKey,
    idleSessionStopService: { snapshot: () => ({ policy: { allWorkflows: false, workflowIds: ['work'] } }) },
    workflowOrganization: { ready: () => true, service: { getTab: id => rows.find(row => row.tabId === id),
      listWorkflows: () => [{ id: 'work' }, { id: 'other' }], listMembers: id => rows.filter(row => row.membership.workflowId === id) } },
    captureWorkflowSessionOwner: row => ({ live: true, kind: row.tabId === 'sdk' ? 'sdk' : row.tabId === 'script' ? 'terminal' : 'ai',
      toolType: 'codex', token: { stopObservation: { ...createSdkStopObservation(true), completedAt: 321 } } }),
    readWorkflowSessionBusy: id => ({ known: true, busy: id === 'busy' }),
    computeProjectActivity: () => ({ projects: [{ tabs: rows.map(row => ({ tabId: row.tabId, inputReady: row.tabId !== 'starting' })) }] }),
    agentSendActivity: { snapshot: () => ({ pendingTabIds: [] }) },
    codexTurnWatchers: new Map(rows.map(row => [row.tabId, { lastOutcomeTs: 123 }])), claudeHookLastEvent: new Map(),
    codexLastRunCommandPayload: new Map([['reserve', { startedAt: 200 }]]), claudeLaunchGenerationByTab: new Map(),
    require: () => ({ readInheritedTabActivity: () => ({ known: true, sourceTabIds: [] }), idleStopQueueActivityKey: () => 'proof-version' }),
  });
  vm.runInContext(functions('main.js', ['captureIdleSessionStopTargets']), context);
  const captured = JSON.parse(JSON.stringify(context.captureIdleSessionStopTargets()));
  assert.deepEqual(captured.map(row => row.tabId), ['idle', 'hidden', 'reserve', 'busy', 'starting', 'sdk']);
  assert.equal(captured.find(row => row.tabId === 'idle').completedAt, 123);
  assert.equal(captured.find(row => row.tabId === 'reserve').completedAt, 0, 'a resumed process does not inherit an expired pre-launch clock');
  assert.equal(captured.find(row => row.tabId === 'sdk').completedAt, 321);
  assert.equal(captured.find(row => row.tabId === 'starting').idle, false);
  assert.equal(captured.find(row => row.tabId === 'busy').idle, false);
});

test('actual Main observation requires process, Root continuation and empty draft proofs', async () => {
  const code = functions('main.js', ['observeIdleSessionStop']);
  for (const [known, queueBusy, draft, expected] of [
    [false, false, false, false], [true, true, false, false], [true, false, true, false],
    [true, false, null, false], [true, false, false, true],
  ]) {
    const calls = [];
    const context = vm.createContext({ path, srcMainDir: __dirname,
      observeWorkflowSessionProcess: async () => ({ known, identity: 'actual-owner-proof' }),
      require: () => ({ readIdleStopQueueGuard: async () => { calls.push('root'); return { known: true, busy: queueBusy }; } }),
      inspectSavedHistoryDraft: () => { calls.push('draft'); return { success: draft !== null, hasDraft: draft }; },
    });
    vm.runInContext(code, context);
    assert.equal((await context.observeIdleSessionStop('A', { kind: 'ai', toolType: 'codex' })).known, expected);
    if (!known) assert.deepEqual(calls, []);
    if (queueBusy) assert.deepEqual(calls, ['root']);
  }
});

test('actual Root read distinguishes future queued triggers from preparing/unknown/compact/child work', async () => {
  const code = functions('web-server.js', ['readIdleStopQueueGuard']);
  for (const phase of ['paused', 'armed', 'countdown', 'waiting-app-restart', 'waiting-dependency',
    'executing', 'waiting-readiness', 'checking-condition', 'editing', 'delivery-unknown', 'shutdown']) {
    const context = vm.createContext({ getRunAfterApi: () => ({ read: async () => ({ runAfter: {
      known: true, runtime: { phase, pending: false, ownBusy: false, inheritedBusy: false, appInstanceKnown: true },
    } }) }) });
    vm.runInContext(code, context);
    const result = await context.readIdleStopQueueGuard('A');
    assert.equal(!!result.busy, !['paused', 'armed', 'countdown', 'waiting-app-restart', 'waiting-dependency'].includes(phase));
  }
  for (const patch of [{ pending: true }, { inheritedBusy: true }, { ownBusy: true }, { autoCompact: { phase: 'compacting' } }]) {
    const context = vm.createContext({ getRunAfterApi: () => ({ read: async () => ({ runAfter: {
      known: true, runtime: { phase: 'armed', appInstanceKnown: true, ...patch },
    } }) }) });
    vm.runInContext(code, context); assert.equal((await context.readIdleStopQueueGuard('A')).busy, true);
  }
});

test('existing SQLite app-state owner persists policy for a new Main service', { skip: process.versions.modules !== '119' }, () => {
  const Database = require('better-sqlite3'); const db = new Database(':memory:');
  db.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const source = fs.readFileSync(path.join(__dirname, 'database.js'), 'utf8');
  const tree = ts.createSourceFile('database.js', source, ts.ScriptTarget.Latest, true);
  const cls = tree.statements.find(node => ts.isClassDeclaration(node) && node.members.some(m => m.name?.text === 'getAppState'));
  const get = cls.members.find(m => m.name?.text === 'getAppState').getText(tree);
  const set = cls.members.find(m => m.name?.text === 'setAppState').getText(tree);
  const context = vm.createContext({ db, WORKSPACE_SESSION_APP_STATE_KEY: 'workspace-session' });
  vm.runInContext(`class Owner { constructor() { this.db=db; } ${get} ${set} }; owner=new Owner();`, context);
  const ports = { readPolicy: () => context.owner.getAppState('globalIdleSessionStop'),
    savePolicy: policy => context.owner.setAppState('globalIdleSessionStop', JSON.stringify(policy)),
    capture: () => [], sameOwner: () => false };
  const service = createIdleSessionStop(ports);
  service.update({ workflowIds: ['work'], minutes: 23, includeAlreadyIdle: false });
  const restored = createIdleSessionStop(ports);
  assert.equal(restored.snapshot().policy.minutes, 23);
  assert.deepEqual(restored.snapshot().policy.workflowIds, ['work']);
  assert.equal(restored.snapshot().policy.includeAlreadyIdle, false);
  service.dispose(); restored.dispose(); db.close();
});

test('SDK own interrupt result cannot restart the idle clock or invalidate its admitted hard Stop', async () => {
  const effects = [], state = createSdkStopObservation(true); state.completedAt = 123;
  const session = { stopObservation: state, query: { interrupt: async () => {
    effects.push('interrupt'); observeSdkStopMessage(state, { type: 'result', is_error: true }, false);
  }, close: () => effects.push('close') }, abortController: { abort: () => effects.push('abort') },
    channel: { end: () => effects.push('end') } };
  const context = vm.createContext({ console: { log() {}, warn() {}, error() {} },
    sdkSessions: new Map([['A', session]]), jsonlWatchers: new Map(), setTimeout: done => done(),
    BrowserWindow: { getAllWindows: () => [] }, stopJsonlWatcher: () => {}, _webBroadcast() {} });
  vm.runInContext(functions('main.js', ['stopSdkSession']), context);
  const result = await context.stopSdkSession({ tabId: 'A', hard: true }, {
    expectedSession: session, guard: () => ({ allowed: state.completedAt === 123 && !state.busy }), onStopAdmitted() {},
  });
  assert.equal(result.success, true); assert.ok(effects.includes('close')); assert.equal(state.completedAt, 123);
  assert.equal(observeSdkStopMessage(state, { type: 'stream_event' }), true);
  assert.equal(observeSdkStopMessage(state, { type: 'stream_event' }), false, 'stream chunks do not publish another idle-stop refresh');
});
