'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  readClaudeRecordsFromBuffer,
  readClaudeUserRecordsFromBuffer,
  selectClaudePendingPromptAudit,
  claudeAuditCanonicalIdentity,
  claudeNativePastedPromptText,
} = require('./claude-prompt-audit');
const {
  claudeQueuePromptSourceIdentity,
  extractClaudePromptCarrier,
  extractClaudeQueueOperationPromptText,
} = require('./claude-prompt-carriers');
const {
  codexUserMessageAuditText,
  codexUserMessageImageRefs,
  isCodexEnvironmentContextUserText,
  isCodexProjectInstructionsUserText,
  consumeCodexUserMessageAuditChunk,
  selectCodexPreferredUserMessageAuditRecords,
  selectCodexPendingPromptAudit,
} = require('./codex-prompt-audit');
const {
  CODEX_CANONICAL_REASONS,
  agentPromptAuditMatchesHash,
} = require('./agent-prompt-audit-identity');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { validateClaudePromptRequestProjection, CLAUDE_REQUEST_TRANSPORT_REASON } = require('./claude-prompt-request-projection');
const {
  projectCodexImageAuditToRequest,
  readPersistedCodexImageRequestProjection,
} = require('./codex-image-request-projection');
const { readOwnedAttachmentProjection } = require('./owned-mobile-attachments');

const DEFAULT_STARTUP_AUDIT_READ_BYTES = 2 * 1024 * 1024;
const MAX_STARTUP_AUDIT_READ_BYTES = 8 * 1024 * 1024;
const DEFAULT_STARTUP_RECONCILE_RECORDS = 256;
const MAX_STARTUP_RECONCILE_RECORDS = 2_048;
const UNRESOLVED_STATES = new Set(['audit-pending', 'delivery-unknown']);
const CLAUDE_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function providerNotAccepted(record, reason, receipt, extra = {}) {
  return decision(record, 'provider-not-accepted', reason, {
    ...extra,
    receipt,
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

function codexExpectedImagePathsFromReceipt(record) {
  const receipt = record?.receipt && typeof record.receipt === 'object'
    ? record.receipt
    : {};
  return (Array.isArray(receipt.expectedImagePaths) ? receipt.expectedImagePaths : [])
    .flatMap((value) => {
      const imagePath = cleanString(value);
      return imagePath && path.isAbsolute(imagePath) ? [imagePath] : [];
    });
}

function claudeSessionIdFromTranscriptPath(value) {
  const exactPath = resolveExactPath(value);
  if (!exactPath) return '';
  const basename = path.basename(exactPath, path.extname(exactPath));
  return CLAUDE_SESSION_FILE_RE.test(basename) ? basename : '';
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
  const promptHash = cleanString(record.promptHash);
  const promptLength = nonNegativeSafeInteger(record.promptLength);
  if (provider !== 'claude' && provider !== 'codex') {
    return { ok: false, reason: 'receipt-provider-unsupported' };
  }
  if (!operationKey || !attemptId || !promptHash || promptLength === null) {
    return { ok: false, reason: 'receipt-identity-incomplete' };
  }
  const prompt = promptTextFromReceipt(record);
  if (!prompt) return { ok: false, reason: 'receipt-prompt-text-missing' };
  const transportHash = promptAuditFingerprint(prompt.text);
  const transportLength = prompt.text.length;
  let imageRequestProjection = null;
  let claudeRequestProjection = null;
  const ownedRequestProjection = record.receipt?.ownedAttachmentProjection
    ? readOwnedAttachmentProjection(record) : null;
  if (ownedRequestProjection && !ownedRequestProjection.valid) return { ok: false, reason: ownedRequestProjection.reason };
  if (record.receipt?.ownedAttachments && !ownedRequestProjection) return { ok: false, reason: 'attachment-projection-missing' };
  const preparedHash = ownedRequestProjection?.preparedHash || promptHash;
  const preparedLength = ownedRequestProjection?.preparedLength ?? promptLength;
  if (provider === 'codex' && record.receipt?.imageRequestProjection) {
    const projected = readPersistedCodexImageRequestProjection(record);
    if (!projected.valid) return { ok: false, reason: projected.reason };
    imageRequestProjection = projected;
  } else if (provider === 'claude' && (transportLength !== preparedLength || transportHash !== preparedHash)) {
    claudeRequestProjection = validateClaudePromptRequestProjection({ tabId: record.tabId, record,
      audit: { handoffId: record.handoffId, sendOperationKey: operationKey, sendAttemptId: attemptId,
        expectedText: prompt.text, expectedHash: transportHash, expectedLen: transportLength } });
    if (!claudeRequestProjection.valid) return { ok: false, reason: claudeRequestProjection.reason };
  } else if (transportLength !== preparedLength || transportHash !== preparedHash) {
    // Never fall back to raw promptText merely because transport differs.
    // Old receipts without the exact staged proof remain unconfirmed.
    return { ok: false, reason: transportLength !== preparedLength
      ? 'receipt-prompt-length-mismatch' : 'receipt-prompt-hash-mismatch' };
  }
  if (!record.transcriptBoundary || typeof record.transcriptBoundary !== 'object') {
    return { ok: false, reason: 'transcript-boundary-missing' };
  }
  const storedSessionId = cleanString(record.sessionId);
  const boundarySessionId = cleanString(record.transcriptBoundary.sessionId);
  const claudePathSessionId = provider === 'claude'
    ? claudeSessionIdFromTranscriptPath(record.transcriptBoundary.transcriptPath)
    : '';
  if (storedSessionId && boundarySessionId && storedSessionId !== boundarySessionId) {
    return { ok: false, reason: 'transcript-boundary-foreign-session' };
  }
  if (provider === 'claude' && claudePathSessionId) {
    if (storedSessionId && storedSessionId !== claudePathSessionId) {
      return { ok: false, reason: 'transcript-boundary-foreign-session' };
    }
    if (boundarySessionId && boundarySessionId !== claudePathSessionId) {
      return { ok: false, reason: 'transcript-boundary-foreign-session' };
    }
  }
  // Older desktop History receipts persisted the exact Codex writer only
  // inside their pre-Enter transcript boundary. Older Claude receipts kept
  // only the exact transcript path; Claude names that file with the session
  // UUID. Both belong to the same attempt, so the current tab/session is never
  // consulted during recovery.
  const sessionId = storedSessionId
    || boundarySessionId
    || claudePathSessionId;
  if (!sessionId) return { ok: false, reason: 'receipt-identity-incomplete' };
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
      transportHash,
      transportLength,
      imageRequestProjection,
      claudeRequestProjection,
      ownedRequestProjection,
      expectedImagePaths: provider === 'codex'
        ? codexExpectedImagePathsFromReceipt(record)
        : [],
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

async function readBoundedCausalPrefix(
  transcriptPath,
  boundaryOffset,
  maxReadBytes,
  causalUpperBoundaryOffset = null,
) {
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
    if (boundaryOffset > 0) {
      const probe = await readFully(handle, boundaryOffset - 1, 1);
      if (probe.bytesRead !== 1 || probe.buffer[0] !== 0x0a) {
        return { ok: false, reason: 'transcript-boundary-not-line-aligned' };
      }
    }

    const requestedUpper = causalUpperBoundaryOffset === null
      || causalUpperBoundaryOffset === undefined
      ? null
      : nonNegativeSafeInteger(causalUpperBoundaryOffset);
    if (requestedUpper !== null && requestedUpper <= boundaryOffset) {
      return { ok: false, reason: 'transcript-causal-upper-boundary-invalid' };
    }
    if (requestedUpper !== null && requestedUpper > fileSize) {
      return {
        ok: false,
        reason: 'transcript-truncated-before-causal-upper-boundary',
        fileSize,
        causalUpperBoundaryOffset: requestedUpper,
      };
    }
    const scanEndOffset = requestedUpper ?? fileSize;
    if (requestedUpper !== null && scanEndOffset > 0) {
      const probe = await readFully(handle, scanEndOffset - 1, 1);
      if (probe.bytesRead !== 1 || probe.buffer[0] !== 0x0a) {
        return {
          ok: false,
          reason: 'transcript-causal-upper-boundary-not-line-aligned',
          causalUpperBoundaryOffset: requestedUpper,
        };
      }
    }

    const causalRangeBytes = scanEndOffset - boundaryOffset;
    const bytesToRead = Math.min(causalRangeBytes, maxReadBytes);
    const read = await readFully(handle, boundaryOffset, bytesToRead);
    if (read.bytesRead !== bytesToRead) {
      return { ok: false, reason: 'transcript-changed-during-read' };
    }
    const rangeComplete = bytesToRead === causalRangeBytes;
    let completeBuffer = read.buffer;
    if (rangeComplete) {
      if (completeBuffer.length > 0 && completeBuffer[completeBuffer.length - 1] !== 0x0a) {
        return {
          ok: false,
          reason: 'transcript-post-boundary-partial-line',
          fileSize,
          postBoundaryBytes: fileSize - boundaryOffset,
        };
      }
    } else {
      const lastNewline = completeBuffer.lastIndexOf(0x0a);
      completeBuffer = lastNewline >= 0
        ? completeBuffer.subarray(0, lastNewline + 1)
        : completeBuffer.subarray(0, 0);
    }

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(completeBuffer);
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
      buffer: completeBuffer,
      fileSize,
      postBoundaryBytes: fileSize - boundaryOffset,
      causalRangeBytes,
      bytesRead: read.bytesRead,
      completeBytesRead: completeBuffer.length,
      rangeComplete,
      scanEndOffset,
      causalUpperBoundaryOffset: requestedUpper,
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
  recordByteOffset = null,
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
    canonicalized: !!canonicalReason || !!context.claudeRequestProjection || !!context.ownedRequestProjection,
    canonicalReason: context.claudeRequestProjection ? CLAUDE_REQUEST_TRANSPORT_REASON
      : canonicalReason || (context.ownedRequestProjection ? 'owned_mobile_attachment_paths' : null),
    entryUuid: cleanString(entryUuid) || null,
    sourceIdentity: cleanString(sourceIdentity) || null,
    recordByteOffset: Number.isSafeInteger(Number(recordByteOffset))
      && Number(recordByteOffset) >= 0
      ? Number(recordByteOffset)
      : null,
    transcriptBoundary: context.boundary,
    auditTimestamp: numericTimestamp(timestamp),
  };
}

function evidenceFor(boundary, snapshot, candidateCount, matchCount) {
  return {
    transcriptPath: boundary.transcriptPath,
    boundaryOffset: boundary.fileSize,
    fileSize: snapshot.fileSize,
    bytesRead: Number.isFinite(snapshot.bytesRead)
      ? snapshot.bytesRead
      : snapshot.postBoundaryBytes,
    postBoundaryBytes: snapshot.postBoundaryBytes,
    rangeComplete: snapshot.rangeComplete !== false,
    scanEndOffset: snapshot.scanEndOffset ?? snapshot.fileSize,
    causalUpperBoundaryOffset: snapshot.causalUpperBoundaryOffset ?? null,
    candidateCount,
    matchCount,
  };
}

function claudeProviderQueueEvidence(context) {
  const providerQueue = context?.record?.receipt?.providerQueue;
  if (!providerQueue || typeof providerQueue !== 'object') return null;
  const entryUuid = cleanString(providerQueue.entryUuid);
  const recordByteOffset = nonNegativeSafeInteger(providerQueue.recordByteOffset);
  const sessionId = cleanString(providerQueue.sessionId) || context.sessionId;
  const sourceIdentity = cleanString(providerQueue.sourceIdentity)
    || (entryUuid ? `claude-queue:uuid:${entryUuid}` : '')
    || (sessionId && recordByteOffset !== null
      ? `claude-queue:offset:${sessionId}:${recordByteOffset}`
      : '');
  if (!sourceIdentity) return null;
  if (sessionId && sessionId !== context.sessionId) return null;
  return {
    sourceIdentity,
    entryUuid: entryUuid || null,
    recordByteOffset,
    sessionId,
  };
}

function isStrictQueuedPromptPrefix(actualText, expectedText) {
  if (
    typeof actualText !== 'string'
    || typeof expectedText !== 'string'
    || actualText.length <= expectedText.length
    || !actualText.startsWith(expectedText)
  ) return false;
  return /\s/u.test(actualText.charAt(expectedText.length));
}

function reconcileClaudeProviderQueue(context, validated, snapshot) {
  const queueEvidence = claudeProviderQueueEvidence(context);
  if (!queueEvidence) return null;
  const records = readClaudeRecordsFromBuffer(
    snapshot.buffer,
    validated.transcriptPath,
    {
      baseOffset: validated.fileSize,
      skipLeadingPartial: false,
      bytesRead: snapshot.bytesRead,
      readMode: 'startup-provider-queue',
    },
  );
  const enqueueMatches = records.filter((candidate) => {
    const record = candidate.record;
    if (record?.type !== 'queue-operation' || record.operation !== 'enqueue') return false;
    const candidateSessionId = cleanString(record.sessionId || record.session_id)
      || context.sessionId;
    if (candidateSessionId !== context.sessionId) return false;
    if (
      queueEvidence.recordByteOffset !== null
      && Number(candidate.byteOffset) !== queueEvidence.recordByteOffset
    ) return false;
    if (
      queueEvidence.entryUuid
      && cleanString(record.uuid) !== queueEvidence.entryUuid
    ) return false;
    const sourceIdentity = claudeQueuePromptSourceIdentity(record, {
      sessionId: candidateSessionId,
      recordByteOffset: candidate.byteOffset,
    });
    return sourceIdentity === queueEvidence.sourceIdentity
      && extractClaudeQueueOperationPromptText(record) === context.promptText;
  });
  const baseEvidence = evidenceFor(
    validated,
    snapshot,
    records.length,
    enqueueMatches.length,
  );
  if (enqueueMatches.length === 0) {
    return unknown(context.record, 'provider-queue-enqueue-not-found', {
      evidence: baseEvidence,
    });
  }
  if (enqueueMatches.length > 1) {
    return unknown(context.record, 'provider-queue-enqueue-ambiguous', {
      evidence: baseEvidence,
    });
  }

  const enqueue = enqueueMatches[0];
  let exactSettlement = null;
  for (const candidate of records) {
    if (Number(candidate.byteOffset) <= Number(enqueue.byteOffset)) continue;
    const record = candidate.record;
    const candidateSessionId = cleanString(record?.sessionId || record?.session_id)
      || context.sessionId;
    if (candidateSessionId !== context.sessionId) continue;

    const carrier = extractClaudePromptCarrier(record);
    if (carrier?.text === context.promptText
      || isStrictQueuedPromptPrefix(carrier?.text, context.promptText)) {
      const merged = carrier.text !== context.promptText;
      const audit = makeAudit(context, {
        actualText: context.promptText,
        actualHash: context.transportHash,
        entryUuid: record.uuid,
        sourceIdentity: queueEvidence.sourceIdentity,
        recordByteOffset: candidate.byteOffset,
        timestamp: record.timestamp,
        canonicalReason: merged ? 'claude_queue_prompt_merged_into_user_turn' : null,
      });
      return found(
        context.record,
        merged ? 'provider-queue-merged-user-turn' : 'provider-queue-canonical-user-turn',
        audit,
        { evidence: { ...baseEvidence, matchCount: 1 } },
      );
    }

    if (record?.type !== 'queue-operation') continue;
    if (record.operation === 'popAll') {
      return providerNotAccepted(
        context.record,
        'provider-queue-returned-to-composer',
        {
          success: false,
          cancelled: true,
          accepted: false,
          submitted: true,
          pasteWritten: true,
          enterWritten: true,
          semanticStatus: 'not-submitted',
          providerAccepted: false,
          providerTurnCreated: false,
          providerQueueReturned: true,
          providerQueueOperation: 'popAll',
          composerDraftState: 'exact-provider-queue-return',
          draftPreserved: true,
          lateReconciliationPending: false,
          auditPending: false,
          deliveryUnknown: false,
          status: 'provider-not-accepted',
          code: 'claude_queue_returned_to_composer',
          error: 'claude_queue_returned_to_composer',
          operationKey: context.operationKey,
          attemptId: context.attemptId,
          provider: 'claude',
          sessionId: context.sessionId,
          actualLen: context.promptLength,
          actualHash: context.promptHash,
          expectedLen: context.promptLength,
          expectedHash: context.promptHash,
          sourceIdentity: queueEvidence.sourceIdentity,
          recordByteOffset: enqueue.byteOffset,
          queueReturnRecordByteOffset: candidate.byteOffset,
          auditTimestamp: numericTimestamp(record.timestamp),
          transcriptBoundary: context.boundary,
          canonicalized: true,
          canonicalReason: 'provider-queue-returned-to-composer',
        },
        { evidence: { ...baseEvidence, matchCount: 1 } },
      );
    }
    if (record.operation === 'remove' || record.operation === 'dequeue') {
      const settlementText = typeof record.content === 'string' ? record.content : '';
      if (settlementText && settlementText === context.promptText) {
        exactSettlement = candidate;
        break;
      }
    }
  }
  if (!exactSettlement) return null;
  const audit = makeAudit(context, {
    actualText: context.promptText,
    actualHash: context.transportHash,
    sourceIdentity: queueEvidence.sourceIdentity,
    recordByteOffset: enqueue.byteOffset,
    timestamp: enqueue.record?.timestamp,
    canonicalReason: `provider-queue-${exactSettlement.record.operation}`,
  });
  return found(
    context.record,
    `provider-queue-${exactSettlement.record.operation}`,
    audit,
    { evidence: { ...baseEvidence, matchCount: 1 } },
  );
}

async function reconcileClaude(context, maxReadBytes, options = {}) {
  const validated = validateClaudeBoundary(context);
  if (!validated.ok) return unknown(context.record, validated.reason, validated);
  const providerQueueEvidence = claudeProviderQueueEvidence(context);
  const snapshot = await readBoundedCausalPrefix(
    validated.transcriptPath,
    validated.fileSize,
    maxReadBytes,
    providerQueueEvidence ? null : options.causalUpperBoundaryOffset,
  );
  if (!snapshot.ok) return unknown(context.record, snapshot.reason, snapshot);
  if (snapshot.causalRangeBytes === 0) {
    return absent(context.record, 'no-post-boundary-records', {
      evidence: evidenceFor(validated, snapshot, 0, 0),
    });
  }

  const providerQueueDecision = reconcileClaudeProviderQueue(
    context,
    validated,
    snapshot,
  );
  if (providerQueueDecision) return providerQueueDecision;

  const candidates = readClaudeUserRecordsFromBuffer(
    snapshot.buffer,
    validated.transcriptPath,
    {
      baseOffset: validated.fileSize,
      skipLeadingPartial: false,
      bytesRead: snapshot.bytesRead,
      readMode: 'startup-causal-prefix',
    },
  );

  const auditExpectation = {
    expectedText: context.promptText,
    expectedLen: context.transportLength,
    expectedHash: context.transportHash,
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
      || Number(candidate.byteOffset) >= snapshot.scanEndOffset
    ) {
      return unknown(context.record, 'transcript-candidate-foreign-boundary');
    }
    const selection = selectClaudePendingPromptAudit(
      [auditExpectation],
      [candidate],
      { hashText: promptAuditFingerprint },
    );
    if (!selection) continue;
    if (candidate.text !== context.promptText
      && claudeNativePastedPromptText(candidate.text) !== context.promptText) {
      return unknown(context.record, 'transcript-prompt-hash-collision');
    }
    matches.push(selection);
  }
  const evidence = evidenceFor(validated, snapshot, candidates.length, matches.length);
  const hasClosedCausalRange = snapshot.causalUpperBoundaryOffset !== null
    && snapshot.rangeComplete === true;
  if (!hasClosedCausalRange) {
    const firstCandidate = candidates[0] || null;
    if (!firstCandidate) {
      return snapshot.rangeComplete
        ? absent(context.record, 'no-post-boundary-user-message', { evidence })
        : unknown(context.record, 'no-user-message-in-bounded-causal-prefix', { evidence });
    }
    const firstSelection = selectClaudePendingPromptAudit(
      [auditExpectation],
      [firstCandidate],
      { hashText: promptAuditFingerprint },
    );
    if (!firstSelection) {
      if (snapshot.rangeComplete === true && matches.length === 0) {
        return absent(context.record, 'no-exact-post-boundary-candidate', { evidence });
      }
      return unknown(context.record, 'first-post-boundary-user-message-mismatch', { evidence });
    }
    if (firstCandidate.text !== context.promptText
      && claudeNativePastedPromptText(firstCandidate.text) !== context.promptText) {
      return unknown(context.record, 'transcript-prompt-hash-collision', { evidence });
    }
    if (snapshot.rangeComplete !== true) {
      matches.length = 0;
      matches.push(firstSelection);
    }
  }
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
  const nativePasteText = claudeNativePastedPromptText(candidate.text);
  if (nativePasteText !== null) {
    // A recovered envelope cannot confirm two operations which shared the
    // same still-open byte window (including a literal wrapper request).
    // Compare persisted operation boundaries, never current tab text/status.
    for (const otherRecord of options.allRecords || []) {
      if (otherRecord?.operationKey === context.operationKey) continue;
      const other = normalizeUnresolvedRecord(otherRecord);
      const otherBoundary = providerBoundaryIdentity(otherRecord);
      if (!other.ok || other.value.provider !== 'claude' || !otherBoundary
        || otherBoundary.sessionId !== context.sessionId
        || otherBoundary.transcriptPath !== validated.transcriptPath
        || otherBoundary.fileSize > Number(candidate.byteOffset)) continue;
      const upper = nextProviderBoundaryOffset(otherRecord, options.allRecords);
      if (upper !== null && Number(candidate.byteOffset) >= upper) continue;
      if (other.value.promptText === candidate.text || other.value.promptText === nativePasteText) {
        return unknown(context.record, 'native-paste-candidate-has-competing-attempt', { evidence });
      }
    }
  }
  const actualHash = promptAuditFingerprint(candidate.text);
  const canonical = claudeAuditCanonicalIdentity(auditExpectation, candidate.text);
  const audit = makeAudit(context, {
    actualText: candidate.text,
    actualHash,
    entryUuid: candidate.record?.uuid,
    recordByteOffset: candidate.byteOffset,
    timestamp: candidate.record?.timestamp,
    canonicalReason: canonical.canonicalReason,
  });
  const identity = agentPromptAuditMatchesHash(context.promptHash, audit);
  if (!identity.matches) {
    return unknown(context.record, identity.reason || 'audit-identity-rejected', { evidence });
  }
  return found(context.record, 'exact-post-boundary-candidate', audit, { evidence });
}

function selectCodexStartupCandidate(context, validated, auditExpectation, candidate) {
  const actualText = codexUserMessageAuditText(candidate.record, {
    preserveProviderImageMarkup: true,
  });
  if (actualText === null) {
    return { ok: false, reason: 'codex-user-message-text-unavailable' };
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
  if (!selection) return { ok: true, match: null };
  let canonicalReason = cleanString(selection.canonicalMatch?.reason) || null;
  if (canonicalReason && !CODEX_CANONICAL_REASONS.has(canonicalReason)) {
    return { ok: false, reason: 'codex-canonical-reason-not-allowlisted' };
  }
  if (!canonicalReason && actualText !== context.promptText) {
    return { ok: false, reason: 'transcript-prompt-hash-collision' };
  }
  if (context.imageRequestProjection) {
    const projected = projectCodexImageAuditToRequest({
      tabId: context.record.tabId,
      record: context.record,
      audit: context.imageRequestProjection.audit,
      result: {
        success: true,
        canonicalized: !!canonicalReason,
        canonicalReason,
        expectedHash: auditExpectation.expectedHash,
        expectedLen: auditExpectation.expectedLen,
        actualHash,
        actualText,
        actualLen: actualText.length,
        actualImagePaths: codexUserMessageImageRefs(candidate.record).map(ref => ref.path),
      },
    });
    if (!projected.applied) return { ok: false, reason: projected.reason };
    canonicalReason = projected.canonicalReason;
  }
  return {
    ok: true,
    match: { candidate, actualText, actualHash, canonicalReason },
  };
}

async function reconcileCodex(context, maxReadBytes, options = {}) {
  const validated = validateCodexBoundary(context);
  if (!validated.ok) return unknown(context.record, validated.reason, validated);
  const snapshot = await readBoundedCausalPrefix(
    validated.transcriptPath,
    validated.fileSize,
    maxReadBytes,
    options.causalUpperBoundaryOffset,
  );
  if (!snapshot.ok) return unknown(context.record, snapshot.reason, snapshot);
  if (snapshot.causalRangeBytes === 0) {
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
    expectedLen: context.transportLength,
    expectedHash: context.transportHash,
    // Legacy durable Codex receipts predate persisted staged image paths.
    // Their exact causal byte boundary still permits the established ordered-
    // slot transformation, while live sends use expectedImagePaths and thus
    // require exact provider path/slot identity.
    expectedImagePaths: context.expectedImagePaths,
    allowUnprovenImageCarrier: context.expectedImagePaths.length === 0,
    sentAt: numericTimestamp(context.boundary.capturedAt)
      ?? numericTimestamp(context.record.updatedAt)
      ?? 0,
    preSubmitBoundary: context.boundary,
  };
  const matches = [];
  const preferredCandidates = selectCodexPreferredUserMessageAuditRecords(consumed.records)
    .filter(candidate => {
      // On cold launch Codex writes project/environment context as role=user
      // response_items before the actual user message. These same reserved
      // carriers are marked as service rows by History, not authored turns.
      // Do not skip an event_msg user turn or the exact requested text.
      if (candidate.record?.type !== 'response_item') return true;
      const text = codexUserMessageAuditText(candidate.record);
      return text === context.promptText
        || (!isCodexEnvironmentContextUserText(text) && !isCodexProjectInstructionsUserText(text));
    });
  for (const candidate of preferredCandidates) {
    const selected = selectCodexStartupCandidate(
      context,
      validated,
      auditExpectation,
      candidate,
    );
    if (!selected.ok) return unknown(context.record, selected.reason);
    if (selected.match) matches.push(selected.match);
  }
  const evidence = evidenceFor(validated, snapshot, preferredCandidates.length, matches.length);
  const hasClosedCausalRange = snapshot.causalUpperBoundaryOffset !== null
    && snapshot.rangeComplete === true;
  let match = null;
  if (hasClosedCausalRange) {
    if (matches.length === 0) {
      return absent(context.record, 'no-exact-post-boundary-candidate', { evidence });
    }
    if (matches.length > 1) {
      return unknown(context.record, 'multiple-exact-post-boundary-candidates', { evidence });
    }
    [match] = matches;
  } else {
    const firstCandidate = preferredCandidates[0] || null;
    if (!firstCandidate) {
      return snapshot.rangeComplete
        ? absent(context.record, 'no-post-boundary-user-message', { evidence })
        : unknown(context.record, 'no-user-message-in-bounded-causal-prefix', { evidence });
    }
    const selected = selectCodexStartupCandidate(
      context,
      validated,
      auditExpectation,
      firstCandidate,
    );
    if (!selected.ok) return unknown(context.record, selected.reason, { evidence });
    if (!selected.match) {
      return unknown(
        context.record,
        'first-post-boundary-user-message-mismatch',
        { evidence },
      );
    }
    match = selected.match;
  }
  const audit = makeAudit(context, {
    actualText: match.actualText,
    actualHash: match.actualHash,
    entryUuid: match.candidate.record?.uuid || match.candidate.record?.id,
    sourceIdentity: `codex-user-source-${context.sessionId}-${match.candidate.byteOffset}`,
    recordByteOffset: match.candidate.byteOffset,
    timestamp: match.candidate.record?.timestamp,
    canonicalReason: match.canonicalReason,
  });
  if (context.imageRequestProjection) {
    audit.transportExpectedHash = context.transportHash;
    audit.transportExpectedLen = context.transportLength;
    audit.imageRequestProjection = {
      kind: context.imageRequestProjection.kind,
      imageCount: context.imageRequestProjection.imageCount,
    };
  }
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
    ? reconcileClaude(normalized.value, maxReadBytes, options)
    : reconcileCodex(normalized.value, maxReadBytes, options);
}

function providerBoundaryIdentity(record) {
  const provider = cleanString(record?.provider).toLowerCase();
  if (provider !== 'claude' && provider !== 'codex') return null;
  const boundary = record?.transcriptBoundary;
  const transcriptPath = resolveExactPath(
    provider === 'claude' ? boundary?.transcriptPath : boundary?.filePath,
  );
  const sessionId = cleanString(boundary?.sessionId || record?.sessionId)
    || (provider === 'claude' ? claudeSessionIdFromTranscriptPath(transcriptPath) : '');
  const fileSize = nonNegativeSafeInteger(boundary?.fileSize);
  if (!transcriptPath || !sessionId || fileSize === null) return null;
  return { provider, transcriptPath, sessionId, fileSize };
}

function nextProviderBoundaryOffset(record, records) {
  const current = providerBoundaryIdentity(record);
  if (!current) return null;
  let next = null;
  for (const candidate of Array.isArray(records) ? records : []) {
    if (candidate === record) continue;
    const other = providerBoundaryIdentity(candidate);
    if (
      !other
      || other.provider !== current.provider
      || other.sessionId !== current.sessionId
      || other.transcriptPath !== current.transcriptPath
    ) {
      continue;
    }
    const candidateOffset = other.fileSize;
    if (candidateOffset <= current.fileSize) continue;
    if (next === null || candidateOffset < next) next = candidateOffset;
  }
  return next;
}

async function reconcileAgentSendStartupRecords(records, options = {}) {
  const source = Array.isArray(records) ? records : [];
  const allRecords = Array.isArray(options.allRecords) ? options.allRecords : source;
  const maxRecords = normalizeRecordLimit(options.maxRecords);
  const decisions = [];
  // Deliberately sequential: startup recovery must not open an unbounded set of
  // large transcripts at once. Callers can page the durable receipt query.
  for (let index = 0; index < source.length; index += 1) {
    if (index >= maxRecords) {
      decisions.push(unknown(source[index], 'startup-reconcile-record-limit'));
      continue;
    }
    decisions.push(await reconcileAgentSendStartupRecord(source[index], {
      ...options,
      allRecords,
      causalUpperBoundaryOffset:
        nextProviderBoundaryOffset(source[index], allRecords),
    }));
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
