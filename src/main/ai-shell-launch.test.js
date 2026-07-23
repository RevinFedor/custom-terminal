'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAgentShellLaunchInput,
  decideAgentShellLaunchAdmission,
} = require('./ai-shell-launch');

test('agent shell launch cancels the raw shell draft before the command', () => {
  assert.equal(
    buildAgentShellLaunchInput('codex resume 123'),
    '\x03codex resume 123\r',
  );
  assert.equal(
    buildAgentShellLaunchInput('claude --resume 123\r'),
    '\x03claude --resume 123\r',
  );
});

test('agent shell launch rejects an empty command', () => {
  assert.throws(() => buildAgentShellLaunchInput(' \r\n'), /command is required/i);
});

test('only a proven idle shell admits the destructive Ctrl+C launch byte', () => {
  assert.deepEqual(
    decideAgentShellLaunchAdmission({ processLookupStatus: 'absent' }),
    { allowed: true, reason: 'proven_idle_shell' },
  );
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'unknown' }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'found' }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'absent', commandRunning: true }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'absent', lifecycleClaimed: true }).allowed, false);
  assert.equal(decideAgentShellLaunchAdmission({ processLookupStatus: 'absent', stopping: true }).allowed, false);
});
