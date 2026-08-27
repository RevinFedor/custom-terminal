import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const panel = fs.readFileSync(
  new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
  'utf8',
);

test('hydration retains only the already presented physical window', () => {
  assert.match(panel, /collectHistoryMaterializedWindowUuids/);
  assert.match(panel, /retainHistoryMaterializedWindow/);
  assert.match(panel, /materializeHistoryWindowForPresentation\(\s*rawServerEntries/);
  assert.match(panel, /MATERIALIZED_WINDOW_RETAIN/);
});

test('range publications coalesce to one settled centre', () => {
  assert.match(panel, /HISTORY_HYDRATION_RANGE_IDLE_MS/);
  assert.match(panel, /historyHydrationCenterForRange/);
  assert.match(panel, /rangeChanged=\{\(range\)[\s\S]*scheduleHistoryHydrationRangeCheck\(\)/);
  assert.doesNotMatch(panel, /rangeChanged=\{\(range\)[\s\S]{0,800}maybeRequestHistoryHydration\('range-changed'\)/);
});

test('hydrated presentation arms its semantic anchor before React can publish new heights', () => {
  const guard = panel.indexOf("historyPresentationApplyGuardRef.current('refresh:");
  const transition = panel.indexOf('startTransition(() => {', guard);
  assert.ok(guard >= 0 && transition > guard);
  assert.match(panel, /source: 'hydration-apply'/);
  assert.match(panel, /MATERIALIZED_WINDOW_APPLY_START/);
  assert.match(panel, /source !== 'hydration-apply' && hydrationRequestInFlightRef\.current/);
});
