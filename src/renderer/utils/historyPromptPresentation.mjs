export function resolveHistoryPromptHandoffPresentationSession({
  auditSessionId,
  sessionIdHint,
  currentSessionId,
}) {
  const exactSessionId = typeof auditSessionId === 'string' && auditSessionId
    ? auditSessionId
    : '';
  const current = typeof currentSessionId === 'string' ? currentSessionId : '';
  return {
    exactSessionId,
    presentationSessionId: exactSessionId || sessionIdHint || current,
    belongsToCurrent: !exactSessionId || !current || exactSessionId === current,
  };
}

export function historyEntryHasExactIdentity(entry, identity) {
  const exact = typeof identity === 'string' ? identity.trim() : '';
  if (!exact) return false;
  if (entry?.uuid === exact || entry?.sourceIdentity === exact) return true;
  return Array.isArray(entry?.sourceIdentityAliases)
    && entry.sourceIdentityAliases.some((alias) => alias === exact);
}

export function matchesHistoryPromptSuppression(entry, suppression) {
  if (entry.isLocal) return false;
  if (entry.role !== 'user' && entry.role !== 'queued') return false;

  if (suppression.requiresAuditIdentity) {
    if (suppression.sourceIdentity) {
      return historyEntryHasExactIdentity(entry, suppression.sourceIdentity);
    }
    if (entry.normalizedText !== suppression.normalizedText) return false;
    if (!suppression.auditTimestamp || entry.timestamp !== suppression.auditTimestamp) {
      return false;
    }
    return !suppression.auditSessionId
      || entry.sessionId === suppression.auditSessionId;
  }

  if (entry.normalizedText !== suppression.normalizedText) return false;
  const entryAt = Date.parse(entry.timestamp || '');
  return !Number.isFinite(entryAt)
    || (entryAt >= suppression.since && entryAt <= suppression.until);
}

export function matchesHistoryPromptAdoption(entry, localPrompt) {
  if (entry.role !== 'user' && entry.role !== 'queued') return false;

  if (localPrompt.requiresAuditIdentity) {
    if (localPrompt.sourceIdentity) {
      return historyEntryHasExactIdentity(entry, localPrompt.sourceIdentity);
    }
    if (entry.normalizedText !== localPrompt.normalizedText) return false;
    if (!localPrompt.auditTimestamp || entry.timestamp !== localPrompt.auditTimestamp) {
      return false;
    }
    return !localPrompt.auditSessionId
      || entry.sessionId === localPrompt.auditSessionId;
  }

  if (entry.normalizedText !== localPrompt.normalizedText) return false;
  const entryAt = Date.parse(entry.timestamp || '');
  return !Number.isFinite(entryAt) || entryAt >= localPrompt.localAt - 5000;
}
