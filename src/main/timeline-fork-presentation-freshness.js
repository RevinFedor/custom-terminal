'use strict';
const {TABLES,VERSION_TABLE,VERSION_DDL,normalize,triggerDefinitions}=require('./timeline-fork-presentation-version-schema');
const {historyFreshnessTriggerDefinitions}=require('./history-freshness-metadata');
const {SqliteStorageGraceStore}=require('./storage-retention-grace');
const cache=new WeakMap(),integer=n=>Number.isSafeInteger(n)&&n>=0;
function attested(db,schema,temp){
 const old=cache.get(db);if(old?.schema===schema&&old.temp===temp)return old.known;
 let known=false;
 try{
  const expected=new Map(TABLES.map(t=>[t.name,{type:'table',sql:normalize(t.ddl)}]));
  expected.set(VERSION_TABLE,{type:'table',sql:normalize(VERSION_DDL)});
  const owned=triggerDefinitions(),allowed=new Map(owned);
  const collect=sql=>{for(const m of sql.matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+)[\s\S]*?END;/g))allowed.set(m[1],m[0]);};
  // Fixed schema vocabulary only, capped at 64 columns. Never user membership.
  const definitions=historyFreshnessTriggerDefinitions({prepare(sql){
   if(!/^PRAGMA table_info\([a-z_]+\)$/.test(sql))throw Error('unknown schema request');
   return {all(){const rows=[];for(const row of db.prepare(sql).iterate()){if(rows.length===64)throw Error('schema cap');rows.push(row);}return rows;}};
  }});
  for(const sql of definitions.values())collect(sql);
  new SqliteStorageGraceStore({exec(sql){
   for(const m of sql.matchAll(/CREATE TRIGGER IF NOT EXISTS (storage_grace_lineage_(?:insert|update))[\s\S]*?END;/g))allowed.set(m[1],m[0]);
  },prepare(sql){return /^(?:PRAGMA table_info|SELECT 1 FROM sqlite_master)/.test(sql)?db.prepare(sql):{};},
  transaction(){return ()=>{throw Error('no schema writes');};}});
  for(const [name,sql] of owned)expected.set(name,{type:'trigger',sql:normalize(sql)});
  const read=db.prepare('SELECT type,substr(sql,1,16385) AS sql FROM main.sqlite_master WHERE name=?');
  for(const [name,spec] of expected){const r=read.get(name);
   if(!r||r.type!==spec.type||typeof r.sql!=='string'||r.sql.length>16384||normalize(r.sql)!==spec.sql)throw Error('unknown grammar');}
  const owners=[...TABLES.map(t=>t.name),VERSION_TABLE],marks=owners.map(()=>'?').join(',');let count=0;
  for(const r of db.prepare(`SELECT name,substr(sql,1,16385) AS sql FROM main.sqlite_master WHERE type='trigger' AND tbl_name IN (${marks}) LIMIT 21`).iterate(...owners)){
   if(++count>20||!allowed.has(r.name)||typeof r.sql!=='string'||r.sql.length>16384||normalize(r.sql)!==normalize(allowed.get(r.name)))throw Error('extra trigger');
  }
  if(db.prepare(`SELECT 1 FROM temp.sqlite_master WHERE name IN (${marks}) OR tbl_name IN (${marks}) LIMIT 1`).get(...owners,...owners))throw Error('temp shadow');
  known=true;
 }catch{/* Unknown/legacy/custom grammar retains full committed database fence. */}
 cache.set(db,{schema,temp,known});return known;
}
// One synchronous committed cut; no statement or transaction survives await.
function readTimelineForkPresentationFreshness(db){
 if(!db?.prepare||typeof db.transaction!=='function'||db.inTransaction!==false)return null;
 try{return db.transaction(()=>{
  if(db.inTransaction!==true)return null;
  const schemaVersion=db.prepare('PRAGMA main.schema_version').get()?.schema_version,
   tempSchemaVersion=db.prepare('PRAGMA temp.schema_version').get()?.schema_version,
   dataVersion=db.prepare('PRAGMA main.data_version').get()?.data_version,
   totalChanges=db.prepare('SELECT total_changes() AS n').get()?.n;
  if(![schemaVersion,tempSchemaVersion,dataVersion,totalChanges].every(integer))return null;
  const base={schemaVersion,tempSchemaVersion,dataVersion,totalChanges};
  if(!attested(db,schemaVersion,tempSchemaVersion))return Object.freeze({...base,mode:'database',version:null});
  const row=db.prepare('SELECT version FROM main.timeline_fork_presentation_version WHERE singleton=1').get(),version=row?row.version:0;
  if(!integer(version))return null;
  return Object.freeze({...base,mode:'scoped',version});
 })();}catch{return null;}
}
module.exports={readTimelineForkPresentationFreshness};
