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

test('changed or unrelated image-mixed composer remains unknown and preserved', () => {
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

test('Claude image-path conversion remains exact not-submitted proof', () => {
  const expectedText = [
    'Review these references:',
    '- /tmp/noted-terminal-codex-image-input/first.png',
    '- /tmp/noted-terminal-codex-image-input/second image.jpg',
    'Return one report.',
  ].join('\n');
  const transformedDraft = [
    '[Image #1] [Image #2]Review these references:',
    '-',
    '-',
    'Return one report.',
  ].join('\n');
  const result = classifyClaudePostEnterOutcome({
    expectedText,
    capture: capture(transformedDraft, {
      images: 2,
      imagePaths: [
        { id: 1, availability: 'available' },
        { id: 2, availability: 'available' },
      ],
    }),
    transcriptRead: { success: true, userRecordCount: 0 },
  });

  assert.equal(result.final, true);
  assert.equal(result.semanticStatus, 'not-submitted');
  assert.equal(result.composerDraftState, 'exact-provider-image-transform');
  assert.equal(result.providerImageTransform, true);
  assert.equal(result.expectedImagePathCount, 2);
  assert.equal(result.capturedImageCount, 2);
  assert.equal(result.draftPreserved, true);
});

test('extra or changed Claude images cannot manufacture exact draft proof', () => {
  const expectedText = 'Review:\n- /tmp/first.png\nDone';
  const result = classifyClaudePostEnterOutcome({
    expectedText,
    capture: capture('[Image #1] [Image #2]Review:\n-\nDone', { images: 2 }),
    transcriptRead: { success: true, userRecordCount: 0 },
  });

  assert.equal(result.final, false);
  assert.equal(result.semanticStatus, 'unknown');
  assert.equal(result.composerDraftState, 'mixed-or-image-draft');
});

test('unresolved Claude image refs cannot terminalize the delivery proof', () => {
  const expectedText = 'Review:\n- /tmp/first.png\nDone';
  const result = classifyClaudePostEnterOutcome({
    expectedText,
    capture: capture('[Image #1]Review:\n-\nDone', { images: 1, imagePaths: [] }),
    transcriptRead: { success: true, userRecordCount: 0 },
  });

  assert.equal(result.final, false);
  assert.equal(result.semanticStatus, 'unknown');
  assert.equal(result.composerDraftState, 'mixed-or-image-draft');
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
