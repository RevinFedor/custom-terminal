'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isOwnInputSendSource,
  isExternalAgentSendSource,
  isProvenNoTerminalInput,
  externalSendFailureBelongsInHistory,
} = require('./external-send-presentation.cjs');

// Fedor31Oct rule: the discriminator is WHERE the send failed, not who sent it.
// Refused before any byte reached the PTY -> no card, error to the caller.
// Reached the terminal (or unknown) -> ordinary card, same as the user's input.

test('own desktop input sources are never treated as external', () => {
  for (const source of ['history-panel', 'codex-history-panel', 'prompt-queue', 'prompt-loop']) {
    assert.equal(isOwnInputSendSource(source), true, source);
    assert.equal(isExternalAgentSendSource(source), false, source);
  }
});

test('programmatic sources are recognized, including the codex writer prefix', () => {
  for (const source of ['terminal-mcp', 'project-api', 'mobile-native', 'inbox',
    'codex-terminal-mcp', 'tab-message:abc', 'orchestration:tab-1',
    'orchestration-completion:run-1', 'codex-orchestration-continue:run-2',
    'build-install-continue:op-1', 'research-operational:notice-1']) {
    assert.equal(isExternalAgentSendSource(source), true, source);
  }
});

test('a bare prefix with no id is not a programmatic source', () => {
  for (const source of ['tab-message:', 'orchestration-completion:', '', null, undefined]) {
    assert.equal(isExternalAgentSendSource(source), false, String(source));
  }
});

test('codex- prefix does not turn an own queue source into an external one', () => {
  assert.equal(isExternalAgentSendSource('codex-prompt-queue'), false);
  assert.equal(isOwnInputSendSource('codex-prompt-queue'), true);
});

test('submitted:false is the only proof that nothing reached the terminal', () => {
  assert.equal(isProvenNoTerminalInput({ submitted: false }), true);
  assert.equal(isProvenNoTerminalInput({ submitted: false, pasteWritten: false, enterWritten: false }), true);
  // Uncertainty is never downgraded to "did not reach".
  assert.equal(isProvenNoTerminalInput({ submitted: false, deliveryUnknown: true }), false);
  assert.equal(isProvenNoTerminalInput({ submitted: null }), false);
  assert.equal(isProvenNoTerminalInput({ submitted: undefined }), false);
  assert.equal(isProvenNoTerminalInput({ submitted: true }), false);
  assert.equal(isProvenNoTerminalInput(null), false);
  // A written byte or an accepted provider queue contradicts the claim.
  assert.equal(isProvenNoTerminalInput({ submitted: false, pasteWritten: true }), false);
  assert.equal(isProvenNoTerminalInput({ submitted: false, enterWritten: true }), false);
  assert.equal(isProvenNoTerminalInput({ submitted: false, providerQueueAccepted: true }), false);
  assert.equal(isProvenNoTerminalInput({ submitted: false, exactAuditConfirmed: true }), false);
});

test('the real 4412 case: refused before input, no card in the user History', () => {
  // send-proven-not-submitted, stopped tab + model change in the same call.
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'terminal-mcp',
    receipt: { success: false, submitted: false, pasteWritten: false, enterWritten: false,
      code: 'codex_settings_change_send_inflight' },
  }), false);
});

test('failure in terminal state after input crossed keeps its card', () => {
  // Reached the terminal, slash/model or writer failed there: identical to the
  // user typing the same prompt into the input by hand.
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'terminal-mcp',
    receipt: { success: false, submitted: true, enterWritten: true, code: 'send-submitted-audit-failed' },
  }), true);
});

test('unknown delivery keeps its card for a programmatic send', () => {
  // The real 8e88fd27 case: renderer receipt unavailable after 60s.
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'terminal-mcp',
    receipt: { success: null, submitted: null, deliveryUnknown: true,
      code: 'bridge_timeout_delivery_unknown' },
  }), true);
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'terminal-mcp',
    receipt: { submitted: false, deliveryUnknown: true },
  }), true);
});

test('the user own send always keeps its card, even proven not submitted', () => {
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'history-panel',
    receipt: { success: false, submitted: false, pasteWritten: false, enterWritten: false },
  }), true);
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'prompt-queue',
    receipt: { submitted: false },
  }), true);
});

test('an unknown source is conservatively treated as own input', () => {
  // Never hide a card because a source string was not recognized.
  assert.equal(externalSendFailureBelongsInHistory({
    source: 'some-future-surface',
    receipt: { submitted: false },
  }), true);
  assert.equal(externalSendFailureBelongsInHistory({ receipt: { submitted: false } }), true);
});

test('a missing receipt never suppresses the card', () => {
  assert.equal(externalSendFailureBelongsInHistory({ source: 'terminal-mcp' }), true);
  assert.equal(externalSendFailureBelongsInHistory({ source: 'terminal-mcp', receipt: null }), true);
  assert.equal(externalSendFailureBelongsInHistory({}), true);
});
