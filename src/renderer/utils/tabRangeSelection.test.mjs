import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTabRangeSelection } from './tabRangeSelection.mjs';

test('Shift range follows visible order in both directions', () => {
  const order = ['a', 'b', 'c', 'd'];
  assert.deepEqual(resolveTabRangeSelection(order, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(resolveTabRangeSelection(order, 'd', 'b'), ['b', 'c', 'd']);
});

test('a hidden/missing anchor degrades to the hovered tab, never invisible rows', () => {
  assert.deepEqual(resolveTabRangeSelection(['a', 'c'], 'hidden-b', 'c'), ['c']);
  assert.deepEqual(resolveTabRangeSelection(['a', 'c'], 'a', 'missing'), []);
});

test('duplicate ids cannot duplicate a selected or dragged tab', () => {
  assert.deepEqual(resolveTabRangeSelection(['a', 'b', 'b', 'c'], 'a', 'c'), ['a', 'b', 'c']);
});
