'use strict';

// Owned v1 grammar. Normal Main initialization only; readers never install it.
// No row backfill is needed: zero is the pre-install committed baseline.
const TABLES = Object.freeze([
  Object.freeze({ name: 'timeline_notes', provider: false, ddl: `CREATE TABLE IF NOT EXISTS timeline_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_uuid TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tab_id TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        position TEXT DEFAULT 'before',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(entry_uuid, session_id)
      )` }),
  Object.freeze({ name: 'timeline_rewind_markers', provider: false, ddl: `CREATE TABLE IF NOT EXISTS timeline_rewind_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_uuid TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(entry_uuid, session_id)
      )` }),
  Object.freeze({ name: 'timeline_prompt_summaries', provider: true, ddl: `CREATE TABLE IF NOT EXISTS timeline_prompt_summaries (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_uuid TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_hash TEXT DEFAULT NULL,
        model TEXT DEFAULT NULL,
        prompt_id TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        candidate_tokens INTEGER DEFAULT 0,
        thought_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id, entry_uuid)
      )` }),
  Object.freeze({ name: 'timeline_outlines', provider: true, ddl: `CREATE TABLE IF NOT EXISTS timeline_outlines (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        source_hash TEXT NOT NULL,
        source_uuids_json TEXT NOT NULL DEFAULT '[]',
        source_entry_count INTEGER NOT NULL DEFAULT 0,
        source_last_uuid TEXT DEFAULT NULL,
        outline_json TEXT NOT NULL,
        model TEXT DEFAULT NULL,
        prompt_id TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        prompt_tokens INTEGER DEFAULT 0,
        candidate_tokens INTEGER DEFAULT 0,
        thought_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        source_chars INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id)
      )` }),
  Object.freeze({ name: 'timeline_turn_action_overrides', provider: true, ddl: `CREATE TABLE IF NOT EXISTS timeline_turn_action_overrides (
        tool_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entry_uuid TEXT NOT NULL,
        action_label TEXT NOT NULL,
        source_hash TEXT DEFAULT NULL,
        model TEXT DEFAULT NULL,
        prompt_id TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (tool_type, session_id, entry_uuid)
      )` }),
]);
const VERSION_TABLE = 'timeline_annotation_versions';
const VERSION_DDL = `CREATE TABLE IF NOT EXISTS timeline_annotation_versions (
  annotation_table TEXT NOT NULL, tool_type TEXT NOT NULL, session_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(annotation_table, tool_type, session_id)
)`;
// Only grammar whitespace; literal values and identifiers remain case-sensitive.
const normalize = sql => sql.replace(/^CREATE (TABLE|TRIGGER) IF NOT EXISTS /, 'CREATE $1 ')
  .replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1').trim().replace(/;$/, '');
function triggerDefinitions() {
  const result = new Map();
  for (const table of TABLES) {
    const bump = ref => `INSERT INTO timeline_annotation_versions(annotation_table,tool_type,session_id,version)
      VALUES('${table.name}',${table.provider ? ref+'.tool_type' : "''"},${ref}.session_id,1)
      ON CONFLICT(annotation_table,tool_type,session_id) DO UPDATE SET version=version+1;`;
    for (const [action, refs] of [['INSERT',['NEW']],['UPDATE',['OLD','NEW']],['DELETE',['OLD']]]) {
      const name = 'annotation_version_'+table.name+'_'+action.toLowerCase();
      result.set(name,`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${action} ON ${table.name}
        BEGIN ${refs.map(bump).join('\n')} END;`);
    }
  }
  return result;
}
function tableDefinitions(table) {
  if (table.name !== 'timeline_notes') return [normalize(table.ddl)];
  // Old Main ADD COLUMN position appends the column before table constraints.
  const legacy = table.ddl.replace(/\s*position TEXT DEFAULT 'before',/, '')
    .replace('UNIQUE(entry_uuid, session_id)', "position TEXT DEFAULT 'before', UNIQUE(entry_uuid, session_id)");
  return [normalize(table.ddl), normalize(legacy)];
}
function installTimelineAnnotationVersionSchema(db) {
  db.transaction(() => {
    const object = db.prepare('SELECT type,sql FROM main.sqlite_master WHERE name=?');
    for (const table of TABLES) {
      const row = object.get(table.name);
      if (!row || row.type !== 'table' || !tableDefinitions(table).includes(normalize(row.sql || ''))) return;
    }
    const installed = object.get(VERSION_TABLE);
    // Never repair/reset a custom counter table or replace a foreign object.
    if (installed && (installed.type !== 'table' || normalize(installed.sql || '') !== normalize(VERSION_DDL))) return;
    if (!installed) db.exec(VERSION_DDL);
    for (const [name, sql] of triggerDefinitions()) {
      // Existing unknown/mismatched triggers remain untouched. The read-only
      // witness will refuse scoped authority until the full grammar is known.
      if (!object.get(name)) db.exec(sql);
    }
  })();
}
module.exports = { TABLES, VERSION_TABLE, VERSION_DDL, normalize, tableDefinitions,
  triggerDefinitions, installTimelineAnnotationVersionSchema };
