import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkflowActivityCounts } from './workflowActivityCounts.mjs';

test('green active and orange loader counts are independent', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', processAlive: true, busy: true },
    { tabId: 'b', sdkAlive: true },
    { tabId: 'c', pasteBusy: true },
    { tabId: 'd', inheritedBusy: true },
  ]), { activeCount: 2, busyCount: 3 });
});
test('one tab is counted once per signal even when several sources agree', () => {
  assert.deepEqual(resolveWorkflowActivityCounts([
    { tabId: 'a', processAlive: true, sdkAlive: true, busy: true, pasteBusy: true },
    { tabId: 'a', processAlive: true, inheritedBusy: true },
  ]), { activeCount: 1, busyCount: 1 });
});

test('invalid/empty input is quiet', () => {
  assert.deepEqual(resolveWorkflowActivityCounts(null), { activeCount: 0, busyCount: 0 });
  assert.deepEqual(resolveWorkflowActivityCounts([{ tabId: '' }, null]), { activeCount: 0, busyCount: 0 });
});
