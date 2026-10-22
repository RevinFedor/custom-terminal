'use strict';

// Observation only. No receipt, readiness, clock/deadline authority, registry,
// timer or transport is owned here. Callers emit through the existing console.
const MAX_READS = 12;
const MAX_EVENTS = 16;
const STAGES = new Set(['initial-presence', 'launch-presence', 'rejected-launch-presence',
  'wait-presence', 'composer-prepare', 'after-composer-presence', 'gate-presence', 'final-presence']);
const PHASES = new Set(['renderer-invoke', 'renderer-ipc-invoke', 'renderer-resume', 'renderer-reject',
  'main-enter', 'main-return', 'main-throw', 'main-reject',
  'ready-handler', 'ready-resolve', 'wait-timer', 'loop-resume', 'observation-omitted']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,384}$/.test(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function ownValue(value,key) { try { return Object.getOwnPropertyDescriptor(value,key)?.value; } catch { return undefined; } }
function absoluteNow() {
  const p = globalThis.performance;
  return p && Number.isFinite(p.timeOrigin) && typeof p.now === 'function'
    ? p.timeOrigin + p.now() : Date.now();
}
function safeNow(now) { try { return finite(now()); } catch { return null; } }
function safeFields(value) {
  const fields = {};
  if (!value || typeof value !== 'object') return fields;
  for (const key of ['eventTs', 'pass', 'reads', 'events']) {
    const n = finite(ownValue(value,key)); if (n !== null) fields[key] = n;
  }
  for (const key of ['success', 'inputWritten', 'inputReady', 'questionExpanded']) {
    const flag=ownValue(value,key); if (typeof flag === 'boolean') fields[key] = flag;
  }
  const wakeSource=ownValue(value,'wakeSource'),limitKind=ownValue(value,'limitKind');
  if (['runtime-ready','readiness-changed','deadline','fallback'].includes(wakeSource)) fields.wakeSource=wakeSource;
  if (['reads-limit','events-limit'].includes(limitKind)) fields.limitKind=limitKind;
  return fields;
}
function normalizeReadTiming(value, expectedTabId) {
  try {
    if (!value || value.version !== 1 || !STAGES.has(value.stage)
      || !Number.isInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > MAX_READS) return null;
    const tabId = id(value.tabId), operationKey = id(value.operationKey), attemptId = id(value.attemptId);
    if (!tabId || !operationKey || !attemptId || expectedTabId !== undefined && tabId !== id(expectedTabId)) return null;
    return Object.freeze({version:1, tabId, operationKey, attemptId,
      ...(id(value.handoffId) ? {handoffId:id(value.handoffId)} : {}),
      stage:value.stage, ordinal:value.ordinal, callerAbs:finite(value.callerAbs)});
  } catch { return null; }
}
function emitReadTiming(context, phase, fields, {emit, now=absoluteNow}={}) {
  if (!context || !PHASES.has(phase) || typeof emit !== 'function') return;
  try { emit({...context, phase, abs:safeNow(now), ...safeFields(fields)}); } catch {}
}
function createAgentSendReadTiming({tabId, operationKey, attemptId, handoffId, emit, now=absoluteNow}={}) {
  const base = {version:1, tabId:id(tabId), operationKey:id(operationKey), attemptId:id(attemptId),
    ...(id(handoffId) ? {handoffId:id(handoffId)} : {})};
  const enabled = !!base.tabId && !!base.operationKey && !!base.attemptId && typeof emit === 'function';
  let reads=0, events=0, omitted=false, closed=false;
  const contexts=[], settled=new Set();
  const omission = limitKind => {
    if (!enabled || omitted) return; omitted=true;
    emitReadTiming(base, 'observation-omitted', {limitKind,reads,events}, {emit,now});
  };
  return Object.freeze({
    start(stage) {
      if (!enabled || closed || !STAGES.has(stage)) return null;
      if (reads >= MAX_READS) { omission('reads-limit'); return null; }
      const context=Object.freeze({...base,stage,ordinal:++reads,callerAbs:safeNow(now)});
      contexts.push(context);
      emitReadTiming(context,'renderer-invoke',{}, {emit,now});
      return context;
    },
    end(context, result, rejected=false) {
      const value=normalizeReadTiming(context,base.tabId);
      if (!enabled || closed || !value || value.operationKey!==base.operationKey || value.attemptId!==base.attemptId
        || contexts[value.ordinal-1]!==context || settled.has(value.ordinal)) return;
      settled.add(value.ordinal);
      emitReadTiming(value,rejected?'renderer-reject':'renderer-resume',result,{emit,now});
    },
    event(phase, fields) {
      if (!enabled || closed || !PHASES.has(phase) || !['ready-handler','ready-resolve','wait-timer','loop-resume'].includes(phase)) return;
      if (events >= MAX_EVENTS) { omission('events-limit'); return; } events++;
      emitReadTiming(base,phase,fields,{emit,now});
    },
    close() { closed=true; contexts.length=0; settled.clear(); },
  });
}
function recordAgentSendReadTiming(value, expectedTabId, phase, fields, options) {
  const context=normalizeReadTiming(value,expectedTabId);
  if(context)emitReadTiming(context,phase,fields,options);
}

// Return the SAME value/promise/error. Attaching the observation adds no awaited
// stage, and a hostile/malformed diagnostic or logger cannot change the operation.
function observeAgentSendReadTiming(value, expectedTabId, operation, {emit,now=absoluteNow}={}) {
  const context=normalizeReadTiming(value,expectedTabId);
  if (!context) return operation();
  emitReadTiming(context,'main-enter',{}, {emit,now});
  let result;
  try { result=operation(); }
  catch (error) { emitReadTiming(context,'main-throw',{}, {emit,now}); throw error; }
  let observedPromise=false,finished=false;
  const finish=(phase,fields)=>{if(finished)return;finished=true;emitReadTiming(context,phase,fields,{emit,now});};
  try { Promise.prototype.then.call(result,
      settled => { finish('main-return',settled); },
      () => { finish('main-reject',{}); }); observedPromise=true;
  } catch {}
  if (!observedPromise) finish('main-return',result);
  return result;
}
function recordAgentReadyPublication(value,phase,{emit,now=absoluteNow}={}) {
  try {
    const tabId=id(value?.tabId),launchId=id(value?.launchId);
    if(!tabId||!['ready-publication-before','ready-publication-after'].includes(phase)||typeof emit!=='function')return;
    emit({version:1,tabId,launchId,eventTs:finite(value?.eventTs),phase,abs:safeNow(now)});
  } catch {}
}
module.exports={MAX_READS,MAX_EVENTS,absoluteNow,normalizeReadTiming,
  createAgentSendReadTiming,observeAgentSendReadTiming,recordAgentSendReadTiming,recordAgentReadyPublication};
