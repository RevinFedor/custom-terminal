import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectTabSaveQueue } from './projectTabSaveQueue.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('same-project full snapshots commit in call order', async () => {
  const queue = createProjectTabSaveQueue();
  const first = deferred();
  const firstStarted = deferred();
  const order = [];

  const a = queue.enqueue('project-a', async () => {
    order.push('a:start');
    firstStarted.resolve();
    await first.promise;
    order.push('a:end');
    return 'a';
  });
  const b = queue.enqueue('project-a', async () => {
    order.push('b:start');
    return 'b';
  });

  await firstStarted.promise;
  assert.deepEqual(order, ['a:start']);
  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start']);
  assert.equal(queue.pending('project-a'), false);
});

test('a rejected snapshot does not poison the next snapshot', async () => {
  const queue = createProjectTabSaveQueue();
  const first = queue.enqueue('project-a', async () => {
    throw new Error('first failed');
  });
  const second = queue.enqueue('project-a', async () => 'second committed');

  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'second committed');
});

test('different projects do not block one another', async () => {
  const queue = createProjectTabSaveQueue();
  const hold = deferred();
  const started = [];
  const a = queue.enqueue('project-a', async () => {
    started.push('a');
    await hold.promise;
  });
  const b = queue.enqueue('project-b', async () => {
    started.push('b');
  });

  await b;
  assert.deepEqual(started, ['a', 'b']);
  hold.resolve();
  await a;
});
