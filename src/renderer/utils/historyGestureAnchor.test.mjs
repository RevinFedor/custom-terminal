import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseHistoryGestureReleaseAnchorMode,
  findHistoryUnitIndexByKey,
  pickHistoryGestureAnchorCandidate,
  settleHistoryMeasuredAnchor,
  settleHistoryVisualAnchor,
} from './historyGestureAnchor.mjs';
import { stabilizeHistoryRevealAnchor } from './historyRevealAnchor.mjs';

const frames = () => {
  const queue = [];
  return {
    requestFrame: (callback) => queue.push(callback),
    step: () => queue.shift()?.(),
    flush: () => { while (queue.length > 0) queue.shift()(); },
  };
};

test('anchor is selected near the viewport centre so overscan retains it', () => {
  const picked = pickHistoryGestureAnchorCandidate([
    { identity: 'top', top: -20, bottom: 80 },
    { identity: 'middle', top: 410, bottom: 560 },
    { identity: 'bottom', top: 900, bottom: 1050 },
  ], 0, 1000);
  assert.equal(picked?.identity, 'middle');
});

test('release follows stable display-unit identity after positional regrouping', () => {
  const keys = ['prompt:a', 'group:b', 'answer:c'];
  assert.equal(findHistoryUnitIndexByKey(keys, 'group:b'), 1);
  assert.equal(findHistoryUnitIndexByKey(['new:x', ...keys], 'group:b'), 2);
  assert.equal(findHistoryUnitIndexByKey(keys, 'missing'), -1);
});

test('tab-776 tail shrink preserves the user tail gap instead of repinning the list', () => {
  assert.equal(chooseHistoryGestureReleaseAnchorMode({
    bottomGapPx: 4,
    trailingHeightDeltaPx: -75,
    measuredRows: 1,
  }), 'tail-gap');
  assert.equal(chooseHistoryGestureReleaseAnchorMode({
    bottomGapPx: 80,
    trailingHeightDeltaPx: -75,
    measuredRows: 1,
  }), 'semantic-row');
  assert.equal(chooseHistoryGestureReleaseAnchorMode({
    bottomGapPx: 4,
    trailingHeightDeltaPx: -75,
    measuredRows: 0,
  }), 'semantic-row');
});

test('tail-gap convergence keeps a tiny upward gesture unpinned through geometry release', () => {
  const queue = frames();
  let scrollHeight = 6562;
  const clientHeight = 1072;
  let scrollTop = 5486;
  const targetGap = 4;
  stabilizeHistoryRevealAnchor({
    targetTop: targetGap,
    readAnchorTop: () => scrollHeight - clientHeight - scrollTop,
    adjustScrollBy: (delta) => { scrollTop += delta; },
    requestFrame: queue.requestFrame,
    minimumFrames: 2,
    maxFrames: 3,
    stableFramesRequired: 2,
  });
  scrollHeight = 6658;
  queue.flush();
  assert.equal(scrollTop, 5582);
  assert.equal(scrollHeight - clientHeight - scrollTop, targetGap);
});

test('visual release bridge hides estimate -> real -> virtualizer compensation ping-pong', () => {
  const queue = frames();
  let naturalTop = 784;
  let visualOffset = 0;
  const visibleSamples = [];
  let committed = null;
  let outcome = null;
  settleHistoryVisualAnchor({
    targetTop: 100,
    readVisualTop: () => naturalTop + visualOffset,
    setVisualOffset: (next) => {
      visualOffset = next;
      visibleSamples.push(naturalTop + visualOffset);
    },
    commitVisualOffset: (offset, reason) => {
      committed = { offset, reason };
      naturalTop += offset;
      visualOffset = 0;
      visibleSamples.push(naturalTop);
    },
    requestFrame: queue.requestFrame,
    minimumObservationFrames: 3,
    quietFramesRequired: 2,
    maxFrames: 12,
    onFinish: (value) => { outcome = value; },
  });

  assert.equal(naturalTop + visualOffset, 100, 'release is corrected synchronously');
  naturalTop = 100; // Virtuoso publishes the measured size on the next frame.
  queue.flush();
  assert.deepEqual(visibleSamples, [100, 100, 100]);
  assert.deepEqual(committed, { offset: 0, reason: 'settled' });
  assert.equal(outcome?.maxDriftPx, 684);
  assert.equal(outcome?.corrections, 2);
});

test('a newer wheel atomically consumes an outstanding visual offset', () => {
  const queue = frames();
  let naturalTop = 130;
  let visualOffset = 0;
  let newerGesture = false;
  let committed = null;
  settleHistoryVisualAnchor({
    targetTop: 100,
    readVisualTop: () => naturalTop + visualOffset,
    setVisualOffset: (next) => { visualOffset = next; },
    commitVisualOffset: (offset, reason) => {
      committed = { offset, reason };
      naturalTop += offset;
      visualOffset = 0;
    },
    hasUserGesture: () => newerGesture,
    requestFrame: queue.requestFrame,
  });
  assert.equal(naturalTop + visualOffset, 100);
  newerGesture = true;
  queue.step();
  assert.deepEqual(committed, { offset: -30, reason: 'user-gesture' });
  assert.equal(naturalTop, 100);
});

test('visual offset is not committed while the old scroll range would clamp it', () => {
  const queue = frames();
  let naturalTop = 780;
  let visualOffset = 0;
  let rangeReady = false;
  let committed = null;
  settleHistoryVisualAnchor({
    targetTop: 100,
    readVisualTop: () => naturalTop + visualOffset,
    setVisualOffset: (next) => { visualOffset = next; },
    canCommitVisualOffset: () => rangeReady,
    commitVisualOffset: (offset, reason) => { committed = { offset, reason }; },
    requestFrame: queue.requestFrame,
    minimumObservationFrames: 2,
    quietFramesRequired: 2,
    maxFrames: 12,
  });
  for (let index = 0; index < 5; index += 1) queue.step();
  assert.equal(committed, null);
  assert.equal(naturalTop + visualOffset, 100);
  rangeReady = true;
  queue.flush();
  assert.deepEqual(committed, { offset: -680, reason: 'settled' });
});

test('measured settle waits out Virtuoso compensation before its one semantic write', () => {
  const queue = frames();
  const writes = [];
  let anchorTop = 100;
  let outcome = null;
  settleHistoryMeasuredAnchor({
    targetTop: 100,
    readAnchorTop: () => anchorTop,
    adjustScrollBy: (delta) => {
      writes.push(delta);
      anchorTop -= delta;
    },
    requestFrame: queue.requestFrame,
    minimumObservationFrames: 3,
    minimumPostCorrectionFrames: 2,
    quietFramesRequired: 2,
    maxFrames: 20,
    onFinish: (value) => { outcome = value; },
  });

  anchorTop = 40;
  queue.step();
  anchorTop = 130;
  queue.step();
  anchorTop = 80;
  queue.step();
  assert.equal(writes.length, 0, 'no application write while geometry is moving');
  queue.step();
  queue.step();
  assert.deepEqual(writes, [-20]);
  queue.flush();
  assert.equal(anchorTop, 100);
  assert.equal(outcome?.reason, 'settled');
  assert.equal(outcome?.writes, 1);
});

test('a position signal resets quietness but never writes synchronously', () => {
  const queue = frames();
  const writes = [];
  let signal = () => {};
  let anchorTop = 90;
  settleHistoryMeasuredAnchor({
    targetTop: 100,
    readAnchorTop: () => anchorTop,
    adjustScrollBy: (delta) => {
      writes.push(delta);
      anchorTop -= delta;
    },
    subscribePositionChange: (listener) => {
      signal = listener;
      return () => {};
    },
    requestFrame: queue.requestFrame,
    minimumObservationFrames: 2,
    minimumPostCorrectionFrames: 2,
    quietFramesRequired: 2,
    maxFrames: 20,
  });
  queue.step();
  queue.step();
  signal();
  assert.equal(writes.length, 0);
  queue.step();
  queue.step();
  queue.step();
  assert.deepEqual(writes, [-10]);
});

test('machine-owned measurement pauses quiet settle without consuming its bound', () => {
  const queue = frames();
  const writes = [];
  let paused = true;
  let anchorTop = 80;
  let outcome = null;
  settleHistoryMeasuredAnchor({
    targetTop: 100,
    readAnchorTop: () => anchorTop,
    adjustScrollBy: (delta) => {
      writes.push(delta);
      anchorTop -= delta;
    },
    isPaused: () => paused,
    requestFrame: queue.requestFrame,
    minimumObservationFrames: 2,
    minimumPostCorrectionFrames: 2,
    quietFramesRequired: 2,
    maxFrames: 8,
    onFinish: (value) => { outcome = value; },
  });
  for (let index = 0; index < 8; index += 1) queue.step();
  assert.equal(writes.length, 0);
  assert.equal(outcome, null);
  paused = false;
  queue.flush();
  assert.deepEqual(writes, [-20]);
  assert.equal(outcome?.reason, 'settled');
  assert.equal(outcome?.pausedFrames, 8);
});

for (const incident of [
  { name: 'tab-4196 +1112 height / +384.5 scroll correction', drift: -384.5 },
  { name: 'tab-812 -333 height / -331 scroll correction', drift: 331 },
]) {
  test(`${incident.name} is returned to the user-owned semantic frame`, () => {
    const queue = frames();
    const writes = [];
    let anchorTop = 450;
    stabilizeHistoryRevealAnchor({
      targetTop: 450,
      readAnchorTop: () => anchorTop,
      adjustScrollBy: (delta, source) => {
        writes.push({ delta, source });
        anchorTop -= delta;
      },
      requestFrame: queue.requestFrame,
      minimumFrames: 2,
      maxFrames: 3,
      stableFramesRequired: 2,
    });
    anchorTop += incident.drift;
    queue.flush();
    assert.equal(anchorTop, 450);
    assert.equal(writes.length, 1);
  });
}
