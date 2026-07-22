import type { AgentHistoryTool, AgentPtyStatus, HistoryAgentRuntime } from './historyAgentRuntimes';
import { waitForClaudeStartupDefaultsReadyWithVisibleFallback } from './claudeStartupDefaultsReady';
import { terminalRegistry } from './terminalRegistry';
import { useUIStore, type HistoryPromptDraftImageRef } from '../store/useUIStore';
import { requireConfirmedCodexWriter } from './codexWriterIdentity';

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
  return value === 'active' || value === 'busy' || value === 'inactive' || value === 'starting' || value === 'stopping' || value === 'unknown'
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

function createAgentReadyWait(tabId: string, runtime: HistoryAgentRuntime, timeoutMs = 30000, purpose = 'ready') {
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
      finish(new Error(runtime.label + ' did not become ready for ' + purpose));
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
  return status === 'busy' || status === 'starting' || status === 'stopping' || status === 'unknown';
}

function getAgentRewindBlockedMessage(runtime: HistoryAgentRuntime, status?: AgentPtyStatus | null): string {
  if (status === 'starting') {
    return runtime.label + ' is starting; wait until the current loader finishes before rewind';
  }
  if (status === 'stopping') {
    return runtime.label + ' is stopping; wait until the current loader finishes before rewind';
  }
  if (status === 'unknown') {
    return runtime.label + ' status could not be verified; retry before rewind';
  }
  return runtime.label + ' is busy; wait for the current turn before rewind';
}

interface AgentReadyForRewindResult {
  status: 'active';
  resumed: boolean;
  resumeSourceSessionId: string | null;
}

export interface PreparedCodexRewindRuntime {
  sourceSessionId: string;
  writerSessionId: string;
  writerRelation: 'same-session' | 'current-resume-child';
  writerAuthorization: 'confirmed-writer' | 'provisional-resume-source';
  writerLaunchId?: string | null;
  targetUuid: string;
  endUuid?: string;
  lineageDepth: number;
}

interface CodexTimelineEntry {
  uuid?: string;
  type?: string;
  content?: string;
}

interface CodexTimelineSnapshot {
  success?: boolean;
  error?: string;
  entries?: CodexTimelineEntry[];
  sessionMeta?: {
    id?: string | null;
    forked_from_id?: string | null;
  } | null;
}

const canonicalTranscriptText = (value: unknown): string => String(value || '')
  .replace(/\r\n/g, '\n')
  .trim();

async function loadCodexTimelineSnapshot(sessionId: string, cwd?: string): Promise<CodexTimelineSnapshot> {
  const result = await ipcRenderer.invoke('agent-transcript:get-timeline', {
    toolType: 'codex',
    sessionId,
    cwd,
    consumerId: 'agent-scenario-rewind-proof',
  }).catch((error: any) => ({ success: false, error: String(error?.message || error) }));
  if (result?.success === false) {
    throw new Error('Cannot prove Codex resume lineage: ' + (result.error || 'timeline unavailable'));
  }
  if (String(result?.sessionMeta?.id || '') !== sessionId) {
    throw new Error('Cannot prove Codex resume lineage: rollout metadata does not match its session ID');
  }
  return result as CodexTimelineSnapshot;
}

async function proveCodexRewindTargetMapping({
  sourceSessionId,
  writerSessionId,
  cwd,
  targetIndex,
  targetUuid,
  endUuid,
  targetFullText,
  rewindableCount,
}: {
  sourceSessionId: string;
  writerSessionId: string;
  cwd?: string;
  targetIndex?: number;
  targetUuid?: string | null;
  endUuid?: string | null;
  targetFullText?: string;
  rewindableCount?: number;
}): Promise<{ targetUuid: string; endUuid?: string; lineageDepth: number }> {
  const source = await loadCodexTimelineSnapshot(sourceSessionId, cwd);
  const writer = writerSessionId === sourceSessionId
    ? source
    : await loadCodexTimelineSnapshot(writerSessionId, cwd);

  // Ready/resume events prove only that a TUI exists. The durable source→child
  // relation lives in rollout metadata, so walk that chain with a hard cap.
  let lineageDepth = 0;
  let cursorId = writerSessionId;
  let cursor = writer;
  const visited = new Set<string>();
  while (cursorId !== sourceSessionId) {
    if (visited.has(cursorId) || lineageDepth >= 16) {
      throw new Error('Cannot prove Codex resume lineage: parent chain is cyclic or too deep');
    }
    visited.add(cursorId);
    const parentId = String(cursor.sessionMeta?.forked_from_id || '').trim();
    if (!parentId) {
      throw new Error('Cannot prove Codex resume lineage: active rollout is unrelated to the selected history');
    }
    lineageDepth += 1;
    if (parentId === sourceSessionId) break;
    cursorId = parentId;
    cursor = await loadCodexTimelineSnapshot(cursorId, cwd);
  }

  const sourceUsers = (source.entries || []).filter((entry) => entry?.type === 'user');
  const writerUsers = (writer.entries || []).filter((entry) => entry?.type === 'user');
  const sourceEntries = source.entries || [];
  const writerEntries = writer.entries || [];
  const expectedCount = Number(rewindableCount);
  const index = Number(targetIndex);
  if (!Number.isInteger(expectedCount)
    || expectedCount !== sourceUsers.length
    || expectedCount !== writerUsers.length
    || !Number.isInteger(index)
    || index < 0
    || index >= expectedCount) {
    throw new Error('Codex history changed during Resume; reload Timeline and repeat Rewind');
  }

  const sourceTarget = sourceUsers[index];
  const writerTarget = writerUsers[index];
  if (!targetUuid
    || sourceTarget?.uuid !== targetUuid
    || !writerTarget?.uuid
    || canonicalTranscriptText(sourceTarget.content) !== canonicalTranscriptText(targetFullText)) {
    throw new Error('Codex Rewind target no longer matches the selected source history; reload Timeline and repeat');
  }
  for (let i = 0; i < sourceUsers.length; i += 1) {
    if (canonicalTranscriptText(sourceUsers[i]?.content) !== canonicalTranscriptText(writerUsers[i]?.content)) {
      throw new Error('Codex child rollout diverged from the selected source history; reload Timeline and repeat');
    }
  }

  // AI compact is built from the complete timeline range, not only user turns.
  // Require equivalent marker structure, then translate both range endpoints
  // to writer-owned UUIDs so copy-range reads the same live rollout as Rewind.
  if (sourceEntries.length !== writerEntries.length) {
    throw new Error('Codex child timeline structure differs from the selected source; reload Timeline and repeat');
  }
  for (let i = 0; i < sourceEntries.length; i += 1) {
    if (sourceEntries[i]?.type !== writerEntries[i]?.type
      || canonicalTranscriptText(sourceEntries[i]?.content) !== canonicalTranscriptText(writerEntries[i]?.content)) {
      throw new Error('Codex child timeline range differs from the selected source; reload Timeline and repeat');
    }
  }

  let mappedEndUuid: string | undefined;
  if (endUuid) {
    const endIndex = sourceEntries.findIndex((entry) => entry?.uuid === endUuid);
    mappedEndUuid = endIndex >= 0 ? writerEntries[endIndex]?.uuid : undefined;
    if (!mappedEndUuid) {
      throw new Error('Codex AI Rewind range end no longer exists in the active writer; reload Timeline and repeat');
    }
  }

  return { targetUuid: writerTarget.uuid, endUuid: mappedEndUuid, lineageDepth };
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
}): Promise<AgentReadyForRewindResult> {
  const waitStartupDefaultsIfNeeded = async () => {
    if (toolType === 'claude') await waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, 15000, 'agent-rewind');
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
  const isCodexProvisionalComposerReady = () => toolType === 'codex'
    && presence?.status === 'starting'
    && presence?.inputReady === true;
  if (isAgentRewindBlockedStatus(presence?.status) && !isCodexProvisionalComposerReady()) {
    throw new Error(getAgentRewindBlockedMessage(runtime, presence?.status));
  }
  if ((presence?.status === 'active' && presence?.inputReady) || isCodexProvisionalComposerReady()) {
    await waitStartupDefaultsIfNeeded();
    return { status: 'active', resumed: false, resumeSourceSessionId: null };
  }

  const readyWait = createAgentReadyWait(tabId, runtime, 30000, 'rewind');
  let resumedForRewind = false;
  try {
    if (!presence || presence.status === 'inactive') {
      resumedForRewind = true;
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
    if ((presence?.status === 'active' && presence?.inputReady) || isCodexProvisionalComposerReady()) {
      readyWait.cancel();
      await waitStartupDefaultsIfNeeded();
      return {
        status: 'active',
        resumed: resumedForRewind,
        resumeSourceSessionId: resumedForRewind ? sessionId : null,
      };
    }

    await readyWait.promise;
    presence = await runtime.getPresence(tabId).catch(() => null);
    console.log('[AgentScenario:rewind] presence after wait tool=' + toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' status=' + (presence?.status || 'unknown')
      + ' inputReady=' + !!presence?.inputReady
      + ' busy=' + !!presence?.isBusy);
    if (isAgentRewindBlockedStatus(presence?.status) && !isCodexProvisionalComposerReady()) {
      throw new Error(getAgentRewindBlockedMessage(runtime, presence?.status));
    }
    if (!((presence?.status === 'active' && presence?.inputReady) || isCodexProvisionalComposerReady())) {
      throw new Error(runtime.label + ' session is not ready for rewind');
    }
    await waitStartupDefaultsIfNeeded();
    return {
      status: 'active',
      resumed: resumedForRewind,
      resumeSourceSessionId: resumedForRewind ? sessionId : null,
    };
  } catch (err) {
    readyWait.cancel();
    throw err;
  }
}

export async function prepareCodexRewindRuntime({
  tabId,
  runtime,
  sourceSessionId,
  cwd,
  targetIndex,
  targetUuid,
  endUuid,
  targetFullText,
  rewindableCount,
}: {
  tabId: string;
  runtime: HistoryAgentRuntime;
  sourceSessionId: string;
  cwd?: string;
  targetIndex?: number;
  targetUuid?: string | null;
  endUuid?: string | null;
  targetFullText?: string;
  rewindableCount?: number;
}): Promise<PreparedCodexRewindRuntime> {
  const readiness = await ensureAgentReadyForRewind({
    tabId,
    toolType: 'codex',
    runtime,
    sessionId: sourceSessionId,
    cwd,
  });
  const authorization = await ipcRenderer.invoke('codex:get-rewind-writer-authorization', {
    tabId,
    sourceSessionId,
  }).catch((error: any) => ({ success: false, error: String(error?.message || error) }));
  if (authorization?.success !== true || !authorization.writerSessionId) {
    throw new Error(authorization?.error || 'Codex writer is not ready for Rewind');
  }
  const writerSessionId = String(authorization.writerSessionId);
  const mapped = await proveCodexRewindTargetMapping({
    sourceSessionId,
    writerSessionId,
    cwd,
    targetIndex,
    targetUuid,
    endUuid,
    targetFullText,
    rewindableCount,
  });
  return {
    sourceSessionId,
    writerSessionId,
    writerRelation: writerSessionId === sourceSessionId ? 'same-session' : 'current-resume-child',
    writerAuthorization: authorization.authorization,
    writerLaunchId: authorization.launchId || null,
    targetUuid: mapped.targetUuid,
    endUuid: mapped.endUuid,
    lineageDepth: mapped.lineageDepth,
  };
}

export async function revalidatePreparedCodexRewindRuntime({
  tabId,
  prepared,
  cwd,
  targetIndex,
  sourceTargetUuid,
  sourceEndUuid,
  targetFullText,
  rewindableCount,
}: {
  tabId: string;
  prepared: PreparedCodexRewindRuntime;
  cwd?: string;
  targetIndex?: number;
  sourceTargetUuid?: string | null;
  sourceEndUuid?: string | null;
  targetFullText?: string;
  rewindableCount?: number;
}): Promise<PreparedCodexRewindRuntime> {
  const mapped = await proveCodexRewindTargetMapping({
    sourceSessionId: prepared.sourceSessionId,
    writerSessionId: prepared.writerSessionId,
    cwd,
    targetIndex,
    targetUuid: sourceTargetUuid,
    endUuid: sourceEndUuid,
    targetFullText,
    rewindableCount,
  });
  if (mapped.targetUuid !== prepared.targetUuid
    || (prepared.endUuid && mapped.endUuid !== prepared.endUuid)) {
    throw new Error('Codex Rewind target changed while the operation was being prepared; reload Timeline and repeat');
  }
  // Keep a fresh main-owned process proof adjacent to the destructive IPC. A
  // resume source may still be provisional because Codex can create its child
  // only on the first user action; that narrow authorization is launch-scoped.
  const authorization = await ipcRenderer.invoke('codex:get-rewind-writer-authorization', {
    tabId,
    sourceSessionId: prepared.sourceSessionId,
  }).catch((error: any) => ({ success: false, error: String(error?.message || error) }));
  if (authorization?.success !== true
    || authorization.writerSessionId !== prepared.writerSessionId
    || authorization.authorization !== prepared.writerAuthorization
    || (prepared.writerAuthorization === 'provisional-resume-source'
      && authorization.launchId !== prepared.writerLaunchId)) {
    throw new Error(authorization?.error || 'Codex writer changed while Rewind was being prepared; reload Timeline and repeat');
  }
  if (prepared.writerAuthorization === 'confirmed-writer') {
    await requireConfirmedCodexWriter({
      tabId,
      expectedSessionId: prepared.writerSessionId,
      operation: 'Rewind',
    });
  }
  const turnState = await ipcRenderer.invoke('codex:get-turn-state', tabId).catch(() => null);
  const turnIdentityReady = prepared.writerAuthorization === 'provisional-resume-source'
    ? turnState?.provisional === true && !turnState?.sessionId
    : turnState?.sessionId === prepared.writerSessionId;
  if (!turnState
    || turnState.hasWatcher !== true
    || !turnIdentityReady
    || turnState.catchUpPending === true
    || turnState.busy !== false) {
    throw new Error('Codex turn state is not confirmed idle; wait and repeat Rewind');
  }
  return { ...prepared, lineageDepth: mapped.lineageDepth };
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
    if (toolType === 'claude') await waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, 15000, 'agent-send');
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
  const isReadyComposer = () => !!presence?.inputReady
    && (presence.status === 'active' || (toolType === 'codex' && presence.status === 'starting'));
  if (presence?.status === 'stopping') {
    throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
  }
  if (presence?.status === 'busy') return 'busy';
  if (isReadyComposer()) {
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

  const readyWait = createAgentReadyWait(tabId, runtime, 30000, 'send');
  try {
    if (!presence || presence.status === 'inactive') {
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
      const actionLabel = hasSession ? 'resume' : 'start-fresh';
      if (!hasSession && !runtime.startFresh) {
        readyWait.cancel();
        throw new Error(runtime.label + ' session is inactive and cannot start fresh');
      }
      console.log('[AgentScenario:send] ' + actionLabel + ' before send tool=' + toolType + ' tab=' + String(tabId).slice(-12));
      const resumeResult = hasSession
        ? await runtime.resume({ tabId, sessionId, cwd })
        : await runtime.startFresh!({ tabId, cwd });
      if (resumeResult?.success === false) {
        throw new Error(resumeResult.error || runtime.label + ' ' + actionLabel + ' failed before send');
      }
    }

    presence = await runtime.getPresence(tabId).catch(() => null);
    if (presence?.status === 'stopping') {
      throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
    }
    if (presence?.status === 'busy') return 'busy';
    if (isReadyComposer()) {
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
    if (!isReadyComposer()) {
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
  let preparedCodex: PreparedCodexRewindRuntime | null = null;
  let runtimeTargetUuid = startUuid || undefined;
  let runtimeEndUuid = endUuid || undefined;

  // Starting a stopped Codex session can materialize a linked child. Establish
  // the live writer first; the source ID passed to resume is launch intent only.
  if (toolType === 'codex') {
    preparedCodex = await prepareCodexRewindRuntime({
      tabId,
      runtime,
      sourceSessionId: sessionId,
      cwd: tab?.cwd,
      targetIndex,
      targetUuid: startUuid,
      endUuid: rewindMode === 'ai' ? endUuid : null,
      targetFullText,
      rewindableCount,
    });
    runtimeTargetUuid = preparedCodex.targetUuid;
    runtimeEndUuid = preparedCodex.endUuid || runtimeEndUuid;
    if (preparedCodex.writerRelation === 'current-resume-child') {
      console.log('[AgentScenario:rewind] proven Codex resume child tab=' + String(tabId).slice(-12)
        + ' source=' + sessionId.slice(0, 8)
        + ' writer=' + preparedCodex.writerSessionId.slice(0, 8)
        + ' lineageDepth=' + preparedCodex.lineageDepth);
    }
  }

  let pasteAfter: string | undefined;
  if (rewindMode === 'ai') {
    if (!buildAiRewindText) throw new Error('AI Rewind builder not provided');
    console.log('[MobRewind:Scenario] AI compact begin tool=' + toolType + ' tab=' + String(tabId).slice(-12));
    pasteAfter = await buildAiRewindText({
      toolType,
      sessionId: toolType === 'codex' ? preparedCodex!.writerSessionId : sessionId,
      cwd: tab?.cwd,
      startUuid: toolType === 'codex'
        ? runtimeTargetUuid
        : (typeof startUuid === 'string' ? startUuid : undefined),
      endUuid: toolType === 'codex'
        ? runtimeEndUuid
        : (typeof endUuid === 'string' ? endUuid : undefined),
      additionalPrompt: typeof additionalPrompt === 'string' ? additionalPrompt : undefined,
    });
    console.log('[MobRewind:Scenario] AI compact ready tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' len=' + pasteAfter.length);
  }
  if (toolType !== 'codex') {
    await ensureAgentReadyForRewind({
      tabId,
      toolType,
      runtime,
      sessionId,
      cwd: tab?.cwd,
    });
  } else {
    preparedCodex = await revalidatePreparedCodexRewindRuntime({
      tabId,
      prepared: preparedCodex!,
      cwd: tab?.cwd,
      targetIndex,
      sourceTargetUuid: startUuid,
      sourceEndUuid: rewindMode === 'ai' ? endUuid : null,
      targetFullText,
      rewindableCount,
    });
  }
  const result = await ipcRenderer.invoke(channel, {
    tabId,
    targetIndex,
    targetText,
    targetFullText,
    targetUuid: runtimeTargetUuid,
    writerSessionId: preparedCodex?.writerSessionId || null,
    writerAuthorization: preparedCodex?.writerAuthorization || null,
    writerLaunchId: preparedCodex?.writerLaunchId || null,
    rewindableCount,
    skipDuplicates,
    pasteAfter,
    deadlineMs: rewindMode === 'ai' ? 170_000 : 16_000,
  });
  if (result?.success && rewindMode === 'native' && toolType === 'claude' && result.historyInputDraft === true) {
    const targetDraft = String(result.historyDraftText || targetFullText || targetText || '').trim();
    if (targetDraft) {
      const store = useUIStore.getState();
      const historyDraftImages: HistoryPromptDraftImageRef[] = Array.isArray(result.historyDraftImages)
        ? result.historyDraftImages
        : [];
      store.setHistoryPromptDraft(tabId, targetDraft, historyDraftImages.length > 0 ? { images: historyDraftImages } : undefined);
      if (typeof startUuid === 'string' && startUuid.trim()) {
        const opId = Date.now().toString(36) + '-' + startUuid.slice(0, 8);
        store.setHistoryRewindPreview(tabId, {
          opId,
          targetUuid: startUuid,
          targetText: targetDraft,
          startedAt: Date.now(),
          sessionId,
        });
        window.dispatchEvent(new CustomEvent('history-panel:rewind-log', {
          detail: {
            tabId,
            opId,
            status: 'done',
            targetUuid: startUuid,
            targetText: targetDraft,
            mode: rewindMode,
            toolType,
            historyInputDraft: true,
            historyDraftText: targetDraft,
            historyDraftImages,
            historyDraftWarning: typeof result.historyDraftWarning === 'string' ? result.historyDraftWarning : undefined,
          },
        }));
      }
    }
  }
  return {
    tabId,
    toolType,
    mode: rewindMode,
    compactPasted: !!pasteAfter,
    compactLength: pasteAfter?.length || 0,
    runtimeSessionId: preparedCodex?.writerSessionId,
    writerRelation: preparedCodex?.writerRelation,
    writerLineageDepth: preparedCodex?.lineageDepth || undefined,
    ...(result || {}),
  };
}
