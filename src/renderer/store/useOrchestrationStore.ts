import { create } from 'zustand';
import {
  isOrchestrationCompletionBlocking,
  isOrchestrationInheritedActivity,
  shouldRetainOrchestrationRun,
} from '../utils/orchestrationRunProjection.mjs';

const { ipcRenderer } = window.require('electron');

export type OrchestrationStatus =
  | 'creating'
  | 'starting'
  | 'sending'
  | 'sent'
  | 'queued'
  | 'running'
  | 'waiting_descendants'
  | 'waiting_recovery'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type OrchestrationOutcome =
  | 'success'
  | 'failed'
  | 'interrupted'
  | 'paused'
  | 'target_closed'
  | 'startup_failed'
  | 'process_exited'
  | 'process_replaced'
  | 'result_unavailable'
  | 'detached'
  | 'unknown';

export type OrchestrationNotificationStatus =
  | 'pending'
  | 'sending'
  | 'audit-pending'
  | 'sent'
  | 'queued'
  | 'waiting-for-input'
  | 'unconfirmed'
  | 'failed'
  | 'suppressed'
  | 'source-closed';

export type OrchestrationResultProofStatus =
  | 'awaiting-transcript'
  | 'awaiting-resumed-turn'
  | 'complete'
  | 'failed'
  | 'paused'
  | 'unavailable';

export type OrchestrationResultErrorCode =
  | 'provider_mismatch'
  | 'session_mismatch'
  | 'execution_identity_incomplete'
  | 'task_started_not_found'
  | 'task_started_ambiguous'
  | 'prompt_identity_required'
  | 'prompt_outside_turn'
  | 'prompt_ambiguous'
  | 'assistant_not_materialized'
  | 'turn_aborted'
  | 'no_final_result'
  | 'result_unavailable'
  | 'result_proof_deadline_elapsed';

export type OrchestrationRun = {
  runId: string;
  label?: string;
  status: OrchestrationStatus;
  outcome?: OrchestrationOutcome | null;
  createdAt: number;
  completedAt?: number | null;
  deliveryAcceptedAt?: number | null;
  deliveryDeferredReason?: string | null;
  targetPromptProofAt?: number | null;
  recoveryDeadlineAt?: number | null;
  pausedAt?: number | null;
  resumedAt?: number | null;
  resumeAfterAt?: number | null;
  resumeAwaitingNewTurn?: boolean;
  sourceTabId: string;
  sourceTabName?: string;
  sourceProjectId: string;
  sourceProjectName?: string;
  sourceProjectPath?: string;
  sourceAcknowledgedAt?: number | null;
  sourceAttentionDismissedAt?: number | null;
  targetTabId: string;
  targetTabName?: string;
  targetProjectId: string;
  targetProjectName?: string;
  targetProjectPath?: string;
  targetToolType?: 'claude' | 'codex';
  targetAcknowledgedAt?: number | null;
  targetAttentionDismissedAt?: number | null;
  parentRunId?: string | null;
  waitForDescendants?: boolean;
  waitingOnRunIds?: string[];
  notificationStatus?: OrchestrationNotificationStatus;
  notificationSuppressed?: boolean;
  notificationAttemptedAt?: number | null;
  notificationDeliveredAt?: number | null;
  notificationDismissedAt?: number | null;
  notificationHandoffId?: string | null;
  notificationCancelRequestedAt?: number | null;
  sourceFollowupPending?: boolean;
  sourceFollowupStartedAt?: number | null;
  attentionRequiredAt?: number | null;
  completionReason?: string | null;
  notificationError?: string | null;
  notificationUnconfirmedAt?: number | null;
  notificationUnconfirmedReason?: string | null;
  resultError?: string | null;
  resultErrorCode?: OrchestrationResultErrorCode | null;
  resultComplete?: boolean;
  resultSourceIdentity?: string | null;
  resultPromptCarrierKind?: 'event' | 'response' | 'user' | null;
  resultProofStatus?: OrchestrationResultProofStatus | null;
  recoveryReason?: string | null;
  error?: string | null;
};

export type OrchestrationRunReleaseKind = 'handoff-started' | 'success' | 'abnormal';

export type OrchestrationRunChange = {
  run: OrchestrationRun;
  previousRun?: OrchestrationRun;
  sourceTabId: string;
  wasCompletionBlocked: boolean;
  completionBlocked: boolean;
  releaseKind: OrchestrationRunReleaseKind | null;
};

type OrchestrationStore = {
  activeRuns: Map<string, OrchestrationRun>;
  inheritedBusyTabIds: Set<string>;
  inheritedBusyProjectIds: Set<string>;
  completionBlockedTabIds: Set<string>;
  initialized: boolean;
  replaceActiveRuns: (runs: OrchestrationRun[]) => void;
  applyRun: (run: OrchestrationRun) => void;
};

const runChangeListeners = new Set<(change: OrchestrationRunChange) => void>();

function projections(runs: Iterable<OrchestrationRun>) {
  const inheritedBusyTabIds = new Set<string>();
  const inheritedBusyProjectIds = new Set<string>();
  const completionBlockedTabIds = new Set<string>();
  for (const run of runs) {
    if (isOrchestrationCompletionBlocking(run)) completionBlockedTabIds.add(run.sourceTabId);
    if (isOrchestrationInheritedActivity(run)) {
      inheritedBusyTabIds.add(run.sourceTabId);
      if (run.sourceProjectId) inheritedBusyProjectIds.add(run.sourceProjectId);
    }
  }
  return { inheritedBusyTabIds, inheritedBusyProjectIds, completionBlockedTabIds };
}

function releaseKindForRun(
  previousRun: OrchestrationRun | undefined,
  run: OrchestrationRun,
): OrchestrationRunReleaseKind {
  if (!previousRun?.sourceFollowupStartedAt && run.sourceFollowupStartedAt) {
    return 'handoff-started';
  }
  if (run.status === 'completed'
    && (run.notificationDismissedAt
      || (run.notificationSuppressed !== true
        && !['failed', 'source-closed', 'suppressed'].includes(run.notificationStatus || '')))) {
    return 'success';
  }
  return 'abnormal';
}

export const useOrchestrationStore = create<OrchestrationStore>((set, get) => ({
  activeRuns: new Map(),
  inheritedBusyTabIds: new Set(),
  inheritedBusyProjectIds: new Set(),
  completionBlockedTabIds: new Set(),
  initialized: false,
  replaceActiveRuns: (runs) => {
    const activeRuns = new Map(
      (Array.isArray(runs) ? runs : [])
        .filter(shouldRetainOrchestrationRun)
        .map((run) => [run.runId, run]),
    );
    set({ activeRuns, ...projections(activeRuns.values()), initialized: true });
  },
  applyRun: (run) => {
    if (!run?.runId) return;
    const previousState = get();
    const previousRun = previousState.activeRuns.get(run.runId);
    const sourceTabId = run.sourceTabId || previousRun?.sourceTabId || '';
    const wasCompletionBlocked = sourceTabId
      ? previousState.completionBlockedTabIds.has(sourceTabId)
      : false;
    const activeRuns = new Map(previousState.activeRuns);
    if (shouldRetainOrchestrationRun(run)) activeRuns.set(run.runId, run);
    else activeRuns.delete(run.runId);
    const nextProjections = projections(activeRuns.values());
    const completionBlocked = sourceTabId
      ? nextProjections.completionBlockedTabIds.has(sourceTabId)
      : false;
    set({ activeRuns, ...nextProjections });

    const releaseKind = wasCompletionBlocked && !completionBlocked
      ? releaseKindForRun(previousRun, run)
      : null;
    if (!sourceTabId || (!releaseKind && wasCompletionBlocked === completionBlocked)) return;
    const change: OrchestrationRunChange = {
      run,
      previousRun,
      sourceTabId,
      wasCompletionBlocked,
      completionBlocked,
      releaseKind,
    };
    for (const listener of runChangeListeners) listener(change);
  },
}));

export function isOrchestrationCompletionBlocked(tabId: string): boolean {
  return useOrchestrationStore.getState().completionBlockedTabIds.has(tabId);
}

export function subscribeOrchestrationRunChanges(
  listener: (change: OrchestrationRunChange) => void,
): () => void {
  runChangeListeners.add(listener);
  return () => runChangeListeners.delete(listener);
}

let initializationPromise: Promise<void> | null = null;
let listenerInstalled = false;

export function initializeOrchestrationStore(): Promise<void> {
  if (!listenerInstalled) {
    listenerInstalled = true;
    ipcRenderer.on('orchestration:changed', (_event: unknown, payload: { run?: OrchestrationRun }) => {
      if (payload?.run) useOrchestrationStore.getState().applyRun(payload.run);
    });
  }
  if (!initializationPromise) {
    initializationPromise = ipcRenderer.invoke('orchestration:list-active')
      .then((runs: OrchestrationRun[]) => {
        useOrchestrationStore.getState().replaceActiveRuns(runs);
      })
      .catch((error: unknown) => {
        console.warn('[OrchestrationStore] initial load failed:', error);
        useOrchestrationStore.getState().replaceActiveRuns([]);
      });
  }
  return initializationPromise;
}
