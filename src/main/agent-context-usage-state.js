'use strict';

/**
 * Main-owned context usage for one terminal tab.
 *
 * Renderer surfaces are consumers, not owners: a compact or token update can
 * arrive while every visual surface for the tab is unmounted. Keep the latest
 * exact provider/session snapshot here and tell the caller when the visible
 * whole-percent changed enough to justify one cheap SQLite write.
 */
function normalizeAuthoritativeContextPct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.min(100, value);
}

function createAgentContextUsageState() {
  const byTab = new Map();
  let semanticRevision = 0;

  return {
    observe({ tabId, provider, sessionId, contextPct, observedAt = Date.now() } = {}) {
      const normalizedTabId = String(tabId || '').trim();
      const normalizedProvider = String(provider || '').trim();
      const normalizedSessionId = String(sessionId || '').trim();
      const normalizedPct = normalizeAuthoritativeContextPct(contextPct);
      if (!normalizedTabId || !normalizedProvider || !normalizedSessionId || normalizedPct == null) {
        return { accepted: false, shouldPersist: false, snapshot: null };
      }

      const previous = byTab.get(normalizedTabId) || null;
      const semanticallyChanged = !previous
        || previous.provider !== normalizedProvider
        || previous.sessionId !== normalizedSessionId
        || previous.contextPct !== normalizedPct;
      const persistenceBucket = Math.round(normalizedPct);
      const shouldPersist = !previous
        || previous.provider !== normalizedProvider
        || previous.sessionId !== normalizedSessionId
        || previous.persistenceBucket !== persistenceBucket;
      const snapshot = {
        tabId: normalizedTabId,
        provider: normalizedProvider,
        sessionId: normalizedSessionId,
        contextPct: normalizedPct,
        persistenceBucket,
        observedAt: Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.now(),
        semanticRevision: semanticallyChanged ? ++semanticRevision : previous.semanticRevision,
      };
      byTab.set(normalizedTabId, snapshot);
      return { accepted: true, shouldPersist, snapshot: { ...snapshot } };
    },

    read(tabId, { provider = null, sessionId = null } = {}) {
      const snapshot = byTab.get(String(tabId || '').trim()) || null;
      if (!snapshot) return null;
      if (provider && snapshot.provider !== String(provider)) return null;
      if (sessionId && snapshot.sessionId !== String(sessionId)) return null;
      return { ...snapshot };
    },

    invalidate(tabId, { provider = null, sessionId = null } = {}) {
      const normalizedTabId = String(tabId || '').trim();
      if (!normalizedTabId) return { accepted: false, previous: null };
      const previous = byTab.get(normalizedTabId) || null;
      if (previous && provider && previous.provider !== String(provider)) {
        return { accepted: false, previous: { ...previous } };
      }
      if (previous && sessionId && previous.sessionId !== String(sessionId)) {
        return { accepted: false, previous: { ...previous } };
      }
      byTab.delete(normalizedTabId);
      return { accepted: true, previous: previous ? { ...previous } : null };
    },

    clear(tabId) {
      byTab.delete(String(tabId || '').trim());
    },
  };
}

module.exports = {
  createAgentContextUsageState,
  normalizeAuthoritativeContextPct,
};
