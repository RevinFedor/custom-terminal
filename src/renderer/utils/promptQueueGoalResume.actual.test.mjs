import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { buildPromptQueueReceiptHandoffId } from './promptQueueReceiptIdentity.mjs';

const source = fs.readFileSync(new URL('../hooks/usePromptQueueRunner.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
const names = ['getContinuationPrompt', 'continuationArmTimestamp', 'continuationTriggerTabId',
  'continuationAttemptIsCurrent', 'deferredOwnerAttemptIsCurrent', 'clearDeferredOwnerSend',
  'clearDeferredOwnerAttempt', 'withPostPrompt', 'beginValidatedQueueSend', 'readPromptQueueSendAdmission'];
const code = ts.transpileModule(names.map(name => {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(tree).replace(/^export /, '');
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };

function harness() {
  const head = { id: 'head', text: 'original body', enabled: true, trigger: { kind: 'app-restart', armedInstanceId: 'old' } };
  const queue = { items: [head], autoRun: true, workflowArmedAt: 100, workflowOutcomeFloorAt: null,
    postPromptEnabled: true, postPromptText: 'post', runAfterTabId: null };
  const pending = new Map(), busy = new Set(), inflight = new Set(), waitingBusy = new Set();
  const sends = [], cards = [], cancels = [], errors = [], subscribers = new Set();
  let pausedPrep, prepCount = 0, preparedBusy = true, status = 'inactive', hydrated = true, locked = false;
  const state = { getQueue: () => queue, setAutoRun: (_id, value) => { queue.autoRun = value; },
    commitSentPrompt: () => { queue.items.shift(); return { removed: true, beforeCount: 1 }; } };
  const context = vm.createContext({ AbortController, console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
    usePromptQueueStore: { getState: () => state, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); } },
    useUIStore: { getState: () => ({ showToast() {} }) },
    queueSendInflight: inflight, deferredOwnerSends: pending, queueAwaitingBusyStart: waitingBusy,
    queueReadinessWakePending: new Map(), queueEditorBlockedOwners: new Set(), queueSendAttemptSequence: 0,
    isTabWorkflowBlocked: id => busy.has(id), isPromptQueueEditorLocked: () => locked,
    isQueuedPromptEnabled: item => item.enabled !== false, getEffectiveQueueTrigger: () => 'T',
    queuedPromptContextConditionKey: () => '', queueItemTriggerCanFire: () => true,
    dictationBlocksSend: () => false, readQueueOwnerReadiness: async () => ({ ready: status === 'active', status, inputReady: status === 'active', reason: 'fixture' }),
    getPromptQueueAgent: () => 'codex', getHistoryAgentRuntime: () => ({ toolType: 'codex' }),
    getAgentSendProviderContract: () => ({}), getPromptQueueSessionId: () => 'S', getTabCwd: () => '/private-fixture',
    subscribePromptQueueEditorLocks: () => () => {}, signalContinuationRelease() {},
    prepareAgentRuntimeForSend: async ({ admissionSignal }) => {
      prepCount++;
      if (pausedPrep) await pausedPrep;
      if (admissionSignal.aborted) throw Object.assign(Error('cancelled'), { cancelled: true, submitted: false });
      // Exact regression: own Resume updates freshness, NOT the user's arm.
      queue.workflowOutcomeFloorAt = 200;
      for (const subscriber of subscribers) subscriber();
      return { submitCapability: preparedBusy ? 'queue' : 'direct', status: preparedBusy ? 'busy' : 'active',
        presence: { inputReady: true }, expectedTarget: { toolType: 'codex', sessionId: 'S' } };
    },
    ensureQueuedPromptImagesReady: async () => ({ ready: true, item: head }),
    buildQueuedPromptPayload: item => item.text, serializeComposerDraft: draft => draft.text,
    buildPromptQueueReceiptHandoffId, prepareTabWorkContext: async (_tab, _id, prompt) => ({ prompt, prefix: '' }),
    countEnabledQueuedPrompts: items => items.length, isStandaloneAgentLocalCommand: () => false,
    beginHistoryPromptHandoff: value => cards.push(value), historyPromptHandoffInitialStatus: () => 'preparing',
    sendQueueCommand: async (...args) => { sends.push(args); return { success: false, submitted: false, deferred: true }; },
    promptQueueReceiptReplayNeedsNoBusyStart: () => false, projectAgentLocalCommandSendResult: () => ({ handled: false }),
    queueSendTransferredOwnership: () => false, retractHistoryPromptHandoff() {}, settleHistoryPromptHandoff() {},
    settleTabWorkContext: async () => {}, retryDeferredOwnerSend() {},
    ipcRenderer: { invoke: async (...args) => { cancels.push(args); } },
    canProcessWorkflowOutcomes: () => hydrated, tabExists: () => true,
    enabledQueueHead: q => q.items.find(item => item.enabled !== false),
  });
  vm.runInContext(code, context);
  return { context, queue, head, sends, cards, cancels, errors, pending, busy, inflight, prepCount: () => prepCount,
    fire: () => context.beginValidatedQueueSend('T', 'T', head, 'cold-start'),
    setStatus: value => status = value, setHydrated: value => hydrated = value, setLocked: value => locked = value,
    setPreparedBusy: value => preparedBusy = value,
    hold: () => { let release; pausedPrep = new Promise(r => { release = r; }); return release; },
    change: fn => { fn(); for (const subscriber of subscribers) subscriber(); },
    request: () => ({ tabId: 'T', provider: 'codex', cwd: '/private-fixture', expectedTarget: { sessionId: 'S' },
      handoffId: buildPromptQueueReceiptHandoffId({ kind: 'queue', itemId: head.id, payload: head.text + '\n\npost', causeKey: null }),
      intent: { version: 1, kind: 'queue', itemId: head.id, armedAt: 100, triggerTabId: 'T', conditionKey: '', triggerKey: JSON.stringify(head.trigger) } }),
  };
}

test('actual Root cold Resume yielding busy preserves head and arm without creating a Send/card', async () => {
  const h = harness(); assert.equal(h.fire(), true); await tick();
  assert.deepEqual(h.errors, []);
  assert.equal(h.prepCount(), 1); assert.equal(h.queue.workflowArmedAt, 100);
  assert.equal(h.queue.workflowOutcomeFloorAt, 200);
  assert.equal(h.pending.has('T'), true); assert.equal(h.queue.autoRun, true);
  assert.equal(h.sends.length, 0); assert.equal(h.cards.length, 0);
  h.setStatus('active'); assert.equal(h.fire(), true); await tick();
  assert.deepEqual(h.errors, []);
  assert.equal(h.sends.length, 1); assert.equal(h.sends[0][1], 'original body\n\npost');
  assert.equal(h.sends[0][2].promptQueueIntent.armedAt, 100);
});

test('Pause/head/trigger/arm changes during own preparation abort before any handoff', async () => {
  for (const mutate of [h => h.queue.autoRun = false, h => h.head.id = 'new',
    h => h.queue.workflowArmedAt = 300, h => h.head.trigger = { kind: 'timer', seconds: 5 }]) {
    const h = harness(), release = h.hold(); h.fire(); await tick();
    h.change(() => mutate(h)); release(); await tick();
    assert.equal(h.sends.length, 0); assert.equal(h.cards.length, 0); assert.equal(h.pending.has('T'), false);
  }
});

test('restored Main admission checks same body/Post/head/arm/owner and waits for hydration/editor/children', () => {
  const h = harness(), request = h.request(), read = () => h.context.readPromptQueueSendAdmission(request);
  assert.equal(read().ready, true);
  h.setHydrated(false); assert.equal(read().ready, false); h.setHydrated(true);
  h.setLocked(true); assert.equal(read().ready, false); h.setLocked(false);
  h.busy.add('T'); assert.equal(read().ready, false); h.busy.clear();
  for (const mutate of [x => x.queue.autoRun = false, x => x.head.text = 'edited', x => x.queue.postPromptText = 'changed',
    x => x.queue.workflowArmedAt = 300, x => x.head.id = 'different']) {
    const x = harness(), old = x.request(); mutate(x); assert.equal(x.context.readPromptQueueSendAdmission(old).cancel, true);
  }
  request.expectedTarget.sessionId = 'foreign'; assert.equal(read().cancel, true);
});
