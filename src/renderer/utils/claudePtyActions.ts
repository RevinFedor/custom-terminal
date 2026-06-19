import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { markPendingResume } from './pendingResume';

const { ipcRenderer } = window.require('electron');

export type ClaudePtyStatus = 'active' | 'busy' | 'inactive' | 'starting';

export interface ClaudePtyPresence {
  status: ClaudePtyStatus;
  hasBridge?: boolean;
  isBusy?: boolean;
  hasTerm?: boolean;
  inputReady?: boolean;
  awaiting?: boolean;
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
  images?: number;
  imagePaths?: Array<{ id: number; path: string; mediaType: string; size: number }>;
  mode?: string;
  error?: string;
}

export interface ClaudePtySendOptions {
  handoffId?: string;
  source?: string;
  statusAtSend?: string;
}

type ClaudePtyResumeResult = {
  success: boolean;
  sessionId?: string;
  alreadyRunning?: boolean;
  status?: ClaudePtyStatus;
  repaired?: number;
  error?: string;
};

const resumeInflight = new Map<string, Promise<ClaudePtyResumeResult>>();
const sendInflight = new Map<string, Promise<any>>();
const stopInflight = new Map<string, Promise<any>>();
const questionInflight = new Map<string, Promise<any>>();
const draftGrabInflight = new Map<string, Promise<ClaudePtyDraftGrabResult>>();
const lastInterruptAt = new Map<string, number>();
const INTERRUPT_DEDUP_MS = 700;

const shortTab = (tabId: string) => String(tabId || '').slice(-12) || 'unknown';
const shortSid = (sessionId?: string) => sessionId ? sessionId.slice(0, 8) : 'none';
const errorText = (e: any) => String(e?.message || e);

export async function getClaudePtyPresence(tabId: string): Promise<ClaudePtyPresence> {
  const presence = await ipcRenderer.invoke('claude:get-presence', tabId);
  return {
    status: presence?.status || 'inactive',
    hasBridge: !!presence?.hasBridge,
    isBusy: !!presence?.isBusy,
    hasTerm: !!presence?.hasTerm,
    inputReady: !!presence?.inputReady,
    awaiting: !!presence?.awaiting,
  };
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

  if (presence?.status === 'active' || presence?.status === 'busy' || presence?.status === 'starting') {
    store.clearInterruptedState(tabId);
    console.log('[ClaudePtyActions:resume] already-running tab=' + shortTab(tabId) + ' status=' + presence.status);
    return { success: true, alreadyRunning: true, status: presence.status };
  }

  if (presence && presence.hasTerm === false) {
    console.warn('[ClaudePtyActions:resume] no-terminal tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId));
    return { success: false, sessionId, status: presence.status, error: 'terminal not ready' };
  }

  store.clearInterruptedState(tabId);

  let repaired = 0;
  if (repair) {
    try {
      const repairRes = await ipcRenderer.invoke('claude:repair-jsonl-before-resume', { sessionId, cwd });
      repaired = Number(repairRes?.repaired || 0);
      if (repairRes?.success === false) {
        console.warn('[ClaudePtyActions:resume] JSONL repair reported failure tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId) + ': ' + (repairRes?.error || 'unknown'));
      } else {
        console.log('[ClaudePtyActions:resume] repair-done tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId) + ' repaired=' + repaired);
      }
    } catch (e: any) {
      console.warn('[ClaudePtyActions:resume] JSONL repair skipped tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId) + ': ' + errorText(e));
    }
  }

  // Arm stale-bridge protection immediately before the PTY write. Starting the
  // 15s TTL before JSONL repair can burn the guard window on large sessions.
  markPendingResume(tabId, sessionId);
  console.log('[ClaudePtyActions:resume] pending-marked-and-write tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId));
  ipcRenderer.send('terminal:input', tabId, '\x15claude --dangerously-skip-permissions --resume ' + sessionId + '\r');
  ipcRenderer.send('terminal:force-command-started', { tabId, commandType: 'claude', sessionId });
  return { success: true, sessionId, repaired };
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
  const work = ipcRenderer.invoke('terminal:paste', {
      tabId,
      content: prompt,
      submit: true,
      fast: false,
      handoffId: options.handoffId || null,
      source: options.source || 'claude-pty-action',
    })
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

export function interruptClaudePtyTurn(tabId: string): { success: boolean; interrupted?: boolean; error?: string } {
  if (!tabId) return { success: false, error: 'tabId required' };
  const now = Date.now();
  const prev = lastInterruptAt.get(tabId) || 0;
  if (now - prev < INTERRUPT_DEDUP_MS) {
    console.log('[ClaudePtyActions:interrupt] dedup tab=' + shortTab(tabId) + ' deltaMs=' + (now - prev));
    return { success: true, interrupted: false };
  }
  lastInterruptAt.set(tabId, now);
  console.log('[ClaudePtyActions:interrupt] esc tab=' + shortTab(tabId));
  ipcRenderer.send('terminal:input', tabId, '\x1b');
  return { success: true, interrupted: true };
}

export async function stopClaudePtyProcess(tabId: string): Promise<any> {
  if (!tabId) return { success: false, error: 'tabId required' };
  const existing = stopInflight.get(tabId);
  if (existing) {
    console.log('[ClaudePtyActions:stop-process] join-inflight tab=' + shortTab(tabId));
    return existing;
  }
  console.log('[ClaudePtyActions:stop-process] start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('terminal:stop-ai-process', tabId)
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

export async function grabClaudePtyDraft(tabId: string): Promise<ClaudePtyDraftGrabResult> {
  if (!tabId) return { success: false, error: 'tabId required' };

  const existing = draftGrabInflight.get(tabId);
  if (existing) {
    console.log('[ClaudePtyActions:draft] join-inflight tab=' + shortTab(tabId));
    return existing;
  }

  console.log('[ClaudePtyActions:draft] grab start tab=' + shortTab(tabId));
  const work = ipcRenderer.invoke('claude:grab-input', tabId)
    .then((result: ClaudePtyDraftGrabResult) => {
      console.log('[ClaudePtyActions:draft] grab done tab=' + shortTab(tabId) + ' success=' + !!result?.success + ' chars=' + (result?.text?.length || 0) + ' images=' + (result?.images || 0) + ' error=' + (result?.error || '-'));
      return result || { success: false, error: 'empty_result' };
    })
    .catch((e: any) => {
      console.warn('[ClaudePtyActions:draft] grab error tab=' + shortTab(tabId) + ': ' + errorText(e));
      return { success: false, error: errorText(e) };
    })
    .finally(() => {
      if (draftGrabInflight.get(tabId) === work) draftGrabInflight.delete(tabId);
    });
  draftGrabInflight.set(tabId, work);
  return work;
}
