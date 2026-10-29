'use strict';

const { TABLES, VERSION_TABLE, VERSION_DDL, normalize, tableDefinitions,
  triggerDefinitions } = require('./timeline-annotation-version-schema');
const contracts = new WeakMap();
const integer = n => Number.isSafeInteger(n) && n >= 0;

function attested(db, schema, tempSchema) {
  const cached = contracts.get(db);
  if (cached?.schema === schema && cached.tempSchema === tempSchema) return cached.known;
  let known = false;
  try {
    const expected = new Map(TABLES.map(table => [table.name, { type:'table', sql:tableDefinitions(table) }]));
    expected.set(VERSION_TABLE, { type:'table', sql:[normalize(VERSION_DDL)] });
    for (const [name, sql] of triggerDefinitions()) expected.set(name, { type:'trigger', sql:[normalize(sql)] });
    const read = db.prepare('SELECT type,tbl_name,substr(sql,1,16385) AS sql FROM main.sqlite_master WHERE name=?');
    for (const [name, spec] of expected) {
      const row = read.get(name);
      if (!row || row.type !== spec.type || typeof row.sql !== 'string' || row.sql.length > 16384
        || !spec.sql.includes(normalize(row.sql))) throw Error('unknown annotation DDL');
    }
    // A custom side effect or TEMP shadow is not part of this contract.
    // Finite scalar iteration, never materialize sqlite_master or payloads.
    const owners = [...TABLES.map(t => t.name),VERSION_TABLE];
    const marks = owners.map(() => '?').join(',');
    let count = 0;
    for (const row of db.prepare(`SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name IN (${marks}) LIMIT 16`).iterate(...owners)) {
      if (++count > 15 || !expected.has(row.name)) throw Error('custom annotation trigger');
    }
    if (count !== 15) throw Error('missing annotation trigger');
    if (db.prepare(`SELECT 1 AS present FROM temp.sqlite_master WHERE name IN (${marks}) OR tbl_name IN (${marks}) LIMIT 1`).get(...owners,...owners))
      throw Error('temporary annotation shadow');
    known = true;
  } catch { /* Legacy/custom storage retains global committed invalidation. */ }
  contracts.set(db, { schema, tempSchema, known });
  return known;
}

// One committed SQLite cut for schema proof AND all five counters. Never borrow
// an existing transaction; never retain a statement/transaction across await.
// No DDL/DML, payload reads, MAX timestamps, row lists or inferred source token.
function readTimelineAnnotationFreshness(db, toolType, sessionId) {
  if (!db?.prepare || typeof db.transaction !== 'function' || db.inTransaction !== false) return null;
  if (typeof toolType !== 'string' || !toolType || typeof sessionId !== 'string' || !sessionId) return null;
  try {
    return db.transaction(() => {
      if (db.inTransaction !== true) return null;
      const schemaVersion = db.prepare('PRAGMA main.schema_version').get()?.schema_version;
      const tempSchemaVersion = db.prepare('PRAGMA temp.schema_version').get()?.schema_version;
      const dataVersion = db.prepare('PRAGMA main.data_version').get()?.data_version;
      const totalChanges = db.prepare('SELECT total_changes() AS n').get()?.n;
      if (![schemaVersion,tempSchemaVersion,dataVersion,totalChanges].every(integer)) return null;
      const base = { schemaVersion,tempSchemaVersion,dataVersion,totalChanges };
      if (!attested(db,schemaVersion,tempSchemaVersion)) return Object.freeze({ ...base, mode:'database', versions:null });
      const read = db.prepare('SELECT version FROM main.timeline_annotation_versions WHERE annotation_table=? AND tool_type=? AND session_id=?');
      const versions = TABLES.map(table => {
        const row = read.get(table.name, table.provider ? toolType : '', sessionId);
        const value = row ? row.version : 0;
        if (!integer(value)) throw Error('invalid annotation version');
        return value;
      });
      return Object.freeze({ ...base, mode:'scoped', versions:Object.freeze(versions) });
    })();
  } catch { return null; }
}
module.exports = { readTimelineAnnotationFreshness };
