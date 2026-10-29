'use strict';
// Run directly; explicit node:sqlite ABI adapter, actual DB getters/selector.
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),v8=require('node:v8');
const {DatabaseSync}=require('node:sqlite');
const evidence=process.env.NOTED_FORK_PRESENTATION_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence),'explicit owned evidence');fs.mkdirSync(evidence,{recursive:true});
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2);
let liveConnections=0,peakConnections=0,peakFixtureBytes=0,peakHeapTotal=0,peakHeapUsed=0;
function sample(){const m=process.memoryUsage();peakHeapTotal=Math.max(peakHeapTotal,m.heapTotal);peakHeapUsed=Math.max(peakHeapUsed,m.heapUsed);
 assert(m.heapTotal<=128*1024**2);assert(liveConnections<=2);}
class SQLite {
  constructor(filename,options={}) {
    this.name=filename;this.native=new DatabaseSync(filename,{readOnly:options.readonly===true});this.depth=0;
    liveConnections++;peakConnections=Math.max(peakConnections,liveConnections);sample();
  }
  get inTransaction(){return this.native.isTransaction;}
  exec(sql){return this.native.exec(sql);}
  prepare(sql){
    // ABI adapter only: node:sqlite returns null-prototype records/Uint8Array
    // and truncates native TEXT at NUL. better-sqlite3 returns ordinary records,
    // Buffers and complete strings. For finite oracle getter SELECTs, move TEXT
    // as bytes and decode according to the actual SQLite storage type. Getter
    // methods, WHERE/ORDER/eligibility and normalization stay unchanged.
    const getter=sql.match(/^\s*SELECT\s+(\*|entry_uuid, content, position|entry_uuid)\s+FROM\s+(timeline_[a-z_]+|session_history_events)([\s\S]*)$/);
    let columns=null;
    if(getter) {
      columns=getter[1]==='*'?this.native.prepare('PRAGMA table_info('+getter[2]+')').all().map(r=>r.name):getter[1].split(',').map(s=>s.trim());
      sql='SELECT '+columns.flatMap(c=>['CASE WHEN typeof('+c+")='text' THEN CAST("+c+' AS BLOB) ELSE '+c+' END AS '+c,
        'typeof('+c+') AS __source_kind_'+c]).join(',')+' FROM '+getter[2]+getter[3];
    }
    if(/SELECT event\.\*/.test(sql)){
      columns=this.native.prepare('PRAGMA table_info(session_history_events)').all().map(r=>r.name);
      sql=sql.replace('event.*',columns.flatMap(c=>['CASE WHEN typeof(event.'+c+")='text' THEN CAST(event."+c+' AS BLOB) ELSE event.'+c+' END AS '+c,
       'typeof(event.'+c+') AS __source_kind_'+c]).join(','));
    }
    const statement=this.native.prepare(sql);
    const convert=row=>{
      if(!row)return row;const out={};
      for(const [key,value] of Object.entries(row))if(!key.startsWith('__source_kind_'))
        out[key]=value instanceof Uint8Array?columns&&row['__source_kind_'+key]==='text'?Buffer.from(value).toString('utf8'):Buffer.from(value):value;
      return out;
    };
    return {get:(...args)=>convert(statement.get(...args)),all:(...args)=>statement.all(...args).map(convert),
      run:(...args)=>statement.run(...args),*iterate(...args){for(const row of statement.iterate(...args))yield convert(row);}};
  }
  pragma(sql,options={}){const rows=this.prepare('PRAGMA '+sql).all();return options.simple?Object.values(rows[0])[0]:rows;}
  transaction(fn){return (...args)=>{
    if(this.depth)return fn(...args);this.native.exec('BEGIN');this.depth++;
    try{const out=fn(...args);this.native.exec('COMMIT');return out;}
    catch(error){try{this.native.exec('ROLLBACK');}catch{}throw error;}finally{this.depth--;}
  };}
  close(){this.native.close();liveConnections--;}
}

const originalLoad=Module._load;
Module._load=function(id,parent,main){return id==='better-sqlite3'?SQLite:originalLoad.call(this,id,parent,main);};
const NativeDB=require('../../database'),RootDB=require('./database');
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {createTimelineLogicalRoot}=require('./timeline-root-logical');
const {captureTimelineRootForkPresentation:capture}=require('./timeline-root-fork-presentation');
const schema=require('./timeline-fork-presentation-version-schema');
const {readTimelineForkPresentationFreshness:read}=require('./timeline-fork-presentation-freshness');
const {readPrimarySidecarWitness:primary}=require('./history-primary-sidecar-witness');
const {selectAppForkMarker}=require('../shared/fork-marker-boundary.cjs');
let normalizeForkMarkers,semanticsPassed=false;
async function fixture(t,ids=['a','b','a','rewritten','edge','child']){
 const dir=fs.mkdtempSync(path.join(evidence,'fixture-')),file=path.join(dir,'forks.sqlite');
 let db=new SQLite(file);db.pragma('journal_mode=WAL');db.pragma('max_page_count=4096');
 const manager=new NativeDB({existingConnection:db});manager.initTables();
 const rootManager=new RootDB({existingConnection:db});
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:48*1024**2});
 store.db.prepare('ATTACH DATABASE ? AS fixture').run(file);
 const arena=new HistoryProjectionArena(store);
 const source=arena.step(()=>{arena.state().entries=arena.own(ids.map(uuid=>({uuid,type:'user',content:'fixture '+uuid,sessionId:'child'})));
  return arena.publish(arena.state().entries);});arena.close();
 const logical=await createTimelineLogicalRoot(store,{success:true,semanticSnapshotComplete:true,entries:source.cursor(),root:source});
 let currentSource=source;
 const stats=()=>{let bytes=0;for(const name of fs.readdirSync(dir)){const st=fs.lstatSync(path.join(dir,name));assert(!st.isSymbolicLink());bytes+=st.size;}
  peakFixtureBytes=Math.max(peakFixtureBytes,bytes);assert(bytes<=64*1024**2);sample();return bytes;};
 const options=()=>({store,manager,sessionId:'child',logicalRoot:logical,readSourceWitness(){assert.equal(currentSource,source);void source.cursor().kind;return JSON.stringify(source.descriptor);},
  cooperate:async()=>{assert.equal(db.inTransaction,false);assert.equal(store.db.inTransaction,false);stats();await new Promise(resolve=>setImmediate(resolve));}});
 t.after(()=>{logical.release();source.release();stats();store.close();db.close();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir));global.gc?.();});
 const insert=(table,values)=>{const keys=Object.keys(values);db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(values));};
 const event=(key,values={})=>insert('session_history_events',{event_key:key,event_type:'fork',provider:'codex',session_id:'child',source_session_id:key,
  child_session_id:'child',entry_uuids_json:'["a","b"]',occurred_at:10,is_direct:1,operation_kind:'fork',...values});
 const native=()=>{manager._forkMarkerCache.clear();rootManager._forkMarkerCache.clear();const all=normalizeForkMarkers(manager.getForkMarkers('child'));
  assert.deepEqual(normalizeForkMarkers(rootManager.getForkMarkers('child')),all);const selected=selectAppForkMarker(all,'child',mat(logical.entries));return {all,selected,markers:selected?[selected]:[]};};
 const pins=()=>store.db.prepare('SELECT count(*) n FROM hp_pins').get().n;
 const foreign=sql=>store.db.exec(sql.replace(/\b(session_history_events|timeline_fork_origins|fork_markers|session_links|app_state)\b/g,'fixture.$1'));
 return {dir,file,get db(){return db;},store,manager,rootManager,source,logical,options,stats,insert,event,native,pins,foreign,
  invalidateSource(){currentSource=null;},reopen(){db.close();db=new SQLite(file,{readonly:true});manager.db=db;rootManager.db=db;}};
}
async function parity(f){const expected=f.native(),pins=f.pins(),s=await capture(f.options());
 assert.deepEqual(mat(s.forkMarkers),expected.markers);assert.equal(s.markerCount,expected.all.length);
 assert.equal(s.selectedCount,expected.selected?1:0);if(expected.selected){assert.deepEqual(mat(s.selected),expected.selected);
  for(const id of expected.selected.entry_uuids)assert(s.hasEntryUuid(id));assert(!s.hasEntryUuid('no-such-id'));}
 assert.equal(mat(s.optionsRoot.cursor().field('forkMarkers')).length,s.selectedCount);
 s.release();assert.equal(f.pins(),pins);assert.equal(f.store.builders,0);return expected;}

test('FIRST complete actual Native getter + Timeline normalize/select equality on owned corpus',async t=>{
 ({normalizeForkMarkers}=await import('../../../renderer/utils/forkMarkerSnapshot.mjs'));
 const f=await fixture(t);assert.equal(read(f.db).mode,'scoped');await parity(f);
 f.event('grandparent',{is_direct:0,entry_uuids_json:'["a","b","edge"]',occurred_at:99});
 f.event('parent',{occurred_at:7,entry_uuids_json:'["a","removed","b"," a ",null,9,{},"", "b"]',
  source_tab_id:'source',child_tab_id:'child-tab',visual_parent_tab_id:'visual',orchestration_run_id:'run',orchestration_parent_run_id:'parent-run',metadata_copied:1});
 assert.equal((await parity(f)).selected.source_session_id,'parent','proven direct beats inherited');
 f.event('hidden',{hidden:1,occurred_at:999});f.event('incomplete',{snapshot_complete:0,occurred_at:999});
 f.event('rewind',{operation_kind:'rewind',occurred_at:999});f.event('edit',{operation_kind:'edit',occurred_at:999});
 f.event('delete',{operation_kind:'delete',occurred_at:999});f.event('technical',{operation_kind:'provider',occurred_at:999});
 f.event('outgoing',{session_id:'other',child_session_id:'other',source_session_id:'child',occurred_at:999});
 await parity(f);
 // Equal dates: latest surviving logical boundary, normalized unique count,
 // source localeCompare, then stable Native ascending id order.
 f.event('rank',{occurred_at:7,entry_uuids_json:'["edge"]'});assert.equal((await parity(f)).selected.source_session_id,'rank');
 f.event('count',{occurred_at:7,entry_uuids_json:'["edge","missing"]'});assert.equal((await parity(f)).selected.source_session_id,'count');
 f.event('zΩ',{occurred_at:7,entry_uuids_json:'["edge","missing"]'});assert.equal((await parity(f)).selected.source_session_id,'zΩ');
 f.event('same-source',{source_session_id:'zΩ',occurred_at:7,entry_uuids_json:'["edge","missing"]'});await parity(f);
 const boundary=await capture(f.options());assert.deepEqual(mat(boundary.selectedBoundary),{atBeginning:false,boundaryIndex:4,boundaryUuid:'edge',matchedCount:1,snapshotCount:2});boundary.release();
 // A nonempty all-removed snapshot still selects; it is not atBeginning.
 f.event('no-survivor',{occurred_at:1000,entry_uuids_json:'["removed"]'});await parity(f);
 let s=await capture(f.options());assert.equal(mat(s.selectedBoundary).atBeginning,false);assert.equal(mat(s.selectedBoundary).boundaryIndex,-1);s.release();
 f.event('empty',{occurred_at:1001,entry_uuids_json:'[]'});await parity(f);
 s=await capture(f.options());assert.equal(mat(s.selectedBoundary).atBeginning,true);s.release();
 // Pure normalization malformed, primitive, BLOB, whitespace, UTF16 and NUL.
 for(const json of ['broken','null','{}','["a","a",null,0,false," b ","\\ud800","Ω😀","x\\u0000z"]',Buffer.from('["a"]')]){
  f.db.prepare('UPDATE session_history_events SET entry_uuids_json=? WHERE event_key=?').run(json,'empty');await parity(f);
 }
 f.db.exec('DELETE FROM session_history_events');
 f.event('origin-app',{session_id:'app-child',child_session_id:'app-child',source_session_id:'origin-parent',entry_uuids_json:'["a","edge"]',boundary_entry_uuid:'edge'});
 f.event('technical-child',{operation_kind:'rewind',source_session_id:'app-child',entry_uuids_json:'["a","edge","child"]'});
 f.insert('timeline_fork_origins',{session_id:'child',event_key:'origin-app',boundary_entry_uuid:'edge'});
 assert.equal((await parity(f)).selected.fork_session_id,'app-child','retains actual original event/action identity');
 f.db.exec("UPDATE timeline_fork_origins SET boundary_entry_uuid='removed'");assert.equal((await parity(f)).selected,null);
 f.db.exec('UPDATE timeline_fork_origins SET boundary_entry_uuid=NULL');await parity(f);
 f.db.exec("UPDATE session_history_events SET hidden=1 WHERE event_key='origin-app'");assert.equal((await parity(f)).selected,null);
 f.db.exec("UPDATE session_history_events SET hidden=0 WHERE event_key='origin-app'");
 f.event('new-app-fork',{occurred_at:1});assert.equal((await parity(f)).selected.source_session_id,'new-app-fork');
 // Legacy mode compatibility including unknown normalized operation and origin.
 f.db.exec('DELETE FROM session_history_events');f.db.exec('DELETE FROM timeline_fork_origins');
 for(const [i,fields] of [
  {operation_kind:null,fork_mode:'full',origin:'app'},
  {operation_kind:'future',fork_mode:'latest_compact',origin:'terminal-mcp'},
  {operation_kind:null,fork_mode:null,origin:'legacy-fork-marker'},
  {operation_kind:null,fork_mode:'direct-virtual',origin:'app'},
  {operation_kind:null,fork_mode:'full',origin:'foreign'},
 ].entries()){f.event('legacy'+i,{...fields,occurred_at:i+1});await parity(f);}
 // Unbounded selector scalars are not narrowed to an ID vocabulary/cap.
 f.db.exec('DELETE FROM session_history_events');
 const longSource='sourceΩ😀'.repeat(800),longMeta='full\0Ω😀'.repeat(500);
 f.event('long-identity',{source_session_id:longSource,entry_uuids_json:'["edge","a"]',source_tab_id:longMeta,occurred_at:'not-a-number'});
 f.event('long-identity-tie',{source_session_id:longSource+'z',entry_uuids_json:'["edge","a"]',source_tab_id:longMeta,occurred_at:'not-a-number'});
 await parity(f);
 semanticsPassed=true;
});

test('frozen selected capability, all source membership, real paged lookups and independent pins',async t=>{
 assert(semanticsPassed);const f=await fixture(t);const ids=Array.from({length:96},(_,n)=>'source-'+n);
 ids.push('edge','a','a',' a ');f.event('selected',{entry_uuids_json:JSON.stringify(ids)});
 const expected=f.native(),pins=f.pins(),s=await capture(f.options()),fork=s.fork();
 assert.deepEqual(mat(s.forkMarkers),expected.markers);assert.equal(s.entryUuidCount,98);
 for(const id of ids)assert(s.hasEntryUuid(id.trim()),'all source membership, not only logical survivors');
 assert.equal(mat(s.selectedBoundary).matchedCount,3);assert.equal(mat(s.selectedBoundary).boundaryIndex,4);
 const old=mat(s.forkMarkers);f.db.exec("UPDATE session_history_events SET entry_uuids_json='[\"child\"]',hidden=1");
 const fresh=await capture(f.options());assert.deepEqual(mat(fresh.forkMarkers),[]);assert.deepEqual(mat(s.forkMarkers),old);
 assert(Object.isFrozen(s)&&Object.isFrozen(s.captureWitness)&&Object.isFrozen(s.stats));
 const heldBefore=f.pins();f.logical.release();f.source.release();const inputPinsReleased=heldBefore-f.pins();
 assert(inputPinsReleased>0);assert(s.hasEntryUuid('source-95'),'result pins its own pages after logical/source release');
 s.release();assert.deepEqual(mat(fork.forkMarkers),old);assert(fork.hasEntryUuid('source-95'));
 assert.throws(()=>s.hasEntryUuid('a'));fork.release();fresh.release();assert.equal(f.pins(),pins-inputPinsReleased);
 assert.equal(f.store.builders,0);
});
async function during(f,mutate,extra={}){let calls=0;return capture({...f.options(),...extra,cooperate:async()=>{
 assert.equal(f.db.inTransaction,false);assert.equal(f.store.db.inTransaction,false);if(++calls===1)mutate();await new Promise(resolve=>setImmediate(resolve));}});}
const changed=e=>e.code==='TIMELINE_FORK_PRESENTATION_CAPTURE_CHANGED';
test('committed freshness covers all fork tables, providers, OLD/NEW rows; unrelated UI and foreign rollback survive',async t=>{
 assert(semanticsPassed);const f=await fixture(t);f.event('parent');
 f.insert('timeline_fork_origins',{session_id:'other',event_key:'parent',boundary_entry_uuid:'a'});
 f.insert('fork_markers',{source_session_id:'outside',forked_to_session_id:'outside-child'});
 f.insert('session_links',{parent_session_id:'outside',child_session_id:'outside-child'});
 f.insert('app_state',{key:'UI',value:'old'});
 const before=read(f.db),s=await during(f,()=>f.foreign("UPDATE app_state SET value='new'"));
 assert.equal(s.captureWitness.mode,'scoped');assert.deepEqual(mat(s.forkMarkers),f.native().markers);s.release();
 assert.equal(read(f.db).version,before.version);assert.notEqual(read(f.db).dataVersion,before.dataVersion);
 const mutations=[
  "UPDATE timeline_fork_origins SET boundary_entry_uuid='b'",
  "DELETE FROM timeline_fork_origins", "INSERT INTO timeline_fork_origins VALUES('other','parent','b')",
  "UPDATE fork_markers SET hidden=1", "DELETE FROM fork_markers", "INSERT INTO fork_markers(source_session_id,forked_to_session_id) VALUES('x','y')",
  "UPDATE session_links SET parent_session_id='moved'", "DELETE FROM session_links", "INSERT INTO session_links(parent_session_id,child_session_id) VALUES('x','y')",
  "UPDATE session_history_events SET provider='claude',source_session_id='moved',occurred_at=10",
  "INSERT INTO session_history_events(event_key,event_type,provider,session_id,source_session_id) VALUES('outside','compact','claude','outside','elsewhere')",
  "DELETE FROM session_history_events WHERE event_key='outside'",
 ];
 for(const sql of mutations){const prior=read(f.db),pins=f.pins();await assert.rejects(during(f,()=>f.foreign(sql)),e=>changed(e)&&e.reason==='version');
  assert(read(f.db).version>prior.version);assert.equal(f.pins(),pins);assert.equal(f.store.builders,0);}
 const committed=read(f.db);
 await assert.rejects(during(f,()=>{f.db.exec('BEGIN');f.db.exec("UPDATE session_history_events SET hidden=1");f.db.exec('ROLLBACK');}),e=>changed(e)&&e.reason==='totalChanges');
 assert.equal(read(f.db).version,committed.version);
 const stable=await during(f,()=>{f.store.db.exec('BEGIN');f.foreign('DELETE FROM session_history_events');f.store.db.exec('ROLLBACK');});stable.release();
});

test('cancel during SQL/parser/membership; source/logical/file/connection/schema fences; no retries or leaks',async t=>{
 assert(semanticsPassed);const f=await fixture(t);f.event('parent',{entry_uuids_json:JSON.stringify(Array.from({length:96},(_,n)=>'id-'+n))});
 const baseline=f.pins();
 for(const phase of ['SQL','parser','membership']){
  let cancelled=false,calls=0,sawParser=false;
  await assert.rejects(capture({...f.options(),chunkBytes:64,control:{assertCurrent(){if(cancelled)throw Object.assign(Error(phase),{code:'OWN_CANCEL'});}},
   cooperate:async()=>{calls++;assert.equal(f.db.inTransaction,false);
    if(f.store.builders===2)sawParser=true;
    if(phase==='SQL'&&!sawParser||phase==='parser'&&f.store.builders===2||phase==='membership'&&sawParser&&f.store.builders===1)cancelled=true;
   }}),{code:'OWN_CANCEL'},phase);
  if(phase!=='SQL')assert(sawParser,'actual parser-active overlap for '+phase);
  assert(cancelled);assert.equal(f.pins(),baseline);assert.equal(f.store.builders,0);
 }
 const logicalRevision=f.logical.revision;
 await assert.rejects(during(f,()=>{f.logical.revision='changed';}),{code:'TIMELINE_FORK_PRESENTATION_LOGICAL_CHANGED'});f.logical.revision=logicalRevision;
 await assert.rejects(during(f,()=>{f.manager.db={};}),{code:'TIMELINE_FORK_PRESENTATION_CONNECTION_CHANGED'});f.manager.db=f.db;
 await assert.rejects(during(f,()=>f.foreign('ALTER TABLE fork_markers ADD COLUMN custom TEXT')),changed);
 f.db.exec('ALTER TABLE fork_markers DROP COLUMN custom');
 const renamed=f.file+'.saved';let moved=false;
 try{await assert.rejects(during(f,()=>{fs.renameSync(f.file,renamed);fs.writeFileSync(f.file,'replacement');moved=true;}),e=>changed(e)&&e.reason==='inode');}
 finally{if(moved){fs.unlinkSync(f.file);fs.renameSync(renamed,f.file);}}
 f.db.exec('BEGIN');await assert.rejects(capture(f.options()),{code:'TIMELINE_FORK_PRESENTATION_CONNECTION_CHANGED'});f.db.exec('ROLLBACK');
 await assert.rejects(during(f,()=>f.invalidateSource()),/strictly equal|reference-equal/);
 assert.equal(f.pins(),baseline);assert.equal(f.store.builders,0);
});

test('exact additive grammar, normal init, readonly constructor and primary attestation remain scoped; unknown extras refuse',async t=>{
 assert(semanticsPassed);const f=await fixture(t);f.event('parent');
 assert.equal(primary(f.db,['child'],'own').mode,'scoped','six owned hooks do not break primary witness');
 new (require('../../storage-retention-grace').SqliteStorageGraceStore)(f.db);
 assert.equal(f.db.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name IN
  ('history_response_timings','history_response_timing_aliases','session_history_events','session_links','agent_activity_intervals','history_prompt_presentations')`).get().n,26);
 assert.equal(primary(f.db,['child'],'own').mode,'scoped','entire 26-trigger inventory with retention clocks');
 assert.equal(read(f.db).mode,'scoped');
 assert.deepEqual(require('../../timeline-fork-presentation-freshness').readTimelineForkPresentationFreshness(f.db),read(f.db));
 f.db.exec('CREATE TEMP TABLE timeline_fork_presentation_version(x)');
 assert.equal(primary(f.db,['child'],'own').mode,'database');assert.equal(read(f.db).mode,'database');
 f.db.exec('DROP TABLE temp.timeline_fork_presentation_version');
 assert.equal(primary(f.db,['child'],'own').mode,'scoped');assert.equal(read(f.db).mode,'scoped');
 f.db.exec('CREATE TRIGGER unknown_counter AFTER UPDATE ON timeline_fork_presentation_version BEGIN SELECT 9; END');
 assert.equal(primary(f.db,['child'],'own').mode,'database');assert.equal(read(f.db).mode,'database');f.db.exec('DROP TRIGGER unknown_counter');

 const version=read(f.db).version,sv=read(f.db).schemaVersion;
 require('../../timeline-fork-presentation-version-schema').installTimelineForkPresentationVersionSchema(f.db);
 schema.installTimelineForkPresentationVersionSchema(f.db);
 assert.equal(read(f.db).schemaVersion,sv);assert.equal(read(f.db).version,version);
 f.rootManager.initTables();assert.equal(read(f.db).mode,'scoped');assert.equal(primary(f.db,['child'],'own').mode,'scoped');
 for(const DB of [NativeDB,RootDB]){const connection={prepare(){throw Error('SQL');},exec(){throw Error('DDL');}};
  assert.equal(new DB({existingConnection:connection}).db,connection);assert.match(DB.prototype.initTables.toString(),/installTimelineForkPresentationVersionSchema/);}
 const trigger='fork_presentation_version_session_links_update';
 f.db.exec('DROP TRIGGER '+trigger);assert.equal(read(f.db).mode,'database');schema.installTimelineForkPresentationVersionSchema(f.db);assert.equal(read(f.db).mode,'scoped');
 f.db.exec('DROP TRIGGER '+trigger);f.db.exec('CREATE TRIGGER '+trigger+' AFTER UPDATE ON session_links BEGIN SELECT 9; END');
 const ddl=f.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(trigger).sql;
 schema.installTimelineForkPresentationVersionSchema(f.db);assert.equal(f.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(trigger).sql,ddl);
 assert.equal(read(f.db).mode,'database');assert.equal(primary(f.db,['child'],'own').mode,'database');
 f.insert('app_state',{key:'UI',value:'x'});await assert.rejects(during(f,()=>f.foreign("UPDATE app_state SET value='y'")),e=>changed(e)&&e.reason==='dataVersion');
 f.db.exec('DROP TRIGGER '+trigger);schema.installTimelineForkPresentationVersionSchema(f.db);
 f.db.exec('CREATE TRIGGER unknown_extra AFTER UPDATE ON session_links BEGIN SELECT 4; END');
 assert.equal(read(f.db).mode,'database');assert.equal(primary(f.db,['child'],'own').mode,'database');f.db.exec('DROP TRIGGER unknown_extra');
 f.db.exec('CREATE TEMP TABLE timeline_fork_origins(x)');assert.equal(read(f.db).mode,'database');f.db.exec('DROP TABLE temp.timeline_fork_origins');
 f.db.exec('UPDATE timeline_fork_presentation_version SET version=-1');assert.equal(read(f.db),null);
 await assert.rejects(capture(f.options()),{code:'TIMELINE_FORK_PRESENTATION_WITNESS_UNKNOWN'});f.db.exec('UPDATE timeline_fork_presentation_version SET version=123');
 // Unknown same-column source grammar cannot acquire scoped authority.
 for(const [name] of schema.triggerDefinitions())f.db.exec('DROP TRIGGER '+name);
 f.db.exec('DROP TABLE timeline_fork_presentation_version');
 assert.equal(read(f.db).mode,'database');
 f.db.exec('DROP TABLE timeline_fork_origins');
 f.db.exec(schema.TABLES.find(t=>t.name==='timeline_fork_origins').ddl.replace('event_key TEXT NOT NULL','event_key TEXT COLLATE NOCASE NOT NULL'));
 schema.installTimelineForkPresentationVersionSchema(f.db);
 assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='timeline_fork_presentation_version'").get().n,0);
 assert.equal(read(f.db).mode,'database');await parity(f);
 f.db.exec('DROP TABLE timeline_fork_origins');f.db.exec(schema.TABLES.find(t=>t.name==='timeline_fork_origins').ddl);
 schema.installTimelineForkPresentationVersionSchema(f.db);assert.equal(read(f.db).mode,'scoped');
 f.reopen();assert.equal(read(f.db).mode,'scoped');const prepare=f.db.prepare.bind(f.db);
 f.db.prepare=sql=>{assert(/^\s*(SELECT|PRAGMA)/.test(sql));return prepare(sql);};await parity(f);
 for(const name of ['timeline-fork-presentation-version-schema.js'])assert.equal(fs.readFileSync(path.join(__dirname,name),'utf8'),fs.readFileSync(path.resolve(__dirname,'../..',name),'utf8'));
});

test('AFTER equality: paged-only product capture, finite storage/heap, capability lookup and complete cleanup',async t=>{
 assert(semanticsPassed);const f=await fixture(t);const ids=Array.from({length:160},(_,n)=>'source-'+n+'Ω😀'.repeat(3));
 f.event('paged',{entry_uuids_json:JSON.stringify(ids)});const expected=f.native(),prepare=f.db.prepare.bind(f.db),parse=JSON.parse;
 let payloadParse=0;JSON.parse=function(v,...args){if(v===JSON.stringify(ids)){payloadParse++;throw Error('NativeN JSON parse');}return parse(v,...args);};
 f.manager.getForkMarkers=()=>{throw Error('Native getter');};f.manager.getSessionHistoryContext=()=>{throw Error('Native getter');};
 f.db.prepare=sql=>{assert(/^(SELECT|PRAGMA)/.test(sql));assert(!/MAX\s*\(/i.test(sql));const statement=prepare(sql);
  return {...statement,all(){throw Error('NativeN all');}};};
 let s;try{s=await capture(f.options());}finally{f.db.prepare=prepare;JSON.parse=parse;}
 assert.deepEqual(mat(s.forkMarkers),expected.markers);assert.equal(payloadParse,0);assert(s.hasEntryUuid(ids[159]));
 assert.equal(s.stats.ownership.nativeRows,0);assert.equal(s.stats.ownership.nativeMapEntries,0);assert.equal(s.stats.ownership.inputIdentitySlots,0);
 assert(s.stats.maxSQLChunkBytes<=1024);assert(s.stats.maxParserWriteBytes<=512);assert.equal(s.stats.wholeJSONParses,0);
 assert.equal(f.store.db.pragma('journal_mode',{simple:true}),'delete');assert.equal(f.store.db.pragma('synchronous',{simple:true}),2);
 const metrics={...s.stats,heapLimit:v8.getHeapStatistics().heap_size_limit,peakHeapTotal,peakHeapUsed,fixtureBytes:f.stats(),peakConnections};
 fs.writeFileSync(path.join(evidence,'BOUNDS.json'),JSON.stringify(metrics,null,2)+'\n');s.release();assert.equal(f.store.builders,0);
});
process.on('exit',()=>{assert.equal(liveConnections,0);sample();fs.writeFileSync(path.join(evidence,'SOURCE-LIMITS.json'),JSON.stringify({
 heapLimit:v8.getHeapStatistics().heap_size_limit,peakHeapTotal,peakHeapUsed,peakFixtureBytes,peakConnections,liveConnections,allOwnedFixturesRemoved:true,
 sourceOnly:true,sqliteNativeMemoryBounded:false},null,2)+'\n');});
