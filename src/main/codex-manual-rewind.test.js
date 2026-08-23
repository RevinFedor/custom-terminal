'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  advanceManualCodexRewindNavigation,
  advanceManualCodexRewindOwnedInputRevision,
  assessManualCodexEnterPreflightScreen,
  classifyManualCodexRewindRestoredCopy,
  classifyManualCodexRewindRestoredComposer,
  classifyManualCodexRewindControlInput,
  classifyManualCodexEnterFrame,
  decideManualCodexRewindEnterWrite,
  isPureCodexEscapeBurst,
  readManualCodexRewindSelectedText,
  resolveManualCodexRewindBoundary,
  shouldAwaitManualCodexEnterPreflight,
  shouldFlushManualCodexEnterPreflight,
} = require('./codex-manual-rewind');
const {
  hashCodexRewindTargetText,
} = require('./codex-rewind-target-proof');

function overlaySnapshot(selectedText = 'older prompt') {
  return {
    success: true,
    lines: [
      { row: 10, text: '        T R A N S C R I P T' },
      { row: 11, text: `› ${selectedText}` },
      { row: 12, text: '↑/↓ to scroll  pgup/pgdn to page  home/end to jump' },
      { row: 13, text: 'q to quit  esc/← to edit prev  → to edit next  enter to edit message' },
    ],
    codexActivePrompt: {
      row: 11,
      text: `› ${selectedText}`,
      hasInverse: true,
    },
  };
}

function sourceMessage(index, text) {
  return {
    uuid: `codex-user-source-${index + 1}`,
    sourceLine: index + 1,
    text,
    textHash: hashCodexRewindTargetText(text),
  };
}

test('only exact native Rewind controls may advance the action-owned input revision', () => {
  const frame = classifyManualCodexEnterFrame(overlaySnapshot('rewind target'));
  for (const data of ['\x1b[D', '\x1b[C', '\x1b[A', '\x1b[B', '\x1b[5~', '\x1b[6~', '\x1b[H', '\x1b[F']) {
    assert.equal(classifyManualCodexRewindControlInput({
      data,
      frame,
      candidateObserver: true,
    }).owned, true, data);
  }
  assert.deepEqual(classifyManualCodexRewindControlInput({
    data: '\r',
    frame,
    candidateObserver: true,
  }), {
    owned: true,
    kind: 'confirm',
    reason: 'rewind-confirm-control',
  });
  assert.deepEqual(classifyManualCodexRewindControlInput({
    data: '\r',
    frame: classifyManualCodexEnterFrame({ success: false }),
    framePending: true,
    candidateObserver: true,
  }), {
    owned: true,
    kind: 'confirm-pending',
    reason: 'rewind-confirm-frame-pending',
  }, 'a pending mirror defers Enter classification to the fail-closed async preflight');
  assert.deepEqual(classifyManualCodexRewindControlInput({
    data: '\r',
    frame: { kind: 'ordinary-enter', possibleRewind: true },
    candidateObserver: true,
  }), {
    owned: true,
    kind: 'confirm-pending',
    reason: 'rewind-confirm-frame-pending',
  }, 'strong partial native chrome keeps the Enter revision inside the Rewind action');
  assert.equal(classifyManualCodexRewindControlInput({
    data: '\r',
    frame: classifyManualCodexEnterFrame({ success: true, lines: [] }),
    candidateObserver: true,
  }).owned, false, 'a settled ordinary frame does not borrow the Rewind lease');
  assert.equal(classifyManualCodexRewindControlInput({
    data: '\x1b',
    frame: classifyManualCodexEnterFrame({ success: true, lines: [] }),
    escapePrimeAllowed: true,
    candidateObserver: true,
  }).owned, true, 'the second Escape owns the pre-overlay transition');
  assert.equal(classifyManualCodexRewindControlInput({
    data: '\x1b',
    frame: classifyManualCodexEnterFrame({ success: true, lines: [] }),
    candidateObserver: true,
  }).owned, false, 'Escape during an unproven or busy context cannot borrow the old lease');
  for (const data of ['typed text', 'q', '\x03', '\t', '\x1b[Z']) {
    assert.equal(classifyManualCodexRewindControlInput({
      data,
      frame,
      candidateObserver: true,
    }).owned, false, data);
  }
  assert.equal(classifyManualCodexRewindControlInput({
    data: '\x1b[D',
    frame,
    candidateObserver: false,
  }).owned, false, 'an overlay-like key without the main observer is ordinary input');
  assert.equal(classifyManualCodexRewindControlInput({
    data: '\x1b[D',
    frame: classifyManualCodexEnterFrame({ success: true, lines: [] }),
    candidateObserver: true,
  }).owned, false, 'navigation outside the exact picker cannot borrow the lease');
});

test('native Rewind input ownership advances only across a contiguous revision chain', () => {
  assert.deepEqual(advanceManualCodexRewindOwnedInputRevision({
    previousOwnedRevision: 8,
    inputRevisionBefore: 7,
    inputRevisionAfter: 8,
    ownedControlCount: 0,
    controlKind: 'navigation',
  }), {
    allowed: true,
    reason: 'rewind-authority-created-by-control',
    ownedInputRevision: 8,
    ownedControlCount: 1,
  });
  assert.equal(advanceManualCodexRewindOwnedInputRevision({
    previousOwnedRevision: 8,
    inputRevisionBefore: 8,
    inputRevisionAfter: 9,
    ownedControlCount: 1,
    controlKind: 'navigation',
  }).allowed, true);
  assert.equal(advanceManualCodexRewindOwnedInputRevision({
    previousOwnedRevision: 8,
    inputRevisionBefore: 9,
    inputRevisionAfter: 10,
    ownedControlCount: 1,
    controlKind: 'navigation',
  }).reason, 'rewind-input-revision-gap', 'an unseen foreign bump cannot be hidden');
  assert.equal(advanceManualCodexRewindOwnedInputRevision({
    previousOwnedRevision: 9,
    inputRevisionBefore: 9,
    inputRevisionAfter: 9,
    ownedControlCount: 2,
    controlKind: 'confirm-pending',
  }).allowed, true, 'a queued confirming Enter may advance only at its later write boundary');
  assert.equal(advanceManualCodexRewindOwnedInputRevision({
    previousOwnedRevision: 9,
    inputRevisionBefore: 9,
    inputRevisionAfter: 9,
    ownedControlCount: 2,
    controlKind: 'navigation',
  }).allowed, false, 'non-confirming controls cannot claim a missing revision');
});

test('physical Enter is classified as native Rewind only for a proven headless overlay', () => {
  assert.deepEqual(
    classifyManualCodexEnterFrame(overlaySnapshot('rewind target')),
    {
      kind: 'native-rewind-confirm',
      proven: true,
      selectedText: 'rewind target',
      selectedRow: 11,
      reason: 'headless-transcript-active-prompt',
    },
  );

  const ordinaryComposer = overlaySnapshot('normal prompt');
  ordinaryComposer.lines = [{ row: 11, text: '› normal prompt' }];
  assert.equal(classifyManualCodexEnterFrame(ordinaryComposer).kind, 'ordinary-enter');

  const historicalTextWithoutActiveSelection = overlaySnapshot('quoted old prompt');
  historicalTextWithoutActiveSelection.codexActivePrompt = null;
  assert.equal(
    classifyManualCodexEnterFrame(historicalTextWithoutActiveSelection).kind,
    'ordinary-enter',
    'transcript words in scrollback do not turn an ordinary Enter into Rewind',
  );

  const transcriptWordInOrdinaryComposer = overlaySnapshot('old prompt reused as draft');
  transcriptWordInOrdinaryComposer.lines = [
    { row: 9, text: 'The assistant response mentions TRANSCRIPT and enter to edit message.' },
    { row: 11, text: '› old prompt reused as draft' },
  ];
  assert.equal(
    classifyManualCodexEnterFrame(transcriptWordInOrdinaryComposer).kind,
    'ordinary-enter',
    'ordinary inverse composer plus transcript words in scrollback is never a Rewind frame',
  );

  const footerWithoutTitle = overlaySnapshot('old prompt reused as draft');
  footerWithoutTitle.lines = footerWithoutTitle.lines.slice(1);
  assert.equal(
    classifyManualCodexEnterFrame(footerWithoutTitle).kind,
    'ordinary-enter',
    'the exact footer without the separate transcript title is insufficient',
  );

  const titleImmediatelyAboveViewport = structuredClone(footerWithoutTitle);
  titleImmediatelyAboveViewport.viewportY = 10;
  titleImmediatelyAboveViewport.cols = 57;
  titleImmediatelyAboveViewport.preViewportLines = [
    { row: 9, text: '/ T R A N S C R I P T / / / / / /' },
  ];
  assert.equal(
    classifyManualCodexEnterFrame(titleImmediatelyAboveViewport).kind,
    'native-rewind-confirm',
    'same-frame transcript title in the headless viewport guard completes the proof',
  );

  const exactNarrowFrame = structuredClone(titleImmediatelyAboveViewport);
  exactNarrowFrame.lines[2] = {
    row: 13,
    text: 'q to quit esc/← to edit prev → to edit next enter',
    occupiedEndX: 51,
  };
  assert.equal(
    classifyManualCodexEnterFrame(exactNarrowFrame).kind,
    'native-rewind-confirm',
    'the exact right-edge-clipped footer used by Codex at 57 columns is responsive chrome',
  );

  const narrowFooterAwayFromRightEdge = structuredClone(exactNarrowFrame);
  narrowFooterAwayFromRightEdge.lines[2].occupiedEndX = 30;
  assert.equal(
    classifyManualCodexEnterFrame(narrowFooterAwayFromRightEdge).kind,
    'ordinary-enter',
    'the same words away from the responsive clipping edge are not UI proof',
  );

  const narrowFooterWithChangedToken = structuredClone(exactNarrowFrame);
  narrowFooterWithChangedToken.lines[2].text =
    'q to quit esc/← to edit previous → to edit next enter';
  assert.equal(
    classifyManualCodexEnterFrame(narrowFooterWithChangedToken).kind,
    'ordinary-enter',
    'a near-match footer remains ordinary text',
  );

  const footerOutOfOrder = overlaySnapshot('old prompt reused as draft');
  footerOutOfOrder.lines[2].row = 14;
  assert.equal(
    classifyManualCodexEnterFrame(footerOutOfOrder).kind,
    'ordinary-enter',
    'the two footer rows must be adjacent current-frame chrome',
  );
});

test('real narrow Codex transcript frame accepts the right-edge clipped message label', () => {
  const mkFrame = (selectedText, {
    cols = 69,
    footer = 'q to quit esc/← to edit prev → to edit next enter to edit mess',
    occupiedEndX = null,
  } = {}) => ({
    success: true,
    rows: 22,
    cols,
    viewportY: 186,
    lines: [
      { row: 186, text: '/ T R A N S C R I P T / / / / / / / / / / / / / / / / /' },
      { row: 189, text: `› ${selectedText}` },
      { row: 205, text: '↑/↓ to scroll pgup/pgdn to page home/end to jump' },
      { row: 206, text: footer, occupiedEndX },
    ],
    codexActivePrompt: {
      row: 189,
      text: `› ${selectedText}`,
      hasInverse: true,
    },
  });

  const realFrameA = mkFrame('S10_A_MATERIALIZE_R4_ROOTFIX');
  assert.deepEqual(
    classifyManualCodexEnterFrame(realFrameA),
    {
      kind: 'native-rewind-confirm',
      proven: true,
      selectedText: 'S10_A_MATERIALIZE_R4_ROOTFIX',
      selectedRow: 189,
      reason: 'headless-transcript-active-prompt',
    },
  );

  const realFrameB = mkFrame('S10_B_MATERIALIZE_R4_ROOTFIX');
  assert.deepEqual(
    classifyManualCodexEnterFrame(realFrameB),
    {
      kind: 'native-rewind-confirm',
      proven: true,
      selectedText: 'S10_B_MATERIALIZE_R4_ROOTFIX',
      selectedRow: 189,
      reason: 'headless-transcript-active-prompt',
    },
  );

  const production70ColumnFrame = mkFrame('S10_C_PRODUCTION_70_COLS', {
    cols: 70,
    footer: 'q to quit esc/← to edit prev → to edit next enter to edit messa',
    occupiedEndX: 69,
  });
  assert.equal(
    classifyManualCodexEnterFrame(production70ColumnFrame).kind,
    'native-rewind-confirm',
    'raw double-space cells may reach the 70-column edge after normalized text already fits',
  );

  const samePrefixAwayFromPhysicalEdge = structuredClone(production70ColumnFrame);
  samePrefixAwayFromPhysicalEdge.lines[3].occupiedEndX = 55;
  assert.equal(
    classifyManualCodexEnterFrame(samePrefixAwayFromPhysicalEdge).kind,
    'ordinary-enter',
    'a footer-looking draft away from the physical edge is not clipping proof',
  );

  const quotedChromeInOrdinaryScrollback = structuredClone(realFrameA);
  quotedChromeInOrdinaryScrollback.lines[0].text = 'Response quoted T R A N S C R I P T';
  assert.equal(
    classifyManualCodexEnterFrame(quotedChromeInOrdinaryScrollback).kind,
    'ordinary-enter',
    'quoted words without the exact slash-delimited title remain ordinary input',
  );
});

test('manual native Rewind resolves duplicate text by physical navigation depth', () => {
  const sourceMessages = [
    sourceMessage(0, 'first prompt'),
    sourceMessage(1, 'same duplicate prompt'),
    sourceMessage(2, 'same duplicate prompt'),
    sourceMessage(3, 'latest prompt'),
  ];
  const resolved = resolveManualCodexRewindBoundary({
    snapshot: overlaySnapshot('same duplicate prompt'),
    sourceMessages,
    navigationOlderSteps: 2,
  });

  assert.equal(resolved.kind, 'native-rewind-confirm');
  assert.equal(resolved.boundaryReady, true);
  assert.equal(resolved.matchMode, 'navigation-and-screen');
  assert.equal(resolved.targetIndex, 1);
  assert.equal(resolved.targetSourceLine, 2);
  assert.equal(resolved.targetUuid, 'codex-user-source-2');
  assert.equal(resolved.rollbackTurns, 3);
  assert.match(resolved.targetTextHash, /^[a-f0-9]{64}$/);
});

test('manual native Rewind reconstructs the full hard-wrapped inverse selection', () => {
  const selected = readManualCodexRewindSelectedText([
    { row: 30, text: '› <pasted_content>', wrapped: false, hasInverse: true },
    { row: 31, text: '  first long source line', wrapped: false, hasInverse: true },
    { row: 32, text: '  continued without a hard newline', wrapped: true, hasInverse: true },
    { row: 33, text: '', wrapped: false },
    { row: 34, text: '  final paragraph', wrapped: false, hasInverse: true },
    { row: 35, text: '</pasted_content>', wrapped: false, hasInverse: true },
    { row: 36, text: '• assistant output', wrapped: false, hasInverse: false },
  ], 30);

  assert.equal(selected, [
    '<pasted_content>',
    'first long source linecontinued without a hard newline',
    '',
    'final paragraph',
    '</pasted_content>',
  ].join('\n'));
});

test('manual native Rewind keeps the full Opt+V saved-prompt marker in target proof', () => {
  const sourceText = [
    '<saved_prompt name="Review &amp; verify">',
    'Inspect the current change and explain every remaining risk.',
    '</saved_prompt>',
    '',
    'My editable follow-up stays outside the saved prompt.',
  ].join('\n');
  const selectedText = readManualCodexRewindSelectedText([
    { row: 40, text: '› <saved_prompt name="Review &amp; verify">', hasInverse: true },
    { row: 41, text: '  Inspect the current change and explain every remaining risk.', hasInverse: true },
    { row: 42, text: '  </saved_prompt>', hasInverse: true },
    { row: 43, text: '', hasInverse: true },
    { row: 44, text: '  My editable follow-up stays outside the saved prompt.', hasInverse: true },
    { row: 45, text: '• assistant output', hasInverse: false },
  ], 40);
  const resolved = resolveManualCodexRewindBoundary({
    snapshot: overlaySnapshot(selectedText),
    sourceMessages: [sourceMessage(0, sourceText)],
    navigationOlderSteps: 0,
  });

  assert.equal(selectedText, sourceText);
  assert.equal(resolved.boundaryReady, true);
  assert.equal(resolved.targetIndex, 0);
  assert.equal(resolved.rollbackTurns, 1);
});

test('manual native Rewind rejects short or foreign screen fragments', () => {
  const sourceMessages = [
    sourceMessage(0, 'first prompt with ordinary content'),
    sourceMessage(1, '<pasted_content> a long source prompt with several exact paragraphs </pasted_content>'),
  ];
  const short = resolveManualCodexRewindBoundary({
    snapshot: overlaySnapshot('<pasted_content>'),
    sourceMessages,
    navigationOlderSteps: 0,
  });
  assert.equal(short.boundaryReady, false);
  assert.equal(short.reason, 'selected-prompt-not-in-source');

  const foreign = resolveManualCodexRewindBoundary({
    snapshot: overlaySnapshot(
      'This sufficiently long paragraph belongs to a completely different conversation.'
    ),
    sourceMessages,
    navigationOlderSteps: 0,
  });
  assert.equal(foreign.boundaryReady, false);
  assert.equal(foreign.reason, 'selected-prompt-not-in-source');
});

test('latest selection stays depth zero and each proven Escape/Left moves one target older', () => {
  assert.equal(isPureCodexEscapeBurst('\x1b'), true);
  assert.equal(isPureCodexEscapeBurst('\x1b\x1b'), true);
  assert.equal(isPureCodexEscapeBurst('\x1b[D'), false);
  assert.equal(advanceManualCodexRewindNavigation(0, '\r', true), 0);
  assert.equal(advanceManualCodexRewindNavigation(0, '\x1b', true), 1);
  assert.equal(advanceManualCodexRewindNavigation(1, '\x1b[D', true), 2);
  assert.equal(
    advanceManualCodexRewindNavigation(0, '\x1b\x1b', true),
    2,
    'a coalesced physical double-Escape navigates twice only when the pre-frame is already the overlay',
  );
  assert.equal(
    advanceManualCodexRewindNavigation(0, '\x1b\x1b', false),
    0,
    'the same double-Escape from composer/hint merely opens the latest overlay',
  );
  assert.equal(advanceManualCodexRewindNavigation(2, '\x1b[C', true), 1);
  assert.equal(
    advanceManualCodexRewindNavigation(1, '\x1b[D', false),
    1,
    'arrows outside an exact overlay never mutate Rewind depth',
  );
});

test('manual Enter flushes only while the main-owned headless screen is pending', () => {
  const pending = {
    writeSeq: 12,
    flushedSeq: 11,
  };
  assert.equal(shouldFlushManualCodexEnterPreflight(pending), true);
  assert.equal(
    shouldAwaitManualCodexEnterPreflight(pending, false),
    false,
    'ordinary Enter never waits for a pending screen mirror',
  );
  assert.equal(
    shouldAwaitManualCodexEnterPreflight(pending, true),
    true,
    'an armed destructive Rewind candidate waits for current screen proof',
  );
  assert.equal(shouldFlushManualCodexEnterPreflight({
    writeSeq: 12,
    flushedSeq: 12,
  }), false);
  assert.equal(shouldFlushManualCodexEnterPreflight({
    success: false,
  }), false);
});

test('an armed Rewind candidate blocks Enter when preflight flush fails or remains pending', () => {
  assert.deepEqual(
    assessManualCodexEnterPreflightScreen({
      candidateObserver: true,
      flushRequired: true,
      flushResult: { success: false, error: 'timeout' },
      snapshot: {
        success: true,
        writeSeq: 14,
        flushedSeq: 13,
      },
    }),
    { ready: false, handled: true, reason: 'rewind-screen-flush-failed' },
  );
  assert.deepEqual(
    assessManualCodexEnterPreflightScreen({
      candidateObserver: true,
      flushRequired: true,
      flushResult: { success: true },
      snapshot: {
        success: true,
        writeSeq: 14,
        flushedSeq: 13,
      },
    }),
    { ready: false, handled: true, reason: 'rewind-screen-still-pending' },
  );
  assert.deepEqual(
    assessManualCodexEnterPreflightScreen({
      candidateObserver: true,
      flushRequired: true,
      flushResult: { success: true },
      snapshot: {
        success: true,
        writeSeq: 14,
        flushedSeq: 14,
      },
    }),
    { ready: true, handled: false, reason: 'rewind-screen-current' },
  );
  assert.deepEqual(
    assessManualCodexEnterPreflightScreen({
      candidateObserver: false,
      flushRequired: true,
      flushResult: { success: false },
      snapshot: {
        success: true,
        writeSeq: 14,
        flushedSeq: 13,
      },
    }),
    { ready: true, handled: false, reason: 'no-rewind-candidate' },
    'ordinary Enter keeps its existing behavior when no Rewind candidate owns the key event',
  );
});

test('manual native Rewind cannot cross Enter boundary without complete durable target proof', () => {
  const incomplete = sourceMessage(0, 'target prompt');
  incomplete.textHash = null;
  const result = resolveManualCodexRewindBoundary({
    snapshot: overlaySnapshot('target prompt'),
    sourceMessages: [incomplete],
  });

  assert.equal(result.kind, 'native-rewind-confirm');
  assert.equal(result.boundaryReady, false);
  assert.equal(result.reason, 'target-proof-incomplete');
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: result.frame,
      observerAvailable: true,
      boundaryReady: result.boundaryReady,
      journalDurable: false,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-target-unproven' },
  );
});

test('exact overlay without an armed writer observer is blocked while an ordinary composer stays immediate', () => {
  const rewindFrame = classifyManualCodexEnterFrame(overlaySnapshot('target prompt'));
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: rewindFrame,
      observerAvailable: false,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-observer-unavailable' },
  );

  const ordinarySnapshot = overlaySnapshot('normal draft');
  ordinarySnapshot.lines = [{ row: 11, text: '› normal draft' }];
  const ordinaryFrame = classifyManualCodexEnterFrame(ordinarySnapshot);
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: ordinaryFrame,
      observerAvailable: true,
    }),
    { handled: false, writeEnter: false, reason: 'ordinary-enter' },
    'an Escape-armed observer does not journal or block an ordinary composer Enter',
  );
});

test('an armed Rewind candidate never turns unavailable or changed screen proof into ordinary Enter', () => {
  const unavailableFrame = classifyManualCodexEnterFrame({ success: false });
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: unavailableFrame,
      observerAvailable: true,
      candidateObserver: true,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-screen-unavailable' },
    'unknown screen state after idle Escape is fail-closed',
  );

  const partialRewindSnapshot = overlaySnapshot('target prompt');
  partialRewindSnapshot.lines.pop();
  const partialRewindFrame = classifyManualCodexEnterFrame(partialRewindSnapshot);
  assert.equal(partialRewindFrame.kind, 'ordinary-enter');
  assert.equal(partialRewindFrame.possibleRewind, true);
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: partialRewindFrame,
      observerAvailable: true,
      candidateObserver: true,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-frame-incomplete' },
    'partial native chrome keeps Enter inside the Rewind proof path instead of submitting it',
  );

  const ordinarySnapshot = overlaySnapshot('ordinary draft');
  ordinarySnapshot.lines = [{ row: 11, text: '› ordinary draft' }];
  const ordinaryFrame = classifyManualCodexEnterFrame(ordinarySnapshot);
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: ordinaryFrame,
      observerAvailable: true,
      candidateObserver: true,
    }),
    { handled: false, writeEnter: false, reason: 'ordinary-enter' },
    'a successful current frame proves the candidate is ordinary input',
  );
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: ordinaryFrame,
      observerAvailable: true,
      rewindOwnershipEstablished: true,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-frame-changed' },
    'once this key event owned an exact overlay, a later frame change cannot fall through',
  );
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: unavailableFrame,
      observerAvailable: true,
      rewindOwnershipEstablished: true,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-screen-unavailable' },
    'a failed final flush cannot downgrade a destructive confirmation into ordinary input',
  );
});

test('manual Rewind Enter is writable only after the exact target and journal are both durable', () => {
  const boundary = resolveManualCodexRewindBoundary({
    snapshot: overlaySnapshot('latest prompt'),
    sourceMessages: [
      sourceMessage(0, 'first prompt'),
      sourceMessage(1, 'latest prompt'),
    ],
    navigationOlderSteps: 0,
  });
  assert.equal(boundary.targetIndex, 1, 'one overlay-open sequence selects the latest prompt');
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: boundary.frame,
      observerAvailable: true,
      boundaryReady: true,
      journalDurable: false,
    }),
    { handled: true, writeEnter: false, reason: 'rewind-journal-not-durable' },
  );
  assert.deepEqual(
    decideManualCodexRewindEnterWrite({
      frame: boundary.frame,
      observerAvailable: true,
      boundaryReady: true,
      journalDurable: true,
    }),
    { handled: true, writeEnter: true, reason: 'durable-rewind-boundary' },
  );
});

test('manual Rewind accepts only a newer committed frame with the exact restored composer', () => {
  const restoredText = 'first prompt restored after zero-prefix rewind';
  const expectedTextHash = hashCodexRewindTargetText(restoredText);
  const snapshot = {
    success: true,
    mirrorGeneration: 'mirror-g1',
    synchronizedOutputOpen: false,
    authoritativeFrameCommitted: true,
    writeSeq: 42,
    flushedSeq: 42,
    lines: [{ row: 11, text: `› ${restoredText}` }],
    codexCursorComposer: {
      row: 11,
      text: restoredText,
      hasDraft: true,
      cursorOwned: true,
    },
  };

  assert.deepEqual(
    classifyManualCodexRewindRestoredComposer({
      snapshot,
      expectedTextHash,
      actionWriteSeq: 41,
      mirrorGeneration: 'mirror-g1',
    }),
    {
      proven: true,
      terminal: true,
      reason: 'rewind-restored-exact-current-composer',
      restoredText,
      restoredTextHash: expectedTextHash,
      writeSeq: 42,
      mirrorGeneration: 'mirror-g1',
    },
  );

  assert.equal(classifyManualCodexRewindRestoredComposer({
    snapshot: { ...snapshot, writeSeq: 41, flushedSeq: 41 },
    expectedTextHash,
    actionWriteSeq: 41,
    mirrorGeneration: 'mirror-g1',
  }).reason, 'rewind-restored-frame-not-newer');

  assert.equal(classifyManualCodexRewindRestoredComposer({
    snapshot: { ...snapshot, synchronizedOutputOpen: true },
    expectedTextHash,
    actionWriteSeq: 41,
    mirrorGeneration: 'mirror-g1',
  }).reason, 'rewind-restored-frame-not-committed');

  assert.equal(classifyManualCodexRewindRestoredComposer({
    snapshot: {
      ...snapshot,
      lines: [{ row: 11, text: '› foreign text' }],
      codexCursorComposer: {
        row: 11,
        text: 'foreign text',
        hasDraft: true,
        cursorOwned: true,
      },
    },
    expectedTextHash,
    actionWriteSeq: 41,
    mirrorGeneration: 'mirror-g1',
  }).reason, 'rewind-restored-text-mismatch');

  assert.equal(classifyManualCodexRewindRestoredComposer({
    snapshot: { ...snapshot, mirrorGeneration: 'mirror-g2' },
    expectedTextHash,
    actionWriteSeq: 41,
    mirrorGeneration: 'mirror-g1',
  }).reason, 'rewind-restored-mirror-generation-changed');

  assert.equal(classifyManualCodexRewindRestoredComposer({
    snapshot: {
      ...snapshot,
      codexCursorComposer: {
        row: 11,
        text: restoredText,
        hasDraft: true,
        cursorOwned: false,
      },
    },
    expectedTextHash,
    actionWriteSeq: 41,
    mirrorGeneration: 'mirror-g1',
  }).reason, 'rewind-restored-composer-unproven');
});

test('manual Rewind exact editor copy proves a multiline restored prompt without clearing it', () => {
  const restoredText = 'first line\nsecond line\nthird line';
  const expectedTextHash = hashCodexRewindTargetText(restoredText);
  assert.deepEqual(classifyManualCodexRewindRestoredCopy({
    captureResult: { success: true, text: restoredText },
    expectedTextHash,
  }), {
    proven: true,
    terminal: true,
    reason: 'rewind-restored-exact-editor-copy',
    restoredText,
    restoredTextHash: expectedTextHash,
  });

  assert.equal(classifyManualCodexRewindRestoredCopy({
    captureResult: { success: true, text: restoredText + ' changed' },
    expectedTextHash,
  }).reason, 'rewind-restored-copy-mismatch');
  assert.equal(classifyManualCodexRewindRestoredCopy({
    captureResult: { success: false, error: 'codex_ctrl_g_noop' },
    expectedTextHash,
  }).reason, 'codex_ctrl_g_noop');
});

test('the transcript picker cannot masquerade as the restored composer', () => {
  const picker = overlaySnapshot('target prompt');
  picker.mirrorGeneration = 'mirror-g1';
  picker.synchronizedOutputOpen = false;
  picker.authoritativeFrameCommitted = true;
  picker.writeSeq = 12;
  picker.flushedSeq = 12;
  assert.equal(classifyManualCodexRewindRestoredComposer({
    snapshot: picker,
    expectedTextHash: hashCodexRewindTargetText('target prompt'),
    actionWriteSeq: 11,
    mirrorGeneration: 'mirror-g1',
  }).reason, 'rewind-picker-still-active');
});
