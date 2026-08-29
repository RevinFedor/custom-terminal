import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paneBodyFocusGestureMoved,
  paneBodyPrimaryFocusBlockReason,
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

test('gesture outcome — not transcript membership — decides primary input focus', () => {
  const collapsed = { isCollapsed: true, toString: () => '' };
  const selected = { isCollapsed: false, toString: () => 'selected' };

  assert.equal(
    paneBodyPrimaryFocusBlockReason(false, collapsed),
    null,
    'a plain click must focus even when its target was transcript text',
  );
  assert.equal(paneBodyPrimaryFocusBlockReason(true, collapsed), 'pointer-drag');
  assert.equal(paneBodyPrimaryFocusBlockReason(false, selected), 'text-selection');
});
