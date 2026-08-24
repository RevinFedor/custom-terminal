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
