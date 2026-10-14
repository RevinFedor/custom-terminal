'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { OrchestrationRunStore, buildOrchestrationResultLookup } = require('./orchestration-runs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const registry = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { createOrchestrationContinuationService, continuationReceiptProof, continuationRunIdFromAudit } = require('./orchestration-continuation');

const oldContext = { provider: 'codex', sessionId: 'B', turnId: 'old-turn', processId: '11', generation: 1, startedAt: 100 };
const nextContext = { ...oldContext, turnId: 'new-turn', processId: '12', generation: 2, startedAt: 1001 };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-continue-'));
  const file = path.join(dir, 'runs.json'), database = path.join(dir, 'receipts.sqlite');
  let db = new Database(database), receipts = createAgentSendReceiptStore(db, { now: () => 2000, settledRetentionMs: 10 });
  let store = new OrchestrationRunStore(file);
  await store.create({ runId: 'R', sourceTabId: 'A', targetTabId: 'B', targetToolType: 'codex', sourceToolType: 'codex',
    sourceSendTarget: { toolType: 'codex', sessionId: 'A' }, promptHash: 'original-hash', targetPromptAuditHash: 'original-audit',
    targetExecutionContext: oldContext, targetCwd: dir, ...extra });
  await store.markDelivery('R', { sessionId: 'B', lifecycleGeneration: 'L-old' });
  await store.patch('R', { targetPromptProofAt: 100, targetPromptProofUserUuid: 'original-user', status: 'running', targetBusySeen: true });
  await store.beginRecovery('R', 'interrupted', 'turn_aborted', { failureGraceMs: 999999999 });
  await store.persistStrict();
  const states = new Map([['A', { known: true, exists: true, toolType: 'codex', sessionId: 'A', busy: false, processStatus: 'found', revision: 'A1', cwd: dir }],
    ['B', { known: true, exists: true, toolType: 'codex', sessionId: 'B', busy: false, processStatus: 'absent', revision: 'B1', cwd: dir }]]);
  const calls = { sends: [], reconciles: [], delivered: [], originals: 0, latest: 0, replacements: [] };
  let resultKind = 'confirmed', original = { found: true, sourceVerified: true, complete: false, userUuid: 'original-user', executionContext: oldContext };
  let latest = { subject: { kind: 'codex-historical-execution', targetExecutionContext: oldContext }, result: { sourceVerified: true } };
  let beforeSend = null, sendOverride = null, originalOverride = null, replacementOverride = null, resumeOverride = null, readStateOverride = null;
  function commit(request, context = nextContext, more = {}) {
    const identity = { operationKey: request.sendOperationKey, tabId: 'B', handoffId: request.handoffId,
      surface: 'desktop-history', requestFingerprint: crypto.createHash('sha256').update(JSON.stringify([request.prompt, request.expectedTarget])).digest('hex'),
      provider: 'codex', sessionId: 'B', promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
    const attempt = receipts.beginAttempt(identity);
    if (attempt.action !== 'attempt-started') return { identity, attempt };
    receipts.markAttemptState(identity.operationKey, attempt.attemptId, 'enter-armed');
    receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true });
    if (resultKind === 'confirmed') receipts.promoteFromAudit({ success: true, ...identity, attemptId: attempt.attemptId,
      provider: 'codex', sessionId: context.sessionId, actualHash: identity.promptHash, expectedHash: identity.promptHash,
      entryUuid: 'continue-user-' + request.handoffId, sourceIdentity: 'continue-source-' + request.handoffId,
      executionContext: context, auditTimestamp: new Date(context.startedAt).toISOString(), queuedAtSubmit: false, ...more });
    return { identity, attempt };
  }
  const makeService = () => createOrchestrationContinuationService({ store, receipts, now: () => 1000,
    readState: async id => readStateOverride ? readStateOverride(id) : ({ ...states.get(id) }), readInfo: async () => ({ sessionId: 'B', lifecycleGeneration: 'L-new' }),
    readOriginal: async (...args) => { calls.originals++; return originalOverride ? originalOverride(...args) : original; }, readLatest: async () => { calls.latest++; return latest; },
    reconcile: async id => { calls.reconciles.push(id); }, deliver: async id => { calls.delivered.push(id); },
    createReplacement: async plan => { calls.replacements.push(plan); return replacementOverride ? replacementOverride(plan) : { ok: true, replacementRunId: plan.runId }; },
    resumeReplacement: async id => resumeOverride ? resumeOverride(id) : store.get(id),
    send: async request => {
      calls.sends.push(request);
      if (sendOverride) return sendOverride(request);
      if (beforeSend) await beforeSend(request);
      await request.prepareSend();
      if (resultKind === 'not-submitted') {
        const identity = { operationKey: request.sendOperationKey, tabId: 'B', handoffId: request.handoffId, surface: 'desktop-history',
          requestFingerprint: 'no-submit', provider: 'codex', sessionId: 'B', promptHash: promptAuditFingerprint('continue'), promptLength: 8 };
        const attempt = receipts.beginAttempt(identity);
        receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: false, enterWritten: false, success: false, status: 'not-submitted' });
        return { success: false, submitted: false, error: 'not ready' };
      }
      commit(request);
      return { submitted: true, deliveryUnknown: resultKind === 'unknown' };
    },
  });
  let service = makeService();
  t.after(async () => { await store.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, get receipts() { return receipts; }, get service() { return service; }, states, calls, dir, commit,
    setOriginal: value => { original = value; }, setLatest: value => { latest = value; },
    setResult: value => { resultKind = value; }, setBeforeSend: value => { beforeSend = value; },
    setSendOverride: value => { sendOverride = value; },
    setOriginalOverride: value => { originalOverride = value; },
    setReadStateOverride: value => { readStateOverride = value; },
    setReplacementOverrides: (create, resume) => { replacementOverride = create; resumeOverride = resume; },
    reopen: async () => { await store.flush(); db.close(); db = new Database(database); receipts = createAgentSendReceiptStore(db, { now: () => 2000, settledRetentionMs: 10 });
      store = new OrchestrationRunStore(file); await store.initialize(); service = makeService(); }, file };
}

test('one accepted continue binds the exact new answer without changing original request identity', async t => {
  const h = await fixture(t);
  const before = structuredClone(await h.store.getInternal('R'));
  const result = await h.service.continueRequest('R');
  assert.equal(result.resumed, true, JSON.stringify({ result, intent: (await h.store.getInternal('R')).continuationIntent,
    receipt: h.receipts.list()[0]?.receipt }));
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].prompt, 'continue');
  assert.deepEqual(h.calls.sends[0].expectedTarget, { toolType: 'codex', sessionId: 'B' });
  const after = await h.store.getInternal('R');
  assert.equal(after.promptHash, before.promptHash);
  assert.equal(after.sourceTabId, before.sourceTabId);
  assert.equal(after.targetPromptProofUserUuid, 'original-user');
  assert.equal(after.targetExecutionContext.turnId, 'new-turn');
  assert.equal(buildOrchestrationResultLookup(after).promptUserUuid, 'continue-user-' + after.continuationIntent.handoffId);
  const saved = JSON.parse(fs.readFileSync(h.file, 'utf8')).runs.find(r => r.runId === 'R');
  assert.equal(saved.continuationIntent.state, 'bound');
  assert.equal(saved.status, 'running');
});

test('concurrent and subsequent clicks cannot submit two continues', async t => {
  const h = await fixture(t), held = defer(), entered = defer();
  h.setBeforeSend(async () => { entered.resolve(); await held.promise; });
  const first = h.service.continueRequest('R'); await entered.promise;
  const second = h.service.continueRequest('R');
  assert.equal(first, second);
  held.resolve(); await first;
  assert.equal((await h.service.continueRequest('R')).alreadyActive, true);
  assert.equal(h.calls.sends.length, 1);
});

for (const party of ['A', 'B']) test(`changed ${party} history refuses input and offers a new request`, async t => {
  const h = await fixture(t); h.states.get(party).sessionId = 'different';
  const result = await h.service.continueRequest('R');
  assert.equal(result.ok, false); assert.equal(result.canCreateNewRequest, true); assert.equal(h.calls.sends.length, 0);
});

test('unknown runtime never means stopped', async t => {
  const h = await fixture(t); Object.assign(h.states.get('B'), { busy: null, processStatus: 'unknown' });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_runtime_unknown');
  assert.equal(h.calls.sends.length, 0);
});

test('restored ready Codex without a new completed turn can accept the authorized continuation', async t => {
  const h = await fixture(t);
  Object.assign(h.states.get('B'), {
    busy: null, transitioning: false, processStatus: 'found', inputReady: true, status: 'active',
    writerUsableForMutation: true, error: 'response_busy_unknown',
  });
  const { createContinuationInputReader } = require('./orchestration-continuation-input');
  h.setReadStateOverride(createContinuationInputReader({
    readResponseState: async id => ({ ...h.states.get(id) }),
    readRuntimeSnapshot: async id => ({ coherent: true, toolType: 'codex', processStatus: 'found',
      status: 'active', inputReady: true, busy: false, lifecycleGeneration: 'L-' + id,
      sendTarget: { toolType: 'codex', sessionId: id, terminalInstanceId: 'instance-' + id, launchId: 'launch-' + id } }),
  }));
  const result = await h.service.continueRequest('R');
  assert.equal(result.resumed, true, JSON.stringify(result));
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.calls.sends[0].expectedTarget.launchId, 'launch-B');
});

test('ready original result is delivered, not executed again', async t => {
  const h = await fixture(t); h.setOriginal({ found: true, sourceVerified: true, complete: true, terminalEvent: 'task_complete',
    executionContext: oldContext, userUuid: 'original-user' });
  assert.equal((await h.service.continueRequest('R')).resultReady, true);
  assert.equal((await h.store.get('R')).status, 'completed');
  assert.deepEqual(h.calls.delivered, ['R']); assert.equal(h.calls.sends.length, 0);
});

test('an already active exact original execution reattaches without input', async t => {
  const h = await fixture(t); Object.assign(h.states.get('B'), { busy: true, processStatus: 'found', executionContext: oldContext });
  assert.equal((await h.service.continueRequest('R')).alreadyActive, true);
  assert.equal(h.calls.sends.length, 0);
});

test('another busy execution and another latest idle turn do not receive a generic continue', async t => {
  const h = await fixture(t); Object.assign(h.states.get('B'), { busy: true, processStatus: 'found', executionContext: nextContext });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_target_busy');
  h.states.get('B').busy = false;
  h.setLatest({ subject: { targetExecutionContext: nextContext }, result: { sourceVerified: true } });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_history_changed');
  assert.equal(h.calls.sends.length, 0);
});

for (const goal of ['active', 'attention']) test(`Goal ${goal} retains the existing work gate`, async t => {
  const h = await fixture(t); h.states.get('B').goalWork = { status: goal };
  h.setOriginal({ found: true, sourceVerified: true, complete: true, terminalEvent: 'task_complete' });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_background_work');
  assert.equal(h.calls.sends.length, 0); assert.equal(h.calls.delivered.length, 0);
});

test('deleted original prompt, cancelled run, paused link and external research never start an executor', async t => {
  for (const kind of ['deleted', 'cancelled', 'paused', 'external']) {
    const h = await fixture(t);
    if (kind === 'deleted') h.setOriginal({ found: false, sourceVerified: true });
    if (kind === 'cancelled') await h.store.cancel('R');
    if (kind === 'paused') await h.store.patch('R', { outcome: 'paused' });
    if (kind === 'external') await h.store.patch('R', { runKind: 'external-research' });
    assert.equal((await h.service.continueRequest('R')).ok, false, kind); assert.equal(h.calls.sends.length, 0, kind);
  }
});

test('source change after claim is caught by the common preparation hook', async t => {
  const h = await fixture(t); h.setBeforeSend(async () => { h.states.get('A').sessionId = 'changed'; });
  assert.equal((await h.service.continueRequest('R')).ok, false);
  assert.equal(h.receipts.list().length, 0);
});

test('cancellation during preparation cannot be resurrected by a late canonical audit', async t => {
  const h = await fixture(t), held = defer(), entered = defer();
  h.setBeforeSend(async () => { entered.resolve(); await held.promise; });
  const work = h.service.continueRequest('R'); await entered.promise;
  const run = await h.store.getInternal('R'), intent = run.continuationIntent;
  h.receipts.cancelDelivery({ operationKey: intent.operationKey, tabId: 'B', handoffId: intent.handoffId, provider: 'codex', allowUnreserved: true });
  await h.store.cancel('R'); held.resolve(); await work;
  assert.equal((await h.store.get('R')).status, 'cancelled');
  assert.equal((await h.service.reconcile('R')).confirmed, false);
});

test('unknown delivery survives reopen, stays pinned, and never permits another Enter', async t => {
  const h = await fixture(t); h.setResult('unknown');
  assert.equal((await h.service.continueRequest('R')).pending, true);
  await h.reopen();
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_delivery_unknown');
  assert.equal(h.calls.sends.length, 1);
  assert.equal(h.receipts.listOwnerPins('orchestration-continuation').length, 1);
});

test('receipt commit with lost run projection restores the same operation without Send', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  const request = h.calls.sends[0], record = h.receipts.get(request.sendOperationKey);
  h.receipts.promoteFromAudit({ success: true, operationKey: record.operationKey, attemptId: record.attemptId, provider: 'codex', sessionId: 'B',
    promptHash: record.promptHash, expectedHash: record.promptHash, actualHash: record.promptHash, entryUuid: 'recovered', sourceIdentity: 'recovered-source', executionContext: nextContext });
  await h.reopen();
  assert.equal((await h.service.reconcile('R')).confirmed, true);
  assert.equal((await h.store.get('R')).status, 'running'); assert.equal(h.calls.sends.length, 1);
  assert.equal(h.receipts.listOwnerPins('orchestration-continuation').length, 0);
});

test('strict checkpoint failure prevents input', async t => {
  const h = await fixture(t); h.store.persistStrict = async () => { throw new Error('disk failure'); };
  await assert.rejects(h.service.continueRequest('R'), /disk failure/); assert.equal(h.calls.sends.length, 0);
});

test('the expected new handoff rejects a foreign receipt and the old execution context', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  const run = await h.store.getInternal('R'), record = h.receipts.get(run.continuationIntent.operationKey);
  assert.equal(continuationReceiptProof(run, { ...record, state: 'confirmed', handoffId: 'other' }), null);
  assert.equal((await h.store.confirmRequestContinuation('R', { handoffId: run.continuationIntent.handoffId,
    operationKey: record.operationKey, sessionId: 'B', executionContext: oldContext })).confirmed, false);
  assert.equal(continuationRunIdFromAudit({ source: 'codex-orchestration-continue:R' }), 'R');
  assert.equal(continuationRunIdFromAudit({ source: 'orchestration-completion:R' }), null);
});

test('generic task_started cannot adopt a pending explicit continuation', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  await h.store.applyLifecycle('B', { type: 'busy', busy: true, toolType: 'codex', sessionId: 'B', executionContext: nextContext, lifecycleGeneration: 'L-new' });
  assert.equal((await h.store.get('R')).status, 'waiting_recovery');
});

test('Pause during preparation remains paused after canonical delivery; Resume never adopts the earlier turn', async t => {
  const h = await fixture(t), held = defer(), entered = defer();
  h.setBeforeSend(async () => { entered.resolve(); await held.promise; });
  const work = h.service.continueRequest('R'); await entered.promise;
  await h.store.pause('R'); held.resolve();
  assert.equal((await work).paused, true);
  const paused = await h.store.get('R');
  assert.equal(paused.outcome, 'paused'); assert.equal(paused.continuation.state, 'delivered-paused');
  const resumed = await h.store.resolveRecovery('R', 'resume', { sessionId: 'B', lifecycleGeneration: 'L-new' });
  assert.equal(resumed.run.resumeAwaitingNewTurn, true);
  await h.service.reconcile('R');
  assert.equal((await h.store.get('R')).resumeAwaitingNewTurn, true);
  const current = await h.store.getInternal('R');
  const afterResume = { ...nextContext, turnId: 'after-pause-resume', startedAt: current.resumeAfterAt + 1 };
  await h.store.applyLifecycle('B', { type: 'busy', busy: true, sessionId: 'B', toolType: 'codex',
    lifecycleGeneration: 'L-new', executionContext: afterResume });
  assert.equal((await h.store.get('R')).targetExecutionContext.turnId, afterResume.turnId);
  assert.equal(h.calls.sends.length, 1);
});

test('queue preparation rechecks the latest question, not merely the unchanged session ID', async t => {
  const h = await fixture(t);
  h.setBeforeSend(async () => { h.setLatest({ subject: { targetExecutionContext: nextContext }, result: { sourceVerified: true } }); });
  assert.equal((await h.service.continueRequest('R')).ok, false);
  assert.equal(h.receipts.list().length, 0);
});

test('an explicit replacement uses frozen original text and a stable new identity', async t => {
  const h = await fixture(t);
  const identity = { operationKey: 'orchestration-target:R', surface: 'orchestration', runId: 'R', tabId: 'B', handoffId: 'orchestration:R',
    provider: 'codex', sessionId: 'B', requestFingerprint: 'original', promptHash: 'original-audit', promptLength: 13 };
  h.receipts.reserveOrGet(identity); const attempt = h.receipts.beginAttempt(identity);
  h.receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { promptText: 'original task' });
  const first = await h.service.newRequest('R'), second = await h.service.newRequest('R');
  assert.equal(first.replacementRunId, second.replacementRunId);
  assert.equal(h.calls.replacements[0].prompt, 'original task');
  assert.notEqual(first.replacementRunId, 'R');
});

test('a ready result cannot settle after Goal starts during the result read', async t => {
  const h = await fixture(t);
  h.setOriginalOverride(async () => {
    Object.assign(h.states.get('B'), { revision: 'B2', goalWork: { status: 'active' } });
    return { found: true, sourceVerified: true, complete: true, terminalEvent: 'task_complete', executionContext: oldContext };
  });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_state_changed');
  assert.equal((await h.store.get('R')).status, 'waiting_recovery'); assert.equal(h.calls.sends.length, 0);
});

test('historical same-turn context gains the exact live PID/generation and then accepts its live done', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  const request = h.calls.sends[0], record = h.receipts.get(request.sendOperationKey);
  h.receipts.promoteFromAudit({ success: true, operationKey: record.operationKey, attemptId: record.attemptId, provider: 'codex', sessionId: 'B',
    promptHash: record.promptHash, expectedHash: record.promptHash, actualHash: record.promptHash, entryUuid: 'historical', sourceIdentity: 'hist-source',
    executionContext: { ...nextContext, generation: null, processId: null } });
  assert.equal((await h.service.reconcile('R')).confirmed, true);
  assert.equal((await h.store.get('R')).targetExecutionContext.processId, null);
  Object.assign(h.states.get('B'), { processStatus: 'found', busy: true, executionContext: nextContext, revision: 'B2' });
  assert.equal((await h.service.reconcile('R')).confirmed, true);
  assert.equal((await h.store.get('R')).targetExecutionContext.processId, '12');
  const done = await h.store.applyLifecycle('B', { type: 'done', reason: 'task_complete', sessionId: 'B', toolType: 'codex',
    lifecycleGeneration: 'L-new', executionContext: nextContext });
  assert.equal(done.settled[0]?.runId, 'R');
});

test('continued registry releases only its own stale pins and retains unresolved delivery', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  const key = (await h.store.getInternal('R')).continuationIntent.operationKey;
  h.receipts.pinForOwner('orphan', 'orchestration-continuation');
  h.receipts.pinForOwner('foreign', 'tab-message');
  await h.service.reconcilePins();
  assert.deepEqual(h.receipts.listOwnerPins('orchestration-continuation'), [key]);
  assert.deepEqual(h.receipts.listOwnerPins('tab-message'), ['foreign']);
  await h.store.cancel('R'); await h.service.reconcilePins();
  assert.equal(h.receipts.listOwnerPins('orchestration-continuation').length, 0);
});

test('a second request cannot claim the same target while a selected continuation is pending', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  await h.store.create({ runId: 'R2', sourceTabId: 'A', targetTabId: 'B', targetToolType: 'codex', promptHash: 'second',
    sourceSendTarget: { toolType: 'codex', sessionId: 'A' }, targetExecutionContext: oldContext });
  await h.store.markDelivery('R2', { sessionId: 'B' });
  await h.store.beginRecovery('R2', 'interrupted', 'turn_aborted');
  assert.equal((await h.service.continueRequest('R2')).code, 'continuation-target-claimed');
  assert.equal(h.calls.sends.length, 1);
});

test('actual /cancel fences the pending Continue and persists closure before ACK and reopen', async t => {
  const h = await fixture(t); h.setResult('unknown'); await h.service.continueRequest('R');
  const text = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
  const ast = ts.createSourceFile('web.js', text, ts.ScriptTarget.Latest, true);
  const helper = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'cancelPendingOrchestrationContinuation').getText(ast);
  const route = text.slice(text.indexOf('  const orchestrationCancelMatch ='), text.indexOf('  const orchestrationActionMatch ='));
  const env = vm.createContext({ getOrchestrationRunStore: () => h.store, agentSendReceiptStore: h.receipts, agentSendQueue: null,
    isResponseObservation: () => false, decId: decodeURIComponent, readBody: async () => ({ interrupt: false }),
    emitOrchestrationChanges() {}, finalizeSettledOrchestrations: async () => {}, withOrchestrationUrls: value => value,
    sendJson: (_res, status, value) => ({ status, value }) });
  vm.runInContext(helper, env);
  const handle = vm.runInContext('(async(req,res,parsed)=>{' + route + '})', env);
  const result = await handle({ method: 'POST' }, {}, { pathname: '/api/orchestrations/R/cancel' });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(h.file, 'utf8')).runs.find(r => r.runId === 'R').status, 'cancelled');
  const operationKey = (await h.store.getInternal('R')).continuationIntent.operationKey;
  await h.reopen();
  assert.equal(h.receipts.isDeliveryCancelled(operationKey), true);
  assert.equal((await h.service.continueRequest('R')).ok, false); assert.equal(h.calls.sends.length, 1);
});

test('actual replacement link survives post-commit dispatch interruption and replays the guarded dispatcher', async t => {
  const h = await fixture(t);
  const identity = { operationKey: 'orchestration-target:R', surface: 'orchestration', runId: 'R', tabId: 'B', handoffId: 'orchestration:R',
    provider: 'codex', sessionId: 'B', requestFingerprint: 'original', promptHash: 'original-audit', promptLength: 13 };
  const attempt = h.receipts.beginAttempt(identity);
  h.receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { promptText: 'original task' });
  const web = ts.createSourceFile('web.js', fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const code = web.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createReplacementOrchestrationRequest').getText(web);
  let dispatch = 0;
  const env = vm.createContext({ crypto, getOrchestrationRunStore: () => h.store, agentSendReceiptStore: h.receipts,
    findOrchestrationTabDescriptor: id => ({ tabId: id, tabName: id, projectId: 'P', projectPath: h.dir, cwd: h.dir }),
    isTerminalStatus: value => ['completed', 'failed', 'cancelled'].includes(value), isPausedRun: () => false,
    promptFingerprint: require('./claude-prompt-carriers').promptFingerprint, promptAuditFingerprint,
    emitOrchestrationChanges() {}, emitOrchestrationRun() {}, finalizeSettledOrchestrations: async () => {},
    dispatchDeferredOrchestrationRun: async () => { throw new Error('controlled interruption before dispatch'); } });
  vm.runInContext(code, env);
  h.setReplacementOverrides(env.createReplacementOrchestrationRequest, async id => { dispatch++; return h.store.get(id); });
  await assert.rejects(h.service.newRequest('R'), /controlled interruption/);
  const id = (await h.store.get('R')).replacementRunId;
  assert.equal((await h.store.get(id)).status, 'queued');
  await h.reopen();
  assert.equal((await h.service.newRequest('R')).replacementRunId, id); assert.equal(dispatch, 1);
  assert.equal((await h.store.get(id)).replacesRunId, 'R');
});

test('actual Claude original adapter keeps parser verification and original identity, without inventing a live turn', async t => {
  const h = await fixture(t), file = path.join(h.dir, 'claude.jsonl'); fs.writeFileSync(file, 'private fixture\n');
  const stat = fs.statSync(file), sourceSnapshot = { filePath: file, fileIdentity: stat.dev + ':' + stat.ino, sessionId: 'B',
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  const main = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const original = { ...oldContext, provider: 'claude' };
  let complete = false;
  const env = vm.createContext({ fs, INTERRUPT_TEXTS: new Set(), claudeDataApi: { claudeUserRecordText: () => 'original task' },
    _getAgentTurnResultForOrchestration: async () => ({ found: true, complete, userUuid: 'original-user', sourceSnapshot, assistantText: complete ? 'ready' : '' }),
    _loadSessionTurns: async () => ({ sourceSnapshot, recordMap: new Map([['original-user', {}]]) }) });
  const code = ['readObservedTranscriptResponse', 'readAgentContinuationOriginalProof'].map(name =>
    main.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(main)).join('\n');
  vm.runInContext(code, env);
  const request = { toolType: 'claude', sessionId: 'B', promptUserUuid: 'original-user', targetExecutionContext: original };
  const read = await env.readAgentContinuationOriginalProof(request);
  assert.equal(read.sourceVerified, true); assert.deepEqual(JSON.parse(JSON.stringify(read.executionContext)), original);
  complete = true; assert.equal((await env.readAgentContinuationOriginalProof(request)).terminalEvent, 'Stop');
  const noOriginal = await env.readAgentContinuationOriginalProof({ ...request, targetExecutionContext: null });
  assert.equal(noOriginal.executionContext, undefined, 'no ambient latest-turn substitute');
  fs.appendFileSync(file, 'changed');
  assert.equal((await env.readAgentContinuationOriginalProof(request)).sourceVerified, false);
});

test('actual action -> common FIFO -> actual Main canonical publisher -> exact continuation, with one physical bridge call', async t => {
  const h = await fixture(t);
  const web = ts.createSourceFile('web.js', fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const main = ts.createSourceFile('main.js', fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), ts.ScriptTarget.Latest, true);
  const extract = (tree, name) => { const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name); assert.ok(fn, name); return fn.getText(tree); };
  let physical = 0, routed;
  const env = vm.createContext({ require, path, srcMainDir: __dirname, ...registry,
    agentSendReceiptStore: h.receipts, agentSendReceiptRegistry: registry.createAgentSendReceiptRegistry(),
    agentSendReceiptStartupReady: Promise.resolve(), agentSendBridgeTimeoutMs: 1000, readAgentRuntimeSnapshot: null,
    AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES, AGENT_SEND_DURABLE_STATES: require('./agent-send-receipt-store').STORE_STATES,
    promptAuditFingerprint, crypto, Buffer, console: { log() {}, warn() {}, error() {} }, tabWorkContext: null, tabMessageService: null,
    compactSendReceiptPresentation: require('./compact-send-settlement').compactSendReceiptPresentation,
    bindStructuredAuthoringPresentation: require('./structured-authoring').bindStructuredAuthoringPresentation,
    agentSendTargetPreconditionFailure: require('./agent-send-target-precondition').agentSendTargetPreconditionFailure,
    withPromptOriginPresentation: value => value, shortId: value => value,
    isLocalSlashCommandPrompt: require('./agent-history-send-receipt').isLocalSlashCommandPrompt,
    cleanOptionalString: (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback,
    scenarioDestination: require('./agent-message-identity').scenarioDestination,
    findOrchestrationTabDescriptor: () => ({ projectId: 'P', toolType: 'codex', sessionId: 'B' }),
    getOrchestrationRunStore: () => h.store, getOrchestrationContinuationService: () => h.service,
    agentPromptAuditMatchesHash: require('./agent-prompt-audit-identity').agentPromptAuditMatchesHash,
    getActiveAgentExecutionContext: () => { throw new Error('publisher must use the exact audit, not a latest turn'); },
    enrichCodexAuditAddress() {}, deferCodexPromptAuditExecutionContext() {},
    routeAgentPromptAuditDetail: detail => { routed = env.notifyAgentPromptAuditResult(detail); },
  });
  vm.runInContext(['isOrchestrationPromptAudit', 'compatiblePromptAuditExecutionContext', 'publishAgentPromptAuditResult']
    .map(name => extract(main, name)).join('\n'), env);
  vm.runInContext(['durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay', 'publicAgentSendReceipt',
    'durableAgentSendFailure', 'runPreparedAgentSendScenario', 'runAgentSendScenario', 'readScenarioDestination',
    'notifyAgentPromptAuditResult', 'performOrchestrationAction'].map(name => extract(web, name)).join('\n'), env);
  const queue = new AgentSendQueue({ store: h.receipts, execute: request => env.runPreparedAgentSendScenario({ ...request, applicationQueueExecution: true }) });
  env.agentSendQueue = queue;
  t.after(() => queue.dispose());
  env.bridgeRequest = async (action, request) => {
    assert.equal(action, 'sendAgentPromptScenario'); physical++;
    assert.equal(request.prompt, 'continue'); assert.equal(request.handoffId, 'orchestration-continue:R:1');
    h.receipts.markAttemptState(request.sendOperationKey, request.sendAttemptId, 'enter-armed');
    Object.assign(h.states.get('B'), { busy: true, processStatus: 'found', executionContext: nextContext, revision: 'B2' });
    const audit = { handoffId: request.handoffId, sendOperationKey: request.sendOperationKey,
      sendAttemptId: request.sendAttemptId, source: request.source, queuedAtSubmit: false };
    const proof = { success: true, actualHash: promptAuditFingerprint('continue'), expectedHash: promptAuditFingerprint('continue'),
      sessionId: 'B', entryUuid: 'actual-continue-user', sourceIdentity: 'actual-continue-source', executionContext: nextContext,
      auditTimestamp: new Date(nextContext.startedAt).toISOString() };
    env.publishAgentPromptAuditResult('B', audit, proof, 'codex'); await routed;
    return { success: true, submitted: true, exactAuditConfirmed: true, codexAudit: proof };
  };
  h.setSendOverride(request => env.runAgentSendScenario(request));
  const result = await env.performOrchestrationAction('R', 'continue');
  assert.equal(result.resumed, true, JSON.stringify(result));
  assert.equal(physical, 1);
  const bound = await h.store.getInternal('R');
  assert.equal(bound.targetLifecycleGeneration, 'L-new');
  assert.equal(buildOrchestrationResultLookup(bound).promptUserUuid, 'actual-continue-user');
  await env.performOrchestrationAction('R', 'continue'); assert.equal(physical, 1);
  const done = await h.store.applyLifecycle('B', { type: 'done', reason: 'task_complete', sessionId: 'B', toolType: 'codex',
    lifecycleGeneration: 'L-new', executionContext: nextContext, backgroundWorkCount: 0 });
  assert.equal(done.settled[0]?.runId, 'R');
  assert.equal((await h.store.get('R')).resultComplete, false, 'existing exact final reader still owns completion proof');
});


test('the illustrative public ready/writer flags alone never supply continuation input authority', async t => {
  const h = await fixture(t);
  Object.assign(h.states.get('B'), { busy: null, transitioning: false, processStatus: 'found',
    inputReady: true, status: 'active', writerUsableForMutation: true, error: 'response_busy_unknown' });
  assert.equal((await h.service.continueRequest('R')).code, 'continuation_runtime_unknown');
  assert.equal(h.calls.sends.length, 0);
});
