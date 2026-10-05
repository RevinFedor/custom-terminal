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
