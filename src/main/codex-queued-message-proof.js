'use strict';

const crypto = require('crypto');
const {
  codexCanonicalUserMessageMatch,
  normalizeCodexPromptImageSlots,
} = require('./codex-prompt-audit');
const {
  extractCodexQueuedMessageProofs,
} = require('./terminal-history-preview');

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function queuedFrameLines(snapshot) {
  if (!snapshot || snapshot.success !== true) return [];
  return [
    ...(Array.isArray(snapshot.preViewportLines) ? snapshot.preViewportLines : []),
    ...(Array.isArray(snapshot.lines) ? snapshot.lines : []),
  ];
}

function matchesQueuedDisplayRows(expected, rows, imagePaths) {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  let offset = 0;
  const visibleRows = rows.slice();
  visibleRows[visibleRows.length - 1] = String(visibleRows.at(-1)).replace(/(?:…|\.{3})\s*$/u, '');
  for (const row of visibleRows) {
    const text = normalizeCodexPromptImageSlots(row, imagePaths);
    if (!text) continue;
    // Only a recorded display-row boundary may be a word break OR a break
    // inside a token. Spaces within a row still have to match exactly.
    if (offset > 0 && expected[offset] === ' ') offset += 1;
    if (!expected.startsWith(text, offset)) return false;
    offset += text.length;
  }
  return offset > 0 && offset < expected.length;
}

function codexQueuedMessageMatchesAudit(audit, actualText, {
  truncated = false, styleEvidence = false, textRows = null,
} = {}) {
  const expected = String(audit?.expectedText || '');
  const actual = String(actualText || '');
  if (!expected || !actual) return null;
  if (expected === actual) return { reason: 'codex_tui_queue_exact' };
  const canonical = codexCanonicalUserMessageMatch(audit, actual);
  if (canonical) return { reason: canonical.reason };
  if (!truncated || !styleEvidence) return null;
  // Product-approved queue-stage evidence: the CLI intentionally paints only
  // a prefix. This is NOT full-content verification and never closes the JSONL
  // audit. Equal visible prefixes may match; causal frame/ownership/count
  // requirements still identify a newly queued submission, never a resend.
  const visible = actual.replace(/(?:…|\.{3})\s*$/u, '').trim();
  if (!visible) return null;
  const imagePaths = Array.isArray(audit?.expectedImagePaths) ? audit.expectedImagePaths : [];
  const expectedPreview = normalizeCodexPromptImageSlots(expected, imagePaths);
  const visiblePreview = normalizeCodexPromptImageSlots(visible, imagePaths);
  const flatPrefix = visiblePreview && expectedPreview.length > visiblePreview.length
    && expectedPreview.startsWith(visiblePreview);
  if (!flatPrefix && !matchesQueuedDisplayRows(expectedPreview, textRows, imagePaths)) return null;
  return { reason: 'codex_tui_queue_visible_prefix' };
}

function matchingQueuedMessages(snapshot, audit) {
  return extractCodexQueuedMessageProofs(queuedFrameLines(snapshot))
    .flatMap((proof) => {
      const match = codexQueuedMessageMatchesAudit(audit, proof.text, proof);
      return match ? [{ ...proof, matchReason: match.reason }] : [];
    });
}

function captureCodexQueuedMessageBaseline(snapshot, audit) {
  if (snapshot?.success !== true
    || snapshot?.authoritativeFrameCommitted !== true
    || typeof snapshot?.mirrorGeneration !== 'string'
    || !Number.isFinite(Number(snapshot?.committedFrameGeneration))) {
    return Object.freeze({ usable: false, reason: 'baseline-frame-unavailable' });
  }
  const matches = matchingQueuedMessages(snapshot, audit);
  return Object.freeze({
    usable: true,
    reason: 'baseline-captured',
    mirrorGeneration: snapshot.mirrorGeneration,
    committedFrameGeneration: Number(snapshot.committedFrameGeneration),
    writeSeq: Number(snapshot.writeSeq || 0),
    matchingCount: matches.length,
    queueCount: extractCodexQueuedMessageProofs(queuedFrameLines(snapshot)).length,
  });
}

function classifyCodexQueuedMessageFrame({
  baseline,
  snapshot,
  audit,
  identity,
} = {}) {
  if (audit?.queuedAtSubmit !== true || audit?.submitWritten !== true) {
    return { accepted: false, reason: 'not-a-submitted-busy-send' };
  }
  if (!baseline?.usable) return { accepted: false, reason: 'baseline-unavailable' };
  if (snapshot?.success !== true || snapshot?.authoritativeFrameCommitted !== true) {
    return { accepted: false, reason: 'frame-not-committed' };
  }
  if (snapshot.mirrorGeneration !== baseline.mirrorGeneration
    || identity?.mirrorGeneration !== baseline.mirrorGeneration) {
    return { accepted: false, reason: 'mirror-generation-changed' };
  }
  if (Number(snapshot.committedFrameGeneration) <= Number(baseline.committedFrameGeneration)) {
    return { accepted: false, reason: 'frame-not-after-enter-baseline' };
  }
  if (identity?.sameTerminal !== true
    || Number(identity?.runSeq) !== Number(audit?.enterRunSeq)
    || String(identity?.lifecycleGeneration || '') !== String(audit?.enterLifecycleGeneration || '')
    || Number(identity?.inputRevision) !== Number(audit?.enterInputRevision)
    || identity?.writeQueueOwned !== true) {
    return { accepted: false, reason: 'post-enter-identity-changed' };
  }
  const matches = matchingQueuedMessages(snapshot, audit);
  const baselineCount = Number(baseline.matchingCount || 0);
  if (matches.length <= baselineCount) {
    return { accepted: false, reason: 'matching-queue-count-did-not-grow' };
  }
  const matched = matches[matches.length - 1];
  if (matched.matchReason === 'codex_tui_queue_visible_prefix'
    && extractCodexQueuedMessageProofs(queuedFrameLines(snapshot)).length <= Number(baseline.queueCount || 0)) {
    return { accepted: false, reason: 'queue-count-did-not-grow' };
  }
  const sourceIdentity = [
    'codex-tui-queue',
    baseline.mirrorGeneration,
    Number(identity.runSeq),
    Number(identity.inputRevision),
    Number(snapshot.committedFrameGeneration),
    matches.length,
    fingerprint(matched.text),
  ].join(':');
  return {
    accepted: true,
    reason: matched.matchReason,
    sourceIdentity,
    text: matched.text,
    textHash: fingerprint(matched.text),
    matchingCount: matches.length,
    baselineMatchingCount: baselineCount,
    committedFrameGeneration: Number(snapshot.committedFrameGeneration),
    writeSeq: Number(snapshot.writeSeq || 0),
    startRow: matched.startRow,
    endRow: matched.endRow,
  };
}

module.exports = {
  captureCodexQueuedMessageBaseline,
  classifyCodexQueuedMessageFrame,
  codexQueuedMessageMatchesAudit,
  matchingQueuedMessages,
};
