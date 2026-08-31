'use strict';

function normalizeCompactCommand(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function inspectCodexCompactPostEnterFrame({
  snapshot = null,
  draftState = null,
  expectedCommand = '/compact',
  afterWriteSeq = null,
} = {}) {
  if (snapshot?.success !== true) {
    return { owned: false, reason: 'compact-post-enter-screen-unavailable' };
  }
  const writeSeq = Number(snapshot.writeSeq);
  const flushedSeq = Number(snapshot.flushedSeq);
  const hasBaseline = afterWriteSeq !== null
    && afterWriteSeq !== undefined
    && Number.isFinite(Number(afterWriteSeq));
  const baseline = hasBaseline ? Number(afterWriteSeq) : null;
  if (snapshot.authoritativeFrameCommitted !== true
    || snapshot.synchronizedOutputOpen === true
    || !Number.isFinite(writeSeq)
    || flushedSeq !== writeSeq) {
    return { owned: false, reason: 'compact-post-enter-frame-not-committed' };
  }
  if (baseline !== null && writeSeq <= baseline) {
    return { owned: false, reason: 'compact-post-enter-frame-not-newer' };
  }
  if (draftState?.success !== true
    || !String(draftState?.source || '').startsWith('headless-main:')
    || draftState?.hasDraft !== true) {
    return {
      owned: false,
      reason: draftState?.hasDraft === false
        ? 'compact-command-left-composer'
        : 'compact-post-enter-draft-unproven',
      writeSeq,
    };
  }
  const expected = normalizeCompactCommand(expectedCommand);
  const current = normalizeCompactCommand(draftState.preview);
  if (expected !== '/compact' || current !== expected) {
    return {
      owned: false,
      reason: 'compact-post-enter-draft-changed',
      writeSeq,
      currentDraft: current,
    };
  }
  return {
    owned: true,
    reason: 'exact-owned-compact-still-in-composer',
    writeSeq,
    committedFrameGeneration: Number.isFinite(Number(snapshot.committedFrameGeneration))
      ? Number(snapshot.committedFrameGeneration)
      : null,
    currentDraft: current,
  };
}

function planCodexCompactPostEnterAction({
  startConfirmed = false,
  identityCurrent = false,
  identityReason = 'compact-submit-identity-changed',
  pendingCurrent = false,
  frameProof = null,
  allowSecondEnter = false,
} = {}) {
  if (startConfirmed) {
    return {
      action: 'confirmed',
      writeSecondEnter: false,
      success: true,
      reason: 'causal-compact-task-started',
    };
  }
  if (!identityCurrent) {
    return {
      action: 'unconfirmed',
      writeSecondEnter: false,
      success: false,
      reason: identityReason,
    };
  }
  if (!pendingCurrent) {
    return {
      action: 'unconfirmed',
      writeSecondEnter: false,
      success: false,
      reason: 'compact-pending-owner-changed',
    };
  }
  if (allowSecondEnter && frameProof?.owned === true) {
    return {
      action: 'second-enter',
      writeSecondEnter: true,
      success: false,
      reason: frameProof.reason || 'exact-owned-compact-still-in-composer',
    };
  }
  return {
    action: 'unconfirmed',
    writeSecondEnter: false,
    success: false,
    reason: frameProof?.reason || 'compact-start-unconfirmed',
  };
}

function buildCodexCompactUnconfirmedResult({
  reason = 'codex_compact_start_unconfirmed',
  enterCount = 0,
  frameProof = null,
} = {}) {
  const normalizedEnterCount = Math.max(0, Number.isInteger(Number(enterCount))
    ? Number(enterCount)
    : 0);
  const manualTakeover = reason === 'terminal-input-changed'
    || reason === 'codex_input_ownership_changed';
  return {
    success: false,
    error: reason,
    submitted: normalizedEnterCount > 0,
    slashInserted: true,
    compactStartConfirmed: false,
    deliveryUnconfirmed: normalizedEnterCount > 0,
    compactEnterCount: normalizedEnterCount,
    manualTakeover,
    admissionRejected: manualTakeover,
    postEnterProof: frameProof,
  };
}

module.exports = {
  buildCodexCompactUnconfirmedResult,
  inspectCodexCompactPostEnterFrame,
  planCodexCompactPostEnterAction,
};
