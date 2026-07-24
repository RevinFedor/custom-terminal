export interface XtermWritePumpMetadata {
  generation?: string | null;
  generationOrdinal?: number | null;
  writeSeq?: number | null;
  [key: string]: unknown;
}

interface XtermWriteBatch {
  chunks: string[];
  chars: number;
  meta: XtermWritePumpMetadata | null;
  items: number;
  queuedAt: number;
}

export interface XtermWritePumpStatus {
  disposed: boolean;
  failed: string | null;
  inFlight: boolean;
  inFlightChars: number;
  inFlightItems: number;
  queuedBatches: number;
  queuedChars: number;
  queuedItems: number;
  latestMeta: XtermWritePumpMetadata | null;
}

export interface XtermWritePump {
  push: (data: string, meta?: XtermWritePumpMetadata | null) => boolean;
  drain: () => Promise<XtermWritePumpStatus>;
  dispose: () => void;
  getStatus: () => XtermWritePumpStatus;
}

export const digestTerminalVisibleText = (value: string): string => {
  let hash = 0x811c9dc5;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export async function waitForXtermPresentationAfterDrain({
  drain,
  requestFrame,
  isCurrent,
}: {
  drain: () => Promise<XtermWritePumpStatus>;
  requestFrame: (callback: FrameRequestCallback) => number;
  isCurrent: () => boolean;
}): Promise<{
  presented: boolean;
  reason: 'presented' | 'write-failed' | 'stale-before-paint' | 'stale-after-paint';
  status: XtermWritePumpStatus;
}> {
  const status = await drain();
  if (status.failed) {
    return { presented: false, reason: 'write-failed', status };
  }
  if (!isCurrent()) {
    return { presented: false, reason: 'stale-before-paint', status };
  }
  await new Promise<void>((resolve) => {
    requestFrame(() => resolve());
  });
  if (!isCurrent()) {
    return { presented: false, reason: 'stale-after-paint', status };
  }
  return { presented: true, reason: 'presented', status };
}

const canCoalesceByGeneration = (
  previousMeta: XtermWritePumpMetadata | null,
  nextMeta: XtermWritePumpMetadata | null,
) => {
  // Local renderer markers have no authoritative PTY generation. Keep them
  // isolated so they cannot cross a process-generation boundary.
  if (!previousMeta || !nextMeta) return previousMeta === nextMeta;
  const previousOrdinal = Number.isFinite(previousMeta.generationOrdinal)
    ? Number(previousMeta.generationOrdinal)
    : null;
  const nextOrdinal = Number.isFinite(nextMeta.generationOrdinal)
    ? Number(nextMeta.generationOrdinal)
    : null;
  return (previousMeta.generation ?? null) === (nextMeta.generation ?? null)
    && previousOrdinal === nextOrdinal;
};

export const createXtermWritePump = (
  write: (data: string, callback: () => void) => void,
  options: {
    beforeWrite?: (metadata: XtermWritePumpMetadata | null) => void;
    onFlushed?: (
      metadata: XtermWritePumpMetadata | null,
      batch: { chars: number; items: number; queuedAt: number },
    ) => void;
    onError?: (error: Error) => void;
  } = {},
): XtermWritePump => {
  let inFlight: XtermWriteBatch | null = null;
  let queued: XtermWriteBatch[] = [];
  let disposed = false;
  let failed: Error | null = null;
  let drainWaiters: Array<(status: XtermWritePumpStatus) => void> = [];

  const snapshot = (): XtermWritePumpStatus => ({
    disposed,
    failed: failed ? failed.message : null,
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
    const status = snapshot();
    for (const resolve of waiters) resolve(status);
  };

  const fail = (error: unknown) => {
    failed = error instanceof Error ? error : new Error(String(error));
    queued = [];
    inFlight = null;
    try { options.onError?.(failed); } catch {}
    settleDrainWaiters();
  };

  const dispatch = (batch: XtermWriteBatch) => {
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
        options.onFlushed?.(batch.meta, {
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
      options.beforeWrite?.(batch.meta);
      write(batch.chunks.length === 1 ? batch.chunks[0] : batch.chunks.join(''), complete);
    } catch (error) {
      fail(error);
    }
  };

  return {
    push(data, meta = null) {
      if (disposed || failed) return false;
      const text = typeof data === 'string' ? data : String(data ?? '');
      if (!text) return true;
      const batch: XtermWriteBatch = {
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
      if (tail && canCoalesceByGeneration(tail.meta, meta)) {
        tail.chunks.push(text);
        tail.chars += text.length;
        tail.meta = meta;
        tail.items += 1;
      } else {
        queued.push(batch);
      }
      return true;
    },
    drain() {
      if (!inFlight && queued.length === 0) return Promise.resolve(snapshot());
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      queued = [];
      inFlight = null;
      settleDrainWaiters();
    },
    getStatus: snapshot,
  };
};
