'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Sqlite=process.versions.electron?require('better-sqlite3'):require('./project-prompt-sqlite.test-support.cjs').NodeSqliteAdapter;
const {WorkflowRootRegistry}=require('./workflow-root-registry');
const {sameFence}=require('./prompt-catalog-preparation');
function fixture(t){
 const db=new Sqlite(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,project_id TEXT,execution_namespace TEXT,name TEXT);
 CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,icon TEXT);
 CREATE TABLE workflow_org_meta(singleton INTEGER PRIMARY KEY,schema_version INTEGER);
 INSERT INTO workflow_org_meta VALUES(1,1);
 CREATE TABLE workflow_org_tabs(tab_id TEXT PRIMARY KEY,execution_json TEXT,record_json TEXT);
 CREATE TABLE workflow_org_memberships(tab_id TEXT PRIMARY KEY,workflow_id TEXT,revision INTEGER);
 CREATE TABLE workflow_org_workflows(workflow_id TEXT PRIMARY KEY,metadata_json TEXT,deleted_generation INTEGER,layout_json TEXT);
 CREATE TABLE project_prompt_sources(project_id TEXT,root_path TEXT);
 CREATE TABLE history_noise(value TEXT);
 INSERT INTO tabs VALUES('T','P','P','Tab');INSERT INTO projects VALUES('P','Project','/own',NULL);
 INSERT INTO workflow_org_tabs VALUES('T','{"executionNamespace":"P"}','{}');
 INSERT INTO workflow_org_workflows VALUES('W','{"defaultCwd":"/own"}',NULL,'{}');
 INSERT INTO workflow_org_memberships VALUES('T','W',1);`);
 const registry=new WorkflowRootRegistry({db});assert.equal(registry.prepareCatalogReadEpoch(),true);
 const fence=()=>registry.captureCatalogFence();assert.equal(fence().authoritySource,'catalog-read-epoch-v2');
 return{db,registry,fence};
}
test('unrelated History/record/layout writes keep the exact source epoch, all source reads remain fresh',t=>{
 const f=fixture(t),before=f.fence();
 f.db.prepare('INSERT INTO history_noise VALUES(?)').run('own');f.db.prepare('UPDATE tabs SET name=?').run('Renamed');
 f.db.prepare('UPDATE workflow_org_tabs SET record_json=?').run('{"busy":true}');
 f.db.prepare('UPDATE workflow_org_workflows SET layout_json=?').run('{"panes":[]}');
 f.db.prepare('UPDATE workflow_org_tabs SET execution_json=?').run('{"model":"new","executionNamespace":"P"}');
 assert.ok(sameFence(before,f.fence()));assert.equal(f.registry.sourcesForTab('T')[0].rootPath,'/own');
});
test('every actual source input invalidates the epoch, including direct writes without notifications',t=>{
 const f=fixture(t);const writes=[
  ()=>f.db.prepare('UPDATE tabs SET execution_namespace=?').run('Q'),
  ()=>f.db.prepare('UPDATE projects SET name=?').run('Q'),
  ()=>f.db.prepare('UPDATE workflow_org_tabs SET execution_json=?').run('{"projectId":"Q"}'),
  ()=>f.db.prepare('UPDATE workflow_org_memberships SET workflow_id=?').run('other'),
  ()=>f.db.prepare('UPDATE workflow_org_workflows SET metadata_json=?').run('{"promptDirectories":[]}'),
  ()=>f.db.prepare('UPDATE workflow_org_workflows SET deleted_generation=2').run(),
  ()=>f.db.prepare('INSERT INTO workflow_root_scope_meta VALUES(?,1,1)').run('tab:T'),
  ()=>f.db.prepare('INSERT INTO workflow_roots VALUES(?,?,?,1,0)').run('R','/own','{}'),
  ()=>f.db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,0,?)').run('tab:T','R','{}'),
  ()=>f.db.prepare('INSERT INTO project_prompt_sources VALUES(?,?)').run('P','/own'),
  ()=>f.db.prepare('DELETE FROM project_prompt_sources').run(),
 ];
 for(const write of writes){const before=f.fence(),result=write();if(typeof result?.changes==='number')assert.equal(result.changes,1,'trigger does not change the caller row-count receipt');const after=f.fence();assert.ok(after.changes>before.changes);assert.ok(!sameFence(before,after));}
});
test('rolled back source writes cannot produce committed change or weaken transaction guards',t=>{
 const f=fixture(t),before=f.fence();
 assert.throws(()=>f.db.transaction(()=>{f.db.prepare('UPDATE projects SET name=?').run('uncommitted');assert.equal(f.fence().transaction,true);throw Error('rollback');})(),/rollback/);
 assert.ok(sameFence(before,f.fence()));assert.equal(f.db.prepare('SELECT name FROM projects').get().name,'Project');
});
test('malformed execution JSON is tracked without rejecting its write or inventing a valid namespace',t=>{
 const f=fixture(t),before=f.fence();f.db.prepare('UPDATE workflow_org_tabs SET execution_json=?').run('{malformed');
 assert.ok(f.fence().changes>before.changes);assert.throws(()=>f.registry.sourcesForTab('T'));
});
test('missing epoch receipt stays missing; reads and initialization do not reset it into fresh authority',t=>{
 const f=fixture(t);f.db.prepare('DELETE FROM noted_prompt_catalog_read_epoch').run();
 assert.equal(f.fence().authoritySource,'sqlite-total-changes');assert.equal(f.registry.prepareCatalogReadEpoch(),false);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM noted_prompt_catalog_read_epoch').get().n,0);
 assert.equal(f.registry.sourcesForTab('T')[0].rootPath,'/own');
});
test('unknown trigger loses only acceleration, never silently repaired by a read',t=>{
 const f=fixture(t);f.db.exec(`DROP TRIGGER noted_catalog_epoch_tabs_update;
 CREATE TRIGGER noted_catalog_epoch_tabs_update AFTER UPDATE ON tabs BEGIN SELECT 1; END;`);
 assert.equal(f.fence().authoritySource,'sqlite-total-changes');assert.equal(f.registry.prepareCatalogReadEpoch(),false);
 assert.ok(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='noted_catalog_epoch_tabs_update'").get().sql.includes('SELECT 1'));
});
test('unrelated DDL is readonly recertified; connection replacement uses conservative fresh fences',t=>{
 const f=fixture(t),before=f.fence();f.db.exec('CREATE TABLE unrelated_extra(value INTEGER)');const changes=f.db.prepare('SELECT total_changes() n').get().n,after=f.fence();
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes,'schema re-certification is read-only');
 assert.equal(after.authoritySource,'catalog-read-epoch-v2');assert.notEqual(after.schema,before.schema);
 const other=new Sqlite(':memory:');t.after(()=>other.close());other.exec('CREATE TABLE workflow_root_meta(singleton INTEGER,version INTEGER);INSERT INTO workflow_root_meta VALUES(1,1)');
 f.registry.database.db=other;assert.equal(f.fence().authoritySource,'sqlite-total-changes');
});
test('future derived proof version remains untouched and falls back to complete SQL reads',t=>{
 const f=fixture(t);f.db.prepare('UPDATE noted_prompt_catalog_read_epoch SET version=99').run();
 assert.equal(f.fence().authoritySource,'sqlite-total-changes');assert.equal(f.registry.prepareCatalogReadEpoch(),false);
 assert.equal(f.db.prepare('SELECT version FROM noted_prompt_catalog_read_epoch').get().version,99);
});
