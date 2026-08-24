export function scheduleHistoryBottomScroll({
  virtuoso,
  itemCount,
  getScroller,
  getOwnerToken,
  smooth = false,
  requestFrame = globalThis.requestAnimationFrame,
}) {
  // Capture the physical reader and its logical owner in the task that asked
  // for the scroll. HistoryPanel survives tab switches, while Virtuoso remounts
  // its scroller; asking getScroller() two frames later without this snapshot
  // lets an operation armed by A write into the newly mounted B.
  const scheduledScroller = getScroller();
  const scheduledOwnerToken = getOwnerToken?.();
  if (virtuoso && itemCount > 0) {
    virtuoso.scrollToIndex({
      index: itemCount - 1,
      align: 'end',
      behavior: 'auto',
    });
  }

  requestFrame(() => {
    requestFrame(() => {
      if (getOwnerToken && getOwnerToken() !== scheduledOwnerToken) return;
      const scroller = getScroller();
      if (!scroller) return;
      if (scheduledScroller && scroller !== scheduledScroller) return;
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    });
  });
}

export const HISTORY_TAIL_PIN_THRESHOLD_PX = 4;
// A send changes geometry in several commits: optimistic row, cleared
// composer, then the measured/canonical row. Keep the transaction alive long
// enough to observe those commits at both 60Hz and high-refresh displays, but
// always bound it; a real user gesture cancels it synchronously.
export const HISTORY_TAIL_MUTATION_MIN_SETTLE_FRAMES = 12;
export const HISTORY_TAIL_MUTATION_MAX_SETTLE_FRAMES = 48;
export const HISTORY_TAIL_MUTATION_REQUIRED_STABLE_FRAMES = 3;

export function isHistoryTailPinned(
  scroller,
  thresholdPx = HISTORY_TAIL_PIN_THRESHOLD_PX,
) {
  if (!scroller) return false;
  const threshold = Math.max(0, Number(thresholdPx) || 0);
  const distance = Number(scroller.scrollHeight || 0)
    - (Number(scroller.scrollTop || 0) + Number(scroller.clientHeight || 0));
  return distance <= threshold;
}

/**
 * Content growth can move the physical bottom away from a tail-pinned reader
 * before the follow scroll runs. That geometry change is not user intent.
 * Only an explicit upward/drag gesture may turn following off. Physical
 * bottom alone cannot turn it back on: immediately after a group is unpinned
 * the old layout is still physically at its old bottom for one commit, and
 * treating that geometry as intent re-pins the expansion to the new bottom.
 * Re-enabling requires a real downward gesture (or an explicit bottom command
 * whose caller sets currentIntent=true).
 */
export function reconcileHistoryTailFollowIntent({
  currentIntent,
  physicalPinned,
  userMovedAway = false,
  userReachedBottom = false,
}) {
  if (userMovedAway) return false;
  if (currentIntent === true) return true;
  return physicalPinned && userReachedBottom;
}

export function createHistoryTailPinScheduler({
  getScroller,
  getOwnerToken,
  requestFrame = globalThis.requestAnimationFrame,
}) {
  let generation = 0;
  let pending = false;
  let pendingTarget = null;
  let pendingTask = null;

  const cancel = () => {
    if (!pending) return false;
    generation += 1;
    pending = false;
    pendingTarget = null;
    pendingTask = null;
    return true;
  };

  const schedule = ({
    shouldPin = true,
    smooth = false,
    delayFrames = 1,
    settleUntilStable = false,
    minimumSettleFrames = 1,
    maximumSettleFrames = 1,
    requiredStableFrames = 1,
    onApplied,
  } = {}) => {
    if (!shouldPin) return false;
    const target = {
      scroller: getScroller(),
      ownerToken: getOwnerToken?.(),
    };
    const normalizedMinimumFrames = Math.max(
      1,
      Math.round(Number(minimumSettleFrames) || 1),
    );
    const normalizedMaximumFrames = Math.max(
      normalizedMinimumFrames,
      Math.round(Number(maximumSettleFrames) || normalizedMinimumFrames),
    );
    const normalizedStableFrames = Math.max(
      1,
      Math.round(Number(requiredStableFrames) || 1),
    );
    if (pending) {
      const sameTarget = pendingTarget?.scroller === target.scroller
        && pendingTarget?.ownerToken === target.ownerToken;
      if (sameTarget) {
        // A second mutation may land while the first settling loop is still
        // alive (optimistic prompt → composer collapse → durable adoption).
        // Keep one physical writer, but restart its stability proof from the
        // newest geometry instead of letting the older proof finish early.
        if (settleUntilStable && pendingTask) {
          pendingTask.settleUntilStable = true;
          pendingTask.smooth = false;
          pendingTask.appliedFrames = 0;
          pendingTask.stableFrames = 0;
          pendingTask.lastScrollHeight = null;
          pendingTask.lastClientHeight = null;
          pendingTask.minimumSettleFrames = normalizedMinimumFrames;
          pendingTask.maximumSettleFrames = normalizedMaximumFrames;
          pendingTask.requiredStableFrames = normalizedStableFrames;
          if (typeof onApplied === 'function') pendingTask.onApplied = onApplied;
        }
        return false;
      }
      // A new mounted owner supersedes the old pending task. The generation
      // guard invalidates the already queued callback without touching either
      // scroller.
      generation += 1;
    }
    pending = true;
    pendingTarget = target;
    const scheduledGeneration = ++generation;
    const frames = Math.max(1, Math.round(Number(delayFrames) || 1));
    const task = {
      settleUntilStable: settleUntilStable === true,
      smooth: smooth === true,
      appliedFrames: 0,
      totalAppliedFrames: 0,
      stableFrames: 0,
      lastScrollHeight: null,
      lastClientHeight: null,
      minimumSettleFrames: normalizedMinimumFrames,
      maximumSettleFrames: normalizedMaximumFrames,
      requiredStableFrames: normalizedStableFrames,
      onApplied,
    };
    pendingTask = task;

    const finish = (scroller, settled) => {
      if (!pending || generation !== scheduledGeneration || pendingTask !== task) return;
      pending = false;
      pendingTarget = null;
      pendingTask = null;
      const distancePx = Number(scroller.scrollHeight || 0)
        - (Number(scroller.scrollTop || 0) + Number(scroller.clientHeight || 0));
      task.onApplied?.(scroller, {
        frames: task.totalAppliedFrames,
        settled,
        distancePx,
      });
    };

    const step = (remaining) => requestFrame(() => {
      if (!pending || generation !== scheduledGeneration || pendingTask !== task) return;
      if (remaining > 1) {
        step(remaining - 1);
        return;
      }
      if (getOwnerToken && getOwnerToken() !== target.ownerToken) {
        cancel();
        return;
      }
      const scroller = getScroller();
      if (!scroller || (target.scroller && scroller !== target.scroller)) {
        cancel();
        return;
      }
      const scrollHeight = Number(scroller.scrollHeight || 0);
      const clientHeight = Number(scroller.clientHeight || 0);
      const sameGeometry = task.lastScrollHeight === scrollHeight
        && task.lastClientHeight === clientHeight;
      const pinnedBeforeWrite = isHistoryTailPinned(scroller);
      if (!task.settleUntilStable || !pinnedBeforeWrite) {
        scroller.scrollTo({
          top: scrollHeight,
          // A settling transaction must be exact on each frame. Repeated smooth
          // animations would become another competing scroll owner.
          behavior: task.smooth && !task.settleUntilStable ? 'smooth' : 'auto',
        });
      }
      task.appliedFrames += 1;
      task.totalAppliedFrames += 1;
      const pinned = isHistoryTailPinned(scroller);
      task.stableFrames = sameGeometry && pinned
        ? task.stableFrames + 1
        : pinned ? 1 : 0;
      task.lastScrollHeight = scrollHeight;
      task.lastClientHeight = clientHeight;

      if (!task.settleUntilStable) {
        finish(scroller, pinned);
        return;
      }
      const stable = task.appliedFrames >= task.minimumSettleFrames
        && task.stableFrames >= task.requiredStableFrames;
      const exhausted = task.appliedFrames >= task.maximumSettleFrames;
      if (stable || exhausted) {
        finish(scroller, stable && pinned);
        return;
      }
      step(1);
    });
    step(frames);
    return true;
  };

  return {
    schedule,
    cancel,
    isPending: () => pending,
  };
}
