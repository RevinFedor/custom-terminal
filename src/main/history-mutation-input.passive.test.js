'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const { EventEmitter } = require('node:events');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const { ConversationOwners } = require('./conversation-owner');
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const code = names => names.map(name => {
  const n = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(n, name); return n.getText(ast);
}).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const quiet = { log() {}, warn() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function mainFixture(t, provider = 'codex') {
  const sql = new Database(':memory:');
  sql.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  t.after(() => sql.close());
  const db = { getAppState(key) { const row = sql.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setAppState(key, value) { sql.prepare('INSERT OR REPLACE INTO app_state VALUES(?,?)').run(key, JSON.stringify(value)); } };
  const term = {}, command = { isRunning: false, runSeq: 2 };
  const state = { sid: 'SOURCE', input: 1, ready: false, status: 'starting', processStatus: 'found', checkpoint: 'one' };
  const events = new EventEmitter(); let reads = 0, wakes = 0;
  const owners = new ConversationOwners({ db, instanceId: 'fixture', publish() {}, capture: () => ({
    known: true, provider, sessionId: state.sid, projectId: 'P', cwd: '/fixture', terminalId: 'PTY',
    instanceId: 'fixture', launchId: provider === 'codex' ? context.codexLastRunCommandPayload.get('T')?.launchId
      : context.claudeLaunchGenerationByTab.get('T')?.generation, runSeq: command.runSeq,
  }) });
  const context = vm.createContext({ console: quiet, Buffer, require: id => id.endsWith('history-mutation-input')
    ? { createHistoryMutationInputGate } : id.endsWith('web-server')
      ? { historyMutationInputBusy: () => false, wakeHistoryMutationInput: () => wakes++ } : assert.fail(id),
    path, srcMainDir: __dirname, ipcMain: events, projectManager: { db },
    terminals: new Map([['T', term]]), terminalCommandState: new Map([['T', command]]),
    terminalProjectIds: new Map([['T', 'P']]), terminalProjects: new Map([['T', '/fixture']]),
    codexLastRunCommandPayload: new Map(), claudeLaunchGenerationByTab: new Map(), aiStoppingTabs: new Map(),
    conversationOwners: owners, sdkSessions: new Map(), bridgeKnownSessions: new Map(), codexKnownSessions: new Map(),
    claudeStartupGateRevisions: new Map(), claudeTurnBusy: new Map(), codexRuntimePolicies: { read: () => null },
    codexLiveSettingsObserver: { read: () => null }, agentLaunchPreparations: { get: () => null },
    getActiveAgentExecutionContext: () => null, currentClaudeStartupDefaultsGate: () => null,
    claudePromptReady: new Set(), getClaudePtyRuntimePresence: () => ({ status: state.status, inputReady: state.ready }),
    resolveAiToolTypeForTab: () => provider, resolveAuthoritativeTabProjectId: () => 'P',
    getTerminalLifecycleGeneration: () => 'TERM:' + command.runSeq, getTerminalInputRevision: () => state.input,
    getTerminalStopRevision: () => 0,
    codexSessionIdFromDb: () => state.sid, getCodexWriterProofSnapshot: () => null,
    captureCodexRuntimeReadCheckpoint: () => ({ all: state.checkpoint }),
    // Only physical/readiness leaves are controlled. The coherent reader,
    // owner reader, observer, factory, SQLite marker and event wiring are real.
    readMainAgentStartReadiness: async () => { reads++; return { toolType: provider, sessionId: state.sid,
      savedSessionId: state.sid, inputReady: state.ready, status: state.status, liveLifecycle: state.processStatus !== 'absent' }; },
    readAiLifecycleIdentityForTab: async () => ({ terminalRunSeq: command.runSeq, inputRevision: state.input,
      processStatus: state.processStatus, processPid: state.processStatus === 'found' ? 123 : null }),
    getPersistedAiSessionBindingForShutdown: () => ({ claude_session_id: state.sid }),
    getSessionMaterialization: () => ({ materialized: true }),
    readAgentSendDestinationAtWriteBoundary: () => ({ toolType: provider, sessionId: state.sid }),
    scheduleProjectActivityBroadcast() {}, scheduleCodexModelEffortIntentReconcile: async () => {},
    scheduleCodexFastIntentReconcile() {}, // unrelated settings wake leaf of the extracted actual Main handler
  });
  vm.runInContext(code(['captureSavedHistoryRuntime', 'captureAiProcessLookupScope', 'aiProcessLookupScopeCurrent',
    'readMainPublicRuntimeSnapshot', 'readHistoryMutationInputBoundary']), context);
  let initializer;
  for (const node of ast.statements) if (ts.isVariableStatement(node)) {
    const d = node.declarationList.declarations.find(d => d.name.getText(ast) === 'historyMutationInput');
    if (d) initializer = d.initializer.getText(ast);
  }
  vm.runInContext('const historyMutationInput=' + initializer + ';this.gate=historyMutationInput;', context);
  for (const n of ast.statements) if (["ipcMain.on('agent:readiness-changed-internal'", "ipcMain.on('agent:tui-ready-internal'",
    "ipcMain.on('agent:input-owner-changed-internal'"].some(prefix => n.getText(ast).startsWith(prefix))) vm.runInContext(n.getText(ast), context);
  const reserve = () => context.gate.reserve({ tabId: 'T', operationId: 'rewind-A', toolType: provider, sessionId: state.sid });
  const launch = proof => {
    context.gate.authorizeResume(proof, { command: provider + '-c', sessionId: state.sid });
    command.runSeq++; command.isRunning = true;
    if (provider === 'codex') context.codexLastRunCommandPayload.set('T', { launchId: 'OWN' });
    else context.claudeLaunchGenerationByTab.set('T', { generation: 'OWN' });
    context.gate.claimLaunch(proof, 'OWN', command.runSeq);
  };
  return { context, gate: context.gate, state, command, term, db, owners, events, reserve, launch,
    reads: () => reads, wakes: () => wakes };
}

for (const provider of ['codex', 'claude']) test('actual Main + real ConversationOwners/SQLite: ' + provider + ' launch-written holds until busy-ready event', async t => {
  const h = mainFixture(t, provider), proof = h.reserve(); h.launch(proof);
  h.gate.finish(proof); await tick();
  assert.equal(h.gate.read('T').phase, 'awaiting-input'); assert.equal(h.wakes(), 0);
  assert.notStrictEqual(h.owners.current('T').ownerOrder, h.owners.current('T').ownerOrder, 'real reader returns fresh order DTOs');
  assert.equal(h.gate.claimSend('T'), null);
  assert.doesNotThrow(() => h.gate.assert('T', null, { action: 'resume' }), 'explicit manual recovery remains possible');
  assert.throws(() => h.gate.assert('T', proof, { action: 'mutation' }), /reservation_changed/);
  h.state.ready = true; h.state.status = 'busy'; h.state.checkpoint = 'two';
  h.events.emit('agent:readiness-changed-internal', null, { tabId: 'T', toolType: provider, status: 'ready' });
  await tick(); assert.equal(h.gate.held('T'), false); assert.equal(h.wakes(), 1);
  assert.ok(h.reads() >= 2); assert.deepEqual(h.db.getAppState('historyMutationInput.v1').reservations, []);
});

test('restart restores passive marker, never old token; absent/inactive releases ordinary auto-start', async t => {
  const h = mainFixture(t), proof = h.reserve(); h.launch(proof); h.gate.finish(proof); await tick();
  const saved = h.db.getAppState('historyMutationInput.v1');
  assert.equal(JSON.stringify(saved).includes(proof.token), false);
  let processStatus = 'unknown';
  const restarted = createHistoryMutationInputGate({ journal: { read: () => saved, write() {} }, log: quiet,
    readInputBoundary: async () => ({ known: processStatus !== 'unknown', ownerStable: true,
      isCurrent: () => true, processStatus, inputReady: false, status: 'inactive' }) });
  assert.equal(restarted.held('T'), true); assert.throws(() => restarted.authorizeResume(proof), /reservation_changed/);
  await restarted.notify('T'); assert.equal(restarted.held('T'), true);
  processStatus = 'absent'; await restarted.notify('T'); assert.equal(restarted.held('T'), false);
});

test('sender loss drains late IO and retains a starting input; manual Stop can cancel the passive fence', async t => {
  const h = mainFixture(t), proof = h.gate.reserve({ tabId: 'T', operationId: 'lost', toolType: 'codex', sessionId: 'SOURCE', owner: 'renderer' });
  h.launch(proof); const wait = deferred(), io = h.gate.run(proof, () => wait.promise);
  h.gate.revokeOwner('renderer'); assert.equal(h.gate.read('T').phase, 'draining');
  wait.resolve({ committed: true }); assert.deepEqual(await io, { committed: true }); await tick();
  assert.equal(h.gate.read('T').phase, 'awaiting-input'); h.gate.cancel('T');
  assert.equal(h.gate.held('T'), false);
});

for (const patch of [{ runSeq: 99 }, { lifecycleGeneration: 'OTHER' }, { inputRevision: 2 }]) test('extra reservation generation guard ' + JSON.stringify(patch), () => {
  const state = { terminalToken: {}, projectId: 'P', cwd: '/f', sessionId: 'S', toolType: 'codex',
    runSeq: 1, lifecycleGeneration: 'G', inputRevision: 1 };
  const gate = createHistoryMutationInputGate({ capture: () => ({ ...state }), log: quiet });
  const p = gate.reserve({ tabId: 'T', operationId: 'R', sessionId: 'S', toolType: 'codex' });
  Object.assign(state, patch); assert.throws(() => gate.assert('T', p, { action: 'mutation' }), /owner_changed/);
});

test('manual input between own Resume authorization and physical claim stays guarded', () => {
  const state = { terminalToken: {}, projectId: 'P', cwd: '/f', sessionId: 'S', toolType: 'codex', runSeq: 1, inputRevision: 1 };
  const gate = createHistoryMutationInputGate({ capture: () => ({ ...state }), log: quiet });
  const p = gate.reserve({ tabId: 'T', operationId: 'R', sessionId: 'S', toolType: 'codex' });
  gate.authorizeResume(p, { command: 'codex-c', sessionId: 'S' }); state.inputRevision++;
  state.runSeq++; state.inputOwnerLaunchId = 'OWN';
  assert.throws(() => gate.claimLaunch(p, 'OWN', state.runSeq), /owner_changed/);
});

test('stale positive read cannot release the FIFO', async () => {
  let current = true, ready = false;
  const state = { terminalToken: {}, projectId: 'P', cwd: '/f', sessionId: 'S', toolType: 'codex' };
  const gate = createHistoryMutationInputGate({ capture: () => state, log: quiet,
    readInputBoundary: async () => ({ known: true, ownerStable: true, isCurrent: () => current,
      processStatus: 'found', inputReady: ready, status: 'active' }) });
  const p = gate.reserve({ tabId: 'T', operationId: 'R', sessionId: 'S', toolType: 'codex' });
  gate.finish(p); await tick(); ready = true; current = false;
  await gate.notify('T'); assert.equal(gate.held('T'), true);
  current = true; await gate.notify('T'); assert.equal(gate.held('T'), false);
});

test('unchanged not-ready notifications coalesce instead of recursively reading the process', async () => {
  const state = { terminalToken: {}, projectId: 'P', cwd: '/f', sessionId: 'S', toolType: 'codex' };
  let reads = 0;
  const gate = createHistoryMutationInputGate({ capture: () => state, log: quiet,
    readInputBoundary: async () => {
      reads++;
      // A bounded reproduction of a coherent read publishing the same status.
      // The limit makes the RED failure finite, not a hanging test.
      if (reads < 5) void gate.notify('T');
      return { known: true, ownerStable: true, isCurrent: () => true,
        processStatus: 'found', inputReady: false, status: 'starting' };
    } });
  const p = gate.reserve({ tabId: 'T', operationId: 'R', sessionId: 'S', toolType: 'codex' });
  gate.finish(p); await tick(); await tick();
  assert.equal(reads, 1);
  assert.equal(gate.held('T'), true);
});

test('a genuinely changed readiness during an in-flight read is rechecked, not lost by coalescing', async () => {
  const state = { terminalToken: {}, projectId: 'P', cwd: '/f', sessionId: 'S', toolType: 'codex' };
  const pending = deferred(); let reads = 0, revision = 0;
  const gate = createHistoryMutationInputGate({ capture: () => state, log: quiet,
    readInputBoundary: async () => {
      const atRead = revision;
      if (++reads === 1) await pending.promise;
      return { known: true, ownerStable: true, isCurrent: () => revision === atRead,
        processStatus: 'found', inputReady: atRead === 1, status: 'active' };
    } });
  const p = gate.reserve({ tabId: 'T', operationId: 'R', sessionId: 'S', toolType: 'codex' });
  gate.finish(p); await Promise.resolve(); revision = 1;
  void gate.notify('T'); pending.resolve(); await tick(); await tick();
  assert.equal(reads, 2);
  assert.equal(gate.held('T'), false);
});
