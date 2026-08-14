'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyClaudeFreshExactEmptyCapture,
  classifyClaudePostEnterOutcome,
} = require('./claude-post-enter-outcome');

function capture(text, overrides = {}) {
  return {
    success: true,
    text,
    images: 0,
    editorReturnReady: true,
    terminalIdentityStable: true,
    terminalRunSeq: 7,
    inputRevision: 12,
    terminalLifecycleGeneration: 'life-1',
    mirrorGeneration: 'mirror-1',
    mirrorWriteSeq: 41,
    mirrorFlushedSeq: 41,
    mirrorSynchronizedOutputOpen: false,
    synchronizedOutputGeneration: 9,
    ...overrides,
  };
}

test('exact original draft plus no post-boundary user turn is final not-submitted', () => {
  const result = classifyClaudePostEnterOutcome({
    expectedText: 'task body',
    capture: capture('task body'),
    transcriptRead: { success: true, userRecordCount: 0 },
    turnBusy: false,
  });

  assert.equal(result.final, true);
  assert.equal(result.semanticStatus, 'not-submitted');
  assert.equal(result.providerAccepted, false);
  assert.equal(result.providerTurnCreated, false);
  assert.equal(result.exactDraftRemained, true);
  assert.equal(result.draftPreserved, true);
  assert.equal(result.lateReconciliationPending, false);
});

test('changed or image-mixed composer remains unknown and preserved', () => {
  const changed = classifyClaudePostEnterOutcome({
    expectedText: 'task body',
    capture: capture('someone else typed here'),
    transcriptRead: { success: true, userRecordCount: 0 },
  });
  assert.equal(changed.final, false);
  assert.equal(changed.semanticStatus, 'unknown');
  assert.equal(changed.composerDraftState, 'changed-draft');

  const mixed = classifyClaudePostEnterOutcome({
    expectedText: 'task body',
    capture: capture('[Image #1]\ntask body', { images: 1 }),
    transcriptRead: { success: true, userRecordCount: 0 },
  });
  assert.equal(mixed.final, false);
  assert.equal(mixed.composerDraftState, 'mixed-or-image-draft');
  assert.equal(mixed.pasteObservedInComposer, true);
});

test('an empty composer cannot prove whether paste was missed or acceptance is merely late', () => {
  const result = classifyClaudePostEnterOutcome({
    expectedText: 'task body',
    capture: capture(''),
    transcriptRead: { success: true, userRecordCount: 0 },
  });
  assert.equal(result.final, false);
  assert.equal(result.semanticStatus, 'unknown');
  assert.equal(result.composerDraftState, 'empty');
  assert.equal(result.pasteObservedInComposer, null);
});

test('delayed exact JSONL success wins over a composer snapshot', () => {
  const acceptedResult = {
    success: true,
    entryUuid: 'accepted-user-turn',
    actualHash: 'hash',
  };
  const result = classifyClaudePostEnterOutcome({
    expectedText: 'task body',
    capture: capture('task body'),
    transcriptRead: { success: true, userRecordCount: 1 },
    acceptedResult,
  });
  assert.equal(result.final, true);
  assert.equal(result.semanticStatus, 'accepted');
  assert.equal(result.acceptedResult, acceptedResult);
});

test('an active Claude turn keeps confirming and does not inspect the composer', () => {
  const result = classifyClaudePostEnterOutcome({
    expectedText: 'task body',
    capture: capture('task body'),
    transcriptRead: { success: true, userRecordCount: 0 },
    turnBusy: true,
  });
  assert.equal(result.final, false);
  assert.equal(result.reason, 'claude_turn_still_active');
  assert.equal(result.composerDraftState, 'not-inspected-active-turn');
});

test('fresh exact empty capture becomes current-operation evidence', () => {
  const result = classifyClaudeFreshExactEmptyCapture(capture(''));
  assert.equal(result.valid, true);
  assert.equal(result.evidence.proofOutcome, 'absent');
  assert.equal(result.evidence.hasDraft, false);
  assert.equal(result.evidence.inputRevisionTransitionOwned, true);
});

test('fresh pre-submit capture refuses a foreign draft without changing it', () => {
  const result = classifyClaudeFreshExactEmptyCapture(capture('foreign draft'));
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'claude_existing_draft_before_paste');
  assert.equal(result.draftPreserved, true);
  assert.equal(result.composerDraftState, 'foreign-draft');
});
