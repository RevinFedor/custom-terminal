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

  const cancel = () => {
    if (!pending) return false;
    generation += 1;
    pending = false;
    pendingTarget = null;
    return true;
  };

  const schedule = ({
    shouldPin = true,
    smooth = false,
    delayFrames = 1,
    onApplied,
  } = {}) => {
    if (!shouldPin) return false;
    const target = {
      scroller: getScroller(),
      ownerToken: getOwnerToken?.(),
    };
    if (pending) {
      const sameTarget = pendingTarget?.scroller === target.scroller
        && pendingTarget?.ownerToken === target.ownerToken;
      if (sameTarget) return false;
      // A new mounted owner supersedes the old pending task. The generation
      // guard invalidates the already queued callback without touching either
      // scroller.
      generation += 1;
    }
    pending = true;
    pendingTarget = target;
    const scheduledGeneration = ++generation;
    const frames = Math.max(1, Math.round(Number(delayFrames) || 1));

    const step = (remaining) => requestFrame(() => {
      if (!pending || generation !== scheduledGeneration) return;
      if (remaining > 1) {
        step(remaining - 1);
        return;
      }
      pending = false;
      pendingTarget = null;
      if (getOwnerToken && getOwnerToken() !== target.ownerToken) return;
      const scroller = getScroller();
      if (!scroller) return;
      if (target.scroller && scroller !== target.scroller) return;
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
      onApplied?.(scroller);
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
