'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore, STORE_STATES } = require('./agent-send-receipt-store');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { promptAuditFingerprint: hash } = require('./prompt-audit-fingerprint');
const { prepareClaudePromptTransport } = require('./claude-prompt-transport');
const { projectClaudePromptAuditToRequest, validateClaudePromptRequestProjection } = require('./claude-prompt-request-projection');
const failureApi = require('../shared/claude-provider-failure.cjs');
const { reconcileAgentSendStartupRecord } = require('./agent-send-startup-reconcile');
const { captureClaudePromptAuditBoundary } = require('./claude-prompt-audit');
const main = fs.readFileSync(require.resolve('./main'), 'utf8');
const parsed = ts.createSourceFile('main.js', main, ts.ScriptTarget.Latest, true);
const declaration = name => parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(parsed);
const quiet = { log() {}, warn() {}, error() {} };
const message = "You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";
// Minimal shape of the exact API record c4b2f48b… at 13.09 19:46:47.093 UTC.
const fatalRecord = { uuid: 'error-1', type: 'assistant', parentUuid: 'user-1', sessionId: 'S',
  timestamp: '2026-09-13T19:46:47.093Z', isApiErrorMessage: true, apiErrorStatus: 429,
  error: 'rate_limit', errorDetails: '429 {"error":{"type":"rate_limit_error"}}',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: message }] } };

function fixture(t, raw = '<context_file>\n\taudit\r\n\tданные 😀\n</context_file>') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-failure-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transport = prepareClaudePromptTransport(raw).transport.text;
  const operationKey = 'orchestration-target:R', attemptId = 'A', handoffId = 'orchestration:R';
  const record = { operationKey, attemptId, handoffId, tabId: 'T', provider: 'claude', sessionId: 'S',
    state: 'audit-pending', promptHash: hash(raw), promptLength: raw.length,
    receipt: { operationKey, attemptId, promptText: raw, transportText: transport } };
  const executionContext = { provider: 'claude', sessionId: 'S', turnId: 'claude:23',
    processId: '27889', generation: 23, startedAt: 1789322883900 };
  const audit = { sendOperationKey: operationKey, sendAttemptId: attemptId, handoffId,
    expectedText: transport, expectedLen: transport.length, expectedHash: hash(transport),
    executionContext, source: 'orchestration:source' };
  const result = { success: true, actualText: transport, actualLen: transport.length,
    actualHash: hash(transport), expectedLen: transport.length, expectedHash: hash(transport),
    sessionId: 'S', entryUuid: 'user-1', recordByteOffset: 500,
    auditTimestamp: '2026-09-13T18:08:04.182Z' };
  return { dir, raw, transport, record, audit, result, executionContext };
}

test('exact pre-Enter request→transport mapping; corrupted scope/text/provider evidence is rejected', t => {
  const h = fixture(t);
  const input = { tabId: 'T', record: h.record, audit: h.audit, result: h.result };
  assert.equal(projectClaudePromptAuditToRequest(input).applied, true);
  for (const key of ['tabId', 'handoffId', 'operationKey', 'attemptId', 'promptHash', 'promptLength']) {
    const record = { ...h.record, [key]: 'different' };
    assert.equal(projectClaudePromptAuditToRequest({ ...input, record }).applied, false, key);
  }
  for (const key of ['promptText', 'transportText', 'operationKey', 'attemptId']) {
    const record = { ...h.record, receipt: { ...h.record.receipt, [key]: 'different' } };
    assert.equal(projectClaudePromptAuditToRequest({ ...input, record }).applied, false, key);
  }
  assert.equal(projectClaudePromptAuditToRequest({ ...input,
    result: { ...h.result, actualHash: hash('other') } }).applied, false);
  assert.equal(validateClaudePromptRequestProjection({ ...input, audit: { ...h.audit,
    expectedText: h.raw } }).valid, false);
});

test('actual settings recovery only resumes the failed kind in the same live launch', () => {
  const term = {}, calls = [];
  const runtime = { term, launchGeneration: 'L', lifecycleGeneration: 'G', runSeq: 2 };
  const context = vm.createContext({ console: quiet,
    claudeStartupDefaultsGateByTab: new Map([['T', { status: 'failed', generation: 'L', failedCommand: '/model fable' }]]),
    claudeLaunchGenerationByTab: new Map([['T', { generation: 'L' }]]), terminals: new Map([['T', term]]),
    terminalCommandState: new Map([['T', { runSeq: 2 }]]), getTerminalLifecycleGeneration: () => 'G',
    aiStoppingTabs: new Set(), claudeStartupMainRuntime: { retry: tabId => calls.push(tabId) } });
  vm.runInContext(declaration('reconcileClaudeStartupAfterSettings'), context);
  const reconcile = context.reconcileClaudeStartupAfterSettings;
  reconcile({ tabId: 'T', runtime, results: [{ success: false, kind: 'model' }] });
  reconcile({ tabId: 'T', runtime, results: [{ success: true, kind: 'effort' }] });
  reconcile({ tabId: 'T', runtime: { ...runtime, launchGeneration: 'old' }, results: [{ success: true, kind: 'model' }] });
  assert.equal(calls.length, 0);
  reconcile({ tabId: 'T', runtime, results: [{ success: true, kind: 'model' }] });
  assert.deepEqual(calls, ['T']);
});

test('same saved mapping recovers exact JSONL delivery, never an old or foreign carrier', async t => {
  const h = fixture(t);
  const file = path.join(h.dir, 'S.jsonl');
  fs.writeFileSync(file, '');
  const boundary = await captureClaudePromptAuditBoundary(file);
  h.record.transcriptBoundary = { ...boundary, sessionId: 'S' };
  fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'user-1', sessionId: 'S',
    timestamp: new Date().toISOString(), message: { role: 'user', content: h.transport } }) + '\n');
  const recovered = await reconcileAgentSendStartupRecord(h.record);
  assert.equal(recovered.decision, 'found', JSON.stringify(recovered));
  assert.equal(recovered.audit.expectedHash, hash(h.raw));
  assert.equal(recovered.audit.actualHash, hash(h.transport));
  assert.equal(recovered.audit.canonicalReason, 'claude_request_transport_exact');
  const rejected = await reconcileAgentSendStartupRecord({ ...h.record,
    receipt: { ...h.record.receipt, transportText: h.transport + 'foreign' } });
  assert.equal(rejected.decision, 'unknown');
});

test('typed failure after tools is recovered through actual main result and web reconciliation, not a final answer', async t => {
  const h = fixture(t);
  const { materializeClaudeOrchestrationTurn, materializeClaudeOrchestrationExecution } = require('./claude-orchestration-result');
  const { classifyOrchestrationResultProbe } = require('./orchestration-result-proof');
  const noResponse = { ...fatalRecord, uuid: 'resume', isApiErrorMessage: false,
    message: { model: '<synthetic>', stop_reason: 'stop_sequence', role: 'assistant',
      content: [{ type: 'text', text: 'No response requested.' }] } };
  const recordMap = new Map([[fatalRecord.uuid, fatalRecord], ['resume', noResponse]]);
  const turn = { userUuid: 'user-1', kind: 'user', assistantUuids: [fatalRecord.uuid, 'resume'] };
  const output = materializeClaudeOrchestrationTurn(turn, recordMap);
  assert.equal(output.complete, false);
  assert.equal(output.assistantText, '');
  assert.equal(output.terminalEvent, 'provider_error');
  assert.equal(classifyOrchestrationResultProbe({ found: true, ...output }).kind, 'terminal-failure');
  const next = materializeClaudeOrchestrationExecution({ turns: [turn, { kind: 'user', assistantUuids: [] }],
    startTurnIndex: 1, recordMap });
  assert.equal(next.terminalEvent, undefined, 'old error cannot fail a new prompt');
  const internal = materializeClaudeOrchestrationTurn({ ...turn, completionAssistantUuids: [] }, recordMap);
  assert.equal(internal.terminalEvent, undefined, 'old error is outside the latest continuation');
  const context = vm.createContext({ console: quiet, materializeClaudeOrchestrationTurn,
    materializeClaudeOrchestrationExecution, findMatchingClaudePromptTurn: () => ({ turn, turnIndex: 0 }),
    _loadSessionTurns: async () => ({ engine: 'claude', turns: [turn], recordMap }),
  });
  // The exact return contract is tested separately from IO/discovery: run the
  // actual Claude result branch after its existing exact prompt lookup.
  const reader = declaration('_getAgentTurnResultForOrchestration');
  const branch = reader.slice(reader.indexOf('const exactClaudeExecutionProof'), reader.lastIndexOf('}'));
  vm.runInContext('function result() { const targetExecutionContext=null, promptUserUuid="user-1", sessionId="S", resultBeforeAt=null, maxChars=10000; const match={turn,turnIndex:0}; const data={turns:[turn],recordMap};' + branch + '}',
    Object.assign(context, { turn, recordMap }));
  const probe = context.result();
  assert.equal(probe.errorCode, 'claude_rate_limit');
  const store = new OrchestrationRunStore(path.join(h.dir, 'runs.json'));
  await store.create({ runId: 'late', sourceTabId: 'source', sourceProjectId: 'P', targetTabId: 'T',
    targetProjectId: 'P', targetToolType: 'claude', promptHash: 'exact-request-hash', promptChars: 10 });
  await store.markDelivery('late', { sessionId: 'S', auditPending: true });
  const webSource = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const webAst = ts.createSourceFile('web.js', webSource, ts.ScriptTarget.Latest, true);
  const reconcile = webAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'reconcileOrchestrationRun');
  const notifications = [];
  vm.runInContext(reconcile.getText(webAst), Object.assign(context, {
    captureOrchestrationResultAttempt: require('./orchestration-runs').captureOrchestrationResultAttempt,
    getOrchestrationRunStore: () => store, isActiveStatus: () => true, isPausedRun: () => false,
    resolveAgentSessionInfo: async () => ({ sessionId: 'S', status: 'active' }),
    probeOrchestrationResult: async () => ({ ...probe, resultComplete: false }),
    emitOrchestrationRun() {}, finalizeSettledOrchestrations: async runs => notifications.push(...runs),
  }));
  const result = await context.reconcileOrchestrationRun('late');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error, message);
  assert.equal(result.resultAvailable, false);
  assert.equal(notifications.length, 1);
  await store.flush();
});

test('actual main audit→SQLite→orchestration→actual StopFailure publication settles once, no successful result', async t => {
  const h = fixture(t);
  let db;
  try { db = new Database(':memory:'); } catch (error) {
    if (error.code === 'ERR_DLOPEN_FAILED') { t.skip('run using Electron Node ABI'); return; } throw error;
  }
  t.after(() => db.close());
  const receipts = createAgentSendReceiptStore(db);
  const identity = { ...h.record, surface: 'orchestration', requestFingerprint: 'F' };
  const begun = receipts.beginAttempt(identity);
  assert.equal(begun.ok, true);
  h.audit.sendAttemptId = begun.attemptId;
  receipts.stageAttemptContext(identity.operationKey, begun.attemptId, {
    promptText: h.raw, transportText: h.transport, sessionId: 'S',
    transcriptBoundary: { sessionId: 'S', fileSize: 500 },
  });
  receipts.markAttemptState(identity.operationKey, begun.attemptId, STORE_STATES.ENTER_ARMED);
  const published = [];
  const context = vm.createContext({ console: quiet, agentSendReceiptStore: receipts,
    AGENT_SEND_DURABLE_STATES: STORE_STATES, projectClaudePromptAuditToRequest,
    routeAgentPromptAuditDetail: detail => published.push(detail) });
  vm.runInContext(['isOrchestrationPromptAudit', 'compatiblePromptAuditExecutionContext',
    'publishAgentPromptAuditResult'].map(declaration).join('\n'), context);
  context.publishAgentPromptAuditResult('T', h.audit, h.result, 'claude');
  assert.equal(receipts.get(identity.operationKey).state, 'confirmed');
  assert.equal(published.length, 1);
  const store = new OrchestrationRunStore(path.join(h.dir, 'runs.json'));
  await store.create({ runId: 'R', sourceTabId: 'source', sourceProjectId: 'P', targetTabId: 'T',
    targetProjectId: 'P', targetToolType: 'claude', promptHash: 'full-transcript-hash',
    targetPromptAuditHash: hash(h.raw), promptChars: h.raw.length, failureGraceMs: 300000 });
  // The actual HTTP/MCP conduit must carry canonicalReason as well as hashes.
  // Dropping it used to reject this proven transform for a second time.
  const webSource = fs.readFileSync(require.resolve('./web-server'), 'utf8');
  const start = webSource.indexOf('const confirmation = await store.confirmTargetPromptDelivery(targetRunId, {');
  const forwardEnd = webSource.indexOf('\n    if (confirmation.confirmed)', start);
  const forward = vm.runInNewContext('(async (store, detail, targetRunId) => {'
    + webSource.slice(start, forwardEnd) + ';return confirmation;})');
  const proof = await forward(store, published[0], 'R');
  assert.equal(proof.confirmed, true);
  assert.equal(proof.contextBound, true);
  await store.markDelivery('R', { sessionId: 'S' });
  const web = [], renderer = [];
  const hookContext = vm.createContext({ ...failureApi, busy: false, event: 'StopFailure',
    msg: { event: 'StopFailure', error: 'rate_limit' }, tabId: 'T', taskTurnId: 'claude:23',
    taskTurnSnapshot: { generation: 23, startedAt: h.executionContext.startedAt },
    taskCompletionMeta: {}, hookEventTs: Date.now(), session_id: 'S', ppid: '27889',
    internalAgentContinuationKind: null, prevSpinner: true, console: quiet,
    claudeLocalCommandWatchers: new Map(), clearClaudePtyCompactProofAttempt() {},
    mainWindow: { isDestroyed: () => false, webContents: { send: (type, data) => renderer.push({ type, data }) } },
    getCombinedTabBackgroundWorkCount: () => 1, _webBroadcast: (_id, payload) => web.push(payload) });
  const begin = main.indexOf("const lifecycleReason = (!busy && event === 'StopFailure')");
  const end = main.indexOf('// Activity tracking — authoritative turn edges', begin);
  vm.runInContext(main.slice(begin, end), hookContext);
  const done = web.find(event => event.type === 'done');
  assert.equal(done.terminalProviderFailure, true);
  assert.equal(renderer[0].data.busy, false);
  const stale = await store.applyLifecycle('T', { ...done, turnId: 'claude:old' });
  assert.equal(stale.settled.length, 0);
  const settled = await store.applyLifecycle('T', done);
  assert.equal(settled.settled.length, 1);
  assert.equal(settled.settled[0].status, 'failed');
  assert.match(settled.settled[0].error, /лимит/);
  assert.equal(settled.settled[0].resultErrorCode, 'claude_rate_limit');
  assert.equal(settled.settled[0].resultAvailable, false);
  assert.equal(settled.settled[0].recoveryDeadlineAt, null);
  assert.equal((await store.applyLifecycle('T', done)).settled.length, 0);
  assert.equal((await store.get('R')).waitingForInternalDescendants, false);
  await store.flush();
});

test('actual durable Claude parser and live reducer agree on error row; quoted text remains an answer', async t => {
  const h = fixture(t);
  const projectDir = path.join(h.dir, '.claude/projects/-fixture');
  fs.mkdirSync(projectDir, { recursive: true });
  const quote = { ...fatalRecord, uuid: 'quote', parentUuid: fatalRecord.uuid, isApiErrorMessage: false };
  fs.writeFileSync(path.join(projectDir, 'S.jsonl'), [
    { type: 'user', uuid: 'user-1', sessionId: 'S', timestamp: '2026-09-13T18:08:03.870Z', message: { role: 'user', content: 'audit' } },
    fatalRecord, quote,
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const originalLoad = Module._load;
  const dataPath = require.resolve('./ipc/claude-data');
  delete require.cache[dataPath];
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { ipcMain: { handle() {} } };
    if (request === 'os' || request === 'node:os') return { ...os, homedir: () => h.dir };
    return originalLoad.call(this, request, parent, isMain);
  };
  let data;
  try { data = require(dataPath); } finally { Module._load = originalLoad; }
  data.register({ projectManager: {}, formatToolAction: () => null });
  const durable = await data._api.getFullHistory({ sessionId: 'S', cwd: '/fixture' });
  assert.equal(durable.success, true);
  const row = durable.entries.find(entry => entry.uuid === fatalRecord.uuid);
  assert.equal(row.role, 'usage-limit');
  assert.equal(row.content, message);
  assert.equal(durable.entries.find(entry => entry.uuid === 'quote').role, 'assistant');
  const live = await import('../renderer/utils/historyLiveProjection.mjs');
  const reduce = live.reduceHistoryLiveProjection;
  assert.equal(typeof reduce, 'function');
  const projected = reduce([], { toolType: 'claude', sessionId: 'S', message: fatalRecord });
  assert.equal(projected[0].role, row.role);
  assert.equal(projected[0].content, row.content);
  assert.equal(reduce([], { toolType: 'claude', sessionId: 'S', message: quote })[0].role, 'assistant');
});
