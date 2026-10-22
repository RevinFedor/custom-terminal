'use strict';
// Actual Root consumer + Loop send selector + queue store. Native delivery,
// workspace/runtime/compact leaves are controlled; no provider or Electron app.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript'), esbuild = require('esbuild');
const current = path.resolve(__dirname, '../hooks/usePromptQueueRunner.ts');
function declaration(file, name) {
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let result;
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(tree);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(tree) === name)) result = node.getText(tree);
    ts.forEachChild(node, walk);
  }
  walk(tree); assert.ok(result, name); return result;
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-root-')), outfile = path.join(root, 'store.cjs');
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const persisted = new Map();
  await esbuild.build({ entryPoints: [path.resolve(__dirname, '../store/usePromptQueueStore.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  global.window = { require: () => ({ ipcRenderer: { on() {}, removeListener() {},
    invoke: async (name, value) => {
      if (name === 'ai-prompts:get') return { success: true, data: [{ id: 'run-after-loop', content: 'Check the whole original plan' }] };
      if (name === 'ai-prompts:save-content') return { success: true };
      if (name === 'app:getState') return persisted.get(value);
      if (name === 'app:setState') { persisted.set(value.key, value.value); return { success: true }; }
      throw Error('unexpected IPC: ' + name);
    }, sendSync: (_name, value) => { persisted.set(value.key, value.value); return { success: true }; } } }) };
  t.after(() => { delete global.window; t.mock.timers.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  let store = require(outfile); await store.hydratePromptQueueStore(); store.usePromptQueueStore.getState().setLoopPromptEnabled('P', true, 'own-turn');
  const { choosePromptQueueContinuationForOutcome } = await import('./promptQueueReconciliation.mjs');
  const { normalizeAgentTurnEndReason, isNaturalAgentTurnEndReason } = await import('./agentCompletionOutcome.mjs');
  const controls = { orchestration: true, loopOrchestration: false, wait: false, priorInput: false, goal: false, installFloor: 0 };
  const messages = [], inflight = new Set();
  const context = vm.createContext({ Map, Set, Number, Date, console: { log() {}, warn() {} },
    usePromptQueueStore: store.usePromptQueueStore, isLoopPromptActive: store.isLoopPromptActive,
    loopPromptMode: store.loopPromptMode,
    promptQueueOutcomeFloor: store.promptQueueOutcomeFloor, promptQueueContextWasSkipped: store.promptQueueContextWasSkipped,
    countEnabledQueuedPrompts: store.countEnabledQueuedPrompts, setPromptQueueContextSkipped: store.setPromptQueueContextSkipped,
    normalizeAgentTurnEndReason, isNaturalAgentTurnEndReason, choosePromptQueueContinuationForOutcome,
    isOrchestrationCompletionBlocked: () => controls.orchestration,
    isLoopOrchestrationBlocked: () => controls.loopOrchestration, loopDependenciesBlock: () => controls.wait,
    buildInstallContinuationFloor: () => controls.installFloor,
    hasPendingAgentGoalWork: value => value.goalWork?.pending === true,
    hasPriorWorkflowInput: () => controls.priorInput, queueShutdownPending: false, queueManualStopping: new Set(),
    autoCompactCoordinator: null, prevBusyRef: new Map([['P', false]]), promptTabTriggerReady: () => false,
    useWorkspaceStore: { getState: () => ({ openProjects: new Map([['W', { tabs: new Map([['P', { codexGoalWork: { pending: controls.goal } }]]) }]]) }) },
    loopNaturalCausesByOwner: new Map(), latestLoopCauseByOwner: new Map(), processedNaturalOutcomes: new Map(),
    deferredOrchestrationNaturalOutcomes: new Map(), deferredContinuationPivotReleases: new Map(),
    queueSendInflight: inflight, queueAwaitingBusyStart: new Set(), autoCompactTurnStarts: new Map(),
    coordinator: { intercept: () => false }, findOwnersWaitingOn: () => [], queueOwnerHasPendingContinuationAt: () => false,
    getEffectiveQueueTrigger: () => 'P', hasRuntimeWorkflowArm: () => false, getReadyTriggerForOwner: () => null,
    getPromptQueueAgent: () => 'codex', getPromptQueueSessionId: () => 'S',
    describeQueuesForTriggerLog: () => '', shortQueueTabId: value => value, getTabName: () => 'parent',
    useUIStore: { getState: () => ({ showToast() {} }) }, fireQueueOwner: () => assert.fail('ordinary queue must not bypass inherited gate'),
    getLoopPrompt: q => store.isLoopPromptActive(q) ? { id: 'loop', text: q.loopPromptText } : null,
    beginValidatedQueueSend: (_owner, _trigger, prompt, _label, kind, cause) => {
      assert.equal(kind, 'loop'); inflight.add('P'); messages.push({ prompt, cause }); return true;
    },
  });
  const file = process.env.LOOP_REVIEW_OLD_ROOT || current;
  const names = ['naturalOutcomeKey', 'isTabWorkflowBlocked', 'processSuccessfulWorkflowOutcome', 'fireLoopOwner'];
  const code = ts.transpileModule(names.map(name => declaration(file, name)).join('\n')
    + '\nglobalThis.outcome = processSuccessfulWorkflowOutcome;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(code, context);
  return { controls, messages, context, persisted, get module() { return store; },
    outcome: (extra = {}) => context.outcome({ tabId: 'P', sessionId: 'S', turnId: 'own-T', reason: 'task_complete', outcomeTs: 1100, ...extra }, 'codex-live', extra.outcomeTs ?? 1100),
    restore: async () => { store.flushPromptQueueStoreSync(); delete require.cache[require.resolve(outfile)]; store = require(outfile); await store.hydratePromptQueueStore(); } };
}

test('own natural final sends ONE Loop chat check while external children still work', async t => {
  const h = await fixture(t); h.outcome(); h.outcome();
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].prompt.text, /whole original plan/);
  assert.equal(h.context.deferredOrchestrationNaturalOutcomes.size, 1, 'whole-work outcome remains deferred');
  assert.equal(h.context.processedNaturalOutcomes.size, 0, 'review does not settle whole work');
});
test('default ordinary Loop defers its check until all external work finishes', async t => {
  const h = await fixture(t);
  h.module.usePromptQueueStore.getState().setLoopPromptEnabled('P', true);
  h.outcome(); assert.equal(h.messages.length, 0, 'ordinary mode keeps the whole-work gate');
  h.controls.orchestration = false; h.controls.wait = true;
  h.outcome(); assert.equal(h.messages.length, 1, 'ordinary final does not wait on the other mode journal');
  h.outcome(); assert.equal(h.messages.length, 1, 'the same natural final cannot repeat');
});
for (const [name, mutate] of [
  ['waiting on declared dependency', h => { h.controls.wait = true; }],
  ['install/callback hold', h => { h.controls.loopOrchestration = true; }],
  ['input UNKNOWN/FIFO', h => { h.controls.priorInput = true; }],
  ['native Goal', h => { h.controls.goal = true; }],
  ['old final below both floors', h => { h.controls.installFloor = 1200; }],
  ['manual Stop', h => { h.context.queueManualStopping.add('P'); }],
  ['shutdown', h => { h.context.queueShutdownPending = true; }],
  ['newer busy turn', h => { h.context.prevBusyRef.set('P', true); }],
]) test(name + ' cannot send an early Loop prompt', async t => {
  const h = await fixture(t); mutate(h); h.outcome(); assert.equal(h.messages.length, 0);
});

test('ordinary Loop still runs with no orchestration; complete_task switches it OFF', async t => {
  const h = await fixture(t); h.module.usePromptQueueStore.getState().setLoopPromptEnabled('P', true);
  h.controls.orchestration = false; h.outcome(); assert.equal(h.messages.length, 1);
  h.context.queueSendInflight.clear(); h.outcome({ turnId: 'review-T', outcomeTs: 1200, explicitTaskComplete: true });
  assert.equal(h.module.usePromptQueueStore.getState().getQueue('P').loopPromptEnabled, false);
  assert.equal(h.messages.length, 1);
});

test('explicit Loop epoch survives restart/floor movement and changes only on rearm/text change', async t => {
  const h = await fixture(t), before = h.module.usePromptQueueStore.getState().getQueue('P').loopPromptEpoch;
  h.module.usePromptQueueStore.getState().suspendWorkflowsForRestart();
  h.module.usePromptQueueStore.getState().applyBuildInstallContinuationFloor('P', 1050);
  await h.restore();
  let s = h.module.usePromptQueueStore.getState();
  assert.equal(s.getQueue('P').loopPromptEpoch, before); assert.equal(s.getQueue('P').loopPromptEnabled, true);
  s.setLoopPromptEnabled('P', false); s.setLoopPromptEnabled('P', true);
  assert.notEqual(s.getQueue('P').loopPromptEpoch, before);
});
