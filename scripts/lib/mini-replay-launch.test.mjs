import test from 'node:test';
import assert from 'node:assert/strict';
import { miniReplayLaunchGate } from './mini-replay-launch.mjs';
test('blocked or absent clone never falls back to an empty chat or a source writer', () => {
  for (const value of [null, { status: 'blocked' }, { status: 'ready', targetSessionId: 'unverified' }]) {
    const result = miniReplayLaunchGate(value);
    assert.equal(result.allowBasic, false); assert.equal(result.targetSessionId, null);
  }
  assert.equal(miniReplayLaunchGate({ status: 'blocked' }, { basic: true }).allowBasic, true);
});
test('selected earlier compact is not mistaken for the latest or a no-start permission refusal', () => {
  const reason = 'Нужный compact29Oct найден; public Fork has no selected-compact parameter';
  const result = miniReplayLaunchGate({ case: 'Main/Rewind', status: 'blocked',
    requestedFork: { mode: 'selected-prior-compact', fullHistory: false }, reason: { error: reason } });
  assert.equal(result.allowBasic, false);
  assert.equal(result.reason, reason);
  assert.doesNotMatch(result.reason, /no-start/);
});
test('verified independent offline profile is admitted without a basic fallback', () => {
  const result = miniReplayLaunchGate({ status: 'prepared', clonePrepared: true, sourceSessionId: 'source',
    targetSessionId: 'copy', targetTabId: 'own', offlineCopy: { verified: true },
    privateProfile: { root: '/private/tmp/noted-mini-dev-test', sessionId: 'copy', tabId: 'own',
      sessionFile: '/private/tmp/noted-mini-dev-test/codex/sessions/own.jsonl' } });
  assert.equal(result.allowLaunch, true); assert.equal(result.allowBasic, false);
  assert.equal(result.mode, 'replay'); assert.equal(result.targetSessionId, 'copy');
});
