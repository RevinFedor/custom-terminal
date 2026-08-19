'use strict';

function createConcurrencyLimiter(maxConcurrent = 2) {
  const limit = Math.max(1, Math.floor(Number(maxConcurrent) || 1));
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    },
    stats: () => ({ active, queued: queue.length, limit }),
  };
}

/**
 * Coalesces only overlapping work. There is deliberately no completed-result
 * cache: a later request remains just as fresh as before this coordinator.
 */
function createGitStatusCoordinator({
  resolveRoot,
  readStatus,
  maxConcurrentRoots = 2,
  maxConcurrentRootLookups = 2,
  onEvent,
} = {}) {
  if (typeof resolveRoot !== 'function') throw new TypeError('resolveRoot is required');
  if (typeof readStatus !== 'function') throw new TypeError('readStatus is required');

  const rootLimiter = createConcurrencyLimiter(maxConcurrentRootLookups);
  const statusLimiter = createConcurrencyLimiter(maxConcurrentRoots);
  const rootFlights = new Map();
  const statusFlights = new Map();

  const emit = (event) => {
    try { onEvent?.(event); } catch { /* diagnostics cannot break Git */ }
  };

  const resolveRootOnce = (projectPath) => {
    const key = String(projectPath || '');
    const existing = rootFlights.get(key);
    if (existing) {
      existing.joined += 1;
      return existing.promise;
    }
    const startedAt = Date.now();
    const entry = { joined: 0, promise: null };
    entry.promise = rootLimiter.run(() => resolveRoot(projectPath))
      .finally(() => {
        if (rootFlights.get(key) === entry) rootFlights.delete(key);
        emit({
          kind: 'root-complete',
          key,
          joined: entry.joined,
          durationMs: Date.now() - startedAt,
          ...rootLimiter.stats(),
        });
      });
    rootFlights.set(key, entry);
    return entry.promise;
  };

  const readStatusOnce = (root) => {
    const key = String(root || '');
    const existing = statusFlights.get(key);
    if (existing) {
      existing.joined += 1;
      return existing.promise;
    }
    const startedAt = Date.now();
    const entry = { joined: 0, promise: null };
    entry.promise = statusLimiter.run(() => readStatus(root))
      .finally(() => {
        if (statusFlights.get(key) === entry) statusFlights.delete(key);
        emit({
          kind: 'status-complete',
          root: key,
          joined: entry.joined,
          durationMs: Date.now() - startedAt,
          ...statusLimiter.stats(),
        });
      });
    statusFlights.set(key, entry);
    return entry.promise;
  };

  return {
    async request(projectPath) {
      const root = await resolveRootOnce(projectPath);
      if (!root) return null;
      return readStatusOnce(root);
    },
    stats() {
      return {
        rootFlights: rootFlights.size,
        statusFlights: statusFlights.size,
        rootLimiter: rootLimiter.stats(),
        statusLimiter: statusLimiter.stats(),
      };
    },
  };
}

module.exports = {
  createConcurrencyLimiter,
  createGitStatusCoordinator,
};
