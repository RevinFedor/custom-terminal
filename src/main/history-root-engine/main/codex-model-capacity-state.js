'use strict';

const crypto = require('node:crypto');
const {
  hasCodexComposerPromptGlyph,
  parseCodexVerifiedComposerFooter,
  selectCodexCurrentInteractiveFrameText,
} = require('./codex-tui-readiness');

const CODEX_MODEL_CAPACITY_CODE = 'codex_model_at_capacity';
const CODEX_MODEL_CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.';

function logicalVisibleLines(lines) {
  const result = [];
  for (const row of Array.isArray(lines) ? lines : []) {
    const text = String(row?.text || '');
    if (row?.wrapped === true && result.length > 0) {
      const current = result[result.length - 1];
      current.text += ' ' + text;
      current.endRow = Number.isFinite(Number(row?.row)) ? Number(row.row) : current.endRow;
      current.hasNonDefaultFg ||= row?.hasNonDefaultFg === true;
      continue;
    }
    result.push({
      text,
      startRow: Number.isFinite(Number(row?.row)) ? Number(row.row) : null,
      endRow: Number.isFinite(Number(row?.row)) ? Number(row.row) : null,
      hasNonDefaultFg: row?.hasNonDefaultFg === true,
    });
  }
  return result;
}

function normalizeCodexModelCapacityLine(text) {
  return String(text || '')
    .trim()
    .replace(/^[⚠!]+\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Capacity is accepted only from one fully committed terminal frame that also
 * contains the live Codex composer. The exact sentence alone is not enough:
 * it remains in scrollback and must not terminate a later turn.
 */
function inspectCodexModelCapacityFrame(snapshot) {
  if (
    !snapshot
    || snapshot.success !== true
    || snapshot.authoritativeFrameCommitted !== true
    || snapshot.liveSynchronizedOutputOpen === true
    || Number(snapshot.writeSeq) !== Number(snapshot.flushedSeq)
  ) {
    return Object.freeze({ capacity: false, reason: 'committed-frame-required' });
  }

  const currentFrameText = selectCodexCurrentInteractiveFrameText(
    snapshot.lines,
    snapshot.codexActivePrompt?.row,
  );
  if (!hasCodexComposerPromptGlyph(currentFrameText)
    || !parseCodexVerifiedComposerFooter(currentFrameText)) {
    return Object.freeze({ capacity: false, reason: 'ready-composer-required' });
  }

  // The same warning can still be visible in scrollback when the retry fails
  // again. Inspect newest-to-oldest so a fresh lower row wins over the baseline
  // occurrence instead of being hidden by it.
  for (const line of logicalVisibleLines(snapshot.lines).reverse()) {
    const message = normalizeCodexModelCapacityLine(line.text);
    if (message !== CODEX_MODEL_CAPACITY_MESSAGE) continue;
    if (line.hasNonDefaultFg !== true) {
      return Object.freeze({
        capacity: false,
        reason: 'capacity-style-unproven',
        candidateCode: CODEX_MODEL_CAPACITY_CODE,
      });
    }
    return Object.freeze({
      capacity: true,
      code: CODEX_MODEL_CAPACITY_CODE,
      outcome: 'provider_error',
      message,
      startRow: line.startRow,
      endRow: line.endRow,
      fingerprint: crypto.createHash('sha256').update(message, 'utf8').digest('hex'),
    });
  }

  return Object.freeze({ capacity: false, reason: 'capacity-surface-absent' });
}

function decideCodexModelCapacityObservation({
  identityCurrent,
  committedFrameGeneration,
  armedCommittedFrameGeneration,
  capacity,
  baselineFingerprint = null,
  baselineStartRow = null,
  sawNonCapacityFrame = false,
} = {}) {
  if (identityCurrent !== true) return { action: 'cancel', reason: 'attempt-identity-changed' };
  if (!Number.isInteger(Number(committedFrameGeneration))
    || Number(committedFrameGeneration) <= Number(armedCommittedFrameGeneration || 0)) {
    return { action: 'wait', reason: 'frame-not-newer-than-attempt' };
  }
  if (capacity?.capacity !== true) {
    return { action: 'observe-non-capacity', reason: capacity?.reason || 'capacity-absent' };
  }
  const capacityIsSameBaselineRow = baselineFingerprint
    && baselineFingerprint === capacity.fingerprint
    && (
      baselineStartRow === null
      || baselineStartRow === undefined
      || Number(baselineStartRow) === Number(capacity.startRow)
    );
  if (capacityIsSameBaselineRow
    && sawNonCapacityFrame !== true) {
    return { action: 'wait', reason: 'capacity-only-in-baseline-scrollback' };
  }
  return { action: 'accept', reason: 'fresh-capacity-with-ready-composer' };
}

module.exports = {
  CODEX_MODEL_CAPACITY_CODE,
  CODEX_MODEL_CAPACITY_MESSAGE,
  decideCodexModelCapacityObservation,
  inspectCodexModelCapacityFrame,
  logicalVisibleLines,
  normalizeCodexModelCapacityLine,
};
