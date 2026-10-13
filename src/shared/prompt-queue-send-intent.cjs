'use strict';

// The queue store serializes absence as '-', not an empty string. Empty is
// retained for legacy intents. Neither requires a context percentage proof.
// Unknown nonempty keys still require proof; do not fail open on malformed data.
function hasPromptQueueContextConditionKey(key) {
  return typeof key === 'string' && key !== '' && key !== '-';
}

// Compare persisted absence representations without rewriting the immutable
// request. Real and unknown nonempty conditions retain exact key equality.
function promptQueueContextConditionKeysEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return left === right
    || ((left === '' || left === '-') && (right === '' || right === '-'));
}

// A persisted application intent, not permission to write to a provider. The
// existing queue runner owns these fields; Main still proves every write.
function isAutomaticPromptQueueRequest(request) {
  const intent = request?.promptQueueIntent;
  return intent?.version === 1 && intent.kind === 'queue'
    && request.promptQueueAction !== 'send-now'
    && ['prompt-queue', 'codex-prompt-queue', 'claude-prompt-queue'].includes(request.source)
    && typeof intent.itemId === 'string' && !!intent.itemId
    && (intent.armedAt === null || Number.isFinite(intent.armedAt))
    && typeof intent.triggerTabId === 'string' && !!intent.triggerTabId
    && typeof intent.conditionKey === 'string' && typeof intent.triggerKey === 'string';
}

function isAutomaticReadinessWaitReceipt(value) {
  return value?.automaticReadinessWait === 1 && value.deferred === true
    && value.submitted === false && value.pasteWritten === false && value.enterWritten === false
    && value.cancelled !== true && value.deliveryUnknown !== true
    && value.providerQueueAccepted !== true && value.exactAuditConfirmed !== true
    && value.error === 'codex_input_not_ready';
}

function isAutomaticNoWriteWait(record, request) {
  return isAutomaticPromptQueueRequest(request) && record?.state === 'not-submitted'
    && !!record.attemptId && !record.auditIdentity?.entryUuid && !record.auditIdentity?.sourceIdentity
    && isAutomaticReadinessWaitReceipt(record.receipt);
}

module.exports = { hasPromptQueueContextConditionKey, promptQueueContextConditionKeysEqual, isAutomaticPromptQueueRequest, isAutomaticReadinessWaitReceipt, isAutomaticNoWriteWait };
