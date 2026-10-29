import { normalizeAgentTurnEndReason } from './agentCompletionOutcome.mjs';

export function isModelCapacityWorkflowOutcome(data) {
  return normalizeAgentTurnEndReason(data?.reason) === 'model_capacity';
}

export function isCapacitySurfaceOnlyOutcome(data) {
  return isModelCapacityWorkflowOutcome(data) && data.capacitySurfaceOnly === true;
}

/**
 * Read-side projection of Main's capacity/turn facts, not a retry executor or
 * delivery receipt. It changes no queue/arm and owns no clock/input. Main keeps
 * the finite Continue budget, delays, exact H/O and UNKNOWN reconciliation.
 * Rebuild it from get-turn-state before restored automation is admitted.
 */
export function createRunAfterCapacityRecovery() {
  const waits = new Map();
  const natural = new Map();
  const owners = new Map();
  const sameOwner = (a, b) => !!a?.sessionId && a.sessionId === b?.sessionId
    && (!a.lifecycleGeneration || !b.lifecycleGeneration || a.lifecycleGeneration === b.lifecycleGeneration);
  const fact = data => ({
    sessionId: data.sessionId || null,
    lifecycleGeneration: data.lifecycleGeneration || null,
    turnId: data.turnId || data.lastOutcomeTurnId || null,
    at: data.workflowOutcomeTimestampKnown !== false && Number.isFinite(data.outcomeTs) ? data.outcomeTs : null,
    surfaceOnly: data.capacitySurfaceOnly === true,
  });
  function observeCapacity(data, currentSessionId) {
    if (!isModelCapacityWorkflowOutcome(data)) return false;
    const next = fact(data);
    // A late callback for a replaced writer cannot hold its replacement.
    if (next.sessionId && currentSessionId && next.sessionId !== currentSessionId) return false;
    const completed = natural.get(data.tabId);
    if (sameOwner(next, completed) && next.turnId && next.turnId === completed.recoveredTurnId) return false;
    if (sameOwner(next, completed) && Number.isFinite(next.at) && completed.at > next.at) return false;
    const old = waits.get(data.tabId);
    if (sameOwner(old, next)) {
      // Presentation can arrive after the typed record for the same failed
      // turn. It must never replace/downgrade that authoritative boundary.
      if (old.turnId && old.turnId === next.turnId && !old.surfaceOnly && next.surfaceOnly) return true;
      if (Number.isFinite(old.at) && Number.isFinite(next.at) && old.at > next.at && !old.surfaceOnly) return true;
      if (old.turnId === next.turnId) next.continuationTurnId = old.continuationTurnId || null;
    }
    waits.set(data.tabId, next);
    owners.set(data.tabId, next);
    return true;
  }
  function observeStart(data, currentSessionId) {
    const old = waits.get(data.tabId);
    if ((!old && !owners.has(data.tabId)) || !data.sessionId || data.sessionId !== currentSessionId) return;
    owners.set(data.tabId, fact(data));
    if (!old) return;
    if (sameOwner(old, data) && data.turnId && data.turnId !== old.turnId) {
      waits.set(data.tabId, { ...old, continuationTurnId: data.turnId });
    }
    // A fresh Main-owned lifecycle supersedes the old observation, not the
    // authored queue. Its genuine busy/Goal/FIFO guards still own readiness.
    if (old.sessionId && (old.sessionId !== data.sessionId
      || (old.lifecycleGeneration && data.lifecycleGeneration
        && old.lifecycleGeneration !== data.lifecycleGeneration))) waits.delete(data.tabId);
  }
  function acceptNatural(data, currentSessionId) {
    const old = waits.get(data.tabId);
    const next = fact(data);
    if (!matchesCurrent(data, currentSessionId)) return { accepted: false, released: false };
    if (old) {
      if (normalizeAgentTurnEndReason(data.reason) !== 'task_complete'
        || !sameOwner(old, next) || !next.turnId || next.turnId === old.turnId
        || !Number.isFinite(old.at) || !Number.isFinite(next.at) || next.at < old.at
        || (next.at === old.at && old.continuationTurnId !== next.turnId
          && data.workflowSnapshotCurrentTurnId !== next.turnId)
        || !currentSessionId || next.sessionId !== currentSessionId
        || (old.lifecycleGeneration && next.lifecycleGeneration !== old.lifecycleGeneration)) {
        return { accepted: false, released: false };
      }
      waits.delete(data.tabId);
    }
    if (data.busy === false && normalizeAgentTurnEndReason(data.reason) === 'task_complete'
      && next.sessionId && next.sessionId === currentSessionId && Number.isFinite(next.at)) {
      const previous = natural.get(data.tabId);
      if (!sameOwner(previous, next) || previous.at <= next.at) natural.set(data.tabId, {
        ...next, recoveredTurnId: old?.turnId || (sameOwner(previous, next) ? previous.recoveredTurnId : null),
        episodeActive: !!old || (sameOwner(previous, next) && previous.episodeActive === true),
      });
    }
    return { accepted: true, released: !!old };
  }
  function matchesCurrent(data, currentSessionId) {
    const owner = owners.get(data.tabId);
    return !owner || (!!currentSessionId && data.sessionId === currentSessionId
      && (!owner.sessionId || owner.sessionId !== currentSessionId || !owner.lifecycleGeneration
        || data.lifecycleGeneration === owner.lifecycleGeneration));
  }
  return {
    observeCapacity, observeStart, acceptNatural, matchesCurrent,
    isRecoveryNatural: data => {
      const last = natural.get(data.tabId), next = fact(data);
      return last?.episodeActive === true && sameOwner(last, next)
        && last.turnId === next.turnId && last.at === next.at;
    },
    blocks: (tabId, currentSessionId) => {
      const wait = waits.get(tabId);
      return !!wait && (!wait.sessionId || !currentSessionId || wait.sessionId === currentSessionId);
    },
    settled: tabId => { const previous = natural.get(tabId); if (previous) natural.set(tabId, { ...previous, episodeActive: false }); },
    forget: tabId => {
      waits.delete(tabId);
      const previous = natural.get(tabId);
      if (previous) natural.set(tabId, { ...previous, episodeActive: false });
    },
  };
}
