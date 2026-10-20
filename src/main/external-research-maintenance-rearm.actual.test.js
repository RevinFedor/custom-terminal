'use strict';
// Real RunStore/strict JSON/coordinator/delivery; SC check and physical input
// are controlled ports. Actual SC HTTP/SQLite is exercised in the bridge suite.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { OrchestrationRunStore, classifyAgentSendReceipt } = require('./orchestration-runs');
const { canDeliver } = require('./external-research-operational');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');
const { createOperationalDelivery } = require('./external-research-operational-delivery');
const browser = '10000000-0000-4000-8000-000000000001';

async function fixture(t) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'owned-rearm-')), file = path.join(root, 'runs.json');
  const stores = [], revoked = [];
  const open = () => { const s = new OrchestrationRunStore(file, { onOperationalRevoked: (_r, n) => {
    revoked.push(n.operationKey); return { ok: true };
  } }); stores.push(s); return s; };
  const store = open();
  await store.reserveOrGet({ runId: 'R', runKind: 'external-research', requestFingerprint: 'original-intent',
    sourceTabId: 'source', sourceProjectId: 'P', sourceSessionId: 'S', sourceSendTarget: { toolType: 'codex', sessionId: 'S' },
    notifySource: true, externalResearchJobId: 'noted_R', externalResearchBrowserInstanceId: browser,
    externalResearchIntent: { provider: 'chatgpt', prompt: 'original', options: { mode: 'chat', model: '6', effort: 'xhigh' }, files: [] } });
  let revision = 0;
  const snapshot = (state = 'open') => ({ id: 'noted_R', provider: 'chatgpt', browserInstanceId: browser,
    status: 'running', stage: 'running', execution: { version: 1, controlEpoch: 'epoch', controlRevision: ++revision,
      send: { state: 'accepted', attemptId: 'original-attempt' },
      turn: { quality: 'native', conversationId: 'CID', userMessageId: 'UID' }, reader: null,
      attention: state === null ? null : { version: 2, jobId: 'noted_R', controlEpoch: 'epoch',
        episodeId: 'same-episode', phase: 'observing', reason: 'observation_unavailable',
        updateSeq: revision, wakeSeq: 1, state, audience: ['human', 'source_agent'], wakeModel: true, terminal: false } } });
  await store.applyExternalResearchSnapshot('R', snapshot(null));
  const begin = (s = store, id = 'maintenance-A') => s.transitionResearchMaintenance({ action: 'begin', operationId: id });
  const complete = (s = store, id = 'maintenance-A') => s.transitionResearchMaintenance({ action: 'complete', operationId: id });
  const fresh = async (s = store, value = snapshot()) => {
    const read = await s.captureExternalOperationalRead('R');
    try { return { ...(await s.applyExternalResearchSnapshot('R', value, { operationalRead: read })), value }; }
    finally { s.releaseExternalOperationalRead(read); }
  };
  const proof = (scope, value, patch = {}) => ({ current: true, execution: structuredClone(value.execution),
    check: { version: 1, state: 'complete', checkId: scope.checkId, jobId: scope.jobId, controlEpoch: scope.controlEpoch,
      browserInstanceId: scope.browserInstanceId, startedAt: Date.now(), completedAt: Date.now(),
      controlRevision: value.execution.controlRevision, reader: null, attention: structuredClone(value.execution.attention),
      verdict: value.execution.attention?.state === 'open' ? 'open' : 'healthy', evidence: { kind: 'controlled-check-port' } }, ...patch });
  const notices = async (s = store) => Object.values((await s.getInternal('R')).externalResearchOperational?.notices || {});
  const deliverable = async (s = store) => { const r = await s.getInternal('R'); return (await notices(s)).filter(n => canDeliver(r, n)); };
  const held = async () => { await begin(); await store.applyExternalResearchSnapshot('R', snapshot());
    await store.recordExternalOperationalFailure('R', { phase: 'observing', reason: 'transport_unavailable', code: 'ECONNREFUSED' });
    const old = structuredClone(await notices()); await complete(); return old; };
  t.after(async () => { for (const s of stores) await s.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, file, open, snapshot, begin, complete, fresh, proof, notices, deliverable, held, revoked };
}

test('same episode gets one new post-maintenance notice only after a correlated check; old body and tombstone survive restart', async t => {
  const f = await fixture(t), old = await f.held();
  await f.store.applyExternalResearchSnapshot('R', f.snapshot());
  assert.equal((await f.deliverable()).length, 0, 'a higher ordinary revision is not fresh check evidence');
  const applied = await f.fresh(), scope = applied.rearmCheck;
  assert(scope); assert.equal((await f.deliverable()).length, 0);
  const receipt = f.proof(scope, applied.value);
  await f.store.completeExternalOperationalRearmCheck('R', scope, receipt);
  const allowed = await f.deliverable(); assert.equal(allowed.length, 1); assert(allowed[0].rearm);
  assert.equal(allowed[0].episodeId, 'same-episode'); assert(!old.some(n => n.id === allowed[0].id));
  const restored = f.open(); await restored.completeExternalOperationalRearmCheck('R', scope, receipt);
  assert.deepEqual((await f.deliverable(restored)).map(n => n.id), allowed.map(n => n.id));
  for (const n of old) {
    const actual = (await f.notices(restored)).find(x => x.id === n.id);
    assert.equal(actual.body, n.body); assert.equal(actual.delivery, 'suppressed');
    assert.equal(actual.cancelRevision, n.cancelRevision); assert.equal(actual.cancellationConfirmed, true);
  }
});

test('continuous local outage re-arms once from a new read, without a healthy interlude', async t => {
  const f = await fixture(t); await f.held();
  const failure = { phase: 'observing', reason: 'transport_unavailable', code: 'ECONNREFUSED' };
  await f.store.recordExternalOperationalFailure('R', failure);
  assert.equal((await f.deliverable()).length, 0);
  for (let i = 0; i < 2; i++) {
    const read = await f.store.captureExternalOperationalRead('R');
    await f.store.recordExternalOperationalFailure('R', { ...failure, operationalRead: read });
    f.store.releaseExternalOperationalRead(read);
  }
  const allowed = await f.deliverable(); assert.equal(allowed.length, 1); assert.equal(allowed[0].origin, 'noted');
  assert.equal(allowed[0].rearm.generation, 1);
});

test('an older concurrent successful read cannot erase a later read failure in the same maintenance generation', async t => {
  const f = await fixture(t); await f.held();
  const slow = await f.store.captureExternalOperationalRead('R'), newer = await f.store.captureExternalOperationalRead('R');
  await f.store.markExternalResearchTransportWait('R', { error: 'newer outage', code: 'ECONNREFUSED', operationalRead: newer });
  await f.store.recordExternalOperationalFailure('R', { reason: 'transport_unavailable', code: 'ECONNREFUSED', operationalRead: newer });
  const before = await f.store.getInternal('R');
  await f.store.applyExternalResearchSnapshot('R', f.snapshot(), { operationalRead: slow });
  f.store.releaseExternalOperationalRead(slow); f.store.releaseExternalOperationalRead(newer);
  const after = await f.store.getInternal('R');
  assert.equal(after.externalResearchOperational.local.state, 'open');
  assert.equal(after.externalResearchTransportError, before.externalResearchTransportError);
  assert.equal((await f.deliverable()).filter(n => n.origin === 'noted').length, 1);
});

test('fresh healthy check ends rearm without replay and subsequent new failure uses ordinary wake', async t => {
  const f = await fixture(t); await f.held();
  const first = await f.fresh(f.store, f.snapshot('cleared'));
  await f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, f.proof(first.rearmCheck, first.value));
  assert.equal((await f.deliverable()).length, 0);
  const later = f.snapshot(); later.execution.attention.episodeId = 'later-failure';
  await f.fresh(f.store, later);
  assert.equal((await f.deliverable()).length, 1);
});

for (const change of ['cancel', 'source', 'opt-out', 'maintenance', 'final']) test('late correlated check loses authority after ' + change, async t => {
  const f = await fixture(t); await f.held(); const first = await f.fresh();
  if (change === 'cancel') await f.store.cancel('R');
  if (change === 'source') await f.store.patch('R', { sourceSendTarget: { toolType: 'codex', sessionId: 'OTHER' } });
  if (change === 'opt-out') await f.store.updateSettings({ externalResearchOperationalPrompts: false });
  if (change === 'maintenance') await f.begin(f.store, 'maintenance-B');
  if (change === 'final') await f.store.applyExternalResearchSnapshot('R', { ...f.snapshot('cleared'), status: 'done', result: { text: 'original full result' } });
  await f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, f.proof(first.rearmCheck, first.value));
  assert.equal((await f.deliverable()).length, 0);
});

test('unusable or foreign proof grants no notice; next safe read changes check ID, not the maintenance generation', async t => {
  const f = await fixture(t); await f.held(); const first = await f.fresh();
  const foreign = f.proof(first.rearmCheck, first.value); foreign.check.jobId = 'foreign';
  await f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, foreign);
  assert.equal((await f.deliverable()).length, 0);
  await f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, f.proof(first.rearmCheck, first.value, { current: false }));
  const next = await f.fresh();
  assert.notEqual(next.rearmCheck.checkId, first.rearmCheck.checkId);
  assert.equal(next.rearmCheck.generation, first.rearmCheck.generation);
  await f.store.completeExternalOperationalRearmCheck('R', next.rearmCheck, f.proof(next.rearmCheck, next.value));
  assert.equal((await f.deliverable()).length, 1);
});

test('failed strict completion blocks a read permit until same-generation persistence succeeds', async t => {
  const f = await fixture(t); await f.begin(); await f.store.applyExternalResearchSnapshot('R', f.snapshot());
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => { if (to === f.file) throw Object.assign(Error('owned EIO'), { code: 'EIO' }); return rename(from, to); };
  try { await assert.rejects(f.complete(), /owned EIO/); await assert.rejects(f.store.captureExternalOperationalRead('R'), /owned EIO/); }
  finally { fs.promises.rename = rename; }
  const generation = (await f.store.getInternal('R')).externalResearchOperationalRearm.generation;
  await f.complete(); const next = await f.fresh(); assert.equal(next.rearmCheck.generation, generation);
});

test('malformed attention cannot consume the fresh-check right or publish a partial operational notice', async t => {
  const f = await fixture(t); await f.held(); const first = await f.fresh();
  const invalid = f.proof(first.rearmCheck, first.value);
  delete invalid.execution.attention.controlEpoch; delete invalid.check.attention.controlEpoch;
  await f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, invalid);
  const r = (await f.store.getInternal('R')).externalResearchOperationalRearm;
  assert.equal(r.lanes.sc.state, 'awaiting_fresh');
  assert.equal(r.checks[first.rearmCheck.checkId].state, 'complete-unusable');
  assert.equal((await f.deliverable()).length, 0);
  const next = await f.fresh(); assert.notEqual(next.rearmCheck.checkId, first.rearmCheck.checkId);
});

test('cloned and prior-process read scopes cannot certify local transport freshness', async t => {
  const f = await fixture(t); await f.held(); const read = await f.store.captureExternalOperationalRead('R');
  const failure = { reason: 'transport_unavailable', code: 'ECONNREFUSED' };
  await f.store.recordExternalOperationalFailure('R', { ...failure, operationalRead: { ...read } });
  assert.equal((await f.deliverable()).length, 0);
  const restored = f.open(); await restored.recordExternalOperationalFailure('R', { ...failure, operationalRead: read });
  assert.equal((await f.deliverable(restored)).length, 0); f.store.releaseExternalOperationalRead(read);
});

test('failed correlated receipt commit never reaches source input; the identical receipt commits and delivers once after recovery', async t => {
  const f = await fixture(t); await f.held(); const first = await f.fresh();
  const proof = f.proof(first.rearmCheck, first.value), sent = [], receipts = new Map();
  const service = createOperationalDelivery({ store: f.store, classify: classifyAgentSendReceipt, logger: { warn() {} }, pin() {},
    prepare: async (_r, n) => ({ prompt: n.body, sendOptions: { provider: 'codex', queue: true, statusAtSend: 'idle' } }),
    lookup: async n => ({ result: receipts.get(n.operationKey) || null }),
    send: async request => { sent.push(request); const result = { success: true, submitted: true, receiptState: 'confirmed',
      operationKey: request.sendOperationKey, attemptId: 'one-controlled-input' }; receipts.set(request.sendOperationKey, result); return result; } });
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => { if (to === f.file) throw Object.assign(Error('receipt commit EIO'), { code: 'EIO' }); return rename(from, to); };
  try {
    await assert.rejects(f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, proof), /receipt commit EIO/);
    service.schedule('R'); await service.drain(); assert.equal(sent.length, 0);
  } finally { fs.promises.rename = rename; }
  const original = (await f.notices()).find(n => n.rearm);
  await f.store.completeExternalOperationalRearmCheck('R', first.rearmCheck, proof);
  service.schedule('R'); await service.drain(); service.stop();
  assert.equal(sent.length, 1); assert.equal(sent[0].handoffId, original.handoffId);
  assert.equal((await f.notices()).filter(n => n.rearm).length, 1);
});

test('fresh read order remains usable after JSON restart and a new maintenance generation', async t => {
  const f = await fixture(t); await f.held();
  for (let i = 0; i < 3; i++) await f.fresh();
  const restored = f.open(), read = await restored.captureExternalOperationalRead('R');
  await restored.recordExternalOperationalFailure('R', { reason: 'transport_unavailable', code: 'ECONNREFUSED', operationalRead: read });
  restored.releaseExternalOperationalRead(read);
  assert.equal((await restored.getInternal('R')).externalResearchOperational.local.state, 'open');
  await f.begin(restored, 'maintenance-B'); await f.complete(restored, 'maintenance-B');
  const next = await f.fresh(restored);
  assert.equal(next.rearmCheck.generation, 2);
  await restored.completeExternalOperationalRearmCheck('R', next.rearmCheck, f.proof(next.rearmCheck, next.value));
  assert.equal((await f.deliverable(restored)).length, 1);
});

test('unavailable correlated checker produces one durable compatibility incident, never a provider terminal or repeated wake', async t => {
  const f = await fixture(t); await f.held();
  for (let i = 0; i < 3; i++) {
    const first = await f.fresh();
    await f.store.recordExternalOperationalRearmFailure('R', first.rearmCheck, { code: 'sc_research_operational_recheck_unavailable' });
  }
  const allowed = await f.deliverable(); assert.equal(allowed.length, 1); assert.equal(allowed[0].origin, 'noted-recheck');
  assert.equal((await f.store.getInternal('R')).status, 'running');
});

test('actual coordinator calls the correlated check and dispatches one notice to the unchanged source', { timeout: 4000 }, async t => {
  const f = await fixture(t); await f.held(); const value = f.snapshot();
  const sent = [], receipts = new Map(); let checks = 0, reads = 0, coordinator;
  const delivery = createOperationalDelivery({ store: f.store, classify: classifyAgentSendReceipt, logger: { warn() {} }, pin() {},
    prepare: async (_run, n) => ({ prompt: n.body, sendOptions: { provider: 'codex', queue: true, statusAtSend: 'idle' } }),
    lookup: async n => ({ result: receipts.get(n.operationKey) || null }),
    send: async request => { sent.push(request); const receipt = { success: true, submitted: true, receiptState: 'confirmed',
      operationKey: request.sendOperationKey, attemptId: 'controlled-source-input' }; receipts.set(request.sendOperationKey, receipt); return receipt; } });
  coordinator = new ExternalResearchCoordinator({ store: f.store, logger: { warn() {} }, longPollMs: 0,
    client: { status: async () => { reads++; return value; }, start: () => assert.fail('no new research'),
      operationalRecheck: async (_id, scope) => { checks++; return f.proof({ ...scope, jobId: 'noted_R' }, value); } },
    notifyOperational: id => { delivery.schedule(id); void coordinator.stop(); } });
  try { await coordinator.watch('R'); await delivery.drain(); }
  finally { await coordinator.stop(); delivery.stop(); }
  assert.equal(reads, 1); assert.equal(checks, 1); assert.equal(sent.length, 1);
  assert.equal(sent[0].tabId, 'source'); assert.deepEqual(sent[0].expectedTarget, { toolType: 'codex', sessionId: 'S' });
  assert.equal(f.store.externalOperationalReadScopes.size, 0);
});
