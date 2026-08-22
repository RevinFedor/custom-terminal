/**
 * Serialize full tab snapshots per project.
 *
 * `project:save-tabs` is a delete/reinsert snapshot, not a point update. Two
 * concurrent snapshots A(old) and B(new) may resolve in reverse order and let
 * A resurrect a tab that B just closed. Different projects remain independent.
 */
export function createProjectTabSaveQueue() {
  const tails = new Map();

  const enqueue = (projectId, operation) => {
    if (!projectId) return Promise.reject(new TypeError('projectId is required'));
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('operation is required'));
    }
    const previous = tails.get(projectId) || Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(operation);
    const tracked = queued.finally(() => {
      if (tails.get(projectId) === tracked) tails.delete(projectId);
    });
    tails.set(projectId, tracked);
    return tracked;
  };

  return {
    enqueue,
    pending(projectId) {
      return tails.has(projectId);
    },
  };
}
