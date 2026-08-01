'use strict';

function createClaudePromptStabilityRegistry({ now = () => Date.now(), log = () => {} } = {}) {
  const byTab = new Map();

  function resolveWaiters(entry, result) {
    if (!entry) return;
    for (const resolve of Array.from(entry.waiters)) {
      try { resolve(result); } catch {}
    }
    entry.waiters.clear();
  }

  function readyResult(entry, reason) {
    return {
      ready: true,
      generation: entry.generation,
      reason,
      at: now(),
      lease: {
        generation: entry.generation,
        activityEpoch: entry.activityEpoch,
        busyEpoch: entry.busyEpoch,
        promptEpoch: entry.promptEpoch,
      },
    };
  }

  function open(tabId, generation, reason = 'launch-open') {
    if (!tabId || !generation) return null;
    const existing = byTab.get(tabId) || null;
    if (existing?.generation === generation) return existing;
    if (existing) {
      resolveWaiters(existing, {
        ready: false,
        generation: existing.generation,
        reason: 'generation-superseded',
      });
    }
    const entry = {
      tabId,
      generation,
      openedAt: now(),
      openedReason: reason,
      ready: false,
      busy: false,
      activityEpoch: 0,
      busyEpoch: 0,
      promptEpoch: 0,
      result: null,
      waiters: new Set(),
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
    entry.promptEpoch += 1;
    entry.activityEpoch += 1;
    if (entry.busy) {
      entry.ready = false;
      entry.result = null;
      log('[ClaudePromptStable] prompt-ignored-busy tab=' + String(tabId).slice(-12)
        + ' gen=' + generation
        + ' reason=' + reason);
      return false;
    }
    entry.ready = true;
    entry.result = readyResult(entry, reason);
    resolveWaiters(entry, entry.result);
    log('[ClaudePromptStable] ready tab=' + String(tabId).slice(-12)
      + ' gen=' + generation
      + ' promptEpoch=' + entry.promptEpoch
      + ' activityEpoch=' + entry.activityEpoch
      + ' reason=' + reason);
    return true;
  }

  function markActivity(tabId, generation, reason = 'terminal-activity') {
    const entry = byTab.get(tabId) || null;
    if (!entry || entry.generation !== generation) return false;
    entry.activityEpoch += 1;
    entry.ready = false;
    entry.result = null;
    log('[ClaudePromptStable] invalidate tab=' + String(tabId).slice(-12)
      + ' gen=' + generation
      + ' activityEpoch=' + entry.activityEpoch
      + ' reason=' + reason);
    return true;
  }

  function markBusy(tabId, generation, busy, reason = 'turn-state') {
    const entry = byTab.get(tabId) || null;
    if (!entry || entry.generation !== generation) return false;
    entry.busy = busy === true;
    entry.busyEpoch += 1;
    entry.activityEpoch += 1;
    entry.ready = false;
    entry.result = null;
    log('[ClaudePromptStable] busy tab=' + String(tabId).slice(-12)
      + ' gen=' + generation
      + ' busy=' + entry.busy
      + ' busyEpoch=' + entry.busyEpoch
      + ' reason=' + reason);
    return true;
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
    if (entry.ready && !entry.busy && entry.result?.ready === true) {
      return Promise.resolve({
        ...entry.result,
        lease: { ...entry.result.lease },
      });
    }
    return new Promise((resolve) => entry.waiters.add(resolve));
  }

  function validate(tabId, generation, lease, { allowFrameAdvance = false } = {}) {
    const entry = byTab.get(tabId) || null;
    if (!entry || entry.generation !== generation || lease?.generation !== generation) {
      return { valid: false, reason: 'stale-generation' };
    }
    if (entry.busy) return { valid: false, reason: 'claude-turn-busy' };
    if (Number(lease.busyEpoch) !== Number(entry.busyEpoch)) {
      return { valid: false, reason: 'claude-busy-generation-changed' };
    }
    if (!allowFrameAdvance && (
      entry.ready !== true
      || Number(lease.activityEpoch) !== Number(entry.activityEpoch)
      || Number(lease.promptEpoch) !== Number(entry.promptEpoch)
    )) {
      return { valid: false, reason: 'claude-prompt-frame-changed' };
    }
    return { valid: true, reason: 'claude-prompt-lease-current' };
  }

  function clear(tabId, generation = null, reason = 'cleared') {
    const entry = byTab.get(tabId) || null;
    if (!entry || (generation && entry.generation !== generation)) return false;
    byTab.delete(tabId);
    resolveWaiters(entry, {
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
      settled: entry.ready,
      ready: entry.ready,
      busy: entry.busy,
      activityEpoch: entry.activityEpoch,
      busyEpoch: entry.busyEpoch,
      promptEpoch: entry.promptEpoch,
      result: entry.result ? { ...entry.result } : null,
    };
  }

  return {
    open,
    markStable,
    markActivity,
    markBusy,
    wait,
    validate,
    clear,
    snapshot,
  };
}

module.exports = {
  createClaudePromptStabilityRegistry,
};
