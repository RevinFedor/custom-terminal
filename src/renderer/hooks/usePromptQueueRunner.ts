import { useEffect } from 'react';
import { buildQueuedPromptPayload, consumeAutomaticRunAfterTargetClear, countEnabledQueuedPrompts, ensureQueuedPromptImagesReady, hasMalformedQueuedImageMarker, hasPendingPromptQueueContinuation, hasRuntimeWorkflowArm, isPromptQueueEditorLocked, isPromptQueueStoreHydrated, isQueuedPromptEnabled, queueSendTransferredOwnership, subscribePromptQueueEditorLocks, subscribePromptQueueHydration, usePromptQueueStore, type QueuedPrompt, type TabQueue } from '../store/usePromptQueueStore';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { terminalRegistry } from '../utils/terminalRegistry';
import { isNaturalAgentTurnEndReason } from '../utils/agentCompletionOutcome.mjs';
import { isWorkflowOutcomeAtOrAfterArm, planWorkflowReconciliation } from '../utils/promptQueueReconciliation.mjs';
import { getHistoryAgentRuntime } from '../utils/historyAgentRuntimes';
import { getClaudeStartupDefaultsGateSnapshot } from '../utils/claudeStartupDefaultsGate';

const { ipcRenderer } = window.require('electron');

// Walk openProjects → find the project that owns this tab. Used after stopAfter
// fires when closeAfter is also armed — we need both ids to call closeTab.
// O(N) but openProjects rarely has more than a handful of entries.
function findProjectIdForTab(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const [projId, ws] of state.openProjects) {
    if (ws.tabs.has(tabId)) return projId;
  }
  return null;
}

// True if `tabId` exists in any open project workspace. Used to validate stale
// runAfterTabId values (target tab was closed) — without this the runner would
// wait forever for a dead tab's busy→idle edge.
function tabExists(tabId: string): boolean {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    if (ws.tabs.has(tabId)) return true;
  }
  return false;
}

function canValidateQueueTabs(): boolean {
  const state = useWorkspaceStore.getState();
  return isPromptQueueStoreHydrated() && !state.isRestoring && state.openProjects.size > 0;
}

function tabCanTriggerQueue(ownerTabId: string, targetTabId: string): boolean {
  if (ownerTabId === targetTabId) return false;
  return tabExists(targetTabId);
}

function workspaceTabBusyNow(tabId: string): boolean {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (!tab) continue;
    const sdkBusy = tab.tabType === 'claude-sdk' && (
      tab.sdkState === 'fetching' ||
      tab.sdkState === 'thinking' ||
      tab.sdkState === 'tool_use'
    );
    return !!(tab.aiBusy || tab.claudeBusy || sdkBusy);
  }
  return false;
}

function seedBusySnapshotFromWorkspace(tabId: string): void {
  if (prevBusyRef.has(tabId)) return;
  if (!workspaceTabBusyNow(tabId)) return;
  prevBusyRef.set(tabId, true);
  console.log('[PromptQueueRunner] seed busy snapshot from workspace tab=' + tabId.slice(-12));
}

type QueueAgent = 'claude' | 'codex';

function getPromptQueueAgent(tabId: string): QueueAgent {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (!tab) continue;
    if (tab.commandType === 'codex') return 'codex';
    if (tab.commandType !== 'claude' && tab.codexSessionId && !tab.claudeSessionId) return 'codex';
    return 'claude';
  }
  return 'claude';
}

function getWorkspaceCommandType(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (tab) return tab.commandType || null;
  }
  return null;
}

function getPromptQueueAgentLabel(tabId: string): string {
  return getPromptQueueAgent(tabId) === 'codex' ? 'Codex' : 'Claude';
}

function sendQueueCommand(tabId: string, payload: string): Promise<unknown> {
  const agent = getPromptQueueAgent(tabId);
  const channel = agent === 'codex' ? 'codex:send-command' : 'claude:send-command';
  const isSlashCommand = String(payload || '').trimStart().startsWith('/');
  const options = {
    source: 'prompt-queue',
    awaitUserMessageAudit: agent === 'claude' && !isSlashCommand,
  };
  const term = terminalRegistry.get(tabId);
  const before = typeof document !== 'undefined' ? document.activeElement?.tagName?.toLowerCase() || '-' : '-';
  try { term?.focus(); } catch {}
  const after = typeof document !== 'undefined' ? document.activeElement?.tagName?.toLowerCase() || '-' : '-';
  console.log('[PromptQueueRunner] focus before send tab=' + tabId.slice(-8) + ' agent=' + agent + ' hadTerm=' + !!term + ' active=' + before + '→' + after + ' slash=' + isSlashCommand + ' awaitAudit=' + options.awaitUserMessageAudit);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      try { terminalRegistry.get(tabId)?.focus(); } catch {}
    });
  }
  return ipcRenderer.invoke(channel, tabId, payload, options);
}

type EffectiveTriggerOptions = { clearStaleTarget?: boolean };
type QueueStateSnapshot = { queues: Map<string, TabQueue> };

function getEffectiveQueueTrigger(ownerTabId: string, queue: TabQueue, options: EffectiveTriggerOptions = {}): string {
  if (queue.runAfterTabId && !canValidateQueueTabs()) {
    return queue.runAfterTabId;
  }
  if (queue.runAfterTabId && tabCanTriggerQueue(ownerTabId, queue.runAfterTabId)) {
    return queue.runAfterTabId;
  }
  if (queue.runAfterTabId && options.clearStaleTarget) {
    console.warn('[PromptQueueRunner] runAfterTabId ' + queue.runAfterTabId.slice(-8) + ' is no longer a valid target, clearing → owner=' + ownerTabId.slice(-8));
    usePromptQueueStore.getState().clearStaleRunAfterTab(ownerTabId, queue.runAfterTabId);
  }
  return ownerTabId;
}

function shortQueueTabId(tabId: string | null | undefined): string {
  return tabId ? String(tabId).slice(-8) : '-';
}

function describeQueueForLog(ownerTabId: string, queue: TabQueue, triggerTabId: string): string {
  const enabled = countEnabledQueuedPrompts(queue.items);
  const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue);
  return [
    'owner=' + shortQueueTabId(ownerTabId),
    'auto=' + (queue.autoRun ? '1' : '0'),
    'items=' + queue.items.length,
    'enabled=' + enabled,
    'target=' + shortQueueTabId(queue.runAfterTabId || ownerTabId),
    'eff=' + shortQueueTabId(effectiveTrigger),
    'matches=' + (effectiveTrigger === triggerTabId ? '1' : '0'),
    'ownerBusy=' + (prevBusyRef.get(ownerTabId) === true ? '1' : '0'),
    'triggerSeen=' + (prevBusyRef.has(effectiveTrigger) ? '1' : '0'),
    'triggerBusy=' + (prevBusyRef.get(effectiveTrigger) === true ? '1' : '0'),
    'inflight=' + (queueSendInflight.has(ownerTabId) ? '1' : '0'),
    'awaitStart=' + (queueAwaitingBusyStart.has(ownerTabId) ? '1' : '0'),
  ].join(',');
}

function describeQueuesForTriggerLog(triggerTabId: string): string {
  const queues = usePromptQueueStore.getState().queues;
  const parts: string[] = [];
  for (const [ownerTabId, queue] of queues) {
    if (
      ownerTabId !== triggerTabId &&
      queue.runAfterTabId !== triggerTabId &&
      !queue.autoRun &&
      queue.items.length === 0 &&
      !queue.stopAfter &&
      queue.firstDelayCountdownAt === null
    ) continue;
    parts.push(describeQueueForLog(ownerTabId, queue, triggerTabId));
  }
  return parts.length > 0 ? parts.join(' | ') : 'none';
}

// When the per-tab post-prompt toggle is ON and post-prompt text is non-empty,
// every fired queue item gets the post-prompt appended after a blank-line
// separator. Empty text is treated as disabled (no glue line, no warning).
// Single chokepoint: every send-command call from the runner goes through this.
function withPostPrompt(tabId: string, body: string): string {
  const q = usePromptQueueStore.getState().getQueue(tabId);
  if (!q.postPromptEnabled) return body;
  const post = q.postPromptText;
  if (!post || !post.trim()) return body;
  return body + '\n\n' + post;
}

// Module-scoped per-tab previous busy state. Lives OUTSIDE React state so that
// re-mounts of the hook don't reset busy tracking (which would re-introduce the
// stale-state bug that prompted moving the runner out of the overlay in the
// first place). Written by the busy-state IPC handler, read by both the
// turn-end handler AND the cold-start subscription — they must share the same
// truth or edges get double-counted / missed.
const prevBusyRef = new Map<string, boolean>();
const queueSendInflight = new Set<string>();
// An unlock is only a retry signal when a concrete send attempt actually hit
// the editor lock. Merely opening/editing a queue item must not synthesize a
// cold-start edge or bypass first-delay / pivot readiness.
const queueEditorBlockedOwners = new Set<string>();
// After send-command resolves successfully there is a short event gap before
// the agent emits busy:true. Keep pivoted owners blocked through that gap.
const queueAwaitingBusyStart = new Set<string>();
const codexTriggerCheckInflight = new Set<string>();
type DeferredOwnerSend = {
  triggerTabId: string;
  headId: string;
  label: 'turn-end' | 'cold-start';
  workflowArmedAt: number | null;
  attemptId: number;
};
// A trigger can be fully satisfied while the queue owner is stopped. Keep that
// result separate from `queueAwaitingBusyStart` (which means Enter was already
// accepted) and retry exactly once when the owner's TUI becomes input-ready.
const deferredOwnerSends = new Map<string, DeferredOwnerSend>();
const claudeQueueStartupPending = new Set<string>();
const queueReadinessWakePending = new Map<string, string>();
const queueOwnerReadinessListeners = new Set<(ownerTabId: string, source: string) => void>();
let queueSendAttemptSequence = 0;

function signalQueueOwnerReadiness(ownerTabId: string, source: string): void {
  retryDeferredOwnerSend(ownerTabId, source);
  for (const listener of queueOwnerReadinessListeners) listener(ownerTabId, source);
}

function subscribeQueueOwnerReadiness(
  listener: (ownerTabId: string, source: string) => void,
): () => void {
  queueOwnerReadinessListeners.add(listener);
  return () => queueOwnerReadinessListeners.delete(listener);
}

async function readQueueOwnerReadiness(ownerTabId: string): Promise<{
  ready: boolean;
  status: string;
  inputReady: boolean;
  reason: string;
}> {
  const agent = getPromptQueueAgent(ownerTabId);
  if (agent === 'claude') {
    const gate = getClaudeStartupDefaultsGateSnapshot(ownerTabId);
    if (claudeQueueStartupPending.has(ownerTabId) || gate?.status === 'pending' || gate?.status === 'failed') {
      return {
        ready: false,
        status: gate?.status || 'starting',
        inputReady: false,
        reason: 'claude-startup-defaults-' + (gate?.status || 'pending'),
      };
    }
  }

  try {
    const presence = await getHistoryAgentRuntime(agent).getPresence(
      ownerTabId,
      findProjectIdForTab(ownerTabId),
    );
    const ready = presence.status === 'active'
      && presence.inputReady === true
      && presence.isBusy !== true;
    return {
      ready,
      status: presence.status,
      inputReady: presence.inputReady === true,
      reason: ready ? 'input-ready' : 'runtime-not-ready',
    };
  } catch (error: any) {
    console.warn('[PromptQueueRunner] owner readiness unknown owner=' + ownerTabId.slice(-8)
      + ' error=' + String(error?.message || error));
    return { ready: false, status: 'unknown', inputReady: false, reason: 'presence-unknown' };
  }
}

function clearDeferredOwnerSend(ownerTabId: string, reason: string): void {
  queueReadinessWakePending.delete(ownerTabId);
  if (!deferredOwnerSends.delete(ownerTabId)) return;
  console.log('[PromptQueueRunner] deferred owner cleared owner=' + ownerTabId.slice(-8) + ' reason=' + reason);
}

function deferredOwnerAttemptIsCurrent(
  ownerTabId: string,
  attempt: DeferredOwnerSend,
): boolean {
  if (deferredOwnerSends.get(ownerTabId) !== attempt) return false;
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
  const head = queue.items.find(isQueuedPromptEnabled);
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    return false;
  }
  return queue.autoRun
    && head?.id === attempt.headId
    && queue.workflowArmedAt === attempt.workflowArmedAt
    && getEffectiveQueueTrigger(ownerTabId, queue) === attempt.triggerTabId;
}

function clearDeferredOwnerAttempt(
  ownerTabId: string,
  attempt: DeferredOwnerSend,
  reason: string,
): void {
  if (deferredOwnerSends.get(ownerTabId) !== attempt) return;
  clearDeferredOwnerSend(ownerTabId, reason);
}

function retryDeferredOwnerSend(ownerTabId: string, source: string): boolean {
  const deferred = deferredOwnerSends.get(ownerTabId);
  if (!deferred) return false;
  if (queueSendInflight.has(ownerTabId)) {
    queueReadinessWakePending.set(ownerTabId, source);
    console.log('[PromptQueueRunner] latch readiness wake owner=' + ownerTabId.slice(-8)
      + ' source=' + source + ' attempt=' + deferred.attemptId);
    return false;
  }
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
  const head = queue.items.find(isQueuedPromptEnabled);
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    return false;
  }
  const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
  if (!queue.autoRun
    || !head
    || head.id !== deferred.headId
    || queue.workflowArmedAt !== deferred.workflowArmedAt
    || effectiveTrigger !== deferred.triggerTabId) {
    clearDeferredOwnerSend(ownerTabId, 'stale:' + source);
    return false;
  }
  if (prevBusyRef.get(ownerTabId) === true) return false;
  console.log('[PromptQueueRunner] retry deferred owner=' + ownerTabId.slice(-8)
    + ' trigger=' + deferred.triggerTabId.slice(-8) + ' source=' + source);
  return beginValidatedQueueSend(ownerTabId, deferred.triggerTabId, head, deferred.label);
}

function pruneDeferredOwnerSends(): void {
  for (const [ownerTabId, deferred] of deferredOwnerSends) {
    const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
    const head = queue.items.find(isQueuedPromptEnabled);
    const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
    if (!queue.autoRun
      || !head
      || head.id !== deferred.headId
      || queue.workflowArmedAt !== deferred.workflowArmedAt
      || effectiveTrigger !== deferred.triggerTabId) {
      clearDeferredOwnerSend(ownerTabId, 'queue-changed');
    }
  }
}

function queueOwnerHasPendingContinuation(ownerTabId: string): boolean {
  if (queueAwaitingBusyStart.has(ownerTabId)
    || queueSendInflight.has(ownerTabId)
    || deferredOwnerSends.has(ownerTabId)) return true;
  return hasPendingPromptQueueContinuation(usePromptQueueStore.getState().getQueue(ownerTabId));
}

function beginValidatedQueueSend(
  ownerTabId: string,
  triggerTabId: string,
  head: QueuedPrompt,
  label: 'turn-end' | 'cold-start',
): boolean {
  if (queueSendInflight.has(ownerTabId)) return false;
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8)
      + ' editor payload locked → wait before firing');
    return false;
  }
  const queueAtStart = usePromptQueueStore.getState().getQueue(ownerTabId);
  const headAtStart = queueAtStart.items.find(isQueuedPromptEnabled);
  if (!queueAtStart.autoRun
    || headAtStart?.id !== head.id
    || getEffectiveQueueTrigger(ownerTabId, queueAtStart, { clearStaleTarget: true }) !== triggerTabId) {
    return false;
  }
  queueSendInflight.add(ownerTabId);
  const attempt: DeferredOwnerSend = {
    triggerTabId,
    headId: head.id,
    label,
    workflowArmedAt: queueAtStart.workflowArmedAt,
    attemptId: ++queueSendAttemptSequence,
  };
  deferredOwnerSends.set(ownerTabId, attempt);
  const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
  console.log('[PromptQueueRunner] ' + label + ' validate owner=' + ownerTabId.slice(-8)
    + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8) + ' item=' + head.id.slice(-8));

  void (async () => {
    const readiness = await readQueueOwnerReadiness(ownerTabId);
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'readiness-became-stale');
      return;
    }
    if (!readiness.ready) {
      console.log('[PromptQueueRunner] ' + label + ' owner=' + ownerTabId.slice(-8)
        + ' trigger=' + triggerTabId.slice(-8)
        + ' → WAIT owner readiness status=' + readiness.status
        + ' inputReady=' + readiness.inputReady
        + ' reason=' + readiness.reason);
      return;
    }

    const validation = await ensureQueuedPromptImagesReady(ownerTabId, head.id);
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'attachment-validation-became-stale');
      return;
    }
    if (!validation.ready || !validation.item) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'attachment-validation-refused');
      const store = usePromptQueueStore.getState();
      store.setAutoRun(ownerTabId, false);
      store.setStopAfter(ownerTabId, false);
      const malformedMarker = validation.item
        ? hasMalformedQueuedImageMarker(validation.item.text, validation.item.imagePaths)
        : false;
      useUIStore.getState().showToast(
        malformedMarker
          ? 'Run after остановлен: метка изображения повреждена'
          : 'Run after остановлен: файл изображения недоступен',
        'error',
        5000,
        false,
        undefined,
        undefined,
        undefined,
        ownerTabId,
      );
      console.warn('[PromptQueueRunner] ' + label + ' attachment validation refused owner=' + ownerTabId.slice(-8)
        + ' item=' + head.id.slice(-8) + ' state=' + validation.state);
      return;
    }

    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'validation-became-stale');
      return;
    }
    const latestQueue = usePromptQueueStore.getState().getQueue(ownerTabId);
    const latestHead = latestQueue.items.find(isQueuedPromptEnabled);
    if (prevBusyRef.get(ownerTabId) === true) {
      console.log('[PromptQueueRunner] ' + label + ' validation became stale owner=' + ownerTabId.slice(-8)
        + ' expected=' + head.id.slice(-8) + ' actual=' + (latestHead?.id.slice(-8) || '-'));
      return;
    }

    queueAwaitingBusyStart.add(ownerTabId);
    const payload = withPostPrompt(ownerTabId, buildQueuedPromptPayload(validation.item));
    const beforeCount = countEnabledQueuedPrompts(latestQueue.items);
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-boundary-became-stale');
      return;
    }
    console.log('[PromptQueueRunner] ' + label + ' fire owner=' + ownerTabId.slice(-8)
      + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8) + ' remaining=' + Math.max(0, beforeCount - 1));
    const res: any = await sendQueueCommand(ownerTabId, payload);
    if (!queueSendTransferredOwnership(res)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
        clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-response-became-stale');
        console.log('[PromptQueueRunner] ' + label + ' ignored stale refused response owner=' + ownerTabId.slice(-8)
          + ' attempt=' + attempt.attemptId + ' error=' + (res?.error || 'unknown'));
        return;
      }
      if (res?.deferred === true || res?.error === 'codex_input_not_ready') {
        console.log('[PromptQueueRunner] ' + label + ' owner=' + ownerTabId.slice(-8)
          + ' → WAIT main readiness admission error=' + (res?.error || 'not-ready'));
        return;
      }
      clearDeferredOwnerSend(ownerTabId, 'send-refused');
      const store = usePromptQueueStore.getState();
      store.setAutoRun(ownerTabId, false);
      store.setStopAfter(ownerTabId, false);
      console.error('[PromptQueueRunner] ' + label + ' send refused owner=' + ownerTabId, res?.error);
      return;
    }
    if (res && res.success === false && res.submitted === true) {
      console.warn('[PromptQueueRunner] ' + label + ' submitted but audit unverified owner=' + ownerTabId.slice(-8)
        + ' trigger=' + triggerTabId.slice(-8) + ' error=' + (res.error || 'unknown'));
    }
    const committed = usePromptQueueStore.getState().commitSentHead(ownerTabId, head.id, triggerTabId);
    clearDeferredOwnerSend(ownerTabId, 'committed');
    console.log('[PromptQueueRunner] ' + label + ' commit owner=' + ownerTabId.slice(-8)
      + ' trigger=' + triggerTabId.slice(-8) + ' removed=' + committed.removed
      + ' targetCleared=' + committed.targetCleared + ' before=' + committed.beforeCount);
  })().catch((error: unknown) => {
    queueAwaitingBusyStart.delete(ownerTabId);
    const current = deferredOwnerAttemptIsCurrent(ownerTabId, attempt);
    clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-error');
    if (current) {
      const store = usePromptQueueStore.getState();
      store.setAutoRun(ownerTabId, false);
      store.setStopAfter(ownerTabId, false);
    }
    console.error('[PromptQueueRunner] ' + label + ' validated send failed owner=' + ownerTabId, error);
  }).finally(() => {
    queueSendInflight.delete(ownerTabId);
    const wakeSource = queueReadinessWakePending.get(ownerTabId) || null;
    queueReadinessWakePending.delete(ownerTabId);
    if (wakeSource && deferredOwnerSends.has(ownerTabId)) {
      retryDeferredOwnerSend(ownerTabId, 'latched:' + wakeSource);
    }
  });
  return true;
}

type BusyStatePayload = {
  tabId: string;
  busy: boolean;
  reason?: string;
  localCommand?: string;
  localCommandReason?: string;
  outcomeKnown?: boolean;
  catchUpPending?: boolean;
  outcomeTs?: number | null;
  turnId?: string | null;
  lastOutcomeReason?: string | null;
  lastOutcomeTs?: number | null;
  lastOutcomeTurnId?: string | null;
  lastAbnormalOutcomeReason?: string | null;
  lastAbnormalOutcomeTs?: number | null;
  lastAbnormalOutcomeTurnId?: string | null;
};

type DeferredWorkflowOutcome = BusyStatePayload & { receivedAt: number };
type DeferredWorkflowOutcomeSet = {
  latest: DeferredWorkflowOutcome | null;
  abnormal: DeferredWorkflowOutcome | null;
};
const deferredWorkflowOutcomes = new Map<string, DeferredWorkflowOutcomeSet>();
const processedNaturalOutcomes = new Map<string, { latestTs: number; keys: Set<string> }>();
const workflowRestoreReconciliationListeners = new Set<() => void>();
let workflowRestoreReconciled = false;
let workflowRestoreReconcilePromise: Promise<void> | null = null;

function explicitOutcomeTimestamp(data: BusyStatePayload): number | null {
  if (Number.isFinite(data.outcomeTs)) return Number(data.outcomeTs);
  if (Number.isFinite(data.lastOutcomeTs)) return Number(data.lastOutcomeTs);
  return null;
}

function liveOutcomeTimestamp(data: BusyStatePayload): number {
  return explicitOutcomeTimestamp(data) ?? Date.now();
}

function isAbnormalWorkflowOutcome(data: BusyStatePayload): boolean {
  return !isNaturalAgentTurnEndReason(data.reason) && !isSuccessfulCompactLocalCommandEnd(data);
}

function rememberDeferredWorkflowOutcome(data: BusyStatePayload): void {
  const receivedAt = liveOutcomeTimestamp(data);
  const deferred = { ...data, outcomeTs: receivedAt, receivedAt };
  const current = deferredWorkflowOutcomes.get(data.tabId) ?? { latest: null, abnormal: null };
  if (!current.latest || receivedAt >= current.latest.receivedAt) current.latest = deferred;
  if (isAbnormalWorkflowOutcome(data)
    && (!current.abnormal || receivedAt >= current.abnormal.receivedAt)) {
    current.abnormal = deferred;
  }
  deferredWorkflowOutcomes.set(data.tabId, current);
  console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
    + ' reason=' + (data.reason || '-')
    + ' outcomeTs=' + receivedAt
    + ' → DEFER workflow outcome until workspace+queue hydration');
}

function applyAbnormalQueueOutcome(
  data: BusyStatePayload,
  source: string,
  outcomeTs: number | null = explicitOutcomeTimestamp(data),
): string[] {
  const queueState = usePromptQueueStore.getState();
  for (const ownerTabId of queueState.queues.keys()) {
    if (!tabExists(ownerTabId)) queueState.cleanupClosedTab(ownerTabId);
  }
  const disarmedOwners = usePromptQueueStore.getState().disarmQueuesForTrigger(data.tabId, outcomeTs);
  console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
    + ' reason=' + (data.reason || '-')
    + ' outcomeTs=' + outcomeTs
    + ' source=' + source
    + ' → DISARM trigger workflow owners=' + (disarmedOwners.length ? disarmedOwners.map(shortQueueTabId).join(',') : 'none/newer-arm'));
  return disarmedOwners;
}

const SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS = new Set([
  'compact_boundary',
  'compact_summary',
  'compact_stdout',
  'pty-output-compacted',
]);

function isSuccessfulCompactLocalCommandEnd(data: BusyStatePayload): boolean {
  return data.reason === 'local-command' &&
    data.busy === false &&
    data.localCommand === '/compact' &&
    SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS.has(data.localCommandReason || '');
}

function hasActiveQueueWorkflow(queue: TabQueue): boolean {
  return queue.autoRun
    || queue.stopAfter
    || queue.closeAfter
    || queue.firstDelayCountdownAt !== null;
}

function workflowAcceptsNaturalOutcome(queue: TabQueue, outcomeTs: number | null): boolean {
  return isWorkflowOutcomeAtOrAfterArm(queue.workflowArmedAt, outcomeTs);
}

function naturalOutcomeKey(data: BusyStatePayload, outcomeTs: number): string {
  return data.tabId + ':' + outcomeTs + ':' + (data.turnId || data.lastOutcomeTurnId || data.reason || 'natural');
}

function markWorkflowRestoreReconciled(): void {
  if (workflowRestoreReconciled) return;
  workflowRestoreReconciled = true;
  for (const listener of workflowRestoreReconciliationListeners) listener();
}

function subscribeWorkflowRestoreReconciliation(listener: () => void): () => void {
  workflowRestoreReconciliationListeners.add(listener);
  return () => workflowRestoreReconciliationListeners.delete(listener);
}

function canProcessWorkflowOutcomes(): boolean {
  return workflowRestoreReconciled && canValidateQueueTabs();
}

// Public accessor — the overlay reads this to render the "target tab is busy
// now" spinner inside the Run-after dropdown. Not used by the runner itself.
export function isTabBusyNow(tabId: string): boolean {
  return prevBusyRef.get(tabId) === true;
}

// Snapshot of the current per-tab busy map. The Run-after picker SEEDS its local
// React state from this ON MOUNT. Critical: the picker overlay mounts/unmounts
// with the active Claude tab (Terminal.tsx gate), so subscribing only to FUTURE
// busy edges misses the busy:true that already fired on a background target —
// the spinner then appears only at a late turn-end flap, if at all. This
// always-on runner (App-root) records every edge into prevBusyRef regardless of
// focus, so seeding from it gives the picker the correct state at mount time.
export function getBusyTabsSnapshot(): Map<string, boolean> {
  return new Map(prevBusyRef);
}

// Always-mounted auto-runner for the per-tab prompt queue. Mounted ONCE at app
// root (App.tsx) so it survives tab switches, project switches, view changes —
// anywhere the user could navigate away from the overlay component itself.
//
// Subscribes to three busy-state channels:
//   - claude:busy-state      — PTY claude tabs + SDK tabs forwarded by main
//                              (main.js::ipcMain.on('claude-sdk:busy-state'))
//   - gemini:busy-state      — Gemini PTY tabs
//   - codex:busy-state       — Codex rollout JSONL turn watcher
// Both feed into the same per-tab `prevBusyRef` map keyed by tabId. From the
// runner's POV "any agent on tab X is busy" is a single bit — the user picks
// a TAB to wait on, not a specific engine.
//
// Two firing paths exist:
//   (1) Own-tab edge (default): queue lives on tab A, user did NOT pick a
//       target → wait for busy→idle on tab A itself. Identical to old behaviour.
//   (2) Target-tab edge: queue lives on tab A, user picked tab B in dropdown →
//       wait for busy→idle on tab B. When that fires, popNext from queue on
//       tab A and send-command to tab A (NOT to tab B — the queue items belong
//       to A, B is just the trigger source).
//
// Lookup direction inverted vs default: the IPC handler doesn't know "which
// queue is waiting on me?" by tabId alone — we have to walk all queues each
// busy event. O(N) but N = number of armed Run-after queues, usually 0-3.
export function usePromptQueueRunner() {
  useEffect(() => {
    // Shared firing logic — pops head, sends to OWNER tab, auto-disarms on last.
    // ownerTabId = which queue's head to pop (always the queue-owner, never the
    // trigger tab). triggerTabId is only used for diagnostics in logs.
    const fireQueueOwner = (ownerTabId: string, triggerTabId: string): boolean => {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const beforePop = countEnabledQueuedPrompts(queue.items);
      if (!queue.autoRun || beforePop === 0) return false;
      if (queueSendInflight.has(ownerTabId)) return false;
      if (prevBusyRef.get(ownerTabId) === true) {
        console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8) + ' is busy → wait before firing trigger=' + triggerTabId.slice(-8));
        return false;
      }

      const head = queue.items.find(isQueuedPromptEnabled);
      if (!head) return false;
      return beginValidatedQueueSend(ownerTabId, triggerTabId, head, 'turn-end');
    };

    const getReadyTriggerForOwner = (ownerTabId: string): string | null => {
      if (!canValidateQueueTabs()) return null;
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (!queue.autoRun || countEnabledQueuedPrompts(queue.items) === 0) return null;
      if (queueAwaitingBusyStart.has(ownerTabId)) return ownerTabId;
      if (queueSendInflight.has(ownerTabId)) return ownerTabId;
      if (prevBusyRef.get(ownerTabId) === true) return null;

      const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
      if (effectiveTrigger === ownerTabId) return ownerTabId;

      // Pivoted queue can only fire when its target has a real idle snapshot.
      // No busy history means "wait for the first busy→idle edge", not "idle".
      if (!prevBusyRef.has(effectiveTrigger)) return null;
      if (prevBusyRef.get(effectiveTrigger) === true) return null;
      return effectiveTrigger;
    };

    const unsubscribeEditorLocks = subscribePromptQueueEditorLocks((ownerTabId, lock, options) => {
      if (lock) return;
      if (options.wakeAutoRun === false) {
        queueEditorBlockedOwners.delete(ownerTabId);
        return;
      }
      if (!queueEditorBlockedOwners.delete(ownerTabId)) return;
      const triggerTabId = getReadyTriggerForOwner(ownerTabId);
      if (!triggerTabId) return;
      console.log('[PromptQueueRunner] editor payload unlocked owner='
        + ownerTabId.slice(-8) + ' → retry');
      fireHead(ownerTabId, triggerTabId);
    });

    // Walk all queues, find one(s) waiting on `triggerTabId` for turn-end edge.
    // For default (runAfterTabId === null) the owner IS the trigger. For
    // pivoted (runAfterTabId !== null) the owner is some OTHER tab whose queue
    // wants this tab's transition.
    const findOwnersWaitingOn = (triggerTabId: string, outcomeTs: number | null = null): string[] => {
      if (!canValidateQueueTabs()) return [];
      const owners: string[] = [];
      const queues = usePromptQueueStore.getState().queues;
      for (const [ownerTabId, q] of queues) {
        if (!tabExists(ownerTabId)) {
          usePromptQueueStore.getState().cleanupClosedTab(ownerTabId);
          continue;
        }
        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) continue;
        if (outcomeTs !== null && !workflowAcceptsNaturalOutcome(q, outcomeTs)) continue;
        // Validate stale target before pivoting — if the picked tab was closed,
        // self-clear and fall through to default own-tab behaviour. This is
        // the lazy validation promised in the store schema comment.
        const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, q, { clearStaleTarget: true });
        if (effectiveTrigger === triggerTabId) owners.push(ownerTabId);
      }
      return owners;
    };

    const processSuccessfulWorkflowOutcome = (
      data: BusyStatePayload,
      source: string,
      explicitTs: number | null = explicitOutcomeTimestamp(data),
    ): void => {
      if (!Number.isFinite(explicitTs)) {
        console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
          + ' reason=' + (data.reason || 'natural')
          + ' source=' + source + ' → WAIT natural outcome without timestamp');
        return;
      }
      const outcomeTs = Number(explicitTs);
      if (prevBusyRef.get(data.tabId) === true) {
        console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
          + ' source=' + source + ' has a newer busy turn → WAIT');
        return;
      }
      const key = naturalOutcomeKey(data, outcomeTs);
      const processed = processedNaturalOutcomes.get(data.tabId);
      if (processed && outcomeTs < processed.latestTs) return;
      if (processed?.latestTs === outcomeTs && processed.keys.has(key)) return;
      if (!processed || outcomeTs > processed.latestTs) {
        processedNaturalOutcomes.set(data.tabId, { latestTs: outcomeTs, keys: new Set([key]) });
      } else {
        processed.keys.add(key);
      }

      const tabId = data.tabId;
      const ownersAtOutcome = findOwnersWaitingOn(tabId, outcomeTs);
      if (getPromptQueueAgent(tabId) === 'codex') {
        console.log('[PromptQueueRunner] codex successful outcome tab=' + tabId.slice(-12)
          + ' reason=' + (data.reason || 'natural')
          + ' ts=' + outcomeTs
          + ' source=' + source
          + ' owners=' + (ownersAtOutcome.length ? ownersAtOutcome.map(shortQueueTabId).join(',') : 'none')
          + ' queues=' + describeQueuesForTriggerLog(tabId));
      }

      if (queueSendInflight.has(tabId) || queueAwaitingBusyStart.has(tabId)) {
        console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' has queued turn starting → defer pivoted owners');
        return;
      }

      const ownQueueBefore = usePromptQueueStore.getState().getQueue(tabId);
      if (workflowAcceptsNaturalOutcome(ownQueueBefore, outcomeTs)) {
        const ownContinuationTrigger = getReadyTriggerForOwner(tabId);
        if (ownContinuationTrigger) {
          const fired = fireQueueOwner(tabId, ownContinuationTrigger);
          if (fired || queueSendInflight.has(tabId) || queueAwaitingBusyStart.has(tabId)) return;
        }
      }

      // An armed queue is unfinished work even when its own trigger is still
      // busy or has never started. Downstream owners must wait for this tab to
      // actually run that continuation and finish its resulting turn.
      if (queueOwnerHasPendingContinuation(tabId)) {
        console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' has pending continuation → defer pivoted owners');
        return;
      }

      for (const ownerTabId of ownersAtOutcome) {
        if (ownerTabId !== tabId) fireQueueOwner(ownerTabId, tabId);
      }

      const ownQueue = usePromptQueueStore.getState().getQueue(tabId);
      if ((!ownQueue.stopAfter && !ownQueue.closeAfter)
        || !workflowAcceptsNaturalOutcome(ownQueue, outcomeTs)) return;

      const shouldCloseTab = ownQueue.closeAfter;
      const agentLabel = getPromptQueueAgentLabel(tabId);
      const showToast = useUIStore.getState().showToast;
      ipcRenderer.invoke('terminal:stop-ai-process', tabId)
        .then(async (res: { success?: boolean; error?: string }) => {
          if (res?.success) {
            showToast(shouldCloseTab ? agentLabel + ' stopped, closing tab' : agentLabel + ' stopped', 'success', 1500);
          } else if (res?.error) {
            console.warn('[PromptQueueRunner] stop failed:', res.error);
          }
          if (!shouldCloseTab) return;
          const projectId = findProjectIdForTab(tabId);
          if (!projectId) {
            console.warn('[PromptQueueRunner] closeAfter: no project found for tab', tabId);
            return;
          }
          try {
            await useWorkspaceStore.getState().closeTab(projectId, tabId, {
              skipProcessCheck: true,
              forceCleanup: true,
            });
          } catch (error) {
            console.error('[PromptQueueRunner] closeAfter failed:', error);
          }
        })
        .catch((error: unknown) => console.error('[PromptQueueRunner] stop error', error));
      usePromptQueueStore.getState().setStopAfter(tabId, false);
    };

    const handleBusyState = (channel: 'claude' | 'gemini' | 'codex') =>
      (_: any, data: BusyStatePayload) => {
        const { tabId, busy, reason } = data;
        if (channel === 'claude' && reason === 'spinner') {
          const commandType = getWorkspaceCommandType(tabId);
          if (commandType === 'codex' || commandType === 'gemini') {
            console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=claude reason=spinner → IGNORE foreign spinner for ' + commandType);
            return;
          }
        }

        // Spinner frames are presentation-only heuristics. Do not let them
        // overwrite the workflow edge snapshot: a spinner-idle can precede the
        // authoritative Stop/StopFailure/InterruptStop and would otherwise make
        // that real outcome look like a duplicate busy:false event.
        if (reason === 'spinner') {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' reason=spinner → IGNORE presentation signal');
          return;
        }

        const wasBusy = prevBusyRef.get(tabId) ?? false;
        prevBusyRef.set(tabId, busy);

        if (busy) {
          queueAwaitingBusyStart.delete(tabId);
          const { clearFirstDelayCountdown } = usePromptQueueStore.getState();
          const q = usePromptQueueStore.getState().getQueue(tabId);
          if (q.firstDelayCountdownAt !== null) clearFirstDelayCountdown(tabId);
        }

        const compactLocalCommandDone = isSuccessfulCompactLocalCommandEnd(data);
        if (!busy && reason === 'local-command' && !compactLocalCommandDone) {
          const localSuffix = ' command=' + (data.localCommand || '-')
            + ' localReason=' + (data.localCommandReason || '-');
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' reason=' + reason + localSuffix + ' → IGNORE non-turn busy edge');
          return;
        }

        const classifiedData = !busy
          ? { ...data, outcomeTs: liveOutcomeTimestamp(data) }
          : data;

        // Restore is a barrier for every workflow outcome, including success:
        // an idle edge arriving before either store is hydrated must not send a
        // prompt or Stop a process against a partial workspace.
        if (!busy && !canProcessWorkflowOutcomes()) {
          rememberDeferredWorkflowOutcome(classifiedData);
          return;
        }

        // Only an authoritative success may advance a workflow. Every explicit
        // non-success reason disarms the correlated workflow but preserves its
        // queued items for deliberate retry.
        if (!busy && !isNaturalAgentTurnEndReason(reason) && !compactLocalCommandDone) {
          applyAbnormalQueueOutcome(classifiedData, channel + '-live');
          return;
        }

        // A normal live completion still requires the real busy→idle edge.
        // Replayed restore outcomes bypass this edge check in reconciliation,
        // where their persisted timestamps are the correlation proof.
        if (!(wasBusy && !busy)) return;
        if (compactLocalCommandDone) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' command=/compact localReason=' + data.localCommandReason + ' → CONTINUE queue after compact');
        }
        processSuccessfulWorkflowOutcome(classifiedData, channel + '-live');
      };

    const applyCodexTurnStateSnapshot = (tabId: string, state: any, source: string): void => {
      if (!state || state.catchUpPending) {
        console.log('[PromptQueueRunner] codex snapshot tab=' + shortQueueTabId(tabId)
          + ' source=' + source + ' → WAIT pending/unknown catch-up');
        return;
      }
      if (state.hasWatcher) prevBusyRef.set(tabId, state.busy === true);

      if (state.lastAbnormalOutcomeReason) {
        applyAbnormalQueueOutcome({
          tabId,
          busy: false,
          reason: state.lastAbnormalOutcomeReason,
          outcomeTs: Number.isFinite(state.lastAbnormalOutcomeTs)
            ? Number(state.lastAbnormalOutcomeTs)
            : null,
          turnId: state.lastAbnormalOutcomeTurnId || null,
        }, source + '-abnormal', Number.isFinite(state.lastAbnormalOutcomeTs)
          ? Number(state.lastAbnormalOutcomeTs)
          : null);
      }

      if (state.busy) return;

      if (!state.outcomeKnown || !state.lastOutcomeReason) return;
      const latest: BusyStatePayload = {
        tabId,
        busy: false,
        reason: state.lastOutcomeReason,
        outcomeTs: Number.isFinite(state.lastOutcomeTs) ? Number(state.lastOutcomeTs) : null,
        turnId: state.lastOutcomeTurnId || null,
      };
      if (isNaturalAgentTurnEndReason(latest.reason)) {
        processSuccessfulWorkflowOutcome(latest, source + '-latest');
      } else if (!state.lastAbnormalOutcomeReason) {
        applyAbnormalQueueOutcome(latest, source + '-latest', explicitOutcomeTimestamp(latest));
      }
    };

    const takeDeferredWorkflowOutcomes = (): Map<string, DeferredWorkflowOutcomeSet> => {
      const snapshot = new Map(deferredWorkflowOutcomes);
      deferredWorkflowOutcomes.clear();
      return snapshot;
    };

    const reconcileRestoredWorkflows = (): Promise<void> | null => {
      if (workflowRestoreReconciled || workflowRestoreReconcilePromise || !canValidateQueueTabs()) {
        return workflowRestoreReconcilePromise;
      }
      workflowRestoreReconcilePromise = (async () => {
        const triggers = new Set<string>();
        const queues = usePromptQueueStore.getState().queues;
        for (const [ownerTabId, queue] of queues) {
          if (!hasActiveQueueWorkflow(queue)) continue;
          if (!tabExists(ownerTabId)) {
            usePromptQueueStore.getState().cleanupClosedTab(ownerTabId);
            continue;
          }
          if (queue.stopAfter || queue.closeAfter || queue.runAfterTabId === null) {
            triggers.add(ownerTabId);
          }
          if (queue.autoRun && queue.runAfterTabId) {
            triggers.add(getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true }));
          }
        }

        const codexSnapshots = await Promise.all(Array.from(triggers, async (triggerTabId) => {
          seedBusySnapshotFromWorkspace(triggerTabId);
          if (getWorkspaceCommandType(triggerTabId) !== 'codex') return null;
          try {
            const state = await ipcRenderer.invoke('codex:get-turn-state', triggerTabId);
            return { tabId: triggerTabId, state };
          } catch (error) {
            console.warn('[PromptQueueRunner] restore codex state failed trigger=' + shortQueueTabId(triggerTabId), error);
            return null;
          }
        }));

        // From this point through markWorkflowRestoreReconciled everything is
        // synchronous, so no incoming IPC can slip between the final deferred
        // snapshot and the abnormal→natural ordering below.
        const deferred = takeDeferredWorkflowOutcomes();
        const abnormalEvidence: Array<{ data: BusyStatePayload; source: string; timestamp: number | null }> = [];
        const naturalEvidence: Array<{ data: BusyStatePayload; source: string; timestamp: number }> = [];
        const rememberNatural = (data: BusyStatePayload, source: string, timestamp: number | null) => {
          if (!Number.isFinite(timestamp)) return;
          naturalEvidence.push({ data, source, timestamp: Number(timestamp) });
        };

        for (const outcomes of deferred.values()) {
          if (outcomes.abnormal) {
            abnormalEvidence.push({
              data: outcomes.abnormal,
              source: 'hydration-buffer-abnormal',
              timestamp: outcomes.abnormal.receivedAt,
            });
          }
          if (outcomes.latest && !isAbnormalWorkflowOutcome(outcomes.latest)) {
            rememberNatural(outcomes.latest, 'hydration-buffer-latest', outcomes.latest.receivedAt);
          }
        }

        for (const snapshot of codexSnapshots) {
          if (!snapshot?.state || snapshot.state.catchUpPending) continue;
          const { tabId, state } = snapshot;
          if (state.hasWatcher) prevBusyRef.set(tabId, state.busy === true);
          if (state.lastAbnormalOutcomeReason) {
            const timestamp = Number.isFinite(state.lastAbnormalOutcomeTs)
              ? Number(state.lastAbnormalOutcomeTs)
              : null;
            abnormalEvidence.push({
              data: {
                tabId,
                busy: false,
                reason: state.lastAbnormalOutcomeReason,
                outcomeTs: timestamp,
                turnId: state.lastAbnormalOutcomeTurnId || null,
              },
              source: 'hydration-codex-abnormal',
              timestamp,
            });
          }
          if (state.busy || !state.outcomeKnown || !state.lastOutcomeReason) continue;
          const timestamp = Number.isFinite(state.lastOutcomeTs) ? Number(state.lastOutcomeTs) : null;
          const latest: BusyStatePayload = {
            tabId,
            busy: false,
            reason: state.lastOutcomeReason,
            outcomeTs: timestamp,
            turnId: state.lastOutcomeTurnId || null,
          };
          if (isNaturalAgentTurnEndReason(latest.reason)) {
            rememberNatural(latest, 'hydration-codex-latest', timestamp);
          } else if (!state.lastAbnormalOutcomeReason) {
            abnormalEvidence.push({
              data: latest,
              source: 'hydration-codex-latest-abnormal',
              timestamp,
            });
          }
        }

        // Failure evidence is always applied before success. A workflow armed
        // before a failure is removed even if a later success exists; one
        // re-armed after that failure can consume the later successful outcome.
        const plan = planWorkflowReconciliation([
          ...abnormalEvidence.map((evidence) => ({
            ...evidence,
            kind: 'abnormal',
            tabId: evidence.data.tabId,
          })),
          ...naturalEvidence.map((evidence) => ({
            ...evidence,
            kind: 'natural',
            tabId: evidence.data.tabId,
          })),
        ]);
        for (const evidence of plan.abnormal) {
          applyAbnormalQueueOutcome(evidence.data, evidence.source, evidence.timestamp);
        }
        for (const evidence of plan.natural) {
          processSuccessfulWorkflowOutcome(evidence.data, evidence.source, evidence.timestamp);
        }
        markWorkflowRestoreReconciled();
        console.log('[PromptQueueRunner] workflow restore reconciliation complete triggers=' + triggers.size);
      })().finally(() => {
        workflowRestoreReconcilePromise = null;
      });
      return workflowRestoreReconcilePromise;
    };

    const maybeReconcileRestoredWorkflows = () => {
      void reconcileRestoredWorkflows();
    };

    const codexTurnStateResolvedHandler = (_: unknown, state: any) => {
      if (!state?.tabId || !canProcessWorkflowOutcomes()) return;
      applyCodexTurnStateSnapshot(state.tabId, state, 'codex-state-resolved');
    };

    const claudeHandler = handleBusyState('claude');
    const geminiHandler = handleBusyState('gemini');
    const codexHandler = handleBusyState('codex');
    const commandStartedHandler = (_: unknown, data: { tabId?: string; commandType?: string | null }) => {
      if (!data?.tabId || data.commandType !== 'claude') return;
      claudeQueueStartupPending.add(data.tabId);
    };
    const commandFinishedHandler = (_: unknown, data: { tabId?: string }) => {
      if (!data?.tabId) return;
      claudeQueueStartupPending.delete(data.tabId);
    };
    const claudeReadyHandler = (_: unknown, data: { tabId?: string }) => {
      if (!data?.tabId) return;
      // Claude's prompt is visible, but /model and /effort startup defaults may
      // still be applying. The gate event below is the actual send boundary.
      claudeQueueStartupPending.add(data.tabId);
    };
    const codexReadyHandler = (_: unknown, data: { tabId?: string }) => {
      if (data?.tabId) signalQueueOwnerReadiness(data.tabId, 'codex-tui-ready');
    };
    const claudeStartupGateHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; status?: string }>).detail || {};
      if (!detail.tabId) return;
      if (detail.status === 'pending' || detail.status === 'failed') {
        claudeQueueStartupPending.add(detail.tabId);
        return;
      }
      if (detail.status === 'ready') {
        claudeQueueStartupPending.delete(detail.tabId);
        signalQueueOwnerReadiness(detail.tabId, 'claude-startup-defaults-ready');
      } else if (detail.status === 'cleared') {
        claudeQueueStartupPending.delete(detail.tabId);
      }
    };
    ipcRenderer.on('claude:busy-state', claudeHandler);
    ipcRenderer.on('gemini:busy-state', geminiHandler);
    ipcRenderer.on('codex:busy-state', codexHandler);
    ipcRenderer.on('codex:turn-state-resolved', codexTurnStateResolvedHandler);
    ipcRenderer.on('terminal:command-started', commandStartedHandler);
    ipcRenderer.on('terminal:command-finished', commandFinishedHandler);
    ipcRenderer.on('claude:tui-ready', claudeReadyHandler);
    ipcRenderer.on('codex:tui-ready', codexReadyHandler);
    window.addEventListener('claude-startup-defaults-gate', claudeStartupGateHandler);
    const unsubscribeQueueHydration = subscribePromptQueueHydration(maybeReconcileRestoredWorkflows);
    const unsubscribeWorkspaceHydration = useWorkspaceStore.subscribe(maybeReconcileRestoredWorkflows);
    maybeReconcileRestoredWorkflows();
    return () => {
      ipcRenderer.removeListener('claude:busy-state', claudeHandler);
      ipcRenderer.removeListener('gemini:busy-state', geminiHandler);
      ipcRenderer.removeListener('codex:busy-state', codexHandler);
      ipcRenderer.removeListener('codex:turn-state-resolved', codexTurnStateResolvedHandler);
      ipcRenderer.removeListener('terminal:command-started', commandStartedHandler);
      ipcRenderer.removeListener('terminal:command-finished', commandFinishedHandler);
      ipcRenderer.removeListener('claude:tui-ready', claudeReadyHandler);
      ipcRenderer.removeListener('codex:tui-ready', codexReadyHandler);
      window.removeEventListener('claude-startup-defaults-gate', claudeStartupGateHandler);
      unsubscribeQueueHydration();
      unsubscribeWorkspaceHydration();
    };
  }, []);

  // Cold-start watcher: when ALL three conditions are true and the EFFECTIVE
  // trigger tab (own tab OR runAfterTabId) is idle, either fire immediately OR
  // start the firstDelay countdown.
  //   queue.items.length > 0  AND  queue.autoRun === true  AND  trigger is idle
  // Triggered on EITHER of two edges (whichever happens last makes the trio true):
  //   (a) items 0 → N  (user added a prompt; autoRun was already on)
  //   (b) autoRun false → true (user armed; items were already queued)
  // Edge (b) covers the case: "Claude finished without me, I forgot to arm —
  // I come back, hit Run after — first prompt must fire immediately, not wait
  // for a never-coming turn-end". Without this, the prompt sits forever.
  //
  // Pivoted-target behaviour: cold-start ONLY fires if the trigger tab is
  // currently idle AND has been busy at least once (i.e. there is a "previous"
  // state to compare against — we know it really is idle, not just unknown).
  // If trigger has never been busy (user picked a fresh tab they haven't
  // submitted anything to yet) we wait — the busy-state handler above will
  // pick up the eventual busy→idle edge whenever the user activates it and
  // sends a prompt. Without this guard, picking an inactive tab would fire
  // the queue IMMEDIATELY (trigger is "idle" because never seen busy = false
  // default) — exact opposite of user intent.
  useEffect(() => {
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearTimer = (tabId: string) => {
      const t = pendingTimers.get(tabId);
      if (t) { clearTimeout(t); pendingTimers.delete(tabId); }
    };

    let firing = false;
    const fireHead = (ownerTabId: string, triggerTabId: string): boolean => {
      if (firing) return false;
      firing = true;
      try {
        const q = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) return false;
        if (queueSendInflight.has(ownerTabId)) return false;
        if (prevBusyRef.get(ownerTabId) === true) return false;
        const head = q.items.find(isQueuedPromptEnabled);
        if (head) {
          return beginValidatedQueueSend(ownerTabId, triggerTabId, head, 'cold-start');
        }
        return false;
      } finally {
        firing = false;
      }
    };

    type FirstDelayReadinessRequest = {
      requestId: number;
      headId: string;
      workflowArmedAt: number | null;
    };
    const firstDelayReadinessPending = new Map<string, FirstDelayReadinessRequest>();
    const firstDelayReadinessInflight = new Map<string, FirstDelayReadinessRequest>();
    const firstDelayReadinessWakePending = new Map<string, string>();
    let firstDelayReadinessSequence = 0;

    const firstDelayRequestIsCurrent = (
      ownerTabId: string,
      request: FirstDelayReadinessRequest,
    ): boolean => {
      if (firstDelayReadinessPending.get(ownerTabId) !== request) return false;
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const head = queue.items.find(isQueuedPromptEnabled);
      return queue.autoRun
        && head?.id === request.headId
        && queue.workflowArmedAt === request.workflowArmedAt
        && queue.firstDelayCountdownAt === null
        && !queueSendInflight.has(ownerTabId)
        && !queueAwaitingBusyStart.has(ownerTabId)
        && !deferredOwnerSends.has(ownerTabId)
        && getEffectiveQueueTrigger(ownerTabId, queue) === ownerTabId;
    };

    const clearFirstDelayReadiness = (ownerTabId: string, reason: string): void => {
      firstDelayReadinessWakePending.delete(ownerTabId);
      if (!firstDelayReadinessPending.delete(ownerTabId)) return;
      console.log('[PromptQueueRunner] first-delay readiness cleared owner=' + ownerTabId.slice(-8)
        + ' reason=' + reason);
    };

    const startFirstDelayAfterReadiness = (
      ownerTabId: string,
      request: FirstDelayReadinessRequest,
    ): void => {
      if (!firstDelayRequestIsCurrent(ownerTabId, request)) {
        clearFirstDelayReadiness(ownerTabId, 'ready-became-stale');
        return;
      }
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      firstDelayReadinessPending.delete(ownerTabId);
      firstDelayReadinessWakePending.delete(ownerTabId);
      if (queue.firstDelaySeconds <= 0) {
        fireHead(ownerTabId, ownerTabId);
        return;
      }

      const delayMs = queue.firstDelaySeconds * 1000;
      usePromptQueueStore.getState().startFirstDelayCountdown(ownerTabId);
      clearTimer(ownerTabId);
      pendingTimers.set(ownerTabId, setTimeout(() => {
        pendingTimers.delete(ownerTabId);
        const latestQueue = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!latestQueue.autoRun
          || countEnabledQueuedPrompts(latestQueue.items) === 0
          || latestQueue.firstDelayCountdownAt === null) {
          usePromptQueueStore.getState().clearFirstDelayCountdown(ownerTabId);
          return;
        }
        usePromptQueueStore.getState().consumeFirstDelayCountdown(ownerTabId);
        fireHead(ownerTabId, ownerTabId);
      }, delayMs));
      console.log('[PromptQueueRunner] first-delay countdown started after readiness owner='
        + ownerTabId.slice(-8) + ' seconds=' + queue.firstDelaySeconds
        + ' request=' + request.requestId);
    };

    const checkFirstDelayOwnerReadiness = (ownerTabId: string, source: string): boolean => {
      const request = firstDelayReadinessPending.get(ownerTabId);
      if (!request) return false;
      if (firstDelayReadinessInflight.has(ownerTabId)) {
        firstDelayReadinessWakePending.set(ownerTabId, source);
        return true;
      }
      if (!firstDelayRequestIsCurrent(ownerTabId, request)) {
        clearFirstDelayReadiness(ownerTabId, 'stale-before-check:' + source);
        return false;
      }

      firstDelayReadinessInflight.set(ownerTabId, request);
      void readQueueOwnerReadiness(ownerTabId).then((readiness) => {
        if (!firstDelayRequestIsCurrent(ownerTabId, request)) {
          clearFirstDelayReadiness(ownerTabId, 'stale-after-check:' + source);
          return;
        }
        if (!readiness.ready) {
          console.log('[PromptQueueRunner] first-delay waits for owner readiness owner='
            + ownerTabId.slice(-8) + ' status=' + readiness.status
            + ' inputReady=' + readiness.inputReady + ' source=' + source);
          return;
        }
        startFirstDelayAfterReadiness(ownerTabId, request);
      }).catch((error: unknown) => {
        console.warn('[PromptQueueRunner] first-delay readiness check failed owner='
          + ownerTabId.slice(-8) + ' source=' + source, error);
      }).finally(() => {
        if (firstDelayReadinessInflight.get(ownerTabId) === request) {
          firstDelayReadinessInflight.delete(ownerTabId);
        }
        const wakeSource = firstDelayReadinessWakePending.get(ownerTabId) || null;
        firstDelayReadinessWakePending.delete(ownerTabId);
        if (wakeSource && firstDelayReadinessPending.has(ownerTabId)) {
          checkFirstDelayOwnerReadiness(ownerTabId, 'latched:' + wakeSource);
        }
      });
      return true;
    };

    const waitForFirstDelayOwnerReadiness = (ownerTabId: string, source: string): boolean => {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const head = queue.items.find(isQueuedPromptEnabled);
      if (!queue.autoRun
        || !head
        || queue.firstDelayCountdownAt !== null
        || getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true }) !== ownerTabId) {
        clearFirstDelayReadiness(ownerTabId, 'invalid-request:' + source);
        return false;
      }

      const existing = firstDelayReadinessPending.get(ownerTabId);
      const request = existing
        && existing.headId === head.id
        && existing.workflowArmedAt === queue.workflowArmedAt
        ? existing
        : {
            requestId: ++firstDelayReadinessSequence,
            headId: head.id,
            workflowArmedAt: queue.workflowArmedAt,
          };
      firstDelayReadinessPending.set(ownerTabId, request);
      return checkFirstDelayOwnerReadiness(ownerTabId, source);
    };

    const pruneFirstDelayReadiness = (): void => {
      for (const [ownerTabId, request] of firstDelayReadinessPending) {
        if (!firstDelayRequestIsCurrent(ownerTabId, request)) {
          clearFirstDelayReadiness(ownerTabId, 'queue-changed');
        }
      }
    };

    const unsubscribeOwnerReadiness = subscribeQueueOwnerReadiness((ownerTabId, source) => {
      if (firstDelayReadinessPending.has(ownerTabId)) {
        checkFirstDelayOwnerReadiness(ownerTabId, source);
      }
    });

    const verifyCodexTriggerIdleThenFire = (ownerTabId: string, triggerTabId: string): boolean => {
      if (getWorkspaceCommandType(triggerTabId) !== 'codex') return false;
      const key = ownerTabId + '→' + triggerTabId;
      if (codexTriggerCheckInflight.has(key)) return true;
      codexTriggerCheckInflight.add(key);
      ipcRenderer.invoke('codex:get-turn-state', triggerTabId).then((res: any) => {
        if (res?.catchUpPending) {
          console.log('[PromptQueueRunner] codex-turn-state trigger=' + triggerTabId.slice(-8) + ' catch-up pending → wait');
          return;
        }
        if (res?.lastAbnormalOutcomeReason) {
          applyAbnormalQueueOutcome({
            tabId: triggerTabId,
            busy: false,
            reason: res.lastAbnormalOutcomeReason,
            outcomeTs: Number.isFinite(res.lastAbnormalOutcomeTs)
              ? Number(res.lastAbnormalOutcomeTs)
              : null,
            turnId: res.lastAbnormalOutcomeTurnId || null,
          }, 'cold-start-codex-state', Number.isFinite(res.lastAbnormalOutcomeTs)
            ? Number(res.lastAbnormalOutcomeTs)
            : null);
        }
        if (res?.hasWatcher) {
          prevBusyRef.set(triggerTabId, !!res.busy);
          if (res.busy) {
            useWorkspaceStore.getState().setAiBusy(triggerTabId, true, 'task_started');
            console.log('[PromptQueueRunner] codex-turn-state trigger=' + triggerTabId.slice(-8) + ' busy=true → wait');
            return;
          }
        }

        // Unknown idle is sufficient only for an explicit post-restore arm on
        // the same tab. A restored queue or a pivot target waits for classified
        // evidence instead of treating a default false boolean as completion.
        const explicitOwnTabArm = ownerTabId === triggerTabId && hasRuntimeWorkflowArm(ownerTabId);
        if ((!res?.hasWatcher || res?.outcomeKnown !== true) && !explicitOwnTabArm) {
          console.log('[PromptQueueRunner] codex-turn-state owner=' + ownerTabId.slice(-8)
            + ' trigger=' + triggerTabId.slice(-8) + ' outcome unknown → wait');
          return;
        }

        const q2 = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!q2.autoRun || countEnabledQueuedPrompts(q2.items) === 0) return;
        if (queueSendInflight.has(ownerTabId) || queueAwaitingBusyStart.has(ownerTabId)) return;
        if (prevBusyRef.get(ownerTabId) === true) return;

        if (ownerTabId !== triggerTabId) {
          if (queueOwnerHasPendingContinuation(triggerTabId)) {
            console.log('[PromptQueueRunner] codex-turn-state owner=' + ownerTabId.slice(-8) + ' target=' + triggerTabId.slice(-8) + ' has pending continuation → wait for chain drain');
            return;
          }
          fireHead(ownerTabId, triggerTabId);
          return;
        }

        if (q2.firstDelayCountdownAt !== null) return;
        if (q2.firstDelaySeconds > 0) {
          waitForFirstDelayOwnerReadiness(ownerTabId, 'codex-own-cold-start');
        } else {
          fireHead(ownerTabId, ownerTabId);
        }
      }).catch((e: unknown) => {
        console.warn('[PromptQueueRunner] codex-turn-state check failed owner=' + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8), e);
      }).finally(() => {
        codexTriggerCheckInflight.delete(key);
      });
      return true;
    };

    const evaluateQueues = (
      state: QueueStateSnapshot,
      prevState: QueueStateSnapshot,
      options: { forceRuntimeArms?: boolean } = {},
    ) => {
      if (!canProcessWorkflowOutcomes()) return;
      for (const [tabId, q] of state.queues) {
        if (!tabExists(tabId)) {
          usePromptQueueStore.getState().cleanupClosedTab(tabId);
          continue;
        }
        const prevQ = prevState.queues.get(tabId);
        const runtimeArm = hasRuntimeWorkflowArm(tabId);
        if (!prevQ && !runtimeArm) continue;

        // Disarm-while-counting: if autoRun went false OR claude turned busy
        // while a countdown was running, cancel the pending timer.
        if (prevQ && prevQ.firstDelayCountdownAt !== null && q.firstDelayCountdownAt === null) {
          clearTimer(tabId);
        }
        if (prevQ && prevQ.autoRun && !q.autoRun) {
          clearTimer(tabId);
        }
        // If the user re-targets to a different tab while armed, cancel any
        // pending countdown — the old trigger no longer applies. The new
        // target will start a fresh cycle via the autoRunArmed edge below
        // (well, NOT quite — autoRun is still true; we need a third edge:
        // target-changed-while-armed. Handled via explicit check below.)
        const prevTarget = prevQ?.runAfterTabId ?? null;
        const targetChanged = (prevTarget ?? null) !== (q.runAfterTabId ?? null);
        const automaticTargetClear = targetChanged && consumeAutomaticRunAfterTargetClear(tabId);
        if (targetChanged && prevQ?.autoRun) {
          clearTimer(tabId);
          if (q.firstDelayCountdownAt !== null) {
            usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
          }
        }

        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) continue;

        const prevCount = prevQ ? countEnabledQueuedPrompts(prevQ.items) : 0;
        const activeCount = countEnabledQueuedPrompts(q.items);
        const prevAutoRun = prevQ?.autoRun ?? false;
        const itemsArrived = prevCount === 0 && activeCount > 0;
        const autoRunArmed = !prevAutoRun && q.autoRun;
        // Treat "target swapped while armed" as an arm-edge too — the user
        // explicitly changed who we're waiting on, evaluate cold-start fit
        // against the new target.
        const armEdge = itemsArrived
          || autoRunArmed
          || (targetChanged && q.autoRun && !automaticTargetClear)
          || (options.forceRuntimeArms === true && runtimeArm);
        if (!armEdge) continue;

        // Validate the picked target — stale id behaves as null (fall back to
        // own-tab default).
        const effectiveTrigger = getEffectiveQueueTrigger(tabId, q, { clearStaleTarget: true });

        if (effectiveTrigger !== tabId) {
          seedBusySnapshotFromWorkspace(effectiveTrigger);
          // Pivoted: only fire cold-start if the target has been seen busy at
          // least once AND is currently idle. Otherwise wait for the busy→idle
          // edge in the IPC handler. The "seen at least once" gate prevents
          // firing on a target the user hasn't touched yet.
          if (!prevBusyRef.has(effectiveTrigger)) {
            console.log('[PromptQueueRunner] cold-start owner=' + tabId.slice(-8) + ' target=' + effectiveTrigger.slice(-8) + ' has no busy history → wait');
            continue;
          }
          if (prevBusyRef.get(effectiveTrigger) === true) {
            // Target is busy right now — wait for its idle edge.
            continue;
          }
          if (verifyCodexTriggerIdleThenFire(tabId, effectiveTrigger)) continue;
          if (queueOwnerHasPendingContinuation(effectiveTrigger)) {
            console.log('[PromptQueueRunner] cold-start owner=' + tabId.slice(-8) + ' target=' + effectiveTrigger.slice(-8) + ' has pending continuation → wait for chain drain');
            continue;
          }
          // Target is idle and was seen busy before. Cold-start fires.
          // (No firstDelay support for pivoted — keep it simple; the user
          // already configured a delay implicitly by picking a target tab.)
          fireHead(tabId, effectiveTrigger);
          continue;
        }

        // Default own-tab cold-start (unchanged behaviour).
        if (verifyCodexTriggerIdleThenFire(tabId, tabId)) continue;
        const isBusy = prevBusyRef.get(tabId) ?? false;
        if (isBusy) continue;

        if (q.firstDelayCountdownAt !== null) continue;

        if (q.firstDelaySeconds > 0) {
          waitForFirstDelayOwnerReadiness(tabId, 'own-cold-start');
        } else {
          fireHead(tabId, tabId);
        }
      }
    };

    const unsubscribeQueue = usePromptQueueStore.subscribe((state, prevState) => {
      pruneDeferredOwnerSends();
      pruneFirstDelayReadiness();
      evaluateQueues(state, prevState);
    });
    const unsubscribeReconciliation = subscribeWorkflowRestoreReconciliation(() => {
      const current = usePromptQueueStore.getState();
      // Revisit only workflows explicitly armed in this renderer. Persisted
      // queues were already correlated against main-process outcomes above and
      // must never be synthesized as fresh 0→N / false→true edges.
      evaluateQueues(current, current, { forceRuntimeArms: true });
    });
    if (workflowRestoreReconciled) {
      const current = usePromptQueueStore.getState();
      evaluateQueues(current, current, { forceRuntimeArms: true });
    }
    return () => {
      unsubscribeQueue();
      unsubscribeReconciliation();
      unsubscribeOwnerReadiness();
      unsubscribeEditorLocks();
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
      firstDelayReadinessPending.clear();
      firstDelayReadinessInflight.clear();
      firstDelayReadinessWakePending.clear();
    };
  }, []);
}
