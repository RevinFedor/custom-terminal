// One plain Node process with Electron's SQLite ABI, no Electron app/window:
// ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --max-old-space-size=128 this-file
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SQLite = require('better-sqlite3');
const plain = value => JSON.parse(JSON.stringify(value));
const norm = sql => sql.replace(/\s+/g, ' ').trim();
const isSourceRead = sql => /^SELECT (project_id,execution_namespace FROM tabs|execution_json FROM workflow_org_tabs|\* FROM workflow_root_scope_meta WHERE scope=|r\.\*,b\.position,b\.metadata_json AS binding_json)/.test(sql);

function fixture(t, n = 2) {
  const root = fs.mkdtempSync('/private/tmp/noted-prompt-batch-');
  const filename = path.join(root, 'fixture.db'), db = new SQLite(filename);
  db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE tabs(tab_id TEXT PRIMARY KEY,project_id TEXT,execution_namespace TEXT);
    CREATE TABLE workflow_org_tabs(tab_id TEXT PRIMARY KEY,execution_json TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,icon TEXT); INSERT INTO projects VALUES('P','Project',NULL);`);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(path.join(a, 'docs'), { recursive: true }); fs.mkdirSync(b);
  for (const name of ['2.prompt.md', '10.prompt.md']) fs.writeFileSync(path.join(a, 'docs', name), 'private fixture');
  let counts = {}, now = 10000, mutation = 0, afterStat;
  const reset = () => { counts = { prepares: new Map(), reads: new Map(), stats: new Map(), readdirs: new Map() }; };
  reset();
  const bump = (key, value) => counts[key].set(value, (counts[key].get(value) || 0) + 1);
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const key = norm(sql); bump('prepares', key);
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, key2) {
      const value = Reflect.get(target, key2, target);
      if (key2 === 'get' || key2 === 'all') return (...args) => { bump('reads', key); return value.apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const timers = new Set(), watches = [], changes = [];
  const fsImpl = { ...fs,
    statSync(p) { bump('stats', p); const value = fs.statSync(p); const hook = afterStat; afterStat = undefined; hook?.(p); return value; },
    readdirSync(p, options) { bump('readdirs', p); return fs.readdirSync(p, options); },
    watch(p, options, callback) { const w = { path: p, callback, closed: false, close() { this.closed = true; } }; watches.push(w); return w; },
  };
  class ClockDate extends Date { static now() { return now; } }
  let catalog;
  const load = name => {
    const filename = path.join(__dirname, name), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, Date: ClockDate, console,
      require(name) { if (name === './project-prompt-catalog') return catalog; return require(name); },
      setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
      clearTimeout: timer => timers.delete(timer),
    }, { filename });
    return module.exports;
  };
  catalog = load('project-prompt-catalog.js');
  const { WorkflowRootRegistry } = load('workflow-root-registry.js');
  const database = { db, getProjectById: id => db.prepare('SELECT * FROM projects WHERE id=?').get(id) };
  const registry = new WorkflowRootRegistry(database);
  const register = rootPath => registry.save({ path: rootPath, kind: 'prompt-source', enabled: true,
    expectedRevision: registry.read().revision, mutationId: 'save-' + (++mutation) }).id;
  const ra = register(a), rb = register(b), tabs = [];
  for (let i = 0; i < n; i++) {
    const tab = 'tab-' + String(i).padStart(2, '0'); tabs.push(tab);
    if (i % 2 === 0) db.prepare('INSERT INTO tabs VALUES(?,?,?)').run(tab, 'P', 'P'); // Other half are archive-only.
    db.prepare('INSERT INTO workflow_org_tabs VALUES(?,?)').run(tab, JSON.stringify({ executionNamespace: 'P' }));
    registry.setTabSources({ tabId: tab, rootIds: [ra], expectedRevision: registry.read().revision, mutationId: 'bind-' + (++mutation) });
  }
  const service = new catalog.ProjectPromptCatalogService({ db: database, rootRegistry: registry, fsImpl,
    layoutStore: { get: () => ({ layout: {} }) }, onChanged: c => changes.push(plain(c)) });
  registry.onChanged = change => { service.invalidateTabs(change.tabIds || null, 'root-bindings-changed'); service.refreshWatchers(); };
  t.after(() => {
    service.close();
    try {
      assert.equal(timers.size, 0); assert.ok(watches.every(w => w.closed));
      const bytes = fs.statSync(filename).size;
      t.diagnostic(JSON.stringify({ fixtureDatabaseBytes: bytes }));
      assert.ok(bytes < 1024 * 1024, 'bounded private SQLite');
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  const total = (kind, predicate = () => true) => [...counts[kind]].filter(([key]) => predicate(key)).reduce((sum, [, count]) => sum + count, 0);
  const summary = () => ({ sourcePrepares: total('prepares', isSourceRead), sourceReads: total('reads', isSourceRead),
    stats: total('stats'), readdirs: total('readdirs'), watched: service.watchers.size });
  return { root, filename, db, registry, service, a, b, ra, rb, tabs, timers, watches, changes, reset, summary, register,
    nextRequest: (tabId, rootIds) => ({ tabId, rootIds, expectedRevision: registry.read().revision, mutationId: 'bind-' + (++mutation) }),
    watch: p => [...watches].reverse().find(w => w.path === p && !w.closed),
    afterStat: fn => { afterStat = fn; }, advance: ms => { now += ms; },
    flush() { for (const timer of [...timers]) { assert.equal(timer.ms, 180); timers.delete(timer); timer.fn(); } },
  };
}

test('usage prepares each source SELECT once per call; every exact binding is still read in both passes', t => {
  const f = fixture(t, 24);
  f.reset(); const usage = f.service.usageForRoot(f.root); const cold = f.summary();
  t.diagnostic(JSON.stringify({ cold }));
  assert.equal(usage.length, 2); assert.equal(usage[0].tabs.length, 24);
  assert.deepEqual(plain(usage[0].projects), [{ id: 'P', name: 'Project', icon: null }]);
  assert.equal(cold.sourcePrepares, 4, 'compile four source queries once, not once per tab/pass');
  assert.equal(cold.sourceReads, 24 * 4 * 2, 'fresh SQL still executes for every binding');
  assert.equal(cold.stats, 6, 'usage A then fresh watcher pass A/B, one stat per root/docs in each pass');
  assert.equal(cold.readdirs, 1, 'existing per-request scan sharing remains');
  const cached = f.service.tabCache.get(f.tabs[0]).value;
  f.reset(); const warm = f.service.usageForRoot(f.root); t.diagnostic(JSON.stringify({ warm: f.summary() }));
  assert.equal(f.summary().sourcePrepares, 4, 'statements do not persist to the next request');
  assert.equal(f.summary().sourceReads, 24 * 4 * 2);
  assert.equal(f.summary().stats, 6); assert.equal(f.summary().readdirs, 0);
  assert.equal(f.service.tabCache.get(f.tabs[0]).value, cached, 'original catalog TTL unchanged');
  assert.deepEqual(plain(warm), plain(usage));
});

test('watch-only refresh batches preparation and stats but does not skip current bindings', t => {
  const f = fixture(t, 24), original = [...f.watches];
  f.reset(); f.service.refreshWatchers(); t.diagnostic(JSON.stringify(f.summary()));
  assert.equal(f.summary().sourcePrepares, 4); assert.equal(f.summary().sourceReads, 24 * 4);
  assert.equal(f.summary().stats, 4); assert.equal(f.summary().readdirs, 0);
  assert.deepEqual(f.watches, original, 'stable source keeps the existing watcher');
});

test('a second SQLite connection can change roots/scope version inside a batch; no row snapshot hides it', t => {
  const f = fixture(t, 2), writer = new SQLite(f.filename);
  try {
    f.afterStat(() => writer.prepare('UPDATE workflow_roots SET metadata_json=? WHERE id=?')
      .run(JSON.stringify({ kind: 'prompt-source', enabled: false }), f.ra));
    const result = f.service.usageForRoot(f.root);
    assert.deepEqual(plain(result[0].tabs.map(t => t.id)), [f.tabs[0]], 'next binding sees the external commit');
    assert.deepEqual(plain(f.service.usageForRoot(f.root)), []);
    writer.prepare('UPDATE workflow_roots SET metadata_json=? WHERE id=?').run(JSON.stringify({ enabled: true }), f.ra);
    f.afterStat(() => writer.prepare('UPDATE workflow_root_scope_meta SET version=2 WHERE scope=?').run('tab:' + f.tabs[1]));
    assert.throws(() => f.service.usageForRoot(f.root), error => error.code === 'root_binding_forward_version');
    writer.prepare('UPDATE workflow_root_scope_meta SET version=1 WHERE scope=?').run('tab:' + f.tabs[1]);
    assert.equal(f.service.usageForRoot(f.root)[0].tabs.length, 2);
    writer.prepare("UPDATE projects SET name='Renamed' WHERE id='P'").run();
    assert.equal(f.service.usageForRoot(f.root)[0].projects[0].name, 'Renamed');
  } finally { writer.close(); }
});

test('source add/rebind/remove, archive provenance, CAS refusal and durable replay stay intact', t => {
  const f = fixture(t, 2), oldId = f.service.listTab(f.tabs[1]).prompts[0].id;
  fs.mkdirSync(path.join(f.b, 'docs')); fs.writeFileSync(path.join(f.b, 'docs', 'other.prompt.md'), 'other');
  const request = f.nextRequest(f.tabs[0], [f.rb]);
  const ack = f.service.setTabSources(request);
  assert.deepEqual(plain(f.service.listTab(f.tabs[0]).prompts.map(p => p.title)), ['other']);
  assert.equal(f.service.listTab(f.tabs[1]).prompts[0].id, oldId, 'archive keeps its exact original namespace/ID');
  const revision = f.registry.read().revision;
  assert.throws(() => f.service.setTabSources({ ...request, mutationId: 'stale', expectedRevision: revision - 1 }), e => e.code === 'root_revision_changed');
  assert.throws(() => f.service.setTabSources({ ...request, rootIds: [], mutationId: request.mutationId }), e => e.code === 'root_mutation_id_conflict');
  const removed = f.registry.remove({ id: f.rb, expectedRevision: revision,
    expectedRootRevision: f.registry.read().roots.find(r => r.id === f.rb).revision, mutationId: 'remove-b' });
  assert.equal(removed.removed, true);
  const source = f.service.getTabSources(f.tabs[0])[0];
  assert.equal(source.removed, true); assert.equal(source.enabled, false);
  assert.deepEqual(plain(f.service.listTab(f.tabs[0]).prompts), []);
  assert.deepEqual(plain(f.service.setTabSources(request)), plain(ack), 'committed retry is still a receipt replay');
  assert.throws(() => f.service.setTabSources(f.nextRequest(f.tabs[1], [f.rb])), e => e.code === 'root_registration_missing');
  f.service.setTabSources(f.nextRequest(f.tabs[0], []));
  assert.deepEqual(plain(f.service.getTabSources(f.tabs[0])), []);
});

test('filesystem add/remove and missing/reappearing docs/root remain fresh through watch invalidation and reads', t => {
  const f = fixture(t, 1), docs = path.join(f.a, 'docs'), tab = f.tabs[0];
  f.service.listTab(tab);
  const added = path.join(docs, 'new.prompt.md'); fs.writeFileSync(added, 'new');
  assert.equal(f.service.listTab(tab).prompts.length, 2, 'existing short TTL is not silently replaced');
  f.watch(docs).callback(); f.flush(); assert.equal(f.service.listTab(tab).prompts.length, 3);
  fs.unlinkSync(added); f.watch(docs).callback(); f.flush(); assert.equal(f.service.listTab(tab).prompts.length, 2);
  const oldDocsWatch = f.watch(docs); fs.rmSync(docs, { recursive: true });
  oldDocsWatch.callback(); f.flush(); assert.ok(oldDocsWatch.closed); assert.ok(f.watch(f.a));
  assert.equal(f.service.listTab(tab).prompts.length, 0);
  fs.mkdirSync(docs); fs.writeFileSync(path.join(docs, 'back.prompt.md'), 'back');
  const rootWatch = f.watch(f.a); rootWatch.callback(); f.flush(); assert.ok(rootWatch.closed); assert.ok(f.watch(docs));
  assert.deepEqual(plain(f.service.listTab(tab).prompts.map(p => p.title)), ['back']);
  const gone = f.watch(docs); fs.rmSync(f.a, { recursive: true }); gone.callback(); f.flush();
  assert.equal(f.service.getTabSources(tab)[0].exists, false); assert.equal(f.service.listTab(tab).prompts.length, 0);
  fs.mkdirSync(docs, { recursive: true }); fs.writeFileSync(path.join(docs, 'again.prompt.md'), 'again');
  assert.deepEqual(plain(f.service.listTab(tab).prompts.map(p => p.title)), ['again']); assert.ok(f.watch(docs));
  fs.writeFileSync(path.join(docs, 'ttl.prompt.md'), 'ttl'); f.advance(1501);
  assert.equal(f.service.listTab(tab).prompts.length, 2, 'original TTL fallback remains');
});

test('retired watch callbacks/timers cannot invalidate a replacement or resurrect watchers after close', t => {
  const f = fixture(t, 1), target = path.join(f.a, 'docs'), old = f.watch(target);
  old.callback(); assert.equal(f.timers.size, 1);
  f.service.setTabSources(f.nextRequest(f.tabs[0], [f.rb]));
  const root = f.registry.read().roots.find(r => r.id === f.ra);
  f.registry.remove({ id: f.ra, expectedRevision: f.registry.read().revision, expectedRootRevision: root.revision, mutationId: 'retire-a' });
  assert.ok(old.closed); assert.equal(f.timers.size, 0, 'retiring target cancels its pending debounce');
  old.callback(); assert.equal(f.timers.size, 0, 'late old filesystem event is ignored');
  f.register(f.a); const replacement = f.watch(target); assert.notEqual(replacement, old);
  replacement.callback(); const pending = f.service.watchDebounce.get(target);
  old.callback(); assert.equal(f.service.watchDebounce.get(target), pending, 'old owner cannot replace new owner timer');
  f.flush(); f.service.close();
  replacement.callback(); assert.equal(f.timers.size, 0); assert.equal(f.service.watchers.size, 0);
});
