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

function isCodexUserMessageAuditRecord(record) {
  const payload = record?.payload || {};
  return (record?.type === 'event_msg' && payload.type === 'user_message')
    || (
      record?.type === 'response_item'
      && payload.type === 'message'
      && payload.role === 'user'
    );
}

function codexUserMessageAuditText(record) {
  if (!isCodexUserMessageAuditRecord(record)) return null;
  const payload = record?.payload || {};
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text;
  if (!Array.isArray(payload.content)) return null;
  const parts = [];
  for (const item of payload.content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const type = String(item?.type || '').toLowerCase();
    if (
      type.includes('image')
      || typeof item?.image_url === 'string'
      || typeof item?.imageUrl === 'string'
    ) {
      // response_item can be the only durable carrier for an image prompt.
      // Preserve the exact content order without retaining its huge data URL.
      parts.push(' [Image] ');
    } else if (typeof item?.text === 'string') {
      parts.push(item.text);
    } else if (typeof item?.value === 'string') {
      parts.push(item.value);
    } else if (typeof item?.message === 'string') {
      parts.push(item.message);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

function codexUserCarrierTextsMatch(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  if (!a || !b) return false;
  if (a === b) return true;
  return !!codexCanonicalUserMessageMatch({ expectedText: a }, b)
    || !!codexCanonicalUserMessageMatch({ expectedText: b }, a);
}

function selectCodexPreferredUserMessageAuditRecords(candidates) {
  const source = Array.isArray(candidates) ? candidates : [];
  const events = source
    .filter((candidate) => candidate?.record?.type === 'event_msg')
    .map((candidate) => ({
      candidate,
      text: codexUserMessageAuditText(candidate.record),
      claimed: false,
    }));
  const selected = [...events.map((item) => item.candidate)];
  for (const candidate of source) {
    if (candidate?.record?.type !== 'response_item') continue;
    const text = codexUserMessageAuditText(candidate.record);
    const responseOffset = Number(candidate?.byteOffset);
    const paired = events.find((event) => {
      if (event.claimed || !codexUserCarrierTextsMatch(text, event.text)) return false;
      const eventOffset = Number(event.candidate?.byteOffset);
      return !Number.isFinite(responseOffset)
        || !Number.isFinite(eventOffset)
        || eventOffset >= responseOffset;
    });
    if (paired) {
      paired.claimed = true;
      continue;
    }
    selected.push(candidate);
  }
  return selected.sort((left, right) => {
    const a = Number(left?.byteOffset);
    const b = Number(right?.byteOffset);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return a - b;
  });
}

function codexPromptHasImageMarker(text) {
  return /\[(?:Image(?:\s+#?\d+)?|imagePath:\s*[^\]\r\n]+?|imageError:\s*[^\]\r\n]+?|image:\s*[^\]\r\n]+?)\]/i.test(String(text || ''));
}

function normalizeCodexPromptImageSlots(text, imagePaths = []) {
  let value = String(text || '');
  value = value
    // Newer Codex response_item user carriers wrap each transported image as
    // one XML-like block. The label and path describe the SAME slot; treating
    // them independently doubles the image count and leaves CONFIRMING stuck.
    .replace(/<image\s+name\s*=\s*["']?\[Image(?:\s+#?\d+)?\]["']?\s+path\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)\s*>\s*<<ImageDisplayed>>\s*<\/image\s*>/gi, ' [Image] ')
    .replace(/<image\s+name\s*=\s*["']?\[Image(?:\s+#?\d+)?\]["']?\s+path\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)\s*\/?>/gi, ' [Image] ')
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

  // The Codex PTY materializes each byte of a Windows CRLF pasted through its
  // composer as a line break of its own. The rollout therefore contains LF+LF
  // for every CRLF while preserving the exact string length. This is a narrow,
  // observed provider transformation: do not generalize it to whitespace
  // collapsing or to the more common CRLF -> LF normalization.
  const ptyMaterializedExpected = expected.replace(/\r\n/g, '\n\n');
  if (ptyMaterializedExpected !== expected && actual === ptyMaterializedExpected) {
    return { reason: 'codex_pty_crlf_materialized_as_double_lf' };
  }

  // Codex normalizes only boundary whitespace when materializing user_message.
  // Accept that exact transformation, but never collapse or rewrite whitespace
  // inside the prompt: an interior difference remains delivery corruption.
  const boundaryTrimmedExpected = expected.trim();
  if (boundaryTrimmedExpected !== expected && actual === boundaryTrimmedExpected) {
    return { reason: 'codex_trimmed_boundary_whitespace' };
  }

  const payload = audit?.actualPayload || null;
  const imagePaths = [
    ...collectCodexPayloadImagePaths(payload),
    ...(Array.isArray(audit?.expectedImagePaths) ? audit.expectedImagePaths : []),
  ];
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
// user carrier is itself part of that proof, so it needs a narrow parser that
// can inspect only audit records without publishing busy/history state. Codex
// normally writes event_msg/user_message, but image-bearing turns can persist
// only response_item/message(role=user). Both are exact provider-owned input
// records. Keep a
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
        if (isCodexUserMessageAuditRecord(record)) {
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
  codexUserMessageAuditText,
  codexUserCarrierTextsMatch,
  codexAuditRecordIsAfterBoundary,
  codexCanonicalUserMessageMatch,
  codexPromptHasImageMarker,
  collectCodexPayloadImagePaths,
  consumeCodexUserMessageAuditChunk,
  isCodexUserMessageAuditRecord,
  normalizeCodexPromptImageSlots,
  partitionCodexPendingPromptAuditsForRetention,
  selectCodexPendingPromptAudit,
  selectCodexPreferredUserMessageAuditRecords,
};
