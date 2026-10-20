'use strict';

// Derived SQLite proof for catalog READS only. It does not own registrations,
// execution identities, CAS receipts, Send, or process readiness. Every source
// selection is still reread by the existing catalog request before publication.
const TABLE = 'noted_prompt_catalog_read_epoch';
const PREFIX = 'noted_catalog_epoch_';
const VERSION = 2;
const TABLE_SQL = `CREATE TABLE ${TABLE} (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  version INTEGER NOT NULL, revision INTEGER NOT NULL)`;
const TARGETS = [
  ['tabs', ['tab_id', 'project_id', 'execution_namespace']],
  ['projects', ['id', 'name', 'path', 'icon']],
  ['workflow_org_tabs', ['tab_id', 'execution_json']],
  ['workflow_org_memberships', ['tab_id', 'workflow_id']],
  ['workflow_org_workflows', ['workflow_id', 'metadata_json', 'deleted_generation']],
  ['workflow_roots', null], ['workflow_root_bindings', null],
  ['workflow_root_scope_meta', null], ['workflow_root_meta', null],
  ['project_prompt_sources', null],
];
const normalize = sql => String(sql || '').replace(/\bIF NOT EXISTS\b/gi, '').replace(/\s+/g, ' ').trim();
const valid = (row, version = VERSION) => row?.version === version && Number.isSafeInteger(row.revision) && row.revision >= 0;
const same = (a,b) => a.size === b.size && [...a].every(([k,v]) => normalize(v) === normalize(b.get(k)));

function definitions(db, legacy = false) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const output = new Map();
  for (const [table, columns] of TARGETS) {
    if (!tables.has(table)) continue;
    const present = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
    if (columns?.some(column => !present.has(column))) throw Error('catalog_epoch_source_schema_unknown');
    let update = columns ? columns.map(column => `OLD."${column}" IS NOT NEW."${column}"`).join(' OR ') : '1';
    if (table === 'workflow_org_tabs') {
      // record_json/model/cwd/status changes are not namespace changes. Invalid
      // JSON remains a tracked change, never a trigger rejecting an old write.
      const ambiguous = legacy ? '' : `WHEN instr(OLD.execution_json,'\\u')>0 OR instr(NEW.execution_json,'\\u')>0 THEN 1
          WHEN EXISTS(SELECT 1 FROM json_each(OLD.execution_json) WHERE key IN('executionNamespace','projectId') GROUP BY key HAVING count(*)>1)
            OR EXISTS(SELECT 1 FROM json_each(NEW.execution_json) WHERE key IN('executionNamespace','projectId') GROUP BY key HAVING count(*)>1) THEN 1`;
      // JavaScript JSON.parse reads the last duplicate key; SQLite reads the
      // first. Ambiguous/escaped text therefore invalidates conservatively,
      // while ordinary unique-key model/status changes keep the fast path.
      update = `OLD.tab_id IS NOT NEW.tab_id OR (OLD.execution_json IS NOT NEW.execution_json AND
        CASE WHEN json_valid(OLD.execution_json)<>1 OR json_valid(NEW.execution_json)<>1 THEN 1 ${ambiguous} ELSE
          json_extract(OLD.execution_json,'$.executionNamespace') IS NOT json_extract(NEW.execution_json,'$.executionNamespace') OR
          json_extract(OLD.execution_json,'$.projectId') IS NOT json_extract(NEW.execution_json,'$.projectId') END)`;
    }
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const name = PREFIX + table + '_' + event.toLowerCase();
      output.set(name, `CREATE TRIGGER ${name} AFTER ${event} ON "${table}"${event === 'UPDATE' ? ' WHEN ' + update : ''}
        BEGIN UPDATE ${TABLE} SET revision=revision+1 WHERE singleton=1; END`);
    }
  }
  return output;
}
const triggers = db => new Map(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all()
  .filter(row => row.name.startsWith(PREFIX)).map(row => [row.name,row.sql]));

function createCatalogReadEpoch({ log = line => console.warn(line) } = {}) {
  const certificates = new WeakMap();
  const warned = new Set();
  const unavailable = code => { if (!warned.has(code)) { warned.add(code); log('[CatalogReadEpoch] fallback=' + code); } return null; };
  function initialize(db) {
    try {
      // Only the owning schema composition calls this initializer. Reads below
      // never create/repair tables, triggers, rows or a missing authority.
      const run = () => {
        const root = db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1').get();
        if (root?.version !== 1) throw Error('catalog_epoch_root_version_unknown');
        const org = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_org_meta'").get();
        if (org && db.prepare('SELECT schema_version FROM workflow_org_meta WHERE singleton=1').get()?.schema_version !== 1) throw Error('catalog_epoch_org_version_unknown');
        const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
        if (existing && normalize(existing.sql) !== normalize(TABLE_SQL)) throw Error('catalog_epoch_schema_unknown');
        const expected = definitions(db), actual = triggers(db);
        const row = existing ? db.prepare(`SELECT version,revision FROM ${TABLE} WHERE singleton=1`).get() : null;
        const legacy = !!existing && valid(row, 1);
        if (existing && !legacy && !valid(row)) throw Error('catalog_epoch_row_unavailable');
        const accepted = legacy ? definitions(db, true) : expected;
        if ([...actual].some(([name,sql]) => !accepted.has(name) || normalize(sql) !== normalize(accepted.get(name)))) throw Error('catalog_epoch_trigger_unknown');
        if (existing && row.revision >= Number.MAX_SAFE_INTEGER) throw Error('catalog_epoch_revision_exhausted');
        if (!existing) {
          db.exec(TABLE_SQL);
          db.prepare(`INSERT INTO ${TABLE} VALUES(1,?,0)`).run(VERSION);
        }
        let changed = false;
        for (const [name,sql] of expected) {
          if (actual.has(name) && normalize(actual.get(name)) === normalize(sql)) continue;
          // Only exact known v1 definitions are replaced by this schema owner.
          // Unknown definitions/future rows above remain untouched fallback.
          if (actual.has(name)) db.exec(`DROP TRIGGER "${name}"`);
          db.exec(sql); changed = true;
        }
        if (existing && (legacy || changed)) db.prepare(`UPDATE ${TABLE} SET version=?,revision=revision+1 WHERE singleton=1`).run(VERSION);
        return { expected, upgraded: legacy, schema: db.prepare('PRAGMA schema_version').get().schema_version,
          statement: db.prepare(`SELECT version,revision FROM ${TABLE} WHERE singleton=1`),
          rootVersion: db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1'),
          orgPresent: !!org,
          orgVersion: org ? db.prepare('SELECT schema_version FROM workflow_org_meta WHERE singleton=1') : null };
      };
      const certificate = db.inTransaction ? run() : db.transaction(run).immediate();
      certificates.set(db, certificate);
      log('[CatalogReadEpoch] prepared triggers=' + certificate.expected.size + ' version=' + VERSION
        + ' upgraded=' + certificate.upgraded);
      return true;
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code
        : /^catalog_epoch_[a-z_]{1,64}$/.test(error?.message || '') ? error.message : 'catalog_epoch_initialization_failed';
      unavailable(code); return false;
    }
  }
  function read(db, schema) {
    const certificate = certificates.get(db);
    if (!certificate) return null;
    try {
      if (certificate.badSchema === schema) return null;
      if (schema !== certificate.schema) {
        // Unrelated DDL is okay after readonly proof; a new relevant table,
        // removed/changed trigger or epoch schema loses the optimization.
        const epoch = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
        const expected = definitions(db);
        const orgPresent = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_org_meta'").get();
        if (!epoch || normalize(epoch.sql) !== normalize(TABLE_SQL)
          || !same(expected, triggers(db)) || orgPresent !== certificate.orgPresent) {
          certificate.badSchema = schema;
          return unavailable('catalog_epoch_schema_changed');
        }
        certificate.expected = expected;
        certificate.schema = schema;
      }
      // Row-only source-version changes do not change SQLite's schema cookie.
      // Recheck the initializer's known-version preconditions on every read.
      if (certificate.rootVersion.get()?.version !== 1) return unavailable('catalog_epoch_root_version_unknown');
      if (certificate.orgPresent && certificate.orgVersion.get()?.schema_version !== 1)
        return unavailable('catalog_epoch_org_version_unknown');
      const row = certificate.statement.get();
      return valid(row) ? row.revision : unavailable('catalog_epoch_row_unavailable');
    } catch { return unavailable('catalog_epoch_read_failed'); }
  }
  return { initialize, read };
}
module.exports = { createCatalogReadEpoch };
