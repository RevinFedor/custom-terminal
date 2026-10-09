'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OrchestrationRunStore, buildOrchestrationResultLookup,
  shouldScheduleCreatedTargetAutoStop, hasNewerTargetRun } = require('./orchestration-runs');
const { RESPONSE_OBSERVATION_KIND, responseObservationRequestIdentity,
  normalizeResponseSubject } = require('./orchestration-response-observation');

const subject = () => ({ toolType: 'codex', sessionId: 'target-session', promptUserUuid: 'current-prompt',
  targetExecutionContext: { provider: 'codex', sessionId: 'target-session', turnId: 'current-turn',
    generation: 7, processId: null, startedAt: 1000 }, requestedAt: 1000 });
const observation = (runId, sourceTabId = 'source', targetTabId = 'target') => ({
  runId, runKind: RESPONSE_OBSERVATION_KIND, sourceTabId, targetTabId,
  targetToolType: 'codex', ...responseObservationRequestIdentity({ sourceTabId, targetTabId }),
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'noted-response-observation-'));
  const filePath = path.join(dir, 'runs.json');
  const store = new OrchestrationRunStore(filePath);
  const stores = [store];
  await store.initialize();
  t.after(async () => {
    await Promise.all(stores.map(item => item.flush()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { store, filePath, stores };
}

test('observing a busy target neither claims its delivery lane nor changes another run', async t => {
  const { store } = await fixture(t);
  await store.create({ runId: 'existing-task', sourceTabId: 'parent', targetTabId: 'target' });
  const reserved = await store.reserveOrGet(observation('watch'));
  assert.equal(reserved.run.runKind, RESPONSE_OBSERVATION_KIND);
  assert.equal(reserved.run.predecessorRunId, null);
  assert.equal(reserved.run.autoStopCreatedTargets, false);
  assert.equal(reserved.run.targetCreatedByOrchestration, false);
  await store.bindResponseObservationSubject('watch', subject());
  assert.equal((await store.get('watch')).status, 'running');
  const following = await store.create({ runId: 'next-task', sourceTabId: 'parent', targetTabId: 'target' });
  assert.equal(following.predecessorRunId, 'existing-task');
  assert.equal(buildOrchestrationResultLookup(await store.getInternal('watch')).promptUserUuid, 'current-prompt');
  assert.equal(shouldScheduleCreatedTargetAutoStop(await store.getInternal('watch')), false);
  const unrelatedChild = await store.create({ runId: 'target-child', sourceTabId: 'target', targetTabId: 'another',
    sourceExecutionContext: subject().targetExecutionContext });
  assert.equal(unrelatedChild.parentRunId, null);
  await assert.rejects(store.create({ runId: 'invalid-child', sourceTabId: 'target', targetTabId: 'another',
    parentRunId: 'watch' }), /observation cannot own/);
});

test('two observers persist independently and cannot be completed by a generic target event', async t => {
  const { store, filePath, stores } = await fixture(t);
  for (const id of ['one', 'two']) {
    await store.reserveOrGet(observation(id, 'source-' + id));
    await store.bindResponseObservationSubject(id, subject());
  }
  const done = await store.applyLifecycle('target', { type: 'done', reason: 'task_complete',
    sessionId: 'target-session', executionContext: subject().targetExecutionContext });
  assert.equal(done.settled.length, 0);
  assert.equal((await store.get('one')).status, 'running');
  await store.persistStrict();
  const restored = new OrchestrationRunStore(filePath);
  stores.push(restored);
  await restored.initialize();
  for (const id of ['one', 'two']) {
    const run = await restored.getInternal(id);
    assert.deepEqual(run.observationSubject, normalizeResponseSubject(subject()));
    assert.equal(run.deliveryIntent, undefined);
    assert.equal(run.targetPromptProofAt, undefined);
  }
});

test('same request retry keeps the captured subject and changed wait scope conflicts', async t => {
  const { store } = await fixture(t);
  const input = observation('watch');
  await store.reserveOrGet(input);
  await store.bindResponseObservationSubject('watch', subject());
  const retry = await store.reserveOrGet(input);
  assert.equal(retry.created, false);
  assert.equal(retry.conflict, false);
  assert.equal((await store.getInternal('watch')).observationSubject.promptUserUuid, 'current-prompt');
  const conflict = await store.reserveOrGet({ ...input,
    ...responseObservationRequestIdentity({ sourceTabId: 'source', targetTabId: 'target', waitForDescendants: false }) });
  assert.equal(conflict.conflict, true);
});

test('reciprocal waits are rejected without replacing the first subscription', async t => {
  const { store } = await fixture(t);
  await store.reserveOrGet(observation('a-to-b', 'a', 'b'));
  await assert.rejects(store.reserveOrGet(observation('b-to-a', 'b', 'a')), { code: 'response_observation_cycle' });
  assert.equal((await store.listAll()).length, 1);
});

test('a read subscription requires an exact prompt, never a hash or timestamp alone', () => {
  assert.throws(() => normalizeResponseSubject({ toolType: 'codex', sessionId: 's', requestedAt: 1000,
    promptHash: 'same-text' }), { code: 'response_subject_unresolved' });
  assert.throws(() => normalizeResponseSubject({ ...subject(), sessionId: 'foreign' }), {
    code: 'response_subject_identity_conflict',
  });
  assert.throws(() => responseObservationRequestIdentity({ sourceTabId: 'same', targetTabId: 'same' }), {
    code: 'response_observation_target_invalid',
  });
});

test('historical Codex observation preserves the proven physical COW execution separately from its view', () => {
  const historical = { kind: 'codex-historical-execution', toolType: 'codex', sessionId: 'child-view',
    targetExecutionContext: { provider: 'codex', sessionId: 'parent-physical', turnId: 'parent-turn',
      generation: null, processId: null, startedAt: 1000 } };
  const normalized = normalizeResponseSubject(historical);
  assert.equal(normalized.sessionId, 'child-view');
  assert.equal(normalized.targetExecutionContext.sessionId, 'parent-physical');
  assert.equal(normalized.targetExecutionContext.generation, null);
  assert.throws(() => normalizeResponseSubject({ ...historical, targetExecutionContext: {
    ...historical.targetExecutionContext, generation: 12,
  } }), { code: 'response_subject_unresolved' });
  assert.throws(() => normalizeResponseSubject({ ...historical, targetExecutionContext: {
    ...historical.targetExecutionContext, processId: 123,
  } }), { code: 'response_subject_unresolved' });
});

test('a passive observer is not newer target execution for an existing auto-stop', () => {
  const scheduled = { runId: 'owned-task', targetTabId: 'target', completedAt: 1000 };
  for (const status of ['running', 'completed', 'failed', 'cancelled']) {
    const observed = { ...observation('watch'), status, startedAt: 1100, ownCompletedAt: 1200 };
    assert.equal(hasNewerTargetRun([scheduled, observed], scheduled), false);
    assert.equal(hasNewerTargetRun([scheduled, { ...observed, runKind: 'agent' }], scheduled), true);
  }
});
