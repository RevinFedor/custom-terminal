import type { AgentHistoryTool, AgentPtyStatus, HistoryAgentRuntime } from './historyAgentRuntimes';
import { waitForClaudeStartupDefaultsReady } from './claudeStartupDefaultsGate';
import { terminalRegistry } from './terminalRegistry';

const { ipcRenderer } = window.require('electron');

export interface SendAgentPromptScenarioArgs {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  sessionId?: string | null;
  cwd?: string;
  prompt: string;
  handoffId?: string;
  source?: string;
  statusAtSend?: string;
  queue?: boolean;
  model?: string;
  effort?: string;
  returnDraftOnConflict?: boolean;
}

const normalizeStatus = (value: unknown): AgentPtyStatus | undefined => {
  return value === 'active' || value === 'busy' || value === 'inactive' || value === 'starting' || value === 'stopping'
    ? value
    : undefined;
};

export async function sendAgentPromptScenario({
  tabId,
  toolType,
  runtime,
  sessionId,
  cwd,
  prompt,
  handoffId,
  source,
  statusAtSend,
  queue,
  model,
  effort,
  returnDraftOnConflict,
}: SendAgentPromptScenarioArgs): Promise<any> {
  const requestedStatusForSend = normalizeStatus(statusAtSend);
  const statusForSend = await ensureAgentReadyForSend({
    tabId,
    toolType,
    runtime,
    sessionId,
    cwd,
  }) || requestedStatusForSend;
  if (requestedStatusForSend && statusForSend && requestedStatusForSend !== statusForSend) {
    console.log('[AgentScenario:send] status override tool=' + toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' requested=' + requestedStatusForSend
      + ' effective=' + statusForSend);
  }

  if (statusForSend === 'active' && queue !== true && runtime.inspectDraft) {
    const visual = runtime.inspectDraft(tabId);
    if (visual?.hasDraft === true) {
      let draftText = '';
      let draftImages = 0;
      if (returnDraftOnConflict === true) {
        const grabbed = await runtime.grabDraft(tabId);
        if (grabbed?.success === false) {
          return {
            tabId,
            toolType,
            success: false,
            ok: false,
            code: 'terminal_draft_grab_failed',
            error: grabbed.error || 'terminal draft exists, but could not be returned',
            draftPreview: visual.preview || '',
            draftSource: visual.source || '',
            originalPrompt: prompt,
          };
        }
        draftText = typeof grabbed?.text === 'string' ? grabbed.text : '';
        draftImages = Number(grabbed?.images || 0);
      }
      return {
        tabId,
        toolType,
        success: false,
        ok: false,
        code: 'terminal_draft_conflict',
        error: 'Terminal has an unsent draft',
        draftText,
        draftPreview: visual.preview || '',
        draftSource: visual.source || '',
        draftImages,
        originalPrompt: prompt,
      };
    }
    if (visual?.hasDraft === null && visual.source !== 'no-terminal') {
      return {
        tabId,
        toolType,
        success: false,
        ok: false,
        code: 'terminal_draft_state_unknown',
        error: 'Terminal draft state is unknown; send stopped before touching input',
        draftPreview: visual.preview || '',
        draftSource: visual.source || '',
        originalPrompt: prompt,
      };
    }
  }

  const result = await runtime.sendPrompt(tabId, prompt, {
    handoffId: typeof handoffId === 'string' ? handoffId : undefined,
    source: typeof source === 'string' ? source : 'mobile-native',
    statusAtSend: statusForSend,
    queue: queue === true,
    model: typeof model === 'string' ? model : undefined,
    effort: typeof effort === 'string' ? effort : undefined,
  });
  return {
    ...(result || {}),
    requestedStatusAtSend: requestedStatusForSend,
    effectiveStatusAtSend: statusForSend,
  };
}

export async function stopAgentProcessScenario({
  tabId,
  toolType,
  runtime,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
}): Promise<any> {
  const r = await runtime.stopProcess(tabId);
  return { tabId, toolType, stopped: !!r?.success, ...(r || {}) };
}

export function interruptAgentTurnScenario({
  tabId,
  toolType,
  runtime,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
}): any {
  const result = runtime.interruptTurn(tabId);
  return { tabId, toolType, interrupted: !!result.interrupted, ...(result || {}) };
}

export async function grabAgentDraftScenario({
  tabId,
  toolType,
  runtime,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
}): Promise<any> {
  const result = await runtime.grabDraft(tabId);
  return { tabId, toolType, ...(result || {}) };
}

export function inspectAgentDraftScenario({
  tabId,
  toolType,
  runtime,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
}): any {
  let result = runtime.inspectDraft
    ? runtime.inspectDraft(tabId)
    : { hasDraft: null, preview: '', source: 'unsupported' };
  if (result?.source === 'no-terminal') {
    result = {
      ...(result || {}),
      mountedForInspect: false,
      debug: [result?.debug, 'mount=not-mounted focus=preserved'].filter(Boolean).join(' '),
    };
  }
  return { tabId, toolType, ...(result || {}) };
}

function createAgentReadyWait(tabId: string, runtime: HistoryAgentRuntime, timeoutMs = 30000) {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(runtime.label + ' did not become ready for rewind'));
    }, timeoutMs);
    const handler = (_event: any, data: { tabId?: string } = {}) => {
      if (data?.tabId !== tabId) return;
      finish();
    };
    cleanup = () => {
      clearTimeout(timer);
      if (runtime.readyEvent) ipcRenderer.removeListener(runtime.readyEvent, handler);
    };
    if (!runtime.readyEvent) {
      finish();
    } else {
      ipcRenderer.on(runtime.readyEvent, handler);
    }
  });
  return {
    promise,
    cancel: () => cleanup(),
  };
}

function isAgentRewindBlockedStatus(status?: AgentPtyStatus | null): boolean {
  return status === 'busy' || status === 'starting' || status === 'stopping';
}

function getAgentRewindBlockedMessage(runtime: HistoryAgentRuntime, status?: AgentPtyStatus | null): string {
  if (status === 'starting') {
    return runtime.label + ' is starting; wait until the current loader finishes before rewind';
  }
  if (status === 'stopping') {
    return runtime.label + ' is stopping; wait until the current loader finishes before rewind';
  }
  return runtime.label + ' is busy; wait for the current turn before rewind';
}

async function ensureAgentReadyForRewind({
  tabId,
  toolType,
  runtime,
  sessionId,
  cwd,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  sessionId: string;
  cwd?: string;
}): Promise<AgentPtyStatus | undefined> {
  const waitStartupDefaultsIfNeeded = async () => {
    if (toolType === 'claude') await waitForClaudeStartupDefaultsReady(tabId);
  };
  let presence = await runtime.getPresence(tabId).catch((err: any) => {
    console.warn('[AgentScenario:rewind] presence failed before resume tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' ' + (err?.message || err));
    return null;
  });
  console.log('[AgentScenario:rewind] presence before tool=' + toolType
    + ' tab=' + String(tabId).slice(-12)
    + ' status=' + (presence?.status || 'unknown')
    + ' inputReady=' + !!presence?.inputReady
    + ' busy=' + !!presence?.isBusy);
  if (isAgentRewindBlockedStatus(presence?.status)) {
    throw new Error(getAgentRewindBlockedMessage(runtime, presence?.status));
  }
  if (presence?.status === 'active' && presence?.inputReady) {
    await waitStartupDefaultsIfNeeded();
    return;
  }

  const readyWait = createAgentReadyWait(tabId, runtime);
  try {
    const resumedForRewind = !presence || presence.status === 'inactive';
    if (!presence || presence.status === 'inactive') {
      console.log('[AgentScenario:rewind] resume before rewind tool=' + toolType + ' tab=' + String(tabId).slice(-12));
      const resumeResult = await runtime.resume({ tabId, sessionId, cwd });
      if (resumeResult?.success === false) {
        throw new Error(resumeResult.error || runtime.label + ' resume failed before rewind');
      }
    }

    presence = await runtime.getPresence(tabId).catch(() => null);
    if (presence?.status === 'stopping' || presence?.status === 'busy' || (presence?.status === 'starting' && !resumedForRewind)) {
      throw new Error(getAgentRewindBlockedMessage(runtime, presence?.status));
    }
    if (presence?.status === 'active' && presence?.inputReady) {
      readyWait.cancel();
      await waitStartupDefaultsIfNeeded();
      return;
    }

    await readyWait.promise;
    presence = await runtime.getPresence(tabId).catch(() => null);
    console.log('[AgentScenario:rewind] presence after wait tool=' + toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' status=' + (presence?.status || 'unknown')
      + ' inputReady=' + !!presence?.inputReady
      + ' busy=' + !!presence?.isBusy);
    if (isAgentRewindBlockedStatus(presence?.status)) {
      throw new Error(getAgentRewindBlockedMessage(runtime, presence?.status));
    }
    if (presence?.status !== 'active' || !presence?.inputReady) {
      throw new Error(runtime.label + ' session is not ready for rewind');
    }
    await waitStartupDefaultsIfNeeded();
  } catch (err) {
    readyWait.cancel();
    throw err;
  }
}

async function ensureAgentReadyForSend({
  tabId,
  toolType,
  runtime,
  sessionId,
  cwd,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  sessionId?: string | null;
  cwd?: string;
}) {
  const waitStartupDefaultsIfNeeded = async () => {
    if (toolType === 'claude') await waitForClaudeStartupDefaultsReady(tabId);
  };
  let presence = await runtime.getPresence(tabId).catch((err: any) => {
    console.warn('[AgentScenario:send] presence failed before send tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' ' + (err?.message || err));
    return null;
  });
  console.log('[AgentScenario:send] presence before tool=' + toolType
    + ' tab=' + String(tabId).slice(-12)
    + ' status=' + (presence?.status || 'unknown')
    + ' inputReady=' + !!presence?.inputReady
    + ' busy=' + !!presence?.isBusy);
  if (presence?.status === 'stopping') {
    throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
  }
  if (presence?.status === 'busy') return 'busy';
  if (presence?.status === 'active' && presence?.inputReady) {
    await waitStartupDefaultsIfNeeded();
    return 'active';
  }
  if (presence?.status === 'active' && !presence?.inputReady && sessionId && runtime.inspectDraft) {
    const draftState = runtime.inspectDraft(tabId);
    if (draftState?.source === 'no-terminal' && !terminalRegistry.get(tabId)) {
      console.log('[AgentScenario:send] renderer terminal not mounted; continue with PTY/audit path tool='
        + toolType + ' tab=' + String(tabId).slice(-12));
      return 'active';
    }
  }

  const readyWait = createAgentReadyWait(tabId, runtime);
  try {
    if (!presence || presence.status === 'inactive') {
      if (!sessionId) {
        readyWait.cancel();
        throw new Error(runtime.label + ' session is inactive and has no session id to resume');
      }
      console.log('[AgentScenario:send] resume before send tool=' + toolType + ' tab=' + String(tabId).slice(-12));
      const resumeResult = await runtime.resume({ tabId, sessionId, cwd });
      if (resumeResult?.success === false) {
        throw new Error(resumeResult.error || runtime.label + ' resume failed before send');
      }
    }

    presence = await runtime.getPresence(tabId).catch(() => null);
    if (presence?.status === 'stopping') {
      throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
    }
    if (presence?.status === 'busy') return 'busy';
    if (presence?.status === 'active' && presence?.inputReady) {
      readyWait.cancel();
      await waitStartupDefaultsIfNeeded();
      return 'active';
    }

    await readyWait.promise;
    presence = await runtime.getPresence(tabId).catch(() => null);
    console.log('[AgentScenario:send] presence after wait tool=' + toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' status=' + (presence?.status || 'unknown')
      + ' inputReady=' + !!presence?.inputReady
      + ' busy=' + !!presence?.isBusy);
    if (presence?.status === 'busy') return 'busy';
    if (presence?.status !== 'active' || !presence?.inputReady) {
      throw new Error(runtime.label + ' session is not ready for send');
    }
    await waitStartupDefaultsIfNeeded();
    return 'active';
  } catch (err) {
    readyWait.cancel();
    throw err;
  }
}

export async function rewindAgentTimelineScenario({
  tabId,
  tab,
  toolType,
  runtime,
  sessionId,
  mode,
  targetIndex,
  targetText,
  targetFullText,
  rewindableCount,
  skipDuplicates,
  startUuid,
  endUuid,
  additionalPrompt,
  buildAiRewindText,
}: {
  tabId: string;
  tab: any;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  sessionId: string;
  mode?: string;
  targetIndex?: number;
  targetText?: string;
  targetFullText?: string;
  rewindableCount?: number;
  skipDuplicates?: number;
  startUuid?: string | null;
  endUuid?: string | null;
  additionalPrompt?: string | null;
  buildAiRewindText?: (args: {
    toolType: AgentHistoryTool;
    sessionId: string;
    cwd?: string;
    startUuid?: string;
    endUuid?: string;
    additionalPrompt?: string;
  }) => Promise<string>;
}): Promise<any> {
  const rewindMode = mode === 'ai' ? 'ai' : 'native';
  const channel = toolType === 'codex' ? 'codex:open-history-menu' : 'claude:open-history-menu';
  let pasteAfter: string | undefined;
  if (rewindMode === 'ai') {
    if (!buildAiRewindText) throw new Error('AI Rewind builder not provided');
    console.log('[MobRewind:Scenario] AI compact begin tool=' + toolType + ' tab=' + String(tabId).slice(-12));
    pasteAfter = await buildAiRewindText({
      toolType,
      sessionId,
      cwd: tab?.cwd,
      startUuid: typeof startUuid === 'string' ? startUuid : undefined,
      endUuid: typeof endUuid === 'string' ? endUuid : undefined,
      additionalPrompt: typeof additionalPrompt === 'string' ? additionalPrompt : undefined,
    });
    console.log('[MobRewind:Scenario] AI compact ready tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' len=' + pasteAfter.length);
  }
  await ensureAgentReadyForRewind({
    tabId,
    toolType,
    runtime,
    sessionId,
    cwd: tab?.cwd,
  });
  const result = await ipcRenderer.invoke(channel, {
    tabId,
    targetIndex,
    targetText,
    targetFullText,
    rewindableCount,
    skipDuplicates,
    pasteAfter,
  });
  return {
    tabId,
    toolType,
    mode: rewindMode,
    compactPasted: !!pasteAfter,
    compactLength: pasteAfter?.length || 0,
    ...(result || {}),
  };
}
