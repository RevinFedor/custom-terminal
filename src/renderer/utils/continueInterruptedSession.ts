// Одна операция автоматического восстановления прерванной PTY-сессии.
// UI-модалки и ручной Continue-step больше нет: App запускает этот flow строго
// последовательно для точного shutdown-набора, а tab-owned lifecycle surface
// показывает pending/ready/error. Обычный Resume намеренно остановленной
// сессии остаётся отдельным действием ControlBar.

import { terminalRegistry } from './terminalRegistry';
import { clearPendingResume, markPendingResume } from './pendingResume';
import { buildCodexRunPayload } from './codexLaunch';
import { createAgentLaunchAdmission } from './agentLaunchAdmission.mjs';
import { resolvePtyAgentOwner } from './ptyAgentOwner.mjs';
import {
  classifyInterruptedRestoreRuntime,
  isTransientInterruptedRestoreAdmission,
} from './interruptedAutoRestore.mjs';

const { ipcRenderer } = window.require('electron');

export type InterruptedEngine = 'claude' | 'codex';

export type InterruptedResumeResult = {
  success: boolean;
  accepted: boolean;
  ready: boolean;
  settled: boolean;
  suppressed?: boolean;
  alreadyRestored?: boolean;
  error?: string | null;
  detail?: string | null;
  launch?: any;
  runtime?: any;
};

// Защита от повторного запуска — на всё приложение, по вкладке. Sequential
// boot queue уже не пересекает свои элементы, но обычный Resume/API может
// прийти параллельно и обязан join/reject, а не записать вторую команду.
const resumeInflight = new Set<string>();

const COLLISION_ERRORS = new Set([
  'shell_not_idle',
  'codex_already_running',
  'claude_already_running',
  'foreground_command_running',
]);

function interruptedReadyOwner(engine: InterruptedEngine, snapshot: any) {
  return {
    launchId: snapshot?.launchId || snapshot?.writerLaunchId || snapshot?.launchGeneration || null,
    // Claude admits its launch before the first shell OSC-B advances runSeq.
    // Its launch token is stable across that same-launch transition; Codex
    // already preclaims its command generation before returning admission.
    ...(engine === 'codex' ? { lifecycleGeneration: snapshot?.lifecycleGeneration || null } : {}),
  };
}

function matchesInterruptedReadyOwner(engine: InterruptedEngine, expected: any, snapshot: any) {
  const current = interruptedReadyOwner(engine, snapshot);
  return !!expected?.launchId
    && current.launchId === expected.launchId
    && (!expected.lifecycleGeneration || current.lifecycleGeneration === expected.lifecycleGeneration)
    && snapshot?.liveLifecycle !== false;
}

async function readInterruptedRuntime({
  tabId,
  projectId,
  engine,
}: {
  tabId: string;
  projectId: string;
  engine: InterruptedEngine;
}) {
  if (engine === 'codex') {
    return await ipcRenderer.invoke('codex:get-runtime-projection', { tabId, projectId });
  }
  return await ipcRenderer.invoke('claude:get-presence', tabId);
}

async function reconcileAlreadyRestoredSession({
  tabId,
  projectId,
  sessionId,
  engine,
  stage,
  waitUntilReady,
  clearInterruptedState,
  releaseAdmission,
  assertCurrent = async () => {},
  getCurrentSessionId = () => sessionId,
}: {
  tabId: string;
  projectId: string;
  sessionId: string;
  engine: InterruptedEngine;
  stage: 'before-launch' | 'after-launch-refusal';
  waitUntilReady: boolean;
  clearInterruptedState: (tabId: string) => void;
  releaseAdmission: () => void;
  assertCurrent?: () => Promise<void>;
  getCurrentSessionId?: () => string;
}): Promise<InterruptedResumeResult | null> {
  let runtime: any = null;
  try {
    runtime = await readInterruptedRuntime({ tabId, projectId, engine });
  } catch (error: any) {
    console.warn('[ResumeInterrupted] runtime check failed tab=' + tabId.slice(-12)
      + ' stage=' + stage
      + ' error=' + (error?.message || String(error)));
    return null;
  }
  await assertCurrent();
  let classified = classifyInterruptedRestoreRuntime({ engine, sessionId: getCurrentSessionId(), runtime });
  if (classified.state === 'conflict') {
    return {
      success: false,
      accepted: false,
      ready: false,
      settled: true,
      error: 'interrupted_restore_runtime_conflict',
      detail: classified.reason,
      runtime,
    };
  }
  if (classified.state !== 'ready' && classified.state !== 'joining') return null;

  // This exact process already owns the launch. Let the bounded boot pipeline
  // admit another tab while we join its remaining TUI/MCP warmup.
  releaseAdmission();

  // A parallel manual Send/Resume may have started the exact target while
  // this item waited in the sequential boot queue. Join that lifecycle;
  // never type a second launch command into the same PTY.
  if (classified.state === 'joining' && waitUntilReady) {
    const expectedOwner = interruptedReadyOwner(engine, runtime);
    const joined = await ipcRenderer.invoke('agent:wait-start-ready', {
      tabId,
      toolType: engine,
      timeoutMs: 60_000,
      expectedOwner,
    }).catch((error: any) => ({
      success: false,
      ready: false,
      error: error?.code || 'agent_ready_wait_failed',
      detail: error?.message || String(error),
    }));
    if (joined?.success !== true || joined?.ready !== true) {
      // The exact process can move from `starting` straight into a busy turn
      // started by the parallel Send. Re-read identity before calling that
      // successful handoff a timeout.
      runtime = await readInterruptedRuntime({ tabId, projectId, engine }).catch(() => runtime);
      await assertCurrent();
      classified = classifyInterruptedRestoreRuntime({ engine, sessionId: getCurrentSessionId(), runtime });
      const sameOwner = matchesInterruptedReadyOwner(engine, expectedOwner, runtime);
      const status = runtime?.status || runtime?.sessionStatus;
      const sameLaunchReady = sameOwner && runtime?.inputReady === true
        && (status === 'active' || status === 'busy');
      if ((!sameLaunchReady && classified.state !== 'ready') || !sameOwner
        || joined?.error === 'agent_ready_owner_changed') {
        return {
          success: false,
          accepted: false,
          ready: false,
          settled: false,
          error: joined?.error || 'agent_ready_wait_failed',
          detail: joined?.detail || classified.reason,
          runtime,
        };
      }
    }
  }

  await assertCurrent();
  clearInterruptedState(tabId);
  console.log('[ResumeInterrupted] already restored tab=' + tabId.slice(-12)
    + ' engine=' + engine
    + ' session=' + sessionId.slice(0, 8)
    + ' stage=' + stage
    + ' proof=' + classified.reason);
  return {
    success: true,
    accepted: false,
    ready: true,
    settled: true,
    alreadyRestored: true,
    runtime,
  };
}

/**
 * Запустить продолжение сохранённого разговора в этой вкладке.
 *
 * Пометка о прерывании снимается ТОЛЬКО после main-owned input-ready proof.
 * Одного принятия shell-команды недостаточно: именно этот разрыв оставлял
 * «восстановленную» вкладку в вечном starting после failed startup.
 */
export async function continueInterruptedSession({
  tabId,
  projectId,
  sessionId,
  engine,
  cwd,
  clearInterruptedState,
  focusTerminal = false,
  launchSource = 'auto-resume',
  waitUntilReady = true,
  onLaunchSettled,
  onAdmissionRetry,
}: {
  tabId: string | null;
  projectId: string;
  sessionId: string | null;
  engine: InterruptedEngine | null;
  cwd?: string;
  clearInterruptedState: (tabId: string) => void;
  focusTerminal?: boolean;
  launchSource?: string;
  waitUntilReady?: boolean;
  onLaunchSettled?: () => void;
  onAdmissionRetry?: (status: {
    attempt: number;
    nextAttempt: number;
    delayMs: number;
    error: string | null;
    reason: string | null;
  }) => void;
}): Promise<InterruptedResumeResult> {
  if (!tabId || !sessionId || !engine) {
    console.log('[ResumeInterrupted] missing tab, engine or sessionId');
    return { success: false, accepted: false, ready: false, settled: true, error: 'invalid_interrupted_resume' };
  }
  if (resumeInflight.has(tabId)) {
    console.warn('[ResumeInterrupted] already in flight for tab:', tabId);
    return { success: false, accepted: false, ready: false, settled: false, error: 'resume_inflight' };
  }
  resumeInflight.add(tabId);
  let launchStageSettled = false;
  let deferAdmissionRelease = false;
  const releaseAdmission = () => {
    if (launchStageSettled || deferAdmissionRelease) return;
    launchStageSettled = true;
    onLaunchSettled?.();
  };
  const controller = new AbortController();
  let checkSource = () => {};
  let unsubscribeSource = () => {};
  let sourceSessionId = sessionId;
  let sessionReconciliation: { sessionId: string; promise: Promise<void> } | null = null;
  // App freezes cwd when this exact boot item enters admission. Retain the
  // already-observed Main terminal/Stop fence before import/presence/readiness.
  const launchAdmission = createAgentLaunchAdmission({
    invoke: ipcRenderer.invoke.bind(ipcRenderer), events: ipcRenderer, tabId, toolType: engine, sessionId, cwd,
    signal: controller.signal, assertCurrent: () => checkSource(),
    onRetry: ({ attempt, nextAttempt, delayMs, result }: any) => {
      console.warn('[ResumeInterrupted] admission retry tab=' + tabId.slice(-12)
        + ' engine=' + engine + ' attempt=' + attempt + ' nextAttempt=' + nextAttempt
        + ' delayMs=' + delayMs + ' error=' + (result?.error || '-')
        + ' reason=' + (result?.reason || '-'));
      onAdmissionRetry?.({ attempt, nextAttempt, delayMs,
        error: result?.error || null, reason: result?.reason || result?.detail || null });
    },
  });
  const assertSourceCurrent = async () => {
    checkSource();
    if (sessionReconciliation) await sessionReconciliation.promise;
    checkSource();
  };
  console.log('[ResumeInterrupted] sending resume tab=' + tabId.slice(-12)
    + ' engine=' + engine + ' session=' + sessionId.slice(0, 8));

  if (focusTerminal) {
    terminalRegistry.get(tabId)?.scrollToBottom();
    terminalRegistry.get(tabId)?.focus();
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  }

  try {
    const { useWorkspaceStore } = await import('../store/useWorkspaceStore');
    checkSource = () => {
      const tab = useWorkspaceStore.getState().openProjects.get(projectId)?.tabs.get(tabId);
      const currentSessionId = engine === 'codex' ? tab?.codexSessionId : tab?.claudeSessionId;
      if (!tab || tab.overlayDismissed === true || resolvePtyAgentOwner(tab) !== engine
        || (tab.cwd || null) !== (cwd || null)
        || (sessionReconciliation && currentSessionId !== sessionReconciliation.sessionId)) {
        controller.abort('interrupted-restore-source-changed');
      } else if (currentSessionId !== sourceSessionId && !sessionReconciliation) {
        // Another accepted Resume can clear wasInterrupted before the writer
        // exists. That label alone is neither an identity change nor new launch
        // authority: retain this scope's original fence/budget/readiness owner.
        // A real SID change still revokes and joins only the exact Main writer;
        // explicit dismissal above and Main's Stop/PTY fences still cancel.
        if (!currentSessionId) controller.abort('interrupted-restore-source-changed');
        else {
          const join = { sessionId: currentSessionId, promise: Promise.resolve() };
          sessionReconciliation = join;
          // Main revokes first. Only the exact existing launch's first writer
          // can complete this read-only join; no new command is authorized.
          join.promise = launchAdmission.reconcileSession(currentSessionId).then(joined => {
            if (joined && !controller.signal.aborted) sourceSessionId = currentSessionId;
            else controller.abort('interrupted-restore-source-changed');
          });
        }
      }
      if (controller.signal.aborted) throw Object.assign(new Error('interrupted_restore_identity_changed'), {
        code: 'interrupted_restore_identity_changed', reason: 'interrupted-restore-source-changed',
        stage: 'renderer-admission', launchStage: 'renderer-admission', cancelled: true,
      });
    };
    unsubscribeSource = useWorkspaceStore.subscribe(() => { try { checkSource(); } catch {} });
    await assertSourceCurrent();
    const beforeLaunch = await reconcileAlreadyRestoredSession({
      tabId,
      projectId,
      sessionId: sourceSessionId,
      engine,
      stage: 'before-launch',
      waitUntilReady,
      clearInterruptedState,
      releaseAdmission,
      assertCurrent: assertSourceCurrent,
      getCurrentSessionId: () => sourceSessionId,
    });
    if (beforeLaunch) return beforeLaunch;

    await assertSourceCurrent();
    const launchPayload = engine === 'codex'
      ? buildCodexRunPayload({ tabId, command: 'codex-c', sessionId, cwd, launchSource })
      : { tabId, command: 'claude-c', sessionId, launchSource, ...(cwd ? { cdTo: cwd } : {}) };
    if (engine === 'claude') markPendingResume(tabId, sessionId);
    const runResult: any = await launchAdmission.run(engine + ':run-command', launchPayload);
    const knownPendingLaunch = runResult?.accepted === true
      || runResult?.acceptancePending === true || runResult?.joined === true;
    if (isTransientInterruptedRestoreAdmission(runResult)
      || runResult?.launchOutcomeUnknown === true
      || (!knownPendingLaunch && (runResult?.launchWritten === null || runResult?.accepted === null))) {
      // The pipeline must observe settled:false before releasing this lane.
      // Its own finally releases it after recording that blocked outcome.
      deferAdmissionRelease = true;
    }
    // A known launch admission can overlap the next tab's admission with this
    // lifecycle's readiness wait. An unknown ACK is not that boundary.
    releaseAdmission();
    await assertSourceCurrent();
    if (engine === 'claude' && runResult?.accepted === true
      && runResult?.restoredEmptySessionId === sessionId) {
      // This admitted launch has no old conversation to resume. Do not let
      // the pending-resume guard reject the fresh CLI's newly assigned UUID.
      clearPendingResume(tabId);
    }
    if (runResult?.suppressed === true) {
      if (engine === 'claude') clearPendingResume(tabId);
      clearInterruptedState(tabId);
      return {
        success: true,
        accepted: false,
        ready: false,
        settled: true,
        suppressed: true,
        launch: runResult,
      };
    }
    if ((runResult?.success === false || runResult?.accepted !== true)
      && runResult?.acceptancePending !== true && runResult?.joined !== true) {
      const collisionCode = String(runResult?.error || '');
      const collisionReason = String(runResult?.reason || '');
      if (COLLISION_ERRORS.has(collisionCode) || COLLISION_ERRORS.has(collisionReason)) {
        const afterRefusal = await reconcileAlreadyRestoredSession({
          tabId,
          projectId,
          sessionId: sourceSessionId,
          engine,
          stage: 'after-launch-refusal',
          waitUntilReady,
          clearInterruptedState,
          releaseAdmission,
          assertCurrent: assertSourceCurrent,
          getCurrentSessionId: () => sourceSessionId,
        });
        if (afterRefusal) return afterRefusal;
      }
      if (engine === 'claude') clearPendingResume(tabId);
      console.warn('[ResumeInterrupted] rejected tab=' + tabId.slice(-12)
        + ' engine=' + engine
        + ' error=' + (runResult?.error || runResult?.reason || 'unknown'));
      const transientLookupFailure = isTransientInterruptedRestoreAdmission(runResult);
      return {
        success: false,
        accepted: false,
        ready: false,
        // Exhausted lookup retries still do not prove either idle or occupied.
        // Stop the boot queue here instead of adding more launches to the same
        // startup storm; the interrupted flag remains available for a later
        // automatic/manual retry.
        settled: !transientLookupFailure && runResult?.launchOutcomeUnknown !== true,
        error: runResult?.error || runResult?.reason || 'resume_rejected',
        detail: runResult?.reason || null,
        launch: runResult,
      };
    }
    let readyResult: any = { success: true, ready: true, status: null };
    if (waitUntilReady) {
      readyResult = await ipcRenderer.invoke('agent:wait-start-ready', {
        tabId,
        toolType: engine,
        timeoutMs: 60_000,
        expectedOwner: interruptedReadyOwner(engine, runResult),
      });
      if (readyResult?.success !== true || readyResult?.ready !== true) {
        const readyError = readyResult?.error || 'agent_ready_wait_failed';
        const terminalFailure = readyError === 'codex_auth_required'
          || readyError === 'agent_startup_defaults_failed'
          || readyError === 'agent_ready_owner_missing'
          || readyError === 'agent_ready_owner_changed';
        console.warn('[ResumeInterrupted] not ready tab=' + tabId.slice(-12)
          + ' engine=' + engine
          + ' error=' + (readyResult?.error || readyResult?.detail || 'unknown'));
        return {
          success: false,
          accepted: true,
          ready: false,
          settled: terminalFailure,
          error: readyError,
          detail: readyResult?.detail || null,
          launch: runResult,
          runtime: readyResult?.status || null,
        };
      }
    }
    await assertSourceCurrent();
    clearInterruptedState(tabId);
    console.log('[ResumeInterrupted] ready tab=' + tabId.slice(-12)
      + ' engine=' + engine + ' session=' + sessionId.slice(0, 8));
    return {
      success: true,
      accepted: true,
      ready: true,
      settled: true,
      launch: runResult,
      runtime: readyResult?.status || null,
    };
  } catch (error: any) {
    if (!launchStageSettled) deferAdmissionRelease = true;
    if (engine === 'claude') clearPendingResume(tabId);
    console.warn('[ResumeInterrupted] failed tab=' + tabId.slice(-12)
      + ' engine=' + engine
      + ' error=' + (error?.message || String(error)));
    return {
      success: false,
      accepted: false,
      ready: false,
      settled: false,
      error: error?.code || 'resume_failed',
      detail: error?.message || String(error),
      launch: { ...launchAdmission.snapshot(), ...error, error: error?.message || String(error) },
    };
  } finally {
    unsubscribeSource();
    void launchAdmission.finish();
    // The pipeline's completion cleanup releases uncertain admissions only
    // after their settled:false result has blocked further boot launches.
    releaseAdmission();
    resumeInflight.delete(tabId);
  }
}
