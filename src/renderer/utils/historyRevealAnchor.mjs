/**
 * Keep one already-visible semantic row at the same viewport coordinate while
 * a reveal grows content below it. React can commit synchronously, but
 * Virtuoso may apply a second compensation on a later frame; convergence owns
 * both without timers or synthetic empty space.
 */
export function stabilizeHistoryRevealAnchor({
  targetTop,
  readAnchorTop,
  adjustScrollBy,
  subscribePositionChange,
  isCurrent = () => true,
  hasUserGesture = () => false,
  requestFrame = globalThis.requestAnimationFrame,
  // Virtuoso's second measured-size pass was observed after ~200ms, well
  // after two apparently stable frames. Keep cheap read-only ownership for a
  // bounded 20-frame window; a real gesture still cancels on its next frame.
  minimumFrames = 20,
  maxFrames = 30,
  stableFramesRequired = 3,
  epsilonPx = 0.5,
  onFinish,
} = {}) {
  const desiredTop = Number(targetTop);
  if (!Number.isFinite(desiredTop)) {
    onFinish?.({
      reason: 'invalid-target',
      frames: 0,
      writes: 0,
      maxDriftPx: 0,
      positionSignals: 0,
    });
    return () => {};
  }

  let cancelled = false;
  let finished = false;
  let frames = 0;
  let writes = 0;
  let stableFrames = 0;
  let maxDriftPx = 0;
  let positionSignals = 0;
  let correctingPosition = false;
  let unsubscribePositionChange = () => {};

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    unsubscribePositionChange();
    unsubscribePositionChange = () => {};
    onFinish?.({ reason, frames, writes, maxDriftPx, positionSignals });
  };

  const correct = (source, countStableFrame) => {
    if (cancelled) { finish('cancelled'); return; }
    if (!isCurrent()) { finish('stale-owner'); return; }
    if (hasUserGesture()) { finish('user-gesture'); return; }
    if (correctingPosition) return;

    const rawTop = readAnchorTop();
    const currentTop = rawTop === null || rawTop === undefined
      ? Number.NaN
      : Number(rawTop);
    if (!Number.isFinite(currentTop)) {
      if (countStableFrame) stableFrames = 0;
      return;
    }

    const drift = currentTop - desiredTop;
    maxDriftPx = Math.max(maxDriftPx, Math.abs(drift));
    if (Math.abs(drift) > epsilonPx) {
      correctingPosition = true;
      try {
        // A position signal (normally the scroller's capture-phase `scroll`)
        // runs before paint. Correcting here prevents a late Virtuoso size
        // compensation from becoming one visible bad frame; the rAF loop
        // remains the fallback for position drift that emits no scroll event.
        adjustScrollBy(drift, source);
      } finally {
        correctingPosition = false;
      }
      writes += 1;
      stableFrames = 0;
    } else if (countStableFrame) {
      stableFrames += 1;
    }
  };

  if (typeof subscribePositionChange === 'function') {
    const unsubscribe = subscribePositionChange(() => {
      if (finished || cancelled || correctingPosition) return;
      positionSignals += 1;
      correct('position-signal', false);
    });
    if (typeof unsubscribe === 'function') {
      if (finished) unsubscribe();
      else unsubscribePositionChange = unsubscribe;
    }
  }

  const step = () => {
    frames += 1;
    correct('frame', true);
    if (finished) return;

    if (frames >= minimumFrames && stableFrames >= stableFramesRequired) {
      finish('settled');
      return;
    }
    if (frames >= maxFrames) { finish('max-frames'); return; }
    requestFrame(step);
  };

  // First correction runs in the click task after flushSync, before paint.
  step();
  return () => {
    cancelled = true;
    finish('cancelled');
  };
}
