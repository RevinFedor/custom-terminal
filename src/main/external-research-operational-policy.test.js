'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { OrchestrationRunStore, classifyAgentSendReceipt } = require('./orchestration-runs');
const { canDeliver } = require('./external-research-operational');
const { createOperationalDelivery } = require('./external-research-operational-delivery');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');

async function fixture(t, enabled) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'operational-policy-')), file = path.join(root, 'runs.json');
  const revoked = [], opts = { onOperationalRevoked: (_run, notice) => { revoked.push(notice.operationKey); return { ok: true }; } };
  const store = new OrchestrationRunStore(file, opts);
  if (typeof enabled === 'boolean') await store.updateSettings({ externalResearchOperationalPrompts: enabled });
  await store.reserveOrGet({ runId: 'R', runKind: 'external-research', requestFingerprint: 'same-intent',
    sourceTabId: 'source', sourceSessionId: 'session', sourceSendTarget: { toolType: 'codex', sessionId: 'session' },
    notifySource: true, externalResearchJobId: 'noted_R',
    externalResearchIntent: { provider: 'chatgpt', prompt: 'original', options: {}, files: [] } });
  const snapshot = { id: 'noted_R', provider: 'chatgpt', browserInstanceId: '10000000-0000-4000-8000-000000000001',
    status: 'running', stage: 'running', execution: { version: 1, controlEpoch: 'same-epoch', controlRevision: 1,
      send: { state: 'accepted' }, turn: { quality: 'native', conversationId: 'same-cid', userMessageId: 'same-user' },
      attention: { version: 2, jobId: 'noted_R', controlEpoch: 'same-epoch', episodeId: 'same-episode',
        phase: 'observing', reason: 'observation_unavailable', updateSeq: 1, wakeSeq: 1, state: 'open',
        audience: ['human', 'source_agent'], wakeModel: true, terminal: false } } };
  t.after(async () => { await store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  const delivery = overrides => createOperationalDelivery({ store, classify: classifyAgentSendReceipt,
    logger: { warn() {} }, prepare: () => assert.fail('disabled policy must not prepare model input'),
    pin: () => assert.fail('disabled policy must not reserve input'),
    lookup: async () => ({ absentBeforeAdmission: false }),
    send: () => assert.fail('disabled policy must not write model input'), ...overrides });
  return { store, file, snapshot, revoked, delivery, reopen: () => new OrchestrationRunStore(file, opts) };
}

test('ordinary research wakes its exact source by default, once per episode across restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.store.getSettings()).externalResearchOperationalPrompts, true);
  await f.store.applyExternalResearchSnapshot('R', f.snapshot);
  const before = await f.store.getInternal('R');
  const notice = Object.values(before.externalResearchOperational.notices)[0];
  assert.equal(notice.delivery, 'pending'); assert.equal(canDeliver(before, notice), true);
  const sent = [], receipts = new Map();
  const dispatch = store => createOperationalDelivery({ store, classify: classifyAgentSendReceipt,
    logger: { warn() {} },
    prepare: async (_run, n) => ({ prompt: n.body,
      sendOptions: { provider: 'codex', queue: true, statusAtSend: 'busy' } }),
    pin() {}, lookup: async n => ({ result: receipts.get(n.operationKey) || null, absentBeforeAdmission: false }),
    send: async request => {
      sent.push(request);
      const receipt = { success: true, submitted: true, receiptState: 'confirmed',
        operationKey: request.sendOperationKey, attemptId: 'source-wake-only' };
      receipts.set(request.sendOperationKey, receipt); return receipt;
    } });
  const first = dispatch(f.store); first.schedule('R'); await first.drain(); first.stop();
  assert.equal(sent.length, 1); assert.equal(sent[0].tabId, 'source');
  assert.deepEqual(sent[0].expectedTarget, { toolType: 'codex', sessionId: 'session' });
  assert.match(sent[0].prompt, /"sendState":"accepted"/);
  const restored = f.reopen();
  assert.equal((await restored.getSettings()).externalResearchOperationalPrompts, true);
  await restored.applyExternalResearchSnapshot('R', f.snapshot);
  const second = dispatch(restored); second.schedule('R'); await second.drain(); second.stop();
  assert.equal(sent.length, 1, 'restoring the same incident cannot enqueue another source wake');
  const after = await restored.getInternal('R');
  assert.equal(after.externalResearchOperational.notices[notice.id].delivery, 'sent');
  for (const key of ['requestFingerprint', 'externalResearchJobId', 'externalResearchIntent', 'sourceSessionId']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.equal(after.resultComplete, false); assert.equal(after.sourceFollowupStartedAt, null);
  await restored.flush();
});

test('explicitly disabled policy records incidents without a source-model prompt, including restart', async t => {
  const f = await fixture(t, false);
  assert.equal((await f.store.getSettings()).externalResearchOperationalPrompts, false);
  await f.store.applyExternalResearchSnapshot('R', f.snapshot);
  await f.store.recordExternalOperationalFailure('R', { reason: 'transport_unavailable', code: 'ECONNREFUSED' });
  const d = f.delivery(); d.schedule('R'); await d.drain(); d.stop();
  const run = await f.store.getInternal('R');
  assert.equal(run.notifySource, true); assert.equal(run.notificationSuppressed, undefined);
  assert.equal(run.externalResearchOperational.sc.latestAttention.state, 'open');
  assert.equal(run.externalResearchOperational.local.state, 'open');
  assert.equal(Object.keys(run.externalResearchOperational.notices).length, 2);
  for (const n of Object.values(run.externalResearchOperational.notices)) {
    assert.equal(n.delivery, 'suppressed'); assert.equal(canDeliver(run, n), false);
  }
  const reopened = f.reopen();
  assert.equal((await reopened.getInternal('R')).externalResearchOperationalPrompts, false);
  await reopened.flush();
});

test('disabling during a held preparation revokes only operational input before any Send', async t => {
  const f = await fixture(t, true); await f.store.applyExternalResearchSnapshot('R', f.snapshot);
  let enter, release; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const d = f.delivery({ prepare: async (_run, n) => { enter(); await held;
    return { prompt: n.body, sendOptions: { provider: 'codex', queue: true, statusAtSend: 'busy' } }; } });
  d.schedule('R'); await entered;
  await f.store.updateSettings({ externalResearchOperationalPrompts: false });
  release(); await d.drain(); d.stop();
  const run = await f.store.getInternal('R');
  assert.equal(run.notifySource, true); assert.equal(run.requestFingerprint, 'same-intent');
  assert.equal(run.externalResearchJobId, 'noted_R'); assert.equal(run.sourceSessionId, 'session');
  assert.equal(Object.values(run.externalResearchOperational.notices)[0].delivery, 'suppressed');
  assert.ok(f.revoked.length > 0);
  const restored = f.reopen(); assert.equal((await restored.getSettings()).externalResearchOperationalPrompts, false);
  assert.equal((await restored.getInternal('R')).externalResearchOperationalPrompts, false); await restored.flush();
});

test('full final still completes the same run automatically while operational prompts are disabled', { timeout: 5000 }, async t => {
  const f = await fixture(t, false); await f.store.applyExternalResearchSnapshot('R', f.snapshot);
  let callbacks = 0, starts = 0;
  const coordinator = new ExternalResearchCoordinator({ store: f.store, logger: { warn() {} },
    client: { status: async () => ({ ...f.snapshot, status: 'done', stage: 'done', doneAt: Date.now(),
      execution: { ...f.snapshot.execution, controlRevision: 2,
        attention: { ...f.snapshot.execution.attention, state: 'cleared', updateSeq: 2 } },
      result: { text: 'complete original answer', answer_text: 'complete original answer' } }),
      start: async () => { starts++; assert.fail('same existing research must not start again'); } },
    finalizeSettled: async run => { callbacks++; assert.equal(run.runId, 'R'); assert.equal(run.notifySource, true); } });
  t.signal.addEventListener('abort', () => { void coordinator.stop(); }, { once: true });
  try {
    await coordinator.watch('R');
    const run = await f.store.getInternal('R');
    assert.equal(run.status, 'completed'); assert.equal(run.resultComplete, true);
    assert.equal(callbacks, 1); assert.equal(starts, 0);
    assert.equal(run.externalResearchOperationalPrompts, false);
    assert.ok(Object.values(run.externalResearchOperational.notices).every(n => n.delivery === 'suppressed'));
  } finally { await coordinator.stop(); }
});

test('planned maintenance survives restart and never replays its suppressed incidents after completion', async t => {
  const f = await fixture(t);
  const before = JSON.parse(JSON.stringify(await f.store.getInternal('R')));
  const begun = await f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'install:owned:1' });
  assert.equal(begun.activeOperationId, 'install:owned:1');
  await f.store.applyExternalResearchSnapshot('R', f.snapshot);
  await f.store.recordExternalOperationalFailure('R', { reason: 'transport_unavailable', code: 'ECONNREFUSED' });
  const restored = f.reopen();
  assert.equal((await restored.getResearchMaintenance()).activeOperationId, 'install:owned:1');
  let run = await restored.getInternal('R');
  assert.equal(run.externalResearchOperationalPrompts, true, 'maintenance does not overwrite the user preference');
  assert.ok(Object.values(run.externalResearchOperational.notices).every(n => n.suppressionReason === 'planned_maintenance'));
  await assert.rejects(restored.transitionResearchMaintenance({ action: 'complete', operationId: 'other-install' }), { code: 'research_maintenance_unknown' });
  const completed = await restored.transitionResearchMaintenance({ action: 'complete', operationId: 'install:owned:1' });
  assert.equal(completed.activeOperationId, null);
  await restored.applyExternalResearchSnapshot('R', f.snapshot);
  run = await restored.getInternal('R');
  assert.ok(Object.values(run.externalResearchOperational.notices).every(n => !canDeliver(run, n)), 'same open episode cannot wake the model later');
  for (const key of ['externalResearchDeliveryBirth', 'externalResearchJobId', 'requestFingerprint', 'externalResearchIntent', 'notifySource', 'sourceSessionId']) {
    assert.deepEqual(run[key], before[key], key + ' is preserved');
  }
  const oldBegin = await restored.transitionResearchMaintenance({ action: 'begin', operationId: 'install:owned:1' });
  assert.equal(oldBegin.repeated, true); assert.equal(oldBegin.activeOperationId, null);
  const freshSnapshot = { ...f.snapshot, execution: { ...f.snapshot.execution, controlRevision: 2,
    attention: { ...f.snapshot.execution.attention, episodeId: 'new-post-install-incident' } } };
  await restored.applyExternalResearchSnapshot('R', freshSnapshot);
  run = await restored.getInternal('R');
  assert.ok(Object.values(run.externalResearchOperational.notices).every(n => !canDeliver(run, n)),
    'a different episode in an uncorrelated status response still needs the post-maintenance check');
  const read = await restored.captureExternalOperationalRead('R');
  const applied = await restored.applyExternalResearchSnapshot('R', freshSnapshot, { operationalRead: read });
  restored.releaseExternalOperationalRead(read);
  const scope = applied.rearmCheck;
  await restored.completeExternalOperationalRearmCheck('R', scope, { current: true, execution: freshSnapshot.execution,
    check: { version: 1, state: 'complete', checkId: scope.checkId, jobId: scope.jobId,
      controlEpoch: scope.controlEpoch, browserInstanceId: scope.browserInstanceId,
      startedAt: Date.now(), completedAt: Date.now(), controlRevision: 2, reader: null,
      verdict: 'open', attention: freshSnapshot.execution.attention, evidence: { kind: 'controlled-check-port' } } });
  run = await restored.getInternal('R');
  const fresh = Object.values(run.externalResearchOperational.notices).find(n => n.rearm && n.episodeId === 'new-post-install-incident');
  assert.equal(canDeliver(run, fresh), true, 'fresh correlated incident can wake after maintenance');
  await restored.flush();
});

test('maintenance begin fences an already prepared operational input and a new run inherits quiet policy', async t => {
  const f = await fixture(t, true); await f.store.applyExternalResearchSnapshot('R', f.snapshot);
  let enter, release; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const d = f.delivery({ prepare: async (_run, n) => { enter(); await held;
    return { prompt: n.body, sendOptions: { provider: 'codex', queue: true, statusAtSend: 'busy' } }; } });
  d.schedule('R'); await entered;
  await f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'install:owned:2' });
  release(); await d.drain(); d.stop();
  assert.ok(f.revoked.length > 0);
  await f.store.reserveOrGet({ runId: 'R2', runKind: 'external-research', sourceTabId: 'other-source',
    externalResearchJobId: 'noted_R2', sourceSessionId: 'other-session', notifySource: true });
  assert.equal((await f.store.getInternal('R2')).externalResearchMaintenanceOperationId, 'install:owned:2');
  assert.equal((await f.store.getInternal('R2')).notifySource, true);
});

test('failed maintenance write cannot ACK a RAM-only begin; same operation retry commits it', async t => {
  const f = await fixture(t, true), rename = fs.promises.rename;
  fs.promises.rename = async (...args) => {
    if (args[1] === f.file) throw Object.assign(Error('owned maintenance EIO'), { code: 'EIO' });
    return rename(...args);
  };
  try { await assert.rejects(f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'install:owned:3' }), { code: 'EIO' }); }
  finally { fs.promises.rename = rename; }
  const retry = await f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'install:owned:3' });
  assert.equal(retry.repeated, true);
  const restored = f.reopen();
  assert.equal((await restored.getResearchMaintenance()).activeOperationId, 'install:owned:3');
  await restored.flush();
});
