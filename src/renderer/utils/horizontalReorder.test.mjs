import assert from 'node:assert/strict';
import test from 'node:test';

import {
  horizontalInsertIndex,
  moveEntriesToIndex,
  reorderHorizontalIds,
  sameHorizontalOrder,
} from './horizontalReorder.mjs';

test('horizontal reorder uses the same edge rule in both directions', () => {
  assert.deepEqual(reorderHorizontalIds(['a', 'b', 'c', 'd'], 'a', 'c', 'right'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(reorderHorizontalIds(['a', 'b', 'c', 'd'], 'd', 'b', 'left'), ['a', 'd', 'b', 'c']);
  assert.equal(reorderHorizontalIds(['a', 'b'], 'a', 'a', 'right')[0], 'a');
});

test('cross-strip insertion removes existing source ids before calculating the slot', () => {
  const a = { tabId: 'a' };
  const b = { tabId: 'b' };
  const c = { tabId: 'c' };
  assert.deepEqual(moveEntriesToIndex([a, b, c], [b], 2).map((entry) => entry.tabId), ['a', 'c', 'b']);
  assert.deepEqual(moveEntriesToIndex([a, c], [b], 1).map((entry) => entry.tabId), ['a', 'b', 'c']);
});

test('pointer insertion ignores the held source chip', () => {
  const chips = [
    { id: 'a', left: 0, right: 40 },
    { id: 'held', left: 45, right: 85 },
    { id: 'b', left: 90, right: 130 },
  ];
  assert.equal(horizontalInsertIndex(chips, 70, ['held']), 1);
  assert.equal(horizontalInsertIndex(chips, 200, ['held']), 2);
  assert.equal(sameHorizontalOrder(['a', 'b'], ['a', 'b']), true);
});
