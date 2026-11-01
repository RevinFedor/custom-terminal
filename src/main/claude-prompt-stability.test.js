'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createClaudePromptStabilityRegistry,
} = require('./claude-prompt-stability');

test('startup send remains pending until the prompt output settles', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1', 'shell-write');

  let settled = false;
  const waiting = registry.wait('tab-a', 'launch-1').then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  assert.equal(registry.markStable('tab-a', 'launch-1', 'output-silence'), true);
  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.generation, 'launch-1');
  assert.equal(result.reason, 'output-silence');
  assert.equal(Number.isFinite(result.at), true);
});

test('opening a newer generation releases an older waiter as superseded', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  const oldWait = registry.wait('tab-a', 'launch-1');

  registry.open('tab-a', 'launch-2');
  assert.deepEqual(await oldWait, {
    ready: false,
    generation: 'launch-1',
    reason: 'generation-superseded',
  });
  assert.equal(registry.snapshot('tab-a').generation, 'launch-2');
});

test('a stale readiness signal cannot settle the current generation', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-2');
  assert.equal(registry.markStable('tab-a', 'launch-1'), false);
  assert.equal(registry.snapshot('tab-a').settled, false);
  registry.markStable('tab-a', 'launch-2');
  assert.equal((await registry.wait('tab-a', 'launch-2')).ready, true);
});

test('process clear releases a pending waiter without authorizing input', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  const waiting = registry.wait('tab-a', 'launch-1');
  assert.equal(registry.clear('tab-a', 'launch-1', 'process-exit'), true);
  assert.deepEqual(await waiting, {
    ready: false,
    generation: 'launch-1',
    reason: 'process-exit',
  });
  assert.equal(registry.snapshot('tab-a'), null);
});

test('duplicate open joins the same generation gate', () => {
  const registry = createClaudePromptStabilityRegistry();
  const first = registry.open('tab-a', 'launch-1');
  const second = registry.open('tab-a', 'launch-1');
  assert.equal(second, first);
});

test('a redraw after the prompt invalidates its lease and requires a fresh prompt frame', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  registry.markStable('tab-a', 'launch-1', 'first-prompt');
  const first = await registry.wait('tab-a', 'launch-1');
  assert.equal(registry.validate('tab-a', 'launch-1', first.lease).valid, true);

  registry.markActivity('tab-a', 'launch-1', 'restored-notification-redraw');
  assert.deepEqual(
    registry.validate('tab-a', 'launch-1', first.lease),
    { valid: false, reason: 'claude-prompt-frame-changed' },
  );

  let released = false;
  const nextWait = registry.wait('tab-a', 'launch-1').then((value) => {
    released = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(released, false);

  registry.markStable('tab-a', 'launch-1', 'prompt-after-restoration');
  const second = await nextWait;
  assert.equal(second.ready, true);
  assert.equal(second.reason, 'prompt-after-restoration');
  assert.equal(registry.validate('tab-a', 'launch-1', second.lease).valid, true);
  assert.notEqual(second.lease.promptEpoch, first.lease.promptEpoch);
});

test('busy start invalidates the lease and busy end alone never authorizes startup input', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  registry.markStable('tab-a', 'launch-1', 'first-prompt');
  const first = await registry.wait('tab-a', 'launch-1');

  registry.markBusy('tab-a', 'launch-1', true, 'restored-user-turn');
  assert.deepEqual(
    registry.validate('tab-a', 'launch-1', first.lease, { allowFrameAdvance: true }),
    { valid: false, reason: 'claude-turn-busy' },
  );
  registry.markBusy('tab-a', 'launch-1', false, 'restored-turn-stop');
  assert.deepEqual(
    registry.validate('tab-a', 'launch-1', first.lease, { allowFrameAdvance: true }),
    { valid: false, reason: 'claude-busy-generation-changed' },
  );

  let released = false;
  const nextWait = registry.wait('tab-a', 'launch-1').then((value) => {
    released = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(released, false);
  registry.markStable('tab-a', 'launch-1', 'fresh-prompt-after-stop');
  const next = await nextWait;
  assert.equal(registry.validate('tab-a', 'launch-1', next.lease).valid, true);
});

test('a prompt rendered while Claude is busy is observed but cannot release waiters', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  registry.markBusy('tab-a', 'launch-1', true, 'notification-start');
  assert.equal(registry.markStable('tab-a', 'launch-1', 'busy-frame'), false);

  let released = false;
  const waiting = registry.wait('tab-a', 'launch-1').then((value) => {
    released = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(released, false);

  registry.markBusy('tab-a', 'launch-1', false, 'notification-stop');
  await Promise.resolve();
  assert.equal(released, false);
  registry.markStable('tab-a', 'launch-1', 'idle-current-prompt');
  assert.equal((await waiting).ready, true);
});

test('multiple restored turns cannot reuse or shift an older prompt lease', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  registry.markStable('tab-a', 'launch-1', 'prompt-0');
  const lease0 = (await registry.wait('tab-a', 'launch-1')).lease;

  for (const suffix of ['a', 'b']) {
    registry.markBusy('tab-a', 'launch-1', true, 'notification-' + suffix);
    registry.markBusy('tab-a', 'launch-1', false, 'stop-' + suffix);
    registry.markStable('tab-a', 'launch-1', 'prompt-' + suffix);
  }
  const latest = await registry.wait('tab-a', 'launch-1');
  assert.equal(latest.reason, 'prompt-b');
  assert.deepEqual(
    registry.validate('tab-a', 'launch-1', lease0, { allowFrameAdvance: true }),
    { valid: false, reason: 'claude-busy-generation-changed' },
  );
  assert.equal(
    registry.validate('tab-a', 'launch-1', latest.lease, { allowFrameAdvance: true }).valid,
    true,
  );
});

test('frame advance can be admitted only by the caller that separately proves its pasted command', async () => {
  const registry = createClaudePromptStabilityRegistry();
  registry.open('tab-a', 'launch-1');
  registry.markStable('tab-a', 'launch-1', 'idle-prompt');
  const lease = (await registry.wait('tab-a', 'launch-1')).lease;

  registry.markActivity('tab-a', 'launch-1', 'paste-redraw');
  assert.deepEqual(
    registry.validate('tab-a', 'launch-1', lease),
    { valid: false, reason: 'claude-prompt-frame-changed' },
  );
  assert.deepEqual(
    registry.validate('tab-a', 'launch-1', lease, { allowFrameAdvance: true }),
    { valid: true, reason: 'claude-prompt-lease-current' },
  );
});

// Production 2026-10-31: three Claude clones (tabs d1718b66 / 029152fbe588 /
// 2efc9b9b7a35) hit the 5-hour usage limit. Claude printed the limit notice and
// "IDE extension install failed" outside a synchronized-output pair, so no
// further frame ever settled the gate. `/model` was never written, the startup
// gate stayed `pending`, and the tabs showed "configuring Claude" forever while
// the process was alive and the composer idle. The working tab in the same
// window logged 5250 frame events; each stuck tab logged exactly one `open`.
test('a launch that never paints another frame fails the wait instead of hanging', async () => {
  const timers = [];
  const registry = createClaudePromptStabilityRegistry({
    timeoutMs: 45000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (handle) => { if (timers[handle - 1]) timers[handle - 1] = null; },
  });
  registry.open('tab-a', 'launch-1', 'claude-run-command-resume');

  const waiting = registry.wait('tab-a', 'launch-1');
  const armed = timers.filter(Boolean);
  assert.equal(armed.length, 1, 'the wait arms exactly one deadline');
  assert.equal(armed[0].ms, 45000);

  armed[0].fn();
  const result = await waiting;
  // The deadline must never look like permission to paste or press Enter.
  assert.equal(result.ready, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.reason, 'prompt-stability-timeout-no-frame');
  assert.equal(result.generation, 'launch-1');
  assert.equal(result.afterMs, 45000);
});

test('an actively repainting launch is never cut short by the deadline', async () => {
  let handleSeq = 0;
  const live = new Map();
  const registry = createClaudePromptStabilityRegistry({
    timeoutMs: 1000,
    setTimer: (fn) => { handleSeq += 1; live.set(handleSeq, fn); return handleSeq; },
    clearTimer: (handle) => { live.delete(handle); },
  });
  registry.open('tab-a', 'launch-1');
  const waiting = registry.wait('tab-a', 'launch-1');

  // Each frame re-arms the deadline, so silence is measured from the last
  // observed frame rather than from the start of the wait.
  for (let index = 0; index < 5; index += 1) {
    registry.markActivity('tab-a', 'launch-1', 'synchronized-frame-begin:' + index);
    assert.equal(live.size, 1, 'exactly one deadline stays armed');
  }
  registry.markStable('tab-a', 'launch-1', 'current-composer-frame:9');

  const result = await waiting;
  assert.equal(result.ready, true);
  assert.equal(result.reason, 'current-composer-frame:9');
  assert.equal(live.size, 0, 'readiness disarms the deadline');
});

test('a busy launch reports the busy timeout reason separately', async () => {
  const timers = [];
  const registry = createClaudePromptStabilityRegistry({
    timeoutMs: 30000,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (handle) => { if (timers[handle - 1]) timers[handle - 1] = null; },
  });
  registry.open('tab-a', 'launch-1');
  registry.markBusy('tab-a', 'launch-1', true, 'claude-hook:UserPromptSubmit');
  const waiting = registry.wait('tab-a', 'launch-1');

  timers.filter(Boolean).pop()();
  const result = await waiting;
  assert.equal(result.ready, false);
  assert.equal(result.reason, 'prompt-stability-timeout-busy');
});

test('no deadline is armed while nothing is waiting', () => {
  const timers = [];
  const registry = createClaudePromptStabilityRegistry({
    timeoutMs: 1000,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  registry.open('tab-a', 'launch-1');
  registry.markActivity('tab-a', 'launch-1', 'frame');
  registry.markStable('tab-a', 'launch-1', 'idle');
  assert.equal(timers.length, 0, 'signals alone must not create timers');
  assert.equal(registry.snapshot('tab-a').deadlineAt, null);
});

test('clearing the gate cancels the deadline and reports the clear reason', async () => {
  const cleared = [];
  const registry = createClaudePromptStabilityRegistry({
    timeoutMs: 5000,
    setTimer: () => 1,
    clearTimer: (handle) => cleared.push(handle),
  });
  registry.open('tab-a', 'launch-1');
  const waiting = registry.wait('tab-a', 'launch-1');
  registry.clear('tab-a', 'launch-1', 'process-exit');
  assert.deepEqual(await waiting, {
    ready: false,
    generation: 'launch-1',
    reason: 'process-exit',
  });
  assert.ok(cleared.includes(1), 'the pending deadline is cancelled');
});

test('a deadline from a superseded generation cannot fail the new one', async () => {
  const timers = [];
  const registry = createClaudePromptStabilityRegistry({
    timeoutMs: 5000,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  registry.open('tab-a', 'launch-1');
  const first = registry.wait('tab-a', 'launch-1');
  const staleDeadline = timers[timers.length - 1];

  registry.open('tab-a', 'launch-2');
  assert.equal((await first).reason, 'generation-superseded');

  const second = registry.wait('tab-a', 'launch-2');
  staleDeadline();
  registry.markStable('tab-a', 'launch-2', 'fresh-frame');
  assert.equal((await second).ready, true, 'the stale timer must not touch launch-2');
});
