// Presentation of the existing JSONL scenario, not writer/adoption authority.
// The running promise owns its exact id; unmount/tab switches cannot clear it.
let sequence = 0;
let operations = Object.freeze([]);
const listeners = new Set();
const publish = next => {
  operations = Object.freeze(next);
  for (const listener of listeners) listener();
};
export const getHistoryOperationActivities = () => operations;
export const subscribeHistoryOperationActivities = listener => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function beginHistoryOperationActivity({ tabId, kind, sourceSessionId, startUuid = null, endUuid = null, range = null }) {
  if (operations.some(op => op.tabId === tabId && op.status === 'running')) return null;
  const id = `history-operation-${Date.now()}-${++sequence}`;
  publish([...operations.filter(op => op.tabId !== tabId), {
    id, tabId, kind, sourceSessionId, startUuid, endUuid,
    range: range ? { ...range } : null, status: 'running', phase: 'validating',
  }]);
  const update = patch => {
    const current = operations.find(op => op.id === id && op.status === 'running');
    if (current) publish(operations.map(op => op.id === id ? { ...op, ...patch } : op));
  };
  return {
    id,
    setPhase: phase => update({ phase }),
    finish: (error = null) => update({
      status: error ? 'failed' : 'done', phase: 'done', message: error ? String(error) : null,
    }),
  };
}
export function dismissHistoryOperationActivity(id) {
  if (!operations.some(op => op.id === id && op.status !== 'running')) return;
  publish(operations.filter(op => op.id !== id));
}

export function historyOperationOwnerView(state, tabId) {
  let projectId = null;
  let tab = null;
  let workspace = null;
  for (const [id, candidate] of state.openProjects) {
    if (!candidate.tabs.has(tabId)) continue;
    projectId = id;
    workspace = candidate;
    tab = candidate.tabs.get(tabId);
    break;
  }
  const panes = state.splitPanes || [];
  const visible = state.view === 'workspace' && !!tab
    && (workspace.currentView || 'terminal') === 'terminal'
    && (panes.length > 0
      ? panes.some(pane => pane.tabId === tabId)
      : state.activeProjectId === projectId && state.getEffectiveTabId() === tabId);
  return { projectId, tabName: tab?.name || tabId, visible, exists: !!tab };
}

export async function openHistoryOperationOwner(state, tabId, options = {}) {
  return await state.openTabById(tabId, { reason: 'history-operation-owner', ...options });
}
