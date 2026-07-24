'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyManualPtyInputAtBoundary,
  shouldSerializeManualPtyInput,
} = require('./pty-input-ownership');

test('manual input waits behind an existing PTY write without invalidating it at receipt time', () => {
  const paste = {
    kind: 'safe-paste',
    submitted: false,
  };
  assert.equal(shouldSerializeManualPtyInput({
    queuedOperation: paste,
    activeOperation: paste,
  }), true);

  assert.deepEqual(classifyManualPtyInputAtBoundary({
    data: 'x',
    precedingOperation: paste,
  }), {
    action: 'deliver',
    reason: 'manual-input-owns-next-boundary',
  });
});

test('Enter queued during a safe paste is suppressed only when that paste actually submitted', () => {
  const paste = {
    kind: 'safe-paste',
    submitted: false,
  };
  assert.equal(classifyManualPtyInputAtBoundary({
    data: '\r',
    precedingOperation: paste,
  }).action, 'deliver');

  // The same object is mutated at the exact term.write(Enter) boundary.
  paste.submitted = true;
  assert.deepEqual(classifyManualPtyInputAtBoundary({
    data: '\r',
    precedingOperation: paste,
  }), {
    action: 'suppress',
    reason: 'preceding-safe-paste-submitted',
  });
  assert.equal(classifyManualPtyInputAtBoundary({
    data: 'x',
    precedingOperation: paste,
  }).action, 'deliver');
});

test('terminal protocol replies and user-owned picker automation bypass the manual queue', () => {
  const queuedOperation = { kind: 'safe-paste' };
  assert.equal(shouldSerializeManualPtyInput({
    isTerminalProtocolResponse: true,
    queuedOperation,
  }), false);
  assert.equal(shouldSerializeManualPtyInput({
    activeOperation: { kind: 'codex-model-effort-picker', manualInputYields: true },
    queuedOperation,
  }), false);
  assert.equal(shouldSerializeManualPtyInput({
    alreadySerialized: true,
    queuedOperation,
  }), false);
  assert.equal(shouldSerializeManualPtyInput({
    isManualCodexSubmit: true,
    queuedOperation,
  }), false);
});
