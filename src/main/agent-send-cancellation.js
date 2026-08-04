'use strict';

const MAX_CANCELLED_SENDS = 512;

function createAgentSendCancellationRegistry() {
  const cancelledByExactHandoff = new Map();
  const listeners = new Set();
  const keyFor = (tabId, handoffId, attemptId = null) => {
    const tab = String(tabId || '').trim();
    const handoff = String(handoffId || '').trim();
    const attempt = String(attemptId || '').trim();
    return tab && handoff ? tab + '\u0000' + handoff + '\u0000' + (attempt || '*') : null;
  };
  const keyPrefixFor = (tabId, handoffId) => {
    const tab = String(tabId || '').trim();
    const handoff = String(handoffId || '').trim();
    return tab && handoff ? tab + '\u0000' + handoff + '\u0000' : null;
  };
  const parseCancelOptions = (optionsOrNow) => {
    if (optionsOrNow && typeof optionsOrNow === 'object') {
      return {
        attemptId: String(optionsOrNow.attemptId || '').trim() || null,
        now: Number(optionsOrNow.now) || Date.now(),
      };
    }
    return { attemptId: null, now: Number(optionsOrNow) || Date.now() };
  };
  const trim = () => {
    while (cancelledByExactHandoff.size > MAX_CANCELLED_SENDS) {
      const oldest = cancelledByExactHandoff.keys().next().value;
      if (oldest === undefined) break;
      cancelledByExactHandoff.delete(oldest);
    }
  };
  return {
    cancel(tabId, handoffId, optionsOrNow = Date.now()) {
      const options = parseCancelOptions(optionsOrNow);
      const key = keyFor(tabId, handoffId, options.attemptId);
      if (!key) return { cancelled: false, reason: 'missing-exact-handoff' };
      const existing = cancelledByExactHandoff.get(key);
      if (existing) return { cancelled: true, deduped: true, ...existing };
      const state = {
        tabId,
        handoffId,
        attemptId: options.attemptId,
        cancelledAt: options.now,
      };
      cancelledByExactHandoff.set(key, state);
      trim();
      for (const listener of listeners) listener({ ...state });
      return { cancelled: true, deduped: false, ...state };
    },
    isCancelled(tabId, handoffId, attemptId = null) {
      const prefix = keyPrefixFor(tabId, handoffId);
      if (!prefix) return false;
      const attempt = String(attemptId || '').trim();
      if (attempt) {
        return cancelledByExactHandoff.has(prefix + attempt)
          || cancelledByExactHandoff.has(prefix + '*');
      }
      for (const key of cancelledByExactHandoff.keys()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    },
    clear(tabId, handoffId, attemptId = null) {
      const prefix = keyPrefixFor(tabId, handoffId);
      if (!prefix) return false;
      const attempt = String(attemptId || '').trim();
      if (attempt) {
        return cancelledByExactHandoff.delete(prefix + attempt);
      }
      let deleted = false;
      for (const key of Array.from(cancelledByExactHandoff.keys())) {
        if (key.startsWith(prefix)) deleted = cancelledByExactHandoff.delete(key) || deleted;
      }
      return deleted;
    },
    wait(tabId, handoffId, attemptId = null) {
      const key = keyFor(tabId, handoffId, attemptId);
      if (!key) {
        return {
          promise: Promise.resolve({ cancelled: false, reason: 'missing-exact-handoff' }),
          dispose() {},
        };
      }
      const wildcardKey = keyFor(tabId, handoffId, null);
      const current = cancelledByExactHandoff.get(key)
        || (attemptId ? cancelledByExactHandoff.get(wildcardKey) : null);
      if (current) {
        return {
          promise: Promise.resolve({ cancelled: true, ...current }),
          dispose() {},
        };
      }
      let resolvePromise;
      let disposed = false;
      const promise = new Promise((resolve) => { resolvePromise = resolve; });
      const listener = (state) => {
        if (disposed) return;
        const stateKey = keyFor(state.tabId, state.handoffId, state.attemptId);
        if (attemptId) {
          if (stateKey !== key && stateKey !== wildcardKey) return;
        } else if (!stateKey?.startsWith(keyPrefixFor(tabId, handoffId))) {
          return;
        }
        disposed = true;
        listeners.delete(listener);
        resolvePromise({ cancelled: true, ...state });
      };
      listeners.add(listener);
      return {
        promise,
        dispose() {
          if (disposed) return;
          disposed = true;
          listeners.delete(listener);
        },
      };
    },
    reset() {
      cancelledByExactHandoff.clear();
      listeners.clear();
    },
  };
}

module.exports = {
  MAX_CANCELLED_SENDS,
  createAgentSendCancellationRegistry,
};
