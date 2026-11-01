'use strict';
// An unconfirmed Claude setting must read as "waiting", never as "rejected".
//
// Reproduced incident (production.log, 2026-10-31):
//   07:38:16.651 tab 6d6fd1718b66  /model claude-opus-5[1m]
//                reason=wrapper-not-found  wrapperSeen=false   <- read deadline
//   ...18 further polls, all wrapper-not-found...
//   07:38:43.083 same commandId      success=true reason=jsonl-stdout
//                                                        session=30ea154d
// The model DID apply, 30.6s later; the proof simply had not been written yet
// (0.3s on a quiet tab, 30.6s while Main was busy). The user was nevertheless
// shown "Claude: не удалось применить модель" with code
// claude_setting_outcome_unknown, i.e. the opposite of what happened.
//
// `wrapper-not-found` is produced with outcome 'pending'
// (claude-setting-evidence.js), so this is a deadline, not a provider verdict.
// Real rejections (rate limit, expired login, access denied, an explicit
// rejecting stdout) must keep their failure wording untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeClaudeStartupFailure,
  formatClaudeStartupFailureReport,
} = require('../shared/claude-startup-failure.cjs');
const { scanClaudeStartupSlashRecords } = require('./claude-startup-slash-proof');

const UNKNOWN_CODE = 'claude_setting_outcome_unknown';
const pendingError = (command = '/model claude-opus-5[1m]') => ({
  message: command + ' was not confirmed by Claude; reason=wrapper-not-found'
    + '; wrapper=false; stdout=false',
  code: UNKNOWN_CODE,
  failedCommand: command,
});

test('an unconfirmed setting is presented as pending, not as a failure', () => {
  for (const [command, target] of [
    ['/model claude-opus-5[1m]', 'модель'],
    ['/effort max', 'уровень усилий'],
  ]) {
    const error = pendingError(command);
    const failure = describeClaudeStartupFailure({
      error, errorCode: error.code, failedCommand: command,
    });
    assert.equal(failure.code, UNKNOWN_CODE, command);
    assert.equal(failure.pending, true, command + ' must be marked pending');
    assert.match(failure.userMessage, new RegExp(target),
      command + ' must name what is still unconfirmed');
    assert.doesNotMatch(failure.userMessage, /не удалось/,
      command + ' must not claim the setting failed');
    assert.match(failure.detail, /не отказ/,
      command + ' detail must say this is not a rejection');
  }
});

test('the copied incident report still carries the exact provider reason', () => {
  const error = pendingError();
  const report = formatClaudeStartupFailureReport({
    tabId: 'tab-9b788f9d-6847-4b56-a44c-6d6fd1718b66',
    sessionId: '30ea154d-9aa4-46dc-88ea-3adb9f8ed0df',
    error, errorCode: error.code, failedCommand: error.failedCommand,
  });
  assert.match(report, /reason=wrapper-not-found/, 'the diagnostic reason is preserved');
  assert.match(report, /Error code: claude_setting_outcome_unknown/);
  assert.match(report, /Command: \/model claude-opus-5\[1m\]/);
  assert.match(report, /Session ID: 30ea154d/);
});

test('real rejections keep their failure wording and are never marked pending', () => {
  const cases = [
    ['API error: 429 rate limit exceeded', 'claude_rate_limit', /лимит/],
    ['OAuth refresh token is no longer valid. Run /login to re-authenticate.',
      'claude_auth_expired', /войти в аккаунт/],
    ['API error: 403 forbidden', 'claude_access_denied', /доступ запрещён/],
    ['Unknown model: claude-opus-9', 'claude_startup_setting_rejected', /не удалось применить/],
  ];
  for (const [message, expectedCode, expectedText] of cases) {
    const failure = describeClaudeStartupFailure({
      error: { message }, failedCommand: '/model claude-opus-5[1m]',
    });
    assert.equal(failure.code, expectedCode, message);
    assert.notEqual(failure.pending, true, message + ' must not be pending');
    assert.match(failure.userMessage, expectedText, message);
  }
});

test('an explicitly rejected command is terminal, not pending', () => {
  // A wrapper plus its direct rejecting child: a real provider verdict.
  const wrapper = {
    type: 'user', uuid: 'w1', sessionId: 'S',
    timestamp: '2026-10-31T07:38:16.000Z',
    message: { role: 'user',
      content: '<command-name>/model</command-name>'
        + '<command-message>model</command-message>'
        + '<command-args>claude-opus-5[1m]</command-args>' },
  };
  const rejected = {
    type: 'user', uuid: 's1', parentUuid: 'w1', sessionId: 'S',
    timestamp: '2026-10-31T07:38:16.500Z',
    message: { role: 'user',
      content: '<local-command-stdout>API error: 429 rate limit exceeded</local-command-stdout>' },
  };
  const proof = scanClaudeStartupSlashRecords([wrapper, rejected],
    '/model claude-opus-5[1m]', { sessionId: 'S', wrapperUuid: 'w1' });
  assert.equal(proof.success, false);
  assert.equal(proof.terminal, true, 'a paired rejecting child is a terminal verdict');
  assert.equal(proof.failureCode, 'claude_rate_limit');

  const failure = describeClaudeStartupFailure({
    error: { message: proof.outputText }, errorCode: proof.failureCode,
    failedCommand: '/model claude-opus-5[1m]',
  });
  assert.notEqual(failure.pending, true, 'a terminal rejection is never pending');
});

test('the exact live JSONL shape of /model and /effort is still recognised', () => {
  // Captured verbatim from this machine's own transcript, CLI 2.1.316,
  // 2026-10-31T08:14:32Z — proof that the record format did NOT change and the
  // detector matches it. Only the write timing was ever the problem.
  const records = [
    { type: 'user', uuid: 'w-model', sessionId: 'S',
      timestamp: '2026-10-31T08:14:32.282Z',
      message: { role: 'user',
        content: '<command-name>/model</command-name>\n'
          + '            <command-message>model</command-message>\n'
          + '            <command-args>claude-opus-5[1m]</command-args>' } },
    { type: 'user', uuid: 's-model', parentUuid: 'w-model', sessionId: 'S',
      timestamp: '2026-10-31T08:14:32.282Z',
      message: { role: 'user',
        content: '<local-command-stdout>Set model to `Opus 5` and saved as your'
          + ' default for new sessions</local-command-stdout>' } },
    { type: 'user', uuid: 'w-effort', sessionId: 'S',
      timestamp: '2026-10-31T08:14:33.008Z',
      message: { role: 'user',
        content: '<command-name>/effort</command-name>\n'
          + '            <command-message>effort</command-message>\n'
          + '            <command-args>max</command-args>' } },
    { type: 'user', uuid: 's-effort', parentUuid: 'w-effort', sessionId: 'S',
      timestamp: '2026-10-31T08:14:33.008Z',
      message: { role: 'user',
        content: '<local-command-stdout>Set effort level to max (this session'
          + ' only): Maximum capability with deepest reasoning.</local-command-stdout>' } },
  ];
  const effort = scanClaudeStartupSlashRecords(records, '/effort max',
    { sessionId: 'S', wrapperUuid: 'w-effort' });
  assert.equal(effort.success, true, '/effort proof must be found in the live shape');
  assert.equal(effort.reason, 'jsonl-stdout');
  assert.equal(effort.wrapperSeen, true);

  // Before its wrapper is written, the same scan reports a pending read, which
  // is exactly the state that used to surface as a user-facing failure.
  const beforeWrite = scanClaudeStartupSlashRecords([], '/effort max', { sessionId: 'S' });
  assert.equal(beforeWrite.success, false);
  assert.equal(beforeWrite.reason, 'stdout-not-found');
  assert.equal(beforeWrite.wrapperSeen, false);
  assert.notEqual(beforeWrite.terminal, true, 'an empty read is not a verdict');
});
