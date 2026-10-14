import assert from 'node:assert/strict';
import test from 'node:test';

test('core package subpath imports without DOM globals', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');

  const core = await import('@noted/structured-dnd/core');

  assert.equal(typeof core.flattenVisible, 'function');
  assert.equal(typeof core.begin, 'function');
  assert.equal(typeof core.commit, 'function');
});
