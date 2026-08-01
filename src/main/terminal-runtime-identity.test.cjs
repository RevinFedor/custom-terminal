'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  deleteTerminalRuntimeIfOwned,
  ownsTerminalRuntime,
  terminateCapturedTerminalRuntime,
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

test('a delayed close kills its captured PTY without deleting a replacement', () => {
  let oldKills = 0;
  const oldTerminal = { pid: 101, kill: () => { oldKills += 1; } };
  const replacementTerminal = { pid: 202, kill: () => assert.fail('replacement must not be killed') };
  const terminals = new Map([['tab-1', replacementTerminal]]);

  assert.deepEqual(
    terminateCapturedTerminalRuntime(terminals, 'tab-1', oldTerminal),
    { killed: true, released: false },
  );
  assert.equal(oldKills, 1);
  assert.equal(terminals.get('tab-1'), replacementTerminal);
});

test('a current captured PTY is killed and releases its own slot', () => {
  let kills = 0;
  const terminal = { pid: 303, kill: () => { kills += 1; } };
  const terminals = new Map([['tab-1', terminal]]);

  assert.deepEqual(
    terminateCapturedTerminalRuntime(terminals, 'tab-1', terminal),
    { killed: true, released: true },
  );
  assert.equal(kills, 1);
  assert.equal(terminals.has('tab-1'), false);
});
