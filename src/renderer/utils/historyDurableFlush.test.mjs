import test from 'node:test';
import assert from 'node:assert/strict';
import { flushHistoryDurableWithRetry } from './historyDurableFlush.mjs';

test('failed durable load retries without waiting for another transcript event', async () => {
  let calls = 0;
  let unmatched = true;
  const result = await flushHistoryDurableWithRetry({
    load: async () => {
      calls += 1;
      if (calls === 1) return false;
      unmatched = false;
      return true;
    },
    isCurrent: () => true,
    hasUnmatchedLive: () => unmatched,
  });

  assert.deepEqual(result, {
    success: true,
    settled: true,
    stale: false,
    attempts: 2,
  });
  assert.equal(calls, 2);
});

test('successful stale snapshot retries while unmatched live state remains', async () => {
  let calls = 0;
  const result = await flushHistoryDurableWithRetry({
    load: async () => {
      calls += 1;
      return true;
    },
    isCurrent: () => true,
    hasUnmatchedLive: () => calls < 2,
  });

  assert.equal(result.settled, true);
  assert.equal(result.attempts, 2);
});

test('owner change stops retry before a new owner can be mutated', async () => {
  let current = true;
  let calls = 0;
  const result = await flushHistoryDurableWithRetry({
    load: async () => {
      calls += 1;
      current = false;
      return false;
    },
    isCurrent: () => current,
    hasUnmatchedLive: () => true,
  });

  assert.equal(result.stale, true);
  assert.equal(calls, 1);
});
