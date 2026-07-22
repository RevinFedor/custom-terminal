export const CODEX_PRESENCE_SNAPSHOT_FIELDS = Object.freeze([
  'success',
  'projectId',
  'sessionStatus',
  'busy',
  'inputReady',
  'liveLifecycle',
  'sessionId',
  'savedSessionId',
  'canCopySessionId',
  'hasTerm',
  'lastNotReady',
  'startupFailed',
  'startupError',
  'manualActionRequired',
  'manualActionType',
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
    : manualActionRequired
      ? 'inactive'
      : startupFailed
        ? 'starting'
        : runtimeStatus;
  const savedSessionId = runtimeSnapshot.savedSessionId || null;
  const sessionId = runtimeSnapshot.sessionId || null;
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
      manualActionType: runtimeSnapshot.manualActionType || null,
      sessionId,
      conversationMaterialized: !!savedSessionId,
      canResume: status === 'inactive' && !!sessionId,
      canCopySessionId: runtimeSnapshot.canCopySessionId === true,
      materializationReason: savedSessionId ? 'codex-session-id' : 'no-session-id',
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
  const runtimeSnapshot = await invoke('codex:get-runtime-session', { tabId, projectId });
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
