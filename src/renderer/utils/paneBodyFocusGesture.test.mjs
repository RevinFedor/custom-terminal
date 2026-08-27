import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paneBodyFocusGestureMoved,
  paneBodySelectionBlocksFocus,
} from './paneBodyFocusGesture.mjs';

test('text drag crosses the focus threshold while a click does not', () => {
  assert.equal(paneBodyFocusGestureMoved(10, 10, 12, 12), false);
  assert.equal(paneBodyFocusGestureMoved(10, 10, 14, 10), true);
});

test('a non-empty browser selection blocks composer auto-focus', () => {
  assert.equal(paneBodySelectionBlocksFocus(null), false);
  assert.equal(paneBodySelectionBlocksFocus({ isCollapsed: true, toString: () => 'text' }), false);
  assert.equal(paneBodySelectionBlocksFocus({ isCollapsed: false, toString: () => 'selected' }), true);
});
