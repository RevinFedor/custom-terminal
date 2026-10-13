import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { shouldDeferTabCompletionNotification } from '../renderer/utils/tabCompletionDeferral.mjs';
const require = createRequire(import.meta.url);
const outcome = require('./codex-turn-outcome');
const { actualFunction } = require('./fixtures/codex-draft-request-observation.cjs');
const evt = (type, payload = {}) => ({ type: 'event_msg', timestamp: '2026-10-10T10:10:49.664Z', payload: { type, ...payload } });
const goal = status => evt('thread_goal_updated', { threadId: 'S', turnId: 'A',
  goal: { threadId: 'S', status, createdAt: 1, updatedAt: 2 } });
const records = status => [evt('task_started', { turn_id: 'A' }), goal(status),
  evt('task_complete', { turn_id: 'A', last_agent_message: 'one turn final' })];

function main() {
  const c = vm.createContext({ ...outcome, console: { log() {}, warn() {} }, Date,
    codexEventType: record => record?.type === 'event_msg' ? record.payload?.type : null,
    settleCodexProviderActivityFromWatcherOutcome() {} });
  for (const name of ['codexOutcomeTimestampMs', 'applyCodexWatcherAbnormalOutcome',
    'applyCodexWatcherOutcome', 'codexTurnStateSnapshot', 'inferCodexBusyFromText']) vm.runInContext(actualFunction(name), c);
  return c;
}
test('actual Main cold-tail infer → outcome → public snapshot retains exact Goal proof', () => {
  const c = main();
  const text = records('active').map(JSON.stringify).join('\n');
  const inferred = c.inferCodexBusyFromText(text, 'S').inferred;
  const state = { sessionId: 'S', busy: false };
  c.applyCodexWatcherOutcome(state, inferred, inferred.timestamp, inferred.turnId);
  const snapshot = c.codexTurnStateSnapshot(state);
  assert.equal(snapshot.outcomeKnown, true);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.goalWork.pending, true);
  assert.equal(snapshot.goalWork.sessionId, 'S');
  assert.equal(c.inferCodexBusyFromText(text, 'OTHER').inferred.goalWork, undefined);
});

test('actual public runtime getter carries Goal while leaving input readiness and turn busy separate', () => {
  const c = main();
  const inferred = c.inferCodexBusyFromText(records('active').map(JSON.stringify).join('\n'), 'S').inferred;
  const watcher = { sessionId: 'S', busy: false };
  c.applyCodexWatcherOutcome(watcher, inferred, inferred.timestamp, inferred.turnId);
  Object.assign(c, {
    codexTurnWatchers: new Map([['T', watcher]]), codexProviderSemanticSources: new Map(),
    aiStoppingTabs: new Map(), codexLateMcpProofPending: new Set(), codexRuntimePolicies: null,
    isCodexTuiEffectivelyReady: () => true, hasCodexEstablishedComposerLifecycle: () => true,
    getCodexLiveInputControl: () => null, isCodexWriterUsableForMutation: () => true,
    hasCodexEstablishedWriterUiLifecycle: () => true,
    projectCodexPublicRuntimeProjection: require('./codex-runtime-contract').projectCodexPublicRuntimeProjection,
    projectCodexPolicyRuntime: require('./codex-runtime-policies').projectCodexPolicyRuntime,
  });
  vm.runInContext(actualFunction('getCodexPublicRuntimeProjection'), c);
  const runtime = c.getCodexPublicRuntimeProjection('T');
  assert.equal(runtime.goalWork.pending, true);
  assert.equal(runtime.busy, false);
  assert.equal(runtime.inputReady, true, 'ordinary Send remains available');
});

const storeSource = fs.readFileSync(new URL('../renderer/store/useWorkspaceStore.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('store.ts', storeSource, ts.ScriptTarget.Latest, true);
function declaration(name) {
  let found;
  function visit(n) {
    if (ts.isVariableDeclaration(n) && n.name.getText(ast) === name) found = 'const ' + n.getText(ast) + ';';
    if (ts.isPropertyAssignment(n) && n.name.getText(ast) === name && ts.isArrowFunction(n.initializer)) found = 'const ' + name + ' = ' + n.initializer.getText(ast) + ';';
    ts.forEachChild(n, visit);
  }
  visit(ast); assert.ok(found, name);
  return ts.transpile(found, { target: ts.ScriptTarget.ES2022 });
}
test('actual store busy edge and common bell gate preserve armed state until Goal complete', () => {
  const tab = { aiBusy: false, completionNotificationPersistent: true }, tabs = new Map([['T', tab]]);
  const state = { openProjects: new Map([['P', { projectId: 'P', tabs }]]), activeProjectId: null };
  const sent = [];
  const c = vm.createContext({ get: () => state, set() {}, useWorkspaceStore: { getState: () => state },
    console: { warn() {} }, Map, shouldDeferTabCompletionNotification,
    isOrchestrationCompletionBlocked: () => false, tabHasPendingQueueContinuation: () => false,
    isNaturalAgentTurnEndReason: reason => reason === 'task_complete',
    emitTabCompletionNotificationCleared() {}, emitTabCompletionNotificationStateChanged() {},
    emitTabCompletionNotification: value => sent.push(value),
    settleTabCompletionNotification: () => { tab.completionNotificationArmed = false; return { changed: true, detail: { fired: true } }; } });
  vm.runInContext(declaration('tabCompletionDeferralReason') + declaration('setAiBusy')
    + '\nglobalThis.busy = setAiBusy;', c);
  c.busy('T', true, 'task_started');
  c.busy('T', false, 'task_complete', { version: 1, pending: true, phase: 'continuing' });
  assert.equal(sent.length, 0);
  assert.equal(tab.aiBusy, false);
  assert.equal(tab.completionNotificationArmed, true);
  c.busy('T', true, 'task_started');
  c.busy('T', false, 'task_complete', { version: 1, pending: false, phase: 'complete' });
  assert.equal(sent.length, 1);
});

test('actual final auto-stop guard rejects Goal continuation without changing manual Stop', () => {
  let pending = true;
  const c = vm.createContext({ require: () => ({ validateOrchestrationAutoStopAuthority: () => ({ valid: true,
    run: { targetTabId: 'T' }, expectedTargetIdentity: 'same' }) }),
    path: { join: () => 'controlled-owner' }, srcMainDir: '',
    getCodexPublicRuntimeProjection: () => ({ goalWork: { pending } }),
    compareAiLifecycleIdentity: () => ({ matches: true, reason: null }) });
  vm.runInContext(actualFunction('validateOrchestrationAutoStopGuard'), c);
  assert.equal(c.validateOrchestrationAutoStopGuard({ kind: 'orchestration-auto-stop' }, 'same').allowed, false);
  pending = false;
  assert.equal(c.validateOrchestrationAutoStopGuard({ kind: 'orchestration-auto-stop' }, 'same').allowed, true);
});
