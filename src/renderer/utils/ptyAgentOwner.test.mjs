import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePtyAgentOwner,
  shouldInterpretPtyScreenAsShellCommand,
} from './ptyAgentOwner.mjs';

test('a single session binding overrides a stale command type', () => {
  assert.equal(resolvePtyAgentOwner({
    commandType: 'claude',
    codexSessionId: 'codex-session',
  }), 'codex');

  assert.equal(resolvePtyAgentOwner({
    commandType: 'codex',
    claudeSessionId: 'claude-session',
  }), 'claude');
});

test('an explicit PTY agent command type owns a fresh tab with no bindings', () => {
  for (const commandType of ['claude', 'codex']) {
    assert.equal(resolvePtyAgentOwner({ commandType }), commandType);
  }
});

test('two session bindings stay unknown even when the mutable command type chooses one', () => {
  for (const commandType of [null, undefined, 'generic', 'gemini', 'devServer', 'claude', 'codex']) {
    assert.equal(resolvePtyAgentOwner({
      commandType,
      claudeSessionId: 'claude-session',
      codexSessionId: 'codex-session',
    }), null);
  }
});

test('a fresh tab without an explicit PTY command type stays unknown', () => {
  for (const commandType of [null, undefined, 'generic', 'gemini', 'devServer']) {
    assert.equal(resolvePtyAgentOwner({ commandType }), null);
  }
});

test('empty session identifiers do not count as bindings', () => {
  assert.equal(resolvePtyAgentOwner({
    commandType: 'claude',
    claudeSessionId: '',
    codexSessionId: 'codex-session',
  }), 'codex');
});

test('screen parsing is allowed only for an idle non-alternate terminal', () => {
  assert.equal(shouldInterpretPtyScreenAsShellCommand({
    foregroundProcessAlive: false,
    bufferType: 'normal',
  }), true);

  assert.equal(shouldInterpretPtyScreenAsShellCommand({
    foregroundProcessAlive: false,
    bufferType: 'alternate',
  }), false);

  for (const foregroundProcessAlive of [true, undefined, null]) {
    assert.equal(shouldInterpretPtyScreenAsShellCommand({
      foregroundProcessAlive,
      bufferType: 'normal',
    }), false);
  }
});
