'use strict';

/**
 * Coalesces process-tree captures without weakening force-fresh semantics.
 *
 * Normal callers join whichever capture is already running. A force-fresh
 * caller may join an already fresh capture, but never reuses an older normal
 * capture: it waits for that work to settle and then starts (or joins) one
 * trailing fresh capture.
 */
function createProcessTreeSnapshotSingleFlight({
  capture,
  now = Date.now,
} = {}) {
  if (typeof capture !== 'function') {
    throw new TypeError('capture must be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  let inflight = null;
  let generation = 0;

  function startCapture(forceFresh) {
    const entry = {
      forceFresh,
      generation,
      waiters: 0,
      promise: null,
    };

    // Publish ownership before capture() can execute. The Promise hop also
    // protects against a synchronously resolving/throwing capture function.
    inflight = entry;
    entry.promise = Promise.resolve()
      .then(() => capture({
        forceFresh,
        getWaiterCount: () => entry.waiters,
        generation: entry.generation,
        isCurrent: () => generation === entry.generation,
      }))
      .finally(() => {
        if (inflight === entry) inflight = null;
      });

    return entry;
  }

  async function get({ forceFresh = false } = {}) {
    while (true) {
      const active = inflight;
      if (!active) {
        const owner = startCapture(forceFresh);
        const value = await owner.promise;
        return {
          value,
          source: forceFresh ? 'force-fresh' : 'spawn',
          waitMs: 0,
          waiters: owner.waiters,
        };
      }

      // A destructive lifecycle boundary (for example, a proven Stop) may
      // invalidate a ps capture that started while the old process still
      // existed. Callers that arrive after that boundary must wait for the old
      // OS command to settle and then form one new capture wave; joining the
      // old promise would resurrect the stopped process for the cache TTL.
      if (active.generation !== generation) {
        try {
          await active.promise;
        } catch {
          // The invalidated observation belongs to the old generation either
          // way. Its result/error must not be inherited by a new caller.
        }
        continue;
      }

      // A normal capture may have started before the destructive caller's
      // lifecycle boundary. Let it settle, then form one shared trailing
      // fresh wave for every force-fresh caller waiting here.
      if (forceFresh && !active.forceFresh) {
        try {
          await active.promise;
        } catch {
          // The failed normal observation proves nothing. A fresh caller still
          // gets its own new attempt rather than inheriting that failure.
        }
        continue;
      }

      active.waiters += 1;
      const waitStartedAt = now();
      const value = await active.promise;
      return {
        value,
        source: active.forceFresh ? 'inflight-force-fresh' : 'inflight',
        waitMs: Math.max(0, now() - waitStartedAt),
        waiters: active.waiters,
      };
    }
  }

  return {
    get,
    invalidate() {
      generation += 1;
      return generation;
    },
    snapshot() {
      if (!inflight) return null;
      return {
        forceFresh: inflight.forceFresh,
        waiters: inflight.waiters,
      };
    },
  };
}

module.exports = {
  createProcessTreeSnapshotSingleFlight,
};
