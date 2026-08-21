import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS,
  HistoryPromptHandoffStore,
  beginHistoryPromptHandoff,
  bindHistoryPromptHandoffSendIdentity,
  consumeHistoryPromptHandoff,
  durableHistorySendReceiptMatchesCanonicalEntry,
  getHistoryPromptHandoffsSnapshot,
  hydrateHistoryPromptHandoffFromDurableReceipt,
  historyPromptHandoffInitialStatus,
  historyPromptHandoffBlocksNewSubmit,
  historyPromptAuditIsProviderQueueReturn,
  historyPromptHandoffStatusPresentation,
  historyPromptHandoffAcceptsAuditIdentity,
  historyPromptHandoffUnconfirmedStatusFromSendResult,
  legacyOrchestrationCompletionMatchesCanonicalEntry,
  reconcileHistoryPromptHandoffRows,
  runHistoryPromptHandoff,
  selectLatestHistoryPromptInputStatus,
  subscribeHistoryPromptHandoffs,
  waitForHistoryPromptHandoffSendIdentity,
  type HistoryPromptHandoff,
  type HistoryPromptHandoffChange,
  type HistoryPromptHandoffProjectionRow,
  type HistoryPromptHandoffStoreLimits,
} from './historyPromptHandoffs.ts';

test('only an exact Claude queue return is classified as cancellation', () => {
  const exact = {
    success: false,
    cancelled: true,
    semanticStatus: 'not-submitted',
    providerAccepted: false,
    providerTurnCreated: false,
    providerQueueReturned: true,
    providerQueueOperation: 'popAll',
    composerDraftState: 'exact-provider-queue-return',
    draftPreserved: true,
    sourceIdentity: 'claude-queue:uuid:return-enqueue',
  };
  assert.equal(historyPromptAuditIsProviderQueueReturn(exact), true);
  assert.equal(historyPromptAuditIsProviderQueueReturn({
    ...exact,
    sourceIdentity: null,
  }), false);
  assert.equal(historyPromptAuditIsProviderQueueReturn({
    ...exact,
    providerQueueOperation: 'dequeue',
  }), false);
});

const limits = (
  overrides: Partial<HistoryPromptHandoffStoreLimits> = {},
): HistoryPromptHandoffStoreLimits => ({
  maxTabs: 4,
  maxHandoffs: 8,
  maxBytes: 64 * 1024,
  ...overrides,
});

const begin = (
  store: HistoryPromptHandoffStore,
  tabId: string,
  handoffId: string,
  text = 'same prompt',
) => store.begin({
  tabId,
  handoffId,
  toolType: 'codex',
  sessionIdHint: `session-${tabId}`,
  text,
  promptChips: [{
    id: `chip-${handoffId}`,
    kind: 'prompt',
    label: 'PROMPT',
    text: `chip text ${handoffId}`,
  }],
  imagePaths: [{
    id: 1,
    path: `/tmp/${handoffId}.png`,
    availability: 'available',
  }],
  submittedAt: 100,
  source: 'prompt-queue',
  statusAtSend: 'active',
  requiresAuditIdentity: true,
});

interface TestProjectionRow extends HistoryPromptHandoffProjectionRow {
  uuid: string;
  content: string;
}

const cachedProjectionRow = (
  handoffId: string,
  queueStatus: TestProjectionRow['queueStatus'],
  content = 'same prompt',
): TestProjectionRow => ({
  uuid: `local-${handoffId}`,
  content,
  handoffId,
  queueStatus,
  statusReason: queueStatus === 'sending' ? 'send-start' : 'send-submitted-audit-pending',
  statusChangedAt: 100,
  statusAtSend: 'active',
  timestamp: new Date(100).toISOString(),
  optimisticAt: 100,
  requiresAuditIdentity: true,
  sessionId: 'session-tab-a',
});

const createProjectionRow = (
  handoff: Readonly<HistoryPromptHandoff>,
): TestProjectionRow => ({
  uuid: `local-${handoff.handoffId}`,
  content: handoff.text,
  handoffId: handoff.handoffId,
  sessionId: handoff.sessionIdHint || undefined,
});

test('a background begin is replayed when History subscribes later', () => {
  const store = new HistoryPromptHandoffStore(limits());
  const created = begin(store, 'tab-a', 'handoff-a');
  assert.equal(created?.queueStatus, 'sending');

  const calls: Array<{
    ids: string[];
    change: HistoryPromptHandoffChange;
  }> = [];
  const unsubscribe = store.subscribe('tab-a', (snapshot, change) => {
    calls.push({
      ids: snapshot.map(item => item.handoffId),
      change,
    });
  });

  assert.deepEqual(calls, [{
    ids: ['handoff-a'],
    change: { type: 'replay' },
  }]);
  unsubscribe();
});

test('handoff retains an exact authoring snapshot for ordered cascade rollback', () => {
  const store = new HistoryPromptHandoffStore(limits());
  const value = store.begin({
    tabId: 'tab-authoring',
    handoffId: 'handoff-authoring',
    toolType: 'claude',
    text: 'presentation text',
    authoringText: 'raw textarea text',
    authoringChips: [{ id: 'paste-1', kind: 'paste', text: 'hidden paste body' }],
    authoringImagePaths: [{ id: 4, path: '/tmp/image.png', availability: 'available' }],
    source: 'history-panel',
    statusAtSend: 'active',
  });
  assert.equal(value?.authoringText, 'raw textarea text');
  assert.equal(value?.authoringChips[0].kind, 'paste');
  assert.equal(value?.authoringImagePaths[0].id, 4);
});

test('a submit made during startup is visible immediately and advances through exact transport phases', () => {
  assert.equal(historyPromptHandoffInitialStatus('inactive'), 'preparing');
  assert.equal(historyPromptHandoffInitialStatus('starting'), 'preparing');
  assert.equal(historyPromptHandoffInitialStatus('active'), 'sending');
  assert.equal(historyPromptHandoffInitialStatus('busy'), 'queued');

  const tabId = 'tab-starting';
  const handoffId = 'handoff-starting';
  const store = new HistoryPromptHandoffStore(limits());
  const observed: string[] = [];
  const unsubscribe = store.subscribe(tabId, (snapshot, change) => {
    if (change.type === 'replay') return;
    const record = snapshot.find(candidate => candidate.handoffId === handoffId);
    if (record) observed.push(record.queueStatus);
  });

  store.begin({
    tabId,
    handoffId,
    toolType: 'codex',
    text: 'wait for startup',
    submittedAt: 100,
    statusAtSend: 'starting',
    initialStatus: historyPromptHandoffInitialStatus('starting'),
  });
  store.advanceTransportPhase(tabId, handoffId, 'sending');
  store.advanceTransportPhase(tabId, handoffId, 'confirming');
  store.advanceTransportPhase(tabId, handoffId, 'sending');

  assert.deepEqual(observed, ['preparing', 'sending', 'audit-pending']);
  assert.equal(store.getSnapshot(tabId)[0]?.queueStatus, 'audit-pending');
  assert.equal(
    historyPromptHandoffStatusPresentation('preparing')?.label,
    'PREPARING',
  );
  unsubscribe();
});

test('the terminal status row selects only the newest active input operation', () => {
  assert.equal(selectLatestHistoryPromptInputStatus([
    { submittedAt: 100, statusChangedAt: 120, queueStatus: 'sent' },
    { submittedAt: 200, statusChangedAt: 210, queueStatus: 'preparing' },
    { submittedAt: 150, statusChangedAt: 300, queueStatus: 'audit-pending' },
  ]), 'preparing');
  assert.equal(selectLatestHistoryPromptInputStatus([
    { submittedAt: 100, statusChangedAt: 120, queueStatus: 'sent' },
    { submittedAt: 200, statusChangedAt: 210, queueStatus: 'failed' },
  ]), null);
});

test('one unresolved UI delivery blocks a second submit until it settles', () => {
  for (const queueStatus of ['preparing', 'sending', 'queued', 'audit-pending'] as const) {
    assert.equal(historyPromptHandoffBlocksNewSubmit([
      { submittedAt: 100, statusChangedAt: 120, queueStatus },
    ]), true, queueStatus);
  }
  for (const queueStatus of ['sent', 'failed', 'cancelled', 'delivery-unknown'] as const) {
    assert.equal(historyPromptHandoffBlocksNewSubmit([
      { submittedAt: 100, statusChangedAt: 120, queueStatus },
    ]), false, queueStatus);
  }
});

test('a queued prompt switches to SENDING only when its exact PTY transfer begins', () => {
  const store = new HistoryPromptHandoffStore(limits());
  store.begin({
    tabId: 'tab-busy',
    handoffId: 'handoff-busy',
    toolType: 'claude',
    text: 'wait for current turn',
    statusAtSend: 'busy',
    initialStatus: 'queued',
  });
  assert.equal(store.getSnapshot('tab-busy')[0]?.queueStatus, 'queued');

  store.advanceTransportPhase('tab-busy', 'handoff-busy', 'sending');
  assert.equal(store.getSnapshot('tab-busy')[0]?.queueStatus, 'sending');

  store.advanceTransportPhase('tab-busy', 'handoff-busy', 'confirming');
  assert.equal(store.getSnapshot('tab-busy')[0]?.queueStatus, 'audit-pending');
});

test('exact Claude provider queue evidence replaces CONFIRMING and resists the later caller timeout', () => {
  const store = new HistoryPromptHandoffStore(limits());
  store.begin({
    tabId: 'tab-provider-queue',
    handoffId: 'handoff-provider-queue',
    sendAttemptId: 'attempt-provider-queue',
    sendOperationKey: 'history:tab-provider-queue:handoff-provider-queue',
    toolType: 'claude',
    text: 'run after the current Claude response',
    statusAtSend: 'busy',
    initialStatus: 'queued',
    submittedAt: 100,
  });
  store.advanceTransportPhase('tab-provider-queue', 'handoff-provider-queue', 'sending');
  store.advanceTransportPhase('tab-provider-queue', 'handoff-provider-queue', 'confirming');
  assert.equal(
    store.getSnapshot('tab-provider-queue')[0]?.queueStatus,
    'audit-pending',
  );

  const accepted = store.acceptProviderQueue(
    'tab-provider-queue',
    'handoff-provider-queue',
    {
      sendAttemptId: 'attempt-provider-queue',
      sendOperationKey: 'history:tab-provider-queue:handoff-provider-queue',
      changedAt: 200,
      proof: {
        sourceIdentity: 'claude-queue:uuid:queue-operation-provider-queue',
        sessionId: 'session-provider-queue',
        entryUuid: 'queue-operation-provider-queue',
        recordByteOffset: 84,
      },
    },
  );
  assert.equal(accepted?.queueStatus, 'queued');
  assert.equal(accepted?.statusReason, 'provider-queue-accepted');
  assert.equal(
    accepted?.providerQueueProof?.sourceIdentity,
    'claude-queue:uuid:queue-operation-provider-queue',
  );

  const timedOut = store.settle('tab-provider-queue', 'handoff-provider-queue', {
    queueStatus: 'audit-pending',
    reason: 'send-submitted-audit-pending',
    changedAt: 300,
  });
  assert.strictEqual(timedOut, accepted,
    'a weaker timeout cannot erase exact native queue acceptance');

  const confirmed = store.settle('tab-provider-queue', 'handoff-provider-queue', {
    queueStatus: 'sent',
    reason: 'late-audit-confirmed',
    changedAt: 400,
    proof: {
      auditTimestamp: '2026-08-16T02:04:48.014Z',
      actualHash: 'confirmed-hash',
      sessionId: 'session-provider-queue',
      entryUuid: 'queued-command-provider-queue',
    },
  });
  assert.equal(confirmed?.queueStatus, 'sent');
});

test('provider queue evidence with a foreign durable attempt cannot change the History row', () => {
  const store = new HistoryPromptHandoffStore(limits());
  store.begin({
    tabId: 'tab-provider-queue-foreign',
    handoffId: 'handoff-provider-queue-foreign',
    sendAttemptId: 'attempt-current',
    sendOperationKey: 'history:current',
    toolType: 'claude',
    text: 'same text is not identity',
    statusAtSend: 'active',
  });
  store.advanceTransportPhase(
    'tab-provider-queue-foreign',
    'handoff-provider-queue-foreign',
    'confirming',
  );
  const before = store.getSnapshot('tab-provider-queue-foreign')[0];
  const after = store.acceptProviderQueue(
    'tab-provider-queue-foreign',
    'handoff-provider-queue-foreign',
    {
      sendAttemptId: 'attempt-foreign',
      sendOperationKey: 'history:foreign',
      changedAt: 300,
    },
  );
  assert.strictEqual(after, before);
  assert.equal(after?.queueStatus, 'audit-pending');
});

test('settle preserves exact handoff identity and immutable audit proof', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  begin(store, 'tab-a', 'handoff-b');

  const proof = {
    auditTimestamp: '2026-07-24T10:51:32.889Z',
    actualHash: '98058a4c3461ae09',
    sessionId: 'session-live',
    entryUuid: 'exact-user-entry',
    sourceIdentity: 'codex-user-source-session-live-258313991',
    recordByteOffset: 258313991,
    actualLen: 69165,
    canonicalized: true,
    canonicalReason: 'codex_trimmed_boundary_whitespace',
  };
  const settled = store.settle('tab-a', 'handoff-b', {
    queueStatus: 'sent',
    reason: 'audit-confirmed',
    proof,
    changedAt: 200,
  });
  proof.actualHash = 'mutated-after-settle';

  const snapshot = store.getSnapshot('tab-a');
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0]?.handoffId, 'handoff-a');
  assert.equal(snapshot[0]?.queueStatus, 'sending');
  assert.equal(snapshot[1]?.handoffId, 'handoff-b');
  assert.equal(settled?.queueStatus, 'sent');
  assert.deepEqual(settled?.auditProof, {
    auditTimestamp: '2026-07-24T10:51:32.889Z',
    actualHash: '98058a4c3461ae09',
    sessionId: 'session-live',
    entryUuid: 'exact-user-entry',
    sourceIdentity: 'codex-user-source-session-live-258313991',
    recordByteOffset: 258313991,
    actualLen: 69165,
    canonicalized: true,
    canonicalReason: 'codex_trimmed_boundary_whitespace',
  });
  assert.equal(Object.isFrozen(settled), true);
  assert.equal(Object.isFrozen(settled?.auditProof), true);
  assert.equal(Object.isFrozen(settled?.promptChips), true);
  assert.equal(Object.isFrozen(settled?.imagePaths), true);
  assert.equal(Object.isFrozen(settled?.imagePaths[0]), true);
});

test('History canonical adoption enriches the same SENT handoff before consume', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'audit-confirmed',
    proof: {
      auditTimestamp: '2026-08-18T22:08:26.286Z',
      actualHash: 'exact-hash',
      sessionId: 'session-live',
      sourceIdentity: 'codex-user-source-session-live-2232297',
    },
  });
  const changes: HistoryPromptHandoffChange[] = [];
  const unsubscribe = store.subscribe('tab-a', (_snapshot, change) => changes.push(change));
  const adopted = store.adoptCanonicalEntry('tab-a', 'handoff-a', {
    entryUuid: 'codex-user-session-live-687',
    sessionId: 'session-live',
    sourceIdentity: 'codex-user-source-session-live-2232400',
    sourceIdentityAliases: ['codex-user-source-session-live-2232297'],
  });
  unsubscribe();

  assert.equal(adopted?.queueStatus, 'sent');
  assert.equal(adopted?.auditProof?.entryUuid, 'codex-user-session-live-687');
  assert.equal(
    adopted?.auditProof?.sourceIdentity,
    'codex-user-source-session-live-2232297',
  );
  assert.equal(changes.at(-1)?.type, 'canonical-adopt');

  const wrong = store.adoptCanonicalEntry('tab-a', 'handoff-a', {
    entryUuid: 'similar-text-but-foreign-entry',
    sessionId: 'session-live',
    sourceIdentity: 'foreign-source',
  });
  assert.equal(wrong, undefined);
});

test('a late pending receipt cannot regress SENT with exact proof', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  const exact = store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'late-audit-confirmed',
    changedAt: 300,
    proof: {
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      actualHash: 'exact-hash',
      sessionId: 'session-live',
      entryUuid: 'exact-user-uuid',
    },
  });

  const stale = store.settle('tab-a', 'handoff-a', {
    queueStatus: 'audit-pending',
    reason: 'late-timeout',
    changedAt: 400,
    proof: null,
  });

  assert.strictEqual(stale, exact);
  assert.equal(stale?.queueStatus, 'sent');
  assert.equal(stale?.statusReason, 'late-audit-confirmed');
  assert.equal(stale?.statusChangedAt, 300);
  assert.equal(stale?.auditProof?.entryUuid, 'exact-user-uuid');
});

test('a late timeout cannot resurrect a provider-returned cancelled attempt', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-returned');
  const cancelled = store.settle('tab-a', 'handoff-returned', {
    queueStatus: 'cancelled',
    reason: 'provider-queue-returned-to-terminal-composer',
    changedAt: 300,
  });
  const stale = store.settle('tab-a', 'handoff-returned', {
    queueStatus: 'audit-pending',
    reason: 'send-submitted-audit-pending',
    changedAt: 400,
  });

  assert.strictEqual(stale, cancelled);
  assert.equal(stale?.queueStatus, 'cancelled');
  assert.equal(stale?.statusReason, 'provider-queue-returned-to-terminal-composer');
  assert.equal(stale?.statusChangedAt, 300);
});

test('only a genuinely new send attempt can reset an exact receipt', () => {
  const store = new HistoryPromptHandoffStore(limits());
  store.begin({
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
    toolType: 'codex',
    text: 'prompt',
    submittedAt: 100,
  });
  const exact = store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'audit-confirmed',
    changedAt: 200,
    proof: {
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      actualHash: 'exact-hash',
      sessionId: 'session-live',
      entryUuid: 'exact-user-uuid',
    },
  });

  const duplicate = store.begin({
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
    toolType: 'codex',
    text: 'prompt',
    submittedAt: 250,
  });
  assert.strictEqual(duplicate, exact);

  const retried = store.begin({
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    sendAttemptId: 'attempt-b',
    sendOperationKey: 'project:tab-a:handoff-a',
    toolType: 'codex',
    text: 'prompt',
    submittedAt: 300,
  });
  assert.equal(retried?.sendAttemptId, 'attempt-b');
  assert.equal(retried?.queueStatus, 'sending');
  assert.equal(retried?.statusReason, 'send-retry-start');
  assert.equal(retried?.statusChangedAt, 300);
  assert.equal(retried?.auditProof, null);
});

test('cached SENDING and CONFIRMING rows reconcile from the exact handoff snapshot', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-sending');
  begin(store, 'tab-a', 'handoff-confirming');
  begin(store, 'tab-a', 'handoff-missing');
  store.settle('tab-a', 'handoff-sending', {
    queueStatus: 'sent',
    reason: 'audit-confirmed',
    changedAt: 210,
    proof: {
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      actualHash: 'hash-sending',
      sessionId: 'session-tab-a',
      entryUuid: 'durable-sending-uuid',
    },
  });
  store.settle('tab-a', 'handoff-confirming', {
    queueStatus: 'sent',
    reason: 'late-audit-confirmed',
    changedAt: 220,
    proof: {
      auditTimestamp: '2026-08-06T12:00:01.000Z',
      actualHash: 'hash-confirming',
      sessionId: 'session-tab-a',
      entryUuid: 'durable-confirming-uuid',
      sourceIdentity: 'codex-user-session-tab-a-2',
      recordByteOffset: 4096,
    },
  });
  store.settle('tab-a', 'handoff-missing', {
    queueStatus: 'audit-pending',
    reason: 'send-submitted-audit-pending',
    changedAt: 230,
  });

  const cachedSending = cachedProjectionRow('handoff-sending', 'sending');
  const cachedConfirming = cachedProjectionRow('handoff-confirming', 'audit-pending');
  const result = reconcileHistoryPromptHandoffRows<TestProjectionRow>({
    rows: [cachedSending, cachedConfirming],
    handoffs: store.getSnapshot('tab-a'),
    createRow: createProjectionRow,
  });
  const byId = new Map(result.rows.map(row => [row.handoffId, row]));

  assert.equal(result.changed, true);
  assert.equal(result.updated, 2);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 0);
  assert.equal(byId.get('handoff-sending')?.queueStatus, 'sent');
  assert.equal(byId.get('handoff-sending')?.statusReason, 'audit-confirmed');
  assert.equal(byId.get('handoff-sending')?.statusChangedAt, 210);
  assert.equal(byId.get('handoff-sending')?.auditEntryUuid, 'durable-sending-uuid');
  assert.equal(byId.get('handoff-confirming')?.queueStatus, 'sent');
  assert.equal(byId.get('handoff-confirming')?.auditHash, 'hash-confirming');
  assert.equal(byId.get('handoff-confirming')?.auditEntryUuid, 'durable-confirming-uuid');
  assert.equal(byId.get('handoff-confirming')?.sourceIdentity, 'codex-user-session-tab-a-2');
  assert.equal(byId.get('handoff-confirming')?.recordByteOffset, 4096);
  assert.equal(byId.get('handoff-missing')?.queueStatus, 'audit-pending');
  assert.equal(byId.get('handoff-missing')?.content, 'same prompt');
});

test('snapshot absence cannot remove a local SENT row without an exact tombstone', () => {
  const localSent = {
    ...cachedProjectionRow('handoff-evicted', 'sent'),
    statusReason: 'audit-confirmed',
    auditEntryUuid: 'durable-proof-not-loaded',
  };
  const cachedRows = [localSent];
  const retained = reconcileHistoryPromptHandoffRows<TestProjectionRow>({
    rows: cachedRows,
    handoffs: [],
    createRow: createProjectionRow,
  });

  assert.strictEqual(retained.rows, cachedRows);
  assert.strictEqual(retained.rows[0], localSent);
  assert.equal(retained.changed, false);
  assert.equal(retained.removed, 0);
});

test('identical prompts reconcile only by exact handoff id', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a', 'byte-identical prompt');
  begin(store, 'tab-a', 'handoff-b', 'byte-identical prompt');
  store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'audit-a',
    changedAt: 201,
    proof: {
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      actualHash: 'hash-a',
      sessionId: 'session-tab-a',
      entryUuid: 'entry-a',
    },
  });
  store.settle('tab-a', 'handoff-b', {
    queueStatus: 'audit-pending',
    reason: 'pending-b',
    changedAt: 202,
  });
  const rowB = cachedProjectionRow('handoff-b', 'sending', 'byte-identical prompt');
  const rowA = cachedProjectionRow('handoff-a', 'audit-pending', 'byte-identical prompt');

  const result = reconcileHistoryPromptHandoffRows<TestProjectionRow>({
    rows: [rowB, rowA],
    handoffs: store.getSnapshot('tab-a'),
    createRow: createProjectionRow,
  });

  assert.equal(result.rows[0]?.handoffId, 'handoff-b');
  assert.equal(result.rows[0]?.queueStatus, 'audit-pending');
  assert.equal(result.rows[0]?.auditEntryUuid, undefined);
  assert.equal(result.rows[1]?.handoffId, 'handoff-a');
  assert.equal(result.rows[1]?.queueStatus, 'sent');
  assert.equal(result.rows[1]?.auditEntryUuid, 'entry-a');
});

test('only explicit consumed or retracted tombstones remove local rows', () => {
  const keep = cachedProjectionRow('handoff-keep', 'sent');
  const consume = cachedProjectionRow('handoff-consume', 'sent');
  const retract = cachedProjectionRow('handoff-retract', 'audit-pending');
  const result = reconcileHistoryPromptHandoffRows<TestProjectionRow>({
    rows: [keep, consume, retract],
    handoffs: [],
    tombstones: [
      { handoffId: 'handoff-consume', state: 'consumed' },
      { handoffId: 'handoff-retract', state: 'retracted' },
    ],
    createRow: createProjectionRow,
  });

  assert.deepEqual(result.rows.map(row => row.handoffId), ['handoff-keep']);
  assert.equal(result.removed, 2);
});

test('reconciliation stays within hard row and snapshot bounds', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  begin(store, 'tab-a', 'handoff-b');
  begin(store, 'tab-a', 'handoff-c');
  let createCalls = 0;
  const bounded = reconcileHistoryPromptHandoffRows<TestProjectionRow>({
    rows: [cachedProjectionRow('existing', 'sent')],
    handoffs: store.getSnapshot('tab-a'),
    createRow: (handoff) => {
      createCalls += 1;
      return createProjectionRow(handoff);
    },
    limits: { maxRows: 2, maxHandoffs: 2, maxTombstones: 1 },
  });

  assert.equal(bounded.rows.length, 2);
  assert.equal(bounded.added, 1);
  assert.equal(createCalls, 1);
  assert.equal(bounded.truncated, true);

  const oversizedRows = [
    cachedProjectionRow('one', 'sent'),
    cachedProjectionRow('two', 'sent'),
    cachedProjectionRow('three', 'sent'),
  ];
  const rejectedTranscriptWalk = reconcileHistoryPromptHandoffRows<TestProjectionRow>({
    rows: oversizedRows,
    handoffs: store.getSnapshot('tab-a'),
    createRow: () => {
      throw new Error('must not walk or add when local overlay exceeds its bound');
    },
    limits: { maxRows: 2 },
  });
  assert.strictEqual(rejectedTranscriptWalk.rows, oversizedRows);
  assert.equal(rejectedTranscriptWalk.changed, false);
  assert.equal(rejectedTranscriptWalk.truncated, true);
});

test('duplicate begin is idempotent and cannot regress a settled handoff', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'submitted',
    changedAt: 200,
  });

  const duplicate = begin(store, 'tab-a', 'handoff-a', 'replacement text');
  assert.equal(duplicate?.text, 'same prompt');
  assert.equal(duplicate?.queueStatus, 'sent');
  assert.equal(store.getSnapshot('tab-a').length, 1);
});

test('a proven pre-Enter failure can begin a new exact attempt without stale attempt ownership', () => {
  const store = new HistoryPromptHandoffStore(limits());
  store.begin({
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
    toolType: 'codex',
    text: 'prompt',
  });
  store.settle('tab-a', 'handoff-a', {
    queueStatus: 'failed',
    reason: 'not-submitted',
  });

  const retried = store.begin({
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    sendAttemptId: 'attempt-b',
    sendOperationKey: 'project:tab-a:handoff-a',
    toolType: 'codex',
    text: 'prompt',
  });

  assert.equal(retried?.sendAttemptId, 'attempt-b');
  assert.equal(retried?.queueStatus, 'sending');
  assert.equal(retried?.auditProof, null);
});

test('late audit A cannot confirm retry attempt B', () => {
  const handoff = {
    sendAttemptId: 'attempt-b',
    sendOperationKey: 'project:tab-a:handoff-a',
  };
  assert.equal(historyPromptHandoffAcceptsAuditIdentity(handoff, {
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
  }), false);
  assert.equal(historyPromptHandoffAcceptsAuditIdentity(handoff, {
    sendAttemptId: 'attempt-b',
    sendOperationKey: 'project:tab-a:handoff-a',
  }), true);
  assert.equal(historyPromptHandoffAcceptsAuditIdentity(handoff, {
    sendAttemptId: 'attempt-b',
    sendOperationKey: 'project:tab-foreign:handoff-a',
  }), false);
});

test('send identity binds monotonically onto an existing exact receipt', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  const exact = store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'audit-confirmed',
    changedAt: 200,
    proof: {
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      actualHash: 'exact-hash',
      sessionId: 'session-live',
      entryUuid: 'exact-user-uuid',
    },
  });

  const bound = store.bindSendIdentity('tab-a', 'handoff-a', {
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
  });

  assert.equal(bound.ok, true);
  assert.equal(bound.ok && bound.changed, true);
  assert.equal(bound.ok && bound.handoff.sendAttemptId, 'attempt-a');
  assert.equal(bound.ok && bound.handoff.sendOperationKey, 'project:tab-a:handoff-a');
  assert.equal(bound.ok && bound.handoff.queueStatus, exact?.queueStatus);
  assert.equal(bound.ok && bound.handoff.statusReason, exact?.statusReason);
  assert.equal(bound.ok && bound.handoff.statusChangedAt, exact?.statusChangedAt);
  assert.deepEqual(bound.ok && bound.handoff.auditProof, exact?.auditProof);
});

test('a PREPARING dismiss waits for the exact durable send identity event', async () => {
  const tabId = 'tab-dismiss-before-reserve';
  const handoffId = 'handoff-dismiss-before-reserve';
  beginHistoryPromptHandoff({
    tabId,
    handoffId,
    toolType: 'codex',
    text: 'hide this presentation',
    submittedAt: Date.now(),
    initialStatus: 'preparing',
  });
  const waiting = waitForHistoryPromptHandoffSendIdentity(tabId, handoffId, 100);
  bindHistoryPromptHandoffSendIdentity(tabId, handoffId, {
    sendOperationKey: 'history:tab-dismiss-before-reserve:handoff-dismiss-before-reserve',
    sendAttemptId: 'attempt-dismiss-before-reserve',
  });
  const resolved = await waiting;
  assert.equal(resolved?.sendAttemptId, 'attempt-dismiss-before-reserve');
  consumeHistoryPromptHandoff(tabId, handoffId);
});

test('replaying the same send identity is idempotent', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');
  const first = store.bindSendIdentity('tab-a', 'handoff-a', {
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
  });
  const replay = store.bindSendIdentity('tab-a', 'handoff-a', {
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'project:tab-a:handoff-a',
  });

  assert.equal(first.ok && first.changed, true);
  assert.equal(replay.ok && replay.changed, false);
  assert.strictEqual(replay.ok && replay.handoff, first.ok && first.handoff);
});

test('foreign send identity conflicts are atomic and receipt-neutral', () => {
  const store = new HistoryPromptHandoffStore(limits());
  store.begin({
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    sendAttemptId: 'attempt-a',
    toolType: 'codex',
    text: 'prompt',
  });
  const exact = store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'audit-confirmed',
    changedAt: 200,
    proof: {
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      actualHash: 'exact-hash',
      sessionId: 'session-live',
      entryUuid: 'exact-user-uuid',
    },
  });

  assert.deepEqual(store.bindSendIdentity('tab-a', 'handoff-a', {
    sendAttemptId: 'attempt-foreign',
    sendOperationKey: 'foreign-operation-must-not-partially-bind',
  }), {
    ok: false,
    reason: 'send-attempt-id-conflict',
  });
  const afterAttemptConflict = store.getSnapshot('tab-a')[0];
  assert.equal(afterAttemptConflict?.sendAttemptId, 'attempt-a');
  assert.equal(afterAttemptConflict?.sendOperationKey, null);
  assert.equal(afterAttemptConflict?.queueStatus, exact?.queueStatus);
  assert.deepEqual(afterAttemptConflict?.auditProof, exact?.auditProof);

  const boundOperation = store.bindSendIdentity('tab-a', 'handoff-a', {
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'operation-a',
  });
  assert.equal(boundOperation.ok, true);
  assert.deepEqual(store.bindSendIdentity('tab-a', 'handoff-a', {
    sendAttemptId: 'attempt-a',
    sendOperationKey: 'operation-foreign',
  }), {
    ok: false,
    reason: 'send-operation-key-conflict',
  });
  const afterOperationConflict = store.getSnapshot('tab-a')[0];
  assert.equal(afterOperationConflict?.sendOperationKey, 'operation-a');
  assert.equal(afterOperationConflict?.queueStatus, exact?.queueStatus);
  assert.deepEqual(afterOperationConflict?.auditProof, exact?.auditProof);
});

test('an unverified post-Enter result cannot weaken exact audit identity', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'handoff-a');

  const settled = store.settle('tab-a', 'handoff-a', {
    queueStatus: 'sent',
    reason: 'send-submitted-unconfirmed',
    requiresAuditIdentity: false,
    changedAt: 200,
  });

  assert.equal(settled?.requiresAuditIdentity, true);
  assert.equal(settled?.auditProof, null);
});

test('expired failed and cancelled handoffs are not replayed after History remounts', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'failed');
  begin(store, 'tab-a', 'cancelled');
  begin(store, 'tab-a', 'sent');
  const expiredAt = Date.now() - HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS - 1;
  store.settle('tab-a', 'failed', {
    queueStatus: 'failed',
    reason: 'old-failure',
    changedAt: expiredAt,
  });
  store.settle('tab-a', 'cancelled', {
    queueStatus: 'cancelled',
    reason: 'old-cancel',
    changedAt: expiredAt,
  });
  store.settle('tab-a', 'sent', {
    queueStatus: 'sent',
    reason: 'awaiting-audit',
    changedAt: expiredAt,
  });

  const replays: string[][] = [];
  const unsubscribe = store.subscribe('tab-a', (snapshot, change) => {
    if (change.type === 'replay') {
      replays.push(snapshot.map(item => item.handoffId));
    }
  });

  assert.deepEqual(replays, [['sent']]);
  assert.equal(store.stats().tabs, 1);
  assert.equal(store.stats().handoffs, 1);
  unsubscribe();
});

test('retract and consume remove only the exact tab plus handoff key', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-a', 'shared-id', 'first');
  begin(store, 'tab-b', 'shared-id', 'second');
  begin(store, 'tab-a', 'other-id', 'third');

  assert.equal(store.retract('tab-a', 'shared-id', 'pre-submit-deferred'), true);
  assert.deepEqual(
    store.getSnapshot('tab-a').map(item => item.handoffId),
    ['other-id'],
  );
  assert.deepEqual(
    store.getSnapshot('tab-b').map(item => item.handoffId),
    ['shared-id'],
  );
  assert.equal(store.consume('tab-b', 'shared-id'), true);
  assert.deepEqual(store.getSnapshot('tab-b'), []);
  assert.equal(store.stats().handoffs, 1);
});

test('LRU bounds retain a recently observed background tab', () => {
  const store = new HistoryPromptHandoffStore(limits({
    maxTabs: 2,
    maxHandoffs: 3,
  }));
  begin(store, 'tab-a', 'a');
  begin(store, 'tab-b', 'b');
  store.getSnapshot('tab-a');
  begin(store, 'tab-c', 'c');

  assert.deepEqual(store.getSnapshot('tab-a').map(item => item.handoffId), ['a']);
  assert.deepEqual(store.getSnapshot('tab-b'), []);
  assert.deepEqual(store.getSnapshot('tab-c').map(item => item.handoffId), ['c']);
  assert.deepEqual(store.stats(), {
    tabs: 2,
    handoffs: 2,
    approxBytes: store.stats().approxBytes,
  });
});

test('byte bound rejects one oversized handoff without evicting valid state', () => {
  const store = new HistoryPromptHandoffStore(limits({
    maxBytes: 1_500,
  }));
  const valid = begin(store, 'tab-a', 'small', 'small');
  const before = store.stats();
  const oversized = begin(store, 'tab-b', 'large', 'x'.repeat(2_000));

  assert.ok(valid);
  assert.equal(oversized, undefined);
  assert.deepEqual(store.getSnapshot('tab-a').map(item => item.handoffId), ['small']);
  assert.deepEqual(store.getSnapshot('tab-b'), []);
  assert.deepEqual(store.stats(), before);
  assert.ok(store.stats().approxBytes <= 1_500);
});

test('external send publishes History handoff before transport and settles the same queued row', async () => {
  const store = new HistoryPromptHandoffStore(limits());
  const changes: HistoryPromptHandoffChange[] = [];
  store.subscribe('tab-api', (_snapshot, change) => {
    if (change.type !== 'replay') changes.push(change);
  });

  const result = await runHistoryPromptHandoff({
    tabId: 'tab-api',
    handoffId: 'api-handoff',
    toolType: 'codex',
    sessionIdHint: 'session-api',
    text: 'prompt from Project API',
    source: 'project-api',
    statusAtSend: 'busy',
    send: async (handoffId) => {
      const beforeTransport = store.getSnapshot('tab-api');
      assert.equal(handoffId, 'api-handoff');
      assert.equal(beforeTransport.length, 1);
      assert.equal(beforeTransport[0]?.queueStatus, 'sending');
      assert.equal(beforeTransport[0]?.text, 'prompt from Project API');
      return { success: true, submitted: true, queued: true };
    },
  }, store);

  assert.equal(result.handoffId, 'api-handoff');
  assert.equal(store.getSnapshot('tab-api')[0]?.queueStatus, 'queued');
  assert.deepEqual(changes, [
    { type: 'begin', handoffId: 'api-handoff' },
    { type: 'settle', handoffId: 'api-handoff' },
  ]);
});

test('external Claude/Codex local command settles without a conversation audit identity', async () => {
  for (const toolType of ['claude', 'codex'] as const) {
    const store = new HistoryPromptHandoffStore(limits());
    await runHistoryPromptHandoff({
      tabId: 'tab-' + toolType,
      handoffId: 'local-' + toolType,
      toolType,
      text: '/status',
      source: 'project-api',
      statusAtSend: 'active',
      send: async () => ({
        success: true,
        submitted: true,
        localSlashCommand: true,
      }),
    }, store);
    const handoff = store.getSnapshot('tab-' + toolType)[0];
    assert.equal(handoff?.queueStatus, 'sent');
    assert.equal(handoff?.requiresAuditIdentity, false);
    assert.equal(handoff?.auditProof, null);
    assert.equal(handoff?.statusReason, 'agent-local-command-submitted');
  }
});

test('post-Enter receipts remain visibly unconfirmed instead of becoming SENT', async () => {
  const store = new HistoryPromptHandoffStore(limits());

  await runHistoryPromptHandoff({
    tabId: 'tab-api',
    handoffId: 'delivery-unknown-handoff',
    toolType: 'codex',
    text: 'receipt missing',
    source: 'project-api',
    statusAtSend: 'active',
    send: async () => ({
      success: null,
      submitted: null,
      status: 'delivery-unknown',
      deliveryUnknown: true,
    }),
  }, store);
  await runHistoryPromptHandoff({
    tabId: 'tab-api',
    handoffId: 'audit-pending-handoff',
    toolType: 'codex',
    text: 'waiting for exact audit',
    source: 'project-api',
    statusAtSend: 'active',
    send: async () => ({
      success: null,
      submitted: true,
      status: 'audit-pending',
      auditPending: true,
    }),
  }, store);

  const byId = new Map(store.getSnapshot('tab-api').map(item => [item.handoffId, item]));
  assert.equal(byId.get('delivery-unknown-handoff')?.queueStatus, 'delivery-unknown');
  assert.equal(byId.get('delivery-unknown-handoff')?.statusReason, 'send-delivery-unknown');
  assert.equal(byId.get('audit-pending-handoff')?.queueStatus, 'audit-pending');
  assert.equal(byId.get('audit-pending-handoff')?.statusReason, 'send-submitted-audit-pending');
});

test('send result preserves exact provider queue return instead of reopening CONFIRMING', async () => {
  const store = new HistoryPromptHandoffStore(limits());
  const queueReturn = {
    success: false,
    submitted: true,
    cancelled: true,
    semanticStatus: 'not-submitted',
    providerAccepted: false,
    providerTurnCreated: false,
    providerQueueReturned: true,
    providerQueueOperation: 'popAll',
    composerDraftState: 'exact-provider-queue-return',
    draftPreserved: true,
    sourceIdentity: 'claude-queue:offset:session-a:20125979',
  };

  await runHistoryPromptHandoff({
    tabId: 'tab-api',
    handoffId: 'returned-handoff',
    toolType: 'claude',
    text: 'returned prompt',
    source: 'history-panel',
    statusAtSend: 'busy',
    send: async () => ({ ...queueReturn, pasteAudit: queueReturn }),
  }, store);

  const handoff = store.getSnapshot('tab-api')[0];
  assert.equal(handoff?.queueStatus, 'cancelled');
  assert.equal(handoff?.statusReason, 'provider-queue-returned-to-terminal-composer');
});

test('late exact audit promotes only its handoff to SENT', () => {
  const store = new HistoryPromptHandoffStore(limits());
  begin(store, 'tab-api', 'handoff-a');
  begin(store, 'tab-api', 'handoff-b');
  store.settle('tab-api', 'handoff-a', {
    queueStatus: 'audit-pending',
    reason: 'send-submitted-audit-pending',
  });
  store.settle('tab-api', 'handoff-b', {
    queueStatus: 'audit-pending',
    reason: 'send-submitted-audit-pending',
  });

  store.settle('tab-api', 'handoff-b', {
    queueStatus: 'sent',
    reason: 'late-audit-confirmed',
    proof: {
      auditTimestamp: '2026-08-03T14:00:00.000Z',
      actualHash: 'exact-b-hash',
      sessionId: 'session-tab-api',
      entryUuid: 'exact-b-entry',
    },
  });

  const byId = new Map(store.getSnapshot('tab-api').map(item => [item.handoffId, item]));
  assert.equal(byId.get('handoff-a')?.queueStatus, 'audit-pending');
  assert.equal(byId.get('handoff-a')?.auditProof, null);
  assert.equal(byId.get('handoff-b')?.queueStatus, 'sent');
  assert.equal(byId.get('handoff-b')?.auditProof?.entryUuid, 'exact-b-entry');
});

test('receipt and chip presentation distinguish confirming from unknown delivery', () => {
  assert.equal(historyPromptHandoffUnconfirmedStatusFromSendResult({
    status: 'audit-pending',
    auditPending: true,
  }), 'audit-pending');
  assert.equal(historyPromptHandoffUnconfirmedStatusFromSendResult({
    status: 'delivery-unknown',
    deliveryUnknown: true,
    auditPending: true,
  }), 'delivery-unknown');
  assert.equal(historyPromptHandoffUnconfirmedStatusFromSendResult({
    success: true,
    submitted: true,
  }), null);

  assert.deepEqual(historyPromptHandoffStatusPresentation('audit-pending'), {
    label: 'CONFIRMING',
    tone: 'accent',
    pending: true,
    title: 'Команда отправлена; приложение ждёт точного подтверждения в истории',
  });
  assert.deepEqual(historyPromptHandoffStatusPresentation('delivery-unknown'), {
    label: 'UNCONFIRMED',
    tone: 'warning',
    pending: false,
    title: 'Доставка не подтверждена. Не отправляйте текст повторно как новую команду',
  });
  assert.notEqual(historyPromptHandoffStatusPresentation('audit-pending')?.tone, 'success');
  assert.notEqual(historyPromptHandoffStatusPresentation('delivery-unknown')?.tone, 'success');
});

test('manual History and Run After share the receipt presentation mapping', () => {
  const historyPanelSource = readFileSync(
    new URL('../components/Workspace/HistoryPanel.tsx', import.meta.url),
    'utf8',
  );
  const queueRunnerSource = readFileSync(
    new URL('../hooks/usePromptQueueRunner.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    historyPanelSource,
    /const unconfirmedStatus = localSlashReceipt\.handled[\s\S]{0,320}historyPromptHandoffUnconfirmedStatusFromSendResult\(result\)/,
  );
  assert.match(
    historyPanelSource,
    /projectAgentLocalCommandSendResult\(\{/,
  );
  assert.match(
    historyPanelSource,
    /requiresAuditIdentity: resultOwnershipTransferred && !localSlashReceipt\.handled/,
  );
  assert.match(
    historyPanelSource,
    /bindHistoryPromptHandoffSendIdentity\([\s\S]{0,260}sendAttemptId: resultSendAttemptId,[\s\S]{0,120}sendOperationKey: resultSendOperationKey/,
  );
  assert.match(
    historyPanelSource,
    /const providerQueueReturned = !historyOnly && historyPromptAuditIsProviderQueueReturn\([\s\S]{0,120}result\?\.pasteAudit \|\| result/,
  );
  assert.match(
    historyPanelSource,
    /currentHandoff\.queueStatus === 'cancelled'[\s\S]{0,180}LOCAL_STATUS_IGNORED/,
  );
  assert.match(
    queueRunnerSource,
    /const unconfirmedStatus = localCommandReceipt\.handled[\s\S]{0,260}historyPromptHandoffUnconfirmedStatusFromSendResult\(res\)/,
  );
  assert.match(
    queueRunnerSource,
    /const providerQueueReturned = !localCommandReceipt\.handled[\s\S]{0,120}historyPromptAuditIsProviderQueueReturn\(res\?\.pasteAudit \|\| res/,
  );
  assert.match(
    queueRunnerSource,
    /settleHistoryPromptHandoff\(auditTabId, handoffId,[\s\S]{0,180}queueStatus: 'sent'/,
  );
});

test('a durable desktop History receipt rebuilds the exact pending row after renderer reload', () => {
  const tabId = 'tab-durable-reload';
  const handoffId = 'handoff-durable-reload';
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey: `history:${tabId}:${handoffId}`,
    surface: 'desktop-history',
    tabId,
    handoffId,
    provider: 'claude',
    sessionId: 'session-durable',
    state: 'audit-pending',
    attemptId: 'attempt-durable',
    createdAt: 100,
    updatedAt: 120,
    receipt: {
      source: 'history-panel',
      promptText: 'durable prompt',
      presentationSnapshot: { promptChips: [], imagePaths: [] },
    },
  });
  assert.equal(outcome.hydrated, true);
  const [handoff] = getHistoryPromptHandoffsSnapshot(tabId);
  assert.equal(handoff.handoffId, handoffId);
  assert.equal(handoff.sendAttemptId, 'attempt-durable');
  assert.equal(handoff.queueStatus, 'audit-pending');
  assert.equal(handoff.text, 'durable prompt');
  consumeHistoryPromptHandoff(tabId, handoffId);
});

test('a durable exact Claude queue receipt remounts as QUEUED instead of CONFIRMING', () => {
  const tabId = 'tab-durable-provider-queue';
  const handoffId = 'handoff-durable-provider-queue';
  const operationKey = `history:${tabId}:${handoffId}`;
  const attemptId = 'attempt-durable-provider-queue';
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey,
    surface: 'desktop-history',
    tabId,
    handoffId,
    provider: 'claude',
    sessionId: 'session-durable-provider-queue',
    state: 'audit-pending',
    attemptId,
    createdAt: 100,
    updatedAt: 160,
    receipt: {
      source: 'history-panel',
      promptText: 'already accepted into the native Claude queue',
      presentationSnapshot: { promptChips: [], imagePaths: [] },
      providerQueue: {
        accepted: true,
        provider: 'claude',
        operationKey,
        attemptId,
        acceptedAt: '2026-08-16T01:58:27.200Z',
        entryUuid: 'queue-operation-durable',
        sourceIdentity: 'claude-queue:uuid:queue-operation-durable',
        recordByteOffset: 84,
      },
    },
  });
  assert.equal(outcome.hydrated, true);
  assert.equal(outcome.handoff?.queueStatus, 'queued');
  assert.equal(outcome.handoff?.statusReason, 'durable-provider-queue-accepted');
  assert.equal(
    outcome.handoff?.providerQueueProof?.sourceIdentity,
    'claude-queue:uuid:queue-operation-durable',
  );
  assert.equal(outcome.handoff?.providerQueueProof?.recordByteOffset, 84);
  const projection = reconcileHistoryPromptHandoffRows({
    rows: [{
      uuid: `local-${handoffId}`,
      content: 'already accepted into the native Claude queue',
      handoffId,
      queueStatus: 'audit-pending',
      sessionId: 'session-durable-provider-queue',
    } satisfies TestProjectionRow],
    handoffs: outcome.handoff ? [outcome.handoff] : [],
    createRow: createProjectionRow,
  });
  assert.equal(
    projection.rows[0]?.sourceIdentity,
    'claude-queue:uuid:queue-operation-durable',
  );
  assert.equal(projection.rows[0]?.recordByteOffset, 84);
  consumeHistoryPromptHandoff(tabId, handoffId);
});

test('exact provider queue ownership survives startup delivery-unknown projection', () => {
  const tabId = 'tab-stale-provider-queue';
  const handoffId = 'handoff-stale-provider-queue';
  const operationKey = `history:${tabId}:${handoffId}`;
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey,
    surface: 'desktop-history',
    tabId,
    handoffId,
    provider: 'claude',
    sessionId: 'session-stale-provider-queue',
    state: 'delivery-unknown',
    attemptId: 'attempt-stale-provider-queue',
    createdAt: 100,
    updatedAt: 200,
    receipt: {
      source: 'history-panel',
      promptText: 'restart made the final delivery outcome unknown',
      providerQueue: {
        accepted: true,
        provider: 'claude',
        operationKey,
        attemptId: 'attempt-stale-provider-queue',
      },
    },
  });
  assert.equal(outcome.hydrated, true);
  assert.equal(outcome.handoff?.queueStatus, 'queued');
  consumeHistoryPromptHandoff(tabId, handoffId);
});

test('provider-not-accepted queue return does not resurrect a History card after remount', () => {
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey: 'history:tab-returned:handoff-returned',
    surface: 'desktop-history',
    tabId: 'tab-returned',
    handoffId: 'handoff-returned',
    provider: 'claude',
    sessionId: 'session-returned',
    state: 'provider-not-accepted',
    attemptId: 'attempt-returned',
    receipt: {
      promptText: 'the provider moved this back to its terminal composer',
      providerQueueReturned: true,
    },
  });
  assert.equal(outcome.hydrated, false);
  assert.equal(outcome.reason, 'durable-history-send-returned-to-terminal-composer');
});

test('a dismissed unconfirmed receipt stays hidden after renderer reload', () => {
  const tabId = 'tab-durable-dismissed';
  const handoffId = 'handoff-durable-dismissed';
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey: `history:${tabId}:${handoffId}`,
    surface: 'desktop-history',
    tabId,
    handoffId,
    provider: 'claude',
    sessionId: 'session-durable-dismissed',
    state: 'delivery-unknown',
    attemptId: 'attempt-durable-dismissed',
    createdAt: 100,
    updatedAt: 140,
    receipt: {
      source: 'history-panel',
      promptText: 'do not show this warning again',
      presentationDismissedAt: 130,
      presentationDismissedSurface: 'desktop-history',
    },
  });
  assert.equal(outcome.hydrated, false);
  assert.equal(outcome.reason, 'durable-history-presentation-dismissed');
  assert.deepEqual(getHistoryPromptHandoffsSnapshot(tabId), []);
});

test('durable confirmation hydrates as one final SENT snapshot without transient SENDING', () => {
  const tabId = 'tab-durable-confirmed-atomic';
  const handoffId = 'handoff-durable-confirmed-atomic';
  const observedStatuses: string[] = [];
  const unsubscribe = subscribeHistoryPromptHandoffs(tabId, (snapshot, change) => {
    if (change.type === 'replay') return;
    const record = snapshot.find(candidate => candidate.handoffId === handoffId);
    if (record) observedStatuses.push(record.queueStatus);
  });

  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey: `history:${tabId}:${handoffId}`,
    surface: 'desktop-history',
    tabId,
    handoffId,
    provider: 'claude',
    sessionId: 'session-durable-confirmed',
    state: 'confirmed',
    attemptId: 'attempt-durable-confirmed',
    createdAt: 200,
    updatedAt: 240,
    receipt: {
      source: 'history-panel',
      promptText: 'confirmed durable prompt',
      actualHash: 'hash-durable-confirmed',
      auditTimestamp: '2026-08-06T12:00:00.000Z',
      entryUuid: 'entry-durable-confirmed',
      recordByteOffset: 8192,
      presentationSnapshot: { promptChips: [], imagePaths: [] },
    },
  });

  assert.equal(outcome.hydrated, true);
  assert.deepEqual(observedStatuses, ['sent']);
  assert.equal(outcome.handoff?.queueStatus, 'sent');
  assert.equal(outcome.handoff?.auditProof?.recordByteOffset, 8192);
  unsubscribe();
  consumeHistoryPromptHandoff(tabId, handoffId);
});

test('durable presentation matching uses exact Claude UUID or Codex source identity aliases only', () => {
  const claudeReceipt = {
    operationKey: 'history:tab-a:claude-a',
    surface: 'desktop-history',
    tabId: 'tab-a',
    handoffId: 'claude-a',
    provider: 'claude',
    sessionId: 'session-a',
    state: 'confirmed',
    attemptId: 'attempt-claude',
    auditIdentity: {
      entryUuid: 'claude-user-exact',
      sourceIdentity: null,
    },
  };
  assert.equal(durableHistorySendReceiptMatchesCanonicalEntry(claudeReceipt, {
    uuid: 'claude-user-exact',
    sessionId: 'session-a',
  }), true);
  assert.equal(durableHistorySendReceiptMatchesCanonicalEntry(claudeReceipt, {
    uuid: 'claude-user-foreign',
    sessionId: 'session-a',
  }), false);

  const codexReceipt = {
    ...claudeReceipt,
    handoffId: 'codex-a',
    provider: 'codex',
    attemptId: 'attempt-codex',
    auditIdentity: {
      entryUuid: null,
      sourceIdentity: 'codex-user-source-session-a-4096',
    },
  };
  assert.equal(durableHistorySendReceiptMatchesCanonicalEntry(codexReceipt, {
    uuid: 'any-canonical-row-id',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-4096',
  }), true);
  assert.equal(durableHistorySendReceiptMatchesCanonicalEntry(codexReceipt, {
    uuid: 'canonical-event-row',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-8192',
    sourceIdentityAliases: ['codex-user-source-session-a-4096'],
  }), true, 'a promoted event carrier must retain the exact audited response carrier');
  assert.equal(durableHistorySendReceiptMatchesCanonicalEntry(codexReceipt, {
    uuid: 'same-text-is-not-proof',
    sessionId: 'session-a',
    sourceIdentity: 'codex-user-source-session-a-8192',
  }), false);
  assert.equal(durableHistorySendReceiptMatchesCanonicalEntry({
    ...codexReceipt,
    presentation: { acknowledgedAt: 1 },
  }, {
    sourceIdentity: 'codex-user-source-session-a-4096',
  }), false);
});

test('legacy orchestration SENT retires only against the exact durable run tag', () => {
  const handoff = {
    handoffId: 'orchestration-complete:run-a',
    source: 'orchestration-completion:run-a',
    queueStatus: 'sent' as const,
    sendOperationKey: null,
    sendAttemptId: null,
  };
  const canonical = {
    uuid: 'entry-a',
    sessionId: 'session-a',
    semanticTags: [{
      kind: 'orchestration',
      runId: 'run-a',
      phase: 'completion',
    }],
  };

  assert.equal(legacyOrchestrationCompletionMatchesCanonicalEntry(handoff, canonical), true);
  assert.equal(legacyOrchestrationCompletionMatchesCanonicalEntry(handoff, {
    ...canonical,
    semanticTags: [{ kind: 'orchestration', runId: 'run-b', phase: 'completion' }],
  }), false);
  assert.equal(legacyOrchestrationCompletionMatchesCanonicalEntry({
    ...handoff,
    source: 'orchestration-completion:run-b',
  }, canonical), false);
  assert.equal(legacyOrchestrationCompletionMatchesCanonicalEntry({
    ...handoff,
    sendOperationKey: 'history:tab:orchestration-complete:run-a',
  }, canonical), false);
  assert.equal(legacyOrchestrationCompletionMatchesCanonicalEntry({
    ...handoff,
    queueStatus: 'audit-pending',
  }, canonical), false);
});

test('acknowledged and legacy confirmed receipts never recreate an unconsumable SENT row', () => {
  const base = {
    operationKey: 'history:tab-legacy:handoff-legacy',
    surface: 'desktop-history',
    tabId: 'tab-legacy',
    handoffId: 'handoff-legacy',
    provider: 'codex',
    sessionId: 'session-legacy',
    state: 'confirmed',
    attemptId: 'attempt-legacy',
    updatedAt: 240,
    receipt: {
      promptText: 'already delivered',
      actualHash: 'hash-legacy',
      auditTimestamp: '2026-08-06T12:00:00.000Z',
    },
  };
  assert.equal(
    hydrateHistoryPromptHandoffFromDurableReceipt(base).reason,
    'durable-history-confirmed-identity-missing',
  );
  assert.equal(
    hydrateHistoryPromptHandoffFromDurableReceipt({
      ...base,
      receipt: {
        ...base.receipt,
        sourceIdentity: 'codex-user-source-session-legacy-4096',
        auditTimestamp: 1_786_105_206_500,
      },
    }).reason,
    'durable-history-confirmed-proof-incomplete',
  );
  assert.equal(
    hydrateHistoryPromptHandoffFromDurableReceipt({
      ...base,
      receipt: {
        ...base.receipt,
        sourceIdentity: 'codex-user-source-session-legacy-4096',
      },
      presentation: {
        attemptId: 'attempt-legacy',
        provider: 'codex',
        sessionId: 'session-legacy',
        sourceIdentity: 'codex-user-source-session-legacy-4096',
        acknowledgedAt: 1,
      },
    }).reason,
    'durable-history-presentation-already-materialized',
  );
  assert.deepEqual(getHistoryPromptHandoffsSnapshot('tab-legacy'), []);
});

test('Codex durable confirmation keeps its restart-stable source identity in the SENT proof', () => {
  const tabId = 'tab-codex-confirmed';
  const handoffId = 'handoff-codex-confirmed';
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey: `history:${tabId}:${handoffId}`,
    surface: 'desktop-history',
    tabId,
    handoffId,
    provider: 'codex',
    sessionId: 'session-codex',
    state: 'confirmed',
    attemptId: 'attempt-codex',
    updatedAt: 240,
    receipt: {
      promptText: 'confirmed Codex prompt',
      actualHash: 'hash-codex',
      auditTimestamp: '2026-08-07T06:46:46.000Z',
      sourceIdentity: 'codex-user-source-session-codex-4096',
    },
  });
  assert.equal(outcome.hydrated, true);
  assert.equal(
    outcome.handoff?.auditProof?.sourceIdentity,
    'codex-user-source-session-codex-4096',
  );
  consumeHistoryPromptHandoff(tabId, handoffId);
});

test('a pre-Enter restart restores draft text instead of inventing a sent row', () => {
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    operationKey: 'history:tab-draft:handoff-draft',
    surface: 'desktop-history',
    tabId: 'tab-draft',
    handoffId: 'handoff-draft',
    provider: 'codex',
    state: 'not-submitted',
    attemptId: 'attempt-draft',
    receipt: { promptText: 'restore me' },
  });
  assert.equal(outcome.hydrated, false);
  assert.equal(outcome.restorableDraft, 'restore me');
  assert.deepEqual(getHistoryPromptHandoffsSnapshot('tab-draft'), []);
});
