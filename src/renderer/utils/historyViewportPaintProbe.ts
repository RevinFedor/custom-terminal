export interface HistoryViewportPaintOwner {
  key: string;
  generation: number;
}

export interface HistoryViewportPaintProbe {
  start(
    owner: HistoryViewportPaintOwner,
    hasMountedRow: () => boolean,
    publishReady: () => void,
  ): boolean;
  isActive(owner: HistoryViewportPaintOwner): boolean;
  cancel(owner?: HistoryViewportPaintOwner): void;
}

interface HistoryViewportPaintProbeScheduler {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
}

const sameOwner = (
  left: HistoryViewportPaintOwner | null,
  right: HistoryViewportPaintOwner,
) => left?.key === right.key && left.generation === right.generation;

/**
 * Waits until Virtuoso has committed a real row and keeps the cold loader
 * through one additional paint. There is at most one scheduled frame.
 *
 * The probe owns a generation independent from React. Cancelling on unmount or
 * owner handoff invalidates callbacks that were already dequeued by the
 * browser, while cancelAnimationFrame removes the one callback still queued.
 */
export const createHistoryViewportPaintProbe = ({
  requestFrame,
  cancelFrame,
}: HistoryViewportPaintProbeScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
}): HistoryViewportPaintProbe => {
  let activeOwner: HistoryViewportPaintOwner | null = null;
  let probeGeneration = 0;
  let scheduledFrame: number | null = null;

  const cancel = (owner?: HistoryViewportPaintOwner) => {
    if (owner && !sameOwner(activeOwner, owner)) return;
    probeGeneration += 1;
    activeOwner = null;
    if (scheduledFrame !== null) {
      cancelFrame(scheduledFrame);
      scheduledFrame = null;
    }
  };

  const start = (
    owner: HistoryViewportPaintOwner,
    hasMountedRow: () => boolean,
    publishReady: () => void,
  ) => {
    if (sameOwner(activeOwner, owner)) return false;
    cancel();
    activeOwner = owner;
    const ownProbeGeneration = probeGeneration;

    const stillOwnsProbe = () =>
      probeGeneration === ownProbeGeneration && sameOwner(activeOwner, owner);

    const publishAfterPaint = () => {
      scheduledFrame = null;
      if (!stillOwnsProbe()) return;
      // A row from the previous virtualized owner can survive for one frame
      // while React swaps the list. It is not presentation proof for the new
      // owner, and it may disappear before this post-paint callback. Require
      // the caller's owner-specific predicate to remain true across the paint
      // boundary before hiding the loader.
      if (!hasMountedRow()) {
        scheduledFrame = requestFrame(waitForMountedRow);
        return;
      }
      activeOwner = null;
      publishReady();
    };

    const waitForMountedRow = () => {
      scheduledFrame = null;
      if (!stillOwnsProbe()) return;
      if (!hasMountedRow()) {
        scheduledFrame = requestFrame(waitForMountedRow);
        return;
      }
      scheduledFrame = requestFrame(publishAfterPaint);
    };

    scheduledFrame = requestFrame(waitForMountedRow);
    return true;
  };

  return {
    start,
    isActive: (owner) => sameOwner(activeOwner, owner),
    cancel,
  };
};
