import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutRunAfterDependencyGraph } from './runAfterDependencyLayout.mjs';

test('branching dependency centres the source and keeps independent chains separate', () => {
  const [branch, chain, standalone] = layoutRunAfterDependencyGraph({
    nodeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    edges: [
      { source: 'a', target: 'b', kind: 'current' },
      { source: 'a', target: 'c', kind: 'current' },
      { source: 'd', target: 'e', kind: 'current' },
    ],
    nodeWidth: 260,
    nodeHeight: 34,
  });

  assert.deepEqual(branch.nodes.map((node) => node.id), ['a', 'b', 'c']);
  const positions = new Map(branch.nodes.map((node) => [node.id, node]));
  assert.equal(positions.get('a').y, (positions.get('b').y + positions.get('c').y) / 2);
  assert.deepEqual(chain.nodes.map((node) => node.id), ['d', 'e']);
  assert.deepEqual(standalone.nodes.map((node) => node.id), ['f']);
});

test('one current relation replaces the same future projection', () => {
  const [component] = layoutRunAfterDependencyGraph({
    nodeIds: ['a', 'b'],
    edges: [
      { source: 'a', target: 'b', kind: 'future' },
      { source: 'a', target: 'b', kind: 'current' },
    ],
  });
  assert.deepEqual(component.edges, [{ source: 'a', target: 'b', kind: 'current' }]);
});

test('damaged cyclic legacy data still produces finite visible geometry', () => {
  const [component] = layoutRunAfterDependencyGraph({
    nodeIds: ['a', 'b'],
    edges: [
      { source: 'a', target: 'b', kind: 'future' },
      { source: 'b', target: 'a', kind: 'future' },
    ],
  });
  assert.equal(component.nodes.length, 2);
  assert.ok(Number.isFinite(component.width));
  assert.ok(Number.isFinite(component.height));
});

