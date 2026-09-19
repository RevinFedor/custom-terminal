'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DESKTOP_HISTORY_SEND_SURFACE,
  buildDesktopHistorySendIdentity,
  desktopHistorySendReplayResult,
  isDesktopHistorySendReceiptEligible,
  isOwnedDesktopHistorySendSource,
} = require('./agent-history-send-receipt');

test('owned desktop prompt surfaces receive automatic durable identity, but queue slash commands do not', () => {
  const base = {
    submit: true,
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    source: 'history-panel',
  };
  assert.equal(isDesktopHistorySendReceiptEligible(base), true);
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, source: 'codex-history-panel' }), true);
  assert.equal(isDesktopHistorySendReceiptEligible({
    ...base,
    handoffId: 'orchestration-complete:run-a',
    source: 'orchestration-completion:run-a',
  }), true);
  assert.equal(isDesktopHistorySendReceiptEligible({
    ...base,
    source: 'prompt-queue',
    rawPrompt: 'continue work',
  }), true);
  assert.equal(isDesktopHistorySendReceiptEligible({
    ...base,
    source: 'prompt-loop',
    rawPrompt: 'continue work',
  }), true);
  assert.equal(isDesktopHistorySendReceiptEligible({
    ...base,
    source: 'prompt-queue',
    rawPrompt: ' /compact',
  }), false);
  assert.equal(isDesktopHistorySendReceiptEligible({
    ...base,
    rawPrompt: '/status\nexplain this output',
  }), true, 'a multiline prompt is a conversation turn, not a local command');
  assert.equal(isDesktopHistorySendReceiptEligible({
    ...base,
    rawPrompt: '/status',
    presentationSnapshot: { imagePaths: [{ id: 1, path: '/tmp/a.png' }] },
  }), true, 'structured attachments keep the ordinary durable send contract');
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, submit: false }), false);
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, sendOperationKey: 'owned' }), false);
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, sendAttemptId: 'attempt' }), false);
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, source: 'orchestration-request:run-a' }), false);
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, source: 'orchestration-completion:' }), false);
});

test('orchestration completion notification owns an exact durable History identity', () => {
  const identity = buildDesktopHistorySendIdentity({
    tabId: 'tab-a',
    handoffId: 'orchestration-complete:run-a',
    provider: 'codex',
    source: 'orchestration-completion:run-a',
    rawPrompt: '[Orchestration] Request completed',
    sessionId: 'session-a',
    promptHash: 'transport-hash',
    promptLength: 33,
  });

  assert.equal(
    identity.operationKey,
    'history:tab-a:orchestration-complete:run-a',
  );
  assert.equal(identity.handoffId, 'orchestration-complete:run-a');
  assert.equal(identity.surface, DESKTOP_HISTORY_SEND_SURFACE);
});

test('one Codex provider wrapper preserves only recognized History/automation/completion origins', () => {
  for (const source of ['codex-orchestration-completion:run-a', 'codex-prompt-queue', 'codex-prompt-loop']) {
    assert.equal(isOwnedDesktopHistorySendSource(source), true, source);
    assert.equal(isDesktopHistorySendReceiptEligible({
      submit: true, tabId: 'tab', handoffId: 'handoff', source, rawPrompt: 'context plus prompt',
    }), true, source);
  }
  for (const source of ['codex-arbitrary', 'codex-orchestration-request:run-a',
    'codex-orchestration-completion:', 'codex-codex-prompt-queue',
    'codex-codex-orchestration-completion:run-a', 'codex-codex-history-panel']) {
    assert.equal(isOwnedDesktopHistorySendSource(source), false, source);
  }
});

test('provider wrapper recognition does not normalize raw fingerprints or bypass explicit identity/slash exclusions', () => {
  const input = {
    tabId: 'tab', handoffId: 'handoff', provider: 'codex',
    source: 'codex-orchestration-completion:run-a', rawPrompt: 'context plus prompt',
    promptHash: 'raw-transport-hash', promptLength: 19,
  };
  const first = buildDesktopHistorySendIdentity(input);
  assert.deepEqual(first, buildDesktopHistorySendIdentity(input));
  assert.notEqual(first.requestFingerprint, buildDesktopHistorySendIdentity({
    ...input, source: 'orchestration-completion:run-a',
  }).requestFingerprint, 'source remains part of the raw immutable request');
  const base = { ...input, submit: true };
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, sendOperationKey: 'project:explicit' }), false);
  assert.equal(isDesktopHistorySendReceiptEligible({ ...base, sendAttemptId: 'explicit-attempt' }), false);
  for (const source of ['codex-prompt-queue', 'codex-prompt-loop', 'codex-orchestration-completion:run-a']) {
    assert.equal(isDesktopHistorySendReceiptEligible({ ...base, source, rawPrompt: '/status' }), false);
  }
});

test('raw request identity stays distinct while transport identity follows the written prompt', () => {
  const common = {
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'claude',
    source: 'history-panel',
    sessionId: 'session-a',
    promptHash: 'transport-hash',
    promptLength: 14,
  };
  const withTab = buildDesktopHistorySendIdentity({ ...common, rawPrompt: 'left\tright' });
  const withSpaces = buildDesktopHistorySendIdentity({ ...common, rawPrompt: 'left    right' });

  assert.equal(withTab.surface, DESKTOP_HISTORY_SEND_SURFACE);
  assert.equal(withTab.operationKey, 'history:tab-a:handoff-a');
  assert.equal(withTab.promptHash, withSpaces.promptHash);
  assert.notEqual(withTab.requestFingerprint, withSpaces.requestFingerprint);
  assert.equal(Object.isFrozen(withTab), true);
});

test('same raw send is stable and different handoff cannot adopt its receipt', () => {
  const input = {
    tabId: 'tab-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    source: 'codex-history-panel',
    rawPrompt: 'same prompt',
    promptHash: 'hash-a',
    promptLength: 11,
  };
  const first = buildDesktopHistorySendIdentity(input);
  const repeated = buildDesktopHistorySendIdentity(input);
  const foreign = buildDesktopHistorySendIdentity({ ...input, handoffId: 'handoff-b' });

  assert.deepEqual(first, repeated);
  assert.notEqual(first.operationKey, foreign.operationKey);
  assert.notEqual(first.requestFingerprint, foreign.requestFingerprint);
});

test('replay never authorizes a second Enter and preserves unresolved versus confirmed state', () => {
  const pending = desktopHistorySendReplayResult({
    operationKey: 'history:tab-a:handoff-a',
    attemptId: 'attempt-a',
    handoffId: 'handoff-a',
    state: 'audit-pending',
    receipt: null,
  });
  assert.equal(pending.replayed, true);
  assert.equal(pending.submitted, true);
  assert.equal(pending.auditPending, true);

  const confirmed = desktopHistorySendReplayResult({
    operationKey: 'history:tab-a:handoff-a',
    attemptId: 'attempt-a',
    handoffId: 'handoff-a',
    state: 'confirmed',
    receipt: { success: true, submitted: true, entryUuid: 'entry-a' },
  });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.replayed, true);
  assert.equal(confirmed.sendAttemptId, 'attempt-a');
  assert.equal(confirmed.entryUuid, 'entry-a');
});

test('provider queue replay is accepted queued work, not delivery-unknown', () => {
  const queued = desktopHistorySendReplayResult({
    operationKey: 'history:tab-a:handoff-a',
    attemptId: 'attempt-a',
    handoffId: 'handoff-a',
    provider: 'codex',
    state: 'delivery-unknown',
    receipt: {
      success: null,
      submitted: true,
      deliveryUnknown: true,
      providerQueue: {
        accepted: true,
        provider: 'codex',
        operationKey: 'history:tab-a:handoff-a',
        attemptId: 'attempt-a',
        sourceIdentity: 'codex-tui-queue:proof-a',
      },
    },
  });
  assert.equal(queued.success, true);
  assert.equal(queued.queued, true);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.receiptState, 'delivery-unknown');
  assert.equal(queued.deliveryUnknown, false);
  assert.equal(queued.providerQueueAccepted, true);
});

test('armed/unknown replay cannot inherit a staged pre-write refusal after receipt commit failed', () => {
  for (const state of ['enter-armed', 'delivery-unknown']) {
    const result = desktopHistorySendReplayResult({
      operationKey: 'history:T:H', attemptId: 'A', handoffId: 'H', state,
      receipt: { promptText: 'retained prompt', success: false, submitted: false, status: 'not-submitted' },
    });
    assert.equal(result.success, null);
    assert.equal(result.submitted, null);
    assert.equal(result.deliveryUnknown, true);
    assert.equal(result.status, 'delivery-unknown');
    assert.equal(result.receiptState, state);
    assert.equal(result.sendAttemptId, 'A');
  }
});
