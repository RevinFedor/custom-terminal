'use strict';

const text = value => typeof value === 'string' && value.trim().length > 0;
const offset = value => Number.isSafeInteger(value) && value >= 0;

// A read-side consistency check, not an authority-minting API. Main supplies
// compactStartIdentity from its private SQLite column only after the bound
// native compact owner observes a causal task_started. Legacy receipt flags,
// receipt.compactStartIdentity and operation-only presentation are not inputs.
function compactSendDeliveryIdentity(record) {
  const identity = record?.compactStartIdentity;
  const owner = record?.receipt?.compactOperationOwner || record?.compactOperationOwner;
  if ((record?.state || record?.receiptState) !== 'confirmed' || record.provider !== 'codex'
    || record.auditIdentity
    || ['entryUuid', 'auditEntryUuid', 'sourceIdentity', 'auditSourceIdentity']
      .some(key => record[key] != null && record[key] !== '')
    || !identity || identity.version !== 1 || identity.kind !== 'compact-start'
    || identity.proof !== 'codex-compact-causal-task-started'
    || identity.provider !== 'codex'
    || owner?.version !== 1 || owner.sendOperationKey !== identity.operationKey
    || owner.sendAttemptId !== identity.attemptId
    || !['operationId', 'tabId', 'handoffId', 'provider', 'sessionId', 'generation',
      'promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence']
      .every(key => owner[key] === identity[key])
    || !['operationKey', 'attemptId', 'tabId', 'handoffId', 'operationId',
      'sessionId', 'generation', 'promptHash'].every(key => text(identity[key]))
    || !['operationKey', 'attemptId', 'tabId', 'handoffId', 'provider', 'promptHash', 'promptLength']
      .every(key => identity[key] === record[key])
    || !['promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence',
      'taskStartedByteOffset', 'taskStartedEventSequence', 'promptLength'].every(key => offset(identity[key]))
    || identity.promptLength < '/compact'.length
    || identity.taskStartedByteOffset < identity.sourceByteOffset
    || identity.taskStartedEventSequence <= identity.causalBoundaryEventSequence) return null;
  return identity;
}

module.exports = { compactSendDeliveryIdentity };
