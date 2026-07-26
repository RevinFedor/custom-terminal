import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyClaudeStartupDefaultsGate,
  hideSessionStartingFromLifecycle,
  invalidateSessionStartingProbeSequence,
  isSessionStartingProbeCurrent,
  syncSessionStartingWithPresence,
} from './sessionStartingState.mjs';

const codexInfo = { tabId: 'tab-codex', engine: 'codex', sessionId: 'session-codex' };
const claudeInfo = { tabId: 'tab-claude', engine: 'claude', sessionId: 'session-claude' };

test('current Codex presence replaces a stale startup failure', () => {
  const failed = {
    ...codexInfo,
    since: 1,
    startupFailed: true,
    startupError: 'startup-timeout:no-ready-signal',
  };
  const starting = syncSessionStartingWithPresence(failed, codexInfo, {
    status: 'starting',
    startupFailed: false,
    startupError: null,
    lastNotReady: { reason: 'no-composer-frame' },
  }, 2);
  assert.equal(starting.startupFailed, false);
  assert.equal(starting.startupError, null);
  assert.equal(starting.lastNotReady.reason, 'no-composer-frame');
});

test('startup timeout event upgrades the existing card without restarting its elapsed time', () => {
  const held = { ...codexInfo, since: 1, holdUntilReady: true };
  const failed = syncSessionStartingWithPresence(held, codexInfo, {
    status: 'starting',
    startupFailed: true,
    startupError: 'startup-timeout:no-ready-signal',
    lastNotReady: { reason: 'startup-timeout:no-ready-signal' },
  }, 60_001);
  assert.equal(failed.since, 1);
  assert.equal(failed.startupFailed, true);
  assert.equal(failed.startupError, 'startup-timeout:no-ready-signal');
});

test('active or inactive Codex presence clears its old startup card', () => {
  const failed = { ...codexInfo, since: 1, startupFailed: true };
  assert.equal(syncSessionStartingWithPresence(failed, codexInfo, { status: 'active' }), null);
  assert.equal(syncSessionStartingWithPresence(failed, codexInfo, { status: 'inactive' }), null);
});

test('ready Codex composer clears startup card even before writer identity exists', () => {
  const starting = { ...codexInfo, since: 1, holdUntilReady: true };
  assert.equal(syncSessionStartingWithPresence(starting, codexInfo, {
    status: 'starting',
    inputReady: true,
    sessionId: null,
  }), null);
});

test('starting to unknown to starting never hides the Codex startup card', () => {
  const starting = syncSessionStartingWithPresence(null, codexInfo, {
    status: 'starting',
    lastNotReady: { reason: 'writer-pending' },
  }, 1);
  const unknown = syncSessionStartingWithPresence(starting, codexInfo, {
    status: 'unknown',
    lastNotReady: { reason: 'process-lookup-failed' },
  }, 2);
  const recovered = syncSessionStartingWithPresence(unknown, codexInfo, {
    status: 'starting',
    lastNotReady: { reason: 'writer-pending' },
  }, 3);
  assert.notEqual(unknown, null);
  assert.equal(unknown.since, starting.since);
  assert.equal(unknown.lastNotReady.reason, 'process-lookup-failed');
  assert.notEqual(recovered, null);
  assert.equal(recovered.since, starting.since);
});

test('command-start race remains visible until a real lifecycle state arrives', () => {
  const held = { ...codexInfo, since: 1, holdUntilReady: true };
  assert.equal(
    syncSessionStartingWithPresence(held, codexInfo, { status: 'inactive', manualActionRequired: false }),
    held,
  );
  assert.equal(syncSessionStartingWithPresence(held, codexInfo, { status: 'active' }), null);
});

test('manual Codex startup blocker remains visible after lifecycle becomes inactive', () => {
  const held = { ...codexInfo, since: 1, holdUntilReady: true };
  const blocked = syncSessionStartingWithPresence(held, codexInfo, {
    status: 'inactive',
    manualActionRequired: true,
    lastNotReady: { reason: 'blocked:auth-required', blockers: ['auth-required'] },
  }, 2);
  assert.notEqual(blocked, null);
  assert.equal(blocked.since, 1);
  assert.equal(blocked.holdUntilReady, false);
  assert.equal(blocked.lastNotReady.reason, 'blocked:auth-required');
});

test('Claude defaults gate owns stickiness until its own ready signal', () => {
  const generic = { ...claudeInfo, since: 1, holdUntilReady: true };
  const pending = applyClaudeStartupDefaultsGate(generic, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'pending',
    reason: 'tui-ready',
  }, 2);
  assert.equal(pending.stickySource, 'claude-startup-defaults');
  assert.equal(syncSessionStartingWithPresence(pending, claudeInfo, { status: 'active' }), pending);
  assert.equal(hideSessionStartingFromLifecycle(pending, claudeInfo.tabId, { force: true }), pending);
  assert.equal(applyClaudeStartupDefaultsGate(pending, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'ready',
  }), null);
});

test('a failed gate carries the command that failed and its proof outcome', () => {
  // The incident's card said "terminal input did not become ready" while the
  // input was in fact ready and a single startup command had been swallowed.
  const failed = applyClaudeStartupDefaultsGate(null, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'failed',
    reason: 'tui-ready',
    error: '/effort max was not confirmed (absent)',
    failedCommand: '/effort max',
    proofOutcome: 'absent',
    userRetryable: true,
  }, 1);
  assert.equal(failed.startupFailed, true);
  assert.equal(failed.startupFailedCommand, '/effort max');
  assert.equal(failed.startupProofOutcome, 'absent');
  assert.equal(failed.startupUserRetryable, true);
});

test('a pending gate carries no failure detail', () => {
  const pending = applyClaudeStartupDefaultsGate(null, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'pending',
    reason: 'tui-ready',
    failedCommand: '/model haiku',
  }, 1);
  assert.equal(pending.startupPending, true);
  assert.equal(pending.startupFailedCommand, null,
    'a command name must not leak into a pending card');
  assert.equal(pending.startupUserRetryable, false);
});

test('Claude defaults cleared signal removes a failed gate card', () => {
  const failed = applyClaudeStartupDefaultsGate(null, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'failed',
    error: 'settings failed',
  }, 1);
  assert.equal(failed.startupFailed, true);
  assert.equal(applyClaudeStartupDefaultsGate(failed, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'cleared',
  }), null);
});

test('an unrelated gate completion cannot clear a generic lifecycle card', () => {
  const generic = { ...claudeInfo, since: 1, holdUntilReady: true };
  assert.equal(applyClaudeStartupDefaultsGate(generic, claudeInfo, {
    tabId: claudeInfo.tabId,
    status: 'ready',
  }), generic);
});

test('an authoritative ready event invalidates an older active-tab presence probe', () => {
  const capturedSequence = 7;
  const currentSequence = invalidateSessionStartingProbeSequence(
    capturedSequence,
    codexInfo,
    codexInfo.tabId,
  );
  assert.equal(currentSequence, 8);
  assert.equal(
    isSessionStartingProbeCurrent(capturedSequence, currentSequence, codexInfo, codexInfo),
    false,
  );
});

test('a background-tab event does not invalidate the active-tab presence probe', () => {
  const capturedSequence = 7;
  const currentSequence = invalidateSessionStartingProbeSequence(
    capturedSequence,
    codexInfo,
    'tab-background',
  );
  assert.equal(currentSequence, capturedSequence);
  assert.equal(
    isSessionStartingProbeCurrent(capturedSequence, currentSequence, codexInfo, codexInfo),
    true,
  );
});
