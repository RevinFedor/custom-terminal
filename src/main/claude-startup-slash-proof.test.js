'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  scanClaudeStartupSlashRecords,
} = require('./claude-startup-slash-proof');

function wrapper({
  uuid = 'wrapper-1',
  parentUuid = 'before',
  command = 'model',
  value = 'claude-opus-5[1m]',
  timestamp = '2026-07-30T18:17:10.163Z',
  sessionId = 'session-a',
  system = false,
} = {}) {
  const content = '<command-name>/' + command + '</command-name>\n'
    + '<command-message>' + command + '</command-message>\n'
    + '<command-args>' + value + '</command-args>';
  return {
    uuid,
    parentUuid,
    timestamp,
    sessionId,
    ...(system
      ? { type: 'system', subtype: 'local_command', content }
      : { type: 'user', message: { role: 'user', content } }),
  };
}

function output({
  uuid = 'stdout-1',
  parentUuid = 'wrapper-1',
  text = 'Set model to \u001b[1mOpus 5 (1M context)\u001b[22m and saved as your default for new sessions',
  timestamp = '2026-07-30T18:17:10.163Z',
  sessionId = 'session-a',
  system = false,
} = {}) {
  const content = '<local-command-stdout>' + text + '</local-command-stdout>';
  return {
    uuid,
    parentUuid,
    timestamp,
    sessionId,
    ...(system
      ? { type: 'system', subtype: 'local_command', content }
      : { type: 'user', message: { role: 'user', content } }),
  };
}

test('a delayed exact wrapper and its direct success child prove one model command', () => {
  const result = scanClaudeStartupSlashRecords([
    wrapper(),
    output(),
  ], '/model claude-opus-5[1m]', {
    afterMs: Date.parse('2026-07-30T18:16:45.000Z'),
    sessionId: 'session-a',
  });

  assert.equal(result.success, true);
  assert.equal(result.reason, 'jsonl-stdout');
  assert.equal(result.wrapperUuid, 'wrapper-1');
  assert.equal(result.stdoutUuid, 'stdout-1');
});

test('a paired explicit rejection is terminal but never success', () => {
  const result = scanClaudeStartupSlashRecords([
    wrapper({ value: 'fable-[1m]', system: true }),
    output({
      text: "Model 'fable-[1m]' not found",
      system: true,
    }),
  ], '/model fable-[1m]', {
    afterMs: Date.parse('2026-07-30T18:16:45.000Z'),
    sessionId: 'session-a',
  });

  assert.equal(result.success, false);
  assert.equal(result.terminal, true);
  assert.equal(result.reason, 'command-output-rejected');
  assert.match(result.outputPreview, /not found/);
});

test('unrelated local-command output cannot close the exact wrapper', () => {
  const result = scanClaudeStartupSlashRecords([
    wrapper(),
    output({ parentUuid: 'some-other-wrapper' }),
  ], '/model claude-opus-5[1m]', {
    sessionId: 'session-a',
  });

  assert.equal(result.success, false);
  assert.equal(result.terminal, undefined);
  assert.equal(result.wrapperSeen, true);
});

test('proof is isolated by exact Claude session and command epoch', () => {
  const records = [
    wrapper({ sessionId: 'session-old', timestamp: '2026-07-30T18:17:10.163Z' }),
    output({ sessionId: 'session-old', timestamp: '2026-07-30T18:17:10.163Z' }),
    wrapper({ uuid: 'wrapper-stale', timestamp: '2026-07-30T18:00:00.000Z' }),
    output({ parentUuid: 'wrapper-stale', timestamp: '2026-07-30T18:00:00.000Z' }),
  ];
  const result = scanClaudeStartupSlashRecords(
    records,
    '/model claude-opus-5[1m]',
    {
      afterMs: Date.parse('2026-07-30T18:16:45.000Z'),
      sessionId: 'session-a',
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.wrapperSeen, false);
});

test('effort success must name the exact requested effort', () => {
  const result = scanClaudeStartupSlashRecords([
    wrapper({ command: 'effort', value: 'max' }),
    output({ text: 'Set effort level to low (saved as your default for new sessions)' }),
  ], '/effort max', { sessionId: 'session-a' });

  assert.equal(result.success, false);
  assert.equal(result.terminal, true);
});
