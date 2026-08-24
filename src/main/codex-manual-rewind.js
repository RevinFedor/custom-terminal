'use strict';

const {
  stripLeadingCodexComposerPromptGlyph,
} = require('./codex-tui-readiness');
const {
  hashCodexRewindTargetText,
} = require('./codex-rewind-target-proof');

function normalizeManualRewindText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[▌█]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readManualCodexRewindSelectedText(lines, selectedRow) {
  const rows = Array.isArray(lines) ? lines : [];
  const startIndex = rows.findIndex((line) => Number(line?.row) === Number(selectedRow));
  if (startIndex < 0 || rows[startIndex]?.hasInverse !== true) return '';

  let text = '';
  let pendingBlankLines = 0;
  let selectedLineCount = 0;
  for (let index = startIndex; index < rows.length; index += 1) {
    const line = rows[index] || {};
    const raw = String(line.text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[▌█]/g, '')
      .trimEnd();
    if (!raw.trim()) {
      pendingBlankLines += 1;
      continue;
    }
    if (line.hasInverse !== true) break;

    let part = raw;
    if (selectedLineCount === 0) {
      part = stripLeadingCodexComposerPromptGlyph(part).trimStart();
    } else {
      // Codex indents every continuation row inside the native transcript
      // selection. This indentation is presentation chrome, not user text.
      part = part.replace(/^\s{1,2}/, '');
    }
    if (selectedLineCount > 0) {
      if (line.wrapped === true) {
        // xterm soft-wrap: the source had no newline at this boundary.
      } else {
        text += '\n'.repeat(Math.max(1, pendingBlankLines + 1));
      }
    }
    text += part;
    pendingBlankLines = 0;
    selectedLineCount += 1;
  }
  return text.trim();
}

function readManualCodexComposerText(snapshot) {
  const active = snapshot?.codexCursorComposer || null;
  if (active?.cursorOwned !== true
    || active?.hasDraft !== true
    || !Number.isFinite(Number(active?.row))) return '';
  return String(stripLeadingCodexComposerPromptGlyph(active.text || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[▌█]/g, '')
    .trim();
}

/**
 * Prove the first fully committed composer frame produced after native Rewind.
 *
 * The prompt text was already visible inside the transcript picker before
 * Enter, so text equality alone is not causal.  The proof additionally needs
 * a newer, closed synchronized frame in the same headless-mirror generation,
 * with the transcript chrome gone and the exact restored prompt active in the
 * composer.
 */
function classifyManualCodexRewindRestoredComposer({
  snapshot,
  expectedTextHash,
  actionWriteSeq,
  mirrorGeneration,
} = {}) {
  if (snapshot?.success !== true) {
    return { proven: false, terminal: false, reason: 'rewind-restored-screen-unavailable' };
  }
  if (!expectedTextHash || !Number.isFinite(Number(actionWriteSeq)) || !mirrorGeneration) {
    return { proven: false, terminal: true, reason: 'rewind-restored-proof-context-incomplete' };
  }
  if (snapshot.mirrorGeneration !== mirrorGeneration) {
    return { proven: false, terminal: true, reason: 'rewind-restored-mirror-generation-changed' };
  }
  if (snapshot.synchronizedOutputOpen === true
    || snapshot.authoritativeFrameCommitted !== true
    || Number(snapshot.writeSeq) !== Number(snapshot.flushedSeq)) {
    return { proven: false, terminal: false, reason: 'rewind-restored-frame-not-committed' };
  }
  if (!Number.isFinite(Number(snapshot.writeSeq))
    || Number(snapshot.writeSeq) <= Number(actionWriteSeq)) {
    return { proven: false, terminal: false, reason: 'rewind-restored-frame-not-newer' };
  }
  if (classifyManualCodexEnterFrame(snapshot).kind === 'native-rewind-confirm') {
    return { proven: false, terminal: false, reason: 'rewind-picker-still-active' };
  }
  const restoredText = readManualCodexComposerText(snapshot);
  if (!restoredText) {
    return { proven: false, terminal: false, reason: 'rewind-restored-composer-unproven' };
  }
  const restoredTextHash = hashCodexRewindTargetText(restoredText);
  if (restoredTextHash !== expectedTextHash) {
    return {
      proven: false,
      terminal: false,
      reason: 'rewind-restored-text-mismatch',
      restoredTextHash,
    };
  }
  return {
    proven: true,
    terminal: true,
    reason: 'rewind-restored-exact-current-composer',
    restoredText,
    restoredTextHash,
    writeSeq: Number(snapshot.writeSeq),
    mirrorGeneration,
  };
}

function classifyManualCodexRewindRestoredCopy({
  captureResult,
  expectedTextHash,
} = {}) {
  if (captureResult?.success !== true) {
    return {
      proven: false,
      terminal: true,
      reason: captureResult?.error || 'rewind-restored-copy-failed',
    };
  }
  if (!expectedTextHash) {
    return {
      proven: false,
      terminal: true,
      reason: 'rewind-restored-copy-context-incomplete',
    };
  }
  const restoredText = String(captureResult.text || '').trim();
  if (!restoredText) {
    return {
      proven: false,
      terminal: true,
      reason: 'rewind-restored-copy-empty',
    };
  }
  const restoredTextHash = hashCodexRewindTargetText(restoredText);
  if (restoredTextHash !== expectedTextHash) {
    return {
      proven: false,
      terminal: true,
      reason: 'rewind-restored-copy-mismatch',
      restoredTextHash,
    };
  }
  return {
    proven: true,
    terminal: true,
    reason: 'rewind-restored-exact-editor-copy',
    restoredText,
    restoredTextHash,
  };
}

function classifyManualCodexRewindProviderRejection({
  snapshot,
  actionWriteSeq,
  mirrorGeneration,
} = {}) {
  if (snapshot?.success !== true) {
    return { rejected: false, terminal: false, reason: 'rewind-provider-frame-unavailable' };
  }
  if (!Number.isFinite(Number(actionWriteSeq)) || !mirrorGeneration) {
    return { rejected: false, terminal: true, reason: 'rewind-provider-frame-context-incomplete' };
  }
  if (snapshot.mirrorGeneration !== mirrorGeneration) {
    return { rejected: false, terminal: true, reason: 'rewind-provider-frame-generation-changed' };
  }
  if (snapshot.synchronizedOutputOpen === true
    || snapshot.authoritativeFrameCommitted !== true
    || Number(snapshot.writeSeq) !== Number(snapshot.flushedSeq)
    || !Number.isFinite(Number(snapshot.writeSeq))
    || Number(snapshot.writeSeq) <= Number(actionWriteSeq)) {
    return { rejected: false, terminal: false, reason: 'rewind-provider-frame-not-newer' };
  }
  if (classifyManualCodexEnterFrame(snapshot).kind === 'native-rewind-confirm') {
    return { rejected: false, terminal: false, reason: 'rewind-picker-still-active' };
  }
  const visibleText = [
    ...(Array.isArray(snapshot.preViewportLines) ? snapshot.preViewportLines : []),
    ...(Array.isArray(snapshot.lines) ? snapshot.lines : []),
  ].map((line) => String(line?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  const match = visibleText.match(
    /(?:^|\s)■\s+Failed to branch before the selected prompt:\s+([^]*?)(?=\s+[›❯»]\s|$)/i,
  );
  if (!match) {
    return { rejected: false, terminal: false, reason: 'rewind-provider-rejection-absent' };
  }
  return {
    rejected: true,
    terminal: true,
    reason: 'rewind-provider-branch-rejected',
    message: match[1].trim(),
    writeSeq: Number(snapshot.writeSeq),
    mirrorGeneration,
  };
}

function classifyManualCodexRewindProviderBranchDraft({
  snapshot,
  actionWriteSeq,
  mirrorGeneration,
} = {}) {
  if (snapshot?.success !== true) {
    return { restored: false, terminal: false, reason: 'rewind-provider-frame-unavailable' };
  }
  if (!Number.isFinite(Number(actionWriteSeq)) || !mirrorGeneration) {
    return { restored: false, terminal: true, reason: 'rewind-provider-frame-context-incomplete' };
  }
  if (snapshot.mirrorGeneration !== mirrorGeneration) {
    return { restored: false, terminal: true, reason: 'rewind-provider-frame-generation-changed' };
  }
  if (snapshot.synchronizedOutputOpen === true
    || snapshot.authoritativeFrameCommitted !== true
    || Number(snapshot.writeSeq) !== Number(snapshot.flushedSeq)
    || !Number.isFinite(Number(snapshot.writeSeq))
    || Number(snapshot.writeSeq) <= Number(actionWriteSeq)) {
    return { restored: false, terminal: false, reason: 'rewind-provider-frame-not-newer' };
  }
  if (classifyManualCodexEnterFrame(snapshot).kind === 'native-rewind-confirm') {
    return { restored: false, terminal: false, reason: 'rewind-picker-still-active' };
  }
  const visibleText = [
    ...(Array.isArray(snapshot.preViewportLines) ? snapshot.preViewportLines : []),
    ...(Array.isArray(snapshot.lines) ? snapshot.lines : []),
  ].map((line) => String(line?.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  if (!/You(?:'|’|ʼ)re continuing from this point in a new conversation/i.test(visibleText)) {
    return { restored: false, terminal: false, reason: 'rewind-provider-branch-draft-absent' };
  }
  return {
    restored: true,
    terminal: true,
    reason: 'rewind-provider-branch-draft-restored',
    writeSeq: Number(snapshot.writeSeq),
    mirrorGeneration,
  };
}

function isPureCodexEscapeBurst(data) {
  return typeof data === 'string' && /^\x1b+$/.test(data);
}

function classifyManualCodexRewindControlInput({
  data,
  frame = null,
  framePending = false,
  escapePrimeAllowed = false,
  candidateObserver = false,
} = {}) {
  if (candidateObserver !== true) {
    return { owned: false, kind: 'ordinary-input', reason: 'rewind-observer-unavailable' };
  }
  const value = String(data || '');
  if (value === 'q' || value === '\x03') {
    return { owned: false, kind: 'cancel', reason: 'rewind-ui-cancelled' };
  }
  // The first idle Escape creates the main-owned observer; the following
  // Escape is Codex's own transition into the transcript picker.  It is part
  // of the same destructive action even though the picker frame is not yet on
  // screen when the byte reaches this boundary.
  if (isPureCodexEscapeBurst(value)) {
    if (frame?.kind === 'native-rewind-confirm' || escapePrimeAllowed === true) {
      return { owned: true, kind: 'navigation', reason: 'rewind-escape-control' };
    }
    return { owned: false, kind: 'ordinary-input', reason: 'rewind-escape-context-unproven' };
  }
  if (value === '\r' || value === '\n') {
    if (frame?.kind === 'native-rewind-confirm') {
      return { owned: true, kind: 'confirm', reason: 'rewind-confirm-control' };
    }
    if (framePending === true || frame?.possibleRewind === true) {
      return { owned: true, kind: 'confirm-pending', reason: 'rewind-confirm-frame-pending' };
    }
    return { owned: false, kind: 'ordinary-input', reason: 'rewind-frame-unproven' };
  }
  if (frame?.kind !== 'native-rewind-confirm') {
    return { owned: false, kind: 'ordinary-input', reason: 'rewind-frame-unproven' };
  }
  // Only controls advertised by the exact current Codex transcript frame are
  // action-owned. Printable text and every unknown escape sequence remain
  // ordinary user input and revoke the lease.
  if (/^(?:(?:\x1b\[[ABCDHF])|(?:\x1b\[(?:1|4|5|6)~))+$/.test(value)) {
    return { owned: true, kind: 'navigation', reason: 'rewind-navigation-control' };
  }
  return { owned: false, kind: 'ordinary-input', reason: 'rewind-control-unrecognized' };
}

function advanceManualCodexRewindOwnedInputRevision({
  previousOwnedRevision,
  inputRevisionBefore,
  inputRevisionAfter,
  ownedControlCount = 0,
  controlKind = null,
} = {}) {
  const previousOwned = Number(previousOwnedRevision);
  const revisionBefore = Number(inputRevisionBefore);
  const revisionAfter = Number(inputRevisionAfter);
  const controlCount = Number(ownedControlCount);
  if (![previousOwned, revisionBefore, revisionAfter, controlCount]
    .every((value) => Number.isInteger(value) && value >= 0)) {
    return { allowed: false, reason: 'rewind-input-revision-unproven' };
  }
  const firstControlCreatedAuthority = controlCount === 0
    && revisionAfter === revisionBefore + 1
    && previousOwned === revisionAfter;
  const continuedOwnedControl = previousOwned === revisionBefore
    && (
      revisionAfter === revisionBefore + 1
      || (String(controlKind || '').startsWith('confirm')
        && revisionAfter === revisionBefore)
    );
  if (!firstControlCreatedAuthority && !continuedOwnedControl) {
    return { allowed: false, reason: 'rewind-input-revision-gap' };
  }
  return {
    allowed: true,
    reason: firstControlCreatedAuthority
      ? 'rewind-authority-created-by-control'
      : 'rewind-owned-control-contiguous',
    ownedInputRevision: revisionAfter,
    ownedControlCount: controlCount + 1,
  };
}

function classifyManualCodexEnterFrame(snapshot) {
  const lines = [
    ...(Array.isArray(snapshot?.preViewportLines) ? snapshot.preViewportLines : []),
    ...(Array.isArray(snapshot?.lines) ? snapshot.lines : []),
  ];
  const normalizedRows = lines.map((line) => ({
    row: Number(line?.row),
    text: normalizeManualRewindText(line?.text || ''),
    occupiedEndX: Number(line?.occupiedEndX),
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
  const responsiveEditFooter = 'q to quit esc/← to edit prev → to edit next enter to edit message';
  const minimumResponsiveFooter = 'q to quit esc/← to edit prev → to edit next enter';
  const editFooterMatches = (row) => {
    if (editFooterPattern.test(row.text)) return true;
    const cols = Number(snapshot?.cols);
    const occupiedEndX = Number(row?.occupiedEndX);
    const isExactResponsivePrefix = row.text.length >= minimumResponsiveFooter.length
      && responsiveEditFooter.startsWith(row.text);
    // xterm reports the physical cell boundary, while normalizeManualRewindText
    // collapses Codex's double-space groups.  The normalized canonical footer
    // is therefore shorter than the same row on screen.  Prove truncation by
    // the physical right edge instead of comparing cols with normalized text
    // length (the production 70-column frame ended in "messa").
    const isRightEdgeClip = Number.isFinite(cols)
      && cols > 0
      && Number.isFinite(occupiedEndX)
      // Codex reserves a small responsive gutter on some widths; the exact
      // prefix plus the full title/selection/footer geometry remains required.
      && occupiedEndX >= cols - 8;
    return isExactResponsivePrefix && isRightEdgeClip;
  };
  const titlePrecedes = (row) => titleRows.some((title) => (
    Number.isFinite(title.row)
    && Number.isFinite(row)
    && title.row < row
    && (!Number.isFinite(activeRow) || title.row < activeRow)
  ));
  const hasTranscriptTitle = titleRows.some(({ row }) => (
    Number.isFinite(row) && (!Number.isFinite(activeRow) || row < activeRow)
  ));
  const scrollFooterRows = normalizedRows.filter((row) => (
    scrollFooterPattern.test(row.text)
    && Number.isFinite(row.row)
    && (!Number.isFinite(activeRow) || row.row > activeRow)
    && titlePrecedes(row.row)
  ));
  const editFooterRows = normalizedRows.filter((row) => (
    editFooterMatches(row)
    && Number.isFinite(row.row)
    && (!Number.isFinite(activeRow) || row.row > activeRow)
    && titlePrecedes(row.row)
  ));
  const hasTranscriptFooter = normalizedRows.some((row, index) => {
    if (!scrollFooterPattern.test(row.text)) return false;
    const next = normalizedRows[index + 1];
    return !!next
      && Number.isFinite(row.row)
      && Number.isFinite(next.row)
      && (!Number.isFinite(activeRow) || row.row > activeRow)
      && titlePrecedes(row.row)
      && next.row === row.row + 1
      && editFooterMatches(next);
  });
  const hasTranscriptChrome = hasTranscriptTitle && hasTranscriptFooter;
  const activePromptProven = active?.hasInverse === true
    && Number.isFinite(activeRow)
    && selectedText.length > 0;
  // The native footer includes `enter to edit message` only while Codex owns a
  // concrete backtrack selection. The selected user cell itself may be taller
  // than the viewport, so its leading `›` row can legitimately be off-screen.
  // Exact title + adjacent selection footer are therefore the destructive UI
  // proof; inverse prompt text is optional presentation diagnostics.
  const possibleRewind = snapshot?.success === true
    && hasTranscriptTitle
    && (scrollFooterRows.length > 0 || editFooterRows.length > 0);

  if (snapshot?.success === true && hasTranscriptChrome) {
    return {
      kind: 'native-rewind-confirm',
      proven: true,
      selectedText: activePromptProven ? selectedText : '',
      selectedRow: activePromptProven ? activeRow : null,
      reason: activePromptProven
        ? 'headless-transcript-active-prompt'
        : 'headless-transcript-selection-chrome',
    };
  }
  return {
    kind: 'ordinary-enter',
    proven: false,
    possibleRewind,
    selectedText: '',
    selectedRow: null,
    reason: snapshot?.success !== true
      ? 'headless-screen-unavailable'
      : !hasTranscriptChrome
        ? 'transcript-chrome-absent'
        : 'transcript-selection-unproven',
  };
}

function manualRewindPromptMatches(selectedText, sourceText) {
  const selected = normalizeManualRewindText(selectedText)
    .replace(/^(?:…|\.\.\.)\s*/, '')
    .replace(/\s*(?:…|\.\.\.)$/, '')
    .trim();
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
    if (candidateObserver && frame?.possibleRewind === true) {
      return { handled: true, writeEnter: false, reason: 'rewind-frame-incomplete' };
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

  const olderSteps = Math.max(0, Number.isInteger(Number(navigationOlderSteps))
    ? Number(navigationOlderSteps)
    : 0);
  const expectedIndex = messages.length - 1 - olderSteps;
  if (expectedIndex < 0 || expectedIndex >= messages.length) {
    return {
      kind: 'native-rewind-confirm',
      boundaryReady: false,
      frame,
      reason: 'selected-prompt-navigation-out-of-range',
      expectedIndex,
      navigationOlderSteps: olderSteps,
    };
  }

  // Codex owns the selection as an ordinal `nth_user_message`: the first
  // backtrack selection is the newest visible user cell, and Esc/Left/Right
  // move that ordinal. Terminal text is presentation only. It can be wrapped,
  // clipped, decorated with image/paste markup, or show a different part of a
  // long transcript cell, so it must never choose or veto the target.
  //
  // Keep the screen comparison solely as diagnostics. In particular, a unique
  // text match at another index is NOT authority to override the exact causal
  // navigation path.
  const matchingIndexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (manualRewindPromptMatches(frame.selectedText, messages[index]?.text)) {
      matchingIndexes.push(index);
    }
  }
  const targetIndex = expectedIndex;
  const screenMatchesTarget = matchingIndexes.includes(targetIndex);
  const screenConsistency = screenMatchesTarget
    ? 'matches-navigation-target'
    : matchingIndexes.length === 0
      ? 'presentation-not-in-source'
      : matchingIndexes.length === 1
        ? 'presentation-points-elsewhere'
        : 'presentation-ambiguous';
  const matchMode = screenMatchesTarget
    ? 'navigation-and-screen'
    : 'navigation-only';

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
  if (target.branchable === false) {
    return {
      kind: 'native-rewind-confirm',
      boundaryReady: false,
      frame,
      reason: 'selected-prompt-not-branchable',
      targetIndex,
      targetUuid: target.uuid,
      targetSourceLine: Number(target.sourceLine),
      branchabilityReason: target.branchabilityReason || 'mid-turn-user-message',
    };
  }

  return {
    kind: 'native-rewind-confirm',
    boundaryReady: true,
    frame,
    reason: 'exact-source-target',
    matchMode,
    screenConsistency,
    matchingIndexes,
    navigationOlderSteps: olderSteps,
    targetUserOrdinal: targetIndex,
    targetIndex,
    targetUuid: target.uuid,
    targetSourceLine: Number(target.sourceLine),
    targetTextHash: target.textHash,
    rollbackTurns: messages.length - targetIndex,
  };
}

module.exports = {
  advanceManualCodexRewindNavigation,
  advanceManualCodexRewindOwnedInputRevision,
  assessManualCodexEnterPreflightScreen,
  classifyManualCodexRewindRestoredCopy,
  classifyManualCodexRewindRestoredComposer,
  classifyManualCodexRewindProviderBranchDraft,
  classifyManualCodexRewindProviderRejection,
  classifyManualCodexRewindControlInput,
  classifyManualCodexEnterFrame,
  decideManualCodexRewindEnterWrite,
  isPureCodexEscapeBurst,
  manualRewindPromptMatches,
  normalizeManualRewindText,
  readManualCodexComposerText,
  readManualCodexRewindSelectedText,
  resolveManualCodexRewindBoundary,
  shouldAwaitManualCodexEnterPreflight,
  shouldFlushManualCodexEnterPreflight,
};
