// This store only combines existing owners for chrome. None of its values may
// authorize PTY input, Stop, Run after, or confirm a delivery.
export function createAgentSendVisualActivity() {
  const local = new Map();
  const listeners = new Set();
  let main = new Set();
  let mainGeneration = null;
  let mainRevision = -1;
  let pending = new Set();
  const publish = () => {
    const next = new Set(main);
    for (const tabs of local.values()) for (const tabId of tabs) next.add(tabId);
    if (next.size === pending.size && [...next].every((id) => pending.has(id))) return;
    pending = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => pending,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    replaceLocal(owner, tabIds) {
      local.set(owner, new Set(tabIds));
      publish();
    },
    setLocal(owner, tabId, active) {
      let tabs = local.get(owner);
      if (!tabs) local.set(owner, tabs = new Set());
      if (active) tabs.add(tabId); else tabs.delete(tabId);
      publish();
    },
    applyMain(snapshot) {
      if (!snapshot?.generation || !Number.isSafeInteger(snapshot.revision)
        || !Array.isArray(snapshot.pendingTabIds)) return;
      if (snapshot.generation === mainGeneration && snapshot.revision <= mainRevision) return;
      mainGeneration = snapshot.generation;
      mainRevision = snapshot.revision;
      main = new Set(snapshot.pendingTabIds.filter((id) => typeof id === 'string' && id));
      publish();
    },
  };
}
