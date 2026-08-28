export function findHistoryUnitIndexByKey(keys, identity) {
  if (!Array.isArray(keys) || typeof identity !== 'string' || identity.length === 0) return -1;
  return keys.indexOf(identity);
}

/**
 * A materialized-window refresh has one position owner. Tail readers stay
 * owned by the bottom pin; mid-list readers use a semantic row. Starting both
 * transactions makes the semantic release undo the already-correct tail pin.
 */
export function chooseHistoryMaterializedApplyOwner({
  followBottom,
  tailPinPending,
} = {}) {
  return followBottom === true || tailPinPending === true
    ? 'tail-pin'
    : 'semantic-row';
}

/**
 * A semantic row top cannot remain fixed when content at/below that row
 * shrinks by more than the user's current distance from the physical tail.
 * In that one boundary case the honest invariant is the user's tail gap; no
 * synthetic second bottom is introduced.
 */
export function chooseHistoryGestureReleaseAnchorMode({
  bottomGapPx,
  trailingHeightDeltaPx,
  measuredRows,
  epsilonPx = 0.5,
} = {}) {
  const gap = Number(bottomGapPx);
  const trailingDelta = Number(trailingHeightDeltaPx);
  const rows = Number(measuredRows);
  const epsilon = Number(epsilonPx);
  if (
    !Number.isFinite(gap)
    || !Number.isFinite(trailingDelta)
    || !Number.isFinite(rows)
    || rows <= 0
  ) {
    return 'semantic-row';
  }
  return trailingDelta < -(Math.max(0, gap) + (Number.isFinite(epsilon) ? epsilon : 0.5))
    ? 'tail-gap'
    : 'semantic-row';
}

/**
 * Keep the already presented semantic row visually fixed while a virtualizer
 * replaces estimated heights with measured heights. Corrections are applied
 * to a presentation-only layer before paint; once geometry is quiet, the
 * caller atomically transfers the remaining offset to the real scroll owner.
 */
export function settleHistoryVisualAnchor({
  targetTop,
  readVisualTop,
  setVisualOffset,
  commitVisualOffset,
  canCommitVisualOffset = () => true,
  subscribeGeometryChange,
  isCurrent = () => true,
  isPaused = () => false,
  hasUserGesture = () => false,
  requestFrame = globalThis.requestAnimationFrame,
  minimumObservationFrames = 12,
  quietFramesRequired = 4,
  maxFrames = 120,
  epsilonPx = 0.5,
  onFinish,
} = {}) {
  const desiredTop = Number(targetTop);
  if (!Number.isFinite(desiredTop)) {
    onFinish?.({
      reason: 'invalid-target',
      frames: 0,
      writes: 0,
      corrections: 0,
      maxDriftPx: 0,
      positionSignals: 0,
      pausedFrames: 0,
      visualOffsetPx: 0,
    });
    return () => {};
  }

  let cancelled = false;
  let finished = false;
  let frames = 0;
  let activeFrames = 0;
  let pausedFrames = 0;
  let quietFrames = 0;
  let writes = 0;
  let corrections = 0;
  let maxDriftPx = 0;
  let positionSignals = 0;
  let visualOffsetPx = 0;
  let unsubscribeGeometryChange = () => {};

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    unsubscribeGeometryChange();
    unsubscribeGeometryChange = () => {};
    const transferableOffsetPx = reason === 'stale-owner'
      ? 0
      : visualOffsetPx;
    commitVisualOffset?.(transferableOffsetPx, reason);
    onFinish?.({
      reason,
      frames,
      writes,
      corrections,
      maxDriftPx,
      positionSignals,
      pausedFrames,
      visualOffsetPx,
      transferableOffsetPx,
    });
  };

  const correctBeforePaint = (source) => {
    if (finished || cancelled || !isCurrent() || isPaused() || hasUserGesture()) return;
    const rawTop = readVisualTop?.();
    const currentTop = rawTop === null || rawTop === undefined
      ? Number.NaN
      : Number(rawTop);
    if (!Number.isFinite(currentTop)) {
      quietFrames = 0;
      return;
    }
    const drift = currentTop - desiredTop;
    maxDriftPx = Math.max(maxDriftPx, Math.abs(drift));
    if (Math.abs(drift) <= epsilonPx) {
      quietFrames += 1;
      return;
    }
    visualOffsetPx -= drift;
    setVisualOffset?.(visualOffsetPx, source);
    writes += 1;
    corrections += 1;
    quietFrames = 0;
  };

  if (typeof subscribeGeometryChange === 'function') {
    const unsubscribe = subscribeGeometryChange(() => {
      if (finished || cancelled) return;
      positionSignals += 1;
      quietFrames = 0;
      // ResizeObserver and MutationObserver callbacks run in the rendering
      // update before paint, so the old wrong frame never becomes visible.
      correctBeforePaint('geometry-signal');
    });
    if (typeof unsubscribe === 'function') unsubscribeGeometryChange = unsubscribe;
  }

  // The wrapper constraints were removed immediately before this call. Make
  // the first inverse correction in the same JS task, before the first paint.
  correctBeforePaint('release-sync');

  const step = () => {
    if (cancelled) { finish('cancelled'); return; }
    if (!isCurrent()) { finish('stale-owner'); return; }
    if (hasUserGesture()) { finish('user-gesture'); return; }
    frames += 1;
    if (isPaused()) {
      pausedFrames += 1;
      quietFrames = 0;
      requestFrame(step);
      return;
    }
    activeFrames += 1;
    correctBeforePaint('frame');
    if (activeFrames >= minimumObservationFrames && quietFrames >= quietFramesRequired) {
      if (canCommitVisualOffset(visualOffsetPx)) {
        finish('settled');
        return;
      }
      // The list can already look stable under the bridge while its physical
      // scroll range still reflects the old estimate. Keep the bridge until
      // the real range can absorb the exact transfer without clamping.
      quietFrames = 0;
    }
    if (activeFrames >= maxFrames) {
      finish('max-frames');
      return;
    }
    requestFrame(step);
  };

  requestFrame(step);
  return () => {
    cancelled = true;
    finish('cancelled');
  };
}

/**
 * Wait until the virtualizer has finished publishing measured sizes, then
 * perform at most a few semantic corrections between quiet generations.
 * Unlike the reveal stabilizer, position signals only reset quietness; they
 * never trigger a competing write while Virtuoso is compensating.
 */
export function settleHistoryMeasuredAnchor({
  targetTop,
  readAnchorTop,
  adjustScrollBy,
  subscribePositionChange,
  isCurrent = () => true,
  isPaused = () => false,
  hasUserGesture = () => false,
  requestFrame = globalThis.requestAnimationFrame,
  minimumObservationFrames = 18,
  minimumPostCorrectionFrames = 6,
  quietFramesRequired = 4,
  maxFrames = 120,
  maxCorrections = 3,
  epsilonPx = 0.5,
  onFinish,
} = {}) {
  const desiredTop = Number(targetTop);
  if (!Number.isFinite(desiredTop)) {
    onFinish?.({
      reason: 'invalid-target',
      frames: 0,
      writes: 0,
      corrections: 0,
      maxDriftPx: 0,
      positionSignals: 0,
    });
    return () => {};
  }

  let cancelled = false;
  let finished = false;
  let frames = 0;
  let activeFrames = 0;
  let pausedFrames = 0;
  let framesSinceCorrection = 0;
  let writes = 0;
  let corrections = 0;
  let quietFrames = 0;
  let lastTop = null;
  let maxDriftPx = 0;
  let positionSignals = 0;
  let signalGeneration = 0;
  let sampledSignalGeneration = 0;
  let correctingPosition = false;
  let unsubscribePositionChange = () => {};

  const finish = (reason) => {
    if (finished) return;
    finished = true;
    unsubscribePositionChange();
    unsubscribePositionChange = () => {};
    onFinish?.({
      reason,
      frames,
      writes,
      corrections,
      maxDriftPx,
      positionSignals,
      pausedFrames,
    });
  };

  if (typeof subscribePositionChange === 'function') {
    const unsubscribe = subscribePositionChange(() => {
      if (finished || cancelled || correctingPosition) return;
      positionSignals += 1;
      signalGeneration += 1;
      quietFrames = 0;
    });
    if (typeof unsubscribe === 'function') unsubscribePositionChange = unsubscribe;
  }

  const step = () => {
    if (cancelled) { finish('cancelled'); return; }
    if (!isCurrent()) { finish('stale-owner'); return; }
    if (hasUserGesture()) { finish('user-gesture'); return; }

    frames += 1;
    if (isPaused()) {
      pausedFrames += 1;
      quietFrames = 0;
      lastTop = null;
      requestFrame(step);
      return;
    }
    activeFrames += 1;
    framesSinceCorrection += 1;
    const rawTop = readAnchorTop();
    const currentTop = rawTop === null || rawTop === undefined
      ? Number.NaN
      : Number(rawTop);
    if (!Number.isFinite(currentTop)) {
      quietFrames = 0;
      lastTop = null;
    } else {
      const drift = currentTop - desiredTop;
      maxDriftPx = Math.max(maxDriftPx, Math.abs(drift));
      const sameSignalGeneration = sampledSignalGeneration === signalGeneration;
      if (
        lastTop !== null
        && sameSignalGeneration
        && Math.abs(currentTop - lastTop) <= epsilonPx
      ) {
        quietFrames += 1;
      } else {
        quietFrames = 0;
      }
      lastTop = currentTop;
      sampledSignalGeneration = signalGeneration;

      const minimumFrames = corrections === 0
        ? minimumObservationFrames
        : minimumPostCorrectionFrames;
      if (framesSinceCorrection >= minimumFrames && quietFrames >= quietFramesRequired) {
        if (Math.abs(drift) <= epsilonPx) {
          finish('settled');
          return;
        }
        if (corrections >= maxCorrections) {
          finish('max-corrections');
          return;
        }
        correctingPosition = true;
        try {
          adjustScrollBy(drift, 'geometry-quiet');
        } finally {
          correctingPosition = false;
        }
        writes += 1;
        corrections += 1;
        framesSinceCorrection = 0;
        quietFrames = 0;
        lastTop = null;
      }
    }

    if (activeFrames >= maxFrames) {
      finish('max-frames');
      return;
    }
    requestFrame(step);
  };

  requestFrame(step);
  return () => {
    cancelled = true;
    finish('cancelled');
  };
}

/** Pick a real semantic row near the viewport centre, not the edge. */
export function pickHistoryGestureAnchorCandidate(rows, viewportTop, viewportBottom) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const top = Number(viewportTop);
  const bottom = Number(viewportBottom);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return null;
  const target = top + (bottom - top) * 0.45;
  const eligible = rows.filter((row) => (
    row
    && typeof row.identity === 'string'
    && row.identity.length > 0
    && Number.isFinite(Number(row.top))
    && Number.isFinite(Number(row.bottom))
    && Number(row.bottom) > top
    && Number(row.top) < bottom
  ));
  if (eligible.length === 0) return null;
  const containing = eligible.find((row) => Number(row.top) <= target && Number(row.bottom) > target);
  if (containing) return containing;
  return eligible.reduce((best, row) => (
    Math.abs(Number(row.top) - target) < Math.abs(Number(best.top) - target) ? row : best
  ));
}
