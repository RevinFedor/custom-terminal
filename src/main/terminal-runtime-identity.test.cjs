'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  deleteTerminalRuntimeIfOwned,
  ownsTerminalRuntime,
} = require('./terminal-runtime-identity.cjs');

test('late callbacks from an old PTY cannot own a replacement runtime', () => {
  const oldTerminal = { pid: 101 };
  const replacementTerminal = { pid: 202 };
  const terminals = new Map([['tab-1', replacementTerminal]]);

  assert.equal(ownsTerminalRuntime(terminals, 'tab-1', oldTerminal), false);
  assert.equal(deleteTerminalRuntimeIfOwned(terminals, 'tab-1', oldTerminal), false);
  assert.equal(terminals.get('tab-1'), replacementTerminal);
});

test('the current PTY can release only its own runtime slot', () => {
  const currentTerminal = { pid: 303 };
  const terminals = new Map([['tab-1', currentTerminal]]);

  assert.equal(ownsTerminalRuntime(terminals, 'tab-1', currentTerminal), true);
  assert.equal(deleteTerminalRuntimeIfOwned(terminals, 'tab-1', currentTerminal), true);
  assert.equal(terminals.has('tab-1'), false);
});
