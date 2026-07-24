import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { isCodexRuntimeWriterUsable } from './codexPtyPresence.mjs';

const { ipcRenderer } = window.require('electron');

export interface CodexRuntimeSessionSnapshot {
  success?: boolean;
  projectId?: string | null;
  sessionId?: string | null;
  displaySessionId?: string | null;
  provenWriterSessionId?: string | null;
  writerSessionId?: string | null;
  knownSessionId?: string | null;
  launchSessionId?: string | null;
  resumeSourceSessionId?: string | null;
  dbSessionId?: string | null;
  savedSessionId?: string | null;
  writerConfirmed?: boolean;
  writerProof?: string | null;
  writerStatus?: string | null;
  writerError?: string | null;
  writerUsableForMutation?: boolean;
  canCopySessionId?: boolean;
  inputReady?: boolean;
  busy?: boolean;
  hasTerm?: boolean;
  lastNotReady?: any;
  startupFailed?: boolean;
  startupError?: string | null;
  manualActionRequired?: boolean;
  manualActionType?: string | null;
  hasWatcher?: boolean;
  catchUpPending?: boolean;
  outcomeKnown?: boolean;
  lastOutcomeReason?: string | null;
  writerSourceMatch?: string | null;
  writerSourceSessionId?: string | null;
  writerForkedFromId?: string | null;
  writerLaunchId?: string | null;
  liveLifecycle?: boolean | null;
  sessionStatus?: 'starting' | 'active' | 'busy' | 'stopping' | 'inactive' | 'unknown' | string;
}

export interface ConfirmedCodexWriterResolution {
  writerSessionId: string;
  relation: 'same-session' | 'current-resume-child';
  snapshot: CodexRuntimeSessionSnapshot;
}

const cleanSessionId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

/**
 * Returns only an identity that main has explicitly proven as the rollout
 * currently opened by this tab's Codex process. Launch/source/DB IDs are
 * deliberately excluded: each can be a valid resume target without being the
 * writer that a destructive Timeline action is allowed to mutate.
 */
export const getConfirmedCodexWriterSessionId = (
  snapshot: CodexRuntimeSessionSnapshot | null | undefined,
): string | null => {
  if (snapshot?.writerConfirmed !== true) return null;
  return cleanSessionId(snapshot.provenWriterSessionId);
};

/** Display-only fallback. Never feed this value into setCodexSessionId. */
export const getCodexDisplaySessionId = (
  snapshot: CodexRuntimeSessionSnapshot | null | undefined,
): string | null => {
  if (snapshot?.liveLifecycle === true) {
    return getConfirmedCodexWriterSessionId(snapshot);
  }
  if (snapshot?.liveLifecycle !== false) return null;
  return cleanSessionId(snapshot?.displaySessionId)
    || cleanSessionId(snapshot?.sessionId)
    || cleanSessionId(snapshot?.dbSessionId);
};

const writerGuardError = (code: string, message: string): Error => {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
};

const readCodexRuntimeSession = async (tabId: string, operation: string): Promise<CodexRuntimeSessionSnapshot> => {
  try {
    const snapshot = await ipcRenderer.invoke('codex:get-runtime-session', tabId) as CodexRuntimeSessionSnapshot | null;
    if (!snapshot || snapshot.success === false) {
      throw new Error('runtime session unavailable');
    }
    return snapshot;
  } catch (error: any) {
    throw writerGuardError(
      'codex_writer_lookup_failed',
      `Не удалось проверить Codex-сессию перед действием «${operation}»: ${error?.message || String(error)}`,
    );
  }
};

export interface CodexSurfaceSessionResolution {
  sessionId: string | null;
  liveLifecycle: boolean | null;
  writerConfirmed: boolean;
  source: 'live-writer' | 'stopped-history' | 'unresolved';
  snapshot: CodexRuntimeSessionSnapshot;
}

/**
 * Read-only/export surfaces use the proven writer while Codex is live and the
 * persisted historical ID only after main has classified the lifecycle as
 * stopped. An unknown live lookup never falls back to stale renderer state.
 */
export const resolveCodexSurfaceSession = async ({
  tabId,
  historicalSessionId,
  operation,
}: {
  tabId: string;
  historicalSessionId?: string | null;
  operation: string;
}): Promise<CodexSurfaceSessionResolution> => {
  const snapshot = await readCodexRuntimeSession(tabId, operation);
  const confirmedWriter = getConfirmedCodexWriterSessionId(snapshot);
  const liveLifecycle = typeof snapshot.liveLifecycle === 'boolean'
    ? snapshot.liveLifecycle
    : snapshot.writerStatus === 'adopted'
      ? true
      : snapshot.writerStatus === 'stopped'
        ? false
        : null;

  if (liveLifecycle === true) {
    const usableWriter = isCodexRuntimeWriterUsable(snapshot, { requireCopy: true })
      && !!confirmedWriter;
    if (!usableWriter) {
      return {
        sessionId: null,
        liveLifecycle,
        writerConfirmed: false,
        source: 'unresolved',
        snapshot,
      };
    }
    const current = useWorkspaceStore.getState().getCodexSessionId?.(tabId) || null;
    if (current !== confirmedWriter) {
      useWorkspaceStore.getState().setCodexSessionId(tabId, confirmedWriter, 'detected');
    }
    return {
      sessionId: confirmedWriter,
      liveLifecycle,
      writerConfirmed: true,
      source: 'live-writer',
      snapshot,
    };
  }

  if (liveLifecycle === false) {
    return {
      sessionId: cleanSessionId(snapshot.sessionId)
        || cleanSessionId(snapshot.dbSessionId)
        || cleanSessionId(historicalSessionId),
      liveLifecycle,
      writerConfirmed: false,
      source: 'stopped-history',
      snapshot,
    };
  }

  return {
    sessionId: null,
    liveLifecycle,
    writerConfirmed: false,
    source: 'unresolved',
    snapshot,
  };
};

export const requireCodexSurfaceSessionId = async (args: {
  tabId: string;
  historicalSessionId?: string | null;
  operation: string;
  requireMutationSafe?: boolean;
}): Promise<string> => {
  const resolved = await resolveCodexSurfaceSession(args);
  if (resolved.sessionId
    && (resolved.liveLifecycle !== true
      || args.requireMutationSafe !== true
      || resolved.snapshot.writerUsableForMutation === true)) {
    return resolved.sessionId;
  }
  throw writerGuardError(
    'codex_surface_session_unresolved',
    `Активная Codex-сессия ещё не подтверждена. Дождитесь окончания загрузки и повторите действие «${args.operation}».`,
  );
};

/**
 * Last renderer-side gate before a Codex history mutation. If main proves a
 * different writer than the Timeline currently displays, adopt that proven ID
 * in Zustand (which causes Timeline to reload) and require a fresh user action;
 * never reinterpret UUIDs selected from the old transcript against the new one.
 */
export const resolveConfirmedCodexWriter = async ({
  tabId,
  expectedSessionId,
  operation,
  currentResumeSourceSessionId,
}: {
  tabId: string;
  expectedSessionId: string | null | undefined;
  operation: string;
  currentResumeSourceSessionId?: string | null;
}): Promise<ConfirmedCodexWriterResolution> => {
  const snapshot = await readCodexRuntimeSession(tabId, operation);

  const writerSessionId = getConfirmedCodexWriterSessionId(snapshot);
  if (!writerSessionId
    || !isCodexRuntimeWriterUsable(snapshot)) {
    throw writerGuardError(
      'codex_writer_unconfirmed',
      `Codex ещё не подтвердил активную сессию. Дождитесь окончания загрузки и повторите действие «${operation}».`,
    );
  }

  const expected = cleanSessionId(expectedSessionId);
  if (expected && writerSessionId === expected) {
    return { writerSessionId, relation: 'same-session', snapshot };
  }

  const allowedResumeSource = cleanSessionId(currentResumeSourceSessionId);
  const provenResumeSource = cleanSessionId(snapshot.writerSourceSessionId);
  const linkedSourceMatch = snapshot.writerSourceMatch === 'direct-fork'
    || snapshot.writerSourceMatch === 'process-owned-descendant';
  const isCurrentResumeChild = !!expected
    && allowedResumeSource === expected
    && provenResumeSource === expected
    && linkedSourceMatch;

  if (!expected || writerSessionId !== expected) {
    useWorkspaceStore.getState().setCodexSessionId(tabId, writerSessionId, 'detected');
    if (isCurrentResumeChild) {
      return { writerSessionId, relation: 'current-resume-child', snapshot };
    }
    throw writerGuardError(
      'codex_writer_changed',
      `Codex переключился на другую сессию. Timeline обновлён — повторите действие «${operation}».`,
    );
  }

  return { writerSessionId, relation: 'same-session', snapshot };
};

export const requireConfirmedCodexWriter = async ({
  tabId,
  expectedSessionId,
  operation,
}: {
  tabId: string;
  expectedSessionId: string | null | undefined;
  operation: string;
}): Promise<string> => {
  const resolved = await resolveConfirmedCodexWriter({
    tabId,
    expectedSessionId,
    operation,
  });
  return resolved.writerSessionId;
};
