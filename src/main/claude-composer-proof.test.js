'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyClaudeMissingPromptExactCaptureAdmission,
  parseClaudeComposerCurrentFrame,
  reserveClaudeExactEmptyEvidence,
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
  assert.equal(proof.exactCaptureRecommended, undefined);
});

function currentClosedHeadlessFrame(overrides = {}) {
  return {
    ...snapshot([
      'assistant response',
      'status text',
      '',
    ], { cursorY: 2, cursorX: 1 }),
    mirrorGeneration: 'mirror-a',
    writeSeq: 19,
    flushedSeq: 19,
    synchronizedOutputOpen: false,
    authoritativeFrameCommitted: true,
    ...overrides,
  };
}

function missingActivePromptProof(frame = currentClosedHeadlessFrame()) {
  const proof = parseClaudeComposerCurrentFrame(frame);
  assert.equal(proof.proofOutcome, 'unknown');
  assert.equal(proof.proofReason, 'active-prompt-not-found');
  assert.equal(proof.exactCaptureRecommended, undefined);
  return proof;
}

test('admits exact capture for a current closed idle headless frame with no active prompt', () => {
  const frame = currentClosedHeadlessFrame();
  assert.deepEqual(classifyClaudeMissingPromptExactCaptureAdmission({
    proof: missingActivePromptProof(frame),
    snapshot: frame,
    startupGateReady: true,
  }), {
    recommended: true,
    reason: 'closed-idle-frame-exact-copy',
  });
});

test('rejects exact capture while Claude lifecycle or PTY ownership is not idle', () => {
  const frame = currentClosedHeadlessFrame();
  const proof = missingActivePromptProof(frame);
  const cases = [
    ['busy turn', { turnBusy: true }, 'claude-turn-busy'],
    ['local command', { localCommandActive: true }, 'claude-local-command-active'],
    ['compact', { compactActive: true }, 'claude-compact-active'],
    ['awaiting question', { awaitingInput: true }, 'claude-question-active'],
    ['stopping', { stopping: true }, 'claude-stopping'],
    ['rewind', { rewindActive: true }, 'claude-rewind-active'],
    ['active PTY write', { writeOperationActive: true }, 'claude-pty-write-active'],
    ['queued PTY write', { writeOperationActive: true }, 'claude-pty-write-active'],
    ['startup gate not ready', { startupGateReady: false }, 'claude-startup-gate-not-ready'],
    ['control surface', { controlSurfaceActive: true }, 'claude-control-surface-active'],
  ];

  for (const [label, overrides, reason] of cases) {
    assert.deepEqual(classifyClaudeMissingPromptExactCaptureAdmission({
      proof,
      snapshot: frame,
      startupGateReady: true,
      ...overrides,
    }), { recommended: false, reason }, label);
  }
});

test('rejects exact capture without a current closed authoritative headless frame', () => {
  const proof = missingActivePromptProof();
  const cases = [
    ['renderer frame', { source: 'renderer' }],
    ['open frame', { synchronizedOutputOpen: true }],
    ['committed replay while a newer frame is open', {
      committedFrameReplay: true,
      liveSynchronizedOutputOpen: true,
    }],
    ['unflushed frame', { writeSeq: 20, flushedSeq: 19 }],
    ['non-authoritative frame', { authoritativeFrameCommitted: false }],
    ['frame without a mirror generation', { mirrorGeneration: null }],
  ];

  for (const [label, frameOverrides] of cases) {
    assert.deepEqual(classifyClaudeMissingPromptExactCaptureAdmission({
      proof,
      snapshot: currentClosedHeadlessFrame(frameOverrides),
      startupGateReady: true,
    }), {
      recommended: false,
      reason: 'current-closed-headless-frame-required',
    }, label);
  }
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

test('exact empty capture can cross only the revision reserved by the same paste', () => {
  const evidence = {
    success: true,
    text: '',
    images: 0,
    proofOutcome: 'absent',
    terminalIdentityStable: true,
    editorReturnReady: true,
    inputRevision: 7,
    terminalRunSeq: 3,
    terminalLifecycleGeneration: 'pty-a:3',
    mirrorGeneration: 'mirror-a',
  };
  const reserved = reserveClaudeExactEmptyEvidence({
    evidence,
    currentInputRevision: 7,
    reservedInputRevision: 8,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
  });
  assert.equal(reserved.inputRevision, 8);
  assert.equal(evidence.inputRevision, 7, 'the caller-owned capture stays immutable');

  for (const stale of [
    { currentInputRevision: 8, reservedInputRevision: 9 },
    { currentRunSeq: 4 },
    { currentLifecycleGeneration: 'pty-a:4' },
    { currentMirrorGeneration: 'mirror-b' },
    { reservedInputRevision: 9 },
  ]) {
    assert.equal(reserveClaudeExactEmptyEvidence({
      evidence,
      currentInputRevision: 7,
      reservedInputRevision: 8,
      currentRunSeq: 3,
      currentLifecycleGeneration: 'pty-a:3',
      currentMirrorGeneration: 'mirror-a',
      ...stale,
    }), null);
  }
  assert.equal(reserveClaudeExactEmptyEvidence({
    evidence: { ...evidence, text: 'real draft', proofOutcome: 'found' },
    currentInputRevision: 7,
    reservedInputRevision: 8,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
  }), null);
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
