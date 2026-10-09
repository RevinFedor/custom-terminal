import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQueueRelations, groupRunAfterDependencies, queueItemDependencyTarget, layoutRunAfterCards, routeRunAfterEdges, retainRunAfterGroups } from './runAfterDependencyLayout.mjs';

test('each step points from its owner to the exact prerequisite; equal pairs are not merged', () => {
  const queue = { items: [
    { id: 'off', enabled: false, trigger: { kind: 'onTab', tabId: 'c' } },
    { id: 'first', trigger: { kind: 'onTab', tabId: 'b' } },
    { id: 'next', trigger: { kind: 'onTab', tabId: 'b' } },
  ] };
  const edges = collectQueueRelations('a', queue);
  assert.deepEqual(edges.map(e => [e.source, e.target, e.itemId, e.kind, e.enabled]), [
    ['a', 'c', 'off', 'future', false], ['a', 'b', 'first', 'current', true], ['a', 'b', 'next', 'future', true],
  ]);
  const grouped = groupRunAfterDependencies({ nodeIds: ['a', 'b', 'c'], edges });
  assert.equal(grouped[0].edges.length, 3);
});

test('legacy queue target only labels the enabled head; explicit per-item target wins', () => {
  const queue = { runAfterTabId: 'legacy', items: [
    { id: 'off', enabled: false }, { id: 'head', trigger: { kind: 'timer', seconds: 5 } }, { id: 'later' },
  ] };
  assert.equal(queueItemDependencyTarget(queue, queue.items[0]), null);
  assert.equal(queueItemDependencyTarget(queue, queue.items[1]), 'legacy');
  assert.equal(queueItemDependencyTarget(queue, queue.items[2]), null);
  queue.items[1].trigger = { kind: 'onTab', tabId: 'explicit' };
  assert.equal(queueItemDependencyTarget(queue, queue.items[1]), 'explicit');
});

test('dependencies are below their owners; independent queues stay separate', () => {
  const groups = groupRunAfterDependencies({ nodeIds: ['source', 'a', 'b', 'alone'],
    edges: [{ source: 'a', target: 'source' }, { source: 'b', target: 'source' }] });
  assert.deepEqual(groups[0].nodes.map(n => n.id), ['a', 'b', 'source']);
  assert.deepEqual(groups[1].nodes, [{ id: 'alone', depth: 0 }]);
});

test('a legacy target remains visible for a Loop queue with no enabled step', () => {
  assert.deepEqual(collectQueueRelations('owner', { items: [], runAfterTabId: 'target' }), [
    { source: 'owner', target: 'target', itemId: 'queue-target', kind: 'current', enabled: true },
  ]);
  assert.equal(queueItemDependencyTarget(undefined, undefined), null);
});

test('a long chain has constant maximum indentation, no horizontal canvas growth', () => {
  const ids = Array.from({ length: 60 }, (_, i) => 'tab-' + i);
  const [group] = groupRunAfterDependencies({ nodeIds: [...ids].reverse(),
    edges: ids.slice(0, -1).map((id, i) => ({ source: id, target: ids[i + 1] })) });
  assert.deepEqual(group.nodes.map(n => n.id), ids);
  assert.equal(Math.max(...group.nodes.map(n => n.depth)), 1);
});

test('cycles, self edges and a missing target never lose or duplicate queue nodes', () => {
  const groups = groupRunAfterDependencies({ nodeIds: ['a', 'b', 'c', 'a'],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' },
      { source: 'b', target: 'missing' }, { source: 'c', target: 'c' }] });
  assert.deepEqual(groups.flatMap(g => g.nodes.map(n => n.id)), ['a', 'b', 'c']);
  assert.ok(groups.flatMap(g => g.nodes).every(n => n.depth <= 1));
});

test('resizing only packs content-sized nodes; dimensions never stretch', () => {
  const input = { nodeIds: ['a', 'b', 'c', 'd'], edges: [{ source: 'a', target: 'b' }],
    sizes: [{ id: 'a', width: 200, height: 120 }, { id: 'b', width: 220, height: 90 },
      { id: 'c', width: 185, height: 65 }, { id: 'd', width: 195, height: 85 }] };
  const wide = layoutRunAfterCards({ ...input, availableWidth: 850 });
  const narrow = layoutRunAfterCards({ ...input, availableWidth: 270 });
  for (const layout of [wide, narrow]) {
    assert.equal(layout.nodes.length, 4);
    for (const node of layout.nodes) {
      const size = input.sizes.find(size => size.id === node.id);
      assert.equal(node.width, size.width); assert.equal(node.height, size.height);
    }
    for (const a of layout.nodes) for (const b of layout.nodes) if (a.id !== b.id) {
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  }
  assert.ok(narrow.height > wide.height);
});

test('shared prerequisite has a single full node and shallow capped indentation', () => {
  const edges = [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }, { source: 'c', target: 'd' }];
  const nodes = ['a', 'b', 'c', 'd'];
  const result = layoutRunAfterCards({ nodeIds: nodes, edges, sizes: nodes.map(id => ({ id, width: 210, height: 100 })), availableWidth: 800 });
  assert.equal(result.nodes.filter(n => n.id === 'c').length, 1);
  assert.ok(result.nodes.every(n => n.depth <= 1));
});

test('two owners share the first row, their unique prerequisite wraps to the next row', () => {
  const nodeIds = ['dashboard', 'subtitles', 'telegram'];
  const edges = [{ source: 'dashboard', target: 'subtitles', itemId: 'roles' },
    { source: 'telegram', target: 'subtitles', itemId: 'browser' }];
  const sizes = nodeIds.map(id => ({ id, width: 220, height: id === 'dashboard' ? 180 : 100 }));
  const layout = layoutRunAfterCards({ nodeIds, edges, sizes, availableWidth: 530 });
  const [dashboard, telegram, subtitles] = layout.nodes;
  assert.deepEqual(layout.nodes.map(n => n.id), ['dashboard', 'telegram', 'subtitles']);
  assert.equal(dashboard.y, telegram.y, 'the second owner must not sink below the first queue');
  assert.ok(telegram.x > dashboard.x + dashboard.width);
  assert.ok(subtitles.y > dashboard.y + dashboard.height);
});

test('adding a reverse dependency never swaps already visible cards', () => {
  const nodeIds = ['first', 'second'], sizes = nodeIds.map(id => ({ id, width: 220, height: 100 }));
  const groups = retainRunAfterGroups(null, { nodeIds, edges: [] });
  const before = layoutRunAfterCards({ nodeIds, edges: [], sizes, availableWidth: 800, groups });
  const edges = [{ source: 'second', target: 'first', itemId: 'step' }];
  const afterGroups = retainRunAfterGroups(groups, { nodeIds, edges });
  const after = layoutRunAfterCards({ nodeIds, edges, sizes, availableWidth: 800, groups: afterGroups });
  // A new horizontal corridor can add height, but must not reorder/reparent.
  const identity = nodes => nodes.map(({ id, x, column, row, depth, width, height }) => ({ id, x, column, row, depth, width, height }));
  assert.deepEqual(identity(after.nodes), identity(before.nodes));
  assert.deepEqual(retainRunAfterGroups(afterGroups, { nodeIds, edges: [] }).map(g => g.nodes), groups.map(g => g.nodes));
});

test('a new target joins its owner once without reparenting previously shown nodes', () => {
  const initial = retainRunAfterGroups(null, { nodeIds: ['a', 'b'], edges: [] });
  const next = retainRunAfterGroups(initial, { nodeIds: ['a', 'b', 'c'], edges: [{ source: 'a', target: 'c' }, { source: 'b', target: 'c' }] });
  assert.deepEqual(next.map(g => g.nodes.map(n => n.id)), [['a', 'c'], ['b']]);
  assert.equal(next[0].nodes[1].depth, 1);
  assert.deepEqual(initial.map(g => g.nodes.map(n => n.id)), [['a'], ['b']], 'previous snapshot is immutable');
  assert.deepEqual(retainRunAfterGroups(next, { nodeIds: ['b', 'c'], edges: [] }).flatMap(g => g.nodes.map(n => n.id)), ['c', 'b']);
});

test('third card uses a third column only when it fits; wrap and expansion preserve order and dimensions', () => {
  const nodeIds = ['a', 'b', 'c'], edges = [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }];
  const sizes = nodeIds.map(id => ({ id, width: 220, height: 100 }));
  for (const [availableWidth, columns] of [[530, 2], [800, 3], [270, 1], [800, 3]]) {
    const layout = layoutRunAfterCards({ nodeIds, edges, sizes, availableWidth });
    assert.equal(layout.columns, columns);
    assert.deepEqual(layout.nodes.map(n => n.id), nodeIds);
    assert.equal(new Set(layout.nodes.slice(0, columns).map(n => n.y)).size, 1);
    assert.ok(layout.width <= availableWidth);
  }
});

test('all routes avoid intermediate cards at one, two and three columns, including reverse/shared/future/self edges', () => {
  const nodeIds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const edges = [ ['a', 'c'], ['b', 'c'], ['a', 'c'], ['c', 'e'], ['e', 'b'], ['f', 'a'], ['d', 'd'], ['b', 'f'] ]
    .map(([source, target], i) => ({ source, target, itemId: 'step-' + i }));
  const sizes = nodeIds.map((id, i) => ({ id, width: 180 + i * 8, height: 160 + i * 9, topOutset: 11 }));
  const groups = retainRunAfterGroups(null, { nodeIds, edges: [] });
  const anchors = new Map(nodeIds.map(id => [id, { headerX: 0, headerY: 13,
    stepAnchors: new Map(edges.filter(e => e.source === id).map((e, i) => [e.itemId, { x: 22, y: 60 + i * 36 }])) }]));
  for (const availableWidth of [260, 510, 760, 1000]) {
    const layout = layoutRunAfterCards({ nodeIds, edges, sizes, availableWidth, groups });
    const routes = routeRunAfterEdges({ ...layout, edges, anchors });
    assert.equal(routes.length, edges.length);
    for (const route of routes) {
      assert.doesNotMatch(route.d, /NaN|undefined/);
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1], b = route.points[i];
        assert.ok(a.x === b.x || a.y === b.y, 'only orthogonal segments');
        for (const node of layout.nodes) {
          if ((i === 1 && node.id === route.source) || (i === route.points.length - 1 && node.id === route.target)) continue;
          const crosses = a.x === b.x
            ? a.x > node.x && a.x < node.x + node.width && Math.max(a.y, b.y) > node.y - node.topOutset && Math.min(a.y, b.y) < node.y + node.height
            : a.y > node.y - node.topOutset && a.y < node.y + node.height && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < node.x + node.width;
          assert.equal(crosses, false, `${availableWidth}: ${route.itemId} crosses ${node.id}`);
        }
        assert.ok(b.x >= 0 && b.y >= 0 && b.x <= layout.width && b.y <= layout.height);
      }
    }
    for (const row of layout.rows) {
      const tracks = layout.routes.filter(r => r.row === layout.rows.indexOf(row));
      assert.ok(tracks.every(r => r.viaY < row.y - row.topOutset));
    }
    const verticals = routes.flatMap(route => route.points.slice(1).flatMap((b, i) => {
      const a = route.points[i];
      return a.x === b.x && a.y !== b.y ? [{ item: route.itemId, x: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y) }] : [];
    }));
    for (const a of verticals) for (const b of verticals) {
      if (a.item === b.item || a.x !== b.x) continue;
      assert.ok(Math.min(a.to, b.to) <= Math.max(a.from, b.from), 'unrelated connections must not merge into one vertical bus');
    }
  }
});

test('disabled section keeps column gutters aligned for links back to an active card', () => {
  const nodeIds = ['a', 'b', 'c', 'd'];
  const sizes = nodeIds.map((id, i) => ({ id, width: i < 2 ? 180 : 240, height: 100 }));
  const groups = retainRunAfterGroups(null, { nodeIds, edges: [] });
  const layout = layoutRunAfterCards({ nodeIds, edges: [{ source: 'd', target: 'a', itemId: 'disabled-step' }],
    sizes, availableWidth: 600, groups, breakBefore: new Map([['c', 60]]) });
  assert.equal(layout.columns, 2);
  assert.equal(layout.nodes[0].lane, layout.nodes[2].lane);
  assert.equal(layout.nodes[1].lane, layout.nodes[3].lane);
  assert.ok(layout.nodes[2].y >= layout.separators.get('c') + 60);
});
