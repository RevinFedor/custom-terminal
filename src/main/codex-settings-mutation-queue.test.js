'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexSettingsMutationQueue } = require('./codex-settings-mutation-queue');

test('persistent Codex settings transactions are serialized across tabs', async () => {
  const queue = createCodexSettingsMutationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    events.push('tab-a:start');
    await firstGate;
    events.push('tab-a:config-proof');
    return 'a';
  });
  const second = queue.run(async () => {
    events.push('tab-b:start');
    events.push('tab-b:config-proof');
    return 'b';
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['tab-a:start']);
  assert.equal(queue.pending, 2);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(events, [
    'tab-a:start',
    'tab-a:config-proof',
    'tab-b:start',
    'tab-b:config-proof',
  ]);
  assert.equal(queue.pending, 0);
});

test('unsubmitted input receipt survives the observer slot but does not block another terminal', async () => {
  const queue = createCodexSettingsMutationQueue();
  const term = {}, other = {}, receipt = { command: '/model' };
  await queue.run(() => assert.equal(queue.rememberUnsubmittedInput(term, receipt), true));
  assert.equal(queue.pending, 0);
  assert.equal(queue.getUnsubmittedInput(term), receipt);
  assert.equal(queue.rememberUnsubmittedInput(term, {}), false, 'a new caller cannot overwrite unresolved ownership');
  assert.equal(queue.releaseUnsubmittedInput(term, {}), false, 'release is exact-receipt CAS');
  assert.equal(await queue.run(() => queue.getUnsubmittedInput(other)), null);
  assert.equal(queue.releaseUnsubmittedInput(term, receipt), true);
  assert.equal(queue.getUnsubmittedInput(term), null);
});
