import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginHistoryPromptHandoff,
  consumeHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot,
  hydrateHistoryPromptHandoffFromDurableReceipt,
} from './historyPromptHandoffs.ts';

let sequence = 0;
function record() {
  const tabId = 'message-retry-' + ++sequence;
  return { tabId, handoffId: 'tab-message:Q', operationKey: 'tab-message:Q',
    provider: 'codex', surface: 'tab-message', sessionId: 'S', attemptId: 'A', state: 'not-submitted',
    createdAt: 1000, updatedAt: 2000,
    applicationQueue: { version: 1, id: 42, state: 'waiting', queuedAt: 1000, position: 43,
      waitingBeforeInput: true, lastNoWriteAttemptId: 'A' },
    receipt: { promptText: 'Frozen MCP question', submitted: false, pasteWritten: false,
      enterWritten: false, code: 'agent_send_target_unresolved' },
  };
}

test('same MCP handoff moves from failed to the Main-certified application wait', () => {
  const r = record();
  const failed = hydrateHistoryPromptHandoffFromDurableReceipt({ ...r,
    applicationQueue: { ...r.applicationQueue, state: 'failed', waitingBeforeInput: false } });
  assert.equal(failed.handoff?.queueStatus, 'failed');
  const waiting = hydrateHistoryPromptHandoffFromDurableReceipt(r);
  assert.equal(waiting.handoff?.queueStatus, 'application-queued');
  assert.equal(waiting.handoff?.text, r.receipt.promptText);
  assert.equal(waiting.handoff?.sendAttemptId, 'A', 'the old negative attempt is not overwritten by a read');
  assert.equal(waiting.handoff?.applicationQueuePosition, 43);
  // Only the real send scenario introduces B. An old A read cannot take it back.
  beginHistoryPromptHandoff({ tabId: r.tabId, handoffId: r.handoffId, toolType: 'codex',
    text: r.receipt.promptText, promptChips: [], imagePaths: [], submittedAt: 3000,
    sendOperationKey: r.operationKey, sendAttemptId: 'B' });
  assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(r).hydrated, false);
  assert.equal(getHistoryPromptHandoffsSnapshot(r.tabId)[0].sendAttemptId, 'B');
  consumeHistoryPromptHandoff(r.tabId, r.handoffId);
});

for (const fault of ['attempt', 'surface', 'paste', 'enter', 'unknown', 'cancel']) {
  test('MCP wait presentation rejects ' + fault, () => {
    const r: any = record();
    if (fault === 'attempt') r.applicationQueue.lastNoWriteAttemptId = 'foreign';
    if (fault === 'surface') r.surface = 'desktop-history';
    if (fault === 'paste') r.receipt.pasteWritten = true;
    if (fault === 'enter') r.receipt.enterWritten = true;
    if (fault === 'unknown') r.receipt.deliveryUnknown = true;
    if (fault === 'cancel') r.deliveryControl = { version: 1, cancelledAt: 1500 };
    const result = hydrateHistoryPromptHandoffFromDurableReceipt(r);
    assert.notEqual(result.handoff?.queueStatus, 'application-queued');
    consumeHistoryPromptHandoff(r.tabId, r.handoffId);
  });
}
