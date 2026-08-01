'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runKeyedExclusive } = require('./codex-writer-ownership');
const { OrchestrationRunStore } = require('./orchestration-runs');

async function fixture() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'noted-lifecycle-race-'));
  const store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  const now = Date.now();
  await store.create({
    runId: 'run-1',
    sourceTabId: 'source-1',
    sourceProjectId: 'project-a',
    targetTabId: 'target-1',
    targetProjectId: 'project-a',
    targetCreated: true,
    promptHash: 'hash-1',
    targetPromptAuditHash: 'audit-1',
    promptChars: 6,
  });
  await store.patch('run-1', {
    status: 'completed',
    resultComplete: true,
    completedAt: now - 1_000,
    autoStopAt: now - 500,
    autoStopStatus: 'scheduled',
  });
  return {
    store,
    cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }),
  };
}

const absentIdentity = {
  terminalLifecycleGeneration: 'terminal:2',
  terminalRunSeq: 2,
  inputRevision: 4,
  processStatus: 'absent',
};

test('AutoResume queued first is suppressed before the due auto-stop settles', async () => {
  const { store, cleanup } = await fixture();
  try {
    const queue = new Map();
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const restore = runKeyedExclusive(queue, 'target-1', async () => {
      await barrier;
      return store.admitAgentLaunch('target-1', { launchSource: 'auto-resume' });
    });
    const stop = runKeyedExclusive(queue, 'target-1', async () => {
      const claim = await store.claimDueAutoStop('run-1', {
        expectedTargetIdentity: absentIdentity,
      });
      assert.equal(claim.claimed, true);
      return store.settleAutoStopClaim('run-1', claim.claimId, {
        status: 'stopped-no-process',
      });
    });
    release();
    assert.equal((await restore).suppressed, true);
    assert.equal((await stop).settled, true);
    assert.equal((await store.get('run-1')).autoStopStatus, 'stopped-no-process');
  } finally {
    await cleanup();
  }
});

test('explicit Continue queued first supersedes the old auto-stop and launches once', async () => {
  const { store, cleanup } = await fixture();
  try {
    const queue = new Map();
    let launches = 0;
    const explicit = runKeyedExclusive(queue, 'target-1', async () => {
      const admission = await store.admitAgentLaunch('target-1', { launchSource: 'explicit' });
      if (admission.allowed) launches += 1;
      return admission;
    });
    const stop = runKeyedExclusive(queue, 'target-1', () => store.claimDueAutoStop('run-1', {
      expectedTargetIdentity: absentIdentity,
    }));
    assert.equal((await explicit).allowed, true);
    assert.equal((await stop).claimed, false);
    assert.equal(launches, 1);
    assert.equal((await store.get('run-1')).autoStopStatus, 'skipped-target-changed');
  } finally {
    await cleanup();
  }
});

test('auto-stop queued first settles, then explicit Continue launches exactly once', async () => {
  const { store, cleanup } = await fixture();
  try {
    const queue = new Map();
    let launches = 0;
    const stop = runKeyedExclusive(queue, 'target-1', async () => {
      const claim = await store.claimDueAutoStop('run-1', {
        expectedTargetIdentity: absentIdentity,
      });
      return store.settleAutoStopClaim('run-1', claim.claimId, {
        status: 'stopped-no-process',
      });
    });
    const explicit = runKeyedExclusive(queue, 'target-1', async () => {
      const admission = await store.admitAgentLaunch('target-1', { launchSource: 'explicit' });
      if (admission.allowed) launches += 1;
      return admission;
    });
    assert.equal((await stop).settled, true);
    assert.equal((await explicit).allowed, true);
    assert.equal(launches, 1);
  } finally {
    await cleanup();
  }
});
