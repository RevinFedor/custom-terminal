// Одна операция автоматического восстановления прерванной PTY-сессии.
// UI-модалки и ручной Continue-step больше нет: App запускает этот flow строго
// последовательно для точного shutdown-набора, а tab-owned lifecycle surface
// показывает pending/ready/error. Обычный Resume намеренно остановленной
// сессии остаётся отдельным действием ControlBar.

import { terminalRegistry } from './terminalRegistry';
import { clearPendingResume, markPendingResume } from './pendingResume';
import { buildCodexRunPayload } from './codexLaunch';

const { ipcRenderer } = window.require('electron');

export type InterruptedEngine = 'claude' | 'codex';

export type InterruptedResumeResult = {
  success: boolean;
  accepted: boolean;
  ready: boolean;
  settled: boolean;
  suppressed?: boolean;
  error?: string | null;
  detail?: string | null;
  launch?: any;
  runtime?: any;
};

// Защита от повторного запуска — на всё приложение, по вкладке. Sequential
// boot queue уже не пересекает свои элементы, но обычный Resume/API может
// прийти параллельно и обязан join/reject, а не записать вторую команду.
const resumeInflight = new Set<string>();

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
}: {
  tabId: string | null;
  projectId: string;
  sessionId: string | null;
  engine: InterruptedEngine | null;
  clearInterruptedState: (tabId: string) => void;
  focusTerminal?: boolean;
  launchSource?: string;
  waitUntilReady?: boolean;
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
  console.log('[ResumeInterrupted] sending resume tab=' + tabId.slice(-12)
    + ' engine=' + engine + ' session=' + sessionId.slice(0, 8));

  if (focusTerminal) {
    terminalRegistry.get(tabId)?.scrollToBottom();
    terminalRegistry.get(tabId)?.focus();
    requestAnimationFrame(() => terminalRegistry.get(tabId)?.focus());
  }

  try {
    const { useWorkspaceStore } = await import('../store/useWorkspaceStore');
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
    resumeInflight.delete(tabId);
  }
}
