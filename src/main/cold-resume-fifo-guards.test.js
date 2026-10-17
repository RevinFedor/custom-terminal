'use strict';
// Actual Queue class / ReceiptStore methods. Manual-send fixtures only.
// Receipt normalization, audit production, assets and UI publication are not
// supplied. Their ports below must not be mistaken for canonical admission.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function declarations(file, names) {
  const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(n => ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name?.text === name)
      || (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(ast) === name)));
    assert.ok(node, 'actual declaration missing: ' + name); return node.getText(ast);
  }).join('\n');
}
function memoryDb() {
  try { const Database = require('better-sqlite3'); return new Database(':memory:'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    // Linux sandbox fallback only; this adapter runs real SQLite statements.
    // It is not the Electron/better-sqlite3 native driver used by the app.
    const db = new (require('node:sqlite').DatabaseSync)(':memory:');
    db.transaction = work => (...args) => {
      db.exec('BEGIN');
      try { const result = work(...args); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    return db;
  }
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function queueFixture() {
  const db = memoryDb(), records = new Map(), listeners = new Set();
  const store = { db, get: key => records.get(key),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    unpinForOwner() {},
    settleQueuedNoWrite(key, result) {
      const r = records.get(key); r.state = 'not-submitted'; r.receipt = result;
      for (const fn of listeners) fn(r);
      return { ok: true, record: r };
    },
  };
  const c = vm.createContext({ console: { log() {}, warn() {} }, queueMicrotask,
    isAutomaticNoWriteWait: () => false, hiddenSendPresentation: () => false,
    adoptCompletedQueueTransfers() {},
  });
  vm.runInContext(declarations('agent-send-queue.js', ['OPEN', 'ORDER', 'FAILED', 'consumed', 'AgentSendQueue'])
    + '\nglobalThis.Queue = AgentSendQueue;', c);
  const queue = new c.Queue({ store, execute: () => assert.fail('unexpected executor') });
  queue.publishRecord = () => {}; // UI/merge projection only; actual pump/finish/observe/wake are intact.
  const add = (key, patch = {}) => {
    const record = { operationKey: key, handoffId: 'H-' + key, tabId: 'T', provider: 'codex',
      state: 'reserved', attemptId: null, requestFingerprint: 'F-' + key, ...patch };
    records.set(key, record);
    db.prepare(`INSERT INTO agent_send_queue(operation_key,tab_id,request_hash,request_json,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run(key, 'T', 'F-' + key, JSON.stringify({ prompt: 'immutable-' + key }),
        record.attemptId ? 'awaiting-receipt' : 'waiting', 1, 1);
    return record;
  };
  const confirm = (key, attemptId = 'A-' + key) => {
    const r = records.get(key); r.attemptId = 'A-' + key; r.state = 'confirmed';
    r.auditIdentity = { attemptId, sessionId: 'source', entryUuid: 'U-' + key };
    queue.observe(r); return r;
  };
  return { db, queue, records, add, confirm,
    async close() { await flush(); queue.dispose(); db.close(); } };
}

test('actual FIFO: early canonical receipt cannot release a still-running physical scenario to its follower', async () => {
  const h = queueFixture(); h.add('one'); h.add('two');
  const calls = []; let release;
  h.queue.executors.set('one', async () => {
    calls.push('one'); h.records.get('one').attemptId = 'A-one';
    return new Promise(resolve => { release = resolve; });
  });
  h.queue.executors.set('two', async () => { calls.push('two'); h.confirm('two'); return { submitted: true }; });
  const first = h.queue.pump('T'); await flush();
  assert.equal(typeof release, 'function'); h.confirm('one'); await flush();
  assert.equal(h.queue.item('one').state, 'completed'); assert.equal(h.queue.running.has('T'), true);
  assert.deepEqual(calls, ['one']);
  release({ submitted: true }); await first; await flush();
  assert.deepEqual(calls, ['one', 'two']); assert.equal(h.queue.running.has('T'), false);
  assert.equal(h.queue.item('two').state, 'completed');
  assert.equal(JSON.parse(h.queue.item('one').request_json).prompt, 'immutable-one');
  await h.close();
});

for (const state of ['delivery-unknown', 'audit-pending', 'enter-armed']) {
  test('actual FIFO: ' + state + ' is never executed again or bypassed by a follower on ready wakes', async () => {
    const h = queueFixture(); h.add('one', { state, attemptId: 'A-one' }); h.add('two');
    let calls = 0;
    h.queue.executors.set('one', () => { calls++; }); h.queue.executors.set('two', () => { calls++; });
    await h.queue.pump('T'); h.queue.wake('T'); h.queue.notifyRuntime('T', 'ready-frame'); await flush();
    assert.equal(calls, 0); assert.equal(h.queue.item('one').state, 'awaiting-receipt');
    assert.equal(h.records.get('one').state, state); await h.close();
  });
}

test('actual FIFO: a foreign audit attempt cannot consume the head; the exact late audit can', async () => {
  const h = queueFixture(); h.add('one', { attemptId: 'A-one', state: 'audit-pending' }); h.add('two');
  let second = 0;
  h.queue.executors.set('two', () => { second++; h.confirm('two'); return { submitted: true }; });
  h.confirm('one', 'foreign'); await flush(); assert.equal(second, 0);
  h.confirm('one'); await flush(); assert.equal(second, 1); await h.close();
});

test('actual FIFO: definite no-write failure releases the original head, not a retry of its immutable prompt', async () => {
  const h = queueFixture(); h.add('one'); h.add('two'); const calls = [];
  h.queue.executors.set('one', () => {
    calls.push('one'); Object.assign(h.records.get('one'), { attemptId: 'A-one', state: 'not-submitted' });
    return { submitted: false, pasteWritten: false, enterWritten: false };
  });
  h.queue.executors.set('two', () => { calls.push('two'); h.confirm('two'); return { submitted: true }; });
  await h.queue.pump('T'); await flush();
  assert.deepEqual(calls, ['one', 'two']); assert.equal(h.queue.item('one').state, 'failed');
  assert.equal(h.records.get('one').attemptId, 'A-one'); await h.close();
});

test('actual FIFO: cancellation before an attempt is begun never dispatches the cancelled item', async () => {
  const h = queueFixture(); h.add('one', { deliveryControl: { cancelledAt: 1 } }); h.add('two'); const calls = [];
  h.queue.executors.set('one', () => calls.push('one'));
  h.queue.executors.set('two', () => { calls.push('two'); h.confirm('two'); return { submitted: true }; });
  await h.queue.pump('T'); await flush();
  assert.deepEqual(calls, ['two']); assert.equal(h.queue.item('one').state, 'cancelled'); await h.close();
});

function receiptMethod(name, record) {
  const source = fs.readFileSync(path.join(__dirname, 'agent-send-receipt-store.js'), 'utf8');
  const ast = ts.createSourceFile('store.js', source, ts.ScriptTarget.Latest, true);
  const owner = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'AgentSendReceiptStore');
  const method = owner.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(ast) === name);
  assert.ok(method); let writes = 0;
  const c = vm.createContext({
    // These string-valued states come from the supplied consumers. The missing
    // registry classifier is deliberately adversarial: it classifies a late
    // weak receipt as NOT_SUBMITTED. Only the STORE's own guard is under test.
    RECEIPT_STATES: { IN_FLIGHT: 'in-flight', NOT_SUBMITTED: 'not-submitted', PROVIDER_NOT_ACCEPTED: 'provider-not-accepted',
      DELIVERY_UNKNOWN: 'delivery-unknown', AUDIT_PENDING: 'audit-pending', CONFIRMED: 'confirmed' },
    classifyAgentSendRegistryReceipt: () => 'not-submitted', isExactProviderNotAcceptedReceipt: () => false,
  });
  vm.runInContext(declarations('agent-send-receipt-store.js', ['STORE_STATES', 'ACTIVE_ATTEMPT_STATES',
    'SETTLED_PRUNABLE_STATES', 'requiredString', 'encodeJson', 'exactSendPreflightScope', 'exactSendPreflightRefusal'])
    + '\nglobalThis.method = ({' + method.getText(ast) + '}).' + name + ';', c);
  const receiver = { db: { transaction: fn => fn }, _record: () => record,
    _observeDeliveryUnknown: x => x, statements: { settle: { run: () => { writes++; return { changes: 1 }; } } } };
  return { run: (...args) => c.method.apply(receiver, args), writes: () => writes };
}
for (const state of ['confirmed', 'delivery-unknown', 'audit-pending']) {
  test('actual ReceiptStore guard preserves ' + state + ' against a weaker late no-submit classification', () => {
    const record = { operationKey: 'O', attemptId: 'A', state, receipt: {} };
    const h = receiptMethod('settleAttempt', record);
    const result = h.run('O', 'A', { submitted: false, pasteWritten: false, enterWritten: false, status: 'not-submitted' });
    assert.equal(result.applied, false); assert.equal(result.record, record); assert.equal(record.state, state);
    assert.equal(h.writes(), 0);
  });
}

test('actual ReceiptStore guard rejects a stale attempt before changing an enter-armed record', () => {
  const record = { operationKey: 'O', attemptId: 'A', state: 'enter-armed', receipt: {} };
  const h = receiptMethod('settleAttempt', record); const result = h.run('O', 'foreign', { submitted: false });
  assert.equal(result.stale, true); assert.equal(h.writes(), 0);
});

test('actual ReceiptStore mark cannot move an enter-armed attempt back to in-flight', () => {
  const record = { operationKey: 'O', attemptId: 'A', state: 'enter-armed', receipt: {} };
  const h = receiptMethod('markAttemptState', record); const result = h.run('O', 'A', 'in-flight');
  assert.equal(result.reason, 'non-monotonic-attempt-state'); assert.equal(h.writes(), 0);
});
