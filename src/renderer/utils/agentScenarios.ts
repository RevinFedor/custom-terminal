import type {
  AgentDraftInspection,
  AgentHistoryTool,
  AgentPtyStatus,
  HistoryAgentRuntime,
} from './historyAgentRuntimes';
import { waitForClaudeStartupDefaultsReadyWithVisibleFallback } from './claudeStartupDefaultsReady';
import { terminalRegistry } from './terminalRegistry';
import { useUIStore, type HistoryPromptDraftImageRef } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { requireCommittedCodexRewind } from './codexRewindCommit';
import { requireConfirmedCodexWriter } from './codexWriterIdentity';
import { selectRewindOperation } from '../store/rewindOperationState';
import { useRewindOperationStore } from '../store/useRewindOperationStore';
import {
  cancelCoordinatedAgentSendFollowers,
  createCoordinatedAgentSendCancellationWait,
  getCoordinatedAgentSendCancellation,
  isCoordinatedAgentSendCancellationRequested,
  settleCoordinatedAgentSend,
} from './agentActionCoordinator.mjs';
import {
  applyAgentDraftCaptureResolution,
  buildExactDraftCaptureProof,
  classifyAgentDraftPreflight,
  resolveAgentDraftConflict,
} from './agentDraftPreflight.mjs';
import { buildClaudeRewindPromptProjection } from './composerChips.mjs';
import { enqueueAgentSendScenario } from './agentSendSequencer.mjs';
import { showAgentDraftScreenContradictionToast } from './agentDraftContradictionToast.mjs';
import { getCodexRuntimeReadSessionId } from './codexPtyPresence.mjs';

const { ipcRenderer } = window.require('electron');

const buildDraftCaptureProof = (tabId: string, proof: AgentDraftInspection) => (
  buildExactDraftCaptureProof(
    proof,
    terminalRegistry.getDraftDiagnosticSnapshot(tabId, {
      promptRow: (proof as any)?.promptRow,
      cursorRow: (proof as any)?.cursorRow,
    }),
  )
);

export interface SendAgentPromptScenarioArgs {
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
  statusAtSend?: string;
  queue?: boolean;
  model?: string;
  effort?: string;
  thinking?: string;
  returnDraftOnConflict?: boolean;
  claudeExactEmptyEvidence?: Record<string, unknown> | null;
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
      source: 'loop';
    }>;
  };
}

const normalizeStatus = (value: unknown): AgentPtyStatus | undefined => {
  return value === 'active' || value === 'busy' || value === 'inactive' || value === 'starting' || value === 'stopping' || value === 'unknown'
    ? value
    : undefined;
};

const needsExactDraftCapture = (visual: any, decision: any) => (
  decision?.decision === 'conflict'
  || (decision?.decision === 'unknown' && visual?.exactCaptureRecommended === true)
);

const isClaudeFrameChangedBeforeExactCapture = (captured: any) => (
  captured?.success === false
  && captured?.error === 'claude_draft_state_unknown_before_paste'
  && captured?.proofReason === 'claude-current-frame-changed-before-exact-capture'
);

async function captureDraftWithOneCommittedFrameRefresh({
  tabId,
  toolType,
  runtime,
  initialVisual,
  mode,
  reason,
  assertSendNotCancelled,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  initialVisual: any;
  mode: 'copy' | 'grab';
  reason: string;
  assertSendNotCancelled: () => void;
}) {
  let visual = initialVisual;
  let decision = classifyAgentDraftPreflight(visual);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!needsExactDraftCapture(visual, decision)) {
      return { visual, decision, captured: null, attemptedCapture: false };
    }
    const captured = mode === 'grab'
      ? await runtime.grabDraft(tabId, {
          draftProof: buildDraftCaptureProof(tabId, visual),
        })
      : await runtime.copyDraft(tabId, {
          draftProof: buildDraftCaptureProof(tabId, visual),
        });
    assertSendNotCancelled();
    if (
      toolType !== 'claude'
      || !isClaudeFrameChangedBeforeExactCapture(captured)
      || attempt > 0
      || !runtime.probeDraft
    ) {
      return { visual, decision, captured, attemptedCapture: true };
    }

    // Process discovery may itself cause Claude to publish a newer complete
    // TUI frame. Re-prove that exact frame once inside the same serialized send
    // scenario; no input has been touched yet, so this preserves the original
    // intent without weakening the empty-composer proof.
    visual = await runtime.probeDraft(tabId, reason + ':committed-frame-refresh');
    assertSendNotCancelled();
    decision = classifyAgentDraftPreflight(visual);
  }
  return { visual, decision, captured: null, attemptedCapture: false };
}

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
  statusAtSend,
  queue,
  model,
  effort,
  thinking,
  returnDraftOnConflict,
  claudeExactEmptyEvidence,
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
  const requestedStatusAtClick = normalizeStatus(statusAtSend);
  let restartPerformed = false;
  let restartSessionId = sessionId;
  let historySessionAuthority: 'live-writer' | 'history-hint' | 'fresh' = sessionId
    ? 'history-hint'
    : 'fresh';
  let historyContextResult: any = null;
  if (recordWithoutReply === true) {
    let presence = await runtime.getPresence(tabId).catch((err: any) => {
      console.warn('[AgentScenario:record-context] presence failed before stop tool=' + toolType
        + ' tab=' + String(tabId).slice(-12) + ' ' + (err?.message || err));
      return null;
    });
    assertSendNotCancelled();
    if (!presence || presence.status === 'unknown') {
      throw new Error(runtime.label + ' status could not be verified before recording context');
    }
    if (presence.status === 'stopping') {
      throw new Error(runtime.label + ' is already stopping; wait before recording context');
    }
    if (presence.status === 'busy' || presence.status === 'starting') {
      throw new Error(runtime.label + ' must be idle before recording context');
    }
    const livePresence = presence.status === 'active'
      || presence.status === 'busy'
      || presence.status === 'starting';
    if (livePresence) {
      const provenLiveSessionId = presence.sessionId
        || (toolType === 'codex'
          ? getCodexRuntimeReadSessionId(presence.runtimeSnapshot)
          : null);
      if (provenLiveSessionId) {
        restartSessionId = provenLiveSessionId;
        historySessionAuthority = 'live-writer';
      } else if (
        !sessionId
        || (toolType === 'claude' && presence.conversationMaterialized === false)
      ) {
        restartSessionId = null;
        historySessionAuthority = 'fresh';
      } else {
        throw new Error(runtime.label + ' live writer session could not be verified before recording context');
      }
    }
    if (toolType === 'claude' && restartSessionId) {
      const conversationMaterialized = presence.conversationMaterialized === true
        || presence.canResume === true;
      const conversationProvenFresh = presence.conversationMaterialized === false
        && presence.canResume !== true;
      if (!conversationMaterialized && !conversationProvenFresh) {
        throw new Error('Claude conversation state could not be verified before recording context');
      }
      restartSessionId = conversationMaterialized ? restartSessionId : null;
      if (!restartSessionId) historySessionAuthority = 'fresh';
    }
    if (presence.status === 'active' || presence.status === 'busy' || presence.status === 'starting') {
      onRestartPhase?.('stopping');
      console.log('[AgentScenario:record-context] stop tool=' + toolType
        + ' tab=' + String(tabId).slice(-12)
        + ' status=' + presence.status);
      const stopped = await stopAgentProcessScenario({
        tabId,
        toolType,
        runtime,
        reason: 'record-history-context',
      });
      assertSendNotCancelled();
      if (stopped?.success === false) {
        // A concurrent clean exit may win the stop request. Accept it only
        // after a fresh authoritative presence read proves the process gone.
        presence = await runtime.getPresence(tabId).catch(() => null);
        if (presence?.status !== 'inactive') {
          throw new Error(stopped?.error || runtime.label + ' could not stop before recording context');
        }
      }
      restartPerformed = true;
    }
    onRestartPhase?.('starting');
    assertSendNotCancelled();
    historyContextResult = await runtime.recordHistoryContext(tabId, prompt, {
      sessionId: restartSessionId,
      sessionAuthority: historySessionAuthority,
      cwd,
      handoffId,
      source,
      model,
      effort,
      presentationSnapshot,
    });
    if (historyContextResult?.success === false && historyContextResult?.accepted !== true) {
      throw Object.assign(
        new Error(historyContextResult?.error || 'History context was not recorded'),
        { historyContextResult },
      );
    }
    restartSessionId = historyContextResult?.sessionId || null;
    if (!restartSessionId) {
      if (coordinatedSendToken) {
          cancelCoordinatedAgentSendFollowers(
            tabId,
            coordinatedSendToken,
            'history-context-session-unresolved',
            Date.now(),
            { cascadeRestore: false },
        );
      }
      return {
        ...(historyContextResult || {}),
        requestedStatusAtSend: requestedStatusAtClick,
        effectiveStatusAtSend: 'inactive',
        recordWithoutReply: true,
        restartPerformed,
        restartSessionId: null,
        reopened: false,
      };
    }
    if (toolType === 'codex') {
      const adopted = await useWorkspaceStore.getState().setCodexSessionId(
        tabId,
        restartSessionId,
        'historyContext',
      );
      if (!adopted) {
        if (coordinatedSendToken) {
          cancelCoordinatedAgentSendFollowers(
            tabId,
            coordinatedSendToken,
            'history-context-session-not-adopted',
            Date.now(),
            { cascadeRestore: false },
          );
        }
        return {
          ...historyContextResult,
          success: true,
          requestedStatusAtSend: requestedStatusAtClick,
          effectiveStatusAtSend: 'inactive',
          recordWithoutReply: true,
          restartPerformed,
          restartSessionId,
          reopened: false,
          reopenWarning: 'Codex history was recorded, but the tab could not adopt the new session',
        };
      }
    } else {
      useWorkspaceStore.getState().setClaudeSessionId(
        tabId,
        restartSessionId,
        'historyContext',
      );
    }
    if (historyContextResult?.historyRecorded === true) {
      await onHistoryRecorded?.(historyContextResult);
    }
  }
  // After the explicit stop, `starting` from the click-time snapshot is stale.
  const requestedStatusForSend = recordWithoutReply === true
    ? 'inactive'
    : requestedStatusAtClick;
  let statusForSend: AgentPtyStatus | undefined;
  let runtimeSnapshotForSend: any = null;
  try {
    const readyForSend = await ensureAgentReadyForSend({
      tabId,
      toolType,
      runtime,
      sessionId: recordWithoutReply === true ? restartSessionId : sessionId,
      cwd,
      coordinatedSendToken,
      requestedStatusAtSend: requestedStatusForSend,
      resumePausedGoal: recordWithoutReply === true ? false : undefined,
    });
    statusForSend = readyForSend?.status || requestedStatusForSend;
    runtimeSnapshotForSend = readyForSend?.presence?.runtimeSnapshot || null;
  } catch (error: any) {
    if (recordWithoutReply === true && historyContextResult?.historyRecorded === true) {
      return {
        ...historyContextResult,
        success: true,
        requestedStatusAtSend: requestedStatusAtClick,
        effectiveStatusAtSend: 'inactive',
        recordWithoutReply: true,
        restartPerformed,
        restartSessionId,
        reopened: false,
        reopenWarning: String(error?.message || error),
      };
    }
    throw error;
  }
  if (recordWithoutReply !== true) assertSendNotCancelled();
  if (statusForSend === 'active' || statusForSend === 'busy') {
    onReadyForSend?.(statusForSend);
  }
  if (requestedStatusForSend && statusForSend && requestedStatusForSend !== statusForSend) {
    console.log('[AgentScenario:send] status override tool=' + toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' requested=' + requestedStatusForSend
      + ' effective=' + statusForSend);
  }
  if (recordWithoutReply === true) {
    return {
      ...(historyContextResult || {}),
      requestedStatusAtSend: requestedStatusAtClick,
      effectiveStatusAtSend: statusForSend,
      recordWithoutReply: true,
      restartPerformed,
      restartSessionId,
      reopened: true,
    };
  }

  const canInspectDraft = !!runtime.probeDraft || !!runtime.inspectDraft;
  let exactEmptyEvidenceForSend = toolType === 'claude'
    ? (claudeExactEmptyEvidence || null)
    : null;
  if ((statusForSend === 'active' || statusForSend === 'busy') && canInspectDraft) {
    let visual = runtime.probeDraft
      ? await runtime.probeDraft(tabId, 'agent-send-preflight:' + (source || 'unknown'))
      : runtime.inspectDraft!(tabId);
    assertSendNotCancelled();
    let draftDecision = classifyAgentDraftPreflight(visual);
    if (needsExactDraftCapture(visual, draftDecision)) {
      const captureMode = returnDraftOnConflict === true ? 'grab' : 'copy';
      const capture = await captureDraftWithOneCommittedFrameRefresh({
        tabId,
        toolType,
        runtime,
        initialVisual: visual,
        mode: captureMode,
        reason: 'agent-send-preflight:' + (source || 'unknown'),
        assertSendNotCancelled,
      });
      visual = capture.visual;
      draftDecision = capture.decision;
      if (!capture.attemptedCapture) {
        // A refreshed committed frame can itself become an exact clear/unknown
        // verdict. Let the ordinary decision below consume that newer proof.
      } else {
        const captured = capture.captured;
        const conflict = resolveAgentDraftConflict(visual, captured, {
          attemptedCapture: true,
        });
        if (conflict.decision === 'capture-failed' && captureMode === 'grab') {
          return {
            tabId,
            toolType,
            success: false,
            ok: false,
            submitted: false,
            accepted: false,
            code: 'terminal_draft_grab_failed',
            error: conflict.error,
            draftPreview: visual.preview || '',
            draftSource: visual.source || '',
            originalPrompt: prompt,
          };
        }
        if (conflict.decision === 'clear') {
          draftDecision = applyAgentDraftCaptureResolution(draftDecision, conflict);
          if (toolType === 'claude') exactEmptyEvidenceForSend = captured;
          showAgentDraftScreenContradictionToast(useUIStore.getState(), {
            tabId,
            label: runtime.label,
          });
          console.warn('[AgentScenario:send] screen draft false-positive resolved by exact empty Ctrl+G'
            + ' tool=' + toolType
            + ' tab=' + String(tabId).slice(-12)
            + ' mode=' + captureMode
            + ' reason=' + conflict.reason);
        } else {
          if (!String(conflict.draftText || '').trim() && Number(conflict.draftImages || 0) === 0) {
            return {
              tabId,
              toolType,
              success: false,
              ok: false,
              submitted: false,
              accepted: false,
              code: 'terminal_draft_state_unknown',
              error: conflict.reason || 'Terminal draft state could not be proven',
              draftPreview: visual.preview || '',
              draftSource: visual.source || '',
              originalPrompt: prompt,
            };
          }
          return {
            tabId,
            toolType,
            success: false,
            ok: false,
            submitted: false,
            accepted: false,
            code: 'terminal_draft_conflict',
            error: 'Terminal has an unsent draft',
            draftText: captureMode === 'grab' ? conflict.draftText : '',
            draftPreview: visual.preview || '',
            draftSource: visual.source || '',
            draftImages: captureMode === 'grab' ? conflict.draftImages : 0,
            originalPrompt: prompt,
          };
        }
      }
    }
    if (draftDecision.decision === 'unknown') {
      return {
        tabId,
        toolType,
        success: false,
        ok: false,
        submitted: false,
        accepted: false,
        code: 'terminal_draft_state_unknown',
        error: 'Terminal draft state is unknown; send stopped before touching input',
        draftPreview: visual.preview || '',
        draftSource: visual.source || '',
        proofOutcome: visual.proofOutcome || 'unknown',
        proofReason: draftDecision.reason,
        originalPrompt: prompt,
      };
    }
  }

  const refreshClaudeExactEmptyEvidence = toolType === 'claude' && canInspectDraft
    ? async () => {
        let visual = runtime.probeDraft
          ? await runtime.probeDraft(
              tabId,
              'agent-send-post-settings-proof:' + (source || 'unknown'),
            )
          : runtime.inspectDraft!(tabId);
        assertSendNotCancelled();
        let draftDecision = classifyAgentDraftPreflight(visual);
        if (needsExactDraftCapture(visual, draftDecision)) {
          const capture = await captureDraftWithOneCommittedFrameRefresh({
            tabId,
            toolType,
            runtime,
            initialVisual: visual,
            mode: 'copy',
            reason: 'agent-send-post-settings-proof:' + (source || 'unknown'),
            assertSendNotCancelled,
          });
          visual = capture.visual;
          draftDecision = capture.decision;
          if (!capture.attemptedCapture) {
            if (draftDecision.decision === 'clear') {
              return { success: true, evidence: null };
            }
            return {
              success: false,
              code: 'terminal_draft_state_unknown',
              error: 'Claude composer state is unknown after settings changed',
            };
          }
          const captured = capture.captured;
          const conflict = resolveAgentDraftConflict(visual, captured, {
            attemptedCapture: true,
          });
          if (conflict.decision === 'clear') {
            draftDecision = applyAgentDraftCaptureResolution(draftDecision, conflict);
            showAgentDraftScreenContradictionToast(useUIStore.getState(), {
              tabId,
              label: runtime.label,
            });
            return { success: true, evidence: captured };
          }
          if (String(conflict.draftText || '').trim() || Number(conflict.draftImages || 0) > 0) {
            return {
              success: false,
              code: 'terminal_draft_conflict',
              error: 'Terminal has an unsent draft after Claude settings changed',
            };
          }
          return {
            success: false,
            code: 'terminal_draft_state_unknown',
            error: conflict.error || conflict.reason || 'Claude composer state is unknown after settings changed',
          };
        }
        if (draftDecision.decision === 'unknown') {
          return {
            success: false,
            code: 'terminal_draft_state_unknown',
            error: 'Claude composer state is unknown after settings changed',
          };
        }
        return { success: true, evidence: null };
      }
    : undefined;

  assertSendNotCancelled();
  const effectivePresentationSnapshot = presentationSnapshot;
  const result = await runtime.sendPrompt(tabId, prompt, {
    handoffId: typeof handoffId === 'string' ? handoffId : undefined,
    sendAttemptId: typeof sendAttemptId === 'string' ? sendAttemptId : undefined,
    sendOperationKey: typeof sendOperationKey === 'string' ? sendOperationKey : undefined,
    source: typeof source === 'string' ? source : 'mobile-native',
    statusAtSend: statusForSend,
    queue: queue === true || statusForSend === 'busy',
    model: typeof model === 'string' ? model : undefined,
    effort: typeof effort === 'string' ? effort : undefined,
    thinking: typeof thinking === 'string' ? thinking : undefined,
    runtimeSnapshot: runtimeSnapshotForSend,
    claudeExactEmptyEvidence: exactEmptyEvidenceForSend,
    refreshClaudeExactEmptyEvidence,
    presentationSnapshot: effectivePresentationSnapshot,
    ...(toolType === 'claude' ? { assertNotCancelled: assertSendNotCancelled } : {}),
  });
  return {
    ...(result || {}),
    requestedStatusAtSend: requestedStatusAtClick,
    effectiveStatusAtSend: statusForSend,
    recordWithoutReply: false,
    restartPerformed,
    restartSessionId: undefined,
  };
}

export function sendAgentPromptScenario(
  args: SendAgentPromptScenarioArgs,
): Promise<any> {
  return enqueueAgentSendScenario({
    tabId: args.tabId,
    handoffId: args.handoffId,
    run: async () => {
      let result: any = null;
      let failure: any = null;
      try {
        result = await runAgentPromptScenario(args);
      } catch (error: any) {
        failure = error;
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

export function interruptAgentTurnScenario({
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
  const result = runtime.interruptTurn(tabId, { busy });
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

// One-shot wake-up on the runtime's ready event. A ready signal is a WAKE
// HINT, not readiness truth: Codex can emit tui-ready and revoke it ~70ms
// later when an MCP-startup blocker appears, then emit a fresh ready after
// startup completes. Callers therefore drive this from a re-arming loop
// (arm listener → check presence → sleep) so a revoked signal fails one
// check and the next armed wait catches the re-emitted ready. The deadline
// is the only failure edge.
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
      // No push signal for this runtime: resolve after a short pause so the
      // caller's re-arming loop becomes a paced presence poll instead of a
      // zero-delay busy-spin for the whole deadline.
      setTimeout(() => finish(), Math.min(500, timeoutMs));
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
  coordinatedSendToken,
  requestedStatusAtSend,
  resumePausedGoal,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  sessionId?: string | null;
  cwd?: string;
  coordinatedSendToken?: number | null;
  requestedStatusAtSend?: AgentPtyStatus;
  resumePausedGoal?: boolean;
}) {
  const assertSendNotCancelled = () => {
    if (
      coordinatedSendToken
      && isCoordinatedAgentSendCancellationRequested(tabId, coordinatedSendToken)
    ) {
      throw new Error('Send cancelled before terminal submission');
    }
  };
  const waitStartupDefaultsIfNeeded = async () => {
    if (toolType === 'claude') await waitForClaudeStartupDefaultsReadyWithVisibleFallback(tabId, 15000, 'agent-send');
    assertSendNotCancelled();
  };
  let presence = await runtime.getPresence(tabId).catch((err: any) => {
    console.warn('[AgentScenario:send] presence failed before send tool=' + toolType + ' tab=' + String(tabId).slice(-12) + ' ' + (err?.message || err));
    return null;
  });
  assertSendNotCancelled();
  const resolved = (status: AgentPtyStatus) => ({ status, presence });
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
  if (presence?.status === 'busy') return resolved('busy');
  if (isReadyComposer()) {
    await waitStartupDefaultsIfNeeded();
    presence = await runtime.getPresence(tabId).catch(() => null);
    assertSendNotCancelled();
    if (presence?.status === 'stopping') {
      throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
    }
    if (presence?.status === 'busy') return resolved('busy');
    if (isReadyComposer()) return resolved('active');
  }
  if (presence?.status === 'active' && !presence?.inputReady && sessionId && runtime.inspectDraft) {
    const draftState = runtime.inspectDraft(tabId);
    if (draftState?.source === 'no-terminal' && !terminalRegistry.get(tabId)) {
      console.log('[AgentScenario:send] renderer terminal not mounted; continue with PTY/audit path tool='
        + toolType + ' tab=' + String(tabId).slice(-12));
      return resolved('active');
    }
  }

  const launchAlreadyInProgress = requestedStatusAtSend === 'starting';
  if ((!presence || presence.status === 'inactive') && !launchAlreadyInProgress) {
    const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
    const actionLabel = hasSession ? 'resume' : 'start-fresh';
    if (!hasSession && !runtime.startFresh) {
      throw new Error(runtime.label + ' session is inactive and cannot start fresh');
    }
    console.log('[AgentScenario:send] ' + actionLabel + ' before send tool=' + toolType + ' tab=' + String(tabId).slice(-12));
    const resumeResult = hasSession
      ? await runtime.resume({ tabId, sessionId, cwd, resumePausedGoal })
      : await runtime.startFresh!({ tabId, cwd });
    if (resumeResult?.success === false) {
      throw new Error(resumeResult.error || runtime.label + ' ' + actionLabel + ' failed before send');
    }
    assertSendNotCancelled();
  } else if ((!presence || presence.status === 'inactive') && launchAlreadyInProgress) {
    console.log('[AgentScenario:send] wait for existing launch tool=' + toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' presence=' + (presence?.status || 'unknown'));
  }

  // Re-arming readiness loop. Enter is one submit intent: the scenario owns
  // Start/Resume → readiness → submit and must survive a REVOKED ready
  // signal. Codex emits tui-ready, can invalidate it ~70ms later on an
  // MCP-startup blocker, then emits a fresh ready when startup completes.
  // The old single-listener wait consumed the revoked signal, saw
  // starting/inputReady=false once and rolled the send back — the proven
  // "Enter needs a second press" bug (production 21:30 + two E2E repros).
  // Each pass arms the listener BEFORE probing so no edge is lost; only the
  // deadline fails the wait.
  const deadline = Date.now() + 30000;
  for (let pass = 0; ; pass += 1) {
    assertSendNotCancelled();
    const remainingMs = deadline - Date.now();
    const readyWait = createAgentReadyWait(tabId, runtime, Math.max(1, remainingMs), 'send');
    const cancellationWait = coordinatedSendToken
      ? createCoordinatedAgentSendCancellationWait(tabId, coordinatedSendToken)
      : null;
    try {
      presence = await runtime.getPresence(tabId).catch(() => null);
      assertSendNotCancelled();
      if (pass > 0) {
        console.log('[AgentScenario:send] presence after wait tool=' + toolType
          + ' tab=' + String(tabId).slice(-12)
          + ' pass=' + pass
          + ' status=' + (presence?.status || 'unknown')
          + ' inputReady=' + !!presence?.inputReady
          + ' busy=' + !!presence?.isBusy);
      }
      if (toolType === 'claude' && presence?.status === 'starting') {
        // The first Claude prompt glyph is only a wake-up hint. Startup can
        // still own the composer with /model or /effort, so wait for the exact
        // launch gate and then re-read one coherent presence snapshot.
        await waitStartupDefaultsIfNeeded();
        presence = await runtime.getPresence(tabId).catch(() => null);
        assertSendNotCancelled();
        if (presence?.status === 'stopping') {
          throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
        }
        if (presence?.status === 'busy') return resolved('busy');
        if (isReadyComposer()) return resolved('active');
        if (remainingMs <= 0) {
          throw new Error(runtime.label + ' session is not ready for send');
        }
        // Startup defaults may finish before the lifecycle publishes the next
        // complete composer frame. Keep this pass's already-armed listener and
        // sleep on that event; an immediate `continue` here spins thousands of
        // presence reads while Claude is legitimately still starting.
        if (cancellationWait) {
          const outcome = await Promise.race([
            readyWait.promise.then(() => 'ready'),
            cancellationWait.promise.then(() => 'cancelled'),
          ]);
          if (outcome === 'cancelled') assertSendNotCancelled();
        } else {
          await readyWait.promise;
        }
        continue;
      }
      if (presence?.status === 'stopping') {
        throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
      }
      if (presence?.status === 'busy') return resolved('busy');
      if (isReadyComposer()) {
        readyWait.cancel();
        await waitStartupDefaultsIfNeeded();
        presence = await runtime.getPresence(tabId).catch(() => null);
        assertSendNotCancelled();
        if (presence?.status === 'stopping') {
          throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
        }
        if (presence?.status === 'busy') return resolved('busy');
        if (isReadyComposer()) return resolved('active');
      }
      if (remainingMs <= 0) {
        throw new Error(runtime.label + ' session is not ready for send');
      }
      if (cancellationWait) {
        const outcome = await Promise.race([
          readyWait.promise.then(() => 'ready'),
          cancellationWait.promise.then(() => 'cancelled'),
        ]);
        if (outcome === 'cancelled') assertSendNotCancelled();
      } else {
        await readyWait.promise;
      }
    } finally {
      readyWait.cancel();
      cancellationWait?.cancel();
    }
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
      store.setHistoryPromptDraft(
        tabId,
        targetDraft,
        historyDraftImages.length > 0 ? { images: historyDraftImages } : undefined,
      );
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
