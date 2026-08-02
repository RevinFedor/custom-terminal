import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isComposerKeyboardTarget,
  shouldOpenHistorySearchFromKeydown,
} from './composerShortcutRouting.mjs';

const target = (insideComposer = false) => ({
  closest(selector) {
    return insideComposer && selector === '.gt-composer-editor' ? {} : null;
  },
});

const event = (overrides = {}) => ({
  key: 'f',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  target: target(false),
  ...overrides,
});

const surface = (overrides = {}) => ({
  isOpen: true,
  mainSurface: true,
  terminalOpen: false,
  terminalIsPrimary: false,
  ...overrides,
});

test('shared composer owns Cmd/Ctrl+F even when it is rendered through a portal', () => {
  assert.equal(isComposerKeyboardTarget(target(true)), true);
  assert.equal(
    shouldOpenHistorySearchFromKeydown(event({ target: target(true) }), surface()),
    false,
  );
  assert.equal(
    shouldOpenHistorySearchFromKeydown(event({ metaKey: false, ctrlKey: true, target: target(true) }), surface()),
    false,
  );
});

test('History owns find only from its non-composer surface', () => {
  assert.equal(shouldOpenHistorySearchFromKeydown(event(), surface()), true);
  assert.equal(
    shouldOpenHistorySearchFromKeydown(event(), surface({ terminalIsPrimary: true })),
    false,
  );
  assert.equal(
    shouldOpenHistorySearchFromKeydown(event(), surface({ terminalOpen: true })),
    false,
  );
});

test('History ignores unrelated, modified and already handled key events', () => {
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ key: 'g' }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ shiftKey: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ altKey: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ defaultPrevented: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ isComposing: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event(), surface({ isOpen: false })), false);
});
