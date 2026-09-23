// This store only combines existing owners for chrome. None of its values may
// authorize PTY input, Stop, Run after, or confirm a delivery.
export function createAgentSendVisualActivity() {
  const local = new Map();
  const listeners = new Set();
  let main = new Set();
  let mainGeneration = null;
  let mainRevision = -1;
  let pending = new Set();
  const observing = new Set();
  const keyFor = (tabId, handoffId) => JSON.stringify([tabId, handoffId]);
  const hasLocalHandoff = (tabId, handoffId) => [...local.values()]
    .some(tabs => tabs.get(tabId)?.includes(handoffId));
  const publish = () => {
    const next = new Set(main);
    for (const tabs of local.values()) for (const [tabId, handoffIds] of tabs) {
      if (handoffIds.some(id => !id || !observing.has(keyFor(tabId, id)))) next.add(tabId);
    }
    if (next.size === pending.size && [...next].every((id) => pending.has(id))) return;
    pending = next;
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => pending,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    replaceLocal(owner, tabIds) {
      local.set(owner, new Map(tabIds.map(item => typeof item === 'string'
        ? [item, [null]] : [item.tabId, [item.handoffId || null]])));
      publish();
    },
    setLocal(owner, tabId, active, handoffs = [null]) {
      let tabs = local.get(owner);
      if (!tabs) local.set(owner, tabs = new Map());
      const previous = tabs.get(tabId) || [];
      const ids = Array.isArray(handoffs) && handoffs.length ? handoffs : [null];
      if (active) tabs.set(tabId, ids); else tabs.delete(tabId);
      for (const id of previous) {
        if (id && !hasLocalHandoff(tabId, id)) observing.delete(keyFor(tabId, id));
      }
      publish();
    },
    applyMain(snapshot) {
      if (!snapshot?.generation || !Number.isSafeInteger(snapshot.revision)
        || !Array.isArray(snapshot.pendingTabIds)) return;
      if (snapshot.generation === mainGeneration && snapshot.revision <= mainRevision) return;
      mainGeneration = snapshot.generation;
      mainRevision = snapshot.revision;
      main = new Set(snapshot.pendingTabIds.filter((id) => typeof id === 'string' && id));
      for (const operation of [...(snapshot.observingHandoffs || []), snapshot.lastOperation]) {
        if (!operation?.handoffId || !hasLocalHandoff(operation.tabId, operation.handoffId)) continue;
        const key = keyFor(operation.tabId, operation.handoffId);
        if (operation.active === true) observing.delete(key);
        else observing.add(key);
      }
      publish();
    },
  };
}
