'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateTerminalCwdCandidate } = require('./terminal-cwd-proof');

test('rejects a non-absolute OSC cwd candidate before reading live process state', async () => {
  let liveReads = 0;
  const result = await validateTerminalCwdCandidate({
    candidate: 'Users/fedor/Desktop/custom-terminal',
    readLiveCwd: async () => {
      liveReads += 1;
      return '/Users/example/Desktop/custom-terminal';
    },
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: 'candidate-not-absolute',
  });
  assert.equal(liveReads, 0);
});

test('rejects an update when live cwd cannot be observed', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-cwd-proof-unknown-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const result = await validateTerminalCwdCandidate({
    candidate: dir,
    readLiveCwd: async () => {
      throw new Error('lsof timed out');
    },
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: 'live-cwd-unknown',
  });
});

test('rejects missing and non-directory candidates', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-cwd-proof-invalid-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const missing = path.join(root, 'missing');
  const file = path.join(root, 'file.txt');
  await fs.promises.writeFile(file, 'not a directory');

  assert.deepEqual(await validateTerminalCwdCandidate({
    candidate: missing,
    readLiveCwd: async () => root,
  }), {
    accepted: false,
    reason: 'candidate-missing',
  });
  assert.deepEqual(await validateTerminalCwdCandidate({
    candidate: file,
    readLiveCwd: async () => root,
  }), {
    accepted: false,
    reason: 'candidate-not-directory',
  });
});

test('rejects an existing directory that does not match live cwd', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-cwd-proof-mismatch-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'candidate');
  const observed = path.join(root, 'observed');
  await Promise.all([
    fs.promises.mkdir(candidate),
    fs.promises.mkdir(observed),
  ]);

  assert.deepEqual(await validateTerminalCwdCandidate({
    candidate,
    readLiveCwd: async () => observed,
  }), {
    accepted: false,
    reason: 'live-cwd-mismatch',
    observedCwd: observed,
  });
});

test('accepts an existing directory that exactly matches live cwd', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-cwd-proof-exact-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const result = await validateTerminalCwdCandidate({
    candidate: dir,
    readLiveCwd: async () => dir,
  });

  assert.deepEqual(result, {
    accepted: true,
    reason: 'live-cwd-match',
    cwd: dir,
    observedCwd: dir,
  });
});

test('accepts a logical symlink candidate when live cwd reports the canonical target', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-cwd-proof-symlink-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const link = path.join(root, 'logical-link');
  await fs.promises.mkdir(target);
  await fs.promises.symlink(target, link, 'dir');

  const result = await validateTerminalCwdCandidate({
    candidate: link,
    readLiveCwd: async () => target,
  });

  assert.deepEqual(result, {
    accepted: true,
    reason: 'live-cwd-match',
    cwd: link,
    observedCwd: target,
  });
});
