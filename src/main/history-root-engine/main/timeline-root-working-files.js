'use strict';
const fs=require('node:fs');
const {StringDecoder}=require('node:string_decoder');
const {HistoryProjectionArena}=require('./history-projection-arena');
const text=require('./history-paged-text');
const {FILE_TABLE_DDL,VERSION_TABLE,VERSION_DDL,normalize,triggerDefinitions}=require('./timeline-working-file-version-schema');
const fail=code=>Object.assign(new Error(code),{code:'TIMELINE_WORKING_FILES_'+code});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const contracts=new WeakMap();
function attested(db,schema,temp){
 const cached=contracts.get(db);if(cached?.schema===schema&&cached.temp===temp)return cached.known;
 let known=false;try{
  const expected=new Map([['tab_context_files',{type:'table',sql:FILE_TABLE_DDL}],
   [VERSION_TABLE,{type:'table',sql:VERSION_DDL}],...Array.from(triggerDefinitions(),([name,sql])=>[name,{type:'trigger',sql}])]);
  for(const [name,spec]of expected){const row=db.prepare('SELECT type,substr(sql,1,8193) AS sql FROM main.sqlite_master WHERE name=?').get(name);
   if(row?.type!==spec.type||typeof row.sql!=='string'||row.sql.length>8192||normalize(row.sql)!==normalize(spec.sql))throw fail('DDL_UNKNOWN');}
  let count=0;for(const row of db.prepare("SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name IN ('tab_context_files','timeline_working_file_versions') LIMIT 4").iterate()){
   if(++count>3||!triggerDefinitions().has(row.name))throw fail('DDL_UNKNOWN');}
  if(count!==3||db.prepare("SELECT 1 AS present FROM temp.sqlite_master WHERE name IN ('tab_context_files','timeline_working_file_versions') OR tbl_name IN ('tab_context_files','timeline_working_file_versions') LIMIT 1").get())throw fail('DDL_UNKNOWN');
  known=true;
 }catch{}
 contracts.set(db,{schema,temp,known});return known;
}
function readTimelineWorkingFileFreshness(db,tabId){
 if(!db?.prepare||typeof db.transaction!=='function'||db.inTransaction!==false||typeof tabId!=='string'||!tabId)return null;
 try{return db.transaction(()=>{
  const schemaVersion=db.prepare('PRAGMA main.schema_version').get()?.schema_version,
   tempSchemaVersion=db.prepare('PRAGMA temp.schema_version').get()?.schema_version,
   dataVersion=db.prepare('PRAGMA main.data_version').get()?.data_version,
   totalChanges=db.prepare('SELECT total_changes() AS n').get()?.n;
  if(![schemaVersion,tempSchemaVersion,dataVersion,totalChanges].every(integer))return null;
  const base={schemaVersion,tempSchemaVersion,dataVersion,totalChanges};
  if(!attested(db,schemaVersion,tempSchemaVersion))return Object.freeze({...base,mode:'database',version:null});
  const row=db.prepare('SELECT version FROM main.timeline_working_file_versions WHERE tab_id=?').get(tabId),version=row?row.version:0;
  if(!integer(version))return null;return Object.freeze({...base,mode:'scoped',version});
 })();}catch{return null;}
}
function sameTimelineWorkingFileWitness(a,b){
 return !!a&&!!b&&Object.keys(a).every(k=>k==='dataVersion'&&a.mode==='scoped'&&b.mode==='scoped'||a[k]===b[k]);
}
async function captureTimelineRootWorkingFiles({store,manager,tabId,readSourceWitness,control}={}){
 const db=manager?.db;if(!store||store.closed||!db?.prepare||db===store.db||typeof db.name!=='string'||!db.name||db.name===':memory:'
  ||typeof tabId!=='string'||!tabId||typeof readSourceWitness!=='function')throw fail('CONFIGURATION');
 const dbPath=db.name,before=readTimelineWorkingFileFreshness(db,tabId),source=readSourceWitness(),physical=fs.statSync(dbPath,{bigint:true});
 if(!before||typeof source!=='string')throw fail('WITNESS_UNKNOWN');
 const check=()=>{control?.assertCurrent();const actual=fs.statSync(dbPath,{bigint:true});
  if(manager.db!==db||db.name!==dbPath||actual.dev!==physical.dev||actual.ino!==physical.ino
   ||readSourceWitness()!==source||!sameTimelineWorkingFileWitness(before,readTimelineWorkingFileFreshness(db,tabId)))throw fail('CAPTURE_CHANGED');};
 const checkpoint=async()=>{check();if(control?.checkpoint)await control.checkpoint();else await new Promise(resolve=>setImmediate(resolve));check();};
 const metrics={rows:0,sqlChunks:0,maxSQLChunkBytes:0,wholeFileArrays:0,sqlNativeMemoryBounded:false};
 let arena,lease,end,transferred=false;
 try{
  check();if(!db.prepare("SELECT 1 AS present FROM main.sqlite_master WHERE type='table' AND name='tab_context_files'").get())throw fail('SCHEMA_UNKNOWN');
  arena=new HistoryProjectionArena(store);end=store.beginBuild();arena.step(()=>{arena.state().workingFiles=arena.make('array');});
  // Close every SELECT before await. OFFSET retains native memory bounds;
  // wide linked-file catalogs may still require substantial SQL work.
  const next=db.prepare('SELECT rowid AS id,typeof(path) AS kind,length(CAST(path AS BLOB)) AS bytes FROM main.tab_context_files WHERE tab_id=? ORDER BY path LIMIT 1 OFFSET ?'),
   chunks=db.prepare('SELECT substr(CAST(path AS BLOB),?,1024) AS bytes FROM main.tab_context_files WHERE rowid=?');
  for(let n=0;;n++){
   check();const row=next.get(tabId,n);if(!row)break;
   if(row.kind!=='text'){await checkpoint();continue;}
   if(!Number.isSafeInteger(row.id)||!integer(row.bytes))throw fail('ROW_CHANGED');
   const writer=store.leafWriter(),decoder=new StringDecoder('utf8');
   for(let offset=1;offset<=row.bytes;){
    check();const part=chunks.get(offset,row.id)?.bytes;
    if(!ArrayBuffer.isView(part)||!part.byteLength||part.byteLength>1024)throw fail('ROW_CHANGED');
    store.transaction(()=>writer.write(decoder.write(part)));offset+=part.byteLength;
    metrics.sqlChunks++;metrics.maxSQLChunkBytes=Math.max(metrics.maxSQLChunkBytes,part.byteLength);await checkpoint();
   }
   let ref;store.transaction(()=>{writer.write(decoder.end());ref=writer.finish();});
   arena.step(()=>{arena.state().workingFiles.push({path:text.fromRef(arena,ref)});});metrics.rows++;await checkpoint();
  }
  check();lease=arena.step(()=>arena.publish());check();transferred=true;
  return wrap(lease);
 }finally{if(!transferred)lease?.release();arena?.close();end?.();}
 function wrap(root){let closed=false;return{root,captureWitness:before,metrics:Object.freeze({...metrics}),
  files:root.cursor().field('workingFiles'),tabId,assertCurrent:check,
  fork(){if(closed)throw fail('RELEASED');return wrap(root.fork());},release(){if(closed)return;closed=true;root.release();}};}
}
module.exports={captureTimelineRootWorkingFiles,readTimelineWorkingFileFreshness,sameTimelineWorkingFileWitness};
