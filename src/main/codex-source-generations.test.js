'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexSourceGenerations } = require('./codex-source-generations');
const { CodexReadFence, retryInvalidatedCodexRead } = require('./codex-read-fence');
const stat = (size, time, ino = 10) => ({ dev: 1, ino, size, mtimeMs: time, ctimeMs: time });

test('source generation survives append and changes on rewrite or explicit writer invalidation', () => {
  const cache = new CodexSourceGenerations();
  const first = cache.observe('/a', stat(100, 1), 'owner').generation;
  assert.equal(cache.observe('/a', stat(120, 2)).generation, first);
  assert.equal(cache.observe('/a', stat(120, 2)).generation, first);
  const rewrite = cache.observe('/a', { ...stat(120, 2), ctimeMs: 3 });
  assert.notEqual(rewrite.generation, first);
  assert.deepEqual([...rewrite.sessions], ['owner']);
  cache.invalidate('/a');
  assert.equal(cache.get('/a').rewritePending, true);
  const explicit = cache.observe('/a', stat(140, 4));
  assert.notEqual(explicit.generation, rewrite.generation);
  assert.equal(explicit.rewritten, true);
});

test('an older completed append cursor does not roll the source witness backwards', () => {
  const cache = new CodexSourceGenerations();
  const generation = cache.observe('/a', stat(120, 12)).generation;
  assert.equal(cache.observe('/a', stat(110, 11)).generation, generation);
  assert.equal(cache.get('/a').stat.size, 120);
  assert.equal(cache.get('/a').stat.ctimeMs, 12);
});

test('source metadata has a byte limit and preserves a currently pinned source', () => {
  let pinned = '/a';
  const cache = new CodexSourceGenerations({ maxBytes: 900, pinned: name => name === pinned });
  const first = cache.observe('/a', stat(1, 1)).generation;
  for (let i = 0; i < 30; i += 1) cache.observe('/other-' + i, stat(i, i));
  assert.equal(cache.get('/a').generation, first);
  assert.ok(cache.bytes <= 900);
  pinned = null;
  for (let i = 0; i < 30; i += 1) cache.observe('/new-' + i, stat(i, i));
  assert.equal(cache.get('/a'), null);
  assert.notEqual(cache.observe('/a', stat(1, 1)).generation, first, 'forgotten metadata cannot reuse an old payload cache namespace');
});

test('read fences isolate paths/kinds and release all in-flight ownership after a retry', async () => {
  const fence = new CodexReadFence();
  const other = fence.begin('/other', 'raw');
  const raw = fence.begin('/a', 'raw');
  const projection = fence.begin('/a', 'projection');
  fence.invalidate('/a', 'projection');
  assert.throws(() => fence.assertCurrent(projection), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
  fence.assertCurrent(raw); fence.assertCurrent(other);
  fence.finish(projection); fence.finish(raw); fence.finish(other);
  let attempts = 0;
  const result = await retryInvalidatedCodexRead(async () => {
    const ticket = fence.begin('/a', 'projection');
    try {
      attempts += 1;
      if (attempts === 1) fence.invalidate('/a');
      fence.assertCurrent(ticket);
      return 'fresh';
    } finally { fence.finish(ticket); }
  });
  assert.equal(result, 'fresh');
  assert.equal(attempts, 2);
  assert.equal(fence.active.size, 0);
});
