'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const Database = require('better-sqlite3');
const { createAgentSendReceiptStore } = require('./agent-send-receipt-store');
const { createCompactOperationRegistry } = require('./compact-operation-state');
const receiptApi = require('./agent-send-receipt-registry');
const { compactSendReceiptPresentation } = require('./compact-send-settlement');

function reader(name) {
  const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  return { source, ast, fn: name => ast.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast) };
}
const main = reader('main.js'), web = reader('web-server.js');
const tabId = 'L1VzZXJzL2ZlZG9yL0Rlc2t0b3AvaGgtdG9vbA==-tab-367';
const handoffId = 'B5C2ECA4-39F2-4564-BE72-8B5BED7F6016';
const sessionId = '019efa1f-1866-72c3-94a8-90d034d3e326';

function fixture(t, { disk = false } = {}) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'compact-receipt-test-')) : null;
  const file = disk ? path.join(directory, 'receipts.sqlite') : ':memory:';
  let db = new Database(file), store = createAgentSendReceiptStore(db);
  t.after(() => { db.close(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  const identity = { operationKey: `project:${tabId}:${handoffId}`, surface: 'project-api',
    tabId, handoffId, provider: 'codex', sessionId: null,
    requestFingerprint: 'exact-request', promptHash: 'unused-for-compact-proof', promptLength: 8 };
  const attempt = store.beginAttempt(identity);
  const published = [];
  const context = vm.createContext({
    agentSendReceiptStore: store, createCompactOperationRegistry,
    compactOperationSubscribers: new Set(),
    aiBoundaryTestGate: { claim: () => ({ claimed: false }) },
    console: { log() {}, warn() {}, error() {} },
    mainWindow: { isDestroyed: () => false, webContents: { send(_name, operation) { published.push(operation); } } },
    _webBroadcast() {}, scheduleProjectActivityBroadcast() {},
  });
  // Execute the ACTUAL registry publisher, not a parallel test-only hook.
  const declaration = main.ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(main.ast) === 'compactOperations'));
  vm.runInContext(main.fn('persistCompactSendReceipt') + '\n' + declaration.getText(main.ast), context);
  const registry = vm.runInContext('compactOperations', context);
  const pending = registry.armPending({ tabId, provider: 'codex', command: '/compact',
    operationId: 'codex:api:' + handoffId, handoffId, sessionId, generation: 'physical-runtime:1',
    promptGeneration: 7, terminal: {}, sourceByteOffset: 128980507, causalBoundaryEventSequence: 1289,
    sendOperationKey: identity.operationKey, sendAttemptId: attempt.attemptId,
    acceptedAt: Date.parse('2026-09-30T09:16:08.544Z'), source: 'programmatic-live-slash' });
  assert.equal(store.bindCompactOperation(pending).ok, true);
  const start = () => registry.confirmStart({ tabId, provider: 'codex', operationId: pending.operationId,
    sessionId, generation: pending.generation, terminal: pending.terminal,
    sourceByteOffset: pending.sourceByteOffset, eventSequence: 1290 });
  const finish = () => {
    // Synthetic causal offsets with the captured incident's owner/receipt shape.
    registry.observeCodexEvidence({ ...pending, kind: 'compacted', rolloutOffset: pending.sourceByteOffset + 100, eventSequence: 1291 });
    registry.observeCodexEvidence({ ...pending, kind: 'task_complete', rolloutOffset: pending.sourceByteOffset + 200, eventSequence: 1292 });
    return registry.finalizeCodexTaskComplete(pending);
  };
  const lateReply = (coordinatedSettlement = null) => store.settleAttempt(identity.operationKey, attempt.attemptId, {
    success: true, submitted: true, localSlashCommand: true, compactStartConfirmed: true,
    localCommandProof: 'codex-compact-causal-task-started', compactStartProof: 'task_started-after-programmatic-slash',
    compactEnterCount: 1, compactOperationId: pending.operationId, handoffId, coordinatedSettlement,
  });
  return { get store() { return store; }, get db() { return db; }, registry, pending, context,
    attempt, identity, start, finish, lateReply, published,
    record: () => store.get(identity.operationKey),
    reopen() { db.close(); db = new Database(file); store = createAgentSendReceiptStore(db); store.reconcileStartup(); },
  };
}

async function httpReceipt(store) {
  const context = vm.createContext({ agentSendReceiptStore: store, agentSendReceiptStartupReady: Promise.resolve(),
    compactSendReceiptPresentation,
    AGENT_SEND_RECEIPT_STATES: receiptApi.RECEIPT_STATES,
    isAgentSendProviderQueueAccepted: () => false,
    decId: decodeURIComponent, cleanOptionalString: value => String(value || '').trim(),
    req: { method: 'GET' }, res: {}, m: null,
    parsed: { pathname: '/api/terminal-tabs/' + encodeURIComponent(tabId) + '/send-receipts', query: { handoffId } },
    sendJson: (_res, status, body) => ({ status, body }),
  });
  vm.runInContext(['durableRecordHasProviderQueueAcceptance', 'durableAgentSendReplay', 'publicAgentSendReceipt']
    .map(web.fn).join('\n'), context);
  const begin = web.source.indexOf('  m = parsed.pathname.match(/^\\/api\\/terminal-tabs\\/([^/]+)\\/send-receipts$/);');
  const end = web.source.indexOf('\n  // Send prompt to a project terminal tab.', begin);
  assert.ok(begin > 0 && end > begin);
  return vm.runInContext('(async () => { ' + web.source.slice(begin, end) + ' })()', context);
}

test('same physical compact completion is durable before public event, then GET survives real DB close/reopen', async t => {
  const f = fixture(t, { disk: true });
  f.context.compactOperationSubscribers.add(operation => {
    if (operation.outcome === 'completed') assert.equal(f.record().receipt.coordinatedSettlement.compact.settled, true);
  });
  f.start(); f.lateReply();
  assert.equal(f.record().receipt.coordinatedSettlement, null, 'accepted command is not finished compact');
  const operation = f.finish();
  const first = await httpReceipt(f.store);
  assert.equal(first.status, 200);
  const result = first.body.receipts[0], settled = result.coordinatedSettlement.compact;
  assert.equal(settled.version, 1); assert.equal(settled.outcome, 'completed');
  assert.equal(settled.proof, 'rollout-compacted-before-task-complete');
  assert.equal(settled.operationId, operation.operationId);
  assert.equal(settled.operationKey, f.identity.operationKey);
  assert.equal(settled.attemptId, f.attempt.attemptId);
  assert.equal(settled.handoffId, handoffId); assert.equal(settled.tabId, tabId);
  assert.equal(settled.sessionId, sessionId); assert.equal(settled.generation, f.pending.generation);
  assert.equal(settled.settledAt, operation.endedAt);
  assert.equal(result.status, 'sent'); assert.equal(result.compactEnterCount, 1);
  assert.equal(result.entryUuid, null); assert.equal(result.sourceIdentity, null);
  assert.equal(f.record().auditIdentity, null, 'no forged user_message audit');
  f.reopen();
  assert.deepEqual(JSON.parse(JSON.stringify((await httpReceipt(f.store)).body)), JSON.parse(JSON.stringify(first.body)));
  assert.equal(createCompactOperationRegistry().snapshot(tabId).active, null, 'durable receipt does not resurrect live compact');
});

test('completed-before-reply, late null coordinator, duplicate and restart cannot regress or create another attempt', t => {
  const f = fixture(t, { disk: true }); f.start(); const op = f.finish();
  const settled = f.record().receipt.coordinatedSettlement.compact;
  f.lateReply(); f.lateReply({ settled: true, reason: 'send-settled', stopped: false });
  assert.deepEqual(f.record().receipt.coordinatedSettlement.compact, settled);
  assert.equal(f.record().receipt.coordinatedSettlement.reason, 'send-settled');
  assert.equal(f.record().receipt.compactEnterCount, 1);
  assert.equal(f.store.observeCompactOperation(op).applied, false);
  f.reopen();
  assert.equal(f.store.beginAttempt(f.identity).action, 'replay');
  assert.equal(f.record().attempt, 1);
  assert.deepEqual(f.record().receipt.coordinatedSettlement.compact, settled);
});

test('late failed reply and a forged terminal event cannot replace the exact completed result', t => {
  const f = fixture(t); f.start(); const op = f.finish();
  const before = f.record().receipt;
  f.store.settleAttempt(f.identity.operationKey, f.attempt.attemptId, {
    success: false, submitted: false, localSlashCommand: true,
    compactOperationId: op.operationId, handoffId, error: 'late-transport-failure', coordinatedSettlement: null,
  });
  assert.deepEqual(f.record().receipt, before);
  assert.equal(f.store.observeCompactOperation({ ...op, endedAt: op.endedAt + 1 }).ok, false);
  assert.deepEqual(f.record().receipt, before);
});

test('legacy sent-only receipt without a bound operation is not upgraded by matching command or handoff text', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE agent_send_receipts SET receipt_json = ?, state = ? WHERE operation_key = ?')
    .run(JSON.stringify({ success: true, submitted: true, compactStartConfirmed: true,
      compactOperationId: f.pending.operationId, handoffId, localSlashCommand: true }), 'confirmed', f.identity.operationKey);
  f.start(); f.finish();
  assert.equal(f.record().receipt.coordinatedSettlement?.compact, undefined,
    'no historical owner/generation reconstruction from a sent-only receipt');
});

// Exact relevant wire fields captured from old B5 GET on 02.10. No synthetic
// session/generation/offsets: these are the fields the legacy receipt LOST.
const legacyB5 = Object.freeze({
  tabId, toolType: 'codex', provider: 'codex', handoffId,
  operationKey: `project:${tabId}:${handoffId}`,
  attemptId: '76db1ae4-80b6-40ba-a3ad-dce5cbf6d6c6',
  success: true, accepted: true, submitted: true, status: 'sent', receiptState: 'confirmed',
  compactStartConfirmed: true, compactEnterCount: 1,
  compactStartProof: 'task_started-after-programmatic-slash', localSlashCommand: true,
  localCommandProof: 'codex-compact-causal-task-started',
  compactOperationId: 'codex:api:' + handoffId, deliveryOutcome: 'local-command-confirmed',
  coordinatedSettlement: null, sessionId: null, entryUuid: null, sourceIdentity: null,
  createdAt: 1790759768454, updatedAt: 1790759768847, settledAt: 1790759768847,
});

test('real legacy B5 HTTP GET classifies operation-only presentation without completion, migration or current SID', async t => {
  const f = fixture(t, { disk: true });
  f.db.prepare(`UPDATE agent_send_receipts SET receipt_json=?, state='confirmed', attempt_id=?,
    created_at=?,updated_at=?,settled_at=? WHERE operation_key=?`)
    .run(JSON.stringify(legacyB5), legacyB5.attemptId, legacyB5.createdAt,
      legacyB5.updatedAt, legacyB5.settledAt, f.identity.operationKey);
  const before = JSON.stringify(f.record());
  const first = (await httpReceipt(f.store)).body.receipts[0];
  assert.equal(first.serviceCommand.kind, 'compact');
  assert.equal(first.serviceCommand.historyPresentation, 'operation-only');
  assert.equal(first.serviceCommand.delivery, 'confirmed');
  assert.equal(first.serviceCommand.deliveryProof, legacyB5.localCommandProof);
  for (const key of ['operationKey', 'attemptId', 'handoffId', 'tabId']) {
    assert.equal(first.serviceCommand[key], legacyB5[key], key);
  }
  assert.equal(first.serviceCommand.operationId, legacyB5.compactOperationId);
  assert.equal(first.serviceCommand.historyScope, null, 'no current/saved/fork SID inference');
  assert.equal(first.coordinatedSettlement, null, 'no invented completion');
  assert.equal(first.sessionId, null); assert.equal(first.entryUuid, null);
  assert.equal(first.sourceIdentity, null);
  assert.equal(first.createdAt, legacyB5.createdAt); assert.equal(first.updatedAt, legacyB5.updatedAt);
  assert.equal(JSON.stringify(f.record()), before, 'GET is a pure projection, not a data repair');
  f.reopen();
  assert.deepEqual(JSON.parse(JSON.stringify((await httpReceipt(f.store)).body.receipts[0])),
    JSON.parse(JSON.stringify(first)), 'same delivery presentation survives DB reopen');
  assert.equal(JSON.stringify(f.record()), before);
});

test('bound service scope is historical compact owner, independent of completion and current conversation', async t => {
  const f = fixture(t); f.start();
  const started = (await httpReceipt(f.store)).body.receipts[0];
  assert.equal(started.serviceCommand.historyScope.sessionId, sessionId);
  assert.equal(started.serviceCommand.historyScope.generation, f.pending.generation);
  assert.equal(started.serviceCommand.historyScope.sourceByteOffset, f.pending.sourceByteOffset);
  assert.equal(started.coordinatedSettlement?.compact, undefined);
  f.finish();
  const completed = (await httpReceipt(f.store)).body.receipts[0];
  assert.deepEqual(completed.serviceCommand, started.serviceCommand,
    'presentation classification does not claim/change terminal outcome');
  assert.equal(completed.coordinatedSettlement.compact.outcome, 'completed');
});

test('ordinary, unknown, unsent, partial and foreign proofs never get service-command hiding authority', () => {
  const record = { ...legacyB5, state: 'confirmed', receipt: { ...legacyB5 }, auditIdentity: null };
  assert.ok(compactSendReceiptPresentation(record));
  for (const state of ['reserved', 'preparing', 'in-flight', 'enter-armed', 'audit-pending',
    'delivery-unknown', 'not-submitted', 'provider-not-accepted']) {
    assert.equal(compactSendReceiptPresentation({ ...record, state }), null, state);
  }
  for (const patch of [{ provider: 'claude' }, { attemptId: '' }, { handoffId: 'foreign' },
    { tabId: 'foreign' }, { operationKey: 'foreign' },
    { auditIdentity: { sessionId: 'canonical', entryUuid: 'real-user' } }]) {
    assert.equal(compactSendReceiptPresentation({ ...record, ...patch }), null, JSON.stringify(patch));
  }
  for (const patch of [{ success: false }, { submitted: null }, { localSlashCommand: false },
    { deliveryUnknown: true }, { auditPending: true }, { queued: true }, { providerAccepted: false },
    { compactStartConfirmed: false }, { compactOperationId: '' }, { handoffId: 'foreign' },
    { localCommandProof: 'ordinary-user-audit' }, { deliveryOutcome: 'audit-confirmed' },
    { entryUuid: 'real-user' }, { sourceIdentity: 'real-source' }, { sourceIdentityAliases: ['real-source'] },
    { attemptId: 'foreign' }, { provider: 'claude' }, { toolType: 'claude' }]) {
    assert.equal(compactSendReceiptPresentation({ ...record, receipt: { ...legacyB5, ...patch } }), null,
      JSON.stringify(patch));
  }
  assert.equal(compactSendReceiptPresentation({ ...record, receipt: { promptText: '/compact' } }), null,
    'command spelling/title/time cannot classify a receipt');
});

test('incomplete or foreign bound owner cannot supply a historical scope', t => {
  const f = fixture(t); f.start();
  const record = f.record();
  const owner = record.receipt.compactOperationOwner;
  for (const field of ['version', 'sendOperationKey', 'sendAttemptId', 'operationId', 'tabId', 'handoffId',
    'provider', 'sessionId', 'generation', 'promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence']) {
    const invalid = { ...owner, [field]: typeof owner[field] === 'number' ? -1 : '' };
    assert.equal(compactSendReceiptPresentation({ ...record,
      receipt: { ...record.receipt, compactOperationOwner: invalid } }), null, field);
  }
});

test('GET never forwards stale stored service presentation on an unconfirmed receipt', async t => {
  const f = fixture(t);
  f.db.prepare('UPDATE agent_send_receipts SET receipt_json=? WHERE operation_key=?')
    .run(JSON.stringify({ serviceCommand: { historyPresentation: 'operation-only', kind: 'compact' } }), f.identity.operationKey);
  assert.equal((await httpReceipt(f.store)).body.receipts[0].serviceCommand, undefined);
});

test('pending and causal start without terminal proof never retire the local compact journal', t => {
  const f = fixture(t, { disk: true });
  assert.equal(f.store.observeCompactOperation(f.pending).ok, false);
  assert.equal(f.record().receipt.coordinatedSettlement, undefined);
  f.start(); f.reopen();
  assert.equal(f.record().state, 'confirmed', 'accepted local command remains non-retryable');
  assert.equal(f.record().receipt.coordinatedSettlement?.compact, undefined);
});

for (const kind of ['task-complete-only', 'telemetry-only', 'interrupted', 'superseded', 'unknown', 'compacted-after-complete']) {
  test(kind + ' cannot manufacture a completed settlement', t => {
    const f = fixture(t); f.start();
    if (kind === 'task-complete-only' || kind === 'telemetry-only' || kind === 'compacted-after-complete') {
      if (kind === 'telemetry-only') f.registry.observeCodexEvidence({ ...f.pending, kind: 'context_compacted', rolloutOffset: f.pending.sourceByteOffset + 1 });
      f.registry.observeCodexEvidence({ ...f.pending, kind: 'task_complete', rolloutOffset: f.pending.sourceByteOffset + 2 });
      if (kind === 'compacted-after-complete') f.registry.observeCodexEvidence({ ...f.pending, kind: 'compacted', rolloutOffset: f.pending.sourceByteOffset + 3 });
      f.registry.finalizeCodexTaskComplete(f.pending);
    } else f.registry.finish({ ...f.pending, outcome: kind === 'interrupted' ? 'aborted' : 'unknown', reason: kind });
    assert.equal(f.record().receipt.coordinatedSettlement?.compact, undefined);
  });
}

test('foreign attempt, handoff, operation, session, generation and causal boundaries cannot settle another owner', t => {
  const f = fixture(t); f.start();
  const op = { ...f.pending, pending: false, active: false, outcome: 'completed', reason: 'compacted',
    completionProof: 'rollout-compacted-before-task-complete', causalStartConfirmed: true,
    causalStartByteOffset: f.pending.sourceByteOffset, causalStartEventSequence: 1290,
    codexCompactedOffset: f.pending.sourceByteOffset + 1, codexTaskCompleteOffset: f.pending.sourceByteOffset + 2,
    endedAt: Date.now() };
  for (const key of ['sendOperationKey', 'sendAttemptId', 'tabId', 'handoffId', 'operationId', 'provider', 'sessionId', 'generation',
    'promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence']) {
    const wrong = { ...op, [key]: typeof op[key] === 'number' ? op[key] + 1 : 'foreign' };
    assert.equal(f.store.observeCompactOperation(wrong).ok, false, key);
    assert.equal(f.record().receipt.coordinatedSettlement?.compact, undefined, key);
  }
  for (const patch of [{ causalStartConfirmed: false }, { pending: true }, { completionProof: 'task_complete' },
    { codexCompactedOffset: op.sourceByteOffset }, { codexTaskCompleteOffset: op.codexCompactedOffset },
    { causalStartEventSequence: 1289 }, { endedAt: null }]) {
    assert.equal(f.store.observeCompactOperation({ ...op, ...patch }).ok, false, JSON.stringify(patch));
  }
  assert.equal(f.store.observeCompactOperation(op).ok, true);
});

test('same command in a second handoff has its own uncompleted receipt; no text equality or current SID lookup', t => {
  const f = fixture(t); f.start(); f.finish();
  const second = { ...f.identity, operationKey: 'project:other', handoffId: 'other', requestFingerprint: 'second' };
  const attempt = f.store.beginAttempt(second);
  const op = { ...f.pending, handoffId: 'other', operationId: 'codex:api:other',
    sendOperationKey: second.operationKey, sendAttemptId: attempt.attemptId };
  assert.equal(f.store.bindCompactOperation(op).ok, true);
  assert.equal(f.store.get(second.operationKey).receipt.coordinatedSettlement?.compact, undefined);
  assert.equal(f.record().receipt.coordinatedSettlement.compact.handoffId, handoffId);
});
