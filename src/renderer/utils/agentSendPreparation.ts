import type {
  AgentDraftInspection,
  AgentHistoryTool,
  AgentPtyStatus,
  HistoryAgentRuntime,
} from './historyAgentRuntimes';
import type { AgentSendProviderContract } from './agentSendProviderContract';
import { terminalRegistry } from './terminalRegistry';
import { useUIStore } from '../store/useUIStore';
import {
  applyAgentDraftCaptureResolution,
  buildExactDraftCaptureProof,
  classifyAgentDraftPreflight,
  resolveAgentDraftConflict,
} from './agentDraftPreflight.mjs';
import {
  createCoordinatedAgentSendCancellationWait,
  isCoordinatedAgentSendCancellationRequested,
} from './agentActionCoordinator.mjs';
import { showAgentDraftScreenContradictionToast } from './agentDraftContradictionToast.mjs';
import { draftTransferResultFields, readAgentDraftTransfer } from './agentDraftTransfer.mjs';
import sendTargetContract from '../../shared/agent-send-target-precondition.cjs';
import manualActionContract from '../../shared/agent-manual-action.cjs';

const { createAgentSendTargetExpectation, resolveReadyAgentSendTarget } = sendTargetContract;

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

const needsExactDraftCapture = (visual: any, decision: any) => (
  decision?.decision === 'conflict'
  || (decision?.decision === 'unknown' && visual?.exactCaptureRecommended === true)
);

const isFrameChangedBeforeExactCapture = (captured: any) => (
  captured?.success === false
  && captured?.error === 'claude_draft_state_unknown_before_paste'
  && captured?.proofReason === 'claude-current-frame-changed-before-exact-capture'
);

async function captureDraftWithOneCommittedFrameRefresh({
  tabId,
  runtime,
  providerContract,
  initialVisual,
  mode,
  reason,
  assertSendNotCancelled,
}: {
  tabId: string;
  runtime: HistoryAgentRuntime;
  providerContract: AgentSendProviderContract;
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
    try {
      assertSendNotCancelled();
    } catch (error) {
      // Cancellation cannot discard a native draft already withdrawn by this
      // request. Carry the complete transfer through the ordinary send error.
      Object.assign(error as object, draftTransferResultFields(captured, tabId));
      throw error;
    }
    if (
      !providerContract.retryExactCaptureAfterCommittedFrame
      || !isFrameChangedBeforeExactCapture(captured)
      || attempt > 0
      || !runtime.probeDraft
    ) {
      return { visual, decision, captured, attemptedCapture: true };
    }

    visual = await runtime.probeDraft(tabId, reason + ':committed-frame-refresh');
    assertSendNotCancelled();
    decision = classifyAgentDraftPreflight(visual);
  }
  return { visual, decision, captured: null, attemptedCapture: false };
}

export function createAgentReadyWait(
  tabId: string,
  runtime: HistoryAgentRuntime,
  timeoutMs = 30000,
  purpose = 'ready',
) {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    // Both callers own an absolute deadline and re-read presence on every
    // wake. The deadline must wake that last read too: an event can be lost
    // while the composer has already become ready. This wake grants nothing.
    const timer = setTimeout(finish, timeoutMs);
    const handler = (_event: any, data: { tabId?: string } = {}) => {
      if (data?.tabId !== tabId) return;
      finish();
    };
    const readinessChanged = (_event: any, data: { tabId?: string; toolType?: string } = {}) => {
      if (data?.toolType !== runtime.toolType) return;
      handler(_event, data);
    };
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    cleanup = () => {
      clearTimeout(timer);
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      if (runtime.readyEvent) ipcRenderer.removeListener(runtime.readyEvent, handler);
      ipcRenderer.removeListener('agent:readiness-changed', readinessChanged);
    };
    ipcRenderer.on('agent:readiness-changed', readinessChanged);
    if (!runtime.readyEvent) {
      fallbackTimer = setTimeout(finish, Math.min(500, timeoutMs));
    } else {
      ipcRenderer.on(runtime.readyEvent, handler);
    }
  });
  return { promise, cancel: () => cleanup() };
}

export async function prepareAgentRuntimeForSend({
  tabId,
  runtime,
  providerContract,
  sessionId,
  cwd,
  coordinatedSendToken,
  requestedStatusAtSend,
  resumePausedGoal,
  requireLive = false,
  sendOperationKey,
  sendAttemptId,
}: {
  tabId: string;
  runtime: HistoryAgentRuntime;
  providerContract: AgentSendProviderContract;
  sessionId?: string | null;
  cwd?: string;
  coordinatedSendToken?: number | null;
  requestedStatusAtSend?: AgentPtyStatus;
  resumePausedGoal?: boolean;
  requireLive?: boolean;
  sendOperationKey?: string | null;
  sendAttemptId?: string | null;
}) {
  const expectedTarget = createAgentSendTargetExpectation(runtime.toolType, sessionId);
  const assertSendNotCancelled = () => {
    if (
      coordinatedSendToken
      && isCoordinatedAgentSendCancellationRequested(tabId, coordinatedSendToken)
    ) {
      throw new Error('Send cancelled before terminal submission');
    }
    const action = runtime.toolType === 'codex' ? manualActionContract.describeAgentManualAction(presence) : null;
    if (action) throw Object.assign(new Error(action.message), action, {
      submitted: false, pasteWritten: false, enterWritten: false,
    });
  };
  const waitStartupGate = async () => {
    await providerContract.waitForStartupGate(tabId, 'agent-send');
    assertSendNotCancelled();
  };
  let presence = await runtime.getPresence(tabId).catch((err: any) => {
    console.warn('[AgentScenario:send] presence failed before send tool=' + runtime.toolType
      + ' tab=' + String(tabId).slice(-12) + ' ' + (err?.message || err));
    return null;
  });
  assertSendNotCancelled();
  if (presence && ['active', 'busy', 'starting'].includes(presence.status)) {
    resolveReadyAgentSendTarget(expectedTarget, presence, runtime.toolType);
  }
  const resolved = (
    status: Extract<AgentPtyStatus, 'active' | 'busy'>,
    submitCapability: 'direct' | 'queue',
  ) => ({
    status,
    presence,
    submitCapability,
    expectedTarget: resolveReadyAgentSendTarget(expectedTarget, presence, runtime.toolType),
  });
  console.log('[AgentScenario:send] presence before tool=' + runtime.toolType
    + ' tab=' + String(tabId).slice(-12)
    + ' status=' + (presence?.status || 'unknown')
    + ' inputReady=' + !!presence?.inputReady
    + ' busy=' + !!presence?.isBusy);
  const submitCapability = () => providerContract.classifySubmitCapability(presence);
  if (presence?.status === 'stopping') {
    throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
  }
  if (submitCapability() === 'queue') return resolved('busy', 'queue');
  if (submitCapability() === 'direct') {
    await waitStartupGate();
    presence = await runtime.getPresence(tabId).catch(() => null);
    assertSendNotCancelled();
    if (presence?.status === 'stopping') {
      throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
    }
    if (submitCapability() === 'queue') return resolved('busy', 'queue');
    if (submitCapability() === 'direct') return resolved('active', 'direct');
  }
  if (providerContract.allowUnmountedActiveComposer
    && presence?.status === 'active'
    && !presence?.inputReady
    && sessionId
    && runtime.inspectDraft) {
    const draftState = runtime.inspectDraft(tabId);
    if (draftState?.source === 'no-terminal' && !terminalRegistry.get(tabId)) {
      console.log('[AgentScenario:send] renderer terminal not mounted; continue with PTY/audit path tool='
        + runtime.toolType + ' tab=' + String(tabId).slice(-12));
      return resolved('active', 'direct');
    }
  }

  const launchAlreadyInProgress = requestedStatusAtSend === 'starting';
  if (presence?.status === 'inactive' && !launchAlreadyInProgress) {
    if (requireLive) throw Object.assign(new Error('Automatic continuation cannot restart a stopped session'), {
      code: 'agent_auto_continue_not_live',
    });
    const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
    const actionLabel = hasSession ? 'resume' : 'start-fresh';
    if (!hasSession && !runtime.startFresh) {
      throw new Error(runtime.label + ' session is inactive and cannot start fresh');
    }
    console.log('[AgentScenario:send] ' + actionLabel + ' before send tool=' + runtime.toolType
      + ' tab=' + String(tabId).slice(-12));
    const resumeResult = hasSession
      ? await runtime.resume({ tabId, sessionId, cwd, resumePausedGoal })
      : await runtime.startFresh!({ tabId, cwd, sendOperationKey, sendAttemptId });
    if (resumeResult?.success === false) {
      if ((resumeResult as any).code === 'agent_send_binding_changed' || (resumeResult as any).code === 'agent_send_owner_launch_changed') {
        throw Object.assign(new Error(resumeResult.error || 'Conversation owner changed'), resumeResult);
      }
      // Another History/API/Queue intent may have won launch admission between
      // our presence read and this call. A rejected launch is terminal only if
      // a fresh authoritative read still proves the process inactive. Unknown
      // waits for the already-armed readiness path; it never authorizes a
      // second lifecycle mutation.
      const afterRejectedLaunch = await runtime.getPresence(tabId).catch(() => null);
      assertSendNotCancelled();
      if (afterRejectedLaunch?.status === 'inactive') {
        throw new Error(resumeResult.error || runtime.label + ' ' + actionLabel + ' failed before send');
      }
      presence = afterRejectedLaunch;
      console.warn('[AgentScenario:send] ' + actionLabel + ' refused but owner is no longer proven inactive tool='
        + runtime.toolType
        + ' tab=' + String(tabId).slice(-12)
        + ' status=' + (presence?.status || 'unknown')
        + ' action=wait-existing-launch');
    }
    assertSendNotCancelled();
  } else if (presence?.status === 'inactive' && launchAlreadyInProgress) {
    console.log('[AgentScenario:send] wait for existing launch tool=' + runtime.toolType
      + ' tab=' + String(tabId).slice(-12)
      + ' presence=' + (presence?.status || 'unknown'));
  } else if (!presence || presence.status === 'unknown') {
    console.warn('[AgentScenario:send] owner state unknown; wait without launch tool=' + runtime.toolType
      + ' tab=' + String(tabId).slice(-12));
  }

  const deadline = Date.now() + 30000;
  const readinessTimeout = () => Object.assign(
    new Error(runtime.label + ' session is not ready for send'),
    { code: 'agent_send_readiness_timeout', submitted: false, pasteWritten: false,
      readinessStatus: presence?.status || 'unknown',
      readinessReason: presence?.lastNotReady?.reason || 'no-ready-proof',
      sendReceipt: { success: false, accepted: false, submitted: false,
        pasteWritten: false, enterWritten: false, code: 'agent_send_readiness_timeout' } },
  );
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
      if (presence && ['active', 'busy', 'starting'].includes(presence.status)) {
        resolveReadyAgentSendTarget(expectedTarget, presence, runtime.toolType);
      }
      if (pass > 0) {
        console.log('[AgentScenario:send] presence after wait tool=' + runtime.toolType
          + ' tab=' + String(tabId).slice(-12)
          + ' pass=' + pass
          + ' status=' + (presence?.status || 'unknown')
          + ' inputReady=' + !!presence?.inputReady
          + ' busy=' + !!presence?.isBusy);
      }
      if (providerContract.startupGateOwnsComposer(presence)) {
        await waitStartupGate();
        presence = await runtime.getPresence(tabId).catch(() => null);
        assertSendNotCancelled();
        if (presence?.status === 'stopping') {
          throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
        }
        if (submitCapability() === 'queue') return resolved('busy', 'queue');
        if (submitCapability() === 'direct') return resolved('active', 'direct');
        if (remainingMs <= 0) throw readinessTimeout();
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
      if (submitCapability() === 'queue') return resolved('busy', 'queue');
      if (submitCapability() === 'direct') {
        readyWait.cancel();
        await waitStartupGate();
        presence = await runtime.getPresence(tabId).catch(() => null);
        assertSendNotCancelled();
        if (presence?.status === 'stopping') {
          throw new Error(runtime.label + ' is stopping; wait until the current loader finishes before send');
        }
        if (submitCapability() === 'queue') return resolved('busy', 'queue');
        if (submitCapability() === 'direct') return resolved('active', 'direct');
      }
      if (remainingMs <= 0) throw readinessTimeout();
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

export async function proveAgentComposerForSend({
  tabId,
  toolType,
  runtime,
  providerContract,
  statusForSend,
  source,
  returnDraftOnConflict,
  initialExactEmptyEvidence,
  assertSendNotCancelled,
}: {
  tabId: string;
  toolType: AgentHistoryTool;
  runtime: HistoryAgentRuntime;
  providerContract: AgentSendProviderContract;
  statusForSend?: AgentPtyStatus;
  source?: string;
  returnDraftOnConflict?: boolean;
  initialExactEmptyEvidence?: Record<string, unknown> | null;
  assertSendNotCancelled: () => void;
}) {
  const canInspectDraft = !!runtime.probeDraft || !!runtime.inspectDraft;
  let exactEmptyEvidence = providerContract.carriesExactEmptyEvidence
    ? (initialExactEmptyEvidence || null)
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
        runtime,
        providerContract,
        initialVisual: visual,
        mode: captureMode,
        reason: 'agent-send-preflight:' + (source || 'unknown'),
        assertSendNotCancelled,
      });
      visual = capture.visual;
      draftDecision = capture.decision;
      if (capture.attemptedCapture) {
        const captured = capture.captured;
        const transferred = captureMode === 'grab' ? readAgentDraftTransfer(captured, tabId) : null;
        if (transferred && (transferred.text || transferred.images > 0 || captured?.success !== true)) {
          return {
            complete: true,
            result: {
              tabId, toolType, success: false, ok: false, submitted: false, accepted: false,
              code: 'terminal_draft_conflict',
              error: captured?.success === true ? 'Terminal has an unsent draft' : captured?.error || 'Terminal return is unconfirmed',
              ...draftTransferResultFields(captured, tabId),
              draftPreview: visual.preview || '', draftSource: visual.source || '',
              editorReturnReady: captured?.editorReturnReady === true,
            },
          };
        }
        const conflict = resolveAgentDraftConflict(visual, captured, { attemptedCapture: true });
        if (conflict.decision === 'capture-failed' && captureMode === 'grab') {
          return {
            complete: true,
            result: {
              tabId, toolType, success: false, ok: false, submitted: false, accepted: false,
              code: 'terminal_draft_grab_failed', error: conflict.error,
              draftPreview: visual.preview || '', draftSource: visual.source || '',
            },
          };
        }
        if (conflict.decision === 'clear') {
          draftDecision = applyAgentDraftCaptureResolution(draftDecision, conflict);
          if (providerContract.carriesExactEmptyEvidence) exactEmptyEvidence = captured;
          showAgentDraftScreenContradictionToast(useUIStore.getState(), {
            tabId,
            label: runtime.label,
            screenProof: visual,
            exactCapture: captured,
          });
        } else if (!String(conflict.draftText || '').trim() && Number(conflict.draftImages || 0) === 0) {
          return {
            complete: true,
            result: {
              tabId, toolType, success: false, ok: false, submitted: false, accepted: false,
              code: 'terminal_draft_state_unknown',
              error: conflict.reason || 'Terminal draft state could not be proven',
              draftPreview: visual.preview || '', draftSource: visual.source || '',
            },
          };
        } else {
          return {
            complete: true,
            result: {
              tabId, toolType, success: false, ok: false, submitted: false, accepted: false,
              code: 'terminal_draft_conflict', error: 'Terminal has an unsent draft',
              draftText: captureMode === 'grab' ? conflict.draftText : '',
              draftPreview: visual.preview || '', draftSource: visual.source || '',
              draftImages: captureMode === 'grab' ? conflict.draftImages : 0,
              draftImagePaths: captureMode === 'grab' && Array.isArray(captured?.imagePaths) ? captured.imagePaths : [],
            },
          };
        }
      }
    }
    if (draftDecision.decision === 'unknown') {
      return {
        complete: true,
        result: {
          tabId, toolType, success: false, ok: false, submitted: false, accepted: false,
          code: 'terminal_draft_state_unknown',
          error: 'Terminal draft state is unknown; send stopped before touching input',
          draftPreview: visual.preview || '', draftSource: visual.source || '',
          proofOutcome: visual.proofOutcome || 'unknown', proofReason: draftDecision.reason,
        },
      };
    }
  }

  const refreshExactEmptyEvidence = providerContract.carriesExactEmptyEvidence && canInspectDraft
    ? async () => {
        let visual = runtime.probeDraft
          ? await runtime.probeDraft(tabId, 'agent-send-post-settings-proof:' + (source || 'unknown'))
          : runtime.inspectDraft!(tabId);
        assertSendNotCancelled();
        let draftDecision = classifyAgentDraftPreflight(visual);
        if (needsExactDraftCapture(visual, draftDecision)) {
          const capture = await captureDraftWithOneCommittedFrameRefresh({
            tabId,
            runtime,
            providerContract,
            initialVisual: visual,
            mode: 'copy',
            reason: 'agent-send-post-settings-proof:' + (source || 'unknown'),
            assertSendNotCancelled,
          });
          visual = capture.visual;
          draftDecision = capture.decision;
          if (!capture.attemptedCapture) {
            return draftDecision.decision === 'clear'
              ? { success: true, evidence: null }
              : { success: false, code: 'terminal_draft_state_unknown', error: runtime.label + ' composer state is unknown after settings changed' };
          }
          const captured = capture.captured;
          const conflict = resolveAgentDraftConflict(visual, captured, { attemptedCapture: true });
          if (conflict.decision === 'clear') {
            showAgentDraftScreenContradictionToast(useUIStore.getState(), {
              tabId,
              label: runtime.label,
              screenProof: visual,
              exactCapture: captured,
            });
            return { success: true, evidence: captured };
          }
          if (String(conflict.draftText || '').trim() || Number(conflict.draftImages || 0) > 0) {
            return { success: false, code: 'terminal_draft_conflict', error: 'Terminal has an unsent draft after settings changed' };
          }
          return {
            success: false,
            code: 'terminal_draft_state_unknown',
            error: conflict.error || conflict.reason || runtime.label + ' composer state is unknown after settings changed',
          };
        }
        if (draftDecision.decision === 'unknown') {
          return { success: false, code: 'terminal_draft_state_unknown', error: runtime.label + ' composer state is unknown after settings changed' };
        }
        return { success: true, evidence: null };
      }
    : undefined;

  return {
    complete: false,
    exactEmptyEvidence,
    refreshExactEmptyEvidence,
  };
}
