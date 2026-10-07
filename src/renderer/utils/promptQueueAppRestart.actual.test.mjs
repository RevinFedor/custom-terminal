import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { appRestartTriggerIsSatisfied } from './promptQueueAppRestart.mjs';

const source = fs.readFileSync(new URL('../hooks/usePromptQueueRunner.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
function declaration(name) {
  let result;
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(tree) === name) {
      result = ts.isFunctionDeclaration(node) ? node.getText(tree) : 'const ' + node.getText(tree) + ';';
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(result, name);
  return result;
}
const code = ts.transpileModule([
  'let firing = false;',
  ...['enabledQueueHead', 'queueItemTriggerCanFire', 'queueDelaySeconds', 'queueUsesItemTimer',
    'fireHead', 'verifyCodexTriggerIdleThenFire', 'evaluateQueues'].map(declaration),
  'globalThis.evaluate = evaluateQueues;',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness({ provider = 'codex', instance = 'main-B', armedInstance = 'main-A', trigger = 'app-restart' } = {}) {
  const head = { id: 'restart-head', enabled: true, text: 'билд инстал выполнил', trigger: trigger === 'app-restart'
    ? { kind: trigger, armedInstanceId: armedInstance } : trigger === 'onTab' ? { kind: trigger, tabId: 'target' } : undefined };
  const queue = { items: [head, { id: 'compact', text: '/compact', condition: { kind: 'context-used', operator: 'gte', percent: 50 } }],
    autoRun: true, firstDelayCountdownAt: null, firstDelaySeconds: 0, runAfterTabId: null };
  const state = { queues: new Map([['owner', queue]]), getQueue: () => queue, cleanupClosedTab: () => assert.fail('owner exists') };
  const attempts = [], reads = [], timers = [], busy = new Set(), inflight = new Set(), prevBusy = new Map();
  let hydrated = true, runtimeArm = false, outcome = { busy: false, hasWatcher: false, outcomeKnown: false };
  const context = vm.createContext({ console: { log() {}, warn() {} }, JSON, Map, Set,
    appRestartTriggerIsSatisfied, queueAppRuntimeInstanceId: instance,
    usePromptQueueStore: { getState: () => state }, queueSendInflight: inflight, queueAwaitingBusyStart: new Set(),
    codexTriggerCheckInflight: new Set(), prevBusyRef: prevBusy,
    isQueuedPromptEnabled: item => item.enabled !== false,
    countEnabledQueuedPrompts: items => items.filter(item => item.enabled !== false).length,
    canProcessWorkflowOutcomes: () => hydrated, tabExists: () => true,
    hasRuntimeWorkflowArm: () => runtimeArm, getWorkspaceCommandType: () => provider,
    getEffectiveQueueTrigger: (_id, q) => q.items.find(item => item.enabled !== false)?.trigger?.tabId || 'owner',
    consumeAutomaticRunAfterTargetClear: () => false, clearTimer() {},
    isTabWorkflowBlocked: id => busy.has(id), isOrchestrationCompletionBlocked: id => busy.has(id),
    seedBusySnapshotFromWorkspace() {}, queueOwnerHasPendingContinuation: () => false,
    applyAbnormalQueueOutcome: () => assert.fail('no new abnormal outcome'),
    useWorkspaceStore: { getState: () => ({ setAiBusy() {} }) },
    ipcRenderer: { invoke: async (channel, id) => { reads.push({ channel, id }); return outcome; } },
    startFirstDelayCountdown: id => { timers.push(id); queue.firstDelayCountdownAt = 100; return true; },
    beginConditionAwareQueueSend: (owner, target, item, label) => {
      attempts.push({ owner, target, item, label }); inflight.add(owner); return true;
    },
  });
  vm.runInContext(code, context);
  return { queue, attempts, reads, timers, busy, inflight, prevBusy,
    evaluate: () => context.evaluate(state, state, { forceAppRestartTriggers: true }),
    setHydrated: value => hydrated = value, setArm: value => runtimeArm = value,
    setOutcome: value => outcome = value };
}

test('restored app-restart head enters the common send pipeline without a previous Codex outcome', async () => {
  for (const hasWatcher of [false, true]) {
    const h = harness(); h.setOutcome({ hasWatcher, busy: false, outcomeKnown: false });
    h.evaluate(); await tick();
    assert.equal(h.attempts.length, 1, 'new main lifetime supplies the trigger; readiness belongs to the common pipeline');
    assert.equal(h.attempts[0].item.id, 'restart-head');
    assert.equal(h.queue.items.length, 2, 'admission alone does not consume the head');
    h.evaluate(); await tick();
    assert.equal(h.attempts.length, 1, 'an in-flight readiness attempt is not admitted twice');
  }
});

test('same or unknown main identity and incomplete restoration cannot release a persisted restart head', async () => {
  for (const instance of ['main-A', null, '']) {
    const h = harness({ instance }); h.evaluate(); await tick(); assert.equal(h.attempts.length, 0);
  }
  const h = harness(); h.setHydrated(false); h.evaluate(); await tick(); assert.equal(h.attempts.length, 0);
  h.setHydrated(true); h.evaluate(); await tick(); assert.equal(h.attempts.length, 1);
});

test('ordinary restored own-tab and on-tab queues still need their natural completion', async () => {
  for (const trigger of ['ordinary', 'onTab']) {
    const h = harness({ trigger }); h.evaluate(); await tick(); assert.equal(h.attempts.length, 0, trigger);
  }
});

test('pause, disabled head, children and busy owner still block restart admission', async () => {
  for (const blocker of ['pause', 'disabled', 'busy', 'children']) {
    const h = harness();
    if (blocker === 'pause') h.queue.autoRun = false;
    if (blocker === 'disabled') h.queue.items[0].enabled = false;
    if (blocker === 'busy') h.prevBusy.set('owner', true);
    if (blocker === 'children') h.busy.add('owner');
    h.evaluate(); await tick(); assert.equal(h.attempts.length, 0, blocker);
    assert.equal(h.queue.items.length, 2, 'blocked admission preserves both cards');
  }
});

test('the restart trigger is provider-independent and keeps the remaining compact in its original position', async () => {
  for (const provider of ['codex', 'claude', 'gemini']) {
    const h = harness({ provider }); h.evaluate(); await tick(); assert.equal(h.attempts.length, 1, provider);
    h.queue.items.shift(); h.inflight.clear(); h.evaluate(); await tick();
    assert.equal(h.attempts.length, 1, 'the following card waits for its own trigger');
    assert.equal(h.queue.items[0].id, 'compact');
    assert.equal(h.queue.items[0].condition.percent, 50);
  }
});

test('a restored first delay still starts its countdown before restart admission', async () => {
  const h = harness(); h.queue.firstDelaySeconds = 60; h.evaluate(); await tick();
  assert.deepEqual(h.timers, ['owner']); assert.equal(h.attempts.length, 0);
});
