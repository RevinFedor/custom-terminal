'use strict';
process.env.NOTED_HISTORY_READER_PROCESS='1';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),v8=require('node:v8');
const Adapter=require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const evidence=process.env.NOTED_TIMELINE_WORKING_EVIDENCE;
assert(evidence&&path.isAbsolute(evidence));fs.mkdirSync(evidence,{recursive:true});
assert(v8.getHeapStatistics().heap_size_limit<=128*1024**2);
class SQLite extends Adapter{constructor(file,options){super(file,options);this.name=file;}
 prepare(sql){
  // node:sqlite 22 truncates NUL in TEXT result strings. The installed
  // better-sqlite3 src/util/data.cpp uses sqlite3_column_bytes explicitly.
  // Adapt ONLY the unchanged finite Native-reference getter to that driver
  // contract; product capture still executes its own bounded BLOB queries.
  if(sql==='SELECT path, hash, error FROM tab_context_files WHERE tab_id=? ORDER BY path'){
   const statement=super.prepare('SELECT CAST(path AS BLOB) AS bytes,hash,error FROM tab_context_files WHERE tab_id=? ORDER BY path');
   return{all:(...args)=>statement.all(...args).map(row=>({path:Buffer.from(row.bytes).toString('utf8'),hash:row.hash,error:row.error}))};
  }return super.prepare(sql);
 }
 function(name,fn){this.native.function(name,fn);}}
const {HistoryPagedStore,materializeHistoryCursorSync:mat}=require('./history-paged-store');
const {TabWorkContext}=require('../../tab-work-context');
const {captureTimelineRootWorkingFiles:capture,readTimelineWorkingFileFreshness:read,sameTimelineWorkingFileWitness:same}=require('./timeline-root-working-files');
const {triggerDefinitions}=require('./timeline-working-file-version-schema');
test('actual working-file getter parity, scoped path freshness, frozen owners and capture cancellation',async t=>{
 const dir=fs.mkdtempSync(path.join(evidence,'working-')),file=path.join(dir,'context.sqlite'),db=new SQLite(file),foreign=new SQLite(file);
 db.pragma('journal_mode=WAL');const manager={db},native=new TabWorkContext({db,listTabs:()=>[]});
 const store=new HistoryPagedStore({filename:path.join(dir,'pages.sqlite'),Database:SQLite,diskBytes:16*1024**2}),roots=[];
 t.after(()=>{for(const r of roots)r.release();assert.equal(store.stats().leases,0);assert.equal(store.stats().activeBuilders,0);
  const bytes=fs.readdirSync(dir).reduce((n,p)=>n+fs.statSync(path.join(dir,p)).size,0);assert(bytes<32*1024**2);
  store.close();foreign.close();db.close();fs.rmSync(dir,{recursive:true});assert(!fs.existsSync(dir));});
 const insert=db.prepare('INSERT INTO tab_context_files(tab_id,path,content,hash,error) VALUES(?,?,?,?,?)');
 for(const p of ['src/work.ts','docs/plain.md','x'.repeat(4101)+'😀\r\n\0end'])insert.run('OWN',p,'authoring text never imported','hash',null);
 insert.run('OTHER','foreign/path','no read','hash',null);
 const expected=native.get('OWN',{}).files.map(({path})=>({path}));
 const options={store,manager,tabId:'OWN',readSourceWitness:()=> 'exact-frozen-source'};
 const first=await capture(options);roots.push(first);assert.deepEqual(mat(first.files),expected);
 assert.equal(first.metrics.maxSQLChunkBytes,1024);assert.equal(first.metrics.wholeFileArrays,0);
 const witness=read(db,'OWN');assert.equal(witness.mode,'scoped');
 foreign.exec('CREATE TABLE unrelated (value TEXT)');const afterDDL=read(db,'OWN');assert(!same(witness,afterDDL));
 const stable=read(db,'OWN');foreign.prepare('INSERT INTO unrelated VALUES(?)').run('Main UI save');assert(same(stable,read(db,'OWN')));
 foreign.prepare('UPDATE tab_context_files SET hash=? WHERE tab_id=?').run('new payload hash','OWN');assert(same(stable,read(db,'OWN')),'hash/content does not change working path markers');
 foreign.prepare('UPDATE tab_context_files SET path=? WHERE tab_id=? AND path=?').run('src/changed.ts','OWN','src/work.ts');
 assert(!same(stable,read(db,'OWN')),'direct foreign path update is covered without timestamp assumptions');
 assert.deepEqual(mat(first.files),expected,'old frozen path metadata stays exact');
 const next=await capture(options);roots.push(next);assert.deepEqual(mat(next.files),native.get('OWN',{}).files.map(({path})=>({path})));
 const held=next.fork();roots.push(held);next.release();assert.deepEqual(mat(held.files),native.get('OWN',{}).files.map(({path})=>({path})));
 const otherBefore=read(db,'OTHER'),ownBefore=read(db,'OWN');
 foreign.prepare('UPDATE tab_context_files SET tab_id=? WHERE tab_id=? AND path=?').run('OTHER','OWN','src/changed.ts');
 assert(!same(ownBefore,read(db,'OWN')));assert(!same(otherBefore,read(db,'OTHER')),'OLD and NEW scope covered');
 const beforeRollback=read(db,'OWN');db.exec('BEGIN');db.prepare('DELETE FROM tab_context_files WHERE tab_id=?').run('OWN');db.exec('ROLLBACK');
 assert(!same(beforeRollback,read(db,'OWN')),'local rollback cannot reuse a committed token');
 const leases=store.stats().leases;let checks=0;
 await assert.rejects(capture({...options,control:{assertCurrent(){if(++checks===4)throw Error('own demand revoked');},async checkpoint(){}}}),/own demand revoked/);
 assert.equal(store.stats().leases,leases);assert.equal(store.stats().activeBuilders,0);
 let changed=false;await assert.rejects(capture({...options,control:{assertCurrent(){},async checkpoint(){if(!changed){changed=true;foreign.prepare('INSERT INTO tab_context_files(tab_id,path) VALUES(?,?)').run('OWN','arrived-during-capture');}}}}),/CAPTURE_CHANGED/);
 assert.equal(store.stats().leases,leases);
 const ro=new SQLite(file,{readonly:true}),beforeSchema=ro.pragma('schema_version',{simple:true});
 try{const roResult=await capture({...options,manager:{db:ro}});assert.deepEqual(mat(roResult.files),native.get('OWN',{}).files.map(({path})=>({path})));roResult.release();assert.equal(ro.pragma('schema_version',{simple:true}),beforeSchema);}
 finally{ro.close();}
 const name=triggerDefinitions().keys().next().value;db.exec('DROP TRIGGER '+name);assert.equal(read(db,'OWN').mode,'database','unknown schema keeps conservative committed DB fence');
});
