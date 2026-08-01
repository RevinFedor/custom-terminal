'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  compareAiLifecycleIdentity,
  decideAutomaticRestoreAdmission,
  normalizeAgentLaunchSource,
} = require('./ai-lifecycle-authority');

const identity = (patch = {}) => ({
  terminalLifecycleGeneration: 'terminal-epoch:7',
  terminalRunSeq: 7,
  inputRevision: 11,
  processStatus: 'absent',
  processPid: null,
  processName: null,
  sessionId: null,
  ...patch,
});

test('only automatic restore is suppressed by an authoritative due auto-stop', () => {
  assert.deepEqual(decideAutomaticRestoreAdmission({
    launchSource: 'auto-resume',
    pendingAutoStop: { authoritative: true, runId: 'run-1' },
  }), {
    allowed: false,
    source: 'auto-resume',
    suppressed: true,
    reason: 'orchestration-auto-stop-pending',
    runId: 'run-1',
  });
  assert.equal(decideAutomaticRestoreAdmission({
    launchSource: 'explicit',
    pendingAutoStop: { authoritative: true, runId: 'run-1' },
  }).allowed, true);
  assert.equal(normalizeAgentLaunchSource('unknown-client'), 'explicit');
});

test('an absent-process proof is exact to terminal generation, run, and input', () => {
  assert.equal(compareAiLifecycleIdentity(identity(), identity()).matches, true);
  assert.equal(compareAiLifecycleIdentity(identity(), identity({ inputRevision: 12 })).reason, 'terminal-input-changed');
  assert.equal(compareAiLifecycleIdentity(identity(), identity({ processStatus: 'found', processPid: 44 })).reason, 'process-presence-changed');
  assert.equal(compareAiLifecycleIdentity(identity(), identity({ terminalLifecycleGeneration: 'other:7' })).reason, 'terminal-generation-changed');
});

test('a live process proof cannot be reused for a replacement process or session', () => {
  const expected = identity({
    processStatus: 'found',
    processPid: 44,
    processName: 'codex',
    sessionId: 'session-a',
  });
  assert.equal(compareAiLifecycleIdentity(expected, expected).matches, true);
  assert.equal(compareAiLifecycleIdentity(expected, identity({
    processStatus: 'found',
    processPid: 45,
    processName: 'codex',
    sessionId: 'session-a',
  })).reason, 'process-pid-changed');
  assert.equal(compareAiLifecycleIdentity(expected, identity({
    processStatus: 'found',
    processPid: 44,
    processName: 'codex',
    sessionId: 'session-b',
  })).reason, 'process-session-changed');
});

test('unknown identity never authorizes a destructive stop', () => {
  assert.equal(compareAiLifecycleIdentity(
    identity({ processStatus: 'unknown' }),
    identity({ processStatus: 'absent' }),
  ).reason, 'process-identity-unknown');
});
