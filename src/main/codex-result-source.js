'use strict';

const fs = require('node:fs');
const { hashFileSegment, lineageError, normalizeDescriptor } = require('./codex-virtual-transcript');

const MAX_VERIFIED_SEGMENTS = 256;

// This identifies the logical source, not its latest contents. Appends and
// physical rewrites are distinguished by the returned file snapshots; a new
// fork manifest/event must never reuse the previous view's proof cursor.
function codexResultSourceRevisionKey(sessionId, lineage) {
  if (lineage?.kind === 'virtual') {
    const descriptor = normalizeDescriptor(lineage.descriptor);
    if (descriptor.viewOwnerSessionId !== sessionId) throw lineageError('view-session-mismatch');
    return JSON.stringify(['codex-result-source-v1', sessionId, 'virtual',
      descriptor.eventKey, descriptor.manifest.manifestDigest]);
  }
  if (lineage?.kind !== 'physical') throw lineageError(lineage?.reason || 'invalid-lineage-descriptor');
  return JSON.stringify(['codex-result-source-v1', sessionId, 'physical',
    lineage.legacyForkEvent?.eventKey || null]);
}

function snapshotFromStat(filePath, sessionId, stat) {
  return {
    filePath,
    sessionId,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    fileIdentity: stat.dev + ':' + stat.ino,
    linkKind: 'end',
  };
}

function snapshotSignature(snapshot) {
  return JSON.stringify([snapshot.filePath, snapshot.dev, snapshot.ino,
    snapshot.size, snapshot.mtimeMs, snapshot.ctimeMs]);
}

/**
 * Resolve byte ranges only: no JSONL records or History/Timeline projectors.
 * Every range is [fromByte, toByte); line coordinates remain physical and
 * zero-based. Frozen endLine is the manifest's expected exclusive boundary;
 * the growing tail's endLine is null until the caller streams its records.
 *
 * Verification caches only successful, unchanged file signatures and bounded
 * range digests. It grants no writer authority or append-continuity proof for
 * the growing tail. The result reader owns revalidation around its own I/O,
 * partial-line handling, invalidation and physical record decoration.
 */
function createCodexResultSourceResolver({
  codexApi,
  hashSegment = hashFileSegment,
  maxVerifiedSegments = MAX_VERIFIED_SEGMENTS,
} = {}) {
  const verified = new Map();
  const inflight = new Map();
  const limit = Number.isSafeInteger(maxVerifiedSegments) && maxVerifiedSegments > 0
    ? maxVerifiedSegments : MAX_VERIFIED_SEGMENTS;

  const resolveSnapshot = async (sessionId, cwd) => {
    if (typeof codexApi?.findCodexSessionFile !== 'function') {
      throw lineageError('codex-loader-unavailable');
    }
    const found = await codexApi.findCodexSessionFile(sessionId, cwd);
    if (!found?.filePath) throw lineageError('segment-file-missing', sessionId);
    const stat = await fs.promises.stat(found.filePath);
    return snapshotFromStat(found.filePath, sessionId, stat);
  };

  const verifyRange = async (snapshot, fromByte, toByte, digest, mismatchReason) => {
    const key = JSON.stringify([snapshot.filePath, fromByte, toByte, digest]);
    const signature = snapshotSignature(snapshot);
    if (verified.get(key) === signature) {
      verified.delete(key);
      verified.set(key, signature);
      return;
    }
    verified.delete(key);
    const flightKey = JSON.stringify([key, signature]);
    const pending = inflight.get(flightKey);
    if (pending) return pending;
    const run = (async () => {
      const actual = await hashSegment(snapshot.filePath, fromByte, toByte);
      const after = snapshotFromStat(snapshot.filePath, snapshot.sessionId,
        await fs.promises.stat(snapshot.filePath));
      // Never attach a digest read from an old inode/version to a new stat.
      // ctime also detects same-size writes whose mtime was restored.
      if (snapshotSignature(after) !== signature) {
        const error = lineageError('source-changed-during-verification');
        error.retryable = true;
        throw error;
      }
      if (actual.sha256 !== digest) throw lineageError(mismatchReason);
      verified.delete(key);
      verified.set(key, signature);
      while (verified.size > limit) verified.delete(verified.keys().next().value);
    })();
    inflight.set(flightKey, run);
    try {
      await run;
    } finally {
      if (inflight.get(flightKey) === run) inflight.delete(flightKey);
    }
  };

  const resolve = async ({ sessionId, cwd, lineage }) => {
    const revisionKey = codexResultSourceRevisionKey(sessionId, lineage);
    const descriptor = lineage.kind === 'virtual' ? normalizeDescriptor(lineage.descriptor) : null;
    const segments = [];
    for (const segment of descriptor?.manifest.sourceSegments || []) {
      const sourceSnapshot = await resolveSnapshot(segment.physicalSessionId, cwd);
      if (sourceSnapshot.size < segment.toByte) throw lineageError('source-segment-shrunk', segment.segmentId);
      await verifyRange(sourceSnapshot, segment.fromByte, segment.toByte,
        segment.prefixDigest, 'source-segment-digest-mismatch');
      segments.push({
        segmentId: segment.segmentId,
        filePath: sourceSnapshot.filePath,
        physicalSessionId: segment.physicalSessionId,
        fromByte: segment.fromByte,
        toByte: segment.toByte,
        startLine: segment.startLine,
        endLine: segment.endLine,
        frozen: true,
        digest: segment.prefixDigest,
        sourceSnapshot,
      });
    }
    const sourceSnapshot = await resolveSnapshot(sessionId, cwd);
    const tail = descriptor?.manifest.childTailStart;
    let childPrefix = null;
    if (tail) {
      if (sourceSnapshot.size < tail.byteOffset) throw lineageError('child-tail-shrunk-before-start');
      await verifyRange(sourceSnapshot, 0, tail.byteOffset, tail.prefixDigest, 'child-prefix-digest-mismatch');
      childPrefix = { fromByte: 0, toByte: tail.byteOffset, startLine: 0,
        endLine: tail.line, digest: tail.prefixDigest };
    }
    segments.push({
      segmentId: descriptor ? 'tail-' + descriptor.manifest.manifestDigest.slice(0, 24) : 'physical-' + sessionId,
      filePath: sourceSnapshot.filePath,
      physicalSessionId: sessionId,
      fromByte: tail?.byteOffset ?? 0,
      toByte: sourceSnapshot.size,
      startLine: tail?.line ?? 0,
      endLine: null,
      frozen: false,
      sourceSnapshot,
    });
    return {
      success: true,
      kind: lineage.kind,
      viewOwnerSessionId: sessionId,
      revisionKey,
      eventKey: descriptor?.eventKey || lineage.legacyForkEvent?.eventKey || null,
      manifestDigest: descriptor?.manifest.manifestDigest || null,
      segments,
      sourceSnapshot,
      childPrefix,
    };
  };

  return { resolve };
}

module.exports = { createCodexResultSourceResolver, codexResultSourceRevisionKey };
