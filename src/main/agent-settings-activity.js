'use strict';

// Presentation of real main-owned operations. This never authorizes a PTY
// write or claims application: the existing provider scenario owns that proof.
function createAgentSettingsActivity({ isCurrent = () => true, publish = () => {} } = {}) {
  const tabs = new Map();
  let sequence = 0;
  const read = tabId => {
    const state = tabs.get(tabId);
    let retired = false;
    for (const [id, op] of state?.operations || []) {
      if (!isCurrent(tabId, op.runtime)) { state.operations.delete(id); retired = true; }
    }
    if (retired) state.sequence = ++sequence;
    const active = [...(state?.operations.values() || [])];
    const latest = active.at(-1);
    return { tabId, sequence: state?.sequence || 0, busy: active.length > 0,
      target: latest?.target || null, toolType: latest?.toolType || null };
  };
  const emit = tabId => publish(read(tabId));
  const begin = ({ tabId, target = 'model', toolType, runtime }) => {
    const state = tabs.get(tabId) || { sequence: 0, operations: new Map() };
    const token = { tabId, id: ++sequence };
    state.sequence = sequence;
    state.operations.set(token.id, { target, toolType, runtime });
    tabs.set(tabId, state);
    emit(tabId);
    return token;
  };
  const end = token => {
    const state = tabs.get(token?.tabId);
    if (!state?.operations.delete(token.id)) return false;
    state.sequence = ++sequence;
    emit(token.tabId);
    return true;
  };
  const run = async (request, operation) => {
    const token = begin(request);
    try { return await operation(); } finally { end(token); }
  };
  return { read, begin, end, run };
}

module.exports = { createAgentSettingsActivity };
