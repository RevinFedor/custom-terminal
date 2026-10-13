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
const { isResponseObservation } = require('./orchestration-response-observation');
const { runOrchestrationCompletionFlow } = require('./orchestration-completion-flow');

// Execute the production HTTP orchestration functions without starting Electron,
// a server, a provider, or any notification transport.
const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const parsed = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declarations = ['probeOrchestrationResult', 'reconcileOrchestrationRun',
  'finalizeSettledOrchestration', 'finalizeSettledOrchestrationPass',
  'finalizeSettledOrchestrations', 'finalizeClosedTargetResultProof'].map(name => {
  const node = parsed.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, name);
  return node.getText(parsed);
}).join('\n');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const complete = { found: true, complete: true, assistantText: 'answer A', turnIndex: 3,
  userUuid: 'user-A', terminalEvent: 'task_complete', hasFinalResult: true };
const failure = { found: true, complete: false, terminalEvent: 'provider_error',
  proofDefinitive: true, errorCode: 'provider_error', error: 'old provider failure' };

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-result-attempt-'));
  const store = new runs.OrchestrationRunStore(path.join(dir, 'runs.json'));
  t.after(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const executionContext = { provider: 'codex', sessionId: 'S', turnId: 'A',
    processId: 'P', generation: 1, startedAt: Date.now() - 1000 };
  await store.create({ runId: 'R', sourceTabId: 'source', targetTabId: 'target',
    targetToolType: 'codex', targetCwd: '/test/cwd', promptHash: 'hash-A',
    targetExecutionContext: executionContext, ...options.run });
  await store.markDelivery('R', { sessionId: 'S', lifecycleGeneration: 'L' });
  await store.applyLifecycle('target', { type: 'busy', busy: true, sessionId: 'S',
    lifecycleGeneration: 'L', executionContext });
  assert.equal((await store.get('R')).status, 'running');
  const effects = [], requests = [];
  const counts = { persist: 0 };
  const enqueue = store._enqueuePersist.bind(store);
  store._enqueuePersist = strict => { counts.persist++; return enqueue(strict); };
  const context = vm.createContext({ ...runs, ...proof, isResponseObservation, runOrchestrationCompletionFlow,
    console: { log() {}, warn() {} },
    getOrchestrationRunStore: () => store,
    resolveAgentSessionInfo: options.resolveSession || (async () => ({
      status: 'idle', sessionId: 'S', cwd: '/test/cwd', lifecycleGeneration: 'L',
    })),
    getAgentTurnResult: async request => {
      requests.push(request);
      return options.read ? options.read(request) : complete;
    },
    orchestrationCompletionInflight: new Map(), orchestrationCompletionTrailing: new Set(),
    e2eBoundaryTestGate: null,
    ORCHESTRATION_RESULT_PROOF_FLUSH_GRACE_MS: 5000,
    orchestrationResultProofCoordinator: { snapshot: () => [] },
    armOrchestrationResultProof: options.arm || (async () => ({ success: true })),
    releaseOrchestrationResultProof: async () => { effects.push('release'); },
    emitOrchestrationRun: () => { effects.push('emit'); },
    emitOrchestrationChanges: changed => { for (const _ of changed || []) effects.push('emit'); },
    dispatchNextDeferredOrchestrationForTarget: async () => { effects.push('dispatch'); },
    sendOrchestrationCompletionNotification: async () => { effects.push('notify'); },
    scheduleOrchestrationPolicyTimer: async () => {},
    findOrchestrationTabDescriptor: () => null,
  });
  vm.runInContext(declarations, context);
  async function finish() {
    const run = await store.getInternal('R');
    await store.applyLifecycle('target', { type: 'done', reason: 'task_complete', sessionId: 'S',
      lifecycleGeneration: run.targetLifecycleGeneration, executionContext: run.targetExecutionContext });
    assert.equal((await store.get('R')).status, 'completed');
  }
  async function replace() {
    assert.equal((await store.pause('R')).paused, true);
    await store.resolveRecovery('R', 'resume');
    const run = await store.getInternal('R');
    await store.applyLifecycle('target', { type: 'busy', busy: true, sessionId: 'S',
      lifecycleGeneration: 'L', executionContext: { ...executionContext, turnId: 'B',
        generation: 2, startedAt: run.resumeAfterAt + 1 } });
    assert.equal((await store.get('R')).status, 'running');
    assert.equal((await store.get('R')).targetExecutionContext.turnId, 'B');
  }
  return { store, context, effects, counts, requests, finish, replace };
}

for (const [outcome, result] of [['success', complete], ['failure', failure]]) {
  for (const flow of ['reconcile', 'finalize']) {
    test(`delayed ${flow} ${outcome} for A cannot commit or notify after Pause/Resume/start B`, async t => {
      const entered = deferred(), delayed = deferred();
      const h = await fixture(t, { read: async () => { entered.resolve(); return delayed.promise; } });
      if (flow === 'finalize') await h.finish();
      const pending = flow === 'reconcile'
        ? h.context.reconcileOrchestrationRun('R')
        : h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
      await entered.promise;
      await h.replace();
      // A status-only guard is insufficient: B may itself finish during A's read.
      if (flow === 'finalize') await h.finish();
      const before = structuredClone(await h.store.getInternal('R'));
      h.counts.persist = 0;
      delayed.resolve(result);
      await pending;
      assert.deepEqual(await h.store.getInternal('R'), before);
      assert.deepEqual(h.effects, []);
      assert.equal(h.counts.persist, 0);
      assert.equal(h.requests[0].targetExecutionContext.turnId, 'A');
    });
  }
}

test('repeated unchanged running observations neither persist nor fan out', async t => {
  const h = await fixture(t, { read: async () => ({ found: true, complete: false }),
    resolveSession: async () => ({ status: 'busy', sessionId: 'S', lifecycleGeneration: 'L' }) });
  await h.context.reconcileOrchestrationRun('R');
  const before = structuredClone(await h.store.getInternal('R'));
  h.effects.length = 0;
  h.counts.persist = 0;
  for (let i = 0; i < 1000; i++) await h.context.reconcileOrchestrationRun('R');
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
  assert.equal(h.requests.length, 1001, 'generic busy must not skip the result reader');
});

test('repeated unchanged pending completion observations neither persist nor fan out', async t => {
  const h = await fixture(t, { read: async () => ({ found: false, complete: false,
    sourceSnapshot: { size: 100, mtimeMs: 42 } }) });
  await h.finish();
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  const before = structuredClone(await h.store.getInternal('R'));
  h.effects.length = 0;
  h.counts.persist = 0;
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
  assert.equal(h.requests.length, 4, 'each pass retains read/arm/reread');
});

test('the same valid completion still records proof and notifies once', async t => {
  const h = await fixture(t);
  await h.finish();
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  const run = await h.store.get('R');
  assert.equal(run.status, 'completed');
  assert.equal(run.resultComplete, true);
  assert.equal(run.resultUserUuid, 'user-A');
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
  assert.ok(h.counts.persist > 0);
});

test('the attempt is captured before asynchronous session resolution', async t => {
  const entered = deferred(), session = deferred();
  const h = await fixture(t, { resolveSession: async () => { entered.resolve(); return session.promise; } });
  const pending = h.context.reconcileOrchestrationRun('R');
  await entered.promise;
  await h.replace();
  const before = structuredClone(await h.store.getInternal('R'));
  h.counts.persist = 0;
  session.resolve({ status: 'idle', sessionId: 'S', lifecycleGeneration: 'L' });
  await pending;
  assert.equal(h.requests[0].targetExecutionContext.turnId, 'A');
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
});

test('replacement while arming keeps the reread on A and prevents its commit into B', async t => {
  const entered = deferred(), armed = deferred();
  let reads = 0;
  const h = await fixture(t, {
    read: async () => ++reads === 1 ? { found: false, complete: false } : complete,
    arm: async () => { entered.resolve(); return armed.promise; },
  });
  await h.finish();
  const pending = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  await entered.promise;
  await h.replace();
  await h.finish();
  const before = structuredClone(await h.store.getInternal('R'));
  h.counts.persist = 0;
  armed.resolve({ success: true });
  await pending;
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.targetExecutionContext.turnId === 'A'));
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
});

test('pending read from a replaced execution does not arm an obsolete subscription', async t => {
  const entered = deferred(), result = deferred();
  let arms = 0;
  const h = await fixture(t, {
    read: async () => { entered.resolve(); return result.promise; },
    arm: async () => { arms++; return { success: true }; },
  });
  await h.finish();
  const pending = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  await entered.promise;
  await h.replace();
  h.counts.persist = 0;
  result.resolve({ found: false, complete: false });
  await pending;
  assert.equal(arms, 0);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
});

for (const [name, replaceIdentity] of [
  ['execution generation', run => { run.targetExecutionContext.generation++; }],
  ['unknown execution generation becoming known', run => { run.targetExecutionContext.generation = 2; }],
  ['writer generation', run => { run.targetLifecycleGeneration = 'replacement-writer'; }],
  ['exact prompt carrier', run => { run.targetPromptProofUserUuid = 'replacement-user'; }],
  ['recovery time boundary', run => { run.resultAfterAt = run.createdAt + 1; }],
  ['continuation generation', run => { run.targetContinuationExecutionContext.generation++; }],
]) {
  for (const operation of ['reconcile', 'record', 'failure']) {
    test(`${operation} checks ${name} at the store commit boundary`, async t => {
      const h = await fixture(t);
      if (operation !== 'reconcile') await h.finish();
      const live = await h.store.getInternal('R');
      if (name.startsWith('unknown')) live.targetExecutionContext.generation = null;
      live.targetContinuationExecutionContext = { ...live.targetExecutionContext, turnId: 'internal' };
      const attempt = runs.captureOrchestrationResultAttempt(live);
      assert.ok(Object.isFrozen(attempt) && Object.isFrozen(attempt.lookup));
      assert.ok(Object.isFrozen(attempt.lookup.targetExecutionContext));
      assert.ok(Object.isFrozen(attempt.targetContinuationExecutionContext));
      const originalGeneration = attempt.lookup.targetExecutionContext.generation;
      // Each method awaits initialization; replace the live identity after the
      // call so a caller-side check alone cannot pass this test.
      const pending = operation === 'reconcile'
        ? h.store.reconcile('R', { resultAttempt: attempt, resultFound: true,
          resultComplete: true, resultAvailable: true, busy: false })
        : operation === 'record'
          ? h.store.recordResultProofObservation('R', { resultAttempt: attempt,
            resultComplete: true, resultAvailable: true }, { withOutcome: true })
          : h.store.markResultProofTerminalFailure('R', 'stale failure', { resultAttempt: attempt });
      replaceIdentity(live);
      const before = structuredClone(live);
      h.counts.persist = 0;
      const result = await pending;
      assert.equal(result.ignored, true);
      assert.ok(result.changed == null || result.changed === false || result.changed.length === 0);
      assert.deepEqual(await h.store.getInternal('R'), before);
      assert.equal(h.counts.persist, 0);
      assert.equal(attempt.lookup.targetExecutionContext.generation, originalGeneration);
    });
  }
}

test('same valid automatic interrupted recovery still selects the resumed exact turn', async t => {
  const h = await fixture(t, { read: async request => ({ ...complete,
    assistantText: 'recovered answer', userUuid: 'user-' + request.targetExecutionContext.turnId }) });
  await h.store.beginRecovery('R', 'interrupted', 'turn_aborted');
  const old = await h.store.getInternal('R');
  await h.store.applyLifecycle('target', { type: 'busy', busy: true, sessionId: 'S',
    lifecycleGeneration: 'L', executionContext: { ...old.targetExecutionContext,
      turnId: 'recovered', generation: 2, startedAt: old.updatedAt + 1 } });
  const resumed = await h.store.getInternal('R');
  assert.equal(resumed.recoveryContinuedAutomatically, true);
  assert.ok(resumed.resultAfterAt);
  await h.context.reconcileOrchestrationRun('R');
  const run = await h.store.get('R');
  assert.equal(run.status, 'completed');
  assert.equal(run.resultComplete, true);
  assert.equal(run.resultUserUuid, 'user-recovered');
  assert.ok(h.requests.every(request => request.targetExecutionContext.turnId === 'recovered'));
  assert.ok(h.requests.every(request => request.promptHash === undefined));
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('same valid ownership recovery still completes from exact result proof', async t => {
  const h = await fixture(t);
  await h.store.beginRecovery('R', 'process_exited', 'process exited');
  await h.context.reconcileOrchestrationRun('R');
  const run = await h.store.get('R');
  assert.equal(run.status, 'completed');
  assert.equal(run.resultComplete, true);
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('same valid terminal failure still fails the run and notifies once', async t => {
  const h = await fixture(t, { read: async () => failure });
  await h.finish();
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  const run = await h.store.get('R');
  assert.equal(run.status, 'failed');
  assert.equal(run.resultErrorCode, 'provider_error');
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('pending observations retain real state transitions and changed source revisions', async t => {
  let size = 100;
  const h = await fixture(t, { read: async () => ({ found: false, complete: false,
    sourceSnapshot: { size, mtimeMs: 42 } }) });
  await h.store.patch('R', { status: 'queued', targetBusySeen: false });
  h.counts.persist = 0;
  const observation = { resultFound: false, busy: true, sessionId: 'S', lifecycleGeneration: 'L' };
  const first = await h.store.reconcile('R', observation);
  assert.equal(first.changed.status, 'running');
  assert.equal(h.counts.persist, 1);
  const repeated = await h.store.reconcile('R', observation);
  assert.equal(repeated.changed, null);
  assert.equal(h.counts.persist, 1);
  await h.finish();
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  h.effects.length = 0;
  h.counts.persist = 0;
  size = 200;
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  assert.equal((await h.store.get('R')).resultProofObservedSize, 200);
  assert.equal(h.counts.persist, 1);
  assert.deepEqual(h.effects, ['emit']);
});

test('an explicit null guard cannot silently become a legacy unguarded observation', async t => {
  const h = await fixture(t);
  const result = await h.store.reconcile('R', { resultAttempt: null,
    resultFound: true, resultComplete: true });
  assert.equal(result.ignored, true);
  assert.equal(result.changed, null);
});

test('closed-target final read for A cannot declare B result unavailable', async t => {
  const entered = deferred(), delayed = deferred();
  const h = await fixture(t, { read: async () => { entered.resolve(); return delayed.promise; } });
  await h.finish();
  const pending = h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true });
  await entered.promise;
  await h.replace();
  await h.finish();
  const before = structuredClone(await h.store.getInternal('R'));
  h.counts.persist = 0;
  delayed.resolve({ found: false, complete: false });
  await pending;
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
});

test('valid pending completion still subscribes, rereads and completes', async t => {
  let reads = 0, arms = 0;
  const h = await fixture(t, {
    read: async () => ++reads === 1 ? { found: false, complete: false } : complete,
    arm: async () => { arms++; return { success: true }; },
  });
  await h.finish();
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  assert.equal((await h.store.get('R')).resultComplete, true);
  assert.equal(reads, 2);
  assert.equal(arms, 1);
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('an in-flight transcript wake still gets a trailing completion pass', async t => {
  const entered = deferred(), first = deferred();
  let reads = 0;
  const h = await fixture(t, { read: async () => {
    if (++reads === 1) { entered.resolve(); return first.promise; }
    return reads === 2 ? { found: false, complete: false } : complete;
  } });
  await h.finish();
  const pending = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  await entered.promise;
  const trailing = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'), 'transcript-changed');
  first.resolve({ found: false, complete: false });
  await Promise.all([pending, trailing]);
  assert.equal(reads, 3);
  assert.equal((await h.store.get('R')).resultComplete, true);
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('valid completion can enrich a missing saved session without discarding its notification', async t => {
  const h = await fixture(t);
  await h.finish();
  await h.store.patch('R', { sessionId: null });
  await h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  const run = await h.store.getInternal('R');
  assert.equal(run.sessionId, 'S');
  assert.equal(run.resultComplete, true);
  assert.equal(Object.hasOwn(run, 'resultAttempt'), false, 'attempt guards are never persisted');
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('unchanged closed-target failure still resolves after its final read', async t => {
  const h = await fixture(t, { read: async () => ({ found: false, complete: false }) });
  await h.finish();
  await h.context.finalizeClosedTargetResultProof('R', { knownTargetClosed: true });
  const run = await h.store.get('R');
  assert.equal(run.status, 'failed');
  assert.equal(run.outcome, 'result_unavailable');
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('cancellation during a completion read stays cancelled without notification', async t => {
  const entered = deferred(), delayed = deferred();
  const h = await fixture(t, { read: async () => { entered.resolve(); return delayed.promise; } });
  await h.finish();
  const pending = h.context.finalizeSettledOrchestration(await h.store.getInternal('R'));
  await entered.promise;
  await h.store.cancel('R');
  const before = structuredClone(await h.store.getInternal('R'));
  h.counts.persist = 0;
  delayed.resolve(complete);
  await pending;
  assert.deepEqual(await h.store.getInternal('R'), before);
  assert.equal(h.counts.persist, 0);
  assert.deepEqual(h.effects, []);
});

async function waitForDescendant(h) {
  const run = await h.store.getInternal('R');
  await h.store.create({ runId: 'child', sourceTabId: 'target', targetTabId: 'child-target',
    parentRunId: 'R', sourceExecutionContext: run.targetExecutionContext, promptHash: 'child-prompt' });
  await h.store.applyLifecycle('target', { type: 'done', reason: 'task_complete', sessionId: 'S',
    lifecycleGeneration: 'L', executionContext: run.targetExecutionContext });
  const waiting = await h.store.get('R');
  assert.equal(waiting.status, 'waiting_descendants');
  assert.equal(waiting.outcome, 'success');
  assert.ok(waiting.ownCompletedAt);
  assert.equal(waiting.resultComplete, false);
}

test('waiting descendants after lifecycle done still needs the late durable final proof', async t => {
  const h = await fixture(t, { read: async () => ({ found: true, complete: false,
    terminalEvent: 'task_complete', hasFinalResult: false }) });
  await waitForDescendant(h);
  await h.context.reconcileOrchestrationRun('R', 'target-transcript-changed');
  const run = await h.store.get('R');
  assert.equal(h.requests.length, 1);
  assert.equal(run.status, 'waiting_recovery');
  assert.equal(run.outcome, 'failed');
  assert.equal(run.error, 'codex-no-final-result');
  assert.equal(h.effects.filter(item => item === 'notify').length, 0);
});

test('an earlier own result proof does not suppress changed proof while waiting descendants', async t => {
  let result = complete;
  const h = await fixture(t, { read: async () => result });
  await waitForDescendant(h);
  await h.context.reconcileOrchestrationRun('R', 'target-transcript-changed');
  const proved = await h.store.get('R');
  assert.equal(proved.status, 'waiting_descendants');
  assert.equal(proved.resultAvailable, true);
  assert.equal(h.effects.filter(item => item === 'notify').length, 0);

  // The coordinator receives fs.watch for both append and rewrite+growth.
  // The provider reader owns validating whether the earlier proof survived.
  result = failure;
  await h.context.reconcileOrchestrationRun('R', 'target-transcript-changed');
  const run = await h.store.get('R');
  assert.equal(h.requests.length, 2);
  assert.equal(run.status, 'failed');
  assert.equal(run.resultErrorCode, 'provider_error');
  assert.equal(h.effects.filter(item => item === 'notify').length, 1);
});

test('unbound Codex Retry routes through the declared-provider compact reader before any generic scan', async t => {
  const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = mainSource.indexOf('async function _getAgentTurnResultForOrchestration');
  const end = mainSource.indexOf('\nasync function handleOverseerRequest', start);
  assert.ok(start >= 0 && end > start);
  const compactCalls = [];
  let genericReads = 0;
  const adapter = vm.createContext({
    console: { log() {}, warn() {} },
    transcriptService: { resolveCodexResultSource: async () => ({ success: true }) },
    codexDataModule: { _api: { loadCodexProviderResult: async request => {
      compactCalls.push(request);
      return { success: true, complete: false, assistantText: '', assistantChars: 0 };
    } } },
    _loadSessionTurns: async () => {
      genericReads++;
      throw new Error('unbound Codex must not scan generic history to discover data.engine');
    },
  });
  const adapterSource = ts.createSourceFile('result-reader.js', mainSource.slice(start, end),
    ts.ScriptTarget.Latest, true);
  const reader = adapterSource.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === '_getAgentTurnResultForOrchestration');
  assert.ok(reader);
  vm.runInContext(reader.getText(adapterSource), adapter);
  const h = await fixture(t, { read: request => adapter._getAgentTurnResultForOrchestration(request) });
  await h.store.beginRecovery('R', 'failed', 'retryable failure');
  await h.store.resolveRecovery('R', 'reopen', { sessionId: 'S', lifecycleGeneration: 'L' });
  const before = structuredClone(await h.store.getInternal('R'));
  assert.equal(before.targetExecutionContext, null);
  assert.ok(before.resultAfterAt);
  await h.context.reconcileOrchestrationRun('R', 'target-transcript-changed');
  assert.equal(h.requests[0].toolType, 'codex');
  assert.equal(h.requests[0].targetExecutionContext, undefined);
  assert.equal(genericReads, 0);
  assert.equal(compactCalls.length, 1);
  assert.equal(compactCalls[0].proof.targetExecutionContext, undefined);
  assert.equal(compactCalls[0].proof.resultAfterAt, before.resultAfterAt);
  assert.equal(compactCalls[0].proof.promptHash, undefined);
  assert.equal(compactCalls[0].sessionId, 'S');
  assert.deepEqual(await h.store.getInternal('R'), before, 'routing must not bind a fabricated execution');
  assert.deepEqual(h.effects, []);
});

test('probe provider stays on the immutable attempt when live session/provider changes during resolution', async t => {
  const entered = deferred(), session = deferred();
  const h = await fixture(t, { resolveSession: async () => { entered.resolve(); return session.promise; } });
  await h.store.beginRecovery('R', 'failed', 'retryable failure');
  await h.store.resolveRecovery('R', 'reopen', { sessionId: 'S', lifecycleGeneration: 'L' });
  const live = await h.store.getInternal('R');
  const pending = h.context.probeOrchestrationResult(live);
  await entered.promise;
  live.targetToolType = 'claude';
  live.sessionId = 'replacement-saved-session';
  live.targetCwd = '/replacement-target-cwd';
  session.resolve({ toolType: 'claude', commandType: 'claude', sessionId: 'another-session', cwd: '/live-cwd' });
  const result = await pending;
  assert.equal(h.requests[0].toolType, 'codex');
  assert.equal(h.requests[0].sessionId, 'S');
  assert.equal(h.requests[0].cwd, '/test/cwd');
  assert.equal(result.resultAttempt.targetToolType, 'codex');
  assert.equal(h.requests[0].targetExecutionContext, undefined);
});

test('probe falls back to the saved lookup provider and keeps a genuinely unknown provider unknown', async t => {
  const h = await fixture(t, { resolveSession: async () => ({
    toolType: 'claude', commandType: 'claude', sessionId: 'another-session',
  }) });
  await h.store.patch('R', { targetToolType: null });
  await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
  assert.equal(h.requests[0].toolType, 'codex', 'the exact saved lookup supplies the provider');
  assert.equal(h.requests[0].sessionId, 'S');
  await h.store.patch('R', { targetExecutionContext: null });
  await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
  assert.equal(h.requests[1].toolType, null, 'a foreign live provider is never borrowed');
});

test('unbound proof keeps its durable session and captured cwd when the live tab is rebound', async t => {
  const h = await fixture(t, { resolveSession: async () => ({
    toolType: 'codex', sessionId: 'new-live-session', cwd: '/new-live-cwd',
  }) });
  await h.store.patch('R', { targetExecutionContext: null, sessionId: 'old-durable-session',
    targetCwd: '/old-target-cwd' });
  const before = structuredClone(await h.store.getInternal('R'));
  const result = await h.context.probeOrchestrationResult(await h.store.getInternal('R'));
  assert.equal(h.requests[0].sessionId, 'old-durable-session');
  assert.equal(h.requests[0].cwd, '/old-target-cwd');
  assert.equal(h.requests[0].toolType, 'codex');
  assert.equal(h.requests[0].targetExecutionContext, undefined);
  assert.equal(result.sessionId, 'old-durable-session');
  assert.deepEqual(await h.store.getInternal('R'), before);
});

test('fresh proof falls back to the live session and retains cwd fallbacks when none was captured', async t => {
  const h = await fixture(t, { resolveSession: async () => ({
    toolType: 'codex', sessionId: 'first-live-session', cwd: '/first-live-cwd',
  }) });
  const fresh = { runId: 'fresh', targetTabId: 'fresh-tab', targetToolType: 'codex',
    promptHash: 'fresh-prompt', targetProjectPath: '/project-root' };
  const result = await h.context.probeOrchestrationResult(fresh);
  assert.equal(result.resultAttempt.sessionId, null);
  assert.equal(h.requests[0].sessionId, 'first-live-session');
  assert.equal(h.requests[0].cwd, '/first-live-cwd');
  assert.equal(h.requests[0].targetExecutionContext, undefined);
  await h.context.probeOrchestrationResult(fresh, {
    sessionInfo: { sessionId: 'first-live-session', cwd: null },
  });
  assert.equal(h.requests[1].cwd, '/project-root');
});
