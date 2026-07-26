'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectDescendantProcessEntries,
  selectTerminalCwdObservation,
} = require('./terminal-process-cwd');

test('collects PTY descendants deepest-first without crossing unrelated roots', () => {
  const children = new Map([
    [10, [{ pid: 11, ppid: 10, cmd: '/bin/zsh' }, { pid: 20, ppid: 10, cmd: 'other' }]],
    [11, [{ pid: 12, ppid: 11, cmd: '/bin/zsh -l' }]],
    [12, [{ pid: 13, ppid: 12, cmd: 'codex' }]],
    [20, [{ pid: 21, ppid: 20, cmd: 'other-child' }]],
  ]);

  assert.deepEqual(
    collectDescendantProcessEntries(children, 11).map(({ pid, depth }) => ({ pid, depth })),
    [
      { pid: 13, depth: 2 },
      { pid: 12, depth: 1 },
    ],
  );
});

test('accepts the visible nested shell cwd when the PTY root retains its launch cwd', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-process-cwd-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const launchCwd = path.join(root, 'project');
  const visibleCwd = path.join(root, 'visible-shell');
  await Promise.all([
    fs.promises.mkdir(launchCwd),
    fs.promises.mkdir(visibleCwd),
  ]);

  assert.deepEqual(await selectTerminalCwdObservation({
    candidate: visibleCwd,
    rootPid: 100,
    observations: [
      { pid: 100, depth: 0, cwd: launchCwd },
      { pid: 101, depth: 1, cwd: visibleCwd },
    ],
    descendantsComplete: true,
  }), {
    status: 'found',
    cwd: visibleCwd,
    pid: 101,
    source: 'pty-descendant',
    depth: 1,
  });
});

test('keeps a real mismatch when every descendant cwd was observed', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-process-cwd-mismatch-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const launchCwd = path.join(root, 'project');
  const childCwd = path.join(root, 'child');
  const candidate = path.join(root, 'candidate');
  await Promise.all([
    fs.promises.mkdir(launchCwd),
    fs.promises.mkdir(childCwd),
    fs.promises.mkdir(candidate),
  ]);

  assert.deepEqual(await selectTerminalCwdObservation({
    candidate,
    rootPid: 100,
    observations: [
      { pid: 100, depth: 0, cwd: launchCwd },
      { pid: 101, depth: 1, cwd: childCwd },
    ],
    descendantsComplete: true,
  }), {
    status: 'found',
    cwd: launchCwd,
    pid: 100,
    source: 'pty-root-no-candidate-match',
  });
});

test('does not turn an incomplete descendant lookup into a false mismatch', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-process-cwd-unknown-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const launchCwd = path.join(root, 'project');
  const candidate = path.join(root, 'candidate');
  await Promise.all([
    fs.promises.mkdir(launchCwd),
    fs.promises.mkdir(candidate),
  ]);

  assert.deepEqual(await selectTerminalCwdObservation({
    candidate,
    rootPid: 100,
    observations: [{ pid: 100, depth: 0, cwd: launchCwd }],
    descendantsComplete: false,
  }), {
    status: 'unknown',
    reason: 'cwd-observation-incomplete',
    cwd: launchCwd,
  });
});

test('canonical paths allow a symlink candidate to match a descendant cwd', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'terminal-process-cwd-link-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  await fs.promises.mkdir(target);
  await fs.promises.symlink(target, link, 'dir');

  assert.deepEqual(await selectTerminalCwdObservation({
    candidate: link,
    rootPid: 100,
    observations: [
      { pid: 100, depth: 0, cwd: root },
      { pid: 101, depth: 1, cwd: target },
    ],
    descendantsComplete: true,
  }), {
    status: 'found',
    cwd: target,
    pid: 101,
    source: 'pty-descendant',
    depth: 1,
  });
});
