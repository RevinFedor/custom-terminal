'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyClaudeMissingPromptExactCaptureAdmission,
  parseClaudeComposerCurrentFrame,
  reserveClaudeExactEmptyEvidence,
  resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence,
  summarizeClaudePromptSuffixStyle,
  validateClaudeComposerSubmitGeneration,
  validateClaudeComposerWriteBoundary,
} = require('./claude-composer-proof');

test('summarizes only semantic xterm attributes for a Claude prompt suffix', () => {
  assert.deepEqual(summarizeClaudePromptSuffixStyle([
    { ch: ' ', dim: false, inverse: false, nonDefaultBg: false },
    { ch: 'g', dim: true, inverse: false, nonDefaultBg: false },
    { ch: 'h', dim: true, inverse: false, nonDefaultBg: false },
  ]), {
    allDim: true,
    hasInverse: false,
    hasNonDefaultBg: false,
  });
  assert.deepEqual(summarizeClaudePromptSuffixStyle([
    { ch: 'g', dim: true, inverse: false, nonDefaultBg: false },
    { ch: 'h', dim: true, inverse: true, nonDefaultBg: true },
  ]), {
    allDim: true,
    hasInverse: true,
    hasNonDefaultBg: true,
  });
});

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

test('proves an arbitrary Claude dim ghost suggestion is not a user draft', () => {
  const proof = parseClaudeComposerCurrentFrame(snapshot([
    'old answer',
    '────────────',
    {
      text: '❯ останови процесс потом архивируй',
      wrapped: false,
      promptSuffixAllDim: true,
      promptSuffixHasInverse: false,
      promptSuffixHasNonDefaultBg: false,
      promptSuffixWrapped: false,
    },
    '',
  ], { cursorY: 2, cursorX: 2 }));
  assert.equal(proof.proofOutcome, 'absent');
  assert.equal(proof.hasDraft, false);
  assert.equal(proof.proofReason, 'current-composer-dim-ghost-suggestion');
});

test('keeps non-dim, mixed, modal, and displaced-cursor suffixes ambiguous', () => {
  const cases = [
    ['normal text', {
      promptSuffixAllDim: false,
      promptSuffixHasInverse: false,
      promptSuffixHasNonDefaultBg: false,
      promptSuffixWrapped: false,
    }, 2],
    ['inverse surface', {
      promptSuffixAllDim: true,
      promptSuffixHasInverse: true,
      promptSuffixHasNonDefaultBg: false,
      promptSuffixWrapped: false,
    }, 2],
    ['background surface', {
      promptSuffixAllDim: true,
      promptSuffixHasInverse: false,
      promptSuffixHasNonDefaultBg: true,
      promptSuffixWrapped: false,
    }, 2],
    ['cursor inside text', {
      promptSuffixAllDim: true,
      promptSuffixHasInverse: false,
      promptSuffixHasNonDefaultBg: false,
      promptSuffixWrapped: false,
    }, 5],
    ['wrapped suffix', {
      promptSuffixAllDim: true,
      promptSuffixHasInverse: false,
      promptSuffixHasNonDefaultBg: false,
      promptSuffixWrapped: true,
    }, 2],
  ];

  for (const [label, style, cursorX] of cases) {
    const proof = parseClaudeComposerCurrentFrame(snapshot([
      'old answer',
      '────────────',
      {
        text: '❯ пользовательский текст',
        wrapped: false,
        ...style,
      },
      '',
    ], { cursorY: 2, cursorX }));
    assert.equal(proof.proofOutcome, 'unknown', label);
    assert.equal(proof.proofReason, 'composer-content-after-cursor', label);
    assert.equal(proof.exactCaptureRecommended, true, label);
  }
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

function reservedExactEmptyEvidence(overrides = {}) {
  return {
    success: true,
    proofOutcome: 'absent',
    hasDraft: false,
    text: '',
    images: 0,
    terminalIdentityStable: true,
    editorReturnReady: true,
    inputRevision: 8,
    terminalRunSeq: 3,
    terminalLifecycleGeneration: 'pty-a:3',
    mirrorGeneration: 'mirror-a',
    // This is the closed capture frame before Ctrl+G returned to Claude. The
    // fresh write-boundary frame below is expected to be newer.
    mirrorWriteSeq: 19,
    mirrorFlushedSeq: 19,
    mirrorSynchronizedOutputOpen: false,
    synchronizedOutputGeneration: 4,
    source: 'headless-main:claude-composer:empty-exact-editor',
    ...overrides,
  };
}

function ambiguousCurrentWriteProof(overrides = {}) {
  return {
    success: true,
    proofOutcome: 'unknown',
    hasDraft: null,
    text: '',
    preview: '',
    source: 'headless-main:claude-composer:unknown:active-prompt-not-found',
    proofReason: 'active-prompt-not-found',
    exactCaptureBlockedReason: 'claude-pty-write-active',
    inputRevision: 8,
    terminalRunSeq: 3,
    terminalLifecycleGeneration: 'pty-a:3',
    mirrorGeneration: 'mirror-a',
    mirrorWriteSeq: 24,
    mirrorFlushedSeq: 24,
    mirrorSynchronizedOutputOpen: false,
    synchronizedOutputGeneration: 5,
    ...overrides,
  };
}

function reservedExactResolutionArgs(overrides = {}) {
  return {
    proof: ambiguousCurrentWriteProof(),
    evidence: reservedExactEmptyEvidence(),
    reservedEvidenceOwnedByCurrentOperation: true,
    terminalMatches: true,
    currentInputRevision: 8,
    currentRunSeq: 3,
    currentLifecycleGeneration: 'pty-a:3',
    currentMirrorGeneration: 'mirror-a',
    currentMirrorWriteSeq: 24,
    currentMirrorFlushedSeq: 24,
    currentMirrorSynchronizedOutputOpen: false,
    currentSynchronizedOutputGeneration: 5,
    startupGateReady: true,
    ...overrides,
  };
}

test('same queue-head evidence resolves found or unknown screen ambiguity without authorizing another capture', () => {
  const cases = [
    ['missing prompt blocked by our active write', ambiguousCurrentWriteProof({
      exactCaptureRecommended: undefined,
      exactCaptureBlockedReason: 'claude-pty-write-active',
    })],
    ['residual cells classified as a draft', ambiguousCurrentWriteProof({
      proofOutcome: 'found',
      hasDraft: true,
      text: 'stale residual cells',
      preview: 'stale residual cells',
      proofReason: 'current-composer-text',
      exactCaptureRecommended: false,
    })],
  ];

  for (const [label, proof] of cases) {
    const decision = resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence(
      reservedExactResolutionArgs({ proof }),
    );
    assert.equal(decision.valid, true, label);
    assert.equal(decision.reason, 'claude_current_composer_empty_from_reserved_exact_evidence');
    assert.equal(decision.proof.proofOutcome, 'absent');
    assert.equal(decision.proof.hasDraft, false);
    assert.equal(decision.proof.text, '');
    assert.equal(proof.proofOutcome, label.startsWith('residual') ? 'found' : 'unknown',
      'the fresh screen proof stays immutable');
  }
});

test('active queue-head write blocks a new Ctrl+G but may consume its own reserved evidence', () => {
  const frame = currentClosedHeadlessFrame();
  const captureAdmission = classifyClaudeMissingPromptExactCaptureAdmission({
    proof: missingActivePromptProof(frame),
    snapshot: frame,
    writeOperationActive: true,
    startupGateReady: true,
  });
  assert.deepEqual(captureAdmission, {
    recommended: false,
    reason: 'claude-pty-write-active',
  });

  const consumption = resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence(
    reservedExactResolutionArgs(),
  );
  assert.equal(consumption.valid, true);
  assert.equal(consumption.proof.proofOutcome, 'absent');
});

test('reserved exact-empty consumption rejects every stale physical identity coordinate', () => {
  const cases = [
    ['foreign queue operation', {
      reservedEvidenceOwnedByCurrentOperation: false,
    }, 'claude_reserved_exact_empty_evidence_not_owned'],
    ['replacement terminal', {
      terminalMatches: false,
    }, 'claude_terminal_replacement_active'],
    ['evidence input revision', {
      evidence: reservedExactEmptyEvidence({ inputRevision: 7 }),
    }, 'claude_input_ownership_changed'],
    ['fresh proof input revision', {
      proof: ambiguousCurrentWriteProof({ inputRevision: 7 }),
    }, 'claude_input_ownership_changed'],
    ['current input revision', {
      currentInputRevision: 9,
    }, 'claude_input_ownership_changed'],
    ['evidence run', {
      evidence: reservedExactEmptyEvidence({ terminalRunSeq: 2 }),
    }, 'claude_terminal_run_changed'],
    ['fresh proof run', {
      proof: ambiguousCurrentWriteProof({ terminalRunSeq: 2 }),
    }, 'claude_terminal_run_changed'],
    ['current run', {
      currentRunSeq: 4,
    }, 'claude_terminal_run_changed'],
    ['evidence lifecycle', {
      evidence: reservedExactEmptyEvidence({ terminalLifecycleGeneration: 'pty-a:2' }),
    }, 'claude_terminal_lifecycle_changed'],
    ['fresh proof lifecycle', {
      proof: ambiguousCurrentWriteProof({ terminalLifecycleGeneration: 'pty-a:2' }),
    }, 'claude_terminal_lifecycle_changed'],
    ['current lifecycle', {
      currentLifecycleGeneration: 'pty-a:4',
    }, 'claude_terminal_lifecycle_changed'],
    ['evidence mirror', {
      evidence: reservedExactEmptyEvidence({ mirrorGeneration: 'mirror-b' }),
    }, 'claude_headless_generation_changed'],
    ['fresh proof mirror', {
      proof: ambiguousCurrentWriteProof({ mirrorGeneration: 'mirror-b' }),
    }, 'claude_headless_generation_changed'],
    ['current mirror', {
      currentMirrorGeneration: 'mirror-b',
    }, 'claude_headless_generation_changed'],
  ];

  for (const [label, mutation, reason] of cases) {
    assert.deepEqual(
      resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence(
        reservedExactResolutionArgs(mutation),
      ),
      { valid: false, reason },
      label,
    );
  }
});

test('reserved exact-empty consumption requires closed flushed capture and current frames', () => {
  const cases = [
    ['capture frame open', {
      evidence: reservedExactEmptyEvidence({ mirrorSynchronizedOutputOpen: true }),
    }, 'claude_exact_empty_capture_frame_open'],
    ['capture frame unflushed', {
      evidence: reservedExactEmptyEvidence({ mirrorWriteSeq: 20 }),
    }, 'claude_exact_empty_capture_frame_unflushed'],
    ['capture frame generation unavailable', {
      evidence: reservedExactEmptyEvidence({ synchronizedOutputGeneration: null }),
    }, 'claude_exact_empty_capture_frame_unflushed'],
    ['fresh proof frame open', {
      proof: ambiguousCurrentWriteProof({ mirrorSynchronizedOutputOpen: true }),
    }, 'claude_headless_frame_open'],
    ['current frame open', {
      currentMirrorSynchronizedOutputOpen: true,
    }, 'claude_headless_frame_open'],
    ['fresh proof frame unflushed', {
      proof: ambiguousCurrentWriteProof({ mirrorFlushedSeq: 23 }),
    }, 'claude_headless_frame_not_flushed'],
    ['current frame unflushed', {
      currentMirrorFlushedSeq: 23,
    }, 'claude_headless_frame_not_flushed'],
    ['fresh proof is from an older closed frame', {
      proof: ambiguousCurrentWriteProof({ mirrorWriteSeq: 23, mirrorFlushedSeq: 23 }),
    }, 'claude_headless_frame_changed'],
    ['synchronized-output generation changed', {
      proof: ambiguousCurrentWriteProof({ synchronizedOutputGeneration: 4 }),
    }, 'claude_headless_frame_changed'],
  ];

  for (const [label, mutation, reason] of cases) {
    assert.deepEqual(
      resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence(
        reservedExactResolutionArgs(mutation),
      ),
      { valid: false, reason },
      label,
    );
  }
});

test('reserved exact-empty consumption fails closed for every unsafe Claude surface', () => {
  const cases = [
    ['busy turn', { turnBusy: true }, 'claude-turn-busy'],
    ['local command', { localCommandActive: true }, 'claude-local-command-active'],
    ['compact', { compactActive: true }, 'claude-compact-active'],
    ['question', { awaitingInput: true }, 'claude-question-active'],
    ['stopping', { stopping: true }, 'claude-stopping'],
    ['rewind control', { rewindActive: true }, 'claude-rewind-active'],
    ['startup not ready', { startupGateReady: false }, 'claude-startup-gate-not-ready'],
    ['picker', { pickerActive: true }, 'claude-picker-active'],
    ['control surface', { controlSurfaceActive: true }, 'claude-control-surface-active'],
    ['replacement in progress', { replacementActive: true }, 'claude_terminal_replacement_active'],
  ];

  for (const [label, mutation, reason] of cases) {
    assert.deepEqual(
      resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence(
        reservedExactResolutionArgs(mutation),
      ),
      { valid: false, reason },
      label,
    );
  }
});

test('unreserved, non-empty, or non-headless evidence cannot override the screen', () => {
  const cases = [
    ['failed evidence', {
      evidence: reservedExactEmptyEvidence({ success: false }),
    }, 'claude_reserved_exact_empty_evidence_required'],
    ['non-empty evidence', {
      evidence: reservedExactEmptyEvidence({ text: 'real draft', proofOutcome: 'found' }),
    }, 'claude_reserved_exact_empty_evidence_required'],
    ['unstable evidence', {
      evidence: reservedExactEmptyEvidence({ terminalIdentityStable: false }),
    }, 'claude_reserved_exact_empty_evidence_required'],
    ['editor return not proven', {
      evidence: reservedExactEmptyEvidence({ editorReturnReady: false }),
    }, 'claude_reserved_exact_empty_evidence_required'],
    ['already empty screen needs the normal validator', {
      proof: ambiguousCurrentWriteProof({ proofOutcome: 'absent', hasDraft: false }),
    }, 'claude_screen_ambiguity_required'],
    ['renderer screen', {
      proof: ambiguousCurrentWriteProof({ source: 'renderer:claude-composer:unknown' }),
    }, 'claude_headless_draft_proof_required'],
  ];

  for (const [label, mutation, reason] of cases) {
    assert.deepEqual(
      resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence(
        reservedExactResolutionArgs(mutation),
      ),
      { valid: false, reason },
      label,
    );
  }
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
