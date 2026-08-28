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

test('tail-follow refresh has one position owner and never starts the semantic bridge', () => {
  const start = panel.indexOf('historyPresentationApplyGuardRef.current =');
  const end = panel.indexOf('const waitForHistoryRealAnchorAndRelease =', start);
  const guard = panel.slice(start, end);
  const ownerChoice = guard.indexOf('chooseHistoryMaterializedApplyOwner');
  const tailReturn = guard.indexOf("materializedApplyOwner === 'tail-pin'", ownerChoice);
  const semanticCapture = guard.indexOf("captureHistoryWheelGeometryAnchor(scroller, 'real')", tailReturn);
  assert.ok(ownerChoice >= 0 && tailReturn > ownerChoice && semanticCapture > tailReturn);
  assert.match(guard, /followBottom: isAtBottomRef\.current/);
  assert.match(guard, /tailPinPending: historyTailPinScheduler\.isPending\(\)/);
  assert.match(guard, /keepHistoryTailPinnedAfterMutation\('materialized-window-apply:' \+ reason, true\)/);
  assert.match(guard, /MATERIALIZED_WINDOW_APPLY_TAIL_OWNED/);
  assert.match(guard.slice(tailReturn, semanticCapture), /return;/);
});
