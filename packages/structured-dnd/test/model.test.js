import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVisualHierarchyDepthMap,
  flatStructuredEntities,
  moveStructuredEntity,
  orderVisualHierarchyItems,
  resolveGroupedListTarget,
  resolveVisualHierarchyStep,
  visualHierarchyAncestorIds,
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

test('grouped resolver distinguishes upper header, lower header, body and flat list', () => {
  const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, midY: (top + bottom) / 2 });
  const geometry = {
    list: rect(0, 300),
    flat: [{ type: 'container', id: 'g1', index: 0, rect: rect(20, 120), header: rect(20, 50) }],
    groups: [{ containerId: 'g1', header: rect(20, 50), body: rect(50, 120), rows: [{ id: 'a', rect: rect(60, 90, 30, 200) }], empty: null, rowLeft: 30, rowRight: 200 }],
  };
  assert.equal(resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 25 }).kind, 'flat');
  assert.equal(resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 45 }).kind, 'container');
  assert.deepEqual(resolveGroupedListTarget({ geometry, drag: { type: 'item', id: 'x' }, clientX: 100, clientY: 80 }).index, 1);
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
  ];
  assert.equal(resolveVisualHierarchyStep({ items, sourceId: 'b', direction: 'right' }).reason, 'no-previous-peer');
  assert.equal(resolveVisualHierarchyStep({ items, sourceId: 'a', direction: 'left' }).reason, 'already-root');
  const deep = [
    { id: 'a', containerId: null, parentId: null },
    { id: 'b', containerId: null, parentId: 'a' },
    { id: 'c', containerId: null, parentId: 'b' },
  ];
  assert.equal(resolveVisualHierarchyStep({ items: deep, sourceId: 'c', direction: 'right', maxDepth: 2 }).reason, 'max-depth');
});
