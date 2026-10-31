'use strict';

// Bounded Main FIFO fault tests: real SQLite, receipt store, queue and actual
// web preparation functions. Build admission and renderer bridge are controlled
// leaves; this is not a native provider/PTY acceptance test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { AgentSendQueue } = require('./agent-send-queue');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const registry = require('./agent-send-receipt-registry');
const preparation = require('./agent-send-preparation');
const { promptAuditFingerprint } = require('./prompt-audit-fingerprint');
const { createFakeClock } = require('./fixtures/codex-draft-request-observation.cjs');

const source = fs.readFileSync(path.join(__dirname, 'web-server.js'), 'utf8');
const tree = ts.createSourceFile('web-server.js', source, ts.ScriptTarget.Latest, true);
const declaration = name => {
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, `actual declaration ${name}`);
  return node.getText(tree);
};
const webCode = ['durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay',
  'durableAgentSendFailure', 'runPreparedAgentSendScenario', 'readScenarioDestination',
  'prepareQueuedBuildContinueInput'].map(declaration).join('\n');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noted-send-deferred-fault-'));
  const file = path.join(root, 'queue.sqlite');
  const clock = createFakeClock(1000), queues = [], databases = [], locks = [], releases = [];
  const calls = { admissions: [], producers: [], bridges: [] };
  const control = { ready: false, queueReady: true, preparationStatus: 'active', onAdmission: null,
    onPublication: null, bridgeResult: null };
  class ClockDate extends Date { static now() { return clock.now(); } }
  let db, store, queue, context;
  const request = id => ({ tabId: 'T', provider: 'codex', handoffId: id,
    sendOperationKey: 'project:T:' + id, sendSurface: 'project-api', prompt: 'frozen ' + id,
    source: 'build-install-continue:operation', queue: true, ownership: 'project' });
  const identity = req => {
    // Web's receipt fingerprint describes the logical send; the queue hash
    // describes the entire frozen request. They are deliberately different.
    const requestFingerprint = registry.fingerprintAgentSendRequest({ prompt: req.prompt,
      model: req.model || null, effort: req.effort || null, thinking: req.thinking || null,
      cwd: req.cwd || null, source: req.source || null, queue: req.queue === true,
      ownership: req.ownership || null });
    assert.notEqual(requestFingerprint, registry.fingerprintAgentSendRequest(req));
    return { operationKey: req.sendOperationKey, surface: req.sendSurface,
      tabId: req.tabId, handoffId: req.handoffId, provider: req.provider, sessionId: null,
      requestFingerprint, promptHash: promptAuditFingerprint(req.prompt), promptLength: req.prompt.length };
  };
  const open = () => {
    db = new Database(file, { timeout: 0 }); databases.push(db);
    db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 0');
    store = createAgentSendReceiptStore(db, { now: clock.now });
    const owner = {
      admit: async req => {
        calls.admissions.push(req.handoffId);
        if (control.onAdmission) return await control.onAdmission(req);
        return control.ready;
      },
      prepareInput: async (_operation, tabId) => {
        calls.producers.push(tabId);
        return { descriptor: { projectId: 'P', toolType: 'codex', sessionId: 'S' } };
      },
    };
    const inspect = () => ({ known: true, exists: true, toolType: 'codex',
      runtime: { known: true, status: control.preparationStatus } });
    context = vm.createContext({ require, path, srcMainDir: __dirname, Date: ClockDate,
      ...preparation, ...registry, agentSendReceiptStore: store,
      agentSendReceiptRegistry: registry.createAgentSendReceiptRegistry({ now: clock.now }),
      agentSendReceiptStartupReady: Promise.resolve(), AGENT_SEND_RECEIPT_STATES: registry.RECEIPT_STATES,
      promptAuditFingerprint, agentSendBridgeTimeoutMs: 1000,
      compactSendReceiptPresentation: require('./compact-send-settlement').compactSendReceiptPresentation,
      isLocalSlashCommandPrompt: require('./agent-history-send-receipt').isLocalSlashCommandPrompt,
      agentSendTargetPreconditionFailure: require('./agent-send-target-precondition').agentSendTargetPreconditionFailure,
      scenarioDestination: require('./agent-message-identity').scenarioDestination,
      withPromptOriginPresentation: value => value,
      tabWorkContext: null, shortId: value => value,
      console: { log() {}, warn() {}, error() {} },
      captureTabInspection: inspect,
      getBuildContinueOperations: () => owner,
      findOrchestrationTabDescriptor: () => ({ projectId: 'P', toolType: 'codex', sessionId: 'S' }),
      bridgeRequest: async (action, payload) => {
        assert.equal(action, 'sendAgentPromptScenario');
        calls.bridges.push(payload);
        if (control.bridgeResult) return control.bridgeResult(payload);
        return { success: null, submitted: true, auditPending: true, status: 'audit-pending' };
      },
    });
    require('./test-helpers/agent-send-web-bindings.cjs').installAgentSendWebBindings(context, tree);
    vm.runInContext(webCode, context);
    const buildContinueAdmission = vm.runInContext('BUILD_CONTINUE_ADMISSION', context);
    const makeQueue = () => {
      const q = new AgentSendQueue({ store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        ready: () => control.queueReady,
        capturePreparationMode: req => preparation.selectSendPreparationMode(req.provider, inspect(req.tabId)),
        publish: record => control.onPublication?.(record),
        execute: (req, scope) => context.runPreparedAgentSendScenario({ ...req,
          applicationQueueExecution: true, sendRequestFingerprint: scope.requestFingerprint,
          // Match the real startup executor: a JSON-restored Build request
          // receives its exact private capability again, not a public flag.
          ...(String(req.source || '').startsWith('build-install-continue:')
            ? { [buildContinueAdmission]: true } : {}),
          prepareSend: () => context.prepareQueuedBuildContinueInput(req, 'operation') }) });
      queues.push(q); context.agentSendQueue = q; return q;
    };
    queue = makeQueue();
    return { makeQueue };
  };
  let factory = open();
  t.after(async () => {
    for (const release of releases) release();
    for (const lock of locks) if (lock.open) { if (lock.inTransaction) lock.exec('ROLLBACK'); lock.close(); }
    for (const q of queues) q.dispose();
    await flush();
    for (const handle of databases) if (handle.open) handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { file, clock, calls, control, request, identity,
    get db() { return db; }, get store() { return store; }, get queue() { return queue; },
    add(id) { const req = request(id); const result = queue.enqueue({ identity: identity(req), request: req });
      assert.equal(result.ok, true); return result; },
    lock() { const other = new Database(file, { timeout: 0 }); locks.push(other);
      other.pragma('busy_timeout = 0'); other.exec('BEGIN IMMEDIATE'); return other; },
    onCleanup(release) { releases.push(release); },
    newQueueSameDb() { queue = factory.makeQueue(); return queue; },
    reopen() { queue.dispose(); db.close(); factory = open(); store.reconcileStartup(); return queue; },
  };
}

function snapshot(h, id) {
  const item = h.queue.item(h.request(id).sendOperationKey), record = h.store.get(item.operation_key);
  return { id: item.id, position: item.queue_position ?? item.id, request: item.request_json,
    hash: item.request_hash, handoffId: record.handoffId, operationKey: record.operationKey,
    attemptId: record.attemptId, preparation: record.receipt.activeHeadPreparation };
}

test('SQLite BUSY after real preparation deferral retains exact unattempted head until runtime wake', async t => {
  const h = fixture(t); let locked;
  h.control.onAdmission = async () => { locked = h.lock(); return false; };
  h.add('head'); h.add('follower'); await flush();
  assert.ok(locked?.inTransaction, 'second SQLite connection holds the write lock');
  const original = snapshot(h, 'head');
  assert.throws(() => h.db.prepare('UPDATE agent_send_queue SET state=state WHERE operation_key=?')
    .run(original.operationKey), error => error.code === 'SQLITE_BUSY', 'the lock is a real SQLite write failure');
  assert.equal(h.queue.item(original.operationKey).state, 'dispatching');
  assert.equal(h.store.get(original.operationKey).state, 'preparing');
  assert.equal(original.attemptId, null);
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
  await flush(); assert.equal(h.calls.admissions.length, 1, 'no self-pump on failed parking');
  locked.exec('ROLLBACK'); h.control.onAdmission = null; h.control.ready = true;
  h.queue.notifyRuntime('T'); await flush();
  assert.deepEqual(snapshot(h, 'head').request, original.request);
  assert.equal(h.queue.item(original.operationKey).id, original.id);
  assert.equal(h.queue.item(original.operationKey).request_hash, original.hash);
  assert.equal(h.queue.item(original.operationKey).queue_position ?? original.id, original.position);
  assert.equal(h.store.get(original.operationKey).handoffId, original.handoffId);
  assert.ok(h.store.get(original.operationKey).attemptId);
  // After beginAttempt the receipt keeps its timing in the issued preflight
  // scope (not necessarily in the pre-attempt activeHeadPreparation field).
  assert.equal(h.store.get(original.operationKey).receipt.preflightScope.preparation.startedAt, original.preparation.startedAt);
  assert.equal(h.store.get(original.operationKey).receipt.preflightScope.preparation.deadlineAt, original.preparation.deadlineAt);
  assert.deepEqual(h.calls.bridges.map(row => row.handoffId), ['head']);
  assert.equal(h.queue.item(h.request('follower').sendOperationKey).state, 'waiting');
});

test('SQLITE_BUSY before receipt preparation retains the dispatch start when it later parks', async t => {
  const h = fixture(t); let locked;
  h.control.onPublication = record => {
    if (!locked && record.applicationQueue?.state === 'dispatching') locked = h.lock();
  };
  h.add('head'); await flush();
  const original = snapshot(h, 'head');
  assert.ok(locked?.inTransaction);
  assert.equal(h.queue.item(original.operationKey).state, 'dispatching');
  assert.equal(h.queue.item(original.operationKey).preparation_started_at, 1000);
  assert.equal(h.store.get(original.operationKey).state, 'reserved');
  assert.equal(original.preparation, undefined); assert.equal(original.attemptId, null);
  locked.exec('ROLLBACK'); h.control.onPublication = null;
  h.clock.advance(15000); h.queue.notifyRuntime('T'); await flush();
  const after = snapshot(h, 'head');
  assert.equal(h.queue.item(original.operationKey).state, 'waiting');
  assert.equal(after.id, original.id); assert.equal(after.hash, original.hash);
  assert.equal(after.preparation.startedAt, 1000); assert.equal(after.preparation.deadlineAt, 61000);
  assert.equal(h.calls.admissions.length, 1);
  h.clock.advance(45000); await flush();
  assert.equal(h.store.get(original.operationKey).receipt.code, 'agent_send_preparation_expired');
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
});

test('an unprepared head expires at its original deadline after SQLite unlock without a runtime wake', async t => {
  const h = fixture(t); let locked;
  h.control.onPublication = record => {
    if (!locked && record.applicationQueue?.state === 'dispatching') locked = h.lock();
  };
  h.add('head'); await flush();
  const original = snapshot(h, 'head'), item = h.queue.item(original.operationKey);
  assert.ok(locked?.inTransaction);
  assert.equal(item.state, 'dispatching');
  assert.equal(item.preparation_started_at, 1000);
  assert.equal(h.store.get(original.operationKey).state, 'reserved');
  assert.equal(original.preparation, undefined); assert.equal(original.attemptId, null);
  assert.notEqual(h.store.get(original.operationKey).requestFingerprint, item.request_hash);
  locked.exec('ROLLBACK'); h.control.onPublication = null;
  h.control.ready = true;
  h.clock.advance(60000); await flush();
  const record = h.store.get(original.operationKey);
  assert.equal(record.state, 'not-submitted');
  assert.equal(record.receipt.code, 'agent_send_preparation_expired');
  assert.equal(record.handoffId, original.handoffId); assert.equal(record.operationKey, original.operationKey);
  assert.equal(record.attemptId, null);
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
});

for (const [initial, next, mode, deadline] of [
  ['active', 'inactive', 'warm', 61000],
  ['inactive', 'active', 'cold-codex', 121000],
]) {
  test('SQLITE_BUSY before receipt preparation keeps the original ' + mode + ' mode after ' + initial + ' → ' + next, async t => {
    const h = fixture(t); let locked;
    h.control.preparationStatus = initial;
    h.control.onPublication = record => {
      if (!locked && record.applicationQueue?.state === 'dispatching') locked = h.lock();
    };
    h.add('head'); await flush();
    const original = snapshot(h, 'head');
    assert.ok(locked?.inTransaction);
    assert.equal(h.queue.item(original.operationKey).state, 'dispatching');
    assert.equal(h.store.get(original.operationKey).state, 'reserved');
    assert.equal(original.preparation, undefined); assert.equal(original.attemptId, null);
    assert.equal(h.queue.item(original.operationKey).preparation_started_at, 1000);
    const firstMode = h.queue.item(original.operationKey).preparation_mode;
    h.control.preparationStatus = next;
    locked.exec('ROLLBACK'); h.control.onPublication = null;
    h.clock.advance(15000); h.queue.notifyRuntime('T'); await flush();
    const after = snapshot(h, 'head');
    assert.equal(h.queue.item(original.operationKey).state, 'waiting');
    assert.equal(after.id, original.id); assert.equal(after.hash, original.hash); assert.equal(after.attemptId, null);
    assert.equal(after.preparation.mode, mode, 'inspection after the original head dispatch must not reclassify the intent');
    assert.equal(after.preparation.startedAt, 1000); assert.equal(after.preparation.deadlineAt, deadline);
    assert.equal(firstMode, mode, 'the mode must already be durable at the first dispatch');
    assert.equal(h.queue.item(original.operationKey).preparation_mode, mode, 'mode belongs to the durable dispatch start');
    assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
  });
}

test('cancellation committed before a crash defeats recovery of dispatching pre-attempt head', async t => {
  const h = fixture(t); let locked;
  h.control.onAdmission = async () => { locked = h.lock(); return false; };
  h.add('head'); await flush(); const original = snapshot(h, 'head');
  locked.exec('ROLLBACK');
  assert.equal(h.store.cancelDelivery({ operationKey: original.operationKey, tabId: 'T',
    handoffId: original.handoffId, attemptId: null, reason: 'manual-stop', notify: false }).ok, true);
  assert.equal(h.queue.item(original.operationKey).state, 'dispatching', 'simulate crash before projection');
  h.control.onAdmission = null; h.control.ready = true;
  h.reopen().resume(); await flush();
  const receipt = h.store.get(original.operationKey);
  assert.equal(h.queue.item(original.operationKey).state, 'cancelled');
  assert.equal(receipt.state, 'not-submitted'); assert.equal(receipt.attemptId, null);
  assert.ok(receipt.deliveryControl.cancelledAt);
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
});

test('SQLite reopen keeps an unrecorded completed capture parked under its original FIFO position', async t => {
  const h = fixture(t); let locked;
  h.control.onAdmission = async () => { locked = h.lock(); return false; };
  h.add('head'); h.add('follower'); await flush();
  const original = snapshot(h, 'head'), follower = snapshot(h, 'follower');
  assert.equal(h.queue.item(original.operationKey).state, 'dispatching');
  locked.exec('ROLLBACK'); h.control.onAdmission = null;
  h.reopen().resume(); await flush();
  assert.equal(h.queue.item(original.operationKey).state, 'waiting');
  assert.deepEqual(snapshot(h, 'head'), original);
  assert.deepEqual(snapshot(h, 'follower'), follower);
  assert.deepEqual(h.calls.bridges, []);
  h.control.ready = true; h.queue.notifyRuntime('T'); await flush();
  assert.ok(h.store.get(original.operationKey).receipt.continuationInputCapture);
  assert.equal(h.store.get(original.operationKey).receipt.continuationInputHold, undefined);
  assert.deepEqual(h.calls.bridges, [], 'after reopen the marker cannot prove which capture returned');
  assert.equal(h.queue.item(original.operationKey).id, original.id);
  assert.equal(h.queue.item(follower.operationKey).state, 'waiting');
});

test('SQLite reopen retries a completed no-proof preparation whose marker was durably cleared', async t => {
  const h = fixture(t);
  h.add('head'); h.add('follower'); await flush();
  const original = snapshot(h, 'head'), follower = snapshot(h, 'follower');
  assert.equal(h.queue.item(original.operationKey).state, 'waiting');
  assert.equal(h.store.get(original.operationKey).receipt.continuationInputCapture, undefined);
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
  h.reopen().resume(); await flush();
  assert.deepEqual(snapshot(h, 'head'), original); assert.deepEqual(snapshot(h, 'follower'), follower);
  h.control.ready = true; h.queue.notifyRuntime('T'); await flush();
  assert.deepEqual(h.calls.bridges.map(row => row.handoffId), ['head']);
  assert.equal(h.queue.item(original.operationKey).id, original.id);
  assert.equal(h.queue.item(follower.operationKey).state, 'waiting');
});

for (const outcome of ['in-flight', 'enter-armed', 'delivery-unknown']) {
  test('restart does not recover an attempted ' + outcome + ' as unattempted', async t => {
    const h = fixture(t); h.control.queueReady = false;
    h.add('head'); h.add('follower'); await flush();
    const original = snapshot(h, 'head'), req = h.request('head');
    assert.equal(h.store.markPreparing(original.operationKey).ok, true);
    const attempt = h.store.beginAttempt(h.identity(req));
    assert.equal(attempt.action, 'attempt-started');
    if (outcome !== 'in-flight') h.store.markAttemptState(original.operationKey, attempt.attemptId, 'enter-armed');
    if (outcome === 'delivery-unknown') h.store.settleAttempt(original.operationKey, attempt.attemptId,
      { submitted: true, success: null, status: 'delivery-unknown', deliveryUnknown: true });
    h.db.prepare("UPDATE agent_send_queue SET state='dispatching' WHERE operation_key=?").run(original.operationKey);
    h.control.queueReady = true; h.reopen().resume(); await flush();
    const record = h.store.get(original.operationKey);
    assert.equal(record.attemptId, attempt.attemptId);
    assert.notEqual(h.queue.item(original.operationKey).state, 'waiting');
    assert.equal(h.calls.bridges.some(row => row.handoffId === 'head'), false);
    if (outcome !== 'in-flight') {
      assert.equal(record.state, 'delivery-unknown');
      assert.equal(h.queue.item(h.request('follower').sendOperationKey).state, 'waiting');
      assert.deepEqual(h.calls.bridges, []);
    }
  });
}

for (const unsafe of ['unknown-without-attempt', 'request-fingerprint-changed']) {
  test('restart does not recover unproven dispatching head: ' + unsafe, async t => {
    const h = fixture(t); h.control.queueReady = false;
    h.add('head'); h.add('follower'); await flush();
    const original = snapshot(h, 'head');
    assert.equal(h.store.markPreparing(original.operationKey).ok, true);
    if (unsafe === 'unknown-without-attempt') {
      assert.equal(h.store.stageQueuedRequest(original.operationKey, { deliveryUnknown: true }).ok, true);
    } else {
      const changed = JSON.stringify({ ...JSON.parse(original.request), prompt: 'foreign bytes' });
      h.db.prepare('UPDATE agent_send_queue SET request_json=? WHERE operation_key=?').run(changed, original.operationKey);
    }
    h.db.prepare("UPDATE agent_send_queue SET state='dispatching' WHERE operation_key=?").run(original.operationKey);
    h.control.queueReady = true; h.control.ready = true; h.reopen().resume(); await flush();
    assert.equal(h.queue.item(original.operationKey).state, 'dispatching');
    assert.equal(h.store.get(original.operationKey).attemptId, null);
    assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
    assert.equal(h.queue.item(h.request('follower').sendOperationKey).state, 'waiting');
  });
}

test('disposed queue holds its dispatch lease until the old preparation actually unwinds', async t => {
  const h = fixture(t), held = gate(), entered = gate();
  let active = 0, maximum = 0;
  h.control.onAdmission = async () => {
    active++; maximum = Math.max(maximum, active);
    try { if (h.calls.admissions.length === 1) { entered.resolve(); await held.promise; return false; } return true; }
    finally { active--; }
  };
  h.onCleanup(() => held.resolve());
  h.add('head'); await entered.promise;
  const original = snapshot(h, 'head'); const old = h.queue;
  old.dispose(); const replacement = h.newQueueSameDb(); replacement.resume(); await flush();
  assert.equal(h.calls.admissions.length, 1); assert.equal(h.calls.producers.length, 0);
  assert.equal(h.calls.bridges.length, 0); assert.equal(replacement.item(original.operationKey).state, 'dispatching');
  held.resolve(); await flush();
  assert.equal(maximum, 1, 'two queue instances must never overlap preparation');
  assert.deepEqual(h.calls.bridges.map(row => row.handoffId), ['head']);
  assert.equal(replacement.item(original.operationKey).id, original.id);
  assert.equal(replacement.item(original.operationKey).request_hash, original.hash);
});

test('repeated runtime wakes never renew the persisted deadline; expiry does not call the producer', async t => {
  const h = fixture(t); h.add('head'); await flush();
  const original = snapshot(h, 'head');
  assert.equal(original.preparation.startedAt, 1000);
  assert.equal(original.preparation.deadlineAt, 61000);
  for (const delta of [10000, 10000, 10000]) {
    h.clock.advance(delta); h.queue.notifyRuntime('T'); await flush();
    assert.deepEqual(snapshot(h, 'head').preparation, original.preparation);
    assert.equal(h.store.get(original.operationKey).attemptId, null);
  }
  h.reopen().resume(); await flush();
  assert.deepEqual(snapshot(h, 'head').preparation, original.preparation, 'reopen cannot restart the clock');
  const admissions = h.calls.admissions.length;
  h.control.ready = true; // No readiness event: expiry itself must not invoke the producer.
  h.clock.advance(30000); await flush();
  const record = h.store.get(original.operationKey);
  assert.equal(record.state, 'not-submitted');
  assert.equal(record.receipt.code, 'agent_send_preparation_expired');
  assert.equal(record.attemptId, null); assert.equal(h.queue.item(original.operationKey).state, 'failed');
  assert.equal(h.calls.admissions.length, admissions, 'expiry is failure-only, not a readiness event');
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
  h.control.ready = true; h.queue.notifyRuntime('T'); await flush();
  assert.deepEqual(h.calls.bridges, []);
});

test('expiry blocked by SQLite retains its owner and fails without input on the next runtime wake', async t => {
  const h = fixture(t); let locked;
  h.control.onAdmission = async () => { locked = h.lock(); return false; };
  h.add('head'); await flush();
  const original = snapshot(h, 'head');
  assert.equal(original.preparation.deadlineAt, 61000);
  h.clock.advance(60000); await flush();
  assert.equal(h.store.get(original.operationKey).state, 'preparing');
  locked.exec('ROLLBACK'); await flush();
  const parked = snapshot(h, 'head');
  assert.deepEqual(parked, original, 'storage failure cannot settle or change the original intent');
  assert.equal(h.store.get(original.operationKey).state, 'preparing');
  h.control.onAdmission = null; h.control.ready = true;
  h.queue.notifyRuntime('T'); await flush();
  assert.equal(h.store.get(original.operationKey).state, 'not-submitted');
  assert.equal(h.store.get(original.operationKey).receipt.code, 'agent_send_preparation_expired');
  assert.equal(h.store.get(original.operationKey).attemptId, null);
  assert.deepEqual(h.calls.producers, []); assert.deepEqual(h.calls.bridges, []);
});

test('certified automatic no-write A1 can start A2 with a fresh lifetime after its old deadline', async t => {
  const h = fixture(t); h.control.ready = true;
  const req = { ...h.request('automatic'), source: 'prompt-queue', promptQueueIntent: {
    version: 1, kind: 'queue', itemId: 'item', armedAt: 1, triggerTabId: 'T', conditionKey: '-', triggerKey: 'null' } };
  h.control.bridgeResult = payload => {
    if (h.calls.bridges.length > 1) return { success: null, submitted: true, auditPending: true, status: 'audit-pending' };
    return h.queue.certifyAutomaticReadinessWait({ tabId: payload.tabId, handoffId: payload.handoffId,
      operationKey: payload.sendOperationKey, attemptId: payload.sendAttemptId }, {
      success: false, deferred: true, submitted: false, pasteWritten: false, enterWritten: false,
      error: 'codex_input_not_ready' });
  };
  assert.equal(h.queue.enqueue({ identity: h.identity(req), request: req }).ok, true);
  await flush();
  const first = h.store.get(req.sendOperationKey), item = h.queue.item(req.sendOperationKey);
  assert.equal(item.state, 'waiting'); assert.equal(first.state, 'not-submitted');
  assert.ok(first.attemptId); assert.equal(first.receipt.automaticReadinessWait, 1);
  assert.equal(first.receipt.pasteWritten, false); assert.equal(first.receipt.enterWritten, false);
  assert.equal(h.calls.bridges.length, 1);
  h.clock.advance(61000); await flush();
  assert.equal(h.calls.bridges.length, 1, 'old expiry is not a new trigger');
  h.queue.notifyRuntime('T'); await flush();
  const second = h.store.get(req.sendOperationKey), after = h.queue.item(req.sendOperationKey);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(after.id, item.id); assert.equal(after.request_hash, item.request_hash);
  assert.equal(h.calls.bridges.length, 2);
  assert.equal(h.calls.bridges[1].preflightScope.preparation.startedAt, 62000);
  assert.equal(h.calls.bridges[1].preflightScope.preparation.deadlineAt, 122000);
});
