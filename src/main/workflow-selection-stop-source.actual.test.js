// Derived from the verified Pro Source package; these controls read CURRENT.
// Process/PTY/publication ports are controlled; SQLite databases are :memory:.
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {SOURCE_COLUMNS,createSelectionStopSourceClock}=require('./workflow-selection-stop-source.js');
function fixture() {
 const sqlite=new DatabaseSync(':memory:');
 const columns=[...SOURCE_COLUMNS,'execution_storage_revision','context_pct','cache_stats','provider_state','external_run','claude_session_history','codex_model','codex_effort','future_metadata'];
 sqlite.exec('CREATE TABLE tabs('+columns.map(key=>'"'+key+'" '+(key==='id'?'INTEGER PRIMARY KEY':['execution_subject_version','execution_archived','execution_storage_revision'].includes(key)?'INTEGER':'TEXT')).join(',')+')');
 sqlite.exec("INSERT INTO tabs(id,tab_id,execution_subject_version,execution_subject_id,execution_namespace,execution_archived,execution_storage_revision,cwd,command_type,codex_session_id,tab_type) VALUES(7,'tab',2,'subject','namespace',0,4,'/cwd','codex','SID','terminal')");
 const revisionTrigger=fs.readFileSync(path.join(__dirname,'database.js'),'utf8').match(/CREATE TRIGGER workflow_tabs_revision AFTER UPDATE ON tabs[\s\S]*?END;/)?.[0];assert(revisionTrigger);sqlite.exec(revisionTrigger);
 const db={prepare:sql=>sqlite.prepare(sql),exec:sql=>sqlite.exec(sql),transaction:fn=>({immediate(){sqlite.exec('BEGIN IMMEDIATE');try{const result=fn();sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}})};
 const clock=createSelectionStopSourceClock(db),initial=clock.read('tab',7);
 return{sqlite,db,clock,initial};
}
test('clock starts at current schema installation and repeated initialization never resets it',()=>{
 const {sqlite,db,clock,initial}=fixture();sqlite.exec("UPDATE tabs SET codex_session_id='OTHER' WHERE id=7");
 const now=clock.read('tab',7);assert.equal(now.revision,initial.revision+1);assert.deepEqual(createSelectionStopSourceClock(db).read('tab',7),now);sqlite.close();
});
test('source SID prefix before capture does not poison later context/model/provider preferences',()=>{
 const {sqlite,clock}=fixture();sqlite.exec("UPDATE tabs SET codex_session_id='OTHER' WHERE id=7; UPDATE tabs SET codex_session_id='SID' WHERE id=7");const before=clock.read('tab',7);
 sqlite.exec("UPDATE tabs SET context_pct='12',cache_stats='small',codex_model='new',codex_effort='high',provider_state='new-settings',future_metadata='metadata' WHERE id=7");
 assert.deepEqual(clock.read('tab',7),before);assert(sqlite.prepare('SELECT execution_storage_revision FROM tabs WHERE id=7').get().execution_storage_revision>4);sqlite.close();
});
for(const column of SOURCE_COLUMNS.filter(key=>!['id','tab_id'].includes(key)))test('actual source clock detects '+column+' ABA',()=>{
 const {sqlite,clock,initial}=fixture();const before=sqlite.prepare('SELECT "'+column+'" AS value FROM tabs WHERE id=7').get().value;
 const different=['execution_subject_version','execution_archived'].includes(column)?99:'OTHER';
 sqlite.prepare('UPDATE tabs SET "'+column+'"=? WHERE id=7').run(different);sqlite.prepare('UPDATE tabs SET "'+column+'"=? WHERE id=7').run(before);
 const after=clock.read('tab',7);assert.equal(after.revision,initial.revision+2);assert.equal(after.epoch,initial.epoch);sqlite.close();
});
test('no-op source UPDATE statements do not advance source clock while native storage revision may advance',()=>{
 const {sqlite,clock,initial}=fixture();sqlite.exec("UPDATE tabs SET cwd='/cwd',codex_session_id='SID' WHERE id=7");assert.deepEqual(clock.read('tab',7),initial);sqlite.close();
});
test('delete/reinsert same tab, same source and reused storage id retains tombstone and advances twice',()=>{
 const {sqlite,clock,initial}=fixture();const row=sqlite.prepare('SELECT * FROM tabs WHERE id=7').get();sqlite.exec('DELETE FROM tabs WHERE id=7');
 assert.throws(()=>clock.read('tab',7),e=>e.code==='selection_stop_source_clock_unknown');
 const columns=Object.keys(row);sqlite.prepare('INSERT INTO tabs('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').run(...columns.map(key=>row[key]));
 assert.equal(clock.read('tab',7).revision,initial.revision+2);sqlite.close();
});
test('tab rename advances both old and new clocks; A to B to A cannot reuse old proof',()=>{
 const {sqlite,clock,initial}=fixture();sqlite.exec("UPDATE tabs SET tab_id='other' WHERE id=7");assert.throws(()=>clock.read('tab',7));assert.equal(clock.read('other',7).revision,1);
 sqlite.exec("UPDATE tabs SET tab_id='tab' WHERE id=7");assert.equal(clock.read('tab',7).revision,initial.revision+2);assert.throws(()=>clock.read('other',7));sqlite.close();
});
test('storage id ABA advances clock even with exact subject and SID restored',()=>{
 const {sqlite,clock,initial}=fixture();sqlite.exec('UPDATE tabs SET id=8 WHERE id=7; UPDATE tabs SET id=7 WHERE id=8');assert.equal(clock.read('tab',7).revision,initial.revision+2);sqlite.close();
});
test('future schema, changed epoch, missing/modified trigger, and missing row fail closed without repair/reset',()=>{
 for(const sql of ['UPDATE workflow_selection_stop_source_meta SET version=2',"UPDATE workflow_selection_stop_source_meta SET epoch='other'",'DROP TRIGGER workflow_selection_stop_source_update',"DELETE FROM workflow_selection_stop_source_clocks WHERE tab_id='tab'"]){
  const {sqlite,db,clock}=fixture();sqlite.exec(sql);assert.throws(()=>clock.read('tab',7));
  if(!sql.includes('epoch'))assert.throws(()=>createSelectionStopSourceClock(db).read('tab',7));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_selection_stop_source_meta').get().n,1);sqlite.close();
 }
});
test('clock overflow aborts the source writer atomically without wraparound or silent proof',()=>{
 const {sqlite,clock}=fixture();sqlite.prepare("UPDATE workflow_selection_stop_source_clocks SET revision=? WHERE tab_id='tab'").run(Number.MAX_SAFE_INTEGER);
 assert.throws(()=>sqlite.exec("UPDATE tabs SET cwd='/new' WHERE id=7"),/selection_stop_source_clock_exhausted/);
 assert.equal(sqlite.prepare('SELECT cwd FROM tabs WHERE id=7').get().cwd,'/cwd');assert.equal(clock.read('tab',7).revision,Number.MAX_SAFE_INTEGER);sqlite.close();
});
test('initialization failure is bounded unavailable; it does not throw app construction',()=>{
 const clock=createSelectionStopSourceClock({prepare(){throw Object.assign(Error('synthetic failure'),{code:'SQLITE_IOERR'});}});
 assert.throws(()=>clock.read('tab',7),e=>e.code==='selection_stop_source_unavailable');
});
