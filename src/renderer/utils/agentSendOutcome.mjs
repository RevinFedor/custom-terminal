const DELIVERY_OUTCOMES = new Set([
  'confirmed',
  'queued',
  'audit-pending',
  'provider-not-accepted',
  'not-submitted',
  'delivery-unknown',
  'cancelled',
  'local-command-confirmed',
]);

/**
 * Additive normalization for renderer consumers. Durable authority remains
 * the main receipt store; this function never promotes a raw unknown result.
 */
export function normalizeAgentSendOutcome(result) {
  if (DELIVERY_OUTCOMES.has(result?.deliveryOutcome)) return result.deliveryOutcome;
  if (result?.localSlashCommand === true && result?.submitted === true && result?.success === true) {
    return 'local-command-confirmed';
  }
  if (result?.status === 'delivery-unknown' || result?.deliveryUnknown === true) {
    return 'delivery-unknown';
  }
  if (result?.status === 'audit-pending' || result?.auditPending === true) {
    return 'audit-pending';
  }
  if (result?.status === 'cancelled' || result?.cancelled === true) return 'cancelled';
  if (result?.queued === true || result?.status === 'queued') return 'queued';
  if (result?.submitted === false) return 'not-submitted';
  if (result?.providerAccepted === false && result?.submitted === true) {
    return 'provider-not-accepted';
  }
  const audit = result?.codexAudit || result?.pasteAudit || null;
  const exactAuditConfirmed = audit?.success === true
    && typeof audit?.auditTimestamp === 'string'
    && audit.auditTimestamp.length > 0
    && typeof audit?.actualHash === 'string'
    && audit.actualHash.length > 0;
  const durableReceiptConfirmed = result?.receiptState === 'confirmed'
    || result?.durableReceiptState === 'confirmed';
  const topLevelExactAuditConfirmed = result?.exactAuditConfirmed === true
    && typeof result?.auditTimestamp === 'string'
    && result.auditTimestamp.length > 0
    && typeof result?.actualHash === 'string'
    && result.actualHash.length > 0;
  if (exactAuditConfirmed || topLevelExactAuditConfirmed || durableReceiptConfirmed) {
    return 'confirmed';
  }
  return 'delivery-unknown';
}

export const AGENT_SEND_DELIVERY_OUTCOMES = Object.freeze([...DELIVERY_OUTCOMES]);
