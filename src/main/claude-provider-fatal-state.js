'use strict';

const crypto = require('node:crypto');

const CLAUDE_PROVIDER_FATAL_CODES = Object.freeze({
  CONTEXT_LIMIT_REACHED: 'claude_context_limit_reached',
});

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

function normalizeClaudeMessageResponseLine(text) {
  return String(text || '')
    .trim()
    .replace(/^(?:[●•]\s*)?⎿\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function inspectClaudeProviderFatalFrame(snapshot) {
  if (
    !snapshot
    || snapshot.success !== true
    || snapshot.authoritativeFrameCommitted !== true
    || snapshot.liveSynchronizedOutputOpen === true
    || Number(snapshot.writeSeq) !== Number(snapshot.flushedSeq)
  ) {
    return Object.freeze({ fatal: false, reason: 'committed-frame-required' });
  }

  for (const line of logicalVisibleLines(snapshot.lines)) {
    const message = normalizeClaudeMessageResponseLine(line.text);
    if (!/^Context limit reached · \/compact or \/clear to continue(?: · .+)?$/u.test(message)) {
      continue;
    }
    if (line.hasNonDefaultFg !== true) {
      return Object.freeze({
        fatal: false,
        reason: 'fatal-style-unproven',
        candidateCode: CLAUDE_PROVIDER_FATAL_CODES.CONTEXT_LIMIT_REACHED,
      });
    }
    return Object.freeze({
      fatal: true,
      code: CLAUDE_PROVIDER_FATAL_CODES.CONTEXT_LIMIT_REACHED,
      outcome: 'provider_error',
      message,
      startRow: line.startRow,
      endRow: line.endRow,
      fingerprint: crypto.createHash('sha256').update(message, 'utf8').digest('hex'),
    });
  }

  return Object.freeze({ fatal: false, reason: 'known-fatal-surface-absent' });
}

module.exports = {
  CLAUDE_PROVIDER_FATAL_CODES,
  inspectClaudeProviderFatalFrame,
  logicalVisibleLines,
  normalizeClaudeMessageResponseLine,
};
