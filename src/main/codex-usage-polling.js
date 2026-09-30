'use strict';

// One account-level clock in main, independent of renderer visibility or selection.
function createCodexUsagePolling({
  listTargets,
  refreshTarget,
  onUpdated = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = 30_000,
  errorCooldownMs = 60_000,
}) {
  const states = new Map();
  let timer = null;
  let stopped = true;

  function tick() {
    if (stopped) return;
    timer = setTimer(tick, intervalMs);
    timer?.unref?.();
    let targets;
    try { targets = new Map(listTargets().map(target => [target.key, target])); }
    catch { return; } // Auth may be replaced while reading; the next tick retries discovery.
    for (const key of states.keys()) if (!targets.has(key)) states.delete(key);
    for (const [key, target] of targets) {
      const previous = states.get(key);
      if (previous?.pending) continue;
      if (previous && previous.identity === target.identity && now() < previous.nextAt) continue;
      const state = { identity: target.identity, pending: true, nextAt: now() + intervalMs };
      states.set(key, state);
      Promise.resolve().then(() => refreshTarget(target)).then(result => {
        if (stopped || states.get(key) !== state) return;
        if (result?.error) state.nextAt = Math.max(state.nextAt, now() + errorCooldownMs);
        onUpdated(target);
      }, () => {
        if (!stopped && states.get(key) === state) {
          state.nextAt = now() + errorCooldownMs;
          onUpdated(target);
        }
      }).finally(() => { state.pending = false; });
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimer(tick, 0);
      timer?.unref?.();
    },
    stop() {
      stopped = true;
      clearTimer(timer);
      timer = null;
      states.clear();
    },
  };
}

module.exports = { createCodexUsagePolling };
