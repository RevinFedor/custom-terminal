'use strict';

const { historyFreshnessTriggerDefinitions } = require('./history-freshness-metadata');
const { HISTORY_PROMPT_VERSION_SCHEMA } = require('./history-prompt-version-schema');
const { SqliteStorageGraceStore } = require('../../storage-retention-grace');
const { triggerDefinitions: forkPresentationTriggers, VERSION_TABLE: forkVersionTable,
  VERSION_DDL: forkVersionDDL, normalize: normalizeForkGrammar } = require('./timeline-fork-presentation-version-schema');
const contracts = new WeakMap();
const normalize = sql => sql.replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim();
const integer = n => Number.isSafeInteger(n) && n >= 0;

// No writes: use the existing installer as the expected trigger grammar.
// A private/legacy or modified schema keeps the conservative database witness;
// missing triggers never turn into a guessed version zero.
function attested(db, schema, tempSchema) {
  const cached = contracts.get(db);
  if (cached?.schema === schema && cached.tempSchema === tempSchema) return cached.known;
  let known = false;
  try {
    for (const [table, expected] of [
      ['history_freshness_versions', ['domain','provider','owner_id','version']],
      ['history_prompt_revision_versions', ['tool_type','version']],
    ]) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all();
      if (columns.length !== expected.length || columns.some((c,i) => c.name !== expected[i])) throw Error('witness columns');
      const keys = table === 'history_freshness_versions' ? ['domain','provider','owner_id'] : ['tool_type'];
      if (keys.some((name,i) => columns.find(c => c.name === name)?.pk !== i + 1)) throw Error('witness primary key');
    }
    const expected = new Map();
    const collect = sql => {
      for (const match of sql.matchAll(/CREATE TRIGGER IF NOT EXISTS ([a-z_]+)[\s\S]*?END;/g)) {
        expected.set(match[1], normalize(match[0].replace(/;\s*$/, '')));
      }
    };
    const definitions = historyFreshnessTriggerDefinitions({ prepare(sql) {
      const statement = db.prepare(sql);
      return { all() { const rows = statement.all(); if (!rows.length || rows.length > 64) throw Error('unbounded schema'); return rows; } };
    } });
    for (const sql of definitions.values()) collect(sql);
    collect(HISTORY_PROMPT_VERSION_SCHEMA);
    if (expected.size !== 18) throw Error('incomplete trigger contract');
    const actualNames = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND tbl_name IN ('history_response_timings','history_response_timing_aliases','session_history_events',
        'session_links','agent_activity_intervals','history_prompt_presentations') LIMIT 27`).all();
    const extras = actualNames.filter(row => !expected.has(row.name));
    if (extras.length) {
      const allowed = new Map();
      // Production also installs these non-semantic retention-clock hooks.
      // Derive their exact SQL from the canonical owner without executing any
      // DDL/DML; a changed or additional trigger remains an unknown contract.
      new SqliteStorageGraceStore({
        exec(sql) { for (const match of sql.matchAll(/CREATE TRIGGER IF NOT EXISTS (storage_grace_lineage_(?:insert|update))[\s\S]*?END;/g)) {
          allowed.set(match[1],normalize(match[0].replace(/;\s*$/, '')));
        } },
        prepare(sql) { return /^(?:PRAGMA table_info|SELECT 1 FROM sqlite_master)/.test(sql) ? db.prepare(sql) : {}; },
        transaction() { return () => { throw Error('schema proof must not execute a transaction'); }; },
      });
      // Six exact additive counter hooks on these two shared dependency tables.
      for (const [name, sql] of forkPresentationTriggers()) {
        if (/ AFTER (INSERT|UPDATE|DELETE) ON (session_history_events|session_links)\s/.test(sql))
          allowed.set(name, normalize(sql.replace(/;\s*$/, '')));
      }
      if (extras.some(row => forkPresentationTriggers().has(row.name))) {
        const counter = db.prepare('SELECT type,substr(sql,1,16385) AS sql FROM main.sqlite_master WHERE name=?').get(forkVersionTable);
        if (!counter || counter.type !== 'table' || typeof counter.sql !== 'string' || counter.sql.length > 16384
          || normalizeForkGrammar(counter.sql) !== normalizeForkGrammar(forkVersionDDL)
          || db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='trigger' AND tbl_name=? LIMIT 1").get(forkVersionTable)
          || db.prepare('SELECT 1 FROM temp.sqlite_master WHERE name=? OR tbl_name=? LIMIT 1').get(forkVersionTable,forkVersionTable))
          throw Error('unknown fork counter grammar');
      }
      if (actualNames.length > 26 || extras.some(row => !allowed.has(row.name))) throw Error('unexpected trigger');
      for (const row of extras) expected.set(row.name,allowed.get(row.name));
    }
    const read = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?");
    for (const [name, sql] of expected) {
      const actual = read.get(name)?.sql;
      if (typeof actual !== 'string' || actual.length > 16384 || normalize(actual.replace(/;\s*$/, '')) !== sql) throw Error('trigger mismatch');
    }
    known = true;
  } catch { /* Optimization unavailable; original root preparation remains. */ }
  contracts.set(db, { schema, tempSchema, known });
  return known;
}

function readPrimarySidecarWitness(db, sessions, tabId, { ownReadSnapshot = false } = {}) {
  if (!db?.prepare || typeof db.transaction !== 'function') return null;
  // A vector read must be one committed cut too. Without this read snapshot,
  // a foreign WAL commit between indexed SELECTs could combine old prompt
  // and new timing versions into a token that never existed.
  if (db.inTransaction === false) {
    try { return db.transaction(() => readPrimarySidecarWitness(db,sessions,tabId,{ownReadSnapshot:true}))(); }
    catch { return null; }
  }
  if (!(ownReadSnapshot && db.inTransaction === true)) return null;
  try {
    const schema = db.prepare('PRAGMA schema_version').get()?.schema_version;
    const tempSchema = db.prepare('PRAGMA temp.schema_version').get()?.schema_version;
    const data = db.prepare('PRAGMA data_version').get()?.data_version;
    const changes = db.prepare('SELECT total_changes() AS changes').get()?.changes;
    if (![schema,tempSchema,data,changes].every(integer)) return null;
    if (!attested(db, schema, tempSchema)) return Object.freeze({ mode:'database', values:Object.freeze([schema,data,changes]) });
    const read = db.prepare('SELECT version FROM history_freshness_versions WHERE domain=? AND provider=? AND owner_id=?');
    const version = (domain,provider,owner) => {
      const row = read.get(domain,provider,owner), value = row ? row.version : 0;
      if (!integer(value)) throw Error('invalid version');
      return value;
    };
    const promptRow = db.prepare('SELECT version FROM history_prompt_revision_versions WHERE tool_type=?').get('codex');
    const prompt = promptRow ? promptRow.version : 0;
    if (!integer(prompt)) return null;
    // data_version changes on unrelated Main UI commits. Relevant foreign and
    // offline DML is covered by the attested transactional triggers instead.
    // Keep total_changes for local writes/rollback and never borrow uncommitted data.
    const values = [schema,changes,prompt,version('timing-provider','codex','*'),
      version('timing-tab','codex',tabId || '')];
    for (const id of sessions) values.push(version('timing-session','codex',id),version('topology','*',id));
    return Object.freeze({ mode:'scoped', values:Object.freeze(values) });
  } catch { return null; }
}
module.exports = { readPrimarySidecarWitness };
