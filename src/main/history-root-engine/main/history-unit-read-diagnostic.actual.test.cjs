'use strict';

// Finite Source control only. Run with the existing explicit node:sqlite TEST
// adapter and an owned evidence directory. Never loads Electron or app data.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Module = require('node:module'), v8 = require('node:v8');
const evidence = process.env.NOTED_UNIT_TEST_EVIDENCE;
assert(evidence && path.isAbsolute(evidence), 'explicit owned evidence directory required');
const SQLite = require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const load = Module._load;
Module._load = function (id, parent, main) {
  return id === 'better-sqlite3' ? SQLite : load.call(this, id, parent, main);
};
const { HistoryRootController } = require('./history-root-controller');
const { HistoryPreparedCache } = require('./history-prepared-cache');
const { createPrimaryHistoryPresentation } = require('./history-primary-presentation');
const { materializeHistoryCursorSync: mat } = require('./history-paged-store');
const { HistoryRootReadPlane } = require('./history-root-read-plane');
const api = require('./ipc/codex-data')._api;
const stages = ['validation','projection','materialize','serialize','release','write','install','cleanup'];
const identity = x => Object.fromEntries(['leaseId','ownerKey','revision','generation'].map(k => [k,x[k]]));
const hash = text => crypto.createHash('sha256').update(text,'utf16le').digest('hex');
const control = { assertCurrent() {}, async checkpoint() {} };
const before = new Module(path.join(__dirname,'history-root-read-plane.js'), module);
before.filename = path.join(__dirname,'history-root-read-plane.js');
before.paths = Module._nodeModulePaths(__dirname);
before._compile(fs.readFileSync(path.join(evidence,'history-root-read-plane.js.BEFORE'),'utf8'), before.filename);
const originalFork = before.exports.HistoryRootReadPlane.prototype.forkViewUnit;
if (process.env.NOTED_UNIT_TEST_ORIGINAL_RED === '1') HistoryRootReadPlane.prototype.forkViewUnit = originalFork;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(evidence,'fixture-'));
  const id = crypto.randomUUID(), file = path.join(dir,'rollout-' + id + '.jsonl');
  const body = 'Full Ω🙂\r\n\0' + String.fromCharCode(0xd800) + 'x'.repeat(16384);
  const stamp = n => new Date(Date.UTC(2026,9,25,0,0,n)).toISOString();
  const records = [
    {type:'session_meta',payload:{id,cwd:dir}},
    {type:'event_msg',timestamp:stamp(1),payload:{type:'user_message',message:'owned request'}},
    {type:'response_item',timestamp:stamp(2),payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'First exact caption Ω🙂'}]}},
  ];
  let n = 3;
  for (const [call,cmd] of [['read1','cat /owned/a.txt'],['read2','cat /owned/b.txt'],['run1','printf owned-one'],['run2','printf owned-two']]) {
    records.push(
      {type:'response_item',timestamp:stamp(n++),payload:{type:'function_call',call_id:call,name:'exec_command',arguments:JSON.stringify({cmd})}},
      {type:'response_item',timestamp:stamp(n++),payload:{type:'function_call_output',call_id:call,output:'finite result ' + call}}
    );
  }
  records.push({type:'response_item',timestamp:stamp(n),payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:body}]}});
  fs.writeFileSync(file,records.map(x => JSON.stringify(x) + '\n').join(''));
  // Same finite nested fixture/schema used by semantic-view-v24, trimmed to
  // the sidecar tables its actual prompt/timing owners read. No app schema.
  const db = new SQLite(path.join(dir,'sidecars.sqlite'));
  db.exec(`
    CREATE TABLE agent_activity_intervals(id INTEGER PRIMARY KEY,start_ts,end_ts,duration_ms);
    CREATE TABLE history_response_timings(interval_id INTEGER PRIMARY KEY,tool_type,tab_id,session_id,entry_uuid,source_identity,updated_at);
    CREATE TABLE history_response_timing_aliases(interval_id,tool_type,session_id,entry_uuid,source_identity,updated_at,
      PRIMARY KEY(interval_id,tool_type,session_id),UNIQUE(tool_type,session_id,entry_uuid));
    CREATE TABLE history_freshness_versions(domain,provider,owner_id,version,PRIMARY KEY(domain,provider,owner_id));
    CREATE TABLE history_prompt_revision_versions(tool_type PRIMARY KEY,version);
    CREATE TABLE history_prompt_presentations(tool_type,session_id,audit_timestamp,transport_hash,entry_uuid,schema_version,chips_json,created_at,updated_at,
      UNIQUE(tool_type,session_id,audit_timestamp,transport_hash));
    CREATE INDEX idx_history_prompt_presentations_uuid ON history_prompt_presentations(tool_type,entry_uuid);
  `);
  db.exec(require('./timeline-fork-presentation-version-schema').TABLES[0].ddl);
  const manager = Object.create(require('./database').prototype);
  manager.db = db; manager.getSessionHistoryContext = () => null;
  const service = {
    ensureCodexProviderForkLineage: async () => ({success:true,required:false}),
    _resolveCodexLineage: () => ({kind:'physical'}), codexData:{_api:api}, promptPresentationStore:manager,
  };
  const cache = new HistoryPreparedCache({directory:path.join(dir,'cache'),maxBytes:32*1024**2,schema:1});
  let ctl;
  ctl = new HistoryRootController({cache,service,api,Database:SQLite,sourceSchema:'unit-phase-source-control',
    sourceOptions:{sessionsDir:dir,highWaterMark:1024},
    preparePrimaryResult:(canonical,payload,ownedControl) => createPrimaryHistoryPresentation(ctl.store,canonical,{service,payload,control:ownedControl})});
  const base = {toolType:'codex',sessionId:id,cwd:dir,tabId:'OWN',_historyRootConsumerKey:'unit-phase-consumer',readProfile:'history-primary-v1'};
  const call = (method,payload = {},options = {}) => ctl.dispatch(method,{...base,...payload},{control,...options});
  t.after(() => {
    try { ctl.close(); } finally { db.close(); api.invalidateJsonlCache(file); fs.rmSync(dir,{recursive:true,force:true}); }
    assert(!fs.existsSync(dir));
  });
  return {dir,ctl,call,base,body};
}
async function readDocument(f, cap) {
  let text = '', offset = 0;
  for (;;) {
    const p = await f.call('readHistoryRootPage',{...cap.payloadDocument,kind:'leaf',offset,limit:1024,creditBytes:4096});
    text += p.text; if (p.done) return text; offset = p.nextOffset;
  }
}
const bodyOf = text => v8.deserialize(Buffer.from(text,'base64'));
function checkSummary(summary, cap, rank, kind, document, f) {
  assert(summary, 'terminal unit phase summary is required');
  assert.equal(summary.schema,'history-unit-phase-v1');
  assert.equal(summary.parentLeaseId,cap.leaseId); assert.equal(summary.generation,cap.generation);
  assert.equal(summary.rank,rank); assert.equal(summary.kind,kind);
  assert.equal(summary.outcome,'success'); assert.equal(summary.incomplete,false); assert.equal(summary.lastStage,'install');
  assert.equal(summary.serializedBytes,Buffer.from(document,'base64').length);
  const width = Math.max(3,Math.floor(f.ctl.store.pageBytes/8)*3);
  const hit=summary.memo==='hit';
  assert.equal(summary.chunks,hit?0:Math.ceil(summary.serializedBytes/width));
  if(hit)assert.equal(kind,'group');
  let previous = 0;
  for (const stage of stages) {
    const start = summary[stage+'StartUs'], end = summary[stage+'EndUs'];
    if(hit&&['projection','materialize','serialize','release','write'].includes(stage)){
      assert.equal(start,null);assert.equal(end,null);continue;
    }
    assert(Number.isSafeInteger(start) && start >= previous, stage+' start');
    assert(Number.isSafeInteger(end) && end >= start, stage+' end'); previous = end;
  }
  assert(summary.startedPerfMs >= 0 && summary.elapsedUs >= previous);
  assert(Buffer.byteLength(JSON.stringify(summary)) <= 1024);
  assert(Object.values(summary).every(value => value === null || ['string','boolean','number'].includes(typeof value)));
  const allowed = new Set(['schema','startedPerfMs','parentLeaseId','generation','rank','kind','serializedBytes','chunks','outcome','incomplete','lastStage','elapsedUs','memo',
    ...stages.flatMap(stage => [stage+'StartUs',stage+'EndUs'])]);
  assert.deepEqual(Object.keys(summary).sort(),[...allowed].sort());
}
function counters(f) {
  let memos=0;
  for(const state of f.ctl.plane.roots.values()){
    assert(state.groupDocuments.length<=2);assert(state.groupDocuments.reduce((n,x)=>n+x.bytes,0)<=65536);
    memos+=state.groupDocuments.length;
  }
  return {roots:f.ctl.plane.roots.size,nonMemoLeases:f.ctl.store.stats().leases-memos,
    nonMemoPins:f.ctl.store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n-memos};
}
function noLeak(f, baseline) {
  assert.deepEqual(counters(f),baseline); assert.equal(f.ctl.plane.opening,0);
  assert.equal(f.ctl.store.stats().activeBuilders,0);
}

test('finite nested Source unit preparation: exact bodies, bounded phases and original ownership', async t => {
  const f = fixture(t);
  let cap = await f.call('openHistoryRoot',{primaryRequestClass:'source',primaryPresentation:{
    localEntries:[],liveEntries:[],liveToolResults:null,settingsPresentationKeys:[],grouping:{enabled:true,threshold:2,expandedKeys:[]},captionSelections:[],
  }});
  assert(cap.success);
  let primary = f.ctl.plane.roots.get(cap.leaseId).primaryPresentation;
  const outer = mat(primary.view.root.cursor().field('units')).find(unit => unit.kind === 'group');
  assert(outer,'existing outer grouping fixture');
  const expanded = await f.call('openHistoryRoot',{primaryRequestClass:'view',localRootLease:identity(cap),expectedSemanticIdentity:cap.semanticIdentity,
    primaryViewOptions:{grouping:{enabled:true,threshold:2,expandedKeys:[outer.key]},captionSelections:[]}});
  assert(expanded.success); await f.call('releaseHistoryRoot',cap); cap = expanded;
  primary = f.ctl.plane.roots.get(cap.leaseId).primaryPresentation;
  const units = mat(primary.view.root.cursor().field('units'));
  const entryRank = units.findIndex(unit => unit.kind === 'entry' && unit.entry?.content === f.body);
  const groupRank = units.findIndex(unit => unit.kind === 'group' && unit.level === 2);
  assert(entryRank >= 0); assert(groupRank >= 0,'existing nested grouping fixture');
  const request = rank => ({...identity(cap),nodeToken:f.ctl.plane.nodeToken(f.ctl.plane.roots.get(cap.leaseId),primary.headerAt(rank)),
    encoding:'history-display-unit-v8-v1'});
  const state = f.ctl.plane.roots.get(cap.leaseId);
  const source = primary.view.root.cursor().field('source');
  let fullCursor;
  for (const row of source.rows()) {
    const content = row.field('content'); if (content.kind === 'text' && content.length === f.body.length) fullCursor = content;
  }
  assert(fullCursor);
  const leaf = await f.call('forkHistoryRootLeaf',f.ctl.plane.describe(state,fullCursor,{inline:false}));
  const heldText = await readDocument(f,leaf), heldHash = hash(heldText);
  assert.equal(heldText,f.body);
  const oldSnapshot = mat(primary.view.root.cursor());
  const baseline = counters(f);
  async function unchanged() {
    noLeak(f,baseline); assert.deepEqual(mat(primary.view.root.cursor()),oldSnapshot);
    assert.equal(hash(await readDocument(f,leaf)),heldHash);
  }
  await t.test('entry/group diagnostic off/on equal prepatch full V8 values and UTF16 document digests', async () => {
    for (const [rank,kind] of [[entryRank,'entry'],[groupRank,'group']]) {
      const raw = await originalFork.call(f.ctl.plane,request(rank),{consumerKey:f.base._historyRootConsumerKey,control});
      const expected = await readDocument(f,raw); await f.call('releaseHistoryRoot',raw);
      const off = await f.call('forkHistoryRootLeaf',request(rank));
      const offText = await readDocument(f,off); await f.call('releaseHistoryRoot',off);
      const summaries = [];
      const on = await f.call('forkHistoryRootLeaf',request(rank),{onUnitDiagnostic:s => summaries.push(s)});
      const onText = await readDocument(f,on); await f.call('releaseHistoryRoot',on);
      assert.deepEqual(bodyOf(onText),bodyOf(expected)); assert.deepEqual(bodyOf(offText),bodyOf(expected));
      assert.equal(hash(onText),hash(expected)); assert.equal(hash(offText),hash(expected));
      assert.equal(summaries.length,1); checkSummary(summaries[0],cap,rank,kind,onText,f);
      t.diagnostic(JSON.stringify({kind,rank,utf16DocumentSHA256:hash(onText),serializedBytes:summaries[0].serializedBytes,
        summaryBytes:Buffer.byteLength(JSON.stringify(summaries[0])),summary:summaries[0]}));
      await unchanged();
    }
  });
  if (process.env.NOTED_UNIT_TEST_ORIGINAL_RED === '1') return;
  await t.test('observer throws after successful cleanup; return and exact body retained', async () => {
    let observed = 0, snapshot;
    const doc = await f.call('forkHistoryRootLeaf',request(entryRank),{onUnitDiagnostic:s => {
      observed++; snapshot = {opening:f.ctl.plane.opening,builders:f.ctl.store.stats().activeBuilders,outcome:s.outcome};
      throw Error('observer-only');
    }});
    assert.equal(observed,1); assert.equal(doc.success,true);
    assert.deepEqual(snapshot,{opening:0,builders:0,outcome:'success'});
    assert.equal(bodyOf(await readDocument(f,doc)).entry.content,f.body);
    await f.call('releaseHistoryRoot',doc); await unchanged();
  });
  await t.test('cancel at existing 32-chunk write checkpoint; throwing observer cannot replace original rejection', async () => {
    const saved = v8.serialize, cancelled = Object.assign(Error('owned checkpoint abort'),{code:'HISTORY_READ_CONSUMER_REVOKED'});
    let serialized = false, checkpoints = 0, observed = 0, summary;
    v8.serialize = value => { const bytes = saved(value); serialized = true; return bytes; };
    const owned = {assertCurrent(){},async checkpoint(){if(serialized){checkpoints++;throw cancelled;}}};
    try {
      await assert.rejects(f.call('forkHistoryRootLeaf',request(entryRank),{control:owned,onUnitDiagnostic:s => {
        observed++; summary=s; throw Error('observer-only');
      }}),error => error === cancelled);
    } finally { v8.serialize = saved; }
    assert.equal(checkpoints,1); assert.equal(observed,1); assert.equal(summary.outcome,'cancelled');
    assert.equal(summary.incomplete,true); assert.equal(summary.lastStage,'write'); assert.equal(summary.chunks,32);
    assert.equal(summary.writeEndUs,null); assert(summary.cleanupEndUs >= summary.cleanupStartUs);
    await unchanged();
  });
  await t.test('post-allocation failure releases document once/endBuild once; original error wins cleanup and observer errors', async () => {
    const savedSerialize=v8.serialize, savedLease=f.ctl.store.lease, savedBuild=f.ctl.store.beginBuild;
    const originalError=Object.assign(Error('owned after document allocation'),{code:'OWN_UNIT_ALLOCATION_FAILURE'});
    const cleanupError=Error('owned cleanup failure');
    let serialized=false, allocated=false, releases=0, ended=0, observed=0, summary;
    const priorCleanupErrors=f.ctl.plane.metrics.cleanupErrors||0;
    v8.serialize=value=>{const bytes=savedSerialize(value);serialized=true;return bytes;};
    f.ctl.store.lease=function(...args){
      const lease=savedLease.apply(this,args);
      if(serialized){allocated=true;const release=lease.release.bind(lease);
        return {...lease,release(){releases++;release();throw cleanupError;}};}
      return lease;
    };
    f.ctl.store.beginBuild=function(...args){
      const end=savedBuild.apply(this,args);
      return()=>{if(serialized)ended++;return end();};
    };
    const owned={assertCurrent(){if(allocated)throw originalError;},async checkpoint(){}};
    try {
      await assert.rejects(f.call('forkHistoryRootLeaf',request(entryRank),{control:owned,onUnitDiagnostic:s=>{
        observed++;summary=s;throw Error('observer-only');
      }}),error=>error===originalError);
    } finally {v8.serialize=savedSerialize;f.ctl.store.lease=savedLease;f.ctl.store.beginBuild=savedBuild;}
    assert(allocated);assert.equal(releases,1);assert.equal(ended,1);assert.equal(observed,1);
    assert.equal(summary.outcome,'error');assert.equal(summary.lastStage,'write');assert.equal(summary.incomplete,true);
    assert.equal(f.ctl.plane.metrics.cleanupErrors,priorCleanupErrors+1);
    await unchanged();
  });
  await t.test('invalid signed node retains original guard and gets one incomplete validation summary', async () => {
    const summaries=[];
    await assert.rejects(f.call('forkHistoryRootLeaf',{...request(entryRank),nodeToken:'bad.token'},
      {onUnitDiagnostic:s=>summaries.push(s)}),{code:'HISTORY_ROOT_NODE_TOKEN'});
    assert.equal(summaries.length,1); assert.equal(summaries[0].outcome,'error');
    assert.equal(summaries[0].lastStage,'validation'); assert.equal(summaries[0].incomplete,true);
    assert.equal(summaries[0].kind,null); assert.equal(summaries[0].projectionStartUs,null);
    await unchanged();
  });
  await t.test('independent Full leaf survives parent release', async () => {
    await f.call('releaseHistoryRoot',cap);
    assert.equal(hash(await readDocument(f,leaf)),heldHash);
    await f.call('releaseHistoryRoot',leaf);
    assert.equal(f.ctl.plane.roots.size,0); assert.equal(f.ctl.plane.opening,0);
    assert.equal(f.ctl.store.stats().activeBuilders,0);
  });
});

test('worker terminal summary uses reserved diagnostic envelope outside optional phase groups', () => {
  const worker=fs.readFileSync(path.join(__dirname,'history-read-worker.js'),'utf8');
  assert.match(worker,/onUnitDiagnostic: summary => \{ context\.unitPreparation = summary; \}/);
  const terminal=worker.slice(worker.indexOf('const diagnostic = { ...correlation'));
  assert.match(terminal,/\.\.\.\(context\.unitPreparation \? \{ unitPreparation: context\.unitPreparation \} : \{\}\)/);
  assert(terminal.indexOf('context.unitPreparation') < terminal.indexOf('send({ ...body, diagnostic }'));
});
