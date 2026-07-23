const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OrchestrationRunStore } = require('./orchestration-runs');

async function makeStore() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-'));
  return {
    store: new OrchestrationRunStore(path.join(dir, 'runs.json')),
    cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

function baseRun(runId, targetTabId = 'target-1') {
  return {
    runId,
    sourceTabId: 'source-1',
    sourceProjectId: 'project-a',
    targetTabId,
    targetProjectId: 'project-b',
    promptHash: 'hash-' + runId,
  };
}

test('queue-capable idle target completes after its own busy-to-done lifecycle', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1', { queued: true, baselineBusy: false });
    assert.equal((await store.get('run-1')).status, 'sent');
    let event = await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal(event.completed.length, 0);
    await store.applyLifecycle('target-1', { type: 'busy', busy: true, sessionId: 'session-1' });
    event = await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete', sessionId: 'session-1' });
    assert.equal(event.completed.length, 1);
    assert.equal((await store.get('run-1')).status, 'completed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('startup lifecycle is ignored until prompt delivery is accepted', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.patch('run-1', { status: 'starting' });
    await store.applyLifecycle('target-1', { type: 'busy', busy: true, sessionId: 'startup-session' });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete', sessionId: 'startup-session' });
    assert.equal((await store.get('run-1')).status, 'starting');

    await store.markDelivery('run-1', { sessionId: 'startup-session' });
    await store.applyLifecycle('target-1', { type: 'busy', busy: true, sessionId: 'startup-session' });
    const event = await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete', sessionId: 'startup-session' });
    assert.equal(event.completed.length, 1);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('busy target consumes the previous completion before starting queued work', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1', { queued: true, baselineBusy: true });
    let event = await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal(event.completed.length, 0);
    assert.equal((await store.get('run-1')).status, 'queued');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    event = await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal(event.completed.length, 1);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('multiple runs on one target advance one lifecycle at a time', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1', { queued: false, baselineBusy: false });
    await store.create(baseRun('run-2'));
    await store.markDelivery('run-2', { queued: true, baselineBusy: true });

    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('run-1')).status, 'completed');
    assert.equal((await store.get('run-2')).status, 'queued');

    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('run-2')).status, 'completed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('aborted target turn is a failure, not a successful completion', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    const event = await store.applyLifecycle('target-1', { type: 'done', reason: 'turn_aborted' });
    assert.equal(event.completed.length, 0);
    assert.equal((await store.get('run-1')).status, 'failed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('transcript reconciliation recovers a completed run after restart', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    const result = await store.reconcile('run-1', {
      busy: false,
      sessionId: 'session-1',
      resultFound: true,
      resultAvailable: true,
      turnIndex: 12,
    });
    assert.equal(result.completed, true);
    const run = await store.get('run-1');
    assert.equal(run.status, 'completed');
    assert.equal(run.resultTurnIndex, 12);
  } finally {
    await store.flush();
    await cleanup();
  }
});
