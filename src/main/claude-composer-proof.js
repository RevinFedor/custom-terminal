'use strict';

const CLAUDE_EMPTY_COMPOSER_HINT_RE = /^\s*Try\s+"[^"]+"/i;

function cleanClaudeComposerText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[▌█]/g, '')
    .replace(/\s+Image in clipboard\b.*$/i, '')
    .trimEnd();
}

function isClaudeComposerStopLine(text) {
  const trimmed = cleanClaudeComposerText(text).trim();
  if (!trimmed) return true;
  if (/^[─━]{8,}$/.test(trimmed)) return true;
  if (/^\[[^\]]+\]\s+\d+%/.test(trimmed)) return true;
  if (/^⏵⏵\s+/.test(trimmed)) return true;
  if (/^[✢✳✶✻✽·]\s*/.test(trimmed)) return true;
  if (/^[╭╰│┃║]/.test(trimmed)) return true;
  if (/^\s*Press Ctrl-C again to exit\b/i.test(trimmed)) return true;
  return false;
}

function unknown(snapshot, reason, extra = null) {
  return {
    success: true,
    proofOutcome: 'unknown',
    hasDraft: null,
    text: '',
    preview: '',
    source: (snapshot?.source || 'visible-buffer') + ':claude-composer:unknown:' + reason,
    proofReason: reason,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

function proven(snapshot, hasDraft, text, promptRow, cursorRow, cursorX) {
  const normalized = String(text || '').trim();
  const state = hasDraft ? 'found' : 'absent';
  return {
    success: true,
    proofOutcome: state,
    hasDraft,
    text: hasDraft ? normalized : '',
    preview: hasDraft ? normalized.replace(/\s+/g, ' ').slice(0, 160) : '',
    source: (snapshot?.source || 'visible-buffer') + ':claude-composer:'
      + (hasDraft ? 'prompt' : 'empty') + '-cursor-row-' + cursorRow,
    proofReason: hasDraft ? 'current-composer-text' : 'current-composer-empty',
    promptRow,
    cursorRow,
    cursorX,
  };
}

/**
 * Read only the logical composer which owns the current xterm cursor.
 *
 * A historic `❯` line elsewhere in the viewport is not evidence of a draft.
 * The caller must additionally prove that the terminal/input generation stayed
 * unchanged while the snapshot was requested.
 */
function parseClaudeComposerCurrentFrame(snapshot) {
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const baseY = Number(snapshot?.baseY);
  const cursorY = Number(snapshot?.cursorY);
  const cursorX = Number(snapshot?.cursorX);
  if (!Number.isInteger(baseY) || !Number.isInteger(cursorY) || !Number.isInteger(cursorX)) {
    return unknown(snapshot, 'cursor-unavailable');
  }
  const cursorRow = baseY + cursorY;
  const cursorIndex = lines.findIndex((line) => Number(line?.row) === cursorRow);
  if (cursorIndex < 0) return unknown(snapshot, 'cursor-outside-visible-frame');

  let promptIndex = cursorIndex;
  let promptCellIndex = -1;
  while (promptIndex >= 0) {
    const index = promptIndex;
    const raw = cleanClaudeComposerText(lines[index]?.text || '');
    const candidate = Math.max(raw.lastIndexOf('❯'), raw.lastIndexOf('›'));
    if (candidate >= 0) {
      promptCellIndex = candidate;
      break;
    }
    // Only xterm's own wrapped-line chain can connect a row above the cursor
    // to the current logical input. Plain response/status rows are a different
    // frame even when they contain no known separator glyph.
    if (lines[index]?.wrapped !== true) {
      promptIndex = -1;
      break;
    }
    promptIndex -= 1;
  }
  if (promptIndex < 0 || promptCellIndex < 0) return unknown(snapshot, 'active-prompt-not-found');
  const promptLine = lines[promptIndex] || {};
  const promptCellX = Number.isInteger(Number(promptLine.promptCellX))
    ? Number(promptLine.promptCellX)
    : promptCellIndex;
  if (promptIndex === cursorIndex && cursorX <= promptCellX) {
    return unknown(snapshot, 'cursor-before-composer');
  }

  const parts = [];
  const firstRaw = cleanClaudeComposerText(lines[promptIndex]?.text || '');
  const first = cleanClaudeComposerText(firstRaw.slice(promptCellIndex + 1)).trim();
  const placeholderWithStyleProof = CLAUDE_EMPTY_COMPOSER_HINT_RE.test(first)
    && lines[promptIndex]?.promptSuffixAllDim === true;

  // xterm's cursor is the current-frame witness. A genuine one-line draft can
  // have the cursor at the end, or before the end after the user moved it. The
  // latter is deliberately ambiguous and is resolved through Claude's exact
  // external-editor read. The production defect was the same geometry with an
  // empty composer: Claude repainted `❯ ` but did not erase old cells to the
  // right, and those residual glyphs were mistaken for a draft.
  const cursorLine = lines[cursorIndex] || {};
  const occupiedEndX = Number.isInteger(Number(cursorLine.occupiedEndX))
    ? Number(cursorLine.occupiedEndX)
    : cleanClaudeComposerText(cursorLine.text || '').length;
  const logicalLineContinuesAfterCursor = lines[cursorIndex + 1]?.wrapped === true;
  if (!placeholderWithStyleProof && (
    occupiedEndX > cursorX
    || logicalLineContinuesAfterCursor
  )) {
    return unknown(snapshot, 'composer-content-after-cursor', {
      exactCaptureRecommended: true,
      promptRow: Number(lines[promptIndex]?.row ?? promptIndex),
      cursorRow,
      cursorX,
      occupiedEndX,
    });
  }
  if (first && !placeholderWithStyleProof) parts.push(first);

  for (let index = promptIndex + 1; index <= cursorIndex; index += 1) {
    const continuation = cleanClaudeComposerText(lines[index]?.text || '');
    const trimmed = continuation.trim();
    if (isClaudeComposerStopLine(continuation)) {
      return unknown(snapshot, 'surface-between-prompt-and-cursor');
    }
    if (CLAUDE_EMPTY_COMPOSER_HINT_RE.test(trimmed)
      && lines[index]?.promptSuffixAllDim === true) break;
    parts.push(trimmed);
  }

  const text = parts.join('\n').trim();
  if (!text && (promptIndex === cursorIndex || placeholderWithStyleProof)) {
    return proven(
      snapshot,
      false,
      '',
      Number(lines[promptIndex]?.row ?? promptIndex),
      cursorRow,
      cursorX,
    );
  }
  if (!text) return unknown(snapshot, 'wrapped-composer-empty-ambiguous');
  return proven(
    snapshot,
    true,
    text,
    Number(lines[promptIndex]?.row ?? promptIndex),
    cursorRow,
    cursorX,
  );
}

function validateClaudeComposerWriteBoundary({
  proof,
  terminalMatches,
  currentInputRevision,
  currentRunSeq,
  currentLifecycleGeneration,
  currentMirrorGeneration,
  currentMirrorWriteSeq,
  currentMirrorFlushedSeq,
  currentMirrorSynchronizedOutputOpen,
}) {
  if (!proof || proof.proofOutcome !== 'absent' || proof.hasDraft !== false) {
    return {
      valid: false,
      reason: proof?.proofOutcome === 'found'
        ? 'claude_existing_draft_before_paste'
        : 'claude_draft_state_unknown_before_paste',
    };
  }
  if (!String(proof.source || '').startsWith('headless-main:')) {
    return { valid: false, reason: 'claude_headless_draft_proof_required' };
  }
  if (terminalMatches !== true) {
    return { valid: false, reason: 'claude_terminal_generation_changed' };
  }
  if (Number(proof.inputRevision) !== Number(currentInputRevision)) {
    return { valid: false, reason: 'claude_input_ownership_changed' };
  }
  if (Number(proof.terminalRunSeq) !== Number(currentRunSeq)) {
    return { valid: false, reason: 'claude_terminal_run_changed' };
  }
  if (
    !proof.terminalLifecycleGeneration
    || proof.terminalLifecycleGeneration !== currentLifecycleGeneration
  ) {
    return { valid: false, reason: 'claude_terminal_lifecycle_changed' };
  }
  if (!proof.mirrorGeneration || proof.mirrorGeneration !== currentMirrorGeneration) {
    return { valid: false, reason: 'claude_headless_generation_changed' };
  }
  if (
    proof.mirrorSynchronizedOutputOpen === true
    || currentMirrorSynchronizedOutputOpen === true
  ) {
    return { valid: false, reason: 'claude_headless_frame_open' };
  }
  if (
    Number(proof.mirrorWriteSeq) !== Number(currentMirrorWriteSeq)
    || Number(currentMirrorWriteSeq) !== Number(currentMirrorFlushedSeq)
  ) {
    return { valid: false, reason: 'claude_headless_frame_changed' };
  }
  if (
    !Number.isFinite(Number(proof.mirrorWriteSeq))
    || Number(proof.mirrorWriteSeq) !== Number(proof.mirrorFlushedSeq)
  ) {
    return { valid: false, reason: 'claude_headless_frame_not_flushed' };
  }
  return { valid: true, reason: 'claude_current_composer_empty' };
}

/**
 * After our own bracketed paste the mirror write sequence is expected to move,
 * but the physical PTY/input/lifecycle generation must still be the one which
 * owned the empty-composer proof. This is checked again at the final Enter
 * boundary because audit staging and render drains are asynchronous.
 */
function validateClaudeComposerSubmitGeneration({
  proof,
  terminalMatches,
  currentInputRevision,
  currentRunSeq,
  currentLifecycleGeneration,
  currentMirrorGeneration,
}) {
  if (!proof || proof.proofOutcome !== 'absent' || proof.hasDraft !== false) {
    return { valid: false, reason: 'claude_submit_missing_empty_composer_proof' };
  }
  if (terminalMatches !== true) {
    return { valid: false, reason: 'claude_terminal_generation_changed_after_paste' };
  }
  if (Number(proof.inputRevision) !== Number(currentInputRevision)) {
    return { valid: false, reason: 'claude_input_ownership_changed_after_paste' };
  }
  if (Number(proof.terminalRunSeq) !== Number(currentRunSeq)) {
    return { valid: false, reason: 'claude_terminal_run_changed_after_paste' };
  }
  if (
    !proof.terminalLifecycleGeneration
    || proof.terminalLifecycleGeneration !== currentLifecycleGeneration
  ) {
    return { valid: false, reason: 'claude_terminal_lifecycle_changed_after_paste' };
  }
  if (!proof.mirrorGeneration || proof.mirrorGeneration !== currentMirrorGeneration) {
    return { valid: false, reason: 'claude_headless_generation_changed_after_paste' };
  }
  return { valid: true, reason: 'claude_submit_generation_unchanged' };
}

module.exports = {
  CLAUDE_EMPTY_COMPOSER_HINT_RE,
  cleanClaudeComposerText,
  isClaudeComposerStopLine,
  parseClaudeComposerCurrentFrame,
  validateClaudeComposerSubmitGeneration,
  validateClaudeComposerWriteBoundary,
};
