import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { buildCodexRunPayload } from './codexLaunch';
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
export type AgentPtyStatus = 'active' | 'busy' | 'inactive' | 'starting';
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
}

export interface AgentResumeResult {
  success: boolean;
  sessionId?: string;
  alreadyRunning?: boolean;
  status?: AgentPtyStatus;
  repaired?: number;
  error?: string;
}

export interface AgentSendPromptOptions {
  handoffId?: string;
  source?: string;
  statusAtSend?: AgentPtyStatus;
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
  getPresence: (tabId: string) => Promise<AgentPtyPresence>;
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

const findTabState = (tabId: string): { aiBusy?: boolean; commandType?: string; codexSessionId?: string } | null => {
  const store = useWorkspaceStore.getState();
  for (const [, workspace] of store.openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) return tab;
  }
  return null;
};

async function getCodexPtyPresence(tabId: string): Promise<AgentPtyPresence> {
  const tab = findTabState(tabId);
  const [state, turnState] = await Promise.all([
    ipcRenderer.invoke('terminal:getCommandState', {
      tabId,
      caller: 'HistoryPanel.codexPresence',
      expectedProcess: 'codex',
      allowProcessTreeLookup: true,
    }).catch(() => null),
    ipcRenderer.invoke('codex:get-turn-state', tabId).catch(() => null),
  ]);
  const isRunning = !!state?.isRunning;
  const isBusy = turnState?.hasWatcher ? !!turnState.busy : !!tab?.aiBusy;
  if (tab && tab.aiBusy !== isBusy) {
    useWorkspaceStore.getState().setAiBusy(tabId, isBusy);
  }
  return {
    status: isRunning ? (isBusy ? 'busy' : 'active') : 'inactive',
    hasBridge: !!tab?.codexSessionId,
    isBusy,
    hasTerm: state?.error !== 'tab not found',
    inputReady: isRunning,
    awaiting: false,
  };
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
  ipcRenderer.send('codex:run-command', buildCodexRunPayload({
    tabId,
    command: 'codex-c',
    sessionId,
    cwd,
  }));
  ipcRenderer.send('terminal:force-command-started', tabId);
  return { success: true, sessionId };
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
  const queue = false;
  console.log('[CodexHistoryActions:send] start tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' source=' + (options.source || '-') + ' statusAtSend=' + (options.statusAtSend || '-') + ' queue=' + queue + ' submitIntent=enter chars=' + prompt.length);
  const work = ipcRenderer.invoke('codex:send-command', tabId, prompt, {
    queue,
    handoffId: options.handoffId || null,
    source: options.source || null,
    statusAtSend: options.statusAtSend || null,
  })
    .then((result: any) => {
      console.log('[CodexHistoryActions:send] done tab=' + shortTab(tabId) + ' handoff=' + (options.handoffId || '-') + ' success=' + (result?.success !== false) + ' queued=' + (result?.queued ? 'true' : 'false') + ' submitKey=' + (result?.submitKey || '-'));
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
  const work = ipcRenderer.invoke('terminal:stop-ai-process', tabId)
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
  readyEvent: 'codex:session-detected',
  supportsQuestions: false,
  supportsInterruptRecovery: true,
  interruptRecoveryReasons: ['turn_aborted'],
  allowSendWhileBusy: true,
  optimisticBusyOnSend: false,
  optimisticActiveOnInterrupt: false,
  getPresence: getCodexPtyPresence,
  resume: resumeCodexSession,
  sendPrompt: sendCodexPrompt,
  interruptTurn: interruptCodexTurn,
  stopProcess: stopCodexProcess,
  grabDraft: grabCodexDraft,
  inspectDraft: inspectCodexDraft,
};

export const getHistoryAgentRuntime = (toolType: AgentHistoryTool): HistoryAgentRuntime =>
  toolType === 'codex' ? CODEX_RUNTIME : CLAUDE_RUNTIME;
