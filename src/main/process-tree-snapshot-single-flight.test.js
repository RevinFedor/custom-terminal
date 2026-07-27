'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProcessTreeSnapshotSingleFlight,
} = require('./process-tree-snapshot-single-flight');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('parallel normal callers share one capture', async () => {
  const gate = deferred();
  const calls = [];
  let clock = 0;
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    now: () => ++clock,
    capture: async (context) => {
      calls.push(context);
      return gate.promise;
    },
  });

  const first = singleFlight.get();
  const second = singleFlight.get();
  await nextTurn();

  assert.equal(calls.length, 1);
  assert.deepEqual(singleFlight.snapshot(), { forceFresh: false, waiters: 1 });

  gate.resolve({ id: 'normal' });
  const [owner, joiner] = await Promise.all([first, second]);
  assert.equal(owner.value.id, 'normal');
  assert.equal(owner.source, 'spawn');
  assert.equal(joiner.source, 'inflight');
  assert.equal(owner.waiters, 1);
});

test('parallel force-fresh callers share one fresh capture', async () => {
  const gate = deferred();
  let calls = 0;
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    capture: async () => {
      calls += 1;
      return gate.promise;
    },
  });

  const first = singleFlight.get({ forceFresh: true });
  const second = singleFlight.get({ forceFresh: true });
  const third = singleFlight.get({ forceFresh: true });
  await nextTurn();

  assert.equal(calls, 1);
  assert.deepEqual(singleFlight.snapshot(), { forceFresh: true, waiters: 2 });

  gate.resolve({ id: 'fresh' });
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(
    results.map((result) => result.source),
    ['force-fresh', 'inflight-force-fresh', 'inflight-force-fresh'],
  );
  assert.ok(results.every((result) => result.value.id === 'fresh'));
});

test('force-fresh callers wait out normal work then share one trailing fresh capture', async () => {
  const normalGate = deferred();
  const freshGate = deferred();
  const calls = [];
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    capture: async ({ forceFresh }) => {
      calls.push(forceFresh ? 'fresh' : 'normal');
      return forceFresh ? freshGate.promise : normalGate.promise;
    },
  });

  const normal = singleFlight.get();
  const freshOne = singleFlight.get({ forceFresh: true });
  const freshTwo = singleFlight.get({ forceFresh: true });
  await nextTurn();
  assert.deepEqual(calls, ['normal']);

  normalGate.resolve({ id: 'old-normal' });
  await nextTurn();
  assert.deepEqual(calls, ['normal', 'fresh']);
  assert.deepEqual(singleFlight.snapshot(), { forceFresh: true, waiters: 1 });

  freshGate.resolve({ id: 'new-fresh' });
  const [normalResult, freshResultOne, freshResultTwo] = await Promise.all([
    normal,
    freshOne,
    freshTwo,
  ]);
  assert.equal(normalResult.value.id, 'old-normal');
  assert.equal(freshResultOne.value.id, 'new-fresh');
  assert.equal(freshResultTwo.value.id, 'new-fresh');
  assert.equal(freshResultOne.source, 'force-fresh');
  assert.equal(freshResultTwo.source, 'inflight-force-fresh');
});

test('normal caller joins an in-flight fresh capture', async () => {
  const gate = deferred();
  let calls = 0;
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    capture: async () => {
      calls += 1;
      return gate.promise;
    },
  });

  const fresh = singleFlight.get({ forceFresh: true });
  const normal = singleFlight.get();
  await nextTurn();
  assert.equal(calls, 1);

  gate.resolve({ id: 'shared' });
  const [, normalResult] = await Promise.all([fresh, normal]);
  assert.equal(normalResult.source, 'inflight-force-fresh');
  assert.equal(normalResult.value.id, 'shared');
});

test('failure clears ownership and a later caller can retry', async () => {
  let attempts = 0;
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    capture: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ps unavailable');
      return { id: 'recovered' };
    },
  });

  await assert.rejects(singleFlight.get(), /ps unavailable/);
  assert.equal(singleFlight.snapshot(), null);

  const result = await singleFlight.get();
  assert.equal(result.value.id, 'recovered');
  assert.equal(result.source, 'spawn');
  assert.equal(attempts, 2);
});

test('failed normal capture does not prevent a waiting force-fresh retry', async () => {
  const normalGate = deferred();
  let attempts = 0;
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    capture: async ({ forceFresh }) => {
      attempts += 1;
      if (!forceFresh) return normalGate.promise;
      return { id: 'fresh-after-failure' };
    },
  });

  const normal = singleFlight.get();
  const fresh = singleFlight.get({ forceFresh: true });
  await nextTurn();
  normalGate.reject(new Error('normal ps failed'));

  await assert.rejects(normal, /normal ps failed/);
  const freshResult = await fresh;
  assert.equal(freshResult.value.id, 'fresh-after-failure');
  assert.equal(attempts, 2);
});

test('invalidation prevents post-boundary callers from joining an older capture', async () => {
  const oldGate = deferred();
  const freshGate = deferred();
  const calls = [];
  const published = [];
  const singleFlight = createProcessTreeSnapshotSingleFlight({
    capture: async (context) => {
      const callIndex = calls.length;
      calls.push(context);
      const value = await (callIndex === 0 ? oldGate.promise : freshGate.promise);
      if (context.isCurrent()) published.push(value.id);
      return value;
    },
  });

  const beforeBoundary = singleFlight.get();
  await nextTurn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isCurrent(), true);

  assert.equal(singleFlight.invalidate(), 1);
  assert.equal(calls[0].isCurrent(), false);

  const afterBoundaryOne = singleFlight.get();
  const afterBoundaryTwo = singleFlight.get();
  await nextTurn();
  assert.equal(calls.length, 1, 'new callers wait out the invalidated OS command');

  oldGate.resolve({ id: 'pre-stop-process-tree' });
  assert.equal((await beforeBoundary).value.id, 'pre-stop-process-tree');
  await nextTurn();
  assert.equal(calls.length, 2, 'one trailing capture owns the new generation');
  assert.equal(calls[1].generation, 1);
  assert.equal(calls[1].isCurrent(), true);
  assert.deepEqual(published, [], 'the old generation cannot republish its snapshot');

  freshGate.resolve({ id: 'post-stop-process-tree' });
  const [first, second] = await Promise.all([afterBoundaryOne, afterBoundaryTwo]);
  assert.equal(first.value.id, 'post-stop-process-tree');
  assert.equal(second.value.id, 'post-stop-process-tree');
  assert.deepEqual(published, ['post-stop-process-tree']);
});
