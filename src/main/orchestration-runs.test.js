const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  OrchestrationRunStore,
  hasNewerTargetRun,
  isCompleteOrchestrationResult,
  mergeActiveLoadersWithOrchestrations,
  orchestrationCompletionRunIdFromAudit,
  orchestrationInstallBlockers,
  shouldRetryWaitingNotificationForSourceLifecycle,
} = require('./orchestration-runs');

async function makeStore() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-'));
  const filePath = path.join(dir, 'runs.json');
  return {
    store: new OrchestrationRunStore(filePath),
    filePath,
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

function completionAuditProof(runId, sourceTabId = 'source-1') {
  return {
    kind: 'prompt-audit',
    sourceTabId,
    handoffId: 'orchestration-complete:' + runId,
    source: 'orchestration-completion:' + runId,
    auditTimestamp: '2026-07-27T17:41:08.000Z',
    actualHash: 'audit-' + runId,
    sessionId: 'session-' + sourceTabId,
  };
}

async function finishRunAndQueueNotification(store, runId, targetTabId, attemptedAt = Date.now()) {
  await store.create(baseRun(runId, targetTabId));
  await store.markDelivery(runId);
  await store.applyLifecycle(targetTabId, { type: 'busy', busy: true });
  await store.applyLifecycle(targetTabId, { type: 'done', reason: 'task_complete' });
  await store.markNotification(runId, 'sending', {
    notificationAttemptedAt: attemptedAt,
    notificationPromptHash: 'notification-hash-' + runId,
    notificationHandoffId: 'orchestration-complete:' + runId,
  });
  await store.markNotification(runId, 'sent', { notificationDeliveredAt: attemptedAt + 1 });
}

test('waiting source notifications retry on a source turn start, not on idle noise', () => {
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'busy', busy: true }), true);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'busy', busy: false }), false);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'done' }), true);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'message' }), false);
});

test('only an exact successful completion audit exposes its run id', () => {
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: true,
  }), 'run-a');
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: false,
  }), null);
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: true,
    source: 'orchestration-completion:run-b',
  }), null);
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: true,
    handoffId: 'external-run-a',
  }), null);
});

test('an active orchestration blocks install on both its inherited source and real target', () => {
  const blockers = orchestrationInstallBlockers({
    ...baseRun('run-a', 'target-a'),
    status: 'running',
    sourceProjectName: 'source-project',
    targetProjectName: 'target-project',
  });
  assert.deepEqual(blockers.map((loader) => [loader.tabId, loader.role, loader.status]), [
    ['source-1', 'source', 'inherited-busy'],
    ['target-a', 'target', 'running'],
  ]);
});

test('active-loaders stays non-idle for Voice Record and deduplicates runtime with orchestration by tab', () => {
  const snapshot = mergeActiveLoadersWithOrchestrations({
    idle: false,
    count: 1,
    loaders: [{ tabId: 'source-1', kind: 'claude', status: 'busy' }],
    ts: 100,
  }, [{
    ...baseRun('run-a', 'target-a'),
    status: 'running',
  }]);
  assert.equal(snapshot.idle, false);
  assert.equal(snapshot.count, 2);
  assert.deepEqual(snapshot.loaders.map((loader) => [loader.tabId, loader.kind]), [
    ['source-1', 'claude'],
    ['target-a', 'orchestration'],
  ]);
});

test('Voice Record caller exclusion removes only the source and keeps the active target blocker', () => {
  const snapshot = mergeActiveLoadersWithOrchestrations(
    { idle: true, count: 0, loaders: [], ts: 100 },
    [{ ...baseRun('run-a', 'target-a'), status: 'running' }],
  );
  const returnToTabId = 'source-1';
  const blockersSeenByObserver = snapshot.loaders.filter((loader) => loader.tabId !== returnToTabId);
  assert.deepEqual(blockersSeenByObserver.map((loader) => [loader.tabId, loader.role]), [
    ['target-a', 'target'],
  ]);
});

test('completion handoff blocks install until the exact follow-up proof and then disappears', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await finishRunAndQueueNotification(store, 'run-a', 'target-a', 100);
    let snapshot = mergeActiveLoadersWithOrchestrations(
      { idle: true, count: 0, loaders: [], ts: 100 },
      await store.listActive(),
    );
    assert.equal(snapshot.idle, false);
    assert.deepEqual(snapshot.loaders.map((loader) => [loader.tabId, loader.status]), [
      ['source-1', 'completion-handoff'],
    ]);

    await store.applyLifecycle('source-1', { type: 'busy', busy: true });
    snapshot = mergeActiveLoadersWithOrchestrations(
      { idle: true, count: 0, loaders: [], ts: 200 },
      await store.listActive(),
    );
    assert.equal(snapshot.idle, false);

    await store.confirmSourceFollowup('run-a', completionAuditProof('run-a'), { now: 300 });
    snapshot = mergeActiveLoadersWithOrchestrations(
      { idle: true, count: 0, loaders: [], ts: 300 },
      await store.listActive(),
    );
    assert.equal(snapshot.idle, true);
    assert.deepEqual(snapshot.loaders, []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('waiting recovery remains an install blocker on source and target', () => {
  const blockers = orchestrationInstallBlockers({
    ...baseRun('run-a', 'target-a'),
    status: 'waiting_recovery',
  });
  assert.deepEqual(blockers.map((loader) => [loader.tabId, loader.status]), [
    ['source-1', 'recovery'],
    ['target-a', 'recovery'],
  ]);
});

test('generic source busy cannot shift two pending notifications by one run', async () => {
  const { store, cleanup } = await makeStore();
  try {
    // Notification A is accepted while the source is already working, so it
    // cannot rely on a fresh busy edge of its own.
    await store.applyLifecycle('source-1', { type: 'busy', busy: true });
    await finishRunAndQueueNotification(store, 'run-a', 'target-a', 100);
    await finishRunAndQueueNotification(store, 'run-b', 'target-b', 200);
    assert.deepEqual((await store.listActive()).map((run) => run.runId), ['run-a', 'run-b']);

    await store.applyLifecycle('source-1', { type: 'busy', busy: true });
    assert.equal((await store.get('run-a')).sourceFollowupStartedAt, null);
    assert.equal((await store.get('run-b')).sourceFollowupStartedAt, null);

    const confirmedB = await store.confirmSourceFollowup(
      'run-b',
      completionAuditProof('run-b'),
      { now: 300 },
    );
    assert.equal(confirmedB.confirmed, true);
    assert.equal((await store.get('run-b')).sourceFollowupStartedAt, 300);
    assert.equal((await store.get('run-a')).sourceFollowupStartedAt, null);
    assert.deepEqual((await store.listActive()).map((run) => run.runId), ['run-a']);

    await store.applyLifecycle('source-1', { type: 'busy', busy: true });
    assert.equal((await store.get('run-a')).sourceFollowupStartedAt, null);

    await store.confirmSourceFollowup(
      'run-a',
      completionAuditProof('run-a'),
      { now: 400 },
    );
    assert.equal((await store.get('run-a')).sourceFollowupStartedAt, 400);
    assert.deepEqual(await store.listActive(), []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('wrong handoff or prompt hash cannot release a pending inherited loader', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await finishRunAndQueueNotification(store, 'run-a', 'target-a', 100);
    const wrongAudit = await store.confirmSourceFollowup('run-a', {
      ...completionAuditProof('run-a'),
      handoffId: 'orchestration-complete:run-b',
    });
    assert.equal(wrongAudit.confirmed, false);
    const wrongTranscript = await store.confirmSourceFollowup('run-a', {
      kind: 'transcript',
      sourceTabId: 'source-1',
      notificationPromptHash: 'notification-hash-run-b',
    });
    assert.equal(wrongTranscript.confirmed, false);
    assert.equal((await store.get('run-a')).sourceFollowupPending, true);
  } finally {
    await store.flush();
    await cleanup();
  }
});

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

test('parent waits until a completed child notification is confirmed by its exact audit', async () => {
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
      notificationHandoffId: 'orchestration-complete:child',
      notificationAttemptedAt: Date.now(),
    });
    await store.markNotification('child', 'queued');
    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    assert.equal((await store.get('child')).parentConsumedAt, undefined);
    await store.confirmSourceFollowup('child', completionAuditProof('child', 'worker'));
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

test('parallel child notifications are consumed only by their own exact audits', async () => {
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
      notificationHandoffId: 'orchestration-complete:child-a',
      notificationAttemptedAt: 100,
    });
    await store.markNotification('child-a', 'queued');

    await store.create({ ...baseRun('child-b', 'tester-b'), sourceTabId: 'worker' });
    await store.markDelivery('child-b');
    await store.applyLifecycle('tester-b', { type: 'busy', busy: true });
    await store.applyLifecycle('tester-b', { type: 'done', reason: 'task_complete' });
    await store.patch('child-b', {
      notificationPromptHash: 'hash-child-b-completion',
      notificationHandoffId: 'orchestration-complete:child-b',
      notificationAttemptedAt: 200,
    });
    await store.markNotification('child-b', 'queued');

    await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.deepEqual((await store.get('parent')).waitingOnRunIds, ['child-a', 'child-b']);

    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    assert.equal((await store.get('child-a')).parentConsumedAt, undefined);
    assert.equal((await store.get('child-b')).parentConsumedAt, undefined);

    await store.confirmSourceFollowup('child-b', completionAuditProof('child-b', 'worker'));
    assert.equal((await store.get('child-a')).parentConsumedAt, undefined);
    assert.ok((await store.get('child-b')).parentConsumedAt);
    assert.equal((await store.getInternal('parent')).resultPromptHash, 'hash-child-b-completion');
    await store.applyLifecycle('worker', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('parent')).status, 'waiting_descendants');
    assert.deepEqual((await store.get('parent')).waitingOnRunIds, ['child-a']);

    await store.confirmSourceFollowup('child-a', completionAuditProof('child-a', 'worker'));
    assert.ok((await store.get('child-a')).parentConsumedAt);
    assert.equal((await store.getInternal('parent')).resultPromptHash, 'hash-child-a-completion');
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

test('dismissing a source delivery error preserves the result and releases its blocker', async () => {
  const { store, filePath, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-1'));
    await store.markDelivery('run-1');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    await store.markNotification('run-1', 'failed', {
      notificationError: 'codex_existing_draft_before_paste',
    });

    const blocked = await store.get('run-1');
    assert.equal(blocked.status, 'completed');
    assert.ok(blocked.attentionRequiredAt);
    assert.equal(orchestrationInstallBlockers(blocked)[0]?.status, 'notification-blocked');

    const acknowledged = await store.acknowledge('run-1', 'source-1');
    assert.equal(acknowledged.sourceAttentionDismissedAt, undefined);
    assert.equal(orchestrationInstallBlockers(acknowledged)[0]?.status, 'notification-blocked');

    const dismissed = await store.dismissAttention('run-1', 'source-1');
    assert.equal(dismissed.dismissed, true);
    assert.equal(dismissed.run.status, 'completed');
    assert.equal(dismissed.run.notificationStatus, 'suppressed');
    assert.equal(dismissed.run.notificationSuppressed, true);
    assert.ok(dismissed.run.notificationDismissedAt);
    assert.ok(dismissed.run.sourceAttentionDismissedAt);
    assert.deepEqual(orchestrationInstallBlockers(dismissed.run), []);

    await store.flush();
    const restored = await new OrchestrationRunStore(filePath).get('run-1');
    assert.ok(restored.sourceAttentionDismissedAt);
    assert.ok(restored.notificationDismissedAt);
    assert.deepEqual(orchestrationInstallBlockers(restored), []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('legacy blocking notification failures become visible without surfacing every old failure', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-legacy-attention-'));
  const filePath = path.join(dir, 'runs.json');
  const now = Date.now();
  try {
    await fs.promises.writeFile(filePath, JSON.stringify({
      runs: [{
        ...baseRun('delivery-failed'),
        status: 'completed',
        createdAt: now - 3000,
        completedAt: now - 2000,
        updatedAt: now - 1000,
        notifySource: true,
        notificationStatus: 'failed',
        notificationError: 'legacy draft conflict',
      }, {
        ...baseRun('old-target-failure', 'target-2'),
        status: 'failed',
        createdAt: now - 3000,
        completedAt: now - 2000,
        updatedAt: now - 1000,
        notifySource: true,
        notificationStatus: 'sent',
      }],
    }), 'utf8');

    const store = new OrchestrationRunStore(filePath);
    assert.ok((await store.get('delivery-failed')).attentionRequiredAt);
    assert.equal((await store.get('old-target-failure')).attentionRequiredAt, undefined);
    await store.flush();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
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

test('restart reconciliation clears only the persisted run with exact notification prompt hash', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-followup-'));
  const filePath = path.join(dir, 'runs.json');
  try {
    const first = new OrchestrationRunStore(filePath);
    await finishRunAndQueueNotification(first, 'run-a', 'target-a', 100);
    await finishRunAndQueueNotification(first, 'run-b', 'target-b', 200);
    await first.flush();

    const second = new OrchestrationRunStore(filePath);
    const confirmation = await second.confirmSourceFollowup('run-a', {
      kind: 'transcript',
      sourceTabId: 'source-1',
      notificationPromptHash: 'notification-hash-run-a',
      sessionId: 'source-session',
      userUuid: 'user-turn-a',
    }, { now: 500 });
    assert.equal(confirmation.confirmed, true);
    assert.equal((await second.get('run-a')).sourceFollowupStartedAt, 500);
    assert.equal((await second.get('run-a')).sourceFollowupProofKind, 'transcript');
    assert.equal((await second.get('run-b')).sourceFollowupStartedAt, null);
    await second.flush();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
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
