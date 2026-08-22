import { describeClaudeStartupFailure } from './claudeStartupFailure.mjs';

export const CLAUDE_STARTUP_DEFAULTS_SOURCE = 'claude-startup-defaults';

export function isClaudeStartupDefaultsState(state) {
  return state?.stickySource === CLAUDE_STARTUP_DEFAULTS_SOURCE;
}

function isSameTarget(state, info) {
  return state?.tabId === info?.tabId && state?.engine === info?.engine;
}

function launchPreparationEngine(snapshot) {
  if (snapshot?.toolType === 'claude') return 'claude';
  if (snapshot?.toolType === 'codex') return 'codex';
  return null;
}

// Main owns launch preparation before a shell command exists. Events are only
// a fast path: this reducer also consumes the exact snapshot returned after a
// tab switch, including a rejection or an explicit clear.
export function applyAgentLaunchPreparationSnapshot(previous, info, snapshot, now = Date.now()) {
  if (!info) return previous;
  if (!snapshot) {
    const preparationOwned = isSameTarget(previous, info)
      && (previous?.launchPreparationStatus || Number(previous?.launchPreparationToken || 0) > 0);
    return preparationOwned ? null : previous;
  }

  const engine = launchPreparationEngine(snapshot);
  if (!engine || snapshot.tabId !== info.tabId || engine !== info.engine) return previous;
  const token = Number(snapshot.token || 0) || null;
  const sameTarget = isSameTarget(previous, info);
  const previousToken = Number(previous?.launchPreparationToken || 0) || null;
  const sameToken = sameTarget && token !== null && previousToken === token;

  if (snapshot.cleared === true) {
    if (!sameTarget || previousToken === null) return previous;
    return token !== null && previousToken !== token ? previous : null;
  }

  // A late completion for an older launch must not replace a newer local
  // preparation. Main also rejects stale tokens; this is the renderer's second
  // identity boundary for delayed IPC delivery.
  if (sameTarget && previousToken !== null && token !== null && previousToken !== token) {
    if (snapshot.preparing !== true) return previous;
  }

  const base = {
    tabId: info.tabId,
    engine,
    sessionId: snapshot.sessionId || info.sessionId || null,
    since: sameToken
      ? previous.since
      : (Number(snapshot.since) || Number(snapshot.finishedAt) || now),
    lastNotReady: sameTarget ? (previous?.lastNotReady || null) : null,
    startupPending: false,
    startupFailedCommand: null,
    startupProofOutcome: null,
    startupUserRetryable: false,
    launchPreparationPhase: snapshot.phase || null,
    launchPreparationToken: token,
  };

  if (snapshot.preparing === true) {
    return {
      ...base,
      holdUntilReady: true,
      startupFailed: false,
      startupError: null,
      launchPreparing: true,
      launchPreparationStatus: 'preparing',
    };
  }

  if (snapshot.accepted === true) {
    return {
      ...base,
      holdUntilReady: true,
      startupFailed: false,
      startupError: null,
      launchPreparing: false,
      launchPreparationPhase: null,
      launchPreparationStatus: 'accepted',
    };
  }

  return {
    ...base,
    holdUntilReady: false,
    startupFailed: true,
    startupError: snapshot.error || snapshot.reason || `${engine} launch rejected`,
    launchPreparing: false,
    launchPreparationStatus: 'rejected',
  };
}

export function describeLaunchPreparationFailure(state) {
  if (state?.launchPreparationStatus !== 'rejected') return null;
  const engineLabel = state.engine === 'codex' ? 'Codex' : 'Claude';
  return {
    subtitle: state.startupError || `Could not start ${engineLabel}`,
    detail: state.sessionId
      ? `The saved ${engineLabel} session was not changed`
      : `The ${engineLabel} process was not started`,
  };
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

  // A launch rejection is an exact final result, not a best-effort lifecycle
  // probe. Only its exact clear/dismiss, a superseding begin, or the matching
  // TUI-ready edge may remove it.
  if (sameTarget && previous?.launchPreparationStatus === 'rejected') {
    return previous;
  }

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
  if (previous?.launchPreparationStatus === 'rejected') return previous;
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
  const failure = failed ? describeClaudeStartupFailure({
    error: detail.error || detail.reason || 'Claude startup defaults failed',
    errorCode: detail.errorCode,
    failedCommand: detail.failedCommand,
  }) : null;
  return {
    tabId: info.tabId,
    engine: 'claude',
    sessionId: info.sessionId || null,
    since: isSameTarget(previous, info) ? previous.since : now,
    lastNotReady: isSameTarget(previous, info) ? (previous.lastNotReady || null) : null,
    holdUntilReady: isSameTarget(previous, info) ? previous.holdUntilReady : false,
    startupPending: !failed,
    startupFailed: failed,
    startupError: failure?.message || null,
    startupErrorCode: failure?.code || null,
    // Which command failed, so the card can say `/effort max` instead of the
    // generic "terminal input did not become ready" — that subtitle actively
    // contradicted the real cause in the 2026-07-25 incident.
    startupFailedCommand: failed ? (detail.failedCommand || null) : null,
    startupProofOutcome: failed ? (detail.proofOutcome || null) : null,
    startupUserRetryable: failed ? detail.userRetryable === true : false,
    stickySource: CLAUDE_STARTUP_DEFAULTS_SOURCE,
  };
}

// Reconcile a re-read snapshot, including terminal states. A stale local
// CONFIGURING card must be removed when main says `ready`, `cleared`, or has no
// gate anymore. Events are only a fast path; switching away must not make a
// completed transaction look pending forever.
export function restoreClaudeStartupDefaultsGate(previous, info, gate, now = Date.now()) {
  if (!info || info.engine !== 'claude') return previous;
  if (!gate) {
    return isSameTarget(previous, info) && isClaudeStartupDefaultsState(previous)
      ? null
      : previous;
  }
  return applyClaudeStartupDefaultsGate(previous, info, {
    ...gate,
    tabId: info.tabId,
  }, now);
}
