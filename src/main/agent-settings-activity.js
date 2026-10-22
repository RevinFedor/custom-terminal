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
      target: latest?.target || null, toolType: latest?.toolType || null,
      ...(active.length && active.every(op => op.replaceable === true) ? { replaceable: true } : {}) };
  };
  const emit = tabId => publish(read(tabId));
  const begin = ({ tabId, target = 'model', toolType, runtime, replaceable = false }) => {
    const state = tabs.get(tabId) || { sequence: 0, operations: new Map() };
    const token = { tabId, id: ++sequence };
    state.sequence = sequence;
    state.operations.set(token.id, { target, toolType, runtime, replaceable: replaceable === true });
    tabs.set(tabId, state);
    emit(tabId);
    return token;
  };
  const markInputStarted = token => {
    const state = tabs.get(token?.tabId), operation = state?.operations.get(token.id);
    if (!operation?.replaceable) return false;
    operation.replaceable = false;
    state.sequence = ++sequence;
    emit(token.tabId);
    return true;
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
  return { read, begin, end, run, markInputStarted };
}

module.exports = { createAgentSettingsActivity };
