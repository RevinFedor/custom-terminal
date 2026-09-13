import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { clearPendingResume, markPendingResume } from './pendingResume';
import type { AgentSendTarget } from './historyAgentRuntimes';
import {
  isStandaloneAgentLocalCommand,
  normalizeAgentLocalCommand,
} from './agentLocalCommand.mjs';

const { ipcRenderer } = window.require('electron');

export type ClaudePtyStatus = 'active' | 'busy' | 'inactive' | 'starting' | 'stopping';

export interface ClaudePtyPresence {
  status: ClaudePtyStatus;
  hasBridge?: boolean;
  isBusy?: boolean;
  hasTerm?: boolean;
  inputReady?: boolean;
  awaiting?: boolean;
  sessionId?: string | null;
  sendTarget?: AgentSendTarget & { acceptedResumeSourceSessionId?: string | null };
  conversationMaterialized?: boolean;
  canResume?: boolean;
  canCopySessionId?: boolean;
  timelineCount?: number | null;
  materializationReason?: string | null;
}

export interface ClaudeQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface ClaudeQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: ClaudeQuestionOption[];
}

export interface ClaudePendingQuestion {
  source: 'pty' | 'sdk';
  toolUseID?: string;
  questions: ClaudeQuestion[];
}

export interface ClaudePtyDraftGrabResult {
  success: boolean;
  text?: string;
  capturedText?: string;
  images?: number;
  imagePaths?: Array<{ id: number; path: string; mediaType: string; size: number }>;
  draftTransfer?: {
    id: string;
    tabId: string;
    text: string;
    images: number;
    imagePaths: Array<{ id: number; path: string; mediaType?: string | null; size?: number; assetId?: string; availability?: 'available' | 'missing'; error?: string }>;
  } | null;
  captureRequestId?: string | null;
  captureOperationId?: string;
  mode?: string;
  error?: string;
  proofOutcome?: 'found' | 'absent' | 'unknown' | string;
  proofReason?: string;
  editorReturnReady?: boolean;
  editorReturnReason?: string | null;
  terminalIdentityStable?: boolean;
  terminalRunSeq?: number | null;
  inputRevision?: number | null;
  screenProofInputRevision?: number | null;
  inputRevisionTransition?: 'ctrl-g-exact-capture' | string;
  inputRevisionTransitionOwned?: boolean;
  screenContradiction?: boolean;
  terminalLifecycleGeneration?: string | null;
  mirrorGeneration?: string | null;
}

export interface ClaudePtyDraftGrabOptions {
  draftProof?: Record<string, unknown>;
  captureRequestId?: string;
  /** Automatic interrupt recovery must not withdraw the next turn's composer. */
  requireTurnIdle?: boolean;
}

export interface ClaudePtySendOptions {
  handoffId?: string;
  sendAttemptId?: string;
  sendOperationKey?: string;
  expectedTarget?: AgentSendTarget;
  source?: string;
  promptQueueAction?: 'send-now';
  statusAtSend?: string;
  queue?: boolean;
  model?: string;
  effort?: string;
  thinking?: string;
  assertNotCancelled?: () => void;
  claudeExactEmptyEvidence?: Record<string, unknown> | null;
  refreshClaudeExactEmptyEvidence?: () => Promise<{
    success: boolean;
    evidence?: Record<string, unknown> | null;
    code?: string;
    error?: string;
  }>;
  presentationSnapshot?: {
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

type ClaudePtyResumeResult = {
  success: boolean;
  sessionId?: string;
  alreadyRunning?: boolean;
  status?: ClaudePtyStatus;
  repaired?: number;
  conversationMaterialized?: boolean;
  canResume?: boolean;
  timelineCount?: number | null;
  materializationReason?: string | null;
  error?: string;
};

const resumeInflight = new Map<string, Promise<ClaudePtyResumeResult>>();
const sendInflight = new Map<string, Promise<any>>();
const stopInflight = new Map<string, Promise<any>>();
const questionInflight = new Map<string, Promise<any>>();
const draftGrabInflight = new Map<string, Promise<ClaudePtyDraftGrabResult>>();

const shortTab = (tabId: string) => String(tabId || '').slice(-12) || 'unknown';
const shortSid = (sessionId?: string) => sessionId ? sessionId.slice(0, 8) : 'none';
const errorText = (e: any) => String(e?.message || e);

export type ClaudePtySettingKind = 'model' | 'effort';

export interface ClaudePtySettingResult {
  success: true;
  tabId: string;
  kind: ClaudePtySettingKind;
  value: string;
  command: string;
  proof: string;
  sessionId?: string | null;
  timestamp?: string | null;
}

export async function applyClaudePtySetting({
  tabId,
  kind,
  value,
  source = 'claude-pty-setting',
  assertNotCancelled,
}: {
  tabId: string;
  kind: ClaudePtySettingKind;
  value: string;
  source?: string;
  assertNotCancelled?: () => void;
}): Promise<ClaudePtySettingResult> {
  assertNotCancelled?.();
  const result = await ipcRenderer.invoke('claude:apply-setting', { tabId, kind, value, source });
  assertNotCancelled?.();
  if (result?.success !== true) throw new Error(result?.error || 'Claude setting was not confirmed');
  return result;
}

export async function applyClaudePtySettings({ tabId, model, effort, source }: {
  tabId: string; model: string; effort: string; source: string;
}): Promise<{ success: true; appliedSettings: { model: string; effort: string } }> {
  const result = await ipcRenderer.invoke('claude:apply-settings', { tabId, model, effort, source });
  if (result?.success !== true) {
    throw Object.assign(new Error(result?.error || 'Claude settings were not confirmed'), {
      appliedSettings: result?.appliedSettings || {},
    });
  }
  return result;
}

export async function getClaudePtyPresence(
  tabId: string,
  _projectId?: string | null,
  requestContext?: {
    consumer: 'history-panel';
    ownerKey: string;
    generation: number;
  },
): Promise<ClaudePtyPresence> {
  const presence = await ipcRenderer.invoke('claude:get-presence', tabId, requestContext);
  return {
    status: presence?.status || 'inactive',
    hasBridge: !!presence?.hasBridge,
    isBusy: !!presence?.isBusy,
    hasTerm: !!presence?.hasTerm,
    inputReady: !!presence?.inputReady,
    awaiting: !!presence?.awaiting,
    sessionId: presence?.sessionId || null,
    sendTarget: presence?.sendTarget || undefined,
    conversationMaterialized: presence?.conversationMaterialized === true,
    canResume: presence?.canResume === true,
    canCopySessionId: presence?.canCopySessionId === true,
    timelineCount: typeof presence?.timelineCount === 'number' ? presence.timelineCount : null,
    materializationReason: presence?.materializationReason || null,
  };
}

async function readClaudeSessionMaterialization(sessionId: string, cwd?: string) {
  try {
    const result = await ipcRenderer.invoke('claude:session-materialization', { sessionId, cwd });
    const materialized = result?.materialized === true || result?.conversationMaterialized === true;
    return {
      ...(result || {}),
      materialized,
      conversationMaterialized: materialized,
      timelineCount: typeof result?.timelineCount === 'number' ? result.timelineCount : null,
      materializationReason: result?.reason || null,
    };
  } catch (e: any) {
    return {
      materialized: false,
      conversationMaterialized: false,
      timelineCount: null,
      materializationReason: 'materialization-check-failed',
      error: errorText(e),
    };
  }
}

export async function resumeClaudePtySession({
  tabId,
  sessionId,
  cwd,
  repair = true,
}: {
  tabId: string;
  sessionId: string;
  cwd?: string;
  repair?: boolean;
}): Promise<ClaudePtyResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!sessionId) return { success: false, error: 'sessionId required' };

  const existing = resumeInflight.get(tabId);
  if (existing) {
    console.log('[ClaudePtyActions:resume] join-inflight tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId));
    return existing;
  }

  const work = resumeClaudePtySessionInner({ tabId, sessionId, cwd, repair })
    .finally(() => {
      if (resumeInflight.get(tabId) === work) resumeInflight.delete(tabId);
    });
  resumeInflight.set(tabId, work);
  return work;
}

async function resumeClaudePtySessionInner({
  tabId,
  sessionId,
  cwd,
  repair = true,
}: {
  tabId: string;
  sessionId: string;
  cwd?: string;
  repair?: boolean;
}): Promise<ClaudePtyResumeResult> {
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'claude');
  console.log('[ClaudePtyActions:resume] start tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId) + ' repair=' + repair);

  let presence: ClaudePtyPresence | null = null;
  try {
    presence = await getClaudePtyPresence(tabId);
    console.log('[ClaudePtyActions:resume] presence tab=' + shortTab(tabId) + ' status=' + presence.status + ' hasTerm=' + !!presence.hasTerm + ' hasBridge=' + !!presence.hasBridge + ' inputReady=' + !!presence.inputReady);
  } catch (e: any) {
    console.warn('[ClaudePtyActions:resume] presence failed tab=' + shortTab(tabId) + ': ' + errorText(e));
  }

  if (presence?.status === 'stopping') {
    console.log('[ClaudePtyActions:resume] blocked tab=' + shortTab(tabId) + ' status=stopping');
    return { success: false, sessionId, status: 'stopping', error: 'Claude is stopping' };
  }
  if (presence?.status === 'active' || presence?.status === 'busy' || presence?.status === 'starting') {
    store.clearInterruptedState(tabId);
    console.log('[ClaudePtyActions:resume] already-running tab=' + shortTab(tabId) + ' status=' + presence.status);
    return { success: true, alreadyRunning: true, status: presence.status };
  }

  if (presence && presence.hasTerm === false) {
    console.warn('[ClaudePtyActions:resume] no-terminal tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId));
    return { success: false, sessionId, status: presence.status, error: 'terminal not ready' };
  }

  const materialization = await readClaudeSessionMaterialization(sessionId, cwd);
  if (materialization.conversationMaterialized !== true) {
    console.warn('[ClaudePtyActions:resume] blocked-empty-session tab=' + shortTab(tabId)
      + ' sid=' + shortSid(sessionId)
      + ' reason=' + (materialization.materializationReason || materialization.reason || '-')
      + ' timelineCount=' + (materialization.timelineCount ?? 'null'));
    return {
      success: false,
      sessionId,
      conversationMaterialized: false,
      canResume: false,
      timelineCount: materialization.timelineCount ?? null,
      materializationReason: materialization.materializationReason || materialization.reason || null,
      error: 'session_not_materialized',
    };
  }

  // Main owns repair + final launch admission as one transaction.  This flag
  // is still armed before the IPC so a stale statusline update cannot replace
  // the requested session between the accepted PTY write and its first fresh
  // bridge record.
  markPendingResume(tabId, sessionId);
  console.log('[ClaudePtyActions:resume] pending-marked-and-write tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId));
  const runResult = await ipcRenderer.invoke('claude:run-command', {
    tabId,
    command: 'claude-c',
    sessionId,
    ...(cwd ? { cdTo: cwd } : {}),
    ...(repair ? {} : { skipResumeRepair: true }),
  }).catch((e: any) => ({ success: false, error: errorText(e) }));
  if (runResult?.success === false) {
    clearPendingResume(tabId);
    return { success: false, sessionId, repaired: Number(runResult?.repaired || 0), error: runResult.error || runResult.reason || 'Claude resume failed' };
  }
  store.clearInterruptedState(tabId);
  return { success: true, sessionId, repaired: Number(runResult?.repaired || 0) };
}

export async function sendClaudePtyPrompt(tabId: string, prompt: string, options: ClaudePtySendOptions = {}): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!prompt.trim()) return { success: false, error: 'prompt required' };

  const existing = sendInflight.get(tabId);
  if (existing) {
    console.log('[ClaudePtyActions:send] join-inflight tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-'));
    return existing;
  }

  useWorkspaceStore.getState().clearInterruptedState(tabId);
  console.log('[ClaudePtyActions:send] start tab=' + shortTab(tabId) +
    ' handoff=' + (options.handoffId || '-') +
    ' source=' + (options.source || '-') +
    ' statusAtSend=' + (options.statusAtSend || '-') +
    ' chars=' + prompt.length);
  const work = (async () => {
    const assertNotCancelled = options.assertNotCancelled || (() => {});
    const localCommand = isStandaloneAgentLocalCommand({
      prompt,
      imageCount: options.presentationSnapshot?.imagePaths?.length || 0,
      chipCount: options.presentationSnapshot?.promptChips?.length || 0,
    }) ? normalizeAgentLocalCommand(prompt) : null;
    if (localCommand) {
      assertNotCancelled();
      const result = await ipcRenderer.invoke('claude:send-command', tabId, localCommand, {
        source: options.source || 'claude-pty-local-command',
        promptQueueAction: options.promptQueueAction,
        handoffId: options.handoffId || null,
        expectedTarget: options.expectedTarget,
        stashFirst: false,
        awaitUserMessageAudit: false,
      });
      return {
        ...(result || {}),
        localSlashCommand: true,
      };
    }
    const pasteRequest = {
      tabId,
      content: prompt,
      submit: true,
      fast: false,
      // Exact UserPromptSubmit proof remains attached to this same send.
      awaitClaudeUserMessageAudit: true,
      handoffId: options.handoffId || null,
      sendAttemptId: options.sendAttemptId || null,
      sendOperationKey: options.sendOperationKey || null,
      expectedTarget: options.expectedTarget,
      source: options.source || 'claude-pty-action',
      promptQueueAction: options.promptQueueAction,
      verifyClaudeVisibleDraftBeforePaste: true,
      presentationSnapshot: options.presentationSnapshot || null,
    };
    assertNotCancelled();
    const hasExplicitSettings = [options.model, options.effort, options.thinking]
      .some(value => typeof value === 'string' && value.trim() && value !== 'none');
    if (hasExplicitSettings) {
      // Settings and the prompt are one main-owned write operation. A second
      // ControlBar/API intent may queue, but cannot slip between proof and paste.
      return ipcRenderer.invoke('claude:send-prompt-with-settings', {
        ...pasteRequest,
        model: options.model,
        effort: options.effort,
        thinking: options.thinking,
        claudeExactEmptyEvidence: options.claudeExactEmptyEvidence,
      });
    }
    return ipcRenderer.invoke('terminal:paste', {
      ...pasteRequest,
      claudeExactEmptyEvidence: options.claudeExactEmptyEvidence,
    });
  })()
    .then((result: any) => {
      console.log('[ClaudePtyActions:send] done tab=' + shortTab(tabId) +
        ' handoff=' + (options.handoffId || '-') +
        ' success=' + (result?.success !== false) +
        ' submitted=' + !!result?.submitted +
        ' chunks=' + (result?.chunksTotal ?? 'na'));
      return result;
    })
    .catch((e: any) => {
      console.warn('[ClaudePtyActions:send] error tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (sendInflight.get(tabId) === work) sendInflight.delete(tabId);
    });
  sendInflight.set(tabId, work);
  return work;
}

export async function interruptClaudePtyTurn(tabId: string): Promise<{
  success: boolean;
  interrupted?: boolean;
  interruptRequested?: boolean;
  interruptConfirmed?: boolean;
  status?: string;
  skipped?: string;
  error?: string;
}> {
  if (!tabId) return { success: false, error: 'tabId required' };
  try {
    // Main captures the current terminal/turn and rechecks both at the head
    // of the shared PTY queue. A renderer timer cannot own that identity.
    const result = await ipcRenderer.invoke('claude:interrupt-turn', tabId);
    console.log('[ClaudePtyActions:interrupt] result tab=' + shortTab(tabId)
      + ' requested=' + (result?.interruptRequested === true)
      + ' confirmed=' + (result?.interruptConfirmed === true)
      + ' skipped=' + (result?.skipped || '-'));
    return result;
  } catch (error: any) {
    console.warn('[ClaudePtyActions:interrupt] failed tab=' + shortTab(tabId) + ': ' + errorText(error));
    return { success: false, interrupted: false, status: 'unknown', error: errorText(error) };
  }
}

export async function stopClaudePtyProcess(tabId: string, options: {
  reason?: string | null;
  authority?: Record<string, unknown> | null;
  captureCodexRestartSettings?: boolean;
} = {}): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const existing = stopInflight.get(tabId);
  if (existing) {
    console.log('[ClaudePtyActions:stop-process] join-inflight tab=' + shortTab(tabId));
    return existing;
  }
  console.log('[ClaudePtyActions:stop-process] start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('terminal:stop-ai-process', {
    tabId,
    toolType: 'claude',
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.authority ? { authority: options.authority } : {}),
  })
    .then((result: any) => {
      console.log('[ClaudePtyActions:stop-process] done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' error=' + (result?.error || '-'));
      return result;
    })
    .catch((e: any) => {
      console.warn('[ClaudePtyActions:stop-process] error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (stopInflight.get(tabId) === work) stopInflight.delete(tabId);
    });
  stopInflight.set(tabId, work);
  return work;
}

export async function getClaudePendingQuestion(tabId: string): Promise<ClaudePendingQuestion | null> {
  if (!tabId) return null;
  try {
    const result = await ipcRenderer.invoke('claude:get-pending-question', { tabId });
    if (result?.success === false) {
      console.warn('[ClaudePtyActions:question] pending failed tab=' + shortTab(tabId) + ': ' + (result?.error || 'unknown'));
      return null;
    }
    const pending = result?.pendingQuestion || null;
    console.log('[ClaudePtyActions:question] pending tab=' + shortTab(tabId) + ' source=' + (pending?.source || 'none') + ' qs=' + (pending?.questions?.length || 0));
    return pending;
  } catch (e: any) {
    console.warn('[ClaudePtyActions:question] pending error tab=' + shortTab(tabId) + ': ' + errorText(e));
    return null;
  }
}

export async function answerClaudeQuestion({
  tabId,
  pendingQuestion,
  answers = {},
  stop = false,
}: {
  tabId: string;
  pendingQuestion: ClaudePendingQuestion;
  answers?: Record<string, string>;
  stop?: boolean;
}): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!pendingQuestion) return { success: false, error: 'pending question required' };

  const existing = questionInflight.get(tabId);
  if (existing) {
    console.log('[ClaudePtyActions:question] join-inflight tab=' + shortTab(tabId) + ' stop=' + stop);
    return existing;
  }

  console.log('[ClaudePtyActions:question] answer start tab=' + shortTab(tabId) + ' source=' + pendingQuestion.source + ' stop=' + stop + ' answers=' + Object.keys(answers || {}).length);
  const work = ipcRenderer.invoke('claude:answer-question', {
      tabId,
      source: pendingQuestion.source,
      toolUseID: pendingQuestion.toolUseID,
      questions: pendingQuestion.questions || [],
      answers,
      stop,
    })
    .then((result: any) => {
      console.log('[ClaudePtyActions:question] answer done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' error=' + (result?.error || result?.reason || '-'));
      return result;
    })
    .catch((e: any) => {
      console.warn('[ClaudePtyActions:question] answer error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (questionInflight.get(tabId) === work) questionInflight.delete(tabId);
    });
  questionInflight.set(tabId, work);
  return work;
}

async function captureClaudePtyDraft(
  tabId: string,
  mode: 'grab' | 'copy',
  options: ClaudePtyDraftGrabOptions = {},
): Promise<ClaudePtyDraftGrabResult> {
  if (!tabId) return { success: false, error: 'tabId required' };

  // Only retransmission of the SAME logical request may share a result.
  // Independent History/MCP consumers must never own the same withdrawn text.
  const captureRequestId = options.captureRequestId || crypto.randomUUID();
  const captureKey = tabId + ':' + mode + ':' + captureRequestId;
  const existing = draftGrabInflight.get(captureKey);
  if (existing) {
    console.log('[ClaudePtyActions:draft] ' + mode + ' join-inflight tab=' + shortTab(tabId));
    return existing;
  }

  console.log('[ClaudePtyActions:draft] ' + mode + ' start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('claude:' + mode + '-input', tabId, { ...options, captureRequestId })
    .then((result: ClaudePtyDraftGrabResult) => {
      console.log('[ClaudePtyActions:draft] ' + mode + ' done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' chars=' + (result?.text?.length || 0) + ' images=' + (result?.images || 0) + ' error=' + (result?.error || '-'));
      return result || { success: false, error: 'empty_result' };
    })
    .catch((e: any) => {
      console.warn('[ClaudePtyActions:draft] ' + mode + ' error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (draftGrabInflight.get(captureKey) === work) draftGrabInflight.delete(captureKey);
    });
  draftGrabInflight.set(captureKey, work);
  return work;
}

export async function grabClaudePtyDraft(
  tabId: string,
  options: ClaudePtyDraftGrabOptions = {},
): Promise<ClaudePtyDraftGrabResult> {
  return captureClaudePtyDraft(tabId, 'grab', options);
}

export async function copyClaudePtyDraft(
  tabId: string,
  options: ClaudePtyDraftGrabOptions = {},
): Promise<ClaudePtyDraftGrabResult> {
  return captureClaudePtyDraft(tabId, 'copy', options);
}
