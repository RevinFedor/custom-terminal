'use strict';

// One finite SOURCE process. Run directly (node:test does not spawn a runner):
// node --max-old-space-size=80 --max-semi-space-size=4 --expose-gc <this file>
// NOTED_ANNOTATIONS_EVIDENCE points to the explicitly owned evidence directory.
// node:sqlite substitutes only the incompatible Electron native ABI. The
// production DatabaseManager prototype/getters and paged implementation run.
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),v8=require('node:v8');
const { DatabaseSync }=require('node:sqlite');
const evidence=process.env.NOTED_ANNOTATIONS_EVIDENCE;
assert(evidence && path.isAbsolute(evidence),'explicit owned evidence directory required');
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2,'TOTAL one-process V8 heap limit <=128MiB');
fs.mkdirSync(evidence,{recursive:true});
let liveConnections=0,peakConnections=0,peakFixtureBytes=0,peakHeapTotal=0,peakHeapUsed=0;
function sample() {
  const m=process.memoryUsage();peakHeapTotal=Math.max(peakHeapTotal,m.heapTotal);peakHeapUsed=Math.max(peakHeapUsed,m.heapUsed);
  assert(m.heapTotal<=128*1024**2);assert(liveConnections<=2);
}
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
    const getter=sql.match(/^\s*SELECT (\*|entry_uuid, content, position|entry_uuid) FROM (timeline_[a-z_]+)([\s\S]*)$/);
    let columns=null;
    if(getter) {
      columns=getter[1]==='*'?this.native.prepare('PRAGMA table_info('+getter[2]+')').all().map(r=>r.name):getter[1].split(',').map(s=>s.trim());
      sql='SELECT '+columns.flatMap(c=>['CASE WHEN typeof('+c+")='text' THEN CAST("+c+' AS BLOB) ELSE '+c+' END AS '+c,
        'typeof('+c+') AS __source_kind_'+c]).join(',')+' FROM '+getter[2]+getter[3];
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
const NativeDB=require('../../database');
const RootDB=require('./database');
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {HistoryProjectionArena}=require('./history-projection-arena');
const {captureTimelineRootAnnotations:capture}=require('./timeline-root-annotations');
const names=['timeline_notes','timeline_rewind_markers','timeline_prompt_summaries','timeline_outlines','timeline_turn_action_overrides'];
const methods=['getTimelineNotes','getRewindMarkers','getTimelinePromptSummaries','getTimelineOutline','getTimelineTurnActionOverrides'];
const nativeSource=fs.readFileSync(path.resolve(__dirname,'../../database.js'),'utf8');
let semanticsPassed=0;

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(evidence,'fixture-')),file=path.join(dir,'annotations.sqlite');
  const db=new SQLite(file);db.pragma('journal_mode=WAL');db.pragma('max_page_count=2048');
  for(const name of names) {
    const ddl=nativeSource.match(new RegExp('CREATE TABLE IF NOT EXISTS '+name+' \\([\\s\\S]*?\\n\\s+\\)'))?.[0];
    assert(ddl,'actual Main schema for '+name);db.exec(ddl);
  }
  require('./timeline-annotation-version-schema').installTimelineAnnotationVersionSchema(db);
  // Actual getter sort plans, including timestamp ties.
  db.exec('CREATE INDEX idx_timeline_prompt_summaries_session ON timeline_prompt_summaries(tool_type,session_id);'+
    'CREATE INDEX idx_timeline_prompt_summaries_updated ON timeline_prompt_summaries(updated_at DESC);'+
    'CREATE INDEX idx_timeline_turn_action_overrides_session ON timeline_turn_action_overrides(tool_type,session_id);');
  const manager=Object.create(NativeDB.prototype);manager.db=db;
  const rootManager=Object.create(RootDB.prototype);rootManager.db=db;
  const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:48*1024**2});
  // Foreign commits through the other supplied fixture connection, not a
  // third native connection, worker, app, profile or product database.
  store.db.prepare('ATTACH DATABASE ? AS annotation').run(file);
  let source='physical-codex-source:1';
  const stats=()=>{
    let bytes=0;for(const name of fs.readdirSync(dir)){const st=fs.lstatSync(path.join(dir,name));assert(!st.isSymbolicLink());bytes+=st.size;}
    peakFixtureBytes=Math.max(peakFixtureBytes,bytes);assert(bytes<=64*1024**2,'finite fixture TOTAL <=64MiB');sample();return bytes;
  };
  t.after(()=>{stats();store.close();db.close();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir));global.gc?.();});
  const insert=(table,values)=>{
    const keys=Object.keys(values);db.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...Object.values(values));
  };
  const captureOptions=()=>({store,manager,sessionId:'physical',readSourceWitness:()=>source,
    cooperate:async()=>{stats();await new Promise(resolve=>setImmediate(resolve));}});
  const native=m=>({notes:m.getTimelineNotes('physical'),rewindMarkers:m.getRewindMarkers('physical'),
    promptSummaries:m.getTimelinePromptSummaries('codex','physical'),outline:m.getTimelineOutline('codex','physical'),
    turnActionOverrides:m.getTimelineTurnActionOverrides('codex','physical')});
  const pins=()=>store.db.prepare('SELECT count(*) n FROM hp_pins').get().n;
  return {dir,file,db,store,manager,rootManager,insert,stats,native,pins,captureOptions,setSource:v=>{source=v;},
    foreign:sql=>store.db.exec(sql.replace(/\b(timeline_[a-z_]+)\b/g,'annotation.$1'))};
}
const plain=s=>({notes:mat(s.notes),rewindMarkers:mat(s.rewindMarkers),promptSummaries:mat(s.promptSummaries),
  outline:mat(s.outline),turnActionOverrides:mat(s.turnActionOverrides)});
function eligible(store,ids) {
  const arena=new HistoryProjectionArena(store);
  try{return arena.step(()=>{arena.state().ids=arena.own(ids);return arena.publish(arena.state().ids);});}finally{arena.close();}
}
function seed(f) {
  const insert=f.insert;
  for(const [uuid,stamp] of [['z',7],['a',9],['middle',9],['',3]]) {
    insert('timeline_notes',{entry_uuid:uuid,session_id:'physical',tab_id:'not-a-scope',content:'note '+uuid+'\0Ω\r\n😀',position:uuid==='z'?null:'after'});
    insert('timeline_rewind_markers',{entry_uuid:uuid,session_id:'physical'});
    insert('timeline_prompt_summaries',{tool_type:'codex',session_id:'physical',entry_uuid:uuid,
      summary:uuid==='middle'?'':'summary '+uuid,source_hash:'',model:null,prompt_id:'',thinking_level:null,prompt_tokens:0,candidate_tokens:-2,updated_at:stamp});
    insert('timeline_turn_action_overrides',{tool_type:'codex',session_id:'physical',entry_uuid:uuid,action_label:' action '+uuid+'。 ',source_hash:'',model:'',updated_at:stamp});
  }
  insert('timeline_notes',{entry_uuid:'foreign',session_id:'ancestor',tab_id:'not-a-scope',content:'exclude'});
  for(const tool of ['claude','codex']) {
    insert('timeline_prompt_summaries',{tool_type:tool,session_id:tool==='codex'?'ancestor':'physical',entry_uuid:'foreign',summary:'exclude'});
  }
  insert('timeline_outlines',{tool_type:'codex',session_id:'physical',source_hash:'hash',source_uuids_json:'["a","a","z","__proto__","😀",null,0]',
    source_entry_count:91,source_last_uuid:'',outline_json:'{"schemaVersion":2,"groups":[],"turns":[{"uuid":"a","description":"Ω"}],"__proto__":{"owned":true}}',
    model:'',schema_version:0,prompt_tokens:null,thought_tokens:-5,source_chars:123,updated_at:0});
}

module.exports = { SQLite, NativeDB, RootDB, fixture, seed, plain, capture, mat, evidence, sample };
if (require.main === module) {
test('actual Main getter parity, physical scope, order, fields, empty/undefined, lookup and membership',async t=>{
  const f=fixture(t);seed(f);
  const expected=f.native(f.manager);assert.deepEqual(f.native(f.rootManager),expected,'Source mirror matches actual Main getters');
  const before=f.pins(),s=await capture(f.captureOptions());
  assert.deepEqual(plain(s),expected);
  assert.deepEqual(expected.promptSummaries.map(r=>r.entryUuid),['a','middle','z','']);
  assert.deepEqual(mat(s.lookupNote('z')),expected.notes.find(r=>r.entry_uuid==='z'));
  assert.deepEqual(mat(s.lookupSummary('a')),expected.promptSummaries[0]);
  assert.deepEqual(mat(s.lookupTurnActionOverride('middle')),expected.turnActionOverrides[1]);
  assert.equal(s.lookupNote('missing'),undefined);assert.equal(s.lookupSummary('foreign'),undefined);
  assert.equal(s.hasRewindMarker('a'),true);assert.equal(s.hasRewindMarker('foreign'),false);
  assert.equal(s.hasSummary('a'),true);assert.equal(s.hasSummary('middle'),false);assert.equal(s.hasSummary(''),false);
  assert.equal(s.summaryCount,2);assert.equal(s.promptSummaryCount,4);assert.equal(s.noteCount,4);
  assert.equal(s.rewindMarkerCount,4);assert.equal(s.turnActionOverrideCount,4);
  assert.equal(s.lookupSummary('a').field('not-a-field').scalar(),undefined);
  assert.equal(s.outlineSourceCount,7);assert.equal(mat(s.outline).sourceEntryCount,91);
  assert.equal(s.outlineSourceUniqueCount,6);
  assert.equal(s.hasOutlineSource('a'),true);assert.equal(s.hasOutlineSource('missing'),false);
  assert.equal(s.hasOutlineSource('__proto__'),true);assert.equal(s.hasOutlineSource(null),true);
  const ids=eligible(f.store,['a','new','new','😀']);assert.equal(await s.countOutlineNew(ids.cursor()),2);
  assert.equal(await s.countSummaries(ids.cursor()),1);ids.release();
  const manyIds=eligible(f.store,Array.from({length:65},(_,i)=>i%2?'a':'new'));
  const countPins=f.pins();let countCancelled=false;
  await assert.rejects(s.countSummaries(manyIds.cursor(),{control:{assertCurrent(){if(countCancelled)throw Error('count-cancel');}},
    cooperate:async()=>{countCancelled=true;}}),/count-cancel/);
  assert(countCancelled);assert.equal(f.pins(),countPins);manyIds.release();
  assert(Object.isFrozen(s)&&Object.isFrozen(s.captureWitness)&&Object.isFrozen(s.stats));
  assert.equal(s.stats.forkMetadataScope,'none');assert.equal(s.captureWitness.sourceRevision,'physical-codex-source:1');
  assert.equal(s.root.cursor().field('notes').length,4);
  s.release();s.release();assert.equal(f.pins(),before);assert.equal(f.store.builders,0);
  assert.throws(()=>s.lookupSummary('a'));assert.throws(()=>s.notes.at(0).field('content').kind);
  semanticsPassed++;
});

test('all JSON content, UTF16 escapes, duplicate/special keys, numeric semantics and native malformed legacy cases',async t=>{
  const f=fixture(t);seed(f);
  const special='{"2":"integer key","__proto__":{"x":1},"constructor":3,"toString":4,"duplicate":1,"duplicate":2,'+
    '"unicode":"Ω😀\\ud800\\udfff\\u0000\\n","number":-0,"huge":1e999,"tiny":1e-999,"array":[true,null,false,{},[]]}';
  const wide={};for(let i=0;i<96;i++)wide['key'+i]={text:'full '+i+'😀'.repeat(5),child:[i,false,null]};
  const cases=[special,JSON.stringify(wide),'['.repeat(96)+'"deep"'+']'.repeat(96),
    '"'+'😀Ω full text \\n'.repeat(700)+'"','null','false','17','""','[]','{}','{"bad":','undefined','[1,]','\u00a0{}',
    Buffer.from('{"buffer":true}')];
  for(const body of cases) {
    f.db.prepare('UPDATE timeline_outlines SET outline_json=?').run(body);
    const expected=f.native(f.manager).outline,s=await capture({...f.captureOptions(),chunkBytes:64});
    assert.deepEqual(mat(s.outline),expected,'native JSON.parse parity');s.release();
  }
  for(const sources of ['','null','false','{}','17','["a",0,null,false,"\\ud800"]','broken']) {
    f.db.prepare('UPDATE timeline_outlines SET source_uuids_json=?,outline_json=?').run(sources,'{}');
    const s=await capture(f.captureOptions());assert.deepEqual(mat(s.outline),f.native(f.manager).outline);
    assert.equal(s.outlineSourceCount,Array.isArray(mat(s.outline)?.sourceUuids)?mat(s.outline).sourceUuids.length:null);s.release();
  }
  // Actual getters differ on coercion: summaries retain SQL text token
  // metadata, overrides/outline apply Number(). Long numeric text must stay
  // paged throughout that conversion as well.
  const numericText='0'.repeat(1800)+'42';
  f.db.prepare('UPDATE timeline_prompt_summaries SET prompt_tokens=?,updated_at=?').run(numericText+'x','not-a-number');
  f.db.prepare('UPDATE timeline_turn_action_overrides SET updated_at=?').run(' '.repeat(1800)+'42x');
  f.db.prepare('UPDATE timeline_outlines SET outline_json=?,source_uuids_json=?,source_chars=?,source_entry_count=?')
    .run('{}','[]',' '.repeat(1800)+'42x',numericText);
  const converted=await capture(f.captureOptions());assert.deepEqual(plain(converted),f.native(f.manager));converted.release();
  const longUuid='longΩ😀'.repeat(1100);
  f.insert('timeline_notes',{entry_uuid:longUuid,session_id:'physical',tab_id:'x',content:'FULL\0'+longUuid,position:'odd-legacy'});
  const s=await capture({...f.captureOptions(),chunkBytes:4096});assert.equal(mat(s.lookupNote(longUuid)).content,'FULL\0'+longUuid);
  assert.equal(s.stats.maxSQLChunkBytes,4096);
  assert.deepEqual(plain(s),f.native(f.manager));s.release();
  semanticsPassed++;
});

test('independent frozen roots survive same-timestamp update/insert/delete and release of another capture',async t=>{
  const f=fixture(t);seed(f);const a=await capture(f.captureOptions()),old=plain(a),fork=a.fork();
  f.db.exec("UPDATE timeline_notes SET content='new' WHERE entry_uuid='a'; DELETE FROM timeline_rewind_markers WHERE entry_uuid='a';"+
    "UPDATE timeline_prompt_summaries SET summary='new same timestamp' WHERE entry_uuid='a';"+
    "UPDATE timeline_outlines SET outline_json='{\"new\":true}';"+
    "DELETE FROM timeline_turn_action_overrides WHERE entry_uuid='z'");
  f.insert('timeline_notes',{entry_uuid:'added',session_id:'physical',tab_id:'x',content:'added'});
  const b=await capture(f.captureOptions());assert.deepEqual(plain(b),f.native(f.manager));assert.notDeepEqual(plain(b),old);
  assert.notEqual(b.revision,a.revision);assert.deepEqual(plain(a),old);a.release();
  assert.deepEqual(plain(fork),old);assert.equal(mat(fork.lookupNote('a')).content,old.notes.find(r=>r.entry_uuid==='a').content);
  b.release();assert.deepEqual(plain(fork),old);fork.release();
  semanticsPassed++;
});

test('guarded boundaries refuse source, DB, connection, foreign commit, local rollback, schema and cancel; no retries/pin leaks',async t=>{
  const f=fixture(t);seed(f);
  const mutations=[
    ()=>f.setSource('physical-codex-source:2'),
    ()=>{f.manager.db={...f.db};},
    ()=>f.foreign("UPDATE timeline_notes SET content='foreign same timestamp' WHERE entry_uuid='a'"),
    ()=>{try{f.db.transaction(()=>{f.db.exec("UPDATE timeline_notes SET content='rollback'");throw Error('rollback');})();}catch{}},
    ()=>f.foreign('ALTER TABLE timeline_notes ADD COLUMN unexpected TEXT'),
  ];
  for(let i=0;i<mutations.length;i++) {
    const pins=f.pins();let calls=0;
    await assert.rejects(capture({...f.captureOptions(),cooperate:async()=>{if(++calls===1)mutations[i]();}}),
      e=>/^TIMELINE_ANNOTATIONS_(CAPTURE_CHANGED|CONNECTION_CHANGED)$/.test(e.code));
    assert.equal(calls,1,'no retry');assert.equal(f.pins(),pins);assert.equal(f.store.builders,0);
    f.manager.db=f.db;f.setSource('physical-codex-source:1');
  }
  // Restore only our fixture schema for subsequent refusal cases.
  assert(f.db.prepare('PRAGMA table_info(timeline_notes)').all().some(row=>row.name==='unexpected'));
  f.db.exec('ALTER TABLE timeline_notes DROP COLUMN unexpected');
  let cancelled=false,calls=0;const pins=f.pins();
  await assert.rejects(capture({...f.captureOptions(),control:{assertCurrent(){if(cancelled)throw Object.assign(Error('cancel'),{code:'OWN_CANCEL'});}},
    cooperate:async()=>{calls++;cancelled=true;}}),{code:'OWN_CANCEL'});
  assert.equal(calls,1);assert.equal(f.pins(),pins);assert.equal(f.store.builders,0);
  // Parser-active cancellation must release its own build guard as well as
  // the capture guard. First-chunk cancellation alone cannot prove this seam.
  let parserCancelled=false;
  await assert.rejects(capture({...f.captureOptions(),control:{assertCurrent(){if(parserCancelled)throw Object.assign(Error('parser cancel'),{code:'OWN_PARSER_CANCEL'});}},
    cooperate:async()=>{if(f.store.builders===2)parserCancelled=true;}}),{code:'OWN_PARSER_CANCEL'});
  assert(parserCancelled);assert.equal(f.store.builders,0);assert.equal(f.pins(),pins);
  f.db.exec('BEGIN');await assert.rejects(capture(f.captureOptions()),{code:'TIMELINE_ANNOTATIONS_CONNECTION_CHANGED'});f.db.exec('ROLLBACK');
  const renamed=f.file+'.original';let moved=false;
  try {
    await assert.rejects(capture({...f.captureOptions(),cooperate:async()=>{if(!moved){fs.renameSync(f.file,renamed);fs.writeFileSync(f.file,'replacement');moved=true;}}}),
      {code:'TIMELINE_ANNOTATIONS_CAPTURE_CHANGED'});
  } finally {if(moved){fs.unlinkSync(f.file);fs.renameSync(renamed,f.file);}}
  assert.equal(f.pins(),pins);
  semanticsPassed++;
});

test('missing/unknown schema never means empty; known empty tables are exact; product capture never calls getters/.all/JSON.parse on payload',async t=>{
  const f=fixture(t);
  const empty=await capture(f.captureOptions());assert.deepEqual(plain(empty),f.native(f.manager));empty.release();
  for(const chunkBytes of [0,63,4097])await assert.rejects(capture({...f.captureOptions(),chunkBytes}),{code:'TIMELINE_ANNOTATIONS_CONFIGURATION'});
  await assert.rejects(capture({...f.captureOptions(),readSourceWitness:()=>null}),{code:'TIMELINE_ANNOTATIONS_SOURCE_WITNESS_REQUIRED'});
  await assert.rejects(capture({...f.captureOptions(),manager:{db:f.store.db}}),{code:'TIMELINE_ANNOTATIONS_READ_CONNECTION_REQUIRED'});
  seed(f);
  const expected=f.native(f.manager);
  for(const method of methods)f.manager[method]=()=>{throw Error('native getter forbidden on product capture');};
  const prepare=f.db.prepare.bind(f.db);let reads=0;
  f.db.prepare=sql=>{
    assert(/^(SELECT|PRAGMA)/.test(sql),'no writes to userDB');assert(!/MAX\s*\(/i.test(sql),'not timestamp freshness');
    const statement=prepare(sql);reads++;
    return new Proxy(statement,{get(target,key){if(key==='all')return ()=>{throw Error('.all forbidden');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  };
  const s=await capture(f.captureOptions());assert.deepEqual(plain(s),expected);assert(reads>0);s.release();f.db.prepare=prepare;
  f.db.exec('DROP TABLE timeline_outlines');await assert.rejects(capture(f.captureOptions()),{code:'TIMELINE_ANNOTATIONS_SCHEMA_UNKNOWN'});
  assert.equal(f.pins(),0);assert.equal(f.store.builders,0);
  const ddl=nativeSource.match(/CREATE TABLE IF NOT EXISTS timeline_outlines \([\s\S]*?\n\s+\)/)[0];f.db.exec(ddl);
  f.db.exec('ALTER TABLE timeline_outlines ADD COLUMN unknown TEXT');
  await assert.rejects(capture(f.captureOptions()),{code:'TIMELINE_ANNOTATIONS_SCHEMA_UNKNOWN'});
  semanticsPassed++;
});

if (!process.env.NOTED_ANNOTATIONS_SKIP_BOUNDS) test('bounds AFTER semantics: finite paged corpus, no native ID graph, chunk caps, DELETE/FULL/quota and cleanup',async t=>{
  assert.equal(semanticsPassed,5,'all content/frozen/mutation/refusal tests pass before bounds');
  const f=fixture(t);
  const body='full Ω😀\0\r\n'.repeat(160);
  for(let i=0;i<40;i++)f.insert('timeline_notes',{entry_uuid:'id-'+i,session_id:'physical',tab_id:'owned',content:body});
  const json={};for(let i=0;i<128;i++)json['key'+i]=[i,body.slice(0,48),'\\ud800'];
  f.insert('timeline_outlines',{tool_type:'codex',session_id:'physical',source_hash:'hash',outline_json:JSON.stringify(json),
    source_uuids_json:JSON.stringify(Array.from({length:40},(_,i)=>'id-'+i))});
  let payloadParses=0;const parse=JSON.parse,payload=JSON.stringify(json);
  JSON.parse=function(value,...args){if(typeof value==='string'&&value===payload)payloadParses++;return parse(value,...args);};
  let s;try{s=await capture(f.captureOptions());}finally{JSON.parse=parse;}
  assert.deepEqual(plain(s),f.native(f.manager));assert.equal(payloadParses,0);
  assert(s.stats.sqlChunks>40);assert(s.stats.parserWrites>0);
  assert(s.stats.maxSQLChunkBytes<=1024);assert(s.stats.maxParserWriteBytes<=512);
  assert.equal(s.stats.ownership.nativeRows,0);assert.equal(s.stats.ownership.nativeMapEntries,0);
  assert.equal(s.stats.ownership.inputIdentitySlots,0);assert(s.stats.ownership.handleCache<=3);
  assert.equal(s.stats.arena.unboundedTextMaterializations||0,0);assert.equal(s.stats.sqlNativeMemoryBounded,false);
  assert.equal(f.store.db.pragma('journal_mode',{simple:true}),'delete');assert.equal(f.store.db.pragma('synchronous',{simple:true}),2);
  assert.equal(f.store.diskBudget,48*1024**2);assert(f.store.diskUsage()<=f.store.diskBudget);
  const metrics={...s.stats,heapLimit:v8.getHeapStatistics().heap_size_limit,peakHeapTotal,peakHeapUsed,peakFixtureBytes:f.stats(),peakConnections};
  fs.writeFileSync(path.join(evidence,'BOUNDS.json'),JSON.stringify(metrics,null,2)+'\n');
  s.release();assert.equal(f.pins(),0);assert.equal(f.store.builders,0);
});
}

process.on('exit',()=>{
  assert.equal(liveConnections,0);sample();
  fs.writeFileSync(path.join(evidence,'SOURCE-LIMITS.json'),JSON.stringify({heapLimit:v8.getHeapStatistics().heap_size_limit,
    peakHeapTotal,peakHeapUsed,peakFixtureBytes,peakConnections,liveConnections,sourceOnly:true,sqliteNativeMemoryBounded:false},null,2)+'\n');
});
