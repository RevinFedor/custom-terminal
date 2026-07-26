import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

// localStorage shim for the node test runner (module under test only uses
// getItem/setItem).
const backing = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
  setItem: (k: string, v: string) => { backing.set(k, String(v)); },
  removeItem: (k: string) => { backing.delete(k); },
};

const {
  getHistoryReadingAnchor,
  setHistoryReadingAnchor,
  deleteHistoryReadingAnchor,
  __resetHistoryReadingAnchorsForTest,
} = await import('./historyReadingAnchor.ts');

beforeEach(() => {
  backing.clear();
  __resetHistoryReadingAnchorsForTest();
});

test('set/get round-trip', () => {
  setHistoryReadingAnchor('tab:one', {
    uuid: 'u-1',
    offsetPx: 12,
    followBottom: false,
    savedAt: 111,
  });
  const anchor = getHistoryReadingAnchor('tab:one');
  assert.deepEqual(anchor, {
    uuid: 'u-1', offsetPx: 12, followBottom: false, savedAt: 111,
  });
});

test('persists to localStorage and survives an in-memory reset', async () => {
  setHistoryReadingAnchor('tab:one', {
    uuid: 'u-1',
    offsetPx: 4,
    followBottom: true,
    savedAt: 5,
  });
  // Persist is debounced; wait past it.
  await new Promise((resolve) => setTimeout(resolve, 500));
  __resetHistoryReadingAnchorsForTest();
  const anchor = getHistoryReadingAnchor('tab:one');
  assert.equal(anchor?.uuid, 'u-1');
  assert.equal(anchor?.followBottom, true);
});

test('corrupt storage yields empty set instead of throwing', () => {
  backing.set('noted-terminal-history-anchors-v1', '{not json');
  __resetHistoryReadingAnchorsForTest();
  assert.equal(getHistoryReadingAnchor('tab:x'), undefined);
});

test('delete removes the anchor', () => {
  setHistoryReadingAnchor('tab:one', {
    uuid: 'u-1', offsetPx: 0, followBottom: false, savedAt: 1,
  });
  deleteHistoryReadingAnchor('tab:one');
  assert.equal(getHistoryReadingAnchor('tab:one'), undefined);
});

test('LRU caps stored anchors', () => {
  for (let i = 0; i < 320; i += 1) {
    setHistoryReadingAnchor('tab:' + i, {
      uuid: 'u-' + i, offsetPx: 0, followBottom: false, savedAt: i,
    });
  }
  assert.equal(getHistoryReadingAnchor('tab:0'), undefined);
  assert.ok(getHistoryReadingAnchor('tab:319'));
});

test('sanitizes malformed persisted entries', () => {
  backing.set('noted-terminal-history-anchors-v1', JSON.stringify([
    ['ok', { uuid: 'u', offsetPx: -5, followBottom: 'yes', savedAt: 'x' }],
    ['bad', { nope: true }],
    'garbage',
  ]));
  __resetHistoryReadingAnchorsForTest();
  const anchor = getHistoryReadingAnchor('ok');
  assert.deepEqual(anchor, {
    uuid: 'u', offsetPx: 0, followBottom: false, savedAt: 0,
  });
  assert.equal(getHistoryReadingAnchor('bad'), undefined);
});

// DOM capture helper — stubbed rects, no jsdom. The scroller and rows only
// need getBoundingClientRect/querySelectorAll/getAttribute.
const { captureHistoryAnchorFromDom } = await import('./historyReadingAnchor.ts');

const makeRow = (uuid: string, top: number, bottom: number) => ({
  getBoundingClientRect: () => ({ top, bottom }),
  getAttribute: (name: string) => (name === 'data-uuid' ? uuid : null),
});

const makeScroller = (rows: ReturnType<typeof makeRow>[], scrollerTop = 100) => ({
  getBoundingClientRect: () => ({ top: scrollerTop }),
  querySelectorAll: () => rows,
}) as unknown as HTMLElement;

test('captures the first row whose bottom crosses the viewport top', () => {
  const scroller = makeScroller([
    makeRow('u-above', 0, 90),      // fully above
    makeRow('u-partial', 80, 140),  // crosses the top edge
    makeRow('u-below', 140, 200),
  ]);
  const anchor = captureHistoryAnchorFromDom(scroller, false);
  assert.equal(anchor?.uuid, 'u-partial');
  assert.equal(anchor?.offsetPx, 20); // scrollerTop 100 - rowTop 80
  assert.equal(anchor?.followBottom, false);
});

test('prefers a durable row over a local- row at the same position', () => {
  const scroller = makeScroller([
    makeRow('local-abc', 90, 130),
    makeRow('u-durable', 130, 190),
  ]);
  const anchor = captureHistoryAnchorFromDom(scroller, true);
  assert.equal(anchor?.uuid, 'u-durable');
  assert.equal(anchor?.followBottom, true);
});

test('falls back to the local row when nothing durable is visible', () => {
  const scroller = makeScroller([
    makeRow('local-abc', 90, 130),
  ]);
  const anchor = captureHistoryAnchorFromDom(scroller, false);
  assert.equal(anchor?.uuid, 'local-abc');
});

test('returns null when no rows are mounted', () => {
  const scroller = makeScroller([]);
  assert.equal(captureHistoryAnchorFromDom(scroller, false), null);
});
