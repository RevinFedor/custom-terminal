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

// The live carrier may promote an audited response_item to event_msg. Its
// text stays owned by the local card, but its proven aliases must not be lost
// when the duplicate live body is suppressed.
export function retainHistoryLocalPromptLiveAliases(entries, envelope, isLocalPrompt) {
  const message = envelope?.message;
  const sessionId = envelope?.sessionId;
  if (!Array.isArray(entries) || message?.type !== 'user' || !sessionId
    || (message.sessionId && message.sessionId !== sessionId)) return entries;
  const incoming = [message.sourceIdentity, ...(Array.isArray(message.sourceIdentityAliases) ? message.sourceIdentityAliases : [])]
    .filter(identity => typeof identity === 'string' && identity);
  if (incoming.length === 0) return entries;
  let changed = false;
  const next = entries.map(entry => {
    if (!isLocalPrompt(entry) || (entry.auditSessionId || entry.sessionId) !== sessionId
      || !matchesHistoryPromptExactProof(message, {
        entryUuid: entry.auditEntryUuid, sourceIdentity: entry.sourceIdentity,
      })) return entry;
    const previous = Array.isArray(entry.sourceIdentityAliases) ? entry.sourceIdentityAliases : [];
    const aliases = [...new Set([...previous, ...incoming])]
      .filter(identity => identity !== entry.sourceIdentity);
    if (aliases.length === previous.length) return entry;
    changed = true;
    return { ...entry, sourceIdentityAliases: aliases };
  });
  return changed ? next : entries;
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
