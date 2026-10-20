'use strict';

// Source-only regression: real PRIVATE SQLite on Node22 and Electron28 Node-mode.
// No app, renderer, userData, provider, HTTP, filesystem catalog scan or UI input.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const Sqlite = process.versions.electron ? require('better-sqlite3')
  : require('./project-prompt-sqlite.test-support.cjs').NodeSqliteAdapter;
const { WorkflowRootRegistry } = require('./workflow-root-registry');
const TABLE = 'noted_prompt_catalog_read_epoch';
const PRE_SHA = 'c232b5357dea6975c57f875b1d0b7e68c4c473709f62aa49accb95a95ec22c95';

// Exact complete V6 module, frozen before the parent v2 edit. This is executable
// migration input, not a reduced duplicate of the trigger/certificate algorithm.
// Provenance: incident source4196/catalog-external-reuse/PRE-prompt-catalog-read-epoch.js.
const LEGACY_V1_SOURCE = [
  "'use strict';\n",
  "\n",
  "// Derived SQLite proof for catalog READS only. It does not own registrations,\n",
  "// execution identities, CAS receipts, Send, or process readiness. Every source\n",
  "// selection is still reread by the existing catalog request before publication.\n",
  "const TABLE = 'noted_prompt_catalog_read_epoch';\n",
  "const PREFIX = 'noted_catalog_epoch_';\n",
  "const TABLE_SQL = `CREATE TABLE ${TABLE} (\n",
  "  singleton INTEGER PRIMARY KEY CHECK(singleton=1),\n",
  "  version INTEGER NOT NULL, revision INTEGER NOT NULL)`;\n",
  "const TARGETS = [\n",
  "  ['tabs', ['tab_id', 'project_id', 'execution_namespace']],\n",
  "  ['projects', ['id', 'name', 'path', 'icon']],\n",
  "  ['workflow_org_tabs', ['tab_id', 'execution_json']],\n",
  "  ['workflow_org_memberships', ['tab_id', 'workflow_id']],\n",
  "  ['workflow_org_workflows', ['workflow_id', 'metadata_json', 'deleted_generation']],\n",
  "  ['workflow_roots', null], ['workflow_root_bindings', null],\n",
  "  ['workflow_root_scope_meta', null], ['workflow_root_meta', null],\n",
  "  ['project_prompt_sources', null],\n",
  "];\n",
  "const normalize = sql => String(sql || '').replace(/\\bIF NOT EXISTS\\b/gi, '').replace(/\\s+/g, ' ').trim();\n",
  "const valid = row => row?.version === 1 && Number.isSafeInteger(row.revision) && row.revision >= 0;\n",
  "const same = (a,b) => a.size === b.size && [...a].every(([k,v]) => normalize(v) === normalize(b.get(k)));\n",
  "\n",
  "function definitions(db) {\n",
  "  const tables = new Set(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(row => row.name));\n",
  "  const output = new Map();\n",
  "  for (const [table, columns] of TARGETS) {\n",
  "    if (!tables.has(table)) continue;\n",
  "    const present = new Set(db.prepare(`PRAGMA table_info(\"${table}\")`).all().map(row => row.name));\n",
  "    if (columns?.some(column => !present.has(column))) throw Error('catalog_epoch_source_schema_unknown');\n",
  "    let update = columns ? columns.map(column => `OLD.\"${column}\" IS NOT NEW.\"${column}\"`).join(' OR ') : '1';\n",
  "    if (table === 'workflow_org_tabs') {\n",
  "      // record_json/model/cwd/status changes are not namespace changes. Invalid\n",
  "      // JSON remains a tracked change, never a trigger rejecting an old write.\n",
  "      update = `OLD.tab_id IS NOT NEW.tab_id OR (OLD.execution_json IS NOT NEW.execution_json AND\n",
  "        CASE WHEN json_valid(OLD.execution_json)<>1 OR json_valid(NEW.execution_json)<>1 THEN 1 ELSE\n",
  "          json_extract(OLD.execution_json,'$.executionNamespace') IS NOT json_extract(NEW.execution_json,'$.executionNamespace') OR\n",
  "          json_extract(OLD.execution_json,'$.projectId') IS NOT json_extract(NEW.execution_json,'$.projectId') END)`;\n",
  "    }\n",
  "    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {\n",
  "      const name = PREFIX + table + '_' + event.toLowerCase();\n",
  "      output.set(name, `CREATE TRIGGER ${name} AFTER ${event} ON \"${table}\"${event === 'UPDATE' ? ' WHEN ' + update : ''}\n",
  "        BEGIN UPDATE ${TABLE} SET revision=revision+1 WHERE singleton=1; END`);\n",
  "    }\n",
  "  }\n",
  "  return output;\n",
  "}\n",
  "const triggers = db => new Map(db.prepare(\"SELECT name,sql FROM sqlite_master WHERE type='trigger'\").all()\n",
  "  .filter(row => row.name.startsWith(PREFIX)).map(row => [row.name,row.sql]));\n",
  "\n",
  "function createCatalogReadEpoch({ log = line => console.warn(line) } = {}) {\n",
  "  const certificates = new WeakMap();\n",
  "  const warned = new Set();\n",
  "  const unavailable = code => { if (!warned.has(code)) { warned.add(code); log('[CatalogReadEpoch] fallback=' + code); } return null; };\n",
  "  function initialize(db) {\n",
  "    try {\n",
  "      // Only the owning schema composition calls this initializer. Reads below\n",
  "      // never create/repair tables, triggers, rows or a missing authority.\n",
  "      const run = () => {\n",
  "        const root = db.prepare('SELECT version FROM workflow_root_meta WHERE singleton=1').get();\n",
  "        if (root?.version !== 1) throw Error('catalog_epoch_root_version_unknown');\n",
  "        const org = db.prepare(\"SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_org_meta'\").get();\n",
  "        if (org && db.prepare('SELECT schema_version FROM workflow_org_meta WHERE singleton=1').get()?.schema_version !== 1) throw Error('catalog_epoch_org_version_unknown');\n",
  "        const existing = db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND name=?\").get(TABLE);\n",
  "        if (existing && normalize(existing.sql) !== normalize(TABLE_SQL)) throw Error('catalog_epoch_schema_unknown');\n",
  "        const expected = definitions(db), actual = triggers(db);\n",
  "        if ([...actual].some(([name,sql]) => !expected.has(name) || normalize(sql) !== normalize(expected.get(name)))) throw Error('catalog_epoch_trigger_unknown');\n",
  "        if (!existing) {\n",
  "          db.exec(TABLE_SQL);\n",
  "          db.prepare(`INSERT INTO ${TABLE} VALUES(1,1,0)`).run();\n",
  "        } else if (!valid(db.prepare(`SELECT version,revision FROM ${TABLE} WHERE singleton=1`).get())) {\n",
  "          throw Error('catalog_epoch_row_unavailable');\n",
  "        }\n",
  "        const missing = [...expected].filter(([name]) => !actual.has(name));\n",
  "        for (const [,sql] of missing) db.exec(sql);\n",
  "        if (existing && missing.length) db.prepare(`UPDATE ${TABLE} SET revision=revision+1 WHERE singleton=1`).run();\n",
  "        return { expected, schema: db.prepare('PRAGMA schema_version').get().schema_version,\n",
  "          statement: db.prepare(`SELECT version,revision FROM ${TABLE} WHERE singleton=1`) };\n",
  "      };\n",
  "      const certificate = db.inTransaction ? run() : db.transaction(run).immediate();\n",
  "      certificates.set(db, certificate);\n",
  "      log('[CatalogReadEpoch] prepared triggers=' + certificate.expected.size);\n",
  "      return true;\n",
  "    } catch (error) {\n",
  "      const code = typeof error?.code === 'string' && /^[A-Z_0-9]{1,64}$/.test(error.code) ? error.code\n",
  "        : /^catalog_epoch_[a-z_]{1,64}$/.test(error?.message || '') ? error.message : 'catalog_epoch_initialization_failed';\n",
  "      unavailable(code); return false;\n",
  "    }\n",
  "  }\n",
  "  function read(db, schema) {\n",
  "    const certificate = certificates.get(db);\n",
  "    if (!certificate) return null;\n",
  "    try {\n",
  "      if (certificate.badSchema === schema) return null;\n",
  "      if (schema !== certificate.schema) {\n",
  "        // Unrelated DDL is okay after readonly proof; a new relevant table,\n",
  "        // removed/changed trigger or epoch schema loses the optimization.\n",
  "        const epoch = db.prepare(\"SELECT sql FROM sqlite_master WHERE type='table' AND name=?\").get(TABLE);\n",
  "        const expected = definitions(db);\n",
  "        if (!epoch || normalize(epoch.sql) !== normalize(TABLE_SQL)\n",
  "          || !same(expected, triggers(db))) {\n",
  "          certificate.badSchema = schema;\n",
  "          return unavailable('catalog_epoch_schema_changed');\n",
  "        }\n",
  "        certificate.expected = expected;\n",
  "        certificate.schema = schema;\n",
  "      }\n",
  "      const row = certificate.statement.get();\n",
  "      return valid(row) ? row.revision : unavailable('catalog_epoch_row_unavailable');\n",
  "    } catch { return unavailable('catalog_epoch_read_failed'); }\n",
  "  }\n",
  "  return { initialize, read };\n",
  "}\n",
  "module.exports = { createCatalogReadEpoch };\n",
].join('');

function compileEpoch(source, filename) {
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = module.paths;
  compiled._compile(source, filename);
  return compiled.exports.createCatalogReadEpoch;
}
assert.equal(crypto.createHash('sha256').update(LEGACY_V1_SOURCE).digest('hex'), PRE_SHA);
const legacyFactory = compileEpoch(LEGACY_V1_SOURCE, path.join(__dirname, 'catalog-epoch-frozen-v1.cjs'));
// The two OLD-RED runs override ONLY this whole module, never the checked-out
// source or the SQL engine. Normal runs load the actual current product module.
const subjectFactory = process.env.NOTED_CATALOG_EPOCH_TEST_MODULE
  ? compileEpoch(fs.readFileSync(process.env.NOTED_CATALOG_EPOCH_TEST_MODULE, 'utf8'),
    process.env.NOTED_CATALOG_EPOCH_TEST_MODULE)
  : require('./prompt-catalog-read-epoch').createCatalogReadEpoch;
const schema = db => db.prepare('PRAGMA schema_version').get().schema_version;
const row = db => db.prepare(`SELECT version,revision FROM ${TABLE} WHERE singleton=1`).get();
const changes = db => db.prepare('SELECT total_changes() n').get().n;
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t, { factory = subjectFactory, initialize = true,
  execution = '{"executionNamespace":"P"}' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-catalog-eligibility-'));
  const filename = path.join(root, 'private.sqlite');
  const db = new Sqlite(filename), connections = new Set([db]);
  t.after(() => {
    for (const connection of connections) if (connection.open) connection.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,project_id TEXT,execution_namespace TEXT,name TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,icon TEXT);
    CREATE TABLE workflow_org_meta(singleton INTEGER PRIMARY KEY,schema_version INTEGER);
    INSERT INTO workflow_org_meta VALUES(1,1);
    CREATE TABLE workflow_org_tabs(tab_id TEXT PRIMARY KEY,execution_json TEXT,record_json TEXT);
    CREATE TABLE workflow_org_memberships(tab_id TEXT PRIMARY KEY,workflow_id TEXT,revision INTEGER);
    CREATE TABLE workflow_org_workflows(workflow_id TEXT PRIMARY KEY,metadata_json TEXT,deleted_generation INTEGER,layout_json TEXT);
    CREATE TABLE project_prompt_sources(project_id TEXT,root_path TEXT);
    INSERT INTO projects VALUES('P','Project P','/private-fixture/P',NULL);
    INSERT INTO projects VALUES('Q','Project Q','/private-fixture/Q',NULL);
    INSERT INTO workflow_org_workflows VALUES('W','{"defaultCwd":"/private-fixture/source"}',NULL,'{}');
    INSERT INTO workflow_org_memberships VALUES('T','W',1);`);
  db.prepare('INSERT INTO workflow_org_tabs VALUES(?,?,?)').run('T', execution, '{"archived":true}');
  const registry = new WorkflowRootRegistry({ db });
  db.prepare('INSERT INTO workflow_root_scope_meta VALUES(?,1,1)').run('tab:T');
  // Deliberately no native tabs row: the real header supports missing/archived
  // provenance and consumes execution_json as its namespace fallback.
  const epoch = factory({ log() {} });
  registry.catalogReadEpoch = epoch;
  if (initialize) assert.equal(epoch.initialize(db), true);
  const read = () => epoch.read(db, schema(db));
  const namespace = () => registry.readTabHeader('T', sql => db.prepare(sql)).namespace;
  const project = () => registry.sourcesForTab('T')[0].projectId;
  const writer = mode => {
    if (mode === 'same') return db;
    const other = new Sqlite(filename); connections.add(other); return other;
  };
  return { db, filename, registry, epoch, read, namespace, project, writer };
}

function state(db) {
  const definitions = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const rows = {};
  for (const { name } of definitions.filter(item => item.type === 'table')) {
    rows[name] = db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '" ORDER BY rowid').all();
  }
  return plain({ schema: schema(db), definitions, rows });
}
function sourceRows(db) {
  const snapshot = state(db);
  delete snapshot.rows[TABLE];
  return snapshot.rows;
}
function assertReadOnly(f, expected) {
  const before = state(f.db), count = changes(f.db);
  assert.equal(f.read(), expected);
  assert.equal(changes(f.db), count, 'certificate reads cannot write or repair');
  assert.deepEqual(state(f.db), before, 'certificate read preserves rows and definitions');
}

test('R1 regression: live organization forward version revokes the existing certificate', t => {
  const f = fixture(t), before = f.read();
  assert.ok(Number.isSafeInteger(before));
  const cookie = schema(f.db);
  f.writer('cross').prepare('UPDATE workflow_org_meta SET schema_version=2 WHERE singleton=1').run();
  assert.equal(schema(f.db), cookie, 'row-only source version change has no DDL signal');
  assertReadOnly(f, null);
});

test('R2 regression: actual archived namespace changes despite unchanged SQLite first value', t => {
  const f = fixture(t, { execution: '{"executionNamespace":"P","executionNamespace":"P"}' });
  assert.equal(f.namespace(), 'P'); assert.equal(f.project(), 'P');
  const before = f.read(), cookie = schema(f.db);
  const first = () => f.db.prepare("SELECT json_extract(execution_json,'$.executionNamespace') value FROM workflow_org_tabs WHERE tab_id='T'").get().value;
  assert.equal(first(), 'P');
  f.writer('cross').prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?')
    .run('{"executionNamespace":"P","executionNamespace":"Q"}', 'T');
  assert.equal(first(), 'P', 'SQLite first match is unchanged');
  assert.equal(schema(f.db), cookie);
  assert.equal(f.namespace(), 'Q'); assert.equal(f.project(), 'Q', 'actual header/source decoder consumes last key');
  assert.ok(f.read() > before, 'changed JavaScript-consumed owner must advance the certified SQL epoch');
});

test('fresh composition publishes only derived version2 and v2 registry authority', t => {
  const f = fixture(t);
  assert.equal(row(f.db).version, 2);
  assert.equal(f.registry.captureCatalogFence().authoritySource, 'catalog-read-epoch-v2');
  assertReadOnly(f, row(f.db).revision);
});

for (const mode of ['same', 'cross']) {
  for (const [name, sql] of [
    ['organization future version', 'UPDATE workflow_org_meta SET schema_version=2 WHERE singleton=1'],
    ['organization singleton missing', 'DELETE FROM workflow_org_meta WHERE singleton=1'],
    ['organization table missing', 'DROP TABLE workflow_org_meta'],
    ['root future version', 'UPDATE workflow_root_meta SET version=2 WHERE singleton=1'],
    ['root singleton missing', 'DELETE FROM workflow_root_meta WHERE singleton=1'],
  ]) test(name + ' revokes a live certificate / ' + mode, t => {
    const f = fixture(t); assert.ok(Number.isSafeInteger(f.read()));
    f.writer(mode).exec(sql);
    assertReadOnly(f, null);
  });

  const ambiguous = [
    ['duplicate executionNamespace',
      '{"executionNamespace":"P","executionNamespace":"P"}',
      '{"executionNamespace":"P","executionNamespace":"Q"}', 'executionNamespace'],
    ['duplicate projectId', '{"projectId":"P","projectId":"P"}',
      '{"projectId":"P","projectId":"Q"}', 'projectId'],
    ['Unicode-escaped executionNamespace collision',
      String.raw`{"executionNamespace":"P","\u0065xecutionNamespace":"P"}`,
      String.raw`{"executionNamespace":"P","\u0065xecutionNamespace":"Q"}`, 'executionNamespace'],
    ['Unicode-escaped projectId collision',
      String.raw`{"projectId":"P","\u0070rojectId":"P"}`,
      String.raw`{"projectId":"P","\u0070rojectId":"Q"}`, 'projectId'],
  ];
  for (const [name, oldText, newText, key] of ambiguous) test(name + ' invalidates actual fallback owners / ' + mode, t => {
    const f = fixture(t, { execution: oldText }), before = f.read();
    const extract = () => f.db.prepare('SELECT json_extract(execution_json,?) value FROM workflow_org_tabs WHERE tab_id=?')
      .get('$.' + key, 'T').value;
    assert.equal(f.namespace(), 'P'); assert.equal(f.project(), 'P');
    assert.equal(extract(), 'P');
    f.writer(mode).prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?').run(newText, 'T');
    assert.equal(extract(), 'P', 'SQL first-key projection cannot see the changed last key');
    assert.equal(f.namespace(), 'Q'); assert.equal(f.project(), 'Q');
    assert.ok(f.read() > before, 'raw ambiguity must invalidate even when SQL extraction is unchanged');
    assertReadOnly(f, row(f.db).revision);
  });

  test('ordinary unique model/record changes retain the namespace fast path / ' + mode, t => {
    const f = fixture(t), before = f.read(), other = f.writer(mode);
    other.prepare('UPDATE workflow_org_tabs SET execution_json=?,record_json=? WHERE tab_id=?')
      .run('{"executionNamespace":"P","projectId":"P","model":"first"}', '{"busy":true}', 'T');
    // Adding a consumed projectId is relevant; the later model-only transition is not.
    const stable = f.read(); assert.ok(stable > before);
    other.prepare('UPDATE workflow_org_tabs SET execution_json=?,record_json=? WHERE tab_id=?')
      .run('{"executionNamespace":"P","projectId":"P","model":"second"}', '{"busy":false}', 'T');
    assert.equal(f.read(), stable); assert.equal(f.project(), 'P');
  });

  test('raw Unicode changes conservatively invalidate without changing the owner / ' + mode, t => {
    const f = fixture(t, { execution: String.raw`{"executionNamespace":"P","model":"\u0061"}` });
    const before = f.read();
    f.writer(mode).prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?')
      .run(String.raw`{"executionNamespace":"P","model":"\u0062"}`, 'T');
    assert.equal(f.namespace(), 'P'); assert.ok(f.read() > before);
  });

  test('byte-identical ambiguous execution JSON does not invent another input change / ' + mode, t => {
    const text = '{"projectId":"P","projectId":"Q"}', f = fixture(t, { execution: text });
    const before = f.read();
    f.writer(mode).prepare('UPDATE workflow_org_tabs SET execution_json=? WHERE tab_id=?').run(text, 'T');
    assert.equal(f.read(), before); assert.equal(f.namespace(), 'Q');
  });
}

for (const partial of [false, true]) test('exact full frozen v1 definitions migrate atomically to v2 / subset=' + partial, t => {
  const f = fixture(t, { factory: legacyFactory }), old = plain(row(f.db)), data = sourceRows(f.db);
  assert.equal(old.version, 1);
  if (partial) f.db.exec('DROP TRIGGER noted_catalog_epoch_tabs_insert; DROP TRIGGER noted_catalog_epoch_workflow_org_tabs_update');
  const candidate = subjectFactory({ log() {} }), beforeRead = state(f.db);
  assert.equal(candidate.read(f.db, schema(f.db)), null, 'a new reader cannot migrate legacy authority');
  assert.deepEqual(state(f.db), beforeRead);
  assert.equal(candidate.initialize(f.db), true);
  const migrated = plain(row(f.db));
  assert.equal(migrated.version, 2); assert.ok(migrated.revision > old.revision);
  assert.deepEqual(sourceRows(f.db), data, 'migration preserves all source/organization rows');
  assert.equal(candidate.read(f.db, schema(f.db)), migrated.revision);
  assert.equal(f.read(), null, 'the complete old reader cannot claim authority over derived v2');
  const after = state(f.db);
  assert.equal(candidate.initialize(f.db), true);
  assert.deepEqual(state(f.db), after, 'owned initialization is strictly idempotent after migration');
});

test('a real SQL failure rolls back the entire owned legacy migration', t => {
  const f = fixture(t, { factory: legacyFactory });
  f.db.exec(`CREATE TRIGGER private_epoch_migration_fault BEFORE UPDATE ON ${TABLE}
    WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'private_migration_failure'); END;`);
  const before = state(f.db), candidate = subjectFactory({ log() {} });
  assert.equal(candidate.initialize(f.db), false);
  assert.deepEqual(state(f.db), before, 'DDL, definitions and revision roll back together');
  assert.equal(candidate.read(f.db, schema(f.db)), null);
  f.db.exec('DROP TRIGGER private_epoch_migration_fault');
  assert.equal(candidate.initialize(f.db), true);
  assert.equal(row(f.db).version, 2);
});

for (const base of ['legacy', 'current']) {
  for (const fault of ['unknown-trigger', 'future99', 'missing-row', 'unknown-epoch-schema']) {
    test('read and owned initialization preserve refused ' + fault + ' / ' + base, t => {
      const f = fixture(t, { factory: base === 'legacy' ? legacyFactory : subjectFactory });
      if (fault === 'unknown-trigger') f.db.exec(`DROP TRIGGER noted_catalog_epoch_workflow_org_tabs_update;
        CREATE TRIGGER noted_catalog_epoch_workflow_org_tabs_update AFTER UPDATE ON workflow_org_tabs BEGIN SELECT 1; END;`);
      if (fault === 'future99') f.db.prepare(`UPDATE ${TABLE} SET version=99`).run();
      if (fault === 'missing-row') f.db.prepare(`DELETE FROM ${TABLE}`).run();
      if (fault === 'unknown-epoch-schema') f.db.exec(`ALTER TABLE ${TABLE} ADD COLUMN future_payload TEXT`);
      const before = state(f.db), candidate = subjectFactory({ log() {} }), count = changes(f.db);
      assert.equal(candidate.read(f.db, schema(f.db)), null);
      assert.equal(candidate.initialize(f.db), false);
      assert.equal(candidate.read(f.db, schema(f.db)), null);
      assert.deepEqual(state(f.db), before, 'no reset, row rewrite or trigger repair is permitted');
      assert.equal(changes(f.db), count);
    });
  }
}

test('an already certified reader loses changed trigger authority without repairing it', t => {
  const f = fixture(t);
  f.writer('cross').exec(`DROP TRIGGER noted_catalog_epoch_workflow_org_tabs_update;
    CREATE TRIGGER noted_catalog_epoch_workflow_org_tabs_update AFTER UPDATE ON workflow_org_tabs BEGIN SELECT 1; END;`);
  assertReadOnly(f, null);
  const before = state(f.db);
  assert.equal(f.epoch.initialize(f.db), false);
  assert.deepEqual(state(f.db), before);
});
