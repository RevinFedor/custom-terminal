'use strict';

const ended = entry => ['cancelled', 'source-replaced'].includes(entry.state);
function messageWaitBlocks(entry, tabId) {
  if (entry?.source?.tabId !== tabId || ended(entry)) return false;
  // Exchange completion is delivery, not a subscription to the source turn.
  // Ordinary Loop admission owns busy/FIFO/current-cause/Goal/Stop separately.
  return entry.state !== 'settled';
}
function exactMessageDelivery(receipt, delivery, source) {
  return receipt?.state === 'confirmed' && !!receipt.attemptId
    && receipt.operationKey === delivery.operationKey && receipt.handoffId === delivery.handoffId
    && receipt.messageId === delivery.messageId && !!delivery.messageId
    && receipt.tabId === (delivery.targetTabId || source.tabId)
    && receipt.provider === (delivery.targetProvider || source.provider)
    && !!receipt.sessionId && receipt.sessionId === (delivery.deliverySessionId || delivery.targetSessionId || source.sessionId)
    && !!receipt.promptHash && !!receipt.requestHash && !!(receipt.userUuid || receipt.sourceIdentity);
}
function exactMessageReturn(result, receipt) {
  if (result?.known !== true || result.natural !== true || !Number.isFinite(result.outcomeTs)
    || result.operationKey !== receipt.operationKey || result.attemptId !== receipt.attemptId
    || result.handoffId !== receipt.handoffId || result.sessionId !== receipt.sessionId
    || result.provider !== receipt.provider || !result.executionContext?.turnId
    || result.executionContext.sessionId !== receipt.sessionId
    || result.executionContext.provider !== receipt.provider) return false;
  const uuids = [receipt.userUuid, ...(receipt.userUuidAliases || [])].filter(Boolean);
  const identities = [receipt.sourceIdentity, ...(receipt.sourceIdentityAliases || [])].filter(Boolean);
  return (uuids.length > 0 || identities.length > 0)
    && (!receipt.userUuid || uuids.includes(result.userUuid))
    && (!receipt.sourceIdentity || identities.includes(result.sourceIdentity));
}
function messageLoopDeferredReceipt(record) {
  if (record?.surface !== 'desktop-history' || record.attemptId
    || !['loop-message-dependency-pending', 'loop-input-changed'].includes(record.deliveryControl?.reason)
    || !record.deliveryControl?.cancelledAt
    || record.deliveryControl.deliveryOutcomeUnknown || !['reserved', 'preparing', 'not-submitted'].includes(record.state)
    || String(record.receipt?.source || '').replace(/^(?:claude|codex)-/, '') !== 'prompt-loop'
    || record.receipt?.submitted === true || record.receipt?.pasteWritten === true || record.receipt?.enterWritten === true
    || record.receipt?.deliveryUnknown === true || record.receipt?.auditPending === true) return null;
  const stale = record.deliveryControl.reason === 'loop-input-changed';
  const code = stale ? 'loop_cause_stale' : 'loop_message_wait';
  return { success: false, accepted: false, submitted: false, pasteWritten: false, enterWritten: false,
    deferred: true, status: 'not-submitted', code, error: code, ...(stale ? { causeInvalidated: true } : {}) };
}
module.exports = { messageWaitBlocks, exactMessageDelivery, exactMessageReturn, messageLoopDeferredReceipt };
