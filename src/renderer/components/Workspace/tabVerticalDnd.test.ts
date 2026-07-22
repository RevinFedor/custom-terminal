import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canReuseVerticalResolution,
  horizontalIntentFrameDeltaY,
  horizontalPointerIntentOwnsFrame,
  isMainVerticalDropTarget,
  resolveAtomicVerticalTarget,
  sameVerticalSemanticBoundary,
  unionVerticalRects,
  type AtomicVerticalTarget,
  type VerticalResolutionCache,
} from './tabVerticalDnd.ts';

test('group headers and main rows are both valid main-list drop targets', () => {
  assert.equal(isMainVerticalDropTarget({ type: 'TAB', zone: 'main' }), true);
  assert.equal(isMainVerticalDropTarget({ type: 'GROUP' }), true);
  assert.equal(isMainVerticalDropTarget({ type: 'TAB_GROUP' }), true);
  assert.equal(isMainVerticalDropTarget({ type: 'TAB', zone: 'utility' }), false);
  assert.equal(isMainVerticalDropTarget(null), false);
});

test('horizontal intent yields to meaningful vertical movement after a hierarchy step', () => {
  assert.equal(horizontalPointerIntentOwnsFrame(4, 0, 6), false);
  assert.equal(horizontalPointerIntentOwnsFrame(8, 0, 6), true);
  assert.equal(horizontalPointerIntentOwnsFrame(-10, -3, 6), true);
  assert.equal(horizontalPointerIntentOwnsFrame(-10, -12, 6), false);
});

test('the first horizontal frame compares against the previous pointer Y, then against the accepted hierarchy Y', () => {
  assert.equal(horizontalIntentFrameDeltaY(180, null, 140), 40);
  assert.equal(horizontalIntentFrameDeltaY(180, null, 180), 0);
  assert.equal(horizontalIntentFrameDeltaY(196, 180, 190), 16);
});

const block = <T>(key: string, value: T, ...rects: Array<{ top: number; bottom: number }>): AtomicVerticalTarget<T> => {
  const rect = unionVerticalRects(rects);
  assert.ok(rect);
  return { key, rect, value };
};

test('expanded equal-size groups expose one union midpoint with a stable hysteresis band', () => {
  const pickupBlocks = [
    block('group:a', 'a', { top: 0, bottom: 30 }, { top: 30, bottom: 90 }),
    block('group:b', 'b', { top: 100, bottom: 130 }, { top: 130, bottom: 190 }),
  ];
  const monotonic = [10, 30, 44, 45, 46, 50, 51, 52, 70, 89].reduce<ReturnType<typeof resolveAtomicVerticalTarget<string>>[]>(
    (results, y) => [
      ...results,
      resolveAtomicVerticalTarget(pickupBlocks, y, results.at(-1)?.boundary),
    ],
    [],
  );
  const before = monotonic[2];
  const after = monotonic[7];

  assert.deepEqual(before?.boundary, { blockKey: 'group:a', side: 'before' });
  assert.deepEqual(after?.boundary, { blockKey: 'group:a', side: 'after' });
  assert.deepEqual(monotonic.map(result => result?.boundary.side), [
    'before', 'before', 'before', 'before', 'before', 'before', 'before', 'after', 'after', 'after',
  ]);

  const cache: VerticalResolutionCache<typeof after> = {
    geometryId: 7,
    sourceKey: 'tab:source',
    projectionRevision: 3,
    scrollAdjustedY: 52,
    value: after,
  };
  assert.equal(canReuseVerticalResolution(cache, 7, 'tab:source', 3, 52), true);
  assert.equal(canReuseVerticalResolution(cache, 7, 'tab:source', 4, 52), false);
  assert.equal(canReuseVerticalResolution(cache, 7, 'tab:source', 3, 53), false);

  const flipMutatedBlocks = [
    block('group:b', 'b', { top: 0, bottom: 30 }, { top: 30, bottom: 90 }),
    block('group:a', 'a', { top: 100, bottom: 130 }, { top: 130, bottom: 190 }),
  ];
  const xOnlyResult = canReuseVerticalResolution(cache, 7, 'tab:source', 3, 52)
    ? cache.value
    : resolveAtomicVerticalTarget(flipMutatedBlocks, 46);
  assert.deepEqual(xOnlyResult?.boundary, { blockKey: 'group:a', side: 'after' });
});

test('nested visual subtree resolves from its full union rect instead of child midpoints', () => {
  const target = block(
    'tab-block:root',
    ['root', 'child', 'grandchild'],
    { top: 20, bottom: 50 },
    { top: 50, bottom: 80 },
    { top: 80, bottom: 110 },
  );

  assert.deepEqual(resolveAtomicVerticalTarget([target], 64)?.boundary, {
    blockKey: 'tab-block:root',
    side: 'before',
  });
  assert.deepEqual(resolveAtomicVerticalTarget([target], 66)?.boundary, {
    blockKey: 'tab-block:root',
    side: 'after',
  });
});

test('reverse crossing must leave the hysteresis band before changing side', () => {
  const target = block('tab-block:target', 'target', { top: 20, bottom: 80 });
  const after = resolveAtomicVerticalTarget([target], 57);
  const reverseNearMidpoint = resolveAtomicVerticalTarget([target], 45, after?.boundary);
  const before = resolveAtomicVerticalTarget([target], 43, reverseNearMidpoint?.boundary);
  const forwardNearMidpoint = resolveAtomicVerticalTarget([target], 55, before?.boundary);
  const afterAgain = resolveAtomicVerticalTarget([target], 57, forwardNearMidpoint?.boundary);

  assert.equal(after?.boundary.side, 'after');
  assert.equal(reverseNearMidpoint?.boundary.side, 'after');
  assert.equal(before?.boundary.side, 'before');
  assert.equal(forwardNearMidpoint?.boundary.side, 'before');
  assert.equal(afterAgain?.boundary.side, 'after');
});

test('the previous block remains selected until the next block wins beyond hysteresis', () => {
  const targets = [
    block('tab-block:a', 'a', { top: 20, bottom: 90 }),
    block('tab-block:b', 'b', { top: 100, bottom: 170 }),
  ];
  const fromA = resolveAtomicVerticalTarget(targets, 85);
  const gapNearB = resolveAtomicVerticalTarget(targets, 96, fromA?.boundary);
  const crossedIntoB = resolveAtomicVerticalTarget(targets, 101, gapNearB?.boundary);
  const reverseNearA = resolveAtomicVerticalTarget(targets, 94, crossedIntoB?.boundary);
  const crossedBackToA = resolveAtomicVerticalTarget(targets, 89, reverseNearA?.boundary);

  assert.deepEqual(fromA?.boundary, { blockKey: 'tab-block:a', side: 'after' });
  assert.deepEqual(gapNearB?.boundary, { blockKey: 'tab-block:a', side: 'after' });
  assert.deepEqual(crossedIntoB?.boundary, { blockKey: 'tab-block:b', side: 'before' });
  assert.deepEqual(reverseNearA?.boundary, { blockKey: 'tab-block:b', side: 'before' });
  assert.deepEqual(crossedBackToA?.boundary, { blockKey: 'tab-block:a', side: 'after' });
});

test('drop parity requires the same semantic block and side as the painted preview', () => {
  const target = block('group:target', 'target', { top: 0, bottom: 30 }, { top: 30, bottom: 90 });
  const preview = resolveAtomicVerticalTarget([target], 46)?.boundary;
  const sameRelease = resolveAtomicVerticalTarget([target], 70, preview)?.boundary;
  const reverseRelease = resolveAtomicVerticalTarget([target], 38, preview)?.boundary;
  const otherRelease = { blockKey: 'group:other', side: 'after' as const };

  assert.equal(sameVerticalSemanticBoundary(preview, sameRelease), true);
  assert.equal(sameVerticalSemanticBoundary(preview, reverseRelease), false);
  assert.equal(sameVerticalSemanticBoundary(preview, otherRelease), false);
});
