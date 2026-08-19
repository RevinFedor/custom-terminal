export function normalizeCodexLocalSlashCommand(rawPrompt) {
  if (typeof rawPrompt !== 'string') return null;
  const normalized = rawPrompt.trim();
  if (!normalized || normalized.includes('\n') || normalized.includes('\r')) return null;
  return /^\/[^\s/]+(?:[ \t].*)?$/.test(normalized) ? normalized : null;
}

export function isStandaloneCodexLocalSlashCommand({
  prompt,
  imageCount = 0,
  chipCount = 0,
} = {}) {
  return Number(imageCount) === 0
    && Number(chipCount) === 0
    && normalizeCodexLocalSlashCommand(prompt) !== null;
}

/**
 * Codex local slash commands are TUI actions, not conversation turns. Their
 * exact proof is: the specialized slash transaction observed the complete
 * command in the current composer frame and then wrote Enter. They must never
 * wait for an event_msg.user_message that Codex does not produce.
 */
export function projectCodexLocalSlashSendResult({
  candidate = false,
  result = null,
} = {}) {
  if (!candidate || result?.localSlashCommand !== true) {
    return { handled: false };
  }
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
      reason: 'codex-local-slash-submitted',
    };
  }
  return {
    handled: true,
    transferred: true,
    requiresAuditIdentity: false,
    queueStatus: 'delivery-unknown',
    deliveryUnconfirmed: true,
    reason: 'codex-local-slash-submit-outcome-unknown',
  };
}
