'use strict';

/**
 * Wait until a newly committed headless-terminal frame satisfies a semantic
 * predicate. The subscription is installed before `trigger` mutates the PTY,
 * so a second frame cannot be lost between two one-shot edge waiters.
 *
 * The timeout only terminates unresolved observation. It never authorizes an
 * action: success requires a newer parsed+flushed committed frame accepted by
 * the caller's semantic predicate.
 */
function waitForCommittedSemanticFrame({
  subscribe,
  readSnapshot,
  inspectSnapshot = (snapshot) => snapshot,
  acceptInspection = () => true,
  trigger = null,
  getAbortReason = null,
  afterWriteSeq = null,
  timeoutMs = 1500,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof subscribe !== 'function' || typeof readSnapshot !== 'function') {
    return Promise.resolve({
      ready: false,
      timedOut: false,
      reason: 'semantic-frame-subscription-unavailable',
      observedFrames: 0,
    });
  }

  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = null;
    let timer = null;
    let lastWriteSeq = Number.isFinite(Number(afterWriteSeq))
      ? Number(afterWriteSeq)
      : null;
    let lastSnapshot = null;
    let lastInspection = null;
    let observedFrames = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
        else unsubscribe?.dispose?.();
      } catch {}
      resolve({
        ...result,
        observedFrames,
        lastSnapshot,
        lastInspection,
        elapsedMs: Math.max(0, now() - startedAt),
      });
    };

    const check = () => {
      if (settled) return;

      if (typeof getAbortReason === 'function') {
        let abortReason = null;
        try {
          abortReason = getAbortReason();
        } catch (error) {
          finish({
            ready: false,
            timedOut: false,
            reason: 'semantic-frame-identity-check-failed',
            error: error?.message || String(error),
          });
          return;
        }
        if (abortReason) {
          finish({ ready: false, timedOut: false, reason: String(abortReason) });
          return;
        }
      }

      let snapshot;
      try {
        snapshot = readSnapshot();
      } catch (error) {
        finish({
          ready: false,
          timedOut: false,
          reason: 'semantic-frame-read-failed',
          error: error?.message || String(error),
        });
        return;
      }

      const writeSeq = Number(snapshot?.writeSeq);
      if (
        snapshot?.success !== true
        || snapshot.authoritativeFrameCommitted !== true
        || !Number.isFinite(writeSeq)
        || Number(snapshot.flushedSeq) !== writeSeq
        || (lastWriteSeq !== null && writeSeq <= lastWriteSeq)
      ) {
        return;
      }

      lastWriteSeq = writeSeq;
      lastSnapshot = snapshot;
      observedFrames += 1;

      try {
        lastInspection = inspectSnapshot(snapshot);
        if (acceptInspection(lastInspection, snapshot) === true) {
          finish({
            ready: true,
            timedOut: false,
            reason: 'semantic-frame-proven',
            snapshot,
            inspection: lastInspection,
            writeSeq,
          });
        }
      } catch (error) {
        finish({
          ready: false,
          timedOut: false,
          reason: 'semantic-frame-inspection-failed',
          error: error?.message || String(error),
        });
      }
    };

    try {
      unsubscribe = subscribe(check);
    } catch (error) {
      finish({
        ready: false,
        timedOut: false,
        reason: 'semantic-frame-subscription-failed',
        error: error?.message || String(error),
      });
      return;
    }

    timer = setTimer(() => finish({
      ready: false,
      timedOut: true,
      reason: 'semantic-frame-timeout',
    }), Math.max(50, Number(timeoutMs) || 1500));

    try {
      if (typeof trigger === 'function') trigger();
    } catch (error) {
      finish({
        ready: false,
        timedOut: false,
        reason: 'semantic-frame-trigger-failed',
        error: error?.message || String(error),
      });
      return;
    }

    // Covers a frame which committed between the caller's initial read and
    // installation of this observer. The sequence gate rejects the old frame.
    check();
  });
}

module.exports = {
  waitForCommittedSemanticFrame,
};
