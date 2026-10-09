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

module.exports = { cancelledSendIntent, retiredSendInputSlot, canProjectCurrentProviderQueue, hiddenSendPresentation };
