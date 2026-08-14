'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCodexLivePromptOwner,
  rememberCodexLivePromptOwner,
  resolveCodexLivePromptOwner,
} = require('./codex-live-prompt-owner');

const audit = (suffix = '1') => ({
  matched: true,
  handoffId: 'history-handoff-' + suffix,
  source: 'history-panel',
  sessionId: 'session-a',
  sourceIdentity: 'codex-user-source-session-a-' + suffix,
});

test('only an exact audited handoff becomes a live prompt owner', () => {
  assert.equal(buildCodexLivePromptOwner(null), null);
  assert.equal(buildCodexLivePromptOwner({ matched: true }), null);
  assert.equal(buildCodexLivePromptOwner({
    matched: true,
    handoffId: 'history-handoff',
  }), null);
  assert.deepEqual(buildCodexLivePromptOwner(audit()), {
    handoffId: 'history-handoff-1',
    source: 'history-panel',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-1',
  });
});

test('audit-only source scan preserves ownership for the later public replay', () => {
  const state = {};
  const owner = rememberCodexLivePromptOwner(state, audit());
  assert.strictEqual(
    resolveCodexLivePromptOwner(state, 'codex-user-source-session-a-1'),
    owner,
  );
  assert.equal(
    resolveCodexLivePromptOwner(state, 'codex-user-source-session-a-2'),
    null,
  );
});

test('remembered owners are bounded and exact identities never fall back to text', () => {
  const state = {};
  rememberCodexLivePromptOwner(state, audit('1'), { limit: 2 });
  rememberCodexLivePromptOwner(state, audit('2'), { limit: 2 });
  rememberCodexLivePromptOwner(state, audit('3'), { limit: 2 });
  assert.equal(resolveCodexLivePromptOwner(state, audit('1').sourceIdentity), null);
  assert.equal(resolveCodexLivePromptOwner(state, audit('2').sourceIdentity)?.handoffId, 'history-handoff-2');
  assert.equal(resolveCodexLivePromptOwner(state, audit('3').sourceIdentity)?.handoffId, 'history-handoff-3');
});
