'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const {
  STORE_STATES,
  TABLE_NAME,
  createAgentSendReceiptStore,
} = require('./agent-send-receipt-store');

function identity(overrides = {}) {
  return {
    operationKey: 'project:tab-a:handoff-a',
    surface: 'project-api',
    runId: null,
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    requestFingerprint: 'request-a',
    provider: 'codex',
    sessionId: 'session-a',
    promptHash: 'hash-a',
    promptLength: 12,
    ...overrides,
  };
}

function exactAudit(attemptId, overrides = {}) {
  return {
    success: true,
    operationKey: 'project:tab-a:handoff-a',
    attemptId,
    provider: 'codex',
    sessionId: 'session-a',
    promptHash: 'hash-a',
    expectedHash: 'hash-a',
    entryUuid: 'entry-a',
    transcriptBoundary: { byteOffset: 42, line: 7 },
    ...overrides,
  };
}

function openMemoryHarness(t, options = {}) {
  let db;
  try {
    db = new Database(':memory:');
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return null;
    }
    throw error;
  }
  t.after(() => db.close());
  let uuid = 0;
  const store = createAgentSendReceiptStore(db, {
    randomUUID: () => `attempt-${++uuid}`,
    ...options,
  });
  return { db, store, getUuidCount: () => uuid };
}

test('schema creation is non-destructive and reserve is idempotent but changed identity conflicts', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { db, store } = harness;
  db.exec('CREATE TABLE unrelated_state (value TEXT); INSERT INTO unrelated_state VALUES (\'keep\')');

  const first = store.reserveOrGet(identity());
  const replay = store.reserveOrGet(identity());
  const conflict = store.reserveOrGet(identity({ requestFingerprint: 'changed', promptHash: 'changed' }));

  assert.equal(first.action, 'reserved');
  assert.equal(first.record.state, STORE_STATES.RESERVED);
  assert.equal(replay.action, 'replay');
  assert.equal(replay.retryable, true);
  assert.equal(conflict.action, 'conflict');
  assert.deepEqual(conflict.mismatchedFields, ['requestFingerprint', 'promptHash']);
  assert.equal(db.prepare('SELECT value FROM unrelated_state').get().value, 'keep');
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(TABLE_NAME));

  createAgentSendReceiptStore(db);
  assert.equal(store.list().length, 1, 'opening the store again preserves existing receipts');
});

test('beginAttempt creates one exact attempt and pending/unknown/confirmed states only replay', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store, getUuidCount } = harness;
  const begun = store.beginAttempt(identity());
  const duplicate = store.beginAttempt(identity());

  assert.equal(begun.action, 'attempt-started');
  assert.equal(begun.attemptId, 'attempt-1');
  assert.equal(begun.record.attempt, 1);
  assert.equal(duplicate.action, 'replay');
  assert.equal(duplicate.record.attemptId, 'attempt-1');
  assert.equal(getUuidCount(), 1);

  const pending = store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  assert.equal(pending.record.state, STORE_STATES.AUDIT_PENDING);
  const replay = store.beginAttempt(identity());
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attempt, 1);
  assert.equal(getUuidCount(), 1);
});

test('proven not-submitted retries with a new attempt, clears session A, and late audit binds B', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const first = store.beginAttempt(identity({ sessionId: 'session-a' }));
  const stopped = store.settleAttempt(first.record.operationKey, first.attemptId, {
    success: false,
    submitted: false,
    code: 'launch-not-accepted',
  });
  assert.equal(stopped.record.state, STORE_STATES.NOT_SUBMITTED);

  const retry = store.beginAttempt(identity({ sessionId: null }));
  assert.equal(retry.action, 'attempt-started');
  assert.equal(retry.record.attempt, 2);
  assert.equal(retry.record.sessionId, null);
  assert.notEqual(retry.attemptId, first.attemptId);

  store.settleAttempt(retry.record.operationKey, retry.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  const promoted = store.promoteFromAudit(exactAudit(retry.attemptId, {
    sessionId: 'session-b',
  }));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
  assert.equal(promoted.record.sessionId, 'session-b');
  assert.equal(promoted.record.auditIdentity.sessionId, 'session-b');
  assert.deepEqual(promoted.record.transcriptBoundary, { byteOffset: 42, line: 7 });
});

test('settleAttempt is an attempt CAS and a stale callback cannot roll back a retry', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const first = store.beginAttempt(identity());
  store.settleAttempt(first.record.operationKey, first.attemptId, {
    success: false,
    submitted: false,
  });
  const second = store.beginAttempt(identity({ sessionId: null }));

  const stale = store.settleAttempt(first.record.operationKey, first.attemptId, {
    success: true,
    submitted: true,
    status: 'sent',
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.record.attemptId, second.attemptId);
  assert.equal(stale.record.state, STORE_STATES.IN_FLIGHT);

  const current = store.settleAttempt(second.record.operationKey, second.attemptId, {
    success: null,
    submitted: null,
    status: 'delivery-unknown',
    deliveryUnknown: true,
  });
  assert.equal(current.applied, true);
  assert.equal(current.record.state, STORE_STATES.DELIVERY_UNKNOWN);
});

test('enter-armed cannot move backwards to in-flight', (t) => {
  const fixture = openMemoryHarness(t);
  if (!fixture) return;
  const request = identity();
  const started = fixture.store.beginAttempt(request);
  assert.equal(
    fixture.store.markAttemptState(
      request.operationKey,
      started.attemptId,
      STORE_STATES.ENTER_ARMED,
    ).ok,
    true,
  );

  const backwards = fixture.store.markAttemptState(
    request.operationKey,
    started.attemptId,
    STORE_STATES.IN_FLIGHT,
  );
  assert.equal(backwards.ok, false);
  assert.equal(backwards.reason, 'non-monotonic-attempt-state');
  assert.equal(fixture.store.get(request.operationKey).state, STORE_STATES.ENTER_ARMED);
});

test('restart changes only in-flight and enter-armed attempts to durable delivery-unknown', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-receipts-'));
  const filename = path.join(root, 'receipts.sqlite');
  let db;
  try {
    db = new Database(filename);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  let uuid = 0;
  let store = createAgentSendReceiptStore(db, { randomUUID: () => `restart-${++uuid}` });
  const active = store.beginAttempt(identity());
  store.markAttemptState(active.record.operationKey, active.attemptId, STORE_STATES.ENTER_ARMED);
  store.reserveOrGet(identity({
    operationKey: 'reserved-op',
    handoffId: 'reserved-handoff',
    requestFingerprint: 'reserved-request',
  }));
  store.reserveOrGet(identity({
    operationKey: 'preparing-op',
    handoffId: 'preparing-handoff',
    requestFingerprint: 'preparing-request',
  }));
  store.markPreparing('preparing-op');
  db.close();

  db = new Database(filename);
  store = createAgentSendReceiptStore(db, { randomUUID: () => `restart-${++uuid}` });
  const reconciled = store.reconcileStartup();
  assert.equal(reconciled.changed, 1);
  assert.equal(store.get(active.record.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(store.get(active.record.operationKey).receipt.code, 'agent_send_restart_during_delivery');
  assert.equal(store.get('reserved-op').state, STORE_STATES.RESERVED);
  assert.equal(store.get('preparing-op').state, STORE_STATES.PREPARING);

  const replay = store.beginAttempt(identity());
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attemptId, active.attemptId, 'restart never authorizes a blind retry');
  const resumedReservation = store.beginAttempt(identity({
    operationKey: 'preparing-op',
    handoffId: 'preparing-handoff',
    requestFingerprint: 'preparing-request',
  }));
  assert.equal(resumedReservation.action, 'attempt-started');
});

test('only exact current attempt/provider/session/hash audit promotes and late callback cannot undo it', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity());

  for (const variant of [
    { attemptId: 'foreign-attempt', field: 'attemptId' },
    { provider: 'claude', field: 'provider' },
    { sessionId: 'foreign-session', field: 'sessionId' },
    { promptHash: 'foreign-hash', field: 'promptHash' },
    { expectedHash: 'foreign-hash', field: 'expectedHash' },
  ]) {
    const verdict = store.promoteFromAudit(exactAudit(attempt.attemptId, variant));
    assert.equal(verdict.promoted, false);
    assert.ok(verdict.mismatchedFields.includes(variant.field));
  }

  const promoted = store.promoteFromAudit(exactAudit(attempt.attemptId));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
  assert.equal(promoted.record.receipt.exactAuditConfirmed, true);

  const callback = store.settleAttempt(attempt.record.operationKey, attempt.attemptId, {
    success: false,
    submitted: false,
    code: 'late-timeout',
  });
  assert.equal(callback.applied, false);
  assert.equal(callback.reason, 'already-confirmed');
  assert.equal(store.get(attempt.record.operationKey).state, STORE_STATES.CONFIRMED);
});

test('unresolved proof survives prune and reopen while old settled proof is prunable', (t) => {
  let time = 1_000;
  const harness = openMemoryHarness(t, {
    now: () => time,
    settledRetentionMs: 100,
  });
  if (!harness) return;
  const { store } = harness;
  const unknown = store.beginAttempt(identity());
  store.settleAttempt(unknown.record.operationKey, unknown.attemptId, {
    success: null,
    submitted: null,
    status: 'delivery-unknown',
    deliveryUnknown: true,
  });

  const confirmedIdentity = identity({
    operationKey: 'confirmed-op',
    handoffId: 'confirmed-handoff',
    requestFingerprint: 'confirmed-request',
  });
  const confirmed = store.beginAttempt(confirmedIdentity);
  store.settleAttempt(confirmed.record.operationKey, confirmed.attemptId, {
    success: true,
    submitted: true,
    status: 'sent',
  });

  time = 1_101;
  const pruned = store.prune();
  assert.equal(pruned.deleted, 1);
  assert.equal(store.get('confirmed-op'), null);
  assert.equal(store.get(unknown.record.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
  const replay = store.beginAttempt(identity());
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attempt, 1);
});

test('an unresolved receipt remains non-retryable after a real SQLite close and reopen', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-send-unresolved-'));
  const filename = path.join(root, 'receipts.sqlite');
  let db;
  try {
    db = new Database(filename);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }
  t.after(() => {
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  let time = 100;
  let store = createAgentSendReceiptStore(db, {
    now: () => time,
    settledRetentionMs: 10,
    randomUUID: () => 'persistent-attempt',
  });
  const attempt = store.beginAttempt(identity());
  store.settleAttempt(attempt.record.operationKey, attempt.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  db.close();

  time = 10_000;
  db = new Database(filename);
  store = createAgentSendReceiptStore(db, {
    now: () => time,
    settledRetentionMs: 10,
    randomUUID: () => {
      throw new Error('an unresolved replay must not allocate a retry attempt');
    },
  });
  assert.equal(store.prune().deleted, 0);
  const replay = store.beginAttempt(identity());
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.state, STORE_STATES.AUDIT_PENDING);
  assert.equal(replay.record.attemptId, 'persistent-attempt');
});

test('capacity fails before a new attempt or UUID while unresolved records remain durable', (t) => {
  const harness = openMemoryHarness(t, { maxRecords: 1 });
  if (!harness) return;
  const { store, getUuidCount } = harness;
  const first = store.beginAttempt(identity());
  store.settleAttempt(first.record.operationKey, first.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  const capacity = store.beginAttempt(identity({
    operationKey: 'second-op',
    tabId: 'tab-b',
    handoffId: 'handoff-b',
    requestFingerprint: 'request-b',
    promptHash: 'hash-b',
  }));
  assert.equal(capacity.action, 'capacity');
  assert.equal(capacity.code, 'agent_send_receipt_store_capacity');
  assert.equal(store.list().length, 1);
  assert.equal(getUuidCount(), 1);
});

test('Inbox surface/run pair is unique even when the tab is not allocated yet', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const inbox = identity({
    operationKey: 'inbox:run-1',
    surface: 'inbox',
    runId: 'run-1',
    tabId: null,
    handoffId: null,
    requestFingerprint: 'inbox-request',
    sessionId: null,
  });
  assert.equal(store.reserveOrGet(inbox).action, 'reserved');

  const duplicateRun = store.reserveOrGet({
    ...inbox,
    operationKey: 'inbox:run-1-duplicate',
  });
  assert.equal(duplicateRun.action, 'conflict');
  assert.equal(duplicateRun.code, 'agent_send_surface_run_conflict');
  assert.deepEqual(duplicateRun.mismatchedFields, ['operationKey']);

  const otherSurface = store.reserveOrGet({
    ...inbox,
    operationKey: 'project:run-1',
    surface: 'project-api',
  });
  assert.equal(otherSurface.action, 'reserved');
  assert.equal(store.list({ runId: 'run-1' }).length, 2);

  const lateBinding = identity({
    operationKey: 'inbox:late-binding',
    surface: 'inbox',
    runId: null,
    tabId: null,
    handoffId: null,
    requestFingerprint: 'late-binding-request',
    sessionId: null,
  });
  store.reserveOrGet(lateBinding);
  const lateConflict = store.beginAttempt({ ...lateBinding, runId: 'run-1' });
  assert.equal(lateConflict.action, 'conflict');
  assert.equal(lateConflict.code, 'agent_send_surface_run_conflict');
});

test('list exposes deterministic persisted records and filters by surface/tab/state', (t) => {
  const harness = openMemoryHarness(t, { now: () => 1_785_725_000_000 });
  if (!harness) return;
  const { store } = harness;
  store.reserveOrGet(identity());
  store.reserveOrGet(identity({
    operationKey: 'inbox:run-2',
    surface: 'inbox',
    runId: 'run-2',
    tabId: null,
    handoffId: null,
    requestFingerprint: 'request-2',
  }));
  assert.deepEqual(store.list().map((record) => record.operationKey), [
    'inbox:run-2',
    'project:tab-a:handoff-a',
  ]);
  assert.equal(store.list({ surface: 'inbox' }).length, 1);
  assert.equal(store.list({ tabId: 'tab-a', state: STORE_STATES.RESERVED }).length, 1);
});
