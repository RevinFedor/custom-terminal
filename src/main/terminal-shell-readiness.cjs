'use strict';

function createTerminalShellReadinessTracker() {
  const states = new Map();
  const normalizePid = (pid) => (
    pid !== null && pid !== undefined && Number.isFinite(Number(pid))
      ? Number(pid)
      : null
  );

  const reset = (tabId, terminalToken, pid = null) => {
    if (!tabId || !terminalToken) return null;
    const state = {
      terminalToken,
      pid: normalizePid(pid),
      ready: false,
      readyAt: null,
    };
    states.set(tabId, state);
    return state;
  };

  const markPromptReady = (tabId, terminalToken, pid = null, readyAt = Date.now()) => {
    const state = states.get(tabId);
    if (!state || state.terminalToken !== terminalToken) return false;
    state.pid = normalizePid(pid) ?? state.pid;
    state.ready = true;
    state.readyAt = Number.isFinite(Number(readyAt)) ? Number(readyAt) : Date.now();
    return true;
  };

  const markCommandBoundary = (tabId, terminalToken) => {
    const state = states.get(tabId);
    if (!state || state.terminalToken !== terminalToken) return false;
    state.ready = false;
    state.readyAt = null;
    return true;
  };

  const remove = (tabId, terminalToken = null) => {
    const state = states.get(tabId);
    if (!state || (terminalToken && state.terminalToken !== terminalToken)) return false;
    states.delete(tabId);
    return true;
  };

  const snapshot = (tabId, terminalToken) => {
    const state = states.get(tabId);
    if (!state || !terminalToken || state.terminalToken !== terminalToken) {
      return { ready: false, pid: null, readyAt: null };
    }
    return {
      ready: state.ready === true,
      pid: state.pid,
      readyAt: state.readyAt,
    };
  };

  return {
    markCommandBoundary,
    markPromptReady,
    remove,
    reset,
    snapshot,
  };
}

module.exports = {
  createTerminalShellReadinessTracker,
};
