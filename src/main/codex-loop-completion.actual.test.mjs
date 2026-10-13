import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { isNaturalAgentTurnEndReason, normalizeAgentTurnEndReason } from '../renderer/utils/agentCompletionOutcome.mjs';
import { choosePromptQueueContinuationForOutcome } from '../renderer/utils/promptQueueReconciliation.mjs';
import { hasPendingAgentGoalWork } from '../shared/agent-work-completion.mjs';

const require = createRequire(import.meta.url);
const { TaskCompletionIntentRegistry, taskCompletionOutcomeMeta } = require('./task-completion-intent');
const { codexProviderPreviewOwnerVerdict, codexProviderTerminalOutcomeVerdict } = require('./codex-provider-preview');
const main = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const runner = fs.readFileSync(new URL('../renderer/hooks/usePromptQueueRunner.ts', import.meta.url), 'utf8');
function declarations(source, names) {
  const tree = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const found = new Map();
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && names.includes(node.name?.getText(tree))) {
      found.set(node.name.getText(tree), ts.isFunctionDeclaration(node) ? node.getText(tree) : 'const ' + node.getText(tree) + ';');
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return names.map(name => { assert.ok(found.has(name), name); return found.get(name); }).join('\n');
}
const mainCode = declarations(main, ['currentCodexProviderSemanticOwnerContext', 'publishCodexProviderTurnActivity',
  'settleCodexProviderActivityFromWatcherOutcome', 'codexOutcomeTimestampMs', 'applyCodexWatcherAbnormalOutcome',
  'applyCodexWatcherOutcome', 'codexTurnStateSnapshot', 'registerTaskCompletionIntent', 'emitCodexBusy']);
const rendererCode = ts.transpileModule(declarations(runner, ['explicitOutcomeTimestamp', 'liveOutcomeTimestamp',
  'naturalOutcomeKey', 'processSuccessfulWorkflowOutcome', 'handleBusyState']) + '\nglobalThis.receive = handleBusyState("codex");',
{ compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness({ eligible = true, ordinaryQueue = false, providerActive = true, queueArmedAt = 1, runtimeOwnArm = false, holdCompact = false } = {}) {
  const terminal = {}, generation = 'launch-1', tabId = 'T', turnId = 'turn-1';
  const watcher = { tabId, sessionId: 'S', currentTurnId: turnId, busy: true, processGeneration: generation,
    lifecycleGeneration: generation, activeTaskCompletionProtocol: { eligible, source: eligible ? 'prompt-loop' : null } };
  const owner = { sourceId: 'provider-1', terminalToken: terminal, runSeq: 1, launchId: 'launch',
    lifecycleGeneration: generation, turnActive: providerActive, turnId, phase: 'provider-response' };
  const queue = { loopPromptEnabled: true, loopPromptText: 'check', loopPromptArmedAt: 1,
    autoRun: ordinaryQueue, items: ordinaryQueue ? [{ id: 'keep', text: 'queued' }] : [] };
  const registry = new TaskCompletionIntentRegistry();
  const events = [], activity = [], projected = [], fired = [], logs = [], toasts = [];
  const console = { log: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) };
  const prevBusyRef = new Map([[tabId, true]]);
  let compactContinuation;
  const renderer = vm.createContext({ console, Map, Set, Date, Number, JSON,
    queueShutdownPending: false, getPromptQueueAgent: () => 'codex', getWorkspaceCommandType: () => 'codex',
    prevBusyRef, autoCompactTurnStarts: new Map(), observedWorkflowStarts: new Set(), queueAwaitingBusyStart: new Set(),
    deferredOrchestrationNaturalOutcomes: new Map(), deferredContinuationPivotReleases: new Map(),
    queueLifecycleStopInflight: new Set(), queueSendInflight: new Set(), latestLoopCauseByOwner: new Map(),
    processedNaturalOutcomes: new Map(), queueRendererStartedAt: 0,
    usePromptQueueStore: { getState: () => ({ getQueue: () => queue, setLoopPromptEnabled: (_id, enabled) => { queue.loopPromptEnabled = enabled; }, resumeWorkflowsForTrigger() {} }) },
    useUIStore: { getState: () => ({ showToast: text => toasts.push(text) }) }, getTabName: () => 'T',
    coordinator: { intercept: (_tab, _outcome, continuation) => {
      if (!holdCompact) return false;
      compactContinuation = continuation; return true;
    }, wake() {}, cancel() {} }, canProcessWorkflowOutcomes: () => true,
    isOrchestrationCompletionBlocked: () => false, isSuccessfulCompactLocalCommandEnd: () => false,
    isNaturalAgentTurnEndReason, normalizeAgentTurnEndReason, hasPendingAgentGoalWork, signalQueueOwnerReadiness() {},
    interruptionContinuesWithQueuedTurn: () => false, applyAbnormalQueueOutcome() {},
    queueManualStopping: new Set(),
    findOwnersWaitingOn: () => [], describeQueuesForTriggerLog: () => '', shortQueueTabId: id => id,
    countEnabledQueuedPrompts: items => items.filter(item => item.enabled !== false).length,
    getEffectiveQueueTrigger: () => tabId, promptQueueOutcomeFloor: () => queueArmedAt,
    choosePromptQueueContinuationForOutcome, hasRuntimeWorkflowArm: () => runtimeOwnArm,
    isLoopPromptActive: q => q.loopPromptEnabled && !!q.loopPromptText,
    queueOwnerHasPendingContinuationAt: () => false, getReadyTriggerForOwner: () => tabId,
    fireLoopOwner: () => fired.push('loop'), fireQueueOwner: () => fired.push('queue'),
  });
  vm.runInContext(rendererCode, renderer);
  const context = vm.createContext({ console, Date, Number, Map, Set,
    taskCompletionIntents: registry, taskCompletionOutcomeMeta,
    codexProviderPreviewOwnerVerdict, codexProviderTerminalOutcomeVerdict,
    terminals: new Map([[tabId, terminal]]), terminalCommandState: new Map([[tabId, { runSeq: 1 }]]),
    codexLastRunCommandPayload: new Map([[tabId, { launchId: 'launch' }]]),
    getTerminalLifecycleGeneration: () => generation, codexTurnWatchers: new Map([[tabId, watcher]]),
    codexProviderSemanticSources: new Map([[tabId, owner]]), claudeTurnBusy: new Map(),
    recordActivity: (...args) => activity.push(args), publishCodexRuntimeProjection: (...args) => projected.push(args),
    shouldCreateHistoryResponseTiming: () => true, terminalHistoryPreviewController: { finish() {} },
    codexRuntimePolicies: null, replayDeferredCodexPromptAuditExecutionContext() {}, discardDeferredCodexPromptAuditExecutionContexts() {},
    clearCodexMcpStartupWatchdog() {}, getCodexPublicRuntimeProjection: () => ({ inputReady: true, sessionStatus: 'active' }),
    emitAgentReadinessChanged() {}, getCodexRuntimeSessionId: () => 'S', getCombinedTabBackgroundWorkCount: () => 0,
    getCodexPublicWriterFields: () => ({}), _webBroadcast() {},
    mainWindow: { isDestroyed: () => false, webContents: { send: (channel, data) => {
      events.push({ channel, ...data }); if (channel === 'codex:busy-state') renderer.receive(null, data);
    } } },
  });
  vm.runInContext(mainCode, context);
  context.emitCodexBusy(tabId, true, 'task_started', { turnId, outcome: { busy: true }, timestamp: 10 });
  events.length = 0; activity.length = 0;
  return { registry, queue, owner, watcher, events, activity, projected, fired, logs, toasts, context,
    rearm: value => { queueArmedAt = value; }, releaseCompact: () => compactContinuation(),
    request: status => context.registerTaskCompletionIntent({ tabId, status, reason: status === 'blocked' ? 'Unlock Mac' : null }),
    finish: (reason = 'task_complete', eventTurnId = turnId, goalWork = null) => {
      const outcome = { event: reason === 'turn_aborted' ? reason : 'task_complete', busy: false, reason,
        hasFinalResult: reason === 'task_complete', goalWork };
      watcher.busy = false;
      // Actual record handler settles provider activity BEFORE emitCodexBusy.
      context.applyCodexWatcherOutcome(watcher, outcome, 100, eventTurnId, null);
      context.emitCodexBusy(tabId, false, reason, { outcome, timestamp: 100, turnId: eventTurnId });
    } };
}

test('accepted completed survives provider activity settlement and the real renderer busy-edge gate', () => {
  const h = harness(); assert.equal(h.request('completed').ok, true); h.finish();
  assert.deepEqual(h.fired, [], 'accepted completion must prevent the next Loop before any automatic send is chosen');
  assert.equal(h.queue.loopPromptEnabled, false);
  assert.equal(h.events.length, 1, 'one full natural event, not an early metadata-free event followed by a duplicate');
  assert.equal(h.events[0].explicitTaskComplete, true);
  assert.equal(h.owner.turnActive, false); assert.equal(h.watcher.providerTurnActive, false);
  assert.ok(h.activity.some(([, busy]) => busy === false)); assert.ok(h.projected.length > 0);
});

test('native active Goal preserves turn idle but does not launch Loop/queued work', () => {
  const h = harness({ ordinaryQueue: true });
  h.finish('task_complete', 'turn-1', { version: 1, pending: true, phase: 'continuing', status: 'active', turnId: 'turn-1', sessionId: 'S' });
  assert.equal(h.events[0].busy, false);
  assert.equal(h.events[0].goalWork.pending, true);
  assert.deepEqual(h.fired, []);
  assert.equal(h.queue.autoRun, true);
  assert.equal(h.queue.loopPromptEnabled, true);
});

test('native Goal deferral still consumes the separate exact Loop completion intent', () => {
  const h = harness({ ordinaryQueue: true });
  assert.equal(h.request('completed').ok, true);
  h.finish('task_complete', 'turn-1', { version: 1, pending: true, phase: 'continuing', status: 'active', turnId: 'turn-1', sessionId: 'S' });
  assert.equal(h.queue.loopPromptEnabled, false);
  assert.equal(h.queue.autoRun, true);
  assert.deepEqual(h.fired, []);
});

test('blocked stops Loop with its reason but preserves ordinary queued work', () => {
  const h = harness({ ordinaryQueue: true }); assert.equal(h.request('blocked').ok, true); h.finish();
  assert.equal(h.queue.loopPromptEnabled, false); assert.deepEqual(h.fired, ['queue']);
  assert.deepEqual(h.queue.items.map(item => item.id), ['keep']); assert.equal(h.queue.autoRun, true);
  assert.equal(h.events[0].explicitTaskBlocked, true); assert.equal(h.events[0].explicitTaskComplete, false);
  assert.match(h.toasts[0], /Unlock Mac/);
});

test('no explicit signal continues Loop once; manual turns cannot call completion', () => {
  const h = harness({ eligible: false }); assert.equal(h.request('completed').code, 'completion_protocol_not_active');
  h.finish(); assert.deepEqual(h.fired, ['loop']); assert.equal(h.queue.loopPromptEnabled, true);
  assert.equal(h.events.length, 1);
});

test('interrupt cancels the intent, and a different turn cannot consume it', () => {
  const aborted = harness(); aborted.request('completed'); aborted.finish('turn_aborted');
  assert.equal(aborted.events.length, 1); assert.notEqual(aborted.events[0].explicitTaskComplete, true);
  assert.equal(aborted.registry.getTurn('T'), null); assert.deepEqual(aborted.fired, []);
  const wrong = harness(); wrong.request('completed'); wrong.finish('task_complete', 'older-turn');
  assert.ok(wrong.registry.getTurn('T')?.intentId); assert.notEqual(wrong.events.at(-1).explicitTaskComplete, true);
});

test('provider-only activity keeps publishing, while stale owners cannot settle current activity', () => {
  const h = harness();
  h.context.publishCodexProviderTurnActivity({ tabId: 'T', sourceId: 'provider-1', active: true, turnId: 'turn-1' });
  assert.equal(h.events.length, 1); assert.equal(h.events[0].providerActivity, true); assert.equal(h.events[0].busy, true);
  assert.equal(h.context.publishCodexProviderTurnActivity({ tabId: 'T', sourceId: 'old-provider', active: false }), false);
  assert.equal(h.owner.turnActive, true); assert.equal(h.events.length, 1);
});

test('an explicit own queue armed while Main is still busy consumes its delayed live idle edge', () => {
  const h = harness({ ordinaryQueue: true, queueArmedAt: 150, runtimeOwnArm: true });
  h.finish(); // provider timestamp100 arrives after the user armed at150.
  assert.deepEqual(h.fired, ['queue'], 'the waiting own queue must run before Loop once the current turn actually becomes idle');
  assert.equal(h.queue.autoRun, true);
});

test('a restored queue does not gain the explicit own-arm allowance from an old timestamp', () => {
  const h = harness({ ordinaryQueue: true, queueArmedAt: 150, runtimeOwnArm: false });
  h.finish();
  assert.deepEqual(h.fired, ['loop']);
});

test('a delayed compact continuation cannot lend its live idle allowance to a newer queue arm', () => {
  const h = harness({ ordinaryQueue: true, queueArmedAt: 150, runtimeOwnArm: true, holdCompact: true });
  h.finish(); assert.deepEqual(h.fired, []);
  h.rearm(250); h.releaseCompact();
  assert.deepEqual(h.fired, ['loop'], 'the original busy edge belongs to arm150, not a newer arm250');
});
