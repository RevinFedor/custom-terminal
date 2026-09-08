const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeCodexCapacityRetrySettings,
  reduceCodexCapacityRetry: reduce,
  isCodexCapacityRetryEffectCurrent: isCurrent,
} = require('./codex-capacity-retry-policy');

const scopeKey = 'tab-1:session-1:run-1';
const settings = { codexCapacityRetryEnabled: true, codexCapacityRetryLimit: 2 };
const capacity = (errorId, at, scope = scopeKey) => ({ type: 'capacity', scopeKey: scope, errorId, at });
const progress = (eventId, at, scope = scopeKey) => ({ type: 'progress', scopeKey: scope, eventId, at });

test('limit 2 allows two automatic continues, then emits one exhausted notification', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  assert.equal(first.effect.type, 'continue');
  assert.equal(first.effect.attempt, 1);
  const second = reduce(first.state, capacity('turn-2', 20), settings);
  assert.equal(second.effect.type, 'continue');
  assert.equal(second.effect.attempt, 2);
  const third = reduce(second.state, capacity('turn-3', 30), settings);
  assert.equal(third.effect.type, 'exhausted');
  assert.equal(third.state.attempts, 2);
  const fourth = reduce(third.state, capacity('turn-4', 40), settings);
  assert.equal(fourth.effect, null);
  assert.equal(fourth.state.attempts, 2);
  assert.equal(isCurrent(fourth.state, third.effect, settings), true);
});

test('default policy is enabled and permits exactly one retry', () => {
  assert.deepEqual(normalizeCodexCapacityRetrySettings(), {
    codexCapacityRetryEnabled: true,
    codexCapacityRetryLimit: 1,
  });
  const first = reduce(null, capacity('turn-1', 10));
  assert.equal(first.effect.type, 'continue');
  const second = reduce(first.state, capacity('turn-2', 20));
  assert.equal(second.effect.type, 'exhausted');
});

test('disabled policy never emits a retry or failure notification and consumes no attempts', () => {
  const disabled = { ...settings, codexCapacityRetryEnabled: false };
  const first = reduce(null, capacity('turn-1', 10), disabled);
  assert.equal(first.effect, null);
  assert.equal(first.state.attempts, 0);
  const second = reduce(first.state, capacity('turn-2', 20), disabled);
  assert.equal(second.effect, null);
  assert.equal(second.state.attempts, 0);
  assert.equal(second.state.exhausted, false);
  assert.equal(reduce(second.state, capacity('turn-1', 30), settings).effect, null);
});

test('settings normalize the retry limit to integer 1..10', () => {
  for (const [value, expected] of [[0, 1], [-10, 1], [3.9, 3], ['4', 4], [11, 10], [Infinity, 1], ['bad', 1], [undefined, 1]]) {
    assert.equal(normalizeCodexCapacityRetrySettings({ codexCapacityRetryLimit: value }).codexCapacityRetryLimit, expected);
  }
  assert.equal(normalizeCodexCapacityRetrySettings({ codexCapacityRetryEnabled: false }).codexCapacityRetryEnabled, false);
});

test('same exact error cannot duplicate a retry even if replayed with a later timestamp', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  assert.deepEqual(reduce(first.state, capacity('turn-1', 15), settings), { state: first.state, effect: null });
  const second = reduce(first.state, capacity('turn-2', 20), settings);
  assert.deepEqual(reduce(second.state, capacity('turn-1', 25), settings), { state: second.state, effect: null });
});

test('distinct failures at the same timestamp are not mistaken for duplicate IDs', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  const second = reduce(first.state, capacity('turn-2', 10), settings);
  assert.equal(second.effect.attempt, 2);
});

test('real progress after capacity replenishes a budget and invalidates the old queued continue', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  const progressed = reduce(first.state, progress('assistant-message-1', 20), settings);
  assert.equal(progressed.state.attempts, 0);
  assert.equal(isCurrent(progressed.state, first.effect, settings), false);
  const next = reduce(progressed.state, capacity('turn-2', 30), settings);
  assert.equal(next.effect.attempt, 1);
});

test('real progress after exhaustion permits a fresh full budget and a later single notification', () => {
  let state = null;
  for (const [id, at] of [['turn-1', 10], ['turn-2', 20], ['turn-3', 30]]) {
    state = reduce(state, capacity(id, at), settings).state;
  }
  assert.equal(state.exhausted, true);
  state = reduce(state, progress('tool-call-1', 40), settings).state;
  assert.equal(state.exhausted, false);
  assert.equal(state.attempts, 0);
  for (const [id, at, type] of [['turn-4', 50, 'continue'], ['turn-5', 60, 'continue'], ['turn-6', 70, 'exhausted']]) {
    const next = reduce(state, capacity(id, at), settings);
    assert.equal(next.effect.type, type);
    state = next.state;
  }
});

test('progress older than or equal to the latest capacity barrier does not reset attempts', () => {
  const first = reduce(null, capacity('turn-1', 20), settings);
  for (const at of [0, 10, 20]) {
    assert.deepEqual(reduce(first.state, progress(`old-${at}`, at), settings), { state: first.state, effect: null });
  }
});

test('a replayed progress identity cannot reset a later retry budget', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  const progressed = reduce(first.state, progress('assistant-message-1', 20), settings);
  const second = reduce(progressed.state, capacity('turn-2', 30), settings);
  assert.deepEqual(reduce(second.state, progress('assistant-message-1', 40), settings), { state: second.state, effect: null });
});

test('automatic continue, provider lifecycle, usage, recap and system records are not progress events', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  for (const type of ['user_message', 'task_started', 'task_complete', 'token_count', 'token_usage', 'service_recap', 'system', 'response_item']) {
    const result = reduce(first.state, { type, scopeKey, at: 20, text: 'continue' }, settings);
    assert.deepEqual(result, { state: first.state, effect: null });
  }
});

test('historical failures do not override a newer failure or later genuine progress', () => {
  const first = reduce(null, capacity('turn-1', 20), settings);
  assert.deepEqual(reduce(first.state, capacity('old-error', 10), settings), { state: first.state, effect: null });
  const progressed = reduce(first.state, progress('assistant-message-1', 30), settings);
  assert.deepEqual(reduce(progressed.state, capacity('old-error', 25), settings), { state: progressed.state, effect: null });
  assert.deepEqual(reduce(progressed.state, capacity('turn-1', 40), settings), { state: progressed.state, effect: null });
});

test('scope mismatch never switches the active source or replenishes its counter', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  for (const event of [capacity('other-error', 20, 'other-scope'), progress('other-progress', 20, 'other-scope'), { type: 'cancel', scopeKey: 'other-scope' }]) {
    assert.deepEqual(reduce(first.state, event, settings), { state: first.state, effect: null });
  }
});

test('cancel/stop invalidates the old continue and cannot be undone by new events or re-enable', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  const cancelled = reduce(first.state, { type: 'cancel', scopeKey }, settings);
  assert.equal(isCurrent(cancelled.state, first.effect, settings), false);
  for (const event of [capacity('turn-2', 20), progress('assistant-message-1', 20)]) {
    assert.deepEqual(reduce(cancelled.state, event, settings), { state: cancelled.state, effect: null });
  }
});

test('changing enable/limit settings immediately revokes an outstanding retry effect', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  assert.equal(isCurrent(first.state, first.effect, { ...settings, codexCapacityRetryEnabled: false }), false);
  const second = reduce(first.state, capacity('turn-2', 20), settings);
  assert.equal(isCurrent(second.state, second.effect, { ...settings, codexCapacityRetryLimit: 1 }), false);
  assert.equal(isCurrent(second.state, first.effect, settings), false);
  assert.equal(isCurrent(second.state, second.effect, settings), true);
  const exhausted = reduce(second.state, capacity('turn-3', 30), settings);
  assert.equal(isCurrent(exhausted.state, exhausted.effect, { ...settings, codexCapacityRetryEnabled: false }), false);
});

test('explicit new source reset retires old scope and imposes a live boundary', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  const reset = reduce(first.state, { type: 'reset', scopeKey: 'new-scope', at: 30 }, settings);
  assert.equal(isCurrent(reset.state, first.effect, settings), false);
  assert.deepEqual(reduce(reset.state, capacity('stale', 40), settings), { state: reset.state, effect: null });
  assert.deepEqual(reduce(reset.state, capacity('old-in-new-source', 30, 'new-scope'), settings), { state: reset.state, effect: null });
  const next = reduce(reset.state, capacity('new-error', 40, 'new-scope'), settings);
  assert.equal(next.effect.attempt, 1);
});

test('JSON persistence preserves consecutive attempt budget, effect identity and duplicate suppression', () => {
  const first = reduce(null, capacity('turn-1', 10), settings);
  const restored = JSON.parse(JSON.stringify(first));
  assert.equal(isCurrent(restored.state, restored.effect, settings), true);
  assert.deepEqual(reduce(restored.state, capacity('turn-1', 20), settings), { state: restored.state, effect: null });
  const next = reduce(restored.state, capacity('turn-2', 30), settings);
  assert.equal(next.effect.attempt, 2);
  assert.deepEqual(reduce(null, capacity('turn-1', 10), settings), first);
});

test('stable effect IDs do not collide for separator-containing source/error IDs', () => {
  const first = reduce(null, capacity('c', 10, 'a:b'), settings);
  const second = reduce(null, capacity('b:c', 10, 'a'), settings);
  assert.notEqual(first.effect.handoffId, second.effect.handoffId);
});

test('malformed capacity/progress events are ignored and ISO timestamps are supported', () => {
  for (const event of [null, {}, capacity('', 10), capacity('turn-1', null), capacity('turn-1', Infinity), capacity('turn-1', 'not-a-date'), progress('', 10)]) {
    assert.deepEqual(reduce(null, event, settings), { state: null, effect: null });
  }
  const first = reduce(null, capacity('turn-1', '2026-09-05T12:00:00.000Z'), settings);
  assert.equal(first.state.lastCapacityAt, Date.parse('2026-09-05T12:00:00.000Z'));
});
