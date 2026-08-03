'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CODEX_ACTION_PROFILE_NATIVE_REWIND,
  CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT,
  bindCodexActionAuthorityGeneration,
  bindCodexActionAuthorityTarget,
  createCodexActionAuthority,
  transitionCodexActionAuthority,
  validateCodexActionAuthority,
} = require('./codex-action-authority');

const terminalToken = {};
const identity = (patch = {}) => ({
  terminalToken,
  projectId: 'project-a',
  tabId: 'tab-a',
  lifecycleGeneration: 'terminal-epoch:9',
  runSeq: 9,
  launchId: 'resume-launch-a',
  sourceSessionId: 'source-a',
  persistedSessionId: 'source-a',
  inputRevision: 12,
  operationId: 'operation-a',
  requestId: 'request-a',
  ...patch,
});

function armedAuthority(profile = CODEX_ACTION_PROFILE_NATIVE_REWIND) {
  const created = createCodexActionAuthority({
    authorityId: 'authority-a',
    profile,
    identity: identity(),
  });
  assert.equal(created.success, true);
  assert.equal(transitionCodexActionAuthority(created.authority, 'waiting').success, true);
  assert.equal(transitionCodexActionAuthority(created.authority, 'armed').success, true);
  return created.authority;
}

test('one exact action authority spans waiting, arm, target binding and one consume', () => {
  const authority = armedAuthority();
  assert.equal(bindCodexActionAuthorityGeneration(authority, 'rewind-action-a').success, true);
  const target = { targetUuid: 'turn-a', targetSourceLine: 44, targetTextHash: 'hash-a' };
  assert.equal(bindCodexActionAuthorityTarget(authority, target).success, true);
  assert.equal(validateCodexActionAuthority(authority, identity(), {
    profile: CODEX_ACTION_PROFILE_NATIVE_REWIND,
    actionGeneration: 'rewind-action-a',
    target,
  }).valid, true);
  assert.equal(transitionCodexActionAuthority(authority, 'consumed').success, true);
  assert.equal(transitionCodexActionAuthority(authority, 'consumed').error,
    'action-authority-transition-out-of-order');
  assert.equal(transitionCodexActionAuthority(authority, 'committed').success, true);
  assert.equal(validateCodexActionAuthority(authority, identity()).reason,
    'action-authority-not-usable');
});

test('terminal, project, lifecycle, run, launch, writer and input changes fail closed', () => {
  const mutations = [
    [{ terminalToken: {} }, 'terminal-changed'],
    [{ projectId: 'project-b' }, 'project-owner-changed'],
    [{ tabId: 'tab-b' }, 'tab-owner-changed'],
    [{ lifecycleGeneration: 'other:9' }, 'lifecycle-generation-changed'],
    [{ runSeq: 10 }, 'run-generation-changed'],
    [{ launchId: 'resume-launch-b' }, 'launch-generation-changed'],
    [{ sourceSessionId: 'source-b' }, 'source-session-changed'],
    [{ persistedSessionId: 'source-b' }, 'persisted-session-changed'],
    [{ inputRevision: 13 }, 'input-revision-changed'],
  ];
  for (const [patch, reason] of mutations) {
    const authority = armedAuthority(CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT);
    assert.equal(validateCodexActionAuthority(authority, identity(patch)).reason, reason);
  }
});

test('an action lease is never created across a stale persisted writer binding', () => {
  const created = createCodexActionAuthority({
    authorityId: 'authority-stale-binding',
    profile: CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT,
    identity: identity({ persistedSessionId: 'other-writer' }),
  });
  assert.deepEqual(created, { success: false, error: 'persisted-source-mismatch' });
});

test('revocation is terminal and an explicit tier-independent profile cannot be reused', () => {
  const authority = armedAuthority(CODEX_ACTION_PROFILE_RESUMED_ACTIVE_SUBMIT);
  assert.equal(transitionCodexActionAuthority(authority, 'revoked', {
    reason: 'manual-input',
  }).success, true);
  assert.equal(authority.reason, 'manual-input');
  assert.equal(transitionCodexActionAuthority(authority, 'armed').error,
    'action-authority-terminal');
  assert.equal(validateCodexActionAuthority(authority, identity(), {
    profile: CODEX_ACTION_PROFILE_NATIVE_REWIND,
  }).valid, false);
});

test('proof failure or Stop while waiting cannot be revived by a stale callback', () => {
  const created = createCodexActionAuthority({
    authorityId: 'authority-waiting',
    profile: CODEX_ACTION_PROFILE_NATIVE_REWIND,
    identity: identity(),
  });
  assert.equal(created.success, true);
  assert.equal(transitionCodexActionAuthority(created.authority, 'waiting').success, true);
  assert.equal(validateCodexActionAuthority(created.authority, identity({
    lifecycleGeneration: 'terminal-epoch:10',
    runSeq: 10,
  }), { phases: ['waiting'] }).valid, false);
  assert.equal(transitionCodexActionAuthority(created.authority, 'revoked', {
    reason: 'stop-start:test',
  }).success, true);
  assert.equal(transitionCodexActionAuthority(created.authority, 'armed', {
    reason: 'late-proof-callback',
  }).error, 'action-authority-terminal');
  assert.equal(transitionCodexActionAuthority(created.authority, 'consumed', {
    reason: 'late-write-callback',
  }).error, 'action-authority-terminal');
});
