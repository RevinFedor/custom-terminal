'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const runs = require('./orchestration-runs');
const proof = require('./orchestration-result-proof');
const receipts = require('./agent-send-receipt-registry');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { resolveOrchestrationSourceNotificationSendOptions, buildDelegationResultTarget } = require('./orchestration-request-plan');
const { findUniqueLegacySourceFollowupProof } = require('./orchestration-source-reconcile');
const { runOrchestrationCompletionFlow } = require('./orchestration-completion-flow');

// Execute the real web functions and durable store. Only the provider reader,
// watcher transport and notification transport are fake; no app/server starts.
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const parsed = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const functions = ['probeOrchestrationResult', 'reconcileOrchestrationRun',
  'finalizeSettledOrchestration', 'finalizeSettledOrchestrations',
  'finalizeClosedTargetResultProof', 'sendOrchestrationCompletionNotification'];
const declarations = functions.map(name => {
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(parsed);
});
const pass = parsed.statements.find(item => ts.isFunctionDeclaration(item)
  && item.name?.text === 'finalizeSettledOrchestrationPass');
if (pass) declarations.push(pass.getText(parsed));
for (const name of ['orchestrationCompletionInflight', 'orchestrationCompletionTrailing']) {
  const node = parsed.statements.find(item => ts.isVariableStatement(item)
    && item.declarationList.declarations.some(decl => decl.name.getText(parsed) === name));
  assert.ok(node, name);
  declarations.push(node.getText(parsed));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const execution = { provider: 'codex', sessionId: 'S', turnId: 'A', processId: 'P',
  generation: 1, startedAt: Date.now() - 1000 };
const complete = { found: true, complete: true, assistantText: 'answer A', turnIndex: 3,
  userUuid: 'user-A', terminalEvent: 'task_complete', hasFinalResult: true,
  executionContext: execution, sourceVerified: true };
const failures = [
  { found: true, complete: false, terminalEvent: 'turn_aborted', hasFinalResult: false },
  { found: true, complete: false, terminalEvent: 'task_complete', hasFinalResult: false },
  { found: true, complete: false, terminalEvent: 'provider_error', proofDefinitive: true,
    errorCode: 'provider_error', error: 'provider rejected A' },
];

async function fixture(t, { read, busy = true, run = {}, sourceInfo, sourceProjects = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-result-audit-'));
  const store = new runs.OrchestrationRunStore(path.join(dir, 'runs.json'));
  t.after(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  await store.create({ runId: 'R', sourceTabId: 'source', targetTabId: 'target',
    targetToolType: 'codex', targetCwd: dir, promptHash: 'hash-A',
    targetExecutionContext: execution, ...run });
  await store.markDelivery('R', { sessionId: 'S', lifecycleGeneration: 'L' });
  await store.applyLifecycle('target', { type: 'busy', busy: true, sessionId: 'S',
    lifecycleGeneration: 'L', executionContext: execution });
  const requests = [], effects = [], notifications = [];
  const context = vm.createContext({ ...runs, ...proof, ...receipts,
    AGENT_SEND_RECEIPT_STATES: receipts.RECEIPT_STATES,
    runOrchestrationCompletionFlow, promptFingerprint, promptAuditFingerprint,
    resolveOrchestrationSourceNotificationSendOptions,
    console: { log() {}, warn() {} },
    getOrchestrationRunStore: () => store,
    resolveAgentSessionInfo: async tabId => tabId === 'source' && sourceInfo
      ? sourceInfo() : ({
      status: busy ? 'busy' : 'idle', sessionId: tabId === 'target' ? 'S' : 'source-S',
      cwd: dir, lifecycleGeneration: 'L', toolType: 'codex',
      executionContext: { ...execution, turnId: 'B', generation: 2 },
    }),
    getAgentTurnResult: async request => {
      requests.push(request);
      return read ? read(request, requests.length) : complete;
    },
    e2eBoundaryTestGate: null,
    ORCHESTRATION_RESULT_PROOF_FLUSH_GRACE_MS: 5000,
    orchestrationResultProofCoordinator: { snapshot: () => [] },
    armOrchestrationResultProof: async () => { effects.push('arm'); return { success: true }; },
    releaseOrchestrationResultProof: async () => { effects.push('release'); },
    emitOrchestrationRun: () => { effects.push('emit'); },
    emitOrchestrationChanges: changed => { for (const _ of changed || []) effects.push('emit'); },
    dispatchNextDeferredOrchestrationForTarget: async () => { effects.push('dispatch'); },
    scheduleOrchestrationPolicyTimer: async () => {},
    findOrchestrationTabDescriptor: () => null,
    findUniqueLegacySourceFollowupProof,
    require: name => {
      assert.equal(name, './project-manager');
      return { db: { getAllProjects: () => sourceProjects } };
    },
    shortId: value => String(value || '').slice(0, 12),
    orchestrationNotificationInflight: new Set(),
    orchestrationNotificationText: current => `result ${current.runId} ${current.status}`,
    orchestrationPresentationSnapshot: () => null,
    tabWorkContext: null,
    armOrchestrationSourceProof: async () => ({ success: true }),
    releaseOrchestrationSourceProof: async () => {},
    reconcileOrchestrationSourceFollowup: async () => ({ confirmed: false }),
    runAgentSendScenario: async request => {
      notifications.push(request);
      return { success: true };
    },
  });
  vm.runInContext(declarations.join('\n'), context);
  async function child(options = {}) {
    await store.create({ runId: 'child', sourceTabId: 'target', targetTabId: 'child-target',
      parentRunId: 'R', sourceExecutionContext: execution, promptHash: 'child-prompt', ...options });
  }
  async function finish() {
    const current = await store.getInternal('R');
    await store.applyLifecycle('target', { type: 'done', reason: 'task_complete', sessionId: 'S',
      lifecycleGeneration: 'L', executionContext: current.targetExecutionContext });
  }
  return { store, context, requests, effects, notifications, child, finish };
}

test('audit #3: closing a target joins the held final proof before deciding unavailable', { timeout: 5000 }, async t => {
  const entered = deferred(), held = deferred();
  t.after(() => held.resolve(complete));
  const h = await fixture(t, { read: async (_, n) => {
    if (n === 1) { entered.resolve(); return held.promise; }
    return complete;
  } });
  await h.finish();
  const first = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  await entered.promise;
  let closeReturned = false;
  const close = h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true })
    .then(value => { closeReturned = true; return value; });
  await new Promise(setImmediate);
  const returnedBeforeRead = closeReturned;
  const statusBeforeRead = (await h.store.get('R')).status;
  held.resolve(complete);
  await Promise.all([first, close]);
  assert.equal(returnedBeforeRead, false, 'queued trailing work is not a finished read');
  assert.equal(statusBeforeRead, 'completed', 'close must not commit result_unavailable while reading');
  const result = await h.store.get('R');
  assert.equal(result.status, 'completed');
  assert.equal(result.resultComplete, true);
  assert.equal(result.resultUserUuid, 'user-A');
  assert.equal(result.resultErrorCode, null);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].prompt, /completed/);
});

for (const withChild of [false, true]) {
  test(`audit #6: exact A completes independently of busy B, child=${withChild}`, async t => {
    const h = await fixture(t);
    if (withChild) await h.child();
    await h.context.reconcileOrchestrationRun('R');
    let result = await h.store.get('R');
    assert.equal(result.status, withChild ? 'waiting_descendants' : 'completed');
    assert.ok(result.ownCompletedAt);
    assert.equal(h.notifications.length, withChild ? 0 : 1);
    const ownCompletedAt = result.ownCompletedAt;
    await h.context.reconcileOrchestrationRun('R');
    result = await h.store.get('R');
    assert.equal(result.status, withChild ? 'waiting_descendants' : 'completed');
    assert.equal(result.ownCompletedAt, ownCompletedAt);
    assert.equal(h.notifications.length, withChild ? 0 : 1);
  });
}

test('audit #4: observe cannot classify success, abort, empty final, error or contradiction as terminal', () => {
  for (const candidate of [complete, ...failures, { found: false, proofDefinitive: true }]) {
    assert.equal(proof.classifyOrchestrationResultProbe({ ...candidate, sourceVerified: false },
      { authoritativeCompletion: true }).kind, 'pending');
  }
});

test('audit #4: ordinary reconciliation promotes a successful observation before completing', async t => {
  const h = await fixture(t, { read: async request => ({ ...complete,
    sourceVerified: request.resultReadMode !== 'observe' }) });
  await h.context.reconcileOrchestrationRun('R');
  assert.deepEqual(h.requests.map(request => request.resultReadMode),
    ['observe', 'authoritative', 'authoritative']);
  assert.equal((await h.store.get('R')).resultComplete, true);
  assert.equal(h.notifications.length, 1);
});

test('audit #4: waiting descendants observes every append without repeatedly authorizing A', async t => {
  const h = await fixture(t, { read: async request => ({ ...complete,
    sourceVerified: request.resultReadMode !== 'observe' }) });
  await h.child();
  await h.finish();
  const before = structuredClone(await h.store.getInternal('R'));
  for (let i = 0; i < 1000; i++) await h.context.reconcileOrchestrationRun('R', 'target-transcript-changed');
  assert.equal(h.requests.length, 1000, 'waiting descendants must keep observing the live index');
  assert.ok(h.requests.every(request => request.resultReadMode === 'observe'));
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.effects.filter(effect => effect === 'release').length, 0);
});

for (const candidate of failures) {
  test(`audit #4: waiting descendants promotes ${candidate.terminalEvent} before failure decisions`, async t => {
    const h = await fixture(t, { read: async request => ({ ...candidate,
      sourceVerified: request.resultReadMode !== 'observe' }) });
    await h.child();
    await h.finish();
    await h.context.reconcileOrchestrationRun('R');
    assert.deepEqual(h.requests.slice(0, 2).map(request => request.resultReadMode),
      ['observe', 'authoritative']);
    assert.notEqual((await h.store.get('R')).status, 'waiting_descendants');
  });
}

test('audit #4: the real store rejects unverified result completion and recovery writes', async t => {
  const h = await fixture(t);
  const before = structuredClone(await h.store.getInternal('R'));
  for (const candidate of [complete, ...failures]) {
    await h.store.reconcile('R', { resultSourceVerified: false, resultFound: true,
      resultComplete: candidate.complete, resultAvailable: true,
      resultTerminalEvent: candidate.terminalEvent, resultHasFinalResult: candidate.hasFinalResult,
      resultProviderError: candidate.terminalEvent === 'provider_error' ? { code: 'provider_error' } : null,
      busy: false, lifecycleGeneration: 'L' });
    assert.deepEqual(await h.store.getInternal('R'), before);
  }
  await h.finish();
  const pending = structuredClone(await h.store.getInternal('R'));
  await h.store.recordResultProofObservation('R', { resultSourceVerified: false,
    resultComplete: true, resultProofStatus: 'complete' });
  assert.deepEqual(await h.store.getInternal('R'), pending);
  await h.store.markResultProofTerminalFailure('R', 'unverified abort', { resultSourceVerified: false });
  assert.deepEqual(await h.store.getInternal('R'), pending);
  await h.store.markResultProofUnavailable('R', 'unverified contradiction', { resultSourceVerified: false });
  assert.deepEqual(await h.store.getInternal('R'), pending);
  await h.store.beginResultProofRecovery('R', 'unverified candidate', { resultSourceVerified: false });
  assert.deepEqual(await h.store.getInternal('R'), pending);
});

test('audit #3: close awaits a held trailing read after the first read/arm/reread stayed pending', { timeout: 5000 }, async t => {
  const entered = deferred(), firstResult = deferred(), trailingEntered = deferred(), trailingResult = deferred();
  t.after(() => { firstResult.resolve(complete); trailingResult.resolve(complete); });
  const pending = { found: true, complete: false, sourceVerified: false };
  const h = await fixture(t, { read: async (_, n) => {
    if (n === 1) { entered.resolve(); return firstResult.promise; }
    if (n === 2) return pending;
    trailingEntered.resolve();
    return trailingResult.promise;
  } });
  await h.finish();
  const flight = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  await entered.promise;
  let closed = false;
  const close = h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true })
    .then(() => { closed = true; });
  await new Promise(setImmediate);
  firstResult.resolve(pending);
  await trailingEntered.promise;
  assert.equal(closed, false);
  const before = await h.store.get('R');
  assert.equal(before.status, 'completed');
  assert.equal(before.resultComplete, false);
  assert.equal(before.resultProofStatus, 'awaiting-transcript');
  assert.ok(before.resultProofDeadlineAt, 'pending materialization keeps its deadline');
  assert.equal(h.effects.filter(effect => effect === 'arm').length, 1);
  assert.equal(h.effects.filter(effect => effect === 'release').length, 0);
  trailingResult.resolve(complete);
  await Promise.all([flight, close]);
  assert.equal((await h.store.get('R')).resultComplete, true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(request => request.resultReadMode === 'authoritative'));
});

test('audit #4: speculative pending fields cannot replace the stored source identity', async t => {
  const h = await fixture(t);
  await h.finish();
  await h.store.recordResultProofObservation('R', { resultSourceVerified: false,
    resultComplete: false, resultAvailable: true, resultUserUuid: 'speculative-user',
    resultSourceIdentity: { sessionId: 'foreign' }, sessionId: 'foreign',
    resultProofStatus: 'awaiting-transcript', resultProofDeadlineAt: Date.now() + 1000,
    autoStopAt: Date.now(), autoStopStatus: 'scheduled' });
  const result = await h.store.getInternal('R');
  assert.equal(result.sessionId, 'S');
  assert.equal(result.resultAvailable, false);
  assert.equal(result.resultSourceIdentity, undefined);
  assert.equal(result.resultUserUuid, undefined);
  assert.equal(result.autoStopAt, undefined);
  assert.ok(result.resultProofDeadlineAt);
  assert.equal(Object.hasOwn(result, 'resultSourceVerified'), false);
});

test('a failed result read is explicitly unverified instead of inheriting legacy authority', async t => {
  const h = await fixture(t, { read: async () => { throw new Error('source unavailable'); } });
  const candidate = await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
  assert.equal(candidate.sourceVerified, false);
  assert.equal(candidate.found, false);
  const before = structuredClone(await h.store.getInternal('R'));
  await h.context.reconcileOrchestrationRun('R');
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.notifications.length, 0);
});

test('audit #6: Codex still waits for internal continuation and Claude retains its busy semantics', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { waitingForInternalDescendants: true,
    internalBackgroundWorkCount: 1, internalContinuationBaseline: 0 });
  await h.context.reconcileOrchestrationRun('R');
  assert.equal((await h.store.get('R')).status, 'running');
  assert.equal(h.notifications.length, 0);
  await h.store.reconcile('R', { resultFound: true, resultComplete: true, resultAvailable: true,
    resultTerminalEvent: 'task_complete', resultHasFinalResult: true, internalContinuationCount: 1,
    resultSourceVerified: true, resultExecutionContext: execution, busy: true });
  assert.equal((await h.store.get('R')).status, 'completed');
  await h.store.patch('R', { status: 'running', targetToolType: 'claude',
    targetExecutionContext: { ...execution, provider: 'claude' } });
  await h.store.reconcile('R', { resultFound: true, resultComplete: true,
    resultTerminalEvent: 'task_complete', resultHasFinalResult: true, busy: true });
  assert.equal((await h.store.get('R')).status, 'running');
});

async function prepareSourceFollowup(h, sessionId = 'source-S') {
  await h.finish();
  await h.store.recordResultProofObservation('R', { resultComplete: true, resultProofStatus: 'complete' });
  await h.store.markNotification('R', 'sent', { notificationPromptHash: 'notification-hash',
    notificationSourceSessionId: sessionId, notificationAttemptedAt: Date.now() - 50 });
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item)
    && item.name?.text === 'reconcileOrchestrationSourceFollowup');
  assert.ok(node);
  vm.runInContext(node.getText(parsed), h.context);
}

for (const verified of [true, false, undefined]) {
  test(`source-followup checks prompt authority in an open turn, sourceVerified=${verified}`, async t => {
    const h = await fixture(t, { run: { sourceToolType: 'codex' },
      sourceInfo: async () => ({ toolType: 'claude', sessionId: 'foreign-live-session', cwd: '/source/cwd' }),
      read: async () => ({ found: true, complete: false, sourceVerified: verified,
        userUuid: 'notification-user', executionContext: { ...execution,
          sessionId: 'source-S', turnId: 'source-open-turn' } }) });
    await prepareSourceFollowup(h);
    const before = structuredClone(await h.store.getInternal('R'));
    const confirmation = await h.context.reconcileOrchestrationSourceFollowup(before);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].toolType, 'codex', 'saved source provider wins over a rebound live tab');
    assert.equal(h.requests[0].sessionId, 'source-S');
    assert.equal(h.requests[0].resultReadMode, 'prompt-proof');
    assert.equal(h.requests[0].promptHash, before.notificationPromptHash);
    assert.equal(h.requests[0].requestedAt, before.notificationAttemptedAt);
    assert.equal(confirmation.confirmed, verified !== false);
    const after = await h.store.getInternal('R');
    if (verified === false) {
      assert.deepEqual(after, before);
      const direct = await h.store.confirmSourceFollowup('R', { kind: 'transcript',
        sourceTabId: 'source', notificationPromptHash: before.notificationPromptHash,
        resultSourceVerified: false });
      assert.equal(direct.confirmed, false);
      assert.deepEqual(await h.store.getInternal('R'), before);
    } else {
      assert.ok(after.sourceFollowupStartedAt, 'an open source turn already consumed the notification');
      assert.equal(after.sourceFollowupUserUuid, 'notification-user');
    }
  });
}

test('legacy source lookup supplies the candidate provider and never persists an unverified match', async t => {
  const h = await fixture(t, { sourceInfo: async () => null,
    sourceProjects: [{ id: 'project', tabs: [{ tabId: 'replacement-source', name: 'Source',
      commandType: 'codex', codexSessionId: 'legacy-source-S', cwd: '/source/cwd' }] }],
    run: { sourceProjectId: 'project', sourceTabName: 'Source' },
    read: async () => ({ found: true, complete: false, sourceVerified: false }) });
  await prepareSourceFollowup(h, null);
  const before = structuredClone(await h.store.getInternal('R'));
  const confirmation = await h.context.reconcileOrchestrationSourceFollowup(before);
  assert.equal(confirmation.confirmed, false);
  assert.equal(h.requests[0].toolType, 'codex');
  assert.equal(h.requests[0].sessionId, 'legacy-source-S');
  assert.equal(h.requests[0].resultReadMode, 'prompt-proof');
  assert.deepEqual(await h.store.getInternal('R'), before);
});

async function attachRealCodexReader(h, rows) {
  const { _api } = require('./ipc/codex-data');
  const { createCodexResultReader } = require('./codex-result-reader');
  const { createCodexResultSourceResolver } = require('./codex-result-source');
  const filePath = path.join(path.dirname(h.store.filePath), 'rollout.jsonl');
  fs.writeFileSync(filePath, rows.map(row => JSON.stringify(row) + '\n').join(''));
  const reader = createCodexResultReader({ readJsonlRange: _api.readJsonlRange,
    createTimelineProjector: _api.createCodexTimelineProjector,
    buildResult: _api.buildCodexProviderTurnAssistantResult, extractText: _api.extractTextContent,
    userIdentity: _api.getCodexUserRecordIdentity,
    isCompactPayload: _api.isCompactPayload, extractReasoning: _api.extractReasoning,
    findExecutionContext: _api.findCodexPromptExecutionContext,
    collectLegacy: _api.collectCodexTurnAssistantBlocks, log: { log() {} } });
  const resolver = createCodexResultSourceResolver({
    codexApi: { findCodexSessionFile: async () => ({ filePath }) },
  });
  const main = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const node = main.statements.find(item => ts.isFunctionDeclaration(item)
    && item.name?.text === '_getAgentTurnResultForOrchestration');
  assert.ok(node);
  const read = vm.runInNewContext('(' + node.getText(main) + ')', {
    _loadSessionTurns() { throw new Error('must not read the generic full history'); },
    codexDataModule: { _api: { loadCodexProviderResult: request => reader.load(request) } },
    transcriptService: { resolveCodexResultSource: request => resolver.resolve({
      ...request, lineage: { kind: 'physical' },
    }) },
    console: { log() {}, warn() {} },
  });
  h.context.getAgentTurnResult = async request => { h.requests.push(request); return read(request); };
  return { reader, filePath };
}

function promptRows(prompt = 'go') {
  return [
    { type: 'event_msg', timestamp: new Date().toISOString(),
      payload: { type: 'task_started', turn_id: 'A' } },
    { type: 'event_msg', timestamp: new Date().toISOString(),
      payload: { type: 'user_message', message: prompt } },
  ];
}

async function unbindHistoricalRun(h) {
  // A restored/legacy request has durable prompt/session identity, but no live
  // process generation. Never borrow the generation of busy unrelated B.
  await h.store.patch('R', { targetExecutionContext: null,
    targetContinuationExecutionContext: null, targetLifecycleGeneration: null });
}

for (const withChild of [false, true]) {
  test(`actual unbound historical T with null generation finishes independently of busy B, child=${withChild}`, async t => {
    const h = await fixture(t);
    await unbindHistoricalRun(h);
    await h.store.patch('R', { promptHash: promptFingerprint('go'), targetPromptProofUserUuid: 'codex-user-S-1' });
    if (withChild) await h.child();
    const rows = promptRows();
    rows[0].payload.turn_id = 'T';
    await attachRealCodexReader(h, [
      ...rows,
      { type: 'response_item', payload: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'answer T' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T', last_agent_message: 'answer T' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'B' } },
    ]);
    const results = [];
    const read = h.context.getAgentTurnResult;
    h.context.getAgentTurnResult = async request => {
      const result = await read(request);
      results.push(result);
      return result;
    };
    await h.context.reconcileOrchestrationRun('R');
    const finished = await h.store.get('R');
    assert.equal(finished.status, withChild ? 'waiting_descendants' : 'completed');
    assert.ok(finished.ownCompletedAt);
    assert.equal(finished.targetExecutionContext, null, 'historical proof must not invent a live binding');
    assert.equal(finished.targetLifecycleGeneration, null);
    assert.deepEqual(finished.waitingOnRunIds, withChild ? ['child'] : []);
    assert.equal(h.notifications.length, withChild ? 0 : 1);
    assert.ok(h.requests.every(request => request.targetExecutionContext === undefined));
    const verified = results.find(result => result.sourceVerified === true);
    assert.ok(verified, 'ordinary observation promotes the exact historical terminal before settlement');
    assert.equal(verified.executionContext.provider, 'codex');
    assert.equal(verified.executionContext.sessionId, 'S');
    assert.equal(verified.executionContext.turnId, 'T');
    assert.equal(verified.executionContext.generation, null);
    await h.context.reconcileOrchestrationRun('R');
    assert.equal((await h.store.get('R')).status, finished.status);
    assert.equal((await h.store.get('R')).ownCompletedAt, finished.ownCompletedAt);
    assert.equal(h.notifications.length, withChild ? 0 : 1);
  });
}

for (const generation of [null, 2]) {
  test(`known execution remains strict when the result generation is ${generation}`, async t => {
    const h = await fixture(t, { read: async () => ({ ...complete,
      executionContext: { ...execution, generation } }) });
    await h.context.reconcileOrchestrationRun('R');
    const result = await h.store.get('R');
    assert.equal(result.status, 'running');
    assert.equal(result.ownCompletedAt, null);
    assert.equal(result.targetExecutionContext.generation, 1);
    assert.equal(h.notifications.length, 0);
  });
}

for (const outcome of ['failed', 'interrupted', 'startup_failed']) {
  test(`unbound historical final cannot override explicit ${outcome} recovery`, async t => {
    const h = await fixture(t, { read: async () => ({ ...complete,
      executionContext: { provider: 'codex', sessionId: 'S', turnId: 'T', generation: null } }) });
    await unbindHistoricalRun(h);
    await h.store.beginRecovery('R', outcome, `canonical ${outcome} decision`);
    const before = structuredClone(await h.store.getInternal('R'));
    await h.context.reconcileOrchestrationRun('R', 'recovery-check', { resultReadMode: 'authoritative' });
    assert.deepEqual(await h.store.getInternal('R'), before);
    assert.equal(h.notifications.length, 0);
  });
}

for (const withChild of [false, true]) {
  test(`unbound historical final keeps the internal continuation gate, child=${withChild}`, async t => {
    let internalContinuationCount = 2;
    const h = await fixture(t, { read: async request => ({ ...complete,
      executionContext: { provider: 'codex', sessionId: 'S', turnId: 'T', generation: null },
      internalContinuationCount, sourceVerified: request.resultReadMode !== 'observe' }) });
    await unbindHistoricalRun(h);
    if (withChild) await h.child();
    await h.store.patch('R', { waitingForInternalDescendants: true,
      internalContinuationBaseline: 2, internalContinuationCountSeen: 2, internalBackgroundWorkCount: 1 });
    const before = structuredClone(await h.store.getInternal('R'));
    await h.context.reconcileOrchestrationRun('R');
    assert.deepEqual(await h.store.getInternal('R'), before, 'the old final cannot consume pending internal work');
    assert.equal(h.notifications.length, 0);
    internalContinuationCount++;
    await h.context.reconcileOrchestrationRun('R');
    const result = await h.store.get('R');
    assert.equal(result.status, withChild ? 'waiting_descendants' : 'completed');
    assert.equal(result.waitingForInternalDescendants, false);
    assert.equal(result.internalContinuationCountSeen, 3);
    assert.equal(h.notifications.length, withChild ? 0 : 1);
  });
}

test('actual web/main/reader/store: foreign appends add zero SHA bytes while A waits for its child', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { promptHash: promptFingerprint('go'), targetPromptProofUserUuid: 'codex-user-S-1' });
  await h.child({ notifySource: false });
  const { reader, filePath } = await attachRealCodexReader(h, [
    ...promptRows(),
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'answer A' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'A', last_agent_message: 'answer A' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'B' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-B', output: 'x'.repeat(1024 * 1024) } },
  ]);
  await h.context.reconcileOrchestrationRun('R');
  assert.equal((await h.store.get('R')).status, 'waiting_descendants');
  const before = reader.stats();
  assert.ok(before.verificationBytes >= 1024 * 1024, 'the first own completion was authoritative');
  h.requests.length = 0;
  for (let i = 0; i < 64; i++) {
    await fs.promises.appendFile(filePath, JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: `tool-B-${i}`, output: 'next B output',
    } }) + '\n');
    await h.context.reconcileOrchestrationRun('R', 'target-transcript-changed');
  }
  assert.equal(reader.stats().verificationBytes, before.verificationBytes);
  assert.equal(h.requests.length, 64);
  assert.ok(h.requests.every(request => request.resultReadMode === 'observe'));
  assert.equal(h.effects.filter(effect => effect === 'release').length, 0);
  assert.equal(h.notifications.length, 0);

  const released = await h.store.cancel('child');
  await h.context.finalizeSettledOrchestrations(released.settled, 'child-gate-released');
  assert.equal((await h.store.get('R')).resultComplete, true);
  assert.ok(reader.stats().verificationBytes > before.verificationBytes,
    'actual settlement revalidates the grown source');
  assert.equal(h.notifications.length, 1);
});

test('actual source-followup/main/reader confirms an open Codex turn with verified prompt identity', async t => {
  const h = await fixture(t, { run: { sourceToolType: 'codex' } });
  await prepareSourceFollowup(h);
  await h.store.patch('R', { notificationPromptHash: promptFingerprint('go') });
  const { reader } = await attachRealCodexReader(h, [
    ...promptRows(),
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Processing the notification' }] } },
  ]);
  const confirmed = await h.context.reconcileOrchestrationSourceFollowup(await h.store.getInternal('R'));
  assert.equal(confirmed.confirmed, true, confirmed.reason);
  assert.ok((await h.store.get('R')).sourceFollowupStartedAt);
  assert.ok(reader.stats().verificationBytes > 0);
  assert.equal(h.requests[0].toolType, 'codex');
  assert.equal(h.requests[0].resultReadMode, 'prompt-proof');
});

test('an authoritative promotion for A cannot commit after Resume binds B', async t => {
  const entered = deferred(), authorized = deferred();
  t.after(() => authorized.resolve(complete));
  const h = await fixture(t, { read: async request => {
    if (request.resultReadMode === 'observe') return { ...complete, sourceVerified: false };
    entered.resolve();
    return authorized.promise;
  } });
  const reconcile = h.context.reconcileOrchestrationRun('R');
  await entered.promise;
  await h.store.pause('R');
  await h.store.resolveRecovery('R', 'resume');
  const resuming = await h.store.getInternal('R');
  await h.store.applyLifecycle('target', { type: 'busy', busy: true, sessionId: 'S',
    lifecycleGeneration: 'L', executionContext: { ...execution, turnId: 'B', generation: 2,
      startedAt: resuming.resumeAfterAt + 1 } });
  const before = structuredClone(await h.store.getInternal('R'));
  authorized.resolve(complete);
  await reconcile;
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.targetExecutionContext.turnId === 'A'));
});

async function getResult(h) {
  const handler = parsed.statements.find(item => ts.isFunctionDeclaration(item)
    && item.name?.text === 'handleApi');
  assert.ok(handler);
  Object.assign(h.context, {
    checkAuth: () => true, decId: decodeURIComponent,
    withOrchestrationUrls: current => current,
    buildDelegationResultTarget,
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
  });
  vm.runInContext(handler.getText(parsed), h.context);
  const response = {};
  await h.context.handleApi({ method: 'GET' }, response,
    { pathname: '/api/orchestrations/R/result', query: {} }, {});
  return response;
}

for (const verified of [true, false]) {
  test(`actual GET uses source-proof and only serves verified success, verified=${verified}`, async t => {
    const h = await fixture(t, { read: async () => ({ ...complete, sourceVerified: verified }) });
    const response = await getResult(h);
    assert.equal(response.status, verified ? 200 : 202);
    assert.equal(response.body.ready, verified);
    assert.equal(h.requests[0].resultReadMode, 'source-proof');
    assert.equal(h.requests.at(-1).resultReadMode, 'source-proof');
    if (verified) assert.equal(response.body.assistantText, 'answer A');
    else assert.equal(h.notifications.length, 0);
    assert.equal(runs.isCompleteOrchestrationResult({ found: true,
      resultComplete: true, sourceVerified: verified }), verified);
  });
}

for (const action of ['close', 'GET']) {
  test(`actual ${action} recovers a final inserted into the warm missing-turn prefix by rewrite+growth`, async t => {
    const h = await fixture(t);
    await h.store.patch('R', { promptHash: promptFingerprint('go'), targetPromptProofUserUuid: 'codex-user-S-1' });
    const rows = promptRows();
    rows[0].payload.turn_id = 'U';
    const { reader, filePath } = await attachRealCodexReader(h, [
      ...rows,
      { type: 'response_item', payload: { type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'recovered answer A' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'U', last_agent_message: 'recovered answer A' } },
    ]);
    if (action === 'close') await h.finish();
    const warm = await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
    assert.equal(warm.found, false);
    assert.equal(warm.errorCode, 'task_started_not_found');
    const verificationBefore = reader.stats().verificationBytes;
    const oldPrefix = await fs.promises.readFile(filePath, 'utf8');
    const newPrefix = oldPrefix.replaceAll('"turn_id":"U"', '"turn_id":"A"');
    assert.equal(Buffer.byteLength(newPrefix), Buffer.byteLength(oldPrefix));
    await fs.promises.writeFile(filePath, newPrefix + JSON.stringify({ type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'unrelated', output: 'append' } }) + '\n');
    h.requests.length = 0;
    let unavailableCalls = 0;
    const unavailable = h.store.markResultProofUnavailable.bind(h.store);
    h.store.markResultProofUnavailable = (...args) => { unavailableCalls++; return unavailable(...args); };
    if (action === 'close') {
      await h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true });
    } else {
      const response = await getResult(h);
      assert.equal(response.status, 200);
      assert.equal(response.body.assistantText, 'recovered answer A');
      assert.equal(response.body.success, true);
    }
    const result = await h.store.get('R');
    assert.equal(result.status, 'completed');
    assert.equal(result.resultComplete, true);
    assert.equal(unavailableCalls, 0);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].prompt, /completed/);
    assert.ok(reader.stats().verificationBytes > verificationBefore);
    assert.ok(h.requests.some(request => request.resultReadMode === 'source-proof'));
  });
}

test('failed result GET validates the source before returning a rewritten partial answer', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { promptHash: promptFingerprint('go'), targetPromptProofUserUuid: 'codex-user-S-1' });
  const { reader, filePath } = await attachRealCodexReader(h, [
    ...promptRows(),
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'old partial answer' }] } },
  ]);
  await h.store.beginRecovery('R', 'failed', 'known execution failure', { failureGraceMs: 0 });
  const warm = await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
  assert.equal(warm.found, true);
  assert.equal(warm.resultComplete, false);
  const verificationBefore = reader.stats().verificationBytes;
  const prefix = await fs.promises.readFile(filePath, 'utf8');
  await fs.promises.writeFile(filePath, prefix.replace('old partial answer', 'new partial answer')
    + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output',
      call_id: 'unrelated', output: 'append' } }) + '\n');
  h.requests.length = 0;
  const response = await getResult(h);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error, 'known execution failure');
  assert.equal(response.body.assistantText, 'new partial answer');
  assert.ok(reader.stats().verificationBytes > verificationBefore);
  assert.equal(h.requests.at(-1).resultReadMode, 'source-proof');
});

test('failed GET does not expose partial text or coordinates when source verification fails', async t => {
  const h = await fixture(t, { read: async () => ({ ...complete, sourceVerified: false }) });
  await h.store.beginRecovery('R', 'failed', 'known execution failure', { failureGraceMs: 0 });
  const response = await getResult(h);
  assert.equal(response.status, 200);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error, 'known execution failure');
  assert.equal(response.body.assistantText, '');
  assert.equal(response.body.assistantChars, 0);
  assert.equal(response.body.userUuid, null);
  assert.equal(response.body.turnIndex, null);
});

test('close preserves explicit result_unavailable when the transcript file disappeared', async t => {
  const h = await fixture(t);
  const { filePath } = await attachRealCodexReader(h, promptRows());
  await h.finish();
  await fs.promises.unlink(filePath);
  await h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true });
  const result = await h.store.get('R');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'result_unavailable');
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].prompt, /failed/);
  assert.ok(h.requests.some(request => request.resultReadMode === 'source-proof'));
});

test('close source-proof uses the original attempt and cannot finish a resumed execution', { timeout: 5000 }, async t => {
  const entered = deferred(), held = deferred();
  t.after(() => held.resolve(complete));
  const h = await fixture(t, { read: async request => {
    if (request.resultReadMode === 'source-proof') { entered.resolve(); return held.promise; }
    return { found: false, complete: false, sourceVerified: false };
  } });
  await h.finish();
  const closing = h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true });
  await entered.promise;
  await h.store.pause('R');
  await h.store.resolveRecovery('R', 'resume');
  const resuming = await h.store.getInternal('R');
  await h.store.applyLifecycle('target', { type: 'busy', busy: true, sessionId: 'S',
    lifecycleGeneration: 'L', executionContext: { ...execution, turnId: 'B', generation: 2,
      startedAt: resuming.resumeAfterAt + 1 } });
  const before = structuredClone(await h.store.getInternal('R'));
  held.resolve(complete);
  await closing;
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.notifications.length, 0);
  assert.ok(h.requests.every(request => request.targetExecutionContext.turnId === 'A'));
});

test('a terminal abort discovered by close source-proof keeps the exact interrupted outcome', async t => {
  const h = await fixture(t);
  await h.store.patch('R', { promptHash: promptFingerprint('go'), targetPromptProofUserUuid: 'codex-user-S-1' });
  const rows = promptRows();
  rows[0].payload.turn_id = 'U';
  const { filePath } = await attachRealCodexReader(h, [
    ...rows,
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'U' } },
  ]);
  await h.finish();
  const warm = await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
  assert.equal(warm.found, false);
  const prefix = await fs.promises.readFile(filePath, 'utf8');
  await fs.promises.writeFile(filePath, prefix.replaceAll('"turn_id":"U"', '"turn_id":"A"')
    + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output',
      call_id: 'unrelated', output: 'append' } }) + '\n');
  await h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true });
  const result = await h.store.get('R');
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.resultErrorCode, 'turn_aborted');
  assert.equal(h.notifications.length, 1);
});
