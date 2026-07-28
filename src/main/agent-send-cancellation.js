'use strict';

const MAX_CANCELLED_SENDS = 512;

function createAgentSendCancellationRegistry() {
  const cancelledByExactHandoff = new Map();
  const listeners = new Set();
  const keyFor = (tabId, handoffId) => {
    const tab = String(tabId || '').trim();
    const handoff = String(handoffId || '').trim();
    return tab && handoff ? tab + '\u0000' + handoff : null;
  };
  const trim = () => {
    while (cancelledByExactHandoff.size > MAX_CANCELLED_SENDS) {
      const oldest = cancelledByExactHandoff.keys().next().value;
      if (oldest === undefined) break;
      cancelledByExactHandoff.delete(oldest);
    }
  };
  return {
    cancel(tabId, handoffId, now = Date.now()) {
      const key = keyFor(tabId, handoffId);
      if (!key) return { cancelled: false, reason: 'missing-exact-handoff' };
      const existing = cancelledByExactHandoff.get(key);
      if (existing) return { cancelled: true, deduped: true, ...existing };
      const state = { tabId, handoffId, cancelledAt: Number(now) || Date.now() };
      cancelledByExactHandoff.set(key, state);
      trim();
      for (const listener of listeners) listener({ ...state });
      return { cancelled: true, deduped: false, ...state };
    },
    isCancelled(tabId, handoffId) {
      const key = keyFor(tabId, handoffId);
      return key ? cancelledByExactHandoff.has(key) : false;
    },
    clear(tabId, handoffId) {
      const key = keyFor(tabId, handoffId);
      return key ? cancelledByExactHandoff.delete(key) : false;
    },
    wait(tabId, handoffId) {
      const key = keyFor(tabId, handoffId);
      if (!key) {
        return {
          promise: Promise.resolve({ cancelled: false, reason: 'missing-exact-handoff' }),
          dispose() {},
        };
      }
      const current = cancelledByExactHandoff.get(key);
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
        if (disposed || keyFor(state.tabId, state.handoffId) !== key) return;
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
