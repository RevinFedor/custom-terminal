import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISMISSIBLE_OVERLAY_SELECTORS,
  isDismissalGesture,
  isDismissibleOverlayOpen,
  notePointerDownForDismissal,
  resetDismissalGesture,
} from './overlayDismissGesture.mjs';

/** Minimal document stand-in: answers querySelector for a set of markers. */
const docWith = (...openMarkers) => ({
  querySelector: (selector) => (selector.split(',').some(part => openMarkers.includes(part.trim())) ? {} : null),
});

test('a press while a menu is open is a dismissal', () => {
  resetDismissalGesture();
  assert.equal(notePointerDownForDismissal(docWith('[data-tab-context-menu]')), true);
  assert.equal(isDismissalGesture(), true);
});

test('a press with nothing open is a normal click', () => {
  resetDismissalGesture();
  assert.equal(notePointerDownForDismissal(docWith()), false);
  assert.equal(isDismissalGesture(), false);
});

test('a normal pointer press scans the retained workspace only once', () => {
  const queries = [];
  assert.equal(notePointerDownForDismissal({ querySelector(selector) { queries.push(selector); return null; } }), false);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].split(','), [...DISMISSIBLE_OVERLAY_SELECTORS]);
});

test('the guard lasts ONE gesture, not until the next overlay', () => {
  // The reported sequence: right-click (menu opens) → click (dismiss only) →
  // click (must work normally). If the flag stuck, the pane could never be
  // focused by clicking again.
  resetDismissalGesture();
  notePointerDownForDismissal(docWith('[data-tab-context-menu]'));
  assert.equal(isDismissalGesture(), true, 'dismiss click is swallowed');
  notePointerDownForDismissal(docWith());
  assert.equal(isDismissalGesture(), false, 'the click after it must act normally');
});

test('every listed overlay owns the next click', () => {
  for (const selector of DISMISSIBLE_OVERLAY_SELECTORS) {
    resetDismissalGesture();
    assert.equal(
      notePointerDownForDismissal(docWith(selector)),
      true,
      `${selector} must swallow the dismissing click`,
    );
  }
});

test('the list covers menus only — a tooltip must not swallow clicks', () => {
  // Adding a hover-only surface here would make real clicks silently vanish.
  assert.equal(isDismissibleOverlayOpen(docWith('[data-control-hint]')), false);
  assert.equal(isDismissibleOverlayOpen(docWith('[data-tab-preview-popover]')), false);
});

test('a missing or odd document is not an open overlay', () => {
  // Fail OPEN here: treating "unknown" as "overlay present" would swallow a real
  // click, which is the worse failure.
  assert.equal(isDismissibleOverlayOpen(null), false);
  assert.equal(isDismissibleOverlayOpen({}), false);
  resetDismissalGesture();
  assert.equal(notePointerDownForDismissal(null), false);
});
