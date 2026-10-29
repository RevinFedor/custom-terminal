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
if (process.env.NOTED_MEMO_ORIGINAL_RED === '1') HistoryRootReadPlane.prototype.forkViewUnit = originalFork;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(evidence,'fixture-'));
  const id = crypto.randomUUID(), file = path.join(dir,'rollout-' + id + '.jsonl');
  const body = 'Full Ω🙂\r\n\0' + String.fromCharCode(0xd800) + 'x'.repeat(16384);
  const stamp = n => new Date(Date.UTC(2026,9,25,0,0,n)).toISOString();
  const records = [{type:'session_meta',payload:{id,cwd:dir}}];
  let n = 0;
  const push = payload => records.push({type:'response_item',timestamp:stamp(n++),payload});
  const captions = [];
  for (let group=0; group<3; group++) {
    records.push({type:'event_msg',timestamp:stamp(n++),payload:{type:'user_message',message:'request '+group}});
    const caption = 'caption '+group+' Ω🙂\r\n\0'+String.fromCharCode(0xd800);
    captions.push(caption);
    push({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:caption}]});
    const calls=[['read1','cat /owned/a.txt'],['read2','cat /owned/b.txt'],['run1','printf owned-one'],['run2','printf owned-two']];
    for (const [call,cmd] of calls) {
      push({type:'function_call',call_id:group+'-'+call,name:'exec_command',arguments:JSON.stringify({cmd})});
      push({type:'function_call_output',call_id:group+'-'+call,output:'finite result '+group+'-'+call});
    }
    push({type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:group===0?body:'done '+group}]});
  }
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
  // The negotiated controller now classifies physical lineage with bounded
  // SQL, rather than the old all-event service stub used by this fixture.
  db.exec(require('./timeline-fork-presentation-version-schema').TABLES[0].ddl);
  const manager = Object.create(require('./database').prototype);
  manager.db = db; manager.getSessionHistoryContext = () => null;
  const service = {
    ensureCodexProviderForkLineage: async () => ({success:true,required:false}),
    _resolveCodexLineage: () => ({kind:'physical'}), codexData:{_api:api}, promptPresentationStore:manager,
  };
  const cache = new HistoryPreparedCache({directory:path.join(dir,'cache'),maxBytes:96*1024**2,schema:1});
  let ctl;
  ctl = new HistoryRootController({cache,service,api,Database:SQLite,sourceSchema:'unit-phase-source-control',rootDiskBudgetBytes:80*1024**2,
    sourceOptions:{sessionsDir:dir,highWaterMark:1024},
    preparePrimaryResult:(canonical,payload,ownedControl) => createPrimaryHistoryPresentation(ctl.store,canonical,{service,payload,control:ownedControl})});
  const base = {toolType:'codex',sessionId:id,cwd:dir,tabId:'OWN',_historyRootConsumerKey:'unit-phase-consumer',readProfile:'history-primary-v1'};
  const call = (method,payload = {},options = {}) => ctl.dispatch(method,{...base,...payload},{control,...options});
  t.after(() => {
    try { ctl.close(); } finally { db.close(); api.invalidateJsonlCache(file); fs.rmSync(dir,{recursive:true,force:true}); }
    assert(!fs.existsSync(dir));
  });
  return {dir,ctl,call,base,body,captions,db,manager,service};
}
async function readDocument(f, cap) {
  let text = '', offset = 0;
  for (;;) {
    const p = await f.call('readHistoryRootPage',{...cap.payloadDocument,kind:'leaf',offset,limit:1024,creditBytes:4096});
    text += p.text; if (p.done) return text; offset = p.nextOffset;
  }
}
const bodyOf = text => v8.deserialize(Buffer.from(text,'base64'));
const { pathToFileURL } = require('node:url');
const renderer = name => import(pathToFileURL(path.resolve(__dirname,'../../../renderer/utils',name)).href);
const stats = f => ({roots:f.ctl.plane.roots.size,leases:f.ctl.store.stats().leases,
  pins:f.ctl.store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n});
const cancelled = () => Object.assign(Error('finite owned cancellation'),{code:'HISTORY_READ_CONSUMER_REVOKED'});
const sameText = (actual,expected) => {assert.equal(actual.length,expected.length);assert.equal(hash(actual),hash(expected));assert.equal(actual,expected);};
const memoSize = state => ({slots:state.groupDocuments.length,bytes:state.groupDocuments.reduce((n,s)=>n+s.bytes,0)});

// One finite fixture, real Source controller/SQLite/primary reducer and real
// renderer client/window demand. IPC invocation alone is an in-process shim.
test('parent-local completed group documents: content first, LRU/ownership/faults second', async t => {
  const f=fixture(t);
  const {HistoryPrimaryRootReadModel}=await renderer('historyPrimaryRootReadModel.mjs');
  const transport=await renderer('historyReadTransport.mjs');
  const {HistoryRootClient}=await renderer('historyRootReadClient.mjs');
  global.window={require}; t.after(()=>{delete global.window;});
  const channels={'agent-transcript:get-history':'openHistoryRoot','agent-transcript:read-page':'readHistoryRootPage',
    'agent-transcript:fork-read-leaf':'forkHistoryRootLeaf','agent-transcript:release-read-root':'releaseHistoryRoot'};
  const summaries=[],responses=[];
  const invoke=async (channel,payload)=>{
    assert(channels[channel],channel);
    const result=await f.call(channels[channel],payload,{onUnitDiagnostic:s=>summaries.push(s)});
    if(channel==='agent-transcript:fork-read-leaf'&&payload.encoding)responses.push(result);
    return result;
  };
  const model=new HistoryPrimaryRootReadModel(invoke,transport,{creditBytes:4096});

  const presentation={localEntries:[],liveEntries:[],liveToolResults:[],settingsPresentationKeys:[],
    grouping:{enabled:true,threshold:2,expandedKeys:[]},captionSelections:[]};
  await model.open({...f.base,primaryRequestClass:'source',primaryPresentation:presentation});
  let cap=model.header,state=f.ctl.plane.roots.get(cap.leaseId),primary=state.primaryPresentation;
  let units=mat(primary.view.root.cursor().field('units'));
  const outer=units.filter(u=>u.kind==='group');
  assert.equal(outer.length,3);
  // Pure view fork is real and must begin with no memo even at identical IDs.
  await model.open({...f.base,primaryRequestClass:'view',primaryViewOptions:{
    grouping:{enabled:true,threshold:2,expandedKeys:[outer[0].key]},captionSelections:[]}});
  cap=model.header;state=f.ctl.plane.roots.get(cap.leaseId);primary=state.primaryPresentation;
  assert.deepEqual(memoSize(state),{slots:0,bytes:0});
  units=mat(primary.view.root.cursor().field('units'));
  const ranks=outer.map(u=>units.findIndex(v=>v.kind==='group'&&v.key===u.key));
  const [A,B,C]=ranks;assert(ranks.every(n=>n>=0));
  assert(units.some(u=>u.kind==='group'&&u.level===2),'nested group retained');
  const entryRank=units.findIndex(u=>u.kind==='entry'&&u.entry?.content===f.body);assert(entryRank>=0);
  const request=(rank,s=state)=>({...identity(s),generation:f.ctl.plane.generation,
    nodeToken:f.ctl.plane.nodeToken(s,s.primaryPresentation.headerAt(rank)),encoding:'history-display-unit-v8-v1'});
  const direct=async(rank,s=state,options={})=>{
    let summary;const response=await f.call('forkHistoryRootLeaf',request(rank,s),{...options,onUnitDiagnostic:x=>{summary=x;}});
    const text=await readDocument(f,response);return {response,text,summary,value:bodyOf(text)};
  };
  const close=doc=>f.call('releaseHistoryRoot',doc.response||doc);
  const baseline=new Map();
  for(const rank of [...ranks,entryRank]){
    const response=await originalFork.call(f.ctl.plane,request(rank),{consumerKey:f.base._historyRootConsumerKey,control});
    const text=await readDocument(f,response);baseline.set(rank,text);await close(response);
    t.diagnostic(JSON.stringify({oracle:'original Source method',rank,rawBytes:Buffer.from(text,'base64').length,rawSHA256:crypto.createHash('sha256').update(Buffer.from(text,'base64')).digest('hex'),utf16Length:text.length,utf16SHA256:hash(text)}));
  }
  // Full exact V8 bytes, not a normalized DTO/previews oracle.
  for(const rank of ranks){
    const value=bodyOf(baseline.get(rank));assert.equal(value.kind,'group');
    t.diagnostic(JSON.stringify({rank,caption:value.captionEntries.map(row=>({length:row.content?.length,hash:hash(row.content||''),complete:row.captionTextComplete,preview:row.content?.slice(0,45)})),expected:{length:f.captions[ranks.indexOf(rank)].length,hash:hash(f.captions[ranks.indexOf(rank)])}}));
    assert(value.captionEntries.some(row=>row.content===f.captions[ranks.indexOf(rank)]&&row.captionTextComplete));
    assert(value.entries.length>=4);assert(value.facts.length>=4);
    for(const row of value.entries)assert(row.rowStub);
  }
  sameText(bodyOf(baseline.get(entryRank)).entry.content,f.body);
  let fullCursor;
  for(const row of primary.view.root.cursor().field('source').rows()){
    const c=row.field('content');if(c.kind==='text'&&c.length===f.body.length)fullCursor=c;
  }
  assert(fullCursor);const full=await f.call('forkHistoryRootLeaf',f.ctl.plane.describe(state,fullCursor,{inline:false}));
  sameText(await readDocument(f,full),f.body);

  await t.test('A → B → A leaves finite body window; identical bytes/new public caps and no hit construction',async()=>{
    const work={projection:0,serialize:0,writers:0};
    const savedUnit=primary.unitForRenderer,savedSerialize=v8.serialize,savedWriter=f.ctl.store.leafWriter;
    state.primaryPresentation={...primary,unitForRenderer:async function(...args){work.projection++;return savedUnit.apply(primary,args);}};
    v8.serialize=function(...args){work.serialize++;return savedSerialize.apply(this,args);};
    f.ctl.store.leafWriter=function(...args){work.writers++;return savedWriter.apply(this,args);};
    try{
      await model.readWindow(A,A);const first=model.unitAt(A);const firstResponse=responses.at(-1);
      const probe=await direct(A);sameText(probe.text,baseline.get(A));await close(probe);
      // The independently held public document below remains live through eviction/drop.
      const held=await direct(A);f.held=held;
      sameText(held.text,baseline.get(A));assert.deepEqual(held.value,first);
      await model.readWindow(B,B);assert.equal(model.unitAt(A),undefined);assert.deepEqual([...model.window.keys()],[B]);
      const before={...work};await model.readWindow(A,A);
      assert.deepEqual(work,before,'hit must not project, materialize/serialize or create a body writer');
      t.diagnostic(JSON.stringify({kind:'hit-work',projection:work.projection-before.projection,serialize:work.serialize-before.serialize,writers:work.writers-before.writers,newPublicLease:true}));
      sameText(v8.serialize(model.unitAt(A)).toString('base64'),baseline.get(A));
      assert.notEqual(responses.at(-1).leaseId,firstResponse.leaseId);
      assert.notEqual(responses.at(-1).payloadDocument.nodeToken,firstResponse.payloadDocument.nodeToken);
      const summary=summaries.at(-1);assert.equal(summary.memo,'hit');assert.equal(summary.outcome,'success');
      for(const stage of ['projection','materialize','serialize','release','write']){
        assert.equal(summary[stage+'StartUs'],null);assert.equal(summary[stage+'EndUs'],null);
      }
      assert.equal(summary.chunks,0);assert(Buffer.byteLength(JSON.stringify(summary))<=1024);
      t.diagnostic(JSON.stringify({unitPreparation:summary,summaryBytes:Buffer.byteLength(JSON.stringify(summary))}));
      assert.deepEqual(memoSize(state),{slots:2,bytes:Buffer.from(baseline.get(A),'base64').length+Buffer.from(baseline.get(B),'base64').length});
      assert.deepEqual(state.groupDocuments.map(s=>s.rank),[B,A]);
    }finally{state.primaryPresentation=primary;v8.serialize=savedSerialize;f.ctl.store.leafWriter=savedWriter;}
  });

  if(process.env.NOTED_MEMO_ORIGINAL_RED==='1')return;
  await t.test('C evicts B only, exact original bytes on a subsequent B miss',async()=>{
    const c=await direct(C);sameText(c.text,baseline.get(C));await close(c);
    assert.equal(c.summary.memo,'miss');assert.deepEqual(state.groupDocuments.map(s=>s.rank),[A,C]);
    const b=await direct(B);sameText(b.text,baseline.get(B));assert.equal(b.summary.memo,'miss');await close(b);
    assert.deepEqual(state.groupDocuments.map(s=>s.rank),[C,B]);
    assert(memoSize(state).bytes<=65536);
  });

  await t.test('authenticated header/owner, quota and capacity remain guards without fallback',async()=>{
    const before=stats(f),slots=state.groupDocuments.map(s=>s.rank);
    for(const patch of [{ownerKey:'wrong-owner'},{nodeToken:'bad.token'},{encoding:'wrong-encoding'},
      {nodeToken:f.ctl.plane.nodeToken(state,primary.view.root.cursor().field('source').at(0))}]){
      await assert.rejects(f.call('forkHistoryRootLeaf',{...request(B),...patch}));assert.deepEqual(stats(f),before);
    }
    assert.deepEqual(state.groupDocuments.map(s=>s.rank),slots);
    const max=f.ctl.plane.maxRoots;f.ctl.plane.maxRoots=f.ctl.plane.roots.size;
    try{await assert.rejects(f.call('forkHistoryRootLeaf',request(B)),{code:'HISTORY_ROOT_LEASE_LIMIT'});}
    finally{f.ctl.plane.maxRoots=max;}
    const budget=f.ctl.store.diskBudget;f.ctl.store.diskBudget=0;
    try{await assert.rejects(f.call('forkHistoryRootLeaf',request(B)),{code:'HISTORY_BACKING_FULL'});}
    finally{f.ctl.store.diskBudget=budget;}
    assert.deepEqual(stats(f),before);
    assert.equal(f.ctl.store.db.pragma('journal_mode',{simple:true}),'delete');
    assert.equal(f.ctl.store.db.pragma('synchronous',{simple:true}),2);
  });

  await t.test('cancel before completion and after body write: no partial memo, original error wins',async()=>{
    for(const phase of ['before','after-write']){
      f.ctl.plane.releaseGroupDocumentMemos();const before=stats(f);
      const original=cancelled(),savedUnit=primary.unitForRenderer,savedLease=f.ctl.store.lease;
      let armed=false,wrote=false,summary;
      state.primaryPresentation={...primary,unitForRenderer:async function(...args){const unit=await savedUnit.apply(primary,args);armed=phase==='before';return unit;}};
      f.ctl.store.lease=function(...args){const lease=savedLease.apply(this,args);if(phase==='after-write'&&lease.cursor().kind==='text'){wrote=true;armed=true;}return lease;};
      try{
        await assert.rejects(f.call('forkHistoryRootLeaf',request(A),{control:{assertCurrent(){if(armed)throw original;},async checkpoint(){}},
          onUnitDiagnostic:s=>{summary=s;throw Error('observer must not replace failure');}}),error=>error===original);
      }finally{state.primaryPresentation=primary;f.ctl.store.lease=savedLease;}
      if(phase==='after-write')assert(wrote);
      assert.equal(summary.outcome,'cancelled');assert.equal(summary.incomplete,true);
      assert.equal(memoSize(state).slots,0);assert.deepEqual(stats(f),before);
      assert.equal(f.ctl.plane.opening,0);assert.equal(f.ctl.store.stats().activeBuilders,0);
    }
  });

  await t.test('optional retention quota/fault cannot fail valid document, no private pin leak',async()=>{
    for(const code of ['SQLITE_FULL','OWN_RETENTION_FAULT']){
      f.ctl.plane.releaseGroupDocumentMemos();const before=stats(f),savedFork=f.ctl.store.lease;
      f.ctl.store.lease=function(...args){const lease=savedFork.apply(this,args);if(lease.cursor().kind!=='text')return lease;
        return {...lease,fork(){throw Object.assign(Error('owned optional retention'),{code});}};};
      let doc;try{doc=await direct(A);}finally{f.ctl.store.lease=savedFork;}
      sameText(doc.text,baseline.get(A));assert.equal(doc.summary.memo,code==='SQLITE_FULL'?'skip-quota':'skip-retention');
      await close(doc);assert.deepEqual(stats(f),before);assert.equal(memoSize(state).slots,0);
    }
  });

  await t.test('optional private pin rollback and cancelled hit fork release their provisional handles',async()=>{
    f.ctl.plane.releaseGroupDocumentMemos();const before=stats(f);
    const savedRetain=f.ctl.plane.retainGroupDocument,savedDisk=f.ctl.store.checkDisk;
    let retention=false;
    f.ctl.plane.retainGroupDocument=function(...args){retention=true;try{return savedRetain.apply(this,args);}finally{retention=false;}};
    f.ctl.store.checkDisk=function(){if(retention)throw Object.assign(Error('owned pin commit quota'),{code:'HISTORY_BACKING_FULL'});return savedDisk.call(this);};
    let doc;try{doc=await direct(A);}finally{f.ctl.plane.retainGroupDocument=savedRetain;f.ctl.store.checkDisk=savedDisk;}
    sameText(doc.text,baseline.get(A));assert.equal(doc.summary.memo,'skip-quota');await close(doc);assert.deepEqual(stats(f),before);
    const warm=await direct(A);await close(warm);const warmStats=stats(f);
    const savedLease=f.ctl.store.lease,original=cancelled();let allocated=false,summary;
    f.ctl.store.lease=function(...args){const lease=savedLease.apply(this,args);allocated=true;return lease;};
    try{await assert.rejects(f.call('forkHistoryRootLeaf',request(A),{
      control:{assertCurrent(){if(allocated)throw original;},async checkpoint(){}},onUnitDiagnostic:s=>{summary=s;}
    }),error=>error===original);}finally{f.ctl.store.lease=savedLease;}
    assert(allocated);assert.equal(summary.memo,'hit');assert.equal(summary.outcome,'cancelled');
    assert.deepEqual(stats(f),warmStats);assert.equal(memoSize(state).slots,1);
  });

  await t.test('hit cancellation/late delivery and UNKNOWN do not retry or close shared parent/Full',async()=>{
    const warm=await direct(A);await close(warm);const before=stats(f);
    const header=f.ctl.plane.describe(state,primary.headerAt(A),{inline:false});
    const reader=new HistoryRootClient(invoke,cap.root,{pageBytes:4096});
    // Own client over shared parent is never closed in these child-only failures.
    let attempts=0,late;const abort=new AbortController();
    reader.invoke=async(channel,payload)=>{
      if(channel==='agent-transcript:fork-read-leaf'){
        attempts++;late=await invoke(channel,payload);abort.abort();return late;
      }
      return invoke(channel,payload);
    };
    await assert.rejects(reader.forkViewUnit(header,{signal:abort.signal}),{code:'HISTORY_READ_CANCELLED'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(attempts,1);assert.deepEqual(stats(f),before);assert.equal(reader.closed,false);
    assert(!f.ctl.plane.roots.has(late.leaseId));
    const unknown=Object.assign(Error('owned transport unknown'),{code:'OWN_TRANSPORT_UNKNOWN'});
    reader.invoke=async(channel,payload)=>{
      if(channel==='agent-transcript:fork-read-leaf'){attempts++;throw unknown;}return invoke(channel,payload);
    };
    await assert.rejects(reader.forkViewUnit(header),error=>error===unknown);assert.equal(attempts,2);
    assert.deepEqual(stats(f),before);sameText(await readDocument(f,full),f.body);
    // No reader.close(): this temporary client borrows the shared parent capability.
  });

  await t.test('hit install fault preserves exact rejection and releases public candidate only',async()=>{
    const warm=await direct(A);await close(warm);const before=stats(f);
    const savedDescribe=f.ctl.plane.describe,original=Object.assign(Error('owned public descriptor fault'),{code:'OWN_INSTALL_FAULT'});
    let summary;
    f.ctl.plane.describe=function(s,c,options){if(s!==state&&c.kind==='text')throw original;return savedDescribe.call(this,s,c,options);};
    try{await assert.rejects(f.call('forkHistoryRootLeaf',request(A),{onUnitDiagnostic:s=>{summary=s;}}),error=>error===original);}
    finally{f.ctl.plane.describe=savedDescribe;}
    assert.equal(summary.memo,'hit');assert.equal(summary.outcome,'error');assert.equal(summary.lastStage,'install');
    assert.deepEqual(stats(f),before);assert.equal(memoSize(state).slots,1);
  });

  await t.test('new pure-view/semantic parent memo empty; frozen old content and changed live/caption/Rewind',async()=>{
    const p=await f.call('openHistoryRoot',{primaryRequestClass:'view',localRootLease:identity(cap),expectedSemanticIdentity:cap.semanticIdentity,
      primaryViewOptions:{grouping:presentation.grouping,captionSelections:[]}});
    const ps=f.ctl.plane.roots.get(p.leaseId);assert.deepEqual(memoSize(ps),{slots:0,bytes:0});
    const pu=mat(ps.primaryPresentation.view.root.cursor().field('units'));
    const pr=pu.findIndex(u=>u.kind==='group'&&u.key===outer[0].key);assert(pr>=0);
    const pdoc=await direct(pr,ps);assert.equal(pdoc.summary.memo,'miss');await close(pdoc);await close(p);
    // Two fresh semantic parents with the SAME live UUID/tool IDs/group key
    // and count, but changed visible caption/result/error facts.
    const realNow=Date.now;let semanticClock=realNow();Date.now=()=>semanticClock;
    try {
    const local={uuid:'local-prompt-same-id',role:'queued',queueStatus:'failed',
      timestamp:new Date().toISOString(),optimisticAt:Date.now(),statusChangedAt:Date.now(),content:'local failed request'};
    const actionTemplate=mat(primary.view.root.cursor().field('source')).find(row=>row.actions?.length)?.actions[0];
    assert.equal(actionTemplate.tool,'__raw__');
    const live={uuid:'live-same-id',role:'assistant',type:'assistant',timestamp:new Date().toISOString(),
      content:'live frozen caption',actions:[0,1].map(n=>{const action=structuredClone(actionTemplate);
        action.rawTool.toolUseId='live-tool'+n;action.rawTool.result='initial live result';return action;})};
    const semantic=async(caption,result,isError=false,rewindPreview=null)=>f.call('openHistoryRoot',{
      primaryRequestClass:'semantic',localRootLease:identity(cap),primaryPresentation:{...presentation,
        localEntries:[local],liveEntries:[{...live,content:caption}],
        liveToolResults:[{toolUseId:'live-tool0',result,isError}],rewindPreview}});
    const first=await semantic(live.content,'frozen live result');
    const firstState=f.ctl.plane.roots.get(first.leaseId);assert.deepEqual(memoSize(firstState),{slots:0,bytes:0});
    const firstUnits=mat(firstState.primaryPresentation.view.root.cursor().field('units'));
    const liveRank=firstUnits.findIndex(u=>u.kind==='group'&&u.entries.some(e=>e.uuid===live.uuid));
    t.diagnostic(JSON.stringify({liveUnits:firstUnits.map(u=>({kind:u.kind,key:u.key,uuid:u.entry?.uuid,members:u.entries?.map(r=>r.uuid)}))}));
    assert(liveRank>=0);
    const frozenLive=await direct(liveRank,firstState);assert.equal(frozenLive.summary.memo,'miss');
    const second=await semantic('live changed caption','changed live result',true);
    const secondState=f.ctl.plane.roots.get(second.leaseId);assert.deepEqual(memoSize(secondState),{slots:0,bytes:0});
    const secondUnits=mat(secondState.primaryPresentation.view.root.cursor().field('units'));
    const changedRank=secondUnits.findIndex(u=>u.kind==='group'&&u.key===frozenLive.value.key);assert(changedRank>=0);
    const changedLive=await direct(changedRank,secondState);assert.equal(changedLive.summary.memo,'miss');
    assert.equal(changedLive.value.entries.length,frozenLive.value.entries.length);
    assert.notEqual(changedLive.text,frozenLive.text);
    assert(changedLive.value.captionEntries.some(row=>row.uuid===live.uuid&&row.content==='live changed caption'));
    assert(frozenLive.value.captionEntries.some(row=>row.uuid===live.uuid&&row.content===live.content));
    assert(changedLive.value.errorCount>frozenLive.value.errorCount);
    for(const [s,rank,doc] of [[firstState,liveRank,frozenLive],[secondState,changedRank,changedLive]]){
      const old=await originalFork.call(f.ctl.plane,request(rank,s),{consumerKey:f.base._historyRootConsumerKey,control});
      sameText(doc.text,await readDocument(f,old));await close(old);
      const source=mat(s.primaryPresentation.view.root.cursor().field('source'));
      assert(source.some(row=>row.uuid===local.uuid));
      const row=source.find(row=>row.uuid===live.uuid);assert(row);
      assert.equal(row.actions[0].rawTool.result,s===firstState?'frozen live result':'changed live result');
    }
    const retainedBeforeOld=firstState.groupDocuments.some(slot=>slot.rank===liveRank);
    const collectionsBeforeOld=f.ctl.maintenanceMetrics.collections;
    const oldAgain=await direct(liveRank,firstState);sameText(oldAgain.text,frozenLive.text);
    if(oldAgain.summary.memo==='miss')assert(!retainedBeforeOld||f.ctl.maintenanceMetrics.collections>collectionsBeforeOld,
      'a same-parent miss after retention requires eviction/pressure; frozen content must still match');
    else assert.equal(oldAgain.summary.memo,'hit');
    t.diagnostic(JSON.stringify({frozenAfterNewParent:oldAgain.summary.memo,retainedBeforeOld,pressureCollections:f.ctl.maintenanceMetrics.collections}));
    await close(oldAgain);
    await close(changedLive);await close(second);
    // Rewind gets a new parent after the failed-local TTL. The old immutable
    // parent and its already issued document remain unchanged.
    semanticClock=local.statusChangedAt+16000;
    const rewound=await semantic('live after rewind','after rewind',false,{targetUuid:units[0].entry.uuid,
      startedAt:Date.now()+100000,opId:'owned-memo-rewind'});
    const rewindState=f.ctl.plane.roots.get(rewound.leaseId);assert.deepEqual(memoSize(rewindState),{slots:0,bytes:0});
    const rewindSource=mat(rewindState.primaryPresentation.view.root.cursor().field('source'));
    assert(!rewindSource.some(row=>row.uuid===local.uuid||row.uuid===live.uuid));
    assert(rewindSource.length<firstState.primaryPresentation.sourceMetadataCursor.length);
    sameText(await readDocument(f,frozenLive.response),frozenLive.text);
    const frozen=await direct(A);sameText(frozen.text,baseline.get(A));await close(frozen);
    await close(rewound);await close(frozenLive);await close(first);
    } finally {Date.now=realNow;}
  });

  await t.test('pressure drops private pins; public documents/Full survive parent close, final cleanup zero',async()=>{
    f.ctl.plane.releaseGroupDocumentMemos();assert.equal(memoSize(state).slots,0);
    sameText(await readDocument(f,f.held.response),baseline.get(A));sameText(await readDocument(f,full),f.body);
    const b=await direct(B);await close(b);assert.equal(memoSize(state).slots,1);
    const closedRequest=request(A);await model.close();assert.equal(memoSize(state).slots,0);
    await assert.rejects(f.call('forkHistoryRootLeaf',closedRequest),{code:'HISTORY_ROOT_RELEASED'});
    sameText(await readDocument(f,f.held.response),baseline.get(A));sameText(await readDocument(f,full),f.body);
    await close(f.held);await close(full);
    assert.equal(f.ctl.plane.roots.size,0);assert.equal(f.ctl.plane.opening,0);
    assert.equal(f.ctl.store.stats().activeBuilders,0);
    f.ctl.close();assert.equal(f.ctl.store.metrics.leases,0);
    t.diagnostic(JSON.stringify({cleanup:{roots:0,leases:0,privatePins:0,builders:0},fixtureBudgetMiB:96}));
  });
});

test('finite paged-store boundary: exact V8 aliases/types, raw summed budget, oversize and close',async t=>{
  if(process.env.NOTED_MEMO_ORIGINAL_RED==='1')return;
  const {HistoryPagedStore}=require('./history-paged-store');
  const dir=fs.mkdtempSync(path.join(evidence,'values-'));
  const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:8*1024**2});
  const plane=new HistoryRootReadPlane({store,projectHistory:async()=>{throw Error('source forbidden in finite value boundary');}});
  t.after(()=>{plane.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const capRows=store.captureLegacy([{rank:0},{rank:1},{rank:2}]);
  const values=[0,1,2].map(rank=>{
    const row={uuid:'synthetic-'+rank,content:'Ω\r\n\0'+String.fromCharCode(0xd800),rowStub:true};
    const shared={rank,scalar:'q'.repeat(rank===2?66000:34000)};
    const value={kind:'group',key:'group-'+rank,entries:[row],captionEntry:row,captionEntries:[row],
      shared,alias:shared,map:new Map([['shared',shared]]),set:new Set([shared]),
      sparse:new Array(3),negativeZero:-0,nan:NaN,infinity:Infinity,big:12345678901234567890n,missing:undefined};
    value.self=value;value.sparse[2]=shared;return value;
  });
  const primary={headerAt:rank=>capRows.cursor().at(rank),unitForRenderer:async rank=>store.captureLegacy(values[rank])};
  const {state}=plane.install({root:capRows,primaryPresentation:primary},capRows.cursor(),{
    consumerKey:'values',ownerKey:'values-owner',revision:'values-revision',source:{},release:()=>capRows.release()});
  const req=rank=>({...plane.identity(state),nodeToken:plane.nodeToken(state,primary.headerAt(rank)),encoding:'history-display-unit-v8-v1'});
  const read=async response=>{
    let text='',offset=0;
    for(;;){const p=await plane.readPage({...response.payloadDocument,kind:'leaf',offset,limit:4096,creditBytes:16384},{consumerKey:'values'});
      text+=p.text;if(p.done)return text;offset=p.nextOffset;}
  };
  const expected=[];
  for(let rank=0;rank<3;rank++){
    const response=await originalFork.call(plane,req(rank),{consumerKey:'values',control});
    expected.push(await read(response));plane.release(response,{consumerKey:'values'});
  }
  assert(Buffer.from(expected[0],'base64').length<65536);assert(Buffer.from(expected[1],'base64').length<65536);
  assert(Buffer.from(expected[0],'base64').length+Buffer.from(expected[1],'base64').length>65536);
  assert(Buffer.from(expected[2],'base64').length>65536);
  const baselinePins=store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n;
  for(const [rank,outcome] of [[0,'miss'],[0,'hit'],[1,'miss'],[0,'miss'],[2,'skip-budget'],[2,'skip-budget']]){
    let summary;const response=await plane.forkViewUnit(req(rank),{consumerKey:'values',control,onUnitDiagnostic:s=>{summary=s;}});
    const text=await read(response);sameText(text,expected[rank]);
    const value=bodyOf(text);assert.equal(value.self,value);assert.equal(value.shared,value.alias);
    assert.equal(value.map.get('shared'),value.shared);assert(value.set.has(value.shared));assert.equal(value.sparse[2],value.shared);
    assert.equal(0 in value.sparse,false);assert(Object.is(value.negativeZero,-0));assert(Number.isNaN(value.nan));
    assert.equal(value.big,12345678901234567890n);assert.equal(value.captionEntry,value.captionEntries[0]);
    sameText(value.captionEntry.content,values[rank].captionEntry.content);
    assert.equal(summary.memo,outcome);assert(Buffer.byteLength(JSON.stringify(summary))<=1024);
    plane.release(response,{consumerKey:'values'});
    assert.equal(memoSize(state).slots,1);assert(memoSize(state).bytes<=65536);
    assert.equal(store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n,baselinePins+1);
    t.diagnostic(JSON.stringify({rank,outcome,rawBytes:Buffer.from(text,'base64').length,utf16SHA256:hash(text),memo:memoSize(state)}));
  }
  const pressure=Object.create(HistoryRootController.prototype);
  pressure.plane=plane;pressure.store=store;pressure.evictOldest=()=>false;
  let collected=0,samples=0;
  pressure.collect=async()=>{collected++;assert.equal(memoSize(state).slots,0);};
  const savedPragma=store.db.pragma;
  store.db.pragma=function(sql,options){
    if(sql==='max_page_count')return 100;
    if(sql==='page_count')return samples++===0?90:10;
    if(sql==='freelist_count')return 0;
    return savedPragma.call(this,sql,options);
  };
  try{await pressure.makeRoom('forkHistoryRootLeaf',{},control);}finally{store.db.pragma=savedPragma;}
  assert.equal(collected,1);assert.equal(memoSize(state).slots,0);
  t.diagnostic('pressure: actual makeRoom and pin release; pressure counts/collector are injected finite controls');
  plane.close();assert.equal(memoSize(state).slots,0);assert.equal(store.metrics.leases,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM hp_pins WHERE durable=0').get().n,0);
});
