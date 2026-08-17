'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyClaudeResumeShellInput } = require('./terminal-shell-command');

const sessionId = '2531a2eb-c6c4-49b2-911f-760d7b39801e';

test('character-by-character shell input matches only when Enter completes the exact resume command', () => {
  const result = classifyClaudeResumeShellInput({
    pendingLine: 'claude --dangerously-skip-permissions --resume ' + sessionId,
    data: '\r',
  });
  assert.equal(result.matched, true);
  assert.equal(result.sessionId, sessionId);
});

test('one whole exact launch burst is accepted', () => {
  assert.equal(classifyClaudeResumeShellInput({
    data: 'command claude --resume=' + sessionId + '\r',
  }).matched, true);
});

test('prose and echo containing a resume example are not shell launch ownership', () => {
  for (const data of [
    'echo "claude --resume ' + sessionId + '"\r',
    'объясни claude --resume ' + sessionId + '\r',
    'claude --resume ' + sessionId + ' && echo done\r',
  ]) {
    assert.equal(classifyClaudeResumeShellInput({ data }).matched, false);
  }
});

test('live or unknown foreground ownership blocks resume parsing', () => {
  assert.equal(classifyClaudeResumeShellInput({
    data: 'claude --resume ' + sessionId + '\r',
    commandRunning: true,
  }).matched, false);
  assert.equal(classifyClaudeResumeShellInput({
    data: 'claude --resume ' + sessionId + '\r',
    liveRuntimeOwners: 1,
  }).matched, false);
});
