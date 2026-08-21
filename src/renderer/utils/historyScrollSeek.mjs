export const HISTORY_SCROLL_SEEK_ENTER_PX_PER_S = 3000;
export const HISTORY_SCROLL_SEEK_EXIT_PX_PER_S = 500;
export const HISTORY_SCROLL_SEEK_MIN_HOLD_MS = 150;
export const HISTORY_WHEEL_BURST_DELTA_PX = 600;
export const HISTORY_WHEEL_BURST_HOLD_MS = 250;
export const HISTORY_SCROLL_SEEK_BURST_CONFIRM_PX_PER_S = 2600;
export const HISTORY_MACHINE_SCROLL_COOLDOWN_MS = 450;

/**
 * One controller per mounted History panel.
 *
 * Virtuoso accepts an object with `enter` / `exit` callbacks, which made it
 * tempting to keep one module-level config. That silently turned all split
 * panes into one owner: a tail-pinned B suppressed seek in A, and the recovery
 * nudge targeted whichever scroller moved last. The controller keeps every
 * mutable part beside the panel that owns it.
 */
export function createHistoryScrollSeekController({
  now = () => globalThis.performance.now(),
  requestFrame = globalThis.requestAnimationFrame,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  isSuppressed = () => false,
  onTransition = () => {},
  enterVelocity = HISTORY_SCROLL_SEEK_ENTER_PX_PER_S,
  exitVelocity = HISTORY_SCROLL_SEEK_EXIT_PX_PER_S,
  minHoldMs = HISTORY_SCROLL_SEEK_MIN_HOLD_MS,
  wheelBurstDeltaPx = HISTORY_WHEEL_BURST_DELTA_PX,
  wheelBurstHoldMs = HISTORY_WHEEL_BURST_HOLD_MS,
  burstConfirmVelocity = HISTORY_SCROLL_SEEK_BURST_CONFIRM_PX_PER_S,
  machineCooldownMs = HISTORY_MACHINE_SCROLL_COOLDOWN_MS,
} = {}) {
  let wheelBurstUntil = 0;
  let machineScrollCooldownUntil = 0;
  let scroller = null;
  let ownerToken = null;
  let kickTimer = null;
  let active = false;
  let enteredAt = 0;
  const exitListeners = new Set();

  const cancelKick = () => {
    if (kickTimer === null) return;
    clearTimer(kickTimer);
    kickTimer = null;
  };

  const notifyExit = (reason, velocity = 0) => {
    if (!active) return;
    active = false;
    cancelKick();
    onTransition({
      kind: 'exit',
      velocity,
      heldMs: Math.max(0, now() - enteredAt),
      reason,
    });
    for (const listener of [...exitListeners]) {
      exitListeners.delete(listener);
      try { listener(); } catch { /* mount-wave wake-up is best-effort */ }
    }
  };

  const scheduleKick = () => {
    cancelKick();
    const currentNow = now();
    const wait = Math.max(minHoldMs, wheelBurstUntil - currentNow) + 60;
    kickTimer = setTimer(() => {
      kickTimer = null;
      if (!active) return;
      if (now() < wheelBurstUntil) {
        scheduleKick();
        return;
      }
      const target = scroller;
      if (!target || !target.isConnected) {
        notifyExit('scroller-gone');
        return;
      }
      const original = target.scrollTop;
      const nudged = original > 0 ? original - 1 : original + 1;
      target.scrollTop = nudged;
      requestFrame(() => {
        // Never restore into a replacement panel. A real gesture or another
        // layout writer also wins by changing scrollTop away from our nudge.
        if (scroller === target
          && target.isConnected
          && Math.abs(target.scrollTop - nudged) <= 0.5) {
          target.scrollTop = original;
        }
      });
    }, wait);
  };

  const configuration = {
    enter: (velocity) => {
      if (isSuppressed()) return false;
      if (now() < machineScrollCooldownUntil) return false;
      const burst = now() < wheelBurstUntil;
      const threshold = burst ? burstConfirmVelocity : enterVelocity;
      const shouldEnter = Math.abs(velocity) > threshold;
      if (shouldEnter && !active) {
        active = true;
        enteredAt = now();
        onTransition({ kind: 'enter', velocity, burst });
        scheduleKick();
      }
      return shouldEnter;
    },
    exit: (velocity) => {
      if (now() < wheelBurstUntil) {
        scheduleKick();
        return false;
      }
      if (Math.abs(velocity) >= exitVelocity) return false;
      if (active && now() - enteredAt < minHoldMs) {
        scheduleKick();
        return false;
      }
      if (active) notifyExit('velocity-settled', velocity);
      return true;
    },
  };

  return {
    configuration,
    armWheelBurst(deltaY) {
      if (Math.abs(Number(deltaY) || 0) >= wheelBurstDeltaPx) {
        wheelBurstUntil = now() + wheelBurstHoldMs;
      }
    },
    stampMachineScrollCooldown() {
      machineScrollCooldownUntil = now() + machineCooldownMs;
    },
    setScroller(nextScroller, nextOwnerToken = null) {
      const ownerChanged = ownerToken !== nextOwnerToken;
      if (!ownerChanged && scroller === nextScroller) return;
      if (active) notifyExit('scroller-change');
      scroller = nextScroller || null;
      // A machine jump belongs to the History OWNER, not to one callback-ref
      // delivery of its DOM element. React/Virtuoso may report null -> the
      // same/new element during an ordinary render; clearing the cooldown on
      // that same-owner remount lets the jump's delayed velocity echo enter
      // seek mode and replace already-correct text with skeletons.
      //
      // A real owner takeover is different: neither gesture evidence nor a
      // machine cooldown from A may make B answer A's scroll question.
      if (!ownerChanged) {
        wheelBurstUntil = 0;
        return;
      }
      ownerToken = nextOwnerToken;
      wheelBurstUntil = 0;
      machineScrollCooldownUntil = 0;
      enteredAt = 0;
    },
    isActive: () => active,
    onExitOnce(listener) {
      if (typeof listener !== 'function') return () => {};
      if (!active) {
        listener();
        return () => {};
      }
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    dispose() {
      cancelKick();
      active = false;
      scroller = null;
      ownerToken = null;
      exitListeners.clear();
    },
  };
}
