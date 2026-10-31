'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { AgentSendQueue, hasCanonicalSendConsumption, hasApplicationSendConsumption } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createCompactOperationRegistry } = require('./compact-operation-state');
const { fingerprintAgentSendRequest } = require('./agent-send-receipt-registry');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { compactSendReceiptPresentation } = require('./compact-send-settlement');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
};

// Real receipt store, SQLite, FIFO and compact-operation owner. The finite
// provider boundary is controlled: no PTY, renderer, app, network or live DB.
function fixture(t, { prompt = '/compact', disk = false, stageContext = null } = {}) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'compact-fifo-private-')) : null;
  const filename = directory ? path.join(directory, 'receipts.sqlite') : ':memory:';
  let db = new Database(filename), now = 1000, attemptSequence = 0;
  let store, queue, pending;
  const compactReply = deferred(), calls = [], observations = [], terminal = {};
  const identity = request => ({ operationKey: request.sendOperationKey, surface: 'desktop-history',
    tabId: request.tabId, handoffId: request.handoffId, provider: request.provider,
    sessionId: null, requestFingerprint: fingerprintAgentSendRequest(request),
    promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length });
  const registry = createCompactOperationRegistry({ now: () => now,
    publish: operation => observations.push(store.observeCompactOperation(operation)) });
  const execute = async (request, scope) => {
    calls.push({ request, scope });
    const begun = store.beginAttempt(identity(request));
    assert.equal(begun.action, 'attempt-started');
    assert.equal(store.stageAttemptContext(request.sendOperationKey, begun.attemptId, {
      promptText: request.prompt, source: request.source,
      ...(stageContext ? stageContext(request, begun) : {}),
    }).ok, true);
    if (request.handoffId === 'compact') {
      pending = registry.armPending({ tabId: request.tabId, provider: 'codex', command: '/compact',
        operationId: 'codex:api:compact', handoffId: request.handoffId,
        sendOperationKey: request.sendOperationKey, sendAttemptId: begun.attemptId,
        sessionId: 'compact-session', generation: 'physical-owner:1', promptGeneration: 7,
        sourceByteOffset: 100, causalBoundaryEventSequence: 10, terminal,
        source: 'programmatic-live-slash', acceptedAt: now });
      assert.equal(store.bindCompactOperation(pending).ok, true);
      // Paste/Enter are deliberately not delivery proof.
      assert.equal(store.markAttemptState(request.sendOperationKey, begun.attemptId, 'enter-armed').ok, true);
      const reply = await compactReply.promise;
      store.settleAttempt(request.sendOperationKey, begun.attemptId, reply);
      return reply;
    }
    store.markAttemptState(request.sendOperationKey, begun.attemptId, 'enter-armed');
    const reply = { success: null, submitted: true, status: 'audit-pending', auditPending: true };
    store.settleAttempt(request.sendOperationKey, begun.attemptId, reply);
    return reply;
  };
  function open() {
    store = createAgentSendReceiptStore(db, { now: () => now, randomUUID: () => 'attempt-' + ++attemptSequence });
    queue = new AgentSendQueue({ store, execute, now: () => now });
  }
  open();
  t.after(async () => {
    compactReply.resolve({ success: null, submitted: true, status: 'delivery-unknown', deliveryUnknown: true });
    await tick();
    queue.dispose(); db.close();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (id, extra = {}) => ({ tabId: 'compact-tab', provider: 'codex', handoffId: id,
    sendOperationKey: 'history:compact-tab:' + id, source: 'history-panel',
    prompt: id === 'compact' ? prompt : 'ordinary text ' + id, ...extra });
  const add = (id, extra) => {
    const req = request(id, extra);
    return queue.enqueue({ identity: identity(req), request: req });
  };
  const record = (id = 'compact') => store.get('history:compact-tab:' + id);
  const startedOperation = () => ({ ...pending, active: true, pending: false,
    causalStartConfirmed: true, causalStartByteOffset: 101, causalStartEventSequence: 11 });
  const start = () => registry.confirmStart({ ...pending, sourceByteOffset: 101, eventSequence: 11 });
  const finish = () => {
    registry.observeCodexEvidence({ ...pending, kind: 'compacted', rolloutOffset: 102, eventSequence: 12 });
    registry.observeCodexEvidence({ ...pending, kind: 'task_complete', rolloutOffset: 103, eventSequence: 13 });
    return registry.finalizeCodexTaskComplete(pending);
  };
  const confirm = (id = 'text') => {
    const current = record(id);
    return store.promoteFromAudit({ success: true, operationKey: current.operationKey,
      attemptId: current.attemptId, provider: current.provider, sessionId: 'compact-session',
      promptHash: current.promptHash, actualHash: current.promptHash, expectedHash: current.promptHash,
      entryUuid: 'canonical-user-' + id, sourceIdentity: 'canonical-source-' + id,
      transcriptBoundary: { byteOffset: 104 } });
  };
  return { get db() { return db; }, get store() { return store; }, get queue() { return queue; },
    get pending() { return pending; }, registry, calls, observations, identity, request, add, record,
    start, finish, startedOperation, confirm, advance: milliseconds => { now += milliseconds; },
    reply: receipt => compactReply.resolve(receipt || { success: true, submitted: true,
      localSlashCommand: true, compactStartConfirmed: true, compactOperationId: pending.operationId,
      handoffId: pending.handoffId }),
    async reopen() {
      assert.ok(directory, 'reopen requires a private disk fixture');
      assert.equal(queue.running.size, 0, 'old executor must unwind before DB close');
      queue.dispose(); db.close(); db = new Database(filename); open();
      store.reconcileStartup(); queue.resume(); await tick();
    },
  };
}

test('causal native compact start releases FIFO before compact final, only after executor unwind', async t => {
  const f = fixture(t);
  assert.equal(f.add('compact').receipt.applicationQueued, true);
  const follower = f.add('text');
  const frozen = JSON.stringify(follower.record);
  f.add('third');
  await tick();
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact']);
  assert.equal(f.record().state, 'enter-armed');
  assert.equal(f.record().compactOperationBinding.kind, 'compact-send-binding');
  assert.equal(hasApplicationSendConsumption(f.record()), false, 'pre-write binding is not native acceptance');
  assert.equal(f.record().compactStartIdentity ?? null, null);
  assert.equal(f.record('text').attemptId, null);
  assert.equal(f.queue.item(f.record('text').operationKey).preparation_started_at, null);
  assert.equal(f.store.observeCompactOperation(f.pending).ok, false);
  assert.equal(f.record().compactStartIdentity ?? null, null, 'pending, paste and Enter do not mint proof');
  f.start();
  assert.equal(f.queue.item(f.record().operationKey).state, 'completed', 'native acceptance must consume compact FIFO head');
  assert.ok(f.record().compactStartIdentity, 'Main persisted exact causal native acceptance');
  assert.equal(f.record().auditIdentity, null, 'local compact never invents canonical user_message');
  assert.equal(hasCanonicalSendConsumption(f.record()), false, 'message/reply delivery keeps canonical-only semantics');
  assert.equal(hasApplicationSendConsumption(f.record()), true);
  assert.equal(f.record().receipt.coordinatedSettlement?.compact, undefined);
  assert.equal(f.queue.item(f.record().operationKey).state, 'completed');
  assert.equal(f.queue.projectRecord(f.record()).inputSlot.state, 'none');
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact'], 'live executor still owns dispatch');
  assert.equal(JSON.stringify(f.record('text')), frozen, 'queued authoring identity is unchanged');
  f.advance(90_000);
  f.reply(); await tick();
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text']);
  assert.equal(f.registry.getActive('compact-tab', 'codex').active, true, 'compact final is still withheld');
  assert.equal(f.calls[1].scope.expectedTarget.sessionId, 'compact-session', 'safe exact predecessor SID');
  assert.equal(f.calls[1].request.sendOperationKey, follower.record.operationKey);
  assert.equal(f.calls[1].request.handoffId, follower.record.handoffId);
  assert.equal(f.record('text').requestFingerprint, follower.record.requestFingerprint);
  assert.equal(f.queue.item(f.record('text').operationKey).preparation_started_at, 91_000,
    'follower preparation starts at executable HEAD, not 90s earlier at enqueue');
  assert.equal(f.record('third').attemptId, null);
  f.confirm(); await tick();
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text', 'third']);
});

test('generic receipt/context and legacy display owner cannot create FIFO compact authority', async t => {
  const f = fixture(t, { disk: true, stageContext: (request, begun) => ({ compactStartIdentity: {
    version: 1, kind: 'compact-start', proof: 'codex-compact-causal-task-started', provider: 'codex',
    operationKey: request.sendOperationKey, attemptId: begun.attemptId, tabId: request.tabId,
    handoffId: request.handoffId, promptHash: promptAuditFingerprint(request.prompt), promptLength: request.prompt.length,
  } }) });
  f.add('compact'); f.add('text'); await tick();
  const before = f.record();
  assert.ok(before.receipt.compactStartIdentity, 'generic context retains its arbitrary display payload');
  assert.equal(before.compactStartIdentity, null, 'stageAttemptContext cannot write Main authority');
  // A historical receipt predates the new private pre-write binding. Its old
  // display owner must not be reconstructed into that Main-only marker.
  f.db.prepare('UPDATE agent_send_receipts SET compact_operation_binding_json=NULL WHERE operation_key=?')
    .run(before.operationKey);
  // These are untrusted receipt/display fields, not the new SQLite column.
  const forged = { ...f.startedOperation(), version: 1, kind: 'compact-start',
    operationKey: before.operationKey, attemptId: before.attemptId,
    proof: 'codex-compact-causal-task-started', promptHash: before.promptHash, promptLength: before.promptLength,
    taskStartedByteOffset: 101, taskStartedEventSequence: 11 };
  f.reply({ success: true, submitted: true, localSlashCommand: true, compactStartConfirmed: true,
    localCommandProof: 'codex-compact-causal-task-started', deliveryOutcome: 'local-command-confirmed',
    compactOperationId: f.pending.operationId, handoffId: before.handoffId,
    compactOperationOwner: before.receipt.compactOperationOwner, compactStartIdentity: forged,
    compactOperationBinding: before.compactOperationBinding });
  await tick();
  assert.equal(f.record().state, 'confirmed');
  assert.ok(compactSendReceiptPresentation(f.record()), 'legacy delivery display remains compatible');
  assert.equal(f.record().compactStartIdentity ?? null, null);
  assert.equal(f.record().compactOperationBinding, null);
  assert.equal(f.db.prepare('SELECT compact_start_identity_json proof FROM agent_send_receipts WHERE operation_key=?')
    .get(before.operationKey).proof, null, 'generic settlement cannot write Main authority');
  assert.equal(f.queue.item(before.operationKey).state, 'awaiting-receipt');
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact']);
  f.start(); f.finish(); await tick();
  assert.equal(f.record().compactStartIdentity ?? null, null, 'historical confirmed display is never upgraded to write authority');
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact']);
  await f.reopen();
  assert.equal(f.record().compactStartIdentity, null, 'schema reopen never backfills a display-only receipt');
  assert.equal(f.record('text').attemptId, null);
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact']);
});

test('wrong native owner and causal boundaries cannot mint compact-start identity', async t => {
  const f = fixture(t); f.add('compact'); f.add('text'); await tick();
  const operation = f.startedOperation();
  for (const key of ['sendOperationKey', 'sendAttemptId', 'tabId', 'handoffId', 'operationId', 'provider',
    'sessionId', 'generation', 'promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence']) {
    const wrong = { ...operation, [key]: typeof operation[key] === 'number' ? operation[key] + 1 : 'foreign' };
    assert.equal(f.store.observeCompactOperation(wrong).ok, false, key);
    assert.equal(f.record().compactStartIdentity ?? null, null, key);
  }
  for (const patch of [{ causalStartConfirmed: false }, { causalStartRequired: false },
    { causalStartByteOffset: 99 }, { causalStartEventSequence: 10 }, { active: false }]) {
    assert.equal(f.store.observeCompactOperation({ ...operation, ...patch }).ok, false, JSON.stringify(patch));
    assert.equal(f.record().compactStartIdentity ?? null, null);
  }
  assert.equal(f.record().state, 'enter-armed');
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact']);
  f.start(); assert.ok(f.record().compactStartIdentity);
});

test('private proof is exact original /compact text, including accepted whitespace bytes', async t => {
  for (const prompt of ['ordinary text', '/compact summary', '/compact\nordinary text']) {
    const f = fixture(t, { prompt }); f.add('compact'); f.add('text'); await tick();
    f.start(); f.reply(); await tick();
    assert.equal(f.record().compactStartIdentity ?? null, null, prompt);
    assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact'], prompt);
  }
  const f = fixture(t, { prompt: ' \t/compact  ' }); f.add('compact'); f.add('text'); await tick();
  f.start();
  assert.equal(f.record().compactStartIdentity.promptHash, promptAuditFingerprint(' \t/compact  '));
  assert.equal(f.record().compactStartIdentity.promptLength, ' \t/compact  '.length);
  f.reply(); await tick(); assert.equal(f.calls.length, 2);
});

test('changed staged text cannot borrow the immutable original prompt identity', async t => {
  const f = fixture(t); f.add('compact'); f.add('text'); await tick();
  f.db.prepare('UPDATE agent_send_receipts SET receipt_json=? WHERE operation_key=?')
    .run(JSON.stringify({ ...f.record().receipt, promptText: ' /compact ' }), f.record().operationKey);
  f.start(); f.reply(); await tick();
  assert.equal(f.record().compactStartIdentity ?? null, null);
  assert.equal(f.calls.length, 1);
});

test('verified native start survives late failure, duplicate observation and SQLite reopen without replay', async t => {
  const f = fixture(t, { disk: true }); f.add('compact'); f.add('text'); await tick();
  const operation = f.start(), proof = f.record().compactStartIdentity;
  assert.ok(proof);
  f.reply({ success: false, submitted: false, status: 'not-submitted', error: 'late-generic-error' });
  await tick();
  assert.equal(f.record().state, 'confirmed');
  assert.deepEqual(f.record().compactStartIdentity, proof);
  assert.equal(f.store.observeCompactOperation(operation).applied, false);
  assert.equal(f.store.beginAttempt(f.identity(f.request('compact'))).action, 'replay');
  assert.equal(f.record().attempt, 1);
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text']);
  await f.reopen();
  assert.deepEqual(f.record().compactStartIdentity, proof);
  assert.equal(f.record().auditIdentity, null);
  assert.equal(f.queue.item(f.record().operationKey).state, 'completed');
  assert.equal(f.add('compact').replayed, true);
  f.queue.wake('compact-tab'); await tick();
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text']);
  assert.equal(f.record('text').attempt, 1);
});

test('actual UNKNOWN compact without causal native start holds followers across SQLite reopen', async t => {
  const f = fixture(t, { disk: true }); f.add('compact'); f.add('text'); await tick();
  f.reply({ success: null, submitted: true, status: 'delivery-unknown', deliveryUnknown: true }); await tick();
  assert.equal(f.record().state, 'delivery-unknown');
  assert.equal(f.record().compactStartIdentity ?? null, null);
  assert.equal(f.record('text').attemptId, null);
  await f.reopen();
  f.queue.wake('compact-tab'); await tick();
  assert.equal(f.record().state, 'delivery-unknown');
  assert.equal(f.record().compactStartIdentity ?? null, null);
  assert.equal(f.record('text').attemptId, null);
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact']);
});

test('a failed native-start SQLite write recovers only from the same newly bound operation after generic confirmation', async t => {
  const f = fixture(t); f.add('compact'); f.add('text'); await tick();
  const operationKey = f.record().operationKey, attemptId = f.record().attemptId;
  f.db.exec(`CREATE TRIGGER fail_compact_start BEFORE UPDATE OF compact_start_identity_json ON agent_send_receipts
    WHEN NEW.compact_start_identity_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'private-start-storage-failure'); END;`);
  assert.throws(() => f.start(), /private-start-storage-failure/);
  const native = f.registry.getActive('compact-tab', 'codex');
  assert.equal(native.causalStartConfirmed, true, 'native task_started already occurred without replay');
  assert.equal(f.record().compactStartIdentity, null, 'failed SQLite update creates no authority');
  f.db.exec('DROP TRIGGER fail_compact_start');
  f.reply({ success: true, submitted: true, localSlashCommand: true, compactStartConfirmed: true,
    compactOperationId: native.operationId, handoffId: native.handoffId });
  await tick();
  assert.equal(f.record().state, 'confirmed', 'generic executor reply arrived after storage recovered');
  assert.equal(f.record().compactStartIdentity, null, 'generic reply is still not authority');
  assert.equal(hasApplicationSendConsumption(f.record()), false, 'private binding alone is never FIFO acceptance');
  assert.equal(f.record('text').attemptId, null);
  assert.equal(f.store.observeCompactOperation(native).applied, true, 'same exact native fact can now persist');
  await tick();
  assert.equal(f.record().operationKey, operationKey); assert.equal(f.record().attemptId, attemptId);
  assert.equal(f.record().attempt, 1); assert.equal(f.record().auditIdentity, null);
  assert.ok(f.record().compactStartIdentity);
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text']);
  assert.equal(f.store.observeCompactOperation(native).applied, false);
  await tick(); assert.equal(f.calls.length, 2);
});

test('private pre-write binding must match immutable request and native owner before recovery', async t => {
  const f = fixture(t); f.add('compact'); f.add('text'); await tick();
  const original = f.record().compactOperationBinding, operation = f.startedOperation();
  const setBinding = binding => f.db.prepare('UPDATE agent_send_receipts SET compact_operation_binding_json=? WHERE operation_key=?')
    .run(JSON.stringify(binding), f.record().operationKey);
  const invalid = [
    ...['version', 'kind', 'requestFingerprint', 'promptHash', 'promptLength'].map(key => ({ ...original,
      [key]: typeof original[key] === 'number' ? original[key] + 1 : 'foreign' })),
    ...['operationId', 'tabId', 'handoffId', 'provider', 'sessionId', 'generation', 'promptGeneration',
      'sourceByteOffset', 'causalBoundaryEventSequence', 'sendOperationKey', 'sendAttemptId'].map(key => ({ ...original,
      owner: { ...original.owner, [key]: typeof original.owner[key] === 'number' ? original.owner[key] + 1 : 'foreign' } })),
  ];
  for (const binding of invalid) {
    setBinding(binding); f.store.observeCompactOperation(operation);
    assert.equal(f.record().compactStartIdentity, null, JSON.stringify(binding));
    assert.equal(hasApplicationSendConsumption(f.record()), false);
    assert.equal(f.record('text').attemptId, null);
  }
  setBinding(original);
  assert.equal(f.store.observeCompactOperation(operation).applied, true);
  f.reply(); await tick();
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text']);
});

test('late exact native start promotes the same UNKNOWN attempt without replaying compact', async t => {
  const f = fixture(t); f.add('compact'); f.add('text'); await tick();
  const attemptId = f.record().attemptId;
  f.reply({ success: null, submitted: true, status: 'delivery-unknown', deliveryUnknown: true }); await tick();
  assert.equal(f.record().state, 'delivery-unknown');
  assert.equal(f.calls.length, 1);
  f.start(); await tick();
  assert.equal(f.record().state, 'confirmed');
  assert.equal(f.record().attemptId, attemptId);
  assert.equal(f.record().attempt, 1);
  assert.ok(f.record().compactStartIdentity);
  assert.deepEqual(f.calls.map(call => call.request.handoffId), ['compact', 'text']);
});

test('fresh beginAttempt clears a stale private identity instead of transferring native proof', async t => {
  const f = fixture(t); f.add('compact'); await tick(); f.start(); f.reply(); await tick();
  const proof = f.record().compactStartIdentity;
  const binding = f.record().compactOperationBinding;
  assert.ok(proof);
  const request = f.request('new'), identity = f.identity(request);
  assert.equal(f.store.reserveOrGet(identity).ok, true);
  // A private stale-row fixture exercises the additive migration/reset guard;
  // no application API can import this field from a generic request/receipt.
  f.db.prepare('UPDATE agent_send_receipts SET compact_start_identity_json=?,compact_operation_binding_json=? WHERE operation_key=?')
    .run(JSON.stringify(proof), JSON.stringify(binding), identity.operationKey);
  const started = f.store.beginAttempt(identity);
  assert.equal(started.action, 'attempt-started');
  assert.equal(started.record.compactStartIdentity, null);
  assert.equal(started.record.compactOperationBinding, null);
  assert.equal(f.db.prepare('SELECT compact_start_identity_json proof FROM agent_send_receipts WHERE operation_key=?')
    .get(identity.operationKey).proof, null);
  assert.deepEqual(f.record().compactStartIdentity, proof, 'reset never changes a different receipt owner');
});
