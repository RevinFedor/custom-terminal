import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateHistoryPromptHandoffFromDurableReceipt as hydrate,
  acceptHistoryPromptHandoffProviderQueue as acceptQueue,
  getHistoryPromptHandoffsSnapshot as snapshot, consumeHistoryPromptHandoff as consume } from './historyPromptHandoffs.ts';

function queued(id: string): any {
  const operationKey = 'tab-message:' + id, attemptId = 'attempt-' + id;
  return { tabId: 'control-projection', handoffId: id, operationKey, attemptId,
    surface: 'tab-message', provider: 'codex', sessionId: 'S', state: 'delivery-unknown',
    createdAt: 100, updatedAt: 200,
    applicationQueue: { version: 1, id: 1, state: 'awaiting-receipt', queuedAt: 100 },
    receipt: { promptText: 'exact frozen ' + id, status: 'queued', submitted: true,
      providerQueue: { accepted: true, provider: 'codex', operationKey, attemptId,
        sessionId: 'S', sourceIdentity: 'codex-tui-queue:' + id } } };
}

test('slot release projects historical unknown, never current native QUEUED, including late old receipt', () => {
  const r = queued('release');
  assert.equal(hydrate(r).handoff?.queueStatus, 'queued');
  const retired = { ...r, applicationQueue: { ...r.applicationQueue, state: 'released-unknown' },
    inputSlot: { version: 1, state: 'retired', reason: 'physical-input-owner-replaced', retiredAt: 300 } };
  assert.equal(hydrate(retired).handoff?.queueStatus, 'delivery-unknown');
  assert.equal(hydrate(r).handoff?.queueStatus, 'delivery-unknown', 'late queued proof cannot reacquire input presentation');
  consume(r.tabId, r.handoffId);
});

test('legacy MCP hide removes an existing optimistic row and late stale hydration cannot resurrect it', () => {
  const r = queued('legacy-hide'); hydrate(r);
  assert.equal(hydrate({ ...r, receipt: { ...r.receipt, presentationDismissedAt: 250,
    presentationDismissedSurface: 'desktop-history' } }).hydrated, false);
  assert.equal(snapshot(r.tabId).some(h => h.handoffId === r.handoffId), false);
  assert.equal(hydrate(r).hydrated, false);
  assert.equal(snapshot(r.tabId).some(h => h.handoffId === r.handoffId), false);
});

test('durable cancellation hides only the exact operation, without fabricating no-input or canonical proof', () => {
  const r = queued('cancel'), foreign = queued('keep'); hydrate(r); hydrate(foreign);
  const cancellation = { ...r, deliveryControl: { version: 1, cancelledAt: 300, presentationDismissed: true } };
  assert.equal(hydrate(cancellation).hydrated, false);
  assert.equal(hydrate(r).hydrated, false);
  assert.equal(snapshot(r.tabId).some(h => h.handoffId === foreign.handoffId), true);
  assert.equal(r.state, 'delivery-unknown');
  assert.equal(r.receipt.submitted, true);
  consume(foreign.tabId, foreign.handoffId);
});

test('canonical audit after input retirement remains stronger than slot presentation', () => {
  const r = queued('late-canonical');
  const retired = { ...r, applicationQueue: { ...r.applicationQueue, state: 'released-unknown' },
    inputSlot: { version: 1, state: 'retired', retiredAt: 300 } };
  hydrate(retired);
  const confirmed = { ...retired, state: 'confirmed', receipt: { ...r.receipt, status: 'sent',
    actualHash: 'hash', auditTimestamp: '2026-10-09T14:00:00Z', entryUuid: 'user-exact', sourceIdentity: 'source-exact' } };
  assert.equal(hydrate(confirmed).handoff?.queueStatus, 'sent');
  assert.equal(hydrate(r).handoff?.queueStatus, 'sent');
  consume(r.tabId, r.handoffId);
});

test('live native queue callback cannot override an exact later input-slot retirement', () => {
  const r = queued('live-callback'); hydrate(r);
  const args = { sendAttemptId: r.attemptId, sendOperationKey: r.operationKey,
    proof: { sourceIdentity: r.receipt.providerQueue.sourceIdentity, sessionId: 'S' } };
  acceptQueue(r.tabId, r.handoffId, args);
  const retired = { ...r, inputSlot: { version: 1, state: 'retired', retiredAt: 400 } };
  assert.equal(hydrate(retired).handoff?.queueStatus, 'delivery-unknown');
  assert.equal(acceptQueue(r.tabId, r.handoffId, args)?.queueStatus, 'delivery-unknown');
  consume(r.tabId, r.handoffId);
});
