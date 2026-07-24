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

export function matchesHistoryPromptSuppression(entry, suppression) {
  if (entry.isLocal) return false;
  if (entry.role !== 'user' && entry.role !== 'queued') return false;
  if (entry.normalizedText !== suppression.normalizedText) return false;

  if (suppression.requiresAuditIdentity) {
    if (suppression.sourceIdentity) {
      return entry.sourceIdentity === suppression.sourceIdentity;
    }
    if (!suppression.auditTimestamp || entry.timestamp !== suppression.auditTimestamp) {
      return false;
    }
    return !suppression.auditSessionId
      || entry.sessionId === suppression.auditSessionId;
  }

  const entryAt = Date.parse(entry.timestamp || '');
  return !Number.isFinite(entryAt)
    || (entryAt >= suppression.since && entryAt <= suppression.until);
}

export function matchesHistoryPromptAdoption(entry, localPrompt) {
  if (entry.role !== 'user' && entry.role !== 'queued') return false;
  if (entry.normalizedText !== localPrompt.normalizedText) return false;

  if (localPrompt.requiresAuditIdentity) {
    if (localPrompt.sourceIdentity) {
      return entry.sourceIdentity === localPrompt.sourceIdentity;
    }
    if (!localPrompt.auditTimestamp || entry.timestamp !== localPrompt.auditTimestamp) {
      return false;
    }
    return !localPrompt.auditSessionId
      || entry.sessionId === localPrompt.auditSessionId;
  }

  const entryAt = Date.parse(entry.timestamp || '');
  return !Number.isFinite(entryAt) || entryAt >= localPrompt.localAt - 5000;
}
