import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { buildCodexRunPayload, getCodexLaunchOptions } from './codexLaunch';
import {
  isCompleteCodexSettingsRequest,
  planCodexHistorySettings,
  resolveCodexSettingsRuntimeProof,
} from './codexHistorySettingsPlan.mjs';
import { readCodexPtyPresence } from './codexPtyPresence.mjs';
import { readCodexDraftAuthority } from './codexDraftAuthority.mjs';
import {
  isStandaloneCodexLocalSlashCommand,
  normalizeCodexLocalSlashCommand,
} from './codexLocalSlashCommand.mjs';
import {
  planCodexLaunchSettingsPersistence,
} from './codexEffectiveSettings.mjs';
import { terminalRegistry } from './terminalRegistry';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import { createAgentLaunchAdmission, withAgentLaunchAdmission } from './agentLaunchAdmission.mjs';
import {
  answerClaudeQuestion,
  copyClaudePtyDraft,
  grabClaudePtyDraft,
  getClaudePendingQuestion,
  getClaudePtyPresence,
  interruptClaudePtyTurn,
  resumeClaudePtySession,
  sendClaudePtyPrompt,
  stopClaudePtyProcess,
  type ClaudePtyDraftGrabResult,
  type ClaudePtyDraftGrabOptions,
  type ClaudePendingQuestion,
  type ClaudeQuestion,
} from './claudePtyActions';

const { ipcRenderer } = window.require('electron');

export type AgentHistoryTool = 'claude' | 'codex';
export type AgentPtyStatus = 'active' | 'busy' | 'inactive' | 'starting' | 'stopping' | 'unknown';
export type AgentDraftGrabResult = ClaudePtyDraftGrabResult;
export type AgentDraftGrabOptions = ClaudePtyDraftGrabOptions;
export type AgentPendingQuestion = ClaudePendingQuestion;
export type AgentQuestion = ClaudeQuestion;

export interface AgentDraftInspection {
  hasDraft: boolean | null;
  preview: string;
  source: string;
  proofOutcome?: 'found' | 'absent' | 'unknown' | string;
  proofReason?: string | null;
  debug?: string;
  mountedForInspect?: boolean;
  [key: string]: any;
}

export interface AgentPtyPresence {
  status: AgentPtyStatus;
  hasBridge?: boolean;
  isBusy?: boolean;
  hasTerm?: boolean;
  inputReady?: boolean;
  awaiting?: boolean;
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
  sessionId?: string | null;
  sessionAuthority?: 'live-writer' | 'history-hint' | 'fresh';
  sendTarget?: AgentSendTarget & { acceptedResumeSourceSessionId?: string | null };
  conversationMaterialized?: boolean;
  canResume?: boolean;
  canCopySessionId?: boolean;
  timelineCount?: number | null;
  materializationReason?: string | null;
  // Codex presence is already derived from this one main-owned snapshot.
  // Bridge/API callers must reuse it instead of issuing a second identity read
  // and combining two different process generations.
  runtimeSnapshot?: any;
}

export interface AgentPresenceRequestContext {
  consumer: 'history-panel';
  ownerKey: string;
  generation: number;
}

export interface AgentResumeResult {
  success: boolean;
  launchId?: string | null;
  launchGeneration?: string | null;
  lifecycleGeneration?: string | null;
  accepted?: boolean | null;
  acceptancePending?: boolean;
  launchWritten?: boolean;
  sessionId?: string;
  alreadyRunning?: boolean;
  status?: AgentPtyStatus;
  repaired?: number;
  conversationMaterialized?: boolean;
  canResume?: boolean;
  timelineCount?: number | null;
  materializationReason?: string | null;
  error?: string;
}

export interface AgentSendTarget {
  toolType: AgentHistoryTool;
  sessionId?: string | null;
  lifecycleGeneration?: string | null;
  turnId?: string | null;
  terminalInstanceId?: string | null;
  launchId?: string | null;
}

// These fields belong to the existing Main Send attempt. The callback stays
// local to the renderer and is never serialized into an IPC payload.
export interface AgentSendLaunchContext {
  sendOperationKey?: string | null;
  sendAttemptId?: string | null;
  expectedTarget?: AgentSendTarget;
  assertNotCancelled?: () => void;
  launchFence?: { terminalInstanceId: string; stopRevision: number } | null;
  launchAdmission?: ReturnType<typeof createAgentLaunchAdmission>;
  acceptPreparedSession?: (sessionId: string) => void;
}

export interface AgentDraftObservationOptions {
  codexStartupFrameWaitId?: string | null;
  handoffId?: string;
  attemptId?: string | null;
}

export interface AgentSendPromptOptions {
  codexStartupFrameWaitId?: string | null;
  handoffId?: string;
  sendAttemptId?: string;
  sendOperationKey?: string;
  expectedTarget?: AgentSendTarget;
  source?: string;
  promptQueueAction?: 'send-now';
  statusAtSend?: AgentPtyStatus;
  queue?: boolean;
  model?: string;
  effort?: string;
  thinking?: string;
  runtimeSnapshot?: any;
  assertNotCancelled?: () => void;
  claudeExactEmptyEvidence?: Record<string, unknown> | null;
  refreshClaudeExactEmptyEvidence?: () => Promise<{
    success: boolean;
    evidence?: Record<string, unknown> | null;
    code?: string;
    error?: string;
  }>;
  presentationSnapshot?: {
    historySendStartedAt?: number;
    historySessionId?: string | null;
    imagePaths?: Array<{
      id: number;
      path: string;
      assetId?: string;
      mediaType?: string | null;
      size?: number;
      availability?: 'available' | 'missing';
      error?: string;
    }>;
    promptChips?: Array<{
      id?: string;
      kind: 'prompt';
      label?: string;
      text: string;
      sourceKey?: string;
      inheritanceDepth?: number;
      inheritanceParentLabel?: string;
    }>;
    semanticTags?: Array<{
      id?: string;
      kind: 'orchestration';
      runId: string;
      phase: 'request' | 'completion' | 'failure';
      parentRunId?: string;
      sourceTabId?: string;
      targetTabId?: string;
      outcome?: string;
    } | {
      id?: string;
      kind: 'prompt-origin';
      source: 'loop' | 'system';
      systemSource?: 'build-install-return' | 'codex-capacity-retry';
      auditSourceIdentity?: string;
    }>;
  };
}

export interface AgentHistoryContextOptions {
  sessionId?: string | null;
  sessionAuthority?: 'live-writer' | 'history-hint' | 'fresh';
  cwd?: string;
  handoffId?: string;
  source?: string;
  model?: string;
  effort?: string;
  presentationSnapshot?: AgentSendPromptOptions['presentationSnapshot'];
}

export interface AgentTurnInterruptResult {
  success: boolean;
  interrupted?: boolean;
  interruptRequested?: boolean;
  interruptConfirmed?: boolean;
  status?: string;
  error?: string;
  skipped?: string;
}

export interface HistoryAgentRuntime {
  toolType: AgentHistoryTool;
  label: string;
  lowerLabel: string;
  logPrefix: string;
  busyEvent: string;
  readyEvent?: string;
  awaitingEvent?: string;
  pasteBusyEvent?: string;
  supportsQuestions: boolean;
  supportsInterruptRecovery: boolean;
  interruptRecoveryReasons?: readonly string[];
  allowSendWhileBusy: boolean;
  optimisticBusyOnSend: boolean;
  optimisticActiveOnInterrupt: boolean;
  getPresence: (
    tabId: string,
    projectId?: string | null,
    context?: AgentPresenceRequestContext,
  ) => Promise<AgentPtyPresence>;
  // Local creation intent, not provider presence/readiness. Send may wait for
  // this already-requested Fork, but must not start a different fresh session.
  hasPendingForkLaunch?: (tabId: string) => boolean;
  prepareMainComposerForSend?: (tabId: string, options: {
    expectedTarget: AgentSendTarget;
    sendOperationKey?: string | null;
    sendAttemptId?: string | null;
  }) => Promise<{ success: boolean; inputWritten?: boolean; error?: string; code?: string }>;
  startFresh?: (args: {
    tabId: string;
    cwd?: string;
    developerInstructions?: string;
  } & AgentSendLaunchContext) => Promise<AgentResumeResult>;
  resume: (args: {
    tabId: string;
    sessionId: string;
    cwd?: string;
    resumePausedGoal?: boolean;
  } & AgentSendLaunchContext) => Promise<AgentResumeResult>;
  sendPrompt: (tabId: string, prompt: string, options?: AgentSendPromptOptions) => Promise<any>;
  recordHistoryContext: (
    tabId: string,
    prompt: string,
    options?: AgentHistoryContextOptions,
  ) => Promise<any>;
  // `context.busy` lets a runtime refuse an interrupt that would do something
  // else entirely on an idle composer (Codex: Escape opens native Rewind).
  interruptTurn: (
    tabId: string,
    context?: { busy?: boolean },
  ) => AgentTurnInterruptResult | Promise<AgentTurnInterruptResult>;
  stopProcess: (tabId: string, options?: {
    reason?: string | null;
    authority?: Record<string, unknown> | null;
    captureCodexRestartSettings?: boolean;
  }) => Promise<any>;
  grabDraft: (tabId: string, options?: AgentDraftGrabOptions) => Promise<AgentDraftGrabResult>;
  copyDraft: (tabId: string, options?: AgentDraftGrabOptions) => Promise<AgentDraftGrabResult>;
  probeDraft?: (tabId: string, reason: string, options?: AgentDraftObservationOptions) => Promise<AgentDraftInspection>;
  inspectDraft?: (tabId: string) => AgentDraftInspection;
  getPendingQuestion?: (tabId: string) => Promise<AgentPendingQuestion | null>;
  answerQuestion?: (args: {
    tabId: string;
    pendingQuestion: AgentPendingQuestion;
    answers?: Record<string, string>;
    stop?: boolean;
  }) => Promise<any>;
}

const codexSendInflight = new Map<string, Promise<any>>();
const codexStopInflight = new Map<string, Promise<any>>();
const codexDraftInflight = new Map<string, Promise<AgentDraftGrabResult>>();

const shortTab = (tabId: string) => String(tabId || '').slice(-12) || 'unknown';
const errorText = (e: any) => String(e?.message || e);

function isSubmittedCodexAuditTimeout(result: any): boolean {
  return result?.success === false &&
    result?.submitted === true &&
    result?.error === 'codex_user_message_audit_timeout';
}

type RuntimeTabState = {
  aiBusy?: boolean;
  commandType?: string;
  codexSessionId?: string;
  codexModel?: string;
  codexEffort?: string;
  codexLiveModel?: string;
  codexLiveEffort?: string;
  codexLiveSettingsSessionId?: string;
  codexSettingsProofSessionId?: string;
};

const findTabRuntimeContext = (
  tabId: string,
  projectIdHint?: string | null,
): { tab: RuntimeTabState; projectId: string; uniqueTabId: boolean } | null => {
  const store = useWorkspaceStore.getState();
  const matches: Array<{ tab: RuntimeTabState; projectId: string }> = [];
  for (const [projectId, workspace] of store.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) matches.push({ tab, projectId });
  }
  if (matches.length === 0) return null;
  if (projectIdHint) {
    const hinted = matches.find((match) => match.projectId === projectIdHint);
    return hinted ? { ...hinted, uniqueTabId: matches.length === 1 } : null;
  }
  if (store.activeProjectId) {
    const hinted = matches.find((match) => match.projectId === store.activeProjectId);
    if (hinted) return { ...hinted, uniqueTabId: matches.length === 1 };
  }
  return { ...matches[0], uniqueTabId: matches.length === 1 };
};


async function startFreshClaudePtySession({
  tabId,
  cwd,
  sendOperationKey,
  sendAttemptId,
  expectedTarget,
  assertNotCancelled,
  launchFence,
  launchAdmission,
}: {
  tabId: string;
  cwd?: string;
} & AgentSendLaunchContext): Promise<AgentResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const projectId = findTabRuntimeContext(tabId)?.projectId;
  const readUi = () => projectId ? useWorkspaceStore.getState().openProjects.get(projectId)?.tabs.get(tabId) : null;
  const before = readUi();
  const presentation = before && { sessionId: before.claudeSessionId || null, cwd: before.cwd,
    interrupted: !!before.wasInterrupted, dismissed: !!before.overlayDismissed };
  return withAgentLaunchAdmission({ launchAdmission,
    invoke: ipcRenderer.invoke.bind(ipcRenderer), events: ipcRenderer, tabId, toolType: 'claude', cwd,
    launchFence, sendOperationKey, sendAttemptId, expectedTarget, assertCurrent: assertNotCancelled,
  }, async admission => {
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'claude');
  store.markAiLaunchAutoTitle(tabId, 'claude');
  console.log('[ClaudePtyActions:startFresh] start tab=' + shortTab(tabId));
  assertNotCancelled?.();
  const runResult = await admission.run('claude:run-command', {
    tabId, command: 'claude', sendOperationKey, sendAttemptId, expectedTarget, launchFence,
  });
  if (runResult?.success === false) {
    return { ...runResult, success: false, error: runResult.error || runResult.reason || 'Claude start failed' };
  }
  const observed = runResult.observedLaunchFence, original = runResult.launchFence;
  const matchesUi = (id: string | null) => {
    const current = readUi();
    return !!presentation && !!current && current.cwd === presentation.cwd
      && resolvePtyAgentOwner(current) === 'claude' && (current.claudeSessionId || null) === id
      && !!current.wasInterrupted === presentation.interrupted && !!current.overlayDismissed === presentation.dismissed;
  };
  const currentSessionId = readUi()?.claudeSessionId || null;
  if (matchesUi(currentSessionId)
    && (observed === undefined || !!observed && observed.terminalInstanceId === original?.terminalInstanceId
      && observed.stopRevision === original?.stopRevision)
    && (currentSessionId === presentation?.sessionId || !!currentSessionId && await admission.reconcileSession(currentSessionId))
    && matchesUi(currentSessionId)) store.clearInterruptedState?.(tabId);
  return { ...runResult, success: true, status: 'starting' };
  });
}

async function getCodexPtyPresence(
  tabId: string,
  projectIdHint?: string | null,
  _requestContext?: AgentPresenceRequestContext,
): Promise<AgentPtyPresence> {
  const context = findTabRuntimeContext(tabId, projectIdHint);
  const tab = context?.tab || null;
  const presence = await readCodexPtyPresence({
    tabId,
    projectId: context?.projectId || projectIdHint || null,
    invoke: ipcRenderer.invoke.bind(ipcRenderer),
    fallbackBusy: !!tab?.aiBusy,
  }) as AgentPtyPresence;
  const runtimeSession = presence.runtimeSnapshot;
  const turnStateResolved = runtimeSession?.hasWatcher === true
    && runtimeSession?.catchUpPending !== true;
  // The legacy store mutator accepts only tabId. Never let a presence read for
  // one project update another project when restored tabs share the same id.
  if (tab && context?.uniqueTabId && turnStateResolved && tab.aiBusy !== presence.isBusy) {
    const reason = presence.isBusy
      ? 'task_started'
      : (runtimeSession?.outcomeKnown && runtimeSession?.lastOutcomeReason
        ? runtimeSession.lastOutcomeReason
        : 'codex-outcome-unknown');
    useWorkspaceStore.getState().setAiBusy(tabId, presence.isBusy === true, reason);
  }
  return presence;
}

function hasPendingContextForkLaunch(tabId: string): boolean {
  const tab = findTabRuntimeContext(tabId)?.tab;
  return !!tab?.pendingAction?.contextFork && !tab.claudeSessionId && !tab.codexSessionId;
}

async function resumeCodexSession({
  tabId,
  sessionId,
  cwd,
  resumePausedGoal,
  sendOperationKey,
  sendAttemptId,
  expectedTarget,
  assertNotCancelled,
  launchFence,
  launchAdmission,
}: {
  tabId: string;
  sessionId: string;
  cwd?: string;
  resumePausedGoal?: boolean;
} & AgentSendLaunchContext): Promise<AgentResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!sessionId) return { success: false, error: 'sessionId required' };
  const projectId = findTabRuntimeContext(tabId)?.projectId;
  const readUi = () => projectId ? useWorkspaceStore.getState().openProjects.get(projectId)?.tabs.get(tabId) : null;
  const before = readUi();
  const presentation = before && { sessionId: before.codexSessionId, cwd: before.cwd,
    interrupted: before.wasInterrupted, dismissed: before.overlayDismissed };
  return withAgentLaunchAdmission({ launchAdmission,
    invoke: ipcRenderer.invoke.bind(ipcRenderer), events: ipcRenderer, tabId, toolType: 'codex', sessionId, cwd,
    launchFence, sendOperationKey, sendAttemptId, expectedTarget, assertCurrent: assertNotCancelled,
  }, async admission => {
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'codex');
  console.log('[CodexHistoryActions:resume] start tab=' + shortTab(tabId) + ' sid=' + sessionId.slice(0, 8));
  assertNotCancelled?.();
  const runResult = await admission.run('codex:run-command', {
    ...buildCodexRunPayload({
      tabId,
      command: 'codex-c',
      sessionId,
      cwd,
      ...(typeof resumePausedGoal === 'boolean' ? { resumePausedGoal } : {}),
    }),
    sendOperationKey, sendAttemptId, expectedTarget, launchFence,
  });
  if (runResult?.success === false || (runResult?.accepted === false
    && runResult?.acceptancePending !== true && runResult?.joined !== true)) {
    return { ...runResult, success: false, error: runResult.error || 'Codex resume failed' };
  }
  const observed = runResult.observedLaunchFence, original = runResult.launchFence;
  const matchesUi = (id: string) => {
    const current = readUi();
    return !!presentation && !!current && current.cwd === presentation.cwd
      && resolvePtyAgentOwner(current) === 'codex' && current.codexSessionId === id
      && current.wasInterrupted === presentation.interrupted && current.overlayDismissed === presentation.dismissed;
  };
  const currentSessionId = readUi()?.codexSessionId;
  if (currentSessionId && matchesUi(currentSessionId)
    && (observed === undefined || !!observed && observed.terminalInstanceId === original?.terminalInstanceId
      && observed.stopRevision === original?.stopRevision)
    && (currentSessionId === presentation?.sessionId || await admission.reconcileSession(currentSessionId))
    && matchesUi(currentSessionId)) store.clearInterruptedState?.(tabId);
  return { ...runResult, success: true, sessionId };
  });
}

export async function startFreshCodexSession({
  tabId,
  cwd,
  developerInstructions,
  sendOperationKey,
  sendAttemptId,
  expectedTarget,
  assertNotCancelled,
  launchFence: requestedLaunchFence,
  launchAdmission,
  acceptPreparedSession,
}: {
  tabId: string;
  cwd?: string;
  developerInstructions?: string;
} & AgentSendLaunchContext): Promise<AgentResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  // Start may reuse an already-bound metadata-only UUID. Capture its source
  // before begin; Main still proves that exact row and owns materialization.
  let originalSessionId: string | null = null;
  let originalProjectId: string | null = null;
  let originalCwd: string | undefined;
  const settingsKeys = ['codexModel', 'codexEffort', 'codexSettingsProofAt', 'codexSettingsIntentRevision'] as const;
  let originalSettings: unknown[] = [];
  for (const [projectId, workspace] of useWorkspaceStore.getState().openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) {
      originalSessionId = tab.codexSessionId || null;
      originalProjectId = projectId;
      originalCwd = tab.cwd;
      originalSettings = settingsKeys.map(key => tab[key]);
      break;
    }
  }
  return withAgentLaunchAdmission({ launchAdmission,
    invoke: ipcRenderer.invoke.bind(ipcRenderer), events: ipcRenderer, tabId, toolType: 'codex',
    sessionId: originalSessionId, cwd,
    launchFence: requestedLaunchFence, sendOperationKey, sendAttemptId, expectedTarget,
    assertCurrent: assertNotCancelled,
  }, async admission => {
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'codex');
  store.markAiLaunchAutoTitle(tabId, 'codex');
  // Freeze the exact tab/global choice at the user's Start click. Binding the
  // newly-created UUID must not change which next-launch pair this operation
  // carries while materialization is in flight.
  const launchOptions = getCodexLaunchOptions(tabId);
  let projectId: string | null = null;
  let tabCwd = cwd;
  for (const [, workspace] of store.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (!tab) continue;
    projectId = workspace.projectId;
    tabCwd = tabCwd || tab.cwd;
    break;
  }
  if (!projectId || !tabCwd) {
    return { ...admission.snapshot(), success: false, code: 'agent_launch_source_unavailable',
      reason: 'agent_launch_source_unavailable', error: 'Codex tab project/cwd is unavailable' };
  }
  console.log('[CodexHistoryActions:startFresh] materialize tab=' + shortTab(tabId));
  assertNotCancelled?.();
  const { launchFence } = await admission.ready();
  assertNotCancelled?.();
  const materialized = await admission.materialize({
    projectId,
    tabId,
    cwd: tabCwd,
    sendOperationKey, sendAttemptId, expectedTarget, launchFence,
  });
  if (materialized?.success !== true || !materialized?.sessionId) {
    return { ...materialized, success: false, error: materialized?.error || 'Codex session materialization failed' };
  }
  assertNotCancelled?.();
  if (materialized.materializedSessionId !== materialized.sessionId) {
    return { ...materialized, success: false, code: 'agent_launch_materialization_proof_missing',
      reason: 'agent_launch_materialization_proof_missing', error: 'agent_launch_materialization_proof_missing',
      accepted: false, launchWritten: false };
  }
  const readSourceTab = () => originalProjectId
    ? useWorkspaceStore.getState().openProjects.get(originalProjectId)?.tabs.get(tabId) : null;
  const sourceStillCurrent = (beforeBinding: boolean, expectedSessionId = materialized.sessionId) => {
    const tab = readSourceTab();
    const currentSessionId = tab?.codexSessionId || null;
    return !!tab && tab.cwd === originalCwd && resolvePtyAgentOwner(tab) === 'codex'
      && (currentSessionId === expectedSessionId || beforeBinding && currentSessionId === originalSessionId);
  };
  const bindingChanged = () => ({ ...materialized, success: false,
    code: 'agent_launch_binding_changed', reason: 'agent_launch_binding_changed',
    error: 'Codex target changed while materialization was pending' });
  // Main's CAS owns the durable file, but its delayed ACK cannot overwrite a
  // newer renderer binding. The actual non-history Store setter mutates before
  // yielding; check again after its promise before clearing launch UI state.
  if (!sourceStillCurrent(true)) return bindingChanged();
  acceptPreparedSession?.(materialized.sessionId);
  const bound = await store.setCodexSessionId(
    tabId,
    materialized.sessionId,
    'detected',
  );
  if (!bound) {
    return { ...admission.snapshot(), success: false, code: 'agent_launch_binding_changed',
      reason: 'agent_launch_binding_changed', error: 'Codex materialized session could not bind to the tab' };
  }
  if (!sourceStillCurrent(false)) return bindingChanged();
  assertNotCancelled?.();
  // The durable UUID now belongs to the tab even if the following PTY launch
  // is rejected. Do not let a stale pre-materialization rollback restore the
  // old bash identity or erase this resumable metadata-only session.
  store.clearAiLaunchSnapshot(tabId, 'codex-empty-session-materialized');
  const runPayload = {
    tabId,
    command: 'codex-c',
    sessionId: materialized.sessionId,
    cwd: tabCwd,
    materializedFresh: materialized.metadataOnly === true,
    developerInstructions,
    ...launchOptions,
    sendOperationKey, sendAttemptId, expectedTarget, launchFence,
  };
  console.log('[CodexHistoryActions:startFresh] resume tab=' + shortTab(tabId)
    + ' sid=' + String(materialized.sessionId).slice(0, 8)
    + ' model=' + (runPayload.model || '-')
    + ' effort=' + (runPayload.effort || '-')
    + ' modelSource=' + (runPayload.modelSource || '-')
    + ' effortSource=' + (runPayload.effortSource || '-'));
  const beforeLaunchUi = readSourceTab();
  const interruptedBeforeLaunch = beforeLaunchUi?.wasInterrupted;
  const dismissedBeforeLaunch = beforeLaunchUi?.overlayDismissed;
  const runResult = await admission.run('codex:run-command', runPayload);
  if (runResult?.success === false || (runResult?.accepted === false
    && runResult?.acceptancePending !== true && runResult?.joined !== true)) {
    return { ...runResult, success: false, error: runResult.error || 'Codex start failed' };
  }
  const persisted = planCodexLaunchSettingsPersistence({
    command: 'codex-c',
    result: runResult,
    payload: runPayload,
  });
  // The ACK describes a historical launch. It cannot project its old settings
  // or interruption state onto a newer source or a newer settings choice.
  const observed = runResult.observedLaunchFence;
  let mayProject = observed === undefined || !!observed
    && observed.terminalInstanceId === launchFence.terminalInstanceId
    && observed.stopRevision === launchFence.stopRevision;
  let projectionSessionId = materialized.sessionId;
  if (mayProject && !sourceStillCurrent(false)) {
    const child = readSourceTab()?.codexSessionId;
    mayProject = !!child && sourceStillCurrent(false, child)
      && await admission.reconcileSession(child);
    if (mayProject) projectionSessionId = child!;
  }
  if (mayProject && sourceStillCurrent(false, projectionSessionId)) {
    const tab = readSourceTab();
    if (persisted && settingsKeys.every((key, index) => tab?.[key] === originalSettings[index])) {
      store.updateCodexState(tabId, persisted);
    }
    const current = readSourceTab();
    if (sourceStillCurrent(false, projectionSessionId)
      && current?.wasInterrupted === interruptedBeforeLaunch
      && current?.overlayDismissed === dismissedBeforeLaunch) store.clearInterruptedState?.(tabId);
  }
  return {
    ...runResult,
    success: true,
    status: 'starting',
    sessionId: materialized.sessionId,
    conversationMaterialized: false,
  };
  });
}

async function sendCodexPrompt(tabId: string, prompt: string, options: AgentSendPromptOptions = {}): Promise<any> {
  // Only call this before codex:send-command / send-live-slash-command.
  // A picker command may have run, but this user prompt has not been pasted.
  const notSubmitted = (result: any) => ({
    ...result,
    success: false,
    accepted: false,
    submitted: false,
    promptSent: false,
    pasteWritten: false,
    enterWritten: false,
    status: 'not-submitted',
  });
  if (!tabId) return notSubmitted({ error: 'tabId required' });
  if (!prompt.trim()) return notSubmitted({ error: 'prompt required' });
  const tabContext = findTabRuntimeContext(tabId);
  const localSlashCommand = isStandaloneCodexLocalSlashCommand({
    prompt,
    imageCount: options.presentationSnapshot?.imagePaths?.length || 0,
    chipCount: options.presentationSnapshot?.promptChips?.length || 0,
  });
  const hasSettingsRequest = [options.model, options.effort].some((value) => (
    typeof value === 'string'
    && value.trim().length > 0
    && value.trim() !== 'none'
  ));
  let settingsRuntimeSnapshot = hasSettingsRequest
    ? (options.runtimeSnapshot || null)
    : null;
  if (
    hasSettingsRequest
    && !settingsRuntimeSnapshot
    && options.statusAtSend !== 'busy'
    && options.queue !== true
  ) {
    settingsRuntimeSnapshot = await ipcRenderer.invoke('codex:get-runtime-session', {
      tabId,
      projectId: tabContext?.projectId || null,
    }).catch((error: any) => {
      console.warn('[CodexHistoryActions:send] settings owner lookup failed tab='
        + shortTab(tabId)
        + ' error=' + errorText(error));
      return null;
    });
  }
  const {
    activeWriterSessionId,
    currentSettingsOwnerId,
  } = resolveCodexSettingsRuntimeProof(settingsRuntimeSnapshot);
  // Prompts and local commands carry raw settings intent to one main transaction.
  // A renderer snapshot cannot resolve the other half or authorize a same-pair
  // shortcut while a different settings operation is already queued in main.
  const settingsIntent = {
    expectedTarget: options.expectedTarget,
    model: options.model,
    effort: options.effort,
    expectedWriterSessionId: hasSettingsRequest && !isCompleteCodexSettingsRequest({
      requestedModel: options.model,
      requestedEffort: options.effort,
    }) ? currentSettingsOwnerId || activeWriterSessionId || null : null,
  };
  const existing = codexSendInflight.get(tabId);
  if (existing) {
    // Preserve the existing in-flight join policy. This is not the settings
    // decision for a new send; main resolves that only after queue admission.
    const inflightSettingsPlan = planCodexHistorySettings({
      requestedModel: options.model, requestedEffort: options.effort,
      runtimeSnapshot: settingsRuntimeSnapshot, statusAtSend: options.statusAtSend,
      queue: options.queue,
    });
    if (inflightSettingsPlan.hasRequestedSettings) {
      console.warn('[CodexHistoryActions:send] settings refused behind inflight send tab='
        + shortTab(tabId)
        + ' handoff=' + (options.handoffId || '-'));
      return notSubmitted({
        success: false,
        ok: false,
        code: 'codex_settings_change_send_inflight',
        error: 'Another Codex send is already in progress; settings and prompt were not sent',
        promptSent: false,
      });
    }
    console.log('[CodexHistoryActions:send] join-inflight tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-'));
    return existing;
  }
  useWorkspaceStore.getState().clearInterruptedState?.(tabId);
  const queue = options.queue === true || options.statusAtSend === 'busy';
  const modelForPicker = options.model;
  const effortForPicker = options.effort;
  const draftStateForSend = await probeCodexDraft(tabId, 'history-send-preflight', {
    codexStartupFrameWaitId: options.codexStartupFrameWaitId,
    handoffId: options.handoffId, attemptId: options.sendAttemptId,
  });
  console.log('[CodexHistoryActions:send] start tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' source=' + (options.source || '-') + ' statusAtSend=' + (options.statusAtSend || '-') + ' queue=' + queue + ' model=' + (modelForPicker || '-') + ' effort=' + (effortForPicker || '-') + ' submitIntent=' + (queue ? 'enter-busy' : 'enter') + ' chars=' + prompt.length + ' draftSource=' + (draftStateForSend?.source || '-') + ' skipVisibleDraftGuard=false');
  const sendInvocation = localSlashCommand
    ? ipcRenderer.invoke('codex:send-live-slash-command', {
        tabId,
        ...settingsIntent,
        command: normalizeCodexLocalSlashCommand(prompt),
        handoffId: options.handoffId || null,
        sendOperationKey: options.sendOperationKey || null,
        sendAttemptId: options.sendAttemptId || null,
        source: options.source || null,
        codexStartupFrameWaitId: options.codexStartupFrameWaitId || draftStateForSend.codexStartupFrameWaitId,
        promptQueueAction: options.promptQueueAction,
        queue,
        statusAtSend: options.statusAtSend || null,
        hasDraft: draftStateForSend?.hasDraft ?? null,
        draftSource: draftStateForSend?.source || 'history-send-preflight',
        draftPreview: draftStateForSend?.preview || '',
        visualHasDraft: draftStateForSend?.hasDraft ?? null,
        visualSource: draftStateForSend?.source || 'history-send-preflight',
        visualPreview: draftStateForSend?.preview || '',
        turnBusy: queue,
      })
    : ipcRenderer.invoke('codex:send-command', tabId, prompt, {
        queue,
        ...settingsIntent,
        handoffId: options.handoffId || null,
        sendAttemptId: options.sendAttemptId || null,
        sendOperationKey: options.sendOperationKey || null,
        source: options.source || null,
        codexStartupFrameWaitId: options.codexStartupFrameWaitId || draftStateForSend.codexStartupFrameWaitId,
        promptQueueAction: options.promptQueueAction,
        statusAtSend: options.statusAtSend || null,
        skipVisibleDraftGuard: false,
        presentationSnapshot: options.presentationSnapshot || null,
      });
  const work = sendInvocation
    .then((result: any) => {
      if (localSlashCommand) {
        console.log('[CodexHistoryActions:send] local slash done tab=' + shortTab(tabId)
          + ' handoff=' + (options.handoffId || '-')
          + ' success=' + (result?.success === true)
          + ' submitted=' + (result?.submitted === true)
          + ' queued=' + queue
          + ' proof=' + (result?.localCommandProof || '-'));
        return {
          ...(result || {}),
          localSlashCommand: true,
          queued: queue,
        };
      }
      const auditTimeoutAfterSubmit = isSubmittedCodexAuditTimeout(result);
      const confirmationPending = result?.auditPending === true && result?.submitted === true;
      console.log('[CodexHistoryActions:send] done tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' success=' + (confirmationPending ? 'pending' : auditTimeoutAfterSubmit ? 'unknown' : result?.success !== false) + ' queued=' + (result?.queued ? 'true' : 'false') + ' submitKey=' + (result?.submitKey || '-') + ' auditSoft=' + auditTimeoutAfterSubmit);
      if (auditTimeoutAfterSubmit) {
        console.warn('[CodexHistoryActions:send] audit timeout after submitted Enter tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' - delivery is unconfirmed; keeping the immutable attempt for late audit');
        return {
          ...result,
          success: null,
          accepted: true,
          status: 'delivery-unknown',
          receiptState: 'delivery-unknown',
          deliveryUnknown: true,
          auditPending: false,
          auditWarning: result.error,
          userMessageAuditPending: true,
        };
      }
      return result;
    })
    .catch((e: any) => {
      console.warn('[CodexHistoryActions:send] error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (codexSendInflight.get(tabId) === work) codexSendInflight.delete(tabId);
    });
  codexSendInflight.set(tabId, work);
  return work;
}

async function interruptCodexTurn(
  tabId: string,
  context?: { busy?: boolean },
): Promise<AgentTurnInterruptResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  // Escape is only an interrupt while Codex is actually answering. On an idle
  // composer the same byte opens Codex's native backtrack/Rewind picker, so
  // sending it as a generic "cancel" hijacks the terminal into a mode the user
  // never asked for. Refusing silently would be just as bad — a skipped path
  // and a path that was never called look identical in a log — hence the
  // explicit trace.
  if (context?.busy === false) {
    console.log('[CodexInterrupt] skipped tab=' + shortTab(tabId)
      + ' reason=idle-composer-would-open-rewind');
    return { success: true, interrupted: false, skipped: 'idle-composer' };
  }
  return ipcRenderer.invoke('codex:interrupt-turn', tabId);
}

async function stopCodexProcess(tabId: string, options: {
  reason?: string | null;
  authority?: Record<string, unknown> | null;
  captureCodexRestartSettings?: boolean;
} = {}): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const existing = codexStopInflight.get(tabId);
  if (existing) {
    console.log('[CodexHistoryActions:stop-process] join-inflight tab=' + shortTab(tabId));
    return existing;
  }
  console.log('[CodexHistoryActions:stop-process] start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('terminal:stop-ai-process', {
    tabId,
    toolType: 'codex',
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.authority ? { authority: options.authority } : {}),
    ...(options.captureCodexRestartSettings ? { captureCodexRestartSettings: true } : {}),
  })
    .then((result: any) => {
      console.log('[CodexHistoryActions:stop-process] done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' error=' + (result?.error || '-'));
      return result;
    })
    .catch((e: any) => {
      console.warn('[CodexHistoryActions:stop-process] error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (codexStopInflight.get(tabId) === work) codexStopInflight.delete(tabId);
    });
  codexStopInflight.set(tabId, work);
  return work;
}

async function captureCodexDraft(
  tabId: string,
  mode: 'grab' | 'copy',
  options: AgentDraftGrabOptions = {},
): Promise<AgentDraftGrabResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  // Same request retries can join; independent consumers get distinct physical
  // captures through main's PTY queue, never the same withdrawn snapshot.
  const captureRequestId = options.captureRequestId || crypto.randomUUID();
  const captureKey = tabId + ':' + mode + ':' + captureRequestId;
  const existing = codexDraftInflight.get(captureKey);
  if (existing) {
    console.log('[CodexHistoryActions:draft] ' + mode + ' join-inflight tab=' + shortTab(tabId));
    return existing;
  }
  console.log('[CodexHistoryActions:draft] ' + mode + ' start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('codex:' + mode + '-input', tabId, { ...options, captureRequestId })
    .then((result: AgentDraftGrabResult) => {
      console.log('[CodexHistoryActions:draft] ' + mode + ' done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' chars=' + (result?.text?.length || 0) + ' images=' + (result?.images || 0) + ' error=' + (result?.error || '-'));
      return result || { success: false, error: 'empty_result' };
    })
    .catch((e: any) => {
      console.warn('[CodexHistoryActions:draft] ' + mode + ' error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (codexDraftInflight.get(captureKey) === work) codexDraftInflight.delete(captureKey);
    });
  codexDraftInflight.set(captureKey, work);
  return work;
}

function grabCodexDraft(
  tabId: string,
  options: AgentDraftGrabOptions = {},
): Promise<AgentDraftGrabResult> {
  return captureCodexDraft(tabId, 'grab', options);
}

function copyCodexDraft(
  tabId: string,
  options: AgentDraftGrabOptions = {},
): Promise<AgentDraftGrabResult> {
  return captureCodexDraft(tabId, 'copy', options);
}

function inspectCodexDraft(tabId: string): { hasDraft: boolean | null; preview: string; source: string } {
  const state = terminalRegistry.getCodexDraftState(tabId);
  console.warn('[CodexHistoryActions:draft] visual-probe tab=' + shortTab(tabId) + ' hasDraft=' + state.hasDraft + ' source=' + state.source + ' preview=' + JSON.stringify(state.preview));
  return state;
}

async function probeCodexDraft(tabId: string, reason: string, options: AgentDraftObservationOptions = {}) {
  let codexStartupFrameWaitId = options.codexStartupFrameWaitId || null;
  const visualState = terminalRegistry.getCodexDraftState(tabId);
  const resolved = await readCodexDraftAuthority({
    invoke: async (channel: string, ...args: any[]) => {
      if (channel === 'codex:get-draft-state') args[1] = { ...(args[1] || {}), ...options };
      const proof = await ipcRenderer.invoke(channel, ...args);
      if (channel === 'codex:get-draft-state' && proof?.codexStartupFrameWaitId) {
        codexStartupFrameWaitId = proof.codexStartupFrameWaitId;
      }
      return proof;
    },
    tabId,
    reason,
    timeoutMs: 700,
    waitFor: false,
    waitTimeoutMs: 2500,
    waitOnUnknownOnly: true,
    visualState,
  });
  console.warn('[CodexHistoryActions:draft] authoritative-probe tab=' + shortTab(tabId)
    + ' reason=' + reason
    + ' hasDraft=' + resolved.hasDraft
    + ' authority=' + resolved.authority
    + ' source=' + resolved.source
    + ' visual=' + resolved.visualHasDraft + ':' + resolved.visualSource
    + (resolved.rendererPositiveIgnored ? ' ignored=' + resolved.rendererPositiveIgnored : '')
    + ' preview=' + JSON.stringify(resolved.preview));
  return { ...resolved, codexStartupFrameWaitId };
}

async function probeClaudeDraft(tabId: string, reason: string) {
  const resolved = await ipcRenderer.invoke('claude:get-draft-state', tabId, {
    reason,
    timeoutMs: 700,
    waitOnUnknownOnly: true,
    waitTimeoutMs: 15000,
  }).catch((error: any) => ({
    success: false,
    hasDraft: null,
    preview: '',
    source: 'claude-composer:probe-error',
    error: errorText(error),
  }));
  console.log('[ClaudePtyActions:draft] authoritative-probe tab=' + shortTab(tabId)
    + ' reason=' + reason
    + ' hasDraft=' + resolved.hasDraft
    + ' proof=' + (resolved.proofOutcome || 'unknown')
    + ' proofReason=' + (resolved.proofReason || resolved.error || '-')
    + ' source=' + (resolved.source || '-')
    + ' preview=' + JSON.stringify(resolved.preview || ''));
  return resolved;
}

async function recordAgentHistoryContext(
  toolType: AgentHistoryTool,
  tabId: string,
  prompt: string,
  options: AgentHistoryContextOptions = {},
) {
  return ipcRenderer.invoke('agent:record-history-context', {
    tabId,
    toolType,
    sessionId: options.sessionId || null,
    sessionAuthority: options.sessionAuthority || (options.sessionId ? 'history-hint' : 'fresh'),
    cwd: options.cwd,
    prompt,
    handoffId: options.handoffId || null,
    source: options.source || 'history-panel',
    model: options.model || null,
    effort: options.effort || null,
    presentationSnapshot: options.presentationSnapshot || null,
  }).catch((error: any) => ({
    success: false,
    accepted: false,
    submitted: false,
    historyOnly: true,
    error: errorText(error),
  }));
}

const CLAUDE_RUNTIME: HistoryAgentRuntime = {
  toolType: 'claude',
  label: 'Claude',
  lowerLabel: 'claude',
  logPrefix: 'ClaudeHistoryControls',
  busyEvent: 'claude:busy-state',
  readyEvent: 'claude:tui-ready',
  awaitingEvent: 'claude:awaiting-input',
  pasteBusyEvent: 'claude:paste-busy',
  supportsQuestions: true,
  supportsInterruptRecovery: true,
  interruptRecoveryReasons: ['interrupt'],
  allowSendWhileBusy: true,
  // History controls must not treat paste/send completion as model thinking.
  // The busy edge comes from Claude's UserPromptSubmit/Stop pipeline.
  optimisticBusyOnSend: false,
  optimisticActiveOnInterrupt: true,
  getPresence: getClaudePtyPresence,
  hasPendingForkLaunch: hasPendingContextForkLaunch,
  startFresh: startFreshClaudePtySession,
  resume: resumeClaudePtySession,
  sendPrompt: sendClaudePtyPrompt,
  recordHistoryContext: (tabId, prompt, options) => (
    recordAgentHistoryContext('claude', tabId, prompt, options)
  ),
  interruptTurn: interruptClaudePtyTurn,
  stopProcess: stopClaudePtyProcess,
  grabDraft: grabClaudePtyDraft,
  copyDraft: copyClaudePtyDraft,
  probeDraft: probeClaudeDraft,
  getPendingQuestion: getClaudePendingQuestion,
  answerQuestion: answerClaudeQuestion,
};

const CODEX_RUNTIME: HistoryAgentRuntime = {
  toolType: 'codex',
  label: 'Codex',
  lowerLabel: 'codex',
  logPrefix: 'CodexHistoryControls',
  busyEvent: 'codex:busy-state',
  readyEvent: 'codex:tui-ready',
  // safePasteAndSubmit owns one provider-neutral PTY write-busy channel.
  // Codex must consume it too; otherwise its perimeter loader/timer starts
  // only after task_started and hides the visible pre-submit phase.
  pasteBusyEvent: 'claude:paste-busy',
  supportsQuestions: false,
  supportsInterruptRecovery: true,
  interruptRecoveryReasons: ['turn_aborted'],
  allowSendWhileBusy: true,
  optimisticBusyOnSend: false,
  optimisticActiveOnInterrupt: false,
  getPresence: getCodexPtyPresence,
  hasPendingForkLaunch: hasPendingContextForkLaunch,
  prepareMainComposerForSend: (tabId, options) => ipcRenderer.invoke(
    'codex:prepare-main-composer-for-send', { tabId, ...options }),
  startFresh: startFreshCodexSession,
  resume: resumeCodexSession,
  sendPrompt: sendCodexPrompt,
  recordHistoryContext: (tabId, prompt, options) => (
    recordAgentHistoryContext('codex', tabId, prompt, options)
  ),
  interruptTurn: interruptCodexTurn,
  stopProcess: stopCodexProcess,
  grabDraft: grabCodexDraft,
  copyDraft: copyCodexDraft,
  probeDraft: probeCodexDraft,
  inspectDraft: inspectCodexDraft,
};

export const getHistoryAgentRuntime = (toolType: AgentHistoryTool): HistoryAgentRuntime =>
  toolType === 'codex' ? CODEX_RUNTIME : CLAUDE_RUNTIME;
