import { getCodexRuntimeReadSessionId } from './codexPtyPresence.mjs';

const byTab = new Map();
const listenersByTab = new Map();

const notify = (tabId) => {
  for (const listener of listenersByTab.get(tabId) || []) listener();
};

/**
 * Read-only Codex identity for History/Timeline/surface navigation.
 *
 * This deliberately does NOT write Tab.codexSessionId: a Resume source can be
 * safe to read before the live writer is known, but it cannot authorize
 * mutation or become the durable writer binding.
 */
export function publishCodexSurfaceReadIdentity(tabId, runtimeSnapshot) {
  const key = String(tabId || '').trim();
  if (!key) return null;
  const next = getCodexRuntimeReadSessionId(runtimeSnapshot);
  const previous = byTab.get(key) || null;
  // A first-submit barrier temporarily makes copy identity unresolved while
  // Codex decides source-in-place vs child. Keep the last exact read-only
  // surface visible through that handoff; command-started clears it explicitly
  // at the generation boundary, and exact writer adoption replaces it.
  if (next) byTab.set(key, next);
  else if (runtimeSnapshot?.liveLifecycle !== true) byTab.delete(key);
  else return previous;
  if (previous !== next) notify(key);
  return next;
}

export function clearCodexSurfaceReadIdentity(tabId) {
  const key = String(tabId || '').trim();
  if (!key || !byTab.has(key)) return false;
  byTab.delete(key);
  notify(key);
  return true;
}

export function getCodexSurfaceReadSessionId(tabId) {
  return byTab.get(String(tabId || '').trim()) || null;
}

export function subscribeCodexSurfaceReadIdentity(tabId, listener) {
  const key = String(tabId || '').trim();
  if (!key || typeof listener !== 'function') return () => {};
  let listeners = listenersByTab.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByTab.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByTab.delete(key);
  };
}

export function resetCodexSurfaceReadIdentityStoreForTests() {
  byTab.clear();
  listenersByTab.clear();
}
