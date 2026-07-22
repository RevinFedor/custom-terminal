import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { buildCodexRunPayload } from './codexLaunch';
import { readCodexPtyPresence } from './codexPtyPresence.mjs';
import { terminalRegistry } from './terminalRegistry';
import {
  answerClaudeQuestion,
  grabClaudePtyDraft,
  getClaudePendingQuestion,
  getClaudePtyPresence,
  interruptClaudePtyTurn,
  resumeClaudePtySession,
  sendClaudePtyPrompt,
  stopClaudePtyProcess,
  type ClaudePtyDraftGrabResult,
  type ClaudePendingQuestion,
  type ClaudeQuestion,
} from './claudePtyActions';

const { ipcRenderer } = window.require('electron');

export type AgentHistoryTool = 'claude' | 'codex';
export type AgentPtyStatus = 'active' | 'busy' | 'inactive' | 'starting' | 'stopping' | 'unknown';
export type AgentDraftGrabResult = ClaudePtyDraftGrabResult;
export type AgentPendingQuestion = ClaudePendingQuestion;
export type AgentQuestion = ClaudeQuestion;

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
  sessionId?: string | null;
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

export interface AgentResumeResult {
  success: boolean;
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

export interface AgentSendPromptOptions {
  handoffId?: string;
  source?: string;
  statusAtSend?: AgentPtyStatus;
  queue?: boolean;
  model?: string;
  effort?: string;
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
  getPresence: (tabId: string, projectId?: string | null) => Promise<AgentPtyPresence>;
  startFresh?: (args: { tabId: string; cwd?: string }) => Promise<AgentResumeResult>;
  resume: (args: { tabId: string; sessionId: string; cwd?: string }) => Promise<AgentResumeResult>;
  sendPrompt: (tabId: string, prompt: string, options?: AgentSendPromptOptions) => Promise<any>;
  interruptTurn: (tabId: string) => { success: boolean; interrupted?: boolean; error?: string };
  stopProcess: (tabId: string) => Promise<any>;
  grabDraft: (tabId: string) => Promise<AgentDraftGrabResult>;
  inspectDraft?: (tabId: string) => { hasDraft: boolean | null; preview: string; source: string };
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
const codexLastInterruptAt = new Map<string, number>();
const INTERRUPT_DEDUP_MS = 700;

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

const findTabState = (tabId: string): RuntimeTabState | null => (
  findTabRuntimeContext(tabId)?.tab || null
);

async function startFreshClaudePtySession({
  tabId,
}: {
  tabId: string;
  cwd?: string;
}): Promise<AgentResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'claude');
  store.markAiLaunchAutoTitle(tabId, 'claude');
  store.clearInterruptedState?.(tabId);
  console.log('[ClaudePtyActions:startFresh] start tab=' + shortTab(tabId));
  ipcRenderer.send('claude:run-command', { tabId, command: 'claude' });
  return { success: true, status: 'starting' };
}

async function getCodexPtyPresence(
  tabId: string,
  projectIdHint?: string | null,
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

async function resumeCodexSession({
  tabId,
  sessionId,
  cwd,
}: {
  tabId: string;
  sessionId: string;
  cwd?: string;
}): Promise<AgentResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!sessionId) return { success: false, error: 'sessionId required' };
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'codex');
  store.clearInterruptedState?.(tabId);
  console.log('[CodexHistoryActions:resume] start tab=' + shortTab(tabId) + ' sid=' + sessionId.slice(0, 8));
  const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
    tabId,
    command: 'codex-c',
    sessionId,
    cwd,
  })).catch((err: any) => ({ success: false, error: String(err?.message || err) }));
  if (runResult?.success === false) {
    return { success: false, error: runResult.error || 'Codex resume failed' };
  }
  return { success: true, sessionId };
}

async function startFreshCodexSession({
  tabId,
  cwd,
}: {
  tabId: string;
  cwd?: string;
}): Promise<AgentResumeResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const store = useWorkspaceStore.getState();
  store.setTabCommandType(tabId, 'codex');
  store.markAiLaunchAutoTitle(tabId, 'codex');
  store.clearInterruptedState?.(tabId);
  console.log('[CodexHistoryActions:startFresh] start tab=' + shortTab(tabId));
  const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
    tabId,
    command: 'codex',
    cwd,
  })).catch((err: any) => ({ success: false, error: String(err?.message || err) }));
  if (runResult?.success === false) {
    return { success: false, error: runResult.error || 'Codex start failed' };
  }
  return { success: true, status: 'starting' };
}

async function sendCodexPrompt(tabId: string, prompt: string, options: AgentSendPromptOptions = {}): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!prompt.trim()) return { success: false, error: 'prompt required' };
  const existing = codexSendInflight.get(tabId);
  if (existing) {
    console.log('[CodexHistoryActions:send] join-inflight tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-'));
    return existing;
  }
  useWorkspaceStore.getState().clearInterruptedState?.(tabId);
  const queue = options.queue === true || options.statusAtSend === 'busy';
  const requestedModel = typeof options.model === 'string' ? options.model.trim() : '';
  const requestedEffort = typeof options.effort === 'string' ? options.effort.trim() : '';
  const tabState = findTabState(tabId);
  const modelForPicker = requestedModel && requestedModel !== 'none' ? requestedModel : (tabState?.codexModel || '');
  const effortForPicker = requestedEffort && requestedEffort !== 'none' ? requestedEffort : '';
  const draftStateForSend = await ipcRenderer.invoke('codex:get-draft-state', tabId, {
    reason: 'history-send-preflight',
    timeoutMs: 700,
  }).catch((error: any) => {
    console.warn('[CodexHistoryActions:send] main draft probe failed tab=' + shortTab(tabId) + ': ' + errorText(error));
    return terminalRegistry.getCodexDraftState(tabId);
  });
  console.log('[CodexHistoryActions:send] start tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' source=' + (options.source || '-') + ' statusAtSend=' + (options.statusAtSend || '-') + ' queue=' + queue + ' model=' + (modelForPicker || '-') + ' effort=' + (effortForPicker || '-') + ' submitIntent=' + (queue ? 'enter-busy' : 'enter') + ' chars=' + prompt.length + ' draftSource=' + (draftStateForSend?.source || '-') + ' skipVisibleDraftGuard=false');
  if (options.statusAtSend !== 'busy' && modelForPicker) {
    const currentModel = tabState?.codexModel || '';
    const currentEffort = tabState?.codexEffort || '';
    const needsPicker = modelForPicker !== currentModel || (!!effortForPicker && effortForPicker !== currentEffort);
    if (needsPicker) {
      const pickerResult = await ipcRenderer.invoke('codex:select-model-effort', {
        tabId,
        model: modelForPicker,
        effort: effortForPicker || undefined,
        hasDraft: false,
        draftSource: 'external-send',
        draftPreview: '',
        visualHasDraft: false,
        visualSource: 'external-send',
        visualPreview: '',
      });
      if (pickerResult?.success === false) {
        console.warn('[CodexHistoryActions:send] picker failed tab=' + shortTab(tabId) + ' error=' + (pickerResult?.error || 'unknown'));
        return { success: false, error: pickerResult?.error || 'model effort switch failed' };
      }
      useWorkspaceStore.getState().updateCodexState(tabId, {
        codexModel: pickerResult?.model || modelForPicker,
        ...(effortForPicker ? { codexEffort: pickerResult?.effort || effortForPicker } : {}),
      });
    }
  }
  const work = ipcRenderer.invoke('codex:send-command', tabId, prompt, {
    queue,
    handoffId: options.handoffId || null,
    source: options.source || null,
    statusAtSend: options.statusAtSend || null,
    skipVisibleDraftGuard: false,
  })
    .then((result: any) => {
      const auditTimeoutAfterSubmit = isSubmittedCodexAuditTimeout(result);
      console.log('[CodexHistoryActions:send] done tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' success=' + (auditTimeoutAfterSubmit || result?.success !== false) + ' queued=' + (result?.queued ? 'true' : 'false') + ' submitKey=' + (result?.submitKey || '-') + ' auditSoft=' + auditTimeoutAfterSubmit);
      if (auditTimeoutAfterSubmit) {
        console.warn('[CodexHistoryActions:send] audit timeout after submitted Enter tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' - keeping local prompt as sent/queued; watcher logs remain authoritative for diagnosis');
        return { ...result, success: true, auditWarning: result.error, userMessageAuditPending: true };
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

function interruptCodexTurn(tabId: string): { success: boolean; interrupted?: boolean; error?: string } {
  if (!tabId) return { success: false, error: 'tabId required' };
  const now = Date.now();
  const prev = codexLastInterruptAt.get(tabId) || 0;
  if (now - prev < INTERRUPT_DEDUP_MS) {
    console.log('[CodexHistoryActions:interrupt] dedup tab=' + shortTab(tabId) + ' deltaMs=' + (now - prev));
    return { success: true, interrupted: false };
  }
  codexLastInterruptAt.set(tabId, now);
  console.log('[CodexHistoryActions:interrupt] escape tab=' + shortTab(tabId));
  ipcRenderer.send('terminal:input', tabId, '\x1b');
  return { success: true, interrupted: true };
}

async function stopCodexProcess(tabId: string): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const existing = codexStopInflight.get(tabId);
  if (existing) {
    console.log('[CodexHistoryActions:stop-process] join-inflight tab=' + shortTab(tabId));
    return existing;
  }
  console.log('[CodexHistoryActions:stop-process] start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('terminal:stop-ai-process', { tabId, toolType: 'codex' })
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

async function grabCodexDraft(tabId: string): Promise<AgentDraftGrabResult> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const existing = codexDraftInflight.get(tabId);
  if (existing) {
    console.log('[CodexHistoryActions:draft] join-inflight tab=' + shortTab(tabId));
    return existing;
  }
  console.log('[CodexHistoryActions:draft] grab start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('codex:grab-input', tabId)
    .then((result: AgentDraftGrabResult) => {
      console.log('[CodexHistoryActions:draft] grab done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' chars=' + (result?.text?.length || 0) + ' images=' + (result?.images || 0) + ' error=' + (result?.error || '-'));
      return result || { success: false, error: 'empty_result' };
    })
    .catch((e: any) => {
      console.warn('[CodexHistoryActions:draft] grab error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (codexDraftInflight.get(tabId) === work) codexDraftInflight.delete(tabId);
    });
  codexDraftInflight.set(tabId, work);
  return work;
}

function inspectCodexDraft(tabId: string): { hasDraft: boolean | null; preview: string; source: string } {
  const state = terminalRegistry.getCodexDraftState(tabId);
  console.warn('[CodexHistoryActions:draft] visual-probe tab=' + shortTab(tabId) + ' hasDraft=' + state.hasDraft + ' source=' + state.source + ' preview=' + JSON.stringify(state.preview));
  return state;
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
  startFresh: startFreshClaudePtySession,
  resume: resumeClaudePtySession,
  sendPrompt: sendClaudePtyPrompt,
  interruptTurn: interruptClaudePtyTurn,
  stopProcess: stopClaudePtyProcess,
  grabDraft: grabClaudePtyDraft,
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
  supportsQuestions: false,
  supportsInterruptRecovery: true,
  interruptRecoveryReasons: ['turn_aborted'],
  allowSendWhileBusy: true,
  optimisticBusyOnSend: false,
  optimisticActiveOnInterrupt: false,
  getPresence: getCodexPtyPresence,
  startFresh: startFreshCodexSession,
  resume: resumeCodexSession,
  sendPrompt: sendCodexPrompt,
  interruptTurn: interruptCodexTurn,
  stopProcess: stopCodexProcess,
  grabDraft: grabCodexDraft,
  inspectDraft: inspectCodexDraft,
};

export const getHistoryAgentRuntime = (toolType: AgentHistoryTool): HistoryAgentRuntime =>
  toolType === 'codex' ? CODEX_RUNTIME : CLAUDE_RUNTIME;
