'use strict';

// This is a projected queue-order disposition, NOT a replacement Send receipt.
// The receipt owner keeps reserved/preparing and the immutable H/O/fingerprint.
function capacityRecoveryWaitResult() {
  return { success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
    deferred: true, status: 'not-submitted', code: 'run_after_capacity_wait', error: 'run_after_capacity_wait' };
}
function capacityRecoveryDeferredReceipt(record) {
  const proof = record?.applicationQueue?.capacityRecovery;
  if (record?.applicationQueue?.state !== 'recovery-deferred' || proof?.version !== 1
    || proof.kind !== 'model-capacity' || !proof.failedTurnId || !Number.isFinite(proof.failedAt)
    || !proof.sessionId || !proof.lifecycleGeneration || !proof.requestHash
    || proof.tabId !== record.tabId || proof.handoffId !== record.handoffId
    || proof.operationKey !== record.operationKey || record.attemptId || record.deliveryControl?.cancelledAt
    || !['reserved', 'preparing'].includes(record.state)
    || record.receipt?.submitted === true || record.receipt?.pasteWritten === true
    || record.receipt?.enterWritten === true || record.receipt?.deliveryUnknown === true
    || record.receipt?.auditPending === true) return null;
  return { ...capacityRecoveryWaitResult(), capacityRecoveryDeferred: proof };
}

module.exports = { capacityRecoveryDeferredReceipt, capacityRecoveryWaitResult };
