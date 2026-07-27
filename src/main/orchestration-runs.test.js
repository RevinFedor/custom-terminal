const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  OrchestrationRunStore,
  hasNewerTargetRun,
  isCompleteOrchestrationResult,
} = require('./orchestration-runs');

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
    await store.create({ ...baseRun('run-1'), reactToManualInterrupt: true });
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    const event = await store.applyLifecycle('target-1', { type: 'done', reason: 'turn_aborted' });
    assert.equal(event.settled.length, 0);
    const run = await store.get('run-1');
    assert.equal(run.status, 'waiting_recovery');
    assert.equal(run.outcome, 'interrupted');
    assert.ok(run.recoveryDeadlineAt > Date.now());
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('parent waits until a completed child notification is consumed by a new turn', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('parent', 'worker'));
    await store.markDelivery('parent');
    await store.applyLifecycle('worker', { type: 'busy', busy: true });

    const child = await store.create({
      ...baseRun('child', 'tester'),
      sourceTabId: 'worker',
    });
    assert.equal(child.parentRunId, 'parent');
    await store.markDelivery('child');
    await store.applyLifecycle('tester', { type: 'busy', busy: true });
    const childDone = await store.applyLifecycle('tester', { type: 'done', reason: 'task_complete' });
    assert.deepEqual(childDone.settled.map((run) => run.runId), ['child']);

    const parentDone = await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.equal(parentDone.settled.length, 0);
    assert.equal((await store.get('parent')).status, 'waiting_descendants');

    await store.patch('child', {
      notificationPromptHash: 'hash-child-completion',
      notificationAttemptedAt: Date.now(),
    });
    await store.markNotification('child', 'queued');
    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    const consumedChild = await store.get('child');
    assert.ok(consumedChild.parentConsumedAt);
    assert.equal((await store.get('parent')).status, 'running');
    assert.equal((await store.getInternal('parent')).resultPromptHash, 'hash-child-completion');

    const finalDone = await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.deepEqual(finalDone.settled.map((run) => run.runId), ['parent']);
    assert.equal((await store.get('parent')).status, 'completed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('parallel child notifications are consumed one target turn at a time', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('parent', 'worker'));
    await store.markDelivery('parent');
    await store.applyLifecycle('worker', { type: 'busy', busy: true });

    await store.create({ ...baseRun('child-a', 'tester-a'), sourceTabId: 'worker' });
    await store.markDelivery('child-a');
    await store.applyLifecycle('tester-a', { type: 'busy', busy: true });
    await store.applyLifecycle('tester-a', { type: 'done', reason: 'task_complete' });
    await store.patch('child-a', {
      notificationPromptHash: 'hash-child-a-completion',
      notificationAttemptedAt: 100,
    });
    await store.markNotification('child-a', 'queued');

    await store.create({ ...baseRun('child-b', 'tester-b'), sourceTabId: 'worker' });
    await store.markDelivery('child-b');
    await store.applyLifecycle('tester-b', { type: 'busy', busy: true });
    await store.applyLifecycle('tester-b', { type: 'done', reason: 'task_complete' });
    await store.patch('child-b', {
      notificationPromptHash: 'hash-child-b-completion',
      notificationAttemptedAt: 200,
    });
    await store.markNotification('child-b', 'queued');

    await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.deepEqual((await store.get('parent')).waitingOnRunIds, ['child-a', 'child-b']);

    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    assert.ok((await store.get('child-a')).parentConsumedAt);
    assert.equal((await store.get('child-b')).parentConsumedAt, undefined);
    assert.equal((await store.getInternal('parent')).resultPromptHash, 'hash-child-a-completion');
    await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('parent')).status, 'waiting_descendants');
    assert.deepEqual((await store.get('parent')).waitingOnRunIds, ['child-b']);

    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    assert.ok((await store.get('child-b')).parentConsumedAt);
    assert.equal((await store.getInternal('parent')).resultPromptHash, 'hash-child-b-completion');
    const final = await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.deepEqual(final.settled.map((run) => run.runId), ['parent']);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('waitForDescendants false allows an early parent result', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('parent', 'worker'), waitForDescendants: false });
    await store.markDelivery('parent');
    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    await store.create({ ...baseRun('child', 'tester'), sourceTabId: 'worker' });
    await store.markDelivery('child');

    const event = await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.deepEqual(event.settled.map((run) => run.runId), ['parent']);
    assert.equal((await store.get('parent')).status, 'completed');
    assert.equal((await store.get('child')).status, 'sent');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('manual interruption can wait indefinitely when the Escape policy is disabled', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-1'), reactToManualInterrupt: false });
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'interrupt' });
    const run = await store.get('run-1');
    assert.equal(run.status, 'waiting_recovery');
    assert.equal(run.recoveryDeadlineAt, null);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('recovery deadline produces a final failure that can be notified', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-1'), failureGraceMs: 1000 });
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    const startedAt = Date.now();
    await store.applyLifecycle('target-1', { type: 'done', reason: 'provider_error' });
    const expired = await store.expireRecoveryDeadlines(startedAt + 1500);
    assert.deepEqual(expired.settled.map((run) => run.runId), ['run-1']);
    assert.equal((await store.get('run-1')).status, 'failed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('new confirmed work reopens an interrupted run automatically', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'turn_aborted' });
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    const reopened = await store.get('run-1');
    assert.equal(reopened.status, 'running');
    assert.equal(reopened.recoveryDeadlineAt, null);
    assert.equal(reopened.outcome, null);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('closing a target moves every active run for that tab into recoverable failure', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    await store.create(baseRun('run-2'));
    await store.markDelivery('run-2', { baselineBusy: true });
    const changed = await store.handleTargetClosed('target-1', { now: Date.now(), failureGraceMs: 2000 });
    assert.deepEqual(changed.map((run) => run.runId).sort(), ['run-1', 'run-2']);
    assert.equal((await store.get('run-1')).outcome, 'target_closed');
    assert.equal((await store.get('run-2')).status, 'waiting_recovery');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('closing a source suppresses a settled notification that can no longer be delivered', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    await store.markNotification('run-1', 'waiting-for-input', {
      notificationError: 'Terminal has an unsent draft',
    });

    const changed = await store.handleSourceClosed('source-1');
    assert.deepEqual(changed.map((run) => run.runId), ['run-1']);
    const run = await store.get('run-1');
    assert.equal(run.status, 'completed');
    assert.equal(run.notificationStatus, 'source-closed');
    assert.equal(run.notificationSuppressed, true);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('report and dismiss actions settle a recovery without ambiguity', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('reported'));
    await store.markDelivery('reported');
    await store.handleTargetClosed('target-1');
    const reported = await store.resolveRecovery('reported', 'report');
    assert.equal(reported.run.status, 'failed');
    assert.equal(reported.run.notificationStatus, 'pending');

    await store.create(baseRun('dismissed', 'target-2'));
    await store.markDelivery('dismissed');
    await store.handleTargetClosed('target-2');
    const dismissed = await store.resolveRecovery('dismissed', 'dismiss');
    assert.equal(dismissed.run.status, 'cancelled');
    assert.equal(dismissed.run.notificationStatus, 'suppressed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('orchestration settings persist and are snapshotted into new runs', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-settings-'));
  const filePath = path.join(dir, 'runs.json');
  try {
    const first = new OrchestrationRunStore(filePath);
    await first.updateSettings({ failureGraceMs: 1234, successAutoStopMs: 5678, reactToManualInterrupt: true });
    await first.create(baseRun('run-1'));
    await first.flush();

    const second = new OrchestrationRunStore(filePath);
    assert.deepEqual(await second.getSettings(), {
      failureGraceMs: 1234,
      successAutoStopMs: 5678,
      reactToManualInterrupt: true,
      autoStopCreatedTargets: true,
    });
    const run = await second.get('run-1');
    assert.equal(run.failureGraceMs, 1234);
    assert.equal(run.successAutoStopMs, 5678);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
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
      resultComplete: true,
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

test('transcript reconciliation never completes from a partial assistant block', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    const result = await store.reconcile('run-1', {
      busy: false,
      sessionId: 'session-1',
      resultFound: true,
      resultComplete: false,
      resultAvailable: true,
      turnIndex: 12,
    });
    assert.equal(result.completed, false);
    const run = await store.get('run-1');
    assert.notEqual(run.status, 'completed');
    assert.equal(run.ownCompletedAt, null);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('delegation result is ready only after the matching turn has completion proof', () => {
  assert.equal(isCompleteOrchestrationResult({ found: false, resultComplete: false }), false);
  assert.equal(isCompleteOrchestrationResult({ found: true, resultComplete: false }), false);
  assert.equal(isCompleteOrchestrationResult({ found: true, resultComplete: true }), true);
});

test('completed newer target work permanently invalidates an older auto-stop', () => {
  const scheduled = {
    runId: 'run-a',
    targetTabId: 'target-1',
    status: 'completed',
    completedAt: 1_000,
    autoStopAt: 2_000,
  };
  const completedNewerRun = {
    runId: 'run-b',
    targetTabId: 'target-1',
    status: 'completed',
    deliveryAcceptedAt: 1_100,
    startedAt: 1_200,
    ownCompletedAt: 1_500,
  };

  assert.equal(hasNewerTargetRun([scheduled, completedNewerRun], scheduled), true);
  assert.equal(hasNewerTargetRun([
    scheduled,
    { ...completedNewerRun, runId: 'other-target', targetTabId: 'target-2' },
  ], scheduled), false);
  assert.equal(hasNewerTargetRun([
    scheduled,
    {
      ...completedNewerRun,
      runId: 'older-run',
      deliveryAcceptedAt: 700,
      startedAt: 800,
      ownCompletedAt: 900,
    },
  ], scheduled), false);
});
