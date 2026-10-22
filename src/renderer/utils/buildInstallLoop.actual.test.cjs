'use strict';
// Actual Root outcome scheduler and persisted queue Store. Provider Send,
// workspace/catalog and compact UI leaves are controlled; no provider turn.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), esbuild = require('esbuild');
const { installContextFixture } = require('../../main/fixtures/build-install-posthook.cjs');
const runner = path.resolve(__dirname, '../hooks/usePromptQueueRunner.ts');
const tree = ts.createSourceFile(runner, fs.readFileSync(runner, 'utf8'), ts.ScriptTarget.Latest, true);
function declaration(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) found = 'const ' + node.getText(tree) + ';';
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(found, name); return found;
}
const code = ts.transpileModule(['naturalOutcomeKey', 'processSuccessfulWorkflowOutcome'].map(declaration).join('\n')
  + '\nglobalThis.outcome = processSuccessfulWorkflowOutcome;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('Loop ON survives context-bound install restart; actual Main natural final releases exactly ONE scheduler step', async t => {
  const epoch = Date.parse(process.env.INSTALL_LOOP_TEST_NOW || '2026-10-21T00:00:00Z');
  assert.ok(Number.isFinite(epoch), 'explicit controlled clock must be valid');
  t.mock.timers.enable({ apis: ['Date'], now: epoch });
  t.after(() => t.mock.timers.reset());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'install-loop-root-'));
  const outfile = path.join(root, 'queue.cjs'), persisted = new Map();
  const { choosePromptQueueContinuationForOutcome } = await import('./promptQueueReconciliation.mjs');
  const { normalizeAgentTurnEndReason, isNaturalAgentTurnEndReason } = await import('./agentCompletionOutcome.mjs');
  await esbuild.build({ entryPoints: [path.resolve(__dirname, '../store/usePromptQueueStore.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'silent' });
  global.window = { require: () => ({ ipcRenderer: { on() {}, removeListener() {},
    invoke: async (channel, body) => {
      if (channel === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: 'continue task' }] };
      if (channel === 'ai-prompts:save-content') return { success: true };
      if (channel === 'app:getState') return persisted.get(body);
      if (channel === 'app:setState') { persisted.set(body.key, body.value); return { success: true }; }
      throw Error('unexpected IPC ' + channel);
    }, sendSync: (_channel, body) => { persisted.set(body.key, body.value); return { success: true }; } } }) };
  t.after(() => { delete global.window; fs.rmSync(root, { recursive: true, force: true }); });
  let module = require(outfile); await module.hydratePromptQueueStore();
  module.usePromptQueueStore.getState().setLoopPromptEnabled('753', true);
  module.usePromptQueueStore.getState().suspendWorkflowsForRestart(); module.flushPromptQueueStoreSync();
  delete require.cache[require.resolve(outfile)]; module = require(outfile); await module.hydratePromptQueueStore();
  assert.equal(module.usePromptQueueStore.getState().getQueue('753').loopPromptEnabled, true);
  const armedAt = module.usePromptQueueStore.getState().getQueue('753').loopPromptArmedAt;
  const oldOutcomeAt = armedAt + 10, auditAt = armedAt + 20;
  t.mock.timers.setTime(auditAt);
  const backend = await installContextFixture(t, { auditAt });
  backend.restore();
  await backend.reconcile();
  let held = backend.blocked(), floor = 0;
  const callbackAt = backend.completedAt;
  assert.equal(Date.parse(backend.store.get(backend.operationKey).auditIdentity.auditTimestamp), auditAt);
  assert.ok(armedAt < oldOutcomeAt && oldOutcomeAt < auditAt && auditAt < callbackAt, 'arm < old final < audit floor < callback final');
  assert.equal(held, true); assert.ok(backend.reads.length > 0);
  const sends = [], deferred = new Map(), processed = new Map(), prevBusy = new Map();
  const context = vm.createContext({ console: { log() {}, warn() {} }, Map, Set, Number, Date,
    usePromptQueueStore: module.usePromptQueueStore, isLoopPromptActive: module.isLoopPromptActive,
    loopPromptMode: module.loopPromptMode,
    promptQueueOutcomeFloor: module.promptQueueOutcomeFloor, countEnabledQueuedPrompts: module.countEnabledQueuedPrompts,
    isOrchestrationCompletionBlocked: () => held, buildInstallContinuationFloor: () => floor,
    hasPendingAgentGoalWork: data => data.goalWork?.pending === true,
    normalizeAgentTurnEndReason, isNaturalAgentTurnEndReason, choosePromptQueueContinuationForOutcome,
    deferredOrchestrationNaturalOutcomes: deferred, processedNaturalOutcomes: processed,
    prevBusyRef: prevBusy, autoCompactTurnStarts: new Map(), latestLoopCauseByOwner: new Map(),
    queueSendInflight: new Set(), queueAwaitingBusyStart: new Set(), deferredContinuationPivotReleases: new Map(),
    coordinator: { intercept: () => false }, findOwnersWaitingOn: () => [], setPromptQueueContextSkipped() {},
    getPromptQueueAgent: () => 'codex', describeQueuesForTriggerLog: () => '', shortQueueTabId: value => value,
    // New Loop-review readers are controlled leaves here; this cohort proves
    // the unchanged install hold/floor, not external-wait admission.
    getPromptQueueSessionId: () => 'S', loopNaturalCausesByOwner: new Map(), isTabWorkflowBlocked: () => held,
    queueOwnerHasPendingContinuationAt: () => false, getEffectiveQueueTrigger: () => '753', hasRuntimeWorkflowArm: () => false,
    getReadyTriggerForOwner: () => null, fireQueueOwner: () => assert.fail('Loop has no queue cards'),
    fireLoopOwner: (tabId, cause) => sends.push({ tabId, cause }), useUIStore: { getState: () => ({ showToast() {} }) }, getTabName: () => 'source',
  });
  vm.runInContext(code, context);
  const outcome = (ts, turn = 'callback-turn', extra = {}) => {
    t.mock.timers.setTime(Math.max(Date.now(), ts)); // old delivery never moves the test clock backwards
    return context.outcome({ tabId: '753', reason: 'task_complete', outcomeTs: ts, turnId: turn, ...extra }, 'actual-live', ts);
  };
  outcome(oldOutcomeAt, 'install-accepted-turn'); assert.equal(sends.length, 0); assert.equal(processed.size, 0);
  outcome(auditAt); assert.equal(sends.length, 0, 'audited callback still lacks a natural final');
  assert.equal(module.usePromptQueueStore.getState().getQueue('753').loopPromptEnabled, true);
  t.mock.timers.setTime(callbackAt);
  backend.complete(); await backend.reconcile();
  floor = backend.read().entries[0].outcomeFloorAt; held = backend.blocked();
  assert.equal(held, false);
  assert.equal(floor, auditAt); assert.ok(oldOutcomeAt < floor && floor < callbackAt);
  outcome(oldOutcomeAt, 'install-accepted-turn'); assert.equal(sends.length, 0, 'old pre-install final never consumes Loop');
  prevBusy.set('753', true); outcome(callbackAt); assert.equal(sends.length, 0, 'actual continuation busy still waits');
  prevBusy.set('753', false); outcome(callbackAt); outcome(callbackAt);
  assert.equal(sends.length, 1); assert.match(sends[0].cause, /callback-turn/);
  assert.equal(module.usePromptQueueStore.getState().getQueue('753').loopPromptEnabled, true);
  // Existing Goal/Pause and explicit App completion semantics remain intact.
  outcome(callbackAt + 30, 'goal', { goalWork: { pending: true } }); assert.equal(sends.length, 1);
  module.usePromptQueueStore.getState().setLoopPromptEnabled('753', false);
  outcome(callbackAt + 40, 'paused'); assert.equal(sends.length, 1);
  module.usePromptQueueStore.getState().setLoopPromptEnabled('753', true);
  const next = Math.max(callbackAt + 50, module.usePromptQueueStore.getState().getQueue('753').loopPromptArmedAt + 50);
  outcome(next, 'ordinary-loop'); assert.equal(sends.length, 2, 'ordinary Loop continues without install hold');
  outcome(next + 10, 'explicit-complete', { explicitTaskComplete: true });
  assert.equal(module.usePromptQueueStore.getState().getQueue('753').loopPromptEnabled, false);
});
