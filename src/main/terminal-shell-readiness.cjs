'use strict';

function createTerminalShellReadinessTracker() {
  const states = new Map();
  let launchWriteSequence = 0;
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
      promptFrame: null,
      pendingAgentLaunch: null,
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
    state.promptFrame = null;
    return true;
  };

  const markPromptFrame = (tabId, terminalToken, readyAt, promptFrame) => {
    const state = states.get(tabId);
    if (
      !state
      || state.terminalToken !== terminalToken
      || state.ready !== true
      || Number(state.readyAt) !== Number(readyAt)
      || !promptFrame
    ) return false;
    state.promptFrame = { ...promptFrame };
    return true;
  };

  const promptFrameSnapshot = (tabId, terminalToken) => {
    const state = states.get(tabId);
    if (!state || state.terminalToken !== terminalToken || !state.promptFrame) return null;
    return { ...state.promptFrame };
  };

  const markCommandBoundary = (tabId, terminalToken) => {
    const state = states.get(tabId);
    if (!state || state.terminalToken !== terminalToken) return false;
    state.ready = false;
    state.readyAt = null;
    state.promptFrame = null;
    return true;
  };

  // Shell input may have been written while the AI child is not visible yet.
  // Neither a process lookup miss nor the Ctrl+C prelude's prompt proves that
  // these bytes were consumed. Retain this small witness in the shell owner.
  const markAgentLaunchWrite = (tabId, terminalToken, toolType, launchId) => {
    const state = states.get(tabId);
    if (!state || state.terminalToken !== terminalToken) return false;
    state.pendingAgentLaunch = { writeId: ++launchWriteSequence,
      toolType, launchId: launchId || null, commandStarted: false };
    markCommandBoundary(tabId, terminalToken);
    return true;
  };
  const markAgentLaunchStarted = (tabId, terminalToken) => {
    const state = states.get(tabId);
    if (state?.terminalToken === terminalToken && state.pendingAgentLaunch) {
      state.pendingAgentLaunch.commandStarted = true;
    }
  };
  const finishAgentLaunch = (tabId, terminalToken, processStopped = false) => {
    const state = states.get(tabId);
    if (!state || state.terminalToken !== terminalToken || !state.pendingAgentLaunch) return false;
    if (!processStopped && !state.pendingAgentLaunch.commandStarted) return false;
    state.pendingAgentLaunch = null;
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
      pendingAgentLaunch: state.pendingAgentLaunch ? { ...state.pendingAgentLaunch } : null,
    };
  };

  return {
    markAgentLaunchWrite,
    markAgentLaunchStarted,
    finishAgentLaunch,
    markCommandBoundary,
    markPromptFrame,
    markPromptReady,
    promptFrameSnapshot,
    remove,
    reset,
    snapshot,
  };
}

function classifyTerminalShellDraftProof({ baseline, current } = {}) {
  if (!baseline || !current) return { status: 'unknown', reason: 'prompt-frame-unavailable' };
  if (baseline.mirrorGeneration !== current.mirrorGeneration) {
    return { status: 'unknown', reason: 'prompt-frame-generation-changed' };
  }
  const baselineInputRevision = Number(baseline.inputRevision);
  const currentInputRevision = Number(current.inputRevision);
  if (
    Number.isFinite(baselineInputRevision)
    && Number.isFinite(currentInputRevision)
    && baselineInputRevision === currentInputRevision
  ) {
    return { status: 'empty', reason: 'prompt-input-revision-unchanged' };
  }
  const unchanged = baseline.bufferType === current.bufferType
    && baseline.lineText === current.lineText
    && Number(baseline.cursorX) === Number(current.cursorX);
  return unchanged
    ? { status: 'empty', reason: 'prompt-frame-returned-to-baseline' }
    : { status: 'draft', reason: 'prompt-frame-changed' };
}

module.exports = {
  classifyTerminalShellDraftProof,
  createTerminalShellReadinessTracker,
};
