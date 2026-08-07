'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  readClaudeUserRecords,
  selectClaudePendingPromptAudit,
} = require('./claude-prompt-audit');
const {
  consumeCodexUserMessageAuditChunk,
  selectCodexPendingPromptAudit,
} = require('./codex-prompt-audit');
const {
  CODEX_CANONICAL_REASONS,
  agentPromptAuditMatchesHash,
} = require('./agent-prompt-audit-identity');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

const DEFAULT_STARTUP_AUDIT_READ_BYTES = 2 * 1024 * 1024;
const MAX_STARTUP_AUDIT_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_STARTUP_RECONCILE_RECORDS = 256;
const MAX_STARTUP_RECONCILE_RECORDS = 2_048;
const UNRESOLVED_STATES = new Set(['audit-pending', 'delivery-unknown']);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeIdentity(record) {
  return {
    operationKey: cleanString(record?.operationKey) || null,
    attemptId: cleanString(record?.attemptId) || null,
    provider: cleanString(record?.provider).toLowerCase() || null,
    sessionId: cleanString(record?.sessionId) || null,
  };
}

function decision(record, value, reason, extra = {}) {
  return {
    ...safeIdentity(record),
    decision: value,
    reason,
    audit: null,
    ...extra,
  };
}

function unknown(record, reason, extra = {}) {
  return decision(record, 'unknown', reason, extra);
}

function absent(record, reason, extra = {}) {
  return decision(record, 'absent', reason, extra);
}

function found(record, reason, audit, extra = {}) {
  return decision(record, 'found', reason, {
    ...extra,
    audit,
  });
}

function normalizeReadLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_STARTUP_AUDIT_READ_BYTES;
  }
  return Math.min(parsed, MAX_STARTUP_AUDIT_READ_BYTES);
}

function normalizeRecordLimit(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_STARTUP_RECONCILE_RECORDS;
  }
  return Math.min(parsed, MAX_STARTUP_RECONCILE_RECORDS);
}

function nonNegativeSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function promptTextFromReceipt(record) {
  const receipt = record?.receipt;
  if (!receipt || typeof receipt !== 'object') return null;
  if (typeof receipt.transportText === 'string') {
    return { text: receipt.transportText, field: 'transportText' };
  }
  if (typeof receipt.promptText === 'string') {
    return { text: receipt.promptText, field: 'promptText' };
  }
  return null;
}

function normalizeUnresolvedRecord(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, reason: 'receipt-record-missing' };
  }
  if (!UNRESOLVED_STATES.has(record.state)) {
    return { ok: false, reason: 'receipt-state-not-unresolved' };
  }
  const operationKey = cleanString(record.operationKey);
  const attemptId = cleanString(record.attemptId);
  const provider = cleanString(record.provider).toLowerCase();
  const sessionId = cleanString(record.sessionId);
  const promptHash = cleanString(record.promptHash);
  const promptLength = nonNegativeSafeInteger(record.promptLength);
  if (!operationKey || !attemptId || !sessionId || !promptHash || promptLength === null) {
    return { ok: false, reason: 'receipt-identity-incomplete' };
  }
  if (provider !== 'claude' && provider !== 'codex') {
    return { ok: false, reason: 'receipt-provider-unsupported' };
  }
  const prompt = promptTextFromReceipt(record);
  if (!prompt) return { ok: false, reason: 'receipt-prompt-text-missing' };
  if (prompt.text.length !== promptLength) {
    return { ok: false, reason: 'receipt-prompt-length-mismatch' };
  }
  if (promptAuditFingerprint(prompt.text) !== promptHash) {
    return { ok: false, reason: 'receipt-prompt-hash-mismatch' };
  }
  if (!record.transcriptBoundary || typeof record.transcriptBoundary !== 'object') {
    return { ok: false, reason: 'transcript-boundary-missing' };
  }
  return {
    ok: true,
    value: {
      record,
      operationKey,
      attemptId,
      provider,
      sessionId,
      promptHash,
      promptLength,
      promptText: prompt.text,
      promptTextField: prompt.field,
      boundary: record.transcriptBoundary,
    },
  };
}

function resolveExactPath(value) {
  const cleaned = cleanString(value);
  return cleaned ? path.resolve(cleaned) : null;
}

function foreignPathHint(record, exactPath) {
  const receipt = record?.receipt && typeof record.receipt === 'object'
    ? record.receipt
    : {};
  const boundary = record?.transcriptBoundary && typeof record.transcriptBoundary === 'object'
    ? record.transcriptBoundary
    : {};
  const hints = [
    record?.transcriptPath,
    record?.filePath,
    receipt.transcriptPath,
    receipt.filePath,
    receipt.linkedTranscriptPath,
    receipt.linkedFilePath,
    boundary.linkedTranscriptPath,
    boundary.linkedFilePath,
  ];
  for (const hint of hints) {
    const resolved = resolveExactPath(hint);
    if (resolved && resolved !== exactPath) return resolved;
  }
  return null;
}

function validateClaudeBoundary(context) {
  const { boundary, record, sessionId } = context;
  const transcriptPath = resolveExactPath(boundary.transcriptPath);
  const fileSize = nonNegativeSafeInteger(boundary.fileSize);
  if (boundary.available !== true || !transcriptPath || fileSize === null) {
    return { ok: false, reason: 'transcript-boundary-unavailable' };
  }
  if (boundary.endedWithNewline !== true) {
    return { ok: false, reason: 'transcript-boundary-partial-line' };
  }
  const boundarySessionId = cleanString(boundary.sessionId);
  if (boundarySessionId && boundarySessionId !== sessionId) {
    return { ok: false, reason: 'transcript-boundary-foreign-session' };
  }
  const foreignPath = foreignPathHint(record, transcriptPath);
  if (foreignPath) {
    return { ok: false, reason: 'transcript-boundary-foreign-file', foreignPath };
  }
  return { ok: true, transcriptPath, fileSize };
}

function validateCodexBoundary(context) {
  const { boundary, record, sessionId } = context;
  const filePath = resolveExactPath(boundary.filePath);
  const fileSize = nonNegativeSafeInteger(boundary.fileSize);
  const boundarySessionId = cleanString(boundary.sessionId);
  if (!filePath || fileSize === null || !boundarySessionId) {
    return { ok: false, reason: 'transcript-boundary-unavailable' };
  }
  if (boundarySessionId !== sessionId) {
    return { ok: false, reason: 'transcript-boundary-foreign-session' };
  }
  const foreignPath = foreignPathHint(record, filePath);
  if (foreignPath) {
    return { ok: false, reason: 'transcript-boundary-foreign-file', foreignPath };
  }
  return { ok: true, transcriptPath: filePath, fileSize };
}

async function readFully(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const read = await handle.read(buffer, total, length - total, position + total);
    if (read.bytesRead <= 0) break;
    total += read.bytesRead;
  }
  return { buffer: buffer.subarray(0, total), bytesRead: total };
}

function validateCompleteJsonl(text) {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch {
      return { ok: false, reason: 'transcript-jsonl-malformed', line: index + 1 };
    }
  }
  return { ok: true };
}

async function readExactPostBoundaryRange(transcriptPath, boundaryOffset, maxReadBytes) {
  let handle = null;
  try {
    handle = await fs.promises.open(transcriptPath, 'r');
    const before = await handle.stat();
    if (!before.isFile()) {
      return { ok: false, reason: 'transcript-not-regular-file' };
    }
    const fileSize = nonNegativeSafeInteger(before.size);
    if (fileSize === null || fileSize < boundaryOffset) {
      return { ok: false, reason: 'transcript-truncated-before-boundary' };
    }
    const postBoundaryBytes = fileSize - boundaryOffset;
    if (postBoundaryBytes > maxReadBytes) {
      return {
        ok: false,
        reason: 'transcript-post-boundary-range-truncated',
        fileSize,
        postBoundaryBytes,
        maxReadBytes,
      };
    }
    if (boundaryOffset > 0) {
      const probe = await readFully(handle, boundaryOffset - 1, 1);
      if (probe.bytesRead !== 1 || probe.buffer[0] !== 0x0a) {
        return { ok: false, reason: 'transcript-boundary-not-line-aligned' };
      }
    }
    const read = await readFully(handle, boundaryOffset, postBoundaryBytes);
    if (read.bytesRead !== postBoundaryBytes) {
      return { ok: false, reason: 'transcript-changed-during-read' };
    }
    if (read.buffer.length > 0 && read.buffer[read.buffer.length - 1] !== 0x0a) {
      return {
        ok: false,
        reason: 'transcript-post-boundary-partial-line',
        fileSize,
        postBoundaryBytes,
      };
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer);
    } catch {
      return { ok: false, reason: 'transcript-invalid-utf8' };
    }
    const jsonl = validateCompleteJsonl(text);
    if (!jsonl.ok) return jsonl;
    const after = await handle.stat();
    if (
      Number(after.size) !== fileSize
      || Number(after.mtimeMs) !== Number(before.mtimeMs)
      || Number(after.ino) !== Number(before.ino)
    ) {
      return { ok: false, reason: 'transcript-changed-during-read' };
    }
    return {
      ok: true,
      text,
      buffer: read.buffer,
      fileSize,
      postBoundaryBytes,
      mtimeMs: Number(before.mtimeMs),
      ino: Number(before.ino),
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'transcript-unreadable',
      errorCode: cleanString(error?.code) || null,
    };
  } finally {
    if (handle) {
      try { await handle.close(); } catch {}
    }
  }
}

async function transcriptStillMatchesSnapshot(transcriptPath, snapshot) {
  try {
    const stat = await fs.promises.stat(transcriptPath);
    return stat.isFile()
      && Number(stat.size) === snapshot.fileSize
      && Number(stat.mtimeMs) === snapshot.mtimeMs
      && Number(stat.ino) === snapshot.ino;
  } catch {
    return false;
  }
}

function numericTimestamp(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function makeAudit(context, {
  actualText,
  actualHash,
  entryUuid = null,
  sourceIdentity = null,
  timestamp = null,
  canonicalReason = null,
} = {}) {
  return {
    success: true,
    operationKey: context.operationKey,
    attemptId: context.attemptId,
    provider: context.provider,
    toolType: context.provider,
    sessionId: context.sessionId,
    promptHash: context.promptHash,
    actualHash,
    expectedHash: context.promptHash,
    actualLen: actualText.length,
    expectedLen: context.promptLength,
    canonicalized: !!canonicalReason,
    canonicalReason,
    entryUuid: cleanString(entryUuid) || null,
    sourceIdentity: cleanString(sourceIdentity) || null,
    transcriptBoundary: context.boundary,
    auditTimestamp: numericTimestamp(timestamp),
  };
}

function evidenceFor(boundary, snapshot, candidateCount, matchCount) {
  return {
    transcriptPath: boundary.transcriptPath,
    boundaryOffset: boundary.fileSize,
    fileSize: snapshot.fileSize,
    bytesRead: snapshot.postBoundaryBytes,
    candidateCount,
    matchCount,
  };
}

async function reconcileClaude(context, maxReadBytes) {
  const validated = validateClaudeBoundary(context);
  if (!validated.ok) return unknown(context.record, validated.reason, validated);
  const snapshot = await readExactPostBoundaryRange(
    validated.transcriptPath,
    validated.fileSize,
    maxReadBytes,
  );
  if (!snapshot.ok) return unknown(context.record, snapshot.reason, snapshot);
  if (snapshot.postBoundaryBytes === 0) {
    return absent(context.record, 'no-post-boundary-records', {
      evidence: evidenceFor(validated, snapshot, 0, 0),
    });
  }

  let candidates;
  try {
    candidates = await readClaudeUserRecords(
      validated.transcriptPath,
      context.boundary,
      { maxReadBytes },
    );
  } catch (error) {
    return unknown(context.record, 'transcript-unreadable', {
      errorCode: cleanString(error?.code) || null,
    });
  }
  if (!await transcriptStillMatchesSnapshot(validated.transcriptPath, snapshot)) {
    return unknown(context.record, 'transcript-changed-during-read');
  }

  const auditExpectation = {
    expectedText: context.promptText,
    expectedLen: context.promptLength,
    expectedHash: context.promptHash,
    sentAt: numericTimestamp(context.boundary.capturedAt)
      ?? numericTimestamp(context.record.updatedAt)
      ?? 0,
    preSubmitBoundary: context.boundary,
    finished: false,
  };
  const matches = [];
  for (const candidate of candidates) {
    if (
      resolveExactPath(candidate?.transcriptPath) !== validated.transcriptPath
      || !Number.isFinite(Number(candidate?.byteOffset))
      || Number(candidate.byteOffset) < validated.fileSize
      || Number(candidate.byteOffset) >= snapshot.fileSize
    ) {
      return unknown(context.record, 'transcript-candidate-foreign-boundary');
    }
    const selection = selectClaudePendingPromptAudit(
      [auditExpectation],
      [candidate],
      { hashText: promptAuditFingerprint },
    );
    if (!selection) continue;
    if (candidate.text !== context.promptText) {
      return unknown(context.record, 'transcript-prompt-hash-collision');
    }
    matches.push(selection);
  }
  const evidence = evidenceFor(validated, snapshot, candidates.length, matches.length);
  if (matches.length === 0) {
    return absent(context.record, 'no-exact-post-boundary-candidate', { evidence });
  }
  if (matches.length > 1) {
    return unknown(context.record, 'multiple-exact-post-boundary-candidates', { evidence });
  }
  const candidate = matches[0].candidate;
  const candidateSessionId = cleanString(candidate.record?.sessionId);
  if (candidateSessionId && candidateSessionId !== context.sessionId) {
    return unknown(context.record, 'transcript-candidate-foreign-session', { evidence });
  }
  const actualHash = promptAuditFingerprint(candidate.text);
  const audit = makeAudit(context, {
    actualText: candidate.text,
    actualHash,
    entryUuid: candidate.record?.uuid,
    timestamp: candidate.record?.timestamp,
  });
  const identity = agentPromptAuditMatchesHash(context.promptHash, audit);
  if (!identity.matches) {
    return unknown(context.record, identity.reason || 'audit-identity-rejected', { evidence });
  }
  return found(context.record, 'exact-post-boundary-candidate', audit, { evidence });
}

function codexUserMessageText(payload) {
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.text === 'string') return payload.text;
  if (!Array.isArray(payload?.content)) return null;
  const parts = [];
  for (const item of payload.content) {
    if (typeof item === 'string') parts.push(item);
    else if (typeof item?.text === 'string') parts.push(item.text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

async function reconcileCodex(context, maxReadBytes) {
  const validated = validateCodexBoundary(context);
  if (!validated.ok) return unknown(context.record, validated.reason, validated);
  const snapshot = await readExactPostBoundaryRange(
    validated.transcriptPath,
    validated.fileSize,
    maxReadBytes,
  );
  if (!snapshot.ok) return unknown(context.record, snapshot.reason, snapshot);
  if (snapshot.postBoundaryBytes === 0) {
    return absent(context.record, 'no-post-boundary-records', {
      evidence: evidenceFor(validated, snapshot, 0, 0),
    });
  }

  const consumed = consumeCodexUserMessageAuditChunk({
    chunk: snapshot.text,
    incomingStartOffset: validated.fileSize,
  });
  if (consumed.partial) {
    return unknown(context.record, 'transcript-post-boundary-partial-line');
  }
  const auditExpectation = {
    expectedText: context.promptText,
    expectedLen: context.promptLength,
    expectedHash: context.promptHash,
    sentAt: numericTimestamp(context.boundary.capturedAt)
      ?? numericTimestamp(context.record.updatedAt)
      ?? 0,
    preSubmitBoundary: context.boundary,
  };
  const matches = [];
  for (const candidate of consumed.records) {
    const actualText = codexUserMessageText(candidate.record?.payload);
    if (actualText === null) {
      return unknown(context.record, 'codex-user-message-text-unavailable');
    }
    const actualHash = promptAuditFingerprint(actualText);
    const selection = selectCodexPendingPromptAudit([auditExpectation], {
      actualText,
      actualHash,
      actualPayload: candidate.record?.payload || null,
      actualIdentity: {
        sessionId: context.sessionId,
        filePath: validated.transcriptPath,
        byteOffset: candidate.byteOffset,
        timestamp: candidate.record?.timestamp || null,
      },
    });
    if (!selection) continue;
    const canonicalReason = cleanString(selection.canonicalMatch?.reason) || null;
    if (canonicalReason && !CODEX_CANONICAL_REASONS.has(canonicalReason)) {
      return unknown(context.record, 'codex-canonical-reason-not-allowlisted');
    }
    if (!canonicalReason && actualText !== context.promptText) {
      return unknown(context.record, 'transcript-prompt-hash-collision');
    }
    matches.push({ candidate, actualText, actualHash, canonicalReason });
  }
  const evidence = evidenceFor(validated, snapshot, consumed.records.length, matches.length);
  if (matches.length === 0) {
    return absent(context.record, 'no-exact-post-boundary-candidate', { evidence });
  }
  if (matches.length > 1) {
    return unknown(context.record, 'multiple-exact-post-boundary-candidates', { evidence });
  }
  const match = matches[0];
  const audit = makeAudit(context, {
    actualText: match.actualText,
    actualHash: match.actualHash,
    entryUuid: match.candidate.record?.uuid || match.candidate.record?.id,
    sourceIdentity: `codex-user-source-${context.sessionId}-${match.candidate.byteOffset}`,
    timestamp: match.candidate.record?.timestamp,
    canonicalReason: match.canonicalReason,
  });
  const identity = agentPromptAuditMatchesHash(context.promptHash, audit);
  if (!identity.matches) {
    return unknown(context.record, identity.reason || 'audit-identity-rejected', { evidence });
  }
  return found(
    context.record,
    match.canonicalReason || 'exact-post-boundary-candidate',
    audit,
    { evidence },
  );
}

async function reconcileAgentSendStartupRecord(record, options = {}) {
  const normalized = normalizeUnresolvedRecord(record);
  if (!normalized.ok) return unknown(record, normalized.reason);
  const maxReadBytes = normalizeReadLimit(options.maxReadBytes);
  return normalized.value.provider === 'claude'
    ? reconcileClaude(normalized.value, maxReadBytes)
    : reconcileCodex(normalized.value, maxReadBytes);
}

async function reconcileAgentSendStartupRecords(records, options = {}) {
  const source = Array.isArray(records) ? records : [];
  const maxRecords = normalizeRecordLimit(options.maxRecords);
  const decisions = [];
  // Deliberately sequential: startup recovery must not open an unbounded set of
  // large transcripts at once. Callers can page the durable receipt query.
  for (let index = 0; index < source.length; index += 1) {
    if (index >= maxRecords) {
      decisions.push(unknown(source[index], 'startup-reconcile-record-limit'));
      continue;
    }
    decisions.push(await reconcileAgentSendStartupRecord(source[index], options));
  }
  return decisions;
}

module.exports = {
  DEFAULT_STARTUP_AUDIT_READ_BYTES,
  DEFAULT_STARTUP_RECONCILE_RECORDS,
  MAX_STARTUP_AUDIT_READ_BYTES,
  MAX_STARTUP_RECONCILE_RECORDS,
  reconcileAgentSendStartupRecord,
  reconcileAgentSendStartupRecords,
};
