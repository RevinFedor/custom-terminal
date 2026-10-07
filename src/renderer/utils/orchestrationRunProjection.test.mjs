import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOrchestrationCompletionBlocking,
  isOrchestrationInheritedActivity,
  isOrchestrationResultProofPending,
  shouldRetainOrchestrationRun,
  mergeOrchestrationRuns,
} from './orchestrationRunProjection.mjs';

function run(patch = {}) {
  return {
    runId: 'run-1',
    status: 'completed',
    sourceTabId: 'source',
    targetTabId: 'target',
    notificationStatus: 'pending',
    ...patch,
  };
}

test('late run list cannot overwrite a newer lifecycle event or erase an event-only run', () => {
  const old = run({ status: 'sending', updatedAt: 10 });
  const completed = run({ status: 'completed', updatedAt: 20, resultComplete: true });
  const other = run({ runId: 'event-only', status: 'running', updatedAt: 20 });
  assert.deepEqual(mergeOrchestrationRuns([old], [completed, other]), [completed, other]);
  assert.deepEqual(mergeOrchestrationRuns([], [completed]), [completed]);
});

test('newer list wins over an older event; equal timestamps prefer the accepted event', () => {
  const latest = run({ status: 'completed', updatedAt: 30 });
  const earlier = run({ status: 'running', updatedAt: 20 });
  assert.deepEqual(mergeOrchestrationRuns([latest], [earlier]), [latest]);
  const sameTick = run({ status: 'failed', updatedAt: 30 });
  assert.deepEqual(mergeOrchestrationRuns([latest], [sameTick]), [sameTick]);
});

test('legacy runs without versions retain accepted events and malformed rows do not invent identities', () => {
  const value = run({ status: 'queued' });
  assert.deepEqual(mergeOrchestrationRuns([null, {}, value], [undefined, { runId: '' }]), [value]);
  assert.deepEqual(mergeOrchestrationRuns(null, [value]), [value]);
});

test('F6: incomplete result proof remains visible, active, and completion-blocking', () => {
  const value = run({ resultComplete: false, sourceFollowupPending: false });
  assert.equal(isOrchestrationResultProofPending(value), true);
  assert.equal(shouldRetainOrchestrationRun(value), true);
  assert.equal(isOrchestrationInheritedActivity(value), true);
  assert.equal(isOrchestrationCompletionBlocking(value), true);
});

test('recovery and delivery attention block completion without inherited shimmer', () => {
  const recovery = run({ status: 'waiting_recovery', resultComplete: false });
  const deliveryError = run({
    status: 'completed',
    resultComplete: true,
    notificationStatus: 'unconfirmed',
    sourceFollowupPending: true,
  });

  for (const value of [recovery, deliveryError]) {
    assert.equal(shouldRetainOrchestrationRun(value), true);
    assert.equal(isOrchestrationCompletionBlocking(value), true);
    assert.equal(isOrchestrationInheritedActivity(value), false);
  }
});

test('a prompt waiting to cross Enter blocks completion without inherited shimmer', () => {
  const value = run({
    status: 'queued',
    deliveryAcceptedAt: null,
    targetPromptProofAt: null,
  });
  assert.equal(shouldRetainOrchestrationRun(value), true);
  assert.equal(isOrchestrationCompletionBlocking(value), true);
  assert.equal(isOrchestrationInheritedActivity(value), false);
});

test('claimed sending before Enter is not executing activity; proof restores activity without changing the block', () => {
  const sending = run({ status: 'sending', deliveryAcceptedAt: null, targetPromptProofAt: null });
  assert.equal(isOrchestrationInheritedActivity(sending), false);
  assert.equal(isOrchestrationCompletionBlocking(sending), true);
  assert.equal(shouldRetainOrchestrationRun(sending), true);
  for (const proof of [{ deliveryAcceptedAt: 1 }, { targetPromptProofAt: 1 }]) {
    assert.equal(isOrchestrationInheritedActivity({ ...sending, ...proof }), true);
    assert.equal(isOrchestrationCompletionBlocking({ ...sending, ...proof }), true);
  }
});

test('audit-pending source handoff stays visible and blocking in renderer parity with main', () => {
  const value = run({
    status: 'completed',
    resultComplete: true,
    notificationStatus: 'audit-pending',
    sourceFollowupPending: true,
    sourceFollowupStartedAt: null,
  });
  assert.equal(shouldRetainOrchestrationRun(value), true);
  assert.equal(isOrchestrationCompletionBlocking(value), true);
  assert.equal(isOrchestrationInheritedActivity(value), true);
});

test('targetless external research blocks completion and becomes inherited activity only after SC accepts it', () => {
  const queued = run({
    runKind: 'external-research',
    targetTabId: null,
    status: 'queued',
    deliveryAcceptedAt: null,
    targetPromptProofAt: null,
  });
  assert.equal(isOrchestrationCompletionBlocking(queued), true);
  assert.equal(isOrchestrationInheritedActivity(queued), false);
  assert.equal(shouldRetainOrchestrationRun(queued), true);

  const running = { ...queued, status: 'running', deliveryAcceptedAt: Date.now() };
  assert.equal(isOrchestrationInheritedActivity(running), true);

  const handoff = {
    ...running,
    status: 'completed',
    resultComplete: true,
    sourceFollowupPending: true,
    notificationStatus: 'pending',
  };
  assert.equal(isOrchestrationCompletionBlocking(handoff), true);
  assert.equal(shouldRetainOrchestrationRun(handoff), true);
});
