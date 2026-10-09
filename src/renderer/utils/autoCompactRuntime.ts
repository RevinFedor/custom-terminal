import { getHistoryAgentRuntime } from './historyAgentRuntimes';
import { sendAgentPromptScenario } from './agentScenarios';
import { AGENT_SETTINGS_INTENT_NONE } from './agentSendSettingsContract';

const { ipcRenderer } = window.require('electron');
export type AutoCompactTarget = {
  tabId: string;
  projectId: string;
  workflowId: string;
  membershipRevision?: number;
  provider: 'claude' | 'codex';
  sessionId: string;
  cwd?: string;
};

export async function executeAutoCompact(target: AutoCompactTarget, handoffId: string): Promise<void> {
  let settle: (operation: any) => void = () => {};
  let rejectProof: (error: Error) => void = () => {};
  let manualStopError: Error | null = null;
  const proof = new Promise<void>((resolve, reject) => {
    rejectProof = reject;
    settle = (operation) => {
      if (operation?.tabId !== target.tabId || operation.provider !== target.provider
        || operation.sessionId !== target.sessionId || operation.handoffId !== handoffId
        || operation.active !== false) return;
      if (operation.outcome === 'completed') resolve();
      else {
        const error = new Error('Автокомпакт не завершён: ' + (operation.reason || operation.outcome || 'неизвестный исход'));
        // Exact Main operation proof can precede agent:stopping-state. Keep it
        // typed: the coordinator must not infer user intent from error text.
        if (operation.outcome === 'aborted' && operation.reason === 'manual-stop') {
          manualStopError = Object.assign(error, { code: 'auto_compact_manual_stop' });
        }
        reject(manualStopError || error);
      }
    };
    // Completion belongs to the exact Main operation, not elapsed time.
    // A long-running compact must retain its observer and continuation until
    // that owner publishes completed/aborted/failed/unknown, without a retry.
  });
  // The provider can finish while its submission IPC is still resolving.
  // Attach immediately and retain that exact outcome through the send await.
  void proof.catch(() => {});
  const handler = (_event: unknown, operation: any) => settle(operation);
  ipcRenderer.on('agent:operational-phase', handler);
  try {
    const result = await sendAgentPromptScenario({
      ...target,
      toolType: target.provider,
      runtime: getHistoryAgentRuntime(target.provider),
      prompt: '/compact',
      handoffId,
      source: 'prompt-queue:auto-compact',
      statusAtSend: 'active',
      queue: false,
      requireLive: true,
      settingsIntent: AGENT_SETTINGS_INTENT_NONE,
      returnDraftOnConflict: false,
    });
    if (result?.submitted !== true) throw new Error(result?.error || 'Автокомпакт не отправлен');
    const snapshot = await ipcRenderer.invoke('agent:get-operational-phase', {
      tabId: target.tabId, provider: target.provider,
    });
    for (const operation of snapshot?.settled || []) settle(operation);
    await proof;
  } catch (error) {
    const resultError = manualStopError || error;
    rejectProof(resultError instanceof Error ? resultError : new Error(String(resultError)));
    throw resultError;
  } finally {
    ipcRenderer.removeListener('agent:operational-phase', handler);
  }
}
