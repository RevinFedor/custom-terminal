import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTabOutline,
  resolveEmptyUtilityDropTarget,
  tabOutlineHorizontalPolicy,
  tabOutlineToLayout,
  tabOutlineVerticalSlotPolicy,
} from './tabOutlineModel.mjs';

const tab = (id, options = {}) => ({ id, name: id, ...options });
const group = (id, options = {}) => ({ id, name: id, createdAt: 1, ...options });

test('tab outline keeps groups, visual descendants, and empty anchors in one tree', () => {
  const outline = buildTabOutline([
    tab('a', { groupId: 'g1' }),
    tab('a-child', { groupId: 'g1', visualParentTabId: 'a' }),
    tab('tail'),
  ], [group('empty', { anchorTabId: 'tail' }), group('g1')]);

  assert.deepEqual(outline.map(node => `${node.entityType}:${node.groupId || node.tabId}`), [
    'group:g1',
    'group:empty',
    'tab:tail',
  ]);
  assert.equal(outline[0].children[0].tabId, 'a');
  assert.equal(outline[0].children[0].children[0].tabId, 'a-child');
});

test('tab commit serializes the complete moved subtree atomically', () => {
  const original = buildTabOutline([
    tab('parent'),
    tab('child', { visualParentTabId: 'parent' }),
    tab('target', { groupId: 'g' }),
  ], [group('g')]);
  const parent = original[0];
  const targetGroup = original[1];
  const preview = [{ ...targetGroup, children: [...targetGroup.children, parent] }];
  const layout = tabOutlineToLayout(preview);

  assert.equal(layout.ok, true);
  assert.deepEqual(layout.orderedIds, ['target', 'parent', 'child']);
  assert.equal(layout.groupAssignments.parent, 'g');
  assert.equal(layout.groupAssignments.child, 'g');
  assert.equal(layout.visualParentAssignments.child, 'parent');
});

test('empty group anchor follows the next top-level block', () => {
  const outline = buildTabOutline([tab('a')], [group('empty')]);
  const preview = [outline[1], outline[0]];
  const layout = tabOutlineToLayout(preview);
  assert.equal(layout.groupAnchorAssignments.empty, 'a');
});

test('groups cannot acquire hierarchy depth and tabs stop at depth four', () => {
  assert.deepEqual(
    tabOutlineHorizontalPolicy({ sourceNode: { entityType: 'group' }, result: { ok: true, depth: 1 } }),
    { ok: false, reason: 'group-depth-locked' },
  );
  assert.deepEqual(
    tabOutlineHorizontalPolicy({
      sourceNode: { id: 'source', entityType: 'tab' },
      result: {
        ok: true,
        tree: [{ id: 'a', entityType: 'tab', children: [{ id: 'b', entityType: 'tab', children: [{ id: 'c', entityType: 'tab', children: [{ id: 'd', entityType: 'tab', children: [{ id: 'e', entityType: 'tab', children: [{ id: 'source', entityType: 'tab', children: [] }] }] }] }] }] }],
      },
    }),
    { ok: false, reason: 'max-depth' },
  );
});

test('vertical host policy keeps groups at root and does not count the group as tab depth', () => {
  const baseOutline = [{
    id: 'group',
    entityType: 'group',
    children: [{ id: 'parent', entityType: 'tab', children: [] }],
  }];
  assert.equal(tabOutlineVerticalSlotPolicy({
    sourceNode: { entityType: 'group' },
    baseOutline,
    slot: { parentId: 'parent' },
  }), false);
  assert.equal(tabOutlineVerticalSlotPolicy({
    sourceNode: { entityType: 'tab' },
    baseOutline,
    slot: { parentId: 'parent' },
  }), true);
});

test('empty utility target requires an intentional downward gesture without changing tree geometry', () => {
  const containerRect = { left: 0, right: 200, top: 60, bottom: 900 };
  assert.equal(resolveEmptyUtilityDropTarget({
    clientX: 100,
    clientY: 859,
    startY: 860,
    containerRect,
  }), null);
  assert.equal(resolveEmptyUtilityDropTarget({
    clientX: 100,
    clientY: 860,
    startY: 860,
    containerRect,
  }), null);
  assert.deepEqual(resolveEmptyUtilityDropTarget({
    clientX: 100,
    clientY: 861,
    startY: 860,
    containerRect,
  }), { id: 'utility', zone: 'utility', insertIndex: 0 });
  assert.equal(resolveEmptyUtilityDropTarget({
    clientX: 100,
    clientY: 820,
    startY: 700,
    containerRect,
  }), null);
});
