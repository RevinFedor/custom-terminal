import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isWorkflowOutcomeAtOrAfterArm,
  planWorkflowReconciliation,
} from './promptQueueReconciliation.mjs';

test('workflow outcomes require a persisted arm timestamp and cannot predate it', () => {
  assert.equal(isWorkflowOutcomeAtOrAfterArm(null, 200), false);
  assert.equal(isWorkflowOutcomeAtOrAfterArm(200, null), false);
  assert.equal(isWorkflowOutcomeAtOrAfterArm(200, 199), false);
  assert.equal(isWorkflowOutcomeAtOrAfterArm(200, 200), true);
  assert.equal(isWorkflowOutcomeAtOrAfterArm(200, 201), true);
});

test('restore applies all abnormal evidence before only the latest success per trigger', () => {
  const earlySuccess = { tabId: 'a', kind: 'natural', timestamp: 100, source: 'buffer' };
  const failure = { tabId: 'a', kind: 'abnormal', timestamp: 150, source: 'main' };
  const lateSuccess = { tabId: 'a', kind: 'natural', timestamp: 200, source: 'main' };
  const otherFailure = { tabId: 'b', kind: 'abnormal', timestamp: null, source: 'legacy' };
  const unknownSuccess = { tabId: 'b', kind: 'natural', timestamp: null, source: 'unknown' };

  const plan = planWorkflowReconciliation([
    earlySuccess,
    failure,
    lateSuccess,
    otherFailure,
    unknownSuccess,
  ]);

  assert.deepEqual(plan.abnormal, [failure, otherFailure]);
  assert.deepEqual(plan.natural, [lateSuccess]);
  assert.deepEqual([...plan.abnormal, ...plan.natural], [failure, otherFailure, lateSuccess]);
});
