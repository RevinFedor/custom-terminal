// Virtuoso 4.x reports displacement between its throttled (~100ms) samples,
// NOT pixels/second. Keep the shipping thresholds; do not retune scroll UX
// while fixing who is allowed to contribute to that displacement.
export const HISTORY_SCROLL_SEEK_ENTER_SAMPLE_PX = 3000;
export const HISTORY_SCROLL_SEEK_EXIT_SAMPLE_PX = 500;
export const HISTORY_SCROLL_SEEK_MIN_HOLD_MS = 150;
export const HISTORY_WHEEL_BURST_DELTA_PX = 600;
export const HISTORY_WHEEL_BURST_HOLD_MS = 250;
export const HISTORY_WHEEL_GESTURE_HOLD_MS = 260;
export const HISTORY_WHEEL_GESTURE_CONFIRM_DELTA_PX = 80;
export const HISTORY_WHEEL_GESTURE_CONFIRM_WINDOW_MS = 120;
export const HISTORY_WHEEL_GESTURE_CONFIRM_PX_PER_S = 2600;
export const HISTORY_SCROLL_SEEK_BURST_CONFIRM_SAMPLE_PX = 2600;
export const HISTORY_MACHINE_SCROLL_COOLDOWN_MS = 450;
const MAX_WHEEL_CREDITS = 128;
const MAX_REJECT_LOGS_PER_GESTURE = 6;

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
  onRejectedSample = () => {},
  enterVelocity = HISTORY_SCROLL_SEEK_ENTER_SAMPLE_PX,
  exitVelocity = HISTORY_SCROLL_SEEK_EXIT_SAMPLE_PX,
  minHoldMs = HISTORY_SCROLL_SEEK_MIN_HOLD_MS,
  wheelBurstDeltaPx = HISTORY_WHEEL_BURST_DELTA_PX,
  wheelBurstHoldMs = HISTORY_WHEEL_BURST_HOLD_MS,
  wheelGestureHoldMs = HISTORY_WHEEL_GESTURE_HOLD_MS,
  wheelGestureConfirmDeltaPx = HISTORY_WHEEL_GESTURE_CONFIRM_DELTA_PX,
  wheelGestureConfirmWindowMs = HISTORY_WHEEL_GESTURE_CONFIRM_WINDOW_MS,
  wheelGestureConfirmVelocity = HISTORY_WHEEL_GESTURE_CONFIRM_PX_PER_S,
  burstConfirmVelocity = HISTORY_SCROLL_SEEK_BURST_CONFIRM_SAMPLE_PX,
  machineCooldownMs = HISTORY_MACHINE_SCROLL_COOLDOWN_MS,
} = {}) {
  let wheelBurstUntil = 0;
  let wheelGestureUntil = 0;
  let wheelGestureWindowStartedAt = null;
  let wheelGestureWindowDelta = 0;
  let machineScrollCooldownUntil = 0;
  let scroller = null;
  let ownerToken = null;
  let kickTimer = null;
  let active = false;
  let enteredAt = 0;
  let wheelCredits = [];
  let inputKind = null;
  let inputDirection = 0;
  let inputAt = -Infinity;
  let directActive = false;
  let rejectedSamples = 0;
  let lastGeometryChange = null;

  const resetInput = () => {
    wheelCredits = [];
    inputKind = null;
    inputDirection = 0;
    inputAt = -Infinity;
    directActive = false;
    rejectedSamples = 0;
    lastGeometryChange = null;
    wheelBurstUntil = 0;
    wheelGestureUntil = 0;
    wheelGestureWindowStartedAt = null;
    wheelGestureWindowDelta = 0;
  };

  const sampleUserMotion = (velocity) => {
    const currentNow = now();
    wheelCredits = wheelCredits.filter((credit) => currentNow - credit.at <= wheelGestureHoldMs);
    const raw = Number.isFinite(velocity) ? velocity : 0;
    const fresh = directActive || currentNow - inputAt <= wheelGestureHoldMs;
    const directionMatches = inputDirection === 0 || Math.sign(raw) === inputDirection;
    const creditBefore = wheelCredits.reduce((sum, credit) => sum + credit.remaining, 0);
    let allowed = 0;
    if (fresh && directionMatches && inputKind) {
      allowed = inputKind === 'wheel' ? Math.min(Math.abs(raw), creditBefore) : Math.abs(raw);
    }
    // One input pixel may corroborate at most one velocity sample. Otherwise
    // a real fast packet would authorize any later resize echo until expiry.
    if (inputKind === 'wheel') {
      let consume = allowed;
      for (const credit of wheelCredits) {
        const amount = Math.min(credit.remaining, consume);
        credit.remaining -= amount;
        consume -= amount;
        if (consume <= 0) break;
      }
    }
    return {
      userDelta: Math.sign(raw) * allowed,
      inputKind: inputKind || 'none',
      inputDirection,
      inputAgeMs: Number.isFinite(inputAt) ? currentNow - inputAt : null,
      wheelCreditPx: creditBefore,
      reason: !fresh || !inputKind ? 'no-current-input'
        : !directionMatches ? 'opposite-to-input'
          : allowed < Math.abs(raw) ? 'beyond-wheel-input' : 'user-motion',
    };
  };

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
  };

  const scheduleKick = () => {
    cancelKick();
    const currentNow = now();
    const wait = Math.max(
      minHoldMs,
      wheelBurstUntil - currentNow,
      wheelGestureUntil - currentNow,
    ) + 60;
    kickTimer = setTimer(() => {
      kickTimer = null;
      if (!active) return;
      if (now() < wheelBurstUntil || now() < wheelGestureUntil) {
        scheduleKick();
        return;
      }
      if (isSuppressed()) {
        notifyExit('suppressed');
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
      if (isSuppressed()) {
        if (active) notifyExit('suppressed', velocity);
        return false;
      }
      if (now() < machineScrollCooldownUntil) return false;
      const burst = now() < wheelBurstUntil;
      const wheelGesture = now() < wheelGestureUntil;
      const threshold = burst ? burstConfirmVelocity : enterVelocity;
      // A scroll event is not proof of user input. Virtuoso's resize
      // compensation also feeds this sample (+4993 during an upward wheel in
      // production). Require BOTH actual movement and matching unspent input;
      // wheel packets alone still cannot turn readable movement into seek.
      const motion = sampleUserMotion(velocity);
      const shouldEnter = Math.abs(motion.userDelta) > threshold;
      if (!shouldEnter && Math.abs(velocity) > threshold && rejectedSamples < MAX_REJECT_LOGS_PER_GESTURE) {
        rejectedSamples += 1;
        onRejectedSample({ velocity, threshold, ...motion,
          geometry: lastGeometryChange ? { ...lastGeometryChange, ageMs: now() - lastGeometryChange.at } : null });
      }
      if (shouldEnter && !active) {
        active = true;
        enteredAt = now();
        onTransition({ kind: 'enter', velocity, burst, wheelGesture, ...motion });
        scheduleKick();
      }
      return shouldEnter;
    },
    exit: (velocity) => {
      if (isSuppressed()) {
        if (active) notifyExit('suppressed', velocity);
        return true;
      }
      const motion = sampleUserMotion(velocity);
      if (now() < wheelBurstUntil || now() < wheelGestureUntil) {
        scheduleKick();
        return false;
      }
      if (Math.abs(motion.userDelta) >= exitVelocity) return false;
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
    armWheelGesture(deltaY, eventTimeMs) {
      const delta = Number(deltaY) || 0;
      const receivedNow = now();
      if (!Number.isFinite(delta) || delta === 0) return false;
      if (receivedNow - inputAt > wheelGestureHoldMs) rejectedSamples = 0;
      if (inputKind !== 'wheel' || inputDirection !== Math.sign(delta)) wheelCredits = [];
      inputKind = 'wheel';
      inputDirection = Math.sign(delta);
      inputAt = receivedNow;
      directActive = false;
      wheelCredits = wheelCredits.filter((credit) => receivedNow - credit.at <= wheelGestureHoldMs);
      wheelCredits.push({ at: receivedNow, remaining: Math.abs(delta) });
      if (wheelCredits.length > MAX_WHEEL_CREDITS) wheelCredits.shift();
      const suppliedEventTime = Number(eventTimeMs);
      const currentNow = Number.isFinite(suppliedEventTime)
        ? suppliedEventTime
        : receivedNow;
      if (delta >= 0) {
        wheelGestureWindowStartedAt = null;
        wheelGestureWindowDelta = 0;
        wheelGestureUntil = 0;
        return false;
      }
      if (
        wheelGestureWindowStartedAt === null
        || currentNow - wheelGestureWindowStartedAt > wheelGestureConfirmWindowMs
      ) {
        wheelGestureWindowStartedAt = currentNow;
        wheelGestureWindowDelta = 0;
      }
      wheelGestureWindowDelta += Math.abs(delta);
      if (wheelGestureWindowDelta < wheelGestureConfirmDeltaPx) return false;
      const elapsedMs = currentNow - wheelGestureWindowStartedAt;
      const packetVelocity = elapsedMs > 0
        ? wheelGestureWindowDelta * 1000 / elapsedMs
        : 0;
      if (packetVelocity < wheelGestureConfirmVelocity) return false;
      wheelGestureUntil = receivedNow + wheelGestureHoldMs;
      if (active) scheduleKick();
      return true;
    },
    beginDirectScroll(kind, direction = 0) {
      resetInput();
      inputKind = kind;
      inputDirection = Math.sign(direction);
      inputAt = now();
      directActive = true;
    },
    endDirectScroll(kind) {
      if (inputKind !== kind || !directActive) return;
      directActive = false;
      inputAt = now();
    },
    armKeyScroll(direction) {
      resetInput();
      inputKind = 'keyboard';
      inputDirection = Math.sign(direction);
      inputAt = now();
    },
    noteGeometryChange(change) {
      // Diagnostic only: an arbitrary size delta is NOT a proven scroll
      // correction, so it must never be subtracted from the motion sample.
      lastGeometryChange = { ...change, at: now() };
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
        resetInput();
        return;
      }
      ownerToken = nextOwnerToken;
      resetInput();
      machineScrollCooldownUntil = 0;
      enteredAt = 0;
    },
    isActive: () => active,
    dispose() {
      cancelKick();
      active = false;
      scroller = null;
      ownerToken = null;
      resetInput();
    },
  };
}
