const prepared=require('./project-prompt-catalog.test-support.cjs');
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
  const service = new catalog.ProjectPromptCatalogService({ db: database, rootRegistry: registry, fsImpl, asyncFs:{...fs.promises,stat:async p=>{bump('stats',p);const value=await fs.promises.stat(p);const hook=afterStat;afterStat=undefined;hook?.(p);return value;},opendir:async(p,...a)=>{bump('readdirs',p);return fs.promises.opendir(p,...a);}},
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

test('usage uses statement-only fresh pages and one complete source; warm read has no discovery or watcher pass',async t=>{
  const f=fixture(t,24);const usage=await prepared.usage(f.service,f.root);assert.equal(usage[0].tabs.length,24);assert.equal(usage.length,2);
  assert.deepEqual(plain(usage[0].projects),[{id:'P',name:'Project',icon:null}]);f.reset();const warm=await f.service.usageForRoot(f.root);
  const summary=f.summary();t.diagnostic(JSON.stringify(summary));assert.deepEqual(plain(warm),plain(usage));assert.equal(summary.readdirs,0);
  assert.ok(summary.sourceReads>=24*4);assert.ok(summary.sourcePrepares<24,'statements reused, rows never cached');assert.equal(f.service.tabCache.size,0);
});
test('compatibility refresh schedules reconciliation; stable source retains owners without discovery',async t=>{
  const f=fixture(t,24);await prepared.usage(f.service,f.root);const owners=[...f.watches];f.reset();f.service.refreshWatchers();assert.equal(f.summary().sourceReads,0);
  await f.service.prepared.reconcile();assert.equal(f.summary().readdirs,0);assert.ok(owners.filter(w=>!w.closed).every(w=>f.watches.includes(w)));
});
test('second SQLite connection exact disabled/empty/future changes produce current aggregate or explicit failure',async t=>{
  const f=fixture(t,2),writer=new SQLite(f.filename);t.after(()=>writer.close());await prepared.usage(f.service,f.root);
  f.afterStat(()=>writer.prepare('UPDATE workflow_roots SET metadata_json=? WHERE id=?').run(JSON.stringify({enabled:false}),f.ra));assert.deepEqual(plain(await f.service.usageForRoot(f.root)),[]);
  writer.prepare('UPDATE workflow_roots SET metadata_json=? WHERE id=?').run(JSON.stringify({enabled:true}),f.ra);
  f.afterStat(()=>writer.prepare('UPDATE workflow_root_scope_meta SET version=2 WHERE scope=?').run('tab:'+f.tabs[1]));await assert.rejects(f.service.usageForRoot(f.root),{code:'root_binding_forward_version'});
  writer.prepare('UPDATE workflow_root_scope_meta SET version=1 WHERE scope=?').run('tab:'+f.tabs[1]);writer.prepare("UPDATE projects SET name='Renamed' WHERE id='P'").run();assert.equal((await f.service.usageForRoot(f.root))[0].projects[0].name,'Renamed');
});
test('source rebind/remove/archive provenance/CAS refusal/durable replay remain synchronous and exact',async t=>{
  const f=fixture(t,2),oldId=(await prepared.tab(f.service,f.tabs[1])).prompts[0].id;fs.mkdirSync(path.join(f.b,'docs'));fs.writeFileSync(path.join(f.b,'docs','other.prompt.md'),'other');
  const request=f.nextRequest(f.tabs[0],[f.rb]),ack=f.service.setTabSources(request);assert.ok(!(ack instanceof Promise));assert.deepEqual(plain((await prepared.tab(f.service,f.tabs[0])).prompts.map(p=>p.title)),['other']);assert.equal((await f.service.listTab(f.tabs[1])).prompts[0].id,oldId);
  const revision=f.registry.read().revision;assert.throws(()=>f.service.setTabSources({...request,mutationId:'stale',expectedRevision:revision-1}),e=>e.code==='root_revision_changed');assert.throws(()=>f.service.setTabSources({...request,rootIds:[]}),e=>e.code==='root_mutation_id_conflict');
  f.registry.remove({id:f.rb,expectedRevision:revision,expectedRootRevision:f.registry.read().roots.find(r=>r.id===f.rb).revision,mutationId:'remove-b'});
  assert.equal(f.service.getTabSources(f.tabs[0])[0].removed,true);assert.deepEqual(plain((await f.service.listTab(f.tabs[0])).prompts),[]);assert.deepEqual(plain(f.service.setTabSources(request)),plain(ack));assert.throws(()=>f.service.setTabSources(f.nextRequest(f.tabs[1],[f.rb])),e=>e.code==='root_registration_missing');
});
test('filesystem events and current root/docs probes recover missing/reappearing source without TTL',async t=>{
  const f=fixture(t,1),docs=path.join(f.a,'docs'),id=f.tabs[0];await prepared.tab(f.service,id);const added=path.join(docs,'new.prompt.md');fs.writeFileSync(added,'new');f.watch(docs).callback('rename',null);
  assert.equal((await prepared.tab(f.service,id)).prompts.length,3);fs.unlinkSync(added);f.watch(docs).callback('rename',null);assert.equal((await prepared.tab(f.service,id)).prompts.length,2);
  fs.rmSync(docs,{recursive:true});assert.equal((await prepared.tab(f.service,id)).prompts.length,0);fs.mkdirSync(docs);fs.writeFileSync(path.join(docs,'back.prompt.md'),'back');assert.deepEqual(plain((await prepared.tab(f.service,id)).prompts.map(p=>p.title)),['back']);
  fs.rmSync(f.a,{recursive:true});assert.equal((await prepared.tab(f.service,id)).sources[0].exists,false);fs.mkdirSync(docs,{recursive:true});fs.writeFileSync(path.join(docs,'again.prompt.md'),'again');assert.deepEqual(plain((await prepared.tab(f.service,id)).prompts.map(p=>p.title)),['again']);
});
test('retired callbacks and closed lifetime cannot replace current owner timer or resurrect old watchers',async t=>{
  const f=fixture(t,1),docs=path.join(f.a,'docs');await prepared.tab(f.service,f.tabs[0]);const old=f.watch(docs);old.callback('rename',null);f.service.close();const previous=f.service.prepared;old.callback('rename',null);assert.equal(previous.watchers.size,0);
  await prepared.tab(f.service,f.tabs[0]);const replacement=f.watch(docs);assert.notEqual(old,replacement);const slot=f.service.prepared.slots.get(f.a),epoch=slot.epoch;old.callback('rename',null);assert.equal(slot.epoch,epoch);assert.equal(old.closed,true);
});
