import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginSidebarTabDrag,
  endSidebarTabDrag,
  getSidebarTabDragCursorChip,
  getSidebarTabDragProjectionKey,
  getSidebarTabDragSnapshot,
  getSidebarTabDragSessionSnapshot,
  subscribeSidebarTabDragSession,
  resetSidebarTabDragForTests,
  updateSidebarTabDragPointer,
} from './sidebarTabDragBridge.mjs';
import { historyForegroundPriority } from './historyForegroundPriority.mjs';

test.afterEach(() => {
  resetSidebarTabDragForTests();
  historyForegroundPriority.resetForTests();
});

test('cross-project bridge retains the exact source subtree and latest pointer', () => {
  const sourceNode = { id: 'tab:root', entityType: 'tab', tabId: 'root', label: 'Root tab', children: [] };
  assert.equal(beginSidebarTabDrag({
    sessionId: 'drag-1',
    sourceProjectId: 'project-a',
    sourceId: 'tab:root',
    sourceNode,
    rootTabId: 'root',
    tabIds: ['root', 'child', 'child'],
    pointerId: 7,
    clientX: 10,
    clientY: 20,
    metaKey: true,
  }), true);
  assert.deepEqual(getSidebarTabDragCursorChip(), {
    sessionId: 'drag-1',
    rootTabId: 'root',
    label: 'Root tab',
    count: 2,
    clientX: 10,
    clientY: 20,
  });
  const projectionKey = getSidebarTabDragProjectionKey();
  updateSidebarTabDragPointer({
    sessionId: 'drag-1',
    pointerId: 7,
    clientX: 44,
    clientY: 88,
    metaKey: false,
  });
  assert.equal(getSidebarTabDragProjectionKey(), projectionKey);
  assert.equal(getSidebarTabDragCursorChip(), null);
  assert.deepEqual(getSidebarTabDragSnapshot(), {
    active: true,
    revision: 2,
    sessionId: 'drag-1',
    sourceProjectId: 'project-a',
    sourceId: 'tab:root',
    sourceNode,
    rootTabId: 'root',
    tabIds: ['root', 'child'],
    pointerId: 7,
    clientX: 44,
    clientY: 88,
    metaKey: false,
  });
  assert.equal(historyForegroundPriority.active(), true);
});

test('projection identity changes only with the semantic drag session', () => {
  const sourceNode = { id: 'tab:root', entityType: 'tab', tabId: 'root' };
  beginSidebarTabDrag({
    sessionId: 'drag-a', sourceProjectId: 'project-a', sourceId: 'tab:root',
    sourceNode, rootTabId: 'root', tabIds: ['root', 'child'], metaKey: true,
  });
  const first = getSidebarTabDragProjectionKey();
  updateSidebarTabDragPointer({ sessionId: 'drag-a', clientY: 320, metaKey: false });
  assert.equal(getSidebarTabDragProjectionKey(), first);

  beginSidebarTabDrag({
    sessionId: 'drag-b', sourceProjectId: 'project-a', sourceId: 'tab:root',
    sourceNode, rootTabId: 'root', tabIds: ['root', 'child'], metaKey: false,
  });
  assert.notEqual(getSidebarTabDragProjectionKey(), first);
  endSidebarTabDrag('drag-b');
  assert.equal(getSidebarTabDragProjectionKey(), '');
});

test('stale release cannot end a newer physical drag', () => {
  const sourceNode = { id: 'tab:root', entityType: 'tab', tabId: 'root' };
  beginSidebarTabDrag({
    sessionId: 'drag-old', sourceProjectId: 'a', sourceId: 'tab:root',
    sourceNode, rootTabId: 'root', tabIds: ['root'],
  });
  beginSidebarTabDrag({
    sessionId: 'drag-new', sourceProjectId: 'a', sourceId: 'tab:root',
    sourceNode, rootTabId: 'root', tabIds: ['root'],
  });
  assert.equal(endSidebarTabDrag('drag-old'), false);
  assert.equal(getSidebarTabDragSnapshot().sessionId, 'drag-new');
  assert.equal(endSidebarTabDrag('drag-new'), true);
  assert.equal(getSidebarTabDragSnapshot().active, false);
  assert.equal(historyForegroundPriority.active(), false);
});

test('pointer packets retain latest adoption coordinates without notifying every TabBar', () => {
  let changes = 0;
  const unsubscribe = subscribeSidebarTabDragSession(() => { changes++; });
  const sourceNode = { id: 'tab:a', entityType: 'tab', tabId: 'a' };
  beginSidebarTabDrag({ sessionId: 'drag', sourceProjectId: 'project', sourceId: 'tab:a',
    sourceNode, rootTabId: 'a', tabIds: ['a'], metaKey: true });
  const initial = getSidebarTabDragSessionSnapshot();
  for (let i = 1; i <= 100; i++) updateSidebarTabDragPointer({ clientX: i, clientY: i * 2 });
  assert.equal(changes, 1);
  assert.equal(getSidebarTabDragSessionSnapshot(), initial);
  assert.equal(getSidebarTabDragSnapshot().clientY, 200);
  updateSidebarTabDragPointer({ metaKey: false });
  assert.equal(changes, 2);
  assert.equal(getSidebarTabDragSessionSnapshot().clientY, 200);
  endSidebarTabDrag();
  assert.equal(changes, 3);
  assert.equal(getSidebarTabDragSessionSnapshot().active, false);
  unsubscribe();
});
