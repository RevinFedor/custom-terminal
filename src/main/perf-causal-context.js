'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { CAUSAL_SCHEMA_VERSION, sanitizeWorkSummary, compactWorkSummary } = require('../shared/perf-causal-schema.cjs');

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
  const retainedWork = new Map();
  const workHealth = { completed:0, retainedEvictions:0, unacknowledgedEvictions:0,
    expired:0, acknowledged:0, unknownAcks:0, sqlOutsideWork:0, invalidSites:0,
    untimedSql:0, counterOverflow:0, attempts:0, retryExhausted:0 };
  let executingWork = null, gcAggregate = null, lastGcAttempt = -Infinity;
  const sqlOperations = new Map([['prepare',0],['get',1],['all',2],['run',3]]);
  const site = value => typeof value==='string' && /^[\w.:-]{1,64}$/.test(value);
  const increment = (target,key,value=1) => { target[key]=Math.min(Number.MAX_SAFE_INTEGER,(target[key] || 0)+value); };
  const pruneWork = at => {
    for(const [id,entry] of retainedWork) if(at-entry.summary.endAbs>300000) {
      retainedWork.delete(id);workHealth.expired++;
      if(!entry.acknowledged)workHealth.unacknowledgedEvictions++;
    }
  };
  const send = record => {
    const data = { schema: CAUSAL_SCHEMA_VERSION, sourceBoot: boot, sourceSeq: ++seq, sourcePid: pid, sourceKind: 'main', emittedAbs: now(), ...record };
    try { if (sink(data) !== true) losses.transport++; } catch { losses.transport++; }
    return data;
  };
  const trySummary = entry => {
    if(entry.acknowledged || entry.attempts>=3)return false;
    entry.attempts++;workHealth.attempts++;
    entry.retryAt=now()+(entry.attempts===1?1000:5000);
    send({kind:'work-summary',summaryId:entry.summary.summaryId,revision:1,
      workSummary:entry.summary});
    if(entry.attempts===3)workHealth.retryExhausted++;
    return true;
  };
  const rememberWork = summary => {
    pruneWork(summary.endAbs);
    if(retainedWork.size>=8) {
      const id=retainedWork.keys().next().value,old=retainedWork.get(id);
      retainedWork.delete(id);workHealth.retainedEvictions++;
      if(!old.acknowledged)workHealth.unacknowledgedEvictions++;
    }
    const entry={summary,attempts:0,retryAt:0,acknowledged:false};
    retainedWork.set(summary.summaryId,entry);trySummary(entry);
  };
  const flushGc = at => {
    if(!gcAggregate || at-lastGcAttempt<10000)return;
    const value=gcAggregate;gcAggregate=null;lastGcAttempt=at;
    send({kind:'gc-summary',startAbs:value.fromAbs,durationMs:value.toAbs-value.fromAbs,
      gcEntries:value.count,gcObservedOverlapMs:value.sumMs,gcMaxMs:value.maxMs,
      gcCoverage:'delivered-entries-only; aggregate window is not exclusive CPU'});
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
    bind(callback) {
      if(!enabled)return callback;
      const captured=storage.getStore() || null;
      return function causalBound(...args) { return storage.run(captured,()=>callback.apply(this,args)); };
    },
    hasWork() { return enabled && executingWork !== null; },
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
    syncWork(siteId, metadata, callback, options = {}) {
      if(!enabled)return callback();
      if(!site(siteId)){workHealth.invalidSites++;return callback();}
      let at;
      try { at=now(); } catch { losses.unavailable++;return callback(); }
      const parent=options.root===true?null:storage.getStore();
      const id=boot+':work:'+(++spanSeq);
      const work={summaryId:id,revision:1,siteId,parentSpanId:parent?.spanId || null,
        startAbs:at,counts:[0,0,0,0],sqlMs:[0,0,0,0],sqlMaxMs:0,sqlErrors:0,
        cells:new Map(),counters:Object.create(null),overflow:{operations:0,ms:0,maxMs:0}};
      const fields={...safeFields(parent?.fields),...safeFields(metadata)};
      const op={spanId:id,parentSpanId:work.parentSpanId,name:siteId,state:'executing',enteredAbs:at,fields};
      if(active.size>=maxActive){active.delete(active.keys().next().value);losses.active++;}
      active.set(id,op);
      let measurement=null;
      try { if(metrics)measurement=metrics.read();
        send({kind:'span',phase:'enter',spanId:id,parentSpanId:work.parentSpanId,
          name:siteId,state:'executing',enteredAbs:at,...fields});
      } catch { losses.unavailable++; }
      const previous=executingWork;executingWork=work;
      let outcome='success';
      try { return storage.run(op,callback); }
      catch(error){outcome='error';throw error;}
      finally {
        executingWork=previous;active.delete(id);
        // Diagnostics must never replace the original value/Promise/exception.
        try {
          const endAbs=now();let measured={};
          try { if(measurement !== null && metrics)measured=metrics.between(measurement); }
          catch { losses.unavailable++; }
          const summary=sanitizeWorkSummary({...work,endAbs,outcome,
            threadCpuMs:measured.threadCpuMs ?? null,context:fields,sites:[...work.cells.values()]});
          workHealth.completed++;
          if(summary && (summary.wallMs>=50 || summary.sqlMs.reduce((a,b)=>a+b,0)>=50
            || summary.counts.reduce((a,b)=>a+b,0)>=128))rememberWork(summary);
          else {
            const record={kind:'span',phase:'settle',spanId:id,parentSpanId:work.parentSpanId,
              name:siteId,state:'settled',enteredAbs:at,settledAbs:endAbs,
              syncMs:endAbs-at,lifetimeMs:endAbs-at,outcome,...fields};
            recent.push(record);if(recent.length>maxRecent){recent.shift();losses.recent++;}
            send(record);
          }
        } catch { losses.unavailable++; }
      }
    },
    sql(siteId, operation, callback) {
      if(!enabled)return callback();
      const work=executingWork,index=sqlOperations.get(operation);
      if(!work){workHealth.sqlOutsideWork++;return callback();}
      if(index===undefined || !site(siteId)){workHealth.invalidSites++;return callback();}
      let start;
      try { start=now(); } catch { workHealth.untimedSql++;return callback(); }
      let failed=false;
      try { return callback(); }
      catch(error){failed=true;throw error;}
      finally {
        try {
          const elapsed=Math.max(0,now()-start);
          work.counts[index]++;work.sqlMs[index]+=elapsed;
          work.sqlMaxMs=Math.max(work.sqlMaxMs,elapsed);if(failed)work.sqlErrors++;
          let cell=work.cells.get(siteId);
          if(!cell && work.cells.size<16){cell={siteId,counts:[0,0,0,0],ms:[0,0,0,0],maxMs:0,errors:0};work.cells.set(siteId,cell);}
          if(cell){cell.counts[index]++;cell.ms[index]+=elapsed;cell.maxMs=Math.max(cell.maxMs,elapsed);if(failed)cell.errors++;}
          else {work.overflow.operations++;work.overflow.ms+=elapsed;work.overflow.maxMs=Math.max(work.overflow.maxMs,elapsed);}
        } catch { workHealth.untimedSql++; }
      }
    },
    count(key, delta=1) {
      if(!enabled || !executingWork)return;
      if(typeof key!=='string' || !/^[\w.:-]{1,48}$/.test(key) || !Number.isFinite(delta) || delta<0)return;
      const counts=executingWork.counters;
      if(!Object.hasOwn(counts,key) && Object.keys(counts).length>=16){workHealth.counterOverflow++;return;}
      increment(counts,key,delta);
    },
    gapCapsule(fromAbs,toAbs) {
      if(!enabled)return null;
      const all=[...retainedWork.values()].map(e=>e.summary)
        .filter(w=>w.startAbs<toAbs && w.endAbs>fromAbs)
        .sort((a,b)=>b.wallMs-a.wallMs);
      return {version:1,fromAbs,toAbs,items:all.slice(0,2).map(w=>compactWorkSummary(w,2)),
        omitted:Math.max(0,all.length-2),retainedEvictions:workHealth.retainedEvictions,
        attribution:'whole-work-totals; no overlap scaling or parent-child sum'};
    },
    acknowledge(ack) {
      if(ack?.sourceBoot!==boot || ack?.revision!==1){workHealth.unknownAcks++;return false;}
      const entry=retainedWork.get(ack.summaryId);
      if(!entry){workHealth.unknownAcks++;return false;}
      if(!entry.acknowledged){entry.acknowledged=true;workHealth.acknowledged++;}
      return true;
    },
    retryRetained() {
      if(!enabled)return;
      const at=now();pruneWork(at);let attempts=0;
      for(const entry of retainedWork.values())if(!entry.acknowledged && entry.attempts<3 && at>=entry.retryAt) {
        trySummary(entry);if(++attempts>=2)break;
      }
      flushGc(at);
    },
    event(kind, fields) {
      if(!enabled)return;
      if(kind==='gc') {
        if(!Number.isFinite(fields?.startAbs) || !Number.isFinite(fields?.durationMs) || fields.durationMs<0)return;
        const end=fields.startAbs+fields.durationMs;
        if(!gcAggregate)gcAggregate={count:0,sumMs:0,maxMs:0,fromAbs:fields.startAbs,toAbs:end};
        gcAggregate.count++;gcAggregate.sumMs+=fields.durationMs;
        gcAggregate.maxMs=Math.max(gcAggregate.maxMs,fields.durationMs);
        gcAggregate.fromAbs=Math.min(gcAggregate.fromAbs,fields.startAbs);gcAggregate.toAbs=Math.max(gcAggregate.toAbs,end);
        return;
      }
      send({kind,...fields});
    },
    snapshot({delivery=false}={}) {
      const at=now();pruneWork(at);
      const completedWork=[];
      for(const entry of retainedWork.values()) {
        if(delivery && (entry.acknowledged || entry.attempts>=3 || at<entry.retryAt || completedWork.length>=2))continue;
        if(delivery){entry.attempts++;entry.retryAt=at+5000;workHealth.attempts++;if(entry.attempts===3)workHealth.retryExhausted++;}
        completedWork.push(compactWorkSummary(entry.summary,2));
      }
      if(delivery && enabled)flushGc(at);
      return { schema: CAUSAL_SCHEMA_VERSION, sourceBoot: boot, sourceSeq: seq, emittedAbs: at, losses: { ...losses },
      completedWork,workHealth:{...workHealth,retained:retainedWork.size,
        pending:[...retainedWork.values()].filter(e=>!e.acknowledged).length},
      coverage:{sql:'explicit-sites-only',iteratorExecution:'uncovered',startupBeforeConfigure:'uncovered',
        activeOmitted:Math.max(0,active.size-8),recentOmitted:Math.max(0,recent.length-4)},
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
