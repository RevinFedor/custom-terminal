import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowsLayoutAnimationForMotionPreference,
  changedOutlineLayoutKeys,
  layoutFlipDelta,
  layoutAnimationBudgetReason,
  layoutAnimationCancelReason,
  normalizeLayoutAnimation,
  verticalFlipDelta,
} from './layoutAnimation.js';

test('layout animation can be configured or disabled by the host', () => {
  assert.equal(normalizeLayoutAnimation(false).enabled, false);
  assert.deepEqual(normalizeLayoutAnimation({ duration: 160, easing: 'linear' }), {
    enabled: true,
    duration: 160,
    easing: 'linear',
    respectReducedMotion: true,
    maxAnimatedRows: 16,
    minRetargetInterval: 32,
    animateDuringScroll: false,
  });
  assert.equal(normalizeLayoutAnimation({ duration: -20 }).duration, 0);
  assert.deepEqual(
    normalizeLayoutAnimation({
      maxAnimatedRows: 8.9,
      minRetargetInterval: 0,
      animateDuringScroll: true,
    }),
    {
      enabled: true,
      duration: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      respectReducedMotion: true,
      maxAnimatedRows: 8,
      minRetargetInterval: 0,
      animateDuringScroll: true,
    },
  );
});

test('outline layout diff isolates rows whose index or depth actually changed', () => {
  const before = [
    { id: 'a', depth: 0 },
    { id: 'a-child', depth: 1 },
    { id: 'b', depth: 0 },
    { id: 'c', depth: 0 },
  ];
  const after = [
    { id: 'b', depth: 0 },
    { id: 'a', depth: 0 },
    { id: 'a-child', depth: 1 },
    { id: 'c', depth: 0 },
  ];

  assert.deepEqual(
    [...changedOutlineLayoutKeys(before, after)].sort(),
    ['a', 'a-child', 'b'],
  );
  assert.deepEqual(
    [...changedOutlineLayoutKeys(
      [{ id: 'a', depth: 0 }],
      [{ id: 'a', depth: 1 }],
    )],
    ['a'],
  );
});

test('animation budget favors direct layout during scroll, bursts, and large moves', () => {
  const config = normalizeLayoutAnimation(true);
  assert.equal(layoutAnimationBudgetReason({
    animationConfig: config,
    origin: 'scroll',
    changedRows: 2,
  }), 'scroll');
  assert.equal(layoutAnimationBudgetReason({
    animationConfig: config,
    sourceRows: 17,
    changedRows: 17,
  }), 'source-row-budget');
  assert.equal(layoutAnimationBudgetReason({
    animationConfig: config,
    sourceRows: 6,
    changedRows: 7,
    projectedActiveRows: 17,
  }), 'active-row-budget');
  assert.equal(layoutAnimationBudgetReason({
    animationConfig: config,
    sourceRows: 6,
    changedRows: 7,
    projectedActiveRows: 8,
    elapsedSinceLayoutChange: 16,
  }), 'retarget-rate');
  assert.equal(layoutAnimationBudgetReason({
    animationConfig: config,
    sourceRows: 6,
    changedRows: 7,
    projectedActiveRows: 8,
    elapsedSinceLayoutChange: 40,
  }), null);
});

test('host can keep layout animation enabled under reduced-motion', () => {
  const defaultConfig = normalizeLayoutAnimation(true);
  const forcedConfig = normalizeLayoutAnimation({ respectReducedMotion: false });

  assert.equal(allowsLayoutAnimationForMotionPreference(defaultConfig, true), false);
  assert.equal(allowsLayoutAnimationForMotionPreference(forcedConfig, true), true);
  assert.equal(allowsLayoutAnimationForMotionPreference(defaultConfig, false), true);
});

test('pointer revisions preserve an active FLIP until layout or mode changes', () => {
  assert.equal(layoutAnimationCancelReason({
    dragging: true,
    layoutChangeAxis: 'vertical',
  }), null);
  assert.equal(layoutAnimationCancelReason({
    layoutChanged: true,
    dragging: true,
    layoutChangeAxis: 'vertical',
  }), 'retarget');
  assert.equal(layoutAnimationCancelReason({
    dragging: true,
    layoutChangeAxis: 'horizontal',
  }), null);
  assert.equal(layoutAnimationCancelReason({
    layoutChanged: true,
    dragging: true,
    layoutChangeAxis: 'horizontal',
  }), 'retarget');
  assert.equal(layoutAnimationCancelReason({}), 'drag-end');
});

test('vertical FLIP delta excludes viewport scrolling', () => {
  assert.equal(verticalFlipDelta({ beforeTop: 100, afterTop: 72 }), 28);
  assert.equal(verticalFlipDelta({ beforeTop: 72, afterTop: 100 }), -28);
  assert.equal(verticalFlipDelta({
    beforeTop: 100,
    afterTop: 72,
    beforeScrollTop: 0,
    afterScrollTop: 28,
  }), 0);
});

test('vertical FLIP can retarget from an in-flight visual rect', () => {
  assert.equal(verticalFlipDelta({
    beforeTop: 91.5,
    afterTop: 72,
    beforeScrollTop: 20,
    afterScrollTop: 20,
  }), 19.5);
});

test('layout FLIP measures horizontal indentation independently from viewport scroll', () => {
  assert.deepEqual(layoutFlipDelta({
    beforeLeft: 32,
    afterLeft: 56,
    beforeTop: 120,
    afterTop: 92,
    beforeScrollTop: 10,
    afterScrollTop: 38,
  }), { x: -24, y: 0 });
});
