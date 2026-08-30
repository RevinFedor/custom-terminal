import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginSidebarTabDrag,
  endSidebarTabDrag,
  getSidebarTabDragProjectionKey,
  getSidebarTabDragSnapshot,
  resetSidebarTabDragForTests,
  updateSidebarTabDragPointer,
} from './sidebarTabDragBridge.mjs';
import { historyForegroundPriority } from './historyForegroundPriority.mjs';

test.afterEach(() => {
  resetSidebarTabDragForTests();
  historyForegroundPriority.resetForTests();
});

test('cross-project bridge retains the exact source subtree and latest pointer', () => {
  const sourceNode = { id: 'tab:root', entityType: 'tab', tabId: 'root', children: [] };
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
  const projectionKey = getSidebarTabDragProjectionKey();
  updateSidebarTabDragPointer({
    sessionId: 'drag-1',
    pointerId: 7,
    clientX: 44,
    clientY: 88,
    metaKey: false,
  });
  assert.equal(getSidebarTabDragProjectionKey(), projectionKey);
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
