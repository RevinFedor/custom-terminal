import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { shouldDeferTabCompletionNotification } from '../renderer/utils/tabCompletionDeferral.mjs';
import { createRestartAfterCoordinator } from '../renderer/utils/restartAfterCoordinator.mjs';
const require = createRequire(import.meta.url);
const codex = require('./codex-turn-outcome.js');
const { hasPendingAgentGoalWork } = require('../shared/agent-work-completion.cjs');
const mainText = fs.readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainText, ts.ScriptTarget.Latest, true);
const storeText = fs.readFileSync(new URL('../renderer/store/useWorkspaceStore.ts', import.meta.url), 'utf8');
const storeAst = ts.createSourceFile('store.ts', storeText, ts.ScriptTarget.Latest, true);
function functionSource(name) {
  const node = mainAst.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(node, 'missing actual Main source: ' + name);
  return node.getText(mainAst);
}
function storeDeclaration(name) {
  let src;
  function walk(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(storeAst) === name)
      src = 'const ' + node.getText(storeAst) + ';';
    if (ts.isPropertyAssignment(node) && node.name.getText(storeAst) === name && ts.isArrowFunction(node.initializer))
      src = 'const ' + name + ' = ' + node.initializer.getText(storeAst) + ';';
    ts.forEachChild(node, walk);
  }
  walk(storeAst); assert.ok(src, 'missing actual Store declaration: ' + name);
  return ts.transpile(src, { target: ts.ScriptTarget.ES2022 });
}
const ev = (type, payload = {}, __byteOffset) => ({ type: 'event_msg', timestamp: '2026-10-19T05:54:46.274Z',
  payload: { type, ...payload }, ...(__byteOffset === undefined ? {} : { __byteOffset }) });
const start = (turn, off, trigger = null) => ev('task_started', { turn_id: turn,
  ...(trigger ? { turn_attribution: { turn_id: turn, turn_trigger: trigger, parent_turn_id: 'A' } } : {}) }, off);
const end = (turn, off) => ev('task_complete', { turn_id: turn, last_agent_message: 'one turn final' }, off);
const goal = (status, off, turn = 'A', thread = 'S') => ev('thread_goal_updated', {
  threadId: thread, ...(turn === null ? {} : { turnId: turn }),
  goal: { threadId: thread, status, createdAt: 1, updatedAt: 2, objective: 'PRIVATE' },
}, off);
const step = (tracker, ...records) => records.map(r => codex.classifyCodexTurnRecord(tracker, r)).filter(Boolean);
const projected = (tracker, record) => codex.classifyCodexTurnRecord(tracker, record);

test('native Goal turn_trigger on no-update successor: every intermediate result remains pending', () => {
  const t = { sessionId: 'S' };
  step(t, start('A', 10), goal('active', 20, 'A'));
  assert.equal(projected(t, end('A', 30)).goalWork.pending, true);
  step(t, start('B', 40, 'goal'));
  const b = projected(t, end('B', 50));
  assert.equal(b.goalWork.pending, true);
  assert.equal(b.goalWork.origin, 'goal-trigger-active');
  assert.equal(b.reason, 'task_complete'); assert.equal(b.hasFinalResult, true);
  step(t, start('C', 60, 'goal'));
  assert.equal(projected(t, end('C', 70)).goalWork.pending, true);
  step(t, start('D', 80, 'goal'), goal('complete', 90, 'D'));
  assert.equal(projected(t, end('D', 100)).goalWork.pending, false);
  assert.equal(t.codexGoalDecision, 'native-turn-attached');
});

test('goal start itself is explicit positive participation when no Goal record is available', () => {
  const t = { sessionId: 'S' }; step(t, start('X', 100, 'goal'));
  const result = projected(t, end('X', 110));
  assert.equal(result.goalWork.status, 'unknown');
  assert.equal(result.goalWork.phase, 'attention');
  assert.equal(result.goalWork.pending, true);
  const other = { sessionId: 'S' }; step(other, start('Y', 120));
  assert.equal(projected(other, end('Y', 130)).goalWork, undefined);
});

test('no-turn Goal status: attaches within present turn only; foreign session and stale byte offset rejected', () => {
  const t = { sessionId: 'S' }; step(t, start('A', 100), goal('active', 110, null));
  assert.equal(projected(t, end('A', 120)).goalWork.pending, true);
  step(t, goal('paused', 130, null));
  step(t, start('B', 150, 'goal'));
  assert.equal(projected(t, end('B', 160)).goalWork.status, 'unknown', 'old paused not inherited');
  step(t, start('C', 170, 'goal'), goal('blocked', 180, null));
  assert.equal(projected(t, end('C', 190)).goalWork.status, 'blocked');
  step(t, start('D', 200, 'goal'), goal('usageLimited', 210, null));
  assert.equal(projected(t, end('D', 220)).goalWork.pending, true);
  step(t, start('E', 230, 'goal'), goal('complete', 250, null));
  assert.equal(projected(t, end('E', 260)).goalWork.pending, false);
  step(t, goal('active', 240, null));
  assert.equal(t.codexGoalDecision, 'goal-offset-not-newer');
  step(t, goal('active', 270, null, 'FOREIGN'));
  assert.equal(t.codexGoalDecision, 'goal-owner-mismatch');
});

test('explicit wrong turn, missing owner, unknown status, rollback and independent input preserve boundaries', () => {
  const t = { sessionId: 'S' };
  step(t, start('A', 10), goal('active', 20, 'Z'));
  assert.equal(t.codexGoalDecision, 'goal-turn-mismatch');
  assert.equal(projected(t, end('A', 30)).goalWork, undefined);
  step(t, goal('futureGoalState', 40, 'A'));
  assert.equal(projected(t, end('A', 50)).goalWork.status, 'unknown');
  step(t, start('B', 60));
  assert.equal(projected(t, end('B', 70)).goalWork, undefined);
  step(t, start('C', 80, 'goal'), goal('active', 90, 'C'));
  step(t, ev('thread_rolled_back', {}, 100));
  assert.equal(projected(t, end('C', 110)).goalWork, undefined);
  const other = { sessionId: 'OTHER' }; step(other, start('A', 10), goal('active', 20, 'A', 'S'));
  assert.equal(projected(other, end('A', 30)).goalWork, undefined);
});

test('actual Main infer/catch-up and public snapshot carry no-update Goal continuation', () => {
  const context = vm.createContext({ ...codex, console: { warn() {}, log() {} }, Date,
    settleCodexProviderActivityFromWatcherOutcome() {},
    codexEventType: record => record?.type === 'event_msg' ? record.payload?.type : null });
  for (const fn of ['codexOutcomeTimestampMs', 'applyCodexWatcherAbnormalOutcome',
    'applyCodexWatcherOutcome', 'codexTurnStateSnapshot', 'inferCodexBusyFromText'])
    vm.runInContext(functionSource(fn), context);
  const records = [start('A', 10), goal('active', 20), end('A', 30), start('B', 40, 'goal'), end('B', 50)];
  const inferred = context.inferCodexBusyFromText(records.map(JSON.stringify).join('\n'), 'S').inferred;
  assert.equal(inferred.goalWork.pending, true);
  const state = { sessionId: 'S', busy: false };
  context.applyCodexWatcherOutcome(state, inferred, inferred.timestamp, inferred.turnId);
  const snapshot = context.codexTurnStateSnapshot(state);
  assert.equal(snapshot.goalWork.origin, 'goal-trigger-active');
  assert.equal(snapshot.busy, false);
  // The caller owns source-file→physical-session proof. The Goal trigger has
  // no threadId field of its own, unlike a typed thread_goal_updated.
  assert.equal(context.inferCodexBusyFromText([start('A', 10), goal('active', 20), end('A', 30)]
    .map(JSON.stringify).join('\n'), 'OTHER').inferred.goalWork, undefined);
  context.applyCodexWatcherOutcome(state, { busy: true, reason: 'task_started' }, '', 'C');
  assert.equal(context.codexTurnStateSnapshot(state).goalWork, null, 'busy clears prior outcome only');
});

test('actual classifier → Main snapshot → Store bell keeps arm across Goal continuation and fires once', () => {
  const tab = { aiBusy: false, completionNotificationPersistent: true };
  const state = { openProjects: new Map([['P', { projectId: 'P', tabs: new Map([['T', tab]]) }]]), activeProjectId: null };
  const sent = [];
  const context = vm.createContext({ get: () => state, set() {}, useWorkspaceStore: { getState: () => state },
    console: { warn() {} }, Map, deferredTabCompletionReasons: new WeakMap(),
    shouldDeferTabCompletionNotification, isOrchestrationCompletionBlocked: () => false,
    tabHasPendingQueueContinuation: () => false,
    isNaturalAgentTurnEndReason: reason => reason === 'task_complete',
    emitTabCompletionNotificationCleared() {}, emitTabCompletionNotificationStateChanged() {},
    emitTabCompletionNotification: value => sent.push(value),
    settleTabCompletionNotification: () => { tab.completionNotificationArmed = false; return { changed: true, detail: { fired: true } }; },
  });
  vm.runInContext(storeDeclaration('tabCompletionDeferralReason') + storeDeclaration('setAiBusy')
    + '\nglobalThis.busy = setAiBusy;', context);
  const watcher = { sessionId: 'S', busy: false };
  const main = vm.createContext({ Date, settleCodexProviderActivityFromWatcherOutcome() {} });
  for (const name of ['codexOutcomeTimestampMs', 'applyCodexWatcherAbnormalOutcome',
    'applyCodexWatcherOutcome', 'codexTurnStateSnapshot']) vm.runInContext(functionSource(name), main);
  const publish = record => {
    const outcome = projected(watcher, record);
    if (!outcome) return;
    main.applyCodexWatcherOutcome(watcher, outcome, outcome.timestamp, outcome.turnId);
    watcher.busy = outcome.busy;
    const snapshot = main.codexTurnStateSnapshot(watcher);
    // IPC serialization is a controlled port; Goal facts are actual producer
    // projection output, not a manually supplied pending flag.
    const wire = JSON.parse(JSON.stringify({ busy: snapshot.busy,
      reason: outcome.reason, goalWork: snapshot.goalWork }));
    context.busy('T', wire.busy, wire.reason, wire.goalWork);
  };
  for (const record of [start('A', 10), goal('active', 20), end('A', 30)]) publish(record);
  assert.equal(sent.length, 0); assert.equal(tab.completionNotificationArmed, true);
  const continued = start('B', 40, 'goal');
  continued.timestamp = '2026-10-19T05:54:46.292Z';
  publish(continued);
  publish(end('B', 50)); // No thread_goal_updated for this entire native turn.
  assert.equal(sent.length, 0);
  for (const record of [start('C', 60, 'goal'), goal('complete', 70, 'C'), end('C', 80)]) publish(record);
  assert.equal(sent.length, 1);
});

test('actual RestartAfter completion and default work predicate hold; ordinary explicit turn remains readable', async () => {
  const writes = [];
  const restart = createRestartAfterCoordinator({
    id: () => 'id', allowed: () => true, blocked: () => false,
    targets: () => [{ tabId: 'target' }], prepare: async () => ({ command: 'echo test', finite: true }),
    launch: async (_r, _p, id, current) => { if (current()) writes.push(id); return { success: true }; },
  });
  const tracker = { sessionId: 'S' };
  step(tracker, start('B', 10, 'goal'));
  const pending = projected(tracker, end('B', 20)).goalWork;
  restart.busy({ tabId: 'T', busy: true });
  restart.busy({ tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: 10, goalWork: pending });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 0);
  assert.equal(hasPendingAgentGoalWork({ goalWork: pending }), true);
  assert.equal(shouldDeferTabCompletionNotification({ successful: true, goalWork: pending }), 'native-goal-attention');
  restart.busy({ tabId: 'T', busy: true });
  restart.busy({ tabId: 'T', busy: false, reason: 'task_complete', outcomeTs: 20,
    goalWork: { version: 1, pending: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(hasPendingAgentGoalWork({ goalWork: null }), false);
});

test('SOURCE observation distinguishes default whole-work from explicit current-turn selection', () => {
  const source = fs.readFileSync(new URL('./response-observation-service.js', import.meta.url), 'utf8');
  const expression = source.slice(source.indexOf('function createResponseObservationService('), source.indexOf('\nmodule.exports'));
  assert.ok(expression.includes('hasPendingAgentGoalWork(state)'), 'real default gate must remain');
  assert.ok(expression.includes('run.waitForDescendants === false'), 'current-turn bypass must remain');
  assert.ok(expression.includes('current.revision !== state.revision'), 'post-read fencing must remain');
  // Same body/source path, but explicit current-turn bypass is a separate product
  // capability; no new response reader/operation is installed by this patch.
});

test('SOURCE diagnostics never log objective, bodies or attempt input write', () => {
  assert.ok(mainText.includes("[CodexGoal:Projection]"));
  const segment = mainText.slice(mainText.indexOf('  // Goal has independent turn/whole-work semantics.'),
    mainText.indexOf('  const compactEvidence = classifyCodexCompactEvidence(record);'));
  assert.doesNotMatch(segment, /\.objective|last_agent_message|JSON\.stringify\(record\)|\.content|term\.write/);
});

test('actual Main auto-stop rejects pending Goal and permits verified complete owner', () => {
  let pending = true;
  const c = vm.createContext({ require: () => ({ validateOrchestrationAutoStopAuthority: () => ({
    valid: true, run: { targetTabId: 'T' }, expectedTargetIdentity: 'same',
  }) }), path: { join: () => 'module' }, srcMainDir: '',
    getCodexPublicRuntimeProjection: () => ({ goalWork: { version: 1, pending } }),
    compareAiLifecycleIdentity: () => ({ matches: true, reason: null }) });
  vm.runInContext(functionSource('validateOrchestrationAutoStopGuard'), c);
  assert.equal(c.validateOrchestrationAutoStopGuard({ kind: 'orchestration-auto-stop' }, 'same').reason,
    'target-goal-activity-pending');
  pending = false;
  assert.equal(c.validateOrchestrationAutoStopGuard({ kind: 'orchestration-auto-stop' }, 'same').allowed, true);
});

test('actual RunAfter consumer refuses to consume pending native Goal event', () => {
  const src = fs.readFileSync(new URL('../renderer/hooks/usePromptQueueRunner.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('runner.ts', src, ts.ScriptTarget.Latest, true);
  let declaration;
  function walk(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'processSuccessfulWorkflowOutcome')
      declaration = 'const processSuccessfulWorkflowOutcome = ' + node.initializer.getText(ast) + ';';
    ts.forEachChild(node, walk);
  }
  walk(ast); assert.ok(declaration);
  const c = vm.createContext({ hasPendingAgentGoalWork, console: { log() {} },
    Number, usePromptQueueStore: { getState() { throw new Error('should never query queue before native Goal gate'); } },
  });
  vm.runInContext(ts.transpile(declaration, { target: ts.ScriptTarget.ES2022 })
    + '\nglobalThis.handle = processSuccessfulWorkflowOutcome;', c);
  const tracker = { sessionId: 'S' };
  step(tracker, start('B', 10, 'goal'));
  const outcome = projected(tracker, end('B', 20));
  assert.equal(c.handle({ ...outcome, tabId: 'T' }, 'codex-live', 10), undefined);
});

test('actual observation completion listener preserves default and permits explicit chosen-turn result', async () => {
  const source = fs.readFileSync(new URL('./response-observation-service.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function createResponseObservationService('), source.indexOf('\nmodule.exports'));
  const subject = { toolType: 'codex', sessionId: 'S', targetExecutionContext: { turnId: 'B' } };
  const defaultRun = { runId: 'default', status: 'running', targetTabId: 'T',
    observationTarget: { toolType: 'codex', sessionId: 'S' } };
  const explicitRun = { ...defaultRun, runId: 'explicit', waitForDescendants: false,
    observationCurrentTurnSubject: subject };
  const frozen = [], binds = [];
  const store = {
    runs: new Map([['default', defaultRun], ['explicit', explicitRun]]),
    responseObservationsForTarget: () => [defaultRun, explicitRun],
    getInternal: async () => ({ status: 'completed' }),
    bindResponseObservationSubject: async (runId, s) => { binds.push(runId); return s; },
  };
  const c = vm.createContext({
    hasPendingAgentGoalWork, terminal: r => ['completed', 'failed', 'cancelled'].includes(r?.status),
    isResponseObservation: () => true, childRuns: () => [],
    responseObservationSubjectKey: s => JSON.stringify(s),
    classifyOrchestrationResultProbe: () => ({ kind: 'complete' }),
    createOrchestrationProofCoordinator: () => ({ handleTranscriptChanged() {},
      stop: async () => {}, release: async () => {}, arm: async () => ({ success: true }) }),
  });
  vm.runInContext(body + '\nglobalThis.factory=createResponseObservationService;', c);
  const svc = c.factory({ store, readState: async () => { throw Error('not needed'); },
    readResponse: async () => { throw Error('not needed'); },
    evidence: { freeze: (runId, s) => { frozen.push(runId); return { subject: s }; } },
    subscribe() {}, unsubscribe() {}, onChanged() {}, onSettled() {}, log: { warn() {} },
  });
  svc.recordCompletion({ tabId: 'T', subject, result: { complete: true, sourceVerified: true },
    backgroundWorkCount: 0, goalWork: { version: 1, pending: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(frozen, ['explicit']);
  assert.deepEqual(binds, ['explicit']);
  await svc.dispose();
});

test('new physical watcher and rollback cannot inherit previous watcher active Goal', () => {
  const old = { sessionId: 'S', processGeneration: 'G1' };
  step(old, start('A', 10), goal('active', 20), end('A', 30));
  const fresh = { sessionId: 'S', processGeneration: 'G2' };
  step(fresh, start('B', 10));
  assert.equal(projected(fresh, end('B', 20)).goalWork, undefined);
  step(fresh, start('C', 30, 'goal'));
  const unproved = projected(fresh, end('C', 40));
  assert.equal(unproved.goalWork.status, 'unknown', 'new owner has only its own trigger proof');
  step(old, ev('thread_rolled_back', {}, 50), start('D', 60));
  assert.equal(projected(old, end('D', 70)).goalWork, undefined);
});

test('no-turn native state between turns cannot retroactively convert prior final to work completion', () => {
  const t = { sessionId: 'S' };
  step(t, start('A', 10));
  const first = projected(t, end('A', 20));
  assert.equal(first.goalWork, undefined);
  step(t, goal('active', 30, null));
  step(t, start('B', 40));
  assert.equal(projected(t, end('B', 50)).goalWork, undefined);
  step(t, start('C', 60, 'goal'));
  assert.equal(projected(t, end('C', 70)).goalWork.pending, true);
});

test('no-turn Goal update before current turn boundary cannot seize its future outcome', () => {
  const t = { sessionId: 'S' };
  step(t, start('A', 10), goal('active', 20, 'A'), end('A', 30));
  step(t, start('B', 80, 'goal'));
  step(t, goal('complete', 60, null));
  assert.equal(t.codexGoalDecision, 'goal-before-current-turn');
  assert.equal(projected(t, end('B', 100)).goalWork.pending, true);
});

for (const invalidTurn of ['', 42, false, {}, []]) {
  test('malformed explicit Goal turn cannot masquerade as omitted turn: ' + JSON.stringify(invalidTurn), () => {
    const t = { sessionId: 'S' };
    step(t, start('A', 10, 'goal'));
    const malformed = goal('complete', 20);
    malformed.payload.turnId = invalidTurn;
    step(t, malformed);
    assert.equal(t.codexGoalDecision, 'goal-turn-invalid');
    assert.equal(projected(t, end('A', 30)).goalWork.pending, true);
  });
}

test('unlocated callback cannot replace a newer located native Goal update', () => {
  const t = { sessionId: 'S' };
  step(t, start('A', 10), goal('active', 20));
  step(t, goal('complete', undefined, null));
  assert.equal(t.codexGoalDecision, 'goal-offset-not-newer');
  assert.equal(projected(t, end('A', 30)).goalWork.pending, true);
});

test('a new explicit Goal trigger cannot inherit success from an old completed Goal', () => {
  const t = { sessionId: 'S' };
  step(t, start('A', 10), goal('complete', 20));
  assert.equal(projected(t, end('A', 30)).goalWork.pending, false);
  step(t, start('B', 40, 'goal'));
  const next = projected(t, end('B', 50)).goalWork;
  assert.equal(next.status, 'unknown');
  assert.equal(next.pending, true);
});
