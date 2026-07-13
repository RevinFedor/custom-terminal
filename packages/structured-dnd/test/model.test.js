import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisualHierarchyDepthMap,
  flatStructuredEntities,
  moveStructuredEntity,
  normalizeSelectedVisualRootIds,
  orderVisualHierarchyItems,
  resolveVisualBlockMove,
  resolveGroupedListTarget,
  resolveStructuredHierarchyStep,
  resolveStructuredVerticalMove,
  resolveVisualHierarchyStep,
  visualHierarchyAncestorIds,
  visualHierarchySubtreeItems,
} from '../src/index.js';

const model = () => ({
  containers: [{ id: 'g1', position: 0 }, { id: 'g2', position: 2 }],
  items: [
    { id: 'a', containerId: 'g1', position: 0 },
    { id: 'b', containerId: null, position: 1 },
    { id: 'c', containerId: 'g1', position: 1 },
  ],
});

test('container moves as one flat entity while its children stay attached', () => {
  const next = moveStructuredEntity(model(), { type: 'container', id: 'g1' }, { kind: 'flat', index: 3 });
  assert.deepEqual(flatStructuredEntities(next).map((item) => `${item.type}:${item.id}`), ['item:b', 'container:g2', 'container:g1']);
  assert.deepEqual(next.items.filter((item) => item.containerId === 'g1').sort((a, b) => a.position - b.position).map((item) => item.id), ['a', 'c']);
});

test('item can enter, reorder inside, and leave a container', () => {
  const inside = moveStructuredEntity(model(), { type: 'item', id: 'b' }, { kind: 'container', containerId: 'g1', index: 1 });
  assert.deepEqual(inside.items.filter((item) => item.containerId === 'g1').sort((a, b) => a.position - b.position).map((item) => item.id), ['a', 'b', 'c']);
  const root = moveStructuredEntity(inside, { type: 'item', id: 'b' }, { kind: 'flat', index: 1 });
  assert.equal(root.items.find((item) => item.id === 'b').containerId, null);
});

test('visual subtree moves atomically and cross-container move detaches only its root', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }, { id: 'g2', position: 1 }],
    items: [
      { id: 'a', containerId: 'g1', parentId: null, position: 0 },
      { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
      { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
      { id: 'd', containerId: 'g2', parentId: null, position: 0 },
    ],
  };
  const movedRoot = moveStructuredEntity(source, { type: 'item', id: 'a' }, { kind: 'container', containerId: 'g2', index: 1 });
  assert.deepEqual(movedRoot.items.filter((item) => ['a', 'b', 'c'].includes(item.id)).map((item) => item.containerId), ['g2', 'g2', 'g2']);
  assert.equal(movedRoot.items.find((item) => item.id === 'b').parentId, 'a');
  assert.equal(movedRoot.items.find((item) => item.id === 'c').parentId, 'b');

  const movedChild = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'container', containerId: 'g2', index: 1 });
  assert.equal(movedChild.items.find((item) => item.id === 'b').parentId, null);
  assert.equal(movedChild.items.find((item) => item.id === 'c').parentId, 'b');
  assert.equal(movedChild.items.find((item) => item.id === 'c').containerId, 'g2');

  const reorderedChild = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'container', containerId: 'g1', index: 2 });
  assert.equal(reorderedChild.items.find((item) => item.id === 'b').parentId, 'a');
  assert.equal(reorderedChild.items.find((item) => item.id === 'c').parentId, 'b');
});

test('moving a grouped visual root to flat detaches its entire subtree', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'a', containerId: 'g1', parentId: null, position: 0 },
      { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
      { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
      { id: 'outside', containerId: null, parentId: null, position: 1 },
    ],
  };

  const moved = moveStructuredEntity(source, { type: 'item', id: 'a' }, { kind: 'flat', index: 1 });
  assert.deepEqual(
    moved.items.filter((item) => ['a', 'b', 'c'].includes(item.id)).map((item) => ({
      id: item.id,
      containerId: item.containerId,
      parentId: item.parentId,
    })),
    [
      { id: 'a', containerId: null, parentId: null },
      { id: 'b', containerId: null, parentId: 'a' },
      { id: 'c', containerId: null, parentId: 'b' },
    ],
  );
  assert.equal(moved.items.some((item) => item.containerId === 'g1' && ['b', 'c'].includes(item.id)), false);
});

test('moving a grouped child to flat detaches its subtree but not its former parent', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'a', containerId: 'g1', parentId: null, position: 0 },
      { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
      { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
      { id: 'd', containerId: 'g1', parentId: 'a', position: 3 },
    ],
  };

  const moved = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'flat', index: 1 });
  assert.deepEqual(
    moved.items.map((item) => ({ id: item.id, containerId: item.containerId, parentId: item.parentId })),
    [
      { id: 'a', containerId: 'g1', parentId: null },
      { id: 'b', containerId: null, parentId: null },
      { id: 'c', containerId: null, parentId: 'b' },
      { id: 'd', containerId: 'g1', parentId: 'a' },
    ],
  );
});

test('flat ordering exposes only visual roots and detaching a child keeps its descendants', () => {
  const source = {
    containers: [],
    items: [
      { id: 'a', containerId: null, parentId: null, position: 0 },
      { id: 'b', containerId: null, parentId: 'a', position: 1 },
      { id: 'c', containerId: null, parentId: 'b', position: 2 },
      { id: 'd', containerId: null, parentId: null, position: 3 },
    ],
  };
  assert.deepEqual(flatStructuredEntities(source).map((item) => item.id), ['a', 'd']);
  const detached = moveStructuredEntity(source, { type: 'item', id: 'b' }, { kind: 'flat', index: 1 });
  assert.equal(detached.items.find((item) => item.id === 'b').parentId, null);
  assert.equal(detached.items.find((item) => item.id === 'c').parentId, 'b');
  assert.deepEqual(flatStructuredEntities(detached).map((item) => item.id), ['a', 'b', 'd']);
});

test('grouped resolver treats a group header and body as one atomic vertical block', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(20, 120), header: rect(20, 50) }],
    groups: [{ containerId: 'g1', header: rect(20, 50), body: rect(50, 120), rows: [{ id: 'a', rect: rect(60, 90, 30, 200) }], empty: null, rowLeft: 30, rowRight: 200 }],
  };
  const upper = resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 25 });
  const lowerHeader = resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 45 });
  const body = resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 80 });
  assert.deepEqual([upper.kind, upper.targetType, upper.targetId, upper.placement], ['block', 'container', 'g1', 'before']);
  assert.deepEqual([lowerHeader.kind, lowerHeader.targetType, lowerHeader.targetId, lowerHeader.placement], ['block', 'container', 'g1', 'before']);
  assert.deepEqual([body.kind, body.targetType, body.targetId, body.placement], ['block', 'container', 'g1', 'after']);
});

test('grouped resolver keeps an empty container body atomic without a placeholder element', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(20, 58), header: rect(20, 50) }],
    groups: [{ containerId: 'g1', header: rect(20, 50), body: rect(50, 58), rows: [], empty: null, rowLeft: null, rowRight: null }],
  };
  assert.deepEqual(
    resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 54 }),
    { key: 'block:container:g1:after', kind: 'block', targetType: 'container', targetId: 'g1', placement: 'after', reason: 'atomic-flat-block' },
  );
});

test('structured vertical move crosses a whole group without entering it', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'member', containerId: 'g1', parentId: null, position: 0 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
    ],
  };
  const geometry = {
    list: rect(0, 300),
    flat: [
      { type: 'container', id: 'g1', index: 0, rect: rect(20, 120), header: rect(20, 50) },
      { type: 'item', id: 'source', index: 1, rect: rect(130, 165), header: rect(130, 165) },
    ],
    groups: [{ containerId: 'g1', body: rect(50, 120), rows: [{ id: 'member', rect: rect(60, 95) }] }],
  };
  const moved = resolveStructuredVerticalMove({
    model: source,
    geometry,
    drag: { type: 'item', id: 'source' },
    clientX: 100,
    clientY: 40,
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.targetEntity.type, 'container');
  assert.deepEqual(moved.targetIds, ['container:g1', 'member']);
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, null);
  assert.deepEqual(flatStructuredEntities(moved.model).map((item) => `${item.type}:${item.id}`), ['item:source', 'container:g1']);
});

test('structured vertical move crosses sibling subtrees and preserves hierarchy/container', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'root', containerId: 'g1', parentId: null, position: 0 },
      { id: 'source', containerId: 'g1', parentId: 'root', position: 1 },
      { id: 'source-child', containerId: 'g1', parentId: 'source', position: 2 },
      { id: 'target', containerId: 'g1', parentId: 'root', position: 3 },
      { id: 'target-child', containerId: 'g1', parentId: 'target', position: 4 },
    ],
  };
  const rows = source.items.map((item, index) => ({ id: item.id, rect: rect(20 + index * 36, 52 + index * 36, 24, 200) }));
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(10, 230), header: rect(10, 20) }],
    groups: [{ containerId: 'g1', body: rect(20, 230), rows }],
  };
  const moved = resolveStructuredVerticalMove({
    model: source,
    geometry,
    drag: { type: 'item', id: 'source' },
    clientX: 100,
    clientY: 205,
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.targetIds, ['target', 'target-child']);
  assert.deepEqual(moved.orderedIds, ['root', 'target', 'target-child', 'source', 'source-child']);
  assert.equal(moved.model.items.find((item) => item.id === 'source').parentId, 'root');
  assert.equal(moved.model.items.find((item) => item.id === 'source-child').parentId, 'source');
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, 'g1');
});

test('horizontal right enters only the immediately preceding group and keeps the subtree', () => {
  const source = {
    containers: [{ id: 'g1', position: 0 }],
    items: [
      { id: 'member', containerId: 'g1', parentId: null, position: 0 },
      { id: 'source', containerId: null, parentId: null, position: 1 },
      { id: 'child', containerId: null, parentId: 'source', position: 2 },
    ],
  };
  const moved = resolveStructuredHierarchyStep({ model: source, sourceId: 'source', direction: 'right' });
  assert.equal(moved.ok, true);
  assert.equal(moved.reason, 'enter-previous-container');
  assert.equal(moved.model.items.find((item) => item.id === 'source').containerId, 'g1');
  assert.equal(moved.model.items.find((item) => item.id === 'child').containerId, 'g1');
  assert.equal(moved.model.items.find((item) => item.id === 'child').parentId, 'source');
});

test('visual hierarchy attaches to previous peer and outdents one level per step', () => {
  const items = [
    { id: 'a', containerId: null, parentId: null },
    { id: 'b', containerId: null, parentId: null },
    { id: 'c', containerId: null, parentId: null },
  ];
  const attached = resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' });
  assert.equal(attached.ok, true);
  assert.equal(attached.parentId, 'a');
  const sibling = resolveVisualHierarchyStep({ items: attached.items, sourceId: 'c', direction: 'right' });
  assert.equal(sibling.parentId, 'a');
  const nested = resolveVisualHierarchyStep({ items: sibling.items, sourceId: 'c', direction: 'right' });
  assert.equal(nested.parentId, 'b');
  assert.deepEqual(orderVisualHierarchyItems(nested.items).map((item) => item.id), ['a', 'b', 'c']);
  assert.deepEqual([...buildVisualHierarchyDepthMap(nested.items).entries()], [['a', 0], ['b', 1], ['c', 2]]);
  assert.deepEqual(visualHierarchyAncestorIds(nested.items, 'c'), ['b', 'a']);
  const outdent = resolveVisualHierarchyStep({ items: nested.items, sourceId: 'c', direction: 'left' });
  assert.equal(outdent.parentId, 'a');
  const detached = resolveVisualHierarchyStep({ items: outdent.items, sourceId: 'c', direction: 'left' });
  assert.equal(detached.parentId, null);
});

test('left steps outdent through parent, then container, then disable at flat root', () => {
  const items = [
    { id: 'a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'b', containerId: 'g1', parentId: 'a', position: 1 },
    { id: 'c', containerId: 'g1', parentId: 'b', position: 2 },
    { id: 'd', containerId: 'g1', parentId: 'c', position: 3 },
  ];

  const parentLevel = resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'left' });
  assert.equal(parentLevel.reason, 'detach-to-root');
  assert.equal(parentLevel.items.find((item) => item.id === 'b').parentId, null);
  assert.equal(parentLevel.items.find((item) => item.id === 'c').parentId, 'b');
  assert.equal(parentLevel.items.find((item) => item.id === 'b').containerId, 'g1');

  const groupLevel = resolveVisualHierarchyStep({ items: parentLevel.items, sourceId: 'b', direction: 'left' });
  assert.equal(groupLevel.reason, 'detach-from-container');
  assert.deepEqual(groupLevel.parentAssignments, { b: null, c: 'b', d: 'c' });
  assert.deepEqual(groupLevel.containerAssignments, { b: null, c: null, d: null });
  assert.deepEqual(
    groupLevel.items.filter((item) => ['b', 'c', 'd'].includes(item.id)).map((item) => ({
      id: item.id,
      containerId: item.containerId,
      parentId: item.parentId,
    })),
    [
      { id: 'b', containerId: null, parentId: null },
      { id: 'c', containerId: null, parentId: 'b' },
      { id: 'd', containerId: null, parentId: 'c' },
    ],
  );

  const disabled = resolveVisualHierarchyStep({ items: groupLevel.items, sourceId: 'b', direction: 'left' });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.reason, 'already-root');
});

test('visual hierarchy follows persisted positions after a vertical reorder', () => {
  const items = [
    { id: 'a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'b', containerId: 'g1', parentId: 'a', position: 2 },
    { id: 'c', containerId: 'g1', parentId: 'a', position: 1 },
  ];
  assert.deepEqual(orderVisualHierarchyItems(items).map((item) => item.id), ['a', 'c', 'b']);
  const nested = resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' });
  assert.equal(nested.ok, true);
  assert.equal(nested.parentId, 'c');
});

test('visual hierarchy rejects cross-container attach and disabled boundaries', () => {
  const items = [
    { id: 'a', containerId: 'g1', parentId: null },
    { id: 'b', containerId: 'g2', parentId: null },
    { id: 'flat-root', containerId: null, parentId: null },
  ];
  assert.equal(resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' }).reason, 'no-previous-peer');
  assert.equal(resolveVisualHierarchyStep({ items, sourceId: 'flat-root', direction: 'left' }).reason, 'already-root');
  const deep = [
    { id: 'a', containerId: null, parentId: null },
    { id: 'b', containerId: null, parentId: 'a' },
    { id: 'c', containerId: null, parentId: 'b' },
  ];
  assert.equal(resolveVisualHierarchyStep({ items: deep, sourceId: 'c', direction: 'right', maxDepth: 2 }).reason, 'max-depth');
});

test('visual hierarchy rejects indent when any descendant would exceed max depth', () => {
  const items = [
    { id: 'previous', containerId: null, parentId: null, position: 0 },
    { id: 'source', containerId: null, parentId: null, position: 1 },
    { id: 'd1', containerId: null, parentId: 'source', position: 2 },
    { id: 'd2', containerId: null, parentId: 'd1', position: 3 },
    { id: 'd3', containerId: null, parentId: 'd2', position: 4 },
    { id: 'd4', containerId: null, parentId: 'd3', position: 5 },
  ];

  const result = resolveVisualHierarchyStep({ items, sourceId: 'source', direction: 'right', maxDepth: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max-depth');
  assert.equal(result.sourceDepth, 0);
  assert.equal(result.sourceSubtreeMaxDepth, 4);
});

test('visual subtree helper returns all transitive descendants in visual order', () => {
  const items = [
    { id: 'outside', parentId: null, position: 0 },
    { id: 'root', parentId: null, position: 1 },
    { id: 'later-child', parentId: 'root', position: 3 },
    { id: 'first-child', parentId: 'root', position: 2 },
    { id: 'grandchild', parentId: 'first-child', position: 4 },
  ];

  assert.deepEqual(
    visualHierarchySubtreeItems(items, 'root').map((item) => item.id),
    ['root', 'first-child', 'grandchild', 'later-child'],
  );
});

test('selected visual roots ignore click order and transitively selected descendants', () => {
  const items = [
    { id: 'a', parentId: null, position: 0 },
    { id: 'b', parentId: 'a', position: 1 },
    { id: 'c', parentId: 'b', position: 2 },
    { id: 'd', parentId: null, position: 3 },
  ];

  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['d', 'a']), ['a', 'd']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['a', 'd']), ['a', 'd']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['c', 'a']), ['a']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['a', 'c']), ['a']);
});

test('visual block move crosses a foreign subtree atomically even when target is a child', () => {
  const items = [
    { id: 'source', containerId: null, parentId: null, position: 0 },
    { id: 'target', containerId: null, parentId: null, position: 1 },
    { id: 'target-a', containerId: null, parentId: 'target', position: 2 },
    { id: 'target-b', containerId: null, parentId: 'target', position: 3 },
    { id: 'after', containerId: null, parentId: null, position: 4 },
  ];

  const moved = resolveVisualBlockMove({
    items,
    sourceId: 'source',
    targetId: 'target-a',
    placement: 'after',
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.targetRootId, 'target');
  assert.deepEqual(moved.targetIds, ['target', 'target-a', 'target-b']);
  assert.deepEqual(moved.orderedIds, ['target', 'target-a', 'target-b', 'source', 'after']);
});

test('visual block move never accepts a source descendant as an external target', () => {
  const items = [
    { id: 'source', containerId: null, parentId: null, position: 0 },
    { id: 'child', containerId: null, parentId: 'source', position: 1 },
    { id: 'grandchild', containerId: null, parentId: 'child', position: 2 },
    { id: 'after', containerId: null, parentId: null, position: 3 },
  ];
  const result = resolveVisualBlockMove({ items, sourceId: 'source', targetId: 'grandchild', placement: 'after' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'target-inside-source');
});

test('visual block move reorders sibling subtrees without changing their parent', () => {
  const items = [
    { id: 'root', containerId: 'g1', parentId: null, position: 0 },
    { id: 'a', containerId: 'g1', parentId: 'root', position: 1 },
    { id: 'a-child', containerId: 'g1', parentId: 'a', position: 2 },
    { id: 'b', containerId: 'g1', parentId: 'root', position: 3 },
  ];
  const moved = resolveVisualBlockMove({ items, sourceId: 'b', targetId: 'a-child', placement: 'before' });
  assert.equal(moved.ok, true);
  assert.equal(moved.targetRootId, 'a');
  assert.deepEqual(moved.orderedIds, ['root', 'b', 'a', 'a-child']);
  assert.equal(moved.items.find((item) => item.id === 'b').parentId, 'root');
  assert.equal(moved.items.find((item) => item.id === 'b').containerId, 'g1');
});

test('visual block move reindexes only the affected sibling namespace', () => {
  const items = [
    { id: 'outside', containerId: null, parentId: null, position: 41 },
    { id: 'root', containerId: 'g1', parentId: null, position: 0 },
    { id: 'a', containerId: 'g1', parentId: 'root', position: 0 },
    { id: 'a-child', containerId: 'g1', parentId: 'a', position: 17 },
    { id: 'b', containerId: 'g1', parentId: 'root', position: 1 },
  ];

  const moved = resolveVisualBlockMove({ items, sourceId: 'b', targetId: 'a', placement: 'before' });
  assert.equal(moved.ok, true);
  assert.equal(moved.items.find((item) => item.id === 'outside').position, 41);
  assert.equal(moved.items.find((item) => item.id === 'root').position, 0);
  assert.equal(moved.items.find((item) => item.id === 'a-child').position, 17);
  assert.equal(moved.items.find((item) => item.id === 'b').position, 0);
  assert.equal(moved.items.find((item) => item.id === 'a').position, 1);
  assert.deepEqual(moved.orderedIds, ['root', 'b', 'a', 'a-child', 'outside']);
});

test('visual block move rejects a child crossing a different parent context', () => {
  const items = [
    { id: 'root-a', containerId: 'g1', parentId: null, position: 0 },
    { id: 'child-a', containerId: 'g1', parentId: 'root-a', position: 1 },
    { id: 'root-b', containerId: 'g1', parentId: null, position: 2 },
    { id: 'child-b', containerId: 'g1', parentId: 'root-b', position: 3 },
  ];
  const result = resolveVisualBlockMove({ items, sourceId: 'child-a', targetId: 'child-b', placement: 'after' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'different-parent-context');
});

test('visual block move normalizes multi-selection by visible order', () => {
  const items = [
    { id: 'a', containerId: null, parentId: null, position: 0 },
    { id: 'a-child', containerId: null, parentId: 'a', position: 1 },
    { id: 'b', containerId: null, parentId: null, position: 2 },
    { id: 'target', containerId: 'g1', parentId: null, position: 3 },
  ];
  const moved = resolveVisualBlockMove({
    items,
    sourceId: 'b',
    selectedIds: ['b', 'a-child', 'a'],
    targetId: 'target',
    placement: 'after',
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.sourceRootIds, ['a', 'b']);
  assert.deepEqual(moved.orderedIds, ['target', 'a', 'a-child', 'b']);
  assert.deepEqual(moved.containerAssignments, { a: 'g1', 'a-child': 'g1', b: 'g1' });
});

test('visual hierarchy helpers terminate on cyclic and broken parent links', () => {
  const items = [
    { id: 'a', parentId: 'b', position: 0 },
    { id: 'b', parentId: 'a', position: 1 },
    { id: 'broken-root', parentId: 'missing', position: 2 },
    { id: 'broken-child', parentId: 'broken-root', position: 3 },
  ];

  assert.deepEqual(visualHierarchySubtreeItems(items, 'a').map((item) => item.id), ['a', 'b']);
  assert.deepEqual(visualHierarchySubtreeItems(items, 'broken-root').map((item) => item.id), ['broken-root', 'broken-child']);
  assert.deepEqual(normalizeSelectedVisualRootIds(items, ['b', 'a', 'broken-child', 'broken-root']), ['broken-root', 'a']);
});
