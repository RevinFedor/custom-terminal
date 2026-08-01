import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOrchestrationCompletionBlocking,
  isOrchestrationInheritedActivity,
  isOrchestrationResultProofPending,
  shouldRetainOrchestrationRun,
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
