'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Database = require('better-sqlite3');

const {
  buildDesktopHistorySendIdentity,
  desktopHistorySendReplayResult,
} = require('./agent-history-send-receipt');
const {
  STORE_STATES,
  createAgentSendReceiptStore,
} = require('./agent-send-receipt-store');

function historyIdentity(overrides = {}) {
  return buildDesktopHistorySendIdentity({
    tabId: 'tab-history',
    handoffId: 'handoff-history',
    provider: 'claude',
    source: 'history-panel',
    sessionId: 'session-history',
    rawPrompt: 'one\ttwo\r\nthree',
    promptHash: 'transport-hash',
    promptLength: 17,
    ...overrides,
  });
}

test('desktop History exact receipt survives SQLite reopen and never authorizes a second Enter', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'history-send-receipt-'));
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

  let uuidCalls = 0;
  let store = createAgentSendReceiptStore(db, {
    randomUUID: () => `history-attempt-${++uuidCalls}`,
  });
  const identity = historyIdentity();
  const attempt = store.beginAttempt(identity);
  assert.equal(attempt.action, 'attempt-started');
  assert.equal(store.markAttemptState(
    identity.operationKey,
    attempt.attemptId,
    STORE_STATES.ENTER_ARMED,
  ).ok, true);
  assert.equal(store.settleAttempt(identity.operationKey, attempt.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }).record.state, STORE_STATES.AUDIT_PENDING);
  db.close();

  db = new Database(filename);
  store = createAgentSendReceiptStore(db, {
    randomUUID: () => {
      throw new Error('restart replay must not allocate another physical attempt');
    },
  });
  const replay = store.beginAttempt(identity);
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attemptId, attempt.attemptId);
  assert.equal(desktopHistorySendReplayResult(replay.record).auditPending, true);

  const promoted = store.promoteFromAudit({
    success: true,
    operationKey: identity.operationKey,
    attemptId: attempt.attemptId,
    provider: 'claude',
    sessionId: 'session-history',
    promptHash: 'transport-hash',
    expectedHash: 'transport-hash',
    entryUuid: 'user-turn-exact',
    auditTimestamp: '2026-08-07T06:46:46.000Z',
    transcriptBoundary: { byteOffset: 80, line: 4 },
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
  const acknowledged = store.acknowledgePresentation({
    operationKey: identity.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-history',
    handoffId: 'handoff-history',
    provider: 'claude',
    sessionId: 'session-history',
    entryUuid: 'user-turn-exact',
  });
  assert.equal(acknowledged.applied, true);

  db.close();
  db = new Database(filename);
  store = createAgentSendReceiptStore(db, {
    randomUUID: () => {
      throw new Error('presentation replay must not allocate another physical attempt');
    },
  });
  const persisted = store.get(identity.operationKey);
  assert.equal(persisted.presentation.entryUuid, 'user-turn-exact');
  assert.equal(persisted.presentation.attemptId, attempt.attemptId);

  const confirmedReplay = store.beginAttempt(identity);
  assert.equal(confirmedReplay.action, 'replay');
  const publicReplay = desktopHistorySendReplayResult(confirmedReplay.record);
  assert.equal(publicReplay.success, true);
  assert.equal(publicReplay.entryUuid, 'user-turn-exact');
  assert.equal(uuidCalls, 1);
});

test('same displayed transport cannot let a different raw request or handoff adopt the receipt', (t) => {
  let db;
  try {
    db = new Database(':memory:');
  } catch (error) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && /NODE_MODULE_VERSION/.test(error?.message || '')) {
      t.skip('better-sqlite3 uses the Electron ABI; run with ELECTRON_RUN_AS_NODE=1');
      return;
    }
    throw error;
  }
  t.after(() => db.close());
  let attemptOrdinal = 0;
  const store = createAgentSendReceiptStore(db, {
    randomUUID: () => `attempt-exact-${++attemptOrdinal}`,
  });
  const withTab = historyIdentity();
  const begun = store.beginAttempt(withTab);
  assert.equal(begun.action, 'attempt-started');

  const sameOperationDifferentRaw = historyIdentity({
    rawPrompt: 'one    two\nthree',
  });
  const conflict = store.beginAttempt(sameOperationDifferentRaw);
  assert.equal(conflict.action, 'conflict');
  assert.ok(conflict.mismatchedFields.includes('requestFingerprint'));

  const foreignHandoff = historyIdentity({ handoffId: 'handoff-foreign' });
  const independent = store.beginAttempt(foreignHandoff);
  assert.equal(independent.action, 'attempt-started');
  assert.notEqual(independent.record.operationKey, begun.record.operationKey);
});

test('Queue and Loop reuse one durable operation after restart while the next causal turn stays independent', async (t) => {
  const { buildPromptQueueReceiptHandoffId } = await import(
    '../renderer/utils/promptQueueReceiptIdentity.mjs'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-send-receipt-'));
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

  const payload = 'continue exactly once';
  const queueHandoff = buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'queue-item-1',
    payload,
  });
  const queueIdentity = historyIdentity({
    handoffId: queueHandoff,
    source: 'prompt-queue',
    rawPrompt: payload,
    promptHash: 'queue-transport-hash',
    promptLength: payload.length,
  });
  let allocations = 0;
  let store = createAgentSendReceiptStore(db, {
    randomUUID: () => `queue-attempt-${++allocations}`,
  });
  const first = store.beginAttempt(queueIdentity);
  assert.equal(first.action, 'attempt-started');
  assert.equal(store.markAttemptState(
    queueIdentity.operationKey,
    first.attemptId,
    STORE_STATES.ENTER_ARMED,
  ).ok, true);
  assert.equal(store.settleAttempt(queueIdentity.operationKey, first.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  }).record.state, STORE_STATES.AUDIT_PENDING);
  db.close();

  db = new Database(filename);
  store = createAgentSendReceiptStore(db, {
    randomUUID: () => { throw new Error('queue replay must not allocate a second attempt'); },
  });
  const replay = store.beginAttempt(queueIdentity);
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attemptId, first.attemptId);
  assert.equal(desktopHistorySendReplayResult(replay.record).submitted, true);

  const causeOne = buildPromptQueueReceiptHandoffId({
    kind: 'loop',
    itemId: 'loop-item',
    payload,
    causeKey: 'tab-a:100:turn-one',
  });
  const causeTwo = buildPromptQueueReceiptHandoffId({
    kind: 'loop',
    itemId: 'loop-item',
    payload,
    causeKey: 'tab-a:200:turn-two',
  });
  assert.notEqual(causeOne, causeTwo);
  assert.notEqual(
    historyIdentity({ handoffId: causeOne, source: 'prompt-loop' }).operationKey,
    historyIdentity({ handoffId: causeTwo, source: 'prompt-loop' }).operationKey,
  );
  assert.equal(allocations, 1);
});
