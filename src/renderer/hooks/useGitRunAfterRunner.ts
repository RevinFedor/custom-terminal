import { useEffect } from 'react';
import { getBusyTabsSnapshot } from './usePromptQueueRunner';
import { useGitRunAfterStore, type GitRunAfterTask } from '../store/useGitRunAfterStore';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

type BusyStatePayload = {
  tabId: string;
  busy: boolean;
  reason?: string;
};

const NON_NATURAL_END_REASONS = new Set([
  'manual-stop',
  'error',
  'interrupt',
  'watchdog',
  'turn_aborted',
  'send-command-failed',
  'send-command-error',
  'command-finished',
  'pty-exit',
  'terminal-kill',
  'replace',
  'close',
]);

const previousBusy = new Map<string, boolean>();
const inflightTasks = new Set<string>();

function trimError(error: unknown): string {
  return String(error || 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function tabExists(tabId: string): boolean {
  for (const workspace of useWorkspaceStore.getState().openProjects.values()) {
    if (workspace.tabs.has(tabId)) return true;
  }
  return false;
}

async function executeTask(task: GitRunAfterTask): Promise<void> {
  const store = useGitRunAfterStore.getState();
  if (inflightTasks.has(task.id) || !store.startTask(task.projectKey, task.id)) return;
  inflightTasks.add(task.id);
  console.log('[GitRunAfter] start project=' + task.projectKey + ' repo=' + task.repoPath + ' trigger=' + task.triggerTabId.slice(-12) + ' action=' + task.action);

  try {
    const generated = await ipcRenderer.invoke('git:generate-commit-message', {
      projectPath: task.repoPath,
      selectedPaths: task.selectedPaths,
      docsOnlyWhenPresent: task.docsOnlyWhenPresent,
      projectId: task.projectId,
      projectName: task.projectName,
      tabId: task.contextTabId,
      tabName: task.contextTabName,
    });
    if (!generated?.success || !generated?.message?.summary) {
      throw new Error(generated?.error || 'AI commit message failed');
    }

    const result = {
      summary: String(generated.message.summary || ''),
      description: String(generated.message.description || ''),
      meta: generated.meta,
    };

    if (task.action === 'generate-commit') {
      const committed = await ipcRenderer.invoke('git:commit', {
        projectPath: task.repoPath,
        selectedPaths: task.selectedPaths,
        summary: result.summary,
        description: result.description,
      });
      if (!committed?.success) throw new Error(committed?.error || 'git commit failed');
    }

    useGitRunAfterStore.getState().completeTask(task.projectKey, task.id, result);
    console.log('[GitRunAfter] success project=' + task.projectKey + ' repo=' + task.repoPath + ' action=' + task.action);
  } catch (error) {
    const current = useGitRunAfterStore.getState().tasks.get(task.projectKey);
    if (current?.id === task.id) {
      useGitRunAfterStore.getState().clearTask(task.projectKey, task.id);
      useUIStore.getState().showToast('Git run after: ' + trimError(error), 'error', 5000);
    }
    console.error('[GitRunAfter] failed project=' + task.projectKey + ' repo=' + task.repoPath, error);
  } finally {
    inflightTasks.delete(task.id);
  }
}

export function useGitRunAfterRunner(): void {
  useEffect(() => {
    for (const [tabId, busy] of getBusyTabsSnapshot()) previousBusy.set(tabId, busy);

    const handleBusyState = (_channel: 'claude' | 'gemini' | 'codex') =>
      (_event: unknown, payload: BusyStatePayload) => {
        const tabId = String(payload?.tabId || '');
        if (!tabId || payload?.reason === 'spinner') return;

        const busy = payload?.busy === true;
        const wasBusy = previousBusy.get(tabId) === true;
        previousBusy.set(tabId, busy);

        const waiting = Array.from(useGitRunAfterStore.getState().tasks.values())
          .filter((task) => task.phase === 'waiting' && task.triggerTabId === tabId);
        if (!waiting.length) return;

        if (!busy && payload?.reason && NON_NATURAL_END_REASONS.has(payload.reason)) {
          for (const task of waiting) {
            useGitRunAfterStore.getState().clearTask(task.projectKey, task.id);
          }
          useUIStore.getState().showToast('Git run after cancelled: target tab did not complete', 'warning', 3000);
          console.log('[GitRunAfter] cancel trigger=' + tabId.slice(-12) + ' reason=' + payload.reason + ' tasks=' + waiting.length);
          return;
        }

        if (payload?.reason === 'local-command' || !wasBusy || busy) return;
        for (const task of waiting) void executeTask(task);
      };

    const handleClaudeBusy = handleBusyState('claude');
    const handleGeminiBusy = handleBusyState('gemini');
    const handleCodexBusy = handleBusyState('codex');
    ipcRenderer.on('claude:busy-state', handleClaudeBusy);
    ipcRenderer.on('gemini:busy-state', handleGeminiBusy);
    ipcRenderer.on('codex:busy-state', handleCodexBusy);

    const unsubscribeWorkspace = useWorkspaceStore.subscribe((state) => {
      if (state.isRestoring) return;
      const tasks = Array.from(useGitRunAfterStore.getState().tasks.values());
      for (const task of tasks) {
        if (task.phase !== 'waiting') continue;
        const ownerClosed = Boolean(task.projectId) && !state.openProjects.has(String(task.projectId));
        if (!ownerClosed && tabExists(task.triggerTabId)) continue;
        useGitRunAfterStore.getState().clearTask(task.projectKey, task.id);
        if (!ownerClosed) {
          useUIStore.getState().showToast('Git run after cancelled: target tab was closed', 'warning', 3000);
        }
      }
    });

    return () => {
      ipcRenderer.removeListener('claude:busy-state', handleClaudeBusy);
      ipcRenderer.removeListener('gemini:busy-state', handleGeminiBusy);
      ipcRenderer.removeListener('codex:busy-state', handleCodexBusy);
      unsubscribeWorkspace();
    };
  }, []);
}
