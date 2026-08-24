// Одна операция автоматического восстановления прерванной PTY-сессии.
// UI-модалки и ручной Continue-step больше нет: App запускает этот flow строго
// последовательно для точного shutdown-набора, а tab-owned lifecycle surface
// показывает pending/ready/error. Обычный Resume намеренно остановленной
// сессии остаётся отдельным действием ControlBar.

import { terminalRegistry } from './terminalRegistry';
import { clearPendingResume, markPendingResume } from './pendingResume';
import { buildCodexRunPayload } from './codexLaunch';
import { classifyInterruptedRestoreRuntime } from './interruptedAutoRestore.mjs';

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
}: {
  tabId: string;
  projectId: string;
  sessionId: string;
  engine: InterruptedEngine;
  stage: 'before-launch' | 'after-launch-refusal';
  waitUntilReady: boolean;
  clearInterruptedState: (tabId: string) => void;
  releaseAdmission: () => void;
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
  let classified = classifyInterruptedRestoreRuntime({ engine, sessionId, runtime });
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
    const joined = await ipcRenderer.invoke('agent:wait-start-ready', {
      tabId,
      toolType: engine,
      timeoutMs: 60_000,
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
      classified = classifyInterruptedRestoreRuntime({ engine, sessionId, runtime });
      if (classified.state !== 'ready') {
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
  clearInterruptedState,
  focusTerminal = false,
  launchSource = 'auto-resume',
  waitUntilReady = true,
  onLaunchSettled,
}: {
  tabId: string | null;
  projectId: string;
  sessionId: string | null;
  engine: InterruptedEngine | null;
  clearInterruptedState: (tabId: string) => void;
  focusTerminal?: boolean;
  launchSource?: string;
  waitUntilReady?: boolean;
  onLaunchSettled?: () => void;
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
  const releaseAdmission = () => {
    if (launchStageSettled) return;
    launchStageSettled = true;
    onLaunchSettled?.();
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
    const beforeLaunch = await reconcileAlreadyRestoredSession({
      tabId,
      projectId,
      sessionId,
      engine,
      stage: 'before-launch',
      waitUntilReady,
      clearInterruptedState,
      releaseAdmission,
    });
    if (beforeLaunch) return beforeLaunch;

    let runResult: any;
    if (engine === 'codex') {
      const ws = useWorkspaceStore.getState().openProjects.get(projectId);
      const cwd = ws?.tabs.get(tabId)?.cwd;
      runResult = await ipcRenderer.invoke('codex:run-command', buildCodexRunPayload({
        tabId,
        command: 'codex-c',
        sessionId,
        cwd,
        launchSource,
      }));
    } else {
      // Сторож от чужого bridge-файла взводится вплотную перед подтверждённым
      // запросом и снимается, если main его отверг.
      markPendingResume(tabId, sessionId);
      const tabCwd = useWorkspaceStore.getState().openProjects.get(projectId)?.tabs.get(tabId)?.cwd;
      runResult = await ipcRenderer.invoke('claude:run-command', {
        tabId,
        command: 'claude-c',
        sessionId,
        launchSource,
        ...(tabCwd ? { cdTo: tabCwd } : {}),
      });
    }
    // `run-command` returning is the main-owned admission boundary: the
    // launch was accepted, suppressed or rejected. Readiness may still take
    // seconds, but another tab may now safely enter admission.
    releaseAdmission();
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
    if (runResult?.success === false || runResult?.accepted === false) {
      const collisionCode = String(runResult?.error || '');
      const collisionReason = String(runResult?.reason || '');
      if (COLLISION_ERRORS.has(collisionCode) || COLLISION_ERRORS.has(collisionReason)) {
        const afterRefusal = await reconcileAlreadyRestoredSession({
          tabId,
          projectId,
          sessionId,
          engine,
          stage: 'after-launch-refusal',
          waitUntilReady,
          clearInterruptedState,
          releaseAdmission,
        });
        if (afterRefusal) return afterRefusal;
      }
      if (engine === 'claude') clearPendingResume(tabId);
      console.warn('[ResumeInterrupted] rejected tab=' + tabId.slice(-12)
        + ' engine=' + engine
        + ' error=' + (runResult?.error || runResult?.reason || 'unknown'));
      return {
        success: false,
        accepted: false,
        ready: false,
        settled: true,
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
      });
      if (readyResult?.success !== true || readyResult?.ready !== true) {
        const readyError = readyResult?.error || 'agent_ready_wait_failed';
        const terminalFailure = readyError === 'codex_auth_required'
          || readyError === 'agent_startup_defaults_failed';
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
    };
  } finally {
    // Runtime/preflight failures before run-command must not deadlock the
    // scheduler's single-admission lane.
    releaseAdmission();
    resumeInflight.delete(tabId);
  }
}
