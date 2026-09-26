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
  storage = null,
  prepareEntries = null,
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
  const metrics = { sourceBytes: 0, sourceVerificationBytes: 0, continuationRestores: 0 };
  const hashSegment = async (...args) => {
    const result = await hashFileSegment(...args); metrics.sourceVerificationBytes += result.bytes; return result;
  };
  const sameSource = (a, b) => !!a && !!b && a.filePath === b.filePath
    && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
    && a.fileIdentity === b.fileIdentity && a.sourceGeneration === b.sourceGeneration;
  const capture = async (reads, filePath, sessionId) => {
    if (!reads.has(filePath)) {
      if (codexApi.beginCodexSourceRead) reads.set(filePath, await codexApi.beginCodexSourceRead(filePath, sessionId));
      else {
        const stat = await fs.promises.stat(filePath);
        reads.set(filePath, { snapshot: { filePath, sessionId, size: stat.size, mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino, linkKind: 'end' } });
      }
    }
    return reads.get(filePath).snapshot;
  };
  const assertReads = async reads => {
    for (const read of reads.values()) {
      if (codexApi.assertCodexSourceRead) await codexApi.assertCodexSourceRead(read);
      else {
        const stat = await fs.promises.stat(read.snapshot.filePath);
        if (!sameSource(read.snapshot, { ...read.snapshot, size: stat.size, mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino })) throw lineageError('source-changed-during-read');
      }
    }
  };
  const finishReads = reads => { for (const read of reads.values()) codexApi.finishCodexSourceRead?.(read); };
  const rememberChunk = (state, chunk, offset) => {
    metrics.sourceBytes += chunk.length;
    state.childProof.push({ offset, bytes: chunk.length, hash: crypto.createHash('sha256').update(chunk).digest('hex') });
  };
  const restoreState = async (descriptor, cwd) => {
    if (descriptor.payloadPolicy !== 'dehydrated') return null;
    const saved = storage?.readVirtualState({ sessionId: descriptor.viewOwnerSessionId, cwd }, descriptor);
    if (!saved) return null;
    const { history, timeline, ...state } = saved;
    for (const source of [...state.sourceVerification.values(), state.childSnapshot]) {
      const found = await codexApi.findCodexSessionFile(source.sessionId, cwd);
      if (found?.filePath !== source.filePath) return null;
      const stat = await fs.promises.stat(source.filePath).catch(() => null);
      if (!stat) return null;
      const current = { ...source, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, fileIdentity: stat.dev + ':' + stat.ino };
      if (sameSource(source, current)) {
        if (codexApi.restoreCodexSourceSnapshot?.(source) === false) return null;
      } else if (source === state.childSnapshot) {
        if (current.fileIdentity !== source.fileIdentity || current.size <= source.size) return null;
        // A persisted tail may have grown while the app was stopped. Verify
        // the old bytes before treating growth as an append; no JSON replay.
        let offset = 0;
        for (const proof of state.childProof || []) {
          if (proof.offset !== offset) return null;
          const digest = await hashSegment(source.filePath, offset, offset + proof.bytes);
          if (digest.sha256 !== proof.hash) return null;
          offset += proof.bytes;
        }
        const after = await fs.promises.stat(source.filePath);
        if (!sameSource(current, { ...current, size: after.size, mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs, fileIdentity: after.dev + ':' + after.ino })) return null;
        if (offset !== source.size || codexApi.restoreCodexSourceSnapshot?.(source) === false) return null;
      }
      if (sameSource(source, current) || source === state.childSnapshot) {
        if (codexApi.isCodexSourceSnapshotCurrent?.(source) === false) {
          throw Object.assign(new Error('Codex source changed during read'), { code: 'CODEX_SOURCE_READ_INVALIDATED' });
        }
      }
    }
    state.historyProjector = codexApi.createCodexHistoryProjector(descriptor.viewOwnerSessionId, history);
    state.timelineProjector = codexApi.createCodexTimelineProjector(descriptor.viewOwnerSessionId, timeline);
    metrics.continuationRestores++;
    return state;
  };
  const forget = key => {
    retainedBytes = Math.max(0, retainedBytes - (cache.get(key)?.approxBytes || 0)); cache.delete(key);
  };
  const unsubscribe = codexApi.observeCodexReadInvalidation?.(({ filePath, readRefresh, sourceAppend }) => {
    if (readRefresh || sourceAppend) return;
    for (const [key, state] of cache) if (!filePath || state.childFilePath === filePath
      || [...state.segmentFiles.values()].includes(filePath)) forget(key);
  });

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

  const verifyFrozenSegment = async (state, segment, cwd, reads) => {
    const filePath = await resolveFile(segment.physicalSessionId, cwd);
    state.segmentFiles.set(segment.segmentId, filePath);
    const stat = await capture(reads, filePath, segment.physicalSessionId);
    if (stat.size < segment.toByte) {
      throw lineageError('source-segment-shrunk', segment.segmentId);
    }
    const previous = state.sourceVerification.get(segment.segmentId);
    if (sameSource(previous, stat)) {
      return filePath;
    }
    const digest = await hashSegment(filePath, segment.fromByte, segment.toByte);
    if (digest.sha256 !== segment.prefixDigest) {
      throw lineageError('source-segment-digest-mismatch', segment.segmentId);
    }
    state.sourceVerification.set(segment.segmentId, stat);
    return filePath;
  };

  const buildState = async (descriptor, cwd, reads) => {
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
      childProof: [],
    };
    const frozen = descriptor.manifest.sourceSegments;
    for (let index = 0; index < frozen.length; index += 1) {
      const segment = frozen[index];
      const filePath = await verifyFrozenSegment(state, segment, cwd, reads);
      const read = await codexApi.readJsonlRange(filePath, segment.fromByte, segment.toByte - 1, {
        lineCount: segment.startLine,
        onChunk: chunk => { metrics.sourceBytes += chunk.length; },
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
    const childStat = await capture(reads, childFilePath, descriptor.viewOwnerSessionId);
    if (childStat.size < tail.fromByte) {
      throw lineageError('child-tail-shrunk-before-start');
    }
    const childPrefix = await hashSegment(childFilePath, 0, tail.fromByte);
    if (childPrefix.sha256 !== descriptor.manifest.childTailStart.prefixDigest) {
      throw lineageError('child-prefix-digest-mismatch');
    }
    const childRead = await codexApi.readJsonlRange(
      childFilePath,
      tail.fromByte,
      childStat.size - 1,
      { lineCount: tail.startLine, onChunk: (chunk, offset) => rememberChunk(state, chunk, offset) },
    );
    if (tail.fromByte > 0) state.childProof.unshift({ offset: 0, bytes: tail.fromByte, hash: childPrefix.sha256 });
    feedRecords(state, childRead.records, tail, frozen.length);
    state.fedRecords += childRead.records.length;
    state.childFilePath = childFilePath;
    state.childSnapshot = childStat;
    state.childSize = childStat.size;
    state.childMtimeMs = childStat.mtimeMs;
    state.childPrefixVerifiedMtimeMs = childStat.mtimeMs;
    state.childLineCount = childRead.lineCount;
    state.childLeftoverBuffer = childRead.leftoverBuffer || Buffer.alloc(0);
    return state;
  };

  const advanceState = async (state, cwd, reads) => {
    for (const segment of state.descriptor.manifest.sourceSegments) {
      await verifyFrozenSegment(state, segment, cwd, reads);
    }
    const childPath = await resolveFile(state.descriptor.viewOwnerSessionId, cwd);
    const stat = await capture(reads, childPath, state.descriptor.viewOwnerSessionId);
    if (!sameSource(state.childSnapshot, stat)) {
      const tail = childTailSegment(state.descriptor);
      const childPrefix = await hashSegment(childPath, 0, tail.fromByte);
      if (childPrefix.sha256 !== state.descriptor.manifest.childTailStart.prefixDigest) {
        throw lineageError('child-prefix-digest-mismatch');
      }
      state.childPrefixVerifiedMtimeMs = stat.mtimeMs;
    }
    if (sameSource(state.childSnapshot, stat)) {
      state.mode = 'unchanged';
      state.fedRecords = 0;
      return state;
    }
    if (stat.filePath !== state.childSnapshot.filePath || stat.fileIdentity !== state.childSnapshot.fileIdentity
      || stat.sourceGeneration !== state.childSnapshot.sourceGeneration || stat.size <= state.childSize) {
      return buildState(state.descriptor, cwd, reads);
    }
    const tail = childTailSegment(state.descriptor);
    const read = await codexApi.readJsonlRange(
      state.childFilePath,
      state.childSize,
      stat.size - 1,
      {
        lineCount: state.childLineCount,
        leftoverBuffer: state.childLeftoverBuffer,
        onChunk: (chunk, offset) => rememberChunk(state, chunk, offset),
      },
    );
    feedRecords(state, read.records, tail, state.descriptor.manifest.sourceSegments.length);
    state.childSize = stat.size;
    state.childSnapshot = stat;
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
    const reads = new Map();
    const release = !cache.has(key) ? await storage?.enterCold?.() : null;
    try {
      let state = cache.get(key) || await restoreState(descriptor, cwd);
      state = state ? await advanceState(state, cwd, reads) : await buildState(descriptor, cwd, reads);
      state.descriptor = descriptor;
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
      await assertReads(reads);
      if (storage && descriptor.payloadPolicy === 'dehydrated' && state.mode !== 'unchanged') {
        prepareEntries?.(historyEntries, descriptor.viewOwnerSessionId);
        const { historyProjector, timelineProjector, ...continuation } = state;
        storage.saveVirtualState({ sessionId: descriptor.viewOwnerSessionId, cwd }, { ...continuation,
          history: historyProjector.exportState(), timeline: timelineProjector.exportState() });
      }
      recostAndPrune(state);
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
        childSnapshot: state.childSnapshot,
        physicalSources: [...reads.values()].map(read => read.snapshot),
        frozenSnapshots: descriptor.manifest.sourceSegments.map((segment) => ({
          ...state.sourceVerification.get(segment.segmentId),
          // The view owns a fixed prefix, not future appends of its ancestor.
          // Physical freshness lives separately in physicalSources/read tickets.
          size: segment.toByte,
          mtimeMs: 0,
          ctimeMs: null,
          linkKind: 'jsonl',
        })),
        childLineCount: state.childLineCount,
        childHasPartialRecord: state.childLeftoverBuffer?.length > 0,
      };
    } catch (error) { forget(key); throw error; }
    finally { finishReads(reads); release?.(); }
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

  const readRecords = async (input, cwd, { childSnapshot = null } = {}) => {
    const descriptor = normalizeDescriptor(input);
    const reads = new Map();
    try {
      const records = [];
      const frozen = descriptor.manifest.sourceSegments;
      for (let index = 0; index < frozen.length; index += 1) {
        const segment = frozen[index];
        const filePath = await resolveFile(segment.physicalSessionId, cwd);
        const stat = await capture(reads, filePath, segment.physicalSessionId);
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
      const childStat = await capture(reads, childFilePath, descriptor.viewOwnerSessionId);
      if (childStat.size < tail.fromByte) throw lineageError('child-tail-shrunk-before-start');
      const childEnd = childSnapshot ? Number(childSnapshot.size) : childStat.size;
      if (!Number.isSafeInteger(childEnd) || childEnd < tail.fromByte || childEnd > childStat.size) {
        throw lineageError('child-snapshot-range-invalid');
      }
      const childPrefix = await hashFileSegment(childFilePath, 0, tail.fromByte);
      if (childPrefix.sha256 !== descriptor.manifest.childTailStart.prefixDigest) {
        throw lineageError('child-prefix-digest-mismatch');
      }
      const child = await codexApi.readJsonlRange(childFilePath, tail.fromByte, childEnd - 1, {
        lineCount: tail.startLine,
      });
      if (child.errors > 0 || child.leftoverBuffer?.length > 0) {
        throw lineageError('child-tail-record-boundary-mismatch');
      }
      records.push(...child.records.map((record) => decoratePhysicalRecord(record, tail, frozen.length)));
      await assertReads(reads);
      return {
        success: true,
        records,
        filePath: childFilePath,
        childSnapshot: {
          ...childStat,
          size: childEnd,
          mtimeMs: childStat.mtimeMs,
          sessionId: descriptor.viewOwnerSessionId,
          linkKind: 'end',
        },
      };
    } finally { finishReads(reads); }
  };

  return {
    project,
    readRecords,
    hashFileSegment,
    dispose: () => { unsubscribe?.(); cache.clear(); retainedBytes = 0; },
    stats: () => ({ views: cache.size, approxBytes: retainedBytes, ...metrics }),
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
