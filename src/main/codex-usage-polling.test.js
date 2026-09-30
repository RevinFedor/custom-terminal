'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexUsagePolling } = require('./codex-usage-polling');

function harness(refreshTarget) {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const calls = [];
  const updates = [];
  let targets = [{ key: 'A', identity: 'token-a' }, { key: 'B', identity: 'profile-b' }];
  const polling = createCodexUsagePolling({
    listTargets: () => targets,
    refreshTarget: target => { calls.push({ key: target.key, at: now }); return refreshTarget?.(target); },
    onUpdated: target => updates.push(target.key),
    now: () => now,
    setTimer: (fn, delay) => { const key = ++id; timers.set(key, { fn, at: now + delay }); return key; },
    clearTimer: key => timers.delete(key),
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return {
    polling, calls, updates, timers,
    setTargets: value => { targets = value; },
    async advance(to) {
      for (;;) {
        const next = [...timers.entries()].find(([, timer]) => timer.at <= to);
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = to;
      await flush();
    },
  };
}

test('both connected accounts refresh every 30s with no renderer or selection', async () => {
  const h = harness();
  h.polling.start();
  h.polling.start();
  await h.advance(60_000);
  assert.deepEqual(h.calls, [0, 30_000, 60_000].flatMap(at => [{ key: 'A', at }, { key: 'B', at }]));
  h.polling.stop();
  assert.equal(h.timers.size, 0);
});

test('a slow account does not delay another or duplicate its own request', async () => {
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const h = harness(target => target.key === 'A' ? slow : { error: null });
  h.polling.start();
  await h.advance(60_000);
  assert.equal(h.calls.filter(call => call.key === 'A').length, 1);
  assert.equal(h.calls.filter(call => call.key === 'B').length, 3);
  release({ error: null });
  await h.advance(60_000);
  await h.advance(90_000);
  assert.equal(h.calls.filter(call => call.key === 'A').length, 2);
  h.polling.stop();
});

test('failure cooldown is account scoped and account rotation revokes it', async () => {
  const h = harness(target => target.key === 'A' ? { error: '429' } : {});
  h.polling.start();
  await h.advance(30_000);
  assert.deepEqual(h.calls, [{ key: 'A', at: 0 }, { key: 'B', at: 0 }, { key: 'B', at: 30_000 }]);
  h.setTargets([{ key: 'A', identity: 'new-token' }, { key: 'B', identity: 'profile-b' }]);
  await h.advance(60_000);
  assert.equal(h.calls.filter(call => call.key === 'A').length, 2);
  await h.advance(90_000);
  assert.equal(h.calls.filter(call => call.key === 'A').length, 2);
  h.polling.stop();
});

test('disconnected accounts and late completion after shutdown do not update the UI', async () => {
  let release;
  const h = harness(target => target.key === 'A' ? new Promise(resolve => { release = resolve; }) : {});
  h.polling.start();
  await h.advance(0);
  h.setTargets([{ key: 'B', identity: 'profile-b' }]);
  await h.advance(30_000);
  h.polling.stop();
  release({});
  await h.advance(120_000);
  assert.deepEqual(h.updates, ['B', 'B']);
  assert.equal(h.timers.size, 0);
});

test('a transient credential discovery failure does not stop the account clock', async () => {
  let callback;
  let attempts = 0;
  let calls = 0;
  const polling = createCodexUsagePolling({
    listTargets: () => { if (++attempts === 1) throw new Error('auth file replaced'); return [{ key: 'A' }]; },
    refreshTarget: () => { calls++; },
    setTimer: fn => { callback = fn; return 1; }, clearTimer() {},
  });
  polling.start();
  callback();
  callback();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(calls, 1);
  polling.stop();
});
