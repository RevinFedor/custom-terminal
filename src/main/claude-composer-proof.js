'use strict';

const { agentInputObservationInvalidated } = require('../shared/agent-input-observation.cjs');

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

function summarizeClaudePromptSuffixStyle(cells) {
  const contentCells = Array.isArray(cells)
    ? cells.filter((cell) => String(cell?.ch || '').trim())
    : [];
  return {
    allDim: contentCells.length > 0
      && contentCells.every((cell) => cell?.dim === true),
    hasInverse: contentCells.some((cell) => cell?.inverse === true),
    hasNonDefaultBg: contentCells.some((cell) => cell?.nonDefaultBg === true),
  };
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

function proven(snapshot, hasDraft, text, promptRow, cursorRow, cursorX, proofReason = null) {
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
    proofReason: proofReason || (hasDraft ? 'current-composer-text' : 'current-composer-empty'),
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
  const strictDimGhostSuggestion = first
    && promptIndex === cursorIndex
    && cursorX === promptCellX + 2
    && logicalLineContinuesAfterCursor !== true
    && promptLine.promptSuffixAllDim === true
    && promptLine.promptSuffixHasInverse === false
    && promptLine.promptSuffixHasNonDefaultBg === false
    && promptLine.promptSuffixWrapped === false;
  if (strictDimGhostSuggestion) {
    return proven(
      snapshot,
      false,
      '',
      Number(lines[promptIndex]?.row ?? promptIndex),
      cursorRow,
      cursorX,
      'current-composer-dim-ghost-suggestion',
    );
  }
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

/**
 * Decide whether a closed main/headless frame which cannot locate the active
 * prompt may be resolved through Claude's non-destructive external-editor
 * copy. The screen parser deliberately does not make this decision: it cannot
 * see lifecycle, startup, picker, or PTY-writer ownership.
 */
function classifyClaudeMissingPromptExactCaptureAdmission({
  proof,
  snapshot,
  turnBusy = false,
  localCommandActive = false,
  compactActive = false,
  awaitingInput = false,
  stopping = false,
  rewindActive = false,
  writeOperationActive = false,
  startupGateReady = false,
  controlSurfaceActive = false,
} = {}) {
  if (proof?.proofOutcome !== 'unknown' || proof?.proofReason !== 'active-prompt-not-found') {
    return { recommended: false, reason: 'not-active-prompt-missing' };
  }
  if (
    snapshot?.source !== 'headless-main'
    || !snapshot?.mirrorGeneration
    || snapshot?.committedFrameReplay === true
    || snapshot?.liveSynchronizedOutputOpen === true
    || snapshot?.synchronizedOutputOpen === true
    || Number(snapshot?.writeSeq) !== Number(snapshot?.flushedSeq)
    || snapshot?.authoritativeFrameCommitted !== true
  ) {
    return { recommended: false, reason: 'current-closed-headless-frame-required' };
  }
  if (turnBusy) return { recommended: false, reason: 'claude-turn-busy' };
  if (localCommandActive) return { recommended: false, reason: 'claude-local-command-active' };
  if (compactActive) return { recommended: false, reason: 'claude-compact-active' };
  if (awaitingInput) return { recommended: false, reason: 'claude-question-active' };
  if (stopping) return { recommended: false, reason: 'claude-stopping' };
  if (rewindActive) return { recommended: false, reason: 'claude-rewind-active' };
  if (writeOperationActive) return { recommended: false, reason: 'claude-pty-write-active' };
  if (!startupGateReady) return { recommended: false, reason: 'claude-startup-gate-not-ready' };
  if (controlSurfaceActive) return { recommended: false, reason: 'claude-control-surface-active' };
  return { recommended: true, reason: 'closed-idle-frame-exact-copy' };
}

/**
 * A Ctrl+G capture is itself serialized through the PTY writer. Its own lock
 * is ownership, not contention; only a different active or queued operation
 * may veto the exact-capture fallback.
 */
function hasConflictingPtyWriteOperation({
  activeOperation = null,
  lastQueuedOperation = null,
  ownedOperation = null,
} = {}) {
  // Once the capture owns the active writer boundary, a later queued write is
  // behind it and cannot mutate the composer until this capture releases the
  // lock. Only the operation that currently owns the PTY can conflict here.
  if (activeOperation) return activeOperation !== ownedOperation;
  return !!lastQueuedOperation && lastQueuedOperation !== ownedOperation;
}

function validateClaudeComposerWriteBoundary({
  proof,
  terminalMatches,
  currentInputRevision,
  currentRunSeq,
  currentStopRevision = 0,
  currentLifecycleGeneration,
  currentMirrorGeneration,
  currentMirrorWriteSeq,
  currentMirrorFlushedSeq,
  currentMirrorSynchronizedOutputOpen,
}) {
  if (agentInputObservationInvalidated(proof)
    || !sameFiniteNumber(proof?.terminalStopRevision ?? 0, currentStopRevision)) {
    return { valid: false, reason: 'claude_input_observation_superseded' };
  }
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
 * Move an exact empty-composer proof across the one input-revision increment
 * owned by this paste request. The caller must invoke this before any async
 * work: a user key, process replacement, or mirror replacement makes the
 * original proof ineligible instead of being silently adopted.
 */
function reserveClaudeExactEmptyEvidence({
  evidence,
  currentInputRevision,
  reservedInputRevision,
  currentRunSeq,
  currentStopRevision = 0,
  currentLifecycleGeneration,
  currentMirrorGeneration,
}) {
  if (
    !evidence
    || evidence.proofOutcome !== 'absent'
    || evidence.terminalIdentityStable !== true
    || evidence.editorReturnReady !== true
    || String(evidence.text || '').trim()
    || Number(evidence.images || 0) > 0
  ) return null;
  if (agentInputObservationInvalidated(evidence)
    || !sameFiniteNumber(evidence.terminalStopRevision ?? 0, currentStopRevision)) return null;
  if (
    Number(evidence.inputRevision) !== Number(currentInputRevision)
    || Number(evidence.terminalRunSeq) !== Number(currentRunSeq)
    || !evidence.terminalLifecycleGeneration
    || evidence.terminalLifecycleGeneration !== currentLifecycleGeneration
    || !evidence.mirrorGeneration
    || evidence.mirrorGeneration !== currentMirrorGeneration
  ) return null;
  if (Number(reservedInputRevision) !== Number(currentInputRevision) + 1) return null;
  return {
    ...evidence,
    inputRevision: Number(reservedInputRevision),
  };
}

function isPresentIdentity(value) {
  return value !== null && value !== undefined && value !== '';
}

function sameFiniteNumber(left, right) {
  if (!isPresentIdentity(left) || !isPresentIdentity(right)) return false;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber)
    && Number.isFinite(rightNumber)
    && leftNumber === rightNumber;
}

/**
 * Resolve a fresh screen ambiguity with the exact empty result already owned
 * by the queue-head paste operation.
 *
 * This is deliberately a different capability from
 * classifyClaudeMissingPromptExactCaptureAdmission(): an active PTY writer
 * must prevent a new Ctrl+G capture, but the writer must not veto the exact
 * evidence which it reserved before entering its final write boundary.
 *
 * The caller proves ownership by comparing the evidence object with the one
 * attached to the active write operation. This helper then rechecks every
 * physical identity coordinate and the fresh closed headless frame. It never
 * authorizes a capture and it never applies to Codex.
 */
function resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence({
  proof,
  evidence,
  reservedEvidenceOwnedByCurrentOperation = false,
  terminalMatches = false,
  currentInputRevision,
  currentRunSeq,
  currentStopRevision = 0,
  currentLifecycleGeneration,
  currentMirrorGeneration,
  currentMirrorWriteSeq,
  currentMirrorFlushedSeq,
  currentMirrorSynchronizedOutputOpen,
  currentSynchronizedOutputGeneration,
  turnBusy = false,
  localCommandActive = false,
  compactActive = false,
  awaitingInput = false,
  stopping = false,
  rewindActive = false,
  startupGateReady = false,
  pickerActive = false,
  controlSurfaceActive = false,
  replacementActive = false,
} = {}) {
  if (agentInputObservationInvalidated(proof) || agentInputObservationInvalidated(evidence)
    || !sameFiniteNumber(proof?.terminalStopRevision ?? 0, currentStopRevision)
    || !sameFiniteNumber(evidence?.terminalStopRevision ?? 0, currentStopRevision)) {
    return { valid: false, reason: 'claude_input_observation_superseded' };
  }
  if (
    !evidence
    || evidence.success !== true
    || evidence.proofOutcome !== 'absent'
    || evidence.terminalIdentityStable !== true
    || evidence.editorReturnReady !== true
    || String(evidence.text || '').trim()
    || Number(evidence.images || 0) > 0
  ) {
    return { valid: false, reason: 'claude_reserved_exact_empty_evidence_required' };
  }
  if (reservedEvidenceOwnedByCurrentOperation !== true) {
    return { valid: false, reason: 'claude_reserved_exact_empty_evidence_not_owned' };
  }
  if (replacementActive || terminalMatches !== true) {
    return { valid: false, reason: 'claude_terminal_replacement_active' };
  }
  if (turnBusy) return { valid: false, reason: 'claude-turn-busy' };
  if (localCommandActive) return { valid: false, reason: 'claude-local-command-active' };
  if (compactActive) return { valid: false, reason: 'claude-compact-active' };
  if (awaitingInput) return { valid: false, reason: 'claude-question-active' };
  if (stopping) return { valid: false, reason: 'claude-stopping' };
  if (rewindActive) return { valid: false, reason: 'claude-rewind-active' };
  if (!startupGateReady) return { valid: false, reason: 'claude-startup-gate-not-ready' };
  if (pickerActive) return { valid: false, reason: 'claude-picker-active' };
  if (controlSurfaceActive) return { valid: false, reason: 'claude-control-surface-active' };

  if (!proof || !['found', 'unknown'].includes(proof.proofOutcome)) {
    return { valid: false, reason: 'claude_screen_ambiguity_required' };
  }
  if (!String(proof.source || '').startsWith('headless-main:')) {
    return { valid: false, reason: 'claude_headless_draft_proof_required' };
  }

  const inputIdentityMatches = sameFiniteNumber(evidence.inputRevision, currentInputRevision)
    && sameFiniteNumber(proof.inputRevision, currentInputRevision);
  if (!inputIdentityMatches) {
    return { valid: false, reason: 'claude_input_ownership_changed' };
  }
  const runIdentityMatches = sameFiniteNumber(evidence.terminalRunSeq, currentRunSeq)
    && sameFiniteNumber(proof.terminalRunSeq, currentRunSeq);
  if (!runIdentityMatches) {
    return { valid: false, reason: 'claude_terminal_run_changed' };
  }
  if (
    !isPresentIdentity(currentLifecycleGeneration)
    || evidence.terminalLifecycleGeneration !== currentLifecycleGeneration
    || proof.terminalLifecycleGeneration !== currentLifecycleGeneration
  ) {
    return { valid: false, reason: 'claude_terminal_lifecycle_changed' };
  }
  if (
    !isPresentIdentity(currentMirrorGeneration)
    || evidence.mirrorGeneration !== currentMirrorGeneration
    || proof.mirrorGeneration !== currentMirrorGeneration
  ) {
    return { valid: false, reason: 'claude_headless_generation_changed' };
  }

  // The capture frame predates Ctrl+G's editor-return redraw, so its sequence
  // need not equal the fresh frame. It must still be a real, closed, flushed
  // frame; terminal/input/mirror generations above carry its exact ownership
  // across that expected redraw.
  if (evidence.mirrorSynchronizedOutputOpen === true) {
    return { valid: false, reason: 'claude_exact_empty_capture_frame_open' };
  }
  if (
    !sameFiniteNumber(evidence.mirrorWriteSeq, evidence.mirrorFlushedSeq)
    || !isPresentIdentity(evidence.synchronizedOutputGeneration)
    || !Number.isFinite(Number(evidence.synchronizedOutputGeneration))
  ) {
    return { valid: false, reason: 'claude_exact_empty_capture_frame_unflushed' };
  }

  if (
    proof.mirrorSynchronizedOutputOpen === true
    || currentMirrorSynchronizedOutputOpen === true
  ) {
    return { valid: false, reason: 'claude_headless_frame_open' };
  }
  if (
    !sameFiniteNumber(currentMirrorWriteSeq, currentMirrorFlushedSeq)
    || !sameFiniteNumber(proof.mirrorWriteSeq, proof.mirrorFlushedSeq)
  ) {
    return { valid: false, reason: 'claude_headless_frame_not_flushed' };
  }
  if (
    !sameFiniteNumber(proof.mirrorWriteSeq, currentMirrorWriteSeq)
    || !sameFiniteNumber(proof.mirrorFlushedSeq, currentMirrorFlushedSeq)
    || !sameFiniteNumber(
      proof.synchronizedOutputGeneration,
      currentSynchronizedOutputGeneration,
    )
  ) {
    return { valid: false, reason: 'claude_headless_frame_changed' };
  }

  const resolvedProof = {
    ...proof,
    proofOutcome: 'absent',
    hasDraft: false,
    text: '',
    preview: '',
    source: 'headless-main:claude-composer:empty-exact-editor',
    proofReason: 'external-editor-empty-current-operation',
  };
  const decision = validateClaudeComposerWriteBoundary({
    proof: resolvedProof,
    terminalMatches,
    currentInputRevision,
    currentRunSeq,
    currentStopRevision,
    currentLifecycleGeneration,
    currentMirrorGeneration,
    currentMirrorWriteSeq,
    currentMirrorFlushedSeq,
    currentMirrorSynchronizedOutputOpen,
  });
  if (!decision.valid) return decision;
  return {
    valid: true,
    reason: 'claude_current_composer_empty_from_reserved_exact_evidence',
    proof: resolvedProof,
  };
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
  currentStopRevision = 0,
  currentLifecycleGeneration,
  currentMirrorGeneration,
}) {
  if (agentInputObservationInvalidated(proof)
    || !sameFiniteNumber(proof?.terminalStopRevision ?? 0, currentStopRevision)) {
    return { valid: false, reason: 'claude_input_observation_superseded_after_paste' };
  }
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
  classifyClaudeMissingPromptExactCaptureAdmission,
  cleanClaudeComposerText,
  hasConflictingPtyWriteOperation,
  isClaudeComposerStopLine,
  parseClaudeComposerCurrentFrame,
  reserveClaudeExactEmptyEvidence,
  resolveClaudeComposerWriteBoundaryWithReservedExactEmptyEvidence,
  summarizeClaudePromptSuffixStyle,
  validateClaudeComposerSubmitGeneration,
  validateClaudeComposerWriteBoundary,
};
