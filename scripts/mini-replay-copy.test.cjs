'use strict';
// Reads ONLY immutable headless evidence, never the user's subsequently edited
// manual profile, the original session or a live DB.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const dir = path.resolve(__dirname, '../docs/tmp/мини-оркестратор-20261030/replay/main');
const native = JSON.parse(fs.readFileSync(path.join(dir, '../main-readonly-v2/CASE.json'), 'utf8'));
const profile = { ...native, outputBytes: native.initialBytes, recordCount: native.initialRecords,
  rewindProof: { exactTurnId: native.excludedTurnId } };
test('private standalone clone starts at chosen compact and ends before the entire selected turn', () => {
  assert.ok(profile.sessionFile.startsWith(profile.root + path.sep));
  const bytes = fs.readFileSync(profile.sessionFile).subarray(0, profile.initialBytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), profile.initialSha256);
  assert.equal(bytes.length, profile.outputBytes);
  const records = bytes.toString().trimEnd().split('\n').map(JSON.parse);
  assert.equal(records.length, profile.recordCount);
  assert.equal(records[0].payload.id, profile.sessionId);
  assert.equal(records[0].payload.session_id, profile.sessionId);
  assert.equal(records[0].payload.cwd, profile.cwd);
  assert.equal(records[0].payload.history_base, undefined);
  assert.equal(records[1].type, 'compacted');
  assert.equal(records[1].timestamp, '2026-10-29T14:23:22.431Z');
  assert.equal(records.filter(r => r.type === 'compacted').length, 1);
  assert.ok(records.slice(1).every(r => Date.parse(r.timestamp) < Date.parse('2026-10-30T12:50:02.233Z')));
  assert.ok(records.some(r => r.payload?.type === 'user_message'));
  assert.ok(!records.some(r => r.payload?.turn_id === profile.rewindProof.exactTurnId));
  assert.ok(profile.source.discardedEarlierBytes > 600 * 1024 * 1024);
  assert.ok(bytes.length < 16 * 1024 * 1024);
});
test('independent screenshot bytes match the original content-addressed asset', () => {
  for (const image of profile.attachments) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(image.path)).digest('hex'), image.sha256);
  }
});
test('only explicit private mini DEV omits full-access; ordinary Codex command is unchanged', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
  const body = source.slice(source.indexOf('function buildCodexCommand({'), source.indexOf('\nfunction cleanCodexTuiFrame('));
  const context = { process: { env: {} }, shellQuote: v => JSON.stringify(v), tomlString: JSON.stringify };
  vm.runInNewContext(body + '\nthis.build=buildCodexCommand;', context);
  const args = { command: 'codex-c', sessionId: 'private', cwd: profile.cwd };
  assert.match(context.build(args), /--dangerously-bypass-approvals-and-sandbox/);
  context.process.env.NOTED_MINI_READ_ONLY_CODEX = '1';
  assert.match(context.build(args), /--dangerously-bypass-approvals-and-sandbox/);
  context.process.env.NOTED_E2E_TEST = 'true';
  assert.match(context.build(args), /--sandbox read-only --ask-for-approval on-request/);
  assert.doesNotMatch(context.build(args), /dangerously-bypass/);
});
test('mini credential is held by trusted Main and never appears in a child environment', () => {
  const { isolateMainProcessEnv, buildChildProcessEnv, getMainProcessEnvValue } = require('../src/main/child-process-env');
  const env = { NOTED_MINI_GEMINI_API_KEY: 'synthetic-fixture-only', PATH: '/usr/bin' };
  isolateMainProcessEnv(env);
  assert.equal(env.NOTED_MINI_GEMINI_API_KEY, undefined);
  assert.equal(getMainProcessEnvValue('NOTED_MINI_GEMINI_API_KEY'), 'synthetic-fixture-only');
  assert.equal(buildChildProcessEnv({ NOTED_MINI_GEMINI_API_KEY: 'synthetic-fixture-only' }, env).NOTED_MINI_GEMINI_API_KEY, undefined);
});
