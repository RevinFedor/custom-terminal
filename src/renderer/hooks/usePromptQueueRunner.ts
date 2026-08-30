import { useEffect } from 'react';
import { buildQueuedPromptPayload, consumeAutomaticRunAfterTargetClear, countEnabledQueuedPrompts, ensureQueuedPromptImagesReady, hasMalformedQueuedImageMarker, hasPendingPromptQueueContinuation, hasRuntimeWorkflowArm, isLoopPromptActive, isPromptQueueEditorLocked, isPromptQueueStoreHydrated, isQueuedPromptEnabled, queuedMetaActionDefaultTitle, queuedPromptContextConditionKey, queuedPromptContextConditionMatches, queueSendTransferredOwnership, subscribePromptQueueEditorLocks, subscribePromptQueueHydration, usePromptQueueStore, type QueuedMetaAction, type QueuedPrompt, type TabQueue } from '../store/usePromptQueueStore';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { isNaturalAgentTurnEndReason, isRecoverableAgentTurnInterruption } from '../utils/agentCompletionOutcome.mjs';
import { choosePromptQueueContinuationForOutcome, isWorkflowOutcomeAtOrAfterArm, planWorkflowReconciliation } from '../utils/promptQueueReconciliation.mjs';
import { getHistoryAgentRuntime } from '../utils/historyAgentRuntimes';
import { sendAgentPromptScenario } from '../utils/agentScenarios';
import { AGENT_SETTINGS_INTENT_NONE } from '../utils/agentSendSettingsContract';
import {
  isStandaloneAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from '../utils/agentLocalCommand.mjs';
import { getClaudeStartupDefaultsGateSnapshot } from '../utils/claudeStartupDefaultsGate';
import { serializeComposerDraft } from '../utils/composerChips.mjs';
import { getFirstDelayRemainingMs, MAX_BROWSER_TIMEOUT_MS } from '../utils/promptQueueDelay';
import {
  initializeOrchestrationStore,
  isOrchestrationCompletionBlocked,
  subscribeOrchestrationRunChanges,
  useOrchestrationStore,
} from '../store/useOrchestrationStore';
import {
  advanceHistoryPromptHandoffTransportPhase,
  beginHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot,
  historyPromptAuditIsProviderQueueReturn,
  historyPromptHandoffAcceptsAuditIdentity,
  historyPromptHandoffAuditProofFromSendResult,
  historyPromptHandoffInitialStatus,
  historyPromptHandoffUnconfirmedStatusFromSendResult,
  retractHistoryPromptHandoff,
  settleHistoryPromptHandoff,
} from '../utils/historyPromptHandoffs';
import {
  buildPromptQueueReceiptHandoffId,
  promptQueueReceiptReplayNeedsNoBusyStart,
} from '../utils/promptQueueReceiptIdentity.mjs';
import { resolvePtyAgentOwner } from '../utils/ptyAgentOwner.mjs';
import {
  executeHistoryRewriteRewindScenario,
  HistoryRewriteRewindError,
} from '../utils/historyRewriteRewind';

const { ipcRenderer } = window.require('electron');

// Walk openProjects → find the project that owns a queued Close-tab action.
// O(N) but openProjects rarely has more than a handful of entries.
function findProjectIdForTab(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const [projId, ws] of state.openProjects) {
    if (ws.tabs.has(tabId)) return projId;
  }
  return null;
}

// Launch cwd contract: the freshest tab cwd (OSC 7 tracked), not project root.
function getTabCwd(tabId: string): string | undefined {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId) as { cwd?: string } | undefined;
    if (tab) return tab.cwd || undefined;
  }
  return undefined;
}

function getTabName(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (tab) return tab.name || null;
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
  return isPromptQueueStoreHydrated()
    && useOrchestrationStore.getState().initialized
    && !state.isRestoring
    && state.openProjects.size > 0;
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

function seedBusySnapshotFromWorkspace(tabId: string, options: { replace?: boolean } = {}): void {
  const busy = workspaceTabBusyNow(tabId);
  if (options.replace === true) {
    prevBusyRef.set(tabId, busy);
    console.log('[PromptQueueRunner] replace busy snapshot from workspace tab='
      + tabId.slice(-12) + ' busy=' + (busy ? '1' : '0'));
    return;
  }
  if (!busy) return;
  if (prevBusyRef.get(tabId) === true) return;
  prevBusyRef.set(tabId, true);
  console.log('[PromptQueueRunner] seed busy snapshot from workspace tab=' + tabId.slice(-12));
}

type QueueAgent = 'claude' | 'codex';

function getPromptQueueAgent(tabId: string): QueueAgent | null {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (!tab) continue;
    return resolvePtyAgentOwner(tab);
  }
  return null;
}

function getWorkspaceCommandType(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (tab) return tab.commandType || null;
  }
  return null;
}

function queuedMetaActionResultLabel(action: QueuedMetaAction): string {
  if (action.kind === 'restart') return 'Restart выполнен';
  if (action.kind === 'rewind') return 'Rewind выполнен';
  if (action.kind === 'stop') return 'Агент остановлен';
  return 'Вкладка закрыта';
}

async function stopQueueOwnerForLifecycleAction(
  ownerTabId: string,
  status: 'active' | 'inactive',
  reason: 'prompt-queue-stop-action' | 'prompt-queue-close-action',
): Promise<void> {
  if (status === 'inactive') return;
  const toolType = getPromptQueueAgent(ownerTabId);
  if (!toolType) throw new Error('Не удалось определить агента для остановки');
  const result = await ipcRenderer.invoke('terminal:stop-ai-process', {
    tabId: ownerTabId,
    toolType,
    reason,
  });
  const noProcess = !result?.success && /no AI process/i.test(String(result?.error || ''));
  if (!result?.success && !noProcess) {
    throw new Error(result?.error || 'Остановка агента не завершена');
  }
}

function getPromptQueueSessionId(tabId: string, agent: QueueAgent): string | null {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (!tab) continue;
    return agent === 'codex'
      ? (tab.codexSessionId || null)
      : (tab.claudeSessionId || null);
  }
  return null;
}

function sendQueueCommand(
  tabId: string,
  payload: string,
  handoff: {
    handoffId: string;
    presentationSnapshot: {
      historySessionId: string | null;
      imagePaths?: NonNullable<QueuedPrompt['imagePaths']>;
      promptChips: Array<{
        id?: string;
        kind: 'prompt';
        label?: string;
        text: string;
        sourceKey?: string;
        inheritanceDepth?: number;
        inheritanceParentLabel?: string;
      }>;
      semanticTags?: Array<{
        kind: 'prompt-origin';
        source: 'loop';
      }>;
    };
  },
  source: 'prompt-queue' | 'prompt-loop' = 'prompt-queue',
  statusAtSend: string = 'active',
): Promise<unknown> {
  const agent = getPromptQueueAgent(tabId);
  if (!agent) {
    return Promise.resolve({
      success: false,
      submitted: false,
      error: 'provider_owner_unknown',
    });
  }
  const runtime = getHistoryAgentRuntime(agent);
  return sendAgentPromptScenario({
    tabId,
    toolType: agent,
    runtime,
    sessionId: getPromptQueueSessionId(tabId, agent),
    cwd: getTabCwd(tabId),
    prompt: payload,
    handoffId: handoff.handoffId,
    source,
    statusAtSend,
    queue: statusAtSend === 'busy',
    settingsIntent: AGENT_SETTINGS_INTENT_NONE,
    returnDraftOnConflict: false,
    presentationSnapshot: handoff.presentationSnapshot,
  });
}

type EffectiveTriggerOptions = { clearStaleTarget?: boolean };
type QueueStateSnapshot = { queues: Map<string, TabQueue> };
const queueDelayStartListeners = new Set<(ownerTabId: string, source: string) => void>();

function enabledQueueHead(queue: TabQueue): QueuedPrompt | null {
  return queue.items.find(isQueuedPromptEnabled) || null;
}

function queueDelaySeconds(queue: TabQueue): number {
  const head = enabledQueueHead(queue);
  return head?.trigger?.kind === 'timer' ? head.trigger.seconds : queue.firstDelaySeconds;
}

function queueUsesItemTimer(queue: TabQueue): boolean {
  return enabledQueueHead(queue)?.trigger?.kind === 'timer';
}

type ContinuationKind = 'queue' | 'loop';

const LOOP_TASK_COMPLETION_PROTOCOL = [
  '<terminal_task_completion_protocol>',
  'Это автоматическая проверка завершения.',
  'Если задача полностью готова и нет незавершённых дочерних Terminal MCP-run, вызови Terminal MCP complete_task ровно один раз ближе к концу этого ответа, затем верни финальный итог.',
  'Если работа продолжается, есть ошибка или ожидание, complete_task не вызывай.',
  '</terminal_task_completion_protocol>',
].join('\n');

function shortPromptFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getLoopPrompt(queue: TabQueue): QueuedPrompt | null {
  if (!isLoopPromptActive(queue)) return null;
  const text = queue.loopPromptText.trim();
  return {
    id: 'loop-' + (queue.loopPromptArmedAt ?? 'legacy') + '-' + shortPromptFingerprint(text),
    text: text + '\n\n' + LOOP_TASK_COMPLETION_PROTOCOL,
    images: 0,
    chips: [],
    createdAt: queue.loopPromptArmedAt ?? 0,
  };
}

function getEffectiveQueueTrigger(ownerTabId: string, queue: TabQueue, options: EffectiveTriggerOptions = {}): string {
  const head = enabledQueueHead(queue);
  if (head?.trigger?.kind === 'onTab') {
    const targetTabId = head.trigger.tabId;
    if (!canValidateQueueTabs()) return targetTabId;
    if (tabCanTriggerQueue(ownerTabId, targetTabId)) return targetTabId;
    if (options.clearStaleTarget) {
      console.warn('[PromptQueueRunner] item onTab trigger ' + targetTabId.slice(-8)
        + ' is no longer valid, clearing → owner=' + ownerTabId.slice(-8));
      usePromptQueueStore.getState().setPromptTrigger(ownerTabId, head.id, null);
      return getEffectiveQueueTrigger(
        ownerTabId,
        usePromptQueueStore.getState().getQueue(ownerTabId),
        { clearStaleTarget: false },
      );
    }
  }
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

function isTabWorkflowBlocked(tabId: string): boolean {
  return prevBusyRef.get(tabId) === true || isOrchestrationCompletionBlocked(tabId);
}

const queueSendInflight = new Set<string>();
// A queued Stop/Close intentionally creates a non-natural busy→idle edge.
// While that exact action owns the stop, the global workflow listener must not
// mistake its own side effect for an external failure and cancel the action
// before it can commit/close.
const queueLifecycleStopInflight = new Set<string>();
// An unlock is only a retry signal when a concrete send attempt actually hit
// the editor lock. Merely opening/editing a queue item must not synthesize a
// cold-start edge or bypass first-delay / pivot readiness.
const queueEditorBlockedOwners = new Set<string>();
// After send-command resolves successfully there is a short event gap before
// the agent emits busy:true. Keep pivoted owners blocked through that gap.
const queueAwaitingBusyStart = new Set<string>();
const codexTriggerCheckInflight = new Set<string>();
type DeferredOwnerSend = {
  kind: ContinuationKind;
  triggerTabId: string;
  headId: string;
  label: 'turn-end' | 'cold-start';
  workflowArmedAt: number | null;
  attemptId: number;
  causeKey: string | null;
  conditionKey: string;
};
// A trigger can be fully satisfied while the queue owner is stopped. Keep that
// result separate from `queueAwaitingBusyStart` (which means Enter was already
// accepted) and retry exactly once when the owner's TUI becomes input-ready.
const deferredOwnerSends = new Map<string, DeferredOwnerSend>();
const claudeQueueStartupPending = new Set<string>();
const queueReadinessWakePending = new Map<string, string>();
// Exact context reads are async. One owner may have only one scheduler pass in
// flight, otherwise two simultaneous turn-end/cold-start signals could rotate
// the same card twice before either sees the other's new head.
const queueConditionChecks = new Set<string>();
let queueSendAttemptSequence = 0;

function getContinuationPrompt(queue: TabQueue, kind: ContinuationKind): QueuedPrompt | null {
  return kind === 'loop'
    ? getLoopPrompt(queue)
    : (queue.items.find(isQueuedPromptEnabled) || null);
}

function continuationArmTimestamp(queue: TabQueue, kind: ContinuationKind): number | null {
  return kind === 'loop' ? queue.loopPromptArmedAt : queue.workflowArmedAt;
}

function continuationTriggerTabId(ownerTabId: string, queue: TabQueue, kind: ContinuationKind): string {
  return kind === 'loop'
    ? ownerTabId
    : getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
}

function continuationAttemptIsCurrent(
  ownerTabId: string,
  queue: TabQueue,
  attempt: DeferredOwnerSend,
): boolean {
  const prompt = getContinuationPrompt(queue, attempt.kind);
  if (!prompt || prompt.id !== attempt.headId) return false;
  if (queuedPromptContextConditionKey(prompt.condition) !== attempt.conditionKey) return false;
  if (continuationArmTimestamp(queue, attempt.kind) !== attempt.workflowArmedAt) return false;
  if (continuationTriggerTabId(ownerTabId, queue, attempt.kind) !== attempt.triggerTabId) return false;
  return attempt.kind === 'loop' ? isLoopPromptActive(queue) : queue.autoRun;
}

function signalQueueOwnerReadiness(ownerTabId: string, source: string): void {
  retryDeferredOwnerSend(ownerTabId, source);
}

async function readQueueOwnerReadiness(ownerTabId: string): Promise<{
  ready: boolean;
  status: string;
  inputReady: boolean;
  reason: string;
}> {
  const agent = getPromptQueueAgent(ownerTabId);
  if (!agent) {
    return {
      ready: false,
      status: 'unknown',
      inputReady: false,
      reason: 'provider-owner-unknown',
    };
  }
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
  signalContinuationRelease(ownerTabId, 'deferred-cleared:' + reason);
}

function deferredOwnerAttemptIsCurrent(
  ownerTabId: string,
  attempt: DeferredOwnerSend,
): boolean {
  if (deferredOwnerSends.get(ownerTabId) !== attempt) return false;
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    return false;
  }
  return continuationAttemptIsCurrent(ownerTabId, queue, attempt);
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
  const prompt = getContinuationPrompt(queue, deferred.kind);
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    return false;
  }
  if (!prompt || !continuationAttemptIsCurrent(ownerTabId, queue, deferred)) {
    clearDeferredOwnerSend(ownerTabId, 'stale:' + source);
    return false;
  }
  if (isTabWorkflowBlocked(ownerTabId)
    || isTabWorkflowBlocked(deferred.triggerTabId)) return false;
  console.log('[PromptQueueRunner] retry deferred owner=' + ownerTabId.slice(-8)
    + ' trigger=' + deferred.triggerTabId.slice(-8) + ' source=' + source);
  return deferred.kind === 'queue'
    ? beginConditionAwareQueueSend(
        ownerTabId,
        deferred.triggerTabId,
        prompt,
        deferred.label,
      )
    : beginValidatedQueueSend(
        ownerTabId,
        deferred.triggerTabId,
        prompt,
        deferred.label,
        deferred.kind,
        deferred.causeKey,
      );
}

function pruneDeferredOwnerSends(): void {
  for (const [ownerTabId, deferred] of deferredOwnerSends) {
    const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
    if (!continuationAttemptIsCurrent(ownerTabId, queue, deferred)) {
      clearDeferredOwnerSend(ownerTabId, 'queue-changed');
    }
  }
}

function queueOwnerHasPendingContinuation(ownerTabId: string): boolean {
  if (queueAwaitingBusyStart.has(ownerTabId)
    || queueSendInflight.has(ownerTabId)
    || deferredOwnerSends.has(ownerTabId)
    || isOrchestrationCompletionBlocked(ownerTabId)) return true;
  return hasPendingPromptQueueContinuation(usePromptQueueStore.getState().getQueue(ownerTabId));
}

function queueOwnerHasPendingContinuationAt(ownerTabId: string, outcomeTs: number): boolean {
  if (queueAwaitingBusyStart.has(ownerTabId)
    || queueSendInflight.has(ownerTabId)
    || deferredOwnerSends.has(ownerTabId)
    || isOrchestrationCompletionBlocked(ownerTabId)) return true;
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
  const queuePending = queue.autoRun
    && countEnabledQueuedPrompts(queue.items) > 0
    && workflowAcceptsNaturalOutcome(queue, outcomeTs);
  const loopPending = isLoopPromptActive(queue)
    && (queue.loopPromptArmedAt === null || queue.loopPromptArmedAt <= outcomeTs);
  return queuePending || loopPending;
}

function scheduleQueueFollowupAfterMetaAction(ownerTabId: string): void {
  setTimeout(() => {
    const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
    if (!queue.autoRun || queue.firstDelayCountdownAt !== null) return;
    const head = enabledQueueHead(queue);
    if (!head || queueSendInflight.has(ownerTabId)) return;
    const triggerTabId = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
    // A per-item pivot remains a real future dependency. Completing a local
    // action must not consume a historical completion from that target.
    if (triggerTabId !== ownerTabId) return;
    if (head.trigger?.kind === 'timer' && head.trigger.seconds > 0) {
      usePromptQueueStore.getState().startFirstDelayCountdown(ownerTabId);
      for (const listener of queueDelayStartListeners) listener(ownerTabId, 'meta-action-followup');
      return;
    }
    beginConditionAwareQueueSend(ownerTabId, ownerTabId, head, 'cold-start');
  }, 0);
}

function beginValidatedQueueMetaAction(
  ownerTabId: string,
  triggerTabId: string,
  head: QueuedPrompt,
  label: 'turn-end' | 'cold-start',
): boolean {
  if (!head.metaAction || queueSendInflight.has(ownerTabId)) return false;
  const queueAtStart = usePromptQueueStore.getState().getQueue(ownerTabId);
  if (enabledQueueHead(queueAtStart)?.id !== head.id
    || !queueAtStart.autoRun
    || getEffectiveQueueTrigger(ownerTabId, queueAtStart, { clearStaleTarget: true }) !== triggerTabId) {
    return false;
  }
  if (triggerTabId !== ownerTabId && !pivotTriggerHasFreshCompletion(queueAtStart, triggerTabId)) {
    return false;
  }

  const existing = deferredOwnerSends.get(ownerTabId);
  const conditionKey = queuedPromptContextConditionKey(head.condition);
  const attempt: DeferredOwnerSend = existing?.headId === head.id
    && existing.conditionKey === conditionKey
    ? existing
    : {
        kind: 'queue',
        triggerTabId,
        headId: head.id,
        label,
        workflowArmedAt: queueAtStart.workflowArmedAt,
        attemptId: ++queueSendAttemptSequence,
        causeKey: null,
        conditionKey,
      };
  deferredOwnerSends.set(ownerTabId, attempt);

  queueSendInflight.add(ownerTabId);
  let succeeded = false;
  let waitingForReadiness = false;
  let ownerTabClosed = false;
  let workflowEndedByAction = false;
  void (async () => {
    const presence = await readQueueOwnerReadiness(ownerTabId);
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) return;
    if (presence.status === 'busy'
      || presence.status === 'starting'
      || presence.status === 'stopping'
      || (presence.status === 'active' && !presence.inputReady)) {
      waitingForReadiness = true;
      console.log('[PromptQueueRunner] meta action waits owner=' + ownerTabId.slice(-8)
        + ' kind=' + head.metaAction?.kind + ' status=' + presence.status);
      return;
    }
    if (presence.status !== 'active' && presence.status !== 'inactive') {
      throw new Error('Не удалось подтвердить состояние вкладки перед действием');
    }

    const action = head.metaAction;
    if (!action) return;
    if (action.kind === 'restart') {
      const result = await ipcRenderer.invoke('terminal:deterministic-stop', {
        tabId: ownerTabId,
        restart: true,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Перезапуск вкладки не завершён');
      }
    } else if (action.kind === 'rewind') {
      const agent = getPromptQueueAgent(ownerTabId);
      if (agent !== action.toolType) {
        throw new Error('Тип агента изменился после добавления Rewind в очередь');
      }
      const sessionId = getPromptQueueSessionId(ownerTabId, agent);
      if (!sessionId) throw new Error('У вкладки больше нет сохранённой сессии для Rewind');
      await executeHistoryRewriteRewindScenario({
        tabId: ownerTabId,
        toolType: action.toolType,
        sessionId,
        cwd: getTabCwd(ownerTabId),
        target: {
          uuid: action.targetUuid,
          text: action.targetText,
        },
      });
    } else if (action.kind === 'stop') {
      queueLifecycleStopInflight.add(ownerTabId);
      await stopQueueOwnerForLifecycleAction(
        ownerTabId,
        presence.status,
        'prompt-queue-stop-action',
      );
      workflowEndedByAction = true;
    } else {
      const projectId = findProjectIdForTab(ownerTabId);
      if (!projectId) throw new Error('Вкладка больше не принадлежит открытому проекту');
      queueLifecycleStopInflight.add(ownerTabId);
      await stopQueueOwnerForLifecycleAction(
        ownerTabId,
        presence.status,
        'prompt-queue-close-action',
      );
      const closed = await useWorkspaceStore.getState().closeTab(projectId, ownerTabId, {
        skipProcessCheck: true,
        forceCleanup: true,
      });
      if (!closed) throw new Error('Закрытие вкладки не завершено');
      // closeTab owns queue cleanup together with every other tab-owned state.
      // There is deliberately no commitSentHead after the owner has vanished.
      ownerTabClosed = true;
      succeeded = true;
    }

    if (!ownerTabClosed) {
      if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) return;
      const committed = usePromptQueueStore.getState().commitSentHead(
        ownerTabId,
        head.id,
        triggerTabId,
      );
      succeeded = committed.removed;
      if (!succeeded) throw new Error('Действие изменилось до завершения исполнения');
      if (workflowEndedByAction) {
        // Stop is a terminal boundary in the visible sequence. Cards after it
        // stay queued but require a new explicit Play; silently auto-launching
        // the just-stopped agent would make the Stop row meaningless.
        usePromptQueueStore.getState().setAutoRun(ownerTabId, false);
      }
    }
    useUIStore.getState().showToast(
      queuedMetaActionResultLabel(action),
      'success',
      1800,
      false,
      undefined,
      undefined,
      undefined,
      ownerTabId,
    );
  })().catch((error: unknown) => {
    const message = String((error as any)?.message || error || 'unknown');
    const historyMutated = error instanceof HistoryRewriteRewindError && error.historyMutated;
    console.error('[PromptQueueRunner] meta action failed owner=' + ownerTabId.slice(-8)
      + ' kind=' + head.metaAction?.kind + ' mutated=' + (historyMutated ? '1' : '0')
      + ' error=' + message);
    const current = deferredOwnerAttemptIsCurrent(ownerTabId, attempt);
    if (historyMutated && current) {
      // The destructive half already committed. Keeping the same action would
      // offer a retry against a target that was just removed from history.
      usePromptQueueStore.getState().commitSentHead(ownerTabId, head.id, triggerTabId);
    }
    if (current || historyMutated) {
      usePromptQueueStore.getState().setAutoRun(ownerTabId, false);
    }
    useUIStore.getState().showToast(
      queuedMetaActionDefaultTitle(head.metaAction || { kind: 'stop' }) + ' в очереди остановлен: ' + message,
      'error',
      5000,
      false,
      undefined,
      undefined,
      undefined,
      ownerTabId,
    );
  }).finally(() => {
    queueLifecycleStopInflight.delete(ownerTabId);
    queueSendInflight.delete(ownerTabId);
    if (!waitingForReadiness && deferredOwnerSends.get(ownerTabId) === attempt) {
      clearDeferredOwnerSend(ownerTabId, succeeded ? 'meta-action-committed' : 'meta-action-wait-or-failed');
    }
    if (succeeded && !ownerTabClosed && !workflowEndedByAction) {
      scheduleQueueFollowupAfterMetaAction(ownerTabId);
    }
    signalContinuationRelease(ownerTabId, 'meta-action-settled');
  });
  return true;
}

async function readExactQueueContextUsedPct(ownerTabId: string): Promise<{
  pct: number | null;
  reason: string;
}> {
  const provider = getPromptQueueAgent(ownerTabId);
  if (!provider) return { pct: null, reason: 'provider-owner-unknown' };
  const sessionId = getPromptQueueSessionId(ownerTabId, provider);
  if (!sessionId) return { pct: null, reason: 'session-owner-unknown' };
  try {
    const result: any = await ipcRenderer.invoke('tab:get-context-pct', {
      tabId: ownerTabId,
      provider,
      sessionId,
      requireExact: true,
    });
    const pct = Number(result?.pct);
    if (result?.exact !== true || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { pct: null, reason: String(result?.reason || 'exact-context-unavailable') };
    }
    return { pct, reason: 'exact-session-context' };
  } catch (error: any) {
    return { pct: null, reason: 'context-read-failed:' + String(error?.message || error) };
  }
}

/**
 * One bounded scheduler pass for context-gated cards.
 *
 * A false/unknown gate moves that card to the physical tail, so the visible
 * order remains the real execution order. Each enabled id is inspected at most
 * once per pass: an all-false queue returns to its original order and waits for
 * the next authoritative trigger instead of spinning.
 */
function beginConditionAwareQueueSend(
  ownerTabId: string,
  triggerTabId: string,
  head: QueuedPrompt,
  label: 'turn-end' | 'cold-start',
): boolean {
  if (!head.condition) {
    return beginValidatedQueueSend(ownerTabId, triggerTabId, head, label);
  }
  if (queueConditionChecks.has(ownerTabId) || queueSendInflight.has(ownerTabId)) return false;
  queueConditionChecks.add(ownerTabId);
  void (async () => {
    const checkedIds = new Set<string>();
    const initialEnabledCount = countEnabledQueuedPrompts(
      usePromptQueueStore.getState().getQueue(ownerTabId).items,
    );
    let contextSnapshot: Awaited<ReturnType<typeof readExactQueueContextUsedPct>> | null = null;

    while (checkedIds.size < initialEnabledCount) {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (!queue.autoRun || queue.firstDelayCountdownAt !== null) return;
      if (queueSendInflight.has(ownerTabId) || isPromptQueueEditorLocked(ownerTabId)) return;
      const candidate = enabledQueueHead(queue);
      if (!candidate || checkedIds.has(candidate.id)) return;

      const candidateTrigger = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
      if (candidateTrigger !== triggerTabId) {
        console.log('[PromptQueueRunner] context rotation reached item with another trigger owner='
          + ownerTabId.slice(-8) + ' item=' + candidate.id.slice(-8)
          + ' expected=' + triggerTabId.slice(-8) + ' actual=' + candidateTrigger.slice(-8));
        return;
      }
      if (candidate.trigger?.kind === 'timer' && candidate.trigger.seconds > 0) {
        usePromptQueueStore.getState().startFirstDelayCountdown(ownerTabId);
        for (const listener of queueDelayStartListeners) listener(ownerTabId, 'context-rotation');
        return;
      }
      if (!candidate.condition) {
        beginValidatedQueueSend(ownerTabId, triggerTabId, candidate, label);
        return;
      }

      contextSnapshot ??= await readExactQueueContextUsedPct(ownerTabId);
      const latestQueue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const latestCandidate = enabledQueueHead(latestQueue);
      if (latestCandidate?.id !== candidate.id
        || queuedPromptContextConditionKey(latestCandidate.condition)
          !== queuedPromptContextConditionKey(candidate.condition)
        || !latestQueue.autoRun) return;
      if (queuedPromptContextConditionMatches(candidate.condition, contextSnapshot.pct)) {
        console.log('[PromptQueueRunner] context gate passed owner=' + ownerTabId.slice(-8)
          + ' item=' + candidate.id.slice(-8)
          + ' condition=' + queuedPromptContextConditionKey(candidate.condition)
          + ' pct=' + contextSnapshot.pct);
        beginValidatedQueueSend(ownerTabId, triggerTabId, candidate, label);
        return;
      }

      checkedIds.add(candidate.id);
      const moved = usePromptQueueStore.getState().deferPromptToEnd(ownerTabId, candidate.id);
      console.log('[PromptQueueRunner] context gate deferred owner=' + ownerTabId.slice(-8)
        + ' item=' + candidate.id.slice(-8)
        + ' condition=' + queuedPromptContextConditionKey(candidate.condition)
        + ' pct=' + (contextSnapshot.pct == null ? '-' : contextSnapshot.pct)
        + ' reason=' + contextSnapshot.reason
        + ' moved=' + (moved ? '1' : '0'));
      if (!moved) return;
    }
  })().catch((error: unknown) => {
    console.error('[PromptQueueRunner] context scheduler failed owner=' + ownerTabId.slice(-8), error);
  }).finally(() => {
    queueConditionChecks.delete(ownerTabId);
  });
  return true;
}

function beginValidatedQueueSend(
  ownerTabId: string,
  triggerTabId: string,
  head: QueuedPrompt,
  label: 'turn-end' | 'cold-start',
  kind: ContinuationKind = 'queue',
  causeKey: string | null = null,
): boolean {
  if (kind === 'queue' && head.metaAction) {
    return beginValidatedQueueMetaAction(ownerTabId, triggerTabId, head, label);
  }
  if (queueSendInflight.has(ownerTabId)) return false;
  if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId)) return false;
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8)
      + ' editor payload locked → wait before firing');
    return false;
  }
  const queueAtStart = usePromptQueueStore.getState().getQueue(ownerTabId);
  const headAtStart = getContinuationPrompt(queueAtStart, kind);
  if (!headAtStart
    || headAtStart.id !== head.id
    || continuationTriggerTabId(ownerTabId, queueAtStart, kind) !== triggerTabId
    || (kind === 'queue' ? !queueAtStart.autoRun : !isLoopPromptActive(queueAtStart))) {
    return false;
  }
  if (kind === 'queue'
    && triggerTabId !== ownerTabId
    && !pivotTriggerHasFreshCompletion(queueAtStart, triggerTabId)) {
    console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8)
      + ' target=' + triggerTabId.slice(-8)
      + ' has no completed workflow after arm → wait');
    return false;
  }
  if (kind === 'loop' && !causeKey) {
    console.warn('[PromptQueueRunner] Loop send refused without exact causal outcome owner='
      + ownerTabId.slice(-8));
    return false;
  }
  queueSendInflight.add(ownerTabId);
  const attempt: DeferredOwnerSend = {
    kind,
    triggerTabId,
    headId: head.id,
    label,
    workflowArmedAt: continuationArmTimestamp(queueAtStart, kind),
    attemptId: ++queueSendAttemptSequence,
    causeKey,
    conditionKey: queuedPromptContextConditionKey(head.condition),
  };
  deferredOwnerSends.set(ownerTabId, attempt);
  let attemptedHandoffId: string | null = null;
  const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
  console.log('[PromptQueueRunner] ' + label + ' validate owner=' + ownerTabId.slice(-8)
    + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8)
    + ' kind=' + kind + ' item=' + head.id.slice(-8));

  void (async () => {
    const readiness = await readQueueOwnerReadiness(ownerTabId);
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'readiness-became-stale');
      return;
    }
    const scenarioStatusAtSend = ['active', 'busy', 'inactive', 'starting', 'stopping', 'unknown']
      .includes(readiness.status)
      ? readiness.status
      : 'starting';
    const scenarioCanPrepare = scenarioStatusAtSend === 'active'
      || scenarioStatusAtSend === 'inactive'
      || scenarioStatusAtSend === 'starting'
      || readiness.reason.startsWith('claude-startup-defaults-');
    if (!readiness.ready && !scenarioCanPrepare) {
      console.log('[PromptQueueRunner] ' + label + ' owner=' + ownerTabId.slice(-8)
        + ' trigger=' + triggerTabId.slice(-8)
        + ' → WAIT owner readiness status=' + readiness.status
        + ' inputReady=' + readiness.inputReady
        + ' reason=' + readiness.reason);
      return;
    }

    const validation = kind === 'loop'
      ? { ready: true, state: 'ready' as const, item: head }
      : await ensureQueuedPromptImagesReady(ownerTabId, head.id);
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'attachment-validation-became-stale');
      return;
    }
    if (!validation.ready || !validation.item) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'attachment-validation-refused');
      const store = usePromptQueueStore.getState();
      if (kind === 'loop') store.setLoopPromptEnabled(ownerTabId, false);
      else {
        store.setAutoRun(ownerTabId, false);
      }
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
    if (validation.degraded) {
      console.warn('[PromptQueueRunner] ' + label + ' attachment unavailable but transferable owner='
        + ownerTabId.slice(-8) + ' item=' + head.id.slice(-8)
        + ' action=replace-with-imageError');
    }
    const latestQueue = usePromptQueueStore.getState().getQueue(ownerTabId);
    const latestHead = getContinuationPrompt(latestQueue, kind);
    if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId)) {
      console.log('[PromptQueueRunner] ' + label + ' validation became stale owner=' + ownerTabId.slice(-8)
        + ' expected=' + head.id.slice(-8) + ' actual=' + (latestHead?.id.slice(-8) || '-'));
      return;
    }

    queueAwaitingBusyStart.add(ownerTabId);
    const rawPayload = buildQueuedPromptPayload(validation.item);
    const rawPresentationText = serializeComposerDraft({
      text: validation.item.text,
      chips: validation.item.chips || [],
    });
    const payload = kind === 'queue' ? withPostPrompt(ownerTabId, rawPayload) : rawPayload;
    const presentationText = (kind === 'queue'
      ? withPostPrompt(ownerTabId, rawPresentationText)
      : rawPresentationText).trim();
    const promptChips = (validation.item.chips || [])
      .filter((chip) => chip.kind === 'prompt')
      .map((chip) => ({
        ...(chip.id ? { id: chip.id } : {}),
        kind: 'prompt' as const,
        ...(chip.label ? { label: chip.label } : {}),
        text: chip.text,
        ...(chip.sourceKey ? { sourceKey: chip.sourceKey } : {}),
        ...(chip.inheritanceDepth ? { inheritanceDepth: chip.inheritanceDepth } : {}),
        ...(chip.inheritanceParentLabel
          ? { inheritanceParentLabel: chip.inheritanceParentLabel }
          : {}),
      }));
    const agent = getPromptQueueAgent(ownerTabId);
    if (!agent) {
      queueAwaitingBusyStart.delete(ownerTabId);
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'provider-owner-unknown-before-send');
      return;
    }
    const handoffId = buildPromptQueueReceiptHandoffId({
      kind,
      itemId: head.id,
      payload,
      causeKey: attempt.causeKey,
    });
    attemptedHandoffId = handoffId;
    const sessionIdHint = getPromptQueueSessionId(ownerTabId, agent);
    const beforeCount = countEnabledQueuedPrompts(latestQueue.items);
    const localCommandCandidate = isStandaloneAgentLocalCommand({
      prompt: payload,
      imageCount: validation.item.imagePaths?.length || 0,
      chipCount: promptChips.length,
    });
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-boundary-became-stale');
      return;
    }
    if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      console.log('[PromptQueueRunner] ' + label + ' workflow became blocked before send owner='
        + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8));
      return;
    }
    console.log('[PromptQueueRunner] ' + label + ' fire owner=' + ownerTabId.slice(-8)
      + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8)
      + ' handoff=' + handoffId
      + ' remaining=' + Math.max(0, beforeCount - 1));
    beginHistoryPromptHandoff({
      tabId: ownerTabId,
      handoffId,
      toolType: agent,
      sessionIdHint,
      text: presentationText,
      promptChips,
      imagePaths: validation.item.imagePaths || [],
      submittedAt: Date.now(),
      source: kind === 'loop' ? 'prompt-loop' : 'prompt-queue',
      statusAtSend: scenarioStatusAtSend,
      initialStatus: historyPromptHandoffInitialStatus(scenarioStatusAtSend),
      requiresAuditIdentity: !localCommandCandidate,
    });
    const res: any = await sendQueueCommand(ownerTabId, payload, {
      handoffId,
      presentationSnapshot: {
        historySessionId: sessionIdHint,
        promptChips,
        imagePaths: validation.item.imagePaths || [],
        ...(kind === 'loop'
          ? { semanticTags: [{ kind: 'prompt-origin' as const, source: 'loop' as const }] }
          : {}),
      },
    }, kind === 'loop' ? 'prompt-loop' : 'prompt-queue', scenarioStatusAtSend);
    if (promptQueueReceiptReplayNeedsNoBusyStart(res)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      console.log('[PromptQueueRunner] ' + label + ' durable replay owner='
        + ownerTabId.slice(-8) + ' handoff=' + handoffId + ' state=' + res.status
        + ' → no new busy edge expected');
    }
    const localCommandReceipt = projectAgentLocalCommandSendResult({
      candidate: localCommandCandidate,
      result: res,
    });
    const ownershipTransferred = localCommandReceipt.handled
      ? localCommandReceipt.transferred === true
      : queueSendTransferredOwnership(res);
    if (!ownershipTransferred) {
      queueAwaitingBusyStart.delete(ownerTabId);
      if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
        retractHistoryPromptHandoff(ownerTabId, handoffId, 'send-response-became-stale');
        clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-response-became-stale');
        console.log('[PromptQueueRunner] ' + label + ' ignored stale refused response owner=' + ownerTabId.slice(-8)
          + ' attempt=' + attempt.attemptId + ' error=' + (res?.error || 'unknown'));
        return;
      }
      if (res?.deferred === true || res?.error === 'codex_input_not_ready') {
        retractHistoryPromptHandoff(ownerTabId, handoffId, 'send-deferred-before-submit');
        console.log('[PromptQueueRunner] ' + label + ' owner=' + ownerTabId.slice(-8)
          + ' → WAIT main readiness admission error=' + (res?.error || 'not-ready'));
        return;
      }
      settleHistoryPromptHandoff(ownerTabId, handoffId, {
        queueStatus: 'failed',
        reason: 'send-refused-before-submit',
        requiresAuditIdentity: false,
      });
      clearDeferredOwnerSend(ownerTabId, 'send-refused');
      const store = usePromptQueueStore.getState();
      if (kind === 'loop') store.setLoopPromptEnabled(ownerTabId, false);
      else {
        store.setAutoRun(ownerTabId, false);
      }
      console.error('[PromptQueueRunner] ' + label + ' send refused owner=' + ownerTabId, res?.error);
      return;
    }
    const auditProof = localCommandReceipt.handled
      ? null
      : historyPromptHandoffAuditProofFromSendResult(res);
    const unconfirmedStatus = localCommandReceipt.handled
      ? (localCommandReceipt.queueStatus === 'delivery-unknown' ? 'delivery-unknown' : null)
      : historyPromptHandoffUnconfirmedStatusFromSendResult(res);
    const providerQueueReturned = !localCommandReceipt.handled
      && historyPromptAuditIsProviderQueueReturn(res?.pasteAudit || res);
    const finalAuditFailure = res?.success === false
      && res?.submitted === true
      && !unconfirmedStatus
      && !providerQueueReturned;
    settleHistoryPromptHandoff(ownerTabId, handoffId, {
      queueStatus: localCommandReceipt.handled
        ? localCommandReceipt.queueStatus
        : providerQueueReturned
        ? 'cancelled'
        : finalAuditFailure
        ? 'failed'
        : unconfirmedStatus
          || (res?.queued === true ? 'queued' : 'sent'),
      reason: localCommandReceipt.handled
        ? localCommandReceipt.reason || 'agent-local-command-result'
        : providerQueueReturned
        ? 'provider-queue-returned-to-terminal-composer'
        : finalAuditFailure
        ? 'send-submitted-audit-failed'
        : unconfirmedStatus === 'audit-pending'
          ? 'send-submitted-audit-pending'
          : unconfirmedStatus === 'delivery-unknown'
            ? 'send-delivery-unknown'
            : 'send-result',
      proof: auditProof,
      // Enter transfers delivery ownership, so the queue item is committed,
      // but text/time similarity is never allowed to impersonate audit proof.
      // A slow Codex rollout settles this same handoff over the late-audit IPC.
      requiresAuditIdentity: !localCommandReceipt.handled,
    });
    if (res && res.success === false && res.submitted === true) {
      console.warn('[PromptQueueRunner] ' + label + ' submitted but audit unverified owner=' + ownerTabId.slice(-8)
        + ' trigger=' + triggerTabId.slice(-8) + ' error=' + (res.error || 'unknown'));
    }
    const committed = kind === 'queue'
      ? usePromptQueueStore.getState().commitSentHead(ownerTabId, head.id, triggerTabId)
      : { removed: false, beforeCount: 1, targetCleared: false };
    if (kind === 'loop' && latestLoopCauseByOwner.get(ownerTabId) === attempt.causeKey) {
      latestLoopCauseByOwner.delete(ownerTabId);
    }
    clearDeferredOwnerSend(ownerTabId, 'committed');
    console.log('[PromptQueueRunner] ' + label + ' commit owner=' + ownerTabId.slice(-8)
      + ' trigger=' + triggerTabId.slice(-8) + ' removed=' + committed.removed
      + ' targetCleared=' + committed.targetCleared + ' before=' + committed.beforeCount);
  })().catch((error: unknown) => {
    queueAwaitingBusyStart.delete(ownerTabId);
    if (attemptedHandoffId) {
      settleHistoryPromptHandoff(ownerTabId, attemptedHandoffId, {
        queueStatus: 'failed',
        reason: 'send-error-before-submit',
        requiresAuditIdentity: false,
      });
    }
    if (kind === 'loop' && latestLoopCauseByOwner.get(ownerTabId) === attempt.causeKey) {
      latestLoopCauseByOwner.delete(ownerTabId);
    }
    const current = deferredOwnerAttemptIsCurrent(ownerTabId, attempt);
    clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-error');
    if (current) {
      const store = usePromptQueueStore.getState();
      if (kind === 'loop') store.setLoopPromptEnabled(ownerTabId, false);
      else {
        store.setAutoRun(ownerTabId, false);
      }
    }
    console.error('[PromptQueueRunner] ' + label + ' validated send failed owner=' + ownerTabId, error);
  }).finally(() => {
    queueSendInflight.delete(ownerTabId);
    const wakeSource = queueReadinessWakePending.get(ownerTabId) || null;
    queueReadinessWakePending.delete(ownerTabId);
    if (wakeSource && deferredOwnerSends.has(ownerTabId)) {
      retryDeferredOwnerSend(ownerTabId, 'latched:' + wakeSource);
    }
    signalContinuationRelease(ownerTabId, 'send-settled');
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
  explicitTaskComplete?: boolean;
  taskCompletionIntentId?: string | null;
  taskCompletionRequestedAt?: number | null;
};

type DeferredWorkflowOutcome = BusyStatePayload & { receivedAt: number };
type DeferredWorkflowOutcomeSet = {
  latest: DeferredWorkflowOutcome | null;
  abnormal: DeferredWorkflowOutcome | null;
};
const deferredWorkflowOutcomes = new Map<string, DeferredWorkflowOutcomeSet>();
const deferredOrchestrationNaturalOutcomes = new Map<string, {
  data: BusyStatePayload;
  source: string;
  outcomeTs: number;
}>();
const deferredContinuationPivotReleases = new Map<string, {
  outcomeTs: number;
  ownerTabIds: string[];
}>();
const continuationReleaseListeners = new Set<(tabId: string, source: string) => void>();
const processedNaturalOutcomes = new Map<string, { latestTs: number; keys: Set<string> }>();
const latestLoopCauseByOwner = new Map<string, string>();
const workflowRestoreReconciliationListeners = new Set<() => void>();
let workflowRestoreReconciled = false;
let workflowRestoreReconcilePromise: Promise<void> | null = null;

function signalContinuationRelease(tabId: string, source: string): void {
  for (const listener of continuationReleaseListeners) listener(tabId, source);
}

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
  const preservePivoted = isRecoverableAgentTurnInterruption(data.reason);
  const preserveLoop = preservePivoted;
  const disarmedOwners = usePromptQueueStore.getState().disarmQueuesForTrigger(
    data.tabId,
    outcomeTs,
    { preservePivoted, preserveLoop },
  );
  console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
    + ' reason=' + (data.reason || '-')
    + ' outcomeTs=' + outcomeTs
    + ' source=' + source
    + ' preservePivoted=' + (preservePivoted ? '1' : '0')
    + ' preserveLoop=' + (preserveLoop ? '1' : '0')
    + ' → DISARM trigger workflow owners=' + (disarmedOwners.length ? disarmedOwners.map(shortQueueTabId).join(',') : 'none/newer-arm'));
  if (disarmedOwners.length > 0) {
    const triggerName = getTabName(data.tabId) || 'вкладка-триггер';
    const outcome = data.reason === 'codex-no-final-result'
      ? 'завершилась без финального ответа'
      : /(interrupt|cancel|stop)/i.test(data.reason || '')
        ? 'была остановлена'
        : /(error|fail)/i.test(data.reason || '')
          ? 'завершилась с ошибкой'
          : 'завершилась нештатно';
    for (const ownerTabId of disarmedOwners) {
      useUIStore.getState().showToast(
        `Run after остановлен: «${triggerName}» ${outcome}`,
        'warning',
        0,
        true,
        undefined,
        undefined,
        undefined,
        ownerTabId,
        undefined,
        `Системная причина: ${data.reason || 'unknown'}`,
      );
    }
  }
  return disarmedOwners;
}

const SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS = new Set([
  'compact_boundary',
  'compact_summary',
  'compact_stdout',
]);

function isSuccessfulCompactLocalCommandEnd(data: BusyStatePayload): boolean {
  return data.reason === 'local-command' &&
    data.busy === false &&
    data.localCommand === '/compact' &&
    SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS.has(data.localCommandReason || '');
}

function hasActiveQueueWorkflow(queue: TabQueue): boolean {
  return queue.autoRun
    || queue.firstDelayCountdownAt !== null;
}

function workflowAcceptsNaturalOutcome(queue: TabQueue, outcomeTs: number | null): boolean {
  return isWorkflowOutcomeAtOrAfterArm(queue.workflowArmedAt, outcomeTs);
}

function pivotTriggerHasFreshCompletion(queue: TabQueue, triggerTabId: string): boolean {
  const latestOutcome = processedNaturalOutcomes.get(triggerTabId)?.latestTs;
  return Number.isFinite(latestOutcome)
    && workflowAcceptsNaturalOutcome(queue, Number(latestOutcome))
    && !queueOwnerHasPendingContinuation(triggerTabId);
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
  return prevBusyRef.get(tabId) === true || workspaceTabBusyNow(tabId);
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
      if (queue.firstDelayCountdownAt !== null) return false;
      if (queueSendInflight.has(ownerTabId)) return false;
      if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId)) {
        console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8) + ' workflow is busy → wait before firing trigger=' + triggerTabId.slice(-8));
        return false;
      }

      const head = enabledQueueHead(queue);
      if (!head) return false;
      if (head.trigger?.kind === 'timer' && head.trigger.seconds > 0) {
        usePromptQueueStore.getState().startFirstDelayCountdown(ownerTabId);
        for (const listener of queueDelayStartListeners) listener(ownerTabId, 'head-turn-end');
        return true;
      }
      return beginConditionAwareQueueSend(ownerTabId, triggerTabId, head, 'turn-end');
    };

    const fireLoopOwner = (
      ownerTabId: string,
      causeKey: string | null = latestLoopCauseByOwner.get(ownerTabId) || null,
    ): boolean => {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const prompt = getLoopPrompt(queue);
      if (!prompt || queueSendInflight.has(ownerTabId)) return false;
      if (isTabWorkflowBlocked(ownerTabId)) return false;
      return beginValidatedQueueSend(ownerTabId, ownerTabId, prompt, 'turn-end', 'loop', causeKey);
    };

    const releaseDeferredPivotOwners = (triggerTabId: string, source: string): void => {
      const deferred = deferredContinuationPivotReleases.get(triggerTabId);
      if (!deferred) return;
      if (prevBusyRef.get(triggerTabId) === true
        || queueOwnerHasPendingContinuationAt(triggerTabId, deferred.outcomeTs)) return;
      deferredContinuationPivotReleases.delete(triggerTabId);
      for (const ownerTabId of deferred.ownerTabIds) {
        const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!queue.autoRun || countEnabledQueuedPrompts(queue.items) === 0) continue;
        if (!workflowAcceptsNaturalOutcome(queue, deferred.outcomeTs)) continue;
        if (getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true }) !== triggerTabId) continue;
        fireQueueOwner(ownerTabId, triggerTabId);
      }
      console.log('[PromptQueueRunner] tab=' + triggerTabId.slice(-12)
        + ' pending continuation cleared → release pivoted owners source=' + source);
    };

    const continuationReleaseListener = (tabId: string, source: string) => {
      releaseDeferredPivotOwners(tabId, source);
    };
    continuationReleaseListeners.add(continuationReleaseListener);
    const unsubscribeContinuationQueue = usePromptQueueStore.subscribe(() => {
      pruneDeferredOwnerSends();
      for (const triggerTabId of deferredContinuationPivotReleases.keys()) {
        releaseDeferredPivotOwners(triggerTabId, 'queue-change');
      }
    });

    const getReadyTriggerForOwner = (ownerTabId: string): string | null => {
      if (!canValidateQueueTabs()) return null;
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (queueAwaitingBusyStart.has(ownerTabId)) return ownerTabId;
      if (queueSendInflight.has(ownerTabId)) return ownerTabId;
      if (isTabWorkflowBlocked(ownerTabId)) return null;

      if (!queue.autoRun || countEnabledQueuedPrompts(queue.items) === 0) {
        return isLoopPromptActive(queue) ? ownerTabId : null;
      }
      if (queue.firstDelayCountdownAt !== null) return null;

      const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
      if (effectiveTrigger === ownerTabId) return ownerTabId;

      // Pivoted queue can only fire after a successful target outcome newer than
      // this arm. An idle snapshot alone never grants readiness.
      if (!prevBusyRef.has(effectiveTrigger)) return null;
      if (isTabWorkflowBlocked(effectiveTrigger)) return null;
      if (!pivotTriggerHasFreshCompletion(queue, effectiveTrigger)) return null;
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
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (queue.autoRun && countEnabledQueuedPrompts(queue.items) > 0) {
        fireQueueOwner(ownerTabId, triggerTabId);
      } else if (triggerTabId === ownerTabId) {
        fireLoopOwner(ownerTabId);
      }
    });
    const onPromptAuditResult = (_event: unknown, detail: any) => {
      const auditTabId = typeof detail?.tabId === 'string' ? detail.tabId : '';
      const handoffId = typeof detail?.handoffId === 'string' ? detail.handoffId : '';
      if (!auditTabId || !handoffId) return;
      const current = getHistoryPromptHandoffsSnapshot(auditTabId)
        .find((handoff) => handoff.handoffId === handoffId);
      if (current && !historyPromptHandoffAcceptsAuditIdentity(current, detail)) {
        console.warn('[PromptQueueRunner] ignore stale prompt audit tab=' + auditTabId.slice(-12)
          + ' handoff=' + handoffId.slice(0, 24)
          + ' expectedAttempt=' + String(current.sendAttemptId || '-').slice(0, 12)
          + ' actualAttempt=' + String(detail?.sendAttemptId || '-').slice(0, 12));
        return;
      }
      if (detail.success === true) {
        const proof = historyPromptHandoffAuditProofFromSendResult({
          codexAudit: {
            success: true,
            auditTimestamp: detail.auditTimestamp,
            actualHash: detail.actualHash,
            actualLen: detail.actualLen,
            sessionId: detail.sessionId,
            entryUuid: detail.entryUuid,
            sourceIdentity: detail.sourceIdentity,
            canonicalized: detail.canonicalized,
            canonicalReason: detail.canonicalReason,
          },
        });
        if (!proof) return;
        settleHistoryPromptHandoff(auditTabId, handoffId, {
          queueStatus: 'sent',
          reason: detail.late === true ? 'late-audit-confirmed' : 'audit-confirmed',
          proof,
          requiresAuditIdentity: true,
        });
        return;
      }
      if (historyPromptAuditIsProviderQueueReturn(detail)) {
        settleHistoryPromptHandoff(auditTabId, handoffId, {
          queueStatus: 'cancelled',
          reason: 'provider-queue-returned-to-terminal-composer',
          requiresAuditIdentity: true,
        });
        return;
      }
      if (detail?.status === 'delivery-unknown' || detail?.deliveryUnknown === true) {
        settleHistoryPromptHandoff(auditTabId, handoffId, {
          queueStatus: 'delivery-unknown',
          reason: 'audit-unconfirmed:' + (detail.error || detail.code || 'unknown'),
          requiresAuditIdentity: true,
        });
        return;
      }
      settleHistoryPromptHandoff(auditTabId, handoffId, {
        queueStatus: 'failed',
        reason: 'audit-failed:' + (detail.error || 'unknown'),
        requiresAuditIdentity: true,
      });
    };
    ipcRenderer.on('agent-prompt:audit-result', onPromptAuditResult);
    const onPromptTransportPhase = (_event: unknown, detail: any) => {
      const transportTabId = typeof detail?.tabId === 'string' ? detail.tabId : '';
      const handoffId = typeof detail?.handoffId === 'string' ? detail.handoffId : '';
      const sendAttemptId = typeof detail?.sendAttemptId === 'string'
        ? detail.sendAttemptId.trim()
        : '';
      const sendOperationKey = typeof detail?.sendOperationKey === 'string'
        ? detail.sendOperationKey.trim()
        : '';
      const phase = detail?.phase;
      if (!transportTabId || !handoffId) return;
      if (phase !== 'sending' && phase !== 'confirming') return;
      // This runner is mounted at App root, unlike HistoryPanel. Transport
      // progress therefore survives a closed/background History surface and
      // remains available to the Run After overlay itself.
      const current = getHistoryPromptHandoffsSnapshot(transportTabId)
        .find((handoff) => handoff.handoffId === handoffId) || null;
      if (current
        && (current.source === 'prompt-queue' || current.source === 'prompt-loop')
        && sendAttemptId
        && current.sendAttemptId !== sendAttemptId) {
        // The stable queue operation id survives retries. A new main-owned
        // physical attempt is the only authority allowed to reopen an older
        // failed/cancelled projection before its paste begins.
        beginHistoryPromptHandoff({
          tabId: transportTabId,
          handoffId,
          sendAttemptId,
          sendOperationKey: sendOperationKey || undefined,
          toolType: current.toolType,
          sessionIdHint: current.sessionIdHint,
          text: current.text,
          promptChips: current.promptChips,
          imagePaths: current.imagePaths,
          authoringText: current.authoringText,
          authoringChips: current.authoringChips,
          authoringImagePaths: current.authoringImagePaths,
          submittedAt: Date.now(),
          source: current.source,
          statusAtSend: current.statusAtSend,
          initialStatus: 'sending',
          requiresAuditIdentity: current.requiresAuditIdentity,
        });
      }
      advanceHistoryPromptHandoffTransportPhase(transportTabId, handoffId, phase);
    };
    ipcRenderer.on('claude:paste-busy', onPromptTransportPhase);

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
        if (!q.autoRun
          || countEnabledQueuedPrompts(q.items) === 0
          || q.firstDelayCountdownAt !== null) continue;
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
      if (isOrchestrationCompletionBlocked(data.tabId)) {
        const current = deferredOrchestrationNaturalOutcomes.get(data.tabId);
        if (!current || outcomeTs >= current.outcomeTs) {
          deferredOrchestrationNaturalOutcomes.set(data.tabId, { data, source, outcomeTs });
        }
        console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
          + ' source=' + source + ' has inherited orchestration activity → DEFER workflow outcome');
        return;
      }
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
      const explicitTaskComplete = data.explicitTaskComplete === true;
      if (explicitTaskComplete) {
        const currentQueue = usePromptQueueStore.getState().getQueue(tabId);
        if (currentQueue.loopPromptEnabled) {
          usePromptQueueStore.getState().setLoopPromptEnabled(tabId, false);
        }
        console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
          + ' exact turn marked complete intent=' + (data.taskCompletionIntentId || '-')
          + ' → Loop disabled');
      }
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
      const queueTrigger = ownQueueBefore.autoRun && countEnabledQueuedPrompts(ownQueueBefore.items) > 0
        ? getEffectiveQueueTrigger(tabId, ownQueueBefore, { clearStaleTarget: true })
        : null;
      const continuationKind = choosePromptQueueContinuationForOutcome({
        queueActive: ownQueueBefore.autoRun && countEnabledQueuedPrompts(ownQueueBefore.items) > 0,
        queueTriggerIsOwner: queueTrigger === tabId,
        queueArmedAt: ownQueueBefore.workflowArmedAt,
        loopActive: isLoopPromptActive(ownQueueBefore),
        loopArmedAt: ownQueueBefore.loopPromptArmedAt,
        explicitTaskComplete,
      }, outcomeTs);

      if (continuationKind && ownersAtOutcome.length > 0) {
        deferredContinuationPivotReleases.set(tabId, {
          outcomeTs,
          ownerTabIds: ownersAtOutcome.filter((ownerTabId) => ownerTabId !== tabId),
        });
      }

      if (continuationKind === 'queue') {
        const ownContinuationTrigger = getReadyTriggerForOwner(tabId);
        if (ownContinuationTrigger) fireQueueOwner(tabId, ownContinuationTrigger);
        // The queue owns this completion even while its delay, editor lock,
        // owner readiness or send acknowledgement is pending. Loop and
        // downstream Run After subscribers must not consume the same edge.
        if (queueOwnerHasPendingContinuationAt(tabId, outcomeTs)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' own queue claims completion → defer Loop and pivoted owners');
          return;
        }
      } else if (continuationKind === 'loop') {
        latestLoopCauseByOwner.set(tabId, key);
        fireLoopOwner(tabId, key);
        if (queueOwnerHasPendingContinuationAt(tabId, outcomeTs)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' Loop claims completion → defer pivoted owners');
          return;
        }
      }

      // An armed queue is unfinished work even when its own trigger is still
      // busy or has never started. Downstream owners must wait for this tab to
      // actually run that continuation and finish its resulting turn.
      if (queueOwnerHasPendingContinuationAt(tabId, outcomeTs)) {
        if (ownersAtOutcome.length > 0 && !deferredContinuationPivotReleases.has(tabId)) {
          deferredContinuationPivotReleases.set(tabId, {
            outcomeTs,
            ownerTabIds: ownersAtOutcome.filter((ownerTabId) => ownerTabId !== tabId),
          });
        }
        console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' has pending continuation → defer pivoted owners');
        return;
      }

      deferredContinuationPivotReleases.delete(tabId);
      for (const ownerTabId of ownersAtOutcome) {
        if (ownerTabId !== tabId) fireQueueOwner(ownerTabId, tabId);
      }
    };

    const handleBusyState = (channel: 'claude' | 'gemini' | 'codex') =>
      (_: any, data: BusyStatePayload) => {
        const { tabId, busy, reason } = data;
        const effectiveOwner = getPromptQueueAgent(tabId);
        const commandType = getWorkspaceCommandType(tabId);
        const channelOwnsTab = channel === 'gemini'
          ? commandType === 'gemini'
          : effectiveOwner === channel;
        if (!channelOwnsTab) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' ch=' + channel
            + ' owner=' + (effectiveOwner || commandType || 'unknown')
            + ' reason=' + (reason || '-')
            + ' → IGNORE foreign lifecycle');
          return;
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
          deferredOrchestrationNaturalOutcomes.delete(tabId);
          deferredContinuationPivotReleases.delete(tabId);
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

        if (!busy && queueLifecycleStopInflight.has(tabId)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' ch=' + channel
            + ' reason=' + (reason || '-')
            + ' → IGNORE lifecycle edge owned by queued Stop/Close');
          return;
        }

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
        signalQueueOwnerReadiness(tabId, channel + '-turn-idle');
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
          if (!hasActiveQueueWorkflow(queue) && !isLoopPromptActive(queue)) continue;
          if (!tabExists(ownerTabId)) {
            usePromptQueueStore.getState().cleanupClosedTab(ownerTabId);
            continue;
          }
          if (isLoopPromptActive(queue)) triggers.add(ownerTabId);
          if (queue.autoRun && countEnabledQueuedPrompts(queue.items) > 0) {
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
      if (getPromptQueueAgent(state.tabId) !== 'codex') return;
      applyCodexTurnStateSnapshot(state.tabId, state, 'codex-state-resolved');
    };

    const claudeHandler = handleBusyState('claude');
    const geminiHandler = handleBusyState('gemini');
    const codexHandler = handleBusyState('codex');
    void initializeOrchestrationStore();
    const unsubscribeOrchestration = subscribeOrchestrationRunChanges((change) => {
      const tabId = change.sourceTabId;
      if (!change.releaseKind) return;

      if (change.releaseKind === 'handoff-started') {
        // The completion notification has become a real parent turn. Its
        // authoritative busy→idle edge now owns every Run After transition.
        deferredOrchestrationNaturalOutcomes.delete(tabId);
        return;
      }

      if (change.releaseKind === 'abnormal') {
        deferredOrchestrationNaturalOutcomes.delete(tabId);
        const outcome: BusyStatePayload = {
          tabId,
          busy: false,
          reason: 'orchestration-abnormal',
          outcomeTs: change.run.completedAt || Date.now(),
          turnId: change.run.runId,
        };
        if (canProcessWorkflowOutcomes()) {
          applyAbnormalQueueOutcome(outcome, 'orchestration-release', explicitOutcomeTimestamp(outcome));
        } else {
          rememberDeferredWorkflowOutcome(outcome);
        }
        return;
      }

      if (prevBusyRef.get(tabId) === true) return;
      const deferred = deferredOrchestrationNaturalOutcomes.get(tabId);
      if (deferred) {
        deferredOrchestrationNaturalOutcomes.delete(tabId);
        processSuccessfulWorkflowOutcome(
          deferred.data,
          deferred.source + '-orchestration-release',
          deferred.outcomeTs,
        );
      }
      for (const [ownerTabId, attempt] of deferredOwnerSends) {
        if (ownerTabId === tabId || attempt.triggerTabId === tabId) {
          retryDeferredOwnerSend(ownerTabId, 'orchestration-release');
        }
      }
    });
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
      if (getPromptQueueAgent(data.tabId) !== 'claude') return;
      // Claude's prompt is visible, but /model and /effort startup defaults may
      // still be applying. The gate event below is the actual send boundary.
      claudeQueueStartupPending.add(data.tabId);
    };
    const codexReadyHandler = (_: unknown, data: { tabId?: string }) => {
      if (data?.tabId && getPromptQueueAgent(data.tabId) === 'codex') {
        signalQueueOwnerReadiness(data.tabId, 'codex-tui-ready');
      }
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
    const unsubscribeOrchestrationHydration = useOrchestrationStore.subscribe(maybeReconcileRestoredWorkflows);
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
      unsubscribeOrchestrationHydration();
      unsubscribeOrchestration();
      unsubscribeContinuationQueue();
      continuationReleaseListeners.delete(continuationReleaseListener);
      ipcRenderer.removeListener('agent-prompt:audit-result', onPromptAuditResult);
      ipcRenderer.removeListener('claude:paste-busy', onPromptTransportPhase);
      unsubscribeEditorLocks();
    };
  }, []);

  // Cold-start watcher: when queue items + autoRun become true, an own-tab
  // firstDelay starts immediately from that explicit arm edge. Runtime
  // readiness is checked only when the delay expires. With zero delay, the
  // effective trigger still has to be authoritatively idle before firing.
  // Triggered on EITHER of two edges (whichever happens last makes the trio true):
  //   (a) items 0 → N  (user added a prompt; autoRun was already on)
  //   (b) autoRun false → true (user armed; items were already queued)
  // Edge (b) covers the case: "Claude finished without me, I forgot to arm —
  // I come back, hit Run after — first prompt must fire immediately, not wait
  // for a never-coming turn-end". Without this, the prompt sits forever.
  //
  // A pivoted target never cold-starts from its current idle snapshot. Picking
  // another tab means "wait for work that starts now or is already in flight",
  // not "reuse any historical completion from this renderer lifetime". The
  // authoritative busy→idle/outcome path below performs the eventual release.
  useEffect(() => {
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearTimer = (tabId: string) => {
      const t = pendingTimers.get(tabId);
      if (t) { clearTimeout(t); pendingTimers.delete(tabId); }
    };

    let firing = false;
    const fireHead = (
      ownerTabId: string,
      triggerTabId: string,
      options: { deferWhileBusy?: boolean } = {},
    ): boolean => {
      if (firing) return false;
      firing = true;
      try {
        const q = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) return false;
        if (q.firstDelayCountdownAt !== null) return false;
        if (queueSendInflight.has(ownerTabId)) return false;
        if (isOrchestrationCompletionBlocked(ownerTabId)
          || isOrchestrationCompletionBlocked(triggerTabId)) return false;
        if (prevBusyRef.get(ownerTabId) === true && options.deferWhileBusy !== true) return false;
        const head = q.items.find(isQueuedPromptEnabled);
        if (head) {
          return beginConditionAwareQueueSend(ownerTabId, triggerTabId, head, 'cold-start');
        }
        return false;
      } finally {
        firing = false;
      }
    };

    const scheduleFirstDelayTimer = (ownerTabId: string): void => {
      const latestQueue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (!latestQueue.autoRun
        || countEnabledQueuedPrompts(latestQueue.items) === 0
        || latestQueue.firstDelayCountdownAt === null) {
        usePromptQueueStore.getState().clearFirstDelayCountdown(ownerTabId);
        return;
      }

      const remainingMs = getFirstDelayRemainingMs(
        queueDelaySeconds(latestQueue),
        latestQueue.firstDelayCountdownAt,
      );
      if (remainingMs <= 0) {
        if (queueUsesItemTimer(latestQueue)) {
          usePromptQueueStore.getState().clearFirstDelayCountdown(ownerTabId);
        } else {
          usePromptQueueStore.getState().consumeFirstDelayCountdown(ownerTabId);
        }
        // The deadline is authoritative even if the owner is busy or a stale
        // busy snapshot survived a process stop. The validated send path
        // re-reads runtime presence and waits/launches without bypassing safety.
        fireHead(ownerTabId, ownerTabId, { deferWhileBusy: true });
        return;
      }

      const sliceMs = Math.min(remainingMs, MAX_BROWSER_TIMEOUT_MS);
      pendingTimers.set(ownerTabId, setTimeout(() => {
        pendingTimers.delete(ownerTabId);
        scheduleFirstDelayTimer(ownerTabId);
      }, sliceMs));
    };

    const startFirstDelayCountdown = (ownerTabId: string, source: string): boolean => {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const head = queue.items.find(isQueuedPromptEnabled);
      if (!queue.autoRun
        || !head
        || queueDelaySeconds(queue) <= 0
        || queue.firstDelayCountdownAt !== null
        || getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true }) !== ownerTabId) {
        return false;
      }
      usePromptQueueStore.getState().startFirstDelayCountdown(ownerTabId);
      clearTimer(ownerTabId);
      scheduleFirstDelayTimer(ownerTabId);
      console.log('[PromptQueueRunner] first-delay countdown started on arm owner='
        + ownerTabId.slice(-8) + ' seconds=' + queueDelaySeconds(queue)
        + ' source=' + source);
      return true;
    };

    const verifyCodexTriggerIdleThenFire = (ownerTabId: string, triggerTabId: string): boolean => {
      if (getWorkspaceCommandType(triggerTabId) !== 'codex') return false;
      if (isOrchestrationCompletionBlocked(ownerTabId)
        || isOrchestrationCompletionBlocked(triggerTabId)) return true;
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
        if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId)) return;

        if (ownerTabId !== triggerTabId) {
          if (queueOwnerHasPendingContinuation(triggerTabId)) {
            console.log('[PromptQueueRunner] codex-turn-state owner=' + ownerTabId.slice(-8) + ' target=' + triggerTabId.slice(-8) + ' has pending continuation → wait for chain drain');
            return;
          }
          fireHead(ownerTabId, triggerTabId);
          return;
        }

        if (q2.firstDelayCountdownAt !== null) return;
        if (queueDelaySeconds(q2) > 0) {
          startFirstDelayCountdown(ownerTabId, 'codex-own-cold-start');
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

        // Disarm/manual cancellation clears the active timer. Agent busy-state
        // does not: the countdown is a user-visible deadline that starts when
        // Run after is armed, while readiness gates only the eventual send.
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
        const prevHeadTrigger = prevQ ? enabledQueueHead(prevQ)?.trigger : undefined;
        const headTriggerChanged = JSON.stringify(prevHeadTrigger) !== JSON.stringify(enabledQueueHead(q)?.trigger);
        const automaticTargetClear = targetChanged && consumeAutomaticRunAfterTargetClear(tabId);
        if ((targetChanged || headTriggerChanged) && prevQ?.autoRun) {
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
          || (headTriggerChanged && q.autoRun)
          || (options.forceRuntimeArms === true && runtimeArm);
        if (!armEdge) continue;

        // Validate the picked target — stale id behaves as null (fall back to
        // own-tab default).
        const effectiveTrigger = getEffectiveQueueTrigger(tabId, q, { clearStaleTarget: true });

        if (effectiveTrigger !== tabId) {
          seedBusySnapshotFromWorkspace(effectiveTrigger, { replace: true });
          console.log('[PromptQueueRunner] pivot armed owner=' + tabId.slice(-8)
            + ' target=' + effectiveTrigger.slice(-8)
            + ' current=' + (isTabWorkflowBlocked(effectiveTrigger) ? 'busy' : 'idle')
            + ' → wait for next completed workflow');
          continue;
        }

        if (q.firstDelayCountdownAt !== null) continue;
        if (queueDelaySeconds(q) > 0) {
          // A per-item timer replaces the send that this edge/arm would have
          // performed. If the owner is still busy, wait for its real idle edge
          // instead of counting down in parallel with the active turn.
          if (queueUsesItemTimer(q) && isTabWorkflowBlocked(tabId)) continue;
          startFirstDelayCountdown(tabId, 'own-arm');
          continue;
        }

        // With no first delay, preserve the original cold-start readiness
        // checks before attempting an immediate send.
        if (verifyCodexTriggerIdleThenFire(tabId, tabId)) continue;
        const isBusy = isTabWorkflowBlocked(tabId);
        if (isBusy) continue;
        fireHead(tabId, tabId);
      }
    };

    const unsubscribeQueue = usePromptQueueStore.subscribe((state, prevState) => {
      pruneDeferredOwnerSends();
      evaluateQueues(state, prevState);
    });
    const delayStartListener = (ownerTabId: string) => {
      clearTimer(ownerTabId);
      scheduleFirstDelayTimer(ownerTabId);
    };
    queueDelayStartListeners.add(delayStartListener);
    const unsubscribeReconciliation = subscribeWorkflowRestoreReconciliation(() => {
      const current = usePromptQueueStore.getState();
      // Revisit only workflows explicitly armed in this renderer. Persisted
      // queues were already correlated against main-process outcomes above and
      // must never be synthesized as fresh 0→N / false→true edges.
      evaluateQueues(current, current, { forceRuntimeArms: true });
    });
    const unsubscribeOrchestration = subscribeOrchestrationRunChanges((change) => {
      if (change.releaseKind !== 'success' || isTabWorkflowBlocked(change.sourceTabId)) return;
      const current = usePromptQueueStore.getState();
      evaluateQueues(current, current, { forceRuntimeArms: true });
    });
    if (workflowRestoreReconciled) {
      const current = usePromptQueueStore.getState();
      evaluateQueues(current, current, { forceRuntimeArms: true });
    }
    return () => {
      unsubscribeQueue();
      unsubscribeReconciliation();
      unsubscribeOrchestration();
      queueDelayStartListeners.delete(delayStartListener);
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
    };
  }, []);
}
