'use strict';

// One finite Node/SQLite process; no Electron, worker, app/profile or provider.
// Use --max-old-space-size=80 --max-semi-space-size=4 and the explicit existing
// node:sqlite test adapter. Each owned family is capped at 24 MiB.
process.env.NOTED_HISTORY_READER_PROCESS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), v8 = require('node:v8');
const crypto = require('node:crypto'), Module = require('node:module');
const { performance } = require('node:perf_hooks');
const { AsyncLocalStorage } = require('node:async_hooks');
const evidence = process.env.NOTED_BACKING_TEST_EVIDENCE;
assert(evidence && path.isAbsolute(evidence));
const SQLite = require(process.env.NOTED_UNIT_TEST_SQLITE_ADAPTER);
const load = Module._load;
Module._load = function(id, parent, main) {
  return id === 'better-sqlite3' ? SQLite : load.call(this, id, parent, main);
};
const { HistoryPagedStore, materializeHistoryCursorSync: mat } = require('./history-paged-store');
const { HistoryRootController } = require('./history-root-controller');
const { createReadControl } = require('./history-read-control');
const MiB = 1024 ** 2;
assert(v8.getHeapStatistics().heap_size_limit <= 128 * MiB);
const control = createReadControl();
const namespace = 'codex-canonical-read-plane-v1:startup-finite';
const base = (schema, id) => JSON.stringify([schema, id, '/synthetic']);
const current = base(namespace, 'current-owner');
const obsolete = base('codex-canonical-read-plane-v1:old-parser', 'obsolete');
const text = 'x'.repeat(511) + '🙂Ω\r\n\0' + String.fromCharCode(0xd800) + 'y'.repeat(14000);
const hash = s => crypto.createHash('sha256').update(s, 'utf16le').digest('hex');
const same = (a, b) => { assert.equal(a.length, b.length); assert.equal(hash(a), hash(b)); assert.equal(a, b); };
const sqlCount = s => Number(s.sql('SELECT count(*) AS n FROM hp_pages').get().n);
const phase = s => s.sql("SELECT value FROM hp_meta WHERE key='gc_phase'").get().value;
const ids = s => s.sql('SELECT id FROM hp_pages ORDER BY id').all().map(r => r.id);
const reachable = s => s.sql(`WITH RECURSIVE live(id) AS (
  SELECT page FROM hp_pins UNION SELECT child FROM hp_edges JOIN live ON parent=live.id
) SELECT id FROM live ORDER BY id`).all().map(r => r.id);
function finish(s, work = 64) {
  let reclaimed = 0, units = 0;
  for (let n = 0; n < 100000; n++) {
    const r = s.collectStep(work); reclaimed += r.reclaimed; units += r.work;
    assert(r.work <= work);
    if (r.complete) return { reclaimed, units };
    assert(!r.blockedByBuilders);
  }
  assert.fail('finite collection did not finish');
}
function fixture(t, seed, Controller = HistoryRootController, budget = 24 * MiB) {
  const dir = fs.mkdtempSync(path.join(evidence, 'sqlite-'));
  const cache = { baseDirectory: dir, maxBytes: 32 * MiB, prune() {}, stats: () => ({ diskBytes: 0 }) };
  const filename = path.join(dir, 'paged-read-plane', 'pages.sqlite');
  fs.mkdirSync(path.dirname(filename));
  const open = () => new HistoryPagedStore({ filename, Database: SQLite, diskBytes: budget });
  let seeded = open(); seed?.(seeded);
  // Exact finite crash/reopen: preserve previous transient pins on disk.
  seeded.db.close(); seeded.closed = true; seeded = null;
  const ctl = new Controller({ cache, service: {},
    api: { projectCodexFullHistoryFromFile: async () => { throw Error('source not assigned in this control'); } },
    Database: SQLite, sourceSchema: 'startup-finite', rootDiskBudgetBytes: budget });
  ctl.ensurePlane();
  t.after(() => {
    ctl.close();
    assert(ctl.store.diskUsage() <= budget);
    fs.rmSync(dir, { recursive: true });
    assert(!fs.existsSync(dir));
  });
  return { ctl, s: ctl.store, dir };
}
function pin(s, name, body) {
  const lease = s.captureLegacy(body); s.replaceRootPin(name, lease.descriptor); lease.release();
}
const logs = [], request = new AsyncLocalStorage(), originalLog = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith('[HistoryRootBacking] ')) {
    assert(logs.length < 2000);
    logs.push({ request: request.getStore(), ...JSON.parse(args[0].slice('[HistoryRootBacking] '.length)) });
  } else originalLog(...args);
};
test.after(() => { console.log = originalLog; });

test('reopened backing: retain full startup collection and attribution; exact Full/text/current survive subsequent incremental GC', async t => {
  const f = fixture(t, s => {
    pin(s, current + ':current', { role: 'assistant', content: text, complete: true });
    pin(s, current + ':checkpoint:0', ['checkpoint', text]);
    pin(s, 'independent-cache:current', { content: 'persistent Ω🙂' });
    pin(s, obsolete + ':current', { obsolete: text });
    pin(s, obsolete + ':checkpoint:3', ['obsolete-checkpoint', text]);
    // These merely resemble our suffixes; they are independent durable owners.
    pin(s, obsolete + ':checkpoint:4', { keep: 'outside exact retired suffix' });
    pin(s, obsolete + ':current:other', { keep: 'unrelated namespace suffix' });
    const group = s.captureLegacy({ abandonedPrivateGroup: text });
    s.lease({ type: 'page', id: group.descriptor.page }, s.owner + ':private-group');
    // Leave both old private leases behind, as an exited reader can.
  });
  const full = f.s.openPin(current + ':current');
  const leaf = f.s.lease(f.s.referenceForCursor(full.cursor().field('content')));
  const frozenView = full.fork();
  // Full contents and UTF-16 proof come before any performance assertions.
  assert.deepEqual(mat(full.cursor()), { role: 'assistant', content: text, complete: true });
  same([...leaf.cursor().textChunks()].join(''), text);
  const before = sqlCount(f.s);
  await request.run('request-1', () => f.ctl.initializeBacking(control));
  assert.equal(f.ctl.maintenanceMetrics.retiredPins, 4);
  assert.equal(f.s.sql('SELECT count(*) AS n FROM hp_pins WHERE durable=0').get().n, 3);
  assert.equal(f.s.sql('SELECT 1 FROM hp_pins WHERE name=?').get(obsolete + ':current'), undefined);
  assert.equal(f.s.sql('SELECT 1 FROM hp_pins WHERE name=?').get(obsolete + ':checkpoint:3'), undefined);
  for (const name of [current + ':current', current + ':checkpoint:0', 'independent-cache:current',
    obsolete + ':checkpoint:4', obsolete + ':current:other']) assert(f.s.sql('SELECT 1 FROM hp_pins WHERE name=?').get(name));
  assert(f.s.sql('SELECT 1 FROM hp_root_cache_owners WHERE owner_key=?').get(current));
  assert.equal(phase(f.s), 5, 'unsafe bounded startup must not ship');
  assert(f.s.metrics.gcSteps > 64);
  assert(sqlCount(f.s) < before);
  f.s.replaceRootPin(current + ':current', full.descriptor);
  f.s.collectStep(64);
  assert.notEqual(phase(f.s), 5);
  const added = f.s.captureLegacy({ content: 'new ' + text, full: true });
  assert.equal(phase(f.s), 0, 'allocation/pin invalidates unfinished mark');
  const beforeCollection = sqlCount(f.s), expected = reachable(f.s), result = finish(f.s, 31);
  assert.deepEqual(ids(f.s), expected);
  assert.equal(result.reclaimed, beforeCollection - expected.length);
  same(mat(full.cursor()).content, text); same([...leaf.cursor().textChunks()].join(''), text);
  same(mat(frozenView.cursor()).content, text); same(mat(added.cursor()).content, 'new ' + text);
  const pressure = logs.filter(l => l.request === 'request-1');
  const initial = pressure.find(l => l.stage === 'initial-collection' && l.event === 'end');
  assert(initial.elapsedMs >= 0);
  const fullCollection = pressure.find(l => l.stage === 'collect-full' && l.event === 'end');
  assert.equal(fullCollection.complete, true); assert(fullCollection.work > 64);
  for (const stage of ['initialize', 'retire-transient-pins', 'retire-parser-namespaces', 'initial-collection',
    'owner-tables', 'restore-cache-owners', 'retire-owner-metadata', 'evict-excess-owners']) {
    const pair = pressure.filter(l => l.stage === stage);
    assert.deepEqual(pair.map(l => l.event), ['begin', 'end']);
    assert(pair[1].endAbs >= pair[0].startAbs); assert(pair[1].elapsedMs >= 0);
    assert.equal(pair[1].timing, 'inclusive-elapsed-wall'); assert.equal(pair[1].outcome, 'success');
  }
  t.diagnostic(JSON.stringify({ content: { utf16Chars: text.length, sha256: hash(text) },
    initialFullWork: fullCollection.work, reclaimed: result.reclaimed, remaining: expected.length, totalV8Limit: v8.getHeapStatistics().heap_size_limit }));
  full.release(); leaf.release(); frozenView.release(); added.release();
});

test('all mark/sweep phases restart on mutation; builders exclude GC; remaining/reclaimed exact', t => {
  const { s } = fixture(t);
  const full = s.captureLegacy({ body: text });
  const discarded = s.captureLegacy({ discard: text }); discarded.release();
  const held = [];
  for (const target of [1, 2, 3, 4]) {
    // Restart via pin mutation, then stop at the requested exact phase.
    s.replaceRootPin('independent', full.descriptor);
    for (let n = 0; phase(s) !== target && n < 100000; n++) s.collectStep(1);
    assert.equal(phase(s), target);
    const endBuild = s.beginBuild();
    const writer = s.leafWriter();
    s.transaction(() => writer.write('phase-' + target + text.slice(0, 2048)));
    const stopped = s.collectStep(64);
    assert.equal(stopped.work, 0); assert.equal(stopped.blockedByBuilders, 1);
    s.transaction(() => held.push(s.lease(writer.finish())));
    endBuild();
    assert.equal(phase(s), 0);
    const before = sqlCount(s), expected = reachable(s), metrics = s.metrics.reclaimedPages;
    const result = finish(s, 17);
    assert.deepEqual(ids(s), expected); assert.equal(result.reclaimed, before - expected.length);
    assert.equal(s.metrics.reclaimedPages - metrics, result.reclaimed);
    same(mat(full.cursor()).body, text);
    for (let n = 0; n < held.length; n++) same([...held[n].cursor().textChunks()].join(''), 'phase-' + (n + 1) + text.slice(0, 2048));
  }
  held.forEach(l => l.release()); full.release(); s.removePin('independent');
  const remaining = sqlCount(s), result = finish(s);
  assert.equal(result.reclaimed, remaining); assert.equal(sqlCount(s), 0);
  assert.equal(s.sql('SELECT count(*) AS n FROM hp_edges').get().n, 0);
});

test('rolled-back sweep does not report reclaimed pages; disk/resource errors preserve live UTF-16 and exact error', t => {
  const { s } = fixture(t);
  const full = s.captureLegacy({ body: text });
  const garbage = s.captureLegacy({ discard: text }); garbage.release();
  for (let n = 0; phase(s) !== 3 && n < 100000; n++) s.collectStep(1);
  assert.equal(phase(s), 3);
  const before = ids(s), counters = { gc: s.metrics.gcSteps, reclaimed: s.metrics.reclaimedPages };
  const check = s.checkDisk, fault = Object.assign(Error('finite resource fault'), { code: 'HISTORY_BACKING_FULL' });
  s.checkDisk = () => { throw fault; };
  assert.throws(() => s.collectStep(100000), e => e === fault);
  s.checkDisk = check;
  assert.deepEqual(ids(s), before);
  assert.equal(s.metrics.reclaimedPages, counters.reclaimed, 'rollback cannot claim reclaimed pages');
  assert.equal(s.metrics.gcSteps, counters.gc, 'rollback cannot claim committed work');
  same(mat(full.cursor()).body, text);
  const expected = reachable(s), result = finish(s);
  assert.deepEqual(ids(s), expected); assert.equal(result.reclaimed, before.length - expected.length);
  // Quota on a real page allocation; no synthetic capacity response.
  const count = s.db.pragma('page_count', { simple: true });
  s.db.pragma('max_page_count = ' + count);
  const limit = s.diskBudget; s.diskBudget = s.diskUsage();
  let quotaError;
  assert.throws(() => s.captureLegacy({ mustFail: text.repeat(5) }), e => {
    quotaError = e; return e.code === 'HISTORY_BACKING_FULL' || e.errcode === 13 || e.code === 'SQLITE_FULL';
  });
  s.diskBudget = limit;
  assert.deepEqual(ids(s), expected); same(mat(full.cursor()).body, text);
  t.diagnostic(JSON.stringify({ realAllocationQuota: { code: quotaError.code, errcode: quotaError.errcode },
    rolledBackReclaimed: 0, remaining: expected.length }));
  full.release();
});

test('pressure collection cancellation retains committed progress; typed resource failure and UNKNOWN never replay allocation', async t => {
  const { ctl, s } = fixture(t, s => {
    pin(s, current + ':current', { content: text });
    const discarded = s.captureLegacy({ discard: text }); discarded.release();
  });
  await ctl.initializeBacking(control);
  const full = s.openPin(current + ':current');
  const abandoned = s.captureLegacy({ discardAfterInitialization: text }); abandoned.release();
  for (let n = 0; phase(s) !== 3 && n < 100000; n++) s.collectStep(1);
  assert.equal(phase(s), 3);
  const before = sqlCount(s), metrics = s.metrics.reclaimedPages;
  const abort = new AbortController();
  await assert.rejects(request.run('cancelled-sweep', () => ctl.collect(createReadControl({
    signal: abort.signal, schedule: async () => { abort.abort(); },
  }))), { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  assert.notEqual(phase(s), 5);
  assert.equal(before - sqlCount(s), s.metrics.reclaimedPages - metrics);
  const cancelled = logs.find(l => l.request === 'cancelled-sweep' && l.stage === 'collect-full' && l.event === 'end');
  assert.equal(cancelled.outcome, 'cancelled'); assert.equal(cancelled.complete, false);
  assert.equal(cancelled.reclaimed, before - sqlCount(s));
  same(mat(full.cursor()).content, text);
  const fault = Object.assign(Error('finite collector I/O failure'), { code: 'SQLITE_IOERR' }), check = s.checkDisk;
  const preserved = ids(s);
  s.checkDisk = () => { throw fault; };
  await assert.rejects(ctl.collect(control), e => e === fault); s.checkDisk = check;
  assert.deepEqual(ids(s), preserved);
  let attempts = 0;
  const unknown = Object.assign(Error('finite producer transport unknown'), { code: 'HISTORY_READER_TRANSPORT_UNKNOWN' });
  ctl.dispatchOwned = async () => { attempts++; throw unknown; };
  await assert.rejects(ctl.dispatch('forkHistoryRootLeaf', { encoding: 'history-display-unit-v8-v1' }, { control }), e => e === unknown);
  assert.equal(attempts, 1); assert.equal(ctl.maintenanceAdmission.active, false);
  const expected = reachable(s); finish(s); assert.deepEqual(ids(s), expected);
  same(mat(full.cursor()).content, text); full.release();
});

test('cancelled/failed initialization stays incomplete, preserves exact error, and new explicit caller can finish', async t => {
  const { ctl, s } = fixture(t, s => {
    pin(s, current + ':current', { content: text });
    for (let i = 0; i < 36; i++) s.captureLegacy({ abandoned: i });
  });
  const abort = new AbortController();
  const revoked = createReadControl({ signal: abort.signal, schedule: async () => { abort.abort(); } });
  await assert.rejects(request.run('cancelled-init', () => ctl.initializeBacking(revoked)), { code: 'HISTORY_READ_CONSUMER_REVOKED' });
  assert.equal(ctl.initializedBacking, false);
  const fault = Object.assign(Error('finite SQL allocation fault'), { code: 'SQLITE_FULL' }), check = s.checkDisk;
  const retiredBefore = ctl.maintenanceMetrics.retiredPins;
  const pinsBefore = s.sql('SELECT name,page,durable FROM hp_pins ORDER BY name').all();
  s.checkDisk = () => { throw fault; };
  await assert.rejects(ctl.initializeBacking(control), e => e === fault);
  s.checkDisk = check;
  assert.equal(ctl.maintenanceMetrics.retiredPins, retiredBefore);
  assert.deepEqual(s.sql('SELECT name,page,durable FROM hp_pins ORDER BY name').all(), pinsBefore);
  assert.equal(ctl.initializedBacking, false);
  await ctl.initializeBacking(control);
  const full = s.openPin(current + ':current'); same(mat(full.cursor()).content, text);
  const expected = reachable(s), before = sqlCount(s), result = finish(s);
  assert.equal(result.reclaimed, before - expected.length); assert.deepEqual(ids(s), expected);
  const failed = logs.filter(l => l.request === 'cancelled-init' && l.event === 'end');
  assert(failed.some(l => l.outcome === 'cancelled' && l.stage === 'initialize'));
  const saved = console.log; console.log = () => { throw Error('observer failed'); };
  try { ctl.cleanupStep(); } finally { console.log = saved; }
  const cleanupFault = Object.assign(Error('finite cleanup resource error'), { code: 'SQLITE_FULL' });
  s.checkDisk = () => { throw cleanupFault; };
  const errorsBefore = ctl.maintenanceMetrics.cleanupErrors;
  request.run('cleanup-fault', () => ctl.cleanupStep());
  s.checkDisk = check;
  assert.equal(ctl.maintenanceMetrics.cleanupErrors, errorsBefore + 1);
  assert(logs.some(l => l.request === 'cleanup-fault' && l.stage === 'cleanup-step' && l.outcome === 'error' && l.errorCode === 'SQLITE_FULL'));
  full.release();
});

test('service preflight preserves lane/FIFO, full sweeps and pressure collection with held independent views', async t => {
  const { ctl, s } = fixture(t, s => pin(s, current + ':current', { content: text }));
  let produced = 0, producerPreflightPhase;
  ctl.api.projectCodexFullHistoryFromFile = async () => {
    produced++;
    producerPreflightPhase = phase(s);
    const root = s.openPin(current + ':current');
    return { success: true, representation: 'codex-canonical-root-v1', entries: root.cursor(), root, release: () => root.release() };
  };
  const full = s.openPin(current + ':current'), independent = full.fork();
  let releaseFirst, startedFirst;
  const firstStarted = new Promise(resolve => { startedFirst = resolve; });
  const order = [], barrier = new Promise(resolve => { releaseFirst = resolve; });
  const first = ctl.withServiceRoot('current-owner', '/synthetic', { _readControl: control }, async r => {
    order.push(1); same(mat(r.entries).content, text); startedFirst(); await barrier; return 1;
  });
  await firstStarted;
  assert.equal(producerPreflightPhase, 5, 'keep the original service preflight sweep');
  const abort = new AbortController();
  const cancelled = ctl.withServiceRoot('cancelled-owner', '/synthetic', { _readControl: createReadControl({ signal: abort.signal }) }, async () => assert.fail());
  const rejected = assert.rejects(cancelled, { code: 'HISTORY_READ_CONSUMER_REVOKED' }); abort.abort();
  const second = ctl.withServiceRoot('current-owner', '/synthetic', { _readControl: control }, async () => { order.push(2); return 2; });
  await rejected; assert.equal(produced, 1); releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]); assert.deepEqual(order, [1, 2]);
  assert.equal(produced, 2); assert.equal(ctl.maintenanceAdmission.active, false); assert.equal(ctl.maintenanceAdmission.waiting, 0);
  // Real SQLite pressure: set current cap to the existing physical size.
  const garbage = s.captureLegacy({ pressureGarbage: text }); garbage.release();
  const before = sqlCount(s), expected = reachable(s);
  const count = s.db.pragma('page_count', { simple: true }); s.db.pragma('max_page_count = ' + count);
  const live = count - s.db.pragma('freelist_count', { simple: true });
  assert(live > Math.floor(count * .75));
  await ctl.makeRoom('openHistoryRoot', { sessionId: 'current-owner', cwd: '/synthetic' }, control);
  assert.equal(phase(s), 5); assert.deepEqual(ids(s), expected);
  same(mat(full.cursor()).content, text); same(mat(independent.cursor()).content, text);
  assert.equal(before - sqlCount(s), before - expected.length);
  assert(logs.some(l => l.stage === 'collect-full' && l.event === 'end' && l.complete));
  ctl.maxCachedOwners = 1;
  const evictedBefore = ctl.maintenanceMetrics.evictedOwners;
  await ctl.makeRoom('openHistoryRoot', { sessionId: 'new-owner', cwd: '/synthetic' }, control);
  assert.equal(ctl.maintenanceMetrics.evictedOwners, evictedBefore + 1);
  assert.equal(s.sql('SELECT 1 FROM hp_pins WHERE name=?').get(current + ':current'), undefined);
  same(mat(full.cursor()).content, text); same(mat(independent.cursor()).content, text);
  assert.deepEqual(ids(s), reachable(s));
  full.release(); independent.release();
  const finalBefore = sqlCount(s), final = finish(s);
  assert.equal(final.reclaimed, finalBefore); assert.equal(sqlCount(s), 0);
  t.diagnostic(JSON.stringify({ pressureReclaimed: before - expected.length, heldRemaining: expected.length,
    finalReclaimed: final.reclaimed, finalRemaining: 0, familyBytes: s.diskUsage() }));
});

test('finite original/final: same full startup work and eventual live graph; attribution does not change collection', async t => {
  const beforeFile = path.join(evidence, 'controller.BEFORE.js');
  const before = new Module(path.join(__dirname, 'history-root-controller.js'), module);
  before.filename = path.join(__dirname, 'history-root-controller.js');
  before.paths = Module._nodeModulePaths(__dirname);
  before._compile(fs.readFileSync(beforeFile, 'utf8'), before.filename);
  const seed = s => {
    pin(s, current + ':current', { content: text });
    pin(s, current + ':checkpoint:0', { checkpoint: text });
    pin(s, obsolete + ':current', { obsolete: text });
    pin(s, 'independent-cache:current', { independent: text });
    const group = s.captureLegacy({ group: text });
    s.lease({ type: 'page', id: group.descriptor.page }, 'exited-private:group');
    group.release();
  };
  const old = fixture(t, seed, before.exports.HistoryRootController), now = fixture(t, seed);
  assert.deepEqual(ids(old.s), ids(now.s));
  const costs = [];
  for (const [name, f] of [['original', old], ['diagnostics-only', now]]) {
    const full = f.s.openPin(current + ':current');
    same(mat(full.cursor()).content, text);
    const start = performance.now(), workBefore = f.s.metrics.gcSteps;
    await f.ctl.initializeBacking(control);
    const elapsedMs = performance.now() - start;
    same(mat(full.cursor()).content, text);
    costs.push({ name, elapsedMs, work: f.s.metrics.gcSteps - workBefore, complete: phase(f.s) === 5,
      pagesBeforeFinal: sqlCount(f.s), familyBytes: f.s.diskUsage() });
    full.release();
  }
  assert.equal(costs[0].work, costs[1].work); assert.equal(costs[0].complete, true);
  assert.equal(costs[1].complete, true);
  finish(old.s); finish(now.s);
  assert.deepEqual(ids(old.s), ids(now.s));
  assert.equal(old.s.sql('SELECT count(*) AS n FROM hp_edges').get().n, now.s.sql('SELECT count(*) AS n FROM hp_edges').get().n);
  for (const f of [old, now]) {
    const keep = f.s.openPin('independent-cache:current'); same(mat(keep.cursor()).independent, text); keep.release();
    assert(f.s.stats().peakCachedPages <= 3); assert(f.s.stats().peakIndexBytes <= 2048);
    assert.equal(f.s.db.pragma('journal_mode', { simple: true }), 'delete');
    assert.equal(f.s.db.pragma('synchronous', { simple: true }), 2);
  }
  t.diagnostic(JSON.stringify({ boundary: 'finite initialization only; no app/native/cold-admission claim', costs, eventualRemaining: sqlCount(now.s) }));
  assert(!JSON.stringify(logs).includes(text));
  assert(logs.every(l => Buffer.byteLength(JSON.stringify(l)) < 1024));
});

test('quota counterexample search: unfinished garbage below 75% versus one larger finite service allocation', async t => {
  const before = new Module(path.join(__dirname, 'history-root-controller.js'), module);
  before.filename = path.join(__dirname, 'history-root-controller.js'); before.paths = Module._nodeModulePaths(__dirname);
  before._compile(fs.readFileSync(path.join(evidence, 'controller.BEFORE.js'), 'utf8'), before.filename);
  const bounded = new Module(before.filename, module); bounded.filename = before.filename; bounded.paths = before.paths;
  bounded._compile(fs.readFileSync(path.join(evidence, 'controller.BOUNDED-REJECTED.js'), 'utf8'), bounded.filename);
  const seed = s => {
    pin(s, current + ':current', { content: text });
    s.captureLegacy({ privateRetiredGarbage: 'z'.repeat(220000) });
  };
  const large = 'y'.repeat(300000) + '🙂' + String.fromCharCode(0xd800);
  const results = [];
  for (const [label, Controller] of [['original', before.exports.HistoryRootController], ['rejected-bounded', bounded.exports.HistoryRootController], ['diagnostics-only', HistoryRootController]]) {
    const { ctl, s } = fixture(t, seed, Controller, 4 * MiB);
    let entry, produced = 0, delivered = false, errorCode, errcode;
    ctl.api.projectCodexFullHistoryFromFile = async () => {
      produced++;
      entry = { live: s.db.pragma('page_count', { simple: true }) - s.db.pragma('freelist_count', { simple: true }),
        cap: s.db.pragma('max_page_count', { simple: true }), gcPhase: phase(s), graphPages: sqlCount(s) };
      const root = s.captureLegacy({ content: large });
      return { success: true, representation: 'codex-canonical-root-v1', entries: root.cursor(), root, release: () => root.release() };
    };
    try {
      await ctl.withServiceRoot('larger-new-owner', '/synthetic', { _readControl: control }, async r => {
        same(mat(r.entries).content, large); delivered = true;
      });
    } catch (e) { errorCode = e.code; errcode = e.errcode; }
    const kept = s.openPin(current + ':current'); same(mat(kept.cursor()).content, text); kept.release();
    results.push({ label, entry, produced, delivered, errorCode, errcode, familyBytes: s.diskUsage() });
  }
  assert.equal(results[0].delivered, true); assert.equal(results[0].produced, 1);
  assert.equal(results[1].delivered, false); assert.equal(results[1].produced, 1);
  assert.equal(results[1].errcode, 13); assert(results[1].entry.live < results[1].entry.cap * .75);
  assert.equal(results[2].delivered, true); assert.equal(results[2].produced, 1);
  assert.equal(results[2].entry.live, results[0].entry.live);
  t.diagnostic(JSON.stringify({ quotaCounterexample: results }));
  fs.writeFileSync(path.join(evidence, 'QUOTA-COUNTEREXAMPLE.json'), JSON.stringify(results, null, 2) + '\n');
});
