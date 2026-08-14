import assert from 'node:assert/strict';
import test from 'node:test';

import { clampMenuToViewport, MENU_VIEWPORT_PAD } from './menuViewportClamp.mjs';

const vp = { viewportWidth: 1200, viewportHeight: 800 };

test('a menu fully inside the window is untouched', () => {
  assert.deepEqual(
    clampMenuToViewport({ x: 100, y: 100, width: 200, height: 300, ...vp }),
    { x: 100, y: 100 },
  );
});

// THE BUG: the split button is the right-most control of a pane header, so its
// menu opened with its body outside the window.
test('a click at the right edge pulls the menu back inside', () => {
  const res = clampMenuToViewport({ x: 1190, y: 100, width: 190, height: 120, ...vp });
  assert.equal(res.x, 1200 - 190 - MENU_VIEWPORT_PAD);
  assert.equal(res.y, 100);
});

test('a click at the bottom edge pulls the menu up', () => {
  const res = clampMenuToViewport({ x: 100, y: 790, width: 190, height: 120, ...vp });
  assert.equal(res.y, 800 - 120 - MENU_VIEWPORT_PAD);
});

test('corner click clamps both axes', () => {
  const res = clampMenuToViewport({ x: 1195, y: 795, width: 240, height: 300, ...vp });
  assert.equal(res.x, 1200 - 240 - MENU_VIEWPORT_PAD);
  assert.equal(res.y, 800 - 300 - MENU_VIEWPORT_PAD);
});

test('a menu taller than the window keeps its TOP reachable', () => {
  const res = clampMenuToViewport({ x: 50, y: 700, width: 200, height: 1000, ...vp });
  assert.equal(res.y, MENU_VIEWPORT_PAD, 'top-left wins over bottom-right');
});

test('broken numbers degrade to the pad corner, never NaN', () => {
  const res = clampMenuToViewport({ x: NaN, y: undefined, width: 'x', height: null, ...vp });
  assert.deepEqual(res, { x: MENU_VIEWPORT_PAD, y: MENU_VIEWPORT_PAD });
});
