import assert from 'node:assert/strict';
import test from 'node:test';

import { canTerminalClaimFocus } from './terminalFocusClaim.mjs';

const base = {
  active: true,
  presented: true,
  terminalIsCentre: false,
  sideTerminalOpen: false,
  hasSurfacePair: true,
};

test('the reported bug: transcript centred, side terminal CLOSED → no claim', () => {
  // This is the layout in which paste landed in an invisible terminal after
  // Cmd+Tab and mangled the TUI.
  assert.equal(canTerminalClaimFocus(base), false);
});

test('same layout with the side terminal OPEN → claim allowed', () => {
  assert.equal(canTerminalClaimFocus({ ...base, sideTerminalOpen: true }), true);
});

test('terminal holds the centre → claim allowed regardless of the panel flag', () => {
  assert.equal(canTerminalClaimFocus({ ...base, terminalIsCentre: true }), true);
  assert.equal(
    canTerminalClaimFocus({ ...base, terminalIsCentre: true, sideTerminalOpen: false }),
    true,
  );
});

test('a tab with a single surface always claims: it has no side panel to be', () => {
  // Plain terminal tab (no agent pair). terminalIsCentre is meaningless there,
  // and reading it as false would leave such a tab permanently unfocusable.
  assert.equal(
    canTerminalClaimFocus({ ...base, hasSurfacePair: false, terminalIsCentre: false }),
    true,
  );
});

test('inactive or unpresented never claims', () => {
  assert.equal(canTerminalClaimFocus({ ...base, active: false, terminalIsCentre: true }), false);
  assert.equal(canTerminalClaimFocus({ ...base, presented: false, terminalIsCentre: true }), false);
  // Being on screen is not enough on its own — a background tab's terminal must
  // never grab the keyboard.
  assert.equal(canTerminalClaimFocus({ ...base, active: false, sideTerminalOpen: true }), false);
});
