import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRewindCancelReply,
  clearRewindOperation,
  completeRewindOperation,
  createEmptyRewindOperationTable,
  markRewindMutationStarted,
  requestRewindCancellation,
  resolveRewindCancellation,
  selectActiveRewindOperation,
  startRewindOperation,
  updateRewindOperation,
  type StartRewindOperationInput,
} from './rewindOperationState.ts';

const operation = (
  tabId: string,
  opId: string,
  overrides: Partial<StartRewindOperationInput> = {},
): StartRewindOperationInput => ({
  tabId,
  opId,
  toolType: 'codex',
  mode: 'native',
  sourceSessionId: `session-${tabId}-a`,
  targetUuid: `target-${tabId}`,
  targetText: `Prompt ${tabId}`,
  targetIndex: 4,
  startedAt: 100,
  ...overrides,
});

test('operations are independent per tab and survive a session A to B handoff', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-a'));
  state = startRewindOperation(state, operation('tab-b', 'op-b'));
  state = updateRewindOperation(state, 'tab-a', 'op-a', {
    activeSessionId: 'session-tab-a-b',
    phase: 'rewinding',
  }, 200);

  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.opId, 'op-a');
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.sourceSessionId, 'session-tab-a-a');
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.activeSessionId, 'session-tab-a-b');
  assert.equal(selectActiveRewindOperation(state, 'tab-b')?.opId, 'op-b');
});

test('one tab rejects a concurrent rewind without blocking another tab', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-a'));
  const rejected = startRewindOperation(state, operation('tab-a', 'op-a-2'));
  const parallel = startRewindOperation(state, operation('tab-b', 'op-b'));

  assert.equal(rejected, state);
  assert.equal(selectActiveRewindOperation(parallel, 'tab-a')?.opId, 'op-a');
  assert.equal(selectActiveRewindOperation(parallel, 'tab-b')?.opId, 'op-b');
});

test('stale completion cannot clear or replace a newer operation in the same tab', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-1'));
  state = clearRewindOperation(state, 'tab-a', 'op-1');
  state = startRewindOperation(state, operation('tab-a', 'op-2'));

  const staleDone = completeRewindOperation(state, 'tab-a', 'op-1', 'stale-child');
  const staleClear = clearRewindOperation(state, 'tab-a', 'op-1');

  assert.equal(staleDone, state);
  assert.equal(staleClear, state);
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.opId, 'op-2');
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.activeSessionId, undefined);
});

test('accepted cancellation clears only the matching operation', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-a'));
  state = startRewindOperation(state, operation('tab-b', 'op-b'));
  state = requestRewindCancellation(state, 'tab-a', 'op-a', 150);
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.phase, 'cancelling');

  state = resolveRewindCancellation(state, 'tab-a', 'op-a', 'accepted', 160);
  assert.equal(selectActiveRewindOperation(state, 'tab-a'), null);
  assert.equal(selectActiveRewindOperation(state, 'tab-b')?.opId, 'op-b');
});

test('too-late cancellation remains locked until the authoritative result completes', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-a'));
  state = requestRewindCancellation(state, 'tab-a', 'op-a', 150);
  state = resolveRewindCancellation(state, 'tab-a', 'op-a', 'too-late', 160);

  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.phase, 'committing');
  state = completeRewindOperation(state, 'tab-a', 'op-a', 'session-tab-a-b', 200);
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.phase, 'done');
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.activeSessionId, 'session-tab-a-b');
});

test('mutation-started is owner and tool safe and wins a cancel reply race', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-a'));
  state = requestRewindCancellation(state, 'tab-a', 'op-a', 150);

  assert.equal(markRewindMutationStarted(state, 'tab-a', 'stale-op', 'codex'), state);
  assert.equal(markRewindMutationStarted(state, 'tab-a', 'op-a', 'claude'), state);

  state = markRewindMutationStarted(state, 'tab-a', 'op-a', 'codex', 160);
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.phase, 'committing');

  const lateAcceptedReply = resolveRewindCancellation(state, 'tab-a', 'op-a', 'accepted', 170);
  assert.equal(lateAcceptedReply, state);
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.phase, 'committing');
});

test('an authoritative success wins an older pending cancel reply', () => {
  let state = createEmptyRewindOperationTable();
  state = startRewindOperation(state, operation('tab-a', 'op-a'));
  state = requestRewindCancellation(state, 'tab-a', 'op-a', 150);
  state = completeRewindOperation(state, 'tab-a', 'op-a', 'session-tab-a-b', 160);

  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.phase, 'done');
  const lateAcceptedReply = resolveRewindCancellation(state, 'tab-a', 'op-a', 'accepted', 170);
  assert.equal(lateAcceptedReply, state);
  assert.equal(selectActiveRewindOperation(state, 'tab-a')?.activeSessionId, 'session-tab-a-b');
});

test('cancel reply classifier supports the explicit contract and legacy success', () => {
  assert.equal(classifyRewindCancelReply({ success: true, accepted: true }), 'accepted');
  assert.equal(classifyRewindCancelReply({
    success: false,
    accepted: false,
    tooLate: true,
    error: 'rewind_cancel_too_late',
  }), 'too-late');
  assert.equal(classifyRewindCancelReply({ success: false, accepted: false }), 'rejected');
  assert.equal(classifyRewindCancelReply({ success: true }), 'accepted');
  assert.equal(classifyRewindCancelReply(null), 'rejected');
});
