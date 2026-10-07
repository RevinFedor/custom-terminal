import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryPromptHandoffStore, hydrateHistoryPromptHandoffFromDurableReceipt,
  getHistoryPromptHandoffsSnapshot, consumeHistoryPromptHandoff, historyPromptHandoffStatusPresentation,
  runHistoryPromptHandoff } from './historyPromptHandoffs.ts';
import { applyHistoryQueuedMessageMerge } from './historyPromptHandoffs.ts';

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

test('merge consumes only exact unattempted originals and hydrates one replacement with previous display time', () => {
  const a = record('merge-a'), b = record('merge-b');
  const guard = { version: 1, tabId: a.tabId, operationKey: b.operationKey, queueId: 2, requestHash: 'B',
    previousOperationKey: a.operationKey, previousQueueId: 1, previousRequestHash: 'A' };
  b.applicationQueue = { ...b.applicationQueue, id: 2, position: 2, mergePrevious: guard };
  hydrateHistoryPromptHandoffFromDurableReceipt(a); hydrateHistoryPromptHandoffFromDurableReceipt(b);
  const source = getHistoryPromptHandoffsSnapshot(a.tabId);
  assert.deepEqual(source.find(value => value.handoffId === b.handoffId)?.applicationQueueMerge, guard);
  const merged = { ...record('merged'), createdAt: a.createdAt + 1000,
    applicationQueue: { ...a.applicationQueue, id: 3, position: 1,
      merge: { version: 1, sourceOperationKeys: [a.operationKey, b.operationKey], presentationHandoffId: a.handoffId } },
    receipt: { promptText: 'first\n\nsecond', source: 'history-panel' } };
  const packet = { success: true, version: 1, requestId: 'merge', tabId: a.tabId, operationKey: merged.operationKey,
    sourceHandoffIds: [a.handoffId, b.handoffId], sourceOperationKeys: [a.operationKey, b.operationKey], record: merged };
  assert.equal(applyHistoryQueuedMessageMerge(packet), true);
  const rows = getHistoryPromptHandoffsSnapshot(a.tabId);
  assert.equal(rows.length, 1); assert.equal(rows[0].text, 'first\n\nsecond');
  assert.equal(rows[0].queueStatus, 'application-queued'); assert.equal(rows[0].sendAttemptId, null);
  assert.equal(rows[0].submittedAt, a.createdAt); assert.equal(rows[0].applicationQueuePosition, 1);
  assert.equal(rows[0].applicationQueuePresentationHandoffId, a.handoffId);
  assert.equal(rows[0].applicationQueueReplacement, true);
  assert.equal(applyHistoryQueuedMessageMerge(packet), true); assert.equal(getHistoryPromptHandoffsSnapshot(a.tabId).length, 1);
  for (const old of [a, b]) hydrateHistoryPromptHandoffFromDurableReceipt({ ...old, state: 'not-submitted',
    receipt: { ...old.receipt, mergedIntoOperationKey: merged.operationKey, presentationDismissedAt: Date.now(), presentationDismissedSurface: 'desktop-history' } });
  assert.equal(getHistoryPromptHandoffsSnapshot(a.tabId).length, 1, 'late original receipts cannot resurrect merged cards');
  consumeHistoryPromptHandoff(a.tabId, merged.handoffId);
});

test('a wrong merge packet cannot consume a physical or unrelated handoff', () => {
  const a = record('physical-a'), b = record('waiting-b');
  hydrateHistoryPromptHandoffFromDurableReceipt({ ...a, state: 'audit-pending', attemptId: 'A', applicationQueue: { ...a.applicationQueue, state: 'awaiting-receipt' } });
  hydrateHistoryPromptHandoffFromDurableReceipt(b);
  const merged = record('not-admitted');
  assert.equal(applyHistoryQueuedMessageMerge({ success: true, version: 1, tabId: a.tabId, operationKey: merged.operationKey,
    sourceHandoffIds: [a.handoffId, b.handoffId], sourceOperationKeys: [a.operationKey, b.operationKey], record: merged }), false);
  assert.equal(getHistoryPromptHandoffsSnapshot(a.tabId).length, 2);
  consumeHistoryPromptHandoff(a.tabId, a.handoffId); consumeHistoryPromptHandoff(a.tabId, b.handoffId);
});

test('a retired merge receipt removes its exact original cards without recreating a queued replacement', () => {
  const a = record('retired-a'), b = record('retired-b');
  hydrateHistoryPromptHandoffFromDurableReceipt(a); hydrateHistoryPromptHandoffFromDurableReceipt(b);
  const packet = { success: true, version: 1, requestId: 'retired-merge', tabId: a.tabId,
    operationKey: 'history:' + a.tabId + ':queued-merge:retired-merge',
    sourceHandoffIds: [a.handoffId, b.handoffId], sourceOperationKeys: [a.operationKey, b.operationKey],
    record: null, receiptRetired: true };
  assert.equal(applyHistoryQueuedMessageMerge(packet), true);
  assert.equal(getHistoryPromptHandoffsSnapshot(a.tabId).length, 0);
  assert.equal(applyHistoryQueuedMessageMerge(packet), true);
  assert.equal(getHistoryPromptHandoffsSnapshot(a.tabId).length, 0);
});

test('durable merge removal emits an explicit tombstone even when the bounded ledger lost the original', () => {
  const store = new HistoryPromptHandoffStore({ maxTabs: 1, maxHandoffs: 1, maxBytes: 65536 });
  const changes: any[] = [];
  const unsubscribe = store.subscribe('T', (_rows, change) => changes.push(change));
  store.begin({ tabId: 'T', handoffId: 'evicted-a', toolType: 'codex', text: 'first' });
  store.begin({ tabId: 'T', handoffId: 'retained-b', toolType: 'codex', text: 'second' });
  assert.deepEqual(store.getSnapshot('T').map(row => row.handoffId), ['retained-b']);
  changes.length = 0;
  store.consumeMergedSource('T', 'evicted-a');
  assert.deepEqual(changes.map(change => [change.type, change.handoffId]), [['consume', 'evicted-a']]);
  assert.deepEqual(store.getSnapshot('T').map(row => row.handoffId), ['retained-b']);
  unsubscribe();
});
