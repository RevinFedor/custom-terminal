import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkflowActivityCounts } from './workflowActivityCounts.mjs';

test('green active and orange loader counts are independent', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', processAlive: true, busy: true },
    { tabId: 'b', sdkAlive: true },
    { tabId: 'c', pasteBusy: true },
    { tabId: 'd', inheritedBusy: true },
  ]), {
    activeCount: 2,
    busyCount: 3,
    awaitingCount: 0,
    completionNotificationCount: 0,
  });
});
test('one tab is counted once per signal even when several sources agree', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', processAlive: true, sdkAlive: true, busy: true, pasteBusy: true },
    { tabId: 'a', processAlive: true, inheritedBusy: true },
  ]), {
    activeCount: 1,
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
