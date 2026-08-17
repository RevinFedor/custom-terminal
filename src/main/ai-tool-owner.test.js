'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAiToolOwner } = require('./ai-tool-owner');

test('live runtime owner beats wrong caller, binding and stored label', () => {
  assert.equal(resolveAiToolOwner({
    runtimeOwners: ['codex'],
    claudeSessionId: 'stale-claude',
    fallback: 'claude',
    storedCommandType: 'claude',
  }), 'codex');
});

test('one persisted binding beats wrong caller and stored label when stopped', () => {
  assert.equal(resolveAiToolOwner({
    codexSessionId: 'codex-session',
    fallback: 'claude',
    storedCommandType: 'claude',
  }), 'codex');
  assert.equal(resolveAiToolOwner({
    claudeSessionId: 'claude-session',
    fallback: 'codex',
    storedCommandType: 'codex',
  }), 'claude');
});

test('conflicting live runtimes or session bindings remain unknown', () => {
  assert.equal(resolveAiToolOwner({ runtimeOwners: ['claude', 'codex'], fallback: 'claude' }), null);
  assert.equal(resolveAiToolOwner({
    claudeSessionId: 'claude-session',
    codexSessionId: 'codex-session',
    fallback: 'codex',
  }), null);
});

test('caller and stored label are used only with no stronger proof', () => {
  assert.equal(resolveAiToolOwner({ fallback: 'claude', storedCommandType: 'codex' }), 'claude');
  assert.equal(resolveAiToolOwner({ storedCommandType: 'codex' }), 'codex');
  assert.equal(resolveAiToolOwner({ storedCommandType: 'devServer' }), null);
});
