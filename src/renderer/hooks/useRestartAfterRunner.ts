import { useEffect } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useUIStore } from '../store/useUIStore';
import { isOrchestrationCompletionBlocked, subscribeOrchestrationRunChanges } from '../store/useOrchestrationStore';
import { tabAllowsShellActions } from '../utils/emptyTab.mjs';
import { createRestartAfterCoordinator } from '../utils/restartAfterCoordinator.mjs';
import { getRestartAfterTriggerIds, isAiLaunchCommand, isDevRestartCommand } from '../utils/restartAfterCommand.mjs';
import { replaceShellInputLine } from '../utils/shellCommandInput.mjs';

const { ipcRenderer } = window.require('electron');
let shuttingDown = false;
type Request = { tabId: string; command?: string; automatic: boolean; triggerTabId?: string };
function owner(tabId: string) {
  for (const [projectId, workspace] of useWorkspaceStore.getState().openProjects) {
    const tab = workspace.tabs.get(tabId);
    if (tab) return { projectId, tab };
  }
  return null;
}
function allowed(request: Request) {
  if (shuttingDown) return false;
  const target = owner(request.tabId)?.tab;
  return !!target && tabAllowsShellActions(target) && (!request.automatic
    || (!target.restartAfterPaused && getRestartAfterTriggerIds(target, useWorkspaceStore.getState()).includes(request.triggerTabId)));
}
const log = (action: string, data: unknown) => console.log('[RestartAfter:Coordinator] ' + action + ' ' + JSON.stringify(data));

// Module lifetime, not hook/TabBar lifetime. Re-mounting presentation cannot
// forget an admitted completion or create another set of pending script runs.
const coordinator = createRestartAfterCoordinator({
  id: () => crypto.randomUUID(), allowed, log, blocked: isOrchestrationCompletionBlocked,
  targets: (triggerId: string) => useWorkspaceStore.getState().consumeRestartAfterTriggerIdle(triggerId, true),
  cancel: (tabId: string, operationId: string) => ipcRenderer.send('terminal:cancel-command-operation', { tabId, operationId }),
  prepare: async (request: Request, current: () => boolean, operationId: string) => {
    const tabOwner = owner(request.tabId);
    if (!tabOwner || !allowed(request)) return null;
    const admission = await ipcRenderer.invoke('terminal:begin-command-operation', { tabId: request.tabId, operationId });
    if (!admission?.success || !current()) return null;
    let command = String(request.automatic ? owner(request.tabId)?.tab.restartAfterCommand || '' : request.command || '').trim();
    const cwd = await ipcRenderer.invoke('terminal:getCwd', request.tabId).catch(() => null) || tabOwner.tab.cwd;
    if (!current()) return null;
    if (!command) {
      const result = await ipcRenderer.invoke('terminal:get-last-project-command', {
        projectId: tabOwner.projectId, tabId: request.tabId, cwd,
      });
      if (!current()) return null;
      command = result?.success ? String(result.command || '').trim() : '';
      if (!command || isAiLaunchCommand(command)) {
        ipcRenderer.send('terminal:cancel-command-operation', { tabId: request.tabId, operationId });
        log('skip-command', { tabId: request.tabId, reason: command ? 'last-command-ai' : 'no-last-command' });
        return null;
      }
    }
    const finite = !isDevRestartCommand(command);
    const status = await ipcRenderer.invoke('terminal:command-operation-status', { tabId: request.tabId, operationId });
    if (!current() || !status?.valid) return null;
    const runningOperationId = request.automatic && finite && status.isRunning ? status.runningOperationId : null;
    if (runningOperationId) ipcRenderer.send('terminal:cancel-command-operation', { tabId: request.tabId, operationId });
    return { command, finite, cwd, runningOperationId };
  },
  launch: async (request: Request, prepared: { command: string; finite: boolean; cwd: string }, operationId: string, current: () => boolean) => {
    if (!current()) return { success: false, reason: 'cancelled' };
    const stop = await ipcRenderer.invoke('terminal:deterministic-stop', {
      tabId: request.tabId, restart: false, commandOperationId: operationId,
    });
    if (!current() || !stop?.success) return { success: false, reason: stop?.error || 'stop-failed-or-cancelled' };
    let prefix = '';
    if (useUIStore.getState().freePortsBeforeStart && prepared.cwd) {
      const result = await ipcRenderer.invoke('system:detect-project-ports', prepared.cwd);
      const ports = (result?.ports || []).filter((p: unknown) => Number.isInteger(p) && Number(p) > 0 && Number(p) < 65536);
      if (ports.length) prefix = 'lsof -ti:' + ports.join(',') + ' 2>/dev/null | xargs -r kill -9 2>/dev/null; ';
    }
    if (!current()) return { success: false, reason: 'cancelled-before-write' };
    const latest = owner(request.tabId)?.tab;
    if (latest?.cwd !== prepared.cwd && latest?.cwd) {
      const cwd = await ipcRenderer.invoke('terminal:getCwd', request.tabId);
      if (!current() || cwd !== prepared.cwd) return { success: false, reason: 'cwd-changed' };
    }
    const result = await ipcRenderer.invoke('terminal:submit-command-operation', {
      tabId: request.tabId, operationId, command: prepared.command,
      data: replaceShellInputLine(prefix + prepared.command + '\r'),
    });
    if (result?.success && !prepared.finite) useWorkspaceStore.getState().setTabCommandType(request.tabId, 'devServer');
    return result;
  },
});

export function cancelRestartAfterCommand(tabId: string) { coordinator.cancel(tabId, 'manual-stop'); }
export function runRestartAfterCommand(tabId: string, command?: string) {
  coordinator.request({ tabId, command, automatic: false });
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  const busy = (_event: unknown, data: any) => coordinator.busy(data);
  for (const channel of ['claude:busy-state', 'gemini:busy-state', 'codex:busy-state']) ipcRenderer.on(channel, busy);
  ipcRenderer.on('terminal:command-finished', (_event: unknown, data: any) => coordinator.finished(data));
  ipcRenderer.on('terminal:command-started', (_event: unknown, data: any) => coordinator.started(data));
  ipcRenderer.on('terminal:command-operation-cancelled', (_event: unknown, data: any) => coordinator.cancel(data.tabId, data.reason));
  ipcRenderer.on('terminal:stop-progress', (_event: unknown, data: any) => {
    if (data.phase === 'starting' && !data.commandOperationId) coordinator.cancel(data.tabId, 'manual-stop-main');
  });
  ipcRenderer.on('shutdown:overlay', (_event: unknown, data: { show?: boolean }) => {
    shuttingDown = data?.show === true;
    if (shuttingDown) coordinator.cancelAll('shutdown');
  });
  subscribeOrchestrationRunChanges(change => coordinator.orchestration(change));
  const reconcile = () => {
    for (const workspace of useWorkspaceStore.getState().openProjects.values()) for (const tab of workspace.tabs.values()) {
      if (tab.aiBusy || tab.claudeBusy || (tab.tabType === 'claude-sdk' && ['fetching', 'thinking', 'tool_use'].includes(tab.sdkState || ''))) {
        coordinator.seedBusy(tab.id);
      }
    }
    coordinator.reconcile();
  };
  useWorkspaceStore.subscribe(reconcile);
  reconcile();
  log('installed', { owner: 'app' });
}
export function useRestartAfterRunner() { useEffect(install, []); }
