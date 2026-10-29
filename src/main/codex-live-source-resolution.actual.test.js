'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), ts = require('typescript'), zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-source-')));
process.env.CODEX_HOME = fixtureRoot;
const data = require('./ipc/codex-data');
const views = require('./codex-rollout-read-views');
const mainPath = process.env.CODEX_LIVE_SOURCE_MAIN || path.join(__dirname, 'main.js');
const source = fs.readFileSync(mainPath, 'utf8');
const ast = ts.createSourceFile('main.js', source, ts.ScriptTarget.Latest, true);
const quiet = { log() {}, warn() {}, error() {} };
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
function observationFixture(t) {
  // Reuse the existing finite Main ownership fixture without importing its
  // tests or starting Electron. Its process/SQLite/readiness leaves remain
  // controlled; reconciliation and watcher/release bodies come from actual Main.
  const fixturePath = path.join(__dirname, 'codex-submission-observation.integration.test.js');
  const fixtureAst = ts.createSourceFile(fixturePath, fs.readFileSync(fixturePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const ports = vm.createContext({ fs, os, path, vm, ts, assert, ast, quiet, setImmediate,
    __dirname, require: require('node:module').createRequire(fixturePath) });
  for (const name of ['harness', 'pathAliasHarness']) {
    const declaration = fixtureAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    vm.runInContext(declaration.getText(fixtureAst), ports);
  }
  const result = ports.pathAliasHarness(t);
  result.context.codexCanonicalPresentation = null;
  return result;
}
function processStopFixture() {
  const fixturePath = path.join(__dirname, 'agent-process-stop-main.integration.test.js');
  const fixtureAst = ts.createSourceFile(fixturePath, fs.readFileSync(fixturePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['getTerminalStopRevision', 'prepareStopPendingSends', 'stopAgentProcessScenarioInMain',
    'stopAiProcessInTabSerialized', 'stopAiProcessInTab'];
  const mainCode = names.map(name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast)).join('\n');
  const ports = vm.createContext({ vm, assert, path, quiet, require, clearTimeout, __dirname, mainCode, webCode: '',
    url: require('node:url'), contract: {}, createHttpReadDiagnostics: () => null, handleStorageMaintenance: null,
    createTerminalShellReadinessTracker: require('./terminal-shell-readiness.cjs').createTerminalShellReadinessTracker,
    createHistoryMutationInputGate: require('./history-mutation-input').createHistoryMutationInputGate,
    runKeyedExclusive: require('./codex-writer-ownership').runKeyedExclusive });
  vm.runInContext(fixtureAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'fixture').getText(fixtureAst), ports);
  const h = ports.fixture();
  h.ctx.aiLifecycleActionInflight = new Map();
  h.ctx.inspectAiDescendantProcessesByTab = async (_tab, _tool, options) => {
    options.onSnapshot({ children: new Map() });
    return { status: 'found', matches: [{ pid: 11, ppid: 10, processName: 'codex', depth: 1, cmd: 'codex' }] };
  };
  h.ctx.resolveAiToolTypeForTab = () => 'codex';
  h.ctx.resolveActivityIdentity = () => ({ sessionId: null });
  h.ctx.codexTurnWatchers.set('T', { busy: true, currentTurnId: null });
  for (const name of ['invalidateCodexExitObservers', 'clearCodexLaunchPayload', 'closeCodexWatcher',
    'clearCodexKnownSession', 'clearCodexTuiReady', 'closeCodexTurnWatcher', 'emitCodexBusy']) h.ctx[name] = () => {};
  return h;
}
function compressedSource(t, { archived = false } = {}) {
  const id = randomUUID(), dir = path.join(fixtureRoot, archived ? 'archived_sessions' : 'sessions/2026/10/25');
  fs.mkdirSync(dir, { recursive: true });
  const native = path.join(dir, 'rollout-' + id + '.jsonl');
  const rows = [{ type: 'session_meta', payload: { id, cwd: fixtureRoot, originator: 'codex-tui', source: 'cli' } },
    { type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'user_message', message: 'old input' } }];
  const plain = encode(rows), compressed = zlib.zstdCompressSync ? zlib.zstdCompressSync(plain)
    : execFileSync('zstd', ['-q', '-c'], { input: plain });
  fs.writeFileSync(native + '.zst', compressed);
  return { id, native, plain, compressed, rows };
}
function ensureHarness(f) {
  const requests = [], warnings = [], terminal = {};
  const context = vm.createContext({ console: { ...quiet, warn: value => warnings.push(value) },
    Date, Number, String, path, require, srcMainDir: __dirname,
    terminals: new Map([['own', terminal]]), terminalProjects: new Map([['own', fixtureRoot]]),
    terminalCommandState: new Map([['own', { runSeq: 1 }]]), codexTurnWatchers: new Map(),
    aiStoppingTabs: new Map(),
    codexDataModule: data, codexSessionIdFromDb: () => f.id,
    getPendingCodexPasteAudits: () => [], getTerminalLifecycleGeneration: () => 'own:1',
    getTerminalStopRevision: () => 0,
    cancelCodexManualCompactPending() {}, configureCodexCatchUpSuppression() {},
    startCodexTurnWatcher: request => {
      const state = { ...request, offset: fs.statSync(request.filePath).size };
      requests.push(state); context.codexTurnWatchers.set('own', state); return true;
    },
  });
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ensureCodexTurnWatcher');
  vm.runInContext(node.getText(ast), context);
  return { context, requests, warnings,
    ensure: () => context.ensureCodexTurnWatcher('own', f.id, fixtureRoot, { sourceObservationLaunchId: 'launch' }) };
}
test.after(async () => { await views.closeCodexRolloutReadViews(); fs.rmSync(fixtureRoot, { recursive: true, force: true }); });

test('actual ensure never watches the decoded read view before native Resume materializes its source', async t => {
  const f = compressedSource(t), readable = await data._api.findCodexSessionFile(f.id, fixtureRoot);
  assert.equal(readable.temporaryReadView, true);
  assert.deepEqual(fs.readFileSync(readable.filePath), f.plain);
  const h = ensureHarness(f);
  const attached = await h.ensure();
  assert.equal(attached, false, 'a compressed container is not an appendable live source');
  assert.equal(h.requests.length, 0, 'no temporary watcher/turn/writer may be installed');
  assert.deepEqual(fs.readFileSync(f.native + '.zst'), f.compressed);
});

test('native source in place wins after read-view cleanup; future append comes from native bytes', async t => {
  const f = compressedSource(t), readable = await data._api.findCodexSessionFile(f.id, fixtureRoot);
  fs.unlinkSync(readable.filePath); // only this own disposable fixture; original zstd stays exact
  fs.writeFileSync(f.native, f.plain); // controlled native Resume materialization, not app mutation
  const h = ensureHarness(f);
  assert.equal(await h.ensure(), true);
  assert.equal(h.requests[0].filePath, f.native);
  const next = encode([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'new-turn' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'new input' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'new-turn', last_agent_message: 'new final' } }]);
  fs.appendFileSync(f.native, next);
  const { createHarness } = require('../../scripts/lib/codex-turn-append-harness.cjs');
  const scanner = createHarness(h.requests[0].filePath, { mainPath, state: { offset: f.plain.length } });
  await scanner.scan();
  assert.equal(scanner.result.records, 3, JSON.stringify(scanner.result));
  assert.deepEqual(scanner.result.warnings, []);
  assert.deepEqual(fs.readFileSync(f.native + '.zst'), f.compressed);
});

function liveAuditFixture(t, f, prompt) {
  const Database = require('better-sqlite3');
  const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
  const DatabaseManager = require('./database');
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE history_prompt_presentations (tool_type TEXT, session_id TEXT, audit_timestamp TEXT,
    transport_hash TEXT, entry_uuid TEXT, schema_version INTEGER, chips_json TEXT, created_at INTEGER,
    updated_at INTEGER, PRIMARY KEY(tool_type,session_id,audit_timestamp,transport_hash))`);
  const manager = Object.create(DatabaseManager.prototype); manager.db = db;
  const store = createAgentSendReceiptStore(db), audits = [], published = [];
  const hash = require('./prompt-audit-fingerprint').promptAuditFingerprint;
  const identity = { operationKey: 'own-op', tabId: 'own', handoffId: 'own-H', provider: 'codex',
    sessionId: f.id, surface: 'desktop-history', requestFingerprint: 'own-request',
    promptHash: hash(prompt), promptLength: prompt.length };
  const attempt = store.beginAttempt(identity);
  const boundary = { sessionId: f.id, filePath: f.native, fileSize: f.plain.length, capturedAt: 1 };
  store.stageAttemptContext(identity.operationKey, attempt.attemptId, { sessionId: f.id,
    transcriptBoundary: boundary, transportText: prompt });
  store.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, auditPending: true });
  audits.push({ handoffId: identity.handoffId, sendOperationKey: identity.operationKey,
    sendAttemptId: attempt.attemptId, expectedText: prompt, expectedHash: identity.promptHash,
    expectedLen: prompt.length, sentAt: 1, preSubmitBoundary: boundary });
  const context = vm.createContext({ ...require('./codex-prompt-audit'),
    createCodexLiveUserCarrierPairer: require('./codex-live-user-carrier-pairing').createCodexLiveUserCarrierPairer,
    CODEX_LIVE_USER_EVENT_CARRIER: 'event_msg', CODEX_LIVE_USER_RESPONSE_CARRIER: 'response_item',
    codexKnownSessions: new Map(), pasteAuditHash: hash, console: quiet, clearTimeout,
    saveAuditedPromptPresentation: require('./history-prompt-presentations').saveAuditedPromptPresentation,
    agentSendReceiptStore: store, AGENT_SEND_DURABLE_STATES: STORE_STATES, projectManager: { db: manager },
    getPendingCodexPasteAudits: () => audits.filter(a => !a.finished),
    getCodexRuntimeSessionId: () => f.id, pasteAuditPreview: text => text,
    getActiveAgentExecutionContext: () => null,
    compatiblePromptAuditExecutionContext: () => ({ context: null, reason: 'controlled-execution-projection' }),
    isOrchestrationPromptAudit: () => false, routeAgentPromptAuditDetail: detail => published.push(detail),
    enrichCodexAuditAddress() {}, holdPasteAuditCompletionForTest: () => false,
    releaseCodexProvisionalSourceAfterMatchedAudit() {}, rememberCodexLivePromptOwner() {},
    removePendingCodexPasteAudit: (_tab, audit) => { const i = audits.indexOf(audit); if (i >= 0) audits.splice(i, 1); },
    reconcileDurableCodexPromptAuditsForTab() {},
  });
  for (const name of ['observeCodexPromptAuditCarrier', 'processCodexUserMessagePasteAudit',
    'finishCodexPasteAudit', 'publishAgentPromptAuditResult', 'codexLiveUserCarrierKind',
    'codexLiveSourceIdentity', 'codexDurableUserUuidFromLiveRecord']) {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    vm.runInContext(node.getText(ast), context);
  }
  return { store, attempt, published, audits, observe(state, record, offset) {
    record.__byteOffset = offset;
    context.observeCodexPromptAuditCarrier(state, record);
    context.processCodexUserMessagePasteAudit(state, record);
  } };
}

test('native append confirms SAME H/O/A through actual Main audit and SQLite, then natural final ends the actual typed turn', async t => {
  const f = compressedSource(t), prompt = 'one new owned input';
  await data._api.findCodexSessionFile(f.id, fixtureRoot);
  fs.writeFileSync(f.native, f.plain);
  const h = ensureHarness(f); assert.equal(await h.ensure(), true);
  const audit = liveAuditFixture(t, f, prompt), tracker = {};
  const terminal = {}, writes = [];
  const interrupt = require('./codex-turn-interrupt').createCodexTurnInterrupt({
    getSnapshot: () => ({ terminal, runSeq: 1, lifecycleGeneration: 'own:1', inputReady: true,
      busy: tracker.busy === true, turnId: tracker.currentTurnId }),
    withWriteLock: (_terminal, work) => work(), writeEscape: () => writes.push('ESC'),
  });
  const { createHarness } = require('../../scripts/lib/codex-turn-append-harness.cjs');
  const scanner = createHarness(f.native, { mainPath, state: { tabId: 'own', sessionId: f.id,
    offset: f.plain.length }, onRecord(record, offset, state) {
    const outcome = require('./codex-turn-outcome').classifyCodexTurnRecord(tracker, record);
    if (outcome) { tracker.busy = outcome.busy; tracker.outcome = outcome; }
    if (record.payload?.type === 'user_message') audit.observe(state, record, offset);
  } });
  fs.appendFileSync(f.native, encode([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'TURN' } }]));
  await scanner.scan();
  assert.equal(audit.store.get('own-op').state, 'audit-pending');
  assert.equal((await interrupt('own')).interruptRequested, true,
    'a known live turn does not need confirmation of a different delivery axis');
  assert.equal((await interrupt('own')).skipped, 'interrupt-already-requested');
  assert.equal(writes.length, 1); assert.equal(audit.store.get('own-op').state, 'audit-pending');
  fs.appendFileSync(f.native, encode([{ type: 'event_msg', timestamp: '2026-10-25T00:00:01Z',
    payload: { type: 'user_message', message: prompt } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
    turn_id: 'TURN', content: [{ type: 'output_text', text: 'owned final' }] } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'TURN', last_agent_message: 'owned final' } }]));
  await scanner.scan();
  assert.deepEqual(scanner.result.warnings, []);
  assert.equal(audit.store.get('own-op').state, 'confirmed');
  assert.equal(audit.store.get('own-op').attemptId, audit.attempt.attemptId);
  assert.equal(audit.published.length, 1); assert.equal(audit.published[0].handoffId, 'own-H');
  assert.equal(tracker.busy, false); assert.equal(tracker.outcome.reason, 'task_complete');
  assert.equal(tracker.outcome.hasFinalResult, true);
  assert.equal((await interrupt('own')).interrupted, false); assert.equal(writes.length, 1);
});

test('read API still reads a compressed archive and retains exact original bytes', async t => {
  const f = compressedSource(t, { archived: true });
  const found = await data._api.findCodexSessionFile(f.id, fixtureRoot);
  assert.equal(found.temporaryReadView, true);
  assert.deepEqual(fs.readFileSync(found.filePath), f.plain);
  assert.deepEqual(fs.readFileSync(f.native + '.zst'), f.compressed);
  assert.equal(fs.existsSync(f.native), false);
});

for (const userFirst of [false, true]) test('late native materialization reattaches and audits before/after task_started: userFirst=' + userFirst, async t => {
  const f = compressedSource(t), h = observationFixture(t);
  h.candidate.sessionId = f.id; h.candidate.filePath = f.native;
  h.candidate.sourceSessionId = f.id; h.launch.sessionId = f.id;
  h.launch.startedAt = Date.parse('2026-10-25T00:00:00Z');
  h.context.codexSessionIdFromDb = () => f.id;
  const intent = h.context.codexSessionDiscoveryIntents.get(h.tabId);
  Object.assign(intent, { sourceSessionId: f.id, startedAt: h.launch.startedAt });
  Object.assign(h.context.codexWatchers.get(h.tabId), { sourceSessionId: f.id,
    provisionalSubmitReservation: { sourceSessionId: f.id, launchId: h.launch.launchId,
      requiresUserMessageAudit: true } });
  h.context.codexTurnWatchers.delete(h.tabId); // native JSONL did not exist at original attach
  const rows = [{ type: 'event_msg', timestamp: '2026-10-25T00:00:01Z', payload: { type: 'task_started', turn_id: 'TURN' } },
    { type: 'event_msg', timestamp: '2026-10-25T00:00:01Z', payload: { type: 'user_message', message: 'new live input' } }];
  if (userFirst) rows.reverse();
  fs.writeFileSync(f.native, Buffer.concat([f.plain, encode(rows)]));
  const audit = liveAuditFixture(t, f, 'new live input');
  audit.audits[0].awaitUserMessage = true;
  h.context.getPendingCodexPasteAudits = () => audit.audits;
  h.context.pendingCodexPasteAudit.set(h.tabId, audit.audits[0]);
  vm.runInContext(ast.statements.find(n => ts.isFunctionDeclaration(n)
    && n.name?.text === 'resolveCodexPendingAuditCatchUpOffset').getText(ast), h.context);
  h.context.codexDataModule._api.findCodexLinkedLiveBoundary = data._api.findCodexLinkedLiveBoundary;
  const result = await h.context.reconcileCodexWriterFromProcessInner(h.tabId, { reason: 'writer-proof-linked' });
  assert.equal(result.status, 'provisional-source');
  const watcher = h.context.codexTurnWatchers.get(h.tabId);
  assert.ok(watcher, 'a pending audit must not leave the physical writer unobserved');
  assert.equal(watcher.filePath, f.native);
  assert.ok(watcher.offset < fs.statSync(f.native).size, 'already written live input remains available for exact replay');
  assert.equal(watcher.sourceObservationStartedAt, h.launch.startedAt);
  assert.equal(h.context.codexKnownSessions.size, 0, 'watcher attachment cannot adopt a writer');
  assert.equal(h.context.getCodexWriterProofSnapshot(h.tabId), null);
  const { createHarness } = require('../../scripts/lib/codex-turn-append-harness.cjs');
  const tracker = {};
  const scanner = createHarness(f.native, { mainPath, state: { tabId: h.tabId, sessionId: f.id },
    onRecord(record) {
      const outcome = require('./codex-turn-outcome').classifyCodexTurnRecord(tracker, record);
      if (outcome) { tracker.busy = outcome.busy; tracker.outcome = outcome; }
    } });
  scanner.context.codexTurnWatchers = h.context.codexTurnWatchers;
  scanner.context.processCodexUserMessagePasteAudit = (state, record) => audit.observe(state, record, record.__byteOffset);
  await scanner.scan('native-source-catch-up');
  assert.deepEqual(scanner.result.warnings, []);
  assert.equal(audit.store.get('own-op').state, 'confirmed');
  assert.ok(watcher.sourceLiveUserActivityProof);
  assert.equal(watcher.busy, false, 'provisional catch-up stays unpublished');
  const adopted = await h.context.reconcileCodexWriterFromProcessInner(h.tabId, { reason: 'writer-proof-linked' });
  assert.equal(adopted.status, 'adopted');
  assert.equal(h.context.codexKnownSessions.get(h.tabId), f.id);
  assert.equal(h.context.codexTurnWatchers.get(h.tabId), watcher, 'same physical observer retains the held replay');
  await scanner.scan('source-proof-replay');
  assert.equal(tracker.currentTurnId, 'TURN'); assert.equal(tracker.busy, true);
  fs.appendFileSync(f.native, encode([{ type: 'event_msg', payload: { type: 'task_complete',
    turn_id: 'TURN', last_agent_message: 'native final after read-view cleanup' } }]));
  await scanner.scan('native-final');
  assert.equal(tracker.busy, false); assert.equal(tracker.outcome.hasFinalResult, true);
  assert.equal(audit.published.length, 1, 'replay cannot confirm or publish the same H a second time');
});

for (const verdict of ['owned', 'foreign', 'unknown']) test('compressed Resume still accepts ONLY a process-proven native child: ' + verdict, async t => {
  const f = compressedSource(t), h = observationFixture(t), childId = randomUUID();
  const childPath = path.join(path.dirname(f.native), 'rollout-' + childId + '.jsonl');
  fs.writeFileSync(childPath, encode([{ type: 'session_meta', payload: { id: childId,
    forked_from_id: f.id, cwd: fixtureRoot, originator: 'codex-tui', source: 'cli' } },
  { type: 'event_msg', timestamp: '2026-10-25T00:00:03Z', payload: { type: 'task_started', turn_id: 'CHILD-TURN' } }]));
  h.launch.sessionId = f.id; h.launch.startedAt = Date.parse('2026-10-25T00:00:00Z');
  h.context.codexSessionIdFromDb = () => f.id;
  Object.assign(h.context.codexSessionDiscoveryIntents.get(h.tabId), { sourceSessionId: f.id, startedAt: h.launch.startedAt });
  Object.assign(h.context.codexWatchers.get(h.tabId), { sourceSessionId: f.id });
  const physical = require('./codex-writer-ownership').resolveCodexWriterProof([
    { pid: 42, output: 'p42\nf7\nau\nn' + childPath + '\n' }], path.dirname(childPath));
  assert.equal(physical.status, 'owned');
  h.context.inspectCodexWriterProcessProof = async () => verdict === 'unknown'
    ? { status: 'unknown', candidates: [] } : physical;
  h.context.codexDataModule._api.readCodexSessionMetadata = data._api.readCodexSessionMetadata;
  h.context.codexDataModule._api.isCodexUserTuiSession = data._api.isCodexUserTuiSession;
  h.context.codexDataModule._api.findCodexLinkedLiveBoundary = data._api.findCodexLinkedLiveBoundary;
  h.context.cloneCodexPromptPresentationsAfterProvenChild = async () => {};
  const ownedNode = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'inspectCodexOwnedWriter');
  vm.runInContext(ownedNode.getText(ast), h.context);
  if (verdict === 'foreign') h.context.getCodexSessionOwner = () => ({ tabId: 'OTHER' });
  const result = await h.context.reconcileCodexWriterFromProcessInner(h.tabId, { reason: 'writer-proof-linked' });
  if (verdict === 'owned') {
    assert.equal(result.status, 'adopted');
    assert.equal(h.context.codexKnownSessions.get(h.tabId), childId);
    assert.equal(h.context.codexTurnWatchers.get(h.tabId).filePath, fs.realpathSync(childPath));
    assert.equal(fs.existsSync(f.native), false, 'child Resume must not materialize or adopt the parent');
  } else {
    assert.notEqual(result.status, 'adopted'); assert.equal(h.context.codexKnownSessions.size, 0);
  }
  assert.deepEqual(fs.readFileSync(f.native + '.zst'), f.compressed);
});

for (const change of ['terminal', 'run', 'generation', 'stop', 'stopping', 'watcher']) test('awaited source lookup cannot attach after ' + change + ' replacement', async t => {
  const f = compressedSource(t); fs.writeFileSync(f.native, f.plain);
  const h = ensureHarness(f), original = h.context.codexDataModule;
  let generation = 'own:1', stop = 0;
  h.context.getTerminalLifecycleGeneration = () => generation;
  h.context.getTerminalStopRevision = () => stop;
  h.context.codexDataModule = { _api: { findCodexSessionFile: async (...args) => {
    const found = await original._api.findCodexSessionFile(...args);
    if (change === 'terminal') h.context.terminals.set('own', {});
    if (change === 'run') h.context.terminalCommandState.get('own').runSeq++;
    if (change === 'generation') generation = 'own:2';
    if (change === 'stop') stop++;
    if (change === 'stopping') h.context.aiStoppingTabs.set('own', true);
    if (change === 'watcher') h.context.codexTurnWatchers.set('own', { sessionId: 'foreign' });
    return found;
  } } };
  assert.equal(await h.ensure(), false);
  assert.equal(h.requests.length, 0);
});

test('a foreign root header at the requested filename is not a live watcher source', async t => {
  const f = compressedSource(t);
  fs.writeFileSync(f.native, encode([{ type: 'session_meta', payload: { id: 'FOREIGN',
    cwd: fixtureRoot, originator: 'codex-tui', source: 'cli' } }]));
  const h = ensureHarness(f);
  assert.equal(await h.ensure(), false); assert.equal(h.requests.length, 0);
  assert.match(h.warnings.join('\n'), /identity mismatch/);
});

test('failed physical discovery stays unknown, never a synthetic ready/final or guessed file', async t => {
  const f = compressedSource(t), h = ensureHarness(f);
  h.context.codexDataModule = { _api: { findCodexSessionFile: async () => {
    throw Object.assign(new Error('controlled EACCES'), { code: 'EACCES' });
  } } };
  assert.equal(await h.ensure(), false); assert.equal(h.requests.length, 0);
  assert.equal(h.context.codexTurnWatchers.size, 0);
  assert.match(h.warnings.join('\n'), /EACCES/);
});

test('existing Main process Stop remains available with unknown canonical turn; no real signal or receipt rewrite', async () => {
  const h = processStopFixture();
  h.ctx.waitForAiStopScopeExit = async () => ({ exited: true });
  const result = await h.ctx.stopAiProcessInTabSerialized('T', { toolType: 'codex', reason: 'manual-stop' });
  assert.equal(result.success, true); assert.equal(result.graceful, 'ctrl-c');
  assert.deepEqual(Array.from(h.writes), ['\x03']); assert.deepEqual(Array.from(h.signals), []);
});

test('a foreign physical Stop guard refuses before Ctrl+C even with unknown canonical turn', async () => {
  const h = processStopFixture();
  const result = await h.ctx.stopAiProcessInTabSerialized('T', { toolType: 'codex', reason: 'manual-stop',
    preSignalGuard: () => ({ allowed: false, reason: 'owner-changed' }) });
  assert.equal(result.success, false); assert.equal(result.guardRejected, true);
  assert.deepEqual(Array.from(h.writes), []); assert.deepEqual(Array.from(h.signals), []);
});
