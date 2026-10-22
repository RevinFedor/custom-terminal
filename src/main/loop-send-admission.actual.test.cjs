'use strict';
// Actual Main HTTP-module admission function; physical/runtime/frame facts are
// controlled leaves, not a second lifecycle implementation or provider input.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { loopEpoch, loopPromptMode, loopExternalWaitAdmission, loopRunAdmission } = require('../shared/loop-dependencies.cjs');
const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
const begin = source.indexOf('async function loopSendAdmission(');
const end = source.indexOf('\n}', begin) + 2;
const code = source.slice(begin, end) + '\nglobalThis.admit = loopSendAdmission;';
function fixture() {
  const queue = { loopPromptEnabled: true, loopPromptMode: 'own-turn', loopPromptEpoch: 'E', pendingDelivery: {
    kind: 'loop', loopPromptMode: 'own-turn', handoffId: 'H', loopEpoch: 'E', loopCause: { provider: 'codex', sessionId: 'S', turnId: 'T' } } };
  const inspection = { known: true, busy: false, transitioning: false, revision: 'R',
    toolType: 'codex', sessionId: 'S', backgroundWorkCount: 0, goalWork: { pending: false },
    turn: { status: 'completed', turnId: 'T' } };
  const runtime = { status: 'active', inputReady: true };
  const controls = { blocked: false, ready: true, afterRuntime: null, wake: null };
  const runs = [{ runId: 'R', sourceTabId: 'P', targetTabId: 'child', status: 'running' }];
  const context = vm.createContext({ loopEpoch, loopPromptMode, loopRunAdmission, loopExternalWaitAdmission, loopNaturalEvidence: new Map(),
    readPersistedLoopQueue: () => queue, captureTabInspection: () => ({ ...inspection }),
    getLoopDependencies: () => ({ reconcile: async () => {}, blocks: () => controls.blocked, readyWake: () => controls.wake }),
    getOrchestrationRunStore: () => ({ listForTab: async () => runs }),
    coherentPublicRuntimeSnapshot: async () => { controls.afterRuntime?.(); return runtime; },
    readAutomaticSendFrame: () => ({ ready: controls.ready }), agentSendQueue: { notifyRuntime() {} } });
  vm.runInContext(code, context);
  return { queue, inspection, runtime, controls, runs, admit: () => context.admit({ tabId: 'P', handoffId: 'H', provider: 'codex' }) };
}
test('actual admission permits exactly pinned idle source with ongoing external work', async () => {
  assert.equal(await fixture().admit(), true);
});
test('ordinary and legacy Loop wait for external work, including ready-wake attempts', async () => {
  const h = fixture(); delete h.queue.loopPromptMode; delete h.queue.pendingDelivery.loopPromptMode;
  assert.equal(await h.admit(), false);
  h.runs.length = 0; assert.equal(await h.admit(), true);
  h.controls.blocked = true; assert.equal(await h.admit(), true, 'ordinary does not depend on the external-mode journal');
  h.inspection.turn = { status: 'unknown' };
  h.controls.wake = { id: 'W', source: { sessionId: 'S', provider: 'codex' } };
  Object.assign(h.queue.pendingDelivery, { loopWaitId: 'W', causeKey: 'W:dependency-ready' });
  assert.equal(await h.admit(), false, 'ordinary cannot take an external-mode control wake');
});
test('mode change before or during admission cancels the old preparation', async () => {
  let h = fixture(); h.queue.loopPromptMode = 'all-work'; assert.equal((await h.admit()).cancel, true);
  h = fixture(); h.controls.afterRuntime = () => { h.queue.loopPromptMode = 'all-work'; };
  assert.equal((await h.admit()).cancel, true);
});
for (const [name, mutate] of [
  ['busy source', h => { h.inspection.busy = true; }],
  ['input unknown', h => { h.runtime.inputReady = false; }],
  ['Goal pending', h => { h.inspection.goalWork.pending = true; }],
  ['own worker', h => { h.inspection.backgroundWorkCount = 1; }],
  ['wrong turn', h => { h.inspection.turn.turnId = 'different'; }],
  ['wait intent', h => { h.controls.blocked = true; }],
  ['frame unknown', h => { h.controls.ready = false; }],
  ['callback ahead', h => { Object.assign(h.runs[0], { status: 'completed', sourceFollowupPending: true, notificationStatus: 'pending' }); }],
]) test(name + ' keeps actual Loop admission closed', async () => {
  const h = fixture(); mutate(h); assert.equal(await h.admit(), false);
});
for (const [name, mutate] of [
  ['busy source', h => { h.inspection.busy = true; }],
  ['input unknown', h => { h.runtime.inputReady = false; }],
  ['Goal pending', h => { h.inspection.goalWork.pending = true; }],
  ['own worker', h => { h.inspection.backgroundWorkCount = 1; }],
  ['wrong turn', h => { h.inspection.turn.turnId = 'different'; }],
  ['frame unknown', h => { h.controls.ready = false; }],
]) test('ordinary mode retains ' + name + ' guard', async () => {
  const h = fixture(); h.queue.loopPromptMode = h.queue.pendingDelivery.loopPromptMode = 'all-work';
  h.runs.length = 0; mutate(h); assert.equal(await h.admit(), false);
});
test('rearm cancels old accepted preparation and late source change cannot send', async () => {
  let h = fixture(); h.queue.loopPromptEpoch = 'new'; assert.equal((await h.admit()).cancel, true);
  h = fixture(); h.controls.afterRuntime = () => { h.inspection.revision = 'new-input'; };
  assert.equal((await h.admit()).cancel, true);
});
test('durable ready dependency has its own control cause after restart, not a fabricated natural outcome', async () => {
  const h = fixture();
  h.controls.wake = { id: 'W', source: { sessionId: 'S', provider: 'codex' } };
  Object.assign(h.queue.pendingDelivery, { loopWaitId: 'W', causeKey: 'W:dependency-ready' });
  h.inspection.turn = { status: 'unknown', turnId: null };
  assert.equal(await h.admit(), true, 'known own idle and native input readiness still required');
  h.inspection.busy = true; assert.equal(await h.admit(), false);
});
test('foreign ready id cannot waive the real source outcome check', async () => {
  const h = fixture();
  h.controls.wake = { id: 'W', source: { sessionId: 'S', provider: 'codex' } };
  Object.assign(h.queue.pendingDelivery, { loopWaitId: 'wrong', causeKey: 'W:dependency-ready' });
  h.inspection.turn = { status: 'unknown', turnId: null };
  assert.equal(await h.admit(), false);
});
