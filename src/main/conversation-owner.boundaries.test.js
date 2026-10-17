'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const http = require('node:http');
const os = require('node:os');
const url = require('node:url');
const crypto = require('node:crypto');
const { ConversationOwners } = require('./conversation-owner');
const { SavedHistoryOperations } = require('./saved-history-operation');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createAgentSendReceiptRegistry, fingerprintAgentSendRequest, RECEIPT_STATES, isAgentSendProviderQueueAccepted } = require('./agent-send-receipt-registry');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { agentSendTargetPreconditionFailure } = require('./agent-send-target-precondition');
const { prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation } = require('./structured-authoring');
const { withPromptOriginPresentation } = require('./history-prompt-presentations');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const quiet = { log() {}, warn() {}, error() {} };
function source(file) {
  const text = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return { text, ast, fn: name => { const n = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(n, name); return n.getText(ast); } };
}
const main = source('main.js'), web = source('web-server.js');
function js(code) { return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText; }
function memoryDb() {
  const rows = new Map(); return { getAppState: k => rows.has(k) ? JSON.parse(JSON.stringify(rows.get(k))) : null,
    setAppState: (k, v) => rows.set(k, JSON.parse(JSON.stringify(v))), db: { transaction: fn => fn } };
}
function mainHarness(db = memoryDb(), receiptStore = null) {
  const writes = [], events = [], input = { revision: 0 };
  const scope = { known: true, provider: 'claude', sessionId: null, projectId: 'P', cwd: '/fixture',
    instanceId: 'main', terminalId: 'pty', launchId: null };
  const owner = new ConversationOwners({ db, capture: () => scope, instanceId: 'main', publish: (_tab, value) => events.push(value) });
  const op = { tabId: 'T', operationId: 'O', toolType: 'claude', revision: 11, state: 'completed', pending: false,
    success: true, bindingCommitted: true, historyMutated: true, fileDeleted: true, activeSessionId: null,
    binding: { applied: true, mode: 'cleared', sessionId: null } };
  op.ownerCheckpoint = owner.checkpoint('T', op, scope);
  const registry = new SavedHistoryOperations({ db, runtime: { owner } }); db.setAppState(registry.key('T', 'O'), op);
  const expected = { toolType: 'claude', sessionId: null, expectedBinding: 'none', ownerToken: owner.current('T').ownerToken };
  let request = { sendOperationKey: 'K', sendAttemptId: 'A' };
  const term = { write: bytes => writes.push(bytes) };
  const ctx = vm.createContext({ console: quiet, path, srcMainDir: __dirname, conversationOwners: owner,
    historyMutationInput: require('./history-mutation-input').createHistoryMutationInputGate(),
    tabWorkContext: { assertContinuationScope() {} }, // this fixture has no quiet completion context
    terminals: new Map([['T', term]]), terminalProjects: new Map([['T', '/fixture']]), terminalInputRevisions: new Map(),
    terminalCommandState: new Map([['T', { runSeq: 1, isRunning: false }]]), claudeLaunchGenerationByTab: new Map(),
    claudePreclaimedCommandGenerations: new Map(), claudeState: new Map(), claudePendingPrompt: new Map(),
    terminalInputLineBuffers: new Map(), terminalInputEscapeStates: new Map(),
    getTerminalInputRevision: () => input.revision,
    getTerminalLifecycleGeneration: () => 'G:' + ctx.terminalCommandState.get('T').runSeq,
    captureConversationOwner: () => ({ ...scope }),
    agentSendReceiptStore: receiptStore || { get: () => ({ attemptId: request.sendAttemptId, receipt: { expectedTarget: expected } }) },
    buildAgentShellLaunchInput: command => command + '\r',
    withPtyWriteLock: async (_term, action) => { if (ctx.beforeLock) ctx.beforeLock(); return action(); },
    proveIdleShellForAgentLaunch: async () => {
      if (ctx.duringProof) ctx.duringProof();
      return { allowed: true, shellWriteProof: { terminalToken: term,
        runSeq: ctx.terminalCommandState.get('T').runSeq, lifecycleGeneration: ctx.getTerminalLifecycleGeneration(), inputRevision: input.revision } };
    },
    beginClaudeLaunchGeneration: () => { scope.launchId = 'own-L'; ctx.claudeLaunchGenerationByTab.set('T', { generation: 'own-L' }); return 'own-L'; },
    markClaudeShellLaunchStarted: () => { if (ctx.afterWrite) ctx.afterWrite(); return 'own-L'; },
    clearClaudeLaunchGeneration: () => { scope.launchId = null; ctx.claudeLaunchGenerationByTab.delete('T'); },
    rollbackClaudeShellLaunchClaims() {}, agentShellLaunchError: () => 'not-idle',
    projectManager: { db: { db: { prepare: () => ({ get: () => ({ claude_session_id: scope.sessionId, cwd: '/fixture' }) }) } } },
    bridgeKnownSessions: new Map([['T', 'stale-before-clear']]),
    getSessionMaterialization: () => assert.fail('strict none must not borrow stale bridge history'),
    evaluateClaudeFreshStartAdmission: ({ boundSessionId }) => { assert.equal(boundSessionId, null); return { allowed: true }; },
  });
  vm.runInContext(['agentSendRequestExpectedTargets', 'expectedKnownEmptySend', 'assertKnownEmptySend',
    'validateClaudeSavedHistoryLaunch', 'writeAgentLaunchCommandToIdleShell', 'writeClaudeSavedHistoryResume',
    'runClaudeCommandFromPayload'].map(main.fn).join('\n'), ctx);
  const run = payload => ctx.runClaudeCommandFromPayload({}, { tabId: 'T', command: 'claude', ...(payload || request) });
  return { owner, scope, registry, op, expected, request, ctx, term, writes, events, input, run,
    setRequest: value => { request = value; } };
}

test('actual fresh Claude caller and physical writer preserve strict empty against a stale renderer/bridge SID', async () => {
  const h = mainHarness(); h.owner.claimSend('T', h.expected, h.request);
  const result = await h.run(); assert.equal(result.launchWritten, true); assert.equal(result.launchId, 'own-L');
  assert.deepEqual(h.writes, ['claude --dangerously-skip-permissions\r']);
  assert.equal(h.ctx.terminalCommandState.get('T').runSeq, 2);
  assert.match((await h.run()).error, /launch_changed/); assert.equal(h.writes.length, 1);
});

test('actual main owner capture reads the exact project binding, distinguishes null/missing and includes run ownership', () => {
  let row = { command_type: 'claude', cwd: '/fixture', claude_session_id: null }, project = 'P';
  const queries = [];
  const ctx = vm.createContext({ resolveAuthoritativeTabProjectId: () => project,
    resolveAiToolOwner: require('./ai-tool-owner').resolveAiToolOwner, getLiveAiRuntimeOwners: () => [],
    projectManager: { db: { db: { prepare: query => ({ get: (...args) => { queries.push([query, args]); return row; } }) } } },
    sdkSessions: new Map(), terminalProjects: new Map(), terminalCommandState: new Map([['T', { runSeq: 9 }]]),
    conversationOwners: { instanceId: 'main' },
    captureArchivedConversationOwner: () => ({ known: false }),
    readAgentSendDestinationAtWriteBoundary: () => ({ terminalInstanceId: 'pty', launchId: 'L', acceptedResumeSourceSessionId: null }),
  });
  vm.runInContext(main.fn('captureConversationOwner'), ctx);
  let result = ctx.captureConversationOwner('T');
  assert.equal(result.known, true); assert.equal(result.sessionId, null); assert.equal(result.runSeq, 9);
  assert.equal(result.cwd, '/fixture'); assert.deepEqual(queries[0][1], ['P', 'T']);
  assert.match(queries[0][0], /project_id = \? AND tab_id = \?/);
  row = { command_type: 'claude' }; assert.equal(ctx.captureConversationOwner('T').known, false);
  row = { command_type: 'claude', claude_session_id: 'stale', codex_session_id: 'live-C' };
  ctx.getLiveAiRuntimeOwners = () => ['codex'];
  result = ctx.captureConversationOwner('T'); assert.equal(result.provider, 'codex'); assert.equal(result.sessionId, 'live-C');
  ctx.getLiveAiRuntimeOwners = () => ['claude', 'codex']; assert.equal(ctx.captureConversationOwner('T').known, false);
  project = null; assert.equal(ctx.captureConversationOwner('T').known, false);
});

for (const edge of ['before-lock', 'during-proof', 'publication-after-write']) {
  test('actual strict launch guard at ' + edge + ' never writes to a successor or repeats its own launch', async () => {
    const h = mainHarness(); h.owner.claimSend('T', h.expected, h.request);
    const change = () => { h.scope.sessionId = 'B'; h.owner.noteInput('T'); };
    if (edge === 'before-lock') h.ctx.beforeLock = change;
    if (edge === 'during-proof') h.ctx.duringProof = change;
    if (edge === 'publication-after-write') h.ctx.afterWrite = () => { throw Error('publication failed'); };
    if (edge === 'publication-after-write') {
      const result = await h.run(); assert.equal(result.launchWritten, true); assert.equal(result.success, false);
      assert.match((await h.run()).error, /launch_changed/); assert.equal(h.writes.length, 1);
    } else { const result = await h.run(); assert.match(result.error, /binding_changed/);
      assert.equal(result.submitted, false); assert.equal(result.launchWritten, false); assert.equal(h.writes.length, 0); }
  });
}

test('actual main paste queue rechecks strict owner after queue wait and before reserving input', async () => {
  const h = mainHarness(); h.owner.claimSend('T', h.expected, h.request);
  const pasteCtx = h.ctx;
  Object.assign(pasteCtx, { findTabIdForTerm: () => 'T', isLocalSlashCommandPrompt: () => false,
    reserveClaudeExactEmptyEvidence: () => null, getHeadlessTerminalMirror: () => null,
    bumpTerminalInputRevision: () => ++h.input.revision,
    _safePasteAndSubmitInner: async () => { h.writes.push('prompt\r'); return { submitted: true }; },
    finishSafePasteAfterWrite: (_term, _content, _options, _op, result) => result });
  vm.runInContext(main.fn('safePasteAndSubmit'), pasteCtx);
  await pasteCtx.safePasteAndSubmit(h.term, 'prompt', h.request); assert.equal(h.writes.length, 1);
  pasteCtx.beforeLock = () => h.owner.noteInput('T');
  const refused = await pasteCtx.safePasteAndSubmit(h.term, 'other', h.request);
  assert.equal(refused.submitted, false); assert.match(refused.error, /binding_changed/);
  assert.equal(h.writes.length, 1); assert.equal(h.input.revision, 1);
});

test('actual cold-history authoring commit retires an older O without waiting for a provider turn', async () => {
  let arm;
  function visit(n) { if (ts.isVariableDeclaration(n) && n.name.getText(main.ast) === 'armMutation'
    && n.initializer?.getText(main.ast).includes('history_context_mutation_not_armed')) arm = n.initializer.getText(main.ast); ts.forEachChild(n, visit); }
  visit(main.ast); assert.ok(arm);
  const h = mainHarness(); let allowed = false;
  const run = vm.runInNewContext('(' + arm + ')', { tabId: 'T', handoffId: 'H', operationKey: 'K', attemptId: 'A',
    conversationOwners: h.owner, agentSendCancellations: { isCancelled: () => false },
    agentSendReceiptStore: { markAttemptState: () => ({ ok: allowed }) }, AGENT_SEND_DURABLE_STATES: { ENTER_ARMED: 'enter-armed' } });
  await assert.rejects(run, /not_armed/);
  assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'applicable');
  allowed = true; await run();
  assert.equal(h.registry.applicability('T', 'O').applicability.verdict, 'superseded');
});

test('actual per-chunk and pre-Enter checks reject a binding change without lying about an already written paste', () => {
  const inner = main.ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === '_safePasteAndSubmitInner');
  let destination, checks = [];
  function visit(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(main.ast) === 'destinationFailure') destination = n.initializer.getText(main.ast);
    if (ts.isIfStatement(n) && n.expression.getText(main.ast).startsWith('knownEmptyDestination || handoffId')) checks.push(n.getText(main.ast));
    ts.forEachChild(n, visit);
  }
  visit(inner); assert.equal(checks.length, 2, 'actual chunk and Enter gates'); assert.ok(destination);
  for (const pasteWritten of [false, true]) {
    const h = mainHarness(); h.owner.claimSend('T', h.expected, h.request);
    Object.assign(h.ctx, { broadcastTabId: 'T', expectedDestination: h.expected, expectedTarget: null,
      handoffId: null, options: {},
      sendOperationKey: 'K', sendAttemptId: 'A', responsePreflightEngine: 'claude', isCodexPasteSource: false,
      claudeAuditBoundary: null, readAgentSendDestinationAtWriteBoundary: () => ({ toolType: 'claude', sessionId: h.scope.sessionId }),
      agentSendTargetPreconditionFailure, knownEmptyDestination: true, pasteWritten });
    h.ctx.destinationFailure = vm.runInContext('(' + destination + ')', h.ctx);
    h.scope.sessionId = 'foreign-B';
    const check = vm.runInContext('(()=>{' + checks[pasteWritten ? 1 : 0] + 'return {written:true};})', h.ctx);
    const result = check(); assert.equal(result.submitted, false); assert.equal(result.enterWritten, false);
    assert.equal(result.pasteWritten, pasteWritten); assert.equal(result.written, undefined);
  }
});

test('actual status null compatibility coexists with explicit none, order rejects delayed reads, unknown never becomes empty', () => {
  const h = mainHarness(); const ctx = vm.createContext({ conversationOwners: h.owner,
    publicRuntimeSnapshots: new Map(), fingerprintAgentSendRequest });
  vm.runInContext(['normalizePublicRuntimeStatus', 'stampPublicRuntimeSnapshot', 'finishConversationOwnerRead'].map(web.fn).join('\n'), ctx);
  ctx.stampPublicRuntimeSnapshot('T', { sessionId: 'old', writerSessionId: 'old', status: 'inactive' });
  const after = ctx.stampPublicRuntimeSnapshot('T', { sessionId: null, writerSessionId: null, status: 'inactive' });
  assert.equal(after.sessionId, 'old'); assert.equal(after.conversationOwner.currentBinding.state, 'none');
  const delayed = h.owner.current('T'); h.owner.noteInput('T');
  const finish = ctx.finishConversationOwnerRead('T', delayed);
  assert.equal(finish.ownerSnapshotCurrent, false);
  assert.equal(finish.conversationOwner.ownerToken, delayed.ownerToken, 'old history is never stamped with a new owner');
  h.scope.known = false;
  assert.equal(ctx.stampPublicRuntimeSnapshot('T', {}).conversationOwner.currentBinding.state, 'unknown');
});

test('actual renderer readiness carries exact attempt to first launch (no native/client extra Enter)', async () => {
  const renderer = source('../renderer/utils/agentSendPreparation.ts');
  let ready = false, captured;
  const ctx = vm.createContext({ console: quiet, createAgentSendTargetExpectation: (toolType, sessionId) => ({ toolType, sessionId }),
    resolveReadyAgentSendTarget: expected => expected,
    createAgentReadyWait: () => ({ promise: Promise.resolve(), cancel() {} }) });
  vm.runInContext(js(renderer.fn('prepareAgentRuntimeForSend').replace(/^export /, '')), ctx);
  await ctx.prepareAgentRuntimeForSend({ tabId: 'T', sessionId: null, sendOperationKey: 'K', sendAttemptId: 'A',
    runtime: { toolType: 'claude', label: 'Claude', getPresence: async () => ({ status: ready ? 'active' : 'inactive' }),
      startFresh: async args => { captured = args; ready = true; return { success: true }; } },
    providerContract: { classifySubmitCapability: p => p?.status === 'active' ? 'direct' : null,
      startupGateOwnsComposer: () => false, waitForStartupGate: async () => {} } });
  assert.equal(captured.sendOperationKey, 'K'); assert.equal(captured.sendAttemptId, 'A');
  const runtimes = source('../renderer/utils/historyAgentRuntimes.ts');
  const invokes = [];
  vm.runInNewContext(js(runtimes.fn('startFreshClaudePtySession')) + ';startFreshClaudePtySession(input)', {
    input: captured, console: quiet, shortTab: x => x, useWorkspaceStore: { getState: () => ({ setTabCommandType() {}, markAiLaunchAutoTitle() {} }) },
    ipcRenderer: { invoke: async (...args) => { invokes.push(args); return { success: true }; } } });
  assert.equal(invokes.length, 1); assert.equal(invokes[0][1].sendAttemptId, 'A');
});

test('actual App scenario uses main strict-none admission, not a stale renderer SID', async () => {
  const app = source('../renderer/App.tsx'); let branch;
  function visit(n) { if (ts.isIfStatement(n) && n.expression.getText(app.ast) === "action === 'sendMessageAuto' || action === 'sendAgentPromptScenario'") branch = n.getText(app.ast); ts.forEachChild(n, visit); }
  visit(app.ast); assert.ok(branch);
  let sent, hint;
  const run = vm.runInNewContext(js('(async(action,payload)=>{' + branch + '})'), {
    crypto, describeAgentTab: () => ({ tab: { cwd: '/fixture' }, toolType: 'claude', runtime: {}, sessionId: 'stale-S' }),
    reply: (_ok, value) => value, createAgentSettingsIntent: () => ({}), maybeAutoTitleAfterMobileSend() {},
    runHistoryPromptHandoff: async args => { hint = args.sessionIdHint; return args.send(args.handoffId); },
    sendAgentPromptScenario: async args => { sent = args; return { success: true }; },
  });
  await run('sendAgentPromptScenario', { tabId: 'T', prompt: 'new authoring', expectedBinding: 'none',
    expectedToolType: 'claude', workContextPrepared: true, sendOperationKey: 'K', sendAttemptId: 'A' });
  assert.equal(hint, null); assert.equal(sent.sessionId, null); assert.equal(sent.sendAttemptId, 'A');
});

test('actual Codex binding IPC + SQLite commit share the exact operation checkpoint and roll back together', async t => {
  let sql;
  try { sql = new (require('better-sqlite3'))(':memory:'); }
  catch (error) { if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Electron ABI'); return; } throw error; }
  t.after(() => sql.close());
  sql.exec("CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER); CREATE TABLE tabs(project_id TEXT,tab_id TEXT,codex_session_id TEXT); INSERT INTO tabs VALUES('P','T','S')");
  const db = Object.create(require('./database').prototype); db.db = sql;
  const term = {}, runtimeState = { terminalToken: term, projectId: 'P', cwd: '/fixture', lifecycleGeneration: 'G',
    runSeq: 3, inputRevision: 4, launchId: null, isRunning: false, toolType: 'codex' };
  const capture = () => ({ ...runtimeState, sessionId: db.getTabCodexSessionId('P', 'T') });
  const owner = new ConversationOwners({ db, capture: () => ({ known: true, provider: 'codex',
    sessionId: capture().sessionId, projectId: 'P', cwd: '/fixture', launchId: null }), instanceId: 'main' });
  const registry = new SavedHistoryOperations({ db, runtime: { owner, capture } });
  const record = { tabId: 'T', operationId: 'O', toolType: 'codex', expectedSessionId: 'S', phase: 'adopting', state: 'running', revision: 4 };
  const lease = { key: registry.key('T', 'O'), record, mutation: { newSessionId: 'child' }, scope: capture() };
  registry.leases.set(lease.key, lease); db.setAppState(lease.key, record);
  let call, handler;
  function visit(n) { if (ts.isCallExpression(n) && n.expression.getText(main.ast) === 'ipcMain.handle' && n.arguments[0]?.text === 'tab:set-codex-session-id') call = n.getText(main.ast); ts.forEachChild(n, visit); }
  visit(main.ast); assert.ok(call);
  vm.runInNewContext(call, { ipcMain: { handle: (_name, fn) => { handler = fn; } }, console: quiet, path, srcMainDir: __dirname,
    historyMutationInput: require('./history-mutation-input').createHistoryMutationInputGate(),
    runKeyedExclusive: (_map, _tab, fn) => fn(), codexLaunchInflight: new Map(),
    resolveAuthoritativeTabProjectId: () => 'P', codexLastRunCommandPayload: new Map(),
    getCodexRuntimeSessionSnapshot: async () => ({ liveLifecycle: false }), projectManager: { db },
    require: () => ({ commitSavedHistoryCodexBinding: (...args) => registry.commitCodexBinding(...args) }) });
  const payload = { projectId: 'P', tabId: 'T', expectedSessionId: 'S', sessionId: 'child', reason: 'deleteRange',
    historyOperation: { tabId: 'forged', operationId: 'O' } };
  sql.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON app_state BEGIN SELECT RAISE(ABORT,'receipt rejected'); END");
  const failed = await handler(null, payload); assert.equal(failed.success, false); assert.equal(capture().sessionId, 'S');
  assert.equal(owner.stored('T'), null); assert.equal(registry.read('T', 'O').bindingCommitted, undefined);
  sql.exec('DROP TRIGGER reject_receipt');
  assert.equal((await handler(null, payload)).success, true);
  assert.equal(capture().sessionId, 'child'); assert.equal(registry.read('T', 'O').bindingCommitted, true);
  assert.equal(registry.applicability('T', 'O', 5).applicability.verdict, 'applicable');
});

test('real SQLite reopen preserves exact clear and later same-SID input tombstone; GET never recreates a checkpoint', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-owner-store-'));
  let sql, Sqlite = require('better-sqlite3');
  try { sql = new Sqlite(path.join(root, 'owner.sqlite')); }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('Electron ABI'); return; } throw error; }
  t.after(() => { sql.close(); fs.rmSync(root, { recursive: true, force: true }); });
  sql.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const db = Object.create(require('./database').prototype); db.db = sql;
  const h = mainHarness(db); const old = h.owner.current('T');
  sql.close(); sql = new Sqlite(path.join(root, 'owner.sqlite')); db.db = sql;
  const resumed = new ConversationOwners({ db, capture: () => h.scope, instanceId: 'other-main' });
  assert.equal(resumed.applicability('T', h.op).applicability.verdict, 'applicable');
  assert.equal(resumed.current('T').ownerToken, old.ownerToken);
  resumed.noteInput('T'); sql.close(); sql = new Sqlite(path.join(root, 'owner.sqlite')); db.db = sql;
  const again = new ConversationOwners({ db, capture: () => h.scope });
  assert.equal(again.applicability('T', h.op).applicability.verdict, 'superseded');
  assert.ok(again.current('T').ownerOrder.revision > old.ownerOrder.revision);
});

function requestJson(port, pathname, body, authenticated = true) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET',
      headers: { ...(authenticated ? { authorization: 'Bearer fixture' } : {}), 'content-type': 'application/json' } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); }
      });
    }); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
test('actual authenticated HTTP receipt/applicability/strict Send with SQLite: O -> B, lost response reads same attempt', async t => {
  let sql;
  try { sql = new (require('better-sqlite3'))(':memory:'); }
  catch (error) { if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('run with Electron Node ABI'); return; } throw error; }
  t.after(() => sql.close());
  sql.exec('CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
  const db = Object.create(require('./database').prototype); db.db = sql;
  const receiptStore = createAgentSendReceiptStore(sql);
  const h = mainHarness(db, receiptStore);
  let bridges = 0;
  const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const ctx = vm.createContext({ console: quiet, url, crypto, token: 'fixture', conversationOwners: h.owner,
    compactSendReceiptPresentation: require('./compact-send-settlement').compactSendReceiptPresentation,
    require: name => { if (name.endsWith('project-manager')) return { db }; throw Error('unexpected module ' + name); },
    savedHistoryOperations: h.registry, inboxSavedHistoryOperations: null,
    agentSendReceiptStore: receiptStore, agentSendReceiptRegistry: createAgentSendReceiptRegistry(), agentSendReceiptStartupReady: Promise.resolve(),
    agentSendBridgeTimeoutMs: 1000, tabWorkContext: null, projectManager: {},
    prepareStructuredAuthoring, validateStructuredSendEnvelope, bindStructuredAuthoringPresentation, withPromptOriginPresentation,
    promptAuditFingerprint, fingerprintAgentSendRequest, classifyAgentSendReceipt, isAgentSendProviderQueueAccepted,
    AGENT_SEND_RECEIPT_STATES: RECEIPT_STATES, agentSendTargetPreconditionFailure,
    shortId: x => x, decId: decodeURIComponent, cleanOptionalString: (x, fallback = '') => typeof x === 'string' ? x.trim() : fallback,
    sendJson, readBody: req => new Promise(resolve => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => resolve(JSON.parse(body))); }),
    findOrchestrationTabDescriptor: () => ({ tabId: 'T', projectId: 'P', toolType: 'claude', sessionId: h.scope.sessionId, tabType: 'terminal' }),
    ensureExplicitAgentTabOpen: async () => ({}), resolveProjectAgentModelRequest: async () => ({}),
    sendSendFailure: (res, data) => sendJson(res, 409, data), sendDeliveryUnknown: (res, data) => sendJson(res, 202, data),
    sendAuditPending: (res, data) => sendJson(res, 202, data),
    bridgeRequest: async (_action, payload) => {
      bridges++; h.setRequest({ sendOperationKey: payload.sendOperationKey, sendAttemptId: payload.sendAttemptId });
      assert.equal(payload.expectedBinding, 'none');
      await h.run({ sendOperationKey: payload.sendOperationKey, sendAttemptId: payload.sendAttemptId });
      h.scope.sessionId = 'new-real-provider-SID'; h.owner.assertNone('T', h.expected, payload);
      h.writes.push('one prompt\r');
      return { success: true, accepted: true, submitted: true, status: 'audit-pending', auditPending: true };
    },
  });
  vm.runInContext(['checkAuth', 'handleApi', 'runAgentSendScenario', 'runPreparedAgentSendScenario',
    'durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay', 'durableAgentSendFailure', 'publicAgentSendReceipt'].map(web.fn).join('\n'), ctx);
  const server = http.createServer((req, res) => ctx.handleApi(req, res, url.parse(req.url, true), new Map()).catch(e => sendJson(res, 500, { error: e.message })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const get = pathname => requestJson(server.address().port, pathname);
  const base = '/api/terminal-tabs/T/history-operations/O';
  assert.equal((await requestJson(server.address().port, base + '/applicability', null, false)).status, 401);
  const applicable = await get(base + '/applicability?operationRevision=11');
  assert.equal(applicable.status, 200, JSON.stringify(applicable));
  assert.equal(applicable.data.applicability.verdict, 'applicable');
  assert.equal((await get(base + '/applicability?operationRevision=10')).status, 409);
  const before = (await get(base)).data;
  const body = { expectedToolType: 'claude', expectedSessionId: null, expectedBinding: 'none', ownerToken: h.expected.ownerToken,
    handoffId: 'H', authoring: { version: 1, text: 'prompt', chips: [], imagePaths: [] } };
  const sent = await requestJson(server.address().port, '/api/terminal-tabs/T/send', body);
  assert.equal(sent.status, 202, JSON.stringify(sent)); assert.equal(bridges, 1); assert.equal(h.writes.length, 2);
  const record = receiptStore.get('project:T:H'); assert.ok(record.attemptId);
  const receipts = await get('/api/terminal-tabs/T/send-receipts?handoffId=H');
  assert.equal(receipts.status, 200, JSON.stringify(receipts));
  assert.equal(receipts.data.receipts[0].attemptId, record.attemptId);
  assert.deepEqual((await get(base)).data, before);
  assert.equal((await get(base + '/applicability')).data.applicability.verdict, 'superseded');
  const later = await requestJson(server.address().port, '/api/terminal-tabs/T/send', { ...body, handoffId: 'other' });
  assert.equal(later.status, 409); assert.equal(later.data.submitted, false); assert.equal(bridges, 1);
  const replay = await requestJson(server.address().port, '/api/terminal-tabs/T/send', body);
  assert.equal(replay.status, 202); assert.equal(bridges, 1); assert.equal(receiptStore.get('project:T:H').attemptId, record.attemptId);
});
