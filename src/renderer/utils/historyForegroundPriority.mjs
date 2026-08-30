const defaultNow = () => performance.now();

const defaultDelay = (ms) => new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, ms));
});

const defaultBackgroundYield = async () => {
  const browserScheduler = globalThis.scheduler;
  if (browserScheduler?.postTask) {
    await browserScheduler.postTask(() => {}, { priority: 'background' });
    return;
  }
  await new Promise((resolve) => {
    const browser = globalThis;
    if (typeof browser.requestIdleCallback === 'function') {
      browser.requestIdleCallback(() => resolve(), { timeout: 250 });
    } else {
      setTimeout(resolve, 0);
    }
  });
};

const defaultHasPendingInput = () => {
  try {
    return globalThis.navigator?.scheduling?.isInputPending?.({ includeContinuous: true }) === true;
  } catch {
    return false;
  }
};

/**
 * One renderer-wide priority lease for a physical History gesture.
 *
 * A hidden transcript can finish IPC at any time. Starting its grouping,
 * Timeline reconciliation or mount-wave in that continuation used to put
 * 100-600ms of synchronous work in front of an already queued wheel event.
 * The lease does not cancel prewarm or discard its result: background work
 * waits for the gesture's quiet edge, then enters through the browser's
 * background task lane. Foreground work itself remains untouched.
 */
export const createHistoryForegroundPriority = ({
  now = defaultNow,
  delay = defaultDelay,
  backgroundYield = defaultBackgroundYield,
  hasPendingInput = defaultHasPendingInput,
} = {}) => {
  let holdUntil = 0;
  let owner = '';
  let interruptible = null;
  let interruptSequence = 0;
  const activeInteractions = new Set();

  const remainingMs = () => Math.max(0, holdUntil - now());
  const active = () => activeInteractions.size > 0 || remainingMs() > 0 || hasPendingInput();

  const interruptBackgroundWork = () => {
    const pending = interruptible;
    interruptible = null;
    try { pending?.interrupt?.(); } catch { /* input priority must fail safe */ }
  };

  const mark = (nextOwner, holdMs = 500) => {
    const safeHoldMs = Math.max(0, Number(holdMs) || 0);
    owner = String(nextOwner || owner || 'history');
    holdUntil = Math.max(holdUntil, now() + safeHoldMs);
    // At most one hidden mount-wave transition is admitted renderer-wide.
    // If its React commit has not landed yet, the physical wheel cancels that
    // pending upgrade before it can become a long task in front of scrolling.
    interruptBackgroundWork();
    return { owner, holdUntil, remainingMs: remainingMs() };
  };

  // A drag is a continuous foreground interaction, not a packet-sized lease.
  // Keep hidden History work out of the renderer lane even when the pointer is
  // held still longer than the ordinary wheel quiet window.
  const beginInteraction = (rawOwner) => {
    const interactionOwner = String(rawOwner || 'renderer-interaction');
    activeInteractions.add(interactionOwner);
    owner = interactionOwner;
    interruptBackgroundWork();
    return interactionOwner;
  };

  const endInteraction = (rawOwner) => {
    const interactionOwner = String(rawOwner || '');
    if (!interactionOwner) return false;
    return activeInteractions.delete(interactionOwner);
  };

  const registerInterruptibleBackgroundWork = (workOwner, interrupt) => {
    if (typeof interrupt !== 'function') return () => {};
    const token = ++interruptSequence;
    interruptible = { token, owner: String(workOwner || ''), interrupt };
    return () => {
      if (interruptible?.token === token) interruptible = null;
    };
  };

  const waitForBackgroundSlot = async ({
    shouldBypass = () => false,
  } = {}) => {
    const startedAt = now();
    let checks = 0;
    while (true) {
      if (shouldBypass()) {
        return { reason: 'bypass', waitedMs: Math.max(0, now() - startedAt), checks };
      }
      const remaining = remainingMs();
      const pendingInput = hasPendingInput();
      const interactionActive = activeInteractions.size > 0;
      if (remaining <= 0 && !pendingInput && !interactionActive) {
        // The background scheduler arbitrates against input that was queued
        // after the last JS check but before this task became runnable.
        await backgroundYield();
        checks += 1;
        if (shouldBypass()) {
          return { reason: 'bypass', waitedMs: Math.max(0, now() - startedAt), checks };
        }
        if (activeInteractions.size === 0 && remainingMs() <= 0 && !hasPendingInput()) {
          return { reason: 'idle', waitedMs: Math.max(0, now() - startedAt), checks };
        }
        continue;
      }
      // Re-check presentation/owner at least every frame-sized slice so a
      // queued hidden pane promoted to foreground never waits for the old
      // gesture's full hold window.
      const waitMs = pendingInput || interactionActive
        ? 16
        : Math.min(32, Math.max(1, remaining));
      await delay(waitMs);
      checks += 1;
    }
  };

  const resetForTests = () => {
    holdUntil = 0;
    owner = '';
    interruptible = null;
    activeInteractions.clear();
  };

  return {
    active,
    beginInteraction,
    endInteraction,
    interactionCount: () => activeInteractions.size,
    mark,
    owner: () => owner,
    registerInterruptibleBackgroundWork,
    remainingMs,
    waitForBackgroundSlot,
    resetForTests,
  };
};

export const historyForegroundPriority = createHistoryForegroundPriority();
