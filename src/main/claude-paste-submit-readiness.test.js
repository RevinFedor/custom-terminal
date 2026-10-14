'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyClaudePasteReadyFrame,
  expectedClaudePasteShape,
  planClaudePostEnterRetry,
} = require('./claude-paste-submit-readiness');

function frame(lines, generation = 3, cursorRow = 12) {
  return {
    success: true,
    authoritativeFrameCommitted: true,
    liveSynchronizedOutputOpen: false,
    synchronizedOutputOpen: false,
    writeSeq: generation + 10,
    flushedSeq: generation + 10,
    committedFrameGeneration: generation,
    baseY: 0,
    cursorY: cursorRow,
    lines: lines.map((text, row) => ({ row, text })),
  };
}

const base = {
  baselineCommittedFrameGeneration: 1,
  identityCurrent: true,
  expectedHasText: true,
  expectedImageCount: 0,
};

test('Claude paste readiness waits through Pasting and the temporary empty composer', () => {
  const pasting = frame([
    '', '', '', '', '', '', '', '', '', '',
    '❯ ',
    '',
    'Pasting…',
  ]);
  assert.equal(classifyClaudePasteReadyFrame({ ...base, snapshot: pasting }).reason, 'claude-still-pasting');

  const empty = frame([
    '', '', '', '', '', '', '', '', '', '',
    '❯ ',
    '',
    '',
  ]);
  assert.equal(classifyClaudePasteReadyFrame({ ...base, snapshot: empty }).reason, 'final-text-carrier-pending');
});

test('Claude paste readiness accepts inline, collapsed, image-first and image-only final forms', () => {
  const inline = frame([
    '', '', '', '', '', '', '', '', '', '',
    '❯    leading spaces stay inside the draft',
    '',
    '',
  ], 4, 10);
  assert.equal(classifyClaudePasteReadyFrame({ ...base, snapshot: inline }).form, 'inline-text');

  const collapsed = frame([
    '', '', '', '', '', '', '', '', '', '',
    '❯ [Pasted text #5 +36 lines]',
    '',
    'paste again to expand',
  ], 4, 10);
  assert.equal(classifyClaudePasteReadyFrame({ ...base, snapshot: collapsed }).form, 'collapsed-paste');

  const imagesAndPaste = frame([
    '', '', '', '', '', '', '', '', '', '',
    '❯ [Image #1] [Image #2] [Pasted text',
    '  #3 +36 lines]',
    '',
    'paste again to expand',
  ], 4, 11);
  const mixed = classifyClaudePasteReadyFrame({
    ...base,
    snapshot: imagesAndPaste,
    expectedImageCount: 2,
  });
  assert.equal(mixed.form, 'images-and-collapsed-paste');
  assert.equal(mixed.observedImageCount, 2);

  const imagesOnly = frame([
    '', '', '', '', '', '', '', '', '', '',
    '❯ [Image #1] [Image #2]',
    '',
    '',
  ], 4, 10);
  assert.equal(classifyClaudePasteReadyFrame({
    ...base,
    snapshot: imagesOnly,
    expectedHasText: false,
    expectedImageCount: 2,
  }).form, 'images-only');
});

test('unknown or incomplete final forms fail closed instead of guessing', () => {
  assert.equal(classifyClaudePasteReadyFrame({
    ...base,
    snapshot: frame(['', '', '❯ [Pasted text #4 +20 lines', ''], 4, 2),
  }).action, 'wait');
  assert.equal(classifyClaudePasteReadyFrame({
    ...base,
    snapshot: frame(['', '', 'unrelated clipped row', ''], 4, 2),
  }).reason, 'active-prompt-not-found');
  assert.equal(classifyClaudePasteReadyFrame({
    ...base,
    snapshot: frame(['', '', '❯ text', ''], 4, 2),
    identityCurrent: false,
  }).action, 'cancel');
});

test('expected shape preserves text whitespace and treats images separately', () => {
  const shape = expectedClaudePasteShape('   alpha\n- /tmp/a.png\n\tbeta', {
    imagePaths: [{ id: 1, path: '/tmp/a.png' }],
  });
  assert.equal(shape.expectedImageCount, 1);
  assert.equal(shape.expectedHasText, true);
  assert.equal(shape.transportLength, '   alpha\n- /tmp/a.png\n\tbeta'.length);
});

test('image references may stay text or collapse with the entire prompt, without native image chips', () => {
  const imagePath = '/Users/example/Library/Application Support/noted-terminal/prompt-queue-assets/8a68.png';
  const payload = '[imagePath: ' + imagePath + ']\n  explain this camera setting';
  const shape = expectedClaudePasteShape(payload, { imagePaths: [{ id: 1, path: imagePath }] });
  for (const text of [
    '❯ [imagePath: ' + imagePath + '] explain this camera setting',
    '❯ [Pasted text #1 +36 lines]',
    '❯ [Pasted content #2 +530 chars]',
    '❯ [Pasted content #3, 36 lines, 2 images]',
  ]) {
    const result = classifyClaudePasteReadyFrame({ ...base, ...shape, snapshot: frame(['', text], 4, 1) });
    assert.equal(result.action, 'ready', text);
    assert.equal(result.observedImageCount, 0);
  }
});

test('image-only paths can be rendered as text, a paste chip, or a native image', () => {
  const path = '/tmp/a.png';
  for (const payload of [path, '[imagePath: ' + path + ']']) {
    const shape = expectedClaudePasteShape(payload, { imagePaths: [{ id: 1, path }] });
    assert.equal(shape.expectedHasText, false, 'an image transport token is not required prose');
    for (const text of ['❯ ' + payload, '❯ [Pasted text #1 +1 lines]', '❯ [Image #1]']) {
      assert.equal(classifyClaudePasteReadyFrame({ ...base, ...shape, snapshot: frame(['', text], 4, 1) }).action, 'ready');
    }
  }
});

test('representation tolerance does not admit Pasting, empty, stale, or incomplete native-only attachments', () => {
  const expected = { ...base, expectedHasText: false, expectedImageCount: 2 };
  assert.equal(classifyClaudePasteReadyFrame({ ...expected, snapshot: frame(['❯ [Image #1]'], 4, 0) }).reason, 'expected-image-chips-pending');
  assert.equal(classifyClaudePasteReadyFrame({ ...expected, snapshot: frame(['❯ [Pasted text #1 +30 lines]', 'Pasting…'], 4, 0) }).reason, 'claude-still-pasting');
  assert.equal(classifyClaudePasteReadyFrame({ ...expected, snapshot: frame(['❯ /tmp/a.png'], 1, 0) }).reason, 'post-paste-frame-required');
  assert.equal(classifyClaudePasteReadyFrame({ ...expected, snapshot: frame(['❯ /tmp/a.png'], 4, 0), identityCurrent: false }).action, 'cancel');
});

test('one retry is allowed only for the same owned draft and no provider user turn', () => {
  const pasteReadyProof = {
    ready: true,
    inputRevision: 8,
    terminalRunSeq: 1,
    terminalLifecycleGeneration: 'life-a',
    mirrorGeneration: 'mirror-a',
    expectedImageCount: 4,
  };
  const capture = {
    success: true,
    editorReturnReady: true,
    terminalIdentityStable: true,
    inputRevision: 9,
    terminalRunSeq: 1,
    terminalLifecycleGeneration: 'life-a',
    mirrorGeneration: 'mirror-a',
    text: '[Image #1] [Image #2] [Image #3] [Image #4]transformed provider draft',
    images: 4,
  };
  assert.equal(planClaudePostEnterRetry({
    pasteReadyProof,
    capture,
    transcriptRead: { success: true, userRecordCount: 0 },
  }).action, 'retry-enter');
  assert.equal(planClaudePostEnterRetry({
    pasteReadyProof,
    capture: { ...capture, inputRevision: 10 },
    transcriptRead: { success: true, userRecordCount: 0 },
  }).reason, 'foreign-input-after-enter');
  assert.equal(planClaudePostEnterRetry({
    pasteReadyProof,
    capture,
    transcriptRead: { success: true, userRecordCount: 1 },
  }).reason, 'provider-user-turn-not-excluded');
  assert.equal(planClaudePostEnterRetry({
    pasteReadyProof,
    capture,
    transcriptRead: { success: true, userRecordCount: 0 },
    enterRetryCount: 1,
  }).reason, 'enter-retry-already-used');
});
