'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexRuntimeProjectionStore } = require('./codex-runtime-projection-store');

test('runtime projections are immutable, monotonic and batch-readable without observers', () => {
  const store = createCodexRuntimeProjectionStore();
  const first = store.publish('tab-a', { sessionStatus: 'starting' }, 'launch');
  const second = store.publish('tab-a', { sessionStatus: 'active' }, 'ready');
  const unchanged = store.publish('tab-a', { sessionStatus: 'active' }, 'status-read');
  store.publish('tab-b', { sessionStatus: 'inactive' }, 'stopped');

  assert.equal(first.runtimeRevision, 1);
  assert.equal(second.runtimeRevision, 2);
  assert.equal(unchanged, second);
  assert.equal(Object.isFrozen(second), true);
  assert.deepEqual(Object.keys(store.readBatch(['tab-a', 'missing', 'tab-b'])), ['tab-a', 'tab-b']);
  assert.equal(store.read('tab-a').sessionStatus, 'active');
  assert.equal(store.remove('tab-a'), true);
  assert.equal(store.read('tab-a'), null);
});
