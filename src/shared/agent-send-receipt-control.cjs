'use strict';

function cancelledSendIntent(record) {
  const control = record?.deliveryControl;
  return control?.version === 1 && Number.isFinite(control.cancelledAt) && control.cancelledAt > 0;
}

function retiredSendInputSlot(record) {
  return record?.inputSlot?.version === 1 && record.inputSlot.state === 'retired'
    || record?.applicationQueue?.version === 1 && record.applicationQueue.state === 'released-unknown';
}

function canProjectCurrentProviderQueue(record) {
  return !cancelledSendIntent(record) && !retiredSendInputSlot(record);
}

function hiddenSendPresentation(record) {
  return cancelledSendIntent(record) && record.deliveryControl.presentationDismissed === true
    || record?.receipt?.presentationDismissedSurface === 'desktop-history'
      && Number.isFinite(Number(record.receipt.presentationDismissedAt))
      && Number(record.receipt.presentationDismissedAt) > 0;
}

function isTabMessageNoInputReceipt(record) {
  const receipt = record?.receipt;
  return record?.surface === 'tab-message' && !!record.attemptId
    && ['claude', 'codex'].includes(record.provider)
    && record.state === 'not-submitted' && !record.deliveryControl?.cancelledAt
    && !retiredSendInputSlot(record)
    && receipt?.submitted === false && receipt.pasteWritten === false && receipt.enterWritten === false
    && receipt.deliveryUnknown !== true && receipt.auditPending !== true
    && receipt.providerQueueAccepted !== true && receipt.cancelled !== true
    && receipt.code !== 'agent_send_queue_cancelled';
}

function isExternalCompletionNoInputReceipt(record, request) {
  const ref = request?.completionDeliveryRef, receipt = record?.receipt;
  return ref?.version === 1 && typeof ref.deliveryId === 'string' && typeof ref.requestHash === 'string'
    && record?.surface === 'desktop-history' && ['claude', 'codex'].includes(record.provider)
    && request.source === 'orchestration-completion:' + ref.runId
    && record.handoffId === 'orchestration-complete:' + ref.runId
    && record.operationKey === request.sendOperationKey && record.tabId === request.tabId
    && record.state === 'not-submitted' && !cancelledSendIntent(record) && !retiredSendInputSlot(record)
    && receipt?.submitted === false && receipt.pasteWritten === false && receipt.enterWritten === false
    && receipt.deliveryUnknown !== true && receipt.auditPending !== true && receipt.providerQueueAccepted !== true
    && receipt.cancelled !== true && receipt.code !== 'agent_send_queue_cancelled';
}

function isExternalOperationalNoInputReceipt(record, request) {
  const ref = request?.operationalNoticeRef, receipt = record?.receipt;
  return ref?.version === 1 && typeof ref.runId === 'string' && typeof ref.noticeId === 'string'
    && typeof ref.bodyHash === 'string' && typeof ref.preparedPromptHash === 'string'
    && record?.surface === 'desktop-history' && ['claude', 'codex'].includes(record.provider)
    && request.source === 'research-operational:' + ref.runId + ':' + ref.noticeId
    && record.handoffId === ref.noticeId && record.handoffId === request.handoffId
    && record.operationKey === request.sendOperationKey && record.tabId === request.tabId
    && record.state === 'not-submitted' && !cancelledSendIntent(record) && !retiredSendInputSlot(record)
    && receipt?.submitted === false && receipt.pasteWritten === false && receipt.enterWritten === false
    && receipt.deliveryUnknown !== true && receipt.auditPending !== true && receipt.providerQueueAccepted !== true
    && receipt.cancelled !== true && receipt.code !== 'agent_send_queue_cancelled';
}

module.exports = { isExternalOperationalNoInputReceipt, isExternalCompletionNoInputReceipt, cancelledSendIntent, retiredSendInputSlot, canProjectCurrentProviderQueue, hiddenSendPresentation,
  isTabMessageNoInputReceipt };
