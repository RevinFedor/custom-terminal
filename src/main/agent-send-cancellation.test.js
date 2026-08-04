'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentSendCancellationRegistry } = require('./agent-send-cancellation');

test('cancels only the exact tab and handoff', () => {
  const registry = createAgentSendCancellationRegistry();
  assert.equal(registry.cancel('tab-a', 'handoff-a', 100).cancelled, true);
  assert.equal(registry.isCancelled('tab-a', 'handoff-a'), true);
  assert.equal(registry.isCancelled('tab-a', 'handoff-b'), false);
  assert.equal(registry.isCancelled('tab-b', 'handoff-a'), false);
});

test('a stale cancellation cannot affect the next send and cleanup is exact', () => {
  const registry = createAgentSendCancellationRegistry();
  registry.cancel('tab-a', 'handoff-old', 100);
  assert.equal(registry.isCancelled('tab-a', 'handoff-new'), false);
  assert.equal(registry.clear('tab-a', 'handoff-new'), false);
  assert.equal(registry.isCancelled('tab-a', 'handoff-old'), true);
  assert.equal(registry.clear('tab-a', 'handoff-old'), true);
  assert.equal(registry.isCancelled('tab-a', 'handoff-old'), false);
});

test('duplicate Stop is idempotent', () => {
  const registry = createAgentSendCancellationRegistry();
  assert.equal(registry.cancel('tab-a', 'handoff-a', 100).deduped, false);
  const duplicate = registry.cancel('tab-a', 'handoff-a', 200);
  assert.equal(duplicate.deduped, true);
  assert.equal(duplicate.cancelledAt, 100);
});

test('an exact waiter wakes on cancellation and ignores another handoff', async () => {
  const registry = createAgentSendCancellationRegistry();
  const waiter = registry.wait('tab-a', 'handoff-a');
  registry.cancel('tab-a', 'handoff-b', 100);
  let settled = false;
  waiter.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  registry.cancel('tab-a', 'handoff-a', 101);
  const result = await waiter.promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.handoffId, 'handoff-a');
});

test('a cancellation for attempt A cannot poison retry attempt B', () => {
  const registry = createAgentSendCancellationRegistry();
  registry.cancel('tab-a', 'handoff-a', { attemptId: 'attempt-a', now: 100 });

  assert.equal(registry.isCancelled('tab-a', 'handoff-a', 'attempt-a'), true);
  assert.equal(registry.isCancelled('tab-a', 'handoff-a', 'attempt-b'), false);
  assert.equal(registry.clear('tab-a', 'handoff-a'), true);
  assert.equal(registry.isCancelled('tab-a', 'handoff-a', 'attempt-a'), false);
});

test('a physical waiter for retry B ignores a late cancellation from attempt A', async () => {
  const registry = createAgentSendCancellationRegistry();
  const waiter = registry.wait('tab-a', 'handoff-a', 'attempt-b');
  registry.cancel('tab-a', 'handoff-a', { attemptId: 'attempt-a', now: 100 });

  let settled = false;
  waiter.promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  registry.cancel('tab-a', 'handoff-a', { attemptId: 'attempt-b', now: 101 });
  const result = await waiter.promise;
  assert.equal(result.cancelled, true);
  assert.equal(result.attemptId, 'attempt-b');
});
