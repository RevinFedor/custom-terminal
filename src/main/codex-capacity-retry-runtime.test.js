'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCodexCapacityRetryRecord: classify, createCodexCapacityRetryRuntime } = require('./codex-capacity-retry-runtime');
const time = '2026-09-05T14:21:39.307Z';
const failure = turn => ({ type: 'event_msg', timestamp: time, payload: { type: 'task_complete', turn_id: turn,
  error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } } });

test('actual JSONL error is capacity; quoted user/tool/system content is not', () => {
  assert.equal(classify(failure('T')).errorId, 'T');
  for (const record of [
    { type: 'event_msg', payload: { type: 'user_message', message: failure('T').payload.error.message } },
    { type: 'event_msg', payload: { type: 'mcp_tool_call_end', result: failure('T') } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'T' } },
    { type: 'event_msg', payload: { ...failure('T').payload, error: { ...failure('T').payload.error, codex_error_info: 'unauthorized' } } },
  ]) assert.equal(classify({ timestamp: time, ...record }), null);
});

test('only actual assistant, reasoning or tool work counts as progress', () => {
  for (const payload of [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working' }] },
    { type: 'reasoning', summary: [{ text: 'checking' }] },
    { type: 'function_call', name: 'read', call_id: 'C' },
    { type: 'message', role: 'assistant', content: [{ text: '{"recap":"a real user-requested answer"}' }] },
  ]) assert.equal(classify({ type: 'response_item', timestamp: time, payload }).type, 'progress');
  for (const payload of [
    { type: 'message', role: 'user', content: 'continue' },
    { type: 'message', role: 'assistant', phase: 'recap', content: [{ text: '{"recap":"service"}' }] },
    { type: 'reasoning', summary: [] },
  ]) assert.equal(classify({ type: 'response_item', timestamp: time, payload }), null);
  for (const type of ['task_started', 'token_count', 'thread_goal_updated', 'user_message']) {
    assert.equal(classify({ type: 'event_msg', timestamp: time, payload: { type, message: 'continue' } }), null);
  }
});

function fixture({ state = null, outcome = { submitted: true }, limit = 2 } = {}) {
  const persisted = new Map(state ? [['tab', state]] : []);
  const calls = [];
  const owner = { tabId: 'tab', sessionId: 'S', generation: 'G' };
  let current = true;
  let enabled = true;
  const runtime = createCodexCapacityRetryRuntime({
    getSettings: async () => ({ codexCapacityRetryEnabled: enabled, codexCapacityRetryLimit: limit }),
    loadState: tab => persisted.get(tab),
    saveState: (tab, value) => persisted.set(tab, JSON.parse(JSON.stringify(value))),
    isCurrent: () => current,
    send: async (_owner, effect, guard) => { if (await guard()) calls.push(['send', effect.handoffId]); return outcome; },
    notify: async (_owner, effect) => calls.push(['alert', effect.handoffId]),
    cancelSend: (_tab, id) => calls.push(['cancel', id]),
  });
  return { runtime, owner, calls, persisted, disable: () => { enabled = false; }, retire: () => { current = false; } };
}

test('N empty retries then one alert; real progress replenishes the budget', async () => {
  const f = fixture();
  for (let n = 1; n <= 4; n++) await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E' + n, at: n * 10 });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 2);
  assert.equal(f.calls.filter(x => x[0] === 'alert').length, 1);
  f.runtime.progress(f.owner, { type: 'progress', eventId: 'P', at: 50 });
  await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E5', at: 60 });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 3);
});

test('uncertain delivery and repeated same error never issue another Enter, including restart', async () => {
  const f = fixture({ outcome: { submitted: null, deliveryUnknown: true }, limit: 1 });
  await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E1', at: 10 });
  await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E1', at: 10 });
  assert.equal(f.calls.filter(x => x[0] === 'send').length, 1);
  const restarted = fixture({ state: f.persisted.get('tab'), limit: 1 });
  await restarted.runtime.capacity(restarted.owner, { type: 'capacity', errorId: 'E1', at: 10 });
  await restarted.runtime.capacity(restarted.owner, { type: 'capacity', errorId: 'E2', at: 20 });
  assert.deepEqual(restarted.calls.map(x => x[0]), ['alert']);
});

test('disabled or retired targets receive no automatic send or forced alert', async () => {
  for (const mode of ['disable', 'retire']) {
    const f = fixture(); f[mode]();
    await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E', at: 10 });
    assert.deepEqual(f.calls, []);
  }
});

test('Stop cancels the pending handoff; late capacity cannot restart it', async () => {
  const f = fixture({ outcome: { submitted: null } });
  await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E1', at: 10 });
  f.runtime.cancel('tab', 'manual-stop');
  await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E2', at: 20 });
  assert.deepEqual(f.calls.map(x => x[0]), ['send', 'cancel']);
});

test('stale progress cannot cancel an already reserved continuation', async () => {
  const f = fixture({ outcome: { submitted: null } });
  await f.runtime.capacity(f.owner, { type: 'capacity', errorId: 'E1', at: 20 });
  f.runtime.progress(f.owner, { type: 'progress', eventId: 'old', at: 10 });
  assert.deepEqual(f.calls.map(x => x[0]), ['send']);
  assert.equal(f.runtime.snapshot('tab').attempts, 1);
  f.runtime.progress(f.owner, { type: 'progress', eventId: 'new', at: 30 });
  assert.deepEqual(f.calls.map(x => x[0]), ['send', 'cancel']);
  assert.equal(f.runtime.snapshot('tab').attempts, 0);
});
