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

test('active or inactive Codex presence clears its old startup card', () => {
  const failed = { ...codexInfo, since: 1, startupFailed: true };
  assert.equal(syncSessionStartingWithPresence(failed, codexInfo, { status: 'active' }), null);
  assert.equal(syncSessionStartingWithPresence(failed, codexInfo, { status: 'inactive' }), null);
});

test('command-start race remains visible until a real lifecycle state arrives', () => {
  const held = { ...codexInfo, since: 1, holdUntilReady: true };
  assert.equal(
    syncSessionStartingWithPresence(held, codexInfo, { status: 'inactive', manualActionRequired: false }),
    held,
  );
  assert.equal(syncSessionStartingWithPresence(held, codexInfo, { status: 'active' }), null);
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
