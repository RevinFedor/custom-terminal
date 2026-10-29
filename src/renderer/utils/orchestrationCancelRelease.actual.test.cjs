'use strict';
// Real Zustand orchestration registry + persisted queue store and AST-selected
// production runner callbacks. Electron persistence/events, native runtime facts,
// compact UI and the final provider input are controlled, finite leaves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const ts = require('typescript');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '../../..');
const P = 'cancel-source', T = 'review-target', S = 'source-session';
const beforeRoot = process.env.LOOP_CANCEL_PRE_ROOT;
const source = name => fs.readFileSync(path.join(beforeRoot || repo, name), 'utf8');
const runnerFile = 'src/renderer/hooks/usePromptQueueRunner.ts';
const runner = ts.createSourceFile(runnerFile, source(runnerFile), ts.ScriptTarget.Latest, true);
function pick(predicate, label) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(runner); assert.equal(found.length, 1, label); return found[0];
}
function declaration(name) {
  const node = pick(node => (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node))
    && node.name?.getText(runner) === name, name);
  return (ts.isVariableDeclaration(node) ? 'const ' : '') + node.getText(runner) + ';';
}
function subscriber(marker) {
  return pick(node => ts.isVariableDeclaration(node) && node.name.getText(runner) === 'unsubscribeOrchestration'
    && node.initializer?.arguments?.[0]?.getText(runner).includes(marker), marker)
    .initializer.arguments[0].getText(runner);
}
const runnerCode = ts.transpileModule([
  ...['explicitOutcomeTimestamp', 'liveOutcomeTimestamp', 'naturalOutcomeKey', 'isTabWorkflowBlocked',
    'applyAbnormalQueueOutcome', 'processSuccessfulWorkflowOutcome', 'fireLoopOwner'].map(declaration),
  'globalThis.outcome = processSuccessfulWorkflowOutcome;',
  'globalThis.abnormal = applyAbnormalQueueOutcome;',
  'globalThis.subscribeNatural = () => subscribeOrchestrationRunChanges(' + subscriber('orchestration-abnormal') + ');',
  'globalThis.subscribeTimers = () => subscribeOrchestrationRunChanges(' + subscriber('resumePersistedTimers') + ');',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let queueBundle, registryBundle, outcomes, reconciliation, capacity;
async function bundle(name) {
  const result = await esbuild.build({ entryPoints: [path.join(repo, name)], bundle: true, write: false,
    platform: 'node', format: 'cjs', logLevel: 'silent', plugins: beforeRoot ? [{
      name: 'exact-saved-source', setup(build) {
        build.onLoad({ filter: /useOrchestrationStore\.ts$/ }, args => ({ contents: source(name), loader: 'ts',
          resolveDir: path.dirname(args.path) }));
      },
    }] : [] });
  return result.outputFiles[0].text;
}
test.before(async () => {
  [queueBundle, registryBundle, outcomes, reconciliation] = await Promise.all([
    bundle('src/renderer/store/usePromptQueueStore.ts'), bundle('src/renderer/store/useOrchestrationStore.ts'),
    import('./agentCompletionOutcome.mjs'), import('./promptQueueReconciliation.mjs'),
  ]);
  capacity = await import('./runAfterCapacityRecovery.mjs');
});
function load(code, name) {
  const file = path.join(__dirname, name + '.controlled-memory.cjs');
  const module = new Module(file, require.main); module.filename = file;
  module.paths = Module._nodeModulePaths(__dirname); module._compile(code, file); return module.exports;
}
const run = (extra = {}) => ({ runId: 'review', runKind: 'agent', sourceTabId: P, sourceProjectId: 'project',
  sourceSessionId: S, targetTabId: T, status: 'running', createdAt: 1010, updatedAt: 1020,
  notificationStatus: 'pending', resultComplete: false, ...extra });
const cancelled = (extra = {}) => run({ status: 'cancelled', outcome: 'interrupted',
  completionReason: 'cancelled-by-api', completedAt: 1200, updatedAt: 1200,
  notificationSuppressed: true, notificationStatus: 'suppressed', ...extra });

async function fixture(t, { mode = 'all-work', busy = true, saved = new Map(), initialRuns = [], delayed = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const original = global.window, events = new Map(), warnings = [], messages = [], releases = [], logs = [];
  const retries = [], timerWakes = [], evaluated = [];
  let releaseList;
  const list = delayed ? new Promise(resolve => { releaseList = resolve; }) : Promise.resolve(initialRuns);
  const ipc = { on(channel, fn) { const entries = events.get(channel) || []; entries.push(fn); events.set(channel, entries); },
    removeListener() {}, invoke: async (channel, value) => {
      if (channel === 'orchestration:list-active') return list;
      if (channel === 'build-install:list-continuations') return { version: 1, known: true, entries: [] };
      if (channel === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: 'check original task' }] };
      if (channel === 'ai-prompts:save-content') return { success: true };
      if (channel === 'app:getState') return saved.get(value);
      if (channel === 'app:setState') { saved.set(value.key, value.value); return { success: true }; }
      throw Error('unexpected IPC ' + channel);
    }, sendSync(_channel, value) { saved.set(value.key, value.value); return { success: true }; } };
  global.window = { require: () => ({ ipcRenderer: ipc }) };
  let queue = load(queueBundle, 'cancel-queue'); await queue.hydratePromptQueueStore();
  if (!saved.has('promptQueueByTab')) queue.usePromptQueueStore.getState().setLoopPromptEnabled(P, true, mode);
  const registry = load(registryBundle, 'cancel-registry');
  const hydration = registry.initializeOrchestrationStore();
  if (!delayed) await hydration;
  const controls = { hydrated: true, priorInput: false, goal: false, installFloor: 0, loopWait: false };
  const context = vm.createContext({ Map, Set, Number, Date, ...outcomes, ...reconciliation,
    isModelCapacityWorkflowOutcome: capacity.isModelCapacityWorkflowOutcome,
    capacityWorkflowRecovery: capacity.createRunAfterCapacityRecovery(), capacityWorkflowSession: () => S,
    capacityWorkflowBlocked: () => false,
    deferredCapacityNaturalOutcomes: new Map(),
    console: { log: value => logs.push(value), warn: value => logs.push(value) },
    usePromptQueueStore: queue.usePromptQueueStore,
    ...Object.fromEntries(['isLoopPromptActive', 'loopPromptMode', 'promptQueueOutcomeFloor', 'countEnabledQueuedPrompts',
      'promptQueueContextWasSkipped', 'setPromptQueueContextSkipped'].map(name => [name, queue[name]])),
    isOrchestrationCompletionBlocked: registry.isOrchestrationCompletionBlocked,
    isLoopOrchestrationBlocked: registry.isLoopOrchestrationBlocked,
    subscribeOrchestrationRunChanges: registry.subscribeOrchestrationRunChanges,
    canProcessWorkflowOutcomes: () => controls.hydrated,
    hasPendingAgentGoalWork: data => data.goalWork?.pending === true,
    buildInstallContinuationFloor: () => controls.installFloor,
    hasPriorWorkflowInput: () => controls.priorInput || Boolean(queue.usePromptQueueStore.getState().getQueue(P).pendingDelivery),
    loopDependenciesBlock: () => controls.loopWait,
    messageLoopWaitsBlock: () => false, // the separate Send/Reply owner is known empty in this cancellation fixture
    messageLoopWaitsBlock: () => false,
    queueShutdownPending: false, queueManualStopping: new Set(), autoCompactCoordinator: null,
    prevBusyRef: new Map([[P, busy]]), autoCompactTurnStarts: new Map(),
    useWorkspaceStore: { getState: () => ({ openProjects: new Map([['project', { tabs: new Map([[P, {
      codexGoalWork: { pending: controls.goal },
    }]]) }]]) }) },
    deferredOrchestrationNaturalOutcomes: new Map(), deferredOwnerSends: new Map(),
    processedNaturalOutcomes: new Map(), latestLoopCauseByOwner: new Map(), loopNaturalCausesByOwner: new Map(),
    deferredContinuationPivotReleases: new Map(), queueSendInflight: new Set(), queueAwaitingBusyStart: new Set(),
    queueAppRuntimeInstanceId: 'controlled-runtime', queueAppRuntimeStartedAt: 900,
    tabExists: id => id === P || id === T,
    coordinator: { intercept: () => false }, findOwnersWaitingOn: () => [],
    getPromptQueueAgent: () => 'codex', getPromptQueueSessionId: () => S,
    getTabName: () => 'parent', shortQueueTabId: value => value, describeQueuesForTriggerLog: () => '',
    buildRunAfterIncidentReport: value => value,
    useUIStore: { getState: () => ({ showToast: (...args) => warnings.push(args) }) },
    rememberDeferredWorkflowOutcome: value => { context.restoredAbnormal = value; },
    retryDeferredOwnerSend: (...args) => retries.push(args),
    resumePersistedTimers: (...args) => timerWakes.push(args), evaluateQueues: (...args) => evaluated.push(args),
    isPromptQueueEditorLocked: () => false, promptTabTriggerReady: () => false,
    queueOwnerHasPendingContinuationAt: () => false, getEffectiveQueueTrigger: () => P,
    hasRuntimeWorkflowArm: () => false, getReadyTriggerForOwner: () => null,
    fireQueueOwner: () => assert.fail('this fixture uses Loop; ordinary cards may not be sent'),
    getLoopPrompt: q => queue.isLoopPromptActive(q) ? { id: 'loop', text: q.loopPromptText } : null,
    beginValidatedQueueSend: (owner, trigger, prompt, label, kind, cause) => {
      assert.ok(cause, 'provider leaf never accepts a synthetic cause');
      messages.push({ owner, trigger, label, kind, cause }); context.queueSendInflight.add(owner); return true;
    },
  });
  vm.runInContext(runnerCode, context);
  const unsubscribe = registry.subscribeOrchestrationRunChanges(change => releases.push(change));
  const unsubNatural = context.subscribeNatural(), unsubTimers = context.subscribeTimers();
  t.after(() => {
    unsubNatural(); unsubTimers(); unsubscribe(); queue.flushPromptQueueStoreSync();
    if (original === undefined) delete global.window; else global.window = original;
    t.mock.timers.reset();
  });
  const event = value => events.get('orchestration:changed').forEach(fn => fn(null, { run: value }));
  const outcome = (extra = {}) => {
    const at = extra.outcomeTs ?? 1300; t.mock.timers.setTime(Math.max(Date.now(), at));
    context.outcome({ tabId: P, sessionId: S, turnId: 'own-final', reason: 'task_complete', outcomeTs: at, ...extra }, 'codex-live', at);
  };
  return { context, controls, saved, event, outcome, messages, releases, warnings, retries, timerWakes, evaluated, logs, registry,
    state: () => queue.usePromptQueueStore.getState(),
    unblockHydration: async () => { releaseList(initialRuns); await hydration; },
    restoreQueue: async () => { queue.flushPromptQueueStoreSync(); queue = load(queueBundle, 'cancel-restored-queue');
      await queue.hydratePromptQueueStore(); context.usePromptQueueStore = queue.usePromptQueueStore; },
  };
}

for (const mode of ['all-work', 'own-turn']) for (const status of ['queued', 'running']) {
  test(`${mode}/${status}: intentional cancel preserves Loop and busy, then ONE real final`, async t => {
    const h = await fixture(t, { mode }); h.event(run({ status }));
    const before = JSON.stringify(h.state().getQueue(P));
    h.event(cancelled());
    assert.equal(h.context.prevBusyRef.get(P), true, 'cancel does not publish parent idle');
    assert.equal(JSON.stringify(h.state().getQueue(P)), before, 'authored queue/Loop flags and arm unchanged');
    assert.equal(h.releases.at(-1).releaseKind, 'dependency-cancelled');
    assert.equal(h.warnings.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.retries.length, 0);
    assert.equal(h.context.processedNaturalOutcomes.size, 0); assert.equal(h.context.latestLoopCauseByOwner.size, 0);
    assert.equal(h.evaluated.length, 0, 'cancel is not a cold-start success');
    h.context.prevBusyRef.set(P, false); h.outcome(); h.outcome(); h.event(cancelled());
    assert.equal(h.messages.length, 1); assert.match(h.messages[0].cause, /own-final/);
    assert.doesNotMatch(h.messages[0].cause, /review/); assert.equal(h.state().getQueue(P).loopPromptEnabled, true);
  });
}

for (const mode of ['all-work', 'own-turn']) test(`${mode}: cancel on idle without own final cannot invent a completion`, async t => {
  const h = await fixture(t, { mode, busy: false }); h.event(run()); h.event(cancelled());
  assert.equal(h.state().getQueue(P).loopPromptEnabled, true); assert.equal(h.warnings.length, 0);
  assert.equal(h.messages.length, 0); assert.equal(h.context.processedNaturalOutcomes.size, 0);
  assert.equal(h.context.latestLoopCauseByOwner.size, 0); assert.equal(h.context.prevBusyRef.get(P), false);
});

test('last cancellation releases only the already saved exact natural outcome once', async t => {
  const h = await fixture(t, { busy: false }); h.event(run()); h.event(run({ runId: 'second' }));
  h.outcome({ outcomeTs: 1100, turnId: 'earlier-proven-final' }); assert.equal(h.messages.length, 0);
  h.event(cancelled()); assert.equal(h.messages.length, 0, 'another dependency remains');
  h.event(cancelled({ runId: 'second' })); h.event(cancelled({ runId: 'second' }));
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].cause, /1100:earlier-proven-final/);
  assert.equal(h.context.deferredOrchestrationNaturalOutcomes.size, 0);
  assert.equal(h.warnings.length, 0); assert.equal(h.evaluated.length, 0);
});

test('own-turn review already queued before cancellation does not acquire a second prompt', async t => {
  const h = await fixture(t, { mode: 'own-turn', busy: false }); h.event(run());
  h.outcome({ outcomeTs: 1100 }); assert.equal(h.messages.length, 1);
  h.event(cancelled()); h.event(cancelled()); h.outcome({ outcomeTs: 1100 });
  assert.equal(h.messages.length, 1); assert.equal(h.state().getQueue(P).loopPromptEnabled, true);
});

test('newer busy parent keeps an older natural outcome deferred until its real new final', async t => {
  const h = await fixture(t, { busy: false }); h.event(run()); h.outcome({ outcomeTs: 1100, turnId: 'old-final' });
  h.context.prevBusyRef.set(P, true); h.event(cancelled());
  assert.equal(h.messages.length, 0); assert.equal(h.context.deferredOrchestrationNaturalOutcomes.size, 1);
  h.context.deferredOrchestrationNaturalOutcomes.delete(P); // existing authoritative busy-start cleanup, controlled lifecycle leaf
  h.context.prevBusyRef.set(P, false); h.outcome({ outcomeTs: 1400, turnId: 'new-final' });
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].cause, /new-final/);
});

test('newer arm rejects the older deferred final while retaining ON', async t => {
  const h = await fixture(t, { busy: false }); h.event(run()); h.outcome({ outcomeTs: 1100 });
  t.mock.timers.setTime(1250); h.state().setLoopPromptEnabled(P, false); h.state().setLoopPromptEnabled(P, true);
  const epoch = h.state().getQueue(P).loopPromptEpoch; h.event(cancelled());
  assert.equal(h.messages.length, 0); assert.equal(h.state().getQueue(P).loopPromptEpoch, epoch);
  assert.equal(h.state().getQueue(P).loopPromptEnabled, true); assert.equal(h.warnings.length, 0);
  h.outcome({ outcomeTs: 1400, turnId: 'new-arm-final' }); assert.equal(h.messages.length, 1);
});

test('unknown parent state does not become idle through cancel or consume its saved final', async t => {
  const h = await fixture(t, { busy: false }); h.event(run()); h.outcome({ outcomeTs: 1100 });
  h.context.prevBusyRef.delete(P); h.event(cancelled());
  assert.equal(h.messages.length, 0); assert.equal(h.context.deferredOrchestrationNaturalOutcomes.size, 1);
  assert.equal(h.context.prevBusyRef.has(P), false);
});

test('foreign source cancellation cannot consume this parent outcome or change its Loop', async t => {
  const h = await fixture(t); h.event(run({ sourceTabId: 'other-source' }));
  const before = JSON.stringify(h.state().getQueue(P));
  h.event(cancelled({ sourceTabId: 'other-source' }));
  assert.equal(JSON.stringify(h.state().getQueue(P)), before); assert.equal(h.messages.length, 0);
  assert.equal(h.warnings.length, 0); assert.equal(h.context.prevBusyRef.get(P), true);
});

test('cancellation only revalidates already prepared matching continuations, never fabricates one', async t => {
  const h = await fixture(t, { busy: false }); h.event(run());
  h.context.deferredOwnerSends.set(P, { triggerTabId: P, handoffId: 'existing-own-H', causeKey: 'proven-own-natural' });
  h.context.deferredOwnerSends.set('pivot-owner', { triggerTabId: P, handoffId: 'existing-pivot-H' });
  h.context.deferredOwnerSends.set('unrelated', { triggerTabId: 'unrelated-target', handoffId: 'untouched-H' });
  h.event(cancelled());
  assert.deepEqual(h.retries.map(value => value[0]), [P, 'pivot-owner']);
  assert.equal(h.messages.length, 0, 'retry port does not replace the existing readiness/receipt owner');
  assert.equal(h.context.latestLoopCauseByOwner.size, 0); assert.equal(h.context.processedNaturalOutcomes.size, 0);
  assert.equal(h.context.deferredOwnerSends.get('unrelated').handoffId, 'untouched-H');
});

test('ordinary successful release still waits for a busy parent then uses its natural final', async t => {
  const h = await fixture(t); h.event(run());
  h.event(run({ status: 'completed', resultComplete: true, completedAt: 1200, updatedAt: 1200, notificationStatus: 'sent' }));
  assert.equal(h.releases.at(-1).releaseKind, 'success'); assert.equal(h.messages.length, 0);
  assert.equal(h.state().getQueue(P).loopPromptEnabled, true); assert.equal(h.warnings.length, 0);
  h.context.prevBusyRef.set(P, false); h.outcome(); assert.equal(h.messages.length, 1);
});

test('real callback handoff discards the earlier deferred final and awaits callback natural end', async t => {
  const h = await fixture(t, { busy: false });
  const pending = run({ status: 'completed', resultComplete: true, notificationStatus: 'sent', sourceFollowupPending: true });
  h.event(pending); h.outcome({ outcomeTs: 1100, turnId: 'pre-callback-final' });
  assert.equal(h.messages.length, 0); assert.equal(h.context.deferredOrchestrationNaturalOutcomes.size, 1);
  h.context.prevBusyRef.set(P, true);
  h.event({ ...pending, updatedAt: 1250, sourceFollowupStartedAt: 1250 });
  assert.equal(h.releases.at(-1).releaseKind, 'handoff-started');
  assert.equal(h.context.deferredOrchestrationNaturalOutcomes.size, 0); assert.equal(h.messages.length, 0);
  h.context.prevBusyRef.set(P, false); h.outcome({ outcomeTs: 1400, turnId: 'callback-final' }); h.outcome({ outcomeTs: 1400, turnId: 'callback-final' });
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].cause, /callback-final/);
});

for (const [name, mutate] of [
  ['input UNKNOWN/FIFO', h => { h.controls.priorInput = true; }],
  ['manual Stop in progress', h => h.context.queueManualStopping.add(P)],
  ['shutdown', h => { h.context.queueShutdownPending = true; }],
  ['Goal', h => { h.controls.goal = true; }],
  ['install floor', h => { h.controls.installFloor = 1500; }],
]) test(`${name}: cancellation preserves ON but cannot bypass the existing input guard`, async t => {
  const h = await fixture(t); h.event(run()); mutate(h); h.event(cancelled());
  h.context.prevBusyRef.set(P, false); h.outcome();
  assert.equal(h.state().getQueue(P).loopPromptEnabled, true); assert.equal(h.messages.length, 0);
});

test('queue Stop/Close configuration and cards remain unchanged by dependency cancellation', async t => {
  const h = await fixture(t); h.state().addPrompt(P, 'authored step');
  h.state().setAutoRun(P, true); h.state().setStopAfter(P, true); h.state().setCloseAfter(P, true);
  h.event(run()); const before = JSON.stringify(h.state().getQueue(P)); h.event(cancelled());
  assert.equal(JSON.stringify(h.state().getQueue(P)), before); assert.equal(h.warnings.length, 0);
  assert.equal(h.messages.length, 0); assert.equal(h.evaluated.length, 0);
});

test('hydration tombstone wins stale initial running list without disarming a restored Loop', async t => {
  const h = await fixture(t, { delayed: true, initialRuns: [run()] });
  h.controls.hydrated = false; h.event(run()); h.event(cancelled());
  assert.equal(h.context.restoredAbnormal, undefined, 'cancel is not deferred as a parent failure');
  await h.unblockHydration(); h.controls.hydrated = true;
  assert.equal(h.registry.useOrchestrationStore.getState().activeRuns.size, 0);
  await h.restoreQueue(); assert.equal(h.state().getQueue(P).loopPromptEnabled, true);
  h.context.prevBusyRef.set(P, false); h.outcome(); h.outcome(); assert.equal(h.messages.length, 1);
});

for (const mode of ['all-work', 'own-turn']) test(`${mode}: queue restart and duplicate/late release preserve ON and one later input`, async t => {
  const h = await fixture(t, { mode }); h.event(run()); h.event(cancelled());
  const epoch = h.state().getQueue(P).loopPromptEpoch; await h.restoreQueue();
  assert.equal(h.state().getQueue(P).loopPromptEnabled, true); assert.equal(h.state().getQueue(P).loopPromptMode, mode);
  assert.equal(h.state().getQueue(P).loopPromptEpoch, epoch);
  h.event(cancelled()); h.event(cancelled({ sourceFollowupStartedAt: 1250, updatedAt: 1250 }));
  assert.equal(h.messages.length, 0); h.context.prevBusyRef.set(P, false); h.outcome(); h.outcome();
  assert.equal(h.messages.length, 1); assert.equal(h.warnings.length, 0);
});

test('unknown accepted input pointer survives restart and cannot be replayed by cancellation', async t => {
  const h = await fixture(t); h.event(run());
  h.state().setPendingDelivery(P, { version: 1, kind: 'loop', itemId: 'loop', handoffId: 'same-H',
    baseHandoffId: 'same-base-H', operationKey: 'same-O', triggerTabId: P, triggerKey: 'same-trigger',
    conditionKey: 'same-condition', createdAt: 1100, causeKey: 'same-natural' });
  h.event(cancelled()); await h.restoreQueue();
  assert.equal(h.state().getQueue(P).pendingDelivery.handoffId, 'same-H');
  h.context.prevBusyRef.set(P, false); h.outcome(); assert.equal(h.messages.length, 0);
});

for (const change of [
  { status: 'failed', outcome: 'failed', completionReason: 'provider-error' },
  { completionReason: 'target-closed' },
  { completionReason: null, outcome: 'unknown' },
  { outcome: 'unknown' },
  { outcome: 'failed' },
]) test(`genuine abnormal retained: ${JSON.stringify(change)}`, async t => {
  const h = await fixture(t); h.event(run()); h.event(cancelled(change));
  assert.equal(h.releases.at(-1).releaseKind, 'abnormal');
  assert.equal(h.state().getQueue(P).loopPromptEnabled, false); assert.equal(h.warnings.length, 1);
  assert.equal(h.messages.length, 0);
});

test('failed/unknown notification delivery remains blocking instead of a neutral cancellation', async t => {
  const h = await fixture(t); h.event(run());
  h.event(cancelled({ notificationStatus: 'failed', notificationSuppressed: false }));
  assert.equal(h.registry.isOrchestrationCompletionBlocked(P), true);
  assert.equal(h.releases.at(-1).releaseKind, null); assert.equal(h.messages.length, 0);
});

test('unknown delivery remains a blocking dependency, not a neutral cancel', async t => {
  const h = await fixture(t); h.event(run({ deliveryTransportUnknownAt: 1100 }));
  assert.equal(h.registry.isOrchestrationCompletionBlocked(P), true);
  h.context.prevBusyRef.set(P, false); h.outcome(); assert.equal(h.messages.length, 0);
  assert.equal(h.state().getQueue(P).loopPromptEnabled, true); assert.equal(h.releases.at(-1).releaseKind, null);
});

test('genuine old failure cannot disarm a newer manually armed Loop', async t => {
  const h = await fixture(t); h.event(run());
  t.mock.timers.setTime(1250); h.state().setLoopPromptEnabled(P, false); h.state().setLoopPromptEnabled(P, true);
  const before = JSON.stringify(h.state().getQueue(P));
  h.event(run({ status: 'failed', completedAt: 1200, updatedAt: 1300 }));
  assert.equal(h.releases.at(-1).releaseKind, 'abnormal');
  assert.equal(JSON.stringify(h.state().getQueue(P)), before); assert.equal(h.warnings.length, 0);
});

for (const reason of ['manual-stop', 'turn_aborted', 'codex-no-final-result', 'watchdog']) {
  test(`native ${reason} keeps its existing separate queue policy`, async t => {
    const h = await fixture(t); h.context.abnormal({ tabId: P, busy: false, reason, outcomeTs: 1200 }, 'controlled-native');
    const preserve = ['manual-stop', 'turn_aborted'].includes(reason);
    assert.equal(h.state().getQueue(P).loopPromptEnabled, preserve);
    assert.equal(h.warnings.length, preserve ? 0 : 1); assert.equal(h.messages.length, 0);
  });
}
