/** Owner-local presentation for calls which share one physical source row
 * with readable text. Exact tool-use IDs also let Timeline reveal that call
 * without replacing the row's UUID or creating a second source address. */
export function createHistoryCompositeGroupState() {
  const open = new Set(), listeners = new Map();
  let pending = null;
  const notify = ids => {
    const changed = new Set();
    for (const id of ids) for (const listener of listeners.get(id) || []) changed.add(listener);
    for (const listener of changed) listener();
  };
  return Object.freeze({
    isOpen(ids) { return ids.some(id => open.has(id) || id === pending); },
    set(ids, value) {
      const changed = [];
      for (const id of ids) {
        if (!id) continue;
        const before = open.has(id) || id === pending;
        if (value) open.add(id); else open.delete(id);
        if (id === pending) pending = null;
        if (before !== open.has(id)) changed.push(id);
      }
      notify(changed);
    },
    revealOnce(id) {
      if (!id || pending === id) return;
      const previous = pending; pending = id;
      notify([previous, id]);
    },
    clearReveal(id) {
      if (pending !== id) return;
      pending = null;
      if (!open.has(id)) notify([id]);
    },
    acknowledge(ids) {
      if (!pending || !ids.includes(pending)) return;
      // Promote only the one exact pending row's group to ordinary open state.
      for (const id of ids) if (id) open.add(id);
      pending = null;
    },
    subscribe(ids, listener) {
      for (const id of ids) {
        let list = listeners.get(id);
        if (!list) listeners.set(id, list = new Set());
        list.add(listener);
      }
      return () => {
        for (const id of ids) {
          const list = listeners.get(id);
          list?.delete(listener);
          if (list?.size === 0) listeners.delete(id);
        }
      };
    },
  });
}
