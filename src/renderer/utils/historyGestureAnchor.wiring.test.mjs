import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const panelPath = new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url);
const source = fs.readFileSync(panelPath, 'utf8');

test('ordinary gestures never freeze estimated wrapper heights', () => {
  const wheelStart = source.indexOf('const handleUserScrollIntent =');
  const wheelEnd = source.indexOf('const handleHistoryTouchStart =', wheelStart);
  const wheel = source.slice(wheelStart, wheelEnd);
  assert.doesNotMatch(wheel, /freezeHistoryWheelGeometry\(/);
  assert.match(wheel, /Ordinary scrolling never freezes Virtuoso/);
  assert.match(source, /scheduleHistoryHydrationRangeCheck/);
  assert.match(source, /maybeRequestHistoryHydration\('range-idle'\)/);
});

test('fast seek alone owns frozen wrapper geometry and exact anchor handoff', () => {
  assert.match(source, /chooseHistoryGestureReleaseAnchorMode/);
  assert.match(source, /settleHistoryVisualAnchor/);
  assert.match(source, /pickHistoryGestureAnchorCandidate/);
  assert.match(source, /findHistoryUnitIndexByKey/);
  assert.match(source, /freezeHistoryWheelGeometry/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /data-item-index.*data-known-size/);
  assert.match(source, /HISTORY_WHEEL_GEOMETRY_FREEZE_HOLD_MS/);
  assert.match(source, /WHEEL_GEOMETRY_FREEZE_START/);
  assert.match(source, /WHEEL_GEOMETRY_RELEASE_(WRITE|DONE)/);
  assert.match(source, /WHEEL_GEOMETRY_BRIDGE_WRITE/);
  assert.match(source, /data-history-geometry-bridge/);
  assert.match(source, /--hp-history-geometry-bridge-y/);
  assert.match(source, /anchorMode=' \+ anchorMode/);
  assert.match(source, /trailingDelta=/);
  assert.doesNotMatch(source, /history-gesture-tail-reserve/);
  assert.match(source, /source: 'slow-real' \| 'seek-exit'/);
  assert.match(source, /skipAnimationFrameInResizeObserver/);
  assert.match(source, /overflowAnchor: 'none'/);
  assert.doesNotMatch(source, /installHistoryVirtuosoScrollByObserver/);
  assert.doesNotMatch(source, /startHistoryGestureAnchorFromScroll/);
  const freezeStart = source.indexOf('const freezeHistoryWheelGeometry =');
  const freezeEnd = source.indexOf('const scheduleHistorySeekRealRowsReady =', freezeStart);
  const freeze = source.slice(freezeStart, freezeEnd);
  assert.match(freeze, /data-known-size/);
  assert.doesNotMatch(freeze, /getBoundingClientRect\(\)\.height/);
  const transitionStart = source.indexOf('historyScrollSeekTransitionRef.current =');
  const transitionEnd = source.indexOf('useEffect(() => () => {', transitionStart);
  const transition = source.slice(transitionStart, transitionEnd);
  assert.match(transition, /event\.kind === 'enter'/);
  assert.match(transition, /freezeHistoryWheelGeometry\(scroller\)/);
});

test('fast seek hands the exact placeholder key to the exact real row', () => {
  assert.match(source, /data-history-seek-key=\{context\?\.seekUnitKeyAt\(index\)/);
  assert.match(source, /captureHistoryWheelGeometryAnchor\(scroller, 'seek'\)/);
  assert.match(source, /state\.seekExitAnchor = anchor/);
  assert.match(source, /WHEEL_GEOMETRY_SEEK_HANDOFF/);
  assert.match(source, /readHistoryWheelGeometryAnchorTop\(scroller, anchor\.identity, true\)/);
  assert.match(source, /SCROLL_SEEK_REAL_ROWS/);
  assert.match(source, /historySeekPresentationEpoch/);
  assert.match(source, /data-history-seek-geometry-settling/);
  const settleStart = source.indexOf('const settleHistoryWheelGeometryRelease =');
  const settleEnd = source.indexOf('const waitForHistoryRealAnchorAndRelease =', settleStart);
  const settle = source.slice(settleStart, settleEnd);
  assert.match(settle, /settleHistoryVisualAnchor/);
  assert.match(settle, /canCommitVisualOffset:/);
  assert.match(settle, /scroller\.scrollHeight - scroller\.clientHeight/);
  assert.match(settle, /commitVisualOffset:/);
  assert.match(settle, /subscribeGeometryChange:/);
  assert.match(settle, /new ResizeObserver/);
  assert.match(settle, /new MutationObserver/);
  assert.match(settle, /isPaused:/);
  assert.match(settle, /outcome\.reason === 'user-gesture'/);
  assert.doesNotMatch(settle, /stabilizeHistoryRevealAnchor/);
  assert.match(source, /historySeekGeometryMaskReleaseTimerRef/);
  assert.match(source, /data-history-seek-geometry-settling/);
  assert.match(source, /const fromSeekExit = state\.seekExitAnchor !== null[\s\S]*scroller\.hasAttribute\('data-history-seek-geometry-settling'\)/);
});

test('geometry release yields to every newer user gesture and machine position owner', () => {
  assert.match(source, /historyUserGestureGenerationRef\.current !== gestureGeneration/);
  assert.match(source, /historyRestoreInFlightRef\.current !== 0/);
  assert.match(source, /historyScrollInFlightRef\.current !== null/);
  assert.match(source, /hydrationRequestInFlightRef\.current/);
  assert.match(source, /terminalPreviewAnchorSettleCancelRef\.current/);
  assert.match(source, /historyScrollSeekController\.isActive\(\)/);
  assert.match(source, /historyPointerScrollActiveRef\.current/);
  assert.doesNotMatch(source, /historyScrollSeekController\.onExitOnce/);
});
