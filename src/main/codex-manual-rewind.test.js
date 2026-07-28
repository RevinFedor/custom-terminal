'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  advanceManualCodexRewindNavigation,
  assessManualCodexEnterPreflightScreen,
  classifyManualCodexEnterFrame,
  decideManualCodexRewindEnterWrite,
  isPureCodexEscapeBurst,
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

  const footerOutOfOrder = overlaySnapshot('old prompt reused as draft');
  footerOutOfOrder.lines[2].row = 14;
  assert.equal(
    classifyManualCodexEnterFrame(footerOutOfOrder).kind,
    'ordinary-enter',
    'the two footer rows must be adjacent current-frame chrome',
  );
});

test('real narrow Codex transcript frame accepts the right-edge clipped message label', () => {
  const mkFrame = (selectedText) => ({
    success: true,
    rows: 22,
    cols: 69,
    viewportY: 186,
    lines: [
      { row: 186, text: '/ T R A N S C R I P T / / / / / / / / / / / / / / / / /' },
      { row: 189, text: `› ${selectedText}` },
      { row: 205, text: '↑/↓ to scroll pgup/pgdn to page home/end to jump' },
      { row: 206, text: 'q to quit esc/← to edit prev → to edit next enter to edit mess' },
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
