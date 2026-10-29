'use strict';
// Source-only finite SQLite/files. Run node --expose-gc --max-old-space-size=96
// --max-semi-space-size=4 --test <this file>. No application or provider.
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Module=require('node:module'),v8=require('node:v8'),{DatabaseSync}=require('node:sqlite');
const evidence=process.env.NOTED_PHYSICAL_SCOPE_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence),'explicit owned evidence directory');fs.mkdirSync(evidence,{recursive:true});
process.env.CODEX_HOME=path.join(evidence,'no-user-profile');
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2,'total V8 limit <=128 MiB');
let bounded=false,peakFixtureBytes=0,peakHeapTotal=0,semanticPassed=false;
class SQLite {
 constructor(filename,options={}){this.name=filename;this.native=new DatabaseSync(filename,{readOnly:options.readonly===true});this.depth=0;}
 get inTransaction(){return this.native.isTransaction;}
 exec(sql){return this.native.exec(sql);}
 prepare(sql){const s=this.native.prepare(sql),convert=row=>row&&Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Uint8Array?Buffer.from(v):v]));
  return {get:(...a)=>convert(s.get(...a)),all:(...a)=>{if(bounded&&/session_history_events/.test(sql))throw Error('native all N forbidden');return s.all(...a).map(convert);},
   run:(...a)=>s.run(...a),*iterate(...a){for(const row of s.iterate(...a))yield convert(row);}};}
 pragma(sql,o={}){const rows=this.prepare('PRAGMA '+sql).all();return o.simple?Object.values(rows[0])[0]:rows;}
 transaction(fn){return(...a)=>{if(this.depth)return fn(...a);this.native.exec('BEGIN');this.depth++;try{const r=fn(...a);this.native.exec('COMMIT');return r;}
  catch(e){try{this.native.exec('ROLLBACK');}catch{}throw e;}finally{this.depth--;}};}
 close(){this.native.close();}
}
const load=Module._load;Module._load=function(id,parent,main){return id==='better-sqlite3'?SQLite:load.call(this,id,parent,main);};
const NativeDB=require('../../database');
const {SessionTranscriptService}=require('./session-transcript-service');
const api=require('./ipc/codex-data')._api;
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {readCodexRootPhysicalScope:read}=require('./codex-root-physical-scope');
const {buildCodexForkLineageManifest}=require('./session-history-events');
const {createReadControl}=require('./history-read-control');
const manifest=(source='parent',child='child')=>buildCodexForkLineageManifest({sourceSessionId:source,childSessionId:child,
 sourceSegments:[{physicalSessionId:source,fromByte:0,toByte:10,startLine:0,endLine:1,prefixDigest:'a'.repeat(64)}],
 childTailStart:{byteOffset:0,line:1,prefixDigest:'b'.repeat(64)}});
function sample(dir){let bytes=0;for(const n of fs.readdirSync(dir)){const s=fs.lstatSync(path.join(dir,n));assert(!s.isSymbolicLink());if(s.isFile())bytes+=s.size;}
 peakFixtureBytes=Math.max(peakFixtureBytes,bytes);peakHeapTotal=Math.max(peakHeapTotal,process.memoryUsage().heapTotal);
 assert(bytes<=64*1024**2,'fixture <=64 MiB');assert(process.memoryUsage().heapTotal<=128*1024**2);return bytes;}
function fixture(t,metadata={},tail=[],{alternate=false}={}){
 const dir=fs.mkdtempSync(path.join(evidence,'owned-')),filename=path.join(dir,'events.sqlite');
 const db=new SQLite(filename);db.pragma('journal_mode=WAL');const manager=new NativeDB({existingConnection:db});manager.initTables();
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:36*1024**2,residentPages:3});
 const filePath=path.join(dir,alternate?'rollout-other-name.jsonl':'rollout-child.jsonl');
 const records=[{type:'session_meta',payload:{id:'child',cwd:dir,...metadata}},...tail];
 fs.writeFileSync(filePath,records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const scopedApi={...api,findCodexSessionFile:(id,cwd,options)=>api.findCodexSessionFile(id,cwd,{...options,sessionsDir:dir}),
  loadSessionRecords:(id,cwd,options)=>api.loadSessionRecords(id,cwd,{...options,sessionsDir:dir})};
 const service=new SessionTranscriptService({codexData:{_api:scopedApi},sessionHistoryStore:manager});
 const insert=values=>{const row={event_key:'event-'+Math.random(),event_type:'fork',provider:'codex',session_id:'child',source_session_id:'parent',child_session_id:'child',
  entry_uuids_json:'[]',fork_mode:'raw',snapshot_complete:1,is_direct:1,occurred_at:1,...values};const keys=Object.keys(row);
  db.prepare('INSERT INTO session_history_events('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(row));};
 let held=[];const pins=()=>store.db.prepare('SELECT count(*) n FROM hp_pins').get().n;
 async function boundedRead(extra={}){const baseline=pins();bounded=true;let result;
  try{result=await read({store,manager,api:scopedApi,sessionId:'child',cwd:dir,sourceOptions:{sessionsDir:dir},...extra});sample(dir);if(result.success)held.push(result);else assert.equal(pins(),baseline);return result;}
  finally{bounded=false;assert.equal(store.builders,0);}}
 async function native(){const lineage=service._resolveCodexLineage('child','full');const recovery=await service.prepareCodexProviderForkLineage({childSessionId:'child',cwd:dir});
  return {kind:lineage.kind,required:recovery.required,reason:recovery.reason,success:recovery.success};}
 t.after(()=>{for(const r of held)r.release();api.invalidateJsonlCache(filePath);assert.equal(pins(),0);assert.equal(store.builders,0);sample(dir);
  store.close();db.close();fs.rmSync(dir,{recursive:true});assert(!fs.existsSync(dir));global.gc?.();});
 return {dir,filePath,filename,db,manager,store,service,insert,pins,native,boundedRead,records,api:scopedApi};
}

test('FIRST NativeReference actual getter/recovery + file content parity before bounds',async t=>{
 let passed=0;
 const cases=[
  ['ordinary root',{},[],{},'physical',false],
  ['raw physical fork',{forked_from_id:'parent'},[],{fork_mode:'raw',entry_uuids_json:'["a"]'},'physical',false],
  ['empty legacy unknown',{forked_from_id:'parent'},[],{fork_mode:'unknown'},'physical',true],
  ['unknown with normalized members',{forked_from_id:'parent'},[],{fork_mode:'unknown',entry_uuids_json:'[null,7," "," a ","a"]'},'physical',false],
  ['legacy standalone empty rewrite',{forked_from_id:'parent',history_mode:'legacy'},[],{fork_mode:'history_delete'},'physical',false],
  ['exact virtual',{forked_from_id:'parent'},[],{lineage_manifest_json:JSON.stringify(manifest())},'virtual',true],
  ['zero legacy row id',{forked_from_id:'parent'},[],{id:0,lineage_manifest_json:JSON.stringify(manifest())},'virtual',true],
  ['negative legacy row id',{forked_from_id:'parent'},[],{id:-7,lineage_manifest_json:JSON.stringify(manifest())},'virtual',true],
  ['invalid manifest digest physical',{},[],{lineage_manifest_json:JSON.stringify({...manifest(),manifestDigest:'bad'})},'physical',false],
  ['incomplete manifest physical',{},[],{lineage_manifest_json:JSON.stringify(manifest()),snapshot_complete:0},'physical',false],
  ['broken manifest JSON',{},[],{lineage_manifest_json:'{"bad":'},'physical',false],
  ['non-direct descriptor excluded',{},[],{lineage_manifest_json:JSON.stringify(manifest()),is_direct:0},'physical',false],
  ['provider ordinal mismatch',{history_mode:'paginated',forked_from_id:'parent',forked_from_ordinal_exclusive:2,
    history_base:{thread_id:'parent',end_byte_offset:10,end_ordinal_exclusive:1}},[],{},'physical',true],
  ['invalid provider history base',{history_mode:'paginated',forked_from_id:'parent',history_base:{}},[],{},'physical',true],
  ['metadata only provider history base',{history_mode:'paginated',forked_from_id:'parent',history_base:{thread_id:'parent',end_byte_offset:10,end_ordinal_exclusive:0}},[],{},'physical',true],
  ['parent mismatch',{history_mode:'paginated',forked_from_id:'other',history_base:{thread_id:'other',end_byte_offset:10,end_ordinal_exclusive:0}},[],{},'physical',true],
 ];
 for(const [name,metadata,tail,event,kind,required] of cases)await t.test(name,async st=>{
  const f=fixture(st,metadata,tail);if(name!=='ordinary root')f.insert(event);
  const expected=await f.native();assert.equal(expected.kind,kind);assert.equal(expected.required,required);
  const r=await f.boundedRead();assert.equal(r.legacyKind,kind);assert.equal(r.requiredRecovery,required);
  if(r.success){assert.deepEqual(mat(r.metadata),f.records[0].payload);assert(Object.isFrozen(r));assert(Object.isFrozen(r.sourceAuthority));assert.equal(r.sourceAuthority.newMutationReady,undefined);r.release();}
  else if(kind==='virtual')assert.equal(r.error,'HISTORY_ROOT_COMPOSITE_NOT_MIGRATED');
  passed++;
 });
 await t.test('multiple exact parent events',async st=>{const f=fixture(st);f.insert({lineage_manifest_json:JSON.stringify(manifest())});
  f.insert({source_session_id:'other',lineage_manifest_json:JSON.stringify(manifest('other'))});const expected=await f.native();
  assert.equal(expected.kind,'unresolved');const r=await f.boundedRead();assert.equal(r.legacyKind,'unresolved');assert.equal(r.requiredRecovery,expected.required);assert.equal(r.reason,'multiple-exact-parent-events');passed++;});
 await t.test('materialized compact retaining history_base remains physical',async st=>{
  const f=fixture(st,{history_mode:'paginated',forked_from_id:'parent',history_base:{thread_id:'parent',end_byte_offset:10,end_ordinal_exclusive:0}},
   [{type:'compacted',payload:{message:'own compact'}}]);
  const physical=await f.api.loadSessionRecords('child',f.dir);const rows=api.buildCodexTimeline(physical.records,'child');assert(rows.length>0);
  f.insert({fork_mode:'latest_compact',entry_uuids_json:JSON.stringify(rows.map(r=>r.uuid)),boundary_entry_uuid:rows.at(-1).uuid});
  const expected=await f.native();assert.equal(expected.required,false);const r=await f.boundedRead();assert(r.success);assert.equal(r.requiredRecovery,false);r.release();passed++;
 });
 assert.equal(passed,cases.length+2,'every actual native comparison passed before bounds');semanticPassed=true;
});

test('full paged header beyond legacy cutoff, alternate-name discovery, no-record EOF',async t=>{
 assert(semanticPassed,'NativeReference first');
 const f=fixture(t,{padding:'Ω🙂'.repeat(100000),nested:{a:[1,{value:'exact'}]},history_mode:'legacy'},[],{alternate:true});
 const r=await f.boundedRead();assert(r.success);assert.deepEqual(mat(r.metadata),f.records[0].payload);
 assert(r.metrics.sourceBytes>512*1024);assert.equal(r.metrics.wholeLineStrings,0);assert.equal(r.metrics.nativeEventDTOs,0);await r.verify();
 const frozen=mat(r.metadata);fs.appendFileSync(f.filePath,JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'new'}})+'\n');
 assert.deepEqual(mat(r.metadata),frozen);await assert.rejects(r.verify(),{code:'CODEX_SOURCE_READ_INVALIDATED'});r.release();
});

test('large forward children and UUID members stay paged; no all/getter/recovery',async t=>{
 assert(semanticPassed);const f=fixture(t);const many=JSON.stringify(Array.from({length:4000},(_,i)=>'uuid-'+i));
 f.db.transaction(()=>{for(let i=0;i<600;i++)f.insert({session_id:'forward-'+i,source_session_id:'child',child_session_id:'forward-'+i,
  entry_uuids_json:'["'+('x'.repeat(1000))+'"]'});})();
 const parentExpected=await f.native();assert.equal(parentExpected.kind,'physical');assert.equal(parentExpected.required,false);
 const parentScope=await f.boundedRead();assert(parentScope.success);assert.equal(parentScope.metrics.lineageRows,0);assert.equal(parentScope.metrics.sqlChunks,0);parentScope.release();
 f.insert({fork_mode:'unknown',entry_uuids_json:many});
 const expected=await f.native();assert.equal(expected.kind,'physical');assert.equal(expected.required,false);
 f.manager.getSessionHistoryEvents=()=>{throw Error('legacy all getter forbidden');};f.service.ensureCodexProviderForkLineage=()=>{throw Error('recovery forbidden');};
 const r=await f.boundedRead();assert(r.success);assert.equal(r.metrics.lineageRows,1);assert(r.metrics.sqlChunks>32);assert(r.metrics.maxSQLChunkBytes<=1024);r.release();
});

test('large invalid manifest graph parsed on pages, never native JSON graph',async t=>{
 assert(semanticPassed);const f=fixture(t);const m={...manifest(),sourceSegments:Array.from({length:1500},(_,i)=>({physicalSessionId:'p'+i,unknown:'x'.repeat(80)}))};
 f.insert({lineage_manifest_json:JSON.stringify(m)});const expected=await f.native();assert.equal(expected.kind,'physical');
 const r=await f.boundedRead();assert(r.success);assert(r.metrics.sqlChunks>100);r.release();
});

test('read-only constructor/connection, root pins, cancellation and fault cleanup',async t=>{
 assert(semanticPassed);const f=fixture(t,{padding:'x'.repeat(10000)});const original=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{assert(!/^\s*(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP)/i.test(sql),'descriptor DB read-only');return original(sql);};
 let baseline=f.pins();const r=await f.boundedRead();assert(r.success);assert(f.pins()>baseline);r.release();r.release();assert.equal(f.pins(),baseline);
 assert.throws(()=>r.assertCurrent(),{code:'HISTORY_ROOT_SCOPE_RELEASED'});
 const ac=new AbortController();let checks=0;const control=createReadControl({signal:ac.signal,schedule:async()=>{if(++checks===3)ac.abort();await new Promise(resolve=>setImmediate(resolve));}});
 await assert.rejects(f.boundedRead({control}),{code:'HISTORY_READ_CONSUMER_REVOKED'});assert.equal(f.pins(),baseline);
 const faultApi={...api,assertCodexSourceRead:async()=>{throw Object.assign(Error('finite I/O fault'),{code:'EIO'});}};
 await assert.rejects(f.boundedRead({api:faultApi}),{code:'EIO'});assert.equal(f.pins(),baseline);
 const put=f.store.put.bind(f.store);let writes=0;
 f.store.put=(...args)=>{if(++writes===35)throw Object.assign(Error('fixture backing full'),{code:'HISTORY_BACKING_FULL'});return put(...args);};
 try{await assert.rejects(f.boundedRead(),{code:'HISTORY_BACKING_FULL'});}finally{f.store.put=put;}
 assert.equal(f.pins(),baseline);assert.equal(f.store.builders,0);
 const settled=createReadControl();const held=await f.boundedRead({control:settled});settled.finish();assert.equal(f.pins(),baseline);assert.throws(()=>held.assertCurrent());
});

test('actual readonly DB, no DDL at construction, frozen SQL scope, unknown versions and non-scalar metadata',async t=>{
 assert(semanticPassed);
 await t.test('readonly file and connection replacement',async st=>{
  const f=fixture(st);const readonly=new SQLite(f.filename,{readonly:true});const total=readonly.prepare('SELECT total_changes() n').get().n;
  f.manager.db=readonly;
  try{const r=await f.boundedRead();assert(r.success);assert.equal(readonly.prepare('SELECT total_changes() n').get().n,total);
   f.manager.db=f.db;assert.throws(()=>r.assertCurrent(),{code:'HISTORY_ROOT_LINEAGE_SQL_UNKNOWN'});r.release();}
  finally{f.manager.db=f.db;readonly.close();}
 });
 await t.test('unknown version is not zero',async st=>{
  const f=fixture(st),prepare=f.db.prepare.bind(f.db);
  f.db.prepare=sql=>/PRAGMA main.data_version/.test(sql)?{get:()=>({})}:prepare(sql);
  const r=await f.boundedRead();assert.equal(r.error,'HISTORY_ROOT_LINEAGE_SQL_UNKNOWN');assert.equal(r.reason,'version-unknown');
 });
 await t.test('unknown source proof never grants physical scope',async st=>{
  const f=fixture(st);for(const value of [null,{snapshot:{}}]){const r=await f.boundedRead({api:{...f.api,beginCodexSourceRead:async()=>value}});
   assert.equal(r.error,'HISTORY_ROOT_SOURCE_UNAVAILABLE');assert.equal(r.reason,'source-proof-unknown');assert.equal(r.requiredRecovery,null);}
 });
 await t.test('postpublication SQL version guard preserves frozen metadata',async st=>{
  const f=fixture(st,{nested:{value:'frozen'}}),r=await f.boundedRead(),prior=mat(r.metadata);
  f.insert({fork_mode:'unknown'});assert.throws(()=>r.assertCurrent(),{code:'HISTORY_ROOT_LINEAGE_CHANGED'});
  assert.deepEqual(mat(r.metadata),prior);r.release();
 });
 await t.test('complex provider metadata is explicitly unmigrated',async st=>{
  const f=fixture(st,{history_mode:'paginated',forked_from_id:'parent',history_base:{thread_id:'parent',end_byte_offset:[1],end_ordinal_exclusive:0}});
  const r=await f.boundedRead();assert.equal(r.error,'HISTORY_ROOT_METADATA_COERCION_NOT_MIGRATED');assert.equal(r.requiredRecovery,null);
 });
 await t.test('complete header without newline and missing/corrupt header',async st=>{
  const f=fixture(st);fs.writeFileSync(f.filePath,JSON.stringify(f.records[0]));let r=await f.boundedRead();assert(r.success);assert.deepEqual(mat(r.metadata),f.records[0].payload);r.release();
  fs.writeFileSync(f.filePath,'{"type":"session_meta","payload":');r=await f.boundedRead();assert.equal(r.error,'HISTORY_ROOT_METADATA_UNRESOLVED');assert.equal(r.reason,'partial-header-record');
 });
});

test('source rewrite / external epoch / SQL version / SQL unknown refuse, clean every lease',async t=>{
 assert(semanticPassed);
 for(const change of ['rewrite','epoch','sql','unknown'])await t.test(change,async st=>{
  const f=fixture(st,{padding:'x'.repeat(10000)});let done=false;
  const control=createReadControl({schedule:async()=>{if(!done){done=true;
   if(change==='rewrite')fs.writeFileSync(f.filePath,JSON.stringify({type:'session_meta',payload:{id:'other'}})+'\n');
   if(change==='epoch')api.invalidateJsonlCache(f.filePath);
   if(change==='sql')f.insert({fork_mode:'unknown'});
  }await new Promise(resolve=>setImmediate(resolve));}});
  if(change==='unknown'){f.db.prepare=()=>{throw Object.assign(Error('unknown SQL'),{code:'SQLITE_IOERR'});};const r=await f.boundedRead();assert.equal(r.error,'HISTORY_ROOT_LINEAGE_SQL_UNKNOWN');assert.equal(r.requiredRecovery,null);}
  else if(change==='sql'){const r=await f.boundedRead({control});assert(!r.success);assert.equal(r.requiredRecovery,true);}
  else await assert.rejects(f.boundedRead({control}),{code:'CODEX_SOURCE_READ_INVALIDATED'});
 });
 await t.test('foreign WAL commit after initial SQL witness',async st=>{
  const f=fixture(st);f.insert({lineage_manifest_json:JSON.stringify({...manifest(),extra:'x'.repeat(10000)})});let done=false;
  const control=createReadControl({schedule:async()=>{if(!done&&bounded){
    // Source prefix uses checkpoints too; wait for the metadata pager's first query.
    if(sqlStarted){done=true;const foreign=new SQLite(f.filename);foreign.prepare('UPDATE session_history_events SET fork_mode=?').run('changed');foreign.close();}}
   await new Promise(resolve=>setImmediate(resolve));}});
  let sqlStarted=false;const prepare=f.db.prepare.bind(f.db);f.db.prepare=sql=>{if(/typeof\(lineage_manifest_json\)/.test(sql))sqlStarted=true;return prepare(sql);};
  await assert.rejects(f.boundedRead({control}),{code:'HISTORY_ROOT_LINEAGE_CHANGED'});assert(done);
 });
});

test('bounds and cleanup receipt',()=>{assert(semanticPassed);const result={semanticPassed,peakFixtureBytes,peakHeapTotal,v8Limit:v8.getHeapStatistics().heap_size_limit,
 qualification:'finite real node:sqlite, actual NativeReference and source API; no app/Electron/provider/UI acceptance'};
 fs.writeFileSync(path.join(evidence,'RESULT.json'),JSON.stringify(result,null,2));});
