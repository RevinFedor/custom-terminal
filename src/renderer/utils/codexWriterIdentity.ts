import { useWorkspaceStore } from '../store/useWorkspaceStore';
import {
  getCodexRuntimeForkSourceSessionId,
  getCodexRuntimeReadSessionId,
  isCodexRuntimeWriterUsable,
} from './codexPtyPresence.mjs';

const { ipcRenderer } = window.require('electron');

export interface CodexRuntimeSessionSnapshot {
  success?: boolean;
  projectId?: string | null;
  sessionId?: string | null;
  displaySessionId?: string | null;
  readSessionId?: string | null;
  readIdentitySource?: 'live-writer' | 'resume-source' | 'stopped-history' | 'unresolved' | string;
  readIdentityReason?: string | null;
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
  canForkSnapshot?: boolean;
  forkSnapshotReason?: string | null;
  inputReady?: boolean;
  busy?: boolean;
  hasTerm?: boolean;
  lastNotReady?: any;
  startupFailed?: boolean;
  startupError?: string | null;
  manualActionRequired?: boolean;
  manualActionType?: string | null;
  lifecycleWarning?: {
    id?: string | null;
    type?: string | null;
    code?: string | null;
    message?: string | null;
    detectedAt?: number | null;
  } | null;
  hasWatcher?: boolean;
  catchUpPending?: boolean;
  outcomeKnown?: boolean;
  lastOutcomeReason?: string | null;
  writerSourceMatch?: string | null;
  writerSourceSessionId?: string | null;
  writerForkedFromId?: string | null;
  writerLaunchId?: string | null;
  codexProvisionalSettingsOwnerId?: string | null;
  codexProvisionalSettingsLaunchId?: string | null;
  codexProvisionalModel?: string | null;
  codexProvisionalEffort?: string | null;
  codexProvisionalFast?: boolean;
  codexProvisionalSettingsProofAt?: number | null;
  codexProvisionalSettingsProofSource?: string | null;
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

const readCodexRuntimeSession = async (tabId: string, operation: string, purpose?: 'fork-source'): Promise<CodexRuntimeSessionSnapshot> => {
  try {
    const snapshot = await ipcRenderer.invoke('codex:get-runtime-session', purpose
      ? { tabId, purpose }
      : tabId) as CodexRuntimeSessionSnapshot | null;
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
  source: 'live-writer' | 'resume-source' | 'stopped-history' | 'unresolved';
  snapshot: CodexRuntimeSessionSnapshot;
}

/**
 * Read-only/export surfaces consume only main's explicit read identity. Main
 * may expose an exact idle Resume source before the first submit; that value
 * remains read-only and is never written into the renderer's writer state.
 */
export const resolveCodexSurfaceSession = async ({
  tabId,
  operation,
  purpose,
}: {
  tabId: string;
  operation: string;
  purpose?: 'fork-source';
}): Promise<CodexSurfaceSessionResolution> => {
  const snapshot = await readCodexRuntimeSession(tabId, operation, purpose);
  const confirmedWriter = getConfirmedCodexWriterSessionId(snapshot);
  const readSessionId = getCodexRuntimeReadSessionId(snapshot);
  const liveLifecycle = typeof snapshot.liveLifecycle === 'boolean'
    ? snapshot.liveLifecycle
    : null;

  if (liveLifecycle === true) {
    if (!readSessionId) {
      return {
        sessionId: null,
        liveLifecycle,
        writerConfirmed: false,
        source: 'unresolved',
        snapshot,
      };
    }
    const liveWriterRead = snapshot.readIdentitySource === 'live-writer'
      && isCodexRuntimeWriterUsable(snapshot, { requireCopy: true })
      && confirmedWriter === readSessionId;
    if (snapshot.readIdentitySource !== 'resume-source' && !liveWriterRead) {
      return {
        sessionId: null,
        liveLifecycle,
        writerConfirmed: false,
        source: 'unresolved',
        snapshot,
      };
    }
    if (liveWriterRead) {
      const current = useWorkspaceStore.getState().getCodexSessionId?.(tabId) || null;
      if (current !== confirmedWriter) {
        useWorkspaceStore.getState().setCodexSessionId(tabId, confirmedWriter, 'detected');
      }
    }
    return {
      sessionId: readSessionId,
      liveLifecycle,
      writerConfirmed: liveWriterRead,
      source: liveWriterRead ? 'live-writer' : 'resume-source',
      snapshot,
    };
  }

  if (liveLifecycle === false) {
    return {
      sessionId: readSessionId,
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
  operation: string;
  requireMutationSafe?: boolean;
}): Promise<string> => {
  const resolved = await resolveCodexSurfaceSession(args);
  if (resolved.sessionId
    && (resolved.liveLifecycle !== true
      || args.requireMutationSafe !== true
      || (resolved.source === 'live-writer'
        && isCodexRuntimeWriterUsable(resolved.snapshot)))) {
    return resolved.sessionId;
  }
  throw writerGuardError(
    'codex_surface_session_unresolved',
    `Активная история Codex ещё не подтверждена. Дождитесь её появления и повторите действие «${args.operation}».`,
  );
};

/**
 * Resolve the immutable source snapshot for Codex Fork/Compact Fork. An exact
 * idle Resume source is sufficient even before the first writer event because
 * Fork never mutates that source. The returned ID remains read authority only;
 * this helper does not adopt it as a writer or unlock destructive mutations.
 */
export const requireCodexForkSourceSessionId = async (args: {
  tabId: string;
  operation: string;
}): Promise<string> => {
  const resolved = await resolveCodexSurfaceSession({ ...args, purpose: 'fork-source' });
  const sourceSessionId = getCodexRuntimeForkSourceSessionId(resolved.snapshot);
  if (sourceSessionId && sourceSessionId === resolved.sessionId) return sourceSessionId;
  const reason = resolved.snapshot.forkSnapshotReason || resolved.snapshot.readIdentityReason || 'unresolved';
  const detail = reason === 'history-session-empty'
    ? 'В сохранённой сессии нет пользовательской истории.'
    : reason === 'fork-source-changed-during-read'
      ? 'Исходная сессия или ввод изменились во время проверки. Повторите Fork.'
      : reason === 'composer-not-ready'
        ? 'Дождитесь завершения текущего запуска Codex.'
        : 'Не удалось проверить сохранённую историю. Причина: ' + reason + '.';
  console.warn('[CodexForkSource] refused tab=' + args.tabId + ' reason=' + reason);
  throw writerGuardError(
    'codex_fork_source_unresolved',
    `Не удалось выполнить «${args.operation}». ${detail}`,
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
