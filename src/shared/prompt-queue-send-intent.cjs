'use strict';

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

module.exports = { isAutomaticPromptQueueRequest, isAutomaticReadinessWaitReceipt, isAutomaticNoWriteWait };
