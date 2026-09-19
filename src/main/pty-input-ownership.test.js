'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyLateMcpProofInput,
  classifyManualPtyInputAtBoundary,
  shouldSerializeManualPtyInput,
} = require('./pty-input-ownership');

test('manual input yields late MCP diagnostic proof while protocol replies preserve it', () => {
  assert.deepEqual(classifyLateMcpProofInput({
    proofPending: true,
    xtermInputOrigin: 'user',
  }), {
    action: 'deliver',
    reason: 'manual-input-owns-terminal',
    cancelProof: true,
  });
  assert.equal(classifyLateMcpProofInput({
    proofPending: true,
    xtermInputOrigin: null,
  }).cancelProof, true, 'unknown origin remains fail-safe manual ownership');
  assert.deepEqual(classifyLateMcpProofInput({
    proofPending: true,
    xtermInputOrigin: 'terminal-response',
  }), {
    action: 'deliver',
    reason: 'terminal-protocol-response',
    cancelProof: false,
  });
});

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

test('queued Enter is suppressed after a written paste but remains deliverable before any write attempt', () => {
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

test('queued Enter cannot retry an unknown prompt write; later explicit input and setting-only Enter stay independent', () => {
  for (const precedingOperation of [
    { kind: 'safe-paste', submitted: false, enterAttempted: true },
    { kind: 'claude-settings-send', promptSubmitted: false, promptSubmitAttempted: true },
  ]) {
    assert.equal(classifyManualPtyInputAtBoundary({ data: '\r', precedingOperation }).action, 'suppress');
    assert.equal(classifyManualPtyInputAtBoundary({ data: 'next text', precedingOperation }).action, 'deliver');
  }
  assert.equal(classifyManualPtyInputAtBoundary({ data: '\r', precedingOperation: null }).action, 'deliver');
  assert.equal(classifyManualPtyInputAtBoundary({ data: '\r', precedingOperation: {
    kind: 'claude-settings-send', submitted: true, enterAttempted: true,
    promptSubmitted: false, promptSubmitAttempted: false,
  } }).action, 'deliver', 'model/effort slash command is not the requested prompt');
});

test('native Rewind owns physical input only until its PTY transaction releases', () => {
  const rewind = {
    kind: 'claude-native-rewind',
    manualInputYields: false,
    cancelRequested: false,
  };
  assert.equal(shouldSerializeManualPtyInput({
    activeOperation: rewind,
    queuedOperation: rewind,
  }), true);

  rewind.cancelRequested = true;
  assert.equal(shouldSerializeManualPtyInput({
    activeOperation: rewind,
    queuedOperation: rewind,
  }), true, 'cancelling remains visibly locked until main releases the transaction');
  assert.equal(shouldSerializeManualPtyInput({
    activeOperation: null,
    queuedOperation: null,
  }), false, 'after settlement there is no stale PTY owner to block input');
});
