const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexDraftProofWaitTimeoutOutcome,
  enforceCodexInteractiveSurfaceDraftAuthority,
  getCodexDraftFrameBlocker,
  isExpectedStaleCodexDraftObservation,
  mergeCodexDraftAuthority,
  shouldFinishCodexDraftProofWait,
  shouldWaitForCodexDraftProof,
} = require('./codex-draft-authority');
const {
  validateCodexPickerRuntimeAdmission,
} = require('./codex-runtime-contract');

const admittedRuntime = {
  sameTerminal: true,
  expectedRunSeq: 3,
  currentRunSeq: 3,
  expectedInputRevision: 9,
  currentInputRevision: 9,
  processRunning: true,
  hasLiveCodexEvidence: true,
  tuiReady: true,
  stopping: false,
  turnBusy: false,
};

const frame = (writeSeq, generation = 'current-pty') => ({ generation, writeSeq });

test('only a safely discarded older same-generation observation is routine, not a full incident', () => {
  const main = { success: true, hasDraft: false, frameIdentity: frame(95) };
  const visual = { success: true, hasDraft: true, frameIdentity: frame(86) };
  const merged = mergeCodexDraftAuthority(main, visual, { mergeRendererPositive: true });
  assert.equal(isExpectedStaleCodexDraftObservation(main, visual, merged), true);
  for (const altered of [null, {}, { ...visual, frameIdentity: frame(95) },
    { ...visual, frameIdentity: frame(96) }, { ...visual, frameIdentity: frame(86, 'other-pty') },
    { ...visual, frameIdentity: undefined }, { ...visual, success: false }]) {
    assert.equal(isExpectedStaleCodexDraftObservation(main, altered, merged), false);
  }
  assert.equal(isExpectedStaleCodexDraftObservation({ ...main, success: false }, visual, merged), false);
  assert.equal(isExpectedStaleCodexDraftObservation({ ...main, hasDraft: null }, visual, merged), false);
  assert.equal(isExpectedStaleCodexDraftObservation(main, visual, { ...merged, hasDraft: true }), false);
  assert.equal(isExpectedStaleCodexDraftObservation(main, visual, { ...merged, success: false }), false);
  assert.equal(isExpectedStaleCodexDraftObservation(main, visual, main), false, 'no claim of a completed merge');
});

test('recorded stale More reasoning tail cannot override a newer committed empty composer', () => {
  const result = mergeCodexDraftAuthority(
    { success: true, hasDraft: false, source: 'headless-main:cursor:1016:dim-hint', frameIdentity: frame(42) },
    { success: true, hasDraft: true, preview: '5. More reasoning…   Max and Ultra consume usage limits',
      source: 'tail:1024', frameIdentity: frame(41) },
    { mergeRendererPositive: true },
  );
  assert.equal(result.hasDraft, false);
  assert.equal(result.rendererPositiveIgnored, 'renderer-frame-behind');
});

test('unscoped or replaced renderer frame cannot veto current main empty proof', () => {
  for (const frameIdentity of [undefined, frame(43, 'old-pty'), { generation: 'current-pty', writeSeq: null }]) {
    const result = mergeCodexDraftAuthority(
      { success: true, hasDraft: false, frameIdentity: frame(42), source: 'headless-main:cursor' },
      { success: true, hasDraft: true, frameIdentity, source: 'tail:1024', preview: 'old screen' },
      { mergeRendererPositive: true },
    );
    assert.equal(result.hasDraft, false);
  }
});

test('a real draft on the same or newer renderer frame remains protected, even when its text quotes a menu', () => {
  for (const writeSeq of [42, 43]) {
    const result = mergeCodexDraftAuthority(
      { success: true, hasDraft: false, frameIdentity: frame(42), source: 'headless-main:cursor' },
      { success: true, hasDraft: true, frameIdentity: frame(writeSeq), source: 'cursor:1016',
        preview: '5. More reasoning…   Max and Ultra consume usage limits' },
      { mergeRendererPositive: true },
    );
    assert.equal(result.hasDraft, true, 'never blacklist user text because it resembles a menu');
  }
});

test('Codex draft proof only reads a closed, flushed, post-resize frame', () => {
  assert.equal(getCodexDraftFrameBlocker(), 'frame-not-flushed');
  assert.equal(getCodexDraftFrameBlocker({
    synchronizedOutputOpen: true,
    writeSeq: 12,
    flushedSeq: 12,
  }), 'synchronized-output-open');
  assert.equal(getCodexDraftFrameBlocker({
    writeSeq: 12,
    flushedSeq: 11,
  }), 'frame-not-flushed');
  assert.equal(getCodexDraftFrameBlocker({
    writeSeq: 12,
    flushedSeq: 12,
    pendingResizeWriteSeq: 12,
  }), 'post-resize-frame-not-observed');
  assert.equal(getCodexDraftFrameBlocker({
    writeSeq: 13,
    flushedSeq: 13,
    pendingResizeWriteSeq: 12,
  }), null);
});

test('hidden renderer cannot turn authoritative headless empty into unknown', () => {
  const result = mergeCodexDraftAuthority(
    { success: true, hasDraft: false, source: 'headless-main:cursor' },
    { success: true, hasDraft: null, source: 'no-terminal' },
    { mergeRendererPositive: true },
  );

  assert.equal(result.hasDraft, false);
  assert.equal(result.source, 'headless-main:cursor');
});

test('fresh renderer positive conservatively overrides headless empty', () => {
  const result = mergeCodexDraftAuthority(
    { success: true, hasDraft: false, source: 'headless-main:cursor' },
    { success: true, hasDraft: true, preview: 'manual text', source: 'renderer-visible' },
    { mergeRendererPositive: true },
  );

  assert.equal(result.hasDraft, true);
  assert.equal(result.preview, 'manual text');
  assert.match(result.source, /renderer-positive:renderer-visible/);
  assert.equal(result.rendererPositive, true);
});

test('renderer negative cannot erase authoritative headless draft', () => {
  const result = mergeCodexDraftAuthority(
    { success: true, hasDraft: true, preview: 'draft', source: 'headless-main' },
    { success: true, hasDraft: false, source: 'renderer-visible' },
    { mergeRendererPositive: true },
  );

  assert.equal(result.hasDraft, true);
  assert.equal(result.preview, 'draft');
  assert.equal(result.source, 'headless-main');
});

test('renderer-only empty fails closed when headless state is unavailable', () => {
  const result = mergeCodexDraftAuthority(
    { success: false, hasDraft: null, error: 'flush-failed', source: 'headless-main' },
    { success: true, hasDraft: false, source: 'renderer-visible' },
    { mergeRendererPositive: true },
  );

  assert.equal(result.success, false);
  assert.equal(result.hasDraft, null);
  assert.equal(result.authority, 'unknown');
  assert.match(result.source, /renderer-negative-untrusted/);
});

test('renderer-only positive still blocks safely when headless state is unavailable', () => {
  const result = mergeCodexDraftAuthority(
    { success: false, hasDraft: null, error: 'flush-failed', source: 'headless-main' },
    { success: true, hasDraft: true, preview: 'manual text', source: 'renderer-visible' },
    { mergeRendererPositive: true },
  );

  assert.equal(result.success, true);
  assert.equal(result.hasDraft, true);
  assert.equal(result.authority, 'renderer-positive');
  assert.match(result.source, /^renderer-positive:/);
});

test('send waits only for an unknown frame and never waits away a real draft', () => {
  assert.equal(shouldWaitForCodexDraftProof({
    initialHasDraft: null,
    expected: false,
    waitOnUnknownOnly: true,
  }), true);
  assert.equal(shouldWaitForCodexDraftProof({
    initialHasDraft: true,
    expected: false,
    waitOnUnknownOnly: true,
  }), false);
  assert.equal(shouldWaitForCodexDraftProof({
    initialHasDraft: false,
    expected: true,
    waitOnUnknownOnly: false,
  }), true);

  assert.equal(shouldFinishCodexDraftProofWait({
    hasDraft: false,
    expected: false,
    waitOnUnknownOnly: true,
  }), true);
  assert.equal(shouldFinishCodexDraftProofWait({
    hasDraft: true,
    expected: false,
    waitOnUnknownOnly: true,
  }), true, 'a proven real draft must block immediately instead of waiting for timeout');
  assert.equal(shouldFinishCodexDraftProofWait({
    hasDraft: null,
    expected: false,
    waitOnUnknownOnly: true,
  }), false);
  assert.equal(shouldFinishCodexDraftProofWait({
    hasDraft: false,
    expected: true,
    waitOnUnknownOnly: false,
  }), false);
});

test('wait deadline is never evidence that the composer is empty', () => {
  const result = createCodexDraftProofWaitTimeoutOutcome({
    source: 'test-fault:codex-draft-unknown-once',
  });

  assert.deepEqual(result, {
    success: false,
    hasDraft: null,
    preview: '',
    source: 'test-fault:codex-draft-unknown-once:wait-timeout',
    error: 'codex-draft-proof-wait-timeout',
  });
});

test('fresh renderer positive blocks direct send and routes picker through draft preservation', () => {
  const draft = mergeCodexDraftAuthority(
    { success: true, hasDraft: false, source: 'headless-main' },
    { success: true, hasDraft: true, source: 'renderer-visible' },
    { mergeRendererPositive: true },
  );
  const admission = validateCodexPickerRuntimeAdmission({
    ...admittedRuntime,
    hasDraft: draft.hasDraft,
  });

  // safePasteAndSubmit requires exactly false before it writes the new prompt.
  assert.equal(draft.hasDraft === false, false);
  // The native picker intentionally remains available: it first stashes and
  // later restores the draft, preserving an existing product capability.
  assert.deepEqual(admission, {
    allowed: true,
    reason: null,
  });
});

test('hidden renderer plus headless empty reaches final picker admission and allows the write', () => {
  const draft = mergeCodexDraftAuthority(
    { success: true, hasDraft: false, source: 'headless-main' },
    { success: true, hasDraft: null, source: 'no-terminal' },
    { mergeRendererPositive: true },
  );
  const admission = validateCodexPickerRuntimeAdmission({
    ...admittedRuntime,
    hasDraft: draft.hasDraft,
  });

  assert.deepEqual(admission, {
    allowed: true,
    reason: null,
  });
});

for (const surface of [
  { nativeRewindProven: true, activePicker: false, source: 'native-rewind-overlay' },
  { nativeRewindProven: false, activePicker: true, source: 'active-picker' },
]) {
  test(surface.source + ' cannot become empty composer from a dim footer', () => {
    const result = enforceCodexInteractiveSurfaceDraftAuthority(
      {
        success: true,
        hasDraft: false,
        preview: 'q to quit  esc/← to edit prev  enter to edit message',
        source: 'headless-main:cursor:35:dim-hint',
      },
      surface,
    );

    assert.equal(result.success, true);
    assert.equal(result.hasDraft, null);
    assert.equal(result.authority, 'non-composer-interactive-surface');
    assert.match(result.source, new RegExp(surface.source));
  });
}

test('History submit cannot authorize PTY paste while native Rewind owns the screen', () => {
  const guardedHeadless = enforceCodexInteractiveSurfaceDraftAuthority(
    {
      success: true,
      hasDraft: false,
      preview: 'q to quit  esc/← to edit prev  enter to edit message',
      source: 'headless-main:cursor:35:dim-hint',
    },
    {
      nativeRewindProven: true,
    },
  );
  const merged = mergeCodexDraftAuthority(
    guardedHeadless,
    { success: true, hasDraft: false, source: 'renderer-hidden' },
    { mergeRendererPositive: true },
  );

  assert.equal(merged.success, false);
  assert.equal(merged.hasDraft, null);
  assert.equal(merged.hasDraft === false, false, 'strict send precondition remains closed');
});
