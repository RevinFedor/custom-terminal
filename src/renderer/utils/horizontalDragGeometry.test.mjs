import assert from 'node:assert/strict';
import test from 'node:test';

import { createHorizontalDragGeometryCache } from './horizontalDragGeometry.mjs';

test('animated preview cannot move a leased insertion boundary', () => {
  const cache = createHorizontalDragGeometryCache();
  let reads = 0;
  const base = [
    { id: 'a', left: 100, right: 160 },
    { id: 'b', left: 166, right: 246 },
    { id: 'held', left: 252, right: 332 },
  ];
  const animatedPreview = [
    { id: 'a', left: 100, right: 160 },
    { id: 'held', left: 166, right: 246 },
    { id: 'b', left: 252, right: 332 },
  ];

  const first = cache.resolve({
    ownerKey: 'pane:0',
    excludedIds: ['held'],
    clientX: 210,
    viewportLeft: 100,
    scrollLeft: 0,
    readChips: () => { reads += 1; return base; },
  });
  const whileAnimating = cache.resolve({
    ownerKey: 'pane:0',
    excludedIds: ['held'],
    clientX: 210,
    viewportLeft: 100,
    scrollLeft: 0,
    readChips: () => { reads += 1; return animatedPreview; },
  });

  assert.equal(first, 2);
  assert.equal(whileAnimating, 2);
  assert.equal(reads, 1, 'the animated DOM must not be measured again during the same drag');
});

test('the lease follows scroller movement without recapturing chip rectangles', () => {
  const cache = createHorizontalDragGeometryCache();
  let reads = 0;
  const readChips = () => {
    reads += 1;
    return [
      { id: 'a', left: 100, right: 160 },
      { id: 'b', left: 166, right: 246 },
    ];
  };

  assert.equal(cache.resolve({
    ownerKey: 'center', clientX: 210, viewportLeft: 100, scrollLeft: 0, readChips,
  }), 2);
  // The strip scrolled 40px left on screen. The same content point is now x=170.
  assert.equal(cache.resolve({
    ownerKey: 'center', clientX: 170, viewportLeft: 100, scrollLeft: 40, readChips,
  }), 2);
  assert.equal(reads, 1);

  cache.clear();
  cache.resolve({ ownerKey: 'center', clientX: 170, viewportLeft: 100, scrollLeft: 40, readChips });
  assert.equal(reads, 2, 'a new drag gesture must capture a new lease');
});
