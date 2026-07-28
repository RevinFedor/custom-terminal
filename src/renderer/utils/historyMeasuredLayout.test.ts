import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';

const {
  saveHistoryMeasuredLayout,
  getHistoryMeasuredLayout,
  dropHistoryMeasuredLayout,
  __resetHistoryMeasuredLayoutForTest,
  __historyMeasuredLayoutSizeForTest,
} = await import('./historyMeasuredLayout.ts');

const snap = (n = 3, scrollTop = 100) => ({
  ranges: Array.from({ length: n }, (_, i) => ({ startIndex: i, endIndex: i, size: 40 })),
  scrollTop,
});

beforeEach(() => __resetHistoryMeasuredLayoutForTest());

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

test('discards geometry after a large shape change (rewind/edit)', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3), 500);
  assert.equal(getHistoryMeasuredLayout('tab:a', 100), null);
  // and the stale entry is gone, not merely hidden
  assert.equal(__historyMeasuredLayoutSizeForTest(), 0);
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

test('re-saving the same owner replaces, not duplicates', () => {
  saveHistoryMeasuredLayout('tab:a', snap(3, 10), 500);
  saveHistoryMeasuredLayout('tab:a', snap(5, 999), 500);
  assert.equal(__historyMeasuredLayoutSizeForTest(), 1);
  assert.equal(getHistoryMeasuredLayout('tab:a', 500)?.scrollTop, 999);
});
