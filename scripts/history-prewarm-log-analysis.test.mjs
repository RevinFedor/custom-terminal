import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeHistoryPrewarmLog } from './history-prewarm-log-analysis.mjs';

const boot = 'boot-new';
const lines = [
  `00:00:01.000 date=x boot=boot-old [Perf:IpcSlow] channel=agent-transcript:get-history durMs=999 endAbs=1999 tab=old-tab`,
  `00:00:01.100 date=x boot=${boot} [HistoryHandoff] LOAD_START tab=hidden-a session=a seq=1 generation=1 refresh=0 cache=miss`,
  `00:00:01.200 date=x boot=${boot} [HistoryHandoff] LOAD_START tab=hidden-b session=b seq=1 generation=1 refresh=0 cache=miss`,
  `00:00:02.000 date=x boot=${boot} [Perf:IpcSlow] channel=agent-transcript:get-history durMs=1000 endAbs=2000 tab=hidden-a`,
  `00:00:02.100 date=x boot=${boot} [Perf:IpcSlow] channel=agent-transcript:get-history durMs=800 endAbs=2100 tab=hidden-b`,
  `00:00:02.200 date=x boot=${boot} [Perf:IpcSlow] channel=agent-transcript:get-history durMs=201 endAbs=2200 tab=visible`,
  `00:00:03.000 date=x boot=${boot} [HistoryHandoff] SCROLL_GESTURE_BEGIN tab=mFs-tab-3951 gid=1 eventTs=1 receivedAbs=1 inputDelayMs=42.5 deltaY=-4 deltaMode=0 scrollTop=1`,
  `00:00:03.010 date=x boot=${boot} [HistoryHandoff] SCROLL_GESTURE_INPUT tab=mFs-tab-3951 gid=1 seq=1 deltaY=-4 deltaMode=0`,
  `00:00:03.020 date=x boot=${boot} [HistoryHandoff] SCROLL_GESTURE_INPUT tab=mFs-tab-3951 gid=1 seq=2 deltaY=-103 deltaMode=0`,
  `00:00:03.500 date=x boot=${boot} [HistoryHandoff] WHEEL_GEOMETRY_BRIDGE_WRITE tab=mFs-tab-3951 key=x path=slow-real source=release-sync offset=-12.5`,
  `00:00:03.600 date=x boot=${boot} [Perf:LongTask] durationMs=84 name=self during=history-mount-wave activeTab=mFs-tab-3951`,
  `00:00:03.700 date=x boot=${boot} [Perf:PanePrewarmAdmission] phase=queued tab=hidden-a token=0 pending=2`,
  `00:00:03.710 date=x boot=${boot} [Perf:PanePrewarmAdmission] phase=start tab=hidden-a token=1 pending=1`,
  `00:00:03.720 date=x boot=${boot} [Perf:PanePrewarm] phase=start tab=hidden-a token=1 requirements=history:load`,
  `00:00:03.730 date=x boot=${boot} [Perf:PanePrewarmAdmission] phase=complete tab=hidden-a token=1 pending=1 reason=initial-source-settled`,
  `00:00:03.740 date=x boot=${boot} [Perf:PanePrewarmAdmission] phase=start tab=hidden-b token=2 pending=0`,
  `00:00:03.750 date=x boot=${boot} [Perf:PanePrewarmAdmission] phase=complete tab=hidden-b token=2 pending=0 reason=initial-source-settled`,
].join('\n');

test('analysis isolates one boot and computes overlap, wheel and bridge maxima', () => {
  const result = analyzeHistoryPrewarmLog(lines, { bootId: boot, tabSuffix: 'tab-3951' });
  assert.equal(result.history.slowRequests, 3);
  assert.equal(result.history.coldStarts, 2);
  assert.equal(result.history.maxConcurrent, 3);
  assert.equal(result.scroll.gestures, 1);
  assert.equal(result.scroll.wheelEvents, 2);
  assert.equal(result.scroll.maxInputDelayMs, 42.5);
  assert.equal(result.scroll.maxAbsWheelDelta, 103);
  assert.equal(result.scroll.maxAbsBridgeOffset, 12.5);
  assert.equal(result.scroll.seekEnters, 0);
  assert.equal(result.scroll.placeholderFrames, 0);
  assert.equal(result.renderer.maxLongTaskMs, 84);
  assert.equal(result.prewarm.admissionStarts, 2);
  assert.equal(result.prewarm.admissionCompletes, 2);
  assert.equal(result.prewarm.maxHiddenConcurrent, 1);
  assert.equal(result.prewarm.maxPending, 2);
});

test('analysis defaults to the latest boot and honours a timestamp window', () => {
  const result = analyzeHistoryPrewarmLog(lines, {
    tabSuffix: 'tab-3951',
    from: '00:00:02.050',
    to: '00:00:03.550',
  });
  assert.equal(result.bootId, boot);
  assert.equal(result.history.slowRequests, 2);
  assert.equal(result.history.coldStarts, 0);
  assert.equal(result.scroll.wheelEvents, 2);
  assert.equal(result.renderer.longTasks, 0);
  assert.equal(result.prewarm.admissionStarts, 0);
});

test('analysis exposes the production-visible failure where ordinary scroll hides every real row', () => {
  const productionFailure = [
    `05:17:08.170 date=x boot=${boot} [HistoryHandoff] SCROLL_SEEK_ENTER tab=mFs-tab-4060 velocity=-258 burst=0 wheelGesture=1 owner=x`,
    `05:17:08.451 date=x boot=${boot} [HistoryHandoff] SCROLL_GESTURE_FRAME tab=mFs-tab-4060 gid=1 phase=motion-3 ageMs=441 domRows=0 shells=0 stubs=0 follow=0 seek=1 restore=0`,
    `05:17:08.500 date=x boot=${boot} [HistoryHandoff] SCROLL_GESTURE_FRAME tab=mFs-tab-4060 gid=1 phase=post-paint ageMs=490 domRows=0 shells=0 stubs=0 follow=0 seek=1 restore=0`,
  ].join('\n');

  const result = analyzeHistoryPrewarmLog(productionFailure, {
    bootId: boot,
    tabSuffix: 'tab-4060',
  });
  assert.equal(result.scroll.seekEnters, 1);
  assert.equal(result.scroll.placeholderFrames, 2);
  assert.deepEqual(result.scroll.seekTransitions, [{
    velocity: -258,
    burst: false,
    wheelGesture: true,
  }]);
});
