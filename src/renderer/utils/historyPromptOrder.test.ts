import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginHistoryPromptHandoff, consumeHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot, hydrateHistoryPromptHandoffFromDurableReceipt,
  historyPromptHandoffPresentationIdentity,
} from './historyPromptHandoffs.ts';
import { buildHistoryLivePresentation } from './historyLiveProjection.mjs';

const sid = 'prompt-order-session';
const prior = { uuid: 'first-prompt', role: 'user', sessionId: sid,
  sourceIdentity: `codex-user-source-${sid}-100` };
const answer = { uuid: 'previous-answer', role: 'assistant', sessionId: sid,
  sourceIdentity: `codex-assistant-source-${sid}-200`, content: 'Already visible answer' };
const ownAnswer = { ...answer, uuid: 'next-answer', sourceIdentity: `codex-assistant-source-${sid}-400` };
const ids = (entries: any[]) => entries.map(entry => entry.uuid);
const row = (handoff: any) => ({ uuid: 'second-prompt', role: 'queued', sessionId: sid,
  queueStatus: handoff.queueStatus, statusAtSend: handoff.statusAtSend,
  ...historyPromptHandoffPresentationIdentity(handoff) });

function receipt(tabId: string, toolType = 'codex') {
  return { tabId, handoffId: 'second', operationKey: `history:${tabId}:second`,
    provider: toolType, surface: 'desktop-history', sessionId: sid, attemptId: 'attempt-1',
    state: 'reserved', createdAt: 1791099723686, updatedAt: 1791099724203,
    receipt: { promptText: 'The next question', source: `${toolType}-history-panel` } };
}

for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: first durable attempt binding cannot erase the busy click-time order`, () => {
    const tabId = `prompt-order-${provider}`;
    try {
      const local = beginHistoryPromptHandoff({ tabId, handoffId: 'second', toolType: provider,
        sessionIdHint: sid, text: 'The next question', submittedAt: 1791099723686,
        statusAtSend: 'busy', initialStatus: 'queued' })!;
      assert.deepEqual(ids(buildHistoryLivePresentation([prior, row(local)], [answer])),
        ['first-prompt', 'previous-answer', 'second-prompt']);
      const bound = hydrateHistoryPromptHandoffFromDurableReceipt(receipt(tabId, provider)).handoff!;
      assert.equal(bound.sendAttemptId, 'attempt-1');
      assert.equal(bound.statusAtSend, 'busy', 'receipt carries no replacement observation of click-time status');
      assert.deepEqual(ids(buildHistoryLivePresentation([prior, row(bound)], [answer])),
        ['first-prompt', 'previous-answer', 'second-prompt']);
      assert.equal(getHistoryPromptHandoffsSnapshot(tabId).length, 1);
    } finally { consumeHistoryPromptHandoff(tabId, 'second'); }
  });
}

test('preserving click-time status does not turn an active send into a deferred prompt', () => {
  const tabId = 'prompt-order-active';
  try {
    beginHistoryPromptHandoff({ tabId, handoffId: 'second', toolType: 'codex',
      sessionIdHint: sid, text: 'The next question', statusAtSend: 'active' });
    const bound = hydrateHistoryPromptHandoffFromDurableReceipt(receipt(tabId)).handoff!;
    assert.equal(bound.statusAtSend, 'active');
    assert.deepEqual(ids(buildHistoryLivePresentation([row(bound)], [ownAnswer])),
      ['second-prompt', 'next-answer']);
  } finally { consumeHistoryPromptHandoff(tabId, 'second'); }
});

test('a genuine retry resets its click-time status while same-attempt receipt replay cannot', () => {
  const tabId = 'prompt-order-retry';
  try {
    beginHistoryPromptHandoff({ tabId, handoffId: 'second', toolType: 'codex', text: 'The next question',
      sessionIdHint: sid, sendAttemptId: 'attempt-1', statusAtSend: 'busy', initialStatus: 'queued' });
    const retried = beginHistoryPromptHandoff({ tabId, handoffId: 'second', toolType: 'codex',
      text: 'The next question', sessionIdHint: sid, sendAttemptId: 'attempt-2', statusAtSend: 'active' })!;
    assert.equal(retried.statusAtSend, 'active');
    assert.equal(retried.queueStatus, 'sending');
    assert.equal(retried.auditProof, null);
    assert.equal(hydrateHistoryPromptHandoffFromDurableReceipt(receipt(tabId)).hydrated, false,
      'the old physical attempt cannot restore old presentation state');
    assert.equal(getHistoryPromptHandoffsSnapshot(tabId)[0].sendAttemptId, 'attempt-2');
    const replay = beginHistoryPromptHandoff({ tabId, handoffId: 'second', toolType: 'codex',
      text: 'The next question', sendAttemptId: 'attempt-2', statusAtSend: 'unknown' });
    assert.strictEqual(replay, retried);
    const unknownRetry = beginHistoryPromptHandoff({ tabId, handoffId: 'second', toolType: 'codex',
      text: 'The next question', sendAttemptId: 'attempt-3', statusAtSend: 'unknown' })!;
    assert.equal(unknownRetry.statusAtSend, 'unknown', 'a real retry is not the first attempt binding');
  } finally { consumeHistoryPromptHandoff(tabId, 'second'); }
});

test('cold durable backlog retains order through first dispatch, queue ACK and exact adoption', () => {
  const tabId = 'prompt-order-cold';
  const raw = receipt(tabId);
  const applicationQueue = { version: 1, id: 23, state: 'waiting', queuedAt: raw.createdAt };
  const states: any[] = [
    { ...raw, attemptId: null, applicationQueue },
    { ...raw, applicationQueue: { ...applicationQueue, state: 'dispatching' } },
    { ...raw, state: 'audit-pending', receipt: { ...raw.receipt, providerQueue: {
      provider: 'codex', accepted: true, operationKey: raw.operationKey, attemptId: raw.attemptId,
      sourceIdentity: 'codex-tui-queue:frame:23', sessionId: sid,
    } } },
    { ...raw, state: 'confirmed', receipt: { ...raw.receipt, actualHash: 'exact-hash',
      auditTimestamp: '2026-10-04T07:42:06.564Z', sessionId: sid,
      entryUuid: 'canonical-second', sourceIdentity: `codex-user-source-${sid}-300`, recordByteOffset: 300 } },
  ];
  try {
    for (const raw of states) {
      const state = hydrateHistoryPromptHandoffFromDurableReceipt(raw);
      assert.equal(state.hydrated, true, state.reason);
      assert.equal(state.handoff!.statusAtSend, 'unknown', 'no invented busy observation');
      assert.deepEqual(ids(buildHistoryLivePresentation([prior, row(state.handoff)], [answer])),
        ['first-prompt', 'previous-answer', 'second-prompt'], raw.state);
    }
    const canonical = { ...row(getHistoryPromptHandoffsSnapshot(tabId)[0]), role: 'user' };
    assert.deepEqual(ids(buildHistoryLivePresentation([prior, answer, canonical], [answer, ownAnswer])),
      ['first-prompt', 'previous-answer', 'second-prompt', 'next-answer']);
  } finally { consumeHistoryPromptHandoff(tabId, 'second'); }
});

for (const queueStatus of ['application-queued', 'preparing', 'sending', 'queued', 'audit-pending', 'delivery-unknown']) {
  test(`a restored ${queueStatus} prompt with unknown click-time status stays after current output`, () => {
    const pending = { uuid: 'second-prompt', role: 'queued', queueStatus, statusAtSend: 'unknown', sessionId: sid };
    const later = { ...pending, uuid: 'third-prompt', queueStatus: 'application-queued' };
    assert.deepEqual(ids(buildHistoryLivePresentation([prior, pending, later], [answer])),
      ['first-prompt', 'previous-answer', 'second-prompt', 'third-prompt']);
    // A partial durable refresh moves the answer between storage layers, not
    // to the opposite side of either unconfirmed user row.
    assert.deepEqual(ids(buildHistoryLivePresentation([prior, answer, pending, later], [answer])),
      ['first-prompt', 'previous-answer', 'second-prompt', 'third-prompt']);
  });
}

test('IN APP QUEUE is future input even when the provider was active at the click', () => {
  const pending = { uuid: 'second-prompt', role: 'queued', queueStatus: 'application-queued', statusAtSend: 'active' };
  assert.deepEqual(ids(buildHistoryLivePresentation([prior, pending], [answer])),
    ['first-prompt', 'previous-answer', 'second-prompt']);
});

test('exact confirmation orders the same prompt between previous and next answers', () => {
  const confirmed = { uuid: 'second-prompt', role: 'queued', queueStatus: 'sent', statusAtSend: 'unknown',
    sessionId: sid, sourceIdentity: `codex-user-source-${sid}-300` };
  const pending = { ...confirmed, uuid: 'third-prompt', queueStatus: 'application-queued', sourceIdentity: undefined };
  assert.deepEqual(ids(buildHistoryLivePresentation([prior, confirmed, pending], [answer, ownAnswer])),
    ['first-prompt', 'previous-answer', 'second-prompt', 'next-answer', 'third-prompt']);
});
