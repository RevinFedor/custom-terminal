'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compactSendDeliveryIdentity } = require('./compact-send-delivery.cjs');

function fixture() {
  const identity = { version: 1, kind: 'compact-start', proof: 'codex-compact-causal-task-started',
    provider: 'codex', operationKey: 'history:T:H', attemptId: 'A', tabId: 'T', handoffId: 'H',
    operationId: 'codex:api:H', sessionId: 'S', generation: 'G', promptGeneration: 3,
    sourceByteOffset: 100, causalBoundaryEventSequence: 10,
    taskStartedByteOffset: 100, taskStartedEventSequence: 11, promptHash: 'd362c39510cd898a', promptLength: 8 };
  const owner = { ...identity, version: 1, sendOperationKey: identity.operationKey, sendAttemptId: identity.attemptId };
  return { state: 'confirmed', provider: 'codex', operationKey: identity.operationKey, attemptId: 'A',
    tabId: 'T', handoffId: 'H', promptHash: identity.promptHash, promptLength: 8,
    compactStartIdentity: identity, receipt: { compactOperationOwner: owner } };
}

test('same private start identity validates both internal record and checked public projection', () => {
  const record = fixture();
  assert.equal(compactSendDeliveryIdentity(record), record.compactStartIdentity);
  const { state, receipt, ...publicFields } = record;
  assert.equal(compactSendDeliveryIdentity({ ...publicFields, receiptState: state, ...receipt }), record.compactStartIdentity);
});

test('generic display/submitted fields cannot substitute for a private start identity', () => {
  const record = fixture();
  const { compactStartIdentity: identity, ...unproven } = record;
  assert.equal(compactSendDeliveryIdentity({ ...unproven, receipt: {
    ...unproven.receipt, compactStartIdentity: identity, success: true, submitted: true,
    localSlashCommand: true, compactStartConfirmed: true,
    localCommandProof: 'codex-compact-causal-task-started',
  } }), null);
  for (const state of ['reserved', 'preparing', 'in-flight', 'enter-armed', 'audit-pending',
    'delivery-unknown', 'not-submitted', 'provider-not-accepted']) {
    assert.equal(compactSendDeliveryIdentity({ ...record, state }), null, state);
  }
});

test('different request/attempt/owner and invalid causal boundary reject a private identity', () => {
  const record = fixture();
  for (const key of ['operationKey', 'attemptId', 'tabId', 'handoffId', 'provider', 'promptHash', 'promptLength']) {
    assert.equal(compactSendDeliveryIdentity({ ...record,
      [key]: typeof record[key] === 'number' ? record[key] + 1 : 'foreign' }), null, key);
  }
  for (const key of ['entryUuid', 'auditEntryUuid', 'sourceIdentity', 'auditSourceIdentity']) {
    assert.equal(compactSendDeliveryIdentity({ ...record, [key]: 'canonical-user-address' }), null, key);
  }
  assert.equal(compactSendDeliveryIdentity({ ...record, auditIdentity: { sessionId: 'S', entryUuid: 'U' } }), null);
  for (const key of ['version', 'sendOperationKey', 'sendAttemptId', 'operationId', 'tabId', 'handoffId',
    'provider', 'sessionId', 'generation', 'promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence']) {
    const owner = record.receipt.compactOperationOwner;
    assert.equal(compactSendDeliveryIdentity({ ...record, receipt: { compactOperationOwner: {
      ...owner, [key]: typeof owner[key] === 'number' ? owner[key] + 1 : 'foreign',
    } } }), null, key);
  }
  for (const patch of [{ version: 2 }, { kind: 'compact' }, { proof: 'submitted' }, { operationId: '' },
    { sessionId: '' }, { generation: '' }, { taskStartedByteOffset: 99 }, { taskStartedEventSequence: 10 },
    { taskStartedEventSequence: 10.5 }, { taskStartedByteOffset: null }, { promptLength: 0 }]) {
    assert.equal(compactSendDeliveryIdentity({ ...record,
      compactStartIdentity: { ...record.compactStartIdentity, ...patch } }), null, JSON.stringify(patch));
  }
});
