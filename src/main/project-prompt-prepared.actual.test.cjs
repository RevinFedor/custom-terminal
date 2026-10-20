'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ProjectPromptCatalogService, scanSource } = require('./project-prompt-catalog');
const { createCatalogControl, stableSort, copyMetadata } = require('./prompt-catalog-cooperative');
const { orderEntries, captureLayout } = require('./prompt-catalog-source');
const { causal } = require('./perf-causal-context');
const support = require('./project-prompt-catalog.test-support.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('unrelated parent-sentinel events do not schedule all-consumer catalog reconciliation', async t => {
  const f = fixture(t, { n: 32 });
  await support.tab(f.s, 'tab-0');
  const p = f.s.prepared, slot = p.slots.get(f.a);
  const entry = { key: 's:' + f.root, target: f.root, recursive: false,
    slots: new Set([slot]), retired: false };
  p.watchers.set(entry.key, entry);
  const before = { reconciliations: p.counters.reconciliations, epoch: slot.epoch,
    changes: f.changes.length };
  for (const name of ['unrelated.sqlite-wal', 'another-project', 'a-other'])
    p.watchEvent(entry, 'rename', name);
  await tick(); // Flush the handler's scheduled setImmediate, not a readiness delay.
  assert.equal(p.counters.reconciliations, before.reconciliations,
    'sibling I/O must not start a fresh read of every tab scope');
  assert.equal(slot.epoch, before.epoch);
  assert.equal(f.changes.length, before.changes);
});

for (const filename of ['a', null]) test(`relevant/unknown sentinel ${filename} still revokes and reconciles`, async t => {
  const f = fixture(t); await support.tab(f.s, 'tab-0');
  const p = f.s.prepared, slot = p.slots.get(f.a);
  const entry = { key: 's:' + f.root, target: f.root, recursive: false,
    slots: new Set([slot]), retired: false };
  p.watchers.set(entry.key, entry);
  const epoch = slot.epoch, reconciliations = p.counters.reconciliations;
  p.watchEvent(entry, 'rename', filename);
  assert.ok(slot.epoch > epoch, 'revoke is synchronous before any async observation');
  await tick();
  assert.ok(p.counters.reconciliations > reconciliations);
});

test('a descendant reported by a nonrecursive backend keeps conservative topology reconciliation', async t => {
  const f = fixture(t); await support.tab(f.s, 'tab-0');
  const p = f.s.prepared, slot = p.slots.get(f.a);
  const entry = { key: 's:' + f.root, target: f.root, recursive: false,
    slots: new Set([slot]), retired: false };
  p.watchers.set(entry.key, entry);
  const before = p.counters.reconciliations;
  p.watchEvent(entry, 'rename', 'a/docs/nested/own.prompt.md');
  await tick();
  assert.ok(p.counters.reconciliations > before);
});
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t, { watch = false, n = 2 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog46-')));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  for (const dir of [a, b]) { fs.mkdirSync(path.join(dir, 'docs'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs', 'same.prompt.md'), 'private fixture'); }
  const row = rootPath => ({ rootPath, projectId: 'original-P', rootId: rootPath, id: rootPath, enabled: true, extra: ['detached'] });
  const bindings = new Map(Array.from({ length: n }, (_, i) => ['tab-' + i, [row(a)]]));
  const projects = new Map([['original-P', { id: 'original-P', name: 'Project', path: a }]]);
  let epoch = 0;
  const registry = { sourcesForTab: id => bindings.get(id) || [],
    createSourcesReader: () => id => registry.sourcesForTab(id),
    listSourceScopes: () => [...bindings.keys()].sort().map(tabId => ({ id: 'tab:' + tabId, tabId, name: tabId })),
    read: () => ({ roots: [], version: 1, revision: 1 }),
  };
  const db = { getProjectById: id => projects.get(id), getProjectPromptSources: id => [row(a)], getProjectsWithPromptSources: () => [...projects.values()] };
  const counts = { opendir: 0, readdirSync: 0, body: 0, handles: 0, closed: 0, stats: 0, watch: 0 };
  const watches = [];
  const io = { ...fs, readdirSync(...args) { counts.readdirSync++; return fs.readdirSync(...args); },
    readFileSync() { counts.body++; throw Error('body read'); }, watch(target, options, callback) {
      counts.watch++; const handle = new EventEmitter(); handle.callback = callback; handle.target = target; handle.options = options;
      handle.closed = false; handle.close = () => { if (!handle.closed) { handle.closed = true; handle.emit('close'); } }; watches.push(handle); return handle;
    } };
  const asyncFs = { stat: async (...args) => { counts.stats++; return fs.promises.stat(...args); },
    lstat: (...args) => fs.promises.lstat(...args), realpath: (...args) => fs.promises.realpath(...args),
    opendir: async (...args) => { counts.opendir++; const handle = await fs.promises.opendir(...args); counts.handles++;
      return { read: () => handle.read(), close: async () => { await handle.close(); counts.handles--; counts.closed++; } }; } };
  const changes = [];
  const s = new ProjectPromptCatalogService({ db, rootRegistry: registry, fsImpl: io, asyncFs, watch,
    authorityFence: () => ({ connection: db, schema: 1, external: epoch, changes: 0, committed: 0, transaction: false }), onChanged: p => changes.push(p) });
  t.after(() => { s.close(); assert.equal(counts.handles, 0); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, a, b, row, bindings, projects, registry, db, counts, io, asyncFs, watches, changes, s,
    mutate(fn) { fn(); epoch++; }, setEpoch(value) { epoch = value; }, epoch: () => epoch,
    watch: target => watches.filter(w => !w.closed && w.target === target).at(-1) };
}
test('constructor and compatibility reconciliation defer all authority/FS traversal; cold prepares, publication event wakes', async t => {
  const f = fixture(t, { watch: true });
  assert.equal(f.counts.opendir, 0); assert.equal(f.counts.stats, 0); assert.equal(f.counts.watch, 0);
  await assert.rejects(f.s.listTab('tab-0'), { code: 'prompt_catalog_preparing' });
  const ready = await support.tab(f.s, 'tab-0'); assert.equal(ready.prompts.length, 1);
  assert.ok(f.changes.some(p => p.state === 'ready')); assert.equal(f.counts.readdirSync, 0); assert.equal(f.counts.body, 0);
});
test('warm after1501ms and much later has zero discovery/watch passes; fresh exact bindings and detached DTO remain', async t => {
  const f = fixture(t), first = await support.tab(f.s, 'tab-0');
  const scans = f.counts.opendir, reconciliation = f.s.prepared.counters.reconciliations, now = Date.now;
  try {
    for (const jump of [1501, 1000000]) { Date.now = () => now() + jump; const next = await f.s.listTab('tab-0');
      assert.equal(next.prompts[0].id, first.prompts[0].id); assert.notEqual(next.prompts, first.prompts); }
  } finally { Date.now = now; }
  assert.equal(f.counts.opendir, scans); assert.equal(f.counts.readdirSync, 0);
  assert.equal(f.s.prepared.counters.reconciliations, reconciliation);
  const next = await f.s.listTab('tab-0'); next.prompts[0].file_paths.push('/foreign'); next.sources[0].extra.push('mutated');
  assert.equal((await f.s.listTab('tab-0')).prompts[0].file_paths.length, 1);
  assert.deepEqual((await f.s.listTab('tab-0')).sources[0].extra, ['detached']);
  f.bindings.set('tab-0', []); assert.deepEqual((await f.s.listTab('tab-0')).prompts, []);
});
test('retained synchronous scanner oracle preserves full order/IDs/labels/positions, visual children and legitimate same-title paths', async t => {
  const f = fixture(t); const docs = path.join(f.a, 'docs');
  fs.mkdirSync(path.join(docs, 'folder')); fs.mkdirSync(path.join(docs, 'node_modules')); fs.mkdirSync(path.join(docs, 'tmp'));
  for (const name of ['10.prompt.md', '2.prompt.md', 'parent.md', 'other.prompt.md', '.hidden.prompt.md']) fs.writeFileSync(path.join(docs, name), 'private');
  fs.writeFileSync(path.join(docs, 'tmp', 'same.prompt.md'), 'private'); fs.writeFileSync(path.join(docs, 'node_modules', 'copied.prompt.md'), 'private');
  const layout = { orderByParent: { [docs]: [path.join(docs, 'parent.md'), path.join(docs, '10.prompt.md')] },
    visualParentByPath: { [path.join(docs, 'other.prompt.md')]: path.join(docs, 'parent.md') } };
  f.s.layoutStore = { get: () => ({ revision: 1, layout }) };
  f.bindings.set('tab-0', [f.row(f.a), { ...f.row(f.b), enabled: false }]);
  // The legacy scanner remains an independent synchronous implementation. Do
  // not require an author's already-cleaned /private/tmp source capture.
  const expected = scanSource({ projectId: 'original-P', rootPath: f.a, sourceName: 'a', layout });
  const current = await support.tab(f.s, 'tab-0');
  assert.deepEqual(current.prompts, expected.prompts);
  assert.deepEqual(current.sources, [{ ...f.row(f.a), sourceName: 'a', docsPath: docs,
    exists: true, docsExists: true, promptCount: expected.prompts.length }]);
  assert.equal(current.prompts.filter(p => p.title === 'same').length, 2);
  assert.ok(!current.prompts.some(p => p.path.includes('node_modules')));
});
test('usage consumes full prepared inventory, keeps archives and namespace/project freshness, no body reads', async t => {
  const f = fixture(t, { n: 8 }); const docs = path.join(f.a, 'docs');
  fs.mkdirSync(path.join(docs, 'unrelated')); fs.writeFileSync(path.join(docs, 'unrelated', 'other.prompt.md'), 'private');
  const all = await support.usage(f.s, f.a); assert.equal(all.length, 2); assert.equal(all[0].tabs.length, 8);
  const scans = f.counts.opendir; f.projects.get('original-P').name = 'Renamed';
  assert.equal((await f.s.usageForRoot('/'))[0].projects[0].name, 'Renamed'); assert.equal(f.counts.opendir, scans);
  const narrower = await f.s.usageForRoot(path.join(docs, 'unrelated')); assert.equal(narrower.length, 1);
  assert.equal((await f.s.listTab('tab-0')).prompts.length, 2); assert.equal(f.counts.body, 0);
  assert.equal(f.s.tabCache.size, 0, 'no archived tab prompt arrays');
});
test('failed preparation is explicit, never partial success or a read-triggered retry; explicit invalidation recovers', async t => {
  const f = fixture(t); const open = f.asyncFs.opendir, failure = Object.assign(Error('controlled async FS failure'), { code: 'EIO' });
  f.asyncFs.opendir = async () => { throw failure; };
  await assert.rejects(support.tab(f.s, 'tab-0'), { code: 'prompt_catalog_failed' });
  const attempts = f.s.prepared.counters.preparations;
  await assert.rejects(f.s.listTab('tab-0'), { code: 'prompt_catalog_failed' }); assert.equal(f.s.prepared.counters.preparations, attempts);
  f.asyncFs.opendir = open; f.s.invalidateTabs(null, 'explicit-refresh'); assert.equal((await support.tab(f.s, 'tab-0')).prompts.length, 1);
});
test('sync-only fake is refused rather than secretly using real fs.promises', () => {
  assert.throws(() => new ProjectPromptCatalogService({ db: {}, watch: false, fsImpl: { statSync() {}, readdirSync() {} } }), { code: 'prompt_catalog_async_fs_required' });
});
for (const macro of [true, false]) for (const stage of ['sort', 'visual', 'layout', 'mapping']) {
  test(`${stage} large-stage ${macro ? 'real macrotask' : 'negative microtask'} sentinel`, async () => {
    let sentinel = false; setImmediate(() => { sentinel = true; });
    const c = createCatalogControl({ maxSteps: 256, targetMs: Infinity, ...(macro ? {} : { schedule: () => Promise.resolve() }) });
    if (stage === 'sort') {
      const result = await stableSort(Array.from({ length: 1024 }, (_, i) => 1024 - i), (a, b) => a - b, c); assert.equal(result[0], 1);
    } else if (stage === 'visual') {
      const rows = Array.from({ length: 700 }, (_, i) => ({ name: String(i), path: '/docs/' + i, isDirectory: false }));
      const result = await orderEntries(rows, '/docs', '/', { visualParentByPath: {} }, c); assert.equal(result.length, rows.length);
    } else if (stage === 'layout') {
      const result = await captureLayout({ get: () => ({ layout: { orderByParent: { '/docs': Array.from({ length: 700 }, (_, i) => '/docs/' + i) } } }) }, '/', c); assert.ok(result.stamp);
    } else await copyMetadata({ items: Array.from({ length: 700 }, (_, i) => ({ id: i })) }, c);
    assert.equal(sentinel, macro); assert.ok(c.fields.yields > 0); await tick(); assert.equal(sentinel, true);
  });
}
test('256-step and2ms clocks are distinct; one long unit not clipped, safe scalar microseconds', async () => {
  for (const timed of [false, true]) {
    let clock = 0, n = 0; const marks = [];
    const c = createCatalogControl({ now: () => clock, schedule: async () => { marks.push(n); await tick(); } });
    for (let i = 0; i < 512; i++) await c.step('map', () => { n++; if (timed) clock++; });
    assert.deepEqual(marks, timed ? Array.from({ length: 256 }, (_, i) => (i + 1) * 2) : [256, 512]);
  }
  let clock = 0; const c = createCatalogControl({ now: () => clock, schedule: async () => { clock += 100; } });
  assert.equal(await c.step('map', () => { clock += 20; return 'complete'; }), 'complete');
  assert.equal(c.finish().maxUnitUs, 20000); assert.equal(c.fields.mapUs, 20000);
  assert.ok(Object.values(c.fields).every(Number.isSafeInteger));
});
test('one active source and one queued latest epoch; obsolete drops and unrelated source progresses', async t => {
  const f = fixture(t); f.bindings.set('tab-1', [f.row(f.b)]);
  const entered = gate(), release = gate(); let held = false;
  const open = f.asyncFs.opendir;
  f.asyncFs.opendir = async dir => { if (!held && dir === path.join(f.a, 'docs')) { held = true; entered.resolve(); await release.promise; } return open(dir); };
  await assert.rejects(f.s.listTab('tab-0'), { code: 'prompt_catalog_preparing' }); await entered.promise;
  await assert.rejects(f.s.listTab('tab-1'), { code: 'prompt_catalog_preparing' });
  const slot = f.s.prepared.slots.get(f.a); for (let i = 0; i < 20; i++) f.s.prepared.markDirty(slot, 'controlled burst');
  assert.equal(f.s.prepared.queue.filter(s => s === slot).length, 1); release.resolve();
  const value = await support.tab(f.s, 'tab-0'); assert.equal(value.prompts.length, 1);
  assert.equal((await support.tab(f.s, 'tab-1')).prompts.length, 1); assert.ok(f.s.prepared.counters.obsolete >= 1);
  const publications = f.changes.filter(p => p.state === 'ready'); assert.ok(publications.length >= 2);
});
test('missing root/docs recover with nonrecursive parent sentinels; rename/unknown revokes before debounce', async t => {
  const f = fixture(t, { watch: true }); const missing = path.join(f.root, 'new', 'deep');
  f.bindings.set('tab-0', [f.row(missing)]);
  let value = await support.tab(f.s, 'tab-0'); assert.equal(value.sources[0].exists, false); assert.equal(value.prompts.length, 0);
  assert.ok(f.watches.some(w => !w.options.recursive && w.target === f.root));
  fs.mkdirSync(path.join(missing, 'docs'), { recursive: true }); fs.writeFileSync(path.join(missing, 'docs', 'back.prompt.md'), 'private');
  f.watch(f.root).callback('rename', 'new');
  await assert.rejects(f.s.listTab('tab-0'), e => ['prompt_catalog_preparing', 'prompt_catalog_changed'].includes(e.code));
  value = await support.tab(f.s, 'tab-0'); assert.equal(value.prompts[0].title, 'back');
  const watch = f.watch(path.join(missing, 'docs')); watch.callback('rename', null);
  assert.equal(f.s.prepared.slots.get(missing).state, 'preparing', 'synchronous revocation');
  await support.tab(f.s, 'tab-0');
});
test('old same-path watcher callbacks/error/close cannot invalidate replacement; observation loss not false ready', async t => {
  const f = fixture(t, { watch: true }); await support.tab(f.s, 'tab-0'); const docs = path.join(f.a, 'docs'), old = f.watch(docs);
  fs.renameSync(docs, docs + '-old'); fs.mkdirSync(docs); fs.writeFileSync(path.join(docs, 'replacement.prompt.md'), 'private');
  assert.equal((await support.tab(f.s, 'tab-0')).prompts[0].title, 'replacement');
  const slot = f.s.prepared.slots.get(f.a), epoch = slot.epoch;
  old.callback('rename', null); old.emit('error', Error('old')); assert.equal(slot.epoch, epoch);
  const current = f.watch(docs); current.emit('error', Error('controlled loss')); assert.equal(slot.state, 'preparing');
  await support.tab(f.s, 'tab-0'); assert.notEqual(f.watch(docs), current);
});
test('aliases retain separate spelling/layout/IDs and retarget revokes; leaf UNKNOWN uses lexical fallback', async t => {
  const f = fixture(t); const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.a, alias, 'dir'); f.bindings.set('alias-tab', [f.row(alias)]);
  await support.tab(f.s, 'alias-tab'); await support.tab(f.s, 'tab-0');
  assert.equal(f.s.prepared.slots.size, 2);
  const results = await f.s.usageForRoot(f.a); assert.equal(results.length, 2); assert.notEqual(results[0].path, results[1].path);
  fs.unlinkSync(alias); fs.symlinkSync(f.b, alias, 'dir');
  await support.tab(f.s, 'alias-tab'); const actual = f.asyncFs.realpath;
  f.asyncFs.realpath = async file => { if (file === path.join(alias, 'docs', 'same.prompt.md')) throw Object.assign(Error('leaf unknown'), { code: 'EACCES' }); return actual(file); };
  const insideAlias = await f.s.usageForRoot(f.root); assert.ok(insideAlias.some(row => row.path === path.join(alias, 'docs', 'same.prompt.md')));
});
test('aggregate local/external change allows one authority re-pass; second instability refuses and no FS rescan', async t => {
  const f = fixture(t); await support.tab(f.s, 'tab-0'); const scans = f.counts.opendir;
  let once = false; f.s.prepared.controlOptions = { maxSteps: 1, schedule: async () => { await tick(); if (!once) { once = true; f.mutate(() => f.bindings.set('tab-0', [])); } } };
  assert.deepEqual((await f.s.listTab('tab-0')).prompts, []); assert.equal(f.counts.opendir, scans);
  f.bindings.set('tab-0', [f.row(f.a)]); f.s.prepared.controlOptions.schedule = async () => { await tick(); f.setEpoch(f.epoch() + 1); };
  await assert.rejects(f.s.listTab('tab-0'), { code: 'prompt_catalog_changed' }); assert.equal(f.counts.opendir, scans);
});
test('future exact scope/layout errors are not hidden by disjoint usage or preceding preparing', async t => {
  const f = fixture(t); const read = f.registry.sourcesForTab;
  f.registry.sourcesForTab = id => { if (id === 'tab-1') throw Object.assign(Error('future'), { code: 'root_binding_forward_version' }); return read(id); };
  await assert.rejects(f.s.usageForRoot('/unrelated'), { code: 'root_binding_forward_version' });
  f.registry.sourcesForTab = read; const failure = Error('controlled layout failure'); f.s.layoutStore = { get() { throw failure; } };
  await assert.rejects(f.s.usageForRoot('/unrelated'), e => e === failure);
});
test('late causal settle invalidation cannot publish stale read success', async t => {
  const f = fixture(t); await support.tab(f.s, 'tab-0'); let once = false;
  causal.configure({ enabled: true, sink: e => { if (!once && e.phase === 'settle' && e.name === 'catalog.listTab') { once = true; f.mutate(() => f.bindings.set('tab-0', [])); } return true; } });
  try { assert.deepEqual((await f.s.listTab('tab-0')).prompts, []); assert.ok(once); }
  finally { causal.configure({ enabled: false }); }
});
test('content-only verified prompt change avoids rebuild; excluded dependency descendants ignored; stale timer/closed lifetime sealed', async t => {
  const f = fixture(t, { watch: true }); await support.tab(f.s, 'tab-0'); const docs = path.join(f.a, 'docs'), watch = f.watch(docs);
  const scanned = f.counts.opendir; fs.writeFileSync(path.join(docs, 'same.prompt.md'), 'different body'); watch.callback('change', 'same.prompt.md');
  await support.tab(f.s, 'tab-0'); assert.equal(f.counts.opendir, scanned);
  const slot = f.s.prepared.slots.get(f.a), epoch = slot.epoch; watch.callback('rename', 'node_modules/x.prompt.md'); assert.equal(slot.epoch, epoch);
  watch.callback('rename', null); const old = f.s.prepared; f.s.close(); const current = f.s.preparation();
  watch.callback('rename', null); assert.equal(old.closed, true); assert.notEqual(old, current); assert.equal(current.slots.size, 0);
  await support.tab(f.s, 'tab-0'); assert.equal(f.counts.body, 0);
});
test('stale timer cannot clear a new same-slot timer; debounce deadline belongs to first event', async t => {
  const f = fixture(t, { watch: true }); await support.tab(f.s, 'tab-0');
  const timers = []; t.mock.method(global, 'setTimeout', (fn, ms) => { const timer = { fn, ms, unref() {}, ref() {} }; timers.push(timer); return timer; });
  t.mock.method(global, 'clearTimeout', () => {});
  const slot = f.s.prepared.slots.get(f.a), watch = f.watch(path.join(f.a, 'docs'));
  watch.callback('rename', null); const first = slot.timer;
  watch.callback('rename', null); assert.equal(slot.timer, first); assert.equal(first.ms, 180);
  slot.timer = null; watch.callback('rename', null); const replacement = slot.timer;
  first.fn(); assert.equal(slot.timer, replacement, 'old callback has no authority over new handle');
  assert.notEqual(first, replacement); replacement.fn(); await support.tab(f.s, 'tab-0');
});
test('obsolete layout observation requeues latest once; endless unnotified layout churn is explicit failure', async t => {
  const f = fixture(t); let reads = 0;
  f.s.layoutStore = { get: () => ({ revision: ++reads, layout: {} }) };
  await assert.rejects(support.tab(f.s, 'tab-0'), { code: 'prompt_catalog_failed' });
  assert.equal(f.s.prepared.counters.publications, 0);
  assert.equal(f.s.prepared.counters.preparations, 2, 'no readiness/retry spin');
  f.s.layoutStore = { get: () => ({ revision: 10, layout: {} }) }; f.s.invalidateTabs(null, 'explicit-refresh');
  assert.equal((await support.tab(f.s, 'tab-0')).prompts.length, 1);
});
test('policy, slot instance and closed lifetime revoke in-flight candidate publication', async t => {
  const f = fixture(t), entered = gate(), release = gate(), open = f.asyncFs.opendir;
  f.asyncFs.opendir = async (...args) => { entered.resolve(); await release.promise; return open(...args); };
  await assert.rejects(f.s.listTab('tab-0'), { code: 'prompt_catalog_preparing' }); await entered.promise;
  const policy = require('../shared/prompt-source-policy.cjs'), prior = policy.PROMPT_SOURCE_POLICY_VERSION;
  policy.PROMPT_SOURCE_POLICY_VERSION = 2;
  try {
    release.resolve(); await assert.rejects(support.tab(f.s, 'tab-0'), { code: 'prompt_catalog_failed' });
    assert.equal(f.s.prepared.counters.publications, 0);
  } finally { policy.PROMPT_SOURCE_POLICY_VERSION = prior; }
  f.s.invalidateTabs(null, 'explicit-refresh'); await support.tab(f.s, 'tab-0');
  const old = f.s.prepared, slot = old.slots.get(f.a); old.removeSlot(slot); const newer = old.slot(f.a);
  assert.throws(() => old.current(slot, slot.epoch, null, old.lifetime, 1), { code: 'prompt_catalog_obsolete' });
  assert.notEqual(slot, newer); f.s.close(); assert.throws(() => old.assertOpen(), { code: 'prompt_catalog_unavailable' });
});
test('async read/close failures preserve failure, close directory handle and never publish partial metadata', async t => {
  const f = fixture(t), open = f.asyncFs.opendir, failure = Object.assign(Error('read failure'), { code: 'EIO' });
  f.asyncFs.opendir = async (...args) => { const handle = await open(...args); return { read: async () => { throw failure; }, close: () => handle.close() }; };
  await assert.rejects(support.tab(f.s, 'tab-0'), { code: 'prompt_catalog_failed' }); assert.equal(f.counts.handles, 0); assert.equal(f.s.prepared.counters.publications, 0);
  f.asyncFs.opendir = async (...args) => { const handle = await open(...args); return { read: () => handle.read(), close: async () => { await handle.close(); throw failure; } }; };
  f.s.invalidateTabs(null, 'explicit-refresh'); await assert.rejects(support.tab(f.s, 'tab-0'), { code: 'prompt_catalog_failed' }); assert.equal(f.counts.handles, 0);
});
for (const macro of [true, false]) test(`actual usage project sorting ${macro ? 'macrotask' : 'microtask negative'} runs inside large stage`, async t => {
  const f = fixture(t, { n: 0 });
  for (let i = 0; i < 300; i++) { const id = 'P' + i; f.projects.set(id, { id, name: 'Project ' + (300 - i) }); f.bindings.set('tab-' + i, [{ ...f.row(f.a), projectId: id }]); }
  await support.tab(f.s, 'tab-0');
  const originalControl = f.s.prepared.control.bind(f.s.prepared); let checked = false;
  f.s.prepared.control = check => {
    const c = originalControl(check); const drain = c.drain.bind(c); c.drain = async (stage, iterator) => {
      let n = 0, sentinel = false;
      const wrapped = { next() { const v = iterator.next(); if (++n === 257) setImmediate(() => { sentinel = true; }); return v; }, return: () => iterator.return?.() };
      const result = await drain(stage, wrapped);
      if (stage === 'sort' && n > 512) { assert.equal(sentinel, macro); checked = true; }
      return result;
    }; return c;
  };
  f.s.prepared.controlOptions = { maxSteps: 256, targetMs: Infinity, ...(macro ? {} : { schedule: () => Promise.resolve() }) };
  const use = await f.s.usageForRoot(f.a); assert.equal(use[0].projects.length, 300); assert.ok(checked); await tick();
});
test('fixed scalar diagnostic has explicit loss and no content/path/arrays; sink/notification failures preserve prepared state', async t => {
  const f = fixture(t); await support.tab(f.s, 'tab-0'); const lines = [], log = console.log;
  console.log = value => lines.push(JSON.parse(value.slice('[PromptCatalog] '.length)));
  try { await f.s.listTab('tab-0'); } finally { console.log = log; }
  assert.ok(lines.length > 0);
  for (const row of lines) { assert.ok(!Object.values(row).some(Array.isArray)); assert.ok(!Object.keys(row).some(k => /body|path|title|query/i.test(k))); assert.equal(row.mode, 'prepared-source-metadata'); }
  const c = f.s.prepared.control(); console.log = () => { throw Error('sink'); };
  try { assert.doesNotThrow(() => f.s.prepared.diagnostic('read', c)); } finally { console.log = log; }
  assert.equal(f.s.prepared.counters.diagnosticLoss, 1);
  f.s.onChanged = () => { throw Error('notify'); }; f.s.prepared.changed({ state: 'ready' }); assert.equal(f.s.prepared.counters.notificationLoss, 1);
  assert.equal((await f.s.listTab('tab-0')).prompts.length, 1);
});
test('explicit recovery revokes immediately and rebinds coverage after a silently lost nested event', async t => {
  const f = fixture(t, { watch: true }), nested = path.join(f.a, 'docs', 'nested'); fs.mkdirSync(nested);
  await support.tab(f.s, 'tab-0'); const old = f.watch(path.join(f.a, 'docs'));
  fs.writeFileSync(path.join(nested, 'lost.prompt.md'), 'private');
  assert.equal((await f.s.listTab('tab-0')).prompts.length, 1, 'event-only limit is retained, not fabricated detection');
  f.s.refreshWatchers({ recovery: true }); assert.equal(f.s.prepared.slots.get(f.a).state, 'preparing');
  assert.equal((await support.tab(f.s, 'tab-0')).prompts.length, 2); assert.notEqual(f.watch(path.join(f.a, 'docs')), old); assert.equal(old.closed, true);
});
test('public committed layout seam revokes exact configured root synchronously, no other source work or commit exception', async t => {
  const f = fixture(t); f.bindings.set('tab-1', [f.row(f.b)]);
  fs.writeFileSync(path.join(f.a, 'docs', 'second.prompt.md'), 'private');
  const layouts = new Map(); f.s.layoutStore = { get: root => ({ revision: layouts.has(root) ? 1 : 0, layout: layouts.get(root) || {} }) };
  await support.tab(f.s, 'tab-0'); await support.tab(f.s, 'tab-1');
  const other = f.s.prepared.slots.get(f.b), otherEpoch = other.epoch, scans = f.counts.opendir;
  layouts.set(f.a, { orderByParent: { [path.join(f.a, 'docs')]: [path.join(f.a, 'docs', 'second.prompt.md')] } });
  const committed = { ok: true, revision: 1 };
  assert.deepEqual(f.s.onLayoutCommitted(f.a), { scheduled: true, state: 'preparing' });
  assert.equal(f.s.prepared.slots.get(f.a).state, 'preparing'); assert.equal(other.epoch, otherEpoch); assert.equal(f.counts.opendir, scans, 'seam itself traverses nothing');
  assert.equal((await support.tab(f.s, 'tab-0')).prompts[0].title, 'second'); assert.equal(other.epoch, otherEpoch);
  f.s.onChanged = () => { throw Error('notification'); }; assert.doesNotThrow(() => f.s.onLayoutCommitted(f.a)); assert.equal(committed.ok, true);
  const before = f.s.prepared.counters.preparations; assert.equal(f.s.onLayoutCommitted(path.join(f.root, 'unbound')).scheduled, false); assert.equal(f.s.prepared.counters.preparations, before);
});
