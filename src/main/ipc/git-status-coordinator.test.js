const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGitStatusCoordinator } = require('./git-status-coordinator');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('45 same-path callers share root lookup and one status bundle', async () => {
  const rootGate = deferred();
  const statusGate = deferred();
  let rootCalls = 0;
  let statusCalls = 0;
  const coordinator = createGitStatusCoordinator({
    resolveRoot: async () => { rootCalls += 1; return rootGate.promise; },
    readStatus: async () => { statusCalls += 1; return statusGate.promise; },
  });

  const requests = Array.from({ length: 45 }, () => coordinator.request('/repo/subdir'));
  await turn();
  assert.equal(rootCalls, 1);
  rootGate.resolve('/repo');
  await turn();
  assert.equal(statusCalls, 1);
  const snapshot = { isRepo: true, repoRoot: '/repo', changedCount: 3 };
  statusGate.resolve(snapshot);
  const results = await Promise.all(requests);
  assert.ok(results.every((result) => result === snapshot));
});

test('different subdirectories resolving to one root still share one bundle', async () => {
  const statusGate = deferred();
  let statusCalls = 0;
  const coordinator = createGitStatusCoordinator({
    resolveRoot: async () => '/repo',
    readStatus: async () => { statusCalls += 1; return statusGate.promise; },
  });
  const requests = Array.from(
    { length: 45 },
    (_, index) => coordinator.request(`/repo/subdir-${index}`),
  );
  await turn();
  assert.equal(statusCalls, 1);
  statusGate.resolve({ repoRoot: '/repo' });
  await Promise.all(requests);
});

test('summary callers coalesce together but never consume an overlapping full result', async () => {
  const gates = { summary: deferred(), full: deferred() };
  const calls = [];
  const coordinator = createGitStatusCoordinator({
    resolveRoot: async () => '/repo',
    readStatus: async (_root, detail) => {
      calls.push(detail);
      return gates[detail].promise;
    },
  });
  const summaryA = coordinator.request('/repo/a', 'summary');
  const summaryB = coordinator.request('/repo/b', 'summary');
  const full = coordinator.request('/repo', 'full');
  await turn();
  assert.deepEqual(calls.sort(), ['full', 'summary']);
  gates.summary.resolve({ detail: 'summary' });
  gates.full.resolve({ detail: 'full' });
  assert.equal((await summaryA).detail, 'summary');
  assert.equal((await summaryB).detail, 'summary');
  assert.equal((await full).detail, 'full');
});

test('45 distinct roots never run more than two status bundles at once', async () => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  const releases = [];
  const coordinator = createGitStatusCoordinator({
    maxConcurrentRoots: 2,
    resolveRoot: async (projectPath) => projectPath,
    readStatus: async (root) => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      releases.push(() => {
        active -= 1;
        gate.resolve({ repoRoot: root });
      });
      return gate.promise;
    },
  });
  const all = Array.from({ length: 45 }, (_, index) => coordinator.request(`/repo-${index}`));
  while (started < 45) {
    await turn();
    const ready = releases.splice(0);
    for (const release of ready) release();
  }
  for (const release of releases.splice(0)) release();
  await Promise.all(all);
  assert.equal(maxActive, 2);
});

test('joined failure is not cached and the next request retries', async () => {
  let calls = 0;
  const firstGate = deferred();
  const coordinator = createGitStatusCoordinator({
    resolveRoot: async () => '/repo',
    readStatus: async () => {
      calls += 1;
      if (calls === 1) return firstGate.promise;
      return { repoRoot: '/repo', changedCount: 0 };
    },
  });
  const first = coordinator.request('/repo');
  const joined = coordinator.request('/repo');
  await turn();
  firstGate.reject(new Error('git failed'));
  await assert.rejects(first, /git failed/);
  await assert.rejects(joined, /git failed/);
  const retried = await coordinator.request('/repo');
  assert.equal(calls, 2);
  assert.equal(retried.changedCount, 0);
});

test('non-repository result remains null and is not cached', async () => {
  let rootCalls = 0;
  const coordinator = createGitStatusCoordinator({
    resolveRoot: async () => { rootCalls += 1; return null; },
    readStatus: async () => { throw new Error('must not run'); },
  });
  assert.equal(await coordinator.request('/not-a-repo'), null);
  assert.equal(await coordinator.request('/not-a-repo'), null);
  assert.equal(rootCalls, 2, 'no completed-result TTL/cache changes freshness semantics');
});

test('git:status IPC is wired through the coordinator', () => {
  const source = fs.readFileSync(path.join(__dirname, 'git.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('git:status'");
  const end = source.indexOf("ipcMain.handle('git:history'", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.match(handler, /gitStatusCoordinator\.request\([\s\S]{0,100}detail === 'summary' \? 'summary' : 'full'/);
  assert.doesNotMatch(handler, /getStatusForRoot\(/);
});

test('summary status runs one git command and skips panel-only metadata', () => {
  const source = fs.readFileSync(path.join(__dirname, 'git.js'), 'utf8');
  assert.match(source, /readStatus: \(root, detail\) => getStatusForRoot\(root, detail\)/);
  const start = source.indexOf('async function getStatusForRoot');
  const fullStart = source.indexOf('const [statusResult, remoteResult', start);
  const summary = source.slice(start, fullStart);
  assert.match(summary, /detail === 'summary'/);
  assert.equal((summary.match(/runGit\(/g) || []).length, 1);
  assert.match(summary, /summaryOnly: true/);
  assert.match(summary, /files: \[\]/);
  assert.match(summary, /parseStatusSummary/);
  assert.doesNotMatch(summary, /credential\.helper|getMergeState|remote\.origin\.url/);
});
