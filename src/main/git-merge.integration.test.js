'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const {
  abortMergeForRoot,
  continueMergeForRoot,
  getMergeState,
  listBranches,
  previewMergeForRoot,
  startMergeForRoot,
} = require('./ipc/git').__test;

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

async function createRepo(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-git-merge-'));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Noted Test']);
  git(root, ['config', 'user.email', 'noted-test@example.com']);
  await fs.promises.writeFile(path.join(root, 'shared.txt'), 'base\n');
  git(root, ['add', 'shared.txt']);
  git(root, ['commit', '--quiet', '-m', 'base']);
  git(root, ['branch', '-M', 'main']);
  return root;
}

async function createConflictingBranches(t) {
  const root = await createRepo(t);
  git(root, ['checkout', '--quiet', '-b', 'feature']);
  await fs.promises.writeFile(path.join(root, 'shared.txt'), 'feature\n');
  git(root, ['commit', '--quiet', '-am', 'feature edit']);
  git(root, ['checkout', '--quiet', 'main']);
  await fs.promises.writeFile(path.join(root, 'shared.txt'), 'main\n');
  git(root, ['commit', '--quiet', '-am', 'main edit']);
  return root;
}

test('branch listing preserves the empty HEAD field for every non-current branch', async (t) => {
  const root = await createRepo(t);
  git(root, ['branch', 'clean-feature']);
  git(root, ['branch', 'conflict-feature']);
  git(root, ['branch', 'abort-feature']);

  const branches = await listBranches(root);
  assert.deepEqual(
    branches.map((branch) => branch.name).sort(),
    ['abort-feature', 'clean-feature', 'conflict-feature', 'main'],
  );
  assert.equal(branches.find((branch) => branch.name === 'main')?.current, true);
  assert.equal(branches.find((branch) => branch.name === 'main')?.default, true);
  assert.equal(branches.every((branch) => branch.updatedUnix > 0), true);
});

test('clean merge creates a merge commit without leaving transient merge state', async (t) => {
  const root = await createRepo(t);
  git(root, ['checkout', '--quiet', '-b', 'feature']);
  await fs.promises.writeFile(path.join(root, 'feature.txt'), 'feature\n');
  git(root, ['add', 'feature.txt']);
  git(root, ['commit', '--quiet', '-m', 'feature']);
  git(root, ['checkout', '--quiet', 'main']);

  const preview = await previewMergeForRoot(root, 'feature');
  assert.equal(preview.state, 'ready');
  assert.equal(preview.conflictCount, 0);
  assert.equal(preview.commitCount, 1);

  const result = await startMergeForRoot(root, 'feature');
  assert.equal(result.state, 'merged');
  assert.equal(git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).length, 3);
  assert.equal((await getMergeState(root)).inProgress, false);
  assert.equal(await fs.promises.readFile(path.join(root, 'feature.txt'), 'utf8'), 'feature\n');
});

test('conflicted merge is previewed without mutation and can be continued after Git marks files resolved', async (t) => {
  const root = await createConflictingBranches(t);

  const preview = await previewMergeForRoot(root, 'feature');
  assert.equal(preview.state, 'conflicts');
  assert.deepEqual(preview.conflictFiles, ['shared.txt']);
  assert.equal((await getMergeState(root)).inProgress, false);
  assert.equal(git(root, ['status', '--porcelain']), '');

  const started = await startMergeForRoot(root, 'feature');
  assert.equal(started.state, 'conflicts');
  assert.deepEqual(started.conflictFiles, ['shared.txt']);
  assert.equal((await getMergeState(root)).inProgress, true);

  await fs.promises.writeFile(path.join(root, 'shared.txt'), 'resolved\n');
  git(root, ['add', 'shared.txt']);
  const resolvedState = await getMergeState(root);
  assert.equal(resolvedState.inProgress, true);
  assert.equal(resolvedState.readyToCommit, true);

  const completed = await continueMergeForRoot(root);
  assert.equal(completed.state, 'merged');
  assert.equal(git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/).length, 3);
  assert.equal((await getMergeState(root)).inProgress, false);
  assert.equal(await fs.promises.readFile(path.join(root, 'shared.txt'), 'utf8'), 'resolved\n');
});

test('abort restores the exact pre-merge branch contents and clean working tree', async (t) => {
  const root = await createConflictingBranches(t);
  const beforeHead = git(root, ['rev-parse', 'HEAD']);

  const started = await startMergeForRoot(root, 'feature');
  assert.equal(started.state, 'conflicts');
  assert.equal((await getMergeState(root)).inProgress, true);

  const aborted = await abortMergeForRoot(root);
  assert.equal(aborted.state, 'aborted');
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(await fs.promises.readFile(path.join(root, 'shared.txt'), 'utf8'), 'main\n');
  assert.equal((await getMergeState(root)).inProgress, false);
});

test('dirty working tree blocks merge before Git mutates repository state', async (t) => {
  const root = await createRepo(t);
  git(root, ['checkout', '--quiet', '-b', 'feature']);
  await fs.promises.writeFile(path.join(root, 'feature.txt'), 'feature\n');
  git(root, ['add', 'feature.txt']);
  git(root, ['commit', '--quiet', '-m', 'feature']);
  git(root, ['checkout', '--quiet', 'main']);
  await fs.promises.writeFile(path.join(root, 'local.txt'), 'uncommitted\n');

  const preview = await previewMergeForRoot(root, 'feature');
  assert.equal(preview.state, 'dirty');
  assert.equal(preview.changedFileCount, 1);
  assert.equal((await getMergeState(root)).inProgress, false);
  assert.match(git(root, ['status', '--porcelain']), /local\.txt/);
});

test('a source already contained by the current branch is reported as up to date', async (t) => {
  const root = await createRepo(t);
  git(root, ['branch', 'feature']);
  await fs.promises.writeFile(path.join(root, 'main.txt'), 'main\n');
  git(root, ['add', 'main.txt']);
  git(root, ['commit', '--quiet', '-m', 'main ahead']);

  const preview = await previewMergeForRoot(root, 'feature');
  assert.equal(preview.state, 'up-to-date');
  assert.equal((await getMergeState(root)).inProgress, false);
});

test('a failed commit hook preserves a ready merge that the UI can recover or abort', async (t) => {
  const root = await createRepo(t);
  git(root, ['checkout', '--quiet', '-b', 'feature']);
  await fs.promises.writeFile(path.join(root, 'feature.txt'), 'feature\n');
  git(root, ['add', 'feature.txt']);
  git(root, ['commit', '--quiet', '-m', 'feature']);
  git(root, ['checkout', '--quiet', 'main']);

  const hookPath = path.join(root, '.git', 'hooks', 'pre-commit');
  await fs.promises.writeFile(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  await assert.rejects(() => startMergeForRoot(root, 'feature'));
  const pending = await getMergeState(root);
  assert.equal(pending.inProgress, true);
  assert.equal(pending.readyToCommit, true);
  assert.equal(pending.conflictCount, 0);

  await abortMergeForRoot(root);
  assert.equal((await getMergeState(root)).inProgress, false);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('merge state is read correctly from a linked worktree git directory', async (t) => {
  const root = await createConflictingBranches(t);
  git(root, ['branch', 'worktree-target', 'main']);
  const worktreeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-git-worktree-'));
  t.after(async () => {
    try {
      git(root, ['worktree', 'remove', '--force', worktreeRoot]);
    } catch {}
    await fs.promises.rm(worktreeRoot, { recursive: true, force: true });
  });
  git(root, ['worktree', 'add', '--quiet', worktreeRoot, 'worktree-target']);

  const started = await startMergeForRoot(worktreeRoot, 'feature');
  assert.equal(started.state, 'conflicts');
  const merge = await getMergeState(worktreeRoot);
  assert.equal(merge.inProgress, true);
  assert.equal(merge.targetBranch, 'worktree-target');
  assert.equal(merge.sourceBranch, 'feature');
  assert.deepEqual(merge.conflictFiles, ['shared.txt']);

  await abortMergeForRoot(worktreeRoot);
  assert.equal((await getMergeState(worktreeRoot)).inProgress, false);
  assert.equal(git(worktreeRoot, ['status', '--porcelain']), '');
});
