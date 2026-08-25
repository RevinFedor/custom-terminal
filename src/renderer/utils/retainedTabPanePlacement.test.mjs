import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pruneRetainedTabPanePlacements,
  resolveRetainedTabPanePlacement,
  resolveTabSurfacePanePlacement,
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

test('zero-pane mode keeps warmed pane tabs but never wraps a never-pane tab', () => {
  const cache = new Map([['A', placement(0, 'left')], ['closed', placement(1, 'right')]]);
  assert.equal(resolveRetainedTabPanePlacement(cache, 'A', null), cache.get('A'));
  assert.equal(resolveRetainedTabPanePlacement(cache, 'new', null), null);
  assert.equal(pruneRetainedTabPanePlacements(cache, new Set(['A'])), 1);
  assert.deepEqual([...cache.keys()], ['A']);
});

test('4→0→2 suppresses only the active center tab and retains all dormant pane parents', () => {
  const cache = new Map();
  const four = ['A', 'B', 'C', 'D'].map((id, index) => [id, placement(index, `four-${index}`)]);
  const two = ['E', 'F'].map((id, index) => [id, placement(index, `two-${index}`)]);
  for (const [tabId, value] of [...four, ...two]) {
    resolveRetainedTabPanePlacement(cache, tabId, value);
  }

  for (const [tabId, value] of [...four, ...two]) {
    assert.equal(
      resolveTabSurfacePanePlacement(cache, tabId, null, false),
      value,
      `${tabId} keeps its SplitPaneSurface while another workflow is single-center`,
    );
  }
  assert.equal(
    resolveTabSurfacePanePlacement(cache, 'CENTER', null, true),
    null,
    'only the one globally presented center tab stays center-owned',
  );
  assert.equal(cache.size, 6);
});
