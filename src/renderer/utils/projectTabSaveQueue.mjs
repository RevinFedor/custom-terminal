/**
 * Serialize full tab snapshots per project.
 *
 * `project:save-tabs` is a delete/reinsert snapshot, not a point update. Two
 * concurrent snapshots A(old) and B(new) may resolve in reverse order and let
 * A resurrect a tab that B just closed. Different projects remain independent.
 */
export function createProjectTabSaveQueue() {
  const tails = new Map();

  const enqueueMany = (projectIds, operation) => {
    const ids = [...new Set(projectIds || [])];
    if (ids.length === 0 || ids.some(id => !id)) return Promise.reject(new TypeError('projectId is required'));
    if (typeof operation !== 'function') {
      return Promise.reject(new TypeError('operation is required'));
    }
    const previous = Promise.all(ids.map(id => (tails.get(id) || Promise.resolve()).catch(() => undefined)));
    const queued = previous
      .catch(() => undefined)
      .then(operation);
    const tracked = queued.finally(() => {
      for (const id of ids) if (tails.get(id) === tracked) tails.delete(id);
    });
    for (const id of ids) tails.set(id, tracked);
    return tracked;
  };

  return {
    enqueue: (projectId, operation) => enqueueMany([projectId], operation),
    enqueueMany,
    pending(projectId) {
      return tails.has(projectId);
    },
  };
}
