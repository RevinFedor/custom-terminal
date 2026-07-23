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
