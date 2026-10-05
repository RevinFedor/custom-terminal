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

test('physical sendTarget allocation does not churn revisions but every changed owner field does', () => {
  const sendTarget = {
    toolType: 'codex', terminalInstanceId: 'I', launchId: 'L', sessionId: null,
    acceptedResumeSourceSessionId: null, lifecycleGeneration: 'G:1', turnId: null,
  };
  for (const field of Object.keys(sendTarget)) {
    const store = createCodexRuntimeProjectionStore();
    const before = store.publish('T', { sessionStatus: 'starting', sendTarget });
    assert.strictEqual(store.publish('T', {
      sessionStatus: 'starting', sendTarget: { ...sendTarget },
    }), before);
    const after = store.publish('T', {
      sessionStatus: 'starting', sendTarget: { ...sendTarget, [field]: 'changed-' + field },
    });
    assert.equal(after.runtimeRevision, before.runtimeRevision + 1, field);
    const missingTarget = store.publish('T', { sessionStatus: 'starting', sendTarget: null });
    assert.equal(missingTarget.runtimeRevision, after.runtimeRevision + 1);
  }
});
