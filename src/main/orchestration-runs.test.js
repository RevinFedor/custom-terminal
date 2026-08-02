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
  orchestrationTargetRunIdFromAudit,
  orchestrationCompletionRunIdFromAudit,
  orchestrationInstallBlockers,
  shouldScheduleCreatedTargetAutoStop,
  shouldRetryWaitingNotificationForSourceLifecycle,
  shouldMarkSourceFollowupUnconfirmed,
  buildOrchestrationResultLookup,
  orchestrationSendFailureRecoveryPolicy,
  resolveCausalSourceExecutionContext,
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
    promptHash: 'transcript-hash-' + runId,
    targetPromptAuditHash: 'audit-hash-' + runId,
    promptChars: 20,
  };
}

function completionAuditProof(runId, sourceTabId = 'source-1') {
  return {
    kind: 'prompt-audit',
    sourceTabId,
    handoffId: 'orchestration-complete:' + runId,
    source: 'orchestration-completion:' + runId,
    auditTimestamp: '2026-07-27T17:41:08.000Z',
    actualHash: 'notification-audit-hash-' + runId,
    expectedHash: 'notification-audit-hash-' + runId,
    sessionId: 'session-' + sourceTabId,
  };
}

function targetAuditProof(runId, targetTabId = 'target-1', sourceTabId = 'source-1') {
  return {
    targetTabId,
    handoffId: 'orchestration:' + runId,
    source: 'orchestration:' + sourceTabId,
    toolType: 'claude',
    auditTimestamp: '2026-07-28T07:26:39.981Z',
    expectedHash: 'audit-hash-' + runId,
    actualHash: 'audit-hash-' + runId,
    expectedLen: 20,
    actualLen: 20,
    sessionId: 'session-' + targetTabId,
    userUuid: 'user-' + runId,
  };
}

async function finishRunAndQueueNotification(store, runId, targetTabId, attemptedAt = Date.now()) {
  await store.create(baseRun(runId, targetTabId));
  await store.markDelivery(runId);
  await store.applyLifecycle(targetTabId, { type: 'busy', busy: true });
  await store.applyLifecycle(targetTabId, { type: 'done', reason: 'task_complete' });
  // Production only attempts source notification after exact final-result proof.
  await store.patch(runId, { resultComplete: true, resultProofStatus: 'complete' });
  await store.markNotification(runId, 'sending', {
    notificationAttemptedAt: attemptedAt,
    notificationPromptHash: 'notification-hash-' + runId,
    notificationPromptAuditHash: 'notification-audit-hash-' + runId,
    notificationHandoffId: 'orchestration-complete:' + runId,
  });
  await store.markNotification(runId, 'sent', { notificationDeliveredAt: attemptedAt + 1 });
}

test('waiting source notifications retry on a source turn start or proven-ready snapshot, not idle noise', () => {
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'busy', busy: true }), true);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'busy', busy: false }), false);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'done' }), true);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({
    type: 'snapshot', inputReady: true, busy: false, starting: false,
  }), true);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({
    type: 'snapshot', inputReady: false, busy: false,
  }), false);
  assert.equal(shouldRetryWaitingNotificationForSourceLifecycle({ type: 'message' }), false);
});

test('durable reservation is idempotent only for the same request fingerprint', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const first = await store.reserveOrGet({
      ...baseRun('run-reservation'),
      requestFingerprint: 'request-a',
      targetCreated: true,
    });
    assert.equal(first.created, true);
    assert.equal(first.conflict, false);

    const exact = await store.reserveOrGet({
      ...baseRun('run-reservation'),
      requestFingerprint: 'request-a',
      targetCreated: true,
    });
    assert.equal(exact.created, false);
    assert.equal(exact.conflict, false);

    const mismatched = await store.reserveOrGet({
      ...baseRun('run-reservation'),
      requestFingerprint: 'request-b',
      targetCreated: true,
    });
    assert.equal(mismatched.created, false);
    assert.equal(mismatched.conflict, true);
    assert.equal(mismatched.reason, 'idempotency-key-reused');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('reservation persistence failure leaves no admitted run', async () => {
  const { store, cleanup } = await makeStore();
  try {
    store.persistStrict = async () => {
      throw new Error('disk unavailable');
    };
    await assert.rejects(
      store.reserveOrGet({
        ...baseRun('run-persist-failure'),
        requestFingerprint: 'request-failure',
        targetCreated: true,
      }),
      /disk unavailable/,
    );
    assert.equal(await store.get('run-persist-failure'), null);
  } finally {
    await cleanup();
  }
});

test('only an exact successful completion audit exposes its run id', () => {
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: true,
  }), 'run-a');
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: true,
    source: 'codex-orchestration-completion:run-a',
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
    source: 'codex-codex-orchestration-completion:run-a',
  }), null);
  assert.equal(orchestrationCompletionRunIdFromAudit({
    ...completionAuditProof('run-a'),
    success: true,
    handoffId: 'external-run-a',
  }), null);
});

test('only a successful exact target handoff exposes its orchestration run id', () => {
  assert.equal(orchestrationTargetRunIdFromAudit({
    ...targetAuditProof('run-a'),
    success: true,
  }), 'run-a');
  assert.equal(orchestrationTargetRunIdFromAudit({
    ...targetAuditProof('run-a'),
    success: false,
  }), null);
  assert.equal(orchestrationTargetRunIdFromAudit({
    ...targetAuditProof('run-a'),
    success: true,
    handoffId: 'orchestration-complete:run-a',
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

test('startup reconciliation exposes an unconfirmed source handoff without losing late exact proof', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await finishRunAndQueueNotification(store, 'run-unconfirmed', 'target-a', 100);
    const sent = await store.get('run-unconfirmed');
    assert.equal(shouldMarkSourceFollowupUnconfirmed(sent, {
      confirmed: false,
      reason: 'source-followup-turn-not-found',
    }), true);
    assert.equal(shouldMarkSourceFollowupUnconfirmed(sent, { confirmed: true }), false);

    await store.markNotification('run-unconfirmed', 'unconfirmed', {
      notificationError: 'exact delivery proof missing after restart',
      notificationUnconfirmedAt: 200,
      notificationUnconfirmedReason: 'source-followup-turn-not-found',
    });
    const unconfirmed = await store.get('run-unconfirmed');
    assert.equal(unconfirmed.sourceFollowupPending, true);
    assert.equal(unconfirmed.notificationStatus, 'unconfirmed');
    assert.equal(orchestrationInstallBlockers(unconfirmed)[0]?.status, 'notification-blocked');
    assert.deepEqual((await store.listActive()).map((run) => run.runId), ['run-unconfirmed']);

    const confirmed = await store.confirmSourceFollowup(
      'run-unconfirmed',
      completionAuditProof('run-unconfirmed'),
      { now: 300 },
    );
    assert.equal(confirmed.confirmed, true);
    const resolved = await store.get('run-unconfirmed');
    assert.equal(resolved.notificationStatus, 'sent');
    assert.equal(resolved.sourceFollowupPending, false);
    assert.equal(resolved.sourceFollowupStartedAt, 300);
    assert.equal(resolved.notificationUnconfirmedAt, null);
    assert.deepEqual(orchestrationInstallBlockers(resolved), []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('startup reconciliation exposes a crash-persisted sending handoff as unconfirmed', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-sending-restart', 'target-a'));
    await store.markDelivery('run-sending-restart');
    await store.applyLifecycle('target-a', { type: 'busy', busy: true });
    await store.applyLifecycle('target-a', { type: 'done', reason: 'task_complete' });
    await store.patch('run-sending-restart', { resultComplete: true, resultProofStatus: 'complete' });
    await store.markNotification('run-sending-restart', 'sending', {
      notificationAttemptedAt: 100,
      notificationPromptHash: 'notification-hash-run-sending-restart',
      notificationPromptAuditHash: 'notification-audit-hash-run-sending-restart',
      notificationHandoffId: 'orchestration-complete:run-sending-restart',
    });
    const sending = await store.get('run-sending-restart');
    assert.equal(shouldMarkSourceFollowupUnconfirmed(sending, {
      confirmed: false,
      reason: 'source-followup-turn-not-found',
    }), true);

    await store.markNotification('run-sending-restart', 'unconfirmed', {
      notificationError: 'exact delivery proof missing after restart',
    });
    const recovered = await store.get('run-sending-restart');
    assert.equal(recovered.notificationStatus, 'unconfirmed');
    assert.equal(recovered.sourceFollowupPending, true);
    assert.equal(orchestrationInstallBlockers(recovered)[0]?.status, 'notification-blocked');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('a completion audit cannot be rebound to another run by relabelling its handoff', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await finishRunAndQueueNotification(store, 'run-proof-a', 'target-a', 100);
    await finishRunAndQueueNotification(store, 'run-proof-b', 'target-b', 200);
    const rebound = await store.confirmSourceFollowup('run-proof-b', {
      ...completionAuditProof('run-proof-b'),
      actualHash: 'notification-audit-hash-run-proof-a',
      expectedHash: 'notification-audit-hash-run-proof-a',
    }, { now: 300 });
    assert.equal(rebound.confirmed, false);
    assert.equal(rebound.reason, 'notification-prompt-audit-hash-mismatch');
    assert.equal((await store.get('run-proof-b')).sourceFollowupPending, true);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('dismissing an unconfirmed handoff preserves the result and releases its blocker', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await finishRunAndQueueNotification(store, 'run-unconfirmed-dismiss', 'target-a', 100);
    await store.markNotification('run-unconfirmed-dismiss', 'unconfirmed', {
      notificationError: 'exact delivery proof missing after restart',
    });

    const dismissed = await store.dismissAttention('run-unconfirmed-dismiss', 'source-1');
    assert.equal(dismissed.dismissed, true);
    assert.equal(dismissed.run.status, 'completed');
    assert.equal(dismissed.run.notificationStatus, 'suppressed');
    assert.equal(dismissed.run.notificationSuppressed, true);
    assert.equal(dismissed.run.sourceFollowupPending, false);
    assert.deepEqual(orchestrationInstallBlockers(dismissed.run), []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('restart reconciliation retains a completed run whose result proof is still pending', async () => {
  const { store, filePath, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('run-result-race', 'target-a'),
      notifySource: false,
    });
    await store.markDelivery('run-result-race');
    await store.applyLifecycle('target-a', { type: 'busy', busy: true });
    await store.applyLifecycle('target-a', { type: 'done', reason: 'task_complete' });
    await store.patch('run-result-race', {
      resultComplete: false,
      resultProofStatus: 'awaiting-transcript',
      completedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
    });
    await store.flush();

    const restored = new OrchestrationRunStore(filePath);
    assert.deepEqual((await restored.listActive()).map((run) => run.runId), [
      'run-result-race',
    ]);
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

test('Codex completion audit is canonicalized and cannot regress from sent back to queued', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-codex-source', 'target-a'));
    await store.markDelivery('run-codex-source');
    await store.applyLifecycle('target-a', { type: 'busy', busy: true });
    await store.applyLifecycle('target-a', { type: 'done', reason: 'task_complete' });
    await store.patch('run-codex-source', { resultComplete: true });
    await store.markNotification('run-codex-source', 'sending', {
      notificationPromptHash: 'notification-hash-run-codex-source',
      notificationPromptAuditHash: 'notification-audit-hash-run-codex-source',
      notificationHandoffId: 'orchestration-complete:run-codex-source',
    });

    const confirmed = await store.confirmSourceFollowup('run-codex-source', {
      ...completionAuditProof('run-codex-source'),
      source: 'codex-orchestration-completion:run-codex-source',
    }, { now: 500 });
    assert.equal(confirmed.confirmed, true);
    assert.equal((await store.get('run-codex-source')).notificationStatus, 'sent');

    // The scenario call returns queued after the post-Enter audit in the live
    // race. That weaker reply must not overwrite the exact materialization.
    await store.markNotification('run-codex-source', 'queued', {
      notificationDeliveredAt: 600,
    });
    const run = await store.get('run-codex-source');
    assert.equal(run.notificationStatus, 'sent');
    assert.equal(run.sourceFollowupStartedAt, 500);
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

test('exact target prompt proof repairs a busy edge that raced before delivery acceptance', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-race'), targetToolType: 'claude' });
    await store.patch('run-race', { status: 'sending' });

    // This is the live E2E order: UserPromptSubmit arrives while the HTTP send
    // route is still resolving the accepted runtime identity.
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      sessionId: 'session-target-1',
    });
    assert.equal((await store.get('run-race')).status, 'sending');

    await store.markDelivery('run-race', { sessionId: 'session-target-1' });
    assert.equal((await store.get('run-race')).status, 'sent');
    const proof = await store.confirmTargetPromptDelivery(
      'run-race',
      targetAuditProof('run-race'),
    );
    assert.equal(proof.confirmed, true);
    assert.equal((await store.get('run-race')).status, 'running');

    const done = await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      sessionId: 'session-target-1',
    });
    assert.equal(done.completed.length, 1);
    assert.equal((await store.get('run-race')).status, 'completed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('exact target prompt proof binds the pre-delivery turn and makes nested work causal', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const executionContext = {
      provider: 'claude',
      sessionId: 'session-target-1',
      turnId: 'claude:7',
      processId: 'pid-target-1',
      generation: 7,
      startedAt: 1785404966414,
    };
    await store.create({ ...baseRun('run-exact-context'), targetToolType: 'claude' });
    await store.patch('run-exact-context', { status: 'sending' });

    // The lifecycle edge alone is not enough before transport acceptance.
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      sessionId: executionContext.sessionId,
      executionContext,
    });
    assert.equal((await store.get('run-exact-context')).targetExecutionContext, null);

    const proof = await store.confirmTargetPromptDelivery('run-exact-context', {
      ...targetAuditProof('run-exact-context'),
      executionContext,
    });
    assert.equal(proof.confirmed, true);
    assert.equal(proof.contextBound, true);
    assert.deepEqual((await store.get('run-exact-context')).targetExecutionContext, executionContext);

    const nested = await store.create({
      ...baseRun('run-nested-context', 'tester'),
      sourceTabId: 'target-1',
      sourceExecutionContext: executionContext,
    });
    assert.equal(nested.parentRunId, 'run-exact-context');

    await store.markDelivery('run-exact-context', { sessionId: executionContext.sessionId });
    await store.markDelivery('run-nested-context');
    await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      sessionId: executionContext.sessionId,
      executionContext,
    });
    assert.equal((await store.get('run-exact-context')).status, 'waiting_descendants');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('prompt proof execution context rejects mismatches and duplicate proof preserves identity', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-provider-mismatch'), targetToolType: 'claude' });
    const providerMismatch = await store.confirmTargetPromptDelivery('run-provider-mismatch', {
      ...targetAuditProof('run-provider-mismatch'),
      executionContext: {
        provider: 'codex',
        sessionId: 'session-target-1',
        turnId: 'codex:7',
      },
    });
    assert.equal(providerMismatch.confirmed, true);
    assert.equal(providerMismatch.contextBound, false);
    assert.equal(providerMismatch.contextReason, 'target-execution-context-provider-mismatch');
    assert.equal((await store.get('run-provider-mismatch')).targetExecutionContext, null);

    await store.create({ ...baseRun('run-session-mismatch'), targetToolType: 'claude' });
    const sessionMismatch = await store.confirmTargetPromptDelivery('run-session-mismatch', {
      ...targetAuditProof('run-session-mismatch'),
      executionContext: {
        provider: 'claude',
        sessionId: 'neighbor-session',
        turnId: 'claude:8',
      },
    });
    assert.equal(sessionMismatch.confirmed, true);
    assert.equal(sessionMismatch.contextBound, false);
    assert.equal(sessionMismatch.contextReason, 'target-execution-context-session-mismatch');
    assert.equal((await store.get('run-session-mismatch')).targetExecutionContext, null);

    const originalContext = {
      provider: 'claude',
      sessionId: 'session-target-1',
      turnId: 'claude:9',
      processId: null,
      generation: 9,
      startedAt: 1785404967000,
    };
    await store.create({ ...baseRun('run-idempotent-context'), targetToolType: 'claude' });
    const first = await store.confirmTargetPromptDelivery('run-idempotent-context', {
      ...targetAuditProof('run-idempotent-context'),
      executionContext: originalContext,
    });
    assert.equal(first.contextBound, true);

    const duplicateWithoutContext = await store.confirmTargetPromptDelivery(
      'run-idempotent-context',
      targetAuditProof('run-idempotent-context'),
    );
    assert.equal(duplicateWithoutContext.confirmed, true);
    assert.equal(duplicateWithoutContext.idempotent, true);
    assert.deepEqual(
      (await store.get('run-idempotent-context')).targetExecutionContext,
      originalContext,
    );

    const conflictingDuplicate = await store.confirmTargetPromptDelivery('run-idempotent-context', {
      ...targetAuditProof('run-idempotent-context'),
      executionContext: {
        ...originalContext,
        turnId: 'claude:10',
        generation: 10,
      },
    });
    assert.equal(conflictingDuplicate.confirmed, true);
    assert.equal(conflictingDuplicate.contextBound, true);
    assert.equal(conflictingDuplicate.contextReason, 'target-execution-context-conflict');
    assert.deepEqual(
      (await store.get('run-idempotent-context')).targetExecutionContext,
      originalContext,
    );

    await store.create({ ...baseRun('run-late-context'), targetToolType: 'claude' });
    const proofWithoutContext = await store.confirmTargetPromptDelivery(
      'run-late-context',
      targetAuditProof('run-late-context'),
    );
    assert.equal(proofWithoutContext.contextBound, false);
    const enrichedDuplicate = await store.confirmTargetPromptDelivery('run-late-context', {
      ...targetAuditProof('run-late-context'),
      executionContext: originalContext,
    });
    assert.equal(enrichedDuplicate.confirmed, true);
    assert.equal(enrichedDuplicate.idempotent, true);
    assert.equal(enrichedDuplicate.contextBound, true);
    assert.deepEqual(
      (await store.get('run-late-context')).targetExecutionContext,
      originalContext,
    );
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('target prompt proof is order-independent and rejects neighboring identities', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-a'), targetToolType: 'claude' });
    const wrongSource = await store.confirmTargetPromptDelivery('run-a', {
      ...targetAuditProof('run-a'),
      source: 'orchestration:source-other',
    });
    assert.equal(wrongSource.confirmed, false);
    assert.equal(wrongSource.reason, 'target-prompt-identity-mismatch');
    const wrongHash = await store.confirmTargetPromptDelivery('run-a', {
      ...targetAuditProof('run-a'),
      expectedHash: 'audit-hash-run-b',
    });
    assert.equal(wrongHash.confirmed, false);
    assert.equal(wrongHash.reason, 'target-prompt-hash-mismatch');

    const early = await store.confirmTargetPromptDelivery('run-a', {
      ...targetAuditProof('run-a'),
      source: 'codex-orchestration:source-1',
    });
    assert.equal(early.confirmed, true);
    assert.equal((await store.get('run-a')).status, 'running');

    await store.markDelivery('run-a', { sessionId: 'session-target-1' });
    const run = await store.get('run-a');
    assert.equal(run.status, 'running');
    assert.equal(run.targetPromptProofKind, 'prompt-audit');
    assert.equal(run.targetPromptProofUserUuid, 'user-run-a');

    await store.create({ ...baseRun('run-canonical'), targetToolType: 'codex' });
    const canonical = await store.confirmTargetPromptDelivery('run-canonical', {
      ...targetAuditProof('run-canonical'),
      toolType: 'codex',
      canonicalized: true,
      actualHash: 'canonicalized-actual-hash',
      actualLen: 19,
    });
    assert.equal(canonical.confirmed, true);
    assert.equal((await store.get('run-canonical')).targetPromptProofCanonicalized, true);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('Codex lifecycle advances only the run bound to the same process generation', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('run-generation'),
      targetToolType: 'codex',
    });
    await store.markDelivery('run-generation', {
      lifecycleGeneration: 'pty-a:7',
    });

    const staleBusy = await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: 'pty-b:1',
    });
    assert.equal(staleBusy.ignored, true);
    assert.equal(staleBusy.ignoreReason, 'process-generation-changed');
    assert.equal((await store.get('run-generation')).status, 'sent');

    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: 'pty-a:7',
    });
    assert.equal((await store.get('run-generation')).status, 'running');

    await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      lifecycleGeneration: 'pty-a:7',
    });
    assert.equal((await store.get('run-generation')).status, 'completed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('restart reconciliation does not revive an unfinished Codex run from a new process', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('run-restart'),
      targetToolType: 'codex',
    });
    await store.markDelivery('run-restart', {
      lifecycleGeneration: 'old-main:3',
    });
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: 'old-main:3',
    });

    const reconciled = await store.reconcile('run-restart', {
      busy: true,
      lifecycleGeneration: 'new-main:1',
      resultFound: false,
      resultComplete: false,
    });
    assert.equal(reconciled.completed, false);
    const run = await store.get('run-restart');
    assert.equal(run.status, 'waiting_recovery');
    assert.equal(run.outcome, 'process_replaced');
    assert.match(run.error, /process ownership changed/);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('unknown Codex generation is not treated as a proven process replacement', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('run-generation-unknown'),
      targetToolType: 'codex',
    });
    await store.markDelivery('run-generation-unknown', {
      lifecycleGeneration: 'main-a:4',
      sessionId: 'session-a',
    });
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: 'main-a:4',
    });

    const missingObservation = await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: null,
    });
    assert.equal(missingObservation.ignored, true);
    assert.equal(missingObservation.generationVerdict, 'unknown');
    assert.equal(missingObservation.ignoreReason, 'observed-generation-unproven');

    const reconciled = await store.reconcile('run-generation-unknown', {
      busy: true,
      lifecycleGeneration: null,
      sessionId: 'unrelated-session',
      resultFound: false,
      resultComplete: false,
    });
    assert.equal(reconciled.completed, false);
    const run = await store.get('run-generation-unknown');
    assert.equal(run.status, 'running');
    assert.equal(run.outcome, null);
    assert.equal(run.error, undefined);
    assert.equal(run.sessionId, 'session-a');

    await store.create({
      ...baseRun('run-expected-generation-unknown', 'target-2'),
      targetToolType: 'codex',
    });
    await store.markDelivery('run-expected-generation-unknown');
    const missingExpected = await store.applyLifecycle('target-2', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: 'main-b:1',
    });
    assert.equal(missingExpected.ignored, true);
    assert.equal(missingExpected.generationVerdict, 'unknown');
    assert.equal(missingExpected.ignoreReason, 'expected-generation-unproven');
    assert.equal((await store.get('run-expected-generation-unknown')).status, 'sent');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('exact transcript completion still settles a Codex run after its process was replaced', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('run-transcript'),
      targetToolType: 'codex',
    });
    await store.markDelivery('run-transcript', {
      lifecycleGeneration: 'old-main:9',
    });
    const reconciled = await store.reconcile('run-transcript', {
      busy: false,
      lifecycleGeneration: 'new-main:1',
      resultFound: true,
      resultComplete: true,
      resultAvailable: true,
      turnIndex: 42,
    });
    assert.equal(reconciled.completed, true);
    assert.equal((await store.get('run-transcript')).status, 'completed');
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

test('a second durable delivery cannot enter the target before the predecessor result materializes', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const prompt = 'the same prompt bytes';
    await store.create({
      ...baseRun('run-1'),
      deliveryIntent: { prompt, queueRequested: true },
    });
    let claim = await store.claimDeferredDelivery('run-1', { sessionId: 'session-target-1' });
    assert.equal(claim.claimed, true);
    assert.equal(claim.intent.prompt, prompt);
    await store.markDelivery('run-1', { sessionId: 'session-target-1' });
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });

    await store.create({
      ...baseRun('run-2'),
      deliveryIntent: { prompt, queueRequested: true },
    });
    await store.deferDelivery('run-2', { reason: 'predecessor-not-materialized' });
    claim = await store.claimDeferredDelivery('run-2', { sessionId: 'session-target-1' });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, 'predecessor-not-materialized');

    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('run-1')).status, 'completed');
    claim = await store.claimDeferredDelivery('run-2', { sessionId: 'session-target-1' });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, 'predecessor-not-materialized');

    await store.patch('run-1', { resultComplete: true, resultProofStatus: 'complete' });
    claim = await store.claimDeferredDelivery('run-2', { sessionId: 'session-target-1' });
    assert.equal(claim.claimed, true);
    assert.equal(claim.intent.prompt, prompt);
    assert.equal(claim.run.status, 'sending');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('a run created after lifecycle done still waits for the predecessor result proof', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('run-done-first'),
      deliveryIntent: { prompt: 'first prompt', queueRequested: true },
    });
    assert.equal((await store.claimDeferredDelivery('run-done-first')).claimed, true);
    await store.markDelivery('run-done-first', { sessionId: 'session-target-1' });
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('run-done-first')).status, 'completed');
    assert.equal((await store.get('run-done-first')).resultComplete, false);

    const second = await store.create({
      ...baseRun('run-after-done'),
      deliveryIntent: { prompt: 'second prompt', queueRequested: true },
    });
    assert.equal(second.predecessorRunId, 'run-done-first');
    let claim = await store.claimDeferredDelivery('run-after-done');
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, 'predecessor-not-materialized');

    await store.patch('run-done-first', { resultComplete: true, resultProofStatus: 'complete' });
    claim = await store.claimDeferredDelivery('run-after-done');
    assert.equal(claim.claimed, true);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('queued delivery survives restart but exact prompt proof removes the private prompt payload', async () => {
  const { store, filePath, cleanup } = await makeStore();
  let restored = null;
  try {
    await store.create({
      ...baseRun('run-restart-queue'),
      targetToolType: 'claude',
      deliveryIntent: { prompt: 'secret queued prompt', queueRequested: true },
    });
    await store.deferDelivery('run-restart-queue', { reason: 'target-busy' });
    await store.flush();

    restored = new OrchestrationRunStore(filePath);
    const publicBefore = await restored.get('run-restart-queue');
    assert.equal(publicBefore.status, 'queued');
    assert.equal(Object.hasOwn(publicBefore, 'deliveryIntent'), false);
    const claim = await restored.claimDeferredDelivery('run-restart-queue', {
      sessionId: 'session-target-1',
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.intent.prompt, 'secret queued prompt');

    const proof = await restored.confirmTargetPromptDelivery(
      'run-restart-queue',
      targetAuditProof('run-restart-queue'),
    );
    assert.equal(proof.confirmed, true);
    assert.equal((await restored.getInternal('run-restart-queue')).deliveryIntent, null);
  } finally {
    await store.flush();
    if (restored) await restored.flush();
    await cleanup();
  }
});

test('restart never auto-replays a delivery whose Enter outcome is unknown', async () => {
  const { store, filePath, cleanup } = await makeStore();
  let restored = null;
  try {
    await store.create({
      ...baseRun('run-ambiguous-enter'),
      deliveryIntent: { prompt: 'apply once', queueRequested: true },
    });
    const first = await store.claimDeferredDelivery('run-ambiguous-enter');
    assert.equal(first.claimed, true);
    await store.flush();

    restored = new OrchestrationRunStore(filePath);
    let replay = await restored.claimDeferredDelivery('run-ambiguous-enter');
    assert.equal(replay.claimed, false);
    assert.equal(replay.reason, 'delivery-outcome-unknown');

    await restored.resetDeferredDelivery('run-ambiguous-enter', 'explicit-retry');
    replay = await restored.claimDeferredDelivery('run-ambiguous-enter');
    assert.equal(replay.claimed, true);
    assert.equal(replay.intent.prompt, 'apply once');
  } finally {
    await store.flush();
    if (restored) await restored.flush();
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
      parentRunId: 'parent',
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
      resultComplete: true,
      resultProofStatus: 'complete',
      notificationPromptHash: 'hash-child-completion',
      notificationPromptAuditHash: 'notification-audit-hash-child',
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

    await store.create({
      ...baseRun('child-a', 'tester-a'),
      sourceTabId: 'worker',
      parentRunId: 'parent',
    });
    await store.markDelivery('child-a');
    await store.applyLifecycle('tester-a', { type: 'busy', busy: true });
    await store.applyLifecycle('tester-a', { type: 'done', reason: 'task_complete' });
    await store.patch('child-a', {
      resultComplete: true,
      resultProofStatus: 'complete',
      notificationPromptHash: 'hash-child-a-completion',
      notificationPromptAuditHash: 'notification-audit-hash-child-a',
      notificationHandoffId: 'orchestration-complete:child-a',
      notificationAttemptedAt: 100,
    });
    await store.markNotification('child-a', 'queued');

    await store.create({
      ...baseRun('child-b', 'tester-b'),
      sourceTabId: 'worker',
      parentRunId: 'parent',
    });
    await store.markDelivery('child-b');
    await store.applyLifecycle('tester-b', { type: 'busy', busy: true });
    await store.applyLifecycle('tester-b', { type: 'done', reason: 'task_complete' });
    await store.patch('child-b', {
      resultComplete: true,
      resultProofStatus: 'complete',
      notificationPromptHash: 'hash-child-b-completion',
      notificationPromptAuditHash: 'notification-audit-hash-child-b',
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
    await store.create({
      ...baseRun('child', 'tester'),
      sourceTabId: 'worker',
      parentRunId: 'parent',
    });
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

test('the next exact turn automatically continues one manually interrupted run', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const interruptedContext = {
      provider: 'claude',
      sessionId: 'session-target-1',
      turnId: 'claude:1',
      generation: 1,
    };
    const continuationContext = {
      provider: 'claude',
      sessionId: 'session-target-1',
      turnId: 'claude:2',
      generation: 2,
    };
    await store.create({
      ...baseRun('run-1'),
      targetToolType: 'claude',
      targetExecutionContext: interruptedContext,
    });
    await store.markDelivery('run-1', { sessionId: 'session-target-1' });
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: interruptedContext,
    });
    await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'turn_aborted',
      executionContext: interruptedContext,
    });
    const interruptedAt = (await store.getInternal('run-1')).ownCompletedAt;

    const unrelatedBusy = await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    assert.equal(unrelatedBusy.ignored, true);
    assert.equal(unrelatedBusy.ignoreReason, 'recovery-continuation-unproven');
    const staleBusy = await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: interruptedContext,
    });
    assert.equal(staleBusy.ignored, true);
    assert.equal((await store.get('run-1')).status, 'waiting_recovery');

    const continued = await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: continuationContext,
    });
    const reopened = await store.get('run-1');
    assert.equal(reopened.status, 'running');
    assert.equal(reopened.recoveryDeadlineAt, null);
    assert.equal(reopened.outcome, null);
    assert.equal(reopened.recoveryContinuedAutomatically, true);
    assert.equal((await store.getInternal('run-1')).resultAfterAt, interruptedAt);
    assert.deepEqual(continued.changed.map((run) => run.runId), ['run-1']);

    await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      executionContext: continuationContext,
    });
    assert.equal((await store.get('run-1')).status, 'completed');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('automatic continuation does not adopt a closed target or a different session', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('closed'), targetToolType: 'claude' });
    await store.markDelivery('closed', { sessionId: 'session-target-1' });
    await store.beginRecovery('closed', 'target_closed', 'target tab closed');
    const closedBusy = await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: {
        provider: 'claude',
        sessionId: 'session-target-1',
        turnId: 'claude:next',
      },
    });
    assert.equal(closedBusy.ignored, true);
    assert.equal((await store.get('closed')).status, 'waiting_recovery');

    await store.create({ ...baseRun('interrupted', 'target-2'), targetToolType: 'claude' });
    await store.markDelivery('interrupted', { sessionId: 'session-target-2' });
    await store.beginRecovery('interrupted', 'interrupted', 'turn_aborted');
    const otherSession = await store.applyLifecycle('target-2', {
      type: 'busy',
      busy: true,
      executionContext: {
        provider: 'claude',
        sessionId: 'different-session',
        turnId: 'claude:next',
      },
    });
    assert.equal(otherSession.ignored, true);
    assert.equal((await store.get('interrupted')).status, 'waiting_recovery');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('automatic continuation refuses to guess between two interrupted runs', async () => {
  const { store, cleanup } = await makeStore();
  try {
    for (const runId of ['run-a', 'run-b']) {
      await store.create({ ...baseRun(runId), targetToolType: 'claude' });
      await store.markDelivery(runId, { sessionId: 'shared-session' });
      await store.beginRecovery(runId, 'interrupted', 'turn_aborted');
    }
    const result = await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: {
        provider: 'claude',
        sessionId: 'shared-session',
        turnId: 'claude:next',
      },
    });
    assert.equal(result.ignored, true);
    assert.equal((await store.get('run-a')).status, 'waiting_recovery');
    assert.equal((await store.get('run-b')).status, 'waiting_recovery');

    await store.resolveRecovery('run-a', 'reopen', { sessionId: 'shared-session' });
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: {
        provider: 'claude',
        sessionId: 'shared-session',
        turnId: 'claude:next',
      },
    });
    assert.equal((await store.get('run-a')).status, 'running');
    assert.equal((await store.get('run-b')).status, 'waiting_recovery');
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

test('closing a source releases a sent notification that still lacks exact follow-up proof', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await finishRunAndQueueNotification(store, 'run-1', 'target-1');
    const before = await store.get('run-1');
    assert.equal(before.notificationStatus, 'sent');
    assert.equal(before.sourceFollowupPending, true);

    const changed = await store.handleSourceClosed('source-1');
    assert.deepEqual(changed.map((run) => run.runId), ['run-1']);
    const run = await store.get('run-1');
    assert.equal(run.notificationStatus, 'source-closed');
    assert.equal(run.notificationSuppressed, true);
    assert.equal(run.sourceFollowupPending, false);
    assert.deepEqual(orchestrationInstallBlockers(run), []);
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
    await store.patch('run-1', { resultComplete: true, resultProofStatus: 'complete' });
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

test('waiting without a timer keeps the interrupted link recoverable', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('waiting'),
      reactToManualInterrupt: true,
      failureGraceMs: 1000,
    });
    await store.markDelivery('waiting');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.applyLifecycle('target-1', { type: 'done', reason: 'turn_aborted' });
    assert.ok((await store.get('waiting')).recoveryDeadlineAt);

    const held = await store.resolveRecovery('waiting', 'wait');
    assert.equal(held.run.status, 'waiting_recovery');
    assert.equal(held.run.recoveryDeadlineAt, null);
    assert.ok(held.run.recoveryWaitStartedAt);

    const expired = await store.expireRecoveryDeadlines(Date.now() + 10_000);
    assert.equal(expired.settled.length, 0);
    assert.equal((await store.get('waiting')).status, 'waiting_recovery');
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('detaching settles only the orchestration link and suppresses its notification', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({
      ...baseRun('detached'),
      targetCreatedByOrchestration: true,
    });
    await store.markDelivery('detached');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });

    const detached = await store.cancel('detached', {
      reason: 'detached-by-user',
      suppressNotification: true,
      outcome: 'detached',
    });
    assert.equal(detached.run.status, 'cancelled');
    assert.equal(detached.run.outcome, 'detached');
    assert.equal(detached.run.completionReason, 'detached-by-user');
    assert.equal(detached.run.notificationStatus, 'suppressed');
    assert.equal(detached.run.notificationSuppressed, true);
    assert.equal(shouldScheduleCreatedTargetAutoStop(detached.run), false);

    await store.applyLifecycle('target-1', { type: 'done', reason: 'task_complete' });
    assert.equal((await store.get('detached')).outcome, 'detached');
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

test('an orchestration-created target keeps auto-stop ownership when later runs reuse it', async () => {
  const { store, filePath, cleanup } = await makeStore();
  try {
    const created = await store.create({
      ...baseRun('created-run', 'managed-target'),
      targetCreated: true,
    });
    assert.equal(created.targetCreated, true);
    assert.equal(created.targetCreatedByOrchestration, true);

    const reused = await store.create({
      ...baseRun('reused-run', 'managed-target'),
      targetCreated: false,
    });
    assert.equal(reused.targetCreated, false);
    assert.equal(reused.targetCreatedByOrchestration, true);
    assert.equal(shouldScheduleCreatedTargetAutoStop({
      ...reused,
      status: 'completed',
      resultComplete: true,
      successAutoStopMs: 300_000,
      autoStopCreatedTargets: true,
    }), true);

    const manual = await store.create({
      ...baseRun('manual-run', 'manual-target'),
      targetCreated: false,
    });
    assert.equal(manual.targetCreatedByOrchestration, false);
    assert.equal(shouldScheduleCreatedTargetAutoStop({
      ...manual,
      status: 'completed',
      resultComplete: true,
      successAutoStopMs: 300_000,
      autoStopCreatedTargets: true,
    }), false);

    await store.flush();
    const persisted = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    assert.deepEqual(persisted.createdTargetTabIds, ['managed-target']);

    const restored = new OrchestrationRunStore(filePath);
    const reusedAfterRestart = await restored.create({
      ...baseRun('reused-after-restart', 'managed-target'),
      targetCreated: false,
    });
    assert.equal(reusedAfterRestart.targetCreatedByOrchestration, true);
    await restored.flush();
  } finally {
    await cleanup();
  }
});

test('v2 run history backfills orchestration-created target ownership', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-orchestration-owned-target-'));
  const filePath = path.join(dir, 'runs.json');
  try {
    const now = Date.now();
    await fs.promises.writeFile(filePath, JSON.stringify({
      version: 2,
      settings: {},
      runs: [
        {
          ...baseRun('legacy-created', 'legacy-managed-target'),
          targetCreated: true,
          status: 'completed',
          resultComplete: true,
          createdAt: now - 20_000,
          completedAt: now - 19_000,
          autoStopAt: now - 18_000,
          autoStopStatus: 'stopped',
          autoStopFinishedAt: now - 17_000,
        },
        {
          ...baseRun('legacy-reused-before-fix', 'legacy-managed-target'),
          targetCreated: false,
          status: 'completed',
          resultComplete: true,
          createdAt: now - 10_000,
          completedAt: now - 5_000,
        },
      ],
    }), 'utf8');

    const store = new OrchestrationRunStore(filePath);
    const backfilled = await store.get('legacy-reused-before-fix');
    assert.equal(backfilled.targetCreatedByOrchestration, true);
    assert.equal(backfilled.autoStopAt, now + 295_000);
    assert.equal(backfilled.autoStopStatus, 'scheduled');

    const reused = await store.create({
      ...baseRun('legacy-reused', 'legacy-managed-target'),
      targetCreated: false,
    });
    assert.equal(reused.targetCreatedByOrchestration, true);
    await store.flush();
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

test('F3: result lookup carries exact prompt UUID and a completed-turn upper bound', () => {
  assert.deepEqual(buildOrchestrationResultLookup({
    promptHash: 'same-hash',
    targetPromptProofUserUuid: 'exact-user-1',
    createdAt: 100,
    ownCompletedAt: 200,
  }), {
    promptHash: 'same-hash',
    promptUserUuid: 'exact-user-1',
    requestedAt: 100,
    resultAfterAt: undefined,
    resultBeforeAt: 200,
  });
  assert.equal(buildOrchestrationResultLookup({
    resultPromptHash: 'notification-hash',
    resultPromptProofUserUuid: 'notification-user',
    resultPromptRequestedAt: 300,
    completedAt: 400,
  }).promptUserUuid, 'notification-user');
});

test('result lookup carries the persisted target execution identity when it is exact', () => {
  assert.deepEqual(buildOrchestrationResultLookup({
    promptHash: 'prompt-hash',
    createdAt: 100,
    ownCompletedAt: 200,
    targetExecutionContext: {
      provider: 'codex',
      sessionId: 'session-1',
      turnId: 'turn-1',
      processId: null,
      generation: 7,
      startedAt: 123,
    },
  }), {
    promptHash: 'prompt-hash',
    promptUserUuid: undefined,
    requestedAt: 100,
    resultAfterAt: undefined,
    resultBeforeAt: 200,
    targetExecutionContext: {
      provider: 'codex',
      sessionId: 'session-1',
      turnId: 'turn-1',
      processId: null,
      generation: 7,
      startedAt: 123,
    },
  });
});

test('proven pre-submit refusal settles immediately and exposes source notification', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-pre-submit-failure'));
    const policy = orchestrationSendFailureRecoveryPolicy({
      success: false,
      accepted: false,
      submitted: false,
      error: 'send-refused-before-submit',
    });
    const transition = await store.beginRecovery(
      'run-pre-submit-failure',
      'failed',
      'send-refused-before-submit',
      { now: 1000, failureGraceMs: policy.failureGraceMs },
    );
    const run = await store.get('run-pre-submit-failure');

    assert.equal(policy.provenNotSent, true);
    assert.equal(policy.failureGraceMs, 0);
    assert.equal(run.status, 'failed');
    assert.equal(run.completedAt, 1000);
    assert.equal(run.recoveryDeadlineAt, null);
    assert.equal(run.notificationStatus, 'pending');
    assert.equal(run.sourceFollowupPending, true);
    assert.equal(transition.settled.length, 1);
    await store.persistStrict();
  } finally {
    await cleanup();
  }
});

test('unknown send failure keeps the configured recovery window', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-unknown-delivery'), failureGraceMs: 5000 });
    const policy = orchestrationSendFailureRecoveryPolicy({
      success: false,
      accepted: false,
      status: 'delivery_unknown',
      error: 'bridge_timeout_delivery_unknown',
    });
    const transition = await store.beginRecovery(
      'run-unknown-delivery',
      'failed',
      'bridge_timeout_delivery_unknown',
      { now: 1000, failureGraceMs: policy.failureGraceMs },
    );
    const run = await store.get('run-unknown-delivery');

    assert.equal(policy.provenNotSent, false);
    assert.equal(policy.failureGraceMs, undefined);
    assert.equal(run.status, 'waiting_recovery');
    assert.equal(run.recoveryDeadlineAt, 6000);
    assert.equal(run.sourceFollowupPending, false);
    assert.equal(transition.settled.length, 0);
    await store.persistStrict();
  } finally {
    await cleanup();
  }
});

test('F1: late done cannot settle a run after target close moved it into recovery', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-late-close'));
    await store.markDelivery('run-late-close');
    await store.applyLifecycle('target-1', { type: 'busy', busy: true });
    await store.handleTargetClosed('target-1', { now: 1000, failureGraceMs: 60_000 });

    const late = await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
    });
    const run = await store.get('run-late-close');
    assert.equal(run.status, 'waiting_recovery');
    assert.equal(run.outcome, 'target_closed');
    assert.deepEqual(late.settled, []);
    assert.deepEqual(late.completed, []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('F1: late done from the old Codex generation cannot settle process replacement recovery', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create({ ...baseRun('run-late-generation'), targetToolType: 'codex' });
    await store.markDelivery('run-late-generation', { lifecycleGeneration: 'pty-old:1' });
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      lifecycleGeneration: 'pty-old:1',
    });
    await store.reconcile('run-late-generation', {
      busy: true,
      lifecycleGeneration: 'pty-new:1',
      resultFound: false,
      resultComplete: false,
    });

    const late = await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      lifecycleGeneration: 'pty-old:1',
    });
    const run = await store.get('run-late-generation');
    assert.equal(run.status, 'waiting_recovery');
    assert.equal(run.outcome, 'process_replaced');
    assert.deepEqual(late.settled, []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('F1: late done from an old execution cannot settle a newer unbound run on the same tab', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const oldContext = {
      provider: 'claude', sessionId: 'shared-session', turnId: 'claude:old',
    };
    await store.create(baseRun('run-old'));
    await store.markDelivery('run-old');
    await store.applyLifecycle('target-1', {
      type: 'busy', busy: true, executionContext: oldContext,
    });
    await store.handleTargetClosed('target-1', { now: 1000, failureGraceMs: 60_000 });

    await store.create(baseRun('run-new'));
    await store.markDelivery('run-new');
    await store.confirmTargetPromptDelivery(
      'run-new',
      targetAuditProof('run-new'),
      { now: 2000 },
    );
    assert.equal((await store.get('run-new')).status, 'running');

    const late = await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      executionContext: oldContext,
    });

    assert.equal((await store.get('run-old')).status, 'waiting_recovery');
    assert.equal((await store.get('run-new')).status, 'running');
    assert.deepEqual(late.settled, []);
    assert.deepEqual(late.completed, []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('F1: Claude writer identity rejects a stale process even if its turn id was relabeled', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-old-writer'));
    await store.markDelivery('run-old-writer');
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: {
        provider: 'claude',
        sessionId: 'shared-session',
        turnId: 'claude:1',
        processId: 'pid-old',
      },
    });
    await store.handleTargetClosed('target-1', { now: 1000, failureGraceMs: 60_000 });

    await store.create(baseRun('run-new-writer'));
    await store.markDelivery('run-new-writer');
    await store.applyLifecycle('target-1', {
      type: 'busy',
      busy: true,
      executionContext: {
        provider: 'claude',
        sessionId: 'shared-session',
        turnId: 'claude:2',
        processId: 'pid-new',
      },
    });

    const stale = await store.applyLifecycle('target-1', {
      type: 'done',
      reason: 'task_complete',
      executionContext: {
        provider: 'claude',
        sessionId: 'shared-session',
        turnId: 'claude:2',
        processId: 'pid-old',
      },
    });

    assert.equal((await store.get('run-old-writer')).status, 'waiting_recovery');
    assert.equal((await store.get('run-new-writer')).status, 'running');
    assert.deepEqual(stale.settled, []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('F4: waiting descendants does not consume the lifecycle of a later run on the same target', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-first', 'worker'));
    await store.markDelivery('run-first');
    const firstContext = {
      provider: 'claude', sessionId: 'worker-session', turnId: 'claude:1',
    };
    const secondContext = {
      provider: 'claude', sessionId: 'worker-session', turnId: 'claude:2',
    };
    await store.applyLifecycle('worker', {
      type: 'busy', busy: true, executionContext: firstContext,
    });
    await store.create({
      ...baseRun('run-child', 'tester'),
      sourceTabId: 'worker',
      parentRunId: 'run-first',
    });
    await store.markDelivery('run-child');
    await store.applyLifecycle('worker', {
      type: 'done', reason: 'task_complete', executionContext: firstContext,
    });
    assert.equal((await store.get('run-first')).status, 'waiting_descendants');

    await store.create(baseRun('run-second', 'worker'));
    await store.markDelivery('run-second');
    assert.equal((await store.get('run-second')).status, 'sent');
    await store.applyLifecycle('worker', {
      type: 'busy', busy: true, executionContext: secondContext,
    });
    const secondDone = await store.applyLifecycle('worker', {
      type: 'done',
      reason: 'task_complete',
      executionContext: secondContext,
    });

    assert.equal((await store.get('run-second')).status, 'completed');
    assert.equal((await store.get('run-first')).status, 'waiting_descendants');
    assert.deepEqual(secondDone.settled.map((run) => run.runId), ['run-second']);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('F5: only the exact active execution context creates a causal child link', async () => {
  const { store, filePath, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-parent', 'worker'));
    await store.markDelivery('run-parent');
    await store.applyLifecycle('worker', { type: 'busy', busy: true });
    await store.patch('run-parent', {
      targetExecutionContext: {
        provider: 'claude',
        sessionId: 'session-worker',
        turnId: 'claude:17',
      },
    });

    const nested = await store.create({
      ...baseRun('run-nested', 'tester-a'),
      sourceTabId: 'worker',
      sourceExecutionContext: {
        provider: 'claude',
        sessionId: 'session-worker',
        turnId: 'claude:17',
      },
    });
    assert.equal(nested.parentRunId, 'run-parent');

    const unrelated = await store.create({
      ...baseRun('run-independent', 'tester-b'),
      sourceTabId: 'worker',
      sourceExecutionContext: {
        provider: 'claude',
        sessionId: 'session-worker',
        turnId: 'claude:18',
      },
    });
    assert.equal(unrelated.parentRunId, null);

    const noContext = await store.create({
      ...baseRun('run-manual', 'tester-c'),
      sourceTabId: 'worker',
    });
    assert.equal(noContext.parentRunId, null);

    await store.create(baseRun('run-ambiguous-a', 'shared-worker'));
    await store.create(baseRun('run-ambiguous-b', 'shared-worker'));
    const ambiguousContext = {
      provider: 'codex', sessionId: 'shared-session', turnId: 'turn-shared',
    };
    await store.patch('run-ambiguous-a', { targetExecutionContext: ambiguousContext });
    await store.patch('run-ambiguous-b', { targetExecutionContext: ambiguousContext });
    const ambiguous = await store.create({
      ...baseRun('run-ambiguous-child', 'tester-d'),
      sourceTabId: 'shared-worker',
      sourceExecutionContext: ambiguousContext,
    });
    assert.equal(ambiguous.parentRunId, null);

    await store.flush();
    const restored = new OrchestrationRunStore(filePath);
    assert.equal((await restored.get('run-nested')).parentRunId, 'run-parent');
    assert.equal((await restored.get('run-independent')).parentRunId, null);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('F5: only an internal Terminal MCP caller can supply causal source context', () => {
  const context = { provider: 'claude', sessionId: 'session-1', turnId: 'claude:9' };
  const getter = () => context;
  assert.deepEqual(resolveCausalSourceExecutionContext({
    sourceTabId: 'source-tab',
    sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'source-tab' },
    getExecutionContext: getter,
  }), { ...context, processId: null, generation: null, startedAt: null });
  assert.equal(resolveCausalSourceExecutionContext({
    sourceTabId: 'source-tab',
    sourceMeta: { server: 'terminal', mode: 'external', tabId: 'source-tab' },
    getExecutionContext: getter,
  }), null);
  assert.equal(resolveCausalSourceExecutionContext({
    sourceTabId: 'source-tab',
    sourceMeta: { server: 'terminal', mode: 'internal', tabId: 'other-tab' },
    getExecutionContext: getter,
  }), null);
});

test('F6: incomplete result proof remains a source and target install blocker', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-result-proof', 'target-proof'));
    await store.markDelivery('run-result-proof');
    await store.applyLifecycle('target-proof', { type: 'busy', busy: true });
    await store.applyLifecycle('target-proof', { type: 'done', reason: 'task_complete' });
    await store.patch('run-result-proof', {
      resultComplete: false,
      resultProofStatus: 'awaiting-transcript',
    });

    const run = await store.get('run-result-proof');
    assert.deepEqual(orchestrationInstallBlockers(run).map((loader) => [
      loader.tabId,
      loader.role,
      loader.status,
    ]), [
      ['source-1', 'source', 'result-proof'],
      ['target-proof', 'target', 'result-proof'],
    ]);
    const snapshot = mergeActiveLoadersWithOrchestrations(
      { idle: true, count: 0, loaders: [] },
      await store.listActive(),
    );
    assert.equal(snapshot.idle, false);
    assert.equal(shouldScheduleCreatedTargetAutoStop({
      ...run,
      targetCreatedByOrchestration: true,
      autoStopCreatedTargets: true,
      successAutoStopMs: 300_000,
    }), false);
    assert.equal(snapshot.count, 2);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('detaching an incomplete completed result releases blockers without targeting the agent', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-detach-proof', 'target-proof'));
    await store.markDelivery('run-detach-proof');
    await store.applyLifecycle('target-proof', { type: 'busy', busy: true });
    await store.applyLifecycle('target-proof', { type: 'done', reason: 'task_complete' });
    await store.patch('run-detach-proof', {
      resultComplete: false,
      resultProofStatus: 'awaiting-transcript',
      resultError: 'matching transcript turn is incomplete',
    });

    const detached = await store.cancel('run-detach-proof', {
      reason: 'detached-by-user',
      suppressNotification: true,
      outcome: 'detached',
    });

    assert.equal(detached.run.status, 'cancelled');
    assert.equal(detached.run.outcome, 'detached');
    assert.equal(detached.run.notificationStatus, 'suppressed');
    assert.equal(detached.run.notificationSuppressed, true);
    assert.deepEqual(orchestrationInstallBlockers(detached.run), []);
    assert.deepEqual(await store.listActive(), []);
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('a closed target converts an unrecoverable result proof into a terminal error', async () => {
  const { store, filePath, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-orphan-proof', 'target-closed'));
    await store.markDelivery('run-orphan-proof');
    await store.applyLifecycle('target-closed', { type: 'busy', busy: true });
    await store.applyLifecycle('target-closed', { type: 'done', reason: 'task_complete' });
    await store.patch('run-orphan-proof', {
      resultComplete: false,
      resultProofStatus: 'awaiting-transcript',
      resultError: 'matching user turn not found',
      notificationStatus: 'suppressed',
      notificationSuppressed: true,
      notificationDismissedAt: 200,
    });
    await store.flush();

    const restored = new OrchestrationRunStore(filePath);
    const unresolved = await restored.get('run-orphan-proof');
    assert.equal(orchestrationInstallBlockers(unresolved)[0]?.status, 'result-proof');

    const resolution = await restored.markResultProofUnavailable(
      'run-orphan-proof',
      'target tab closed and exact result is unavailable',
      { now: 300 },
    );
    assert.equal(resolution.run.status, 'failed');
    assert.equal(resolution.run.outcome, 'result_unavailable');
    assert.equal(resolution.run.resultProofStatus, 'unavailable');
    assert.equal(resolution.run.resultProofUnavailableAt, 300);
    assert.equal(resolution.run.resultComplete, false);
    assert.equal(resolution.run.notificationStatus, 'suppressed');
    assert.deepEqual(orchestrationInstallBlockers(resolution.run), []);
    assert.deepEqual(await restored.listActive(), []);

    const retained = await restored.get('run-orphan-proof');
    assert.equal(retained.resultError, 'matching user turn not found');
    assert.match(retained.error, /target tab closed/);
    await restored.flush();
  } finally {
    await store.flush();
    await cleanup();
  }
});

test('unavailable result still delivers one explicit failure when its source is waiting', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.create(baseRun('run-proof-error', 'target-closed'));
    await store.markDelivery('run-proof-error');
    await store.applyLifecycle('target-closed', { type: 'busy', busy: true });
    await store.applyLifecycle('target-closed', { type: 'done', reason: 'task_complete' });
    await store.patch('run-proof-error', {
      resultComplete: false,
      resultProofStatus: 'awaiting-transcript',
    });

    const resolution = await store.markResultProofUnavailable(
      'run-proof-error',
      'target tab closed and exact result is unavailable',
      { now: 400 },
    );
    assert.equal(resolution.run.status, 'failed');
    assert.equal(resolution.run.notificationStatus, 'pending');
    assert.equal(resolution.run.sourceFollowupPending, true);
    assert.deepEqual(orchestrationInstallBlockers(resolution.run).map((loader) => [
      loader.tabId,
      loader.role,
      loader.status,
    ]), [['source-1', 'source', 'completion-handoff']]);
  } finally {
    await store.flush();
    await cleanup();
  }
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

async function createDueAutoStop(store, runId = 'run-auto-stop', targetTabId = 'managed-target') {
  const now = Date.now();
  await store.create({
    ...baseRun(runId, targetTabId),
    targetCreated: true,
  });
  return store.patch(runId, {
    status: 'completed',
    resultComplete: true,
    completedAt: now - 1_000,
    autoStopAt: now - 500,
    autoStopStatus: 'scheduled',
  });
}

const absentTargetIdentity = (patch = {}) => ({
  terminalLifecycleGeneration: 'terminal-epoch:3',
  terminalRunSeq: 3,
  inputRevision: 8,
  processStatus: 'absent',
  processPid: null,
  processName: null,
  sessionId: null,
  ...patch,
});

test('a due auto-stop has one durable claimant and survives restart', async () => {
  const { store, filePath, cleanup } = await makeStore();
  try {
    await createDueAutoStop(store);
    const [first, second] = await Promise.all([
      store.claimDueAutoStop('run-auto-stop', { expectedTargetIdentity: absentTargetIdentity() }),
      store.claimDueAutoStop('run-auto-stop', { expectedTargetIdentity: absentTargetIdentity() }),
    ]);
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, true);
    assert.equal(first.claimId, second.claimId);
    assert.equal([first.idempotent, second.idempotent].filter(Boolean).length, 1);

    const restored = new OrchestrationRunStore(filePath);
    await restored.get('run-auto-stop');
    const validation = restored.validateAutoStopClaim('run-auto-stop', first.claimId);
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.expectedTargetIdentity, absentTargetIdentity());
  } finally {
    await cleanup();
  }
});

test('automatic restore is suppressed, while explicit Continue supersedes the old auto-stop', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await createDueAutoStop(store);
    const automatic = await store.admitAgentLaunch('managed-target', {
      launchSource: 'auto-resume',
    });
    assert.equal(automatic.allowed, false);
    assert.equal(automatic.suppressed, true);
    assert.equal(automatic.runId, 'run-auto-stop');

    const explicit = await store.admitAgentLaunch('managed-target', {
      launchSource: 'explicit',
    });
    assert.equal(explicit.allowed, true);
    assert.deepEqual(explicit.supersededRunIds, ['run-auto-stop']);
    const run = await store.get('run-auto-stop');
    assert.equal(run.autoStopStatus, 'skipped-target-changed');
    assert.ok(run.autoStopFinishedAt);
  } finally {
    await cleanup();
  }
});

test('automatic restore before the deadline does not cancel the future auto-stop', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await createDueAutoStop(store);
    await store.patch('run-auto-stop', {
      autoStopAt: Date.now() + 60_000,
      autoStopStatus: 'scheduled',
    });
    const admission = await store.admitAgentLaunch('managed-target', {
      launchSource: 'auto-resume',
    });
    assert.equal(admission.allowed, true);
    assert.deepEqual(admission.supersededRunIds, []);
    const run = await store.get('run-auto-stop');
    assert.equal(run.autoStopStatus, 'scheduled');
    assert.equal(run.autoStopFinishedAt, undefined);
  } finally {
    await cleanup();
  }
});

test('new target activity invalidates a scheduled auto-stop before it can claim', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await createDueAutoStop(store);
    await store.applyLifecycle('managed-target', {
      type: 'busy',
      busy: true,
      sessionId: 'manual-session',
      executionContext: {
        provider: 'claude',
        sessionId: 'manual-session',
        turnId: 'manual-turn',
        processId: '88',
      },
    });
    const claim = await store.claimDueAutoStop('run-auto-stop', {
      expectedTargetIdentity: absentTargetIdentity(),
    });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, 'skipped-target-changed');
    assert.equal((await store.get('run-auto-stop')).autoStopFinishedAt > 0, true);
  } finally {
    await cleanup();
  }
});

test('only the current claim may settle and changed activity revokes its final signal authority', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await createDueAutoStop(store);
    const claim = await store.claimDueAutoStop('run-auto-stop', {
      expectedTargetIdentity: absentTargetIdentity(),
    });
    assert.equal(store.validateAutoStopClaim('run-auto-stop', claim.claimId).valid, true);
    assert.equal((await store.settleAutoStopClaim(
      'run-auto-stop',
      'wrong-claim',
      { status: 'stopped' },
    )).reason, 'auto-stop-claim-changed');

    await store.admitAgentLaunch('managed-target', { launchSource: 'explicit' });
    assert.equal(store.validateAutoStopClaim('run-auto-stop', claim.claimId).valid, false);
    assert.equal((await store.settleAutoStopClaim(
      'run-auto-stop',
      claim.claimId,
      { status: 'stopped' },
    )).reason, 'auto-stop-already-finished');
  } finally {
    await cleanup();
  }
});

test('detaching a settled run cancels its pending auto-stop without stopping the target', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await createDueAutoStop(store);
    const cancellation = await store.cancelAutoStop('run-auto-stop', {
      reason: 'detached-by-user',
    });
    assert.equal(cancellation.cancelled, true);
    assert.equal(cancellation.run.autoStopStatus, 'cancelled');
    assert.ok(cancellation.run.autoStopFinishedAt);
    assert.equal((await store.claimDueAutoStop('run-auto-stop', {
      expectedTargetIdentity: absentTargetIdentity(),
    })).reason, 'auto-stop-already-finished');
  } finally {
    await cleanup();
  }
});
