import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createCodexGoalDesktopAdapter, watchCodexGoalDesktop, projectCodexGoalLifecycle } from './codexGoalDesktopAdapter.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const available = (overrides = {}) => ({ ok: true, tabId: 'T', operationId: 'op', status: 'available',
  currentOperation: true, runtimeLive: true, owner: { sessionId: 'S' }, availableActions: ['resume', 'leave-paused'], ...overrides });
function fixture(overrides = {}) {
  const calls = []; let current = available(overrides);
  const adapter = createCodexGoalDesktopAdapter({ createRequestId: () => 'exact-request',
    invoke: async (channel, request) => { calls.push({ channel, request });
      if (channel === 'codex:apply-goal-action') throw new Error('lost ACK');
      if (request.requestId) return { tabId: 'T', status: 'unavailable', requestId: request.requestId, reason: 'goal-request-not-found' };
      return current;
    } });
  return { adapter, calls, set: value => { current = value; } };
}

for (const guard of [
  { availableActions: [] }, { currentOperation: false }, { runtimeLive: false },
  { status: 'pending' }, { status: 'unknown', recoveryAvailable: false },
]) test('actual adapter never enables/distributes unproved choice: ' + JSON.stringify(guard), async () => {
  const h = fixture(guard); await h.adapter.refresh('T');
  assert.deepEqual(h.adapter.snapshot('T', 'S').availableActions, []);
  assert.equal(await h.adapter.choose('T', 'S', 'op', 'resume'), false);
  assert.equal(h.calls.length, 1);
});

test('exact session/operation/action guards also protect stale callback closures', async () => {
  const h = fixture(); await h.adapter.refresh('T');
  assert.equal(h.adapter.snapshot('T', 'another-session'), null);
  for (const args of [['T', 'another-session', 'op', 'resume'], ['T', 'S', 'old', 'resume'], ['T', 'S', 'op', 'stop']]) {
    assert.equal(await h.adapter.choose(...args), false);
  }
  assert.equal(h.calls.length, 1);
});

test('lost ACK + missing receipt stays unknown even if a stale current read still advertises choices', async () => {
  const h = fixture(); await h.adapter.refresh('T');
  await h.adapter.choose('T', 'S', 'op', 'resume'); await tick();
  const result = h.adapter.snapshot('T', 'S');
  assert.equal(result.status, 'unknown'); assert.equal(result.requestId, 'exact-request');
  assert.deepEqual(result.availableActions, []); assert.match(result.error, /goal-request-not-found/);
  assert.equal(await h.adapter.choose('T', 'S', 'op', 'resume'), false);
  await h.adapter.refresh('T');
  assert.equal(h.calls.filter(call => call.channel === 'codex:apply-goal-action').length, 1);
  assert.ok(h.calls.filter(call => call.request.requestId).every(call => call.request.requestId === 'exact-request'));
  h.set(available({ operationId: 'new-operation' })); await h.adapter.refresh('T');
  assert.deepEqual(h.adapter.snapshot('T', 'S').availableActions, ['resume', 'leave-paused']);
  assert.equal(h.adapter.snapshot('T', 'S').requestId, null);
  assert.equal(h.adapter.receipt('T', 'exact-request').status, 'unknown');
});

test('event read in flight is coalesced and cannot publish an older available operation after a newer wake', async () => {
  let release, reads = 0;
  const adapter = createCodexGoalDesktopAdapter({ invoke: async () => {
    if (++reads === 1) return new Promise(resolve => { release = resolve; });
    return available({ operationId: 'new', availableActions: [] });
  } });
  const seen = []; adapter.subscribe('T', () => seen.push(adapter.snapshot('T', 'S')));
  const first = adapter.refresh('T'); void adapter.refresh('T');
  release(available({ operationId: 'old' })); await first; await tick();
  assert.equal(reads, 2); assert.equal(adapter.snapshot('T', 'S').operationId, 'new');
  assert.equal(seen.some(state => state?.operationId === 'old'), false);
});

test('known pre-action rejection does not permanently mask a fresh Main-authorized manual choice', async () => {
  const calls = []; let receipt = null;
  const adapter = createCodexGoalDesktopAdapter({ createRequestId: () => 'rejected-request', invoke: async (channel, request) => {
    calls.push({ channel, request });
    if (channel === 'codex:apply-goal-action') {
      receipt = { ...request, status: 'rejected', accepted: false, reason: 'stale-current-frame', availableActions: [] };
      return receipt;
    }
    return request.requestId ? receipt : available();
  } });
  await adapter.refresh('T'); await adapter.choose('T', 'S', 'op', 'resume'); await tick();
  await adapter.refresh('T');
  assert.deepEqual(adapter.snapshot('T', 'S').availableActions, ['resume', 'leave-paused']);
  assert.equal(adapter.receipt('T', 'rejected-request').status, 'rejected');
  assert.equal(calls.filter(x => x.channel === 'codex:apply-goal-action').length, 1, 'a read never replays the choice');
});

test('lifecycle wakes and remount are read-only; dismiss survives busy/session wakes and all listeners unsubscribe', async () => {
  const h = fixture(), ipc = new EventEmitter(), seen = [];
  let cleanup = watchCodexGoalDesktop(h.adapter, ipc, 'T', 'S', state => seen.push(state));
  await tick(); const reads = h.calls.length;
  ipc.emit('agent:readiness-changed', null, { tabId: 'other', toolType: 'codex' });
  ipc.emit('agent:readiness-changed', null, { tabId: 'T', toolType: 'claude' });
  assert.equal(h.calls.length, reads);
  h.adapter.dismiss('T', 'op');
  ipc.emit('codex:busy-state', null, { tabId: 'T', busy: true }); await tick();
  assert.equal(seen.at(-1).hidden, true);
  cleanup(); assert.equal(ipc.eventNames().length, 0);
  cleanup = watchCodexGoalDesktop(h.adapter, ipc, 'T', 'S', state => seen.push(state)); await tick();
  assert.equal(seen.at(-1).hidden, true);
  h.set(available({ operationId: 'new' })); ipc.emit('codex:session-detected', null, { tabId: 'T' }); await tick();
  assert.equal(seen.at(-1).hidden, false);
  assert.ok(h.calls.every(call => call.channel === 'codex:read-goal-action'));
  cleanup(); assert.equal(ipc.eventNames().length, 0);
});

test('Goal projection is compact, honest on failure/unknown and preserves other lifecycle owners', () => {
  const goal = { ...available(), pending: false }, actions = { onChoose() {}, onRefresh() {}, onDismiss() {} };
  const summary = projectCodexGoalLifecycle(null, goal, actions);
  assert.equal(summary.spinner, false); assert.equal(summary.goalActions.onChoose, actions.onChoose);
  for (const status of ['pending', 'unknown', 'rejected', 'unavailable']) {
    const result = projectCodexGoalLifecycle(null, { ...goal, status, pending: status === 'pending', availableActions: [] }, actions);
    assert.doesNotMatch(result.description, /возобновлён|успешно|на паузе/);
    assert.deepEqual(result.goalActions.availableActions, []);
  }
  const unknown = projectCodexGoalLifecycle(null, { ...goal, status: 'unknown', availableActions: [], error: 'offline' }, actions);
  assert.match(unknown.detail, /offline/); assert.equal(unknown.goalActions.onRefresh, undefined);
  assert.equal(unknown.kind, 'error');
  for (const base of [
    { tabId: 'other', engine: 'codex', kind: 'info' }, { tabId: 'T', engine: 'claude', kind: 'info' },
    ...['stopping', 'error', 'warning'].map(kind => ({ tabId: 'T', engine: 'codex', kind })),
    { tabId: 'T', engine: 'codex', kind: 'starting', goalControlsBlocked: true },
    { tabId: 'T', engine: 'codex', kind: 'info', description: 'Sign in' },
  ]) assert.equal(projectCodexGoalLifecycle(base, goal, actions), base);
  const generic = { tabId: 'T', engine: 'codex', kind: 'starting' };
  assert.equal(projectCodexGoalLifecycle(generic, { ...goal, status: 'confirmed', choiceConfirmed: true }, actions), generic,
    'Goal confirmation cannot erase an unrelated unknown process/startup status');
  const oldGoal = { ...generic, goalOperationId: 'op' };
  assert.equal(projectCodexGoalLifecycle(oldGoal, { ...goal, hidden: true }, actions), null);
  assert.equal(projectCodexGoalLifecycle(oldGoal, { ...goal, status: 'confirmed', choiceConfirmed: true }, actions), null);
  const handledUnknown = { ...goal, phase: 'handled', status: 'unknown', choiceConfirmed: false,
    requestId: 'still-unknown', availableActions: [] };
  assert.equal(projectCodexGoalLifecycle(oldGoal, handledUnknown, actions), null);
  assert.equal(projectCodexGoalLifecycle(null, handledUnknown, actions), null);
  assert.equal(projectCodexGoalLifecycle(generic, handledUnknown, actions), generic);
  assert.equal(handledUnknown.status, 'unknown', 'hiding handled Goal never changes the request receipt');
});
