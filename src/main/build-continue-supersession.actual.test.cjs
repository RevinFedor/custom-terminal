'use strict';
// Actual operation, input receipts and SQL FIFO. Only OS/native/current-frame
// evidence and the unavailable old History slice are controlled finite leaves.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { NodeSqlite } = require('./fixtures/build-install-posthook.cjs');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { AgentSendQueue } = require('./agent-send-queue');
const { readBuildContinueSupersession } = require('./build-continue-supersession');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
let { createBuildContinueOperations } = require('./build-continue-operation');
if (process.env.BUILD_CONTINUE_STALE_PRE) {
  const mod = new Module(path.join(__dirname, 'stale-pre.cjs'), module); mod.filename = path.join(__dirname, 'stale-pre.cjs'); mod.paths = module.paths;
  mod._compile(fs.readFileSync(process.env.BUILD_CONTINUE_STALE_PRE, 'utf8'), mod.filename);
  ({ createBuildContinueOperations } = mod.exports);
}
const clone = value => JSON.parse(JSON.stringify(value));
const ID = 'exact-stale-operation';
async function fixture(t, options = {}) {
  let saved, service, clock = 1000;
  const db = new NodeSqlite(), receipts = createAgentSendReceiptStore(db, { now: () => clock });
  const queue = new AgentSendQueue({ store: receipts, ready: () => false });
  const old = { provider: 'codex', sessionId: 'A', turnId: 'captured', generation: 1, processId: null, startedAt: 900 };
  const next = { ...old, turnId: 'manual-later', generation: 2, startedAt: 2000 };
  const controls = { revision: 'native-final', busy: false, sid: 'A', stop: 0, final: true, unknown: false,
    interval: 'result_cache_cold', source: options.source || 'history-panel', afterProof: null, writesFail: false };
  const releases = [], changes = [], sent = [], oldReads = [];
  const state = () => ({ known: !controls.unknown, exists: true, toolType: 'codex', sessionId: controls.sid,
    cwd: '/fixture', busy: controls.busy, transitioning: false, processStatus: 'found', backgroundWorkCount: 0,
    revision: controls.revision });
  const capture = () => ({ ...state(), tabId: 'worker', projectId: 'project',
    runtime: { known: true, status: 'active', liveLifecycle: true, writerConfirmed: true },
    turn: { status: controls.final ? 'completed' : 'running', turnId: next.turnId, outcome: controls.final ? 'task_complete' : null } });
  const make = pid => createBuildContinueOperations({ pid, instanceId: 'fixture-' + pid, now: () => clock,
    read: () => saved, write: value => { if (controls.writesFail) throw Error('controlled save EIO'); saved = clone(value); },
    captureTabs: () => [{ tabId: 'worker', known: true, toolType: 'codex', sessionId: 'A', projectId: 'project',
      cwd: '/fixture', busy: true, executionContext: old, subject: { kind: 'codex-execution', targetExecutionContext: old } }],
    readRuns: async () => [], readStartup: () => ({ source: 'exact-shutdown-snapshot', capturedAt: 1001, shutdownPid: 11,
      targets: [{ tabId: 'worker', provider: 'codex', sessionId: 'A' }] }),
    readState: async () => state(), readInputFence: () => ({ terminalInstanceId: 'restored-pty', stopRevision: controls.stop, order: 1 }),
    readLaterInput: async (op, target, frame) => {
      const result = readBuildContinueSupersession({ operation: op, target, state: frame, capture, receipts, readQueued: key => queue.item(key) });
      await controls.afterProof?.(); return result;
    },
    readOriginal: async () => { oldReads.push('original'); return { found: true, sourceVerified: true, userUuid: 'original-user',
      executionContext: old, complete: false }; },
    readLatest: async () => { oldReads.push('latest'); return { result: { sourceVerified: true }, subject: { targetExecutionContext: next } }; },
    readInputInterval: async () => ({ known: false, reason: controls.interval }),
    readReceipt: key => receipts.get(key), readQueued: key => queue.item(key),
    cancelInput: target => {
      const row = queue.item(target.operationKey), record = receipts.get(target.operationKey);
      if (row) return queue.cancelDelivery('worker', target.handoffId, { dismiss: false, reason: 'build-continue-cancelled' }).complete;
      return receipts.cancelDelivery({ operationKey: target.operationKey, tabId: 'worker', provider: 'codex',
        handoffId: target.handoffId, attemptId: record?.attemptId || null, allowUnreserved: true }).ok;
    },
    send: async request => { sent.push(request); return { success: true, submitted: false }; },
    getRun: async () => null, changed: op => changes.push(clone(op)), released: event => releases.push(clone(event)),
  });
  service = make(11); await service.capture(ID, 11); service.dispose(); service = make(22); clock = 2001;
  const request = { tabId: 'worker', provider: 'codex', expectedTarget: { toolType: 'codex', sessionId: 'A' },
    source: controls.source, handoffId: 'new-manual-H', sendOperationKey: 'history:worker:new-manual-H', prompt: 'new own task' };
  const identity = { operationKey: request.sendOperationKey, tabId: 'worker', provider: 'codex', sessionId: 'A',
    handoffId: request.handoffId, surface: 'desktop-history', requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length };
  queue.enqueue({ identity, request }); const attempt = receipts.beginAttempt(identity);
  receipts.stageAttemptContext(identity.operationKey, attempt.attemptId, { sessionId: 'A' });
  receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true });
  if (!options.unknownReceipt) assert.equal(receipts.promoteFromAudit({ success: true, operationKey: identity.operationKey,
    attemptId: attempt.attemptId, provider: 'codex', sessionId: 'A', promptHash: identity.promptHash,
    actualHash: identity.promptHash, entryUuid: 'manual-user', executionContext: next,
    auditTimestamp: new Date(clock).toISOString(), transcriptBoundary: { byteOffset: 10 } }).promoted, true);
  queue.finish(queue.item(identity.operationKey), options.unknownReceipt ? 'awaiting-receipt' : 'completed');
  t.after(() => { service.dispose(); queue.dispose(); db.close(); });
  return { controls, receipts, queue, releases, changes, sent, oldReads, identity, next,
    get service() { return service; }, target: () => service.get(ID).targets[0], envelope: () => clone(saved),
    activate: async () => { service.activate(ID); await service.reconcile(ID); },
    reopen: () => { service.dispose(); service = make(22); }, capture };
}

test('causal: exact later independent native input/final supersedes stale restoration despite cold old interval', async t => {
  const h = await fixture(t); await h.activate();
  assert.equal(h.target().state, 'superseded'); assert.equal(h.target().reason, 'build_continue_newer_input');
  assert.equal(h.service.pending('worker'), false); assert.equal(h.sent.length, 0);
  assert.equal(h.releases.length, 1); assert.equal(h.oldReads.length, 0, 'positive new-work proof needs no giant old History');
  const receipt = h.receipts.get(h.identity.operationKey);
  h.reopen(); h.service.restore(); await h.service.reconcile(ID);
  assert.equal(h.releases.length, 1, 'reopen does not invent another release');
  assert.deepEqual(h.receipts.get(h.identity.operationKey), receipt, 'new/native receipt remains unchanged');
});

for (const source of ['build-install-return', 'external:build-install-return', 'orchestration-completion:child', 'tab-message:reply', 'prompt-loop', 'codex-capacity-retry']) {
  test(source + ' final cannot impersonate independent user work', async t => {
    const h = await fixture(t, { source }); await h.activate();
    assert.equal(h.target().state, 'pending'); assert.equal(h.service.pending('worker'), true);
    assert.equal(h.target().proofWait?.reason, 'result_cache_cold'); assert.equal(h.sent.length, 0);
    assert.equal(h.releases.length, 0);
  });
}
for (const source of ['terminal-mcp', 'external:terminal-mcp']) test('canonical independent request preserves ' + source + ' routing', async t => {
  const h = await fixture(t, { source }); await h.activate();
  assert.equal(h.target().state, 'superseded'); assert.equal(h.service.pending('worker'), false); assert.equal(h.sent.length, 0);
});
for (const kind of ['unknown-receipt', 'unknown-owner', 'no-final', 'busy', 'owner-race', 'Stop-race']) {
  test(kind + ' cannot grant supersession from a snapshot', async t => {
    const h = await fixture(t, { unknownReceipt: kind === 'unknown-receipt' });
    if (kind === 'unknown-owner') h.controls.unknown = true;
    if (kind === 'no-final') h.controls.final = false;
    if (kind === 'busy') h.controls.busy = true;
    if (kind === 'owner-race') h.controls.afterProof = () => { h.controls.sid = 'foreign'; h.controls.revision = 'foreign'; };
    if (kind === 'Stop-race') h.controls.afterProof = () => { h.controls.stop++; };
    await h.activate(); assert.equal(h.sent.length, 0);
    assert.equal(h.target().supersessionProof, undefined);
    if (h.releases.length) assert.equal(h.releases[0].reason, 'build_continue_owner_changed', 'existing real owner/Stop refusal stays separate');
  });
}

const cancelRequest = target => ({ requestId: 'exact-user-cancel-one', tabId: target.source.tabId,
  handoffId: target.handoffId, operationKey: target.operationKey });
test('card-contract: X acknowledges a settled unresolved refusal without replay, receipt rewrite or a second release', async t => {
  const h = await fixture(t), target = h.target();
  h.receipts.reserveOrGet({ operationKey: target.operationKey, tabId: 'worker', provider: 'codex', sessionId: 'A',
    handoffId: target.handoffId, surface: 'desktop-history', requestFingerprint: 'old-refused-request',
    promptHash: promptAuditFingerprint('continue'), promptLength: 8 });
  h.receipts.settleQueuedNoWrite(target.operationKey, { code: 'agent_send_startup_failed' });
  await h.activate(); assert.equal(h.target().state, 'unresolved'); assert.equal(h.target().cancellation, undefined);
  const before = h.receipts.get(target.operationKey), releases = h.releases.length, reason = h.target().reason;
  const request = cancelRequest(h.target()); await h.service.cancelTarget(ID, request);
  assert.ok(h.target().cancellation?.acknowledgedAt, 'inactive visible error needs a durable acknowledged close');
  assert.equal(h.target().reason, reason, 'History retains the actual refusal, separate from the close acknowledgement');
  const after = h.receipts.get(target.operationKey);
  assert.equal(after.state, before.state); assert.equal(after.attemptId, before.attemptId); assert.deepEqual(after.receipt, before.receipt);
  assert.equal(h.releases.length, releases); assert.equal(h.sent.length, 0);
  await h.service.cancelTarget(ID, request); h.reopen(); h.service.restore(); await h.service.reconcile(ID);
  assert.ok(h.target().cancellation.acknowledgedAt); assert.equal(h.sent.length, 0);
});
test('exact legacy target cancellation revokes future input and hold; retry/reopen cannot dispatch', async t => {
  const h = await fixture(t, { source: 'orchestration-completion:child' }); await h.activate();
  assert.equal(h.service.pending('worker'), true);
  const request = cancelRequest(h.target());
  await h.service.cancelTarget(ID, request);
  assert.equal(h.envelope().version, 4, 'new frozen recovery prompt and cancellation both survive rollback readers');
  assert.equal(h.service.pending('worker'), false); assert.equal(h.target().state, 'cancelled');
  assert.equal(h.releases.length, 1); assert.equal(h.sent.length, 0);
  await h.service.cancelTarget(ID, request); h.reopen(); h.service.restore();
  await h.service.reconcile(ID); await h.service.cancelTarget(ID, request);
  assert.equal(h.releases.length, 1); assert.equal(h.sent.length, 0);
  assert.equal(h.receipts.isDeliveryCancelled(request.operationKey), true);
});
test('cancel rejects a foreign handoff/operation and never cancels a neighbouring receipt', async t => {
  const h = await fixture(t, { source: 'build-install-return' }); await h.activate();
  const receipt = h.receipts.get(h.identity.operationKey), request = cancelRequest(h.target());
  await assert.rejects(h.service.cancelTarget(ID, { ...request, handoffId: 'foreign' }), /cancel_identity_changed/);
  assert.equal(h.service.pending('worker'), true); assert.equal(h.releases.length, 0);
  await h.service.cancelTarget(ID, request);
  assert.deepEqual(h.receipts.get(h.identity.operationKey), receipt);
});
test('cancel during awaited new-input proof wins without synthetic completion or another input', async t => {
  const h = await fixture(t);
  h.controls.afterProof = async () => {
    h.controls.afterProof = null; await h.service.cancelTarget(ID, cancelRequest(h.target()));
  };
  await h.activate(); assert.equal(h.target().state, 'cancelled'); assert.equal(h.sent.length, 0);
  assert.equal(h.target().supersessionProof, undefined); assert.equal(h.releases.length, 1);
});
test('cancellation does not rewrite an already attempted UNKNOWN receipt', async t => {
  const h = await fixture(t, { source: 'build-install-return' }); await h.activate();
  const target = h.target(), request = { tabId: 'worker', provider: 'codex', expectedTarget: { toolType: 'codex', sessionId: 'A' },
    handoffId: target.handoffId, sendOperationKey: target.operationKey, source: 'build-install-continue:' + ID, prompt: 'continue' };
  const identity = { operationKey: target.operationKey, tabId: 'worker', handoffId: target.handoffId, provider: 'codex', sessionId: 'A',
    surface: 'desktop-history', requestFingerprint: fingerprintAgentSendRequest(request), promptHash: promptAuditFingerprint(request.prompt), promptLength: 8 };
  h.queue.enqueue({ identity, request }); const attempt = h.receipts.beginAttempt(identity);
  h.receipts.settleAttempt(identity.operationKey, attempt.attemptId, { submitted: true, deliveryUnknown: true, enterWritten: true });
  h.queue.finish(h.queue.item(target.operationKey), 'awaiting-receipt');
  assert.equal(h.queue.queueInfo(target.operationKey).inputSlot.state, 'held');
  const before = h.receipts.get(target.operationKey);
  await h.service.cancelTarget(ID, cancelRequest(target));
  const after = h.receipts.get(target.operationKey);
  assert.equal(after.state, before.state); assert.equal(after.attemptId, before.attemptId); assert.deepEqual(after.receipt, before.receipt);
  assert.equal(h.service.pending('worker'), false); assert(after.deliveryControl.cancelledAt);
  await h.queue.retireObsoleteInputSlot('worker');
  assert.equal(h.queue.queueInfo(target.operationKey).inputSlot.state, 'retired', 'explicit cancellation retires the physical slot while delivery remains unknown');
  h.reopen(); h.service.restore(); await h.service.reconcile(ID); assert.equal(h.sent.length, 0);
});
test('a failed durable cancellation write cannot acknowledge or emit a Loop wake', async t => {
  const h = await fixture(t, { source: 'build-install-return' }); await h.activate(); h.controls.writesFail = true;
  await assert.rejects(h.service.cancelTarget(ID, cancelRequest(h.target())), /save EIO/);
  assert.equal(h.releases.length, 0); assert.equal(h.sent.length, 0);
});

test('late callback/UNKNOWN cannot revive an already superseded target or request a second release', async t => {
  const h = await fixture(t); await h.activate();
  h.controls.source = 'orchestration-completion:late'; h.controls.revision = 'callback-later';
  h.controls.busy = true; h.controls.final = false;
  await h.service.reconcile(ID); h.reopen(); h.service.restore(); await h.service.reconcile(ID);
  assert.equal(h.target().state, 'superseded'); assert.equal(h.releases.length, 1); assert.equal(h.sent.length, 0);
});
for (const reason of ['result_interval_gap', 'result_lineage_unverified', 'result_cache_stale']) {
  test(reason + ' remains a bounded visible pending reason, never a guessed manual input', async t => {
    const h = await fixture(t, { source: 'build-install-return' }); h.controls.interval = reason; await h.activate();
    assert.equal(h.target().state, 'pending'); assert.equal(h.target().proofWait.stage, 'input-interval');
    assert.equal(h.target().proofWait.reason, reason); assert.equal(h.sent.length, 0);
  });
}

for (const kind of ['opaque-unknown-without-attempt', 'exact-no-submit']) test(kind + ' retains the original receipt meaning across journal recovery', async t => {
  const h = await fixture(t), target = h.target();
  h.receipts.reserveOrGet({ operationKey: target.operationKey, tabId: 'worker', provider: 'codex', sessionId: 'A',
    handoffId: target.handoffId, surface: 'desktop-history', requestFingerprint: 'old-exact-request',
    promptHash: promptAuditFingerprint('continue'), promptLength: 8 });
  if (kind === 'exact-no-submit') h.receipts.settleQueuedNoWrite(target.operationKey, { code: 'known-refusal' });
  else h.receipts.db.prepare("UPDATE agent_send_receipts SET state='delivery-unknown', receipt_json='{}' WHERE operation_key=?").run(target.operationKey);
  const before = h.receipts.get(target.operationKey); await h.activate();
  assert.equal(h.target().state, kind === 'exact-no-submit' ? 'unresolved' : 'unknown');
  assert.equal(h.service.pending('worker'), kind !== 'exact-no-submit'); assert.equal(h.sent.length, 0);
  assert.deepEqual(h.receipts.get(target.operationKey), before); assert.equal(h.target().supersessionProof, undefined);
});

module.exports = { fixture, ID };
