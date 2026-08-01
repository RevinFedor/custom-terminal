'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseClaudeComposerCurrentFrame,
  validateClaudeComposerSubmitGeneration,
  validateClaudeComposerWriteBoundary,
} = require('./claude-composer-proof');

function snapshot(lines, { baseY = 100, cursorY = 3, cursorX = 8 } = {}) {
  return {
    source: 'headless-main',
    baseY,
    cursorY,
    cursorX,
    lines: lines.map((value, index) => ({
      row: baseY + index,
      ...(typeof value === 'string'
        ? { text: value, wrapped: false, occupiedEndX: value.trimEnd().length }
        : {
            ...value,
            occupiedEndX: value.occupiedEndX ?? String(value.text || '').trimEnd().length,
          }),
    })),
  };
}

test('proves an empty Claude composer only when the prompt owns the cursor', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    'old answer',
    '────────────',
    { text: '❯ Try "write a test"', wrapped: false, promptSuffixAllDim: true },
    '',
  ], { cursorY: 2, cursorX: 3 }));
  assert.equal(proof.proofOutcome, 'absent');
  assert.equal(proof.hasDraft, false);
});

test('proves text in the current Claude composer', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    'old answer',
    '────────────',
    '❯ hello from composer',
    { text: 'continued line', wrapped: true },
  ], { cursorX: 14 }));
  assert.equal(proof.proofOutcome, 'found');
  assert.equal(proof.hasDraft, true);
  assert.equal(proof.text, 'hello from composer\ncontinued line');
});

test('text beyond the cursor is ambiguous and asks for an exact Claude read', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    'old answer',
    '────────────',
    '❯ actual draft text',
    '',
  ], { cursorY: 2, cursorX: 4 }));
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.hasDraft, null);
  assert.equal(proof.proofReason, 'composer-content-after-cursor');
  assert.equal(proof.exactCaptureRecommended, true);
});

test('does not treat real user text shaped like the placeholder as empty', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    'old answer',
    '────────────',
    { text: '❯ Try "write a test"', wrapped: false, promptSuffixAllDim: false },
    '',
  ], { cursorY: 2, cursorX: 20 }));
  assert.equal(proof.proofOutcome, 'found');
  assert.equal(proof.text, 'Try "write a test"');
});

test('plain response rows cannot connect an old prompt to the current cursor', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    '❯ stale old user text',
    'assistant response without a known separator',
    'another response line',
    'status text',
  ], { cursorY: 3, cursorX: 4 }));
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.hasDraft, null);
});

test('does not mistake an old prompt row in the viewport for a live draft', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    '❯ stale text from an earlier frame',
    '✻ Worked for 42s',
    'assistant answer',
    'status',
  ], { cursorX: 3 }));
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.hasDraft, null);
  assert.match(proof.proofReason, /active-prompt-not-found|surface/);
});

test('returns unknown when cursor geometry is unavailable', () => {
  const proof = parseClaudeComposerCurrentFrame({
    source: 'renderer',
    lines: [{ row: 1, text: '❯ stale text' }],
  });
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.hasDraft, null);
});

function emptyWriteProof(overrides = {}) {
  return {
    proofOutcome: 'absent',
    hasDraft: false,
    source: 'headless-main:claude-composer:empty-cursor-row-12',
    inputRevision: 7,
    terminalRunSeq: 3,
    terminalLifecycleGeneration: 'pty-a:3',
    mirrorGeneration: 'mirror-a',
    mirrorWriteSeq: 19,
    mirrorFlushedSeq: 19,
    mirrorSynchronizedOutputOpen: false,
    ...overrides,
  };
}

test('accepts an empty proof only at the unchanged physical write boundary', () => {
  const decision = validateClaudeComposerWriteBoundary({
    proof: emptyWriteProof(),
    terminalMatches: true,
    currentInputRevision: 7,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
    currentMirrorWriteSeq: 19,
    currentMirrorFlushedSeq: 19,
    currentMirrorSynchronizedOutputOpen: false,
  });
  assert.deepEqual(decision, { valid: true, reason: 'claude_current_composer_empty' });
});

test('rejects user input and process/mirror changes between probe and paste', () => {
  const base = {
    proof: emptyWriteProof(),
    terminalMatches: true,
    currentInputRevision: 7,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
    currentMirrorWriteSeq: 19,
    currentMirrorFlushedSeq: 19,
    currentMirrorSynchronizedOutputOpen: false,
  };
  assert.equal(validateClaudeComposerWriteBoundary({ ...base, currentInputRevision: 8 }).valid, false);
  assert.equal(validateClaudeComposerWriteBoundary({ ...base, currentRunSeq: 4 }).valid, false);
  assert.equal(validateClaudeComposerWriteBoundary({ ...base, currentLifecycleGeneration: 'pty-a:4' }).valid, false);
  assert.equal(validateClaudeComposerWriteBoundary({ ...base, currentMirrorGeneration: 'mirror-b' }).valid, false);
  assert.deepEqual(
    validateClaudeComposerWriteBoundary({
      ...base,
      currentMirrorSynchronizedOutputOpen: true,
    }),
    { valid: false, reason: 'claude_headless_frame_open' },
  );
  assert.deepEqual(
    validateClaudeComposerWriteBoundary({
      ...base,
      proof: emptyWriteProof({ mirrorSynchronizedOutputOpen: true }),
    }),
    { valid: false, reason: 'claude_headless_frame_open' },
  );
});

test('renderer or unresolved proof never authorizes a background paste', () => {
  const base = {
    terminalMatches: true,
    currentInputRevision: 7,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
    currentMirrorWriteSeq: 19,
    currentMirrorFlushedSeq: 19,
  };
  assert.equal(validateClaudeComposerWriteBoundary({
    ...base,
    proof: emptyWriteProof({ source: 'renderer:claude-composer:empty-cursor-row-12' }),
  }).valid, false);
  assert.equal(validateClaudeComposerWriteBoundary({
    ...base,
    proof: emptyWriteProof({ proofOutcome: 'unknown', hasDraft: null }),
  }).valid, false);
});

test('submit generation may advance mirror bytes but not input or process identity', () => {
  const base = {
    proof: emptyWriteProof(),
    terminalMatches: true,
    currentInputRevision: 7,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
  };
  assert.deepEqual(validateClaudeComposerSubmitGeneration(base), {
    valid: true,
    reason: 'claude_submit_generation_unchanged',
  });
  assert.equal(validateClaudeComposerSubmitGeneration({ ...base, currentInputRevision: 8 }).valid, false);
  assert.equal(validateClaudeComposerSubmitGeneration({ ...base, currentRunSeq: 4 }).valid, false);
  assert.equal(validateClaudeComposerSubmitGeneration({
    ...base,
    currentLifecycleGeneration: 'pty-a:4',
  }).valid, false);
  assert.equal(validateClaudeComposerSubmitGeneration({
    ...base,
    currentMirrorGeneration: 'mirror-b',
  }).valid, false);
});
