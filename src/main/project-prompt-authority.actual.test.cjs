'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { NodeSqliteAdapter } = require('./project-prompt-sqlite.test-support.cjs');
const { WorkflowRootRegistry } = require('./workflow-root-registry');
const { ProjectPromptCatalogService } = require('./project-prompt-catalog');
const support = require('./project-prompt-catalog.test-support.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, n = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog46-sql-'))), source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'docs'), { recursive: true }); fs.writeFileSync(path.join(source, 'docs', 'authored.prompt.md'), 'private');
  const filename = path.join(root, 'private.sqlite'), db = new NodeSqliteAdapter(filename);
  db.exec(`CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,project_id TEXT,execution_namespace TEXT,name TEXT);
    CREATE TABLE tab_history(tab_id TEXT,project_id TEXT,execution_namespace TEXT,name TEXT);
    CREATE TABLE workflow_org_tabs(tab_id TEXT PRIMARY KEY,execution_json TEXT);
    CREATE TABLE workflow_org_memberships(tab_id TEXT PRIMARY KEY,workflow_id TEXT);
    CREATE TABLE workflow_org_workflows(workflow_id TEXT PRIMARY KEY,metadata_json TEXT,deleted_generation INTEGER);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,path TEXT,icon TEXT,updated_at INTEGER);
    CREATE TABLE history_noise(value TEXT);
    INSERT INTO projects VALUES('P','Project',NULL,NULL,1);`);
  let scans = 0;
  const database = { db, getProjectById(id) { return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id); },
    getProjectsWithPromptSources() { throw Error('registry path must not enumerate legacy Projects'); } };
  const registry = new WorkflowRootRegistry(database);
  const saved = registry.save({ mutationId: 'root', expectedRevision: registry.read().revision, path: source, kind: 'prompt-source' });
  db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = 't-' + String(i).padStart(4, '0');
      db.prepare('INSERT INTO tabs VALUES(?,?,?,?)').run(id, 'P', 'P', id);
      db.prepare('INSERT INTO workflow_org_tabs VALUES(?,?)').run(id, JSON.stringify({ executionNamespace: 'P' }));
      db.prepare('INSERT INTO workflow_root_scope_meta VALUES(?,1,1)').run('tab:' + id);
      db.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,0,?)').run('tab:' + id, saved.id, JSON.stringify({ project_id: 'P' }));
    }
  })();
  const asyncFs = { stat: (...a) => fs.promises.stat(...a), lstat: (...a) => fs.promises.lstat(...a), realpath: (...a) => fs.promises.realpath(...a),
    opendir(...a) { scans++; return fs.promises.opendir(...a); } };
  const service = new ProjectPromptCatalogService({ db: database, rootRegistry: registry, asyncFs, watch: false });
  t.after(() => { service.close(); for (const c of [db, database.db]) if (c.open) c.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, filename, db, database, registry, service, saved, scans: () => scans };
}
test('real SQL pages retain original scope order, archives/future/explicit-empty, no all-scopes query', async t => {
  const f = fixture(t, 258);
  const original = f.registry.listSourceScopes().map(s => s.id), first = f.registry.readSourceScopesPage('', 256), second = f.registry.readSourceScopesPage(first.at(-1).id, 256);
  assert.equal(first.length, 256); assert.deepEqual([...first, ...second].map(s => s.id), original);
  const all = await support.usage(f.service, f.source); assert.equal(all[0].tabs.length, 258);
  f.db.prepare('DELETE FROM workflow_root_bindings WHERE scope=?').run('tab:t-0000');
  assert.deepEqual((await f.service.listTab('t-0000')).prompts, []);
  f.db.prepare('UPDATE workflow_root_scope_meta SET version=2 WHERE scope=?').run('tab:t-0001');
  await assert.rejects(f.service.usageForRoot('/disjoint'), { code: 'root_binding_forward_version' });
});
test('statement-only reader sees outside commit and resets exact connection/schema ports', t => {
  const f = fixture(t), reader = f.registry.createSourcesReader(); const rows = reader('t-0000'); assert.equal(rows.length, 1);
  f.db.exec('ALTER TABLE workflow_roots ADD COLUMN extra TEXT'); assert.equal(reader('t-0000')[0].rootId, f.saved.id);
  f.db.prepare('DELETE FROM workflow_root_bindings WHERE scope=?').run('tab:t-0000'); assert.deepEqual(reader('t-0000'), []);
  const next = new NodeSqliteAdapter(f.filename); f.database.db = next; assert.deepEqual(reader('t-0000'), []);
  next.prepare('INSERT INTO workflow_root_bindings VALUES(?,?,0,?)').run('tab:t-0000', f.saved.id, '{}'); assert.equal(reader('t-0000').length, 1);
  next.prepare('UPDATE workflow_root_scope_meta SET version=2 WHERE scope=?').run('tab:t-0000'); assert.throws(() => reader('t-0000'), { code: 'root_binding_forward_version' });
});
test('external connection exact-empty commit during real yield re-passes authority without source rescan', async t => {
  const f = fixture(t); await support.tab(f.service, 't-0000'); const scans = f.scans(), external = new NodeSqliteAdapter(f.filename); t.after(() => external.close());
  let once = false; f.service.prepared.controlOptions = { maxSteps: 1, schedule: async () => { await tick(); if (!once) { once = true; external.prepare('DELETE FROM workflow_root_bindings WHERE scope=?').run('tab:t-0000'); } } };
  assert.deepEqual((await f.service.listTab('t-0000')).prompts, []); assert.equal(f.scans(), scans);
});
test('actual bindCreatedTab outer commit without notify is fenced; rollback does not rewrite source/CAS receipts', async t => {
  const f = fixture(t); await support.tab(f.service, 't-0000'); const oldEpoch = f.registry.catalogCommittedEpoch;
  f.db.transaction(() => {
    f.db.prepare('INSERT INTO tabs VALUES(?,?,?,?)').run('outer-created', 'P', 'P', 'Created');
    f.db.prepare('INSERT INTO workflow_org_tabs VALUES(?,?)').run('outer-created', JSON.stringify({ executionNamespace: 'P' }));
    f.registry.bindCreatedTab('outer-created', 'P', 't-0000');
  })();
  assert.equal(f.registry.catalogCommittedEpoch, oldEpoch, 'notify completeness is not manufactured');
  assert.equal((await f.service.listTab('outer-created')).prompts.length, 1);
  assert.ok((await f.service.usageForRoot(f.source))[0].tabs.some(t => t.id === 'outer-created'));
  assert.throws(() => f.db.transaction(() => { f.registry.copyBindings('tab:rollback', 'tab:t-0000'); throw Error('rollback'); })(), /rollback/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM workflow_root_scope_meta WHERE scope=?').get('tab:rollback').n, 0);
  const request = { tabId: 't-0000', rootIds: [], mutationId: 'exact-empty', expectedRevision: f.registry.read().revision };
  const receipt = f.service.setTabSources(request); assert.ok(!(receipt instanceof Promise));
  assert.deepEqual(f.service.setTabSources(request), receipt, 'durable replay remains synchronous');
  assert.throws(() => f.service.setTabSources({ ...request, mutationId: 'stale', tabId: 't-0001' }), { code: 'root_revision_changed' });
});
test('unrelated History local commit may re-pass once, never dirties source preparation', async t => {
  const f = fixture(t); await support.tab(f.service, 't-0000'); const scans = f.scans(); let once = false;
  f.service.prepared.controlOptions = { maxSteps: 1, schedule: async () => { await tick(); if (!once) { once = true; f.db.prepare('INSERT INTO history_noise VALUES(?)').run('irrelevant'); } } };
  assert.equal((await f.service.listTab('t-0000')).prompts.length, 1); assert.equal(f.scans(), scans);
});
test('schema/connection swap during projection refuses mixed authority and takes one fresh pass', async t => {
  const f = fixture(t); await support.tab(f.service, 't-0000'); let once = false;
  f.service.prepared.controlOptions = { maxSteps: 1, schedule: async () => { await tick(); if (!once) { once = true;
    const db = new NodeSqliteAdapter(f.filename); f.database.db = db; db.exec('ALTER TABLE workflow_roots ADD COLUMN epoch46 INTEGER'); db.prepare('DELETE FROM workflow_root_bindings WHERE scope=?').run('tab:t-0000'); } } };
  assert.deepEqual((await f.service.listTab('t-0000')).prompts, []);
});
