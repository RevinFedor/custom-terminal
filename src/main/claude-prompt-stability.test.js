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
