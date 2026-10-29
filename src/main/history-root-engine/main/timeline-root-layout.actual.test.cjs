'use strict';

// Finite SOURCE geometry oracle only, no app/worker/provider/host activity.
// node --max-old-space-size=80 --max-semi-space-size=4 --expose-gc <this file>
// NOTED_TIMELINE_LAYOUT_EVIDENCE=<explicit owned directory>
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), v8 = require('node:v8');
const { DatabaseSync } = require('node:sqlite');
const { HistoryPagedStore } = require('./history-paged-store');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { createTimelineRootLayout: create, E28_PHYSICAL_EXTENT_LIMIT } = require('./timeline-root-layout');
const evidence = process.env.NOTED_TIMELINE_LAYOUT_EVIDENCE;
assert(evidence && path.isAbsolute(evidence), 'explicit evidence directory required');
assert(v8.getHeapStatistics().heap_size_limit <= 128 * 1024 ** 2, 'entire V8 limit <=128MiB');
fs.mkdirSync(evidence, { recursive: true });
let peakHeapTotal = 0, peakHeapUsed = 0, peakFixtureBytes = 0, connections = 0, semantics = 0;
const fixtureDirs = new Set(); // at most two finite private SQLite scopes
function sample(dir) {
  const m = process.memoryUsage(); peakHeapTotal = Math.max(peakHeapTotal, m.heapTotal); peakHeapUsed = Math.max(peakHeapUsed, m.heapUsed);
  assert(m.heapTotal <= 128 * 1024 ** 2);
  if (dir) {
    let bytes = 0;
    for (const fixtureDir of fixtureDirs) for (const name of fs.readdirSync(fixtureDir)) {
      const st = fs.lstatSync(path.join(fixtureDir, name)); assert(!st.isSymbolicLink()); bytes += st.size;
    }
    peakFixtureBytes = Math.max(peakFixtureBytes, bytes); assert(bytes <= 64 * 1024 ** 2, 'whole fixture <=64MiB');
  }
}
// Explicit ABI adapter, not a stub store. Production page SQL, transactions,
// page ownership, vectors/maps, DELETE/FULL, quota and GC all execute unchanged.
class SQLite {
  constructor(filename) { this.native = new DatabaseSync(filename); this.depth = 0; connections++; }
  exec(sql) { return this.native.exec(sql); }
  prepare(sql) {
    const s = this.native.prepare(sql);
    const row = r => r && Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v]));
    return { get: (...a) => row(s.get(...a)), run: (...a) => s.run(...a), all: (...a) => s.all(...a).map(row),
      *iterate(...a) { for (const r of s.iterate(...a)) yield row(r); } };
  }
  pragma(sql, options = {}) { const rows = this.prepare('PRAGMA ' + sql).all(); return options.simple ? Object.values(rows[0])[0] : rows; }
  transaction(fn) { return (...a) => {
    if (this.depth) return fn(...a);
    this.native.exec('BEGIN'); this.depth++;
    try { const value = fn(...a); this.native.exec('COMMIT'); return value; }
    catch (error) { this.native.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }; }
  close() { this.native.close(); connections--; }
}
function corpus() {
  const kinds = ['group', 'note', 'fork', 'entry', 'sc-wrapped', 'plan', 'boundary'];
  const bases = [9.25, 37.5, 6.125, 0, 18.75, 3.5, 1.25], weights = [0, .25, 1.5, 2, 0, 3.75, .5];
  return Array.from({ length: 257 }, (_, i) => ({ key: i === 17 ? 'atom:17\0Ω😀' : 'atom:' + i,
    identity: 'visual:' + i + ':' + kinds[i % 7], kind: kinds[i % 7],
    baseExtent: i % 29 === 0 ? 0 : bases[i % 7] + (i % 4) * .125,
    flexWeight: i % 31 === 0 ? 0 : weights[i % 7], estimated: i % 3 !== 0, intrinsic: i % 3 === 0 }));
}
function oracle(atoms, mode, H) {
  const B = atoms.reduce((n, a) => n + a.baseExtent, 0), W = atoms.reduce((n, a) => n + a.flexWeight, 0);
  const E = mode === 'compact' && W ? Math.max(0, H - B) : 0;
  let offset = 0;
  const rects = atoms.map((a, ordinal) => {
    const extent = a.baseExtent + (W ? E * (a.flexWeight / W) : 0), start = offset; offset += extent;
    return { ...a, ordinal, start, extent, end: offset };
  });
  return { B, W, E, total: offset, rects };
}
const near = (a, b) => assert(Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 2e-12, `${a} != ${b}`);
function rectEqual(actual, expected) {
  for (const key of ['ordinal', 'key', 'identity', 'baseExtent', 'flexWeight', 'estimated', 'intrinsic']) assert.equal(actual[key], expected[key], key);
  for (const key of ['start', 'extent', 'end']) near(actual[key], expected[key]);
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(evidence, 'fixture-'));
  fixtureDirs.add(dir); assert(fixtureDirs.size <= 2);
  const store = new HistoryPagedStore({ filename: path.join(dir, 'pages.sqlite'), Database: SQLite, diskBytes: 32 * 1024 ** 2 });
  const held = new Set();
  const own = obj => { held.add(obj); return obj; };
  const source = atoms => {
    const arena = new HistoryProjectionArena(store); let lease;
    try {
      arena.step(() => { arena.state().atoms = arena.make('array'); });
      for (const atom of atoms) arena.step(() => {
        // Unrelated user graph must never be copied/pinned by layout. Real
        // paged bodies, notes/fork/group sizes are distinct in the same array.
        arena.state().atoms.push(arena.own({ ...atom, body: 'BODY_NOT_GEOMETRY:' + 'Ω😀'.repeat(128), row: { content: 'user graph' } }));
      });
      arena.step(() => { lease = arena.publish(arena.state().atoms); });
      return own(lease);
    } finally { arena.close(); sample(dir); }
  };
  const build = async (atoms, options = {}) => {
    const lease = source(atoms);
    const layout = own(await create({ store, atomsCursor: lease.cursor(), layoutFingerprint: 'width:320/font:a',
      mode: 'expanded', viewportExtent: 600, ...options }));
    sample(dir); return { layout, lease };
  };
  const pins = () => store.db.prepare('SELECT count(*) n FROM hp_pins').get().n;
  t.after(() => {
    for (const obj of held) obj.release();
    assert.equal(pins(), 0); assert.equal(store.builders, 0); sample(dir);
    store.close(); fs.rmSync(dir, { recursive: true }); fixtureDirs.delete(dir); assert(!fs.existsSync(dir)); global.gc?.();
  });
  return { store, dir, own, source, build, pins };
}
function measure(layout, ordinals, extent = i => 40 + i / 8) {
  const info = layout.info();
  return { layoutId: info.layoutId, layoutRevision: info.layoutRevision, layoutFingerprint: info.layoutFingerprint,
    measurements: ordinals.map(ordinal => {
      const r = layout.rect(ordinal);
      return { ordinal, key: r.key, identity: r.identity, layoutFingerprint: r.layoutFingerprint, intrinsicExtent: extent(ordinal) };
    }) };
}
function collect(store) {
  let complete = false;
  for (let i = 0; i < 200 && !complete; i++) complete = store.collectStep(10000).complete;
  assert(complete, 'finite collection completed');
}

test('257 actual mixed atoms: independent global content/order/allocation oracle BEFORE bounds', async t => {
  const f = fixture(t), atoms = corpus(), B = atoms.reduce((n, a) => n + a.baseExtent, 0), H = B + 777.75;
  const { layout } = await f.build(atoms, { mode: 'compact', viewportExtent: H });
  const expected = oracle(atoms, 'compact', H), info = layout.info();
  near(info.totalExtent, H); near(info.baseExtent, expected.B); near(info.flexWeight, expected.W);
  assert.equal(info.count, 257); assert.equal(info.estimatedCount, atoms.filter(a => a.estimated).length);
  let visited = 0;
  for (let startOrdinal = 0; startOrdinal < atoms.length;) {
    const w = layout.window({ startOrdinal }); assert(w.items.length <= 3);
    for (const r of w.items) { rectEqual(r, expected.rects[visited]); assert.equal(r.ordinal, visited++); }
    startOrdinal = w.nextOrdinal;
  }
  assert.equal(visited, 257);
  for (let i = 0; i < 257; i++) {
    const r = layout.rect(i); rectEqual(layout.lookup(atoms[i].key), expected.rects[i]);
    near(layout.prefixExtent(i), expected.rects[i].start);
    if (r.extent) {
      const found = layout.atomAtOffset(r.start + r.extent / 2); assert.equal(found.ordinal, i); near(found.intraOffset, r.extent / 2);
      assert.equal(layout.atomAtOffset(r.start).ordinal, i, 'half-open boundary');
    }
  }
  assert.equal(layout.atomAtOffset(info.totalExtent), null); assert.equal(layout.lookup('not-present'), null);
  const range = layout.range(2, 250);
  rectEqual(range.start, expected.rects[2]); rectEqual(range.end, expected.rects[250]);
  assert.equal(range.count, 249); near(range.extent, expected.rects[250].end - expected.rects[2].start);
  assert.equal(range.estimatedCount, atoms.slice(2, 251).filter(a => a.estimated).length);
  const window = layout.window({ startOrdinal: 210 });
  near(window.items[0].extent, expected.rects[210].extent);
  const mounted = atoms.slice(210, 213), subset = oracle(mounted, 'compact', H);
  assert(Math.abs(window.items[1].extent - subset.rects[1].extent) > 1, 'not mounted-only allocation');
  assert.notEqual(layout.info().layoutId, atoms[0].identity); assert(Object.isFrozen(info) && Object.isFrozen(range));
  semantics++;
});

test('expanded estimates -> measured SC wrapping and late one-atom summary; frozen snapshots/forks survive source/parent release', async t => {
  const f = fixture(t), atoms = corpus(), { layout, lease } = await f.build(atoms);
  const old = f.own(layout.snapshot()), fork = f.own(layout.fork());
  const bodyPage = f.store.referenceForCursor(lease.cursor().at(0).field('body')).id;
  const oldInfo = old.info(), oldRect = old.rect(256), oldTotal = oldInfo.totalExtent;
  const changed = atoms.map(a => ({ ...a })), ordinals = [4, 11, 18, 25, 32]; // SC actual intrinsic changes at this width
  const batch = measure(layout, ordinals, i => 70.375 + i / 4);
  layout.applyMeasuredBatch(batch);
  for (const m of batch.measurements) Object.assign(changed[m.ordinal], { baseExtent: m.intrinsicExtent, estimated: false, intrinsic: true });
  const expected = oracle(changed, 'expanded', 600);
  for (let i = 0; i < 257; i++) rectEqual(layout.rect(i), expected.rects[i]);
  assert.equal(layout.info().layoutRevision, 1); assert.notEqual(layout.info().totalExtent, oldTotal);
  assert.equal(old.info().totalExtent, oldTotal); assert.deepEqual(old.rect(256), oldRect);
  assert.equal(fork.info().totalExtent, oldTotal);
  fork.applyMeasuredBatch(measure(fork, [256], () => 123.125));
  assert.equal(layout.rect(256).baseExtent, atoms[256].baseExtent); assert.equal(old.rect(256).baseExtent, atoms[256].baseExtent);
  // Late summary changes only one visual atom. Prefix/range off-window follows.
  layout.applyMeasuredBatch(measure(layout, [253], () => 99.5));
  Object.assign(changed[253], { baseExtent: 99.5, estimated: false, intrinsic: true });
  const late = oracle(changed, 'expanded', 600);
  rectEqual(layout.rect(256), late.rects[256]); rectEqual(layout.range(0, 256).end, late.rects[256]);
  assert.throws(() => old.applyMeasuredBatch(measure(old, [4])), { code: 'TIMELINE_LAYOUT_READ_ONLY' });
  lease.release(); lease.release(); collect(f.store);
  assert.equal(f.store.db.prepare('SELECT 1 present FROM hp_pages WHERE id=?').get(bodyPage), undefined, 'held geometry does not retain body graph');
  rectEqual(layout.rect(256), late.rects[256]);
  layout.release(); layout.release(); fork.release(); fork.release();
  assert.deepEqual(old.rect(256), oldRect); assert.equal(old.info().totalExtent, oldTotal);
  old.release(); old.release(); assert.equal(f.pins(), 0); assert.throws(() => old.rect(0), { code: 'TIMELINE_LAYOUT_RELEASED' });
  semantics++;
});

test('zero/fractional extents, no-flex compact, viewport/mode/width fingerprint changes and huge un-clipped far seek', async t => {
  const f = fixture(t);
  const atom = (key, baseExtent, flexWeight = 0) => ({ key, identity: 'atom-id:' + key, baseExtent, flexWeight, estimated: true, intrinsic: false });
  const atoms = [atom('zero', 0), atom('fraction', .125, .25), atom('zero2', 0), atom('last', 1.75, .75)];
  const { layout } = await f.build(atoms, { mode: 'compact', viewportExtent: 13.875 });
  for (let i = 0; i < atoms.length; i++) rectEqual(layout.rect(i), oracle(atoms, 'compact', 13.875).rects[i]);
  assert.equal(layout.atomAtOffset(0).ordinal, 1); assert.equal(layout.atomAtOffset(layout.rect(3).start).ordinal, 3);
  const expanded = f.own(layout.fork({ mode: 'expanded' })); near(expanded.info().totalExtent, 1.875);
  const taller = f.own(layout.fork({ viewportExtent: 100.5 })); near(taller.info().totalExtent, 100.5);
  near(layout.info().totalExtent, 13.875);
  assert.throws(() => layout.fork({ layoutFingerprint: 'width:640/font:a' }), { code: 'TIMELINE_LAYOUT_FINGERPRINT_REBUILD_REQUIRED' });
  const wide = await f.build(atoms.map(a => ({ ...a, baseExtent: a.baseExtent / 2 })), { layoutFingerprint: 'width:640/font:a' });
  assert.notEqual(wide.layout.info().layoutFingerprint, layout.info().layoutFingerprint);
  assert.throws(() => wide.layout.applyMeasuredBatch(measure(layout, [1])), { code: 'TIMELINE_LAYOUT_STALE_MEASUREMENT' });
  const noFlex = await f.build([atom('a', 1.5), atom('b', 2.75)], { mode: 'compact', viewportExtent: 100 });
  near(noFlex.layout.info().totalExtent, 4.25);
  const zero = await f.build([atom('a', 0), atom('b', 0)], { mode: 'compact', viewportExtent: 0 });
  assert.equal(zero.layout.info().totalExtent, 0); assert.equal(zero.layout.atomAtOffset(0), null); assert.equal(zero.layout.window().items.length, 2);
  const empty = await f.build([], { viewportExtent: 0 }); assert.equal(empty.layout.window().done, true); assert.equal(empty.layout.atomAtOffset(0), null);
  const huge = await f.build([atom('a', E28_PHYSICAL_EXTENT_LIMIT * 2), atom('b', 4.125), atom('c', 0)]);
  const hi = huge.layout.info(); assert(hi.physicalRebaseRequired); near(hi.totalExtent, E28_PHYSICAL_EXTENT_LIMIT * 2 + 4.125);
  assert.equal(huge.layout.atomAtOffset(hi.totalExtent - .5).key, 'b'); assert.equal(huge.layout.range(0, 2).end.extent, 0);
  const tiny = await f.build([atom('subnormal', 0, Number.MIN_VALUE)], { mode: 'compact', viewportExtent: 100 });
  near(tiny.layout.rect(0).extent, 100); assert.equal(tiny.layout.atomAtOffset(99).ordinal, 0);
  const cancellation = await f.build([atom('huge', 1e20), atom('tiny', .125)]);
  cancellation.layout.applyMeasuredBatch(measure(cancellation.layout, [0], () => 0));
  near(cancellation.layout.info().totalExtent, .125); assert.equal(cancellation.layout.atomAtOffset(0).ordinal, 1);
  semantics++;
});

test('atomic exact owner/ordinal/key/identity/fingerprint/revision batch refusals and <=32 cap', async t => {
  const f = fixture(t), { layout } = await f.build(corpus()), other = f.own(layout.fork());
  const before = layout.info(), beforeRect = layout.rect(255), pins = f.pins();
  const badBatches = [
    { ...measure(layout, [1]), layoutId: other.layoutId },
    { ...measure(layout, [1]), layoutRevision: -1 },
    { ...measure(layout, [1]), layoutFingerprint: 'wrong' },
    measure(layout, []), measure(layout, Array.from({ length: 33 }, (_, i) => i)),
    measure(layout, [1, 1]),
  ];
  for (const field of ['key', 'identity', 'layoutFingerprint', 'ordinal', 'intrinsicExtent']) {
    const b = measure(layout, [1, 2]); b.measurements[1][field] = field === 'ordinal' ? 257 : field === 'intrinsicExtent' ? NaN : 'wrong'; badBatches.push(b);
  }
  for (const b of badBatches) {
    const writes = f.store.metrics.pagesWritten;
    assert.throws(() => layout.applyMeasuredBatch(b)); assert.equal(f.store.metrics.pagesWritten, writes, 'refused before mutation');
    assert.deepEqual(layout.info(), before); assert.deepEqual(layout.rect(255), beforeRect); assert.equal(f.pins(), pins);
  }
  const stale = measure(layout, [255]);
  layout.applyMeasuredBatch(measure(layout, Array.from({ length: 32 }, (_, i) => i)));
  const after = layout.info(); assert.equal(after.layoutRevision, 1);
  assert.throws(() => layout.applyMeasuredBatch(stale), { code: 'TIMELINE_LAYOUT_STALE_MEASUREMENT' }); assert.deepEqual(layout.info(), after);
  assert.throws(() => layout.window({ limit: 4 }), { code: 'TIMELINE_LAYOUT_WINDOW' });
  assert.throws(() => layout.rect(1.5)); assert.throws(() => layout.range(4, 3)); assert.throws(() => layout.atomAtOffset(-1));
  semantics++;
});

test('actual SQL quota/cancel rollback retains prior complete layout; build refusal/cancel releases every private pin', async t => {
  const f = fixture(t), { layout, lease } = await f.build(corpus());
  const before = layout.info(), rect = layout.rect(255), pins = f.pins();
  const pages = () => f.store.db.prepare('SELECT count(*) n FROM hp_pages').get().n;
  const oldPages = pages(), writes = f.store.metrics.pagesWritten, budget = f.store.diskBudget;
  f.store.diskBudget = f.store.diskUsage() - 1;
  assert.throws(() => layout.applyMeasuredBatch(measure(layout, [0, 255])), { code: 'HISTORY_BACKING_FULL' });
  f.store.diskBudget = budget;
  assert(f.store.metrics.pagesWritten > writes, 'real staged writes occurred');
  assert.equal(pages(), oldPages); assert.equal(f.pins(), pins); assert.deepEqual(layout.info(), before); assert.deepEqual(layout.rect(255), rect);
  const cancellationWrites = f.store.metrics.pagesWritten;
  assert.throws(() => layout.applyMeasuredBatch(measure(layout, [0, 255]), { control: { assertCurrent() {
    if (f.store.metrics.pagesWritten > cancellationWrites) throw Object.assign(Error('own cancel'), { code: 'OWN_CANCEL' });
  } } }), { code: 'OWN_CANCEL' });
  assert.equal(pages(), oldPages); assert.equal(f.pins(), pins); assert.deepEqual(layout.info(), before); assert.deepEqual(layout.rect(255), rect);
  let cancelled = false;
  await assert.rejects(create({ store: f.store, atomsCursor: lease.cursor(), layoutFingerprint: 'other-width', mode: 'expanded', viewportExtent: 1,
    control: { assertCurrent() { if (cancelled) throw Error('build cancel'); }, async checkpoint() { sample(f.dir); cancelled = true; } } }), /build cancel/);
  assert(cancelled); assert.equal(f.pins(), pins); assert.equal(f.store.builders, 0);
  const duplicate = f.source([{ key: 'a', identity: 'x', baseExtent: 1, flexWeight: 0, estimated: true, intrinsic: false },
    { key: 'a', identity: 'y', baseExtent: 2, flexWeight: 0, estimated: true, intrinsic: false }]);
  const duplicatePins = f.pins();
  await assert.rejects(create({ store: f.store, atomsCursor: duplicate.cursor(), layoutFingerprint: 'x', mode: 'expanded', viewportExtent: 10 }),
    { code: 'TIMELINE_LAYOUT_DUPLICATE_KEY' }); assert.equal(f.pins(), duplicatePins);
  for (const bad of [{ baseExtent: undefined }, { baseExtent: -1 }, { baseExtent: Infinity }, { flexWeight: -.25 },
    { estimated: undefined }, { intrinsic: 'unknown' }, { key: 'x'.repeat(4097) }]) {
    const input = f.source([{ key: 'valid', identity: 'visual-identity', baseExtent: .125, flexWeight: .5,
      estimated: true, intrinsic: false, ...bad }]), inputPins = f.pins();
    await assert.rejects(create({ store: f.store, atomsCursor: input.cursor(), layoutFingerprint: 'x', mode: 'expanded', viewportExtent: 10 }));
    assert.equal(f.pins(), inputPins); assert.equal(f.store.builders, 0); input.release();
  }
  const missingIdentity = f.source([{ key: 'fallback-key', baseExtent: .125, flexWeight: 0, estimated: true, intrinsic: false }]);
  const fallback = f.own(await create({ store: f.store, atomsCursor: missingIdentity.cursor(), layoutFingerprint: 'x', mode: 'expanded', viewportExtent: 10 }));
  assert.equal(fallback.rect(0).identity, 'fallback-key'); fallback.release(); missingIdentity.release();
  const foreign = fixture(t), foreignLease = foreign.source(corpus().slice(0, 1));
  await assert.rejects(create({ store: f.store, atomsCursor: foreignLease.cursor(), layoutFingerprint: 'x', mode: 'expanded', viewportExtent: 10 }),
    { code: 'history_foreign_root' }); assert.equal(f.pins(), duplicatePins); assert.equal(f.store.builders, 0);
  layout.applyMeasuredBatch(measure(layout, [255])); assert.equal(layout.info().layoutRevision, 1, 'same prior owner remains usable after failures');
  semantics++;
});

test('bounds AFTER geometry semantics: actual ownership/indexed seeks, finite fixture, DELETE/FULL and cleanup', async t => {
  assert.equal(semantics, 5, 'all content/order/allocation/mutation/refusal semantics before bounds');
  const f = fixture(t), { layout, lease } = await f.build(corpus(), { mode: 'compact', viewportExtent: 10000 });
  const reads = f.store.metrics.pagesRead;
  const off = layout.prefixExtent(250); assert.equal(layout.atomAtOffset(off + .125).ordinal, 250);
  layout.range(1, 256); layout.lookup('atom:256');
  const queryReads = f.store.metrics.pagesRead - reads;
  assert(queryReads < 6000, 'indexed far queries, not scanning 257 atom records');
  const beforeForkWrites = f.store.metrics.pagesWritten, held = f.own(layout.snapshot());
  assert.equal(f.store.metrics.pagesWritten, beforeForkWrites, 'snapshot shares immutable pages without a tree walk');
  lease.release(); const stats = layout.stats();
  assert.equal(stats.ownership.nativeRows, 0); assert.equal(stats.ownership.nativeMapEntries, 0);
  assert.equal(stats.ownership.inputIdentitySlots, 0); assert(stats.ownership.handleCache <= 3);
  assert(stats.ownership.pageCache <= 3); assert(stats.ownership.indexBytes <= f.store.indexBytes);
  assert.equal(stats.sourceGraphRetained, false); assert.equal(stats.arena.unboundedTextMaterializations || 0, 0);
  assert.equal(f.store.db.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(f.store.db.pragma('synchronous', { simple: true }), 2); assert.equal(f.store.diskBudget, 32 * 1024 ** 2);
  sample(f.dir); held.release(); layout.release(); assert.equal(f.pins(), 0); collect(f.store);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM hp_pages').get().n, 0);
  fs.writeFileSync(path.join(evidence, 'BOUNDS.json'), JSON.stringify({ ...stats, queryReads, peakHeapTotal, peakHeapUsed,
    peakFixtureBytes, heapLimit: v8.getHeapStatistics().heap_size_limit, sourceGeometryOnly: true, actualE28Acceptance: false,
    sqliteNativeMemoryBounded: false }, null, 2) + '\n');
});

process.on('exit', () => {
  sample(); assert.equal(connections, 0);
  fs.writeFileSync(path.join(evidence, 'SOURCE-LIMITS.json'), JSON.stringify({ heapLimit: v8.getHeapStatistics().heap_size_limit,
    peakHeapTotal, peakHeapUsed, peakFixtureBytes, connections, semanticsPassed: semantics,
    sourceGeometryOnly: true, actualE28Acceptance: false, sqliteNativeMemoryBounded: false }, null, 2) + '\n');
});
