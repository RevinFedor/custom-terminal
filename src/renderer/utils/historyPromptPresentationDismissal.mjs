export function planHistoryPromptPresentationDismissal({
  isLocalPrompt = false,
  handoffId = '',
  requiresAuditIdentity = undefined,
  sendOperationKey = '',
  sendAttemptId = '',
} = {}) {
  const exactHandoffId = typeof handoffId === 'string' ? handoffId.trim() : '';
  if (isLocalPrompt !== true || !exactHandoffId) {
    return { allowed: false, mode: 'none', reason: 'local-handoff-required' };
  }
  const hasDurableIdentity = !!String(sendOperationKey || '').trim()
    && !!String(sendAttemptId || '').trim();
  if (requiresAuditIdentity === false && !hasDurableIdentity) {
    return {
      allowed: true,
      mode: 'local-only',
      reason: 'receiptless-local-command',
    };
  }
  return {
    allowed: true,
    mode: 'durable',
    reason: hasDurableIdentity ? 'durable-identity-ready' : 'wait-for-durable-identity',
  };
}
