import assert from 'node:assert/strict';
import test from 'node:test';

import { planHistoryPromptPresentationDismissal } from './historyPromptPresentationDismissal.mjs';

test('receiptless local slash presentation dismisses locally', () => {
  assert.deepEqual(planHistoryPromptPresentationDismissal({
    isLocalPrompt: true,
    handoffId: 'slash-1',
    requiresAuditIdentity: false,
  }), {
    allowed: true,
    mode: 'local-only',
    reason: 'receiptless-local-command',
  });
});

test('ordinary or receipt-backed sends keep durable dismissal', () => {
  assert.equal(planHistoryPromptPresentationDismissal({
    isLocalPrompt: true,
    handoffId: 'send-1',
    requiresAuditIdentity: true,
  }).mode, 'durable');
  assert.equal(planHistoryPromptPresentationDismissal({
    isLocalPrompt: true,
    handoffId: 'slash-future-receipt',
    requiresAuditIdentity: false,
    sendOperationKey: 'operation-1',
    sendAttemptId: 'attempt-1',
  }).mode, 'durable');
});

test('non-local or identity-less rows expose no dismiss plan', () => {
  assert.equal(planHistoryPromptPresentationDismissal({
    isLocalPrompt: false,
    handoffId: 'x',
  }).allowed, false);
  assert.equal(planHistoryPromptPresentationDismissal({
    isLocalPrompt: true,
    handoffId: '',
  }).allowed, false);
});

test('proved pre-submit failures dismiss locally, legacy failures require exact receipt absence', () => {
  for (const reason of ['send-proven-not-submitted', 'send-error-before-submit']) {
    assert.equal(planHistoryPromptPresentationDismissal({ isLocalPrompt: true, handoffId: 'failed',
      requiresAuditIdentity: true, queueStatus: 'failed', statusReason: reason }).mode, 'local-only');
  }
  assert.equal(planHistoryPromptPresentationDismissal({ isLocalPrompt: true, handoffId: 'legacy',
    requiresAuditIdentity: true, queueStatus: 'failed', statusReason: 'send-refused-before-submit' }).mode,
  'verify-local-failure');
});

test('missing receipts never grant local dismissal to pending, unknown, accepted or partial-identity rows', () => {
  for (const patch of [
    { queueStatus: 'preparing' }, { queueStatus: 'sending' }, { queueStatus: 'queued' },
    { queueStatus: 'audit-pending' }, { queueStatus: 'delivery-unknown' }, { queueStatus: 'sent' },
    { sendAttemptId: 'partial-attempt' }, { sendOperationKey: 'partial-operation' },
    { hasAcceptedProof: true },
  ]) {
    assert.equal(planHistoryPromptPresentationDismissal({ isLocalPrompt: true, handoffId: 'not-safe',
      requiresAuditIdentity: true, queueStatus: 'failed', statusReason: 'send-proven-not-submitted',
      ...patch }).mode, 'durable');
  }
});
