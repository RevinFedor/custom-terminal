'use strict';

// A launch has a real lifecycle before the shell command is written: checking
// the saved transcript, proving the shell is idle, and preparing Resume.  That
// phase must be re-queryable (not a one-shot renderer event), and an older
// async completion must never clear a newer launch for the same tab.
function createAgentLaunchPreparationRegistry({
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  const byTab = new Map();
  let nextToken = 0;

  const publicState = (state) => state ? { ...state } : null;

  function begin({
    tabId,
    toolType,
    sessionId = null,
    command = null,
    phase = 'checking',
    reason = 'launch-requested',
  } = {}) {
    if (!tabId) throw new Error('tabId required');
    if (toolType !== 'claude' && toolType !== 'codex') {
      throw new Error('toolType must be claude or codex');
    }
    const state = {
      tabId,
      toolType,
      sessionId: sessionId || null,
      command: command || null,
      phase,
      reason,
      token: ++nextToken,
      since: now(),
      preparing: true,
    };
    byTab.set(tabId, state);
    onChange(publicState(state));
    return publicState(state);
  }

  function update(tabId, token, patch = {}) {
    const current = byTab.get(tabId);
    if (!current || current.token !== token || current.preparing !== true) return null;
    const next = {
      ...current,
      ...patch,
      tabId: current.tabId,
      toolType: current.toolType,
      token: current.token,
      preparing: true,
    };
    byTab.set(tabId, next);
    onChange(publicState(next));
    return publicState(next);
  }

  function finish(tabId, token, {
    accepted = false,
    reason = accepted ? 'launch-accepted' : 'launch-rejected',
    error = null,
  } = {}) {
    const current = byTab.get(tabId);
    if (!current || current.token !== token || current.preparing !== true) return false;
    const finalState = {
      ...publicState(current),
      preparing: false,
      accepted: accepted === true,
      reason,
      error: error ? String(error) : null,
      finishedAt: now(),
    };
    // Once the shell command is accepted, ordinary command/TUI lifecycle owns
    // the loader. Keeping that outcome here would resurrect a preparation
    // overlay after readiness. A rejection is different: it may happen while
    // the tab is in the background, so its exact error must remain queryable.
    if (accepted === true) byTab.delete(tabId);
    else byTab.set(tabId, finalState);
    onChange(publicState(finalState));
    return true;
  }

  function clear(tabId, token, {
    reason = 'launch-preparation-cleared',
  } = {}) {
    const current = byTab.get(tabId);
    if (!current || current.token !== token || current.preparing === true) return false;
    if (current.cleared === true) return true;
    const cleared = {
      ...current,
      preparing: false,
      accepted: false,
      cleared: true,
      reason,
      clearedAt: now(),
    };
    // Keep a harmless tombstone until the next begin. A delayed renderer read
    // can now prove that this exact failure was cleared instead of treating a
    // missing entry as an ambiguous transport race.
    byTab.set(tabId, cleared);
    onChange(publicState(cleared));
    return true;
  }

  function clearRejected(tabId, {
    toolType = null,
    reason = 'agent-tui-ready',
  } = {}) {
    const current = byTab.get(tabId);
    if (
      !current
      || current.preparing === true
      || current.accepted === true
      || current.cleared === true
      || (toolType && current.toolType !== toolType)
    ) return false;
    return clear(tabId, current.token, { reason });
  }

  function get(tabId) {
    return publicState(byTab.get(tabId) || null);
  }

  function list() {
    return Array.from(byTab.values())
      .filter((state) => state.preparing === true)
      .map(publicState);
  }

  return { begin, update, finish, clear, clearRejected, get, list };
}

module.exports = { createAgentLaunchPreparationRegistry };
