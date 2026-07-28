'use strict';

const {
  stripLeadingCodexComposerPromptGlyph,
} = require('./codex-tui-readiness');

function normalizeManualRewindText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[▌█]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPureCodexEscapeBurst(data) {
  return typeof data === 'string' && /^\x1b+$/.test(data);
}

function classifyManualCodexEnterFrame(snapshot) {
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const normalizedRows = lines.map((line) => ({
    row: Number(line?.row),
    text: normalizeManualRewindText(line?.text || ''),
  }));
  const active = snapshot?.codexActivePrompt || null;
  const activeRow = Number(active?.row);
  const selectedText = normalizeManualRewindText(
    stripLeadingCodexComposerPromptGlyph(active?.text || ''),
  );
  // Neither word is enough by itself: ordinary history or a user's draft may
  // contain "TRANSCRIPT" / "enter to edit message". Native Rewind is proven
  // only by the ordered overlay geometry: a slash-delimited TRANSCRIPT title
  // above the active inverse row, followed by Codex's two adjacent footer rows.
  // The final word is allowed to be clipped as "mess" by a narrow xterm; the
  // preceding title/navigation/edit controls must still match exactly.
  const titleRows = normalizedRows.filter(({ text }) => (
    /(?:^|[\/\\|─━_-])\s*T\s+R\s+A\s+N\s+S\s+C\s+R\s+I\s+P\s+T\s*(?=$|[\/\\|─━_-])/i.test(text)
  ));
  const scrollFooterPattern = /^↑\s*\/\s*↓\s+to\s+scroll\s+pgup\s*\/\s*pgdn\s+to\s+page\s+home\s*\/\s*end\s+to\s+jump$/i;
  const editFooterPattern = /^q\s+to\s+quit\s+esc\s*\/\s*←\s+to\s+edit\s+prev\s+→\s+to\s+edit\s+next\s+enter\s+to\s+edit\s+(?:mess|message)$/i;
  const hasTranscriptTitle = titleRows.some(({ row }) => (
    Number.isFinite(row) && Number.isFinite(activeRow) && row < activeRow
  ));
  const hasTranscriptFooter = normalizedRows.some((row, index) => {
    if (!scrollFooterPattern.test(row.text)) return false;
    const next = normalizedRows[index + 1];
    return !!next
      && Number.isFinite(row.row)
      && Number.isFinite(next.row)
      && Number.isFinite(activeRow)
      && row.row > activeRow
      && next.row === row.row + 1
      && editFooterPattern.test(next.text);
  });
  const hasTranscriptChrome = hasTranscriptTitle && hasTranscriptFooter;
  const activePromptProven = active?.hasInverse === true
    && Number.isFinite(activeRow)
    && selectedText.length > 0;

  if (snapshot?.success === true && hasTranscriptChrome && activePromptProven) {
    return {
      kind: 'native-rewind-confirm',
      proven: true,
      selectedText,
      selectedRow: activeRow,
      reason: 'headless-transcript-active-prompt',
    };
  }
  return {
    kind: 'ordinary-enter',
    proven: false,
    selectedText: '',
    selectedRow: null,
    reason: snapshot?.success !== true
      ? 'headless-screen-unavailable'
      : !hasTranscriptChrome
        ? 'transcript-chrome-absent'
        : 'active-rewind-prompt-unproven',
  };
}

function manualRewindPromptMatches(selectedText, sourceText) {
  const selected = normalizeManualRewindText(selectedText).replace(/…$/, '').trim();
  const source = normalizeManualRewindText(sourceText);
  if (!selected || !source) return false;
  if (selected === source) return true;
  const words = selected.split(/\s+/).filter(Boolean);
  return selected.length >= 16 && words.length >= 3 && source.startsWith(selected);
}

function advanceManualCodexRewindNavigation(currentOlderSteps, data, overlayProven) {
  const current = Math.max(0, Number.isInteger(Number(currentOlderSteps))
    ? Number(currentOlderSteps)
    : 0);
  if (!overlayProven) return current;
  const value = String(data || '');
  const leftCount = isPureCodexEscapeBurst(value)
    ? value.length
    : (value.match(/\x1b\[D/g) || []).length;
  const rightCount = (value.match(/\x1b\[C/g) || []).length;
  return Math.max(0, current + leftCount - rightCount);
}

function shouldFlushManualCodexEnterPreflight(snapshot) {
  const writeSeq = Number(snapshot?.writeSeq);
  const flushedSeq = Number(snapshot?.flushedSeq);
  return Number.isFinite(writeSeq)
    && Number.isFinite(flushedSeq)
    && writeSeq > flushedSeq;
}

function shouldAwaitManualCodexEnterPreflight(snapshot, candidateObserver = false) {
  return candidateObserver === true
    && shouldFlushManualCodexEnterPreflight(snapshot);
}

function assessManualCodexEnterPreflightScreen({
  candidateObserver = false,
  flushRequired = false,
  flushResult = null,
  snapshot = null,
} = {}) {
  if (!candidateObserver) {
    return { ready: true, handled: false, reason: 'no-rewind-candidate' };
  }
  if (flushRequired && flushResult?.success !== true) {
    return { ready: false, handled: true, reason: 'rewind-screen-flush-failed' };
  }
  if (shouldFlushManualCodexEnterPreflight(snapshot)) {
    return { ready: false, handled: true, reason: 'rewind-screen-still-pending' };
  }
  return { ready: true, handled: false, reason: 'rewind-screen-current' };
}

function decideManualCodexRewindEnterWrite({
  frame,
  observerAvailable = false,
  boundaryReady = false,
  journalDurable = false,
  candidateObserver = false,
  rewindOwnershipEstablished = false,
} = {}) {
  if (frame?.kind !== 'native-rewind-confirm') {
    if (rewindOwnershipEstablished) {
      return {
        handled: true,
        writeEnter: false,
        reason: frame?.reason === 'headless-screen-unavailable'
          ? 'rewind-screen-unavailable'
          : 'rewind-frame-changed',
      };
    }
    if (candidateObserver && frame?.reason === 'headless-screen-unavailable') {
      return { handled: true, writeEnter: false, reason: 'rewind-screen-unavailable' };
    }
    return { handled: false, writeEnter: false, reason: 'ordinary-enter' };
  }
  if (!observerAvailable) {
    return { handled: true, writeEnter: false, reason: 'rewind-observer-unavailable' };
  }
  if (!boundaryReady) {
    return { handled: true, writeEnter: false, reason: 'rewind-target-unproven' };
  }
  if (!journalDurable) {
    return { handled: true, writeEnter: false, reason: 'rewind-journal-not-durable' };
  }
  return { handled: true, writeEnter: true, reason: 'durable-rewind-boundary' };
}

function resolveManualCodexRewindBoundary({
  snapshot,
  sourceMessages,
  navigationOlderSteps = 0,
} = {}) {
  const frame = classifyManualCodexEnterFrame(snapshot);
  if (frame.kind !== 'native-rewind-confirm') {
    return {
      kind: 'ordinary-enter',
      boundaryReady: false,
      frame,
      reason: frame.reason,
    };
  }

  const messages = Array.isArray(sourceMessages) ? sourceMessages : [];
  if (messages.length === 0) {
    return {
      kind: 'native-rewind-confirm',
      boundaryReady: false,
      frame,
      reason: 'source-projection-empty',
    };
  }

  const matchingIndexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (manualRewindPromptMatches(frame.selectedText, messages[index]?.text)) {
      matchingIndexes.push(index);
    }
  }

  const olderSteps = Math.max(0, Number.isInteger(Number(navigationOlderSteps))
    ? Number(navigationOlderSteps)
    : 0);
  const expectedIndex = messages.length - 1 - olderSteps;
  let targetIndex = -1;
  let matchMode = 'none';
  if (
    expectedIndex >= 0
    && matchingIndexes.includes(expectedIndex)
  ) {
    targetIndex = expectedIndex;
    matchMode = 'navigation-and-screen';
  } else if (matchingIndexes.length === 1) {
    targetIndex = matchingIndexes[0];
    matchMode = 'unique-screen';
  }

  if (targetIndex < 0) {
    return {
      kind: 'native-rewind-confirm',
      boundaryReady: false,
      frame,
      reason: matchingIndexes.length > 1
        ? 'selected-prompt-ambiguous'
        : 'selected-prompt-not-in-source',
      matchingIndexes,
      expectedIndex,
    };
  }

  const target = messages[targetIndex] || {};
  const targetShapeValid = typeof target.uuid === 'string'
    && target.uuid.length > 0
    && Number.isInteger(Number(target.sourceLine))
    && Number(target.sourceLine) >= 1
    && typeof target.textHash === 'string'
    && /^[a-f0-9]{64}$/i.test(target.textHash);
  if (!targetShapeValid) {
    return {
      kind: 'native-rewind-confirm',
      boundaryReady: false,
      frame,
      reason: 'target-proof-incomplete',
      targetIndex,
    };
  }

  return {
    kind: 'native-rewind-confirm',
    boundaryReady: true,
    frame,
    reason: 'exact-source-target',
    matchMode,
    targetIndex,
    targetUuid: target.uuid,
    targetSourceLine: Number(target.sourceLine),
    targetTextHash: target.textHash,
    rollbackTurns: messages.length - targetIndex,
  };
}

module.exports = {
  advanceManualCodexRewindNavigation,
  assessManualCodexEnterPreflightScreen,
  classifyManualCodexEnterFrame,
  decideManualCodexRewindEnterWrite,
  isPureCodexEscapeBurst,
  manualRewindPromptMatches,
  normalizeManualRewindText,
  resolveManualCodexRewindBoundary,
  shouldAwaitManualCodexEnterPreflight,
  shouldFlushManualCodexEnterPreflight,
};
