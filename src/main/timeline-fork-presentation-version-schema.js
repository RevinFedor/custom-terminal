'use strict';
// Owned additive Main-only grammar; existingConnection readers never install.
const TABLES=Object.freeze([
  Object.freeze({name:'session_history_events',ddl:`CREATE TABLE IF NOT EXISTS session_history_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source_session_id TEXT DEFAULT NULL,
        child_session_id TEXT DEFAULT NULL,
        source_tab_id TEXT DEFAULT NULL,
        child_tab_id TEXT DEFAULT NULL,
        visual_parent_tab_id TEXT DEFAULT NULL,
        orchestration_run_id TEXT DEFAULT NULL,
        orchestration_parent_run_id TEXT DEFAULT NULL,
        fork_mode TEXT DEFAULT NULL,
        operation_kind TEXT DEFAULT NULL,
        entry_uuids_json TEXT NOT NULL DEFAULT '[]',
        lineage_manifest_json TEXT DEFAULT NULL,
        snapshot_complete INTEGER NOT NULL DEFAULT 1,
        boundary_entry_uuid TEXT DEFAULT NULL,
        summary_entry_uuid TEXT DEFAULT NULL,
        occurred_at INTEGER DEFAULT NULL,
        turn_index INTEGER DEFAULT NULL,
        after_iteration_index INTEGER DEFAULT NULL,
        next_iteration_index INTEGER DEFAULT NULL,
        trigger TEXT DEFAULT NULL,
        pre_tokens INTEGER DEFAULT NULL,
        post_tokens INTEGER DEFAULT NULL,
        origin TEXT NOT NULL DEFAULT 'app',
        inherited INTEGER NOT NULL DEFAULT 0,
        is_direct INTEGER NOT NULL DEFAULT 0,
        metadata_copied INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`}),
  Object.freeze({name:'timeline_fork_origins',ddl:`CREATE TABLE IF NOT EXISTS timeline_fork_origins (
        session_id TEXT PRIMARY KEY,
        event_key TEXT NOT NULL,
        boundary_entry_uuid TEXT DEFAULT NULL,
        FOREIGN KEY(event_key) REFERENCES session_history_events(event_key) ON DELETE CASCADE
      )`}),
  Object.freeze({name:'fork_markers',ddl:`CREATE TABLE IF NOT EXISTS fork_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_session_id TEXT NOT NULL,
        forked_to_session_id TEXT NOT NULL,
        entry_uuids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        hidden INTEGER NOT NULL DEFAULT 0,
        UNIQUE(source_session_id, forked_to_session_id)
      )`}),
  Object.freeze({name:'session_links',ddl:`CREATE TABLE IF NOT EXISTS session_links (
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL PRIMARY KEY,
        created_at TEXT DEFAULT (datetime('now'))
      )`})
]);
const VERSION_TABLE='timeline_fork_presentation_version';
const VERSION_DDL=`CREATE TABLE IF NOT EXISTS timeline_fork_presentation_version (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL DEFAULT 0
)`;
const normalize=sql=>sql.replace(/^CREATE (TABLE|TRIGGER) IF NOT EXISTS /,'CREATE $1 ')
 .replace(/\s+/g,' ').replace(/\s*([(),=])\s*/g,'$1').trim().replace(/;$/,'');
function triggerDefinitions(){
 const out=new Map();
 for(const table of TABLES)for(const action of ['INSERT','UPDATE','DELETE']){
  const name='fork_presentation_version_'+table.name+'_'+action.toLowerCase();
  out.set(name,`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${action} ON ${table.name}
   BEGIN INSERT INTO timeline_fork_presentation_version(singleton,version) VALUES(1,1)
    ON CONFLICT(singleton) DO UPDATE SET version=version+1; END;`);
 }return out;
}
function installTimelineForkPresentationVersionSchema(db){
 db.transaction(()=>{
  const read=db.prepare('SELECT type,substr(sql,1,16385) AS sql FROM main.sqlite_master WHERE name=?');
  for(const t of TABLES){const row=read.get(t.name);
   if(!row||row.type!=='table'||typeof row.sql!=='string'||row.sql.length>16384||normalize(row.sql)!==normalize(t.ddl))return;}
  const installed=read.get(VERSION_TABLE);
  if(installed&&(installed.type!=='table'||normalize(installed.sql||'')!==normalize(VERSION_DDL)))return;
  if(!installed)db.exec(VERSION_DDL);
  // Preserve unknown objects. Reader attestation refuses incomplete/custom grammar.
  for(const [name,sql] of triggerDefinitions())if(!read.get(name))db.exec(sql);
 })();
}
module.exports={TABLES,VERSION_TABLE,VERSION_DDL,normalize,triggerDefinitions,installTimelineForkPresentationVersionSchema};
