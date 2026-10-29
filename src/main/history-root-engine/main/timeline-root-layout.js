'use strict';

// Reader-owned geometry, NOT source/row authority or a physical scroll surface.
// See the scoped evidence/API document for the consumer contract. All N-sized
// state is in the supplied HistoryPagedStore; no source cursor/body is retained.
const { randomUUID } = require('node:crypto');
const { HistoryProjectionArena } = require('./history-projection-arena');
const { isHistoryPagedCursor } = require('./history-paged-store');
const { createReadWorkBudget } = require('./history-read-control');
const text = require('./history-paged-text');
const E28_PHYSICAL_EXTENT_LIMIT = 33554428; // conservative Blink layout ceiling
const MAX_WINDOW_ITEMS = 3;
const MAX_MEASUREMENTS = 32;
const fail = code => Object.assign(new Error(code), { code: 'TIMELINE_LAYOUT_' + code });
const nonnegative = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function finite(n) { if (!nonnegative(n)) throw fail('EXTENT'); return n; }
function modeOf(mode) { if (mode !== 'compact' && mode !== 'expanded') throw fail('MODE'); return mode; }
function smallString(value) {
  if (!text.isText(value) || !value.length || value.length > 4096) throw fail('IDENTITY');
  return typeof value === 'string' ? value : text.materialize(value, 'timeline-layout-fixed-identity');
}
function cursorString(cursor) {
  if (cursor.kind !== 'text' || !cursor.length || cursor.length > 4096) throw fail('IDENTITY');
  let value = ''; for (const part of cursor.textChunks()) value += part;
  return value;
}
// Arithmetic lowbit avoids signed 32-bit coercion of the paged ordinal.
function lowbit(n) { let bit = 1; while (n % 2 === 0) { n /= 2; bit *= 2; } return bit; }
function prefix(tree, end) {
  // At most 32 fixed-size stack frames (the paged array ordinal domain).
  // Add high-to-low, matching inverse traversal at exact boundaries.
  return end === 0 ? 0 : finite(prefix(tree, end - lowbit(end)) + tree[end]);
}
function appendSum(tree, value, ordinal) {
  const i = ordinal + 1, first = i - lowbit(i);
  let sum = value;
  for (let at = i - 1; at > first; at -= lowbit(at)) sum = finite(sum + tree[at]);
  tree.push(sum);
}
function updateSum(tree, ordinal, valueAt, count, control) {
  for (let i = ordinal + 1; i <= count; i += lowbit(i)) {
    control?.assertCurrent();
    // Recombine indexed positive blocks instead of subtracting an old height
    // from a large total: removing a huge atom must reveal tiny neighbours.
    let sum = valueAt(i - 1), first = i - lowbit(i);
    for (let at = i - 1; at > first; at -= lowbit(at)) sum = finite(sum + tree[at]);
    tree[i] = sum;
  }
}
function checkpoint(control) {
  control?.assertCurrent();
  return Promise.resolve(control?.checkpoint ? control.checkpoint() : new Promise(resolve => setImmediate(resolve)))
    .then(() => control?.assertCurrent());
}

/**
 * atomsCursor: SAME-store paged array, in visual order. Each atom has unique key,
 * identity (defaults to key), baseExtent, flexWeight, estimated and intrinsic.
 * Extents/weights are finite >=0; no sizing default is supplied here. Only these
 * fixed scalar fields are copied into a fresh derived arena. Fingerprint must
 * include width/font/style/wrapping inputs; a changed fingerprint needs a new
 * build from caller estimates, never reuse old measurements under a new label.
 */
async function createTimelineRootLayout({ store, atomsCursor, layoutFingerprint, mode, viewportExtent, control } = {}) {
  modeOf(mode); finite(viewportExtent); layoutFingerprint = smallString(layoutFingerprint);
  if (!isHistoryPagedCursor(atomsCursor) || atomsCursor.kind !== 'array') throw fail('ATOMS_REQUIRED');
  const endBuild = store.beginBuild();
  const work = createReadWorkBudget(control);
  let arena, transferred = false;
  try {
    control?.assertCurrent();
    // Validates the actual cursor owner, not a filename/descriptor comparison.
    store.referenceForCursor(atomsCursor);
    arena = new HistoryProjectionArena(store);
    const count = atomsCursor.length;
    const frame = arena.step(() => {
      const s = arena.state();
      s.atoms = arena.make('array'); s.keys = arena.make('map');
      s.bases = arena.own([0]); s.weights = arena.own([0]); s.estimates = arena.own([0]);
      s.count = count; s.baseTotal = 0; s.weightTotal = 0; s.estimatedCount = 0;
      return s;
    });
    for (let ordinal = 0; ordinal < count; ordinal++) {
      control?.assertCurrent();
      const atom = atomsCursor.at(ordinal);
      if (atom.kind !== 'object') throw fail('ATOM');
      const key = cursorString(atom.field('key')), id = atom.field('identity');
      const identity = id.kind === 'undefined' ? key : cursorString(id);
      const baseExtent = finite(atom.field('baseExtent').scalar());
      const flexWeight = finite(atom.field('flexWeight').scalar());
      const estimated = atom.field('estimated').scalar(), intrinsic = atom.field('intrinsic').scalar();
      if (typeof estimated !== 'boolean' || typeof intrinsic !== 'boolean') throw fail('FLAGS');
      arena.step(() => {
        if (frame.keys.has(key)) throw fail('DUPLICATE_KEY');
        frame.atoms.push(arena.record({ key, identity, baseExtent, flexWeight, estimated, intrinsic }));
        frame.keys.set(key, ordinal);
        appendSum(frame.bases, baseExtent, ordinal);
        appendSum(frame.weights, flexWeight, ordinal);
        appendSum(frame.estimates, estimated ? 1 : 0, ordinal);
        control?.assertCurrent();
      });
      await work();
    }
    arena.step(() => {
      frame.baseTotal = prefix(frame.bases, count); frame.weightTotal = prefix(frame.weights, count);
      frame.estimatedCount = prefix(frame.estimates, count); control?.assertCurrent();
    });
    control?.assertCurrent();
    const result = new TimelineRootLayout(arena, { layoutFingerprint, mode, viewportExtent });
    transferred = true; return result;
  } finally { if (!transferred) arena?.close(); endBuild(); }
}

class TimelineRootLayout {
  constructor(arena, { layoutFingerprint, mode, viewportExtent, layoutRevision = 0, readOnly = false }) {
    this.arena = arena; this.layoutId = randomUUID(); this.layoutRevision = layoutRevision;
    this.layoutFingerprint = layoutFingerprint; this.mode = mode; this.viewportExtent = viewportExtent;
    this.readOnly = readOnly; this.closed = false;
    // Fixed registers only: six paged handles and four aggregate scalars.
    // Re-resolving the owner root inside every inverse step would add needless
    // SQLite reads; none of these registers grow with atom count or visits.
    this.frame = arena.state(); this.atoms = this.frame.atoms; this.keys = this.frame.keys;
    this.bases = this.frame.bases; this.weights = this.frame.weights; this.estimates = this.frame.estimates;
    this.count = this.frame.count; this.refreshTotals();
  }
  refreshTotals() { this.baseTotal = this.frame.baseTotal; this.weightTotal = this.frame.weightTotal; this.estimatedCount = this.frame.estimatedCount; }
  assertOpen() { if (this.closed) throw fail('RELEASED'); this.arena.assertOpen(); }
  allocation(weight) {
    return this.mode === 'compact' && this.weightTotal > 0
      ? Math.max(0, this.viewportExtent - this.baseTotal) * (weight / this.weightTotal) : 0;
  }
  extent() { return finite(this.baseTotal + this.allocation(this.weightTotal)); }
  stamp() { return { layoutId: this.layoutId, layoutRevision: this.layoutRevision, layoutFingerprint: this.layoutFingerprint }; }
  info() {
    this.assertOpen(); const totalExtent = this.extent();
    return Object.freeze({ ...this.stamp(), mode: this.mode, viewportExtent: this.viewportExtent,
      count: this.count, baseExtent: this.baseTotal, flexWeight: this.weightTotal, totalExtent,
      estimatedCount: this.estimatedCount, estimated: this.estimatedCount > 0,
      physicalRebaseRequired: totalExtent > E28_PHYSICAL_EXTENT_LIMIT,
      maxWindowItems: MAX_WINDOW_ITEMS, readOnly: this.readOnly });
  }
  ordinal(ordinal, end = false) {
    const count = this.count;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= count + (end ? 1 : 0)) throw fail('ORDINAL');
  }
  prefixExtent(end) {
    this.assertOpen(); this.ordinal(end, true);
    return finite(prefix(this.bases, end) + this.allocation(prefix(this.weights, end)));
  }
  rect(ordinal) {
    this.assertOpen(); this.ordinal(ordinal);
    const atom = this.atoms[ordinal], start = this.prefixExtent(ordinal);
    const extent = finite(atom.baseExtent + this.allocation(atom.flexWeight));
    return Object.freeze({ ...this.stamp(), ordinal, key: smallString(atom.key), identity: smallString(atom.identity),
      start, end: this.prefixExtent(ordinal + 1), extent, baseExtent: atom.baseExtent, flexWeight: atom.flexWeight,
      estimated: atom.estimated, intrinsic: atom.intrinsic });
  }
  lookup(key) {
    this.assertOpen(); key = smallString(key); const ordinal = this.keys.get(key);
    return ordinal === undefined ? null : this.rect(ordinal);
  }
  // Half-open intervals. Zero-height atoms have rects but no covering offset.
  // offset==total (including an all-zero layout) has no covering atom.
  atomAtOffset(offset) {
    this.assertOpen(); finite(offset);
    if (offset >= this.extent()) return null;
    let rank = 0, base = 0, weight = 0, bit = 1;
    while (bit * 2 <= this.count) bit *= 2;
    for (; bit >= 1; bit /= 2) {
      const next = rank + bit;
      if (next <= this.count) {
        const b = base + this.bases[next], w = weight + this.weights[next];
        if (b + this.allocation(w) <= offset) { rank = next; base = b; weight = w; }
      }
    }
    if (rank >= this.count) return null;
    const rect = this.rect(rank);
    return Object.freeze({ ...rect, intraOffset: Math.max(0, offset - rect.start) });
  }
  range(startOrdinal, endOrdinal) {
    this.assertOpen(); this.ordinal(startOrdinal); this.ordinal(endOrdinal);
    if (endOrdinal < startOrdinal) throw fail('RANGE');
    const start = this.rect(startOrdinal), end = this.rect(endOrdinal);
    return Object.freeze({ ...this.stamp(), count: endOrdinal - startOrdinal + 1, start, end,
      extent: finite(this.prefixExtent(endOrdinal + 1) - start.start),
      estimatedCount: prefix(this.estimates, endOrdinal + 1) - prefix(this.estimates, startOrdinal) });
  }
  // Ordinal pagination also preserves zero-extent markers. No hidden N array.
  window({ startOrdinal = 0, limit = MAX_WINDOW_ITEMS } = {}) {
    this.assertOpen(); this.ordinal(startOrdinal, true);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WINDOW_ITEMS) throw fail('WINDOW');
    const count = this.count, items = [];
    for (let i = startOrdinal; i < count && items.length < limit; i++) items.push(this.rect(i));
    const nextOrdinal = startOrdinal + items.length;
    return Object.freeze({ ...this.stamp(), items: Object.freeze(items), nextOrdinal, done: nextOrdinal === count });
  }
  /** Atomic synchronous <=32-item intrinsic batch. Echo stamp from rect/window:
   * {layoutId,layoutRevision,layoutFingerprint, measurements:[
   *   {ordinal,key,identity,layoutFingerprint,intrinsicExtent}
   * ]}. No duplicate ordinal, stale revision, foreign owner or mixed width.
   * On quota/cancellation failure both SQL and arena roots keep the old layout.
   */
  applyMeasuredBatch({ layoutId, layoutRevision, layoutFingerprint, measurements } = {}, { control } = {}) {
    this.assertOpen();
    if (this.readOnly) throw fail('READ_ONLY');
    if (layoutId !== this.layoutId || layoutRevision !== this.layoutRevision || layoutFingerprint !== this.layoutFingerprint)
      throw fail('STALE_MEASUREMENT');
    if (!Array.isArray(measurements) || measurements.length < 1 || measurements.length > MAX_MEASUREMENTS) throw fail('BATCH');
    control?.assertCurrent();
    const batch = [], seen = new Set(); // hard cap 32, never a visited-height map
    for (const m of measurements) {
      this.ordinal(m?.ordinal); const atom = this.atoms[m.ordinal];
      if (seen.has(m.ordinal) || m.layoutFingerprint !== this.layoutFingerprint
        || m.key !== smallString(atom.key) || m.identity !== smallString(atom.identity)) throw fail('MEASUREMENT_IDENTITY');
      seen.add(m.ordinal); batch.push({ ordinal: m.ordinal, intrinsicExtent: finite(m.intrinsicExtent) });
    }
    const s = this.frame;
    this.arena.step(() => {
      for (const m of batch) {
        control?.assertCurrent(); const atom = this.atoms[m.ordinal], wasEstimated = atom.estimated;
        atom.baseExtent = m.intrinsicExtent; atom.estimated = false; atom.intrinsic = true;
        updateSum(this.bases, m.ordinal, i => this.atoms[i].baseExtent, this.count, control);
        if (wasEstimated) updateSum(this.estimates, m.ordinal, i => this.atoms[i].estimated ? 1 : 0, this.count, control);
      }
      s.baseTotal = prefix(s.bases, s.count); s.estimatedCount = prefix(s.estimates, s.count);
      control?.assertCurrent();
    });
    this.refreshTotals(); this.layoutRevision++; return this.info();
  }
  // O(1) immutable page sharing. Every handle owns its own pin and ID. Updating
  // a fork never mutates its parent or any held snapshot. Width cannot relabel
  // existing measurements: build a fresh layout for a different fingerprint.
  fork({ mode = this.mode, viewportExtent = this.viewportExtent, layoutFingerprint = this.layoutFingerprint, readOnly = false } = {}) {
    this.assertOpen(); modeOf(mode); finite(viewportExtent);
    if (layoutFingerprint !== this.layoutFingerprint) throw fail('FINGERPRINT_REBUILD_REQUIRED');
    const arena = this.arena.fork();
    try { return new TimelineRootLayout(arena, { mode, viewportExtent, layoutFingerprint,
      layoutRevision: this.layoutRevision, readOnly }); }
    catch (error) { arena.close(); throw error; }
  }
  snapshot() { return this.fork({ readOnly: true }); }
  stats() { this.assertOpen(); return Object.freeze({ ...this.info(), ownership: this.arena.inspectOwnership(),
    arena: this.arena.stats(), sourceGraphRetained: false, nativeMemoryMeasured: false }); }
  release() { if (this.closed) return; this.closed = true; this.arena.close(); }
  close() { this.release(); }
}

module.exports = { createTimelineRootLayout, TimelineRootLayout, E28_PHYSICAL_EXTENT_LIMIT, MAX_WINDOW_ITEMS, MAX_MEASUREMENTS };
