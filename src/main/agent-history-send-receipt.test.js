'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DESKTOP_HISTORY_SEND_SURFACE,
  buildDesktopHistorySendIdentity,
  desktopHistorySendReplayResult,
  isDesktopHistorySendReceiptEligible,
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
