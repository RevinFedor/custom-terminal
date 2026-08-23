'use strict';

const crypto = require('crypto');
const fs = require('fs');

const {
  normalizeCodexForkLineageManifest,
} = require('./session-history-events');

const DEFAULT_MAX_VIEWS = 8;
const DEFAULT_MAX_BYTES = 400 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;

function lineageError(reason, detail = null) {
  const error = new Error('lineage_unresolved');
  error.code = 'CODEX_LINEAGE_UNRESOLVED';
  error.reason = reason;
  if (detail !== null && detail !== undefined) error.detail = detail;
  return error;
}

async function hashFileSegment(filePath, fromByte, toByte) {
  const start = Number(fromByte);
  const endExclusive = Number(toByte);
  if (!filePath
    || !Number.isInteger(start)
    || !Number.isInteger(endExclusive)
    || start < 0
    || endExclusive < start) {
    throw lineageError('invalid-segment-range');
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  if (endExclusive > start) {
    const stream = fs.createReadStream(filePath, {
      start,
      end: endExclusive - 1,
      highWaterMark: HASH_CHUNK_BYTES,
    });
    for await (const chunk of stream) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  }
  if (bytes !== endExclusive - start) {
    throw lineageError('segment-short-read', { expected: endExclusive - start, actual: bytes });
  }
  return { bytes, sha256: hash.digest('hex') };
}

function decoratePhysicalRecord(record, segment, segmentIndex) {
  return {
    ...record,
    __physicalSessionId: segment.physicalSessionId,
    __segmentId: segment.segmentId,
    __segmentIndex: segmentIndex,
  };
}

function virtualEntryRef(viewOwnerSessionId, entry, segmentBySession) {
  const physicalSessionId = String(entry?.sessionId || '');
  const segment = segmentBySession.get(physicalSessionId) || null;
  return {
    viewOwnerSessionId,
    segmentId: segment?.segmentId || ('tail:' + physicalSessionId),
    physicalSessionId,
    rawUuid: String(entry?.uuid || ''),
    sourceIdentity: typeof entry?.sourceIdentity === 'string' ? entry.sourceIdentity : null,
  };
}

function decorateVirtualEntries(entries, viewOwnerSessionId, segmentBySession) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const entryRef = virtualEntryRef(viewOwnerSessionId, entry, segmentBySession);
    return {
      ...entry,
      viewOwnerSessionId,
      physicalSessionId: entryRef.physicalSessionId,
      transcriptSegmentId: entryRef.segmentId,
      rawUuid: entryRef.rawUuid,
      entryRef,
    };
  });
}

function childTailSegment(descriptor) {
  return {
    segmentId: 'tail-' + descriptor.manifest.manifestDigest.slice(0, 24),
    physicalSessionId: descriptor.viewOwnerSessionId,
    fromByte: descriptor.manifest.childTailStart.byteOffset,
    startLine: descriptor.manifest.childTailStart.line,
  };
}

function normalizeDescriptor(input) {
  const viewOwnerSessionId = String(input?.viewOwnerSessionId || '').trim();
  const eventKey = String(input?.eventKey || '').trim();
  const manifest = normalizeCodexForkLineageManifest(input?.manifest, {
    childSessionId: viewOwnerSessionId,
  });
  if (!viewOwnerSessionId || !eventKey || !manifest) {
    throw lineageError('invalid-lineage-descriptor');
  }
  const payloadPolicy = input?.payloadPolicy === 'full' ? 'full' : 'dehydrated';
  return { viewOwnerSessionId, eventKey, manifest, payloadPolicy };
}

function cacheKeyForDescriptor(descriptor) {
  return descriptor.viewOwnerSessionId + ':' + descriptor.eventKey + ':'
    + descriptor.manifest.manifestDigest + ':' + descriptor.payloadPolicy;
}

function createCodexVirtualTranscriptStore({
  codexApi,
  maxViews = DEFAULT_MAX_VIEWS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!codexApi
    || typeof codexApi.findCodexSessionFile !== 'function'
    || typeof codexApi.readJsonlRange !== 'function'
    || typeof codexApi.createCodexHistoryProjector !== 'function'
    || typeof codexApi.createCodexTimelineProjector !== 'function') {
    throw new Error('codex virtual transcript dependencies unavailable');
  }

  const cache = new Map();
  const chains = new Map();
  let retainedBytes = 0;

  const resolveFile = async (sessionId, cwd) => {
    const found = await codexApi.findCodexSessionFile(sessionId, cwd);
    if (!found?.filePath) throw lineageError('segment-file-missing', sessionId);
    return found.filePath;
  };

  const feedRecords = (state, records, segment, segmentIndex) => {
    for (const record of Array.isArray(records) ? records : []) {
      const physical = decoratePhysicalRecord(record, segment, segmentIndex);
      state.historyProjector.feed(physical);
      state.timelineProjector.feed(physical);
    }
  };

  const verifyFrozenSegment = async (state, segment, cwd) => {
    const filePath = state.segmentFiles.get(segment.segmentId)
      || await resolveFile(segment.physicalSessionId, cwd);
    state.segmentFiles.set(segment.segmentId, filePath);
    const stat = await fs.promises.stat(filePath);
    if (stat.size < segment.toByte) {
      throw lineageError('source-segment-shrunk', segment.segmentId);
    }
    const previous = state.sourceVerification.get(segment.segmentId);
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
      return filePath;
    }
    const digest = await hashFileSegment(filePath, segment.fromByte, segment.toByte);
    if (digest.sha256 !== segment.prefixDigest) {
      throw lineageError('source-segment-digest-mismatch', segment.segmentId);
    }
    state.sourceVerification.set(segment.segmentId, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    return filePath;
  };

  const buildState = async (descriptor, cwd) => {
    const state = {
      key: cacheKeyForDescriptor(descriptor),
      descriptor,
      historyProjector: codexApi.createCodexHistoryProjector(descriptor.viewOwnerSessionId),
      timelineProjector: codexApi.createCodexTimelineProjector(descriptor.viewOwnerSessionId),
      segmentFiles: new Map(),
      sourceVerification: new Map(),
      childFilePath: null,
      childSize: 0,
      childMtimeMs: 0,
      childLineCount: descriptor.manifest.childTailStart.line,
      childLeftoverBuffer: Buffer.alloc(0),
      approxBytes: 0,
      mode: 'rebuild',
      fedRecords: 0,
    };
    const frozen = descriptor.manifest.sourceSegments;
    for (let index = 0; index < frozen.length; index += 1) {
      const segment = frozen[index];
      const filePath = await verifyFrozenSegment(state, segment, cwd);
      const read = await codexApi.readJsonlRange(filePath, segment.fromByte, segment.toByte - 1, {
        lineCount: segment.startLine,
      });
      if (read.errors > 0
        || read.leftoverBuffer?.length > 0
        || read.lineCount !== segment.endLine) {
        throw lineageError('source-segment-record-boundary-mismatch', segment.segmentId);
      }
      feedRecords(state, read.records, segment, index);
      state.fedRecords += read.records.length;
    }

    const tail = childTailSegment(descriptor);
    const childFilePath = await resolveFile(descriptor.viewOwnerSessionId, cwd);
    const childStat = await fs.promises.stat(childFilePath);
    if (childStat.size < tail.fromByte) {
      throw lineageError('child-tail-shrunk-before-start');
    }
    const childPrefix = await hashFileSegment(childFilePath, 0, tail.fromByte);
    if (childPrefix.sha256 !== descriptor.manifest.childTailStart.prefixDigest) {
      throw lineageError('child-prefix-digest-mismatch');
    }
    const childRead = await codexApi.readJsonlRange(
      childFilePath,
      tail.fromByte,
      childStat.size - 1,
      { lineCount: tail.startLine },
    );
    feedRecords(state, childRead.records, tail, frozen.length);
    state.fedRecords += childRead.records.length;
    state.childFilePath = childFilePath;
    state.childSize = childStat.size;
    state.childMtimeMs = childStat.mtimeMs;
    state.childPrefixVerifiedMtimeMs = childStat.mtimeMs;
    state.childLineCount = childRead.lineCount;
    state.childLeftoverBuffer = childRead.leftoverBuffer || Buffer.alloc(0);
    return state;
  };

  const advanceState = async (state, cwd) => {
    for (const segment of state.descriptor.manifest.sourceSegments) {
      await verifyFrozenSegment(state, segment, cwd);
    }
    const stat = await fs.promises.stat(state.childFilePath);
    if (stat.mtimeMs !== state.childPrefixVerifiedMtimeMs) {
      const tail = childTailSegment(state.descriptor);
      const childPrefix = await hashFileSegment(state.childFilePath, 0, tail.fromByte);
      if (childPrefix.sha256 !== state.descriptor.manifest.childTailStart.prefixDigest) {
        throw lineageError('child-prefix-digest-mismatch');
      }
      state.childPrefixVerifiedMtimeMs = stat.mtimeMs;
    }
    if (stat.size === state.childSize && stat.mtimeMs === state.childMtimeMs) {
      state.mode = 'unchanged';
      state.fedRecords = 0;
      return state;
    }
    if (stat.size < state.childSize
      || (stat.size === state.childSize && stat.mtimeMs !== state.childMtimeMs)) {
      return buildState(state.descriptor, cwd);
    }
    const tail = childTailSegment(state.descriptor);
    const read = await codexApi.readJsonlRange(
      state.childFilePath,
      state.childSize,
      stat.size - 1,
      {
        lineCount: state.childLineCount,
        leftoverBuffer: state.childLeftoverBuffer,
      },
    );
    feedRecords(state, read.records, tail, state.descriptor.manifest.sourceSegments.length);
    state.childSize = stat.size;
    state.childMtimeMs = stat.mtimeMs;
    state.childLineCount = read.lineCount;
    state.childLeftoverBuffer = read.leftoverBuffer || Buffer.alloc(0);
    state.mode = 'append';
    state.fedRecords = read.records.length;
    return state;
  };

  const recostAndPrune = (state) => {
    const previous = cache.get(state.key);
    if (previous) retainedBytes = Math.max(0, retainedBytes - (previous.approxBytes || 0));
    const peek = state.historyProjector.peekEntries?.() || [];
    state.approxBytes = typeof codexApi.estimateProjectorBytes === 'function'
      ? codexApi.estimateProjectorBytes(peek)
      : peek.length * 256;
    cache.delete(state.key);
    cache.set(state.key, state);
    retainedBytes += state.approxBytes;
    const boundedViews = Math.max(1, Number(maxViews) || DEFAULT_MAX_VIEWS);
    const boundedBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
    while (cache.size > boundedViews || (retainedBytes > boundedBytes && cache.size > 1)) {
      const oldestKey = cache.keys().next().value;
      if (!oldestKey || oldestKey === state.key) break;
      const evicted = cache.get(oldestKey);
      cache.delete(oldestKey);
      retainedBytes = Math.max(0, retainedBytes - (evicted?.approxBytes || 0));
    }
  };

  const projectInner = async (input, cwd) => {
    const descriptor = normalizeDescriptor(input);
    const key = cacheKeyForDescriptor(descriptor);
    let state = cache.get(key) || null;
    state = state ? await advanceState(state, cwd) : await buildState(descriptor, cwd);
    state.descriptor = descriptor;
    recostAndPrune(state);
    const tail = childTailSegment(descriptor);
    const segmentBySession = new Map(
      [...descriptor.manifest.sourceSegments, tail]
        .map((segment) => [segment.physicalSessionId, segment]),
    );
    const historyEntries = decorateVirtualEntries(
      state.historyProjector.finalize(),
      descriptor.viewOwnerSessionId,
      segmentBySession,
    );
    const timelineEntries = decorateVirtualEntries(
      state.timelineProjector.finalize(),
      descriptor.viewOwnerSessionId,
      segmentBySession,
    );
    return {
      success: true,
      viewOwnerSessionId: descriptor.viewOwnerSessionId,
      eventKey: descriptor.eventKey,
      manifest: descriptor.manifest,
      mode: state.mode,
      fedRecords: state.fedRecords,
      historyEntries,
      timelineEntries,
      sessionMeta: {
        id: descriptor.viewOwnerSessionId,
        forked_from_id: descriptor.manifest.sourceSessionId,
        forkLiveStartLine: descriptor.manifest.childTailStart.line,
      },
      filePath: state.childFilePath,
      childSnapshot: {
        filePath: state.childFilePath,
        size: state.childSize,
        mtimeMs: state.childMtimeMs,
        sessionId: descriptor.viewOwnerSessionId,
        linkKind: 'end',
      },
      frozenSnapshots: descriptor.manifest.sourceSegments.map((segment) => ({
        filePath: state.segmentFiles.get(segment.segmentId),
        size: segment.toByte,
        mtimeMs: 0,
        sessionId: segment.physicalSessionId,
        linkKind: 'jsonl',
      })),
      childLineCount: state.childLineCount,
    };
  };

  const project = (input, cwd) => {
    let descriptor;
    try {
      descriptor = normalizeDescriptor(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = cacheKeyForDescriptor(descriptor);
    const previous = chains.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => projectInner(descriptor, cwd));
    chains.set(key, run);
    run.finally(() => {
      if (chains.get(key) === run) chains.delete(key);
    }).catch(() => {});
    return run;
  };

  const readRecords = async (input, cwd) => {
    const descriptor = normalizeDescriptor(input);
    const records = [];
    const frozen = descriptor.manifest.sourceSegments;
    for (let index = 0; index < frozen.length; index += 1) {
      const segment = frozen[index];
      const filePath = await resolveFile(segment.physicalSessionId, cwd);
      const stat = await fs.promises.stat(filePath);
      if (stat.size < segment.toByte) throw lineageError('source-segment-shrunk', segment.segmentId);
      const digest = await hashFileSegment(filePath, segment.fromByte, segment.toByte);
      if (digest.sha256 !== segment.prefixDigest) {
        throw lineageError('source-segment-digest-mismatch', segment.segmentId);
      }
      const read = await codexApi.readJsonlRange(filePath, segment.fromByte, segment.toByte - 1, {
        lineCount: segment.startLine,
      });
      if (read.errors > 0 || read.leftoverBuffer?.length > 0 || read.lineCount !== segment.endLine) {
        throw lineageError('source-segment-record-boundary-mismatch', segment.segmentId);
      }
      records.push(...read.records.map((record) => decoratePhysicalRecord(record, segment, index)));
    }
    const tail = childTailSegment(descriptor);
    const childFilePath = await resolveFile(descriptor.viewOwnerSessionId, cwd);
    const childStat = await fs.promises.stat(childFilePath);
    if (childStat.size < tail.fromByte) throw lineageError('child-tail-shrunk-before-start');
    const childPrefix = await hashFileSegment(childFilePath, 0, tail.fromByte);
    if (childPrefix.sha256 !== descriptor.manifest.childTailStart.prefixDigest) {
      throw lineageError('child-prefix-digest-mismatch');
    }
    const child = await codexApi.readJsonlRange(childFilePath, tail.fromByte, childStat.size - 1, {
      lineCount: tail.startLine,
    });
    records.push(...child.records.map((record) => decoratePhysicalRecord(record, tail, frozen.length)));
    return {
      success: true,
      records,
      filePath: childFilePath,
      childSnapshot: {
        filePath: childFilePath,
        size: childStat.size,
        mtimeMs: childStat.mtimeMs,
        sessionId: descriptor.viewOwnerSessionId,
        linkKind: 'end',
      },
    };
  };

  return {
    project,
    readRecords,
    hashFileSegment,
    stats: () => ({ views: cache.size, approxBytes: retainedBytes }),
    clear: () => {
      cache.clear();
      chains.clear();
      retainedBytes = 0;
    },
  };
}

module.exports = {
  createCodexVirtualTranscriptStore,
  decorateVirtualEntries,
  hashFileSegment,
  lineageError,
  normalizeDescriptor,
};
