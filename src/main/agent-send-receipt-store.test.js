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

test('message owner pins survive receipt retention until the delivered state is durably recorded', (t) => {
  const h = openMemoryHarness(t, { now: () => 100, settledRetentionMs: 10 });
  if (!h) return;
  const store = h.store;
  const request = identity();
  store.pinForOwner(request.operationKey, 'tab-message');
  store.reserveOrGet(request);
  const attempt = store.beginAttempt(request);
  store.settleAttempt(request.operationKey, attempt.attemptId, { success: true, accepted: true,
    submitted: true, status: 'sent', exactAuditConfirmed: true });
  assert.equal(store.get(request.operationKey).state, STORE_STATES.CONFIRMED);
  store.prune(1000);
  assert.ok(store.get(request.operationKey), 'a crashed message projection can still recover positive delivery');
  store.pinForOwner(request.operationKey, 'another-owner');
  store.unpinForOwner(request.operationKey, 'tab-message');
  store.prune(1000);
  assert.ok(store.get(request.operationKey), 'each owner releases only its own pin');
  store.unpinForOwner(request.operationKey, 'another-owner');
  store.prune(1000);
  assert.equal(store.get(request.operationKey), null);
});

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
    sourceIdentity: 'codex-user-source-session-a-4242',
    auditTimestamp: '2026-08-07T06:46:46.000Z',
    transcriptBoundary: { byteOffset: 42, line: 7 },
    ...overrides,
  };
}

function exactProviderNotAccepted(overrides = {}) {
  return {
    success: false,
    accepted: false,
    submitted: true,
    pasteWritten: true,
    enterWritten: true,
    semanticStatus: 'not-submitted',
    providerAccepted: false,
    providerTurnCreated: false,
    composerDraftState: 'exact-original',
    exactDraftRemained: true,
    draftPreserved: true,
    lateReconciliationPending: false,
    code: 'claude_prompt_not_accepted_exact_draft_remained',
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

test('source-only confirmed receipt learns canonical address without new settlement, survives reopen and rejects conflicts', (t) => {
  let now = 1000;
  const h = openMemoryHarness(t, { now: () => now });
  if (!h) return;
  const begun = h.store.beginAttempt(identity());
  h.store.settleAttempt(identity().operationKey, begun.attemptId, { submitted: true, status: 'audit-pending', auditPending: true });
  const first = h.store.promoteFromAudit(exactAudit(begun.attemptId, { entryUuid: null, recordByteOffset: null }));
  assert.equal(first.record.auditIdentity.entryUuid, null);
  assert.equal(first.record.receipt.recordByteOffset, null);
  now = 2000;
  const enriched = h.store.promoteFromAudit(exactAudit(begun.attemptId, { recordByteOffset: 4242 }));
  assert.equal(enriched.enriched, true); assert.equal(enriched.promoted, false);
  assert.equal(enriched.record.settledAt, first.record.settledAt);
  assert.equal(enriched.record.receipt.entryUuid, 'entry-a');
  const reopened = createAgentSendReceiptStore(h.db);
  assert.equal(reopened.get(identity().operationKey).auditIdentity.entryUuid, 'entry-a');
  const replay = reopened.promoteFromAudit(exactAudit(begun.attemptId, { entryUuid: null }));
  assert.equal(replay.idempotent, true); assert.equal(replay.record.receipt.entryUuid, 'entry-a');
  for (const patch of [{ entryUuid: 'wrong' }, { sourceIdentity: 'wrong' }, { recordByteOffset: 999 }, { attemptId: 'wrong' }]) {
    const result = reopened.promoteFromAudit(exactAudit(begun.attemptId, patch));
    assert.equal(result.ok, false);
  }
});

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

test('live unconfirmed transitions notify diagnostics, stale/confirmed transitions do not', (t) => {
  const observed = [];
  const h = openMemoryHarness(t, { onDeliveryUnknown: record => observed.push(record) });
  if (!h) return;
  const begun = h.store.beginAttempt(identity());
  h.store.settleAttempt(identity().operationKey, begun.attemptId, {
    submitted: true, accepted: true, status: 'audit-pending', auditPending: true,
  });
  assert.equal(observed.length, 0);
  h.store.markDeliveryUnknown(identity().operationKey, begun.attemptId, { source: 'runtime' });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].attemptId, begun.attemptId);
  h.store.promoteFromAudit(exactAudit(begun.attemptId));
  h.store.markDeliveryUnknown(identity().operationKey, begun.attemptId, { source: 'runtime' });
  assert.equal(observed.length, 1);
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

test('explicit source survives pre-Enter context staging and keeps the actual writer separate', t => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ sessionId: null }));
  const expectedTarget = { toolType: 'codex', sessionId: 'source-A' };
  assert.equal(store.stageAttemptContext(begun.record.operationKey, begun.attemptId, { expectedTarget }).ok, true);
  const staged = store.stageAttemptContext(begun.record.operationKey, begun.attemptId, {
    sessionId: 'writer-B', transcriptBoundary: { sessionId: 'writer-B', byteOffset: 42 },
  });
  assert.equal(staged.ok, true);
  assert.deepEqual(staged.record.receipt.expectedTarget, expectedTarget);
  assert.equal(staged.record.sessionId, 'writer-B');
});

test('exact Claude queue acceptance survives the caller timeout without becoming final delivery proof', (t) => {
  let time = 100;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  store.stageAttemptContext(begun.record.operationKey, begun.attemptId, {
    promptText: 'wait behind the active Claude turn',
    transcriptBoundary: { sessionId: 'session-a', fileSize: 42 },
  });
  store.markAttemptState(
    begun.record.operationKey,
    begun.attemptId,
    STORE_STATES.ENTER_ARMED,
  );

  time = 110;
  const accepted = store.markProviderQueueAccepted(
    begun.record.operationKey,
    begun.attemptId,
    {
      provider: 'claude',
      sessionId: 'session-a',
      entryUuid: 'queue-operation-a',
      sourceIdentity: 'claude-queue:uuid:queue-operation-a',
      recordByteOffset: 84,
      acceptedAt: '2026-08-16T01:58:27.200Z',
    },
  );
  assert.equal(accepted.applied, true);
  assert.equal(accepted.record.state, STORE_STATES.ENTER_ARMED);
  assert.deepEqual(accepted.record.receipt.providerQueue, {
    accepted: true,
    provider: 'claude',
    operationKey: begun.record.operationKey,
    attemptId: begun.attemptId,
    promptHash: 'hash-a',
    acceptedAt: '2026-08-16T01:58:27.200Z',
    observedAt: 110,
    sessionId: 'session-a',
    entryUuid: 'queue-operation-a',
    sourceIdentity: 'claude-queue:uuid:queue-operation-a',
    recordByteOffset: 84,
  });

  time = 120;
  const pending = store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  assert.equal(pending.record.state, STORE_STATES.AUDIT_PENDING);
  assert.equal(pending.record.receipt.providerQueue.entryUuid, 'queue-operation-a');
  assert.equal(pending.record.receipt.auditPending, true,
    'provider queue acceptance does not replace the canonical transcript audit');

  const replay = store.markProviderQueueAccepted(
    begun.record.operationKey,
    begun.attemptId,
    {
      provider: 'claude',
      sessionId: 'session-a',
      entryUuid: 'queue-operation-a',
      sourceIdentity: 'claude-queue:uuid:queue-operation-a',
      recordByteOffset: 84,
    },
  );
  assert.equal(replay.idempotent, true);
  assert.equal(replay.record.state, STORE_STATES.AUDIT_PENDING);

  const conflict = store.markProviderQueueAccepted(
    begun.record.operationKey,
    begun.attemptId,
    {
      provider: 'claude',
      sessionId: 'session-a',
      entryUuid: 'foreign-queue-operation',
      sourceIdentity: 'claude-queue:uuid:foreign-queue-operation',
      recordByteOffset: 96,
    },
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'provider-queue-identity-conflict');
  assert.deepEqual(conflict.mismatchedFields, ['entryUuid', 'sourceIdentity', 'recordByteOffset']);
});

test('provider queue evidence cannot attach to another attempt or a non-Claude receipt', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));

  const stale = store.markProviderQueueAccepted(
    begun.record.operationKey,
    'foreign-attempt',
    { provider: 'claude' },
  );
  assert.equal(stale.reason, 'stale-attempt');

  const wrongProvider = store.markProviderQueueAccepted(
    begun.record.operationKey,
    begun.attemptId,
    { provider: 'codex' },
  );
  assert.equal(wrongProvider.reason, 'provider-mismatch');
  assert.equal(store.get(begun.record.operationKey).receipt, null);
});

test('Codex committed TUI queue proof survives timeout and remains late-audit promotable', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'codex' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  const queued = store.markProviderQueueAccepted(
    begun.record.operationKey,
    begun.attemptId,
    {
      provider: 'codex',
      sessionId: 'session-a',
      sourceIdentity: 'codex-tui-queue:mirror-a:7:12:11:1:hash',
      evidence: { kind: 'committed-tui-queue-card', committedFrameGeneration: 11 },
    },
  );
  assert.equal(queued.ok, true);
  assert.equal(queued.record.state, STORE_STATES.AUDIT_PENDING);
  assert.equal(queued.record.receipt.providerQueue.provider, 'codex');
  assert.equal(
    queued.record.receipt.providerQueue.evidence.kind,
    'committed-tui-queue-card',
  );

  const unknown = store.markDeliveryUnknown(
    begun.record.operationKey,
    begun.attemptId,
    { source: 'runtime', reason: 'caller-timeout' },
  );
  assert.equal(unknown.record.state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(unknown.record.receipt.providerQueue.accepted, true);

  const replayedQueue = store.markProviderQueueAccepted(
    begun.record.operationKey,
    begun.attemptId,
    {
      provider: 'codex',
      sessionId: 'session-a',
      sourceIdentity: 'codex-tui-queue:mirror-a:7:12:11:1:hash',
    },
  );
  assert.equal(replayedQueue.idempotent, true);
  assert.equal(replayedQueue.record.state, STORE_STATES.DELIVERY_UNKNOWN);

  const confirmed = store.promoteFromAudit(exactAudit(begun.attemptId));
  assert.equal(confirmed.promoted, true);
  assert.equal(confirmed.record.state, STORE_STATES.CONFIRMED);
});

test('exact post-Enter provider refusal terminalizes the same audit-pending attempt', (t) => {
  let time = 100;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store, getUuidCount } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  const pending = store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
    transcriptBoundary: { fileSize: 42 },
  });
  assert.equal(pending.record.state, STORE_STATES.AUDIT_PENDING);

  time = 125;
  const terminal = store.settleAttempt(
    begun.record.operationKey,
    begun.attemptId,
    exactProviderNotAccepted(),
  );
  assert.equal(terminal.applied, true);
  assert.equal(terminal.record.state, STORE_STATES.PROVIDER_NOT_ACCEPTED);
  assert.equal(terminal.record.settledAt, 125);
  assert.equal(terminal.record.receipt.submitted, true);
  assert.equal(terminal.record.receipt.auditPending, false);
  assert.deepEqual(terminal.record.transcriptBoundary, { fileSize: 42 });

  const replay = store.beginAttempt(identity({ provider: 'claude' }));
  assert.equal(replay.action, 'replay');
  assert.equal(replay.retryable, false);
  assert.equal(replay.record.attemptId, begun.attemptId);
  assert.equal(getUuidCount(), 1);

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    provider: 'claude',
  }));
  assert.equal(promoted.promoted, false);
  assert.equal(promoted.reason, 'provider-not-accepted-cannot-be-promoted');
});

test('incomplete post-Enter negative proof remains audit-pending', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  const ambiguous = store.settleAttempt(
    begun.record.operationKey,
    begun.attemptId,
    exactProviderNotAccepted({ exactDraftRemained: false }),
  );
  assert.equal(ambiguous.applied, false);
  assert.equal(ambiguous.record.state, STORE_STATES.AUDIT_PENDING);
});

test('startup reconciliation replaces an endless audit spinner with replay-safe unconfirmed state', (t) => {
  let time = 100;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store, getUuidCount } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
    promptText: 'exact original prompt',
  });

  time = 125;
  const unconfirmed = store.markStartupUnconfirmed(
    begun.record.operationKey,
    begun.attemptId,
    {
      decision: 'absent',
      reason: 'no-exact-post-boundary-candidate',
      evidence: { boundaryOffset: 42, scanEndOffset: 84 },
    },
  );
  assert.equal(unconfirmed.applied, true);
  assert.equal(unconfirmed.record.state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(unconfirmed.record.settledAt, null);
  assert.equal(unconfirmed.record.receipt.submitted, true);
  assert.equal(unconfirmed.record.receipt.auditPending, false);
  assert.equal(unconfirmed.record.receipt.deliveryUnknown, true);
  assert.equal(unconfirmed.record.receipt.accepted, null);
  assert.equal(
    unconfirmed.record.receipt.startupReconciliation.reason,
    'no-exact-post-boundary-candidate',
  );

  const replay = store.beginAttempt(identity({ provider: 'claude' }));
  assert.equal(replay.action, 'replay');
  assert.equal(replay.retryable, false);
  assert.equal(replay.record.attemptId, begun.attemptId);
  assert.equal(getUuidCount(), 1, 'unconfirmed recovery must never create a retry attempt');

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    provider: 'claude',
  }));
  assert.equal(promoted.promoted, true, 'a later exact record may still resolve the receipt');
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
});

test('runtime audit timeout becomes finite delivery-unknown and remains late-promotable', (t) => {
  let time = 200;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'codex' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
    promptText: 'exact original prompt',
  });

  time = 225;
  const unconfirmed = store.markDeliveryUnknown(
    begun.record.operationKey,
    begun.attemptId,
    {
      source: 'runtime',
      decision: 'unknown',
      reason: 'codex-user-message-audit-timeout',
      code: 'codex_user_message_audit_timeout',
    },
  );
  assert.equal(unconfirmed.applied, true);
  assert.equal(unconfirmed.record.state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(unconfirmed.record.receipt.accepted, true);
  assert.equal(unconfirmed.record.receipt.submitted, true);
  assert.equal(unconfirmed.record.receipt.auditPending, false);
  assert.equal(unconfirmed.record.receipt.deliveryUnknown, true);
  assert.equal(
    unconfirmed.record.receipt.deliveryReconciliation.reason,
    'codex-user-message-audit-timeout',
  );

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    provider: 'codex',
  }));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
});

test('a startup-discovered provider queue return terminalizes delivery-unknown', (t) => {
  let time = 100;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    accepted: true,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  store.markStartupUnconfirmed(
    begun.record.operationKey,
    begun.attemptId,
    { decision: 'unknown', reason: 'pre-scan' },
  );
  assert.equal(store.get(begun.record.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);

  time = 140;
  const returned = store.settleAttempt(
    begun.record.operationKey,
    begun.attemptId,
    exactProviderNotAccepted({
      composerDraftState: 'exact-provider-queue-return',
      providerQueueReturned: true,
      providerQueueOperation: 'popAll',
      sourceIdentity: 'claude-queue:uuid:return-enqueue',
      exactDraftRemained: false,
    }),
  );
  assert.equal(returned.applied, true);
  assert.equal(returned.record.state, STORE_STATES.PROVIDER_NOT_ACCEPTED);
  assert.equal(returned.record.settledAt, 140);
  assert.equal(returned.record.receipt.providerQueueReturned, true);
});

test('startup unconfirmed transition cannot overwrite a settled receipt or a newer attempt', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  const stale = store.markStartupUnconfirmed(
    begun.record.operationKey,
    'foreign-attempt',
    { decision: 'unknown', reason: 'test' },
  );
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale-attempt');
  assert.equal(stale.record.state, STORE_STATES.AUDIT_PENDING);

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    provider: 'claude',
  }));
  assert.equal(promoted.promoted, true);
  const afterConfirmed = store.markStartupUnconfirmed(
    begun.record.operationKey,
    begun.attemptId,
    { decision: 'unknown', reason: 'late-startup-result' },
  );
  assert.equal(afterConfirmed.applied, false);
  assert.equal(afterConfirmed.reason, 'already-confirmed');
  assert.equal(afterConfirmed.record.state, STORE_STATES.CONFIRMED);
});

test('pre-Enter context binds the exact writer session and rejects a contradictory boundary', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ sessionId: null }));
  const boundary = {
    sessionId: 'writer-session',
    filePath: '/tmp/writer-session.jsonl',
    fileSize: 42,
  };

  const staged = store.stageAttemptContext(begun.record.operationKey, begun.attemptId, {
    sessionId: 'writer-session',
    promptText: 'exact writer prompt',
    expectedImagePaths: [
      '/tmp/noted-terminal-codex-image-input/content-hash.png',
    ],
    transcriptBoundary: boundary,
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.record.sessionId, 'writer-session');
  assert.equal(staged.record.receipt.sessionId, 'writer-session');
  assert.deepEqual(staged.record.receipt.expectedImagePaths, [
    '/tmp/noted-terminal-codex-image-input/content-hash.png',
  ]);
  assert.deepEqual(staged.record.transcriptBoundary, boundary);

  const contradictory = store.stageAttemptContext(
    begun.record.operationKey,
    begun.attemptId,
    {
      sessionId: 'foreign-session',
      promptText: 'must not replace exact context',
      transcriptBoundary: boundary,
    },
  );
  assert.equal(contradictory.ok, false);
  assert.equal(contradictory.reason, 'attempt-context-session-boundary-mismatch');
  assert.equal(contradictory.record.sessionId, 'writer-session');
  assert.equal(contradictory.record.receipt.promptText, 'exact writer prompt');
});

test('pre-Enter exact writer replaces a stale pre-Resume session hint', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ sessionId: 'resume-source' }));

  const staged = store.stageAttemptContext(begun.record.operationKey, begun.attemptId, {
    sessionId: 'resume-child',
    transcriptBoundary: {
      sessionId: 'resume-child',
      filePath: '/tmp/resume-child.jsonl',
      fileSize: 7,
    },
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.record.sessionId, 'resume-child');
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

test('proven Codex canonical audit keeps expected operation hash and records observed hash', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity());
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    promptHash: 'hash-a',
    expectedHash: 'hash-a',
    actualHash: 'provider-hash',
    canonicalized: true,
    canonicalReason: 'codex_trimmed_boundary_whitespace',
    recordByteOffset: 4242,
  }));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.promptHash, 'hash-a');
  assert.equal(promoted.record.auditIdentity.promptHash, 'provider-hash');
  assert.equal(promoted.record.receipt.actualHash, 'provider-hash');
  assert.equal(promoted.record.receipt.canonicalized, true);
  assert.equal(promoted.record.receipt.recordByteOffset, 4242);

  const foreign = store.beginAttempt(identity({
    operationKey: 'project:tab-a:handoff-b',
    handoffId: 'handoff-b',
    requestFingerprint: 'request-b',
  }));
  store.settleAttempt(foreign.record.operationKey, foreign.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  const rejected = store.promoteFromAudit(exactAudit(foreign.attemptId, {
    operationKey: foreign.record.operationKey,
    actualHash: 'provider-hash',
    canonicalized: true,
    canonicalReason: 'unproven-transform',
  }));
  assert.equal(rejected.promoted, false);
  assert.ok(rejected.mismatchedFields.includes('canonicalProof'));
});

test('proven Claude composer transform keeps the original send identity', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity({ provider: 'claude' }));
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    provider: 'claude',
    expectedHash: 'hash-a',
    actualHash: 'claude-provider-hash',
    canonicalized: true,
    canonicalReason: 'claude_owned_composer_provider_transform',
  }));

  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
  assert.equal(promoted.record.promptHash, 'hash-a');
  assert.equal(promoted.record.auditIdentity.promptHash, 'claude-provider-hash');
  assert.equal(promoted.record.receipt.expectedHash, 'hash-a');
  assert.equal(promoted.record.receipt.actualHash, 'claude-provider-hash');
  assert.equal(
    promoted.record.receipt.canonicalReason,
    'claude_owned_composer_provider_transform',
  );
});

test('durable receipt accepts the exact Codex CRLF transport proof', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const begun = store.beginAttempt(identity());
  store.settleAttempt(begun.record.operationKey, begun.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });

  const promoted = store.promoteFromAudit(exactAudit(begun.attemptId, {
    expectedHash: 'hash-a',
    actualHash: 'rollout-double-lf-hash',
    canonicalized: true,
    canonicalReason: 'codex_pty_crlf_materialized_as_double_lf',
  }));

  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
  assert.equal(promoted.record.promptHash, 'hash-a');
  assert.equal(promoted.record.auditIdentity.promptHash, 'rollout-double-lf-hash');
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

test('restart distinguishes proven pre-Enter attempts from enter-armed unknown delivery', (t) => {
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
  store.stageAttemptContext(active.record.operationKey, active.attemptId, {
    promptText: 'recover this draft',
    transcriptBoundary: { filePath: '/tmp/session.jsonl', fileSize: 12 },
  });
  store.markAttemptState(active.record.operationKey, active.attemptId, STORE_STATES.ENTER_ARMED);
  const preEnter = store.beginAttempt(identity({
    operationKey: 'pre-enter-op',
    handoffId: 'pre-enter-handoff',
    requestFingerprint: 'pre-enter-request',
  }));
  store.stageAttemptContext(preEnter.record.operationKey, preEnter.attemptId, {
    promptText: 'restore before Enter',
  });
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
  assert.equal(reconciled.changed, 2);
  assert.equal(store.get(active.record.operationKey).state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(store.get(active.record.operationKey).receipt.code, 'agent_send_restart_during_delivery');
  assert.equal(store.get(active.record.operationKey).receipt.promptText, 'recover this draft');
  assert.deepEqual(store.get(active.record.operationKey).transcriptBoundary, {
    filePath: '/tmp/session.jsonl',
    fileSize: 12,
  });
  assert.equal(store.get('pre-enter-op').state, STORE_STATES.NOT_SUBMITTED);
  assert.equal(store.get('pre-enter-op').receipt.code, 'agent_send_restart_before_enter');
  assert.equal(store.get('pre-enter-op').receipt.promptText, 'restore before Enter');
  assert.equal(store.get('reserved-op').state, STORE_STATES.RESERVED);
  assert.equal(store.get('preparing-op').state, STORE_STATES.PREPARING);

  const replay = store.beginAttempt(identity());
  assert.equal(replay.action, 'replay');
  assert.equal(replay.record.attemptId, active.attemptId, 'restart never authorizes a blind retry');
  const preEnterRetry = store.beginAttempt(identity({
    operationKey: 'pre-enter-op',
    handoffId: 'pre-enter-handoff',
    requestFingerprint: 'pre-enter-request',
  }));
  assert.equal(preEnterRetry.action, 'attempt-started');
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

test('confirmed delivery is enriched with exact audit identity and presentation ACK is an exact CAS', (t) => {
  const harness = openMemoryHarness(t, { now: () => 1_786_105_206_500 });
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity({ surface: 'desktop-history' }));
  const settled = store.settleAttempt(attempt.record.operationKey, attempt.attemptId, {
    success: true,
    submitted: true,
    status: 'sent',
    exactAuditConfirmed: true,
  });
  assert.equal(settled.record.state, STORE_STATES.CONFIRMED);
  assert.equal(settled.record.auditIdentity, null, 'transport settlement is not row identity');

  const enriched = store.promoteFromAudit(exactAudit(attempt.attemptId));
  assert.equal(enriched.promoted, true);
  assert.equal(enriched.record.auditIdentity.sourceIdentity, 'codex-user-source-session-a-4242');
  assert.equal(enriched.record.auditIdentity.auditTimestamp, '2026-08-07T06:46:46.000Z');
  assert.equal(enriched.record.receipt.auditTimestamp, '2026-08-07T06:46:46.000Z');
  const duplicateWithoutSecondarySource = store.promoteFromAudit(exactAudit(attempt.attemptId, {
    sourceIdentity: null,
  }));
  assert.equal(duplicateWithoutSecondarySource.ok, true);
  assert.equal(duplicateWithoutSecondarySource.idempotent, true);

  const baseAck = {
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    sessionId: 'session-a',
    entryUuid: 'entry-a',
    sourceIdentity: 'codex-user-source-session-a-4242',
  };
  assert.equal(store.acknowledgePresentation({ ...baseAck, attemptId: 'stale' }).reason, 'stale-attempt');
  assert.equal(store.acknowledgePresentation({ ...baseAck, entryUuid: 'foreign' }).reason, 'entry-uuid-mismatch');
  assert.equal(store.acknowledgePresentation({ ...baseAck, sourceIdentity: 'foreign' }).reason, 'source-identity-mismatch');
  assert.equal(store.acknowledgePresentation({ ...baseAck, tabId: 'foreign-tab' }).reason, 'handoff-identity-mismatch');

  const acknowledged = store.acknowledgePresentation(baseAck);
  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.applied, true);
  assert.equal(acknowledged.record.presentation.attemptId, attempt.attemptId);
  assert.equal(acknowledged.record.presentation.surface, 'desktop-history');
  assert.equal(acknowledged.record.presentation.entryUuid, 'entry-a');
  assert.equal(acknowledged.record.presentation.sourceIdentity, 'codex-user-source-session-a-4242');
  const replay = store.acknowledgePresentation(baseAck);
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
});

test('History dismissal is durable without changing delivery truth or external send ownership', (t) => {
  let time = 100;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store, getUuidCount } = harness;
  const attempt = store.beginAttempt(identity({
    surface: 'project-api',
    provider: 'claude',
  }));
  const settled = store.settleAttempt(attempt.record.operationKey, attempt.attemptId, {
    success: null,
    submitted: true,
    status: 'delivery-unknown',
    deliveryUnknown: true,
    promptText: 'possibly delivered',
  });
  assert.equal(settled.record.state, STORE_STATES.DELIVERY_UNKNOWN);

  time = 125;
  const dismissed = store.dismissPresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
  });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.applied, true);
  assert.equal(dismissed.record.surface, 'project-api', 'the send origin remains unchanged');
  assert.equal(dismissed.record.state, STORE_STATES.DELIVERY_UNKNOWN);
  assert.equal(dismissed.record.receipt.presentationDismissedAt, 125);
  assert.equal(dismissed.record.receipt.presentationDismissedSurface, 'desktop-history');

  const replay = store.dismissPresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  const retry = store.beginAttempt(identity({ surface: 'project-api', provider: 'claude' }));
  assert.equal(retry.action, 'replay');
  assert.equal(retry.retryable, false, 'hiding a warning must not authorize a blind resend');
  assert.equal(getUuidCount(), 1);
});

test('consuming a recovered pre-Enter draft hides only its presentation and keeps not-submitted truth', (t) => {
  let time = 200;
  const harness = openMemoryHarness(t, { now: () => time });
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity({
    surface: 'desktop-history',
    provider: 'claude',
  }));
  const stopped = store.settleAttempt(attempt.record.operationKey, attempt.attemptId, {
    success: false,
    submitted: false,
    status: 'not-submitted',
    promptText: 'restore exactly once',
  });
  assert.equal(stopped.record.state, STORE_STATES.NOT_SUBMITTED);

  time = 225;
  const dismissed = store.dismissPresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
  });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.applied, true);
  assert.equal(dismissed.record.state, STORE_STATES.NOT_SUBMITTED);
  assert.equal(dismissed.record.receipt.promptText, 'restore exactly once');
  assert.equal(dismissed.record.receipt.presentationDismissedAt, 225);
  assert.equal(dismissed.record.receipt.presentationDismissedSurface, 'desktop-history');
});

test('a confirmed send can hide only its stale local History presentation', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity({ provider: 'codex' }));
  const promoted = store.promoteFromAudit(exactAudit(attempt.attemptId, {
    provider: 'codex',
    sourceIdentity: 'codex-user-source-session-a-response',
  }));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);

  const dismissed = store.dismissPresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
  });
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.record.state, STORE_STATES.CONFIRMED);
  assert.ok(dismissed.record.receipt.presentationDismissedAt);
});

test('hiding CONFIRMING survives a later exact confirmation without changing delivery', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity({ provider: 'codex' }));
  const pending = store.settleAttempt(attempt.record.operationKey, attempt.attemptId, {
    success: null,
    submitted: true,
    status: 'audit-pending',
    auditPending: true,
  });
  assert.equal(pending.record.state, STORE_STATES.AUDIT_PENDING);
  const dismissed = store.dismissPresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
  });
  assert.equal(dismissed.ok, true);
  const dismissedAt = dismissed.record.receipt.presentationDismissedAt;

  const promoted = store.promoteFromAudit(exactAudit(attempt.attemptId, {
    provider: 'codex',
    sourceIdentity: 'codex-user-source-session-a-response',
  }));
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.record.state, STORE_STATES.CONFIRMED);
  assert.equal(promoted.record.receipt.presentationDismissedAt, dismissedAt);
});

test('canonical desktop History can acknowledge an exact Project API delivery', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity({ surface: 'project-api', provider: 'claude' }));
  const promoted = store.promoteFromAudit(exactAudit(attempt.attemptId, {
    provider: 'claude',
    sourceIdentity: null,
  }));
  assert.equal(promoted.promoted, true);

  const acknowledged = store.acknowledgePresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'claude',
    sessionId: 'session-a',
    entryUuid: 'entry-a',
    sourceIdentity: null,
  });

  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.applied, true);
  assert.equal(acknowledged.record.surface, 'project-api',
    'the immutable send origin remains Project API');
  assert.equal(acknowledged.record.presentation.surface, 'desktop-history',
    'the canonical presentation surface is tracked separately');
  const replay = store.acknowledgePresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'claude',
    sessionId: 'session-a',
    entryUuid: 'entry-a',
    sourceIdentity: null,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
});

test('Codex presentation ACK accepts exact source identity when no audit entry UUID exists', (t) => {
  const harness = openMemoryHarness(t);
  if (!harness) return;
  const { store } = harness;
  const attempt = store.beginAttempt(identity({ surface: 'desktop-history' }));
  const promoted = store.promoteFromAudit(exactAudit(attempt.attemptId, {
    entryUuid: null,
  }));
  assert.equal(promoted.promoted, true);
  const rejected = store.acknowledgePresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    sessionId: 'session-a',
    entryUuid: 'canonical-row',
    sourceIdentity: 'foreign-source',
  });
  assert.equal(rejected.reason, 'source-identity-mismatch');
  const accepted = store.acknowledgePresentation({
    operationKey: attempt.record.operationKey,
    attemptId: attempt.attemptId,
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    sessionId: 'session-a',
    entryUuid: 'canonical-row',
    sourceIdentity: 'codex-user-source-session-a-4242',
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.record.presentation.entryUuid, 'canonical-row');
});

test('existing receipt tables migrate additively before statements are prepared', (t) => {
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
  db.exec(`
    CREATE TABLE ${TABLE_NAME} (
      operation_key TEXT PRIMARY KEY, surface TEXT NOT NULL, run_id TEXT,
      tab_id TEXT, handoff_id TEXT, request_fingerprint TEXT NOT NULL,
      provider TEXT, session_id TEXT, prompt_hash TEXT NOT NULL,
      prompt_length INTEGER NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      attempt_id TEXT, receipt_json TEXT, transcript_boundary_json TEXT,
      audit_attempt_id TEXT, audit_provider TEXT, audit_session_id TEXT,
      audit_prompt_hash TEXT, audit_entry_uuid TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, settled_at INTEGER
    )
  `);
  const store = createAgentSendReceiptStore(db);
  const columns = new Set(db.prepare(`PRAGMA table_info(${TABLE_NAME})`).all().map((row) => row.name));
  for (const column of [
    'audit_source_identity',
    'audit_timestamp',
    'presentation_attempt_id',
    'presentation_surface',
    'presentation_entry_uuid',
    'presentation_source_identity',
    'presentation_at',
  ]) {
    assert.equal(columns.has(column), true, `${column} was migrated`);
  }
  assert.equal(store.beginAttempt(identity()).action, 'attempt-started');
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

test('list exposes deterministic persisted records and filters by surface/tab/handoff/state', (t) => {
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
  assert.equal(store.list({ tabId: 'tab-a', handoffId: 'handoff-a' }).length, 1);
  assert.equal(store.list({ tabId: 'tab-a', handoffId: 'missing' }).length, 0);
});
