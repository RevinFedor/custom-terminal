'use strict';

const PREFIX = 'build-continue-stale-loop:';
function deferredBuildContinueInput(code = 'build_continue_pending') {
  return { success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
    deliveryUnknown: false, auditPending: false, deferred: true, status: 'not-submitted', code, error: code };
}
// Presentation of a durable, never-attempted obsolete Loop cause. The original
// receipt/cancellation remains immutable; UNKNOWN/Enter are never negated.
function buildContinueDeferredReceipt(record) {
  const reason = record?.deliveryControl?.reason, source = record?.receipt?.source;
  if (record?.attemptId || !record?.deliveryControl?.cancelledAt || record.deliveryControl.deliveryOutcomeUnknown
    || !['reserved', 'preparing', 'not-submitted'].includes(record.state)
    || typeof reason !== 'string' || !reason.startsWith(PREFIX)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,119}$/.test(reason.slice(PREFIX.length))
    || typeof source !== 'string' || source.replace(/^(?:claude|codex)-/, '') !== 'prompt-loop'
    || record.receipt?.submitted === true || record.receipt?.pasteWritten === true || record.receipt?.enterWritten === true
    || record.receipt?.deliveryUnknown === true || ['delivery-unknown', 'audit-pending'].includes(record.receipt?.status)) return null;
  return { ...deferredBuildContinueInput(), buildContinueDeferred: { version: 1, operationId: reason.slice(PREFIX.length) } };
}
module.exports = { PREFIX, deferredBuildContinueInput, buildContinueDeferredReceipt };
