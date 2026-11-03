'use strict';
// `npm run <команда>-t` / `-tg` — выполнить команду и прислать итог в Telegram.
//
// The feature exists for unattended builds: `build:install` and friends run for
// minutes and the user is not watching the terminal.
//
// The risk it carries is not the message — it is the wrapper silently changing
// how the build behaves. These cases pin the transparency contract by RUNNING
// the real wrapper against real child processes: live output, the command's own
// exit code, forwarded interrupts, and a build result that survives any
// messaging failure.
//
// Run: node --test scripts/run-with-telegram.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const wrapper = path.join(__dirname, 'run-with-telegram.js');
const { buildEnvelope, describeOutcome, notifyTelegram, MAX_TEXT } = require('./notify-telegram');

// A disposable package.json so a probe script never lands in the real one.
function sandbox(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-with-tg-'));
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { probe: script } }, null, 2));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cwd, { signalOn = null, tokenPath = '/nonexistent/noted-tg-token' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, 'probe'], {
      cwd,
      // An unreachable token makes delivery fail deterministically: these cases
      // are about the command, not about Telegram.
      env: { ...process.env, SC_DESKTOP_NOTIFICATION_TOKEN_PATH: tokenPath },
    });
    let stdout = '', stderr = '', signalled = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (signalOn && !signalled && stdout.includes(signalOn)) {
        signalled = true;
        setTimeout(() => { try { child.kill('SIGINT'); } catch {} }, 200);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the command runs for real: its output and its exit code pass through', async (t) => {
  const dir = sandbox(t, 'node -e "console.log(\'LIVE OUTPUT\'); process.exit(0)"');
  const ok = await run(dir);
  assert.match(ok.stdout, /LIVE OUTPUT/, 'the wrapper must not swallow output');
  assert.equal(ok.code, 0);
});

test('a failing command keeps its own exit code, so && chains still break', async (t) => {
  // Returning 0 here would quietly turn a broken build into a green one.
  const dir = sandbox(t, 'node -e "process.exit(3)"');
  const failed = await run(dir);
  assert.equal(failed.code, 3);
});

test('a failed notification is reported but never changes the build result', async (t) => {
  // The build already happened. Hiding its result behind a messaging error is
  // strictly worse than a missing message.
  const dir = sandbox(t, 'node -e "process.exit(0)"');
  const result = await run(dir, { tokenPath: '/nonexistent/noted-tg-token' });
  assert.equal(result.code, 0, 'a messaging failure must not fail the build');
  assert.match(result.stderr, /уведомление не отправлено/);
  assert.match(result.stderr, /token_unavailable/, 'the reason must be visible, not generic');
});

test('Ctrl+C reaches the command itself and leaves no orphan', async (t) => {
  // Forwarding matters: without it the wrapper would die while the build kept
  // running detached, which is how a "stopped" install keeps installing.
  const marker = path.join(os.tmpdir(), 'run-with-tg-' + process.pid + '.flag');
  const dir = sandbox(t, 'node -e "'
    + "const fs=require('fs');"
    + "process.on('SIGINT',()=>{fs.writeFileSync('" + marker + "','got-sigint');process.exit(130)});"
    + "console.log('WAITING');setTimeout(()=>{},30000)"
    + '"');
  t.after(() => fs.rmSync(marker, { force: true }));
  const result = await run(dir, { signalOn: 'WAITING' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'got-sigint',
    'the interrupt must reach the COMMAND; npm alone does not forward it');
  assert.notEqual(result.code, 0, 'an interrupted build is not a success');
});

test('usage error exits 2 without pretending anything ran', async () => {
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper], { cwd: repoRoot });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage/);
});

test('the message says which command, what happened and how long', () => {
  assert.match(describeOutcome({ command: 'npm run build:i-obs', code: 0, startedAt: Date.now() - 95_000 }),
    /^npm run build:i-obs — выполнена успешно за 1 мин 35 с$/);
  assert.match(describeOutcome({ command: 'npm run build:install', code: 1, startedAt: Date.now() - 12_000 }),
    /завершилась с ошибкой \(код 1\) за 12 с/);
  assert.match(describeOutcome({ command: 'npm run build', signal: 'SIGINT', startedAt: Date.now() - 3_000 }),
    /остановлена \(SIGINT\)/);
  assert.match(describeOutcome({ command: 'x', code: 0 }), /^x — выполнена успешно$/,
    'an unknown duration is omitted, not invented');
});

test('an over-long report is trimmed to the receiver limit, not refused', () => {
  // A truncated report still tells the user the command finished.
  const envelope = buildEnvelope({ text: 'x'.repeat(MAX_TEXT + 500), label: 'npm run build' });
  assert.equal(envelope.text.length, MAX_TEXT);
  assert.ok(envelope.text.endsWith('…'));
  assert.throws(() => buildEnvelope({ text: '   ', label: 'npm run build' }), /text required/);
});

test('a repeat of the same report is one message, not two', () => {
  // The receiver keys on eventId, so an identical retry after a lost ACK is
  // idempotent instead of spamming the chat.
  const detail = { text: 'same', label: 'npm run build', requestId: 'fixed', now: 1 };
  assert.equal(buildEnvelope(detail).eventId, buildEnvelope(detail).eventId);
  assert.notEqual(buildEnvelope(detail).eventId,
    buildEnvelope({ ...detail, requestId: 'other' }).eventId);
});

test('every delivery failure is distinguishable, and none of them throw', async () => {
  // "SC Desktop is not running" and "SC Desktop is too old" need different
  // answers from the user, so they must not collapse into one error.
  assert.deepEqual(await notifyTelegram({ text: 'x', label: 'l' }, { tokenPath: '/nonexistent' }),
    { ok: false, reason: 'token_unavailable' });
  assert.equal((await notifyTelegram({ text: 'x', label: 'l' },
    { fetchImpl: () => Promise.reject(new Error('fetch failed')) })).reason, 'sc_desktop_unavailable');
  assert.equal((await notifyTelegram({ text: 'x', label: 'l' },
    { fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }) })).reason,
    'sc_desktop_update_required');
  assert.equal((await notifyTelegram({ text: '', label: 'l' }, { fetchImpl: () => assert.fail('must not send') })).reason,
    'invalid_request');
  const sent = await notifyTelegram({ text: 'done', label: 'npm run build' }, {
    fetchImpl: () => Promise.resolve({ ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, deliveries: [{ message_id: 42 }] }) }),
  });
  assert.deepEqual(sent, { ok: true, status: 200, messageId: 42, duplicate: false });
});

test('every -t has a -tg twin and both point at a real base command', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  const suffixed = Object.keys(scripts).filter((name) => /-tg?$/.test(name) && name !== 'build:i-c');
  assert.ok(suffixed.length >= 20, 'the long-running commands must be covered');
  for (const name of suffixed) {
    const base = name.replace(/-tg?$/, '');
    assert.ok(scripts[base], name + ' points at a missing command');
    assert.equal(scripts[name], 'node scripts/run-with-telegram.js ' + base);
    const twin = name.endsWith('-tg') ? base + '-t' : base + '-tg';
    assert.ok(scripts[twin], name + ' has no ' + twin + ' twin');
  }
  // `build:i-c` is a real command whose name merely ends in -c; adding -t to it
  // must not have shadowed anything.
  assert.equal(scripts['build:i-c'], 'node scripts/build-and-continue-immediate.cjs');
  assert.ok(scripts['build:i-c-t'] && scripts['build:i-c-tg']);
});
