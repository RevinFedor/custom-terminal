export function planHistoryPromptPresentationDismissal({
  isLocalPrompt = false,
  handoffId = '',
  requiresAuditIdentity = undefined,
  sendOperationKey = '',
  sendAttemptId = '',
  queueStatus = '',
  statusReason = '',
  hasAcceptedProof = false,
} = {}) {
  const exactHandoffId = typeof handoffId === 'string' ? handoffId.trim() : '';
  if (isLocalPrompt !== true || !exactHandoffId) {
    return { allowed: false, mode: 'none', reason: 'local-handoff-required' };
  }
  const hasDurableIdentity = !!String(sendOperationKey || '').trim()
    && !!String(sendAttemptId || '').trim();
  const hasAnyDurableIdentity = !!String(sendOperationKey || '').trim()
    || !!String(sendAttemptId || '').trim();
  if (['preparing', 'sending', 'queued', 'audit-pending', 'delivery-unknown'].includes(queueStatus)) {
    return { allowed: true, mode: 'durable', reason: 'unsettled-local-presentation' };
  }
  if (requiresAuditIdentity === false && !hasAnyDurableIdentity && !hasAcceptedProof) {
    return {
      allowed: true,
      mode: 'local-only',
      reason: 'receiptless-local-command',
    };
  }
  if (queueStatus === 'failed' && !hasAnyDurableIdentity && !hasAcceptedProof) {
    const provenNotSubmitted = statusReason === 'send-proven-not-submitted'
      || statusReason === 'send-error-before-submit';
    return {
      allowed: true,
      mode: provenNotSubmitted ? 'local-only' : 'verify-local-failure',
      reason: provenNotSubmitted ? 'proved-local-failure-before-submit' : 'failed-local-receipt-check',
    };
  }
  return {
    allowed: true,
    mode: 'durable',
    reason: hasDurableIdentity ? 'durable-identity-ready' : 'wait-for-durable-identity',
  };
}
