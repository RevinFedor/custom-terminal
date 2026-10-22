'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OrchestrationRunStore, mergeActiveLoadersWithOrchestrations } = require('./orchestration-runs');
const { createBuildInstallEligibility } = require('./build-install-eligibility');
const { externalResearchRequestFingerprint, externalResearchJobId } = require('./external-research-request');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.INSTALL_TEST_ROOT || os.tmpdir(), 'install-eligibility-'));
  let store = new OrchestrationRunStore(path.join(dir, 'runs.json'));
  t.after(async () => { await store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = { provider: 'chatgpt', prompt: 'existing research', options: { mode: 'chat' }, files: [] };
  const input = { runId: 'original', runKind: 'external-research', sourceTabId: 'source',
    sourceProjectId: 'P', sourceToolType: 'codex', sourceSessionId: 'S',
    sourceSendTarget: { toolType: 'codex', sessionId: 'S' }, notifySource: true,
    externalResearchJobId: externalResearchJobId('original'), externalResearchIntent: request,
    requestFingerprint: externalResearchRequestFingerprint({ runId: 'original', sourceTabId: 'source', request }) };
  await store.reserveOrGet(input);
  await store.patch('original', { status: 'running' });
  let loaders = [], physical = [];
  return { dir, store, input,
    runtime: value => { loaders = value; }, physical: value => { physical = value; },
    read: () => createBuildInstallEligibility({ store,
      readRuntime: () => ({ idle: loaders.length === 0, loaders }), readInput: () => physical })(),
    restore: async () => {
      await store.flush(); store = new OrchestrationRunStore(path.join(dir, 'runs.json')); await store.initialize();
      return store;
    },
  };
}

test('OLDRED inherited wait remains in general activity; strict install projection is GREEN without cancelling Research', async t => {
  const h = await fixture(t);
  const old = mergeActiveLoadersWithOrchestrations({ idle: true, loaders: [] }, await h.store.listActive());
  assert.equal(old.idle, false); assert.equal(old.loaders[0].status, 'inherited-busy');
  console.log('OLDRED: actual active-loaders projection blocks on inherited-busy');
  const green = await h.read(); assert.equal(green.eligible, true);
  assert.deepEqual(green.preservedExternalWaits.map(r => [r.runId, r.jobId, r.sourceTarget.sessionId]), [['original', 'noted_original', 'S']]);
  const restored = await h.restore(); const run = await restored.getInternal('original');
  assert.equal(run.status, 'running'); assert.deepEqual(run.externalResearchIntent, h.input.externalResearchIntent);
  assert.equal(run.notificationSuppressed, undefined);
  console.log('GREEN: same durable job/intent/source retained; UI busy unchanged');
});

test('same source real model/preparation/input/unknown and a second local child still block', async t => {
  const h = await fixture(t);
  for (const kind of ['codex', 'claude', 'gemini', 'restart-after']) {
    h.runtime([{ tabId: 'source', kind, status: 'busy' }]); assert.equal((await h.read()).eligible, false);
  }
  h.runtime([]);
  for (const status of ['preparing', 'physical-input', 'delivery-unknown', 'runtime-unknown']) {
    h.physical([{ tabId: 'source', kind: 'input', status }]); assert.equal((await h.read()).eligible, false);
  }
  h.physical([]);
  await h.store.reserveOrGet({ runId: 'local-child', sourceTabId: 'source', targetTabId: 'child', notifySource: true });
  await h.store.patch('local-child', { status: 'running' });
  assert.equal((await h.read()).eligible, false);
});

test('a supplied preservation flag, missing identity, altered intent and local completion UNKNOWN grant no exemption', async t => {
  const h = await fixture(t);
  for (const patch of [{ requestFingerprint: 'fake', preserved: true },
    { externalResearchJobId: 'different' }, { sourceSendTarget: { toolType: 'codex', sessionId: null } },
    { notificationStatus: 'unconfirmed' }, { notificationAttemptedAt: 12 }]) {
    const run = await h.store.getInternal('original');
    const before = Object.fromEntries(Object.keys(patch).map(key => [key, run[key]]));
    await h.store.patch('original', patch); assert.equal((await h.read()).eligible, false);
    await h.store.patch('original', before);
  }
});

test('store write failure and changing snapshot never become eligible', async t => {
  const h = await fixture(t), persist = h.store.persistStrict.bind(h.store);
  h.store.runs.get('original').label = 'uncommitted RAM intent';
  h.store.persistStrict = async () => { throw new Error('fixture:EIO'); };
  await assert.rejects(h.read, /EIO/);
  h.store.persistStrict = async () => { await persist(); h.store.runs.get('original').notificationStatus = 'unconfirmed'; };
  await assert.rejects(h.read, /install_run_state_changed/);
  h.store.persistStrict = persist;
});

test('unchanged strictly committed external wait does not rewrite the full RunStore on every observer read', async t => {
  const h = await fixture(t); await h.read();
  const epoch = h.store.installPersistEpoch;
  await h.read(); await h.read();
  assert.equal(h.store.installPersistEpoch, epoch, 'read-only observation reuses only the exact successful writer receipt');
});

test('final committed during preparation retains result identity and future delivery through restore, with no provider start', async t => {
  const h = await fixture(t);
  assert.equal((await h.read()).eligible, true);
  const text = 'Original final bytes\nюникод\n';
  await h.store.applyExternalResearchSnapshot('original', { id: 'noted_original', status: 'done', provider: 'chatgpt',
    result: { text }, conversationUrl: 'https://chatgpt.com/c/existing' });
  await h.read();
  const restored = await h.restore(), run = await restored.getInternal('original');
  // SC owns the bytes; RunStore retains its exact job and summary, not a
  // second fabricated result copy. Actual delivery has its own regression.
  assert.equal(run.externalResearchResultSummary.textChars, text.length); assert.equal(run.resultComplete, true);
  assert.equal(run.externalResearchJobId, 'noted_original');
  assert.equal(run.sourceSendTarget.sessionId, 'S');
  assert.notEqual(run.notificationSuppressed, true);
  assert.equal(run.externalResearchDelivery.request, null);
});
