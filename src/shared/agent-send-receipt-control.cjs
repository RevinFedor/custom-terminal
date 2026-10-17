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

module.exports = { cancelledSendIntent, retiredSendInputSlot, canProjectCurrentProviderQueue, hiddenSendPresentation,
  isTabMessageNoInputReceipt };
