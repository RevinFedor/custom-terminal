import { getHistoryAgentRuntime } from './historyAgentRuntimes';
import { sendAgentPromptScenario } from './agentScenarios';
import { AGENT_SETTINGS_INTENT_NONE } from './agentSendSettingsContract';

const { ipcRenderer } = window.require('electron');
export type AutoCompactTarget = {
  tabId: string;
  projectId: string;
  workflowId: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  cwd?: string;
};

export async function executeAutoCompact(target: AutoCompactTarget, handoffId: string): Promise<void> {
  let settle: (operation: any) => void = () => {};
  let rejectProof: (error: Error) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const proof = new Promise<void>((resolve, reject) => {
    rejectProof = reject;
    settle = (operation) => {
      if (operation?.tabId !== target.tabId || operation.provider !== target.provider
        || operation.sessionId !== target.sessionId || operation.handoffId !== handoffId
        || operation.active !== false) return;
      if (operation.outcome === 'completed') resolve();
      else reject(new Error('Автокомпакт не завершён: ' + (operation.reason || operation.outcome || 'неизвестный исход')));
    };
    // A deadline is an unknown outcome, never proof of completion or a retry.
    timer = setTimeout(() => reject(new Error('Нет подтверждения завершения автокомпакта. Проверьте сессию перед повтором.')), 180_000);
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
    rejectProof(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    ipcRenderer.removeListener('agent:operational-phase', handler);
  }
}
