'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimRewindOperation,
  classifyRewindCancel,
  finishRewindOperation,
  markRewindMutationStarted,
} = require('./rewind-operation-contract');

function claim(operations, overrides = {}) {
  return claimRewindOperation(operations, {
    tabId: 'tab-1',
    toolType: 'codex',
    opId: 'rewind-1',
    ...overrides,
  }, {
    now: () => 1000,
    random: () => 0.5,
  });
}

test('one tab cannot claim a second Rewind operation concurrently', () => {
  const operations = new Map();
  const first = claim(operations);
  const second = claim(operations, { opId: 'rewind-2', toolType: 'claude' });

  assert.equal(first.success, true);
  assert.deepEqual(second, {
    success: false,
    error: 'rewind_already_in_progress',
    activeOpId: 'rewind-1',
  });
  assert.equal(operations.get('tab-1'), first.operation);
});

test('cancel rejects a stale operation id and a mismatched tool', () => {
  const operations = new Map();
  claim(operations);

  assert.deepEqual(classifyRewindCancel(operations, {
    tabId: 'tab-1',
    toolType: 'codex',
    opId: 'rewind-old',
  }).response, {
    success: false,
    accepted: false,
    stale: true,
    activeOpId: 'rewind-1',
    error: 'rewind_cancel_stale_operation',
  });

  assert.deepEqual(classifyRewindCancel(operations, {
    tabId: 'tab-1',
    toolType: 'claude',
    opId: 'rewind-1',
  }).response, {
    success: false,
    accepted: false,
    stale: true,
    activeOpId: 'rewind-1',
    error: 'rewind_cancel_stale_operation',
  });
});

test('cancel is accepted before the mutation boundary', () => {
  const operations = new Map();
  claim(operations);

  const decision = classifyRewindCancel(operations, {
    tabId: 'tab-1',
    toolType: 'codex',
    opId: 'rewind-1',
  });

  assert.equal(decision.status, 'accepted');
  assert.deepEqual(decision.response, { success: true, accepted: true });
});

test('cancel is too late after the mutation boundary', () => {
  const operations = new Map();
  const { operation } = claim(operations);

  assert.equal(markRewindMutationStarted(operations, operation, { now: () => 1100 }), true);
  assert.equal(operation.mutationStartedAt, 1100);
  assert.deepEqual(classifyRewindCancel(operations, {
    tabId: 'tab-1',
    toolType: 'codex',
    opId: 'rewind-1',
  }).response, {
    success: false,
    accepted: false,
    tooLate: true,
    error: 'rewind_cancel_too_late',
  });
});

test('finishing an old operation cannot delete a newer operation for the same tab', () => {
  const operations = new Map();
  const { operation: oldOperation } = claim(operations);
  operations.delete('tab-1');
  const { operation: newOperation } = claim(operations, { opId: 'rewind-2' });

  assert.equal(finishRewindOperation(operations, oldOperation), false);
  assert.equal(operations.get('tab-1'), newOperation);
  assert.equal(finishRewindOperation(operations, newOperation), true);
  assert.equal(operations.has('tab-1'), false);
});
