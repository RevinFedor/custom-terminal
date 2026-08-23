import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOutlineTabDragPayload,
  resolveTabSelectionDragPayload,
} from './tabDragPayload.mjs';

const tab = (id, parent = null) => ({ id, visualParentTabId: parent || undefined });

test('project transfer expands a selected root while pane placement keeps only the root', () => {
  const payload = resolveTabSelectionDragPayload([
    tab('parent'),
    tab('child', 'parent'),
    tab('grandchild', 'child'),
    tab('other'),
  ], ['parent'], 'parent');
  assert.deepEqual(payload.rootIds, ['parent']);
  assert.deepEqual(payload.projectIds, ['parent', 'child', 'grandchild']);
  assert.deepEqual(payload.descendantIds, ['child', 'grandchild']);
});

test('multi-select normalizes parent plus child and expands every independent root once', () => {
  const payload = resolveTabSelectionDragPayload([
    tab('parent'),
    tab('child', 'parent'),
    tab('other'),
    tab('other-child', 'other'),
  ], ['child', 'other', 'parent'], 'parent');
  assert.deepEqual(payload.rootIds, ['parent', 'other']);
  assert.deepEqual(payload.projectIds, ['parent', 'child', 'other', 'other-child']);
});

test('dragging an unselected row ignores the old selection but still carries its descendants to a project', () => {
  const payload = resolveTabSelectionDragPayload([
    tab('a'), tab('b'), tab('b-child', 'b'),
  ], ['a'], 'b');
  assert.deepEqual(payload.rootIds, ['b']);
  assert.deepEqual(payload.projectIds, ['b', 'b-child']);
});

test('outline payload exposes one pane root and the complete project subtree', () => {
  const payload = resolveOutlineTabDragPayload({
    entityType: 'tab',
    tabId: 'root',
    children: [{ entityType: 'tab', tabId: 'child', children: [] }],
  });
  assert.deepEqual(payload.rootIds, ['root']);
  assert.deepEqual(payload.projectIds, ['root', 'child']);
});
