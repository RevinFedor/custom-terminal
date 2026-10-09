'use strict';

// A bounded extension of the EXISTING external flight-recorder artifact store.
// No file IO or payload/DOM inspection on the Main or renderer input path.
const STRING_FIELDS = new Set(['sourceBoot', 'sourceKind', 'spanId', 'parentSpanId', 'name', 'kind', 'phase', 'state', 'outcome',
  'actionId', 'readId', 'requestId', 'tabId', 'sessionId', 'fileIdentity', 'caller', 'mode', 'reason', 'threadCpuSource',
  'threadCpuUnavailableReason', 'gcCoverage', 'cpuCoverage', 'keyClass', 'event', 'owner', 'visibility', 'incidentId',
  'targetSource', 'targetTag', 'historyOwner']);
const NUMBER_FIELDS = new Set(['sourceSeq', 'sourcePid', 'emittedAbs', 'enteredAbs', 'syncReturnedAbs', 'syncMs', 'settledAbs',
  'lifetimeMs', 'startAbs', 'durationMs', 'inputDelayMs', 'handlerMs', 'presentationMs', 'receivedAbs', 'threadCpuMs',
  'processCpuUserMs', 'processCpuSystemMs', 'sourceBytes', 'deltaBytes', 'recordsBefore', 'recordsAfter', 'snapshotRecords',
  'rows', 'bytes', 'gcObservedOverlapMs', 'gcEntries', 'gcDropped', 'gcId', 'gcKind', 'gcFlags', 'observedAbs',
  'gestureGeneration', 'visit', 'ringDropped', 'transportDrops', 'rateDrops', 'noWriterDrops', 'backpressureDrops']);
const BOOL_FIELDS = new Set(['returnedPromise', 'meta', 'ctrl', 'alt', 'shift', 'repeat', 'focused']);
function cleanCausalRecord(input, origin, receivedAt) {
  if (!input || typeof input !== 'object' || !Number.isInteger(origin?.pid) || origin.pid <= 0) return null;
  const record = { schema: 2, sourcePid: origin.pid, sourceKind: origin.kind, watchdogReceivedAbs: receivedAt };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'sourcePid' || key === 'sourceKind') continue;
    if (STRING_FIELDS.has(key) && (value === null || typeof value === 'string')) {
      record[key] = value === null ? null : value.replace(/[\r\n\t]/g, '_').slice(0, key === 'spanId' || key === 'parentSpanId' ? 112 : 100);
    } else if (NUMBER_FIELDS.has(key) && (value === null || (typeof value === 'number' && Number.isFinite(value)))) record[key] = value;
    else if (BOOL_FIELDS.has(key) && typeof value === 'boolean') record[key] = value;
  }
  if (!record.kind || !record.sourceBoot || !Number.isFinite(record.emittedAbs)) return null;
  return record;
}

function createCausalJournal({ artifacts, now = Date.now, maxPerMinute = 60, maxQueued = 64,
  // Full raw-reader correlation + CPU/GC fields exceeded1KiB in the real
  // reader test. Keep those causal fields together under a measured2KiB cap.
  maxRecordBytes = 2048, log = () => {} } = {}) {
  const pending = [], sources = new Map(), active = new Map(), recent = [];
  const counts = { received: 0, written: 0, droppedRate: 0, droppedQueue: 0, droppedBytes: 0,
    droppedMalformed: 0, sourceEvictions: 0, sequenceGaps: 0, diskErrors: 0, reconciledSettlements: 0, unknownSpans: 0 };
  let lastFlushAt = now(), lastFlushLagMs = null, lastErrorAt = -Infinity;
  function observeSequence(input, origin) {
    const data = cleanCausalRecord({ ...input, kind: 'sequence' }, origin, now());
    if (!data) return null;
    const at = now();
    const key = data.sourcePid + ':' + data.sourceBoot;
    if (!sources.has(key) && sources.size >= 64) { sources.delete(sources.keys().next().value); counts.sourceEvictions++; }
    let source = sources.get(key);
    if (!source) { source = { since: at, count: 0, critical: 0, lastSeq: null }; sources.set(key, source); }
    if (Number.isFinite(data.sourceSeq)) {
      if (source.lastSeq !== null && data.sourceSeq > source.lastSeq + 1) {
        counts.sequenceGaps += data.sourceSeq - source.lastSeq - 1;
        for (const [id, op] of active) if (op.sourcePid === data.sourcePid && op.sourceBoot === data.sourceBoot) {
          active.set(id, { ...op, state: 'unknown', reason: 'source-sequence-gap' });
        }
      }
      source.lastSeq = Math.max(source.lastSeq ?? data.sourceSeq, data.sourceSeq);
    }
    return source;
  }
  function record(input, origin, { critical = false } = {}) {
    const at = now(), data = cleanCausalRecord(input, origin, at);
    if (!data) { counts.droppedMalformed++; return false; }
    const encoded = JSON.stringify(data);
    counts.received++;
    const source = observeSequence(data, origin);
    // Even rate-limited records maintain the bounded live span context. A stall
    // incident receives this context, rather than an opaque old IPC age string.
    if (data.kind === 'span' && data.spanId) {
      if (data.phase === 'settle') active.delete(data.spanId);
      else { active.set(data.spanId, data); if (active.size > 64) active.delete(active.keys().next().value); }
    }
    recent.push(data); if (recent.length > 32) recent.shift();
    if (Buffer.byteLength(encoded) > maxRecordBytes) { counts.droppedBytes++; return false; }
    if (at - source.since >= 60000) { source.since = at; source.count = 0; source.critical = 0; }
    // Reserve separate small space for actual stall/resume boundaries. Neither
    // stream is unbounded; a loss is surfaced in the next recorder heartbeat.
    if (critical ? source.critical >= 12 : source.count >= maxPerMinute) { counts.droppedRate++; return false; }
    if (critical) source.critical++; else source.count++;
    if (pending.length >= maxQueued) {
      if (!critical) { counts.droppedQueue++; return false; }
      pending.shift(); counts.droppedQueue++;
    }
    pending.push({ line: encoded + '\n', at });
    return true;
  }
  function reconcile(snapshot, origin) {
    if (!snapshot || typeof snapshot.sourceBoot !== 'string' || !Number.isFinite(snapshot.emittedAbs)) return;
    const live = new Map((Array.isArray(snapshot.active) ? snapshot.active.slice(-8) : [])
      .filter(op => typeof op?.spanId === 'string').map(op => [op.spanId, op]));
    const settled = new Map((Array.isArray(snapshot.recent) ? snapshot.recent.slice(-4) : [])
      .filter(op => op?.phase === 'settle' && typeof op.spanId === 'string' && Number.isFinite(op.settledAbs))
      .map(op => [op.spanId, op]));
    for (const [id, previous] of active) {
      if (previous.sourcePid !== origin.pid || previous.sourceBoot !== snapshot.sourceBoot || previous.emittedAbs > snapshot.emittedAbs) continue;
      const completed = settled.get(id);
      if (completed) {
        record({ ...completed, kind: 'span', phase: 'settle', state: 'settled',
          sourceBoot: snapshot.sourceBoot, emittedAbs: completed.settledAbs, reason: 'heartbeat-confirmed-settlement' }, origin);
        counts.reconciledSettlements++;
      } else if (live.has(id)) {
        const confirmed = cleanCausalRecord({ ...live.get(id), kind: 'span', phase: 'heartbeat-confirmed',
          sourceBoot: snapshot.sourceBoot, emittedAbs: snapshot.emittedAbs }, origin, now());
        if (confirmed) active.set(id, confirmed);
      } else if (previous.state !== 'unknown') {
        // The snapshot is truncated. Missing is NOT a completion certificate.
        active.set(id, { ...previous, state: 'unknown', reason: 'not-in-truncated-heartbeat' });
        counts.unknownSpans++;
      }
    }
  }
  function flush(force = false) {
    const at = now();
    if (!pending.length || (!force && at - lastFlushAt < 250)) return;
    const batch = pending.splice(0); lastFlushAt = at; lastFlushLagMs = at - batch[0].at;
    try {
      const name = 'causal-' + new Date(at).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
      artifacts.write(name, batch.map(r => r.line).join(''), true); counts.written += batch.length;
    } catch {
      counts.diskErrors++; counts.droppedQueue += batch.length;
      if (at - lastErrorAt > 30000) { lastErrorAt = at; log('[Perf:CausalHealth] journal-write-failed'); }
    }
  }
  return { record, flush, reconcile, observeSequence,
    snapshot() { return { limits: { maxPerMinute, criticalPerMinute: 12, maxQueued, maxRecordBytes },
      counts: { ...counts }, queued: pending.length, flushLagMs: lastFlushLagMs,
      active: [...active.values()].slice(-8), recent: recent.slice(-8) }; },
  };
}

module.exports = { createCausalJournal, cleanCausalRecord };
