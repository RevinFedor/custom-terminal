import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  HISTORY_PROMPT_FAILURE_REPLAY_TTL_MS,
  HistoryPromptHandoffStore,
  historyPromptHandoffStatusPresentation,
  historyPromptHandoffAcceptsAuditIdentity,
  historyPromptHandoffUnconfirmedStatusFromSendResult,
  runHistoryPromptHandoff,
  type HistoryPromptHandoffChange,
  type HistoryPromptHandoffStoreLimits,
} from './historyPromptHandoffs.ts';

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
    /const unconfirmedStatus = historyPromptHandoffUnconfirmedStatusFromSendResult\(result\)/,
  );
  assert.match(
    queueRunnerSource,
    /const unconfirmedStatus = historyPromptHandoffUnconfirmedStatusFromSendResult\(res\)/,
  );
  assert.match(
    queueRunnerSource,
    /settleHistoryPromptHandoff\(auditTabId, handoffId,[\s\S]{0,180}queueStatus: 'sent'/,
  );
});
