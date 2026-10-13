import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mergeOrchestrationRuns } from '../renderer/utils/orchestrationRunProjection.mjs';
const require = createRequire(import.meta.url);
const { OrchestrationRunStore } = require('./orchestration-runs');
const { promptFingerprint } = require('./claude-prompt-carriers');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');

async function fixture(t, withParent = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-source-clock-'));
  const file = path.join(dir, 'runs.json');
  const store = new OrchestrationRunStore(file);
  t.after(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const text = 'Exact Research answer';
  const at = Date.now() - 10_000;
  if (withParent) {
    await store.create({ runId: 'parent', sourceTabId: 'ancestor', targetTabId: 'source',
      targetToolType: 'codex', targetExecutionContext: { provider: 'codex', sessionId: 'SID',
        turnId: 'old', generation: 1, startedAt: at - 1000 } });
    await store.patch('parent', { status: 'waiting_descendants', outcome: 'success', ownCompletedAt: at - 500 });
  }
  await store.create({ runId: 'research', runKind: 'external-research', sourceTabId: 'source',
    externalResearchJobId: 'noted_research', sourceToolType: 'codex',
    sourceSendTarget: { toolType: 'codex', sessionId: 'SID' }, ...(withParent ? { parentRunId: 'parent' } : {}) });
  await store.patch('research', { status: 'completed', outcome: 'success', resultComplete: true,
    notificationStatus: 'queued', notificationSourceSessionId: 'SID',
    notificationAttemptedAt: at - 100, notificationHandoffId: 'orchestration-complete:research',
    notificationPromptHash: promptFingerprint(text), notificationPromptAuditHash: promptAuditFingerprint(text) });
  const proof = { kind: 'prompt-audit', sourceTabId: 'source', source: 'orchestration-completion:research',
    handoffId: 'orchestration-complete:research', sessionId: 'SID', toolType: 'codex',
    userUuid: 'exact-user', sourceIdentity: 'exact-source', actualHash: promptAuditFingerprint(text),
    expectedHash: promptAuditFingerprint(text), auditTimestamp: new Date(at).toISOString(),
    executionContext: { provider: 'codex', sessionId: 'SID', turnId: 'new', generation: 2, startedAt: at },
    queuedAtSubmit: true };
  return { store, file, proof, at };
}

test('old audit time cannot make source delivery confirmation older than its queued presentation', async t => {
  const h = await fixture(t);
  const queued = await h.store.get('research');
  assert.equal(queued.sourceFollowupPending, true);
  const confirmed = await h.store.confirmSourceFollowup('research', h.proof);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.run.sourceFollowupStartedAt, h.at, 'historical provider time stays exact');
  assert.ok(confirmed.run.updatedAt > queued.updatedAt, 'publication must advance instead of backdating');
  const [projected] = mergeOrchestrationRuns([queued], confirmed.changed);
  assert.equal(projected.notificationStatus, 'sent');
  assert.equal(projected.sourceFollowupPending, false);
  const [hydrated] = mergeOrchestrationRuns(confirmed.changed, [queued]);
  assert.equal(hydrated.notificationStatus, 'sent', 'late queued list cannot restore the grey chip');
  await h.store.flush();
  const reopened = new OrchestrationRunStore(h.file);
  const restored = await reopened.get('research');
  assert.equal(restored.updatedAt, confirmed.run.updatedAt);
  assert.equal(restored.sourceFollowupStartedAt, h.at);
  await reopened.flush();
});

test('causal parent snapshots also publish forward without changing their exact new execution time', async t => {
  const h = await fixture(t, true);
  const parent = await h.store.get('parent');
  const confirmed = await h.store.confirmSourceFollowup('research', h.proof);
  assert.equal(confirmed.confirmed, true);
  const advanced = confirmed.changed.find(run => run.runId === 'parent');
  assert.ok(advanced.updatedAt > parent.updatedAt);
  assert.equal(advanced.targetExecutionContext.startedAt, h.at);
  const [projected] = mergeOrchestrationRuns([parent], [advanced]);
  assert.equal(projected.status, 'running');
  assert.equal(projected.targetExecutionContext.turnId, 'new');
});
