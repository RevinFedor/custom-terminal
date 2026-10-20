'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const ts = require('typescript'), Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { OrchestrationRunStore, classifyAgentSendReceipt } = require('./orchestration-runs');
const { createOperationalDelivery } = require('./external-research-operational-delivery');
const source = fs.readFileSync(require.resolve('./web-server'), 'utf8');
const ast = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
let factory;
const visit = n => {
  if (ts.isNewExpression(n) && n.expression.getText(ast) === 'AgentSendQueue') {
    factory = n.arguments[0].properties.find(p => p.name?.getText(ast) === 'execute').initializer;
  }
  ts.forEachChild(n, visit);
}; visit(ast); assert(factory);
const physical = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'runPreparedAgentSendScenario');
// Other owners may prepend their own guard; the first statement is not this
// protocol's identity. Keep testing the actual operational boundary explicitly.
const guard = physical.body.statements.find(n => ts.isIfStatement(n)
  && n.expression.getText(ast).includes('operationalNoticeRef'));
assert(guard, 'actual operational admission guard');
const revoke = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'revokeExternalOperationalDelivery');
assert(revoke);
const next = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const parent = path.join(os.homedir(), 'Library/Application Support/sc-desktop/test-artifacts/research-autonomy-20261019');
  fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'noted-fifo-'));
  const file = path.join(root, 'runs.json'), db = new Database(':memory:');
  const receipts = createAgentSendReceiptStore(db), calls = [];
  let queue, ready = false, service, actualRevoke;
  const sourceTarget = options.sourceTarget || { toolType: 'codex', sessionId: 'S' };
  let store = new OrchestrationRunStore(file, { onOperationalRevoked: (run, notice) => actualRevoke(run, notice) });
  await store.updateSettings({ externalResearchOperationalPrompts: true });
  await store.reserveOrGet({ runId: 'own', runKind: 'external-research', requestFingerprint: 'immutable',
    sourceTabId: 'T', sourceSessionId: sourceTarget.sessionId || null, sourceSendTarget: sourceTarget,
    notifySource: true, externalResearchJobId: 'noted_own', externalResearchIntent: { provider: 'chatgpt', prompt: 'fixture', files: [], options: {} } });
  await store.applyExternalResearchSnapshot('own', { id: 'noted_own', status: 'running',
    browserInstanceId: '10000000-0000-4000-8000-000000000001', execution: { version: 1, controlEpoch: 'epoch', controlRevision: 1,
      attention: { version: 2, jobId: 'noted_own', controlEpoch: 'epoch', episodeId: 'episode', updateSeq: 1, wakeSeq: 1,
        phase: 'observing', reason: 'observation_unavailable', state: 'open', terminal: false, wakeModel: true, audience: ['human', 'source_agent'] } } });
  const identity = request => ({ operationKey: request.sendOperationKey, surface: 'desktop-history', tabId: request.tabId,
    handoffId: request.handoffId, provider: request.provider, sessionId: request.sessionId || null,
    requestFingerprint: fingerprintAgentSendRequest(request), promptHash: fingerprintAgentSendRequest(request.prompt), promptLength: request.prompt.length });
  const context = vm.createContext({ OPERATIONAL_ADMISSION: Symbol('owned'), getExternalOperationalDelivery: () => service,
    require, agentSendReceiptStore: receipts, agentSendQueue: null,
    tabWorkContext: null, calls, assert,
    physicalResult: options.physicalResult || (() => ({ success: false, submitted: false, code: 'owned_provider_leaf' })),
    runPreparedAgentSendScenario: null });
  // Actual guard and actual restart factory; the final provider/PTY leaf is
  // deliberately controlled. No real model prompt, window or native input.
  vm.runInContext('async function ownedPhysical(args) {' + guard.getText(ast)
    + '; calls.push(args); return physicalResult(args, calls.length); }', context);
  context.runPreparedAgentSendScenario = context.ownedPhysical;
  const execute = vm.runInContext('(' + factory.getText(ast) + ')', context);
  actualRevoke = vm.runInContext('(' + revoke.getText(ast) + ')', context);
  const makeQueue = () => new AgentSendQueue({ store: receipts, execute, ready: () => ready });
  queue = makeQueue(); context.agentSendQueue = queue;
  const makeService = () => createOperationalDelivery({ store, classify: classifyAgentSendReceipt, logger: { warn() {} },
    prepare: async (_run, notice) => ({ prompt: notice.body, sendOptions: { provider: 'codex', queue: true, statusAtSend: 'busy' } }),
    pin: notice => receipts.pinForOwner(notice.operationKey, 'research-operational'),
    lookup: async () => ({ result: null, absentBeforeAdmission: false }),
    send: async request => queue.enqueue({ identity: identity(request), request }).receipt });
  service = makeService();
  t.after(async () => { service.stop(); queue.dispose(); await next(); await store.flush(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get store() { return store; }, receipts, calls, get service() { return service; },
    queueInfo: key => queue.queueInfo(key),
    predecessor: () => {
      const request = { tabId: 'T', provider: 'codex', sessionId: null, handoffId: 'fixture-prior',
        sendOperationKey: 'history:T:fixture-prior', prompt: 'prior source input', source: 'history-panel' };
      const key = identity(request); queue.enqueue({ identity: key, request });
      return () => {
        const begun = receipts.beginAttempt(key); receipts.markAttemptState(key.operationKey, begun.attemptId, 'enter-armed');
        receipts.settleAttempt(key.operationKey, begun.attemptId, { submitted: true, auditPending: true });
        assert(receipts.promoteFromAudit({ success: true, operationKey: key.operationKey, attemptId: begun.attemptId,
          provider: 'codex', sessionId: 'prior-SID', promptHash: key.promptHash, actualHash: key.promptHash,
          expectedHash: key.promptHash, entryUuid: 'prior-input', sourceIdentity: 'prior-source-proof',
          auditTimestamp: new Date().toISOString() }).promoted);
      };
    },
    legacyFailed: key => db.prepare("UPDATE agent_send_queue SET state='failed' WHERE operation_key=?").run(key),
    unownedOperationalInput: () => context.ownedPhysical({ source: 'research-operational:forged',
      operationalNoticeRef: { version: 1, runId: 'own' } }),
    async restart() { queue.dispose(); queue = makeQueue(); context.agentSendQueue = queue; ready = true; queue.resume(); await next(); await next(); },
    async startupRestart(operationId) {
      await store.flush(); service.stop(); queue.dispose(); ready = false;
      store = new OrchestrationRunStore(file, { startupMaintenance: { version: 1, operationId },
        onOperationalRevoked: (run, notice) => actualRevoke(run, notice) });
      queue = makeQueue(); context.agentSendQueue = queue; service = makeService();
      await store.initialize({ requireAuthority: true });
      ready = true; queue.resume(); await next(); await next();
    },
    allow: async () => { ready = true; queue.resume(); await next(); await next(); },
    runtime: async signature => { queue.notifyRuntime('T', signature); await next(); await next(); } };
}
test('actual SQLite FIFO retains busy-parent notice and actual restart factory restores its guard', async t => {
  const f = await fixture(t); f.service.schedule('own'); await f.service.drain();
  assert.equal(f.calls.length, 0);
  await f.restart();
  assert.equal(f.calls.length, 1, 'the authorized provider leaf is reached once after readiness');
  assert.equal((await f.store.getInternal('own')).resultComplete, false);
});
test('cancelled operational input in a persisted FIFO cannot become an ordinary unguarded send after restart', async t => {
  const f = await fixture(t); f.service.schedule('own'); await f.service.drain();
  await f.store.cancel('own'); await f.restart();
  assert.equal(f.calls.length, 0);
  const notice = Object.values((await f.store.getInternal('own')).externalResearchOperational.notices)[0];
  assert.equal(notice.delivery, 'suppressed');
  assert(f.receipts.get(notice.operationKey).deliveryControl.cancelledAt);
});
test('startup handover revokes pre-existing SQLite queued notice before the restarted FIFO is ready', async t => {
  const f = await fixture(t); f.service.schedule('own'); await f.service.drain();
  const before = await f.store.getInternal('own'), notice = Object.values(before.externalResearchOperational.notices)[0];
  const original = f.receipts.get(notice.operationKey);
  assert.equal(f.queueInfo(notice.operationKey).state, 'waiting');
  await f.startupRestart('install:startup:sqlite');
  assert.equal(f.calls.length, 0);
  const state = await f.store.getResearchMaintenance(), after = await f.store.getInternal('own');
  assert.equal(state.startup.durable, true); assert.equal(state.activeOperationId, 'install:startup:sqlite');
  assert.equal(after.externalResearchOperational.notices[notice.id].delivery, 'suppressed');
  assert.equal(after.externalResearchDeliveryBirth.birthId, before.externalResearchDeliveryBirth.birthId);
  const cancelled = f.receipts.get(notice.operationKey);
  assert.ok(cancelled.deliveryControl.cancelledAt);
  assert.equal(cancelled.requestFingerprint, original.requestFingerprint);
});
for (const maintenance of [false, true]) test((maintenance ? 'planned maintenance' : 'turning operational prompts off') + ' cancels an already queued notice across actual SQLite FIFO restart', async t => {
  const f = await fixture(t); f.service.schedule('own'); await f.service.drain();
  const before = await f.store.getInternal('own');
  const notice = Object.values(before.externalResearchOperational.notices)[0];
  const original = f.receipts.get(notice.operationKey);
  if (maintenance) await f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'install:actual-fifo' });
  else await f.store.updateSettings({ externalResearchOperationalPrompts: false });
  await f.restart();
  assert.equal(f.calls.length, 0);
  const after = await f.store.getInternal('own');
  assert.equal(after.notifySource, true); assert.equal(after.notificationSuppressed, undefined);
  assert.equal(after.externalResearchJobId, before.externalResearchJobId);
  assert.equal(after.externalResearchDeliveryBirth.birthId, before.externalResearchDeliveryBirth.birthId);
  assert.equal(after.externalResearchOperational.notices[notice.id].delivery, 'suppressed');
  const receipt = f.receipts.get(notice.operationKey);
  assert(receipt.deliveryControl.cancelledAt);
  assert.equal(receipt.requestFingerprint, original.requestFingerprint);
  if (maintenance) {
    assert.equal((await f.store.getResearchMaintenance()).activeOperationId, 'install:actual-fifo');
    await f.store.transitionResearchMaintenance({ action: 'complete', operationId: 'install:actual-fifo' });
    f.service.schedule('own'); await f.service.drain();
    assert.equal(f.calls.length, 0, 'completion of maintenance does not replay the old notice');
  }
});
test('replacement source revokes the frozen old destination instead of granting it late input', async t => {
  const f = await fixture(t); f.service.schedule('own'); await f.service.drain();
  const notice = Object.values((await f.store.getInternal('own')).externalResearchOperational.notices)[0];
  await f.store.patch('own', { sourceTabId: 'replacement-tab', sourceSendTarget: { toolType: 'codex', sessionId: 'replacement-session' } });
  await f.store.persistStrict(); await f.restart();
  assert.equal(f.calls.length, 0);
  assert(f.receipts.get(notice.operationKey).deliveryControl.cancelledAt);
  const current = (await f.store.getInternal('own')).externalResearchOperational.notices[notice.id];
  assert.equal(current.delivery, 'suppressed'); assert.equal(current.cancellationConfirmed, true);
});
test('actual operational guard still rejects an unowned input after completion guard was added before it', async t => {
  const f = await fixture(t);
  await assert.rejects(f.unownedOperationalInput(), { code: 'operational_admission_required', submitted: false });
  assert.equal(f.calls.length, 0);
});

test('actual FIFO restart keeps a provisional operational launch pin intact after a confirmed predecessor', async t => {
  const target = { toolType: 'codex', terminalInstanceId: 'exact-instance', launchId: 'exact-launch' };
  const f = await fixture(t, { sourceTarget: target }), confirmPrior = f.predecessor();
  f.service.schedule('own'); await f.service.drain(); confirmPrior();
  await f.restart();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].expectedTarget)), target);
  assert.equal(f.calls[0].sessionId, null);
  assert.deepEqual((await f.store.getInternal('own')).sourceSendTarget, target);
});

for (const beginAgain of [false, true]) test('fresh rearm has its own SQLite FIFO identity; later maintenance=' + beginAgain, async t => {
  const f = await fixture(t); f.service.schedule('own'); await f.service.drain();
  const before = await f.store.getInternal('own'), old = Object.values(before.externalResearchOperational.notices)[0];
  const oldReceipt = f.receipts.get(old.operationKey);
  await f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'fifo-rearm-A' });
  await f.store.transitionResearchMaintenance({ action: 'complete', operationId: 'fifo-rearm-A' });
  const snapshot = { id: 'noted_own', status: 'running', browserInstanceId: before.externalResearchBrowserInstanceId,
    execution: { version: 1, controlEpoch: 'epoch', controlRevision: 2, reader: null,
      attention: { ...before.externalResearchOperational.sc.latestAttention, jobId: 'noted_own', controlEpoch: 'epoch',
        audience: ['human', 'source_agent'], wakeModel: true, terminal: false, updateSeq: 2 } } };
  const read = await f.store.captureExternalOperationalRead('own');
  const applied = await f.store.applyExternalResearchSnapshot('own', snapshot, { operationalRead: read });
  f.store.releaseExternalOperationalRead(read);
  const scope = applied.rearmCheck;
  await f.store.completeExternalOperationalRearmCheck('own', scope, { current: true, execution: snapshot.execution,
    check: { version: 1, state: 'complete', checkId: scope.checkId, jobId: scope.jobId,
      controlEpoch: scope.controlEpoch, browserInstanceId: scope.browserInstanceId,
      startedAt: Date.now(), completedAt: Date.now(), controlRevision: 2,
      reader: null, attention: snapshot.execution.attention, verdict: 'open', evidence: { kind: 'controlled-check-port' } } });
  f.service.schedule('own'); await f.service.drain();
  const current = await f.store.getInternal('own'), fresh = Object.values(current.externalResearchOperational.notices).find(n => n.rearm);
  assert(fresh); assert.notEqual(fresh.operationKey, old.operationKey);
  assert(f.queueInfo(fresh.operationKey), JSON.stringify({ delivery: fresh.delivery, reason: fresh.suppressionReason,
    error: fresh.lastError, epoch: fresh.scControlEpoch }));
  assert.equal(f.queueInfo(fresh.operationKey).state, 'waiting');
  assert(f.receipts.get(old.operationKey).deliveryControl.cancelledAt);
  if (beginAgain) await f.store.transitionResearchMaintenance({ action: 'begin', operationId: 'fifo-rearm-B' });
  await f.restart();
  assert.equal(f.calls.length, beginAgain ? 0 : 1);
  if (beginAgain) assert(f.receipts.get(fresh.operationKey).deliveryControl.cancelledAt);
  else assert.equal(f.calls[0].handoffId, fresh.handoffId);
  assert.equal(f.receipts.get(old.operationKey).requestFingerprint, oldReceipt.requestFingerprint);
  assert.equal((await f.store.getInternal('own')).externalResearchOperational.notices[old.id].body, old.body);
});

for (const hasAttempt of [false, true]) test('proven no-input operational refusal parks the same FIFO item until a source runtime wake, then enters once; attempt=' + hasAttempt, async t => {
  let f, inputCount = 0;
  f = await fixture(t, { physicalResult: (args, count) => {
    if (count === 1) {
      const refusal = { success: false, submitted: false, pasteWritten: false, enterWritten: false,
        code: 'draft_conflict', status: 'not-submitted' };
      if (hasAttempt) {
        const previous = f.receipts.get(args.sendOperationKey), begun = f.receipts.beginAttempt(previous);
        f.receipts.settleAttempt(previous.operationKey, begun.attemptId, refusal);
      }
      return refusal;
    }
    inputCount++;
    const old = f.receipts.get(args.sendOperationKey), begun = f.receipts.beginAttempt(old);
    assert.equal(begun.action, 'attempt-started');
    f.receipts.markAttemptState(old.operationKey, begun.attemptId, 'enter-armed');
    f.receipts.settleAttempt(old.operationKey, begun.attemptId, { success: true, submitted: true,
      pasteWritten: true, enterWritten: true, auditPending: true, status: 'audit-pending' });
    return f.receipts.get(old.operationKey).receipt;
  } });
  f.service.schedule('own'); await f.service.drain();
  const notice = Object.values((await f.store.getInternal('own')).externalResearchOperational.notices)[0];
  const id = f.queueInfo(notice.operationKey).id, fingerprint = f.receipts.get(notice.operationKey).requestFingerprint;
  await f.allow(); assert.equal(f.calls.length, 1); assert.equal(inputCount, 0);
  assert.equal(f.queueInfo(notice.operationKey).state, 'waiting');
  await next(); await next(); assert.equal(f.calls.length, 1, 'receipt publication cannot self-retry');
  await f.runtime('source-draft-cleared');
  assert.equal(f.calls.length, 2); assert.equal(inputCount, 1);
  assert.equal(f.queueInfo(notice.operationKey).id, id);
  assert.equal(f.receipts.get(notice.operationKey).requestFingerprint, fingerprint);
  assert.equal(f.calls[1].handoffId, f.calls[0].handoffId); assert.equal(f.calls[1].prompt, f.calls[0].prompt);
  await f.runtime('another-source-event'); assert.equal(inputCount, 1, 'unknown post-Enter outcome is never retried');
});

test('source readiness arriving during a no-input attempt is retained without a receipt-driven retry loop', { timeout: 4000 }, async t => {
  let enter, release, retried;
  const entered = new Promise(r => { enter = r; }), held = new Promise(r => { release = r; });
  const second = new Promise(r => { retried = r; });
  const f = await fixture(t, { physicalResult: async (_args, count) => {
    if (count === 1) { enter(); await held; } else retried();
    return { success: false, submitted: false, pasteWritten: false, enterWritten: false, code: 'draft_conflict' };
  } });
  f.service.schedule('own'); await f.service.drain();
  const opening = f.allow(); await entered; await f.runtime('source-became-ready-during-check'); release();
  await opening;
  let deadline;
  try { await Promise.race([second, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('source-ready wake was lost')), 1000); })]); }
  finally { clearTimeout(deadline); }
  await next(); await next();
  assert.equal(f.calls.length, 2); await next(); await next(); assert.equal(f.calls.length, 2);
});

for (const patch of [{ deliveryUnknown: true }, { pasteWritten: true }, { enterWritten: true }, { pasteWritten: undefined }]) {
  test('ambiguous operational refusal never resumes from a runtime event: ' + JSON.stringify(patch), async t => {
    let f;
    f = await fixture(t, { physicalResult: args => {
      const record = f.receipts.get(args.sendOperationKey), attempt = f.receipts.beginAttempt(record);
      const result = { success: false, submitted: false, pasteWritten: false, enterWritten: false,
        code: 'source_unavailable', ...patch };
      f.receipts.settleAttempt(record.operationKey, attempt.attemptId, result);
      return result;
    } });
    f.service.schedule('own'); await f.service.drain(); await f.allow();
    assert.equal(f.calls.length, 1); await f.runtime('source-ready'); assert.equal(f.calls.length, 1);
  });
}

for (const cancelled of [false, true]) test('old-version failed operational no-input row resumes in the same FIFO after restart; cancelled=' + cancelled, async t => {
  const f = await fixture(t, { physicalResult: () => ({ success: false, submitted: false,
    pasteWritten: false, enterWritten: false, code: 'draft_conflict' }) });
  f.service.schedule('own'); await f.service.drain(); await f.allow();
  const notice = Object.values((await f.store.getInternal('own')).externalResearchOperational.notices)[0];
  const firstId = f.queueInfo(notice.operationKey).id;
  f.legacyFailed(notice.operationKey);
  if (cancelled) await f.store.cancel('own');
  await f.restart();
  assert.equal(f.calls.length, cancelled ? 1 : 2);
  assert.equal(f.queueInfo(notice.operationKey).id, firstId);
  if (!cancelled) assert.equal(f.queueInfo(notice.operationKey).state, 'waiting');
});
