import assert from 'node:assert/strict';
import test from 'node:test';

import {
  keyboardOwnerFromPress,
  pressCanMoveKeyboardOwner,
  WORKSPACE_SURFACE_SELECTORS,
  INTERFACE_SURFACE_SELECTORS,
  OWNERSHIP_NEUTRAL_SELECTORS,
} from './keyboardOwnerGesture.mjs';

// A DOM-free element: "I match these selectors (my own or an ancestor's)".
// The rule only calls closest(), so this is the entire contract.
const el = (...selectors) => ({
  closest: (s) => (selectors.includes(s) ? {} : null),
});

test('a press inside the centre column keeps the keyboard in the workspace', () => {
  assert.equal(keyboardOwnerFromPress(el('[data-workspace-center]')), 'workspace');
  assert.equal(keyboardOwnerFromPress(el('[data-terminal-pane-wrapper]')), 'workspace');
});

test('a press on the tab list / toolbar / titlebar / dashboard moves it to the interface', () => {
  assert.equal(keyboardOwnerFromPress(el('[data-tabbar-vertical]')), 'interface');
  assert.equal(keyboardOwnerFromPress(el('[data-project-toolbar]')), 'interface');
  assert.equal(keyboardOwnerFromPress(el('.title-bar')), 'interface');
  assert.equal(keyboardOwnerFromPress(el('[data-dashboard-root]')), 'interface');
});

test('a press on an overlay changes NOTHING — even one anchored inside a pane', () => {
  // A menu about a pane must not hand the keyboard to what is behind it, and
  // picking a row in a pane's list must not flip the scope mid-click.
  for (const s of OWNERSHIP_NEUTRAL_SELECTORS) {
    assert.equal(keyboardOwnerFromPress(el(s)), null, s);
  }
  // Neutral WINS over workspace: the pane's own menus live inside the wrapper.
  assert.equal(
    keyboardOwnerFromPress(el('[data-pane-recent-menu]', '[data-terminal-pane-wrapper]')),
    null,
  );
});

test('an unmarked press is left alone, not guessed as "interface"', () => {
  // A stray click on window padding must not silently change what Ctrl+Tab does.
  assert.equal(keyboardOwnerFromPress(el()), null);
  assert.equal(keyboardOwnerFromPress(null), null);
  assert.equal(keyboardOwnerFromPress({}), null);
});

test('only the LEFT button moves ownership', () => {
  assert.equal(pressCanMoveKeyboardOwner(0), true);
  assert.equal(pressCanMoveKeyboardOwner(1), false); // middle removes things
  assert.equal(pressCanMoveKeyboardOwner(2), false); // right opens menus
});

test('the three lists never overlap — one selector, one meaning', () => {
  const all = [
    ...WORKSPACE_SURFACE_SELECTORS,
    ...INTERFACE_SURFACE_SELECTORS,
    ...OWNERSHIP_NEUTRAL_SELECTORS,
  ];
  assert.equal(new Set(all).size, all.length);
});
