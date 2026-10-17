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

test('History owns Cmd/Ctrl+F from its shared composer, including portals', () => {
  assert.equal(isComposerKeyboardTarget(target(true)), true);
  assert.equal(
    shouldOpenHistorySearchFromKeydown(event({ target: target(true) }), surface()),
    true,
  );
  assert.equal(
    shouldOpenHistorySearchFromKeydown(event({ metaKey: false, ctrlKey: true, target: target(true) }), surface()),
    true,
  );
});

test('History owns find across its surface while raw-terminal presentation keeps its route', () => {
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

test('physical Cmd+F works in a non-Latin layout without claiming another physical key', () => {
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ code:'KeyF', key:'а', target:target(true) }), surface()), true);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ code:'KeyG', key:'f' }), surface()), false);
});

test('History ignores unrelated, modified and already handled key events', () => {
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ key: 'g' }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ shiftKey: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ altKey: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ defaultPrevented: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event({ isComposing: true }), surface()), false);
  assert.equal(shouldOpenHistorySearchFromKeydown(event(), surface({ isOpen: false })), false);
});
