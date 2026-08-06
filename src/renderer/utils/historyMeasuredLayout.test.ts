import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// localStorage shim for the node test runner (the module persists geometry
// the same way the reading anchor does).
const backing = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => { backing.set(k, String(v)); },
  removeItem: (k: string) => { backing.delete(k); },
};

const {
  saveHistoryMeasuredLayout,
  getHistoryMeasuredLayout,
  dropHistoryMeasuredLayout,
  updateHistoryMeasuredLayoutScrollTop,
  estimateHistoryAverageRowHeight,
  createHistoryRowHeightLookup,
  pickHistoryMountWaveTarget,
  __resetHistoryMeasuredLayoutForTest,
  __historyMeasuredLayoutSizeForTest,
} = await import('./historyMeasuredLayout.ts');

const snap = (n = 3, scrollTop = 100) => ({
  ranges: Array.from({ length: n }, (_, i) => ({ startIndex: i, endIndex: i, size: 40 })),
  scrollTop,
});

beforeEach(() => {
  backing.clear();
  __resetHistoryMeasuredLayoutForTest();
});

test('round-trips a snapshot for the same owner', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3, 250), 500);
  const got = getHistoryMeasuredLayout('tab:a', 500);
  assert.equal(got?.scrollTop, 250);
  assert.equal(got?.ranges.length, 3);
});

test('unknown owner returns null', () => {
  assert.equal(getHistoryMeasuredLayout('tab:missing', 10), null);
});

test('refuses to store an empty measurement set', () => {
  assert.equal(saveHistoryMeasuredLayout('tab:a', { ranges: [], scrollTop: 0 }, 10), false);
  assert.equal(getHistoryMeasuredLayout('tab:a', 10), null);
});

test('rejects null/garbage snapshots without throwing', () => {
  assert.equal(saveHistoryMeasuredLayout('tab:a', null, 10), false);
  assert.equal(saveHistoryMeasuredLayout('tab:a', undefined, 10), false);
  assert.equal(saveHistoryMeasuredLayout('', snap(), 10), false);
  assert.equal(__historyMeasuredLayoutSizeForTest(), 0);
});

test('tolerates rows appended while away', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3), 500);
  // A live turn added a few messages — geometry still describes the list.
  assert.ok(getHistoryMeasuredLayout('tab:a', 512));
});

test('refuses to restore after a large shape change but keeps the entry', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3), 500);
  assert.equal(getHistoryMeasuredLayout('tab:a', 100), null);
  // A read with a foreign count is a transient (owner-switch frame renders
  // the previous tab's rows) — it must not destroy valid stored geometry.
  assert.ok(getHistoryMeasuredLayout('tab:a', 500), 'correct count still restores');
});

test('explicit drop clears one owner only', () => {
  saveHistoryMeasuredLayout('tab:a', snap(), 10);
  saveHistoryMeasuredLayout('tab:b', snap(), 10);
  dropHistoryMeasuredLayout('tab:a');
  assert.equal(getHistoryMeasuredLayout('tab:a', 10), null);
  assert.ok(getHistoryMeasuredLayout('tab:b', 10));
});

test('evicts the least recently used owner past the cap', () => {
  for (let i = 0; i < 20; i += 1) {
    saveHistoryMeasuredLayout('tab:' + i, snap(), 10);
  }
  assert.equal(__historyMeasuredLayoutSizeForTest(), 12);
  assert.equal(getHistoryMeasuredLayout('tab:0', 10), null);
  assert.ok(getHistoryMeasuredLayout('tab:19', 10));
});

test('a read refreshes recency so an active tab survives eviction', () => {
  for (let i = 0; i < 12; i += 1) saveHistoryMeasuredLayout('tab:' + i, snap(), 10);
  // tab:0 is the eviction candidate — touch it, then push one more owner in.
  assert.ok(getHistoryMeasuredLayout('tab:0', 10));
  saveHistoryMeasuredLayout('tab:new', snap(), 10);
  assert.ok(getHistoryMeasuredLayout('tab:0', 10), 'recently read owner must survive');
  assert.equal(getHistoryMeasuredLayout('tab:1', 10), null);
});

test('refuses a zero offset that would overwrite a real position', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3, 43140), 2304);
  // The transient "list is still at the top" sample seen right after a
  // restore is applied — accepting it lost the user's place entirely.
  assert.equal(saveHistoryMeasuredLayout('tab:a', snap(3, 0), 2304), false);
  assert.equal(getHistoryMeasuredLayout('tab:a', 2304)?.scrollTop, 43140);
});

test('accepts a zero offset when nothing better is stored', () => {
  // A genuine top-of-list visit must still be recordable.
  assert.equal(saveHistoryMeasuredLayout('tab:top', snap(3, 0), 100), true);
  assert.equal(getHistoryMeasuredLayout('tab:top', 100)?.scrollTop, 0);
});

test('re-saving the same owner replaces, not duplicates', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3, 10), 500);
  saveHistoryMeasuredLayout('tab:a', snap(5, 999), 500);
  assert.equal(__historyMeasuredLayoutSizeForTest(), 1);
  assert.equal(getHistoryMeasuredLayout('tab:a', 500)?.scrollTop, 999);
});

test('live scrollTop patch updates the stored offset in place', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3, 500), 500);
  updateHistoryMeasuredLayoutScrollTop('tab:a', 1234.6);
  assert.equal(getHistoryMeasuredLayout('tab:a', 500)?.scrollTop, 1235);
});

test('live patch refuses a transient zero over a real position', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3, 500), 500);
  updateHistoryMeasuredLayoutScrollTop('tab:a', 0);
  assert.equal(getHistoryMeasuredLayout('tab:a', 500)?.scrollTop, 500);
});

test('live patch is a no-op without a stored snapshot', () => {
  updateHistoryMeasuredLayoutScrollTop('tab:none', 700);
  assert.equal(getHistoryMeasuredLayout('tab:none', 10), null);
  assert.equal(__historyMeasuredLayoutSizeForTest(), 0);
});

test('persists to localStorage and survives an in-memory reset', async () => {
  saveHistoryMeasuredLayout('tab:persist', snap(3, 4321), 500);
  // Persistence is debounced; wait past it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  __resetHistoryMeasuredLayoutForTest();
  // backing intentionally NOT cleared — simulating an app restart.
  assert.equal(getHistoryMeasuredLayout('tab:persist', 500)?.scrollTop, 4321);
});

test('average row height weighs ranges by row count', () => {
  // 10 rows of 40px + 2 rows of 500px → (400+1000)/12 ≈ 117
  const snapshot = {
    ranges: [
      { startIndex: 0, endIndex: 9, size: 40 },
      { startIndex: 10, endIndex: 11, size: 500 },
    ],
    scrollTop: 0,
  };
  assert.equal(estimateHistoryAverageRowHeight(snapshot), 117);
});

test('average row height rejects empty/garbage snapshots', () => {
  assert.equal(estimateHistoryAverageRowHeight(null), null);
  assert.equal(estimateHistoryAverageRowHeight({ ranges: [], scrollTop: 0 }), null);
  assert.equal(
    estimateHistoryAverageRowHeight({ ranges: [{ nope: 1 }], scrollTop: 0 }),
    null,
  );
});

test('drops malformed and expired persisted entries on load', async () => {
  const now = Date.now();
  backing.set('noted-terminal-history-measured-layout-v1', JSON.stringify([
    ['tab:ok', {
      snapshot: { ranges: [{ startIndex: 0, endIndex: 4, size: 40 }], scrollTop: 77 },
      itemCount: 5, savedAt: now,
    }],
    ['tab:garbage-ranges', {
      snapshot: { ranges: [{ nope: true }], scrollTop: 10 }, itemCount: 5, savedAt: now,
    }],
    ['tab:expired', {
      snapshot: { ranges: [{ startIndex: 0, endIndex: 4, size: 40 }], scrollTop: 10 },
      itemCount: 5, savedAt: now - 15 * 24 * 60 * 60 * 1000,
    }],
    'not-an-entry',
  ]));
  __resetHistoryMeasuredLayoutForTest();
  assert.equal(getHistoryMeasuredLayout('tab:ok', 5)?.scrollTop, 77);
  assert.equal(getHistoryMeasuredLayout('tab:garbage-ranges', 5), null);
  assert.equal(getHistoryMeasuredLayout('tab:expired', 5), null);
  assert.equal(__historyMeasuredLayoutSizeForTest(), 1);
});

test('height lookup answers stored size per index, fallback elsewhere', () => {
  const lookup = createHistoryRowHeightLookup({
    ranges: [
      { startIndex: 0, endIndex: 2, size: 40 },
      { startIndex: 3, endIndex: 3, size: 500 },
      { startIndex: 4, endIndex: 9, size: 120 },
    ],
    scrollTop: 0,
  }, 111);
  assert.equal(lookup(0), 40);
  assert.equal(lookup(2), 40);
  assert.equal(lookup(3), 500);
  assert.equal(lookup(7), 120);
  // Beyond every measured range → fallback (rows never scrolled past).
  assert.equal(lookup(10), 111);
});

test('height lookup without a snapshot is a constant fallback', () => {
  const lookup = createHistoryRowHeightLookup(null, 90);
  assert.equal(lookup(0), 90);
  assert.equal(lookup(999), 90);
});

test('wave target prefers the topmost shell inside the viewport', () => {
  const picked = pickHistoryMountWaveTarget(
    [
      { uuid: 'above', top: -900, bottom: -700 },
      { uuid: 'second-visible', top: 400, bottom: 600 },
      { uuid: 'first-visible', top: 100, bottom: 380 },
      { uuid: 'below', top: 2000, bottom: 2200 },
    ],
    { top: 0, bottom: 800 },
  );
  assert.equal(picked, 'first-visible');
});

test('wave target margin catches near-viewport rows before far ones', () => {
  const picked = pickHistoryMountWaveTarget(
    [
      { uuid: 'far-below', top: 3000, bottom: 3100 },
      { uuid: 'just-above', top: -150, bottom: -60 },
    ],
    { top: 0, bottom: 800 },
    200,
  );
  assert.equal(picked, 'just-above');
});

test('wave target with nothing near the viewport takes the topmost mounted shell', () => {
  const picked = pickHistoryMountWaveTarget(
    [
      { uuid: 'lower', top: 5000, bottom: 5100 },
      { uuid: 'upper', top: 3000, bottom: 3100 },
    ],
    { top: 0, bottom: 800 },
  );
  assert.equal(picked, 'upper');
});

test('wave target on an empty candidate set is null', () => {
  assert.equal(pickHistoryMountWaveTarget([], { top: 0, bottom: 800 }), null);
  assert.equal(pickHistoryMountWaveTarget([], null), null);
});

test('a sparse re-save cannot replace rich coverage; offset still refreshes', () => {
  saveHistoryMeasuredLayout('tab:rich', {
    ranges: [{ startIndex: 0, endIndex: 999, size: 100 }],
    scrollTop: 50000,
  }, 1000);
  // A Timeline-jump visit measured only a 30-row neighborhood.
  const accepted = saveHistoryMeasuredLayout('tab:rich', {
    ranges: [{ startIndex: 500, endIndex: 529, size: 90 }],
    scrollTop: 44000,
  }, 1000);
  assert.equal(accepted, false);
  const kept = getHistoryMeasuredLayout('tab:rich', 1000);
  assert.equal(kept?.ranges.length, 1);
  assert.equal((kept?.ranges[0] as any).endIndex, 999, 'rich ranges survive');
  assert.equal(kept?.scrollTop, 44000, 'offset refreshed from the sparse save');
});

test('a comparable-coverage re-save replaces normally', () => {
  saveHistoryMeasuredLayout('tab:even', {
    ranges: [{ startIndex: 0, endIndex: 999, size: 100 }],
    scrollTop: 100,
  }, 1000);
  const accepted = saveHistoryMeasuredLayout('tab:even', {
    ranges: [{ startIndex: 0, endIndex: 899, size: 110 }],
    scrollTop: 200,
  }, 1000);
  assert.equal(accepted, true);
  assert.equal((getHistoryMeasuredLayout('tab:even', 1000)?.ranges[0] as any).size, 110);
});

test('coverage guard does not apply across a shape change', () => {
  saveHistoryMeasuredLayout('tab:reshaped', {
    ranges: [{ startIndex: 0, endIndex: 999, size: 100 }],
    scrollTop: 100,
  }, 1000);
  // Rewind truncated the session — small new list, sparse measurements are
  // the ONLY truth about it now. (Non-zero offset: the transient-zero guard
  // is a separate, older rule and rewinds drop the geometry anyway.)
  const accepted = saveHistoryMeasuredLayout('tab:reshaped', {
    ranges: [{ startIndex: 0, endIndex: 9, size: 80 }],
    scrollTop: 40,
  }, 10);
  assert.equal(accepted, true);
});
