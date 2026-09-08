import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import asar from '@electron/asar';
import {
  buildInstallNotedTerminal, INSTALL_READY_PREFIX, PREPARE_SCRIPTS,
  validateAppBundle, waitForInstallAck,
} from './build-install-noted-terminal.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'noted-install-driver-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationsDir = path.join(root, 'Applications');
  const installedApp = path.join(applicationsDir, 'Noted Terminal.app');
  const releaseApp = path.join(root, 'release', 'Noted Terminal.app');
  await fs.mkdir(applicationsDir);
  async function makeApp(target, version) {
    await fs.mkdir(path.join(target, 'Contents', 'MacOS'), { recursive: true });
    await fs.mkdir(path.join(target, 'Contents', 'Resources'), { recursive: true });
    await fs.writeFile(path.join(target, 'Contents', 'Info.plist'), 'test plist');
    await fs.writeFile(path.join(target, 'Contents', 'MacOS', 'Noted Terminal'), 'test executable');
    await fs.writeFile(path.join(target, 'Contents', 'Resources', 'app.asar'), version);
  }
  if (!options.firstInstall) await makeApp(installedApp, 'old installed bytes');
  await makeApp(releaseApp, 'new prepared bytes');
  const events = [];
  let failedOnce = false;
  let validation = 0;
  const fail = label => {
    if (options.fail === label && !failedOnce) { failedOnce = true; throw new Error('injected ' + label); }
  };
  const readVersion = app => fs.readFile(path.join(app, 'Contents', 'Resources', 'app.asar'), 'utf8');
  const run = async (command, args, commandOptions) => {
    const label = command === 'npm' ? args[1] : command === 'bash' ? 'quit' : command === '/usr/bin/open' ? 'open' : command === '/usr/bin/ditto' ? 'copy' : command;
    events.push({ label, args, commandOptions });
    fail(label);
    if (label === 'copy') await fs.cp(args[0], args[1], { recursive: true });
    if (label === 'open') events.push({ label: 'opened-version', version: await readVersion(args[0]) });
    if (label === 'quit') options.onQuit?.();
  };
  const fileSystem = {
    ...fs,
    rename: async (from, to) => {
      const label = to.endsWith('previous.app') ? 'preserve' : from.endsWith('previous.app') ? 'restore' : to.endsWith('failed.app') ? 'retain-failed' : 'replace';
      events.push({ label, from, to });
      fail(label);
      if (options.failRecovery && label === 'restore') throw new Error('injected restore failure');
      await fs.rename(from, to);
    },
  };
  const validate = async target => {
    const label = ['validate-release', 'validate-stage', 'validate-installed'][validation++];
    events.push({ label, target });
    fail(label);
    assert.equal(await readVersion(target), 'new prepared bytes');
  };
  const beforeQuit = async data => {
    events.push({ label: 'idle-ack', data });
    fail('idle-ack');
    if (!options.firstInstall) assert.equal(await readVersion(installedApp), 'old installed bytes');
    await options.beforeQuit?.(data);
  };
  return { root, applicationsDir, installedApp, releaseApp, events, readVersion,
    execute: extra => buildInstallNotedTerminal({ projectDir: root, applicationsDir, releaseApp, run, fileSystem, validate, beforeQuit, log() {}, ...extra }),
  };
}

test('prepare/sign/integrations and staged validation precede quit; old app is retained', async t => {
  const f = await fixture(t);
  const result = await f.execute();
  assert.equal(result.ok, true);
  assert.equal(result.installed, true);
  assert.equal(result.launchRequested, true);
  assert.deepEqual(f.events.map(x => x.label), [
    ...PREPARE_SCRIPTS, 'validate-release', 'copy', 'validate-stage', 'idle-ack',
    'quit', 'preserve', 'replace', 'validate-installed', 'open', 'opened-version',
  ]);
  assert.equal(await f.readVersion(f.installedApp), 'new prepared bytes');
  assert.equal(await f.readVersion(result.previousApp), 'old installed bytes');
  await assert.rejects(fs.stat(path.join(f.applicationsDir, '.noted-terminal-install-lock')), { code: 'ENOENT' });
});

for (const failure of [...PREPARE_SCRIPTS, 'validate-release', 'copy', 'validate-stage', 'idle-ack']) {
  test('failure before quit leaves installed app byte-for-byte in place: ' + failure, async t => {
    const f = await fixture(t, { fail: failure });
    const result = await f.execute();
    assert.equal(result.ok, false);
    assert.equal(result.recovery.status, 'installed-app-untouched');
    assert.equal(await f.readVersion(f.installedApp), 'old installed bytes');
    assert.ok(!f.events.some(e => ['quit', 'preserve', 'replace', 'open'].includes(e.label)));
  });
}

for (const failure of ['quit', 'preserve', 'replace', 'validate-installed', 'open']) {
  test('post-quit failure restores/reopens old app, not an unvalidated artifact: ' + failure, async t => {
    const f = await fixture(t, { fail: failure });
    const result = await f.execute();
    assert.equal(result.ok, false);
    assert.equal(result.recovery.status, 'previous-app-reopened');
    assert.equal(await f.readVersion(f.installedApp), 'old installed bytes');
    assert.equal(f.events.filter(e => e.label === 'opened-version').at(-1).version, 'old installed bytes');
    if (failure === 'open') assert.equal(f.events.filter(e => e.label === 'quit').length, 2);
  });
}

test('failed rollback keeps exact previous app and failed candidate for manual recovery', async t => {
  const f = await fixture(t, { fail: 'validate-installed', failRecovery: true });
  const result = await f.execute();
  assert.equal(result.ok, false);
  assert.equal(result.recovery.status, 'failed');
  assert.equal(await f.readVersion(result.previousApp), 'old installed bytes');
  assert.equal(await f.readVersion(path.join(result.stagingRoot, 'failed.app')), 'new prepared bytes');
});

test('first install cannot invent a previous app on launch failure', async t => {
  const f = await fixture(t, { firstInstall: true, fail: 'open' });
  const result = await f.execute();
  assert.equal(result.recovery.status, 'no-previous-app');
  assert.equal(await f.readVersion(path.join(result.stagingRoot, 'failed.app')), 'new prepared bytes');
});

test('concurrent/stale lock is refused without touching it or running build steps', async t => {
  const f = await fixture(t);
  const lock = path.join(f.applicationsDir, '.noted-terminal-install-lock');
  await fs.mkdir(lock);
  const result = await f.execute();
  assert.equal(result.ok, false);
  assert.equal(result.failedStep, 'lock');
  assert.equal(f.events.length, 0);
  assert.ok((await fs.stat(lock)).isDirectory());
});

test('cancel before ACK cannot quit the installed host', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { beforeQuit: () => controller.abort(new Error('cancelled by owner')) });
  const result = await f.execute({ signal: controller.signal });
  assert.equal(result.recovery.status, 'installed-app-untouched');
  assert.ok(!f.events.some(e => e.label === 'quit'));
});

test('cancel during quit lets shutdown finish, then reopens the old app without swapping', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { onQuit: () => controller.abort(new Error('cancelled during shutdown')) });
  const result = await f.execute({ signal: controller.signal });
  assert.equal(result.recovery.status, 'previous-app-reopened');
  assert.equal(f.events.find(e => e.label === 'quit').commandOptions.signal, undefined);
  assert.ok(!f.events.some(e => e.label === 'replace'));
});

test('bundle validation requires exact identifier, real artifacts and stable signing authority', async t => {
  const f = await fixture(t);
  const archiveSource = await fs.mkdtemp(path.join(tmpdir(), 'noted-install-valid-archive-'));
  t.after(() => fs.rm(archiveSource, { recursive: true, force: true }));
  await fs.writeFile(path.join(archiveSource, 'main.js'), 'module.exports = 1;');
  await asar.createPackage(archiveSource, path.join(f.releaseApp, 'Contents', 'Resources', 'app.asar'));
  const commandLog = [];
  const run = async (command, args) => {
    commandLog.push({ command, args });
    if (args.includes('Print :CFBundleIdentifier')) return 'com.noted.terminal\n';
    if (args.includes('Print :CFBundleExecutable')) return 'Noted Terminal\n';
    return 'Authority=' + (process.env.LOCAL_CODESIGN_IDENTITY || 'Noted Terminal Dev') + '\n';
  };
  await validateAppBundle(f.releaseApp, { run });
  assert.ok(commandLog.some(x => x.command === '/usr/bin/codesign' && x.args.includes('--strict')));
  await assert.rejects(validateAppBundle(f.releaseApp, {
    run: async (command, args) => args.includes('Print :CFBundleIdentifier') ? 'com.other.app' : run(command, args),
  }), /unexpected app identifier/);
  await assert.rejects(validateAppBundle(f.releaseApp, {
    run: async (command, args) => args.includes('--verbose=4') ? 'Authority=Ad Hoc\n' : run(command, args),
  }), /unexpected signing authority/);
  await fs.writeFile(path.join(f.releaseApp, 'Contents', 'Resources', 'app.asar'), '');
  await assert.rejects(validateAppBundle(f.releaseApp, { run }), /missing\/empty app artifact/);
});

const nonce = 'test-job-123';
function handshake(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const pending = waitForInstallAck({ nonce, input, output, timeoutMs: 1000, ...options });
  assert.equal(text, '\n' + INSTALL_READY_PREFIX + nonce + '\n');
  return { input, output, pending };
}

test('pre-quit protocol requires exact split-safe ACK', async () => {
  const h = handshake();
  h.input.write('install test-');
  h.input.write('job-123\n');
  await h.pending;
});

test('matching idle progress extends the owner deadline without authorizing quit', async () => {
  const h = handshake({ timeoutMs: 100 });
  let approved = false;
  h.pending.then(() => { approved = true; });
  // Cross the original deadline while existing observation progress keeps
  // the owner alive. No application, shell command, or installer is started.
  const progress = setInterval(() => h.input.write('waiting test-job-123\n'), 20);
  await new Promise(resolve => setTimeout(resolve, 125));
  clearInterval(progress);
  assert.equal(approved, false);
  h.input.write('install test-job-123\n');
  await h.pending;
});

test('wrong ACK or closed owner channel rejects before any quit', async () => {
  const wrong = handshake();
  wrong.input.end('install some-other-job\n');
  await assert.rejects(wrong.pending, /does not match/);
  const closed = handshake();
  closed.input.end();
  await assert.rejects(closed.pending, /closed the ACK channel/);
});

test('silent or cancelled handshake remains bounded and unapproved', async () => {
  const silent = handshake({ timeoutMs: 10 });
  await assert.rejects(silent.pending, /deadline expired/);
  const controller = new AbortController();
  const cancelled = handshake({ signal: controller.signal });
  controller.abort(new Error('owner cancelled'));
  await assert.rejects(cancelled.pending, /owner cancelled/);
});
