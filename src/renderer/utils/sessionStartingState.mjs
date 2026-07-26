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

  // A manual startup blocker ends the process lifecycle but not the user's
  // need for an explanation. Keep the same non-modal card as an actionable
  // status until the user dismisses it or a later lifecycle event replaces it.
  if (info.engine === 'codex' && presence.manualActionRequired === true) {
    return {
      tabId: info.tabId,
      engine: info.engine,
      sessionId: info.sessionId || null,
      since: sameTarget ? previous.since : now,
      lastNotReady: presence.lastNotReady || previous?.lastNotReady || null,
      holdUntilReady: false,
      startupPending: false,
      startupFailed: false,
      startupError: null,
    };
  }

  // The startup card describes terminal readiness, not rollout identity. A
  // fresh Codex session legitimately has no writer/session id until the first
  // submitted message, so an authoritative ready composer always clears it.
  if (info.engine === 'codex' && presence.inputReady === true) {
    return sameTarget ? null : previous;
  }

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

  // A failed process/writer probe is not evidence that startup completed. Keep
  // the existing card for the same tab so a transient lsof/ps timeout cannot
  // produce starting → hidden → starting flicker.
  if (presence.status === 'unknown' && sameTarget) {
    return {
      ...previous,
      sessionId: info.sessionId || previous.sessionId || null,
      lastNotReady: presence.lastNotReady || previous.lastNotReady || null,
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
    // Which command failed, so the card can say `/effort max` instead of the
    // generic "terminal input did not become ready" — that subtitle actively
    // contradicted the real cause in the 2026-07-25 incident.
    startupFailedCommand: failed ? (detail.failedCommand || null) : null,
    startupProofOutcome: failed ? (detail.proofOutcome || null) : null,
    startupUserRetryable: failed ? detail.userRetryable === true : false,
    stickySource: CLAUDE_STARTUP_DEFAULTS_SOURCE,
  };
}
