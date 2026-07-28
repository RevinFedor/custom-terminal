'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_OWNERSHIP_RECORDS,
  getCodexProcessActionGeneration,
  recordCodexProcessActionOwnership,
  resetCodexProcessActionOwnershipForTests,
} = require('./codex-process-action-ownership');

test.beforeEach(() => resetCodexProcessActionOwnershipForTests());

test('binds only the exact session, call and byte offset to a process generation', () => {
  assert.equal(recordCodexProcessActionOwnership({
    sessionId: 'session-a',
    callId: 'call-a',
    sourceByteOffset: 120,
    lifecycleGeneration: 'pty-a:2',
  }), true);
  assert.equal(getCodexProcessActionGeneration({
    sessionId: 'session-a', callId: 'call-a', sourceByteOffset: 120,
  }), 'pty-a:2');
  assert.equal(getCodexProcessActionGeneration({
    sessionId: 'session-a', callId: 'call-a', sourceByteOffset: 121,
  }), null);
  assert.equal(getCodexProcessActionGeneration({
    sessionId: 'session-b', callId: 'call-a', sourceByteOffset: 120,
  }), null);
});

test('a later process generation replaces proof only for the same exact record', () => {
  const identity = { sessionId: 'session-a', callId: 'call-a', sourceByteOffset: 120 };
  recordCodexProcessActionOwnership({ ...identity, lifecycleGeneration: 'pty-a:2' });
  recordCodexProcessActionOwnership({ ...identity, lifecycleGeneration: 'pty-a:3' });
  assert.equal(getCodexProcessActionGeneration(identity), 'pty-a:3');
});

test('invalid or historical records cannot create ownership proof', () => {
  assert.equal(recordCodexProcessActionOwnership({
    sessionId: 'session-a', callId: '', sourceByteOffset: 120, lifecycleGeneration: 'pty-a:2',
  }), false);
  assert.equal(recordCodexProcessActionOwnership({
    sessionId: 'session-a', callId: 'call-a', sourceByteOffset: null, lifecycleGeneration: 'pty-a:2',
  }), false);
});

test('registry is bounded without evicting the newest exact proof', () => {
  for (let index = 0; index <= MAX_OWNERSHIP_RECORDS; index += 1) {
    recordCodexProcessActionOwnership({
      sessionId: 'session-a',
      callId: 'call-' + index,
      sourceByteOffset: index,
      lifecycleGeneration: 'pty-a:2',
    });
  }
  assert.equal(getCodexProcessActionGeneration({
    sessionId: 'session-a', callId: 'call-0', sourceByteOffset: 0,
  }), null);
  assert.equal(getCodexProcessActionGeneration({
    sessionId: 'session-a', callId: 'call-' + MAX_OWNERSHIP_RECORDS,
    sourceByteOffset: MAX_OWNERSHIP_RECORDS,
  }), 'pty-a:2');
});
