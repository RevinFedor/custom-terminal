'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { OrchestrationRunStore } = require('./orchestration-runs');
const { canDeliver } = require('./external-research-operational');
const { recordLocalOperationalFailure, clearLocalOperationalEpisode } = require('./external-research-operational');
const { createOperationalDelivery, resolveOperationalRequest } = require('./external-research-operational-delivery');
const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { ExternalResearchCoordinator } = require('./external-research-coordinator');
const owner = '10000000-0000-4000-8000-000000000001';
async function fixture(t, onOperationalRevoked) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'noted-operational-')), file = path.join(root, 'runs.json');
  const store = new OrchestrationRunStore(file, { onOperationalRevoked });
  await store.updateSettings({ externalResearchOperationalPrompts: true });
  await store.reserveOrGet({ runId: 'own', runKind: 'external-research', requestFingerprint: 'immutable',
    sourceTabId: 'source', sourceSessionId: 'S', sourceSendTarget: { toolType: 'codex', sessionId: 'S' },
    notifySource: true, externalResearchJobId: 'noted_own',
    externalResearchIntent: { provider: 'chatgpt', prompt: 'own fixture', options: {}, files: [] } });
  await store.persistStrict();
  t.after(async () => { await store.flush(); fs.rmSync(root, { recursive: true, force: true }); });
  const snapshot = (patch = {}) => ({ id: 'noted_own', provider: 'chatgpt', browserInstanceId: owner,
    status: 'queued', stage: 'waiting_browser_update', execution: { version: 1, controlEpoch: 'epoch', controlRevision: 3,
      send: { state: 'not_attempted' }, turn: { quality: 'unbound' }, attention: { version: 2, jobId: 'noted_own',
        controlEpoch: 'epoch', episodeId: 'episode', phase: 'opening', reason: 'executor_update_required',
        updateSeq: 1, wakeSeq: 1, state: 'open', audience: ['human', 'source_agent'], wakeModel: true, terminal: false } }, ...patch });
  return { store, file, snapshot, reopened: () => new OrchestrationRunStore(file, { onOperationalRevoked }) };
}
test('SC attention is durably frozen once, independent of final callback and result state', async t => {
  const f = await fixture(t);
  await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  const run = await f.store.getInternal('own'), notices = Object.values(run.externalResearchOperational.notices);
  assert.equal(notices.length, 1); assert.equal(notices[0].origin, 'sc'); assert(canDeliver(run, notices[0]));
  assert.match(notices[0].body, /не поручение продолжать продуктовую реализацию до консультации/);
  assert.match(notices[0].body, /send_message и жди/);
  assert.match(notices[0].body, /Не восстанавливай канал самостоятельно новым Chat/);
  assert.match(notices[0].body, /Не начинай независимые правки/);
  assert.equal(run.resultAvailable, false); assert.equal(run.resultComplete, false); assert.equal(run.notificationStatus, 'pending');
  assert.equal(run.sourceFollowupStartedAt, null);
  const repeat = f.snapshot(); repeat.execution.controlRevision++; repeat.execution.attention.updateSeq += 3;
  await f.store.applyExternalResearchSnapshot('own', repeat);
  const reopened = await f.reopened().getInternal('own');
  assert.equal(Object.keys(reopened.externalResearchOperational.notices).length, 1);
  assert.equal(Object.values(reopened.externalResearchOperational.notices)[0].body, notices[0].body);
  const publicRun = await f.store.get('own');
  assert.equal(JSON.stringify(publicRun).includes(notices[0].body), false, 'status must not leak the prepared model prompt');
});
test('local transport outage persists before SC exists, and a healthy exact snapshot clears it without fake epoch', async t => {
  const f = await fixture(t);
  await f.store.recordExternalOperationalFailure('own', { reason: 'transport_unavailable', code: 'sc_research_request_timeout' });
  let run = await f.store.getInternal('own');
  const local = Object.values(run.externalResearchOperational.notices)[0];
  assert.equal(local.origin, 'noted'); assert.equal(local.scControlEpoch, undefined); assert(canDeliver(run, local));
  await f.store.recordExternalOperationalFailure('own', { reason: 'transport_unavailable', code: 'ECONNREFUSED' });
  run = await f.reopened().getInternal('own');
  assert.equal(Object.keys(run.externalResearchOperational.notices).length, 1);
  const firstObservedAt = run.externalResearchOperational.local.firstObservedAt;
  await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  run = await f.store.getInternal('own');
  assert.equal(run.externalResearchOperational.local.state, 'cleared');
  assert.equal(run.externalResearchOperational.local.firstObservedAt, firstObservedAt);
  assert.equal(run.externalResearchOperational.sc.controlEpoch, 'epoch');
  assert.equal(run.externalResearchOperational.notices[local.id].delivery, 'suppressed');
  assert.equal(canDeliver(run, local), false);
});

test('retrying transport records failure immediately but source wake waits for the bounded durable recovery window', async t => {
  const f = await fixture(t), run = await f.store.getInternal('own'), started = Date.now();
  const input = { reason: 'transport_unavailable', code: 'ECONNREFUSED', notificationGraceMs: 60000 };
  recordLocalOperationalFailure(run, input, started); await f.store.persistStrict();
  assert.equal(run.externalResearchOperational.local.state, 'open');
  assert.equal(Object.keys(run.externalResearchOperational.notices).length, 0);
  const reopened = f.reopened(), restored = await reopened.getInternal('own');
  recordLocalOperationalFailure(restored, input, started + 30000);
  assert.equal(Object.keys(restored.externalResearchOperational.notices).length, 0);
  recordLocalOperationalFailure(restored, input, started + 61000); await reopened.persistStrict();
  const notice = Object.values(restored.externalResearchOperational.notices)[0];
  assert(notice); assert(canDeliver(restored, notice));
  recordLocalOperationalFailure(restored, input, started + 70000);
  assert.equal(Object.keys(restored.externalResearchOperational.notices).length, 1);
  clearLocalOperationalEpisode(restored, started + 71000); await reopened.persistStrict();
  assert.equal(canDeliver(restored, notice), false); await reopened.flush();
});
test('pin without attention persists strictly, and stale/foreign snapshots cannot reset it', async t => {
  const f = await fixture(t), snapshot = f.snapshot(); snapshot.execution.attention = null;
  await f.store.applyExternalResearchSnapshot('own', snapshot);
  assert.equal((await f.reopened().getInternal('own')).externalResearchOperational.sc.controlEpoch, 'epoch');
  const foreign = f.snapshot(); foreign.execution.controlEpoch = 'other';
  await assert.rejects(f.store.applyExternalResearchSnapshot('own', foreign), { code: 'external_research_control_epoch_mismatch' });
  const stale = f.snapshot(); stale.execution.controlRevision = 2;
  await f.store.applyExternalResearchSnapshot('own', stale);
  assert.equal(Object.keys((await f.store.getInternal('own')).externalResearchOperational.notices).length, 0);
});
test('cancel revokes the exact notice synchronously before any persistence await; late receipts do not revive it', async t => {
  const revoked = [], f = await fixture(t, (_run, notice) => { revoked.push(notice.operationKey); return { ok: true }; });
  await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  const notice = Object.values((await f.store.getInternal('own')).externalResearchOperational.notices)[0];
  await f.store.cancel('own');
  assert.deepEqual(revoked, [notice.operationKey]);
  await f.store.markExternalOperationalDelivery('own', notice.id, { delivery: 'sent', observedReceipt: { state: 'confirmed' } });
  const run = await f.reopened().getInternal('own');
  assert.equal(run.status, 'cancelled'); assert.equal(run.externalResearchOperational.notices[notice.id].delivery, 'suppressed');
  assert.equal(run.externalResearchOperational.notices[notice.id].observedReceipt.state, 'confirmed');
});

function deliveryHarness(store, overrides = {}) {
  const sent = [], receipts = new Map(), pins = new Set();
  const service = createOperationalDelivery({ store, logger: { warn() {} }, classify: classifyAgentSendReceipt,
    prepare: async (_run, notice) => ({ prompt: 'frozen-context\n' + notice.body,
      sendOptions: { provider: 'codex', queue: true, statusAtSend: 'busy' } }),
    pin: notice => pins.add(notice.operationKey),
    lookup: async notice => ({ result: receipts.get(notice.operationKey) || null, absentBeforeAdmission: false }),
    send: async request => {
      await resolveOperationalRequest(store, request); sent.push(request);
      const result = { success: true, submitted: true, receiptState: 'confirmed',
        operationKey: request.sendOperationKey, attemptId: 'own-attempt' };
      receipts.set(request.sendOperationKey, result); return result;
    }, ...overrides });
  return { service, sent, receipts, pins };
}
test('operational dispatcher freezes the prepared context, sends once, and never completes the research', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  const h = deliveryHarness(f.store); h.service.schedule('own'); await h.service.drain();
  h.service.schedule('own'); await h.service.drain();
  assert.equal(h.sent.length, 1);
  const request = h.sent[0], run = await f.store.getInternal('own');
  assert.match(request.prompt, /^frozen-context/); assert.equal(request.handoffId.startsWith('research-operational:'), true);
  assert.equal(run.externalResearchOperational.notices[request.handoffId].delivery, 'sent');
  assert.equal(run.resultComplete, false); assert.equal(run.notificationStatus, 'pending');
  assert.equal(run.sourceFollowupStartedAt, null);
});
test('cancel while context preparation awaits forbids enqueue of the formerly pending notice', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  let enter, release; const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const h = deliveryHarness(f.store, { prepare: async (_run, notice) => { enter(); await held;
    return { prompt: notice.body, sendOptions: { provider: 'codex', queue: false, statusAtSend: null } }; } });
  h.service.schedule('own'); await entered; await f.store.cancel('own'); release(); await h.service.drain();
  assert.equal(h.sent.length, 0);
  const notices = (await f.reopened().getInternal('own')).externalResearchOperational.notices;
  assert.equal(Object.values(notices)[0].delivery, 'suppressed');
});
test('lost operational receipt after restart is recovered under its same identity without another Send', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  let request, sends = 0;
  const h = deliveryHarness(f.store, { send: async value => { request = value; sends++;
    return { success: true, deliveryUnknown: true, status: 'delivery-unknown', operationKey: value.sendOperationKey, attemptId: 'original-attempt' }; } });
  h.service.schedule('own'); await h.service.drain();
  const restored = f.reopened();
  const next = deliveryHarness(restored, { lookup: async () => ({ result: { success: true, submitted: true,
    receiptState: 'confirmed', operationKey: request.sendOperationKey, attemptId: 'original-attempt' } }),
    send: () => assert.fail('unknown original delivery must never create another Send') });
  await next.service.restore(await restored.listAll()); await next.service.drain();
  assert.equal(sends, 1);
  assert.equal((await restored.getInternal('own')).externalResearchOperational.notices[request.handoffId].delivery, 'sent');
});
test('restart resolver rejects forged source/ref/body and rechecks suppression after preparation', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  let request;
  const h = deliveryHarness(f.store, { send: async value => { request = value;
    return { success: true, deliveryUnknown: true, operationKey: value.sendOperationKey }; } });
  h.service.schedule('own'); await h.service.drain();
  for (const patch of [{ operationalNoticeRef: null }, { prompt: 'different bytes' },
    { expectedTarget: { toolType: 'codex', sessionId: 'replacement' } }, { source: 'history-panel' }]) {
    await assert.rejects(resolveOperationalRequest(f.store, { ...request, ...patch }), { code: 'external_research_operational_cancelled' });
  }
  const guard = await resolveOperationalRequest(f.store, JSON.parse(JSON.stringify(request)));
  const reordered = { ...request,
    operationalNoticeRef: Object.fromEntries(Object.entries(request.operationalNoticeRef).reverse()),
    expectedTarget: Object.fromEntries(Object.entries(request.expectedTarget).reverse()) };
  await resolveOperationalRequest(f.store, reordered);
  await f.store.cancel('own');
  await assert.rejects(guard.prepareSend(), { code: 'external_research_operational_cancelled' });
});

test('returned draft/readiness refusal stays recorded without automatic Telegram by default', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  const blocked = []; let sends = 0;
  const h = deliveryHarness(f.store, {
    send: async () => { sends++; return { success: false, submitted: false, code: 'draft_conflict' }; },
    onBlocked: async (_run, notice) => blocked.push(notice.id),
  });
  h.service.schedule('own'); await h.service.drain();
  const run = await f.reopened().getInternal('own'), notice = Object.values(run.externalResearchOperational.notices)[0];
  assert.equal(sends, 1); assert.deepEqual(blocked, []);
  assert.equal(notice.delivery, 'waiting_for_input');
  assert.equal(run.resultComplete, false); assert.equal(run.status, 'starting');
});

function terminalSnapshot(f, withExecution = true) {
  const value = f.snapshot({ status: 'done', stage: 'done', doneAt: Date.now(), result: { text: 'full owned answer' } });
  if (withExecution) {
    value.execution.controlRevision++;
    value.execution.attention = { ...value.execution.attention, state: 'cleared', updateSeq: 2 };
  } else delete value.execution;
  return value;
}
function interceptTerminalRename(file, inspect) {
  const original = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (to === file) {
      const snapshot = JSON.parse(await fs.promises.readFile(from, 'utf8'));
      if (snapshot.runs.some(run => run.runId === 'own' && ['completed', 'failed'].includes(run.status))) await inspect(snapshot);
    }
    return original.call(fs.promises, from, to);
  };
  return () => { fs.promises.rename = original; };
}
test('same terminal snapshot retries its failed strict write instead of acknowledging a RAM-only final', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  const final = terminalSnapshot(f); let failures = 0;
  const restore = interceptTerminalRename(f.file, async () => { if (!failures++) throw Object.assign(Error('owned final rename failure'), { code: 'EACCES' }); });
  try {
    await assert.rejects(f.store.applyExternalResearchSnapshot('own', final), /owned final rename failure/);
    assert.equal((await f.store.getInternal('own')).status, 'completed', 'final evidence is retained in RAM, not rolled back over cancel/receipts');
    await f.store.applyExternalResearchSnapshot('own', final);
    const reopened = f.reopened(), run = await reopened.getInternal('own'); await reopened.flush();
    assert.equal(run.status, 'completed'); assert.equal(run.resultComplete, true);
    assert.equal(Object.values(run.externalResearchOperational.notices)[0].delivery, 'suppressed');
  } finally { restore(); }
});
test('monitor retries a local final write and publishes its same run once, without another SC start or status read', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  let failures = 0, reads = 0; const finalized = [];
  const restore = interceptTerminalRename(f.file, async () => { if (!failures++) throw Object.assign(Error('owned final rename failure'), { code: 'EACCES' }); });
  const coordinator = new ExternalResearchCoordinator({ store: f.store, longPollMs: 0, retryBaseMs: 1, retryMaxMs: 1, logger: { warn() {} },
    client: { status: async () => { reads++; return terminalSnapshot(f); }, start: () => assert.fail('final retry cannot regenerate') },
    finalizeSettled: async run => {
      const saved = JSON.parse(await fs.promises.readFile(f.file, 'utf8')).runs.find(value => value.runId === run.runId);
      assert.equal(saved.status, 'completed', 'durable terminal state precedes the completion callback'); finalized.push(run.runId);
    } });
  try {
    await coordinator.watch('own');
    assert.deepEqual(finalized, ['own']); assert.equal(reads, 1); assert(failures >= 2);
    const reopened = f.reopened(); assert.equal((await reopened.get('own')).status, 'completed'); await reopened.flush();
  } finally { restore(); await coordinator.stop(); }
});
test('legacy final without operational delta waits for its raw write before publishing completion', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', { id: 'noted_own', status: 'running', browserInstanceId: owner }); await f.store.persistStrict();
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const finalized = [], restore = interceptTerminalRename(f.file, async () => { enter(); await held; });
  const coordinator = new ExternalResearchCoordinator({ store: f.store, longPollMs: 0, logger: { warn() {} },
    client: { status: async () => terminalSnapshot(f, false), start: () => assert.fail('existing final cannot start another job') },
    finalizeSettled: async run => finalized.push(run.runId) });
  const watched = coordinator.watch('own');
  try { await entered; assert.deepEqual(finalized, [], 'a caught/background persist is not a completion ACK'); }
  finally { release(); await watched; restore(); await coordinator.stop(); }
  assert.deepEqual(finalized, ['own']);
});
test('a failed finalizer retries the same durable outcome, not the provider job or an operational warning', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  let reads = 0, attempts = 0; const finalized = [];
  const coordinator = new ExternalResearchCoordinator({ store: f.store, longPollMs: 0, retryBaseMs: 1, retryMaxMs: 1, logger: { warn() {} },
    client: { status: async () => { reads++; return terminalSnapshot(f); }, start: () => assert.fail('finalizer retry cannot regenerate') },
    finalizeSettled: async run => { assert.equal(run.runId, 'own'); if (++attempts === 1) throw Error('owned callback storage unavailable'); finalized.push(run.runId); } });
  try { await coordinator.watch('own'); }
  finally { await coordinator.stop(); }
  assert.equal(reads, 1); assert.equal(attempts, 2); assert.deepEqual(finalized, ['own']);
  const run = await f.store.getInternal('own');
  assert.equal(run.status, 'completed'); assert.equal(Object.values(run.externalResearchOperational.notices)[0].delivery, 'suppressed');
});
test('suppression while a local final-write retry waits is re-read before the completion callback', async t => {
  const f = await fixture(t); await f.store.applyExternalResearchSnapshot('own', f.snapshot());
  let failures = 0, enter, release; const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const restore = interceptTerminalRename(f.file, async () => {
    if (!failures++) throw Error('owned first final write failed');
    if (failures === 2) { enter(); await held; }
  });
  const inputs = [];
  const coordinator = new ExternalResearchCoordinator({ store: f.store, longPollMs: 0, retryBaseMs: 1, retryMaxMs: 1, logger: { warn() {} },
    client: { status: async () => terminalSnapshot(f), start: () => assert.fail('suppression cannot regenerate') },
    finalizeSettled: async run => { if (!run.notificationSuppressed) inputs.push(run.runId); } });
  const watched = coordinator.watch('own');
  try {
    await entered; const suppression = f.store.markNotification('own', 'suppressed'); release(); await Promise.all([suppression, watched]);
    assert.deepEqual(inputs, []); const reopened = f.reopened(); assert.equal((await reopened.get('own')).notificationSuppressed, true); await reopened.flush();
  } finally { release(); restore(); await coordinator.stop(); }
});

test('pre-send failure retries its failed strict write instead of acknowledging a RAM-only failure', async t => {
  const f = await fixture(t); let failures = 0;
  const restore = interceptTerminalRename(f.file, async () => { if (!failures++) throw Error('owned failure rename unavailable'); });
  try {
    await assert.rejects(f.store.failExternalResearch('own', { message: 'invalid own pair', code: 'invalid_pair' }), /owned failure rename unavailable/);
    assert.equal((await f.store.getInternal('own')).status, 'failed');
    await f.store.failExternalResearch('own', { message: 'must not replace original failure', code: 'other' });
    const reopened = f.reopened(), run = await reopened.getInternal('own'); await reopened.flush();
    assert.equal(run.status, 'failed'); assert.equal(run.resultErrorCode, 'invalid_pair'); assert.equal(run.error, 'invalid own pair');
  } finally { restore(); }
});
test('pre-send rejection waits for its raw failure write before publishing the failure callback', async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const finalized = [], restore = interceptTerminalRename(f.file, async () => { enter(); await held; });
  const coordinator = new ExternalResearchCoordinator({ store: f.store, logger: { warn() {} },
    client: { status: async () => { throw Object.assign(Error('invalid own pair'), { code: 'invalid_pair', status: 400 }); },
      start: () => assert.fail('a rejection cannot submit') }, finalizeSettled: async run => finalized.push(run.runId) });
  const watched = coordinator.watch('own');
  try { await entered; assert.deepEqual(finalized, [], 'a queued/caught write is not a durable failure ACK'); }
  finally { release(); await watched; restore(); await coordinator.stop(); }
  assert.deepEqual(finalized, ['own']);
});
test('pre-send failure write and finalizer failures retry only local completion, without another provider read', async t => {
  const f = await fixture(t); let writes = 0, reads = 0, attempts = 0; const finalized = [];
  const restore = interceptTerminalRename(f.file, async () => { if (!writes++) throw Error('owned failure rename unavailable'); });
  const coordinator = new ExternalResearchCoordinator({ store: f.store, retryBaseMs: 1, retryMaxMs: 1, logger: { warn() {} },
    client: { status: async () => { reads++; throw Object.assign(Error('invalid own pair'), { code: 'invalid_pair', status: 400 }); },
      start: () => assert.fail('a rejection cannot submit') }, finalizeSettled: async run => {
      const saved = JSON.parse(await fs.promises.readFile(f.file, 'utf8')).runs.find(value => value.runId === run.runId);
      assert.equal(saved.status, 'failed'); if (!attempts++) throw Error('owned callback unavailable'); finalized.push(run.runId);
    } });
  try { await coordinator.watch('own'); }
  finally { restore(); await coordinator.stop(); }
  assert.equal(reads, 1); assert.equal(attempts, 2); assert.deepEqual(finalized, ['own']);
});
test('suppression during the pre-send failure write is preserved before a fresh failure callback', async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  let writes = 0; const inputs = [];
  const restore = interceptTerminalRename(f.file, async () => { if (!writes++) { enter(); await held; } });
  const coordinator = new ExternalResearchCoordinator({ store: f.store, retryBaseMs: 1, retryMaxMs: 1, logger: { warn() {} },
    client: { status: async () => { throw Object.assign(Error('invalid own pair'), { status: 400 }); },
      start: () => assert.fail('suppression cannot submit') },
    finalizeSettled: async run => { if (!run.notificationSuppressed) inputs.push(run.runId); } });
  const watched = coordinator.watch('own');
  try {
    await entered; const suppression = f.store.markNotification('own', 'suppressed'); release(); await Promise.all([suppression, watched]);
    assert.deepEqual(inputs, []); const reopened = f.reopened(); assert.equal((await reopened.get('own')).notificationSuppressed, true); await reopened.flush();
  } finally { release(); restore(); await coordinator.stop(); }
});
test('stopping a locally failed-write watcher aborts its backoff without another provider action', async t => {
  const f = await fixture(t); let warned, reads = 0;
  const waiting = new Promise(resolve => { warned = resolve; });
  const restore = interceptTerminalRename(f.file, async () => { throw Error('owned persistent failure'); });
  const coordinator = new ExternalResearchCoordinator({ store: f.store, retryBaseMs: 10_000, retryMaxMs: 10_000,
    logger: { warn() { warned(); } },
    client: { status: async () => { reads++; throw Object.assign(Error('invalid own pair'), { status: 400 }); },
      start: () => assert.fail('stop cannot submit') }, finalizeSettled: () => assert.fail('no callback before persistence') });
  const watched = coordinator.watch('own');
  try { await waiting; await coordinator.stop(); await watched; assert.equal(reads, 1); }
  finally { restore(); await coordinator.stop(); }
});
