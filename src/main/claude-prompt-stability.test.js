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
