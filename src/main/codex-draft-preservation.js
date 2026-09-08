'use strict';

function exactCodexDraftSnapshot(capture) {
  if (capture?.success !== true || capture.editorReturnReady !== true
    || capture.terminalIdentityStable !== true
    || typeof capture.text !== 'string') return null;
  const images = Number(capture.images || 0);
  const imagePaths = Array.isArray(capture.imagePaths) ? capture.imagePaths : [];
  if (!Number.isSafeInteger(images) || images < 0 || imagePaths.length !== images) return null;
  const attachments = imagePaths.map(ref => ({
    id: Number(ref.id),
    identity: ref.assetId ? 'asset:' + ref.assetId : (ref.path ? 'path:' + ref.path : null),
    available: ref.availability !== 'missing' && ref.missing !== true,
  }));
  if (attachments.some(ref => !Number.isSafeInteger(ref.id) || !ref.identity || !ref.available)) return null;
  if (new Set(attachments.map(ref => ref.id)).size !== images) return null;
  return {
    capturedText: typeof capture.capturedText === 'string' ? capture.capturedText : capture.text,
    text: capture.text,
    images,
    imagePaths: imagePaths.map(ref => ({ ...ref })),
    attachments: attachments.sort((a, b) => a.id - b.id),
    captureOperationId: capture.captureOperationId || null,
  };
}

function compareCodexDraftSnapshots(expected, capture) {
  const actual = exactCodexDraftSnapshot(capture);
  if (!expected || !actual) return { matched: false, reason: 'codex_draft_exact_proof_unavailable' };
  if (expected.capturedText !== actual.capturedText) {
    return { matched: false, reason: 'codex_draft_text_changed' };
  }
  if (expected.images !== actual.images
    || JSON.stringify(expected.attachments) !== JSON.stringify(actual.attachments)) {
    return { matched: false, reason: 'codex_draft_attachments_changed' };
  }
  return { matched: true, reason: 'codex_draft_full_snapshot_matches' };
}

function codexNativeDraftTransfer(tabId, snapshot) {
  if (!tabId || !snapshot?.captureOperationId) return null;
  return {
    id: 'codex-native-stash:' + snapshot.captureOperationId,
    tabId,
    provider: 'codex',
    source: 'codex-native-stash',
    text: snapshot.text,
    images: snapshot.images,
    imagePaths: snapshot.imagePaths.map(ref => ({ ...ref })),
  };
}

function codexExactCaptureOwnedRevision(capture, beforeRevision, currentRevision) {
  const capturedRevision = Number(capture?.inputRevision);
  if (capture?.success !== true || capture.editorReturnReady !== true
    || capture.terminalIdentityStable !== true
    || !Number.isSafeInteger(beforeRevision)
    || capturedRevision !== beforeRevision + 1
    || capturedRevision !== currentRevision) return null;
  return capturedRevision;
}

module.exports = {
  exactCodexDraftSnapshot,
  compareCodexDraftSnapshots,
  codexNativeDraftTransfer,
  codexExactCaptureOwnedRevision,
};
