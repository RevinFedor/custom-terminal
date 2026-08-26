import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const panelPath = new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url);
const source = fs.readFileSync(panelPath, 'utf8');

test('ordinary wheel establishes a bounded semantic anchor after real motion', () => {
  assert.match(source, /shouldArmHistoryGestureAnchor/);
  assert.match(source, /pickHistoryGestureAnchorCandidate/);
  assert.match(source, /historyGestureAnchorArmRef/);
  assert.match(source, /historyGestureAnchorSettleCancelRef/);
  assert.match(source, /historyGestureAnchorSettleSignalRef\.current\?\.\(\)/);
  assert.match(source, /GESTURE_ANCHOR_(START|WRITE|DONE|SKIP)/);
  assert.match(source, /skipAnimationFrameInResizeObserver/);
  assert.match(source, /overflowAnchor: 'none'/);
});

test('the gesture anchor yields to every newer user gesture and machine owner', () => {
  assert.match(source, /historyUserGestureGenerationRef\.current !== gestureGeneration/);
  assert.match(source, /historyRestoreInFlightRef\.current !== 0/);
  assert.match(source, /historyScrollInFlightRef\.current !== null/);
  assert.match(source, /historyScrollSeekController\.isActive\(\)/);
});
