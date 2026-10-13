import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldDeferTabCompletionNotification } from './tabCompletionDeferral.mjs';

test('plain finished turn with nothing pending rings', () => {
  assert.equal(
    shouldDeferTabCompletionNotification({ successful: true }),
    null,
  );
});

test('a native Goal final only rings after the whole Goal is complete', () => {
  for (const phase of ['continuing', 'attention']) {
    assert.equal(shouldDeferTabCompletionNotification({ successful: true,
      goalWork: { version: 1, pending: true, phase } }), 'native-goal-' + phase);
  }
  assert.equal(shouldDeferTabCompletionNotification({ successful: true,
    goalWork: { version: 1, pending: false, phase: 'complete' } }), null);
});

test('turn that ends while Run after still owes prompts stays silent', () => {
  assert.equal(
    shouldDeferTabCompletionNotification({ successful: true, queueContinuationPending: true }),
    'queue-continuation-pending',
  );
});

test('the LAST queue item rings — nothing is pending after it fired', () => {
  assert.equal(
    shouldDeferTabCompletionNotification({ successful: true, queueContinuationPending: false }),
    null,
  );
});

test('orchestration keeps priority over the queue gate', () => {
  assert.equal(
    shouldDeferTabCompletionNotification({
      successful: true,
      orchestrationBlocked: true,
      queueContinuationPending: true,
    }),
    'orchestration-blocked',
  );
});

test('abnormal end never defers on the queue — Run after is disarmed by it', () => {
  // Without this, an interrupted tab would keep an armed bell waiting for a
  // turn that the DISARM contract guarantees will never come.
  assert.equal(
    shouldDeferTabCompletionNotification({ successful: false, queueContinuationPending: true }),
    null,
  );
});

test('abnormal end still defers while orchestration owns the outcome', () => {
  assert.equal(
    shouldDeferTabCompletionNotification({ successful: false, orchestrationBlocked: true }),
    'orchestration-blocked',
  );
});
