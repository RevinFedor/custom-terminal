import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryPromptHandoffStore, hydrateHistoryPromptHandoffFromDurableReceipt,
  getHistoryPromptHandoffsSnapshot, consumeHistoryPromptHandoff, historyPromptHandoffStatusPresentation,
  runHistoryPromptHandoff } from './historyPromptHandoffs.ts';

function record(id: string): any {
  return { tabId: 'application-queue-test', handoffId: id, operationKey: 'history:application-queue-test:' + id,
    surface: 'desktop-history', provider: 'codex', sessionId: null, state: 'reserved', attemptId: null,
    createdAt: 1791070000000, updatedAt: 1791070000000,
    applicationQueue: { version: 1, id: 1, state: 'waiting', queuedAt: 1791070000000 },
    receipt: { promptText: 'text [Image #1]', presentationSnapshot: { imagePaths: [{ id: 1, path: '/var/a.png' }] },
      authoringSnapshot: { editorText: 'text [Image #1]', chips: [{ kind: 'prompt', text: 'context' }],
        imagePaths: [{ id: 1, path: '/var/a.png' }] } } };
}

test('unwritten durable item hydrates without fake attempt/provider proof and preserves its authoring', () => {
  const r = record('pending');
  const result = hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(result.hydrated, true);
  const handoff = result.handoff!;
  assert.equal(handoff.queueStatus, 'application-queued');
  assert.equal(handoff.sendAttemptId, null); assert.equal(handoff.providerQueueProof, null);
  assert.equal(handoff.authoringChips[0].text, 'context');
  assert.equal(handoff.authoringImagePaths[0].path, '/var/a.png');
  const presentation = historyPromptHandoffStatusPresentation(handoff.queueStatus);
  assert.equal(presentation.label, 'IN APP QUEUE'); assert.equal(presentation.pending, false);
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
});

test('canonical attempt adoption and a late admission receipt cannot resurrect application waiting', () => {
  const r = record('promoted');
  hydrateHistoryPromptHandoffFromDurableReceipt(r);
  const sent = { ...r, state: 'confirmed', sessionId: 'S', attemptId: 'A',
    applicationQueue: { ...r.applicationQueue, state: 'completed' },
    receipt: { ...r.receipt, actualHash: 'H', auditTimestamp: new Date().toISOString(),
      sessionId: 'S', entryUuid: 'user-A' }, auditIdentity: { attemptId: 'A', sessionId: 'S', entryUuid: 'user-A' } };
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(sent).handoff?.queueStatus, 'sent');
  hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(getHistoryPromptHandoffsSnapshot(r.tabId).find(h => h.handoffId === r.handoffId)?.queueStatus, 'sent');
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
});

test('durable refusal after dequeue leaves a failed recoverable row instead of IN APP QUEUE forever', () => {
  const r = record('refused'); hydrateHistoryPromptHandoffFromDurableReceipt(r);
  const refused = { ...r, state: 'not-submitted', attemptId: 'A',
    applicationQueue: { ...r.applicationQueue, state: 'failed' },
    receipt: { ...r.receipt, submitted: false, code: 'codex_tui_not_ready' } };
  const result = hydrateHistoryPromptHandoffFromDurableReceipt(refused);
  assert.equal(result.handoff?.queueStatus, 'failed');
  assert.equal(result.handoff?.authoringChips[0].text, 'context');
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
});

test('failed application snapshot does not expire after the legacy 15-second failure timer', () => {
  const r = record('persistent-failure');
  const result = hydrateHistoryPromptHandoffFromDurableReceipt({ ...r, state: 'not-submitted',
    receipt: { ...r.receipt, submitted: false }, updatedAt: 1 });
  assert.equal(result.handoff?.applicationQueueId, 1);
  assert.equal(getHistoryPromptHandoffsSnapshot(r.tabId).find(h => h.handoffId === r.handoffId)?.queueStatus, 'failed');
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
});

test('waiting cancellation never claims provider acceptance; dismissed item does not revive', () => {
  const r = record('cancelled'); hydrateHistoryPromptHandoffFromDurableReceipt(r);
  const cancelled = { ...r, state: 'not-submitted', applicationQueue: { ...r.applicationQueue, state: 'cancelled' },
    receipt: { ...r.receipt, cancelled: true } };
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(cancelled).handoff?.queueStatus, 'cancelled');
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt({ ...cancelled,
    receipt: { ...cancelled.receipt, presentationDismissedAt: Date.now(), presentationDismissedSurface: 'desktop-history' } }).hydrated, false);
});

test('the shared handoff wrapper distinguishes accepted application work from pre-Enter rejection', async () => {
  const store = new HistoryPromptHandoffStore();
  const r = record('wrapper');
  const result = await runHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId,
    toolType: 'codex', text: r.receipt.promptText,
    send: async () => ({ applicationQueued: true, applicationQueue: { version: 1 },
      operationKey: r.operationKey, submitted: false, success: true }) }, store);
  assert.equal(result.applicationQueued, true);
  assert.equal(store.getSnapshot(r.tabId)[0].queueStatus, 'application-queued');
});

const noInput = { success: false, accepted: false, deferred: true, automaticReadinessWait: 1,
  error: 'codex_input_not_ready', submitted: false, pasteWritten: false, enterWritten: false };
test('Main-certified busy deferral is IN APP QUEUE, not failed, through wrapper and remount', async () => {
  const r = record('automatic-wait'), store = new HistoryPromptHandoffStore();
  const result = await runHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId, toolType: 'codex',
    text: r.receipt.promptText, sendAttemptId: 'A', sendOperationKey: r.operationKey,
    send: async () => noInput }, store);
  assert.equal(result.submitted, false);
  assert.equal(store.getSnapshot(r.tabId)[0].queueStatus, 'application-queued');
  const wait = { ...r, attemptId: 'A', state: 'not-submitted', receipt: { ...r.receipt, ...noInput },
    applicationQueue: { ...r.applicationQueue, waitingBeforeInput: true, lastNoWriteAttemptId: 'A' } };
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(wait).handoff?.queueStatus, 'application-queued');
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt({ ...wait,
    applicationQueue: { ...wait.applicationQueue, state: 'cancelled' } }).handoff?.queueStatus, 'cancelled');
  hydrateHistoryPromptHandoffFromDurableReceipt(wait);
  assert.equal(getHistoryPromptHandoffsSnapshot(r.tabId)[0].queueStatus, 'cancelled', 'late waiting cannot undo Pause/Stop');
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
});

test('a late no-input receipt cannot replace a newer physical attempt or confirmed result', async () => {
  const r = record('wait-ordering'), store = new HistoryPromptHandoffStore();
  await runHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId, toolType: 'codex', text: 'body',
    sendAttemptId: 'A', sendOperationKey: r.operationKey, send: async () => noInput }, store);
  store.begin({ tabId: r.tabId, handoffId: r.handoffId, toolType: 'codex', text: 'body',
    sendAttemptId: 'B', sendOperationKey: r.operationKey });
  store.settle(r.tabId, r.handoffId, { queueStatus: 'application-queued', reason: 'automatic-readiness-wait',
    sendAttemptId: 'A', sendOperationKey: r.operationKey, noWriteAttemptId: 'A' });
  assert.equal(store.getSnapshot(r.tabId)[0].sendAttemptId, 'B');
  assert.equal(store.getSnapshot(r.tabId)[0].queueStatus, 'sending');
  store.settle(r.tabId, r.handoffId, { queueStatus: 'delivery-unknown', reason: 'lost reply', sendAttemptId: 'B', sendOperationKey: r.operationKey });
  store.settle(r.tabId, r.handoffId, { queueStatus: 'application-queued', reason: 'automatic-readiness-wait',
    sendAttemptId: 'B', sendOperationKey: r.operationKey, noWriteAttemptId: 'B' });
  assert.equal(store.getSnapshot(r.tabId)[0].queueStatus, 'delivery-unknown');
});
