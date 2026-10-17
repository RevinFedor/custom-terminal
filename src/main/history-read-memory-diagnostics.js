'use strict';

const { performance } = require('node:perf_hooks');
const { getHeapStatistics } = require('node:v8');
const { isMainThread, threadId } = require('node:worker_threads');
const enqueueMicrotask = queueMicrotask;
let sequence = 0;
const numberFields = ['sourceBytes', 'records', 'preparedRows', 'returnedRows', 'totalIterations', 'matches',
  'projectionQueueUs', 'projectionRawReadUs', 'projectionHistoryFeedUs', 'projectionHistoryFinalizeUs',
  'projectionTimelineFeedUs', 'projectionTimelineFinalizeUs', 'projectionMetadataUs', 'projectionDtoUs',
  'projectionSlices', 'projectionYields', 'projectionMaxSliceUs', 'projectionMaxUnitUs',
  'projectionHistoryFedRecords', 'projectionTimelineFedRecords'];
const token = value => typeof value === 'string' && /^[\w.:-]{1,100}$/.test(value) ? value : undefined;
const snapshotFields = (fields = {}) => {
  const counts = {};
  for (const key of numberFields) {
    const value = fields[key];
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  return { ...counts, errorCode: token(fields.errorCode), projectionMode: token(fields.projectionMode) };
};

// Admission and terminal snapshots, never a heap walk, body serialization, timer
// or extra transcript read. Optional prepared() is provisional, before the final
// guard. Arm deferSuccess() before the last synchronous guard, then invoke its
// commit in the same frame. Even native scheduling can reenter via async hooks;
// commit only records clocks/state, and emission uses the prepared scalars.
// Default end() remains synchronous and one-shot.
// RSS is process-wide, heap isolate-wide; missing completion is unknown.
function beginHistoryReadDiagnostic(kind, identity = {}) {
  const started = performance.now();
  const readId = token(identity.readId) || `hrm-${process.pid}-${++sequence}`;
  const base = { readId, kind: token(kind), sessionId: token(identity.sessionId),
    provider: token(identity.provider), caller: token(identity.caller), pid: process.pid, threadId,
    isolate: isMainThread ? 'main' : 'worker' };
  const decisionClock = () => {
    const now = performance.now();
    return { decisionAbs: performance.timeOrigin + now, decisionElapsedMs: now - started };
  };
  const emit = (phase, fields = {}, decision = decisionClock()) => {
    try {
      const memory = process.memoryUsage();
      const emitted = performance.now();
      console.log('[HistoryReadMemory] ' + JSON.stringify({ ...base, phase,
        ...decision, emittedAbs: performance.timeOrigin + emitted, elapsedMs: emitted - started,
        ...fields,
        heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
        processRssBytes: memory.rss, externalBytes: memory.external,
        coverage: 'phase-snapshot; heap-isolate/rss-process; not-peak-or-exclusive-allocation' }));
    } catch { /* Diagnostics cannot change read admission or its outcome. */ }
  };
  emit('start');
  let ended = false;
  let preparedFields;
  return { readId, prepared(fields) {
    if (ended || preparedFields) return;
    try {
      preparedFields = snapshotFields(fields);
      emit('prepared', preparedFields);
    } catch { /* Diagnostics cannot change read admission or its outcome. */ }
  }, deferSuccess() {
    if (ended) return () => {};
    let decision;
    enqueueMicrotask(() => { if (decision) emit('complete', preparedFields, decision); });
    return () => {
      if (ended) return;
      ended = true;
      decision = decisionClock();
    };
  }, end(outcome, fields) {
    if (ended) return;
    ended = true;
    const decision = decisionClock();
    try { emit(outcome === 'success' ? 'complete' : 'error', { ...preparedFields, ...snapshotFields(fields) }, decision); }
    catch { /* Diagnostics cannot change read admission or its outcome. */ }
  } };
}

module.exports = { beginHistoryReadDiagnostic };
