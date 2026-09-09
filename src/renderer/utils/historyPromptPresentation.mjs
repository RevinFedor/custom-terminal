import { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';
export { historyEntryHasExactIdentity } from '../../shared/history-entry-identity.mjs';

export function resolveHistoryNavigationTarget(entries, requestedIdentity) {
  const requested = typeof requestedIdentity === 'string'
    ? requestedIdentity.trim()
    : '';
  if (!requested) return null;
  const source = Array.isArray(entries) ? entries : [];
  const index = source.findIndex((entry) => historyEntryHasExactIdentity(entry, requested));
  if (index < 0) return null;
  const uuid = typeof source[index]?.uuid === 'string' ? source[index].uuid : '';
  return uuid ? { uuid, index, requestedIdentity: requested } : null;
}

export function matchesHistoryPromptExactProof(entry, proof = {}) {
  const identities = [proof.entryUuid, proof.sourceIdentity]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean);
  return identities.some((identity) => historyEntryHasExactIdentity(entry, identity));
}

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
