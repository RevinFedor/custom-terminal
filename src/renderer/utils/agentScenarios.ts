import type {
  AgentDraftInspection,
  AgentHistoryTool,
  AgentPtyStatus,
  HistoryAgentRuntime,
} from './historyAgentRuntimes';
import { waitForClaudeStartupDefaultsReadyWithVisibleFallback } from './claudeStartupDefaultsReady';
import { useUIStore, type HistoryPromptDraftImageRef } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { requireCommittedCodexRewind } from './codexRewindCommit';
import { requireConfirmedCodexWriter } from './codexWriterIdentity';
import { selectRewindOperation } from '../store/rewindOperationState';
import { useRewindOperationStore } from '../store/useRewindOperationStore';
import {
  cancelCoordinatedAgentSendFollowers,
  getCoordinatedAgentSendCancellation,
  settleCoordinatedAgentSend,
} from './agentActionCoordinator.mjs';
import { runAgentSendFlow } from './agentSendFlow.mjs';
import { createAgentReadyWait } from './agentSendPreparation';
import { createAgentSendAdapter } from './agentSendAdapter';
import {
  agentSendSettingsContractError,
  type AgentHistoryRestartSettings,
  type AgentSettingsIntent,
} from './agentSendSettingsContract';
import { buildClaudeRewindPromptProjection } from './composerChips.mjs';
import { enqueueAgentSendScenario } from './agentSendSequencer.mjs';
import { prepareTabWorkContext, settleTabWorkContext, activateTabWorkContext } from './tabWorkContext';

const { ipcRenderer } = window.require('electron');

export interface SendAgentPromptScenarioArgs {
  workContextPrepared?: boolean;
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  sessionId?: string | null;
  cwd?: string;
  prompt: string;
  handoffId?: string;
  sendAttemptId?: string | null;
  sendOperationKey?: string | null;
  source?: string;
  promptQueueAction?: 'send-now';
  statusAtSend?: string;
  queue?: boolean;
  requireLive?: boolean;
  // Required discriminant: every caller must say whether this prompt carries
  // an explicit settings mutation. Ambient display/launch values have no field
  // here and therefore cannot accidentally reach a provider picker.
  settingsIntent: AgentSettingsIntent;
  // Separate lifecycle evidence used only by record-without-reply. It can be
  // written into/reopened with history but is never interpreted as a request
  // to mutate the live provider before this prompt.
  historyRestartSettings?: AgentHistoryRestartSettings;
  returnDraftOnConflict?: boolean;
  initialComposerProof?: Record<string, unknown> | null;
  coordinatedSendToken?: number | null;
  // Explicit alternate gesture: stop the provider, persist the immutable
  // authoring snapshot into model-visible history WITHOUT a model turn, then
  // reopen that exact session and wait for an idle composer.
  recordWithoutReply?: boolean;
  onRestartPhase?: (phase: 'stopping' | 'starting') => void;
  onHistoryRecorded?: (result: any) => void | Promise<void>;
  onReadyForSend?: (status: Extract<AgentPtyStatus, 'active' | 'busy'>) => void;
  presentationSnapshot?: {
    historySessionId?: string | null;
    imagePaths?: HistoryPromptDraftImageRef[];
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

interface AgentSendFlowContext {
  complete?: boolean;
  result?: any;
  historyContextResult: any;
  restartPerformed: boolean;
  restartSessionId?: string | null;
  requestedStatusAtClick?: AgentPtyStatus;
  requestedStatusForSend?: AgentPtyStatus;
  recordWithoutReply: boolean;
}

interface AgentSendReadyContext {
  status: Extract<AgentPtyStatus, 'active' | 'busy'>;
  submitCapability: 'direct' | 'queue';
  runtimeSnapshot: unknown;
  expectedTarget?: import('./historyAgentRuntimes').AgentSendTarget;
}

interface AgentSendComposerContext {
  complete: false;
  exactEmptyEvidence?: Record<string, unknown> | null;
  refreshExactEmptyEvidence?: () => Promise<any>;
}

const normalizeStatus = (value: unknown): AgentPtyStatus | undefined => {
  return value === 'active' || value === 'busy' || value === 'inactive' || value === 'starting' || value === 'stopping' || value === 'unknown'
    ? value
    : undefined;
};

async function runAgentPromptScenario({
  tabId,
  toolType,
  runtime,
  sessionId,
  cwd,
  prompt,
  handoffId,
  sendAttemptId,
  sendOperationKey,
  source,
  promptQueueAction,
  statusAtSend,
  queue,
  requireLive,
  settingsIntent,
  historyRestartSettings,
  returnDraftOnConflict,
  initialComposerProof,
  coordinatedSendToken,
  recordWithoutReply,
  onRestartPhase,
  onHistoryRecorded,
  onReadyForSend,
  presentationSnapshot,
}: SendAgentPromptScenarioArgs): Promise<any> {
  const assertSendNotCancelled = () => {
    if (coordinatedSendToken) {
      const cancellation = getCoordinatedAgentSendCancellation(tabId, coordinatedSendToken);
      if (cancellation) {
        throw Object.assign(
          new Error('Send cancelled before terminal submission'),
          {
            coordinatedCancelReason: cancellation.cancelReason,
            cascadeRestoreByToken: cancellation.cascadeRestoreByToken,
            cascadeRestoreBatched: cancellation.cascadeRestoreBatched === true,
          },
        );
      }
    }
  };
  const adapter = createAgentSendAdapter({
    tabId,
    toolType,
    runtime,
    assertSendNotCancelled,
  });
  const requestedStatusAtClick = normalizeStatus(statusAtSend);
  const settingsContractError = agentSendSettingsContractError({
    toolType,
    recordWithoutReply,
    settingsIntent,
    historyRestartSettings,
  });
  if (settingsContractError) {
    return {
      success: false,
      accepted: false,
      submitted: false,
      pasteWritten: false,
      code: 'agent_send_settings_contract_invalid',
      error: settingsContractError,
    };
  }
  return runAgentSendFlow({
    prepareContext: async () => {
      const prepared = await adapter.prepareRecordContext({
        enabled: recordWithoutReply === true,
        sessionId,
        cwd,
        prompt,
        handoffId,
        source,
        historyRestartSettings,
        presentationSnapshot,
        coordinatedSendToken,
        requestedStatusAtClick,
        onRestartPhase,
        onHistoryRecorded,
      });
      if (prepared.complete) return { complete: true, result: prepared.result };
      return {
        ...prepared,
        requestedStatusAtClick,
        // After an explicit record-context Stop, click-time `starting` is stale.
        requestedStatusForSend: recordWithoutReply === true ? 'inactive' : requestedStatusAtClick,
        recordWithoutReply: recordWithoutReply === true,
      };
    },
    ensureReady: async (context: AgentSendFlowContext): Promise<AgentSendReadyContext> => {
      const readyForSend = await adapter.ensureReady({
        sessionId: context.recordWithoutReply ? context.restartSessionId : sessionId,
        cwd,
        coordinatedSendToken,
        requestedStatusAtSend: context.requestedStatusForSend,
        resumePausedGoal: context.recordWithoutReply ? false : undefined,
        requireLive,
      });
      const statusForSend = readyForSend.status;
      if (!context.recordWithoutReply) assertSendNotCancelled();
      if (statusForSend === 'active' || statusForSend === 'busy') {
        onReadyForSend?.(statusForSend);
      }
      if (context.requestedStatusForSend
        && statusForSend
        && context.requestedStatusForSend !== statusForSend) {
        console.log('[AgentScenario:send] status override tool=' + toolType
          + ' tab=' + String(tabId).slice(-12)
          + ' requested=' + context.requestedStatusForSend
          + ' effective=' + statusForSend);
      }
      return {
        status: statusForSend,
        submitCapability: readyForSend.submitCapability,
        runtimeSnapshot: readyForSend?.presence?.runtimeSnapshot || null,
        expectedTarget: readyForSend.expectedTarget,
      };
    },
    recoverReadyFailure: async (error: any, context: AgentSendFlowContext) => {
      if (!context.recordWithoutReply || context.historyContextResult?.historyRecorded !== true) {
        throw error;
      }
      return {
        complete: true,
        result: {
          ...context.historyContextResult,
          success: true,
          requestedStatusAtSend: requestedStatusAtClick,
          effectiveStatusAtSend: 'inactive',
          recordWithoutReply: true,
          restartPerformed: context.restartPerformed,
          restartSessionId: context.restartSessionId,
          reopened: false,
          reopenWarning: String(error?.message || error),
        },
      };
    },
    finishAfterReady: async (context: AgentSendFlowContext, ready: AgentSendReadyContext) => context.recordWithoutReply
      ? {
          complete: true,
          result: {
            ...(context.historyContextResult || {}),
            requestedStatusAtSend: requestedStatusAtClick,
            effectiveStatusAtSend: ready.status,
            recordWithoutReply: true,
            restartPerformed: context.restartPerformed,
            restartSessionId: context.restartSessionId,
            reopened: true,
          },
        }
      : { complete: false },
    proveComposer: async (_context: AgentSendFlowContext, ready: AgentSendReadyContext) => {
      const composer = await adapter.proveComposer({
        statusForSend: ready.status,
        source,
        returnDraftOnConflict,
        initialExactEmptyEvidence: initialComposerProof,
      });
      if (composer.complete === true) {
        return {
          complete: true,
          result: { ...(composer.result || {}), originalPrompt: prompt },
        };
      }
      return composer as AgentSendComposerContext;
    },
    runProviderOperation: async (
      context: AgentSendFlowContext,
      ready: AgentSendReadyContext,
      composer: AgentSendComposerContext,
    ) => {
      assertSendNotCancelled();
      const result = await adapter.runProviderOperation({
        prompt,
        handoffId,
        sendAttemptId,
        sendOperationKey,
        source,
        promptQueueAction,
        statusForSend: ready.status,
        submitCapability: queue === true ? 'queue' : ready.submitCapability,
        settingsIntent,
        runtimeSnapshot: ready.runtimeSnapshot,
        expectedTarget: ready.expectedTarget,
        composer,
        presentationSnapshot,
      });
      return {
        ...(result || {}),
        requestedStatusAtSend: requestedStatusAtClick,
        effectiveStatusAtSend: ready.status,
        recordWithoutReply: false,
        restartPerformed: context.restartPerformed,
        restartSessionId: undefined,
      };
    },
  });
}

export function sendAgentPromptScenario(
  args: SendAgentPromptScenarioArgs,
): Promise<any> {
  if (!args.handoffId) args = { ...args, handoffId: 'context-send:' + crypto.randomUUID() };
  return enqueueAgentSendScenario({
    tabId: args.tabId,
    handoffId: args.handoffId,
    run: async () => {
      let result: any = null;
      let failure: any = null;
      try {
        const context = args.handoffId && args.workContextPrepared !== true
          ? await prepareTabWorkContext(args.tabId, args.handoffId, args.prompt)
          : { prompt: args.prompt };
        if (args.handoffId) await activateTabWorkContext(args.tabId, args.handoffId);
        result = await runAgentPromptScenario({ ...args, prompt: context.prompt });
        await settleTabWorkContext(args.tabId, args.handoffId, result);
      } catch (error: any) {
        failure = error;
        if (error?.submitted === false) await settleTabWorkContext(args.tabId, args.handoffId, error);
        if (
          args.recordWithoutReply === true
          && args.coordinatedSendToken
          && error?.historyContextResult?.accepted !== true
        ) {
          const cascade = cancelCoordinatedAgentSendFollowers(
            args.tabId,
            args.coordinatedSendToken,
            'history-context-not-recorded',
          );
          failure.cancelledFollowerHandoffIds = cascade.handoffIds || [];
          failure.cascadeRestoreOwnerToken = args.coordinatedSendToken;
        }
      }
      let coordinatedSettlement: any = null;
      if (args.coordinatedSendToken) {
        coordinatedSettlement = await settleCoordinatedAgentSend({
          tabId: args.tabId,
          token: args.coordinatedSendToken,
          runQueuedStop: () => stopAgentProcessScenario({
            tabId: args.tabId,
            toolType: args.toolType,
            runtime: args.runtime,
            reason: 'queued-stop-after-send',
          }),
        });
      }
      // The FIFO lane must not release the next intent until this exact
      // coordinator token is settled; otherwise the follower starts while the
      // previous token is still the Stop owner.
      if (failure) {
        failure.coordinatedSettlement = coordinatedSettlement;
        throw failure;
      }
      return { ...(result || {}), coordinatedSettlement };
    },
  });
}

export async function stopAgentProcessScenario({
  tabId,
  toolType,
  runtime,
  reason,
  authority,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  reason?: string | null;
  authority?: Record<string, unknown> | null;
}): Promise<any> {
  const r = await runtime.stopProcess(tabId, { reason, authority });
  return { tabId, toolType, stopped: !!r?.success, ...(r || {}) };
}

export async function interruptAgentTurnScenario({
  tabId,
  toolType,
  runtime,
  busy,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  // Callers that know the live turn state pass it through so a runtime can
  // refuse an interrupt whose keystroke means something else when idle.
  // Unknown (undefined) keeps the previous behaviour.
  busy?: boolean;
}): any {
  const result = await runtime.interruptTurn(tabId, { busy });
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
  let result: AgentDraftInspection = runtime.inspectDraft
    ? runtime.inspectDraft(tabId)
    : { hasDraft: null, preview: '', source: 'unsupported' };
  if (result?.source === 'no-terminal') {
    result = {
      ...result,
      mountedForInspect: false,
      debug: [result?.debug, 'mount=not-mounted focus=preserved'].filter(Boolean).join(' '),
    };
  }
  return { tabId, toolType, ...(result || {}) };
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

  const deadline = Date.now() + 30000;
  let resumedForRewind = false;
  let launchedThisCall = false;
  if (!presence || presence.status === 'inactive') {
    resumedForRewind = true;
    launchedThisCall = true;
    console.log('[AgentScenario:rewind] resume before rewind tool=' + toolType + ' tab=' + String(tabId).slice(-12));
    const resumeResult = await runtime.resume({ tabId, sessionId, cwd });
    if (resumeResult?.success === false) {
      throw new Error(resumeResult.error || runtime.label + ' resume failed before rewind');
    }
  }

  // Re-arming readiness loop: a ready event is a wake hint, not truth — a
  // startup blocker can revoke it right after emission. Each pass re-arms the
  // listener BEFORE probing so no edge is lost, and a revoked ready simply
  // waits for the re-emitted one. Only the deadline fails the wait.
  for (let pass = 0; ; pass += 1) {
    const remainingMs = deadline - Date.now();
    const readyWait = createAgentReadyWait(tabId, runtime, Math.max(1, remainingMs), 'rewind');
    try {
      presence = await runtime.getPresence(tabId).catch(() => null);
      if (pass > 0) {
        console.log('[AgentScenario:rewind] presence after wait tool=' + toolType
          + ' tab=' + String(tabId).slice(-12)
          + ' pass=' + pass
          + ' status=' + (presence?.status || 'unknown')
          + ' inputReady=' + !!presence?.inputReady
          + ' busy=' + !!presence?.isBusy);
      }
      if (presence?.status === 'stopping' || presence?.status === 'busy') {
        throw new Error(getAgentRewindBlockedMessage(runtime, presence?.status));
      }
      if (presence?.status === 'starting' && !launchedThisCall) {
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
      if (remainingMs <= 0) {
        throw new Error(runtime.label + ' session is not ready for rewind');
      }
      await readyWait.promise;
    } finally {
      readyWait.cancel();
    }
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
  const sameLaunchStrengthening = prepared.writerAuthorization === 'provisional-resume-source'
    && authorization?.authorization === 'confirmed-writer'
    && !!prepared.writerLaunchId
    && authorization.launchId === prepared.writerLaunchId;
  if (authorization?.success !== true
    || authorization.writerSessionId !== prepared.writerSessionId
    || (authorization.authorization !== prepared.writerAuthorization && !sameLaunchStrengthening)
    || (prepared.writerAuthorization === 'provisional-resume-source'
      && authorization.launchId !== prepared.writerLaunchId)) {
    throw new Error(authorization?.error || 'Codex writer changed while Rewind was being prepared; reload Timeline and repeat');
  }
  if (authorization.authorization === 'confirmed-writer') {
    await requireConfirmedCodexWriter({
      tabId,
      expectedSessionId: prepared.writerSessionId,
      operation: 'Rewind',
    });
  }
  const turnState = authorization.turnState
    || await ipcRenderer.invoke('codex:get-turn-state', tabId).catch(() => null);
  const turnIdentityReady = authorization.authorization === 'provisional-resume-source'
    ? turnState?.provisional === true && !turnState?.sessionId
    : turnState?.sessionId === prepared.writerSessionId;
  if (!turnState
    || turnState.hasWatcher !== true
    || !turnIdentityReady
    || turnState.catchUpPending === true
    || turnState.busy !== false) {
    throw new Error('Codex turn state is not confirmed idle; wait and repeat Rewind');
  }
  return {
    ...prepared, lineageDepth: mapped.lineageDepth,
    writerAuthorization: authorization.authorization,
    writerLaunchId: authorization.launchId || null,
  };
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
  targetEntryRef,
  expectedContentRevision,
  targetSourceIdentity,
  additionalPrompt,
  buildAiRewindText,
  restoreDraft = true,
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
  targetEntryRef?: ({
    viewOwnerSessionId?: string;
    contentRevision?: string;
    sourceIdentity?: string;
  } & Record<string, unknown>) | null;
  expectedContentRevision?: string | null;
  targetSourceIdentity?: string | null;
  additionalPrompt?: string | null;
  restoreDraft?: boolean;
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
  const normalizedTargetIndex = Number.isFinite(Number(targetIndex)) ? Number(targetIndex) : 0;
  const normalizedTargetUuid = typeof startUuid === 'string' && startUuid.trim()
    ? startUuid.trim()
    : 'timeline-index:' + String(normalizedTargetIndex);
  const normalizedTargetText = String(targetFullText || targetText || '').trim();
  const targetMenuText = toolType === 'claude'
    ? buildClaudeRewindPromptProjection(normalizedTargetText).menuText
    : String(targetText || normalizedTargetText).trim();
  const opId = 'scenario-' + Date.now().toString(36)
    + '-' + normalizedTargetUuid.slice(0, 8)
    + '-' + Math.random().toString(36).slice(2, 8);
  const operationStore = useRewindOperationStore.getState();
  const began = operationStore.begin({
    tabId,
    opId,
    toolType,
    mode: rewindMode,
    sourceSessionId: sessionId,
    targetUuid: normalizedTargetUuid,
    targetText: normalizedTargetText,
    targetIndex: normalizedTargetIndex,
    phase: 'preparing',
    message: runtime.label + ' Rewind: preparing...',
  });
  if (!began) {
    return {
      tabId,
      toolType,
      mode: rewindMode,
      opId,
      success: false,
      code: 'rewind_already_in_progress',
      error: 'Rewind is already in progress for this tab',
    };
  }

  const getOwnedOperation = () => {
    const state = useRewindOperationStore.getState();
    return state.activeOpIdByTab[tabId] === opId
      ? selectRewindOperation(state, tabId, opId)
      : null;
  };
  const canContinuePreparation = () => {
    const operation = getOwnedOperation();
    return !!operation
      && operation.phase !== 'cancelling'
      && operation.phase !== 'committing'
      && operation.phase !== 'done';
  };
  const staleResult = (extra: Record<string, unknown> = {}) => ({
    tabId,
    toolType,
    mode: rewindMode,
    opId,
    success: false,
    cancelled: true,
    stale: true,
    error: 'rewind_operation_no_longer_active',
    ...extra,
  });
  const emitHistoryRewindLog = (
    status: 'start' | 'done' | 'failed',
    options: {
      error?: string;
      message?: string;
      persisted?: boolean;
      historyInputDraft?: boolean;
      historyDraftText?: string;
      historyDraftImages?: HistoryPromptDraftImageRef[];
      historyDraftWarning?: string;
      writerGeneration?: string;
    } = {},
  ) => {
    window.dispatchEvent(new CustomEvent('history-panel:rewind-log', {
      detail: {
        tabId,
        opId,
        status,
        targetUuid: normalizedTargetUuid,
        targetText: normalizedTargetText,
        mode: rewindMode,
        toolType,
        sourceSessionId: sessionId || null,
        error: options.error,
        message: options.message,
        persisted: options.persisted,
        historyInputDraft: options.historyInputDraft,
        historyDraftText: options.historyDraftText,
        historyDraftImages: options.historyDraftImages,
        historyDraftWarning: options.historyDraftWarning,
        writerGeneration: options.writerGeneration,
      },
    }));
  };
  const clearOwnedFailure = (error: unknown): boolean => {
    const message = String((error as any)?.message || error || 'Rewind failed');
    const cleared = useRewindOperationStore.getState().clear(tabId, opId);
    if (cleared) emitHistoryRewindLog('failed', { error: message });
    return cleared;
  };

  emitHistoryRewindLog('start', { message: runtime.label + ' Rewind: preparing...' });

  let preparedCodex: PreparedCodexRewindRuntime | null = null;
  let runtimeTargetUuid = startUuid || undefined;
  let runtimeEndUuid = endUuid || undefined;

  try {
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
      if (!canContinuePreparation()) return staleResult();
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
      if (!useRewindOperationStore.getState().setPhase(
        tabId,
        opId,
        'compacting',
        'Building the compact text for Rewind',
      )) return staleResult();
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
      if (!canContinuePreparation()) return staleResult();
      console.log('[MobRewind:Scenario] AI compact ready tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' len=' + pasteAfter.length);
    }

    if (!useRewindOperationStore.getState().setPhase(
      tabId,
      opId,
      'preparing',
      runtime.label + ' Rewind: verifying the active session...',
    )) return staleResult();
    if (toolType !== 'codex') {
      await ensureAgentReadyForRewind({
        tabId,
        toolType,
        runtime,
        sessionId,
        cwd: tab?.cwd,
      });
      if (!canContinuePreparation()) return staleResult();
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
      if (!canContinuePreparation()) return staleResult();
    }

    if (!canContinuePreparation()) return staleResult();
    if (!useRewindOperationStore.getState().setPhase(
      tabId,
      opId,
      'rewinding',
      runtime.label + ' Rewind: applying...',
    )) return staleResult();
    // There is intentionally no await between this ownership marker and the
    // destructive IPC. Cancel can distinguish local preparation from a request
    // that has already crossed into the runtime.
    if (!useRewindOperationStore.getState().markRuntimeStarted(tabId, opId)) {
      return staleResult();
    }
    const result = await ipcRenderer.invoke(channel, {
      tabId,
      opId,
      viewOwnerSessionId: targetEntryRef?.viewOwnerSessionId || sessionId,
      expectedContentRevision: expectedContentRevision || targetEntryRef?.contentRevision || null,
      targetEntryRef: targetEntryRef || null,
      targetSourceIdentity: targetSourceIdentity || targetEntryRef?.sourceIdentity || null,
      targetIndex,
      targetText: targetMenuText,
      targetMenuText,
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

    // The runtime result is authoritative. A locally requested cancellation
    // does not turn a committed success into a cancellation.
    if (result?.cancelled === true) {
      const cleared = useRewindOperationStore.getState().clear(tabId, opId);
      if (cleared) {
        emitHistoryRewindLog('failed', {
          error: String(result.error || 'Rewind cancelled'),
          message: 'Rewind cancelled',
        });
      }
      return {
        tabId,
        toolType,
        mode: rewindMode,
        opId,
        compactPasted: !!pasteAfter,
        compactLength: pasteAfter?.length || 0,
        runtimeSessionId: preparedCodex?.writerSessionId,
        writerRelation: preparedCodex?.writerRelation,
        writerLineageDepth: preparedCodex?.lineageDepth || undefined,
        ...(result || {}),
      };
    }
    if (!result || result.success === false) {
      const failureMessage = String(result?.error || result?.message || 'Rewind failed');
      clearOwnedFailure(failureMessage);
      return {
        tabId,
        toolType,
        mode: rewindMode,
        opId,
        compactPasted: !!pasteAfter,
        compactLength: pasteAfter?.length || 0,
        runtimeSessionId: preparedCodex?.writerSessionId,
        writerRelation: preparedCodex?.writerRelation,
        writerLineageDepth: preparedCodex?.lineageDepth || undefined,
        ...(result || {}),
        success: false,
        error: failureMessage,
      };
    }
    if (!getOwnedOperation()) {
      return staleResult({
        runtimeSessionId: preparedCodex?.writerSessionId,
        runtimeSuccess: true,
      });
    }

    let codexWriterChanged = false;
    let activeSessionId = typeof result.activeSessionId === 'string'
      ? result.activeSessionId
      : (preparedCodex?.writerSessionId || sessionId);
    if (toolType === 'codex') {
      const committed = requireCommittedCodexRewind(
        result,
        useWorkspaceStore.getState().getCodexSessionId(tabId),
      );
      codexWriterChanged = committed.writerChanged;
      activeSessionId = committed.activeSessionId;
      if (committed.writerChanged) {
        const adopted = await useWorkspaceStore.getState().setCodexSessionId(
          tabId,
          committed.activeSessionId,
          'detected',
        );
        if (!adopted) {
          throw new Error('Новая ветка Codex сохранена, но вкладка не смогла на неё переключиться');
        }
      }
      if (!getOwnedOperation()) {
        return staleResult({
          runtimeSessionId: preparedCodex?.writerSessionId,
          runtimeSuccess: true,
        });
      }
    }
    const completed = useRewindOperationStore.getState().complete(tabId, opId, activeSessionId);
    if (!completed) {
      return staleResult({
        runtimeSessionId: preparedCodex?.writerSessionId,
        runtimeSuccess: true,
      });
    }

    const historyDraftImages: HistoryPromptDraftImageRef[] = Array.isArray(result.historyDraftImages)
      ? result.historyDraftImages
      : [];
    const targetDraft = String(result.historyDraftText || targetFullText || targetText || '').trim();
    const historyProjectionPersisted = toolType === 'codex'
      ? codexWriterChanged
      : result.persisted === true || result.bindingCommitted === true;
    if (
      rewindMode === 'native'
      && (toolType === 'claude' || toolType === 'codex')
      && result.historyInputDraft === true
      && targetDraft
    ) {
      const store = useUIStore.getState();
      if (restoreDraft) {
        store.setHistoryPromptDraft(
          tabId,
          targetDraft,
          historyDraftImages.length > 0 ? { images: historyDraftImages } : undefined,
        );
      }
      if (!historyProjectionPersisted && typeof startUuid === 'string' && startUuid.trim()) {
        store.setHistoryRewindPreview(tabId, {
          opId,
          targetUuid: startUuid,
          targetText: targetDraft,
          startedAt: Date.now(),
          sessionId,
          writerGeneration: typeof result.handoffGeneration === 'string'
            ? result.handoffGeneration
            : undefined,
        });
      }
    }

    emitHistoryRewindLog('done', {
      persisted: toolType === 'codex'
        ? codexWriterChanged
        : historyProjectionPersisted || rewindMode === 'ai',
      historyInputDraft: result.historyInputDraft === true,
      restoreDraft,
      historyDraftText: targetDraft || undefined,
      historyDraftImages: historyDraftImages.length > 0 ? historyDraftImages : undefined,
      historyDraftWarning: typeof result.historyDraftWarning === 'string'
        ? result.historyDraftWarning
        : undefined,
      writerGeneration: typeof result.handoffGeneration === 'string'
        ? result.handoffGeneration
        : undefined,
    });
    setTimeout(() => {
      useRewindOperationStore.getState().clear(tabId, opId);
    }, 1200);

    return {
      tabId,
      toolType,
      mode: rewindMode,
      opId,
      compactPasted: !!pasteAfter,
      compactLength: pasteAfter?.length || 0,
      runtimeSessionId: preparedCodex?.writerSessionId,
      writerRelation: preparedCodex?.writerRelation,
      writerLineageDepth: preparedCodex?.lineageDepth || undefined,
      ...(result || {}),
    };
  } catch (error) {
    if (!clearOwnedFailure(error)) {
      return staleResult({
        caughtError: String((error as any)?.message || error),
      });
    }
    throw error;
  }
}
