import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HistoryPromptHandoffStore, historyPromptHandoffPresentationIdentity,
  beginHistoryPromptHandoff, settleHistoryPromptHandoff, consumeHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot, hydrateHistoryPromptHandoffFromDurableReceipt,
} from './historyPromptHandoffs.ts';
import {
  buildHistoryLivePresentation, reconcileCommittedHistoryLiveProjection,
} from './historyLiveProjection.mjs';

const sid = 'busy-session';
const base = { uuid: 'base', role: 'user', sessionId: sid, recordByteOffset: 10 };
const prompt = { uuid: 'accepted-prompt', role: 'queued', statusAtSend: 'busy',
  queueStatus: 'sent', sessionId: sid, recordByteOffset: 100,
  sourceIdentity: `codex-user-source-${sid}-100` };
const notice = { ...prompt, uuid: 'later-notice', recordByteOffset: 300,
  sourceIdentity: `codex-user-source-${sid}-300` };
const answer = { uuid: 'answer', role: 'assistant', sessionId: sid,
  recordByteOffset: 200, sourceIdentity: `codex-assistant-source-${sid}-200`, content: 'answer' };
const ids = (rows: any[]) => rows.map(row => row.uuid);

for (const queueStatus of ['failed', 'cancelled']) {
  test(`${queueStatus} does not move the current answer before later accepted prompts`, () => {
    const old = { uuid: 'old-attempt', role: 'queued', statusAtSend: 'busy', queueStatus, sessionId: sid };
    const pending = { ...old, uuid: 'future-input', queueStatus: 'queued' };
    const rows = buildHistoryLivePresentation([base, old, prompt, notice, pending], [answer]);
    assert.deepEqual(ids(rows), ['base', 'old-attempt', 'accepted-prompt', 'answer', 'later-notice', 'future-input']);
    assert.strictEqual(rows[1], old, 'failure remains visible with its own identity/status');
    const durable = [base, old, { ...prompt, role: 'user' }, answer, { ...notice, role: 'user' }, pending];
    const retained = reconcileCommittedHistoryLiveProjection([answer], durable).entries;
    assert.deepEqual(retained, []);
    assert.deepEqual(ids(buildHistoryLivePresentation(durable, retained)), ids(rows));
  });
}

for (const queueStatus of ['preparing', 'sending', 'queued', 'audit-pending', 'delivery-unknown']) {
  test(`true ${queueStatus} input stays after the current live answer`, () => {
    const pending = { uuid: 'future-input', role: 'queued', statusAtSend: 'busy', queueStatus, sessionId: sid };
    assert.deepEqual(ids(buildHistoryLivePresentation([base, prompt, pending], [answer])),
      ['base', 'accepted-prompt', 'answer', 'future-input']);
  });
}

const receipt = {
  queueStatus: 'sent' as const, reason: 'late-audit-confirmed', toolType: 'codex' as const,
  sendAttemptId: 'attempt', sendOperationKey: 'operation',
  proof: { auditTimestamp: '2026-09-14T00:41:24.225Z', actualHash: 'exact-hash',
    sessionId: sid, entryUuid: 'canonical-prompt', sourceIdentity: prompt.sourceIdentity, recordByteOffset: 100 },
};
function failedStore(status: 'failed' | 'cancelled' = 'failed') {
  const store = new HistoryPromptHandoffStore();
  store.begin({ tabId: 'tab', handoffId: 'handoff', toolType: 'codex', sessionIdHint: sid,
    text: 'same prompt', statusAtSend: 'busy', sendAttemptId: 'attempt', sendOperationKey: 'operation' });
  store.settle('tab', 'handoff', { queueStatus: status, reason: 'local-send-result' });
  return store;
}

for (const status of ['failed', 'cancelled'] as const) {
  test(`an exact late receipt promotes ${status} and immediately orders the same local row`, () => {
    const store = failedStore(status);
    const changed: string[] = [];
    store.subscribe('tab', (snapshot) => changed.push(snapshot[0]?.queueStatus));
    const before = store.getSnapshot('tab')[0];
    const promoted = store.settle('tab', 'handoff', receipt)!;
    assert.equal(promoted.queueStatus, 'sent');
    assert.equal(promoted.submittedAt, before.submittedAt);
    assert.ok(changed.includes('sent'), 'mounted History subscribers update without turn-end');
    const local = { uuid: 'local-prompt', role: 'queued', queueStatus: promoted.queueStatus,
      statusAtSend: promoted.statusAtSend, sessionId: sid, ...historyPromptHandoffPresentationIdentity(promoted) };
    assert.deepEqual(ids(buildHistoryLivePresentation([base, local, notice], [answer])),
      ['base', 'local-prompt', 'answer', 'later-notice']);
    const replay = store.settle('tab', 'handoff', { queueStatus: 'audit-pending', reason: 'old-timeout' });
    assert.strictEqual(replay, promoted);
    assert.equal(store.getSnapshot('tab').length, 1);
  });
}

test('terminal promotion rejects unproved, foreign and queue-only receipts', () => {
  const variants = [
    { ...receipt, sendAttemptId: undefined }, { ...receipt, sendOperationKey: undefined },
    { ...receipt, sendAttemptId: 'old-attempt' }, { ...receipt, sendOperationKey: 'foreign-operation' },
    { ...receipt, toolType: 'claude' as const }, { ...receipt, toolType: undefined },
    { ...receipt, proof: { ...receipt.proof, sessionId: 'foreign-session' } },
    { ...receipt, proof: { ...receipt.proof, actualHash: '' } },
    { ...receipt, proof: { ...receipt.proof, entryUuid: undefined, sourceIdentity: undefined } },
    { ...receipt, proof: { ...receipt.proof, sourceIdentity: 'codex-tui-queue:frame:1' } },
    { ...receipt, queueStatus: 'audit-pending' as const },
  ];
  for (const input of variants) {
    const store = failedStore(); const before = store.getSnapshot('tab')[0];
    assert.strictEqual(store.settle('tab', 'handoff', input), before, JSON.stringify(input));
  }
});

test('a refreshed exact durable receipt promotes only its existing attempt', () => {
  const tabId = 'durable-busy-tab', handoffId = 'durable-handoff';
  const record = { tabId, handoffId, operationKey: 'operation', attemptId: 'attempt',
    provider: 'codex', surface: 'desktop-history', sessionId: sid, state: 'confirmed',
    receipt: { promptText: 'same prompt', ...receipt.proof } };
  try {
    beginHistoryPromptHandoff({ tabId, handoffId, toolType: 'codex', sessionIdHint: sid,
      sendAttemptId: 'attempt', sendOperationKey: 'operation', text: 'same prompt', statusAtSend: 'busy' });
    settleHistoryPromptHandoff(tabId, handoffId, { queueStatus: 'failed', reason: 'local-failure' });
    assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(record).handoff?.queueStatus, 'sent');
    beginHistoryPromptHandoff({ tabId, handoffId, toolType: 'codex', sessionIdHint: sid,
      sendAttemptId: 'new-attempt', sendOperationKey: 'operation', text: 'same prompt' });
    const before = getHistoryPromptHandoffsSnapshot(tabId)[0];
    assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(record).hydrated, false);
    assert.strictEqual(getHistoryPromptHandoffsSnapshot(tabId)[0], before);
  } finally { consumeHistoryPromptHandoff(tabId, handoffId); }
});
