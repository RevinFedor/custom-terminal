'use strict';
// Picking a model reported "не подтверждено" when Claude had in fact answered.
//
// 02.11, tab b765ffed534b. The app sent `/model claude-sonnet-5[1m]`. Claude
// recorded the command under DIFFERENT args and applied something else:
//
//   <command-args>claude-opus-5[1m]</command-args>        ← not what we sent
//   <local-command-stdout>Set model to `Opus 5` and saved …
//        ANTHROPIC_MODEL is set to `Opus 5.5`             ← the real cause
//
// The wrapper was only accepted on an exact args match, so this one was
// invisible; its paired stdout then had no parent to attach to, and the scan
// ended at `wrapper-not-found` → "команда отправлена, подтверждение ещё не
// получено". Both halves were false: the command was answered, and waiting
// would never resolve it.
//
// The executor already had the right outcome for this — `command-applied-
// different` — it just could never be reached. Now the wrapper is accepted by
// position (Main binds the scan to one exact checkpoint: afterMs + sessionId,
// often wrapperUuid) and the stdout comparison still decides success, so a
// foreign value can never become a false confirmation.
const assert = require('node:assert/strict');
const test = require('node:test');
const { scanClaudeStartupSlashRecords } = require('./claude-startup-slash-proof');
const { describeClaudeStartupFailure } = require('../shared/claude-startup-failure.cjs');

const SID = 'b8da418f-8c11-4e0e-a8ea-f61edcaaf094';
const AFTER = 1793631203384;
const pair = (args, stdout, { sessionId = SID } = {}) => ([
  { type: 'user', sessionId, uuid: 'W', parentUuid: 'P', timestamp: '2026-11-02T14:53:24.333Z',
    message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n'
      + '<command-args>' + args + '</command-args>' } },
  { type: 'user', sessionId, uuid: 'S', parentUuid: 'W', timestamp: '2026-11-02T14:53:24.400Z',
    message: { content: '<local-command-stdout>' + stdout + '</local-command-stdout>' } },
]);
const ENV_STDOUT = 'Set model to `Opus 5` and saved as your default for new sessions'
  + '      ANTHROPIC_MODEL is set to `Opus 5.5`';

test('the exact production case resolves instead of reporting wrapper-not-found', () => {
  const result = scanClaudeStartupSlashRecords(
    pair('claude-opus-5[1m]', ENV_STDOUT), '/model claude-sonnet-5[1m]',
    { afterMs: AFTER, sessionId: SID });
  assert.equal(result.reason, 'command-applied-different');
  assert.equal(result.failureCode, 'claude_setting_applied_different');
  assert.equal(result.success, false);
  assert.equal(result.terminal, true, 'it is a settled outcome, not something to keep waiting on');
  assert.equal(result.requestedValue, 'claude-sonnet-5[1m]');
  assert.equal(result.actualValue, 'Opus 5');
  assert.equal(result.wrapperArgsDiverged, true);
});

test('a matching wrapper still confirms exactly as before', () => {
  const result = scanClaudeStartupSlashRecords(
    pair('claude-opus-5[1m]', 'Set model to `Opus 5` and saved as your default for new sessions'),
    '/model claude-opus-5[1m]', { afterMs: AFTER, sessionId: SID });
  assert.equal(result.success, true);
  assert.equal(result.reason, 'jsonl-stdout');
  assert.notEqual(result.wrapperArgsDiverged, true, 'an exact match is not a divergence');
});

test('a divergent wrapper can never become a false success', () => {
  // Accepting the wrapper by position must not weaken the outcome check:
  // the stdout still has to satisfy what we asked for.
  const result = scanClaudeStartupSlashRecords(
    pair('whatever-else', 'Set model to `Haiku 5.5` and saved as your default for new sessions'),
    '/model claude-sonnet-5[1m]', { afterMs: AFTER, sessionId: SID });
  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'claude_setting_applied_different');
  assert.equal(result.actualValue, 'Haiku 5.5');
});

test('an explicit wrapperUuid still pins the pair', () => {
  const records = pair('claude-opus-5[1m]', ENV_STDOUT);
  const foreign = scanClaudeStartupSlashRecords(records, '/model claude-sonnet-5[1m]',
    { afterMs: AFTER, sessionId: SID, wrapperUuid: 'SOMEONE-ELSE' });
  assert.equal(foreign.success, false);
  assert.equal(foreign.reason, 'stdout-unmatched',
    'a wrapper Main did not bind must not be adopted by position');
  const bound = scanClaudeStartupSlashRecords(records, '/model claude-sonnet-5[1m]',
    { afterMs: AFTER, sessionId: SID, wrapperUuid: 'W' });
  assert.equal(bound.reason, 'command-applied-different');
});

test('records from another session are still ignored', () => {
  const result = scanClaudeStartupSlashRecords(
    pair('claude-opus-5[1m]', ENV_STDOUT, { sessionId: 'other-session' }),
    '/model claude-sonnet-5[1m]', { afterMs: AFTER, sessionId: SID });
  assert.equal(result.wrapperSeen, false);
  assert.equal(result.reason, 'stdout-not-found');
});

test('records before the checkpoint are still ignored', () => {
  const stale = pair('claude-opus-5[1m]', ENV_STDOUT).map(record => ({
    ...record, timestamp: '2026-11-02T10:00:00.000Z',
  }));
  const result = scanClaudeStartupSlashRecords(stale, '/model claude-sonnet-5[1m]',
    { afterMs: AFTER, sessionId: SID });
  assert.equal(result.wrapperSeen, false);
});

test('the message names the environment variable that overrode the choice', () => {
  const described = describeClaudeStartupFailure({
    error: '/model claude-sonnet-5[1m] was not confirmed by Claude; ' + ENV_STDOUT,
    errorCode: 'claude_setting_applied_different',
    failedCommand: '/model claude-sonnet-5[1m]',
  });
  assert.match(described.userMessage, /применил другую модель — Opus 5/);
  assert.match(described.subtitle, /ANTHROPIC_MODEL/);
  assert.match(described.detail, /Opus 5\.5/, 'the actual env value must be quoted back');
  assert.match(described.detail, /Повтор выбора ничего не изменит/,
    'the user must be told that retrying is pointless');
  assert.notEqual(described.pending, true, 'this is settled, not pending');
});

test('without an env var the message still says what was applied instead', () => {
  const described = describeClaudeStartupFailure({
    error: 'Set model to `Haiku 5.5` and saved as your default for new sessions',
    errorCode: 'claude_setting_applied_different',
    failedCommand: '/model claude-sonnet-5[1m]',
  });
  assert.match(described.userMessage, /Haiku 5\.5/);
  assert.doesNotMatch(described.subtitle, /ANTHROPIC_MODEL/,
    'no env var must not be invented');
});

test('args differing only by case stay unowned — the regression this fix nearly caused', () => {
  // Custom model IDs are case-sensitive, and here the args ARE the evidence:
  // `/model VendorCase` recorded as `vendorcase` with stdout `Set model to
  // VendorCase` would compare equal at the stdout stage and confirm a command
  // we never sent that way. Caught by claude-startup-slash-proof.test.js.
  const records = [
    { type: 'user', sessionId: SID, uuid: 'W', parentUuid: 'P', timestamp: '2026-11-02T14:53:24.333Z',
      message: { content: '<command-name>/model</command-name>\n<command-args>vendorcase</command-args>' } },
    { type: 'user', sessionId: SID, uuid: 'S', parentUuid: 'W', timestamp: '2026-11-02T14:53:24.400Z',
      message: { content: '<local-command-stdout>Set model to VendorCase</local-command-stdout>' } },
  ];
  const result = scanClaudeStartupSlashRecords(records, '/model VendorCase',
    { afterMs: AFTER, sessionId: SID });
  assert.equal(result.success, false);
  assert.equal(result.wrapperSeen, false, 'a case-only difference must not adopt the wrapper');
});

test('effort keeps its case-insensitive enum matching', () => {
  // Effort is a normalized enum, so `/effort HIGH` answered as `high` is the
  // SAME command, not a divergence.
  const records = [
    { type: 'user', sessionId: SID, uuid: 'W', parentUuid: 'P', timestamp: '2026-11-02T14:53:24.333Z',
      message: { content: '<command-name>/effort</command-name>\n<command-args>HIGH</command-args>' } },
    { type: 'user', sessionId: SID, uuid: 'S', parentUuid: 'W', timestamp: '2026-11-02T14:53:24.400Z',
      message: { content: '<local-command-stdout>Set effort level to high (saved as your default for new sessions)</local-command-stdout>' } },
  ];
  const result = scanClaudeStartupSlashRecords(records, '/effort high',
    { afterMs: AFTER, sessionId: SID });
  assert.equal(result.success, true);
  assert.notEqual(result.wrapperArgsDiverged, true);
});
