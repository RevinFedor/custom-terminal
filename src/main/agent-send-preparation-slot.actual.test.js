'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path');
const { classifyInputSlotRetirement } = require(path.join(process.env.ACTUAL_SOURCE_DIR || __dirname, 'agent-send-input-slot.js'));
const record = { operationKey: 'history:T:H', tabId: 'T', handoffId: 'H', attemptId: 'A',
  state: 'delivery-unknown', receipt: { submitted: null, deliveryUnknown: true } };
test('automatic renderer-owner loss revokes input without releasing the possible-Enter FIFO slot', () => {
  const current = { ...record, deliveryControl: { cancelledAt: 1000, reason: 'send-renderer-owner-lost' } };
  const before = JSON.stringify(current);
  assert.equal(classifyInputSlotRetirement(current, null).retire, false);
  assert.equal(JSON.stringify(current), before, 'a slot decision cannot rewrite delivery truth');
});
test('the existing explicit user-cancel slot policy remains separate', () => {
  assert.equal(classifyInputSlotRetirement({ ...record,
    deliveryControl: { cancelledAt: 1000, reason: 'user-cancel' } }, null).retire, true);
});
test('an ordinary uncertain head still needs exact independent input-owner proof', () => {
  assert.equal(classifyInputSlotRetirement(record, null).retire, false);
});
