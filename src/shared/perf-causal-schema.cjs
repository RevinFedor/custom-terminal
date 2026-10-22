'use strict';

// One bounded wire definition for Main and its external observer. This schema
// never accepts SQL text, bindings, document text, paths or exception messages.
const CAUSAL_SCHEMA_VERSION = 3;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const own = (value, key) => value && typeof value === 'object'
  ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const token = (value, size = 112) => typeof value === 'string'
  && value.length > 0 && value.length <= size && /^[\w.:-]+$/.test(value) ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.min(MAX_COUNTER, value) : null;
const count = value => Math.floor(number(value) || 0);
const vector = value => Array.from({length:4}, (_, i) => number(own(value, String(i))) || 0);
const validVector = (value, integer = false) => Array.isArray(value) && value.length === 4
  && Array.from({length:4}, (_, i) => own(value, String(i))).every(v => number(v) !== null
    && (!integer || Number.isSafeInteger(v)));

function sanitizeWorkSummary(value, maxSites = 16) {
  const summaryId = token(own(value, 'summaryId'));
  const siteId = token(own(value, 'siteId'), 64);
  const startAbs = number(own(value, 'startAbs')), endAbs = number(own(value, 'endAbs'));
  if (!summaryId || !siteId || own(value, 'revision') !== 1 || startAbs === null
    || endAbs === null || endAbs < startAbs) return null;
  // Missing/corrupt measurement is UNKNOWN, never a successful zero-SQL work.
  // Only optional site detail may be omitted; the aggregate core must be valid.
  const outcome = own(value, 'outcome');
  if (!['success', 'error'].includes(outcome) || !validVector(own(value, 'counts'), true)
    || !validVector(own(value, 'sqlMs')) || number(own(value, 'sqlMaxMs')) === null
    || !Number.isSafeInteger(own(value, 'sqlErrors')) || own(value, 'sqlErrors') < 0) return null;
  const sites = [], supplied = own(value, 'sites');
  const limit = Math.max(0, Math.min(16, Math.floor(maxSites) || 0));
  if (Array.isArray(supplied)) for (let i=0; i<Math.min(supplied.length,16); i++) {
    const cell=own(supplied,String(i)), id=token(own(cell,'siteId'),64);
    if (!id || sites.length >= limit || !validVector(own(cell,'counts'),true)
      || !validVector(own(cell,'ms')) || number(own(cell,'maxMs')) === null
      || !Number.isSafeInteger(own(cell,'errors')) || own(cell,'errors') < 0) continue;
    sites.push({siteId:id,counts:vector(own(cell,'counts')).map(count),ms:vector(own(cell,'ms')),
      maxMs:number(own(cell,'maxMs')) || 0,errors:count(own(cell,'errors'))});
  }
  const counters=Object.create(null), rawCounters=own(value,'counters');
  let counterCount=0;
  if (rawCounters && typeof rawCounters==='object') for (const key of Object.keys(rawCounters)) {
    if (!token(key,48) || number(own(rawCounters,key))===null) continue;
    counterCount++;
    if (Object.keys(counters).length<16) counters[key]=number(own(rawCounters,key));
  }
  const overflow=own(value,'overflow');
  const context=Object.create(null), rawContext=own(value,'context');
  for (const key of ['tabId','sessionId','actionId','readId','requestId','fileIdentity','caller']) {
    const v=token(own(rawContext,key),100); if(v)context[key]=v;
  }
  const omittedSites=count(own(value,'omittedSites')) + Math.max(0,
    (Array.isArray(supplied)?supplied.length:0)-sites.length);
  return {summaryId,revision:1,siteId,parentSpanId:token(own(value,'parentSpanId')),
    startAbs,endAbs,wallMs:endAbs-startAbs,threadCpuMs:number(own(value,'threadCpuMs')),
    outcome,
    counts:vector(own(value,'counts')).map(count),sqlMs:vector(own(value,'sqlMs')),
    sqlMaxMs:number(own(value,'sqlMaxMs')) || 0,sqlErrors:count(own(value,'sqlErrors')),
    sites,counters,context,overflow:{operations:count(own(overflow,'operations')),
      ms:number(own(overflow,'ms')) || 0,maxMs:number(own(overflow,'maxMs')) || 0},
    omittedSites,omittedCounters:count(own(value,'omittedCounters'))+Math.max(0,counterCount-16),
    coverage:omittedSites || count(own(overflow,'operations')) ? 'partial-sites':'listed-sites',
    iteratorExecution:'uncovered'};
}

function compactWorkSummary(value, maxSites = 2) {
  return sanitizeWorkSummary(value, maxSites);
}

function sanitizeWorkCapsule(value) {
  const fromAbs=number(own(value,'fromAbs')),toAbs=number(own(value,'toAbs'));
  if (fromAbs===null || toAbs===null || toAbs<fromAbs) return null;
  const source=own(value,'items'),items=[];
  if(Array.isArray(source))for(let i=0;i<Math.min(source.length,2);i++) {
    const work=compactWorkSummary(own(source,String(i)),2);
    if(work && work.startAbs<toAbs && work.endAbs>fromAbs)items.push(work);
  }
  return {version:1,fromAbs,toAbs,items,omitted:count(own(value,'omitted'))
    +Math.max(0,(Array.isArray(source)?source.length:0)-items.length),
    retainedEvictions:count(own(value,'retainedEvictions')),
    attribution:'whole-work-totals; no overlap scaling or parent-child sum'};
}

// SQL witness v1 is additive to causal v3. Tokens are fixed wrapper-site IDs,
// never SQL/bindings/paths/stacks. Descriptor reads do not invoke getters.
function sanitizeSqlWitness(value, maxSites = 16) {
  try {
    const sequence=own(value,'sequence'), revision=own(value,'revision');
    const integer=v=>Number.isSafeInteger(v) && v>=0;
    if(own(value,'version')!==1 || !integer(sequence) || !integer(revision))return null;
    const cell = (raw, identity=false) => {
      if(!raw || typeof raw!=='object')return null;
      const siteId=token(own(raw,'siteId'),64), operation=own(raw,'operation');
      if(!siteId || !['prepare','get','all','run'].includes(operation))return null;
      if(!identity)return {siteId,operation};
      const seq=own(raw,'sequence'), enteredAbs=number(own(raw,'enteredAbs'));
      if(!integer(seq) || seq<1 || seq>sequence || enteredAbs===null)return null;
      return {siteId,operation,sequence:seq,enteredAbs,
        workId:token(own(raw,'workId')),parentSpanId:token(own(raw,'parentSpanId')),
        parentSqlSequence:integer(own(raw,'parentSqlSequence'))?own(raw,'parentSqlSequence'):null};
    };
    const rawActive=own(value,'active'), active=rawActive===null?null:cell(rawActive,true);
    if(rawActive!==null && !active)return null;
    const rawLast=own(value,'lastCompleted');let lastCompleted=null;
    if(rawLast!==null) {
      const c=cell(rawLast,true),outcome=own(rawLast,'outcome');
      if(!c || !['success','error'].includes(outcome))return null;
      lastCompleted={...c,outcome,rows:outcome==='success' && c.operation==='all'
        && integer(own(rawLast,'rows'))?own(rawLast,'rows'):null};
    }
    const totals=(raw)=>{
      const keys=['attempted','completed','errors','allReturned','rows','maxRows'];
      if(!keys.every(k=>integer(own(raw,k))))return null;
      const out=Object.fromEntries(keys.map(k=>[k,own(raw,k)]));
      return out.completed<=out.attempted && out.errors<=out.completed
        && out.allReturned<=out.completed-out.errors?out:null;
    };
    const aggregate=totals(own(value,'totals'));if(!aggregate || aggregate.attempted!==sequence)return null;
    const sites=[],supplied=own(value,'sites'),limit=Math.max(0,Math.min(16,Math.floor(maxSites)||0));
    if(Array.isArray(supplied))for(let i=0;i<Math.min(supplied.length,16);i++) {
      const raw=own(supplied,String(i)),siteId=token(own(raw,'siteId'),64),stats=totals(raw);
      if(siteId && stats && sites.length<limit)sites.push({siteId,...stats});
    }
    const health={},rawHealth=own(value,'health');
    for(const k of ['preCallAttempts','suppressed','settleSuppressed','transportFailures','unavailable','siteOverflow'])health[k]=count(own(rawHealth,k));
    const mode=own(value,'collectionState');
    return {version:1,revision,sequence,active,lastCompleted,totals:aggregate,sites,
      collectionState:mode==='enabled'||mode==='disabled'?mode:'unknown',
      counterScope:'named-wrappers-while-enabled',
      omittedSites:count(own(value,'omittedSites'))+Math.max(0,(Array.isArray(supplied)?supplied.length:0)-sites.length),health,
      coverage:'named-wrappers-only',preCallCoverage:'all-only-4-pairs-per-minute-best-effort',
      certainty:'observation-only; current-state-UNKNOWN; not-retaining-owner'};
  } catch {return null;}
}

// Dedicated source-side envelope allowlist: SQL metadata must be clean BEFORE
// entering child.send, as well as again at the external receiver.
function sanitizeSqlEnvelope(value) {
  try {
    const sourceBoot=token(own(value,'sourceBoot'),100),sourcePid=own(value,'sourcePid'),sourceSeq=own(value,'sourceSeq');
    const emittedAbs=number(own(value,'emittedAbs')),sqlWitness=sanitizeSqlWitness(own(value,'sqlWitness'),0);
    if(own(value,'kind')!=='sql-witness' || !sourceBoot || !Number.isSafeInteger(sourcePid) || sourcePid<=0
      || !Number.isSafeInteger(sourceSeq) || sourceSeq<1 || emittedAbs===null || !sqlWitness)return null;
    return {schema:CAUSAL_SCHEMA_VERSION,kind:'sql-witness',sourceBoot,sourcePid,sourceSeq,
      sourceKind:'main',emittedAbs,sqlWitness};
  } catch {return null;}
}

// Input here is already top-level allowlisted by the journal. Preserve the
// mandatory causal explanation before optional metadata, within the SAME cap.
// Return a fresh fitted record, or null when even its core cannot fit.
function fitCausalRecord(clean, maxBytes = 2048) {
  if (!clean || typeof clean!=='object' || !(maxBytes>0)) return null;
  const record={...clean};
  if(record.workSummary)record.workSummary=sanitizeWorkSummary(record.workSummary);
  if(record.workCapsule)record.workCapsule=sanitizeWorkCapsule(record.workCapsule);
  if(record.sqlWitness)record.sqlWitness=sanitizeSqlWitness(record.sqlWitness,0);
  const fits=()=>Buffer.byteLength(JSON.stringify(record))<=maxBytes;
  if(fits())return record;
  let omitted=count(record.omittedFields);
  const works=()=>[record.workSummary,...(record.workCapsule?.items || [])].filter(Boolean);
  for(const w of works()) {
    w.omittedSites+=w.sites.length; w.sites=[];
    w.omittedCounters+=Object.keys(w.counters).length; w.counters={};
    w.coverage='partial-sites';
  }
  const core=new Set(['schema','sourcePid','sourceKind','sourceBoot','sourceSeq','emittedAbs',
    'watchdogReceivedAbs','kind','summaryId','revision','workSummary','workCapsule',
    'startAbs','durationMs','threadCpuMs','enteredRecordMissing','omittedFields',
    'spanId','parentSpanId','name','phase','enteredAbs','settledAbs','state','outcome','sqlWitness']);
  for(const key of Object.keys(record)) {
    if(fits())break;
    if(!core.has(key)){delete record[key];record.omittedFields=++omitted;}
  }
  if(fits())return record;
  for(const w of works()) {omitted+=Object.keys(w.context).length;w.context={};}
  record.omittedFields=omitted;
  if(fits())return record;
  while(record.workCapsule?.items.length>1 && !fits()) {
    record.workCapsule.items.pop();record.workCapsule.omitted++;
  }
  return fits()?record:null;
}

module.exports={CAUSAL_SCHEMA_VERSION,sanitizeWorkSummary,compactWorkSummary,
  sanitizeWorkCapsule,fitCausalRecord,sanitizeSqlWitness,sanitizeSqlEnvelope};
