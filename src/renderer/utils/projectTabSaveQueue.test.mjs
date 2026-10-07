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

test('a multi-catalog close waits for earlier saves and reserves every touched catalog', async () => {
  const queue = createProjectTabSaveQueue(), hold = deferred(), order = [];
  const before = queue.enqueue('a', async () => { order.push('before'); await hold.promise; });
  const close = queue.enqueueMany(['a', 'b'], async () => { order.push('close'); });
  const after = queue.enqueue('b', async () => { order.push('after'); });
  const unrelated = queue.enqueue('c', async () => { order.push('unrelated'); });
  await unrelated;
  assert.deepEqual(order, ['before', 'unrelated']);
  assert.equal(queue.pending('a'), true); assert.equal(queue.pending('b'), true);
  hold.resolve(); await Promise.all([before, close, after]);
  assert.deepEqual(order, ['before', 'unrelated', 'close', 'after']);
  assert.equal(queue.pending('a'), false); assert.equal(queue.pending('b'), false);
});

test('overlapping cohorts cannot overtake one another or deadlock, including a failure', async () => {
  const queue = createProjectTabSaveQueue(), order = [];
  const first = queue.enqueueMany(['b', 'a'], async () => { order.push('first'); throw Error('refused'); });
  const second = queue.enqueueMany(['c', 'b'], async () => { order.push('second'); });
  const third = queue.enqueue('a', async () => { order.push('third'); });
  await assert.rejects(first, /refused/);
  await Promise.all([second, third]);
  assert.equal(order[0], 'first'); assert.ok(order.includes('second') && order.includes('third'));
  assert.equal(queue.pending('a'), false); assert.equal(queue.pending('b'), false);
});

test('empty cohort is rejected; duplicate project identity does not reserve twice', async () => {
  const queue = createProjectTabSaveQueue();
  await assert.rejects(queue.enqueueMany([], () => {}), /projectId/);
  let commits = 0;
  await queue.enqueueMany(['a', 'a'], () => { commits++; });
  assert.equal(commits, 1); assert.equal(queue.pending('a'), false);
});
