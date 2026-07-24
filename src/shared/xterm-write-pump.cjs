'use strict';

function defaultCanCoalesce(previousMeta, nextMeta) {
  if (!previousMeta || !nextMeta) return true;
  const previousGeneration = previousMeta.generation ?? null;
  const nextGeneration = nextMeta.generation ?? null;
  const previousOrdinal = Number.isFinite(previousMeta.generationOrdinal)
    ? Number(previousMeta.generationOrdinal)
    : null;
  const nextOrdinal = Number.isFinite(nextMeta.generationOrdinal)
    ? Number(nextMeta.generationOrdinal)
    : null;
  return previousGeneration === nextGeneration && previousOrdinal === nextOrdinal;
}

/**
 * Keep xterm's internal queue bounded without inspecting or splitting ANSI.
 *
 * xterm already preserves byte order inside one write. Feeding every node-pty
 * chunk as a separate write creates one callback/queue entry per chunk and can
 * leave a hidden terminal minutes behind a busy TUI. This pump allows exactly
 * one physical write in flight and joins only the untouched tail. Generation
 * boundaries stay separate, so a recreated PTY can never be merged into the
 * previous terminal stream.
 */
function createXtermWritePump(write, options = {}) {
  if (typeof write !== 'function') {
    throw new TypeError('createXtermWritePump requires a write(data, callback) function');
  }

  const canCoalesce = typeof options.canCoalesce === 'function'
    ? options.canCoalesce
    : defaultCanCoalesce;
  const onFlushed = typeof options.onFlushed === 'function'
    ? options.onFlushed
    : () => {};
  const onError = typeof options.onError === 'function'
    ? options.onError
    : () => {};

  let inFlight = null;
  let queued = [];
  let disposed = false;
  let failed = null;
  let drainWaiters = [];

  const snapshot = () => ({
    disposed,
    failed: failed ? String(failed?.message || failed) : null,
    inFlight: !!inFlight,
    inFlightChars: inFlight?.chars || 0,
    inFlightItems: inFlight?.items || 0,
    queuedBatches: queued.length,
    queuedChars: queued.reduce((sum, batch) => sum + batch.chars, 0),
    queuedItems: queued.reduce((sum, batch) => sum + batch.items, 0),
    latestMeta: queued.at(-1)?.meta || inFlight?.meta || null,
  });

  const settleDrainWaiters = () => {
    if (inFlight || queued.length > 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    const state = snapshot();
    for (const resolve of waiters) resolve(state);
  };

  const fail = (error) => {
    failed = error instanceof Error ? error : new Error(String(error));
    queued = [];
    inFlight = null;
    try { onError(failed); } catch {}
    settleDrainWaiters();
  };

  const dispatch = (batch) => {
    if (disposed || failed) {
      settleDrainWaiters();
      return;
    }
    inFlight = batch;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      if (inFlight !== batch) return;
      inFlight = null;
      try {
        onFlushed(batch.meta, {
          chars: batch.chars,
          items: batch.items,
          queuedAt: batch.queuedAt,
        });
      } catch (error) {
        fail(error);
        return;
      }
      const next = queued.shift() || null;
      if (next) dispatch(next);
      else settleDrainWaiters();
    };

    try {
      write(batch.chunks.length === 1 ? batch.chunks[0] : batch.chunks.join(''), complete);
    } catch (error) {
      fail(error);
    }
  };

  const push = (data, meta = null) => {
    if (disposed || failed) return false;
    const text = typeof data === 'string' ? data : String(data ?? '');
    if (!text) return true;
    const batch = {
      chunks: [text],
      chars: text.length,
      meta,
      items: 1,
      queuedAt: Date.now(),
    };

    if (!inFlight && queued.length === 0) {
      dispatch(batch);
      return true;
    }

    const tail = queued.at(-1);
    if (tail && canCoalesce(tail.meta, meta)) {
      tail.chunks.push(text);
      tail.chars += text.length;
      if (meta !== null && meta !== undefined) tail.meta = meta;
      tail.items += 1;
    } else {
      queued.push(batch);
    }
    return true;
  };

  const drain = () => {
    if (!inFlight && queued.length === 0) return Promise.resolve(snapshot());
    return new Promise((resolve) => {
      drainWaiters.push(resolve);
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    queued = [];
    inFlight = null;
    settleDrainWaiters();
  };

  return {
    push,
    drain,
    dispose,
    getStatus: snapshot,
  };
}

module.exports = {
  createXtermWritePump,
  defaultCanCoalesce,
};
