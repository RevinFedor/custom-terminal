'use strict';

const { createHash } = require('node:crypto');

// Diagnostic only. This never decides whether a Fork/Rewind may be adopted.
// Transcript bodies (including images and opaque compact content) stay out of
// the log; strings are identified by length and a chunked digest.
function describeValue(value, present = true) {
  if (!present) return { type: 'missing' };
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') {
    const hash = createHash('sha256');
    // UTF-16 hashes the exact code units without lossy surrogate replacement.
    for (let offset = 0; offset < value.length; offset += 32_768) {
      hash.update(Buffer.from(value.slice(offset, offset + 32_768), 'utf16le'));
    }
    return { type: 'string', chars: value.length, sha256Utf16: hash.digest('hex') };
  }
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') return { type: 'object', keyCount: Object.keys(value).length };
  if (typeof value === 'boolean' || typeof value === 'number') {
    return { type: typeof value, value };
  }
  return { type: typeof value };
}

function firstDifference(expected, actual, rootPath) {
  let visited = 0;
  const walk = (left, right, path, depth, leftPresent = true, rightPresent = true) => {
    // Parsed JSON is acyclic. Bound diagnostics for unusually deep/large
    // payloads without weakening the existing complete equality check.
    if (++visited > 10_000 || depth > 64) {
      return { path, scanLimited: true, expected: describeValue(left), actual: describeValue(right) };
    }
    if (leftPresent === rightPresent && Object.is(left, right)) return null;
    if (!leftPresent || !rightPresent) {
      return { path, expected: describeValue(left, leftPresent), actual: describeValue(right, rightPresent) };
    }
    if (left && right && typeof left === 'object' && typeof right === 'object'
      && Array.isArray(left) === Array.isArray(right)) {
      if (Array.isArray(left)) {
        for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
          const diff = walk(left[index], right[index], path + '/' + index, depth + 1,
            index < left.length, index < right.length);
          if (diff) return diff;
        }
      } else {
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
          const pointerKey = key.replace(/~/g, '~0').replace(/\//g, '~1');
          const diff = walk(left[key], right[key], path + '/' + pointerKey, depth + 1,
            Object.hasOwn(left, key), Object.hasOwn(right, key));
          if (diff) return diff;
        }
      }
      return null;
    }
    const diff = { path, expected: describeValue(left), actual: describeValue(right) };
    if (typeof left === 'string' && typeof right === 'string') {
      let offset = 0;
      while (offset < Math.min(left.length, right.length) && left[offset] === right[offset]) offset += 1;
      diff.firstDifferentUtf16Offset = offset;
    }
    return diff;
  };
  return walk(expected, actual, rootPath, 0);
}

function describeRecord(record, fallbackSessionId) {
  if (!record) return null;
  return {
    physicalSessionId: record.__physicalSessionId || fallbackSessionId,
    // Zero-based physical line, NOT the temporary composite reducer index.
    line: record.__line ?? null,
    byteOffset: record.__byteOffset ?? null,
    type: record.type || null,
    payloadType: record.payload?.type || null,
    role: record.payload?.role || null,
  };
}

function describeCodexForkPrefixFailure({ snapshot, childSessionId, childTabId,
  operationKind, meta, childSnapshot, counts, failure }) {
  return {
    version: 1,
    operationKind,
    tabId: childTabId,
    sourceSessionId: snapshot.sourceSessionId,
    childSessionId,
    snapshotCapturedAt: snapshot.capturedAt,
    boundaryEntryUuid: snapshot.boundaryEntryUuid,
    sourceSegmentCount: snapshot.sourceSegments.length,
    sourceSegments: snapshot.sourceSegments.slice(0, 16),
    sourceSegmentsTruncated: snapshot.sourceSegments.length > 16,
    childHistoryMode: meta.history_mode || null,
    childCliVersion: meta.cli_version || null,
    childSnapshot: { size: childSnapshot?.size ?? null, mtimeMs: childSnapshot?.mtimeMs ?? null },
    counts,
    check: failure.check,
    index: failure.index ?? null,
    sourceEntryUuid: failure.sourceEntry?.uuid || null,
    childEntryUuid: failure.childEntry?.uuid || null,
    sourceRecord: describeRecord(failure.sourceRecord, snapshot.sourceSessionId),
    childRecord: describeRecord(failure.childRecord, childSessionId),
    difference: firstDifference(failure.expected, failure.actual, failure.path),
  };
}

module.exports = { describeCodexForkPrefixFailure };
