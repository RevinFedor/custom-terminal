// Run via ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test this-file.
// Actual database/migration/root APIs and native SQLite; only owned temp data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const DatabaseManager = require('./database');
const { createWorkflowOrganizationApi, registerWorkflowOrganizationIpc } = require('./workflow-organization-api');
const { ProjectPromptCatalogService, scanSource } = require('./project-prompt-catalog');

function fixture(t, { legacy = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-catalog-native-'));
  const filename = path.join(base, 'fixture.db');
  const a = path.join(base, 'one');
  const b = path.join(base, 'two');
  for (const root of [a, b]) {
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', path.basename(root) + '.prompt.md'), root);
  }
  const db = new Database(filename);
  db.pragma('foreign_keys=ON');
  const database = new DatabaseManager({ existingConnection: db });
  database.initTables();
  t.after(() => { if (db.open) db.close(); fs.rmSync(base, { recursive: true, force: true }); });
  if (legacy) {
    for (const [ns, source] of [['P', a], ['Q', b]]) {
      db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run(ns, source, ns);
      database.saveProjectPromptSources(ns, [source]);
      db.prepare('INSERT INTO tabs(project_id,tab_id,name,cwd) VALUES(?,?,?,?)').run(ns, 'legacy-' + ns, ns, source);
    }
    db.prepare('INSERT INTO tab_history(project_id,tab_id,name,cwd) VALUES(?,?,?,?)').run('P', 'old-archive', 'Archived', a);
  }
  const api = createWorkflowOrganizationApi({ database });
  api.bootstrap({
    mutationId: 'activate', migrationId: 'private-migration',
    workspace: { activeSpaceId: 'work', spaces: [{ id: 'work', name: 'Work', projectIds: legacy ? ['P', 'Q'] : [], layout: { splitPanes: [] } }] },
  });
  const service = new ProjectPromptCatalogService({ db: database, rootRegistry: api.roots, watch: false });
  t.after(() => service.close());
  const create = (tabId, sourceTabId) => api.createTab({ mutationId: 'create:' + tabId, tabId, cwd: base, workflowId: 'work', sourceTabId, record: { name: tabId } });
  const register = rootPath => api.roots.save({ path: rootPath, kind: 'prompt-source', enabled: true, mutationId: 'root:' + rootPath, expectedRevision: api.roots.read().revision });
  const bind = (tabId, rootIds, mutationId = 'bind:' + tabId) => service.setTabSources({ mutationId, expectedRevision: api.roots.read().revision, tabId, rootIds });
  return { base, filename, db, database, api, service, a, b, create, register, bind };
}

test('native no-Project roots bind only the selected tab and new tabs inherit explicit-empty choices', t => {
  const f = fixture(t);
  f.create('opaque:a'); f.create('opaque:b');
  const one = f.register(f.a), two = f.register(f.b);
  const ack = f.bind('opaque:a', [one.id]);
  f.bind('opaque:b', [two.id]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM projects').get().n, 0);
  assert.deepEqual(f.service.listTab('opaque:a').prompts.map(p => p.title), ['one']);
  assert.deepEqual(f.service.listTab('opaque:b').prompts.map(p => p.title), ['two']);
  f.create('inherits', 'opaque:a');
  assert.deepEqual(f.service.listTab('inherits').prompts.map(p => p.title), ['one']);
  const empty = f.bind('opaque:a', [], 'empty-choice');
  f.create('inherits-empty', 'opaque:a');
  assert.deepEqual(f.service.listTab('inherits-empty').sources, []);
  assert.deepEqual(f.service.listTab('opaque:a').prompts, []);
  assert.deepEqual(f.service.listTab('opaque:b').prompts.map(p => p.title), ['two']);
  assert.deepEqual(f.api.roots.setTabSources({ mutationId: 'empty-choice', expectedRevision: empty.revision - 1, tabId: 'opaque:a', rootIds: [] }), empty);
  assert.throws(() => f.service.setTabSources({ mutationId: 'stale', expectedRevision: ack.revision, tabId: 'opaque:b', rootIds: [] }), /root_revision_changed/);
});

test('native activation preserves exact legacy IDs, includes archive bindings, and survives a database reopen', t => {
  const f = fixture(t, { legacy: true });
  const original = scanSource({ projectId: 'P', rootPath: f.a }).prompts[0].id;
  assert.equal(f.service.listTab('legacy-P').prompts[0].id, original);
  assert.deepEqual(f.service.listTab('legacy-Q').prompts.map(p => p.title), ['two']);
  assert.equal(f.service.listTab('old-archive').prompts[0].id, original);
  f.create('legacy-child', 'legacy-P');
  assert.equal(f.service.listTab('legacy-child').prompts[0].id, original);
  assert.ok(f.api.roots.listSourceScopes().some(scope => scope.tabId === 'old-archive'));
  f.service.close(); f.db.close();
  const db = new Database(f.filename);
  t.after(() => db.close());
  const database = new DatabaseManager({ existingConnection: db });
  const api = createWorkflowOrganizationApi({ database });
  const service = new ProjectPromptCatalogService({ db: database, rootRegistry: api.roots, watch: false });
  t.after(() => service.close());
  assert.equal(service.listTab('legacy-child').prompts[0].id, original);
  assert.equal(service.listTab('old-archive').prompts[0].id, original);
});

test('native workflow tab-roots IPC supplies unbound registrations and exact revisioned bindings', t => {
  const f = fixture(t);
  f.create('target'); f.create('other');
  const one = f.register(f.a), two = f.register(f.b);
  f.bind('target', [one.id]);
  const handlers = new Map();
  registerWorkflowOrganizationIpc({ handle: (name, callback) => handlers.set(name, callback) }, f.api);
  const snapshot = handlers.get('workflow:tab-roots')({}, 'target');
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.rootIds, [one.id]);
  assert.deepEqual(snapshot.sources.map(s => s.rootPath), [f.a]);
  assert.ok(snapshot.roots.some(root => root.id === two.id));
  const request = { mutationId: 'public-bind', expectedRevision: snapshot.revision, tabId: 'target', rootIds: [two.id] };
  const ack = handlers.get('workflow:set-tab-roots')({}, request);
  assert.equal(ack.revision, snapshot.revision + 1);
  assert.deepEqual(f.service.listTab('target').prompts.map(p => p.title), ['two']);
  assert.deepEqual(f.service.listTab('other').prompts, []);
});
