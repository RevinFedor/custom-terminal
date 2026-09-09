'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  captureManualCodexQueueInterrupt,
  classifyManualCodexQueueInterruptOutcome,
} = require('./codex-manual-queue-interrupt');

function fixture() {
  const terminal = {};
  const pendingPrompt = {
    text: 'already queued prompt',
    source: 'manual-terminal-enter',
    terminal,
    lifecycleGeneration: 'life:1',
    promptGeneration: 7,
    sourceSequence: 100,
    sourceByteOffset: 5000,
  };
  const current = {
    reason: 'turn_aborted',
    turnId: 'turn-a',
    pendingPrompt,
    terminal,
    lifecycleGeneration: 'life:1',
    runSeq: 2,
    promptGeneration: 7,
    inputRevision: 9,
    outcomeTs: 1020,
  };
  const token = captureManualCodexQueueInterrupt({
    data: '\x1b', turnBusy: true, turnId: 'turn-a', pendingPrompt, terminal,
    lifecycleGeneration: 'life:1', runSeq: 2, promptGeneration: 7,
    inputRevision: 9, capturedAt: 1000,
  });
  return { terminal, pendingPrompt, current, token };
}

test('manual Escape classifies abort A as the boundary before queued B', () => {
  const f = fixture();
  assert.equal(f.token.turnId, 'turn-a');
  assert.deepEqual(classifyManualCodexQueueInterruptOutcome(f.token, f.current), {
    expectedContinuation: true,
    reason: 'manual-escape-submits-native-queue',
    queuedPromptSourceSequence: 100,
    queuedPromptSourceByteOffset: 5000,
  });
});

test('idle Escape, Ctrl+C and Escape without an exact queued prompt never claim continuation', () => {
  const f = fixture();
  for (const patch of [
    { data: '\x03' },
    { turnBusy: false },
    { pendingPrompt: null },
    { pendingPrompt: { ...f.pendingPrompt, source: 'rollout-user-message' } },
    { pendingPrompt: { ...f.pendingPrompt, terminal: {} } },
  ]) {
    assert.equal(captureManualCodexQueueInterrupt({
      data: '\x1b', turnBusy: true, turnId: 'turn-a', pendingPrompt: f.pendingPrompt,
      terminal: f.terminal, lifecycleGeneration: 'life:1', runSeq: 2,
      promptGeneration: 7, inputRevision: 9, capturedAt: 1000, ...patch,
    }), null);
  }
});

test('scope, turn, queued prompt and time are all revalidated at turn_aborted', () => {
  const f = fixture();
  for (const patch of [
    { reason: 'task_complete' }, { turnId: 'turn-b' }, { pendingPrompt: { ...f.pendingPrompt } },
    { terminal: {} }, { lifecycleGeneration: 'life:2' }, { runSeq: 3 },
    { promptGeneration: 8 }, { inputRevision: 10 }, { outcomeTs: 999 },
  ]) {
    assert.equal(classifyManualCodexQueueInterruptOutcome(
      f.token, { ...f.current, ...patch },
    ).expectedContinuation, false, JSON.stringify(Object.keys(patch)));
  }
});
