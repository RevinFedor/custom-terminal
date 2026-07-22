export const CLAUDE_STARTUP_DEFAULTS_SOURCE = 'claude-startup-defaults';

export function isClaudeStartupDefaultsState(state) {
  return state?.stickySource === CLAUDE_STARTUP_DEFAULTS_SOURCE;
}

function isSameTarget(state, info) {
  return state?.tabId === info?.tabId && state?.engine === info?.engine;
}

export function invalidateSessionStartingProbeSequence(sequence, activeInfo, tabId) {
  return activeInfo?.tabId === tabId ? sequence + 1 : sequence;
}

export function isSessionStartingProbeCurrent(probeSequence, currentSequence, requestedInfo, activeInfo) {
  return probeSequence === currentSequence && isSameTarget(requestedInfo, activeInfo);
}

export function syncSessionStartingWithPresence(previous, info, presence, now = Date.now()) {
  if (!info || !presence) return previous;
  const sameTarget = isSameTarget(previous, info);

  if (presence.status === 'starting') {
    if (sameTarget && isClaudeStartupDefaultsState(previous)) {
      return {
        ...previous,
        sessionId: info.sessionId || null,
        lastNotReady: presence.lastNotReady || null,
      };
    }
    if (sameTarget) {
      const failed = presence.startupFailed === true;
      return {
        ...previous,
        sessionId: info.sessionId || null,
        lastNotReady: presence.lastNotReady || null,
        startupPending: false,
        startupFailed: failed,
        startupError: failed ? (presence.startupError || null) : null,
      };
    }
    return {
      tabId: info.tabId,
      engine: info.engine,
      sessionId: info.sessionId || null,
      since: now,
      lastNotReady: presence.lastNotReady || null,
      startupPending: false,
      startupFailed: presence.startupFailed === true,
      startupError: presence.startupFailed === true
        ? (presence.startupError || null)
        : null,
    };
  }

  if (!sameTarget) return previous;
  if (isClaudeStartupDefaultsState(previous)) return previous;
  const keepHoldingForCommandStartRace = previous?.holdUntilReady
    && presence.status === 'inactive'
    && !presence.manualActionRequired;
  return keepHoldingForCommandStartRace ? previous : null;
}

export function hideSessionStartingFromLifecycle(previous, tabId, { force = false } = {}) {
  if (previous?.tabId !== tabId) return previous;
  if (isClaudeStartupDefaultsState(previous)) return previous;
  if (previous.startupPending || (!force && previous.holdUntilReady)) return previous;
  return null;
}

export function applyClaudeStartupDefaultsGate(previous, info, detail, now = Date.now()) {
  if (!info || info.engine !== 'claude' || info.tabId !== detail?.tabId) return previous;
  if (detail.status === 'ready' || detail.status === 'cleared') {
    return isSameTarget(previous, info) && isClaudeStartupDefaultsState(previous)
      ? null
      : previous;
  }
  if (detail.status !== 'pending' && detail.status !== 'failed') return previous;

  const failed = detail.status === 'failed';
  return {
    tabId: info.tabId,
    engine: 'claude',
    sessionId: info.sessionId || null,
    since: isSameTarget(previous, info) ? previous.since : now,
    lastNotReady: isSameTarget(previous, info) ? (previous.lastNotReady || null) : null,
    holdUntilReady: isSameTarget(previous, info) ? previous.holdUntilReady : false,
    startupPending: !failed,
    startupFailed: failed,
    startupError: failed
      ? (detail.error || detail.reason || 'Claude startup defaults failed')
      : null,
    stickySource: CLAUDE_STARTUP_DEFAULTS_SOURCE,
  };
}
