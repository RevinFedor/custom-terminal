import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginSidebarTabDrag,
  endSidebarTabDrag,
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
  updateSidebarTabDragPointer({
    sessionId: 'drag-1',
    pointerId: 7,
    clientX: 44,
    clientY: 88,
    metaKey: false,
  });
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
