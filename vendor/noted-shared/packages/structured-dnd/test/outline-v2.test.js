import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceCollapsibleDwell,
  assertValidOutline,
  begin,
  boundaryFromGeometry,
  boundaryFromPointer,
  cancel,
  chooseVerticalSlot,
  cloneTree,
  commit,
  createEdgeGesture,
  detachNode,
  detachedBoundaryTops,
  edgeScrollVelocity,
  enumerateVisibleSlots,
  findNodeLocation,
  flattenVisible,
  horizontalIntent,
  indentNode,
  outlineSnapshot,
  outdentNode,
  prepareDrag,
  project,
  projectVerticalMove,
  step,
  updateEdgeGesture,
} from '@noted/structured-dnd/core';
import { createOutlineFixture } from './outline-v2.fixtures.js';

const rowIds = (tree) => flattenVisible(tree).map((row) => row.id);

const allIds = (tree) => {
  const ids = [];
  const visit = (nodes) => nodes.forEach((node) => {
    ids.push(node.id);
    visit(node.children || []);
  });
  visit(tree);
  return ids.sort();
};

test('flattenVisible hides descendants of a closed collapsible node', () => {
  const tree = [{
    id: 'section',
    label: 'Section',
    kind: 'section',
    collapsible: true,
    expanded: false,
    children: [{ id: 'hidden', kind: 'task', children: [] }],
  }];

  assert.deepEqual(rowIds(tree), ['section']);
});

test('flattenVisible preserves lazy hasChildren metadata without exposing hidden slots', () => {
  const tree = [{
    id: 'lazy-folder',
    kind: 'folder',
    collapsible: true,
    expanded: false,
    hasChildren: true,
    children: [],
  }];
  const row = flattenVisible(tree)[0];

  assert.equal(row.hasChildren, true);
  assert.equal(enumerateVisibleSlots(tree).some((slot) => slot.parentId === 'lazy-folder'), false);
});

test('flattenVisible exposes connector topology for nested sibling branches', () => {
  const tree = [{
    id: 'parent',
    kind: 'file',
    children: [{
      id: 'branch',
      kind: 'file',
      children: [{ id: 'leaf', kind: 'file', children: [] }],
    }, {
      id: 'tail',
      kind: 'file',
      children: [],
    }],
  }];
  const rows = new Map(flattenVisible(tree).map((row) => [row.id, row]));

  assert.equal(rows.get('branch').hasNextSibling, true);
  assert.deepEqual(rows.get('leaf').ancestorContinuationDepths, [0]);
  assert.equal(rows.get('tail').hasNextSibling, false);
  assert.deepEqual(rows.get('tail').ancestorContinuationDepths, []);
});

test('kind does not make a node collapsible', () => {
  const tree = [{
    id: 'folder-shaped-data',
    label: 'Folder-shaped data',
    kind: 'folder',
    collapsible: false,
    expanded: false,
    children: [{
      id: 'visible-child',
      label: 'Visible child',
      kind: 'file',
      children: [],
    }],
  }];

  assert.deepEqual(rowIds(tree), ['folder-shaped-data', 'visible-child']);
  assert.equal(flattenVisible(tree)[0].expanded, true);
  assert.equal(flattenVisible(tree)[0].collapsible, false);
  assert.equal(
    enumerateVisibleSlots(tree).some((slot) => slot.parentId === 'folder-shaped-data'),
    true,
  );
});

test('visible slots cover every rendered boundary', () => {
  const tree = createOutlineFixture('mixed');
  const visibleCount = flattenVisible(tree).length;
  const boundaries = new Set(enumerateVisibleSlots(tree).map((slot) => slot.boundary));

  for (let boundary = 0; boundary <= visibleCount; boundary += 1) {
    assert.equal(boundaries.has(boundary), true, `missing boundary ${boundary}`);
  }
});

test('closed collapsible node exposes no hidden child slot', () => {
  const slots = enumerateVisibleSlots(createOutlineFixture('mixed'));
  assert.equal(slots.some((slot) => slot.parentId === 'folder-b-closed'), false);
});

test('detaching a parent keeps its subtree atomic', () => {
  const detached = detachNode(createOutlineFixture('mixed'), 'a-child');
  assert.deepEqual(detached.detached.children[0].id, 'a-grandchild');
  assert.equal(rowIds(detached.tree).includes('a-grandchild'), false);
  assert.equal(rowIds(detached.tree).includes('a-depth-four'), false);
});

test('adjacent vertical movement changes one visible boundary', () => {
  const drag = prepareDrag(createOutlineFixture('flat'), 'flat-b');
  const projected = projectVerticalMove({
    ...drag,
    boundary: drag.slot.boundary + 1,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
  });

  assert.deepEqual(rowIds(projected.tree), ['flat-a', 'flat-c', 'flat-b', 'flat-d', 'flat-e']);
});

test('vertical movement preserves preferred depth when that slot exists', () => {
  const drag = prepareDrag(createOutlineFixture('mirrored'), 'left-child');
  const baseRows = flattenVisible(drag.baseTree);
  const boundary = baseRows.findIndex((row) => row.id === 'right-child') + 1;
  const projected = projectVerticalMove({
    ...drag,
    boundary,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
  });
  const location = findNodeLocation(projected.tree, 'left-child');

  assert.equal(location.parentId, 'right-parent');
  assert.equal(location.depth, 2);
});

test('host can restrict vertical projection to root slots without creating a dead boundary', () => {
  const drag = prepareDrag(createOutlineFixture('flat'), 'flat-a');
  const projected = projectVerticalMove({
    ...drag,
    boundary: 2,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
    canUseSlot: slot => slot.parentId == null,
  });

  assert.equal(projected.slot.parentId, null);
  assert.equal(findNodeLocation(projected.tree, 'flat-a').parentId, null);
});

test('restricted projection reports the accepted semantic boundary, not the raw pointer boundary', () => {
  const source = {
    id: 'source-group',
    kind: 'group',
    collapsible: true,
    expanded: true,
    children: [{ id: 'source-child', kind: 'item', children: [] }],
  };
  const nested = {
    id: 'nested-root',
    kind: 'item',
    children: [{ id: 'nested-child', kind: 'item', children: [] }],
  };
  const drag = prepareDrag([source, nested, { id: 'tail', kind: 'item', children: [] }], source.id);
  const rawPointerBoundary = 1;
  const projected = projectVerticalMove({
    ...drag,
    boundary: rawPointerBoundary,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
    canUseSlot: slot => slot.parentId == null,
  });

  assert.notEqual(projected.slot.boundary, rawPointerBoundary);
  assert.equal(projected.boundary, projected.slot.boundary);
  assert.notDeepEqual(detachedBoundaryTops({
    rows: flattenVisible(projected.tree).map((row, index) => ({
      id: row.id,
      top: index * 30,
      bottom: index * 30 + 27,
    })),
    sourceIds: ['source-group', 'source-child'],
    currentBoundary: projected.boundary,
  }), []);
});

test('vertical return can restore preferred depth inside an emptied parent', () => {
  for (const collapsible of [false, true]) {
    const parent = (id, child) => ({
      id,
      label: id,
      kind: collapsible ? 'section' : 'task',
      collapsible,
      expanded: collapsible ? true : false,
      children: [child],
    });
    const leaf = (id) => ({ id, kind: 'task', collapsible: false, children: [] });
    const tree = [
      parent('home', leaf('source')),
      parent('away', leaf('away-child')),
    ];
    const drag = prepareDrag(tree, 'source');
    const returned = projectVerticalMove({
      ...drag,
      boundary: 1,
      previousDepth: 1,
      currentParentId: 'away',
    });
    const location = findNodeLocation(returned.tree, 'source');

    assert.equal(location.parentId, 'home', String(collapsible));
    assert.equal(location.depth, 1, String(collapsible));
  }
});

test('an explicit shallower preferred depth does not re-enter an empty parent', () => {
  const tree = [{
    id: 'home',
    label: 'Home',
    kind: 'section',
    collapsible: true,
    expanded: true,
    children: [{ id: 'source', label: 'Source', kind: 'task', children: [] }],
  }];
  const drag = prepareDrag(tree, 'source');
  const projected = projectVerticalMove({
    ...drag,
    boundary: 1,
    preferredDepth: 0,
    previousDepth: 0,
    currentParentId: null,
  });
  const location = findNodeLocation(projected.tree, 'source');

  assert.equal(location.parentId, null);
  assert.equal(location.depth, 0);
});

test('vertical movement automatically outdents only to the deepest available parent', () => {
  const drag = prepareDrag(createOutlineFixture('mixed'), 'a-depth-four');
  const baseRows = flattenVisible(drag.baseTree);
  const boundary = baseRows.findIndex((row) => row.id === 'root-tail');
  const projected = projectVerticalMove({
    ...drag,
    boundary,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
  });
  const location = findNodeLocation(projected.tree, 'a-depth-four');

  assert.equal(location.parentId, 'b-tail');
  assert.equal(location.depth, 2);
});

test('vertical movement automatically indents only to the shallowest required slot', () => {
  const drag = prepareDrag(createOutlineFixture('mirrored'), 'empty-folder');
  const baseRows = flattenVisible(drag.baseTree);
  const boundary = baseRows.findIndex((row) => row.id === 'left-child') + 1;
  const projected = projectVerticalMove({
    ...drag,
    boundary,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
  });
  const location = findNodeLocation(projected.tree, 'empty-folder');

  assert.equal(location.parentId, 'left-folder');
  assert.equal(location.depth, 1);
});

test('slot tie prefers previous depth and then shallower depth', () => {
  const slots = [
    { parentId: 'deep', index: 0, depth: 2, boundary: 4 },
    { parentId: 'shallow', index: 1, depth: 0, boundary: 4 },
  ];
  assert.equal(chooseVerticalSlot(slots, {
    boundary: 4,
    preferredDepth: 1,
    previousDepth: 2,
  }).parentId, 'deep');
  assert.equal(chooseVerticalSlot(slots, {
    boundary: 4,
    preferredDepth: 1,
    previousDepth: 1,
  }).parentId, 'shallow');
});

test('moving a parent preserves descendant order', () => {
  const drag = prepareDrag(createOutlineFixture('mirrored'), 'left-parent');
  const projected = projectVerticalMove({
    ...drag,
    boundary: flattenVisible(drag.baseTree).length,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
  });
  const ids = rowIds(projected.tree);

  assert.equal(ids.indexOf('left-child'), ids.indexOf('left-parent') + 1);
});

test('indent makes the previous visible sibling the parent', () => {
  const result = indentNode(createOutlineFixture('flat'), 'flat-c');
  const location = findNodeLocation(result.tree, 'flat-c');

  assert.equal(result.ok, true);
  assert.equal(location.parentId, 'flat-b');
  assert.equal(location.depth, 1);
});

test('indent enters an empty collapsible node and expands it', () => {
  const tree = [
    {
      id: 'empty-parent',
      kind: 'section',
      collapsible: true,
      expanded: false,
      children: [],
    },
    { id: 'source', kind: 'task', collapsible: false, children: [] },
  ];
  const result = indentNode(tree, 'source');
  const parent = findNodeLocation(result.tree, 'empty-parent').node;

  assert.equal(result.ok, true);
  assert.equal(findNodeLocation(result.tree, 'source').parentId, 'empty-parent');
  assert.equal(parent.expanded, true);
});

test('indent into a closed nonempty collapsible node is blocked', () => {
  const tree = createOutlineFixture('mixed');
  const result = indentNode(tree, 'b-tail');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'closed-parent');
  assert.deepEqual(outlineSnapshot(result.tree), outlineSnapshot(tree));
});

test('stale collapsed state on a non-collapsible parent does not block indent', () => {
  const tree = [
    {
      id: 'non-collapsible-parent',
      label: 'Non-collapsible parent',
      kind: 'folder',
      collapsible: false,
      expanded: false,
      children: [{
        id: 'existing-child',
        kind: 'task',
        children: [],
      }],
    },
    { id: 'source', kind: 'task', children: [] },
  ];

  const result = indentNode(tree, 'source');
  assert.equal(result.ok, true);
  assert.equal(findNodeLocation(result.tree, 'source').parentId, 'non-collapsible-parent');
});

test('outdent places an item immediately after its parent subtree', () => {
  const result = outdentNode(createOutlineFixture('mixed'), 'a-child');
  const location = findNodeLocation(result.tree, 'a-child');
  const rootIds = result.tree.map((node) => node.id);

  assert.equal(result.ok, true);
  assert.equal(location.parentId, null);
  assert.equal(rootIds.indexOf('a-child'), rootIds.indexOf('folder-a') + 1);
});

test('outdent at root reports a horizontal blocker without mutation', () => {
  const tree = createOutlineFixture('flat');
  const result = outdentNode(tree, 'flat-a');

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'root-boundary');
  assert.deepEqual(outlineSnapshot(result.tree), outlineSnapshot(tree));
});

test('preparing drag from an empty parent keeps its restoration slot', () => {
  const indented = indentNode(createOutlineFixture('flat'), 'flat-b').tree;
  const drag = prepareDrag(indented, 'flat-b');
  assert.equal(drag.slot.parentId, 'flat-a');
  assert.equal(drag.slot.index, 0);
});

test('outline validation rejects duplicate stable ids', () => {
  assert.throws(() => assertValidOutline([
    { id: 'same', children: [] },
    { id: 'same', children: [] },
  ]), /Duplicate outline id/);
});

test('pointer boundary follows source top rather than row hover', () => {
  assert.equal(boundaryFromPointer({
    clientY: 202,
    grabOffsetY: 10,
    containerTop: 100,
    scrollTop: 0,
    rowHeight: 44,
    visibleCount: 8,
  }), 2);
});

test('geometry boundary includes row gaps instead of treating row height as row pitch', () => {
  const boundaryTops = Array.from({ length: 24 }, (_, index) => 100 + index * 30);
  assert.equal(boundaryFromGeometry({
    sourceTop: 100 + 18 * 30 - 2,
    boundaryTops,
  }), 18);
  assert.equal(boundaryFromGeometry({
    sourceTop: 100 + 17 * 30 + 14,
    boundaryTops,
  }), 17);
  assert.equal(boundaryFromGeometry({
    sourceTop: 100 + 17 * 30 + 16,
    boundaryTops,
  }), 18);
});

test('detached geometry preserves the current slot for a subtree with variable row heights', () => {
  const boundaryTops = detachedBoundaryTops({
    rows: [
      { id: 'before', top: 100, bottom: 127 },
      { id: 'source', top: 130, bottom: 162 },
      { id: 'source-child', top: 165, bottom: 192 },
      { id: 'after-tall', top: 195, bottom: 235 },
      { id: 'after', top: 238, bottom: 265 },
    ],
    sourceIds: ['source', 'source-child'],
    currentBoundary: 1,
  });

  assert.deepEqual(boundaryTops, [100, 130, 173, 203]);
  assert.equal(boundaryFromGeometry({ sourceTop: 128, boundaryTops }), 1);
  assert.equal(boundaryFromGeometry({ sourceTop: 151, boundaryTops }), 1);
  assert.equal(boundaryFromGeometry({ sourceTop: 152, boundaryTops }), 2);
});

test('detached geometry rejects a stale DOM order instead of projecting in the wrong direction', () => {
  assert.deepEqual(detachedBoundaryTops({
    rows: [
      { id: 'source', top: 100, bottom: 127 },
      { id: 'before', top: 130, bottom: 157 },
    ],
    sourceIds: ['source'],
    currentBoundary: 1,
  }), []);
});

test('horizontal intent has preview and commit thresholds', () => {
  assert.equal(horizontalIntent({ clientX: 105, baseX: 100 }).direction, null);
  assert.deepEqual(horizontalIntent({ clientX: 112, baseX: 100 }), {
    direction: 'right',
    deltaX: 12,
    progress: 0.3,
    crossed: false,
  });
  assert.equal(horizontalIntent({ clientX: 145, baseX: 100 }).crossed, true);
});

test('edge scroll velocity is directional and neutral in the center', () => {
  assert.equal(edgeScrollVelocity({ clientY: 120, top: 100, bottom: 500 }) < 0, true);
  assert.equal(edgeScrollVelocity({ clientY: 300, top: 100, bottom: 500 }), 0);
  assert.equal(edgeScrollVelocity({ clientY: 490, top: 100, bottom: 500 }) > 0, true);
});

test('edge gesture started inside bottom zone requires 5px edgeward intent', () => {
  let gesture = createEdgeGesture({ clientY: 480, top: 100, bottom: 500 });
  assert.deepEqual(gesture, { zone: 'bottom', active: false, anchorY: 480 });

  gesture = updateEdgeGesture(gesture, { clientY: 470, top: 100, bottom: 500 });
  assert.equal(gesture.active, false);
  gesture = updateEdgeGesture(gesture, { clientY: 474, top: 100, bottom: 500 });
  assert.equal(gesture.active, false);
  gesture = updateEdgeGesture(gesture, { clientY: 475, top: 100, bottom: 500 });
  assert.equal(gesture.active, true);
});

test('edge gesture started inside top zone is symmetric and entry from center is immediate', () => {
  let gesture = createEdgeGesture({ clientY: 120, top: 100, bottom: 500 });
  gesture = updateEdgeGesture(gesture, { clientY: 130, top: 100, bottom: 500 });
  assert.equal(gesture.active, false);
  gesture = updateEdgeGesture(gesture, { clientY: 125, top: 100, bottom: 500 });
  assert.equal(gesture.active, true);

  gesture = createEdgeGesture({ clientY: 300, top: 100, bottom: 500 });
  gesture = updateEdgeGesture(gesture, { clientY: 490, top: 100, bottom: 500 });
  assert.deepEqual(gesture, { zone: 'bottom', active: true, anchorY: 490 });
});

test('collapsible dwell repeats one deterministic toggle per completed cycle', () => {
  let result = advanceCollapsibleDwell(null, {
    targetId: 'section-a',
    now: 100,
    interval: 900,
  });
  assert.equal(result.shouldToggle, false);
  assert.deepEqual(result.dwell, {
    targetId: 'section-a',
    blocked: false,
    startedAt: 100,
    progress: 0,
    cycle: 0,
  });

  result = advanceCollapsibleDwell(result.dwell, {
    targetId: 'section-a',
    now: 550,
    interval: 900,
  });
  assert.equal(result.shouldToggle, false);
  assert.equal(result.dwell.progress, 0.5);

  result = advanceCollapsibleDwell(result.dwell, {
    targetId: 'section-a',
    now: 1_000,
    interval: 900,
  });
  assert.equal(result.shouldToggle, true);
  assert.equal(result.dwell.cycle, 1);
  assert.equal(result.dwell.progress, 0);

  result = advanceCollapsibleDwell(result.dwell, {
    targetId: 'section-a',
    now: 1_900,
    interval: 900,
  });
  assert.equal(result.shouldToggle, true);
  assert.equal(result.dwell.cycle, 2);
});

test('collapsible dwell resets on ineligible, protected and changed targets', () => {
  let result = advanceCollapsibleDwell(null, {
    targetId: 'section-a',
    now: 0,
    interval: 900,
  });
  result = advanceCollapsibleDwell(result.dwell, {
    targetId: 'section-b',
    now: 500,
    interval: 900,
  });
  assert.equal(result.shouldToggle, false);
  assert.equal(result.dwell.targetId, 'section-b');
  assert.equal(result.dwell.startedAt, 500);
  assert.equal(result.dwell.progress, 0);

  result = advanceCollapsibleDwell(result.dwell, {
    targetId: 'section-b',
    blocked: true,
    now: 1_500,
    interval: 900,
  });
  assert.equal(result.shouldToggle, false);
  assert.equal(result.dwell.blocked, true);
  assert.equal(result.dwell.progress, 0);

  result = advanceCollapsibleDwell(result.dwell, {
    targetId: null,
    now: 2_000,
    interval: 900,
  });
  assert.equal(result.shouldToggle, false);
  assert.equal(result.dwell, null);
});

test('every visible source projects safely to every visible boundary', () => {
  for (const fixture of ['flat', 'mixed', 'mirrored', 'anchor', 'long']) {
    const original = createOutlineFixture(fixture);
    const originalIds = allIds(original);

    for (const source of flattenVisible(original)) {
      const drag = prepareDrag(original, source.id);
      const sourceRows = flattenVisible([drag.sourceNode]).map((row) => row.id);
      const boundaryCount = flattenVisible(drag.baseTree).length;

      for (let boundary = 0; boundary <= boundaryCount; boundary += 1) {
        const projected = projectVerticalMove({
          ...drag,
          boundary,
          previousDepth: drag.preferredDepth,
          currentParentId: drag.sourceLocation.parentId,
        });
        const location = findNodeLocation(projected.tree, source.id);
        const visibleIds = rowIds(projected.tree);
        const sourceIndex = visibleIds.indexOf(source.id);

        assertValidOutline(projected.tree);
        assert.deepEqual(allIds(projected.tree), originalIds, `${fixture}:${source.id}:B${boundary}`);
        assert.equal(location.parentId, projected.slot.parentId);
        assert.equal(location.index, projected.slot.index);
        assert.equal(location.depth, projected.slot.depth);
        assert.deepEqual(
          visibleIds.slice(sourceIndex, sourceIndex + sourceRows.length),
          sourceRows,
          `${fixture}:${source.id}:subtree:B${boundary}`,
        );
        assert.doesNotThrow(() => prepareDrag(projected.tree, source.id));
      }
    }
  }
});

test('all one-step horizontal results preserve ids and outline validity', () => {
  for (const fixture of ['flat', 'mixed', 'mirrored', 'anchor', 'long']) {
    const original = createOutlineFixture(fixture);
    const originalIds = allIds(original);

    for (const source of flattenVisible(original)) {
      for (const operation of [indentNode, outdentNode]) {
        const result = operation(original, source.id);
        assert.deepEqual(allIds(result.tree), originalIds, `${fixture}:${source.id}`);
        assertValidOutline(result.tree);
      }
    }
  }
});

test('kind and host metadata survive cloning and projection unchanged', () => {
  const tree = [
    {
      id: 'epic',
      kind: 'roadmap-epic',
      collapsible: true,
      expanded: true,
      hostData: { color: 'red' },
      children: [{
        id: 'task',
        kind: 'roadmap-task',
        collapsible: false,
        hostData: { estimate: 3 },
        children: [],
      }],
    },
    { id: 'note', kind: 'roadmap-note', collapsible: false, children: [] },
  ];
  const cloned = cloneTree(tree);
  const drag = prepareDrag(cloned, 'task');
  const projected = projectVerticalMove({
    ...drag,
    boundary: flattenVisible(drag.baseTree).length,
    previousDepth: drag.preferredDepth,
    currentParentId: drag.sourceLocation.parentId,
  });
  const task = findNodeLocation(projected.tree, 'task').node;

  assert.equal(flattenVisible(tree)[0].kind, 'roadmap-epic');
  assert.equal(task.kind, 'roadmap-task');
  assert.deepEqual(task.hostData, { estimate: 3 });
  assert.deepEqual(tree[0].hostData, { color: 'red' });
});

test('session project and commit accept the last semantic preview', () => {
  const tree = createOutlineFixture('flat');
  const baseline = outlineSnapshot(tree);
  const started = begin(tree, 'flat-b');
  const projected = project(started, { boundary: started.boundary + 1 });
  const result = commit(projected);

  assert.notEqual(projected, started);
  assert.deepEqual(outlineSnapshot(tree), baseline);
  assert.deepEqual(rowIds(result.tree), ['flat-a', 'flat-c', 'flat-b', 'flat-d', 'flat-e']);
  assert.deepEqual(result.position, { parentId: null, index: 2, depth: 0 });
  assert.equal(result.committed, true);
});

test('session step changes one explicit depth and rebases preferred depth', () => {
  const tree = createOutlineFixture('flat');
  const started = begin(tree, 'flat-c');
  const indented = step(started, 'right');

  assert.notEqual(indented, started);
  assert.deepEqual(indented.position, { parentId: 'flat-b', index: 0, depth: 1 });
  assert.equal(indented.preferredDepth, 1);
  assert.deepEqual(indented.lastStep, { direction: 'right', ok: true, reason: 'indent' });

  const outdented = step(indented, 'left');
  assert.deepEqual(outdented.position, { parentId: null, index: 2, depth: 0 });
  assert.equal(outdented.preferredDepth, 0);
  assert.deepEqual(rowIds(outdented.tree), rowIds(tree));
});

test('blocked session step retains the last valid preview', () => {
  const tree = createOutlineFixture('flat');
  const started = begin(tree, 'flat-a');
  const blocked = step(started, 'left');

  assert.strictEqual(blocked.tree, started.tree);
  assert.deepEqual(blocked.position, started.position);
  assert.deepEqual(blocked.lastStep, {
    direction: 'left',
    ok: false,
    reason: 'root-boundary',
  });
  assert.strictEqual(commit(blocked).tree, tree);
});

test('session cancel restores the exact baseline tree and origin', () => {
  const tree = createOutlineFixture('mixed');
  const started = begin(tree, 'a-child');
  const projected = project(started, {
    boundary: flattenVisible(started.baseTree).length,
  });
  const result = cancel(projected);

  assert.notStrictEqual(projected.tree, tree);
  assert.strictEqual(result.tree, tree);
  assert.deepEqual(result.position, started.origin);
  assert.equal(result.committed, false);
});
