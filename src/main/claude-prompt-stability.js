'use strict';

function createClaudePromptStabilityRegistry({ now = () => Date.now(), log = () => {} } = {}) {
  const byTab = new Map();

  function settle(entry, result) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    entry.result = result;
    entry.resolve(result);
    return true;
  }

  function open(tabId, generation, reason = 'launch-open') {
    if (!tabId || !generation) return null;
    const existing = byTab.get(tabId) || null;
    if (existing?.generation === generation) return existing;
    if (existing) {
      settle(existing, {
        ready: false,
        generation: existing.generation,
        reason: 'generation-superseded',
      });
    }

    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const entry = {
      tabId,
      generation,
      openedAt: now(),
      openedReason: reason,
      settled: false,
      result: null,
      resolve,
      promise,
    };
    byTab.set(tabId, entry);
    log('[ClaudePromptStable] open tab=' + String(tabId).slice(-12)
      + ' gen=' + generation
      + ' reason=' + reason);
    return entry;
  }

  function markStable(tabId, generation, reason = 'prompt-output-settled') {
    const entry = byTab.get(tabId) || null;
    if (!entry || entry.generation !== generation) return false;
    const result = {
      ready: true,
      generation,
      reason,
      at: now(),
    };
    const changed = settle(entry, result);
    if (changed) {
      log('[ClaudePromptStable] ready tab=' + String(tabId).slice(-12)
        + ' gen=' + generation
        + ' reason=' + reason);
    }
    return changed;
  }

  function wait(tabId, generation) {
    const entry = byTab.get(tabId) || null;
    if (!entry) {
      return Promise.resolve({
        ready: false,
        generation: generation || null,
        reason: 'stability-gate-missing',
      });
    }
    if (entry.generation !== generation) {
      return Promise.resolve({
        ready: false,
        generation,
        reason: 'stale-generation',
      });
    }
    return entry.promise;
  }

  function clear(tabId, generation = null, reason = 'cleared') {
    const entry = byTab.get(tabId) || null;
    if (!entry || (generation && entry.generation !== generation)) return false;
    byTab.delete(tabId);
    settle(entry, {
      ready: false,
      generation: entry.generation,
      reason,
    });
    log('[ClaudePromptStable] clear tab=' + String(tabId).slice(-12)
      + ' gen=' + entry.generation
      + ' reason=' + reason);
    return true;
  }

  function snapshot(tabId) {
    const entry = byTab.get(tabId) || null;
    if (!entry) return null;
    return {
      tabId: entry.tabId,
      generation: entry.generation,
      openedAt: entry.openedAt,
      openedReason: entry.openedReason,
      settled: entry.settled,
      result: entry.result ? { ...entry.result } : null,
    };
  }

  return {
    open,
    markStable,
    wait,
    clear,
    snapshot,
  };
}

module.exports = {
  createClaudePromptStabilityRegistry,
};
