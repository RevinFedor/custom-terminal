'use strict';

// A bounded extension of the EXISTING external flight-recorder artifact store.
// No file IO or payload/DOM inspection on the Main or renderer input path.
const { CAUSAL_SCHEMA_VERSION, sanitizeWorkSummary, sanitizeWorkCapsule, fitCausalRecord, sanitizeSqlWitness } = require('../shared/perf-causal-schema.cjs');
const STRING_FIELDS = new Set(['sourceBoot', 'sourceKind', 'spanId', 'parentSpanId', 'name', 'kind', 'phase', 'state', 'outcome',
  'actionId', 'readId', 'requestId', 'tabId', 'sessionId', 'fileIdentity', 'caller', 'mode', 'reason', 'threadCpuSource',
  'threadCpuUnavailableReason', 'gcCoverage', 'cpuCoverage', 'keyClass', 'event', 'owner', 'visibility', 'incidentId',
  'targetSource', 'targetTag', 'historyOwner', 'summaryId']);
const NUMBER_FIELDS = new Set(['sourceSeq', 'sourcePid', 'emittedAbs', 'enteredAbs', 'syncReturnedAbs', 'syncMs', 'settledAbs',
  'lifetimeMs', 'startAbs', 'durationMs', 'inputDelayMs', 'handlerMs', 'presentationMs', 'receivedAbs', 'threadCpuMs',
  'processCpuUserMs', 'processCpuSystemMs', 'sourceBytes', 'deltaBytes', 'recordsBefore', 'recordsAfter', 'snapshotRecords',
  'rows', 'bytes', 'gcObservedOverlapMs', 'gcEntries', 'gcDropped', 'gcId', 'gcKind', 'gcFlags', 'observedAbs',
  'gestureGeneration', 'visit', 'ringDropped', 'transportDrops', 'rateDrops', 'noWriterDrops', 'backpressureDrops',
  'revision', 'retainedEvictions', 'completedWorkOmitted', 'omittedFields', 'gcMaxMs', 'childPid', 'exitCode']);
const BOOL_FIELDS = new Set(['returnedPromise', 'meta', 'ctrl', 'alt', 'shift', 'repeat', 'focused', 'enteredRecordMissing']);
function cleanCausalRecord(input, origin, receivedAt) {
  if (!input || typeof input !== 'object' || !Number.isInteger(origin?.pid) || origin.pid <= 0) return null;
  const record = { schema: CAUSAL_SCHEMA_VERSION, sourcePid: origin.pid,
    sourceKind: typeof origin.kind === 'string' ? origin.kind.slice(0, 32) : 'unknown', watchdogReceivedAbs: receivedAt };
  const fields = Object.getOwnPropertyDescriptors(input);
  for (const [key, descriptor] of Object.entries(fields)) {
    const value = descriptor.value;
    if (key === 'sourcePid' || key === 'sourceKind') continue;
    if (STRING_FIELDS.has(key) && (value === null || typeof value === 'string')) {
      record[key] = value === null ? null : value.replace(/[\r\n\t]/g, '_').slice(0,
        ['spanId', 'parentSpanId', 'summaryId'].includes(key) ? 112 : 100);
    } else if (NUMBER_FIELDS.has(key) && (value === null || (typeof value === 'number' && Number.isFinite(value)))) record[key] = value;
    else if (BOOL_FIELDS.has(key) && typeof value === 'boolean') record[key] = value;
  }
  if (!record.kind || !record.sourceBoot || !Number.isFinite(record.emittedAbs)) return null;
  if (record.kind === 'work-summary') {
    const work = sanitizeWorkSummary(fields.workSummary?.value);
    // Never ACK a sanitized/truncated identity, another PID, or a mismatched
    // envelope revision. Sequence numbers are transport, not persistence IDs.
    if (!work || fields.summaryId?.value !== work.summaryId || fields.revision?.value !== work.revision
      || fields.sourceBoot?.value !== record.sourceBoot
      || (fields.sourcePid && fields.sourcePid.value !== origin.pid)) return null;
    record.summaryId = work.summaryId; record.revision = work.revision; record.workSummary = work;
  }
  if (fields.workCapsule) {
    const capsule = sanitizeWorkCapsule(fields.workCapsule.value);
    if (capsule) record.workCapsule = capsule;
  }
  if(fields.sqlWitness) {
    const sql=sanitizeSqlWitness(fields.sqlWitness.value,0);
    if(!sql || (fields.sourcePid && fields.sourcePid.value!==origin.pid))return null;
    record.sqlWitness=sql;
  }
  if(record.kind==='sql-witness' && !record.sqlWitness)return null;
  return record;
}

function createCausalJournal({ artifacts, now = Date.now, maxPerMinute = 60, maxQueued = 64,
  // Full raw-reader correlation + CPU/GC fields exceeded1KiB in the real
  // reader test. Keep those causal fields together under a measured2KiB cap.
  maxRecordBytes = 2048, onPersisted = () => {}, log = () => {} } = {}) {
  const bound = (value, limit) => Number.isInteger(value) && value > 0 ? Math.min(value, limit) : limit;
  maxPerMinute = bound(maxPerMinute, 60); maxQueued = bound(maxQueued, 64); maxRecordBytes = bound(maxRecordBytes, 2048);
  const pending = [], sources = new Map(), active = new Map(), recent = [];
  const entered = new Map(), persisted = new Map(), sqlSources = new Map();
  let sqlSourceEvictions=0;
  const observeSql=data=>{
    if(!data.sqlWitness)return null;
    const id=JSON.stringify([data.sourcePid,data.sourceBoot]),prior=sqlSources.get(id);
    if(prior && prior.sqlWitness.revision>=data.sqlWitness.revision)return null;
    if(!prior && sqlSources.size>=64){sqlSources.delete(sqlSources.keys().next().value);sqlSourceEvictions++;}
    const observed={sourcePid:data.sourcePid,sourceBoot:data.sourceBoot,
      sourceSeq:Number.isSafeInteger(data.sourceSeq) && data.sourceSeq>=0?data.sourceSeq:null,
      emittedAbs:Number.isFinite(data.emittedAbs)?data.emittedAbs:null,
      watchdogReceivedAbs:data.watchdogReceivedAbs,sqlWitness:data.sqlWitness,
      currentState:'UNKNOWN',reason:'last-observation-not-current-proof',persistence:'received-only'};
    sqlSources.set(id,observed);return observed;
  };
  const sqlPersistence=(data,status)=>{
    const entry=sqlSources.get(JSON.stringify([data.sourcePid,data.sourceBoot]));
    if(entry && entry.sqlWitness.revision===data.sqlWitness?.revision)entry.persistence=status;
  };
  // Fixed shares prevent a flood in one category from spending all sixty
  // ordinary records. Reduced test limits leave the remainder to detail.
  const normalLimits = { work: Math.max(1, Math.floor(maxPerMinute * 32 / 60)), health: Math.max(1, Math.floor(maxPerMinute * 8 / 60)) };
  normalLimits.detail = Math.max(1, maxPerMinute - normalLimits.work - normalLimits.health);
  const priority = { detail: 0, health: 1, work: 2, critical: 3 };
  const losses = Object.fromEntries(Object.keys(priority).map(key => [key,
    { rate: 0, queue: 0, evicted: 0, bytes: 0, bucket: 0, disk: 0, malformed: 0 }]));
  const categoryOf = (data, critical) => critical ? 'critical' : data?.kind === 'work-summary' ? 'work'
    : ['health', 'source-health', 'transport-health', 'recorder-health', 'causal-health', 'gc-summary', 'gc'].includes(data?.kind) ? 'health' : 'detail';
  const sourceKey = data => JSON.stringify([data.sourcePid, data.sourceBoot]);
  const spanKey = (data, id = data.spanId) => JSON.stringify([data.sourcePid, data.sourceBoot, id]);
  const summaryKey = data => data.kind === 'work-summary'
    ? JSON.stringify([data.sourcePid, data.sourceBoot, data.summaryId, data.revision]) : null;
  const counts = { received: 0, written: 0, droppedRate: 0, droppedQueue: 0, droppedBytes: 0,
    droppedMalformed: 0, droppedBucket: 0, sourceEvictions: 0, sequenceGaps: 0, diskErrors: 0, reconciledSettlements: 0, unknownSpans: 0,
    reconciledWork: 0, duplicatePending: 0, duplicatePersisted: 0, persistedEvictions: 0,
    activeEvictions: 0, enteredEvictions: 0, ackErrors: 0, tornBucketRecords: 0 };
  let lastFlushAt = now(), lastFlushLagMs = null, lastErrorAt = -Infinity;
  function lose(category, reason) { losses[category][reason]++; }
  function ack(data) {
    try {
      if (onPersisted({ sourcePid: data.sourcePid, sourceBoot: data.sourceBoot,
        summaryId: data.summaryId, revision: data.revision }) === false) counts.ackErrors++;
    }
    catch { counts.ackErrors++; } // A failed transport ACK does not undo the append.
  }
  function observeSequence(input, origin) {
    const data = cleanCausalRecord({ ...input, kind: 'sequence' }, origin, now());
    if (!data) return null;
    const at = now();
    const key = sourceKey(data);
    if (!sources.has(key) && sources.size >= 64) { sources.delete(sources.keys().next().value); counts.sourceEvictions++; }
    let source = sources.get(key);
    if (!source) { source = { since: at, count: 0, critical: 0, normal: { work: 0, health: 0, detail: 0 }, lastSeq: null }; sources.set(key, source); }
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
    const category = categoryOf(input, critical), at = now();
    let data = cleanCausalRecord(input, origin, at);
    if (!data) { counts.droppedMalformed++; lose(category, 'malformed'); return false; }
    counts.received++;
    observeSql(data);
    const source = observeSequence(data, origin);
    const key = summaryKey(data);
    if (key) active.delete(spanKey(data, data.summaryId));
    if (key && persisted.has(key)) { counts.duplicatePersisted++; ack(persisted.get(key)); return true; }
    if (key && pending.some(item => item.key === key)) { counts.duplicatePending++; return true; }
    if (data.phase === 'enter' && (data.spanId || data.summaryId)) {
      entered.set(spanKey(data, data.spanId || data.summaryId), true);
      if (entered.size > 128) { entered.delete(entered.keys().next().value); counts.enteredEvictions++; }
    }
    if (key) data.enteredRecordMissing = !entered.has(spanKey(data, data.summaryId));
    const beforeFit=data;
    data = fitCausalRecord(data, maxRecordBytes);
    if (!data) { counts.droppedBytes++; lose(category, 'bytes'); sqlPersistence(beforeFit,'byte-drop'); return false; }
    const encoded = JSON.stringify(data);
    // Even rate-limited records maintain the bounded live span context. A stall
    // incident receives this context, rather than an opaque old IPC age string.
    if (data.kind === 'span' && data.spanId) {
      const id = spanKey(data);
      if (data.phase === 'settle') active.delete(id);
      else { active.set(id, data); if (active.size > 64) { active.delete(active.keys().next().value); counts.activeEvictions++; } }
    }
    recent.push(data); if (recent.length > 32) recent.shift();
    if (Buffer.byteLength(encoded) > maxRecordBytes) { counts.droppedBytes++; lose(category, 'bytes'); return false; }
    if (at - source.since >= 60000) {
      source.since = at; source.count = 0; source.critical = 0; source.normal = { work: 0, health: 0, detail: 0 };
    }
    // Reserve separate small space for actual stall/resume boundaries. Neither
    // stream is unbounded; a loss is surfaced in the next recorder heartbeat.
    if (critical ? source.critical >= 12 : source.count >= maxPerMinute || source.normal[category] >= normalLimits[category]) {
      counts.droppedRate++; lose(category, 'rate'); sqlPersistence(data,'rate-drop'); return false;
    }
    if (pending.length >= maxQueued) {
      // Only strictly lower-priority evidence may be evicted. In particular,
      // a new critical record can NEVER displace an older critical record.
      let index = -1;
      for (let i = 0; i < pending.length; i++) {
        if (priority[pending[i].category] < priority[category]
          && (index < 0 || priority[pending[i].category] < priority[pending[index].category])) index = i;
      }
      if (index < 0) { counts.droppedQueue++; lose(category, 'queue'); sqlPersistence(data,'queue-drop'); return false; }
      const [evicted] = pending.splice(index, 1); counts.droppedQueue++; lose(evicted.category, 'evicted'); sqlPersistence(evicted.data,'queue-evicted');
    }
    if (critical) source.critical++; else { source.count++; source.normal[category]++; }
    sqlPersistence(data,'queued-not-persisted');
    pending.push({ line: encoded + '\n', at, data, key, category });
    return true;
  }
  function reconcile(snapshot, origin) {
    if (!snapshot || !Number.isInteger(origin?.pid) || origin.pid <= 0
      || typeof snapshot.sourceBoot !== 'string' || !Number.isFinite(snapshot.emittedAbs)) return;
    const sql=sanitizeSqlWitness(snapshot.sqlWitness,0);
    if(sql)observeSql({sourcePid:origin.pid,sourceBoot:snapshot.sourceBoot,sourceSeq:snapshot.sourceSeq,
      emittedAbs:snapshot.emittedAbs,sqlWitness:sql,watchdogReceivedAbs:now()});
    // A completed work may arrive well after the incident's twenty-second
    // window, or without any enter packet. Its own interval remains intact.
    for (const work of (Array.isArray(snapshot.completedWork) ? snapshot.completedWork.slice(-8) : [])) {
      const summary = sanitizeWorkSummary(work);
      if (!summary || summary.endAbs > snapshot.emittedAbs) continue;
      const envelope = { kind: 'work-summary', sourceBoot: snapshot.sourceBoot, emittedAbs: snapshot.emittedAbs,
        summaryId: summary.summaryId, revision: summary.revision, workSummary: summary };
      const key = summaryKey({ ...envelope, sourcePid: origin.pid });
      const known = persisted.has(key) || pending.some(item => item.key === key);
      if (record(envelope, origin) && !known) counts.reconciledWork++;
    }
    const live = new Map((Array.isArray(snapshot.active) ? snapshot.active.slice(-8) : [])
      .filter(op => typeof op?.spanId === 'string').map(op => [op.spanId, op]));
    const settled = new Map((Array.isArray(snapshot.recent) ? snapshot.recent.slice(-4) : [])
      .filter(op => op?.phase === 'settle' && typeof op.spanId === 'string' && Number.isFinite(op.settledAbs))
      .map(op => [op.spanId, op]));
    for (const [id, previous] of active) {
      if (previous.sourcePid !== origin.pid || previous.sourceBoot !== snapshot.sourceBoot || previous.emittedAbs > snapshot.emittedAbs) continue;
      const completed = settled.get(previous.spanId);
      if (completed) {
        record({ ...completed, kind: 'span', phase: 'settle', state: 'settled',
          sourceBoot: snapshot.sourceBoot, emittedAbs: completed.settledAbs, reason: 'heartbeat-confirmed-settlement' }, origin);
        counts.reconciledSettlements++;
      } else if (live.has(previous.spanId)) {
        const confirmed = cleanCausalRecord({ ...live.get(previous.spanId), kind: 'span', phase: 'heartbeat-confirmed',
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
    const name = 'causal-' + new Date(at).toISOString().slice(0, 13).replace(/\D/g, '') + '.ndjson';
    // Keep chronological order within contiguous lanes. A failed ordinary
    // append cannot suppress a later essential group in this same flush.
    const groups = [];
    for (const item of batch) {
      // Work summaries are already selected as important by the source. They
      // share the essential disk reserve without changing rate/queue priority.
      const essential = item.category === 'work' || item.category === 'critical';
      if (!groups.length || (artifacts.writeCausal && groups.at(-1).essential !== essential)) groups.push({ essential, items: [] });
      groups.at(-1).items.push(item);
    }
    for (const group of groups) {
      const lines = group.items.map(item => item.line).join('');
      try {
        let receipt;
        if (artifacts.writeCausal) {
          receipt = artifacts.writeCausal(name, lines, { essential: group.essential });
          if (!receipt || receipt.appended !== true || receipt.bytes !== Buffer.byteLength(lines)
            || receipt.name !== name) throw new Error('causal append not confirmed');
        } else artifacts.write(name, lines, true); // Older observer adapters: no persistence ACK.
        counts.written += group.items.length;
        for(const item of group.items)sqlPersistence(item.data,receipt?'append-confirmed':'legacy-write-unconfirmed');
        for (const item of group.items) if (item.key && receipt) {
          persisted.set(item.key, { sourcePid: item.data.sourcePid, sourceBoot: item.data.sourceBoot,
            summaryId: item.data.summaryId, revision: item.data.revision });
          if (persisted.size > 512) { persisted.delete(persisted.keys().next().value); counts.persistedEvictions++; }
          ack(item.data);
        }
      } catch (error) {
        const bucketFull = error?.code === 'CAUSAL_NORMAL_BUCKET_FULL' || error?.code === 'CAUSAL_TOTAL_BUCKET_FULL';
        if (error?.code === 'CAUSAL_TORN_BUCKET') counts.tornBucketRecords += group.items.length;
        if (bucketFull) counts.droppedBucket += group.items.length; else counts.diskErrors++;
        counts.droppedQueue += group.items.length;
        for (const item of group.items) {lose(item.category, bucketFull ? 'bucket' : 'disk');sqlPersistence(item.data,bucketFull?'bucket-drop':'disk-unknown');}
        if (at - lastErrorAt > 30000) {
          lastErrorAt = at;
          const reason = bucketFull ? error.code === 'CAUSAL_NORMAL_BUCKET_FULL' ? 'normal-hour-cap' : 'total-hour-cap'
            : error?.code === 'CAUSAL_TORN_BUCKET' ? 'incomplete-hour-tail' : 'append-failed';
          try { log('[Perf:CausalHealth] journal-write-failed reason=' + reason); } catch {}
        }
      }
    }
  }
  return { record, flush, reconcile, observeSequence,
    snapshot() { return { limits: { maxPerMinute, criticalPerMinute: 12, maxQueued, maxRecordBytes },
      normalLimits: { ...normalLimits },
      counts: { ...counts, losses: Object.fromEntries(Object.entries(losses).map(([key, value]) => [key, { ...value }])) },
      sqlSourceEvictions,sqlSourcesOmitted:Math.max(0,sqlSources.size-8),
      sqlWitnesses:[...sqlSources.values()].slice(-8).map(e=>({...e,sqlWitness:sanitizeSqlWitness(e.sqlWitness,0)})),
      queued: pending.length, persistedSummaries: persisted.size, flushLagMs: lastFlushLagMs,
      active: [...active.values()].slice(-8), recent: recent.slice(-8) }; },
  };
}

module.exports = { createCausalJournal, cleanCausalRecord };
