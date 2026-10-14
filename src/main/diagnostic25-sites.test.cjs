'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncResource } = require('node:async_hooks');
const { createCausalContext } = require('./perf-causal-context');
const { PrivateSQLite, load } = require('./diagnostic25-sites.fixtures.cjs');

function diagnostics(step = 60) {
  let now = 1000, clockReads = 0;
  const events = [];
  const causal = createCausalContext({ boot: 'sites-test', now: () => { clockReads++; now += step; return now; } });
  causal.configure({ enabled: true, sink: event => { events.push(event); return true; } });
  assert.equal(typeof causal.hasWork, 'function', 'requires actual diagnostic25 API; never skip');
  return { causal, events, reset: () => { events.length = 0; },
    clockReads: () => clockReads, advance: ms => { now += ms; },
    summaries: siteId => events.filter(e => e.kind === 'work-summary' && (!siteId || e.workSummary.siteId === siteId)).map(e => e.workSummary),
  };
}
const ops = ['prepare', 'get', 'all', 'run'];
const counts = calls => ops.map(op => calls.filter(c => c.operation === op).length);
const total = summaries => summaries.reduce((sum, s) => sum.map((v, i) => v + s.counts[i]), [0, 0, 0, 0]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function catalogFixture(t, { n = 24, watch = true, diag = diagnostics() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic25-sites-'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  fs.mkdirSync(path.join(a, 'docs'), { recursive: true }); fs.mkdirSync(b);
  for (const name of ['2.prompt.md', '10.prompt.md']) fs.writeFileSync(path.join(a, 'docs', name), 'private fixture body');
  const db = new PrivateSQLite();
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT,name TEXT,icon TEXT,updated_at INTEGER);
    CREATE TABLE tabs(id INTEGER PRIMARY KEY,tab_id TEXT,project_id TEXT,execution_namespace TEXT,is_utility INTEGER,position INTEGER);
    CREATE TABLE workflow_org_tabs(tab_id TEXT PRIMARY KEY,execution_json TEXT);
    CREATE TABLE global_commands(name TEXT,command TEXT,position INTEGER);`);
  db.prepare('INSERT INTO projects(id,path,name) VALUES(?,?,?)').run('P', a, 'Project');
  const overrides = { './perf-causal-context': { causal: diag.causal } };
  const timers = new Set(), watches = [], notices = [], fsCounts = { stats: 0, scans: 0, layouts: 0 };
  const catalogModule = load('project-prompt-catalog.js', overrides, {
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const { WorkflowRootRegistry } = load('workflow-root-registry.js', { ...overrides, './project-prompt-catalog': catalogModule });
  const DatabaseManager = load('database.js', { ...overrides, 'better-sqlite3': PrivateSQLite,
    electron: { app: { getPath() { throw Error('must use existing private connection'); } } } });
  const database = new DatabaseManager({ existingConnection: db });
  diag.causal.configure({ enabled: false });
  const registry = new WorkflowRootRegistry(database);
  const ra = registry.save({ path: a, enabled: true, mutationId: 'root-a', expectedRevision: 0 }).id;
  registry.save({ path: b, enabled: true, mutationId: 'root-b', expectedRevision: 1 });
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const tabId = 'tab-' + i; tabs.push(tabId);
    if (i % 2 === 0) db.prepare('INSERT INTO tabs(tab_id,project_id,execution_namespace) VALUES(?,?,?)').run(tabId, 'P', 'P');
    db.prepare('INSERT INTO workflow_org_tabs VALUES(?,?)').run(tabId, JSON.stringify({ executionNamespace: 'P' }));
    registry.setTabSources({ tabId, rootIds: [ra], expectedRevision: registry.read().revision, mutationId: 'bind-' + i });
  }
  const fsImpl = { ...fs,
    statSync(...args) { fsCounts.stats++; return fs.statSync(...args); },
    readdirSync(...args) { fsCounts.scans++; return fs.readdirSync(...args); },
    watch(target, options, callback) {
      const w = { target, options, callback: AsyncResource.bind(callback), closed: false, close() { this.closed = true; } };
      watches.push(w); return w;
    },
  };
  const service = new catalogModule.ProjectPromptCatalogService({ db: database, rootRegistry: registry, fsImpl, watch,
    layoutStore: { get() { fsCounts.layouts++; return { layout: {} }; } }, onChanged: value => notices.push(value) });
  diag.causal.configure({ enabled: true });
  const reset = () => { diag.reset(); db.calls.length = 0; fsCounts.stats = fsCounts.scans = fsCounts.layouts = 0; notices.length = 0; };
  reset();
  t.after(() => { service.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, a, b, ra, db, database, registry, service, tabs, diag, timers, watches, notices, fsCounts, reset,
    flush() { for (const timer of [...timers]) { assert.equal(timer.ms, 180); timers.delete(timer); timer.fn(); } },
  };
}

test('cached source statements count real prepare once and execute in the current work owner', t => {
  const f = catalogFixture(t, { n: 1, watch: false });
  const read = f.registry.createSourcesReader();
  assert.equal(f.db.calls.length, 0, 'reader creation does not compile');
  f.diag.causal.syncWork('control.first', { readId: 'first' }, () => {
    for (let i = 0; i < 1024; i++) read(f.tabs[0]);
  });
  const first = f.diag.summaries('control.first')[0];
  assert.deepEqual(first.counts, [4, 3072, 1024, 0]);
  assert.equal(first.counters.sourceReads, 1024);
  assert.equal(f.diag.summaries().length, 1, 'no per-binding fallback work under the pass');
  assert.deepEqual(first.counts, counts(f.db.calls));
  assert.ok(f.diag.events.length < 5, '4096 short SQL executions do not send per-query records');
  f.reset();
  f.diag.causal.syncWork('control.second', { readId: 'second' }, () => read(f.tabs[0]));
  const second = f.diag.summaries('control.second')[0];
  assert.deepEqual(second.counts, [0, 3, 1, 0]);
  assert.equal(second.context.readId, 'second');
  f.reset(); read(f.tabs[0]);
  assert.deepEqual(f.diag.summaries('roots.readTabSources')[0].counts, [0, 3, 1, 0], 'standalone reader owns one work');
});

test('catalog counters describe cold/warm work and both fresh SQL passes, not the two returned files', t => {
  const f = catalogFixture(t);
  const usage = f.service.usageForRoot(f.dir);
  assert.equal(usage.length, 2); assert.equal(usage[0].tabs.length, 24);
  const cold = f.diag.summaries('catalog.usageForRoot')[0];
  const watchers = f.diag.summaries('catalog.refreshWatchers')[0];
  assert.equal(cold.counters.scopes, 24); assert.equal(watchers.counters.scopes, 24);
  assert.equal(cold.counters.cacheMisses, 24); assert.equal(cold.counters.layoutReads, 24);
  assert.equal(cold.counters.sourceScans, 1); assert.equal(cold.counters.scanHits, 23);
  assert.equal(cold.counters.directoryReads, 1); assert.equal(cold.counters.statReads, 2);
  assert.equal(watchers.counters.statReads, 4);
  assert.equal(f.fsCounts.stats, 6); assert.equal(f.fsCounts.scans, 1);
  const sourceCells = f.diag.summaries().flatMap(s => s.sites).filter(s => s.siteId.startsWith('roots.tabSources.'));
  assert.deepEqual(total(sourceCells), [4, 24 * 3 * 2, 24 * 2, 0]);
  assert.deepEqual(total(f.diag.summaries()), counts(f.db.calls), 'whole parent/child SQL cells are exclusive');
  const cached = f.service.tabCache.get(f.tabs[0]).value;
  f.reset(); assert.deepEqual(f.service.usageForRoot(f.dir), usage);
  const warm = f.diag.summaries('catalog.usageForRoot')[0];
  assert.equal(warm.counters.cacheHits, 24); assert.equal(warm.counters.layoutReads || 0, 0);
  assert.equal(warm.counters.sourceScans || 0, 0); assert.equal(f.fsCounts.scans, 0);
  assert.equal(f.service.tabCache.get(f.tabs[0]).value, cached);
  assert.deepEqual(total(f.diag.summaries()), counts(f.db.calls));
});

test('watch events/debounce are new roots, retain 180ms coalescing and retired watcher guard', t => {
  const f = catalogFixture(t, { n: 2, watch: false });
  f.service.watchEnabled = true;
  f.diag.causal.run('historical.registration', { readId: 'old' }, () => f.service.refreshWatchers());
  const watch = f.watches.find(w => w.target === path.join(f.a, 'docs'));
  f.reset();
  watch.callback(); watch.callback();
  assert.equal(f.timers.size, 1);
  const events = f.diag.summaries('catalog.watchEvent');
  assert.equal(events.length, 2); assert.ok(events.every(e => e.parentSpanId === null && e.counters.watchEvents === 1));
  f.flush();
  const fired = f.diag.summaries('catalog.watchDebounce')[0];
  assert.equal(fired.parentSpanId, null); assert.equal(fired.counters.notifications, 1);
  assert.equal(f.notices.length, 1); assert.equal(f.timers.size, 0);
  f.service.close(); watch.callback();
  assert.equal(f.timers.size, 0, 'late event cannot recreate closed watchers');
  assert.equal(f.notices.length, 1);
});

test('source reads remain SQL-fresh and preserve CAS errors, receipt replay and transaction rollback', t => {
  const f = catalogFixture(t, { n: 2, watch: false });
  const read = f.registry.createSourcesReader(); read(f.tabs[1]);
  f.db.prepare('UPDATE workflow_root_scope_meta SET version=2 WHERE scope=?').run('tab:' + f.tabs[1]);
  assert.throws(() => read(f.tabs[1]), e => e.code === 'root_binding_forward_version');
  f.db.prepare('UPDATE workflow_root_scope_meta SET version=1 WHERE scope=?').run('tab:' + f.tabs[1]);
  const request = { tabId: f.tabs[0], rootIds: [], mutationId: 'empty', expectedRevision: f.registry.read().revision };
  const receipt = f.registry.setTabSources(request);
  assert.deepEqual(f.registry.setTabSources(request), receipt);
  assert.throws(() => f.registry.setTabSources({ ...request, mutationId: 'stale' }), e => e.code === 'root_revision_changed');
  assert.deepEqual(read(f.tabs[0]), []); assert.equal(read(f.tabs[1]).length, 1);
  const revision = f.registry.read().revision, error = new Error('private controlled failure');
  assert.throws(() => f.registry.mutate('control', { mutationId: 'failed', expectedRevision: revision }, () => {
    f.db.prepare('DELETE FROM workflow_root_bindings').run(); throw error;
  }), e => e === error);
  assert.equal(f.registry.read().revision, revision); assert.equal(read(f.tabs[1]).length, 1);
});

function historyFixture(t, diag) {
  const db = new PrivateSQLite(); t.after(() => db.close());
  db.exec(`CREATE TABLE session_history_events(id INTEGER PRIMARY KEY,event_key TEXT,event_type TEXT,
    provider TEXT,session_id TEXT,source_session_id TEXT,child_session_id TEXT,occurred_at INTEGER,
    created_at INTEGER,is_direct INTEGER,operation_kind TEXT,entry_uuids_json TEXT,lineage_manifest_json TEXT);`);
  db.prepare(`INSERT INTO session_history_events(event_key,event_type,provider,session_id,source_session_id,
    child_session_id,occurred_at,created_at,is_direct,operation_kind,entry_uuids_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run('fork', 'fork', 'codex', 'child', 'source', 'child', 2, 1, 1, 'rewind', '["private-entry"]');
  const DatabaseManager = load('database.js', { './perf-causal-context': { causal: diag.causal }, 'better-sqlite3': PrivateSQLite, electron: {} });
  return { db, manager: new DatabaseManager({ existingConnection: db }) };
}

test('history events/context instrument actual SELECT and map while preserving Fork operation', t => {
  const d = diagnostics(), { db, manager } = historyFixture(t, d);
  db.calls.length = 0;
  const value = manager.getSessionHistoryContext('child');
  assert.equal(value.fork.operationKind, 'rewind'); assert.deepEqual(value.fork.entryUuids, ['private-entry']);
  assert.deepEqual(d.summaries('db.getSessionHistoryContext')[0].counts, [1, 0, 1, 0]);
  assert.equal(d.summaries().length, 1); assert.deepEqual(counts(db.calls), [1, 0, 1, 0]);
  db.prepare("UPDATE session_history_events SET operation_kind='fork' WHERE event_key='fork'").run();
  assert.equal(manager.getSessionHistoryContext('child').fork.operationKind, 'fork', 'no row cache introduced');
  const secret = new Error('private-failure'), prepare = db.prepare;
  db.prepare = () => { throw secret; }; d.reset();
  assert.throws(() => manager.getSessionHistoryEvents('child'), e => e === secret);
  const failed = d.summaries()[0];
  assert.equal(failed.outcome, 'error'); assert.equal(failed.sqlErrors, 1); assert.deepEqual(failed.counts, [1, 0, 0, 0]);
  assert.ok(!JSON.stringify(d.events).includes('private-failure')); db.prepare = prepare;
});

test('availability enumerates manifests after inflight await and attributes interleaved owners correctly', async t => {
  const d = diagnostics(), { manager } = historyFixture(t, d);
  const { AgentSessionAvailabilityService } = load('agent-session-availability.js', { './perf-causal-context': { causal: d.causal } });
  const gate = deferred(); let manifests = 0;
  const service = new AgentSessionAvailabilityService({ claudeProjectsDir: '/unused', codexHome: '/unused',
    getCodexLineageManifest() { manifests++; manager.getSessionHistoryContext('child'); return { sourceSegments: [{ physicalSessionId: 'physical' }] }; } });
  // Only the async discovery participants are substituted; the target manifest
  // enumeration, actual DB reader, ALS context, work clocks and sink are real.
  service._discoverClaude = service._discoverCodex = service._discoverGemini = async () => {};
  service.inflight = gate.promise;
  const response = d.causal.run('request.owner', { readId: 'request' }, () => service.probeBatch({ sessions: [
    { provider: 'codex', sessionId: 'child', tabId: 'request-tab' },
  ] }));
  assert.equal(manifests, 0); assert.equal(d.summaries('availability.manifests').length, 0);
  d.causal.syncWork('unrelated', { readId: 'other' }, () => manager.getSessionHistoryEvents('source'));
  d.advance(20000); gate.resolve(); await response;
  const work = d.summaries('availability.manifests')[0];
  assert.equal(manifests, 1); assert.equal(work.context.readId, 'request');
  assert.deepEqual(work.counts, [1, 0, 1, 0]);
  assert.equal(work.counters.descriptors, 1); assert.equal(work.counters.manifestReads, 1); assert.equal(work.counters.manifestSegments, 1);
  assert.ok(work.wallMs < 2000, '20s inflight await is not synchronous work');
  assert.equal(d.summaries('db.getSessionHistoryContext').length, 0, 'DB reader joins executing manifest pass');
});

function contextFixture(t) {
  const diag = diagnostics(), db = new PrivateSQLite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic25-context-'));
  const filePath = path.join(dir, 'work.md'); fs.writeFileSync(filePath, 'before\n');
  const watches = [], changes = [], tabs = [
    { tabId: 'owner', name: 'Owner', cwd: dir, tabType: 'terminal', commandType: 'codex', codexSessionId: 'session' },
    { tabId: 'file', tabType: 'file', filePath, visualParentTabId: 'owner' },
    { tabId: 'unrelated', tabType: 'terminal', cwd: dir },
  ];
  const fsImpl = { ...fs, watch(target, callback) {
    const w = { target, callback: AsyncResource.bind(callback), close() {}, unref() {}, on() {} }; watches.push(w); return w;
  } };
  const { TabWorkContext } = load('tab-work-context.js', { 'node:fs': fsImpl, './perf-causal-context': { causal: diag.causal } });
  diag.causal.configure({ enabled: false });
  const context = new TabWorkContext({ db, listTabs: () => tabs, archivedTab: () => null, onChanged: v => changes.push(v) });
  diag.causal.configure({ enabled: true }); diag.reset(); db.calls.length = 0;
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { diag, db, dir, filePath, tabs, context, watches, changes, fsImpl };
}

test('syncLinks measures actual enumeration between awaits and preserves fresh SQL/watch passes', async t => {
  const f = contextFixture(t), gate = deferred(), started = deferred();
  const read = f.context.readFile.bind(f.context); let first = true;
  f.context.readFile = async file => {
    if (first) { first = false; started.resolve(); await gate.promise; }
    return read(file);
  };
  const promise = f.context.syncLinks(); await started.promise;
  assert.equal(f.diag.causal.hasWork(), false);
  const before = f.diag.summaries('tabContext.syncLinks.links');
  assert.equal(before.length, 1); assert.equal(before[0].counters.tabsVisited, 2);
  f.diag.advance(20000); gate.resolve(); await promise;
  const passes = f.diag.summaries('tabContext.syncLinks.links');
  assert.equal(passes.length, 2); assert.equal(passes[1].counters.tabsVisited, 1);
  assert.ok(passes.every(s => s.wallMs < 2000));
  assert.equal(f.diag.summaries('tabContext.syncLinks.reconcile')[0].counters.tabsVisited, 3);
  assert.equal(f.watches.length, 1);
  assert.deepEqual(total(f.diag.summaries()), counts(f.db.calls), 'every real prepare/read/write has executing work');
  assert.equal(f.diag.causal.snapshot().workHealth.sqlOutsideWork, 0);
  assert.equal(f.context.get('owner').files[0].error, null);
});

test('post-await file decode/hash/diff/writes and watcher SELECT have their own actual work', async t => {
  const f = contextFixture(t);
  await f.diag.causal.run('registration', { readId: 'registration' }, () => f.context.syncLinks());
  const other = path.join(f.dir, 'other.md'); fs.writeFileSync(other, 'other\n');
  f.db.prepare('INSERT INTO tab_context_files(tab_id,path) VALUES(?,?)').run('archived', other);
  f.diag.reset(); f.db.calls.length = 0; f.changes.length = 0;
  fs.writeFileSync(f.filePath, 'after\n');
  f.watches[0].callback('change', path.basename(f.filePath));
  const watched = f.diag.summaries('tabContext.watchEvent')[0];
  assert.equal(watched.parentSpanId, null); assert.deepEqual(watched.counts, [1, 0, 1, 0]);
  assert.equal(watched.counters.watchEvents, 1); assert.equal(watched.counters.pathsVisited, 2); assert.equal(watched.counters.matchedPaths, 1);
  await Promise.all([...f.context.reads.values()]);
  const consumed = f.diag.summaries('tabContext.readFile.consume')[0];
  assert.equal(consumed.counters.fileHashes, 1); assert.ok(consumed.counters.diffs > 0);
  assert.equal(consumed.counters.notifications, 1); assert.equal(f.changes.length, 1);
  assert.ok(consumed.counts[3] >= 3); assert.ok(f.diag.summaries('tabContext.readFile.decode').length > 0);
  assert.deepEqual(total(f.diag.summaries()), counts(f.db.calls));
  assert.ok(!JSON.stringify(f.diag.events).includes(f.dir));
  assert.ok(!JSON.stringify(f.diag.events).includes('after\\n'));
  const update = f.context.get('owner').updates.find(u => u.status === 'pending');
  assert.ok(update, 'actual file update exists');
  f.diag.reset();
  const prepared = await f.context.prepare('owner', 'handoff', 'private prompt');
  assert.deepEqual(await f.context.prepare('owner', 'handoff', 'private prompt'), prepared, 'same frozen prompt receipt');
  f.context.confirm('owner', 'handoff', 'wrong');
  assert.equal(f.context.get('owner').updates[0].status, 'sending');
  const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
  f.context.confirm('owner', 'handoff', promptAuditFingerprint(prepared.prompt));
  assert.deepEqual(f.context.get('owner').updates, []);
  assert.equal(f.db.prepare('SELECT status FROM tab_context_updates WHERE tab_id=?').get('owner').status, 'delivered');
});

test('OFF preserves catalog return identity, SQL freshness and zero diagnostic clocks/sink events', t => {
  const f = catalogFixture(t, { n: 4, watch: false });
  f.diag.causal.configure({ enabled: false }); f.reset();
  const before = f.diag.clockReads();
  const first = f.service.listTab(f.tabs[0]); const second = f.service.listTab(f.tabs[0]);
  assert.equal(second, first); assert.equal(f.diag.clockReads(), before); assert.equal(f.diag.events.length, 0);
  assert.equal(f.db.calls.filter(c => c.operation === 'get' && c.sql.includes('workflow_root_scope_meta')).length, 2);
});

test('static boundary IDs/counters are bounded and no syncWork callback is async', () => {
  const ts = require('typescript');
  for (const name of ['workflow-root-registry.js', 'project-prompt-catalog.js', 'agent-session-availability.js', 'database.js', 'tab-work-context.js']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const inspect = node => {
      if (ts.isCallExpression(node)) {
        const target = node.expression.getText(ast);
        if (['causal.syncWork', 'causal.sql', 'causal.count', 'sqlStatement'].includes(target) && ts.isStringLiteral(node.arguments[0])) {
          assert.match(node.arguments[0].text, target === 'causal.count' ? /^[\w.:-]{1,48}$/ : /^[\w.:-]{1,64}$/, name);
        }
        if (target === 'causal.syncWork') {
          const callback = node.arguments[2];
          if (ts.isArrowFunction(callback)) {
            assert.ok(!callback.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), name);
            const checkAwait = part => {
              if (part !== callback && ts.isFunctionLike(part)) return;
              assert.notEqual(part.kind, ts.SyntaxKind.AwaitExpression, name);
              ts.forEachChild(part, checkAwait);
            };
            checkAwait(callback);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(ast);
  }
});
