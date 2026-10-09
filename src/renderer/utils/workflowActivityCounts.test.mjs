import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkflowActivityCounts } from './workflowActivityCounts.mjs';
import { allPaneTabIds } from './splitPanesModel.mjs';
import { tabSpaceIndexMap } from './workspaceSpacesModel.mjs';

test('green idle, orange own work and purple MCP waiting are separate categories', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', processAlive: true, busy: true },
    { tabId: 'b', sdkAlive: true },
    { tabId: 'c', pasteBusy: true },
    { tabId: 'd', inheritedBusy: true },
  ]), {
    activeCount: 1,
    busyCount: 2,
    inheritedBusyCount: 1,
    awaitingCount: 0,
    completionNotificationCount: 0,
  });
});
test('one tab is counted once per signal even when several sources agree', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', processAlive: true, sdkAlive: true, busy: true, pasteBusy: true },
    { tabId: 'a', processAlive: true, inheritedBusy: true },
  ]), {
    activeCount: 0,
    busyCount: 1,
    awaitingCount: 0,
    completionNotificationCount: 0,
  });
});

test('awaiting and completion signals aggregate once on the owning workflow', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', awaiting: true, completionNotificationFired: true },
    { tabId: 'a', awaiting: true, completionNotificationFired: true },
    { tabId: 'b', completionNotificationFired: true },
  ]), {
    activeCount: 0,
    busyCount: 0,
    awaitingCount: 1,
    completionNotificationCount: 2,
  });
});

test('invalid/empty input is quiet', () => {
  const empty = { activeCount: 0, busyCount: 0, awaitingCount: 0, completionNotificationCount: 0 };
  assert.deepEqual(resolveWorkflowActivityCounts(null), empty);
  assert.deepEqual(resolveWorkflowActivityCounts([{ tabId: '' }, null]), empty);
});

test('MCP waiting is purple, excluded from green, and not hidden by another orange tab', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'idle', processAlive: true },
    { tabId: 'working', processAlive: true, busy: true },
    { tabId: 'waiting', processAlive: true, inheritedBusy: true },
    { tabId: 'waiting', processAlive: true, inheritedBusy: true },
  ]), { activeCount: 1, busyCount: 1, inheritedBusyCount: 1, awaitingCount: 0, completionNotificationCount: 0 });
});

test('own work wins over inherited work per tab, without also counting its process green', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'both', sdkAlive: true, sendPending: true, inheritedBusy: true },
    { tabId: 'waiting-without-process', inheritedBusy: true },
  ]), { activeCount: 0, busyCount: 1, inheritedBusyCount: 1, awaitingCount: 0, completionNotificationCount: 0 });
});

test('busy follows the workflow that physically holds the tab, not its project parent', () => {
  const spaces = [
    {
      id: 'main',
      projectIds: ['project-main'],
      layout: {
        splitPanes: [{ projectId: 'project-ios', tabId: 'ios-busy', column: 0 }],
      },
    },
    {
      id: 'main-ios-app',
      projectIds: ['project-ios'],
      layout: {
        splitPanes: [{ projectId: 'project-ios', tabId: 'ios-idle', column: 0 }],
      },
    },
  ];
  const ownerByTab = tabSpaceIndexMap(spaces, allPaneTabIds, 'main');
  const entries = [
    { tabId: 'ios-busy', busy: true },
    { tabId: 'orphan-busy', busy: true },
  ];
  const activityFor = (spaceIndex) => resolveWorkflowActivityCounts(
    entries.filter((entry) => ownerByTab.get(entry.tabId) === spaceIndex),
  );

  assert.equal(ownerByTab.get('ios-busy'), 0, 'layout, not projectIds, owns activity');
  assert.equal(activityFor(0).busyCount, 1, 'actual main placement shows the loader');
  assert.equal(activityFor(1).busyCount, 0, 'project parent does not inherit a foreign loader');
  assert.equal(ownerByTab.has('orphan-busy'), false, 'unplaced activity is not assigned by folder');
});
