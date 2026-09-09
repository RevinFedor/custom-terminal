'use strict';

const { classifyAgentSendReceipt } = require('./orchestration-runs');
const { isAgentSendProviderQueueAccepted } = require('./agent-send-receipt-registry');

// Legacy HTTP and its activity log describe the same receipt as Project API.
// This projects a result only; it never sends, retries or creates an identity.
function projectLegacyAiPromptReceipt(result = {}, { submit = true } = {}) {
  const receipt = result && typeof result === 'object' ? result : {};
  if (submit === false && receipt.success === true && receipt.pasteWritten !== false) {
    return { status: 'pasted', activityStatus: 'pasted', httpStatus: 200, success: true };
  }
  const classified = classifyAgentSendReceipt(receipt);
  if (classified.state === 'delivery-unknown') {
    return { status: 'delivery-unknown', activityStatus: 'delivery-unknown', httpStatus: 202, success: null };
  }
  if (classified.state === 'not-submitted' || classified.state === 'provider-not-accepted') {
    return { status: 'failed', activityStatus: 'error', success: false,
      httpStatus: Number(receipt.httpStatus) >= 400 ? Number(receipt.httpStatus)
        : receipt.draftPasteRejected || classified.state === 'provider-not-accepted' ? 409 : 500 };
  }
  if (isAgentSendProviderQueueAccepted(receipt)) {
    return { status: 'queued', activityStatus: 'queued', httpStatus: 200, success: true };
  }
  if (classified.state === 'audit-pending') {
    return { status: 'audit-pending', activityStatus: 'audit-pending', httpStatus: 202, success: null };
  }
  return { status: receipt.queued === true ? 'queued' : 'sent',
    activityStatus: receipt.queued === true ? 'queued' : 'sent', httpStatus: 200, success: true };
}

module.exports = { projectLegacyAiPromptReceipt };
