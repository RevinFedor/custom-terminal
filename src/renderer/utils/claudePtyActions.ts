import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { clearPendingResume, markPendingResume } from './pendingResume';

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
const lastInterruptAt = new Map<string, number>();
const INTERRUPT_DEDUP_MS = 700;

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

type ClaudePtySettingProof = {
  success?: boolean;
  reason?: string;
  timestamp?: string | null;
  wrapperSeen?: boolean;
  stdoutSeen?: boolean;
  sessionId?: string | null;
  file?: string;
  error?: string;
};

const claudeSettingQueueTails = new Map<string, Promise<unknown>>();
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

async function waitForClaudePtySettingProof({
  tabId,
  kind,
  command,
  afterMs,
  source,
  timeoutMs,
}: {
  tabId: string;
  kind: ClaudePtySettingKind;
  command: string;
  afterMs: number;
  source: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + timeoutMs;
  let last: ClaudePtySettingProof | null = null;
  while (Date.now() <= deadline) {
    const proof = await ipcRenderer.invoke('claude:startup-slash-proof', {
      tabId,
      command,
      afterMs,
      label: source,
    }).catch((error: any) => ({
      success: false,
      reason: 'proof_ipc_error',
      error: errorText(error),
    }));
    last = proof || null;
    if (proof?.success === true) {
      return { proof, last };
    }

    // The PTY stream is only a wake-up signal. Main confirms Enter from the
    // current headless frame and refuses if another dialog, input revision, or
    // terminal generation is present.
    await ipcRenderer.invoke('claude:confirm-settings-dialog', {
      tabId,
      kind,
      reason: source,
    }).catch(() => null);
    await wait(180);
  }
  return { proof: null, last };
}

async function applyClaudePtySettingInner({
  tabId,
  kind,
  value,
  source,
}: {
  tabId: string;
  kind: ClaudePtySettingKind;
  value: string;
  source: string;
}): Promise<ClaudePtySettingResult> {
  const normalizedValue = String(value || '').trim();
  if (!tabId) throw new Error('tabId required');
  if (!normalizedValue) throw new Error(kind + ' value required');

  const command = '/' + kind + ' ' + normalizedValue;
  const afterMs = Date.now();
  console.warn('[ClaudePtySetting] start tab=' + shortTab(tabId)
    + ' command=' + JSON.stringify(command)
    + ' source=' + source);

  const sent = await ipcRenderer.invoke('claude:send-command', tabId, command, {
    source,
    stashFirst: true,
    armPromptBoundaryOnSubmit: true,
  });
  if (sent?.success !== true) {
    throw new Error(sent?.error || 'Claude setting command was not sent');
  }

  let observed = await waitForClaudePtySettingProof({
    tabId,
    kind,
    command,
    afterMs,
    source,
    timeoutMs: 6500,
  });

  if (!observed.proof) {
    // One bounded retry is allowed only when main atomically copied the current
    // composer and it still equals this exact command at the Enter boundary.
    // A changed or unknown draft is never submitted.
    const retry = await ipcRenderer.invoke('claude:retry-exact-setting-input', {
      tabId,
      command,
      reason: source + ':proof-timeout',
    }).catch((error: any) => ({
      success: false,
      submitted: false,
      error: errorText(error),
    }));
    if (retry?.submitted === true) {
      observed = await waitForClaudePtySettingProof({
        tabId,
        kind,
        command,
        afterMs,
        source: source + ':exact-retry',
        timeoutMs: 3500,
      });
    }
  }

  if (!observed.proof) {
    const last = observed.last || {};
    throw new Error(
      command + ' was not confirmed by Claude'
      + '; reason=' + (last.reason || 'timeout')
      + '; wrapper=' + !!last.wrapperSeen
      + '; stdout=' + !!last.stdoutSeen
      + (last.error ? '; error=' + last.error : ''),
    );
  }

  console.warn('[ClaudePtySetting] confirmed tab=' + shortTab(tabId)
    + ' command=' + JSON.stringify(command)
    + ' session=' + shortSid(observed.proof.sessionId || undefined)
    + ' timestamp=' + (observed.proof.timestamp || '-'));
  return {
    success: true,
    tabId,
    kind,
    value: normalizedValue,
    command,
    proof: observed.proof.reason || 'jsonl-stdout',
    sessionId: observed.proof.sessionId || null,
    timestamp: observed.proof.timestamp || null,
  };
}

export async function applyClaudePtySetting({
  tabId,
  kind,
  value,
  source = 'claude-pty-setting',
}: {
  tabId: string;
  kind: ClaudePtySettingKind;
  value: string;
  source?: string;
}): Promise<ClaudePtySettingResult> {
  const previous = claudeSettingQueueTails.get(tabId) || Promise.resolve();
  const work = previous
    .catch(() => undefined)
    .then(() => applyClaudePtySettingInner({ tabId, kind, value, source }));
  claudeSettingQueueTails.set(tabId, work);
  try {
    return await work;
  } finally {
    if (claudeSettingQueueTails.get(tabId) === work) {
      claudeSettingQueueTails.delete(tabId);
    }
  }
}

export async function getClaudePtyPresence(tabId: string): Promise<ClaudePtyPresence> {
  const presence = await ipcRenderer.invoke('claude:get-presence', tabId);
  return {
    status: presence?.status || 'inactive',
    hasBridge: !!presence?.hasBridge,
    isBusy: !!presence?.isBusy,
    hasTerm: !!presence?.hasTerm,
    inputReady: !!presence?.inputReady,
    awaiting: !!presence?.awaiting,
    sessionId: presence?.sessionId || null,
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

  let repaired = 0;
  if (repair) {
    try {
      const repairRes = await ipcRenderer.invoke('claude:repair-jsonl-before-resume', { sessionId, cwd, tabId });
      repaired = Number(repairRes?.repaired || 0);
      if (repairRes?.success === false) {
        console.warn('[ClaudePtyActions:resume] JSONL repair reported failure tab=' + shortTab(tabId) + ' sid=' + shortSid(sessionId) + ': ' + (repairRes?.error || 'unknown'));
        return { success: false, sessionId, error: repairRes?.error || 'JSONL repair failed' };
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
  const runResult = await ipcRenderer.invoke('claude:run-command', {
    tabId,
    command: 'claude-c',
    sessionId,
    ...(cwd ? { cdTo: cwd } : {}),
  }).catch((e: any) => ({ success: false, error: errorText(e) }));
  if (runResult?.success === false) {
    clearPendingResume(tabId);
    return { success: false, sessionId, repaired, error: runResult.error || runResult.reason || 'Claude resume failed' };
  }
  store.clearInterruptedState(tabId);
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
  const work = ipcRenderer.invoke('terminal:stop-ai-process', { tabId, toolType: 'claude' })
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
