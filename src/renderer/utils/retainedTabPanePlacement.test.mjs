import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pruneRetainedTabPanePlacements,
  resolveRetainedTabPanePlacement,
} from './retainedTabPanePlacement.mjs';

const placement = (paneIndex, geometry) => ({ paneIndex, geometry, panes: [], sizes: null });

test('A→B→A keeps each warmed tab on the same retained placement object', () => {
  const cache = new Map();
  const a = placement(0, 'left');
  const b = placement(0, 'left');

  assert.equal(resolveRetainedTabPanePlacement(cache, 'A', a), a);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'A', null), a);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'B', b), b);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'B', null), b);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'A', a), a);
});

test('a real new placement replaces retained geometry without losing identity cache', () => {
  const cache = new Map();
  const oldPlacement = placement(0, 'left');
  const movedPlacement = placement(2, 'right-bottom');
  resolveRetainedTabPanePlacement(cache, 'A', oldPlacement);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'A', movedPlacement), movedPlacement);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'A', null), movedPlacement);
});

test('single mode does not wrap never-pane tabs and closed tabs are pruned', () => {
  const cache = new Map([['A', placement(0, 'left')], ['closed', placement(1, 'right')]]);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'new', null, false), null);
  assert.equal(pruneRetainedTabPanePlacements(cache, new Set(['A'])), 1);
  assert.deepEqual([...cache.keys()], ['A']);
});
