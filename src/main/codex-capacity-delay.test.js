'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexCapacityRetryRuntime } = require('./codex-capacity-retry-runtime');
const { normalizeCodexCapacityRetrySettings } = require('./codex-capacity-retry-policy');
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function fixture() {
  const owner = { tabId: 'private', sessionId: 'S', generation: 'G' };
  const timers = new Map(), saved = new Map(), sent = [], notices = [], waits = [];
  const settings = { codexCapacityRetryEnabled: true, codexCapacityRetryLimit: 1,
    codexCapacityRetryDelaysMs: [1800000, 3600000] };
  let clock = 1000, id = 0, current = true, outcome = { submitted: true };
  const options = { getSettings: async () => settings,
    loadState: tab => saved.get(tab), saveState: (tab, state) => saved.set(tab, JSON.parse(JSON.stringify(state))),
    isCurrent: () => current, now: () => clock,
    setTimer: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: clock + delay }); return key; },
    clearTimer: key => timers.delete(key), waiting: (_owner, effect) => waits.push(effect),
    send: async (_owner, effect, guard) => { if (await guard()) sent.push(effect); return outcome; },
    notify: (_owner, effect) => notices.push(effect), cancelSend() {},
  };
  const runtime = createCodexCapacityRetryRuntime(options);
  const capacity = n => runtime.capacity(owner, { type: 'capacity', errorId: 'E' + n, at: n * 10 });
  return { runtime, owner, timers, saved, sent, notices, waits, settings, options, capacity,
    retire: () => current = false, outcome: value => outcome = value,
    advance: async ms => { clock += ms; for (const timer of [...timers.values()]) if (timer.at <= clock) timer.fn(); await tick(); },
  };
}

test('one existing immediate retry, then 30m/60m for new typed failures, then one exhaustion', async () => {
  const f = fixture(); await f.capacity(1); assert.equal(f.sent.length, 1);
  const second = f.capacity(2); await tick();
  assert.equal(f.timers.size, 1); assert.equal(f.runtime.snapshot('private').pendingDelayUntil, 1801000);
  await f.capacity(2); assert.equal(f.timers.size, 1, 'duplicate error cannot reset the timer');
  await f.advance(1799999); assert.equal(f.sent.length, 1);
  await f.advance(1); await second; assert.equal(f.sent.length, 2);
  const third = f.capacity(3); await tick(); await f.advance(3599999); assert.equal(f.sent.length, 2);
  await f.advance(1); await third; assert.equal(f.sent.length, 3);
  assert.notEqual(f.sent[1].handoffId, f.sent[2].handoffId, 'different proven failed turns, not a replayed send');
  await f.capacity(4); await f.capacity(5); assert.equal(f.notices.length, 1);
  assert.equal(f.timers.size, 0); assert.equal(f.saved.get('private').pendingDelayUntil, null);
});

for (const reason of ['stop', 'disable', 'edit', 'progress', 'new-turn', 'replacement']) {
  test('waiting is revoked before any delayed Send: ' + reason, async () => {
    const f = fixture(); await f.capacity(1); const pending = f.capacity(2); await tick();
    if (reason === 'stop') f.runtime.cancel('private', 'manual-stop');
    if (reason === 'disable') { f.settings.codexCapacityRetryEnabled = false; f.runtime.settingsChanged(f.settings); }
    if (reason === 'edit') { f.settings.codexCapacityRetryDelaysMs = [2400000]; f.runtime.settingsChanged(f.settings); }
    if (reason === 'progress') f.runtime.progress(f.owner, { type: 'progress', eventId: 'work', at: 30 });
    if (reason === 'new-turn') f.runtime.activity(f.owner, 30);
    if (reason === 'replacement') f.retire();
    await f.advance(1800000); const result = await pending;
    assert.equal(result.submitted, false); assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
  });
}

test('unknown first delivery and mere elapsed time cannot schedule or repeat that error', async () => {
  const f = fixture(); f.outcome({ submitted: null, deliveryUnknown: true });
  await f.capacity(1); await f.capacity(1); await f.advance(7200000);
  assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
});

test('new runtime never replays a persisted pending timer or the historical error', async () => {
  const f = fixture(); await f.capacity(1); const pending = f.capacity(2); await tick();
  const persisted = f.saved.get('private');
  f.runtime.cancel('private'); await pending;
  const reopened = createCodexCapacityRetryRuntime({ ...f.options, loadState: () => persisted });
  await reopened.capacity({ ...f.owner, generation: 'new-main' }, { type: 'capacity', errorId: 'E2', at: 20 });
  await f.advance(7200000); assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
});

test('intervals have bounded integer-minute storage; explicit empty removes delayed steps', () => {
  assert.deepEqual(normalizeCodexCapacityRetrySettings({ codexCapacityRetryDelaysMs: [] }).codexCapacityRetryDelaysMs, []);
  assert.deepEqual(normalizeCodexCapacityRetrySettings({ codexCapacityRetryDelaysMs: [1800000, 3600000, -1, 'bad', null, Infinity, 9e99] }).codexCapacityRetryDelaysMs,
    [1800000, 3600000, 60000, 604800000]);
  assert.equal(normalizeCodexCapacityRetrySettings({ codexCapacityRetryDelaysMs: Array(20).fill(60000) }).codexCapacityRetryDelaysMs.length, 10);
});
