'use strict';

const {
  codexCanonicalUserMessageMatch,
} = require('./codex-prompt-audit');

const RETRYABLE_RECEIPT_STATES = new Set(['audit-pending', 'delivery-unknown']);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function refusal(reason, extra = {}) {
  return { retry: false, reason, ...extra };
}

function classifyCodexPostEnterRetryAdmission({
  timeoutResult,
  audit,
  durableRecord,
  terminalSame,
  currentRunSeq,
  currentLifecycleGeneration,
  currentInputRevision,
  turnBusy,
  writeQueueOwned,
} = {}) {
  if (timeoutResult?.error !== 'codex_user_message_audit_timeout') {
    return refusal('not-codex-audit-timeout');
  }
  if (!audit || audit.submitWritten !== true || audit.finished === true) {
    return refusal('audit-not-pending-after-enter');
  }
  if (Number(audit.enterRetryCount || 0) >= 1) {
    return refusal('enter-retry-already-used');
  }
  if (!durableRecord || durableRecord.attemptId !== audit.sendAttemptId) {
    return refusal('durable-attempt-changed');
  }
  if (!RETRYABLE_RECEIPT_STATES.has(durableRecord.state)) {
    return refusal('durable-attempt-not-unresolved');
  }
  if (terminalSame !== true) return refusal('terminal-generation-changed');
  if (writeQueueOwned !== true) return refusal('newer-pty-input-queued');
  if (turnBusy === true) return refusal('turn-started-before-retry');
  if (Number(currentRunSeq) !== Number(audit.enterRunSeq)) {
    return refusal('terminal-run-changed');
  }
  if (cleanString(currentLifecycleGeneration) !== cleanString(audit.enterLifecycleGeneration)) {
    return refusal('terminal-lifecycle-changed');
  }
  if (Number(currentInputRevision) !== Number(audit.enterInputRevision)) {
    return refusal('input-ownership-changed');
  }
  return {
    retry: true,
    reason: 'exact-capture-required',
    captureInputRevision: Number(currentInputRevision),
  };
}

function sameOrderedPaths(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every((value, index) => value === actual[index]);
}

function sameOrderedImageRefs(expected, actual) {
  if (expected.length !== actual.length) return false;
  return expected.every((left, index) => {
    const right = actual[index] || {};
    const leftAsset = cleanString(left?.assetId);
    const rightAsset = cleanString(right?.assetId);
    if (leftAsset && rightAsset) return leftAsset === rightAsset;
    const leftPath = cleanString(left?.path || left);
    const rightPath = cleanString(right?.path || right);
    return !!leftPath && leftPath === rightPath;
  });
}

function classifyCodexPostEnterRetryCapture({
  audit,
  durableRecord,
  capture,
  terminalSame,
  turnBusy,
  currentInputRevision,
  captureInputRevision,
  currentRunSeq,
  currentLifecycleGeneration,
  writeQueueOwned,
} = {}) {
  if (!audit || audit.finished === true) return refusal('audit-finished-during-capture');
  if (!durableRecord || durableRecord.attemptId !== audit.sendAttemptId) {
    return refusal('durable-attempt-changed-during-capture');
  }
  if (!RETRYABLE_RECEIPT_STATES.has(durableRecord.state)) {
    return refusal('durable-attempt-settled-during-capture');
  }
  if (terminalSame !== true) return refusal('terminal-generation-changed-during-capture');
  if (writeQueueOwned !== true) return refusal('newer-pty-input-queued-during-capture');
  if (turnBusy === true) return refusal('turn-started-during-capture');
  if (!capture || capture.success !== true || capture.terminalIdentityStable !== true) {
    return refusal('exact-capture-unavailable');
  }
  if (Number(currentRunSeq) !== Number(audit.enterRunSeq)
    || Number(capture.terminalRunSeq) !== Number(audit.enterRunSeq)) {
    return refusal('terminal-run-changed-during-capture');
  }
  if (cleanString(currentLifecycleGeneration) !== cleanString(audit.enterLifecycleGeneration)
    || cleanString(capture.terminalLifecycleGeneration) !== cleanString(audit.enterLifecycleGeneration)) {
    return refusal('terminal-lifecycle-changed-during-capture');
  }
  const expectedCaptureRevision = Number(captureInputRevision) + 1;
  if (!Number.isFinite(expectedCaptureRevision)
    || Number(capture.inputRevision) !== expectedCaptureRevision
    || Number(currentInputRevision) !== expectedCaptureRevision) {
    return refusal('capture-input-transition-not-owned');
  }

  const expectedText = String(audit.expectedText || '');
  const capturedText = String(capture.text || '');
  if (!expectedText || !capturedText) return refusal('captured-draft-empty');
  const expectedImagePaths = (Array.isArray(audit.expectedImagePaths)
    ? audit.expectedImagePaths
    : []).filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
  const capturedImageCount = Number(capture.images || 0);
  if (capturedImageCount !== expectedImagePaths.length) {
    return refusal('captured-image-count-changed');
  }
  const capturedImageRefs = Array.isArray(capture.imagePaths) ? capture.imagePaths : [];
  const capturedImagePaths = capturedImageRefs
    .flatMap((value) => {
      const imagePath = cleanString(value?.path || value);
      return imagePath ? [imagePath] : [];
    });
  const expectedImageRefs = Array.isArray(audit.expectedImageRefs)
    ? audit.expectedImageRefs
    : [];
  const capturedIdentityMatches = expectedImageRefs.length > 0
    ? sameOrderedImageRefs(expectedImageRefs, capturedImageRefs)
    : sameOrderedPaths(expectedImagePaths, capturedImagePaths);
  if (capturedImagePaths.length > 0 && !capturedIdentityMatches) {
    return refusal('captured-image-identity-changed');
  }
  // With more than one attachment, unresolved slot identities cannot prove
  // that the user did not reorder the images after the first Enter. A single
  // slot remains exact when the input revision and image count are unchanged.
  if (expectedImagePaths.length > 1 && capturedImagePaths.length !== expectedImagePaths.length) {
    return refusal('multiple-image-identity-unresolved');
  }

  const exact = capturedText === expectedText;
  const canonical = exact ? null : codexCanonicalUserMessageMatch({
    expectedText,
    expectedImagePaths,
  }, capturedText);
  if (!exact && !canonical) return refusal('captured-draft-does-not-match-prompt');
  return {
    retry: true,
    reason: exact ? 'exact-draft-still-in-composer' : canonical.reason,
    canonicalized: !exact,
  };
}

module.exports = {
  RETRYABLE_RECEIPT_STATES,
  classifyCodexPostEnterRetryAdmission,
  classifyCodexPostEnterRetryCapture,
};
