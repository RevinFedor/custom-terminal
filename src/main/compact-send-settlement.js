'use strict';

const OWNER_FIELDS = ['operationId', 'tabId', 'handoffId', 'provider', 'sessionId',
  'generation', 'promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence',
  'sendOperationKey', 'sendAttemptId'];

const text = value => typeof value === 'string' && value.trim().length > 0;
const offset = value => Number.isSafeInteger(value) && value >= 0;

// Only the live compact owner can create this binding. No prompt-text search,
// current-tab SID or synthetic transcript/user identity participates.
function compactSendOwner(operation) {
  if (operation?.kind !== 'compact' || operation.provider !== 'codex'
    || operation.command !== '/compact'
    || !['operationId', 'tabId', 'handoffId', 'sessionId', 'generation',
      'sendOperationKey', 'sendAttemptId'].every(key => text(operation[key]))
    || !['promptGeneration', 'sourceByteOffset', 'causalBoundaryEventSequence']
      .every(key => offset(operation[key]))) return null;
  return Object.fromEntries([['version', 1], ...OWNER_FIELDS.map(key => [key, operation[key]])]);
}

function compactSendOwnerMatches(owner, operation) {
  const candidate = compactSendOwner(operation);
  return owner?.version === 1 && !!candidate
    && OWNER_FIELDS.every(key => owner[key] === candidate[key]);
}

function compactSendStartProven(operation) {
  return operation?.causalStartRequired === true && operation.causalStartConfirmed === true
    && offset(operation.causalStartByteOffset) && offset(operation.sourceByteOffset)
    && operation.causalStartByteOffset >= operation.sourceByteOffset
    && offset(operation.causalStartEventSequence) && offset(operation.causalBoundaryEventSequence)
    && operation.causalStartEventSequence > operation.causalBoundaryEventSequence;
}

function compactSendTerminalSettlement(operation) {
  const owner = compactSendOwner(operation);
  if (!owner || !compactSendStartProven(operation)
    || operation.active !== false || operation.pending === true
    || operation.outcome !== 'completed' || operation.reason !== 'compacted'
    || !['rollout-compacted-before-task-complete', 'rollout-compacted'].includes(operation.completionProof)
    || !offset(operation.codexCompactedOffset) || !offset(operation.codexTaskCompleteOffset)
    || operation.codexCompactedOffset <= operation.causalStartByteOffset
    || operation.codexCompactedOffset >= operation.codexTaskCompleteOffset
    || !Number.isFinite(operation.endedAt) || operation.endedAt <= 0) return null;
  return {
    version: 1, kind: 'compact', settled: true, outcome: 'completed',
    operationKey: owner.sendOperationKey, attemptId: owner.sendAttemptId,
    operationId: owner.operationId, handoffId: owner.handoffId, tabId: owner.tabId,
    provider: owner.provider, sessionId: owner.sessionId, generation: owner.generation,
    promptGeneration: owner.promptGeneration,
    reason: operation.reason, proof: operation.completionProof, settledAt: operation.endedAt,
    sourceByteOffset: owner.sourceByteOffset,
    taskStartedByteOffset: operation.causalStartByteOffset,
    compactedByteOffset: operation.codexCompactedOffset,
    taskCompleteByteOffset: operation.codexTaskCompleteOffset,
  };
}

// Delivery classification, NOT completion or a canonical History row. Legacy
// receipts can prove a local command was accepted without retaining its full
// compact owner. Reopening such a receipt must not append a new user bubble to
// the current conversation. Keep the journal/settlement recovery separately.
function compactSendReceiptPresentation(record) {
  const receipt = record?.receipt;
  if (record?.state !== 'confirmed' || record.provider !== 'codex'
    || !['operationKey', 'attemptId', 'tabId', 'handoffId'].every(key => text(record[key]))
    || record.auditIdentity
    || receipt?.success !== true || receipt.submitted !== true
    || receipt.deliveryUnknown === true || receipt.auditPending === true
    || receipt.queued === true || receipt.providerAccepted === false
    || receipt.localSlashCommand !== true || receipt.compactStartConfirmed !== true
    || receipt.localCommandProof !== 'codex-compact-causal-task-started'
    || receipt.deliveryOutcome !== 'local-command-confirmed'
    || !text(receipt.compactOperationId)
    || receipt.handoffId !== record.handoffId
    || ['entryUuid', 'auditEntryUuid', 'sourceIdentity', 'auditSourceIdentity']
      .some(key => receipt[key] != null && receipt[key] !== '')
    || (Array.isArray(receipt.sourceIdentityAliases) && receipt.sourceIdentityAliases.length > 0)
    || ['operationKey', 'attemptId', 'tabId', 'provider']
      .some(key => receipt[key] != null && receipt[key] !== record[key])
    || (receipt.toolType != null && receipt.toolType !== record.provider)) return null;

  let historyScope = null;
  const owner = receipt.compactOperationOwner;
  if (owner != null) {
    const checked = compactSendOwner({ ...owner, kind: 'compact', command: '/compact' });
    if (owner.version !== 1 || !checked
      || checked.operationId !== receipt.compactOperationId
      || checked.sendOperationKey !== record.operationKey || checked.sendAttemptId !== record.attemptId
      || checked.tabId !== record.tabId || checked.handoffId !== record.handoffId
      || checked.provider !== record.provider) return null;
    historyScope = { source: 'compact-operation-owner', sessionId: checked.sessionId,
      generation: checked.generation, promptGeneration: checked.promptGeneration,
      sourceByteOffset: checked.sourceByteOffset };
  }
  return {
    version: 1, kind: 'compact', provider: record.provider,
    operationId: receipt.compactOperationId, operationKey: record.operationKey,
    attemptId: record.attemptId, handoffId: record.handoffId, tabId: record.tabId,
    delivery: 'confirmed', deliveryProof: receipt.localCommandProof,
    historyPresentation: 'operation-only', historyScope,
  };
}

module.exports = { compactSendOwner, compactSendOwnerMatches,
  compactSendStartProven, compactSendTerminalSettlement, compactSendReceiptPresentation };
