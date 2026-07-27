'use strict';

function collectCodexPayloadImagePaths(payload) {
  const paths = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) paths.push(trimmed);
  };
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.local_images)) payload.local_images.forEach(add);
    if (Array.isArray(payload.images)) payload.images.forEach(add);
  }
  return paths;
}

function codexPromptHasImageMarker(text) {
  return /\[(?:Image(?:\s+#?\d+)?|imagePath:\s*[^\]\r\n]+?|imageError:\s*[^\]\r\n]+?|image:\s*[^\]\r\n]+?)\]/i.test(String(text || ''));
}

function normalizeCodexPromptImageSlots(text, imagePaths = []) {
  let value = String(text || '');
  value = value
    .replace(/\[imagePath:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[imageError:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[image:\s*[^\]\r\n]+?\s*\]/gi, ' [Image] ')
    .replace(/\[Image(?:\s+#?\d+)?\]/gi, ' [Image] ');
  const sortedPaths = [...new Set((imagePaths || []).filter(Boolean))]
    .sort((a, b) => String(b).length - String(a).length);
  for (const imagePath of sortedPaths) {
    value = value.split(String(imagePath)).join(' [Image] ');
  }
  return value
    .replace(/\s+/g, ' ')
    .trim();
}

function codexCanonicalUserMessageMatch(audit, actualText) {
  const expected = String(audit?.expectedText || '');
  const actual = String(actualText || '');
  if (!expected) return null;

  // Codex normalizes only boundary whitespace when materializing user_message.
  // Accept that exact transformation, but never collapse or rewrite whitespace
  // inside the prompt: an interior difference remains delivery corruption.
  const boundaryTrimmedExpected = expected.trim();
  if (boundaryTrimmedExpected !== expected && actual === boundaryTrimmedExpected) {
    return { reason: 'codex_trimmed_boundary_whitespace' };
  }

  const payload = audit?.actualPayload || null;
  const imagePaths = collectCodexPayloadImagePaths(payload);
  if ((imagePaths.length > 0 || codexPromptHasImageMarker(expected) || codexPromptHasImageMarker(actual))
    && normalizeCodexPromptImageSlots(expected, imagePaths) === normalizeCodexPromptImageSlots(actual, imagePaths)) {
    return { reason: 'codex_image_placeholder_canonical' };
  }
  return null;
}

function codexAuditRecordIsAfterBoundary(
  audit,
  {
    sessionId = null,
    filePath = null,
    byteOffset = null,
    timestamp = null,
  } = {},
) {
  const boundary = audit?.preSubmitBoundary || null;
  const sentAt = Number(audit?.sentAt || 0);
  const recordAt = Date.parse(String(timestamp || ''));

  if (!boundary) {
    // Older/non-file-backed callers have no byte boundary. A real rollout
    // timestamp is still useful, but absence of both signals must preserve the
    // previous matcher contract rather than rejecting every record.
    return !Number.isFinite(recordAt) || !Number.isFinite(sentAt) || recordAt >= sentAt;
  }

  const sameWriterFile = !!boundary.sessionId
    && !!boundary.filePath
    && String(sessionId || '') === String(boundary.sessionId)
    && String(filePath || '') === String(boundary.filePath);
  if (sameWriterFile) {
    return Number.isFinite(byteOffset)
      && Number.isFinite(boundary.fileSize)
      && Number(byteOffset) >= Number(boundary.fileSize);
  }

  // A resume/compact can hand the writer to a linked child rollout whose
  // beginning contains copied historical records. Those records retain their
  // old timestamps, so only a record materialized after Enter is causal.
  return Number.isFinite(recordAt)
    && Number.isFinite(sentAt)
    && recordAt >= sentAt;
}

function selectCodexPendingPromptAudit(
  audits,
  {
    actualText = '',
    actualHash = '',
    actualPayload = null,
    actualIdentity = null,
  } = {},
) {
  const pending = (Array.isArray(audits) ? audits : [])
    .filter((audit) => codexAuditRecordIsAfterBoundary(audit, actualIdentity || {}));
  const text = String(actualText || '');
  const exact = pending.find((audit) =>
    Number(audit?.expectedLen) === text.length
    && String(audit?.expectedHash || '') === String(actualHash || '')
  );
  if (exact) {
    return { audit: exact, canonicalMatch: null };
  }
  for (const audit of pending) {
    const canonicalMatch = codexCanonicalUserMessageMatch(
      { ...audit, actualPayload },
      text,
    );
    if (canonicalMatch) {
      return { audit, canonicalMatch };
    }
  }
  return null;
}

function partitionCodexPendingPromptAuditsForRetention(
  audits,
  {
    now = Date.now(),
    maxAgeMs,
    maxPending,
  } = {},
) {
  const source = Array.isArray(audits) ? audits : [];
  const ageBound = Number.isFinite(maxAgeMs) ? Math.max(0, Number(maxAgeMs)) : Infinity;
  const countBound = Number.isSafeInteger(maxPending) ? Math.max(0, Number(maxPending)) : Infinity;
  const evicted = [];
  const retained = [];
  for (const audit of source) {
    const sentAt = Number(audit?.sentAt);
    const ageMs = Number.isFinite(sentAt) ? Number(now) - sentAt : 0;
    if (ageMs >= ageBound) evicted.push({ audit, reason: 'age-bound' });
    else retained.push(audit);
  }
  while (retained.length > countBound) {
    evicted.push({ audit: retained.shift(), reason: 'count-bound' });
  }
  return { retained, evicted };
}

// A provisional Resume watcher intentionally withholds normal lifecycle
// processing until writer ownership is proven. The first post-Enter
// user_message is itself part of that proof, so it needs a narrow parser that
// can inspect only audit records without publishing busy/history state. Keep a
// separate partial buffer from the normal turn parser: once ownership is
// accepted, the held byte range is replayed through the full parser.
function consumeCodexUserMessageAuditChunk({
  chunk = '',
  incomingStartOffset = 0,
  partial = '',
  partialStartOffset = null,
} = {}) {
  const incoming = Buffer.from(String(chunk || ''), 'utf8');
  const carried = Buffer.from(String(partial || ''), 'utf8');
  const combined = carried.length > 0
    ? Buffer.concat([carried, incoming])
    : incoming;
  const combinedStartOffset = carried.length > 0 && Number.isFinite(partialStartOffset)
    ? Number(partialStartOffset)
    : Math.max(0, Number(incomingStartOffset) || 0);
  const records = [];
  let lineStart = 0;
  let newlineIndex = combined.indexOf(0x0a, lineStart);
  while (newlineIndex >= 0) {
    const text = combined.subarray(lineStart, newlineIndex).toString('utf8').trim();
    if (text) {
      try {
        const record = JSON.parse(text);
        if (record?.type === 'event_msg' && record?.payload?.type === 'user_message') {
          records.push({
            record,
            byteOffset: combinedStartOffset + lineStart,
          });
        }
      } catch {
        // A complete newline-delimited record that does not parse is not
        // delivery proof. The full watcher owns diagnostics for malformed
        // rollout rows; this narrow reader only extracts positive evidence.
      }
    }
    lineStart = newlineIndex + 1;
    newlineIndex = combined.indexOf(0x0a, lineStart);
  }
  const remaining = combined.subarray(lineStart);
  return {
    records,
    partial: remaining.toString('utf8'),
    partialStartOffset: combinedStartOffset + lineStart,
  };
}

module.exports = {
  codexAuditRecordIsAfterBoundary,
  codexCanonicalUserMessageMatch,
  codexPromptHasImageMarker,
  collectCodexPayloadImagePaths,
  consumeCodexUserMessageAuditChunk,
  normalizeCodexPromptImageSlots,
  partitionCodexPendingPromptAuditsForRetention,
  selectCodexPendingPromptAudit,
};
