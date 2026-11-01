import test from 'node:test';
import assert from 'node:assert/strict';
import { runHistoryPromptHandoff, hydrateHistoryPromptHandoffFromDurableReceipt,
  getHistoryPromptHandoffsSnapshot, consumeHistoryPromptHandoff,
  historyPromptHandoffStatusPresentation } from './historyPromptHandoffs.ts';

// Fedor31Oct: a programmatic Send from another tab follows the SAME History
// rule as the user's own input, decided by WHERE it failed.
//   refused before any byte reached the PTY -> no card (caller gets the error)
//   failed inside terminal state, or unknown  -> ordinary card
// The durable receipt is never touched by this rule.

const TAB = 'external-send-card-test';

function input(overrides: any = {}) {
  return {
    tabId: TAB,
    toolType: 'codex' as const,
    text: 'programmatic prompt',
    source: 'terminal-mcp',
    statusAtSend: 'active' as const,
    sendOperationKey: 'project:' + TAB + ':project-send:op',
    sendAttemptId: 'attempt-1',
    ...overrides,
  };
}

function rows() {
  return getHistoryPromptHandoffsSnapshot(TAB);
}

function cleanup() {
  for (const row of [...rows()]) consumeHistoryPromptHandoff(TAB, row.handoffId);
}

test('MCP send refused before input leaves no card in the user History', async (t) => {
  t.after(cleanup);
  // The real 4412 receipt: stopped tab, model+Send in one call, nothing written.
  const result = await runHistoryPromptHandoff(input({
    handoffId: 'h-not-submitted',
    send: async () => ({ success: false, submitted: false, pasteWritten: false,
      enterWritten: false, status: 'not-submitted', code: 'codex_settings_change_send_inflight' }),
  }));
  assert.equal(result.submitted, false, 'the caller still receives the refusal');
  assert.equal(result.handoffId, 'h-not-submitted', 'the handoff id is returned for receipt recovery');
  assert.equal(rows().length, 0, 'no SEND FAILED card is left for the user');
});

test('MCP send that reached the terminal and failed there keeps its card', async (t) => {
  t.after(cleanup);
  // Enter crossed; the failure is in terminal state. Indistinguishable from
  // the user typing the same prompt, so it must be shown.
  await runHistoryPromptHandoff(input({
    handoffId: 'h-after-input',
    send: async () => ({ success: false, submitted: true, enterWritten: true, pasteWritten: true }),
  }));
  const card = rows().find(row => row.handoffId === 'h-after-input');
  assert.ok(card, 'the card is kept');
  assert.equal(card!.queueStatus, 'failed');
  assert.equal(historyPromptHandoffStatusPresentation(card!.queueStatus)?.label, 'SEND FAILED');
});

test('unknown delivery keeps its card and is not downgraded to no-input', async (t) => {
  t.after(cleanup);
  // The real 8e88fd27 case: renderer receipt unavailable after 60s.
  await runHistoryPromptHandoff(input({
    handoffId: 'h-unknown',
    send: async () => ({ success: null, submitted: null, accepted: true,
      status: 'delivery-unknown', deliveryUnknown: true, code: 'bridge_timeout_delivery_unknown' }),
  }));
  const card = rows().find(row => row.handoffId === 'h-unknown');
  assert.ok(card, 'an unproven outcome still owns a card');
  assert.equal(card!.queueStatus, 'delivery-unknown');
  assert.equal(historyPromptHandoffStatusPresentation(card!.queueStatus)?.label, 'UNCONFIRMED');
});

test('the user own send keeps its card even when proven not submitted', async (t) => {
  t.after(cleanup);
  await runHistoryPromptHandoff(input({
    handoffId: 'h-own',
    source: 'history-panel',
    send: async () => ({ success: false, submitted: false, pasteWritten: false, enterWritten: false }),
  }));
  const card = rows().find(row => row.handoffId === 'h-own');
  assert.ok(card, 'the 18Oct own-send contract is unchanged');
  assert.equal(card!.queueStatus, 'failed');
});

test('a thrown transport refusal also leaves no card but still throws to the caller', async (t) => {
  t.after(cleanup);
  const error: any = new Error('bridge refused');
  error.sendReceipt = { submitted: false, pasteWritten: false, enterWritten: false };
  await assert.rejects(runHistoryPromptHandoff(input({
    handoffId: 'h-thrown',
    send: async () => { throw error; },
  })), /bridge refused/);
  assert.equal(rows().length, 0, 'no card for a refusal that never reached the PTY');
});

test('a thrown error with unknown delivery keeps its card', async (t) => {
  t.after(cleanup);
  const error: any = new Error('bridge timeout');
  error.sendReceipt = { submitted: null, deliveryUnknown: true };
  await assert.rejects(runHistoryPromptHandoff(input({
    handoffId: 'h-thrown-unknown',
    send: async () => { throw error; },
  })), /bridge timeout/);
  const card = rows().find(row => row.handoffId === 'h-thrown-unknown');
  assert.ok(card, 'uncertainty is preserved, not hidden');
  assert.equal(card!.queueStatus, 'delivery-unknown');
});

test('a durable receipt publication cannot reintroduce the suppressed card', (t) => {
  t.after(cleanup);
  // Main republishes the same not-submitted receipt (live publish or remount).
  // The rule must hold on that path too, or the card returns by the back door.
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    tabId: TAB,
    handoffId: 'h-republished',
    operationKey: 'project:' + TAB + ':project-send:republished',
    surface: 'project-api',
    provider: 'codex',
    sessionId: null,
    state: 'not-submitted',
    attemptId: null,
    createdAt: 1791070000000,
    updatedAt: 1791070000000,
    applicationQueue: { version: 1, id: 7, state: 'cancelled', queuedAt: 1791070000000 },
    receipt: { promptText: 'programmatic prompt', source: 'terminal-mcp',
      submitted: false, pasteWritten: false, enterWritten: false,
      code: 'codex_settings_change_send_inflight', presentationSnapshot: {} },
  } as any);
  assert.equal(outcome.hydrated, false);
  assert.equal(outcome.reason, 'external-send-no-terminal-input');
  assert.equal(rows().length, 0, 'the suppressed card does not come back');
});

test('a durable own-input receipt still hydrates its failure card', (t) => {
  t.after(cleanup);
  const outcome = hydrateHistoryPromptHandoffFromDurableReceipt({
    tabId: TAB,
    handoffId: 'h-own-durable',
    operationKey: 'history:' + TAB + ':h-own-durable',
    surface: 'desktop-history',
    provider: 'codex',
    sessionId: null,
    state: 'not-submitted',
    attemptId: null,
    createdAt: 1791070000000,
    updatedAt: 1791070000000,
    applicationQueue: { version: 1, id: 8, state: 'completed', queuedAt: 1791070000000 },
    receipt: { promptText: 'typed by hand', source: 'history-panel',
      submitted: false, presentationSnapshot: {} },
  } as any);
  assert.equal(outcome.hydrated, true, 'own sends keep the existing behaviour');
  assert.equal(outcome.handoff?.queueStatus, 'failed');
});
