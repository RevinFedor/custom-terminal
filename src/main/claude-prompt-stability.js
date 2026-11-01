'use strict';

// A launch that never paints another synchronized frame leaves the startup
// transaction waiting forever: `/model` is never written, the gate stays
// `pending`, and the tab shows "configuring Claude" with no terminal state.
// Production 2026-10-31 (tabs d1718b66 / 029152fbe588 / 2efc9b9b7a35): Claude
// reached its 5-hour usage limit and printed the limit notice plus
// "IDE extension install failed" OUTSIDE a synchronized-output pair, so
// `markStable` was never reached even though the composer was idle and the
// process alive. The working tab in the same window logged 5250 frame events;
// each stuck tab logged one `open` and nothing else.
//
// The wait is therefore bounded. A deadline does not authorize input: it
// resolves `ready:false` with its own reason, so the existing caller keeps
// refusing paste/Enter and the transaction can fail visibly and be retried
// instead of hanging. Each readiness or activity signal re-arms the deadline,
// so an actively repainting launch is never cut short.
const DEFAULT_PROMPT_STABILITY_TIMEOUT_MS = 45000;

function createClaudePromptStabilityRegistry({
  now = () => Date.now(),
  log = () => {},
  timeoutMs = DEFAULT_PROMPT_STABILITY_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) {
  const byTab = new Map();
  const finiteTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : null;

  function cancelDeadline(entry) {
    if (!entry?.deadlineTimer) return;
    try { clearTimer(entry.deadlineTimer); } catch {}
    entry.deadlineTimer = null;
    entry.deadlineAt = null;
  }

  // The deadline exists only while something is actually waiting. Re-arming on
  // every signal measures silence since the last observed frame, not time
  // since the wait began.
  function armDeadline(entry) {
    if (!entry || finiteTimeoutMs === null) return;
    cancelDeadline(entry);
    if (entry.waiters.size === 0) return;
    const generation = entry.generation;
    entry.deadlineAt = now() + finiteTimeoutMs;
    entry.deadlineTimer = setTimer(() => {
      const current = byTab.get(entry.tabId) || null;
      if (current !== entry || current.generation !== generation) return;
      entry.deadlineTimer = null;
      entry.deadlineAt = null;
      if (entry.waiters.size === 0) return;
      log('[ClaudePromptStable] deadline tab=' + String(entry.tabId).slice(-12)
        + ' gen=' + generation
        + ' waiters=' + entry.waiters.size
        + ' busy=' + entry.busy
        + ' activityEpoch=' + entry.activityEpoch
        + ' promptEpoch=' + entry.promptEpoch
        + ' afterMs=' + finiteTimeoutMs);
      resolveWaiters(entry, {
        ready: false,
        generation,
        reason: entry.busy
          ? 'prompt-stability-timeout-busy'
          : 'prompt-stability-timeout-no-frame',
        timedOut: true,
        afterMs: finiteTimeoutMs,
      });
    }, finiteTimeoutMs);
  }

  function resolveWaiters(entry, result) {
    if (!entry) return;
    cancelDeadline(entry);
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
      deadlineTimer: null,
      deadlineAt: null,
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
      armDeadline(entry);
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
    armDeadline(entry);
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
    armDeadline(entry);
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
    return new Promise((resolve) => {
      entry.waiters.add(resolve);
      armDeadline(entry);
    });
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
      waiters: entry.waiters.size,
      deadlineAt: entry.deadlineAt || null,
      timeoutMs: finiteTimeoutMs,
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
  DEFAULT_PROMPT_STABILITY_TIMEOUT_MS,
};
