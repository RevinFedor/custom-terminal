export const CODEX_PRESENCE_SNAPSHOT_FIELDS = Object.freeze([
  'success',
  'projectId',
  'sessionStatus',
  'busy',
  'inputReady',
  'liveLifecycle',
  'sessionId',
  'readSessionId',
  'readIdentitySource',
  'savedSessionId',
  'conversationMaterialized',
  'timelineCount',
  'materializationReason',
  'canCopySessionId',
  'hasTerm',
  'lastNotReady',
  'startupFailed',
  'startupError',
  'manualActionRequired',
  'manualActionType',
  'lifecycleWarning',
  'hasWatcher',
  'catchUpPending',
  'outcomeKnown',
  'lastOutcomeReason',
]);

const CODEX_PTY_STATUSES = new Set([
  'active',
  'busy',
  'inactive',
  'starting',
  'stopping',
  'unknown',
]);

const hasOwn = (value, field) => Object.prototype.hasOwnProperty.call(value, field);

/**
 * Renderer consumes one explicit main-owned read/copy verdict. It must not
 * rebuild that identity from launch, saved-history, or writer fields because
 * those values can belong to different lifecycle generations.
 */
export function getCodexRuntimeReadSessionId(runtimeSnapshot) {
  if (runtimeSnapshot?.canCopySessionId !== true) return null;
  const source = runtimeSnapshot?.readIdentitySource;
  const lifecycleMatches = runtimeSnapshot?.liveLifecycle === true
    ? source === 'live-writer' || source === 'resume-source'
    : runtimeSnapshot?.liveLifecycle === false
      ? source === 'stopped-history'
      : false;
  if (!lifecycleMatches) return null;
  const value = typeof runtimeSnapshot?.readSessionId === 'string'
    ? runtimeSnapshot.readSessionId.trim()
    : '';
  return value || null;
}

/**
 * Main owns the proof-kind taxonomy. Renderer actions must consume the
 * mutation-safe verdict from the same atomic runtime snapshot instead of
 * duplicating a list of proof kinds: a settled native-Rewind writer is just as
 * authoritative as the initial process-open-rollout proof.
 */
export function isCodexRuntimeWriterUsable(runtimeSnapshot, {
  requireCopy = false,
} = {}) {
  const provenWriterSessionId = typeof runtimeSnapshot?.provenWriterSessionId === 'string'
    ? runtimeSnapshot.provenWriterSessionId.trim()
    : '';
  const writerProof = typeof runtimeSnapshot?.writerProof === 'string'
    ? runtimeSnapshot.writerProof.trim()
    : '';
  return runtimeSnapshot?.writerConfirmed === true
    && runtimeSnapshot?.writerStatus === 'adopted'
    && runtimeSnapshot?.writerUsableForMutation === true
    && provenWriterSessionId.length > 0
    && writerProof.length > 0
    && (requireCopy !== true || runtimeSnapshot?.canCopySessionId === true);
}

/**
 * Fork does not mutate its source rollout. It may therefore snapshot an exact
 * idle Resume read identity before that process has produced the first writer
 * event. This does NOT promote the read identity to writer authority: live
 * Edit/Delete and every other destructive action still require the main-owned
 * mutation-safe writer verdict.
 */
export function getCodexRuntimeForkSourceSessionId(runtimeSnapshot) {
  if (runtimeSnapshot?.canForkSnapshot !== true) return null;
  return getCodexRuntimeReadSessionId(runtimeSnapshot);
}

export function isCodexRuntimeForkReady(runtimeSnapshot) {
  return !!getCodexRuntimeForkSourceSessionId(runtimeSnapshot);
}

/**
 * Presence must be projected from one main-owned lifecycle generation. Until
 * the runtime snapshot contains every field used by the UI, callers must not
 * fill the gaps with separate IPC reads: that recreates the split-generation
 * race this helper is intended to remove.
 */
export function projectCodexPtyPresence(runtimeSnapshot, { fallbackBusy = false } = {}) {
  if (!runtimeSnapshot || typeof runtimeSnapshot !== 'object') {
    return {
      complete: false,
      missingFields: [...CODEX_PRESENCE_SNAPSHOT_FIELDS],
      presence: null,
    };
  }

  const missingFields = CODEX_PRESENCE_SNAPSHOT_FIELDS.filter(
    (field) => !hasOwn(runtimeSnapshot, field),
  );
  if (missingFields.length > 0) {
    return { complete: false, missingFields, presence: null };
  }
  if (runtimeSnapshot.success !== true) {
    return { complete: false, missingFields: [], presence: null };
  }

  const runtimeStatus = CODEX_PTY_STATUSES.has(runtimeSnapshot.sessionStatus)
    ? runtimeSnapshot.sessionStatus
    : 'unknown';
  const startupFailed = runtimeSnapshot.startupFailed === true;
  const manualActionRequired = runtimeSnapshot.manualActionRequired === true;
  const status = runtimeStatus === 'stopping'
    ? 'stopping'
    : manualActionRequired && !runtimeSnapshot.runtimePolicy
      ? 'inactive'
      : startupFailed
        ? 'starting'
        : runtimeStatus;
  const savedSessionId = runtimeSnapshot.savedSessionId || null;
  const sessionId = runtimeSnapshot.sessionId || null;
  const readSessionId = getCodexRuntimeReadSessionId(runtimeSnapshot);
  const busyStateResolved = runtimeSnapshot.hasWatcher === true
    && runtimeSnapshot.catchUpPending !== true;
  const isBusy = busyStateResolved
    ? runtimeSnapshot.busy === true
    : fallbackBusy === true;

  return {
    complete: true,
    missingFields: [],
    presence: {
      status,
      hasBridge: !!savedSessionId,
      isBusy,
      hasTerm: runtimeSnapshot.hasTerm === true,
      inputReady: status === 'stopping' ? false : runtimeSnapshot.inputReady === true,
      awaiting: false,
      lastNotReady: runtimeSnapshot.lastNotReady || null,
      startupFailed,
      startupError: runtimeSnapshot.startupError || null,
      manualActionRequired,
      ...(runtimeSnapshot.runtimePolicy ? { runtimePolicy: runtimeSnapshot.runtimePolicy } : {}),
      manualActionType: runtimeSnapshot.manualActionType || null,
      lifecycleWarning: runtimeSnapshot.lifecycleWarning || null,
      sessionId,
      conversationMaterialized: runtimeSnapshot.conversationMaterialized === true,
      canResume: status === 'inactive' && !!sessionId,
      canCopySessionId: !!readSessionId,
      timelineCount: Number.isFinite(Number(runtimeSnapshot.timelineCount))
        ? Number(runtimeSnapshot.timelineCount)
        : null,
      materializationReason: runtimeSnapshot.materializationReason || null,
      runtimeSnapshot,
    },
  };
}

export async function readCodexPtyPresence({
  tabId,
  projectId = null,
  invoke,
  fallbackBusy = false,
}) {
  const runtimeSnapshot = await invoke('codex:get-runtime-projection', { tabId, projectId });
  const projected = projectCodexPtyPresence(runtimeSnapshot, { fallbackBusy });
  if (!projected.complete || !projected.presence) {
    const missing = projected.missingFields.length > 0
      ? projected.missingFields.join(',')
      : 'runtime-snapshot-unavailable';
    throw new Error('Incomplete Codex runtime snapshot: ' + missing);
  }
  if (projectId && runtimeSnapshot.projectId !== projectId) {
    throw new Error('Codex runtime snapshot project mismatch');
  }
  return projected.presence;
}
