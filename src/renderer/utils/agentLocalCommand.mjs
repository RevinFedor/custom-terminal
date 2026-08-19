export function normalizeAgentLocalCommand(rawPrompt) {
  if (typeof rawPrompt !== 'string') return null;
  const normalized = rawPrompt.trim();
  if (!normalized || normalized.includes('\n') || normalized.includes('\r')) return null;
  return /^\/[^\s/]+(?:[ \t].*)?$/.test(normalized) ? normalized : null;
}

export function isStandaloneAgentLocalCommand({
  prompt,
  imageCount = 0,
  chipCount = 0,
} = {}) {
  return Number(imageCount) === 0
    && Number(chipCount) === 0
    && normalizeAgentLocalCommand(prompt) !== null;
}

export function projectAgentLocalCommandSendResult({
  candidate = false,
  result = null,
} = {}) {
  if (!candidate || result?.localSlashCommand !== true) return { handled: false };
  if (result?.submitted !== true) {
    return {
      handled: true,
      transferred: false,
      requiresAuditIdentity: false,
      queueStatus: null,
      deliveryUnconfirmed: false,
    };
  }
  if (result?.success === true) {
    return {
      handled: true,
      transferred: true,
      requiresAuditIdentity: false,
      queueStatus: 'sent',
      deliveryUnconfirmed: false,
      reason: 'agent-local-command-submitted',
    };
  }
  return {
    handled: true,
    transferred: true,
    requiresAuditIdentity: false,
    queueStatus: 'delivery-unknown',
    deliveryUnconfirmed: true,
    reason: 'agent-local-command-submit-outcome-unknown',
  };
}
