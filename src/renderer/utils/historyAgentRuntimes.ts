import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { buildCodexRunPayload } from './codexLaunch';
import {
  codexSettingsProofMatchesActiveWriter,
  isCompleteCodexSettingsRequest,
  planCodexHistorySettings,
  resolveCodexSettingsRuntimeProof,
} from './codexHistorySettingsPlan.mjs';
import { readCodexPtyPresence } from './codexPtyPresence.mjs';
import { readCodexDraftAuthority } from './codexDraftAuthority.mjs';
import {
  planCodexPickerStateApplication,
  resolveCodexEffectiveSettings,
} from './codexEffectiveSettings.mjs';
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
  probeDraft?: (tabId: string, reason: string) => Promise<{ hasDraft: boolean | null; preview: string; source: string; [key: string]: any }>;
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

const applyCodexPickerResultForTab = ({
  tabId,
  tabState,
  result,
  requestedModel,
  requestedEffort,
  liveSessionId,
}: {
  tabId: string;
  tabState: RuntimeTabState | null;
  result: any;
  requestedModel?: string;
  requestedEffort?: string;
  liveSessionId?: string | null;
}) => {
  const plan = planCodexPickerStateApplication({
    result,
    requestedModel,
    requestedEffort,
    liveSessionId,
    currentPersistentModel: tabState?.codexModel,
    currentPersistentEffort: tabState?.codexEffort,
  });
  if (!plan.allowed) return plan;
  const state = useWorkspaceStore.getState();
  if (Object.keys(plan.persistentPatch || {}).length > 0) {
    state.updateCodexState(tabId, plan.persistentPatch);
  }
  state.updateCodexLiveState(tabId, plan.livePatch);
  return plan;
};

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
  console.log('[ClaudePtyActions:startFresh] start tab=' + shortTab(tabId));
  const runResult = await ipcRenderer.invoke('claude:run-command', { tabId, command: 'claude' })
    .catch((err: any) => ({ success: false, error: String(err?.message || err) }));
  if (runResult?.success === false) {
    return { success: false, error: runResult.error || runResult.reason || 'Claude start failed' };
  }
  store.clearInterruptedState?.(tabId);
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
  console.log('[CodexHistoryActions:resume] start tab=' + shortTab(tabId) + ' sid=' + sessionId.slice(0, 8));
  const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
    tabId,
    command: 'codex-c',
    sessionId,
    cwd,
  })).catch((err: any) => ({ success: false, error: String(err?.message || err) }));
  if (runResult?.success === false || runResult?.accepted === false) {
    return { success: false, error: runResult.error || 'Codex resume failed' };
  }
  store.clearInterruptedState?.(tabId);
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
  console.log('[CodexHistoryActions:startFresh] start tab=' + shortTab(tabId));
  const runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
    tabId,
    command: 'codex',
    cwd,
  })).catch((err: any) => ({ success: false, error: String(err?.message || err) }));
  if (runResult?.success === false || runResult?.accepted === false) {
    return { success: false, error: runResult.error || 'Codex start failed' };
  }
  store.clearInterruptedState?.(tabId);
  return { success: true, status: 'starting' };
}

async function sendCodexPrompt(tabId: string, prompt: string, options: AgentSendPromptOptions = {}): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  if (!prompt.trim()) return { success: false, error: 'prompt required' };
  const tabContext = findTabRuntimeContext(tabId);
  const tabState = tabContext?.tab || null;
  const hasSettingsRequest = [options.model, options.effort].some((value) => (
    typeof value === 'string'
    && value.trim().length > 0
    && value.trim() !== 'none'
  ));
  const settingsRuntimeSnapshot = hasSettingsRequest
    && options.statusAtSend !== 'busy'
    && options.queue !== true
    ? await ipcRenderer.invoke('codex:get-runtime-session', {
      tabId,
      projectId: tabContext?.projectId || null,
    }).catch((error: any) => {
      console.warn('[CodexHistoryActions:send] settings owner lookup failed tab='
        + shortTab(tabId)
        + ' error=' + errorText(error));
      return null;
    })
    : null;
  const { activeWriterSessionId } = resolveCodexSettingsRuntimeProof(settingsRuntimeSnapshot);
  const effectiveSettings = resolveCodexEffectiveSettings({
    codexSessionId: tabState?.codexSessionId,
    codexModel: tabState?.codexModel,
    codexEffort: tabState?.codexEffort,
    codexLiveModel: tabState?.codexLiveModel,
    codexLiveEffort: tabState?.codexLiveEffort,
    codexLiveSettingsSessionId: tabState?.codexLiveSettingsSessionId,
  });
  const settingsPlan = planCodexHistorySettings({
    requestedModel: options.model,
    requestedEffort: options.effort,
    currentModel: effectiveSettings.model,
    currentEffort: effectiveSettings.effort,
    currentProofSessionId: effectiveSettings.liveOwned
      ? tabState?.codexLiveSettingsSessionId
      : tabState?.codexSettingsProofSessionId,
    runtimeSnapshot: settingsRuntimeSnapshot,
    statusAtSend: options.statusAtSend,
    queue: options.queue,
  });
  if (settingsPlan.blocked) {
    console.warn('[CodexHistoryActions:send] settings refused tab='
      + shortTab(tabId)
      + ' statusAtSend=' + (options.statusAtSend || '-')
      + ' queue=' + (options.queue === true)
      + ' code=' + settingsPlan.code);
    return {
      success: false,
      ok: false,
      code: settingsPlan.code,
      error: settingsPlan.error,
      promptSent: false,
    };
  }
  const existing = codexSendInflight.get(tabId);
  if (existing) {
    if (settingsPlan.hasRequestedSettings) {
      console.warn('[CodexHistoryActions:send] settings refused behind inflight send tab='
        + shortTab(tabId)
        + ' handoff=' + (options.handoffId || '-'));
      return {
        success: false,
        ok: false,
        code: 'codex_settings_change_send_inflight',
        error: 'Another Codex send is already in progress; settings and prompt were not sent',
        promptSent: false,
      };
    }
    console.log('[CodexHistoryActions:send] join-inflight tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-'));
    return existing;
  }
  useWorkspaceStore.getState().clearInterruptedState?.(tabId);
  const queue = options.queue === true || options.statusAtSend === 'busy';
  const modelForPicker = settingsPlan.model;
  const effortForPicker = settingsPlan.effort;
  const visualDraftStateForSend = terminalRegistry.getCodexDraftState(tabId);
  const draftStateForSend = await readCodexDraftAuthority({
    invoke: ipcRenderer.invoke.bind(ipcRenderer),
    tabId,
    reason: 'history-send-preflight',
    timeoutMs: 700,
    visualState: visualDraftStateForSend,
  });
  console.log('[CodexHistoryActions:send] start tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' source=' + (options.source || '-') + ' statusAtSend=' + (options.statusAtSend || '-') + ' queue=' + queue + ' model=' + (modelForPicker || '-') + ' effort=' + (effortForPicker || '-') + ' submitIntent=' + (queue ? 'enter-busy' : 'enter') + ' chars=' + prompt.length + ' draftSource=' + (draftStateForSend?.source || '-') + ' skipVisibleDraftGuard=false');
  if (settingsPlan.hasRequestedSettings) {
    const currentModel = effectiveSettings.model || '';
    const currentEffort = effectiveSettings.effort || '';
    // Equal strings are not enough after a writer handoff: without matching
    // ownership proof they may describe the resume source, not this process's
    // active conversation. A complete API pair must still reach the picker.
    const currentPairProvenForWriter = codexSettingsProofMatchesActiveWriter({
      currentProofSessionId: effectiveSettings.liveOwned
        ? tabState?.codexLiveSettingsSessionId
        : tabState?.codexSettingsProofSessionId,
      runtimeSnapshot: settingsRuntimeSnapshot,
    });
    const needsPicker = modelForPicker !== currentModel
      || effortForPicker !== currentEffort
      || !currentPairProvenForWriter;
    if (needsPicker) {
      const pickerHasDraft =
        draftStateForSend?.hasDraft === true || draftStateForSend?.hasDraft === false
        ? draftStateForSend.hasDraft
        : null;
      if (pickerHasDraft === null) {
        console.warn('[CodexHistoryActions:send] picker refused unknown draft state tab='
          + shortTab(tabId)
          + ' source=' + (draftStateForSend?.source || '-'));
        return { success: false, error: 'codex_draft_state_unknown' };
      }
      const pickerResult = await ipcRenderer.invoke('codex:select-model-effort', {
        tabId,
        model: modelForPicker,
        effort: effortForPicker,
        expectedWriterSessionId: isCompleteCodexSettingsRequest({
          requestedModel: options.model,
          requestedEffort: options.effort,
        })
          ? undefined
          : activeWriterSessionId,
        allowTurnBusy: false,
        hasDraft: pickerHasDraft,
        draftSource: draftStateForSend.source || 'history-send-preflight',
        draftPreview: draftStateForSend.preview || '',
        visualHasDraft: pickerHasDraft,
        visualSource: draftStateForSend.source || 'history-send-preflight',
        visualPreview: draftStateForSend.preview || '',
      });
      const appliedWithProof = pickerResult?.applied === true
        && !!(pickerResult?.applicationProofSource || pickerResult?.configProofSource);
      if (pickerResult?.success === false) {
        if (appliedWithProof) {
          const appliedPlan = applyCodexPickerResultForTab({
            tabId,
            tabState,
            result: pickerResult,
            requestedModel: modelForPicker,
            requestedEffort: effortForPicker,
            liveSessionId: pickerResult?.codexSettingsProofSessionId
              || activeWriterSessionId
              || tabState?.codexSessionId,
          });
          if (!appliedPlan.allowed) {
            return {
              success: false,
              error: appliedPlan.code || 'codex picker proof could not be owned',
            };
          }
          console.warn('[CodexHistoryActions:send] picker applied but draft restore failed tab='
            + shortTab(tabId)
            + ' model=' + appliedPlan.model
            + ' effort=' + (appliedPlan.effort || '-')
            + ' proof=' + (pickerResult?.applicationProofSource || pickerResult?.configProofSource)
            + ' error=' + (pickerResult?.error || 'unknown'));
          return {
            ...pickerResult,
            success: false,
            applied: true,
            model: appliedPlan.model,
            effort: appliedPlan.effort,
            error: pickerResult?.error
              || 'Codex settings changed, but the input text could not be restored',
          };
        }
        console.warn('[CodexHistoryActions:send] picker failed tab=' + shortTab(tabId) + ' error=' + (pickerResult?.error || 'unknown'));
        return { success: false, error: pickerResult?.error || 'model effort switch failed' };
      }
      const appliedPlan = applyCodexPickerResultForTab({
        tabId,
        tabState,
        result: pickerResult,
        requestedModel: modelForPicker,
        requestedEffort: effortForPicker,
        liveSessionId: pickerResult?.codexSettingsProofSessionId
          || activeWriterSessionId
          || tabState?.codexSessionId,
      });
      if (!appliedPlan.allowed) {
        return {
          success: false,
          error: appliedPlan.code || 'codex picker proof could not be owned',
        };
      }
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

async function probeCodexDraft(tabId: string, reason: string) {
  const visualState = terminalRegistry.getCodexDraftState(tabId);
  const resolved = await readCodexDraftAuthority({
    invoke: ipcRenderer.invoke.bind(ipcRenderer),
    tabId,
    reason,
    timeoutMs: 700,
    visualState,
  });
  console.warn('[CodexHistoryActions:draft] authoritative-probe tab=' + shortTab(tabId)
    + ' reason=' + reason
    + ' hasDraft=' + resolved.hasDraft
    + ' authority=' + resolved.authority
    + ' source=' + resolved.source
    + ' visual=' + resolved.visualHasDraft + ':' + resolved.visualSource
    + ' preview=' + JSON.stringify(resolved.preview));
  return resolved;
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
  probeDraft: probeCodexDraft,
  inspectDraft: inspectCodexDraft,
};

export const getHistoryAgentRuntime = (toolType: AgentHistoryTool): HistoryAgentRuntime =>
  toolType === 'codex' ? CODEX_RUNTIME : CLAUDE_RUNTIME;
