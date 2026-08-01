import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTabOutline,
  tabOutlineHorizontalPolicy,
  tabOutlineSubtreeTabIds,
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

test('root group can move past another group as one ordered block', () => {
  const outline = buildTabOutline([
    tab('a-root', { groupId: 'a' }),
    tab('a-child', { groupId: 'a', visualParentTabId: 'a-root' }),
    tab('b-root', { groupId: 'b' }),
    tab('b-child', { groupId: 'b', visualParentTabId: 'b-root' }),
  ], [group('a'), group('b')]);
  const layout = tabOutlineToLayout([outline[1], outline[0]]);

  assert.equal(layout.ok, true);
  assert.deepEqual(layout.orderedIds, ['b-root', 'b-child', 'a-root', 'a-child']);
  assert.deepEqual(layout.groupAssignments, {
    'b-root': 'b',
    'b-child': 'b',
    'a-root': 'a',
    'a-child': 'a',
  });
});

test('moving a tab subtree out of a group clears every descendant assignment', () => {
  const outline = buildTabOutline([
    tab('parent', { groupId: 'g' }),
    tab('child', { groupId: 'g', visualParentTabId: 'parent' }),
    tab('remaining', { groupId: 'g' }),
  ], [group('g')]);
  const groupNode = outline[0];
  const source = groupNode.children[0];
  const preview = [source, { ...groupNode, children: groupNode.children.slice(1) }];
  const layout = tabOutlineToLayout(preview);

  assert.equal(layout.ok, true);
  assert.deepEqual(layout.orderedIds, ['parent', 'child', 'remaining']);
  assert.equal(layout.groupAssignments.parent, null);
  assert.equal(layout.groupAssignments.child, null);
  assert.equal(layout.groupAssignments.remaining, 'g');
  assert.equal(layout.visualParentAssignments.child, 'parent');
});

test('cross-project source ids include the selected tab and its complete visual subtree', () => {
  const outline = buildTabOutline([
    tab('root'),
    tab('child', { visualParentTabId: 'root' }),
    tab('grandchild', { visualParentTabId: 'child' }),
    tab('sibling'),
  ]);

  assert.deepEqual(tabOutlineSubtreeTabIds(outline, 'root'), ['root', 'child', 'grandchild']);
  assert.deepEqual(tabOutlineSubtreeTabIds(outline, 'child'), ['child', 'grandchild']);
  assert.deepEqual(tabOutlineSubtreeTabIds(outline, 'missing'), []);
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

test('legacy utility tabs participate in the only remaining main outline', () => {
  const outline = buildTabOutline([
    tab('legacy-utility', { isUtility: true }),
    tab('main'),
  ]);
  assert.deepEqual(outline.map(node => node.tabId), ['legacy-utility', 'main']);
});
