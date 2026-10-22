'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript'), Database = require('better-sqlite3');
const { createHistoryMutationInputGate } = require('./history-mutation-input');
const { TerminalCwdChangeProofRegistry } = require('./terminal-cwd-change');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const bodies = names => names.map(name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}).join('\n');
const quiet = { log() {}, warn() {}, error() {} };

function fixture(t, active = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noted-cwd-main-')));
  const a = path.join(root, 'a'), b = path.join(root, 'b'), filePath = path.join(root, 'fixture.jsonl');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(filePath, JSON.stringify({ type: 'session_meta', payload: { id: 'source', cwd: a } }) + '\n');
  const sourceStat = fs.statSync(filePath);
  const sql = new Database(':memory:');
  sql.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE tabs(id TEXT PRIMARY KEY,cwd TEXT,subject TEXT)');
  sql.prepare('INSERT INTO tabs VALUES (?,?,?)').run('T', a, 'subject');
  t.after(() => { sql.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const db = { db: sql,
    getAppState: key => { const row = sql.prepare('SELECT value FROM app_state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    setAppState: (key, value) => sql.prepare('INSERT OR REPLACE INTO app_state VALUES(?,?)').run(key, JSON.stringify(value)) };
  const state = { cwd: a, runSeq: 4, inputRevision: 2, isRunning: active, sessionId: 'source',
    status: active ? 'active' : 'inactive', processStatus: active ? 'found' : 'absent', inputReady: active };
  const writes = [], packets = [], lines = new Map(), terms = new Map(), projects = new Map([['T', a]]);
  const command = new Map([['T', state]]), proofs = new TerminalCwdChangeProofRegistry();
  const events = new EventEmitter();
  const term = { write(input) {
    writes.push(input);
    setImmediate(() => {
      state.runSeq++; state.cwd = b; projects.set('T', b);
      sql.prepare('UPDATE tabs SET cwd=? WHERE id=?').run(b, 'T');
      proofs.observe({ tabId: 'T', terminalToken: term, cwd: b, persisted: true });
    });
  } };
  terms.set('T', term);
  const capture = () => ({ terminalToken: terms.get('T'), projectId: 'P', cwd: state.cwd, toolType: 'codex',
    sessionId: state.sessionId, runSeq: state.runSeq, lifecycleGeneration: 'TERM:' + state.runSeq,
    inputRevision: state.inputRevision, isRunning: state.isRunning, processLookupUnknown: false, stopping: state.stopping === true,
    subjectId: sql.prepare('SELECT subject FROM tabs WHERE id=?').get('T').subject,
    inputOwnerLaunchId: state.launchId || null });
  const gate = createHistoryMutationInputGate({ capture, log: quiet,
    readInputBoundary: async () => ({ known: true, ownerStable: true, isCurrent: () => true,
      processStatus: state.processStatus, status: state.status, inputReady: state.inputReady === true }) });
  const context = vm.createContext({ console: quiet, Buffer, path, fs, srcMainDir: __dirname, queueMicrotask,
    require, ipcMain: events, terminals: terms, terminalProjects: projects, terminalCommandState: command,
    terminalInputLineBuffers: lines, terminalInputEscapeStates: new Map(), terminalCwdChangeProofs: proofs,
    historyMutationInput: gate, projectManager: { db }, mainWindow: { webContents: {} },
    captureSavedHistoryRuntime: capture,
    captureConversationOwner: () => ({ executionScope: { subjectId: capture().subjectId } }),
    readPendingCodexNativeRewindHandoff: () => null,
    normalizeDirectoryTarget: value => path.resolve(value),
    runKeyedExclusive: async (_map, _key, body) => body(), aiLifecycleActionInflight: new Map(),
    proveIdleShellForAgentLaunch: async () => ({ allowed: true, shellWriteProof: { ...capture(),
      terminalToken: terms.get('T') } }),
    agentShellLaunchError: verdict => verdict.reason,
    getTerminalLifecycleGeneration: () => 'TERM:' + state.runSeq,
    getTerminalInputRevision: () => state.inputRevision,
    shellQuote: value => "'" + value.replaceAll("'", "'\\''") + "'",
    buildAgentShellLaunchInput: value => '\x15' + value + '\r',
    readMainPublicRuntimeSnapshot: async () => ({ ...state, coherent: true, cwd: state.cwd,
      writerConfirmed: state.processStatus === 'found', launchId: state.launchId || null,
      lifecycleGeneration: 'TERM:' + state.runSeq, terminalRunSeq: state.runSeq }),
    getCombinedTabBackgroundWorkCount: () => 0,
    getCodexWriterProofSnapshot: () => ({ sessionId: 'source', filePath, valid: true }),
    CODEX_SETTINGS_WRITER_ADOPTED_EVENT: 'codex:settings-writer-adopted-internal',
    codexTurnWatchers: new Map(), getCodexPublicRuntimeProjection: () => ({ goalWork: null }),
    getHeadlessCodexDraftState: () => ({ success: true, hasDraft: false }),
    getHeadlessVisibleBufferSnapshot: () => ({ success: true, authoritativeFrameCommitted: true,
      writeSeq: 1, flushedSeq: 1, lines: ['›'], preViewportLines: [] }),
    codexDataModule: { _api: { findSessionFile: async () => ({ filePath }) } },
    _webBroadcast: (_tab, packet) => packets.push(packet),
    stopAgentProcessScenarioInMain: async (request, control) => {
      assert.equal(active, true, 'stopped fixture must not Stop');
      assert.equal(typeof control.onStopAdmitted, 'function', 'do not cancel pending control work before guard admission');
      assert.equal(control.preSignalGuard().allowed, true, 'actual Stop requires an explicit allowed verdict');
      control.onStopAdmitted(); state.stopping = true;
      assert.equal(control.preSignalGuard().allowed, true, 'own Stop output is allowed but owner/input still guarded');
      Object.assign(state, { isRunning: false, status: 'inactive', processStatus: 'absent', stopping: false, inputReady: false });
      return { success: true };
    },
    runCodexCommandFromPayload: async (_sender, request) => {
      assert.equal(request.command, 'codex-c'); assert.equal(request.cwd, b);
      context.service.noteResumeSource(request.workingDirectoryOperation, request.historyInput, {
        filePath, size: sourceStat.size, fileIdentity: sourceStat.dev + ':' + sourceStat.ino, sessionId: 'source' });
      gate.authorizeResume(request.historyInput, request);
      state.runSeq++; state.launchId = 'OWN'; gate.claimLaunch(request.historyInput, 'OWN', state.runSeq);
      await fs.promises.appendFile(filePath, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied',
        thread_settings: { cwd: b, model: 'fixture', reasoning_effort: 'high' } } }) + '\n');
      Object.assign(state, { status: 'active', processStatus: 'found', inputReady: true });
      return { success: true, accepted: true, launchWritten: true, launchId: 'OWN', lifecycleGeneration: 'TERM:' + state.runSeq };
    },
  });
  vm.runInContext(bodies(['captureWorkingDirectoryOperationScope', 'inspectWorkingDirectoryInput',
    'getWorkingDirectoryOperations', 'changeTerminalWorkingDirectory', 'writeAgentLaunchCommandToIdleShell',
    'assertAgentSendLaunchCurrent']) + '\nlet workingDirectoryOperations=null;this.service=getWorkingDirectoryOperations();', context);
  return { a, b, state, writes, context, gate, lines, packets, sql };
}

for (const active of [false, true]) test('actual Main constructor/cwd writer/gate/native proof completes one ' + (active ? 'active' : 'stopped') + ' operation', async t => {
  const f = fixture(t, active);
  const completed = new Promise(resolve => {
    const original = f.context._webBroadcast;
    f.context._webBroadcast = (tab, packet) => {
      original(tab, packet); if (packet.operation?.state === 'completed' || packet.operation?.state === 'failed') resolve(packet.operation);
    };
  });
  const accepted = f.context.service.accept('T', { operationId: 'actual-main', expectedSessionId: 'source', targetCwd: f.b });
  assert.equal(accepted.pending, true);
  const done = await completed;
  assert.equal(done.success, true, done.error); assert.equal(done.nativeCwd, f.b); assert.equal(done.inputReady, true);
  assert.equal(f.writes.length, 1); assert.match(f.writes[0], /cd -- /);
  assert.equal(f.sql.prepare('SELECT cwd FROM tabs WHERE id=?').get('T').cwd, f.b);
});

test('actual Main refuses unsent shell input before its writer clears anything', async t => {
  const f = fixture(t);
  f.lines.set('T', 'user draft');
  const proof = f.gate.reserve({ tabId: 'T', operationId: 'draft', toolType: 'codex', sessionId: 'source', purpose: 'working-directory' });
  const outcome = await f.context.changeTerminalWorkingDirectory({ tabId: 'T', targetCwd: f.b, historyInput: proof });
  assert.equal(outcome.error, 'terminal_has_unsent_input'); assert.equal(f.writes.length, 0);
  assert.equal(f.lines.get('T'), 'user draft');
});

test('actual physical shell proof cannot be borrowed after a new input revision', async t => {
  const f = fixture(t);
  f.context.proveIdleShellForAgentLaunch = async () => {
    const proof = { terminalToken: f.context.terminals.get('T'), runSeq: f.state.runSeq,
      lifecycleGeneration: 'TERM:' + f.state.runSeq, inputRevision: f.state.inputRevision };
    f.state.inputRevision++;
    return { allowed: true, shellWriteProof: proof };
  };
  const input = f.gate.reserve({ tabId: 'T', operationId: 'changed', toolType: 'codex', sessionId: 'source', purpose: 'working-directory' });
  const outcome = await f.context.changeTerminalWorkingDirectory({ tabId: 'T', targetCwd: f.b, historyInput: input });
  assert.equal(outcome.success, false); assert.equal(f.writes.length, 0);
  assert.equal(f.sql.prepare('SELECT cwd FROM tabs WHERE id=?').get('T').cwd, f.a);
});
