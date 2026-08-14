import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldWrapControlBar, CONTROL_BAR_CLUSTER_MIN_GAP_PX } from './controlBarWrap.mjs';

test('wraps once the two clusters would touch', () => {
  // The reported case: a split pane at roughly half the window width, both
  // clusters at their natural size.
  assert.equal(
    shouldWrapControlBar({ availableWidth: 620, leftWidth: 380, rightWidth: 300 }),
    true,
  );
});

test('stays on one line while there is room', () => {
  assert.equal(
    shouldWrapControlBar({ availableWidth: 1300, leftWidth: 380, rightWidth: 300 }),
    false,
  );
});

test('the required gap is what decides the borderline case', () => {
  // Exactly touching, zero gap → wrap: overlapping by 0px still reads as two
  // controls glued together.
  const exact = { availableWidth: 680, leftWidth: 380, rightWidth: 300 };
  assert.equal(shouldWrapControlBar(exact), true);
  // One px of slack beyond the gap → fits.
  assert.equal(
    shouldWrapControlBar({ ...exact, availableWidth: 680 + CONTROL_BAR_CLUSTER_MIN_GAP_PX + 1 }),
    false,
  );
});

test('an unmeasured bar never wraps', () => {
  // Zeros mean "not measured yet", not "fits in nothing" — wrapping there would
  // make every bar flash two lines on mount.
  assert.equal(shouldWrapControlBar({ availableWidth: 0, leftWidth: 0, rightWidth: 0 }), false);
  assert.equal(shouldWrapControlBar({ availableWidth: 620, leftWidth: 0, rightWidth: 300 }), false);
  assert.equal(shouldWrapControlBar({ availableWidth: 620, leftWidth: 380, rightWidth: 0 }), false);
  assert.equal(
    shouldWrapControlBar({ availableWidth: NaN, leftWidth: 380, rightWidth: 300 }),
    false,
  );
});

test('a hidden bar (width 0) does not wrap', () => {
  // A collapsed/hidden container reports 0 for everything; wrapping on that would
  // leave the bar stacked when it comes back.
  assert.equal(
    shouldWrapControlBar({ availableWidth: 0, leftWidth: 380, rightWidth: 300 }),
    false,
  );
});
