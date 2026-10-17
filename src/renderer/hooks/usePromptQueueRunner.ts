import { useEffect } from 'react';
import { flushPromptQueueStoreSync, persistPromptQueueDeliveryPointer, queueSendOutcome, type PromptQueuePendingDelivery } from '../store/usePromptQueueStore';
import { buildQueuedPromptPayload, consumeAutomaticRunAfterTargetClear, countEnabledQueuedPrompts, ensureQueuedPromptImagesReady, hasMalformedQueuedImageMarker, hasPendingPromptQueueContinuation, hasRuntimeWorkflowArm, isLoopPromptActive, isPromptQueueEditorLocked, isPromptQueueStoreHydrated, isQueuedPromptEnabled, queuedMetaActionDefaultTitle, queuedPromptContextConditionKey, queuedPromptContextConditionMatches, queueSendTransferredOwnership, subscribePromptQueueEditorLocks, subscribePromptQueueHydration, usePromptQueueStore, type QueuedMetaAction, type QueuedPrompt, type TabQueue } from '../store/usePromptQueueStore';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { interruptionContinuesWithQueuedTurn, isNaturalAgentTurnEndReason, isRecoverableAgentTurnInterruption, normalizeAgentTurnEndReason } from '../utils/agentCompletionOutcome.mjs';
import { choosePromptQueueContinuationForOutcome, isWorkflowOutcomeAtOrAfterArm, planWorkflowReconciliation } from '../utils/promptQueueReconciliation.mjs';
import { getHistoryAgentRuntime } from '../utils/historyAgentRuntimes';
import { sendAgentPromptScenario } from '../utils/agentScenarios';
import { prepareTabWorkContext, settleTabWorkContext } from '../utils/tabWorkContext';
import { promptQueueOutcomeFloor } from '../store/usePromptQueueStore';
import { promptQueueContextWasSkipped, setPromptQueueContextSkipped } from '../store/usePromptQueueStore';
import { prepareAgentRuntimeForSend } from '../utils/agentSendPreparation';
import { createAgentLaunchAdmission } from '../utils/agentLaunchAdmission.mjs';
import { getAgentSendProviderContract } from '../utils/agentSendProviderContract';
import { AGENT_SETTINGS_INTENT_NONE } from '../utils/agentSendSettingsContract';
import {
  isStandaloneAgentLocalCommand,
  projectAgentLocalCommandSendResult,
} from '../utils/agentLocalCommand.mjs';
import { getClaudeStartupDefaultsGateSnapshot } from '../utils/claudeStartupDefaultsGate';
import { serializeComposerDraft } from '../utils/composerChips.mjs';
import { getFirstDelayRemainingMs, MAX_BROWSER_TIMEOUT_MS } from '../utils/promptQueueDelay';
import { buildRunAfterIncidentReport } from '../utils/runAfterIncidentReport.mjs';
import { LOOP_TASK_COMPLETION_PROTOCOL } from '../../shared/task-completion-protocol.mjs';
import {
  initializeOrchestrationStore,
  isOrchestrationCompletionBlocked,
  subscribeOrchestrationRunChanges,
  useOrchestrationStore,
} from '../store/useOrchestrationStore';
import {
  advanceHistoryPromptHandoffTransportPhase,
  acceptHistoryPromptHandoffProviderQueue,
  beginHistoryPromptHandoff,
  getHistoryPromptHandoffsSnapshot,
  historyPromptHandoffBlocksNewSubmit,
  subscribeHistoryPromptHandoffs,
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
import { applyClaudePtySettings } from '../utils/claudePtyActions';
import { flushAutoCompactStoreSync, hydrateAutoCompactStore, useAutoCompactStore } from '../store/useAutoCompactStore';
import { workflowForTab } from '../utils/workflowMembership.mjs';
import { createAutoCompactCoordinator } from '../utils/autoCompactCoordinator.mjs';
import { executeAutoCompact, type AutoCompactTarget } from '../utils/autoCompactRuntime';
import { pendingAgentSendScenarioCount, subscribeAgentSendScenarios } from '../utils/agentSendSequencer.mjs';
import { dictationBlocksSend } from '../utils/dictationChips.mjs';
import { classifyQueuedCodexSettingsIntent } from '../utils/promptQueueCodexSettingsIntent.mjs';
import { getAppRuntimeIdentity } from '../utils/appRuntimeIdentity';
import { appRestartTriggerIsSatisfied } from '../utils/promptQueueAppRestart.mjs';
import { pendingPromptTabIds, promptTabTriggerMatches, promptTabTriggerReady } from '../utils/promptQueueDependencies.mjs';
import { hasPendingAgentGoalWork } from '../../shared/agent-work-completion.mjs';
import { hasPromptQueueContextConditionKey, promptQueueContextConditionKeysEqual } from '../../shared/prompt-queue-send-intent.cjs';

const { ipcRenderer } = window.require('electron');
// A planned process shutdown pauses automation; its synthetic Ctrl+C outcomes
// must not cancel the promises restored by the next app instance.
const queueRendererStartedAt = Date.now();
let queueAppRuntimeInstanceId: string | null = null;
let queueAppRuntimeStartedAt: number | null = null;
let queueShutdownPending = false;
const observedWorkflowStarts = new Set<string>();
const autoCompactTurnStarts = new Map<string, number>();
let autoCompactCoordinator: ReturnType<typeof createAutoCompactCoordinator> | null = null;

export function getAutoCompactTarget(tabId: string): AutoCompactTarget | null {
  const state = useWorkspaceStore.getState();
  for (const [projectId, workspace] of state.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (!tab) continue;
    const provider = resolvePtyAgentOwner(tab);
    const sessionId = provider === 'codex' ? tab.codexSessionId : tab.claudeSessionId;
    if (!provider || !sessionId || tab.tabType === 'claude-sdk') return null;
    return { tabId, projectId, provider, sessionId, cwd: tab.cwd || workspace.projectPath,
      workflowId: workflowForTab(state, tabId, projectId),
      membershipRevision: state.tabWorkflowMembership?.[tabId]?.revision };
  }
  return null;
}

export function requestAutoCompactNow(tabId: string, resume = false): Promise<any> {
  return autoCompactCoordinator?.request(tabId, { resume })
    || Promise.resolve({ error: 'Автокомпакт ещё не готов' });
}

export function cancelPendingAutoCompact(tabId: string, activityId: string | null = null): boolean {
  return autoCompactCoordinator?.cancel(tabId, true, activityId) === true;
}

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
  return !queueShutdownPending && isPromptQueueStoreHydrated()
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
  if (action.kind === 'model-effort') return 'Model / effort изменены';
  if (action.kind === 'stop') return 'Агент остановлен';
  return 'Вкладка закрыта';
}

const CODEX_QUEUE_SETTINGS_TIMEOUT_MS = 45_000;

async function applyQueuedCodexModelEffort(
  tabId: string,
  model: string,
  effort: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let expectedRevision = 0;
    let lastState: any = null;
    let settled = false;
    let proofCheckInFlight = false;
    let lastIntentError = '';
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let proofRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (proofRetryTimer) clearTimeout(proofRetryTimer);
      ipcRenderer.removeListener('provider:state-changed', onProviderState);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const verifyCurrentOwner = async (state: any) => {
      if (proofCheckInFlight || settled) return;
      proofCheckInFlight = true;
      try {
        const runtime = await ipcRenderer.invoke('codex:get-runtime-session', { tabId });
        if (settled) return;
        const current = await ipcRenderer.invoke('provider:get-status', { tabId });
        if (settled) return;
        lastState = current;
        const classification = classifyQueuedCodexSettingsIntent(current, {
          revision: expectedRevision,
          model,
          effort,
        });
        if (classification.kind !== 'applied') {
          if (classification.kind === 'pending') {
            lastIntentError = classification.error || lastIntentError;
          } else {
            inspect(current);
          }
          return;
        }
        lastIntentError = '';
        const currentOwner = String(
          runtime?.provenWriterSessionId || runtime?.codexProvisionalSettingsOwnerId || '',
        ).trim();
        const appliedOwner = String(current?.codexSettingsIntentAppliedOwnerId || '').trim();
        if (runtime?.liveLifecycle === true
          && currentOwner
          && appliedOwner === currentOwner
          && Number(current?.codexSettingsIntentAppliedRevision || 0) === expectedRevision) {
          finish();
        }
      } catch (error: any) {
        console.warn('[PromptQueueRunner] Codex settings owner proof unavailable tab='
          + tabId.slice(-8) + ' error=' + String(error?.message || error));
      } finally {
        proofCheckInFlight = false;
        if (!settled && lastState !== state) {
          inspect(lastState);
        } else if (!settled
          && Number(lastState?.codexSettingsIntentAppliedRevision || 0) === expectedRevision
          && !proofCheckInFlight
          && !proofRetryTimer) {
          proofRetryTimer = setTimeout(() => {
            proofRetryTimer = null;
            void verifyCurrentOwner(lastState);
          }, 350);
        }
      }
    };
    const inspect = (state: any) => {
      if (!state || typeof state !== 'object') return;
      lastState = state;
      if (!expectedRevision) return;
      const classification = classifyQueuedCodexSettingsIntent(state, {
        revision: expectedRevision,
        model,
        effort,
      });
      if (classification.kind === 'replaced') {
        finish(new Error('Настройка Codex была заменена более новым выбором'));
        return;
      }
      if (classification.kind === 'different-pair') {
        finish(new Error('Codex сохранил другую пару model / effort'));
        return;
      }
      if (classification.kind === 'failed') {
        finish(new Error('Codex не подтвердил model / effort: ' + classification.error));
        return;
      }
      if (classification.kind === 'pending') {
        lastIntentError = classification.error || lastIntentError;
        return;
      }
      if (classification.kind === 'applied') {
        lastIntentError = '';
        // An equal revision from a previous Codex process is not proof for the
        // current queue position. Bind the applied marker to the exact current
        // writer/launch owner before removing the card.
        void verifyCurrentOwner(state);
      }
    };
    const onProviderState = (_event: unknown, data: { tabId?: string; state?: any }) => {
      if (data?.tabId === tabId) inspect(data.state);
    };
    timeout = setTimeout(() => {
      finish(new Error('Codex не подтвердил смену model / effort за 45 секунд'
        + (lastIntentError ? ' (последняя попытка: ' + lastIntentError + ')' : '')));
    }, CODEX_QUEUE_SETTINGS_TIMEOUT_MS);

    ipcRenderer.on('provider:state-changed', onProviderState);
    void (async () => {
      const result = await ipcRenderer.invoke('codex:set-model-effort-intent', {
        tabId,
        model,
        effort,
        control: 'model',
      });
      if (result?.success !== true) {
        throw new Error(result?.error || 'Codex не принял смену model / effort');
      }
      expectedRevision = Number(result.intentRevision || 0);
      if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) {
        throw new Error('Codex не вернул номер операции смены model / effort');
      }
      inspect(lastState);
      inspect(result.providerState);
      if (settled) return;
      const current = await ipcRenderer.invoke('provider:get-status', { tabId });
      inspect(current);
    })().catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
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
    promptQueueIntent?: Record<string, unknown>;
    expectedTarget?: import('../utils/historyAgentRuntimes').AgentSendTarget;
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
    ...(handoff.promptQueueIntent ? { promptQueueIntent: handoff.promptQueueIntent } : {}),
    ...(handoff.expectedTarget ? { expectedTarget: handoff.expectedTarget } : {}),
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

function queueItemTriggerCanFire(item: QueuedPrompt | null): boolean {
  if (item?.trigger?.kind === 'onTab' && item.trigger.dependencies) return promptTabTriggerReady(item.trigger);
  if (!item || item.trigger?.kind !== 'app-restart') return true;
  return appRestartTriggerIsSatisfied(item.trigger, queueAppRuntimeInstanceId);
}

function queueDelaySeconds(queue: TabQueue): number {
  const head = enabledQueueHead(queue);
  return head?.trigger?.kind === 'timer' ? head.trigger.seconds : queue.firstDelaySeconds;
}

function queueUsesItemTimer(queue: TabQueue): boolean {
  return enabledQueueHead(queue)?.trigger?.kind === 'timer';
}

type ContinuationKind = 'queue' | 'loop';

function shortPromptFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getLoopPrompt(queue: TabQueue): QueuedPrompt | null {
  if (queue.loopRestartPending) return null;
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
    if (head.trigger.dependencies && promptTabTriggerReady(head.trigger)) return targetTabId;
    if (!canValidateQueueTabs()) return targetTabId;
    if (tabCanTriggerQueue(ownerTabId, targetTabId)) return targetTabId;
    if (options.clearStaleTarget) {
      console.warn('[PromptQueueRunner] item onTab trigger ' + targetTabId.slice(-8)
        + ' is no longer valid, clearing → owner=' + ownerTabId.slice(-8));
      if (head.trigger.dependencies) usePromptQueueStore.getState().removePromptTabDependency(ownerTabId, head.id, targetTabId);
      else usePromptQueueStore.getState().setPromptTrigger(ownerTabId, head.id, null);
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
const queueManualStopping = new Set<string>();

function hasPriorWorkflowInput(tabId: string): boolean {
  const handoffs = getHistoryPromptHandoffsSnapshot(tabId);
  const ownId = deferredOwnerSends.get(tabId)?.handoffId;
  const own = ownId ? handoffs.find(handoff => handoff.handoffId === ownId) : null;
  // Readiness/Resume and a caller returning audit-pending are still input work.
  // A later manual FIFO follower must not block its already admitted head,
  // and this queue's own scenario must not wait for itself.
  if (!own && pendingAgentSendScenarioCount(tabId) > 0) return true;
  return historyPromptHandoffBlocksNewSubmit(handoffs.filter(handoff => {
    if (handoff.handoffId === ownId) return false;
    if (!own) return true;
    if (Number.isFinite(own.applicationQueuePosition) && Number.isFinite(handoff.applicationQueuePosition)) {
      return handoff.applicationQueuePosition! < own.applicationQueuePosition!;
    }
    return handoff.submittedAt <= own.submittedAt;
  }));
}

function subscribeWorkflowInputRelease(wake: (tabId: string) => void): () => void {
  let disposed = false;
  const subscriptions = new Map<string, () => void>();
  const release = (tabId: string) => queueMicrotask(() => { if (!disposed) wake(tabId); });
  const refresh = () => {
    const targets = new Set<string>();
    for (const [tabId, queue] of usePromptQueueStore.getState().queues) {
      if (!queue.autoRun && !isLoopPromptActive(queue)) continue;
      targets.add(tabId);
      targets.add(getEffectiveQueueTrigger(tabId, queue));
    }
    for (const [tabId, unsubscribe] of subscriptions) if (!targets.has(tabId)) {
      unsubscribe(); subscriptions.delete(tabId);
    }
    for (const tabId of targets) if (!subscriptions.has(tabId)) {
      let previous = getHistoryPromptHandoffsSnapshot(tabId);
      subscriptions.set(tabId, subscribeHistoryPromptHandoffs(tabId, snapshot => {
        const failedInputReleased = snapshot.some(handoff =>
          (handoff.queueStatus === 'failed' || handoff.queueStatus === 'cancelled')
          && previous.some(old => old.handoffId === handoff.handoffId
            && old.queueStatus !== handoff.queueStatus));
        previous = snapshot;
        // A sent receipt is not whole-turn completion. That wake remains with
        // the existing natural outcome/readiness owner, not this input journal.
        if (failedInputReleased) release(tabId);
      }));
    }
  };
  refresh();
  const unsubscribeQueue = usePromptQueueStore.subscribe(refresh);
  const unsubscribeScenarios = subscribeAgentSendScenarios(({ tabId, pending }: { tabId: string; pending: number }) => {
    if (pending === 0 && subscriptions.has(tabId)) release(tabId);
  });
  return () => {
    disposed = true; unsubscribeQueue(); unsubscribeScenarios();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
    subscriptions.clear();
  };
}

function isTabWorkflowBlocked(tabId: string, waitingItem?: QueuedPrompt | null): boolean {
  if (waitingItem?.trigger?.kind === 'onTab' && waitingItem.trigger.dependencies
    && promptTabTriggerReady(waitingItem.trigger)) return false;
  if (hasPriorWorkflowInput(tabId)) return true;
  return queueShutdownPending || queueManualStopping.has(tabId) || autoCompactCoordinator?.has(tabId) === true
    || prevBusyRef.get(tabId) === true || isOrchestrationCompletionBlocked(tabId)
    || Array.from(useWorkspaceStore.getState().openProjects.values()).some(workspace =>
      hasPendingAgentGoalWork({ goalWork: workspace.tabs.get(tabId)?.codexGoalWork }));
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
type QueuePreparationSource = {
  projectId: string | null;
  provider: QueueAgent | null;
  sessionId: string | null;
  preparedSessionId?: string;
  cwd: string | undefined;
  authoredPayload: string;
};
type DeferredOwnerSend = {
  kind: ContinuationKind;
  triggerTabId: string;
  headId: string;
  label: 'turn-end' | 'cold-start';
  workflowArmedAt: number | null;
  attemptId: number;
  causeKey: string | null;
  conditionKey: string;
  triggerKey: string;
  metaActionKey?: string;
  contextProof?: QueueContextProof;
  handoffId?: string;
  payloadKey?: string;
  expectedTarget?: import('../utils/historyAgentRuntimes').AgentSendTarget;
  preparationSource?: QueuePreparationSource;
  preparationController?: AbortController;
  cancelledByManualStop?: boolean;
};
// A trigger can be fully satisfied while the queue owner is stopped. Keep that
// result separate from `queueAwaitingBusyStart` (which means Enter was already
// accepted) and retry exactly once when the owner's TUI becomes input-ready.
const deferredOwnerSends = new Map<string, DeferredOwnerSend>();
const queueReceiptReads = new Set<string>();

function pauseUnresolvedQueueDelivery(ownerTabId: string, pending: PromptQueuePendingDelivery): void {
  // Do not run the pre-write cancellation/retract path after an unknown call.
  // Main's immutable receipt/FIFO remains the sole delivery authority.
  deferredOwnerSends.delete(ownerTabId);
  queueReadinessWakePending.delete(ownerTabId);
  const store = usePromptQueueStore.getState();
  store.setPendingDelivery(ownerTabId, pending);
  const q = store.getQueue(ownerTabId);
  if (q.autoRun) store.setAutoRun(ownerTabId, false);
  if (q.loopPromptEnabled) store.setLoopPromptEnabled(ownerTabId, false);
  settleHistoryPromptHandoff(ownerTabId, pending.handoffId, {
    queueStatus: 'delivery-unknown', reason: 'automatic-send-outcome-unknown', requiresAuditIdentity: true,
  });
}

// Passive reconciliation of one exact pointer, never another enqueue or audit
// job. Mounted at App root, so a hidden/closed overlay has the same guarantee.
export async function reconcilePromptQueuePendingDelivery(ownerTabId: string): Promise<boolean> {
  const pending = usePromptQueueStore.getState().getQueue(ownerTabId).pendingDelivery;
  if (!pending || queueReceiptReads.has(ownerTabId) || queueSendInflight.has(ownerTabId)) return false;
  queueReceiptReads.add(ownerTabId);
  try {
    const result = await ipcRenderer.invoke('agent:list-send-receipts', {
      tabId: ownerTabId, surface: 'desktop-history', handoffId: pending.handoffId, operationKey: pending.operationKey,
    });
    if (usePromptQueueStore.getState().getQueue(ownerTabId).pendingDelivery !== pending) return false;
    const record = result?.success === true && Array.isArray(result.records)
      ? result.records.find((r: any) => r.tabId === ownerTabId && r.handoffId === pending.handoffId
        && r.operationKey === pending.operationKey) : null;
    if (!record) return false; // missing/unavailable is not a no-submit proof
    const outcome = record.state === 'confirmed' ? 'transferred'
      : ['reserved', 'preparing', 'in-flight'].includes(record.state) && record.receipt?.submitted !== true
        ? 'unknown' : queueSendOutcome(record.receipt);
    if (outcome === 'unknown') return false;
    const store = usePromptQueueStore.getState(), q = store.getQueue(ownerTabId);
    if (outcome === 'transferred' && pending.kind === 'queue') {
      const head = enabledQueueHead(q);
      if (head?.id === pending.itemId
        && promptQueueContextConditionKeysEqual(queuedPromptContextConditionKey(head.condition), pending.conditionKey)
        && JSON.stringify(head.trigger || null) === pending.triggerKey
        && buildPromptQueueReceiptHandoffId({ kind: 'queue', itemId: head.id,
          payload: withPostPrompt(ownerTabId, buildQueuedPromptPayload(head)), causeKey: null }) === pending.baseHandoffId) {
        store.commitSentHead(ownerTabId, head.id, pending.triggerTabId);
      }
    }
    if (pending.kind === 'loop' && latestLoopCauseByOwner.get(ownerTabId) === pending.causeKey) {
      latestLoopCauseByOwner.delete(ownerTabId);
    }
    store.setPendingDelivery(ownerTabId, null, pending.handoffId);
    settleHistoryPromptHandoff(ownerTabId, pending.handoffId, {
      queueStatus: outcome === 'transferred' ? 'sent' : 'failed',
      reason: 'same-operation-receipt-' + outcome,
      proof: historyPromptHandoffAuditProofFromSendResult(record.receipt),
      requiresAuditIdentity: outcome === 'transferred',
      sendAttemptId: record.attemptId, sendOperationKey: record.operationKey,
    });
    await persistPromptQueueDeliveryPointer();
    signalContinuationRelease(ownerTabId, 'delivery-reconciled');
    return true;
  } catch (error) {
    console.warn('[PromptQueueRunner] exact receipt read failed owner=' + ownerTabId.slice(-8), error);
    return false;
  } finally { queueReceiptReads.delete(ownerTabId); }
}
// A satisfied Run After trigger can reach its send boundary while Voice
// Record is still resolving an inline dictation marker inside the queue item.
// Preserve that exact causal attempt; the marker resolution wakes it. Merely
// changing another queue field must never synthesize a new turn-end.
const deferredDictationSends = new Map<string, DeferredOwnerSend>();
const claudeQueueStartupPending = new Set<string>();
const queueReadinessWakePending = new Map<string, string>();
const queueDeadlineWakeListeners = new Set<(tabId: string) => void>();
// Exact context reads are async. One owner may have only one scheduler pass in
// flight, otherwise two simultaneous turn-end/cold-start signals could rotate
// the same card twice before either sees the other's new head.
const queueConditionChecks = new Map<string, { headId: string; triggerTabId: string }>();
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

function captureQueuePreparationSource(ownerTabId: string, prompt: QueuedPrompt): QueuePreparationSource {
  const provider = getPromptQueueAgent(ownerTabId);
  return {
    projectId: findProjectIdForTab(ownerTabId),
    provider,
    sessionId: provider ? getPromptQueueSessionId(ownerTabId, provider) : null,
    cwd: getTabCwd(ownerTabId),
    // Ref materialization updates managed paths/status independently. Preserve
    // the authored markers/chips here; its existing owner validates refs later.
    authoredPayload: withPostPrompt(ownerTabId, serializeComposerDraft({
      text: prompt.text, chips: prompt.chips || [],
    })),
  };
}

function queuePreparationSourceIsCurrent(
  ownerTabId: string,
  attempt: DeferredOwnerSend,
  options: { allowSessionChange?: boolean } = {},
): boolean {
  const expected = attempt.preparationSource;
  const prompt = getContinuationPrompt(usePromptQueueStore.getState().getQueue(ownerTabId), attempt.kind);
  if (!expected || !prompt) return false;
  const current = captureQueuePreparationSource(ownerTabId, prompt);
  if (expected.preparedSessionId && current.sessionId === expected.preparedSessionId) {
    expected.sessionId = expected.preparedSessionId;
    delete expected.preparedSessionId;
  }
  return current.projectId === expected.projectId
    && current.provider === expected.provider
    && (options.allowSessionChange || current.sessionId === expected.sessionId)
    && current.cwd === expected.cwd && current.authoredPayload === expected.authoredPayload;
}

function continuationAttemptIsCurrent(
  ownerTabId: string,
  queue: TabQueue,
  attempt: DeferredOwnerSend,
): boolean {
  const prompt = getContinuationPrompt(queue, attempt.kind);
  if (!prompt || prompt.id !== attempt.headId) return false;
  if (!promptQueueContextConditionKeysEqual(queuedPromptContextConditionKey(prompt.condition), attempt.conditionKey)) return false;
  if (JSON.stringify(prompt.trigger || null) !== attempt.triggerKey) return false;
  if (attempt.metaActionKey !== undefined && queuedActionExecutionKey(prompt.metaAction) !== attempt.metaActionKey) return false;
  if (attempt.payloadKey !== undefined
    && withPostPrompt(ownerTabId, buildQueuedPromptPayload(prompt)) !== attempt.payloadKey) return false;
  if (continuationArmTimestamp(queue, attempt.kind) !== attempt.workflowArmedAt) return false;
  if (continuationTriggerTabId(ownerTabId, queue, attempt.kind) !== attempt.triggerTabId) return false;
  return attempt.kind === 'loop' ? isLoopPromptActive(queue) : queue.autoRun;
}

function signalQueueOwnerReadiness(ownerTabId: string, source: string): void {
  void reconcilePromptQueuePendingDelivery(ownerTabId);
  autoCompactCoordinator?.wake(ownerTabId);
  retryDeferredOwnerSend(ownerTabId, source);
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId), head = enabledQueueHead(queue);
  if (queue.autoRun && head?.trigger?.kind === 'onTab' && head.trigger.dependencies
    && promptTabTriggerReady(head.trigger) && !deferredOwnerSends.has(ownerTabId)
    && !queueSendInflight.has(ownerTabId) && !queueAwaitingBusyStart.has(ownerTabId)
    && !isTabWorkflowBlocked(ownerTabId) && pivotTriggerHasFreshCompletion(queue, head.trigger.tabId)) {
    beginConditionAwareQueueSend(ownerTabId, head.trigger.tabId, head, 'turn-end');
  }
  for (const listener of queueDeadlineWakeListeners) listener(ownerTabId);
}

export function signalPromptQueueDictationResolved(ownerTabId: string, itemId: string): boolean {
  const attempt = deferredDictationSends.get(ownerTabId);
  if (!attempt || attempt.headId !== itemId) return false;
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
  if (!continuationAttemptIsCurrent(ownerTabId, queue, attempt)) {
    deferredDictationSends.delete(ownerTabId);
    return false;
  }
  const head = getContinuationPrompt(queue, attempt.kind);
  if (!head || dictationBlocksSend(head.text)) return false;
  deferredDictationSends.delete(ownerTabId);
  console.log('[PromptQueueRunner] dictation resolved → retry exact send owner='
    + ownerTabId.slice(-8) + ' item=' + itemId.slice(-8));
  return beginValidatedQueueSend(
    ownerTabId,
    attempt.triggerTabId,
    head,
    attempt.label,
    attempt.kind,
    attempt.causeKey,
  );
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

function clearDeferredOwnerSend(ownerTabId: string, reason: string, release = true): void {
  queueReadinessWakePending.delete(ownerTabId);
  const attempt = deferredOwnerSends.get(ownerTabId);
  if (!deferredOwnerSends.delete(ownerTabId)) return;
  if (reason !== 'committed') attempt?.preparationController?.abort();
  if (attempt?.handoffId && reason !== 'committed') {
    // Revoke only this pending automatic input, never Stop the Goal/provider.
    void ipcRenderer.invoke('agent:cancel-send', { tabId: ownerTabId, handoffId: attempt.handoffId })
      .catch(error => console.warn('[PromptQueueRunner] revoke pending input: ' + String(error)));
  }
  console.log('[PromptQueueRunner] deferred owner cleared owner=' + ownerTabId.slice(-8) + ' reason=' + reason);
  if (release) signalContinuationRelease(ownerTabId, 'deferred-cleared:' + reason);
  else notifyPromptQueueRuntime(ownerTabId, 'deferred-cleared:' + reason);
}

// A Main-accepted process Stop revokes preparations belonging to that process,
// not the saved queue. Late readiness/context/editor callbacks must not undo the
// Stop. Future deadlines/dependencies still enter the usual Resume/send path.
function cancelPreparationsForManualStop(tabId: string): void {
  autoCompactCoordinator?.stop(tabId);
  deferredOrchestrationNaturalOutcomes.delete(tabId);
  deferredContinuationPivotReleases.delete(tabId);
  processedNaturalOutcomes.delete(tabId);
  latestLoopCauseByOwner.delete(tabId);
  queueAwaitingBusyStart.delete(tabId);
  const completedBatch = (ownerTabId: string) => {
    const trigger = enabledQueueHead(usePromptQueueStore.getState().getQueue(ownerTabId))?.trigger;
    return ownerTabId !== tabId && trigger?.kind === 'onTab' && trigger.dependencies && promptTabTriggerReady(trigger);
  };
  for (const [ownerTabId, attempt] of deferredOwnerSends) {
    if (ownerTabId !== tabId && attempt.triggerTabId !== tabId) continue;
    if (completedBatch(ownerTabId)) continue;
    attempt.cancelledByManualStop = true;
    attempt.preparationController?.abort();
    clearDeferredOwnerSend(ownerTabId, 'manual-stop', false);
  }
  for (const [ownerTabId, attempt] of deferredDictationSends) {
    if (completedBatch(ownerTabId)) continue;
    if (ownerTabId === tabId || attempt.triggerTabId === tabId) deferredDictationSends.delete(ownerTabId);
  }
  for (const [ownerTabId, check] of queueConditionChecks) {
    if (ownerTabId !== tabId && check.triggerTabId !== tabId) continue;
    if (completedBatch(ownerTabId)) continue;
    queueConditionChecks.delete(ownerTabId);
    notifyPromptQueueRuntime(ownerTabId, 'condition-check-cancelled:manual-stop');
  }
  for (const ownerTabId of queueEditorBlockedOwners) {
    if (completedBatch(ownerTabId)) continue;
    if (ownerTabId === tabId
      || getEffectiveQueueTrigger(ownerTabId, usePromptQueueStore.getState().getQueue(ownerTabId)) === tabId) {
      queueEditorBlockedOwners.delete(ownerTabId);
    }
  }
  notifyPromptQueueRuntime(tabId, 'manual-stop');
}

function handleQueueAgentStopping(_event: unknown, data: { tabId?: string; toolType?: string; stopping?: boolean; reason?: string }): void {
  if (!data?.tabId || queueShutdownPending) return;
  const owner = getPromptQueueAgent(data.tabId) || getWorkspaceCommandType(data.tabId);
  if (data.toolType && data.toolType !== owner) return;
  if (data.stopping === false) {
    if (queueManualStopping.delete(data.tabId)) {
      notifyPromptQueueRuntime(data.tabId, 'manual-stop-settled');
      for (const listener of queueDeadlineWakeListeners) listener(data.tabId);
    }
    return;
  }
  if (data.stopping !== true || data.reason !== 'manual-stop') return;
  queueManualStopping.add(data.tabId);
  cancelPreparationsForManualStop(data.tabId);
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
  if (autoCompactCoordinator?.has(ownerTabId) || queueAwaitingBusyStart.has(ownerTabId)
    || queueSendInflight.has(ownerTabId)
    || deferredOwnerSends.has(ownerTabId)
    || isOrchestrationCompletionBlocked(ownerTabId)) return true;
  return hasPendingPromptQueueContinuation(usePromptQueueStore.getState().getQueue(ownerTabId));
}

function queueOwnerHasPendingContinuationAt(ownerTabId: string, outcomeTs: number): boolean {
  if (autoCompactCoordinator?.has(ownerTabId) || queueAwaitingBusyStart.has(ownerTabId)
    || queueSendInflight.has(ownerTabId)
    || deferredOwnerSends.has(ownerTabId)
    || isOrchestrationCompletionBlocked(ownerTabId)) return true;
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
  const queuePending = queue.autoRun
    && countEnabledQueuedPrompts(queue.items) > 0
    && !promptQueueContextWasSkipped(queue)
    && (workflowAcceptsNaturalOutcome(queue, outcomeTs)
      || (hasRuntimeWorkflowArm(ownerTabId)
        && getEffectiveQueueTrigger(ownerTabId, queue) === ownerTabId));
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
    if (!queueItemTriggerCanFire(head)) return;
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
  contextProof?: QueueContextProof,
): boolean {
  if (!head.metaAction || queueSendInflight.has(ownerTabId) || !queueItemTriggerCanFire(head)) return false;
  if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId, head)) return false;
  const queueAtStart = usePromptQueueStore.getState().getQueue(ownerTabId);
  if (queueAtStart.pendingDelivery) {
    void reconcilePromptQueuePendingDelivery(ownerTabId);
    return false;
  }
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
  const triggerKey = JSON.stringify(head.trigger || null);
  const attempt: DeferredOwnerSend = existing?.headId === head.id
    && promptQueueContextConditionKeysEqual(existing.conditionKey, conditionKey)
    && existing.triggerKey === triggerKey
    && existing.metaActionKey === queuedActionExecutionKey(head.metaAction)
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
        triggerKey,
        metaActionKey: queuedActionExecutionKey(head.metaAction),
        contextProof,
      };
  deferredOwnerSends.set(ownerTabId, attempt);

  queueSendInflight.add(ownerTabId);
  let succeeded = false;
  notifyPromptQueueRuntime(ownerTabId, 'preparing-meta-action');
  let waitingForReadiness = false;
  let ownerTabClosed = false;
  let workflowEndedByAction = false;
  void (async () => {
    const presence = await readQueueOwnerReadiness(ownerTabId);
    if (!await refreshQueueAttemptContext(ownerTabId, attempt)) return;
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
    } else if (action.kind === 'model-effort') {
      let observedModel = action.model;
      let observedEffort = action.effort;
      const agent = getPromptQueueAgent(ownerTabId);
      if (agent !== action.toolType) {
        throw new Error('Тип агента изменился после добавления model / effort в очередь');
      }
      if (presence.status !== 'active') {
        throw new Error('Агент остановлен — model / effort можно применить после его запуска');
      }
      if (agent === 'claude') {
        const providerState = await ipcRenderer.invoke('provider:get-status', { tabId: ownerTabId });
        const providerType = String(providerState?.type || '').trim();
        if (!providerType) {
          throw new Error('Не удалось подтвердить текущий Claude provider');
        }
        if (providerType !== 'anthropic') {
          throw new Error('Claude provider изменился — выберите model / effort заново');
        }
        const applied = await applyClaudePtySettings({
          tabId: ownerTabId,
          model: action.model,
          effort: action.effort,
          source: 'prompt-queue:model-effort',
        });
        observedModel = applied.appliedSettings.model || action.model;
        observedEffort = applied.appliedSettings.effort || action.effort;
      } else {
        await applyQueuedCodexModelEffort(ownerTabId, action.model, action.effort);
      }
      window.dispatchEvent(new CustomEvent('prompt-queue:model-effort-applied', {
        detail: {
          tabId: ownerTabId,
          toolType: action.toolType,
          model: observedModel,
          effort: observedEffort,
        },
      }));
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
    if (attempt.cancelledByManualStop && !historyMutated) return;
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

type QueueContextProof = {
  pct: number | null;
  reason: string;
  provider?: 'claude' | 'codex';
  sessionId?: string;
};
function queuedActionExecutionKey(action?: QueuedMetaAction): string {
  if (!action) return 'null';
  // targetIteration is presentation enrichment, not an execution identity.
  const { targetIteration: _displayOnly, ...execution } = action as any;
  return JSON.stringify(execution);
}
async function refreshQueueAttemptContext(
  ownerTabId: string,
  attempt: DeferredOwnerSend,
  options: { forceFresh?: boolean } = {},
): Promise<boolean> {
  if (!hasPromptQueueContextConditionKey(attempt.conditionKey)) return true;
  const provider = getPromptQueueAgent(ownerTabId);
  const sessionId = provider && getPromptQueueSessionId(ownerTabId, provider);
  if (options.forceFresh || attempt.contextProof?.provider !== provider || attempt.contextProof?.sessionId !== sessionId) {
    attempt.contextProof = await readExactQueueContextUsedPct(ownerTabId);
  }
  const queue = usePromptQueueStore.getState().getQueue(ownerTabId), head = getContinuationPrompt(queue, attempt.kind);
  return deferredOwnerAttemptIsCurrent(ownerTabId, attempt) && !!head
    && attempt.contextProof?.provider === getPromptQueueAgent(ownerTabId)
    && attempt.contextProof?.sessionId === getPromptQueueSessionId(ownerTabId, getPromptQueueAgent(ownerTabId)!)
    && queuedPromptContextConditionMatches(head.condition, attempt.contextProof.pct);
}
async function readExactQueueContextUsedPct(ownerTabId: string): Promise<QueueContextProof> {
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
    const pct = result?.pct;
    if (getPromptQueueAgent(ownerTabId) !== provider || getPromptQueueSessionId(ownerTabId, provider) !== sessionId) {
      return { pct: null, reason: 'context-owner-changed' };
    }
    if (result?.exact !== true || result.provider !== provider || result.sessionId !== sessionId
      || typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { pct: null, reason: String(result?.reason || 'exact-context-unavailable') };
    }
    return { pct, reason: 'exact-session-context', provider, sessionId };
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
  if (promptQueueContextWasSkipped(usePromptQueueStore.getState().getQueue(ownerTabId))) return false;
  if (!head.condition) {
    return beginValidatedQueueSend(ownerTabId, triggerTabId, head, label);
  }
  if (queueConditionChecks.has(ownerTabId) || queueSendInflight.has(ownerTabId)) return false;
  const check = { headId: head.id, triggerTabId,
    armedAt: promptQueueOutcomeFloor(usePromptQueueStore.getState().getQueue(ownerTabId)) };
  const falseItems = new Map<string, QueuedPrompt>();
  let contextSnapshot: Awaited<ReturnType<typeof readExactQueueContextUsedPct>> | null = null;
  queueConditionChecks.set(ownerTabId, check);
  notifyPromptQueueRuntime(ownerTabId, 'checking-condition');
  void (async () => {
    const checkedIds = new Set<string>();
    const initialEnabledCount = countEnabledQueuedPrompts(
      usePromptQueueStore.getState().getQueue(ownerTabId).items,
    );

    while (checkedIds.size < initialEnabledCount) {
      if (queueConditionChecks.get(ownerTabId) !== check) return;
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (!queue.autoRun || queue.firstDelayCountdownAt !== null
        || promptQueueOutcomeFloor(queue) !== check.armedAt) return;
      if (queueSendInflight.has(ownerTabId) || isPromptQueueEditorLocked(ownerTabId)) return;
      const candidate = enabledQueueHead(queue);
      if (!candidate || checkedIds.has(candidate.id)) return;
      if (!queueItemTriggerCanFire(candidate)) return;

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

      const currentProvider = getPromptQueueAgent(ownerTabId);
      check.headId = candidate.id;
      notifyPromptQueueRuntime(ownerTabId, 'checking-condition');
      if (!contextSnapshot || contextSnapshot.provider !== currentProvider
        || contextSnapshot.sessionId !== (currentProvider && getPromptQueueSessionId(ownerTabId, currentProvider))) {
        contextSnapshot = await readExactQueueContextUsedPct(ownerTabId);
      }
      if (queueConditionChecks.get(ownerTabId) !== check) return;
      const latestQueue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const latestCandidate = enabledQueueHead(latestQueue);
      if (latestCandidate?.id !== candidate.id
        || queuedPromptContextConditionKey(latestCandidate.condition)
          !== queuedPromptContextConditionKey(candidate.condition)
        || JSON.stringify(latestCandidate.trigger || null) !== JSON.stringify(candidate.trigger || null)
        || promptQueueOutcomeFloor(latestQueue) !== check.armedAt
        || !latestQueue.autoRun) return;
      if (queuedPromptContextConditionMatches(candidate.condition, contextSnapshot.pct)) {
        console.log('[PromptQueueRunner] context gate passed owner=' + ownerTabId.slice(-8)
          + ' item=' + candidate.id.slice(-8)
          + ' condition=' + queuedPromptContextConditionKey(candidate.condition)
          + ' pct=' + contextSnapshot.pct);
        beginValidatedQueueSend(ownerTabId, triggerTabId, candidate, label, 'queue', null, contextSnapshot);
        return;
      }

      checkedIds.add(candidate.id);
      // Unknown context still waits. Only a fresh numeric false result can
      // finish this pass without running the preserved card.
      if (contextSnapshot.pct !== null) falseItems.set(candidate.id, latestCandidate);
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
    const currentCheck = queueConditionChecks.get(ownerTabId) === check;
    if (currentCheck) queueConditionChecks.delete(ownerTabId);
    const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
    const enabled = queue.items.filter(isQueuedPromptEnabled);
    const provider = getPromptQueueAgent(ownerTabId);
    const skipped = currentCheck && queue.autoRun && enabled.length > 0
      && promptQueueOutcomeFloor(queue) === check.armedAt
      && queue.firstDelayCountdownAt === null && !queue.pendingDelivery
      && !queueSendInflight.has(ownerTabId) && !queueAwaitingBusyStart.has(ownerTabId)
      && !deferredOwnerSends.has(ownerTabId)
      && !isTabWorkflowBlocked(ownerTabId) && !isPromptQueueEditorLocked(ownerTabId)
      && !isTabWorkflowBlocked(triggerTabId, enabled[0])
      && contextSnapshot?.provider === provider && !!provider
      && contextSnapshot.sessionId === getPromptQueueSessionId(ownerTabId, provider)
      && enabled.every(item => falseItems.get(item.id) === item);
    if (skipped) {
      setPromptQueueContextSkipped(queue, true);
      console.log('[PromptQueueRunner] context pass skipped owner=' + ownerTabId.slice(-8)
        + ' items=' + enabled.length + ' → release current continuation');
    }
    if (skipped) signalContinuationRelease(ownerTabId, 'conditions-skipped');
    else {
      notifyPromptQueueRuntime(ownerTabId, 'condition-check-settled');
      autoCompactCoordinator?.wake(ownerTabId);
    }
  });
  return true;
}

// Delivery of the frozen body does not authorize deleting a newer authored
// body under the same item id. Keep commit/legacy target cleanup with Store.
function commitTransferredQueueSource(ownerTabId: string, attempt: DeferredOwnerSend) {
  const store = usePromptQueueStore.getState(), queue = store.getQueue(ownerTabId);
  const item = queue.items.find(it => it.id === attempt.headId);
  if (item && (item.metaAction
    || withPostPrompt(ownerTabId, buildQueuedPromptPayload(item)) !== attempt.payloadKey
    || !promptQueueContextConditionKeysEqual(queuedPromptContextConditionKey(item.condition), attempt.conditionKey)
    || JSON.stringify(item.trigger || null) !== attempt.triggerKey)) {
    return { removed: false, beforeCount: countEnabledQueuedPrompts(queue.items), targetCleared: false };
  }
  return store.commitSentHead(ownerTabId, attempt.headId, attempt.triggerTabId);
}

function beginValidatedQueueSend(
  ownerTabId: string,
  triggerTabId: string,
  head: QueuedPrompt,
  label: 'turn-end' | 'cold-start',
  kind: ContinuationKind = 'queue',
  causeKey: string | null = null,
  contextProof?: QueueContextProof,
): boolean {
  if (kind === 'queue' && head.metaAction) {
    return beginValidatedQueueMetaAction(ownerTabId, triggerTabId, head, label, contextProof);
  }
  if (queueSendInflight.has(ownerTabId)) return false;
  if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId, head)) return false;
  if (isPromptQueueEditorLocked(ownerTabId)) {
    queueEditorBlockedOwners.add(ownerTabId);
    console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8)
      + ' editor payload locked → wait before firing');
    return false;
  }
  const queueAtStart = usePromptQueueStore.getState().getQueue(ownerTabId);
  const headAtStart = getContinuationPrompt(queueAtStart, kind);
  if (queueAtStart.pendingDelivery) {
    void reconcilePromptQueuePendingDelivery(ownerTabId);
    return false;
  }
  if (!headAtStart
    || headAtStart.id !== head.id
    || continuationTriggerTabId(ownerTabId, queueAtStart, kind) !== triggerTabId
    || (kind === 'queue' ? !queueAtStart.autoRun : !isLoopPromptActive(queueAtStart))) {
    return false;
  }
  if (kind === 'queue' && !queueItemTriggerCanFire(headAtStart)) return false;
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
  if (dictationBlocksSend(headAtStart.text)) {
    deferredDictationSends.set(ownerTabId, {
      kind,
      triggerTabId,
      headId: headAtStart.id,
      label,
      workflowArmedAt: continuationArmTimestamp(queueAtStart, kind),
      attemptId: ++queueSendAttemptSequence,
      causeKey,
      conditionKey: queuedPromptContextConditionKey(headAtStart.condition),
      triggerKey: JSON.stringify(headAtStart.trigger || null),
    });
    console.log('[PromptQueueRunner] ' + label + ' owner=' + ownerTabId.slice(-8)
      + ' item=' + headAtStart.id.slice(-8) + ' → WAIT dictation marker');
    return true;
  }
  queueSendInflight.add(ownerTabId);
  const previousPreparation = deferredOwnerSends.get(ownerTabId);
  const attempt: DeferredOwnerSend = {
    kind,
    triggerTabId,
    headId: head.id,
    label,
    workflowArmedAt: continuationArmTimestamp(queueAtStart, kind),
    attemptId: ++queueSendAttemptSequence,
    causeKey,
    conditionKey: queuedPromptContextConditionKey(head.condition),
    triggerKey: JSON.stringify(head.trigger || null),
    metaActionKey: queuedActionExecutionKey(head.metaAction),
    contextProof,
    ...(kind === 'queue' ? { preparationSource: captureQueuePreparationSource(ownerTabId, headAtStart) } : {}),
    ...(previousPreparation && continuationAttemptIsCurrent(ownerTabId, queueAtStart, previousPreparation)
      ? { expectedTarget: previousPreparation.expectedTarget } : {}),
  };
  deferredOwnerSends.set(ownerTabId, attempt);
  const controller = kind === 'queue' ? new AbortController() : null;
  if (controller) attempt.preparationController = controller;
  let launchAdmission: ReturnType<typeof createAgentLaunchAdmission> | undefined;
  let sessionReconciliation: { sessionId: string; promise: Promise<void> } | null = null;
  const revokePreparation = () => {
    if (!controller || controller.signal.aborted) return;
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)
      || !queuePreparationSourceIsCurrent(ownerTabId, attempt, { allowSessionChange: true })) {
      controller.abort('run-after-preparation-changed');
      return;
    }
    const provider = attempt.preparationSource?.provider;
    const sessionId = provider ? getPromptQueueSessionId(ownerTabId, provider) : null;
    if (sessionReconciliation && sessionReconciliation.sessionId !== sessionId) {
      controller.abort('run-after-preparation-changed');
      return;
    }
    if (queuePreparationSourceIsCurrent(ownerTabId, attempt)) return;
    if (!sessionId || !launchAdmission) {
      controller.abort('run-after-preparation-changed');
      return;
    }
    if (sessionReconciliation) return;
    const reconciliation = { sessionId, promise: Promise.resolve() };
    sessionReconciliation = reconciliation;
    // This synchronously revokes the original Main write authority first.
    // Only a read-only proof of that exact already-launched owner may join;
    // neither an arbitrary renderer binding nor a late ACK can re-enable it.
    reconciliation.promise = launchAdmission.reconcileSession(sessionId).then(accepted => {
      if (controller.signal.aborted) return;
      if (!accepted || !deferredOwnerAttemptIsCurrent(ownerTabId, attempt)
        || !queuePreparationSourceIsCurrent(ownerTabId, attempt, { allowSessionChange: true })
        || getPromptQueueSessionId(ownerTabId, provider!) !== sessionId) {
        controller.abort('run-after-preparation-changed');
        return;
      }
      attempt.preparationSource!.sessionId = sessionId;
    }).catch(() => { controller.abort('run-after-preparation-changed'); });
  };
  const assertAdmissionCurrent = () => {
    revokePreparation();
    if (controller?.signal.aborted) throw Object.assign(new Error('Run After preparation changed'), {
      code: 'agent_send_cancelled', cancelled: true, reason: 'run-after-preparation-changed',
      stage: 'renderer-admission',
    });
  };
  const awaitSourceCurrent = async () => {
    assertAdmissionCurrent();
    if (sessionReconciliation) await sessionReconciliation.promise;
    assertAdmissionCurrent();
  };
  const acceptPreparedSession = (sessionId: string) => {
    assertAdmissionCurrent();
    const source = attempt.preparationSource;
    if (!source || source.sessionId !== null || source.preparedSessionId || !sessionId) {
      throw Object.assign(new Error('Run After preparation binding changed'), {
        code: 'agent_send_cancelled', cancelled: true, reason: 'run-after-preparation-changed',
        stage: 'renderer-admission',
      });
    }
    // Only the existing startFresh owner calls this, after its exact Main
    // materialization result and before its own renderer binding mutation.
    // setSession can await persistence. Accept the previous binding until the
    // exact authorized new one is observed, then never accept the old one again.
    source.preparedSessionId = sessionId;
  };
  const unsubscribePreparation = controller ? usePromptQueueStore.subscribe(revokePreparation) : () => {};
  const unsubscribePreparationWorkspace = controller ? useWorkspaceStore.subscribe(revokePreparation) : () => {};
  const unsubscribePreparationEditor = controller
    ? subscribePromptQueueEditorLocks(tab => { if (tab === ownerTabId) revokePreparation(); }) : () => {};
  const source = attempt.preparationSource;
  // Acquire the original Main fence before even the first readiness read.
  // An already-ready Send need not use this launch scope, but a later Resume
  // must not mint a new intent after a Stop which raced that read.
  launchAdmission = controller && source?.provider ? createAgentLaunchAdmission({
    invoke: ipcRenderer.invoke.bind(ipcRenderer), events: ipcRenderer, tabId: ownerTabId,
    toolType: source.provider, sessionId: source.sessionId, cwd: source.cwd,
    assertCurrent: assertAdmissionCurrent, signal: controller.signal,
  }) : undefined;
  let attemptedHandoffId: string | null = null;
  notifyPromptQueueRuntime(ownerTabId, 'preparing-send');
  let pendingDelivery: PromptQueuePendingDelivery | null = null;
  let sendDispatched = false;
  const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
  console.log('[PromptQueueRunner] ' + label + ' validate owner=' + ownerTabId.slice(-8)
    + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8)
    + ' kind=' + kind + ' item=' + head.id.slice(-8));

  void (async () => {
    let enteredOwnPreparation = false;
    let readiness = await readQueueOwnerReadiness(ownerTabId);
    if (!await refreshQueueAttemptContext(ownerTabId, attempt)) return;
    if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      clearDeferredOwnerAttempt(ownerTabId, attempt, 'readiness-became-stale');
      return;
    }
    if (!readiness.ready && kind === 'queue'
      && (['inactive', 'starting', 'active'].includes(readiness.status) || readiness.reason.startsWith('claude-startup-defaults-'))) {
      const agent = getPromptQueueAgent(ownerTabId);
      if (!agent) return;
      const runtime = getHistoryAgentRuntime(agent);
      assertAdmissionCurrent();
      enteredOwnPreparation = true;
      // Reuse the common lifecycle/readiness preparer BEFORE admitting an
      // ordinary message. A resumed Goal can already be doing the work.
      const prepared = await prepareAgentRuntimeForSend({ tabId: ownerTabId, runtime,
        providerContract: getAgentSendProviderContract(agent, runtime),
        sessionId: getPromptQueueSessionId(ownerTabId, agent), cwd: getTabCwd(ownerTabId),
        expectedTarget: attempt.expectedTarget,
        requestedStatusAtSend: readiness.status as any, admissionSignal: controller!.signal,
        assertAdmissionCurrent, acceptPreparedSession, launchAdmission });
      attempt.expectedTarget = prepared.expectedTarget;
      readiness = { ready: prepared.submitCapability === 'direct', status: prepared.status,
        inputReady: prepared.presence?.inputReady === true, reason: 'prepared-runtime' };
      await awaitSourceCurrent();
      // Own Resume/readiness can change the usage of the same session. Read
      // it once again before freezing an ordinary Send identity.
      if (!await refreshQueueAttemptContext(ownerTabId, attempt, { forceFresh: true })) return;
      await awaitSourceCurrent();
      if (!deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) return;
      if (!readiness.ready) {
        console.log('[PromptQueueRunner] ' + label + ' prepared owner=' + ownerTabId.slice(-8) + ' → WAIT active work');
        return;
      }
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
    if (!await refreshQueueAttemptContext(ownerTabId, attempt)) return;
    if (enteredOwnPreparation) await awaitSourceCurrent();
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
    if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId, head)) {
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
    let payload = kind === 'queue' ? withPostPrompt(ownerTabId, rawPayload) : rawPayload;
    let presentationText = (kind === 'queue'
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
      ...(kind === 'queue' ? { armedAt: attempt.workflowArmedAt } : {}),
    });
    const baseHandoffId = buildPromptQueueReceiptHandoffId({ kind, itemId: head.id, payload, causeKey: attempt.causeKey });
    attemptedHandoffId = handoffId;
    attempt.handoffId = handoffId;
    if (kind === 'queue') attempt.payloadKey = payload;
    const contextPrepared = await prepareTabWorkContext(ownerTabId, handoffId, payload);
    payload = contextPrepared.prompt;
    presentationText = contextPrepared.prefix + presentationText;
    if (!await refreshQueueAttemptContext(ownerTabId, attempt)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      return;
    }
    if (enteredOwnPreparation) await awaitSourceCurrent();
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
    if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId, head)) {
      queueAwaitingBusyStart.delete(ownerTabId);
      console.log('[PromptQueueRunner] ' + label + ' workflow became blocked before send owner='
        + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8));
      return;
    }
    console.log('[PromptQueueRunner] ' + label + ' fire owner=' + ownerTabId.slice(-8)
      + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8)
      + ' handoff=' + handoffId
      + ' remaining=' + Math.max(0, beforeCount - 1));
    pendingDelivery = { version: 1, kind, itemId: head.id, handoffId, baseHandoffId,
      operationKey: `history:${ownerTabId}:${handoffId}`, triggerTabId,
      triggerKey: attempt.triggerKey, conditionKey: attempt.conditionKey,
      causeKey: attempt.causeKey, createdAt: Date.now() };
    if (!usePromptQueueStore.getState().setPendingDelivery(ownerTabId, pendingDelivery)) return;
    await persistPromptQueueDeliveryPointer();
    if (!await refreshQueueAttemptContext(ownerTabId, attempt)
      || !deferredOwnerAttemptIsCurrent(ownerTabId, attempt)) {
      usePromptQueueStore.getState().setPendingDelivery(ownerTabId, null, handoffId);
      queueAwaitingBusyStart.delete(ownerTabId);
      void settleTabWorkContext(ownerTabId, handoffId, { submitted: false });
      return;
    }
    if (enteredOwnPreparation) await awaitSourceCurrent();
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
    sendDispatched = true;
    const res: any = await sendQueueCommand(ownerTabId, payload, {
      handoffId,
      ...(kind === 'queue' ? { promptQueueIntent: { version: 1, kind: 'queue', itemId: head.id,
        baseHandoffId, armedAt: attempt.workflowArmedAt, triggerTabId, conditionKey: attempt.conditionKey, triggerKey: attempt.triggerKey,
        ...(attempt.contextProof ? { contextProof: attempt.contextProof } : {}) },
        expectedTarget: attempt.expectedTarget } : {}),
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
    if (!ownershipTransferred && queueSendOutcome(res) === 'unknown' && localCommandReceipt.restoreDraftSafe !== true) {
      queueAwaitingBusyStart.delete(ownerTabId);
      // A legacy renderer may have lost its pointer before this upgrade. Main
      // can return the exact older frozen operation instead of admitting the
      // new arm; retain THAT identity, never label it as a new no-submit.
      if (typeof res?.handoffId === 'string'
        && res.operationKey === `history:${ownerTabId}:${res.handoffId}`
        && (res.handoffId === baseHandoffId || res.handoffId.startsWith(baseHandoffId + '-arm-'))
        && res.handoffId !== handoffId) {
        usePromptQueueStore.getState().setPendingDelivery(ownerTabId, null, handoffId);
        retractHistoryPromptHandoff(ownerTabId, handoffId, 'joined-original-unknown-operation');
        pendingDelivery = { ...pendingDelivery, handoffId: res.handoffId, operationKey: res.operationKey };
      }
      pauseUnresolvedQueueDelivery(ownerTabId, pendingDelivery);
      console.warn('[PromptQueueRunner] retain unknown automatic send owner=' + ownerTabId.slice(-8)
        + ' handoff=' + handoffId + ' code=' + (res?.code || 'missing-send-proof'));
      return;
    }
    usePromptQueueStore.getState().setPendingDelivery(ownerTabId, null, handoffId);
    if (res?.alreadyConsumedHandoffId) {
      queueAwaitingBusyStart.delete(ownerTabId);
      retractHistoryPromptHandoff(ownerTabId, handoffId, 'original-item-already-consumed');
    }
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
    // Delivery now belongs to the exact Main Send. Retire this preparation
    // before commitSentHead publishes removal: Root's synchronous Store pruner
    // must not mistake our own successful consumption for a user cancellation.
    // queueSendInflight still blocks another attempt until the final cleanup.
    clearDeferredOwnerAttempt(ownerTabId, attempt, 'committed');
    const committed = kind === 'queue'
      ? commitTransferredQueueSource(ownerTabId, attempt)
      : { removed: false, beforeCount: 1, targetCleared: false };
    if (kind === 'loop' && latestLoopCauseByOwner.get(ownerTabId) === attempt.causeKey) {
      latestLoopCauseByOwner.delete(ownerTabId);
    }
    console.log('[PromptQueueRunner] ' + label + ' commit owner=' + ownerTabId.slice(-8)
      + ' trigger=' + triggerTabId.slice(-8) + ' removed=' + committed.removed
      + ' targetCleared=' + committed.targetCleared + ' before=' + committed.beforeCount);
  })().catch((error: unknown) => {
    queueAwaitingBusyStart.delete(ownerTabId);
    if (sendDispatched && pendingDelivery) {
      pauseUnresolvedQueueDelivery(ownerTabId, pendingDelivery);
      console.error('[PromptQueueRunner] retain interrupted automatic send owner=' + ownerTabId, error);
      return;
    }
    if (pendingDelivery) usePromptQueueStore.getState().setPendingDelivery(ownerTabId, null, pendingDelivery.handoffId);
    if (attempt.cancelledByManualStop) {
      if (attemptedHandoffId) {
        void settleTabWorkContext(ownerTabId, attemptedHandoffId, { submitted: false });
        retractHistoryPromptHandoff(ownerTabId, attemptedHandoffId, 'manual-stop-before-submit');
      }
      return;
    }
    if (attemptedHandoffId) {
      void settleTabWorkContext(ownerTabId, attemptedHandoffId, { submitted: false });
      settleHistoryPromptHandoff(ownerTabId, attemptedHandoffId, {
        queueStatus: 'failed',
        reason: 'send-error-before-submit',
        requiresAuditIdentity: false,
      });
    }
    if (kind === 'loop' && latestLoopCauseByOwner.get(ownerTabId) === attempt.causeKey) {
      latestLoopCauseByOwner.delete(ownerTabId);
    }
    const current = deferredOwnerAttemptIsCurrent(ownerTabId, attempt)
      && (error as any)?.reason !== 'run-after-preparation-changed'
      && !(controller?.signal.aborted && !queuePreparationSourceIsCurrent(ownerTabId, attempt));
    clearDeferredOwnerAttempt(ownerTabId, attempt, 'send-error');
    if (current) {
      const store = usePromptQueueStore.getState();
      if (kind === 'loop') store.setLoopPromptEnabled(ownerTabId, false);
      else {
        store.setAutoRun(ownerTabId, false);
      }
    }
    const failure = error as any;
    console.error('[PromptQueueRunner] ' + label + ' validated send failed owner=' + ownerTabId
      + ' trigger=' + triggerTabId + ' item=' + attempt.headId + ' handoff=' + (attemptedHandoffId || '-')
      + ' detail=' + JSON.stringify({ name: failure?.name, message: failure?.message,
        code: failure?.code, reason: failure?.reason, lookupUnknown: failure?.lookupUnknown,
        launchWritten: failure?.launchWritten, cancelled: failure?.cancelled, sendDispatched,
        stage: failure?.stage, launchAttempt: failure?.launchAttempt,
        intentId: failure?.intentId || failure?.launchIntent?.intentId,
        launchFence: failure?.launchFence || failure?.launchIntent?.launchFence,
        observedLaunchFence: failure?.observedLaunchFence,
        launchOutcomeUnknown: failure?.launchOutcomeUnknown }));
  }).finally(() => {
    unsubscribePreparation(); unsubscribePreparationWorkspace(); unsubscribePreparationEditor();
    if (attempt.preparationController === controller) attempt.preparationController = undefined;
    void launchAdmission?.finish();
    queueSendInflight.delete(ownerTabId);
    if (usePromptQueueStore.getState().getQueue(ownerTabId).pendingDelivery) {
      void reconcilePromptQueuePendingDelivery(ownerTabId);
    }
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
  goalWork?: any;
  tabId: string;
  busy: boolean;
  reason?: string;
  localCommand?: string;
  localCommandReason?: string;
  completionKind?: string;
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
  manualQueueContinuationExpected?: boolean;
  lastAbnormalOutcomeHasQueuedContinuation?: boolean;
  lastAbnormalOutcomeContinuationTs?: number | null;
  explicitTaskComplete?: boolean;
  explicitTaskBlocked?: boolean;
  taskCompletionReason?: string | null;
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
  liveOwnArmAt?: number | null;
}>();
const deferredContinuationPivotReleases = new Map<string, {
  outcomeTs: number;
  ownerTabIds: string[];
}>();
const continuationReleaseListeners = new Set<(tabId: string, source: string) => void>();
const promptQueueRuntimeListeners = new Set<(tabId: string, source: string) => void>();

function notifyPromptQueueRuntime(tabId: string, reason: string): void {
  // Read observers only: beginning preparation must not signal a continuation
  // release, wake a dependent queue or create another execution owner.
  for (const listener of promptQueueRuntimeListeners) {
    try { listener(tabId, reason); }
    catch (error) { console.warn('[PromptQueueRunner] runtime observer failed', error); }
  }
}
const processedNaturalOutcomes = new Map<string, { latestTs: number; keys: Set<string> }>();
const latestLoopCauseByOwner = new Map<string, string>();
const workflowRestoreReconciliationListeners = new Set<() => void>();
let workflowRestoreReconciled = false;
let workflowRestoreReconcilePromise: Promise<void> | null = null;

function signalContinuationRelease(tabId: string, source: string): void {
  notifyPromptQueueRuntime(tabId, source);
  autoCompactCoordinator?.wake(tabId);
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
  if (queueShutdownPending) return [];
  // Stopping the agent is not Pause in Run After and is not a successful turn.
  // Keep authored promises, including Loop, timers and foreign dependencies,
  // unchanged for their next real trigger. Applies to live AND restored Stop.
  if (normalizeAgentTurnEndReason(data.reason) === 'manual-stop') {
    console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
      + ' reason=manual-stop outcomeTs=' + outcomeTs + ' source=' + source
      + ' → PRESERVE queue configuration; no completion or notification');
    return [];
  }
  const queueState = usePromptQueueStore.getState();
  for (const ownerTabId of queueState.queues.keys()) {
    if (!tabExists(ownerTabId)) queueState.cleanupClosedTab(ownerTabId);
  }
  const preservePivoted = isRecoverableAgentTurnInterruption(data.reason);
  const preserveLoop = preservePivoted;
  const disarmedOwners = usePromptQueueStore.getState().disarmQueuesForTrigger(
    data.tabId,
    outcomeTs,
    {
      preservePivoted,
      preserveLoop,
      runtimeInstanceId: queueAppRuntimeInstanceId,
      runtimeStartedAt: queueAppRuntimeStartedAt,
    },
  );
  console.log('[PromptQueueRunner] tab=' + data.tabId.slice(-12)
    + ' reason=' + (data.reason || '-')
    + ' outcomeTs=' + outcomeTs
    + ' source=' + source
    + ' preservePivoted=' + (preservePivoted ? '1' : '0')
    + ' preserveLoop=' + (preserveLoop ? '1' : '0')
    + ' → DISARM trigger workflow owners=' + (disarmedOwners.length ? disarmedOwners.map(shortQueueTabId).join(',') : 'none/newer-arm'));
  // The provider already distinguishes a recoverable user interruption from
  // error/watchdog/no-result. Keep the same queue policy, but a requested Escape
  // is not an incident (including replay after renderer hydration).
  if (disarmedOwners.length > 0 && !preservePivoted) {
    const triggerName = getTabName(data.tabId) || 'вкладка-триггер';
    const outcome = data.reason === 'codex-no-final-result'
      ? 'завершилась без финального ответа'
      : /(interrupt|cancel|stop)/i.test(data.reason || '')
        ? 'была остановлена'
        : /(error|fail)/i.test(data.reason || '')
          ? 'завершилась с ошибкой'
          : 'завершилась нештатно';
    const triggerAgent = getPromptQueueAgent(data.tabId);
    const triggerSessionId = triggerAgent
      ? getPromptQueueSessionId(data.tabId, triggerAgent)
      : null;
    for (const ownerTabId of disarmedOwners) {
      const incidentReport = buildRunAfterIncidentReport({
        tabId: data.tabId,
        sessionId: triggerSessionId,
        triggerName,
        reason: data.reason || 'unknown',
        outcome,
        source,
        occurredAt: outcomeTs,
        ownerTabId,
        ownerName: getTabName(ownerTabId) || ownerTabId,
        remainingItems: usePromptQueueStore.getState().getQueue(ownerTabId).items.length,
      });
      useUIStore.getState().showToast(
        `Run after остановлен: «${triggerName}» ${outcome}`,
        'warning',
        0,
        true,
        incidentReport,
        undefined,
        undefined,
        ownerTabId,
        undefined,
        incidentReport,
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
  const head = enabledQueueHead(queue);
  if (head?.trigger?.kind === 'app-restart') {
    if (!queueItemTriggerCanFire(head)
      || !Number.isFinite(outcomeTs)
      || !Number.isFinite(queueAppRuntimeStartedAt)
      || Number(outcomeTs) < Number(queueAppRuntimeStartedAt)) return false;
  }
  return !queue.workflowRestartPending && isWorkflowOutcomeAtOrAfterArm(promptQueueOutcomeFloor(queue), outcomeTs);
}

function pivotTriggerHasFreshCompletion(queue: TabQueue, triggerTabId: string): boolean {
  const trigger = enabledQueueHead(queue)?.trigger;
  if (trigger?.kind === 'onTab' && trigger.dependencies) return promptTabTriggerReady(trigger);
  const latestOutcome = processedNaturalOutcomes.get(triggerTabId)?.latestTs;
  return Number.isFinite(latestOutcome)
    && workflowAcceptsNaturalOutcome(queue, Number(latestOutcome))
    && !queueOwnerHasPendingContinuation(triggerTabId);
}

function naturalOutcomeKey(data: BusyStatePayload, outcomeTs: number): string {
  return data.tabId + ':' + outcomeTs + ':' + (
    data.turnId
    || data.lastOutcomeTurnId
    || normalizeAgentTurnEndReason(data.reason)
    || 'natural'
  );
}

function markWorkflowRestoreReconciled(): void {
  if (workflowRestoreReconciled) return;
  workflowRestoreReconciled = true;
  for (const listener of workflowRestoreReconciliationListeners) listener();
  // The FIFO may already be parked on this barrier without another busy edge.
  void ipcRenderer.invoke('agent:send-queue-ready', true).catch(() => {});
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

export function getPromptQueueRuntimeSnapshot(tabId: string) {
  const q = usePromptQueueStore.getState().getQueue(tabId);
  const head = enabledQueueHead(q), triggerTabId = getEffectiveQueueTrigger(tabId, q);
  const pending = !!q.pendingDelivery || queueSendInflight.has(tabId) || queueAwaitingBusyStart.has(tabId)
    || pendingAgentSendScenarioCount(tabId) > 0 || queueConditionChecks.has(tabId);
  const phase = queueShutdownPending ? 'shutdown'
    : q.pendingDelivery && !queueSendInflight.has(tabId) ? 'delivery-unknown'
    : queueSendInflight.has(tabId) ? 'executing'
      : queueAwaitingBusyStart.has(tabId) ? 'awaiting-agent'
        : deferredOwnerSends.has(tabId) ? 'waiting-readiness'
          : queueConditionChecks.has(tabId) ? 'checking-condition'
            : isPromptQueueEditorLocked(tabId) ? 'editing'
              : q.firstDelayCountdownAt !== null ? 'countdown'
                : q.autoRun && head?.trigger?.kind === 'app-restart' && !queueItemTriggerCanFire(head) ? 'waiting-app-restart'
                  : q.autoRun && triggerTabId !== tabId
                    && !(head?.trigger?.kind === 'onTab' && head.trigger.dependencies && promptTabTriggerReady(head.trigger)) ? 'waiting-dependency'
                    : q.autoRun ? 'armed' : 'paused';
  const last = getHistoryPromptHandoffsSnapshot(tabId).filter(handoff => String(handoff.source || '').startsWith('prompt-queue'))
    .reduce((latest, value) => !latest || value.submittedAt > latest.submittedAt ? value : latest, null as ReturnType<typeof getHistoryPromptHandoffsSnapshot>[number] | null);
  return { pending, phase,
    preparingItemId: queueSendInflight.has(tabId) ? deferredOwnerSends.get(tabId)?.headId || null : queueConditionChecks.get(tabId)?.headId || null,
    ownBusy: prevBusyRef.has(tabId) ? prevBusyRef.get(tabId) : null,
    inheritedBusy: useOrchestrationStore.getState().inheritedBusyTabIds.has(tabId), triggerTabId,
    triggerBusy: prevBusyRef.has(triggerTabId) ? prevBusyRef.get(triggerTabId) : null,
    appInstanceKnown: !!queueAppRuntimeInstanceId,
    autoCompact: useAutoCompactStore.getState().activities[tabId] || null,
    lastAttempt: last ? { handoffId: last.handoffId, operationKey: last.sendOperationKey, attemptId: last.sendAttemptId,
      status: last.queueStatus, reason: last.statusReason, changedAt: last.statusChangedAt }
      : q.pendingDelivery ? { handoffId: q.pendingDelivery.handoffId, operationKey: q.pendingDelivery.operationKey,
        attemptId: null, status: 'delivery-unknown', reason: 'same-operation-reconciliation-required',
        changedAt: q.pendingDelivery.createdAt } : null };
}

// Read-only revalidation for Main's existing FIFO. It cannot create a trigger,
// resume a provider or consume a card; the root runner has already admitted it.
export function readPromptQueueSendAdmission(request: any) {
  if (!canProcessWorkflowOutcomes()) return { ready: false, reason: 'root-restore-not-ready' };
  const { tabId, intent } = request;
  const queue = usePromptQueueStore.getState().getQueue(tabId);
  const head = enabledQueueHead(queue);
  const cancelled = () => ({ cancel: true, reason: 'automatic-intent-changed' });
  if (intent?.version !== 1 || intent.kind !== 'queue' || !tabExists(tabId)
    || !queue.autoRun || !head || head.metaAction || head.id !== intent.itemId
    || queue.workflowArmedAt !== intent.armedAt
    || !promptQueueContextConditionKeysEqual(queuedPromptContextConditionKey(head.condition), intent.conditionKey)
    || JSON.stringify(head.trigger || null) !== intent.triggerKey
    || getEffectiveQueueTrigger(tabId, queue) !== intent.triggerTabId
    || getPromptQueueAgent(tabId) !== request.provider
    || (request.cwd && getTabCwd(tabId) !== request.cwd)) return cancelled();
  const sessionId = getPromptQueueSessionId(tabId, request.provider);
  if (hasPromptQueueContextConditionKey(intent.conditionKey) && (!intent.contextProof || intent.contextProof.provider !== request.provider
    || intent.contextProof.sessionId !== sessionId
    || !queuedPromptContextConditionMatches(head.condition, intent.contextProof.pct))) return cancelled();
  if (request.expectedTarget?.sessionId && request.expectedTarget.sessionId !== sessionId) return cancelled();
  const payload = withPostPrompt(tabId, buildQueuedPromptPayload(head));
  if (buildPromptQueueReceiptHandoffId({ kind: 'queue', itemId: head.id, payload, causeKey: null,
    ...(intent.baseHandoffId ? { armedAt: intent.armedAt } : {}) }) !== request.handoffId) return cancelled();
  if (isPromptQueueEditorLocked(tabId)) return { ready: false, reason: 'editor-locked' };
  if (!queueItemTriggerCanFire(head)) return { ready: false, reason: 'trigger-not-ready' };
  if (dictationBlocksSend(head.text)) return { ready: false, reason: 'dictation-pending' };
  if (isTabWorkflowBlocked(tabId)) return { ready: false, reason: 'owner-work-pending' };
  if (isTabWorkflowBlocked(intent.triggerTabId, head)) return { ready: false, reason: 'trigger-work-pending' };
  return { ready: true };
}

export function subscribePromptQueueRuntime(listener: (tabId: string, reason: string) => void) {
  promptQueueRuntimeListeners.add(listener);
  return () => { promptQueueRuntimeListeners.delete(listener); };
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
    void hydrateAutoCompactStore();
    const coordinator = createAutoCompactCoordinator({
      startedAt: queueRendererStartedAt,
      policy: () => useAutoCompactStore.getState().policy,
      target: getAutoCompactTarget,
      blocked: (tabId: string) => !canProcessWorkflowOutcomes()
        || !useAutoCompactStore.getState().hydrated || prevBusyRef.get(tabId) === true
        || queueSendInflight.has(tabId)
        || queueConditionChecks.has(tabId) || queueAwaitingBusyStart.has(tabId)
        || isPromptQueueEditorLocked(tabId) || isOrchestrationCompletionBlocked(tabId)
        || pendingAgentSendScenarioCount(tabId) > 0,
      readiness: readQueueOwnerReadiness,
      context: (target: AutoCompactTarget) => ipcRenderer.invoke('tab:get-context-pct', {
        tabId: target.tabId, provider: target.provider, sessionId: target.sessionId, requireExact: true,
      }),
      resume: async (target: AutoCompactTarget) => {
        const result = await getHistoryAgentRuntime(target.provider).resume(target);
        if (result?.success === false) throw new Error(result.error || 'Не удалось запустить выбранную сессию');
        return result;
      },
      compact: executeAutoCompact,
      trace: (event: string, detail: unknown) => console.log('[AutoCompact] ' + event + ' ' + JSON.stringify(detail)),
      activity: (tabId: string, activity: any) => useAutoCompactStore.getState().setActivity(tabId, activity),
      failure: (tabId: string, error: string) => {
        const store = usePromptQueueStore.getState();
        const queue = store.getQueue(tabId);
        if (queue.autoRun) store.setAutoRun(tabId, false);
        if (queue.loopPromptEnabled) store.setLoopPromptEnabled(tabId, false);
        console.warn('[AutoCompact] tab=' + tabId + ' error=' + error);
        useUIStore.getState().showToast('Автокомпакт · ' + (getTabName(tabId) || tabId) + ': ' + error,
          'warning', 0, true);
      },
      release: (tabId: string) => {
        signalContinuationRelease(tabId, 'auto-compact-settled');
        signalQueueOwnerReadiness(tabId, 'auto-compact-settled');
      },
    });
    autoCompactCoordinator = coordinator;
    const unsubscribeAutoCompactPolicy = useAutoCompactStore.subscribe((state, previous) => {
      if (state.policy !== previous.policy || state.hydrated !== previous.hydrated) coordinator.policyChanged();
    });
    const unsubscribeAutoCompactWorkspace = useWorkspaceStore.subscribe(() => coordinator.targetsChanged());
    const unsubscribeAutoCompactEditor = subscribePromptQueueEditorLocks((tabId, lock) => {
      if (!lock) coordinator.wake(tabId);
    });
    const unsubscribeAutoCompactSends = subscribeAgentSendScenarios(({ tabId, pending }: { tabId: string; pending: number }) => {
      if (pending === 0) coordinator.wake(tabId);
    });
    const autoCompactWake = (_event: unknown, data: { tabId?: string }) => {
      if (data?.tabId) coordinator.wake(data.tabId);
    };
    const autoCompactWakeChannels = ['claude:bridge-update', 'codex:context-update', 'agent:readiness-changed'];
    for (const channel of autoCompactWakeChannels) ipcRenderer.on(channel, autoCompactWake);
    const shutdownHandler = (_event: unknown, data: { show?: boolean }) => {
      if (!data?.show || queueShutdownPending) return;
      queueShutdownPending = true;
      coordinator.dispose();
      flushAutoCompactStoreSync();
      usePromptQueueStore.getState().suspendWorkflowsForRestart();
      // beforeunload also flushes; this earlier boundary precedes main's
      // graceful Ctrl+C fan-out, so its finalizers cannot disarm saved work.
      flushPromptQueueStoreSync();
    };
    ipcRenderer.on('shutdown:overlay', shutdownHandler);
    window.addEventListener('beforeunload', flushAutoCompactStoreSync);
    // Shared firing logic — pops head, sends to OWNER tab, auto-disarms on last.
    // ownerTabId = which queue's head to pop (always the queue-owner, never the
    // trigger tab). triggerTabId is only used for diagnostics in logs.
    const fireQueueOwner = (ownerTabId: string, triggerTabId: string): boolean => {
      let queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (queue.pendingDelivery) { void reconcilePromptQueuePendingDelivery(ownerTabId); return false; }
      const beforePop = countEnabledQueuedPrompts(queue.items);
      if (!queue.autoRun || beforePop === 0) return false;
      const waitingHead = enabledQueueHead(queue);
      const outcomeTs = processedNaturalOutcomes.get(triggerTabId)?.latestTs;
      if (waitingHead?.trigger?.kind === 'onTab' && waitingHead.trigger.dependencies
        && Number.isFinite(outcomeTs) && !queueOwnerHasPendingContinuation(triggerTabId)) {
        const retired = usePromptQueueStore.getState().completePromptTabDependency(ownerTabId, waitingHead.id, triggerTabId, Number(outcomeTs));
        queue = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (retired) console.log('[PromptQueueRunner] dependency completed owner=' + shortQueueTabId(ownerTabId)
          + ' item=' + waitingHead.id + ' target=' + shortQueueTabId(triggerTabId)
          + ' outcomeTs=' + outcomeTs + ' remaining=' + pendingPromptTabIds(enabledQueueHead(queue)?.trigger).length);
      }
      if (queue.firstDelayCountdownAt !== null) return false;
      if (queueSendInflight.has(ownerTabId)) return false;
      if (isTabWorkflowBlocked(ownerTabId) || isTabWorkflowBlocked(triggerTabId, enabledQueueHead(queue))) {
        console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8) + ' workflow is busy → wait before firing trigger=' + triggerTabId.slice(-8));
        return false;
      }

      const head = enabledQueueHead(queue);
      if (!head) return false;
      if (!queueItemTriggerCanFire(head)) return false;
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
        const trigger = enabledQueueHead(queue)?.trigger;
        if (trigger?.kind === 'onTab' && trigger.dependencies
          ? !promptTabTriggerMatches(trigger, triggerTabId)
          : getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true }) !== triggerTabId) continue;
        fireQueueOwner(ownerTabId, triggerTabId);
      }
      console.log('[PromptQueueRunner] tab=' + triggerTabId.slice(-12)
        + ' pending continuation cleared → release pivoted owners source=' + source);
    };

    const continuationReleaseListener = (tabId: string, source: string) => {
      const queue = usePromptQueueStore.getState().getQueue(tabId);
      const outcomeTs = processedNaturalOutcomes.get(tabId)?.latestTs;
      if (source === 'conditions-skipped' && latestLoopCauseByOwner.has(tabId)
        && (queue.loopPromptArmedAt === null || (outcomeTs !== undefined && queue.loopPromptArmedAt <= outcomeTs))) {
        fireLoopOwner(tabId);
      }
      releaseDeferredPivotOwners(tabId, source);
      if (source === 'conditions-skipped') useWorkspaceStore.getState().retryTabCompletionNotification(tabId);
    };
    continuationReleaseListeners.add(continuationReleaseListener);
    const unsubscribeContinuationQueue = usePromptQueueStore.subscribe(() => {
      for (const [ownerTabId, queue] of usePromptQueueStore.getState().queues) {
        if (queue.pendingDelivery) void reconcilePromptQueuePendingDelivery(ownerTabId);
      }
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
      if (isTabWorkflowBlocked(effectiveTrigger, enabledQueueHead(queue))) return null;
      if (!pivotTriggerHasFreshCompletion(queue, effectiveTrigger)) return null;
      return effectiveTrigger;
    };

    const unsubscribeEditorLocks = subscribePromptQueueEditorLocks((ownerTabId, lock, options) => {
      if (lock) return;
      void ipcRenderer.invoke('agent:send-queue-ready', true).catch(() => {});
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
      if (usePromptQueueStore.getState().getQueue(auditTabId).pendingDelivery?.handoffId === handoffId) {
        void reconcilePromptQueuePendingDelivery(auditTabId);
      }
      const current = getHistoryPromptHandoffsSnapshot(auditTabId)
        .find((handoff) => handoff.handoffId === handoffId);
      if (current && !historyPromptHandoffAcceptsAuditIdentity(current, detail)) {
        console.warn('[PromptQueueRunner] ignore stale prompt audit tab=' + auditTabId.slice(-12)
          + ' handoff=' + handoffId.slice(0, 24)
          + ' expectedAttempt=' + String(current.sendAttemptId || '-').slice(0, 12)
          + ' actualAttempt=' + String(detail?.sendAttemptId || '-').slice(0, 12));
        return;
      }
      if (detail?.providerQueueAccepted === true && detail?.status === 'queued') {
        const sourceIdentity = typeof detail?.providerQueueProof?.sourceIdentity === 'string'
          ? detail.providerQueueProof.sourceIdentity
          : typeof detail?.sourceIdentity === 'string'
            ? detail.sourceIdentity
            : '';
        if (!sourceIdentity) return;
        acceptHistoryPromptHandoffProviderQueue(auditTabId, handoffId, {
          sendAttemptId: detail.sendAttemptId || null,
          sendOperationKey: detail.sendOperationKey || null,
          changedAt: Date.now(),
          proof: {
            sourceIdentity,
            sessionId: typeof detail?.providerQueueProof?.sessionId === 'string'
              ? detail.providerQueueProof.sessionId
              : typeof detail?.sessionId === 'string'
                ? detail.sessionId
                : null,
          },
        });
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
            recordByteOffset: detail.recordByteOffset,
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
          sendAttemptId: detail.sendAttemptId,
          sendOperationKey: detail.sendOperationKey,
          toolType: detail.toolType,
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
        const trigger = enabledQueueHead(q)?.trigger;
        if (trigger?.kind === 'onTab' && trigger.dependencies
          ? promptTabTriggerMatches(trigger, triggerTabId)
          : effectiveTrigger === triggerTabId) owners.push(ownerTabId);
      }
      return owners;
    };

    const processSuccessfulWorkflowOutcome = (
      data: BusyStatePayload,
      source: string,
      explicitTs: number | null = explicitOutcomeTimestamp(data),
      compactChecked = false,
      liveOwnArmAt: number | null = null,
    ): void => {
      if (hasPendingAgentGoalWork(data)) {
        // App Loop completion is a separate exact intent. Consume its stop
        // request now even while native Goal keeps working; never lose it and
        // accidentally restart Loop at a later Goal turn without that intent.
        if ((data.explicitTaskComplete || data.explicitTaskBlocked)
          && usePromptQueueStore.getState().getQueue(data.tabId).loopPromptEnabled) {
          usePromptQueueStore.getState().setLoopPromptEnabled(data.tabId, false);
          if (data.explicitTaskBlocked) useUIStore.getState().showToast('Loop · ' + getTabName(data.tabId)
            + ' остановлен: ' + (data.taskCompletionReason || 'требуется внешнее действие'), 'info', 8000);
        }
        console.log('[PromptQueueRunner] native Goal holds workflow completion tab=' + data.tabId.slice(-12)
          + ' status=' + data.goalWork.status + ' turn=' + data.goalWork.turnId);
        return;
      }
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
          deferredOrchestrationNaturalOutcomes.set(data.tabId, { data, source, outcomeTs, liveOwnArmAt });
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
      if (!compactChecked && coordinator.intercept(data.tabId, {
        at: outcomeTs,
        live: source.includes('-live'),
        natural: isNaturalAgentTurnEndReason(data.reason),
        compact: data.completionKind === 'compact' || data.localCommand === '/compact',
        turnStartedAt: autoCompactTurnStarts.get(data.tabId) || 0,
      }, () => processSuccessfulWorkflowOutcome(data, source, outcomeTs, true, liveOwnArmAt))) return;
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
      const explicitTaskBlocked = data.explicitTaskBlocked === true;
      if (explicitTaskComplete || explicitTaskBlocked) {
        const currentQueue = usePromptQueueStore.getState().getQueue(tabId);
        if (currentQueue.loopPromptEnabled) {
          usePromptQueueStore.getState().setLoopPromptEnabled(tabId, false);
        }
        console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
          + ' exact turn marked ' + (explicitTaskBlocked ? 'blocked' : 'complete')
          + ' intent=' + (data.taskCompletionIntentId || '-')
          + ' → Loop disabled');
        if (explicitTaskBlocked) {
          useUIStore.getState().showToast('Loop · ' + getTabName(tabId) + ' остановлен: '
            + (data.taskCompletionReason || 'требуется внешнее действие'), 'info', 8000);
        }
      }
      const ownersAtOutcome = findOwnersWaitingOn(tabId, outcomeTs);
      // A skipped card belongs to the previous pass. A fresh completion of
      // its external trigger must check the preserved condition again too.
      for (const ownerTabId of ownersAtOutcome) {
        setPromptQueueContextSkipped(usePromptQueueStore.getState().getQueue(ownerTabId), false);
      }
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
      if (isLoopPromptActive(ownQueueBefore)
        && (ownQueueBefore.loopPromptArmedAt === null || ownQueueBefore.loopPromptArmedAt <= outcomeTs)) {
        latestLoopCauseByOwner.set(tabId, key);
      }
      const queueTrigger = ownQueueBefore.autoRun && countEnabledQueuedPrompts(ownQueueBefore.items) > 0
        ? getEffectiveQueueTrigger(tabId, ownQueueBefore, { clearStaleTarget: true })
        : null;
      const continuationKind = choosePromptQueueContinuationForOutcome({
        queueActive: ownQueueBefore.autoRun && countEnabledQueuedPrompts(ownQueueBefore.items) > 0,
        queueTriggerIsOwner: queueTrigger === tabId,
        queueArmedAt: promptQueueOutcomeFloor(ownQueueBefore),
        // An explicit own-tab Play already permits starting on a proven idle
        // owner. If Main published the busy→idle edge late, its provider time
        // can precede that Play. Keep that permission separate from historical
        // or pivot completion timestamps; do not rewrite either timestamp.
        queueOwnLiveIdle: Number.isFinite(liveOwnArmAt) && hasRuntimeWorkflowArm(tabId)
          && promptQueueOutcomeFloor(ownQueueBefore) === liveOwnArmAt,
        loopActive: isLoopPromptActive(ownQueueBefore),
        loopArmedAt: ownQueueBefore.loopPromptArmedAt,
        explicitTaskComplete,
      }, outcomeTs);
      if (continuationKind === 'queue' && Number.isFinite(liveOwnArmAt)
        && Number(promptQueueOutcomeFloor(ownQueueBefore)) > outcomeTs) {
        console.log('[PromptQueueRunner] explicit own arm reached live idle tab=' + tabId.slice(-12)
          + ' arm=' + promptQueueOutcomeFloor(ownQueueBefore) + ' outcomeTs=' + outcomeTs);
      }

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
        if (queueShutdownPending) return;
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
          setPromptQueueContextSkipped(usePromptQueueStore.getState().getQueue(tabId), false);
          for (const [ownerTabId, check] of queueConditionChecks) {
            if (ownerTabId === tabId || check.triggerTabId === tabId) queueConditionChecks.delete(ownerTabId);
          }
          if (!wasBusy && reason !== 'local-command') autoCompactTurnStarts.set(tabId, Date.now());
          if (reason !== 'local-command' || data.localCommand === '/compact') {
            observedWorkflowStarts.add(tabId);
            usePromptQueueStore.getState().resumeWorkflowsForTrigger(tabId, queueRendererStartedAt);
          }
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
          ? {
              ...data,
              reason: normalizeAgentTurnEndReason(data.reason) || data.reason,
              outcomeTs: liveOutcomeTimestamp(data),
            }
          : data;

        if (!busy && queueLifecycleStopInflight.has(tabId)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' ch=' + channel
            + ' reason=' + (reason || '-')
            + ' → IGNORE lifecycle edge owned by queued Stop/Close');
          return;
        }

        if (!busy && classifiedData.reason === 'manual-stop') cancelPreparationsForManualStop(tabId);

        // Ctrl+C/exit can publish intermediate abort/error/final records before
        // Main finishes an already accepted Stop. They are not new queue policy
        // decisions and cannot release a continuation through the stop boundary.
        if (!busy && queueManualStopping.has(tabId)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' reason=' + (reason || '-') + ' → IGNORE outcome during accepted manual Stop');
          return;
        }

        // Restore is a barrier for every workflow outcome, including success:
        // an idle edge arriving before either store is hydrated must not send a
        // prompt or Stop a process against a partial workspace.
        if (!busy && !canProcessWorkflowOutcomes()) {
          rememberDeferredWorkflowOutcome(classifiedData);
          return;
        }

        // Only authoritative success advances a workflow. An explicit process
        // Stop preserves its configuration; actual failures still disarm it.
        if (!busy && !isNaturalAgentTurnEndReason(reason) && !compactLocalCommandDone) {
          coordinator.cancel(tabId, false);
          if (interruptionContinuesWithQueuedTurn(classifiedData)) {
            console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
              + ' reason=' + (classifiedData.reason || '-')
              + ' source=' + channel + '-live'
              + ' → PRESERVE Run after for native queued continuation');
          } else {
            applyAbnormalQueueOutcome(classifiedData, channel + '-live');
          }
          return;
        }

        // A normal live completion still requires the real busy→idle edge.
        // Replayed restore outcomes bypass this edge check in reconciliation,
        // where their persisted timestamps are the correlation proof.
        if (!(wasBusy && !busy)) { if (!busy) coordinator.wake(tabId); return; }
        if (compactLocalCommandDone) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' command=/compact localReason=' + data.localCommandReason + ' → CONTINUE queue after compact');
        }
        const liveOwnArmAt = hasRuntimeWorkflowArm(tabId)
          ? promptQueueOutcomeFloor(usePromptQueueStore.getState().getQueue(tabId)) : null;
        processSuccessfulWorkflowOutcome(classifiedData, channel + '-live', explicitOutcomeTimestamp(classifiedData), false, liveOwnArmAt);
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
        const abnormal = {
          tabId,
          busy: false,
          reason: state.lastAbnormalOutcomeReason,
          outcomeTs: Number.isFinite(state.lastAbnormalOutcomeTs)
            ? Number(state.lastAbnormalOutcomeTs)
            : null,
          turnId: state.lastAbnormalOutcomeTurnId || null,
          lastAbnormalOutcomeHasQueuedContinuation:
            state.lastAbnormalOutcomeHasQueuedContinuation === true,
          lastAbnormalOutcomeContinuationTs:
            Number.isFinite(state.lastAbnormalOutcomeContinuationTs)
              ? Number(state.lastAbnormalOutcomeContinuationTs)
              : null,
        };
        if (interruptionContinuesWithQueuedTurn(abnormal)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12)
            + ' source=' + source + '-abnormal'
            + ' → PRESERVE restored native queued continuation');
        } else {
          applyAbnormalQueueOutcome(abnormal, source + '-abnormal',
            Number.isFinite(state.lastAbnormalOutcomeTs)
              ? Number(state.lastAbnormalOutcomeTs)
              : null);
        }
      }

      if (state.busy) return;

      if (!state.outcomeKnown || !state.lastOutcomeReason) return;
      const latest: BusyStatePayload = {
        goalWork: state.goalWork || null,
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
        try {
          const identity = await getAppRuntimeIdentity();
          queueAppRuntimeInstanceId = identity.instanceId;
          queueAppRuntimeStartedAt = identity.startedAt;
        } catch (error) {
          console.warn('[PromptQueueRunner] app runtime identity unavailable; restart triggers stay waiting', error);
        }
        // Restored queues must not consume an old done edge before the durable
        // child/handoff inventory has arrived. Purple inherited work survives
        // a renderer/app restart just like the queue itself.
        await initializeOrchestrationStore();
        if (!useOrchestrationStore.getState().initialized) return;
        for (const tabId of observedWorkflowStarts) {
          usePromptQueueStore.getState().resumeWorkflowsForTrigger(tabId, queueRendererStartedAt);
        }
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
            const trigger = enabledQueueHead(queue)?.trigger;
            const pending = trigger?.kind === 'onTab' && trigger.dependencies ? pendingPromptTabIds(trigger) : [];
            if (pending.length) pending.forEach(tabId => triggers.add(tabId));
            else triggers.add(getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true }));
          }
        }

        const codexSnapshots = await Promise.all(Array.from(triggers, async (triggerTabId) => {
          seedBusySnapshotFromWorkspace(triggerTabId);
          if (getWorkspaceCommandType(triggerTabId) !== 'codex') return null;
          try {
            const state = await ipcRenderer.invoke('codex:get-turn-state', triggerTabId);
            if (state?.hasWatcher && state.busy && !state.catchUpPending && !state.provisional) {
              usePromptQueueStore.getState().resumeWorkflowsForTrigger(triggerTabId, queueRendererStartedAt);
            }
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
          if (outcomes.abnormal && !interruptionContinuesWithQueuedTurn(outcomes.abnormal)) {
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
            const abnormalData = {
                tabId,
                busy: false,
                reason: state.lastAbnormalOutcomeReason,
                outcomeTs: timestamp,
                turnId: state.lastAbnormalOutcomeTurnId || null,
                lastAbnormalOutcomeHasQueuedContinuation:
                  state.lastAbnormalOutcomeHasQueuedContinuation === true,
                lastAbnormalOutcomeContinuationTs:
                  Number.isFinite(state.lastAbnormalOutcomeContinuationTs)
                    ? Number(state.lastAbnormalOutcomeContinuationTs)
                    : null,
              };
            if (!interruptionContinuesWithQueuedTurn(abnormalData)) {
              abnormalEvidence.push({
                data: abnormalData,
                source: 'hydration-codex-abnormal',
                timestamp,
              });
            }
          }
          if (state.busy || !state.outcomeKnown || !state.lastOutcomeReason) continue;
          const timestamp = Number.isFinite(state.lastOutcomeTs) ? Number(state.lastOutcomeTs) : null;
          const latest: BusyStatePayload = {
            goalWork: state.goalWork || null,
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
      for (const [ownerTabId, queue] of usePromptQueueStore.getState().queues) {
        if (queue.pendingDelivery) void reconcilePromptQueuePendingDelivery(ownerTabId);
      }
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
          false,
          deferred.liveOwnArmAt ?? null,
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
    ipcRenderer.on('agent:stopping-state', handleQueueAgentStopping);
    ipcRenderer.on('claude:tui-ready', claudeReadyHandler);
    ipcRenderer.on('codex:tui-ready', codexReadyHandler);
    window.addEventListener('claude-startup-defaults-gate', claudeStartupGateHandler);
    const unsubscribeQueueHydration = subscribePromptQueueHydration(maybeReconcileRestoredWorkflows);
    const unsubscribeWorkspaceHydration = useWorkspaceStore.subscribe(maybeReconcileRestoredWorkflows);
    const unsubscribeOrchestrationHydration = useOrchestrationStore.subscribe(maybeReconcileRestoredWorkflows);
    maybeReconcileRestoredWorkflows();
    return () => {
      coordinator.dispose();
      if (autoCompactCoordinator === coordinator) autoCompactCoordinator = null;
      unsubscribeAutoCompactPolicy();
      unsubscribeAutoCompactWorkspace();
      unsubscribeAutoCompactEditor();
      unsubscribeAutoCompactSends();
      for (const channel of autoCompactWakeChannels) ipcRenderer.removeListener(channel, autoCompactWake);
      ipcRenderer.removeListener('claude:busy-state', claudeHandler);
      ipcRenderer.removeListener('gemini:busy-state', geminiHandler);
      ipcRenderer.removeListener('codex:busy-state', codexHandler);
      ipcRenderer.removeListener('codex:turn-state-resolved', codexTurnStateResolvedHandler);
      ipcRenderer.removeListener('terminal:command-started', commandStartedHandler);
      ipcRenderer.removeListener('terminal:command-finished', commandFinishedHandler);
      ipcRenderer.removeListener('agent:stopping-state', handleQueueAgentStopping);
      ipcRenderer.removeListener('shutdown:overlay', shutdownHandler);
      window.removeEventListener('beforeunload', flushAutoCompactStoreSync);
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
          if (!queueItemTriggerCanFire(head)) return false;
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
        // The deadline has elapsed, not been cancelled. Keep it durable while
        // another turn/child or the draft editor owns this tab, then retry on
        // that owner's release instead of silently losing/restarting the timer.
        if (!canProcessWorkflowOutcomes() || isTabWorkflowBlocked(ownerTabId)
          || isPromptQueueEditorLocked(ownerTabId)) return;
        if (queueUsesItemTimer(latestQueue)) {
          const head = enabledQueueHead(latestQueue);
          if (head) usePromptQueueStore.getState().setPromptTrigger(ownerTabId, head.id, { kind: 'timer', seconds: 0 });
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
        if (hasPendingAgentGoalWork(res)) {
          console.log('[PromptQueueRunner] cold-start held by native Goal tab=' + triggerTabId.slice(-12));
          return;
        }
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
      options: { forceRuntimeArms?: boolean; forceAppRestartTriggers?: boolean } = {},
    ) => {
      if (!canProcessWorkflowOutcomes()) return;
      for (const [tabId, q] of state.queues) {
        if (!tabExists(tabId)) {
          usePromptQueueStore.getState().cleanupClosedTab(tabId);
          continue;
        }
        const prevQ = prevState.queues.get(tabId);
        const runtimeArm = hasRuntimeWorkflowArm(tabId);
        const restartTriggerReady = queueItemTriggerCanFire(enabledQueueHead(q))
          && enabledQueueHead(q)?.trigger?.kind === 'app-restart';
        if (!prevQ && !runtimeArm && !restartTriggerReady) continue;

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
          || (options.forceRuntimeArms === true && runtimeArm)
          || (options.forceAppRestartTriggers === true && restartTriggerReady);
        if (!armEdge) continue;
        if (options.forceAppRestartTriggers === true && restartTriggerReady) {
          console.log('[PromptQueueRunner] after-restart ready owner=' + tabId.slice(-12)
            + ' runtime=' + String(queueAppRuntimeInstanceId || '-').slice(-12));
        }

        // Validate the picked target — stale id behaves as null (fall back to
        // own-tab default).
        const effectiveTrigger = getEffectiveQueueTrigger(tabId, q, { clearStaleTarget: true });

        const headTrigger = enabledQueueHead(q)?.trigger;
        if (headTrigger?.kind === 'onTab' && headTrigger.dependencies && promptTabTriggerReady(headTrigger)) {
          signalQueueOwnerReadiness(tabId, 'completed-dependency-arm');
          continue;
        }

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

        // The new main lifetime already proves this item's trigger. It does
        // not depend on an assistant outcome from the previous process. Enter
        // the shared send path now so its exact readiness wait can join Resume
        // and wake when the owner becomes ready.
        if (restartTriggerReady) {
          if (!isTabWorkflowBlocked(tabId)) fireHead(tabId, tabId);
          continue;
        }

        // Ordinary own-tab arms still use the original Codex outcome check.
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
    const resumePersistedTimers = (onlyTabId?: string) => {
      if (!canProcessWorkflowOutcomes()) return;
      for (const [tabId, queue] of usePromptQueueStore.getState().queues) {
        if ((!onlyTabId || onlyTabId === tabId) && queue.autoRun
          && queue.firstDelayCountdownAt !== null && !pendingTimers.has(tabId)) {
          scheduleFirstDelayTimer(tabId);
        }
      }
    };
    queueDeadlineWakeListeners.add(resumePersistedTimers);
    const unsubscribeDeadlineEditor = subscribePromptQueueEditorLocks((tabId, lock) => {
      if (!lock) resumePersistedTimers(tabId);
    });
    const unsubscribeReconciliation = subscribeWorkflowRestoreReconciliation(() => {
      const current = usePromptQueueStore.getState();
      resumePersistedTimers();
      for (const [ownerTabId, queue] of current.queues) {
        if (enabledQueueHead(queue)?.trigger?.kind === 'onTab'
          && enabledQueueHead(queue)?.trigger?.dependencies) signalQueueOwnerReadiness(ownerTabId, 'restored-dependencies');
      }
      // Revisit only workflows explicitly armed in this renderer. Persisted
      // queues were already correlated against main-process outcomes above and
      // must never be synthesized as fresh 0→N / false→true edges.
      evaluateQueues(current, current, { forceRuntimeArms: true, forceAppRestartTriggers: true });
    });
    const unsubscribeOrchestration = subscribeOrchestrationRunChanges((change) => {
      if (change.releaseKind) resumePersistedTimers(change.sourceTabId);
      if (change.releaseKind !== 'success' || isTabWorkflowBlocked(change.sourceTabId)) return;
      const current = usePromptQueueStore.getState();
      evaluateQueues(current, current, { forceRuntimeArms: true, forceAppRestartTriggers: true });
    });
    const unsubscribeInput = subscribeWorkflowInputRelease(tabId => {
      resumePersistedTimers(tabId);
      signalQueueOwnerReadiness(tabId, 'input-owner-released');
      const current = usePromptQueueStore.getState();
      evaluateQueues(current, current, { forceRuntimeArms: true, forceAppRestartTriggers: true });
    });
    if (workflowRestoreReconciled) {
      const current = usePromptQueueStore.getState();
      resumePersistedTimers();
      evaluateQueues(current, current, { forceRuntimeArms: true, forceAppRestartTriggers: true });
    }
    return () => {
      unsubscribeQueue();
      unsubscribeReconciliation();
      unsubscribeOrchestration();
      unsubscribeDeadlineEditor();
      unsubscribeInput();
      queueDeadlineWakeListeners.delete(resumePersistedTimers);
      queueDelayStartListeners.delete(delayStartListener);
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
    };
  }, []);
}
