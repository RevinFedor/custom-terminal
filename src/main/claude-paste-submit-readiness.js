'use strict';

const STANDALONE_IMAGE_PATH_RE = /^(\s*(?:[-*+]\s+)?)(?:file:\/\/)?\/.+\.(?:png|jpe?g|gif|webp|bmp|tiff?)(\s*)$/i;
const IMAGE_CHIP_RE = /\[Image\s+#?\d+\]/giu;
const COMPLETE_PASTE_CHIP_RE = /\[Pasted(?:\s+(?:text|content))?(?:\s+#?\d+)?(?:\s+\+?\d+\s+(?:lines?|chars?))?\]/iu;
const PASTE_CHIP_PREFIX_RE = /\[Pasted(?:\s+(?:text|content))?/iu;
const PASTING_RE = /(?:^|\s)Pasting(?:…|\.\.\.)?(?:\s|$)/iu;
const EXTERNAL_EDITOR_RE = /Save and close editor to continue/iu;

function countMatches(value, expression) {
  return (String(value || '').match(expression) || []).length;
}

function expectedClaudePasteShape(text, presentationSnapshot = null) {
  let inlineImagePathCount = 0;
  const body = String(text || '')
    .split('\n')
    .map((line) => {
      const match = line.match(STANDALONE_IMAGE_PATH_RE);
      if (!match) return line;
      inlineImagePathCount += 1;
      return match[1].trimEnd();
    })
    .join('\n');
  const presentationImageCount = Array.isArray(presentationSnapshot?.imagePaths)
    ? presentationSnapshot.imagePaths.length
    : 0;
  return {
    expectedImageCount: Math.max(inlineImagePathCount, presentationImageCount),
    expectedHasText: body.trim().length > 0,
    transportLength: String(text || '').length,
  };
}

function rowNumber(line, fallback) {
  const row = Number(line?.row);
  return Number.isFinite(row) ? row : fallback;
}

function currentClaudeComposerBand(snapshot) {
  const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
  const baseY = Number(snapshot?.baseY);
  const cursorY = Number(snapshot?.cursorY);
  if (!Number.isInteger(baseY) || !Number.isInteger(cursorY)) {
    return { available: false, reason: 'cursor-unavailable', text: '', nearbyText: '' };
  }
  const cursorRow = baseY + cursorY;
  let promptIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const row = rowNumber(lines[index], index);
    if (row > cursorRow) break;
    if (/[❯›]/u.test(String(lines[index]?.text || ''))) promptIndex = index;
  }
  if (promptIndex < 0) {
    return { available: false, reason: 'active-prompt-not-found', text: '', nearbyText: '' };
  }
  const promptRow = rowNumber(lines[promptIndex], promptIndex);
  const bandLines = lines.filter((line, index) => {
    const row = rowNumber(line, index);
    return row >= promptRow && row <= cursorRow;
  });
  const nearbyLines = lines.filter((line, index) => {
    const row = rowNumber(line, index);
    return row >= promptRow - 2 && row <= cursorRow + 8;
  });
  return {
    available: true,
    reason: 'current-composer-band',
    promptRow,
    cursorRow,
    text: bandLines.map((line) => String(line?.text || '')).join('\n'),
    nearbyText: nearbyLines.map((line) => String(line?.text || '')).join('\n'),
  };
}

function classifyClaudePasteReadyFrame({
  snapshot,
  baselineCommittedFrameGeneration = 0,
  identityCurrent = false,
  expectedHasText = true,
  expectedImageCount = 0,
} = {}) {
  if (identityCurrent !== true) {
    return { action: 'cancel', reason: 'paste-owner-changed' };
  }
  if (
    !snapshot
    || snapshot.success !== true
    || snapshot.authoritativeFrameCommitted !== true
    || snapshot.liveSynchronizedOutputOpen === true
    || snapshot.synchronizedOutputOpen === true
    || Number(snapshot.writeSeq) !== Number(snapshot.flushedSeq)
  ) {
    return { action: 'wait', reason: 'committed-frame-required' };
  }
  const generation = Number(snapshot.committedFrameGeneration || 0);
  if (!Number.isInteger(generation)
    || generation <= Number(baselineCommittedFrameGeneration || 0)) {
    return { action: 'wait', reason: 'post-paste-frame-required' };
  }
  const band = currentClaudeComposerBand(snapshot);
  if (!band.available) return { action: 'wait', reason: band.reason };
  if (EXTERNAL_EDITOR_RE.test(band.nearbyText)) {
    return { action: 'wait', reason: 'external-editor-active' };
  }
  if (PASTING_RE.test(band.nearbyText)) {
    return { action: 'wait', reason: 'claude-still-pasting' };
  }

  const normalizedBandText = band.text.replace(/\s+/gu, ' ');
  const completePasteChip = COMPLETE_PASTE_CHIP_RE.test(normalizedBandText);
  if (PASTE_CHIP_PREFIX_RE.test(normalizedBandText) && !completePasteChip) {
    return { action: 'wait', reason: 'collapsed-paste-chip-incomplete' };
  }
  const imageCount = countMatches(band.text, IMAGE_CHIP_RE);
  if (imageCount < Number(expectedImageCount || 0)) {
    return {
      action: 'wait',
      reason: 'expected-image-chips-pending',
      expectedImageCount: Number(expectedImageCount || 0),
      observedImageCount: imageCount,
    };
  }
  const collapsedPaste = completePasteChip;
  const residualText = band.text
    .replace(/^[\s\S]*?[❯›]\s*/u, '')
    .replace(IMAGE_CHIP_RE, ' ')
    .replace(COMPLETE_PASTE_CHIP_RE, ' ')
    .replace(/[▌█]/gu, '')
    .trim();
  const inlineText = residualText.length > 0;
  const hasRequiredTextCarrier = expectedHasText !== true || collapsedPaste || inlineText;
  if (!hasRequiredTextCarrier) {
    return { action: 'wait', reason: 'final-text-carrier-pending' };
  }
  if (!expectedHasText && Number(expectedImageCount || 0) === 0) {
    return { action: 'wait', reason: 'empty-prompt-not-submittable' };
  }
  const form = collapsedPaste
    ? (imageCount > 0 ? 'images-and-collapsed-paste' : 'collapsed-paste')
    : inlineText
      ? (imageCount > 0 ? 'images-and-inline-text' : 'inline-text')
      : 'images-only';
  return {
    action: 'ready',
    reason: 'final-claude-composer-form',
    form,
    committedFrameGeneration: generation,
    observedImageCount: imageCount,
  };
}

function planClaudePostEnterRetry({
  pasteReadyProof,
  capture,
  transcriptRead,
  enterRetryCount = 0,
} = {}) {
  if (Number(enterRetryCount || 0) > 0) {
    return { action: 'none', reason: 'enter-retry-already-used' };
  }
  if (pasteReadyProof?.ready !== true) {
    return { action: 'none', reason: 'paste-ready-proof-missing' };
  }
  if (transcriptRead?.success !== true || Number(transcriptRead.userRecordCount || 0) !== 0) {
    return { action: 'none', reason: 'provider-user-turn-not-excluded' };
  }
  if (
    capture?.success !== true
    || capture?.editorReturnReady !== true
    || capture?.terminalIdentityStable !== true
  ) {
    return { action: 'none', reason: 'exact-draft-capture-unavailable' };
  }
  for (const field of ['terminalRunSeq', 'terminalLifecycleGeneration', 'mirrorGeneration']) {
    if (!pasteReadyProof[field] || capture[field] !== pasteReadyProof[field]) {
      return { action: 'none', reason: 'paste-owner-changed-after-enter' };
    }
  }
  if (!Number.isFinite(Number(pasteReadyProof.inputRevision))
    || Number(capture.inputRevision) !== Number(pasteReadyProof.inputRevision) + 1) {
    return { action: 'none', reason: 'foreign-input-after-enter' };
  }
  const text = String(capture.text || '');
  const images = Number(capture.images || 0);
  if (!text.trim() && images <= 0) {
    return { action: 'none', reason: 'draft-no-longer-present' };
  }
  if (images < Number(pasteReadyProof.expectedImageCount || 0)) {
    return { action: 'none', reason: 'captured-images-incomplete' };
  }
  return {
    action: 'retry-enter',
    reason: 'same-owned-draft-remained-without-user-turn',
    inputRevision: Number(capture.inputRevision),
    providerAcceptedText: text,
    providerAcceptedImageCount: images,
  };
}

module.exports = {
  classifyClaudePasteReadyFrame,
  currentClaudeComposerBand,
  expectedClaudePasteShape,
  planClaudePostEnterRetry,
};
