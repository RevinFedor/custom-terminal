export function scheduleHistoryBottomScroll({
  virtuoso,
  itemCount,
  getScroller,
  smooth = false,
  requestFrame = globalThis.requestAnimationFrame,
}) {
  if (virtuoso && itemCount > 0) {
    virtuoso.scrollToIndex({
      index: itemCount - 1,
      align: 'end',
      behavior: 'auto',
    });
  }

  requestFrame(() => {
    requestFrame(() => {
      const scroller = getScroller();
      if (!scroller) return;
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

export function createHistoryTailPinScheduler({
  getScroller,
  requestFrame = globalThis.requestAnimationFrame,
}) {
  let generation = 0;
  let pending = false;

  const cancel = () => {
    if (!pending) return false;
    generation += 1;
    pending = false;
    return true;
  };

  const schedule = ({
    shouldPin = true,
    smooth = false,
  } = {}) => {
    if (!shouldPin || pending) return false;
    pending = true;
    const scheduledGeneration = ++generation;

    requestFrame(() => {
      if (!pending || generation !== scheduledGeneration) return;
      pending = false;
      const scroller = getScroller();
      if (!scroller) return;
      scroller.scrollTo({
        top: scroller.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    });
    return true;
  };

  return {
    schedule,
    cancel,
    isPending: () => pending,
  };
}
