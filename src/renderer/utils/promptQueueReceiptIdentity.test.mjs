import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPromptQueueReceiptHandoffId,
  promptQueueHandoffMatchesItem,
  promptQueueReceiptReplayNeedsNoBusyStart,
  selectPromptQueueTransportProgress,
} from './promptQueueReceiptIdentity.mjs';

test('queue identity survives restart and separates identical items and edited payloads', () => {
  const first = buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'item-a',
    payload: 'same text',
  });
  assert.equal(first, buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'item-a',
    payload: 'same text',
  }));
  assert.notEqual(first, buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'item-b',
    payload: 'same text',
  }));
  assert.notEqual(first, buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'item-a',
    payload: 'edited text',
  }));
});

test('Loop identity is exact per causal outcome but stable for its replay', () => {
  const input = {
    kind: 'loop',
    itemId: 'loop-armed-prompt',
    payload: 'continue',
    causeKey: 'tab-a:123:turn-one',
  };
  const first = buildPromptQueueReceiptHandoffId(input);
  assert.equal(first, buildPromptQueueReceiptHandoffId(input));
  assert.notEqual(first, buildPromptQueueReceiptHandoffId({
    ...input,
    causeKey: 'tab-a:456:turn-two',
  }));
  assert.throws(() => buildPromptQueueReceiptHandoffId({
    kind: 'loop',
    itemId: 'loop',
    payload: 'continue',
  }), /causeKey/);
});

test('only a durable non-retry replay suppresses the expected new busy edge', () => {
  assert.equal(promptQueueReceiptReplayNeedsNoBusyStart({
    replayed: true,
    status: 'confirmed',
  }), true);
  assert.equal(promptQueueReceiptReplayNeedsNoBusyStart({
    replayed: true,
    status: 'delivery-unknown',
  }), true);
  assert.equal(promptQueueReceiptReplayNeedsNoBusyStart({
    replayed: true,
    status: 'not-submitted',
  }), false);
  assert.equal(promptQueueReceiptReplayNeedsNoBusyStart({
    replayed: false,
    status: 'confirmed',
  }), false);
});

test('Run After transport progress follows exact item identity and pending phases', () => {
  const handoffId = buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'item-a/with space',
    payload: 'same text',
  });
  assert.equal(promptQueueHandoffMatchesItem(handoffId, 'item-a/with space'), true);
  assert.equal(promptQueueHandoffMatchesItem(handoffId, 'item-a'), false);
  assert.deepEqual(selectPromptQueueTransportProgress([
    {
      handoffId,
      source: 'prompt-queue',
      queueStatus: 'sending',
      submittedAt: 10,
      statusChangedAt: 20,
    },
  ], ['item-a/with space']), {
    handoffId,
    itemId: 'item-a/with space',
    queueStatus: 'sending',
    changedAt: 20,
  });
});

test('Run After transport progress ignores terminal and stale unrelated handoffs', () => {
  const handoffId = buildPromptQueueReceiptHandoffId({
    kind: 'queue',
    itemId: 'item-a',
    payload: 'same text',
  });
  assert.equal(selectPromptQueueTransportProgress([
    { handoffId, source: 'prompt-queue', queueStatus: 'sent', statusChangedAt: 30 },
    { handoffId: 'run-after-item-b-9-deadbeef', source: 'prompt-queue', queueStatus: 'audit-pending', statusChangedAt: 40 },
  ], ['item-a']), null);
});
