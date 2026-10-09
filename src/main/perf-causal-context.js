'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const ID_FIELDS = new Set(['tabId', 'sessionId', 'actionId', 'readId', 'requestId', 'fileIdentity']);
const TEXT_FIELDS = new Set(['caller', 'mode', 'reason', 'threadCpuSource', 'threadCpuUnavailableReason', 'gcCoverage']);
const NUMBER_FIELDS = new Set(['sourceBytes', 'deltaBytes', 'recordsBefore', 'recordsAfter', 'snapshotRecords', 'rows', 'bytes',
  'syncMs', 'durationMs', 'threadCpuMs', 'processCpuUserMs', 'processCpuSystemMs', 'gcObservedOverlapMs', 'gcEntries', 'gcDropped']);
function opaqueId(value) {
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return undefined;
  const s = typeof value === 'string' ? value : String(value);
  return /^[\w.:-]{1,96}$/.test(s) ? s : 'sha256:' + createHash('sha256').update(s).digest('hex').slice(0, 24);
}
function safeFields(input = {}) {
  const output = {};
  if (!input || typeof input !== 'object') return output;
  let keys;
  try { keys = Object.keys(input); } catch { return output; }
  for (const key of keys) {
    let value;
    try { value = Object.getOwnPropertyDescriptor(input, key)?.value; } catch { continue; }
    if (ID_FIELDS.has(key)) { if (value != null) output[key] = opaqueId(value); }
    else if (NUMBER_FIELDS.has(key)) { if (value === null || (typeof value === 'number' && Number.isFinite(value))) output[key] = value; }
    else if (TEXT_FIELDS.has(key) && typeof value === 'string') output[key] = value.replace(/[^\w .:;=-]/g, '_').slice(0, 100);
  }
  return output;
}

function createCausalContext({ now = () => performance.timeOrigin + performance.now(), pid = process.pid,
  boot = 'main-' + pid + '-' + Math.floor(now()).toString(36), maxActive = 256, maxRecent = 96 } = {}) {
  const storage = new AsyncLocalStorage(), active = new Map(), recent = [];
  let enabled = false, sink = () => false, metrics = null, seq = 0, spanSeq = 0;
  const losses = { transport: 0, active: 0, recent: 0, unavailable: 0 };
  const send = record => {
    const data = { schema: 2, sourceBoot: boot, sourceSeq: ++seq, sourcePid: pid, sourceKind: 'main', emittedAbs: now(), ...record };
    try { if (sink(data) !== true) losses.transport++; } catch { losses.transport++; }
    return data;
  };
  const complete = (op, outcome) => {
    if (op.completed) return;
    op.completed = true;
    active.delete(op.spanId);
    let measurement = {};
    try { if (op.measurement && metrics) measurement = metrics.between(op.measurement); }
    catch { losses.unavailable++; }
    const endAbs = now();
    const record = { kind: 'span', phase: 'settle', spanId: op.spanId, parentSpanId: op.parentSpanId,
      name: op.name, enteredAbs: op.enteredAbs, syncReturnedAbs: op.syncReturnedAbs ?? endAbs,
      syncMs: op.syncMs ?? endAbs - op.enteredAbs, returnedPromise: op.returnedPromise || false,
      state: 'settled', settledAbs: endAbs, lifetimeMs: endAbs - op.enteredAbs,
      outcome, ...op.fields, ...safeFields(measurement), cpuCoverage: 'thread-interval; async lifetime is not exclusive CPU' };
    recent.push(record); if (recent.length > maxRecent) { recent.shift(); losses.recent++; }
    if (op.explicit || record.lifetimeMs >= 50) send(record);
  };
  const api = {
    configure(options = {}) {
      if ('enabled' in options) enabled = options.enabled === true;
      if (typeof options.sink === 'function') sink = options.sink;
      if (options.metrics) metrics = options.metrics;
    },
    current() { return storage.getStore() || null; },
    transportFailed() { losses.transport++; },
    update(fields) { const op = storage.getStore(); if (op) Object.assign(op.fields, safeFields(fields)); },
    run(name, fields, callback, options = {}) {
      if (!enabled) return callback();
      const parent = storage.getStore();
      const op = { spanId: boot + ':' + (++spanSeq), parentSpanId: parent?.spanId || null,
        name: typeof name === 'string' ? name.replace(/[^\w.:-]/g, '_').slice(0, 96) : 'unclassified', enteredAbs: now(), state: 'executing',
        fields: { ...safeFields(parent?.fields), ...safeFields(fields) }, explicit: options.explicit !== false };
      if (active.size >= maxActive) { active.delete(active.keys().next().value); losses.active++; }
      active.set(op.spanId, op);
      try { if (op.explicit && metrics) op.measurement = metrics.read(); } catch { losses.unavailable++; }
      if (op.explicit) send({ kind: 'span', phase: 'enter', spanId: op.spanId, parentSpanId: op.parentSpanId,
        name: op.name, state: 'executing', enteredAbs: op.enteredAbs, ...op.fields });
      return storage.run(op, () => {
        let result;
        try {
          result = callback();
          op.syncReturnedAbs = now(); op.syncMs = op.syncReturnedAbs - op.enteredAbs;
          op.returnedPromise = !!result && typeof result.then === 'function';
          if (op.returnedPromise) {
            op.state = 'awaiting';
            if (op.explicit) send({ kind: 'span', phase: 'sync-return', spanId: op.spanId,
              parentSpanId: op.parentSpanId, name: op.name, state: 'awaiting', enteredAbs: op.enteredAbs,
              syncReturnedAbs: op.syncReturnedAbs, syncMs: op.syncMs, returnedPromise: true, ...op.fields });
            return result.then(value => { complete(op, 'success'); return value; }, error => { complete(op, 'error'); throw error; });
          }
        } catch (error) { complete(op, 'error'); throw error; }
        complete(op, 'success');
        return result;
      });
    },
    event(kind, fields) { if (enabled) send({ kind, ...fields }); },
    snapshot() { return { schema: 2, sourceBoot: boot, sourceSeq: seq, emittedAbs: now(), losses: { ...losses },
      active: [...active.values()].slice(-8).map(op => ({ spanId: op.spanId, parentSpanId: op.parentSpanId,
        name: op.name, state: op.state, enteredAbs: op.enteredAbs, syncReturnedAbs: op.syncReturnedAbs ?? null,
        syncMs: op.syncMs ?? null, returnedPromise: op.returnedPromise ?? null, ...op.fields })),
      recent: recent.slice(-4) }; },
  };
  return api;
}

// Worker copies stay disabled unless explicitly configured; their existing
// request-scoped History diagnostics remain the authority for worker timings.
const causal = createCausalContext();
function boundedCallerToken() {
  try {
    return String(new Error().stack).split('\n').slice(2, 8)
      .map(line => /\bat (?:async )?([\w.$]+)\s/.exec(line)?.[1]).filter(Boolean).join(':').slice(0, 100) || 'unclassified';
  } catch { return 'unclassified'; }
}
module.exports = { causal, createCausalContext, safeFields, opaqueId, boundedCallerToken };
