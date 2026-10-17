import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { enqueueAgentSendScenario, pendingAgentSendScenarioCount, subscribeAgentSendScenarios } from './agentSendSequencer.mjs';
const runnerPath = new URL('../hooks/usePromptQueueRunner.ts', import.meta.url);
const current = fs.readFileSync(runnerPath, 'utf8');
const baseline = process.env.QUEUE_INPUT_BASELINE
  ? execFileSync('git', ['show', process.env.QUEUE_INPUT_BASELINE + ':src/renderer/hooks/usePromptQueueRunner.ts'], { encoding: 'utf8' }) : current;
function declaration(source, name) {
  const tree = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(tree).replace(/^export /, '');
}
const handoffs = fs.readFileSync(new URL('./historyPromptHandoffs.ts', import.meta.url), 'utf8');
const code = ts.transpileModule([
  declaration(current, 'hasPriorWorkflowInput'), declaration(current, 'subscribeWorkflowInputRelease'),
  declaration(baseline, 'isTabWorkflowBlocked'),
  declaration(handoffs, 'selectLatestHistoryPromptInputStatus'), declaration(handoffs, 'historyPromptHandoffBlocksNewSubmit'),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));

// Actual Runner gate and release subscriptions + actual Send sequencer/status
// predicate. Store publication/runtime/IPC are explicit controlled ports.
function fixture() {
  let snapshot = [];
  const listeners = new Set(), queueListeners = new Set(), wakes = [];
  const queue = { autoRun: true, items: [{ id: 'head', text: '/compact', enabled: true }] };
  const c = vm.createContext({ queueMicrotask, console,
    pendingAgentSendScenarioCount, subscribeAgentSendScenarios,
    getHistoryPromptHandoffsSnapshot: () => snapshot,
    subscribeHistoryPromptHandoffs: (_id, fn) => { listeners.add(fn); fn(snapshot); return () => listeners.delete(fn); },
    usePromptQueueStore: { getState: () => ({ queues: new Map([['T', queue]]) }),
      subscribe: fn => { queueListeners.add(fn); return () => queueListeners.delete(fn); } },
    getEffectiveQueueTrigger: () => 'T', isLoopPromptActive: () => false,
    deferredOwnerSends: new Map(), queueShutdownPending: false, queueManualStopping: new Set(),
    autoCompactCoordinator: null, prevBusyRef: new Map(), isOrchestrationCompletionBlocked: () => false,
    promptTabTriggerReady: () => true, hasPendingAgentGoalWork: () => false,
    useWorkspaceStore: { getState: () => ({ openProjects: new Map() }) },
  });
  vm.runInContext(code, c);
  return { c, queue, wakes, listeners, queueListeners,
    blocked: item => c.isTabWorkflowBlocked('T', item),
    publish: rows => { snapshot = rows; for (const fn of listeners) fn(snapshot); },
    observe: () => c.subscribeWorkflowInputRelease(id => wakes.push(id)),
  };
}
const row = (queueStatus, patch = {}) => ({ handoffId: 'manual', submittedAt: 1,
  statusChangedAt: 1, queueStatus, ...patch });

for (const state of ['preparing', 'application-queued', 'sending', 'audit-pending', 'queued']) {
  test('Run After cannot overtake an earlier ' + state + ' input before own busy begins', () => {
    const h = fixture(); h.publish([row(state)]);
    assert.equal(h.blocked(), true);
    assert.equal(h.queue.items[0].text, '/compact'); assert.equal(h.queue.autoRun, true);
    assert.equal(h.blocked({ trigger: { kind: 'onTab', dependencies: [{}] } }), false,
      'an already completed foreign dependency is not rearmed by its newer input; owner is checked separately');
  });
}

test('actual readiness scenario blocks Run After even before its History row exists', async () => {
  const h = fixture(); let release;
  const send = enqueueAgentSendScenario({ tabId: 'T', handoffId: 'starting', run: () => new Promise(resolve => { release = resolve; }) });
  await tick(); assert.equal(h.blocked(), true); release({ submitted: false }); await send; await tick();
  assert.equal(h.blocked(), false);
});

test('own admitted automatic head and later manual FIFO successor do not create self-deadlock', () => {
  const h = fixture(); h.c.deferredOwnerSends.set('T', { handoffId: 'own' });
  h.publish([row('sending', { handoffId: 'own', submittedAt: 2, applicationQueuePosition: 20 }),
    row('application-queued', { submittedAt: 3, applicationQueuePosition: 21 })]);
  assert.equal(h.blocked(), false);
  h.publish([row('sending', { handoffId: 'own', submittedAt: 2 }), row('audit-pending')]);
  assert.equal(h.blocked(), true, 'an actual older input is still protected');
});

test('delivery confirmation is not whole-turn completion; provider busy still blocks', () => {
  const h = fixture(); h.publish([row('sent')]); h.c.prevBusyRef.set('T', true);
  assert.equal(h.blocked(), true); h.c.prevBusyRef.set('T', false); assert.equal(h.blocked(), false);
});

test('failed pre-input release wakes the existing arm; sent and unknown do not manufacture completion', async () => {
  const h = fixture(); h.publish([row('sending')]); const stop = h.observe();
  h.publish([row('audit-pending')]); h.publish([row('sent')]); await tick(); assert.deepEqual(h.wakes, []);
  h.publish([row('sending')]); h.publish([row('delivery-unknown')]); await tick(); assert.deepEqual(h.wakes, []);
  h.publish([row('failed')]); await tick(); assert.deepEqual(h.wakes, ['T']);
  stop(); assert.equal(h.listeners.size, 0); assert.equal(h.queueListeners.size, 0);
});

test('unmount cancels a queued release callback and retires every subscription', async () => {
  const h = fixture(); h.publish([row('sending')]); const stop = h.observe();
  h.publish([row('failed')]); stop(); await tick(); assert.deepEqual(h.wakes, []);
  assert.equal(h.listeners.size, 0); assert.equal(h.queueListeners.size, 0);
});
