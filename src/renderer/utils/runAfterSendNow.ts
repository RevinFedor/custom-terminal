import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { getHistoryAgentRuntime } from './historyAgentRuntimes';
import { sendAgentPromptScenario } from './agentScenarios';
import { AGENT_SETTINGS_INTENT_NONE } from './agentSendSettingsContract';
import { serializeComposerDraft } from './composerChips.mjs';
import { buildPromptQueueReceiptHandoffId } from './promptQueueReceiptIdentity.mjs';
import { historyPromptHandoffInitialStatus, runHistoryPromptHandoff } from './historyPromptHandoffs';
import { buildQueuedPromptPayload, usePromptQueueStore, type QueuedPrompt } from '../store/usePromptQueueStore';

// The existing Cmd+Replay send scenario, shared with the remote explicit action.
// No scheduling/condition/Post is applied to a selected manual Send-now.
export async function sendQueuedPromptNow(tabId: string, item: QueuedPrompt, sessionType: 'claude' | 'codex') {
  if (item.metaAction) throw new Error('run_after_action_not_replayable');
  const workspace = Array.from(useWorkspaceStore.getState().openProjects.values()).find(candidate => candidate.tabs.has(tabId));
  const tab = workspace?.tabs.get(tabId);
  if (!tab) throw new Error('run_after_tab_missing');
  const runtime = getHistoryAgentRuntime(sessionType);
  const presence = await runtime.getPresence(tabId).catch(() => null);
  const statusAtSend = presence?.status || 'unknown';
  const sessionIdHint = sessionType === 'codex' ? tab.codexSessionId || null : tab.claudeSessionId || null;
  const payload = buildQueuedPromptPayload(item);
  const handoffId = buildPromptQueueReceiptHandoffId({ kind: 'queue', itemId: item.id, payload });
  try {
  const result = await runHistoryPromptHandoff({ tabId, handoffId, toolType: sessionType, sessionIdHint,
    text: serializeComposerDraft({ text: item.text, chips: item.chips || [] }).trim(),
    promptChips: item.chips || [], imagePaths: item.imagePaths || [], submittedAt: Date.now(), source: 'prompt-queue',
    statusAtSend, initialStatus: historyPromptHandoffInitialStatus(statusAtSend),
    send: exactHandoffId => sendAgentPromptScenario({ tabId, toolType: sessionType, runtime, sessionId: sessionIdHint,
      cwd: tab.cwd, prompt: payload, handoffId: exactHandoffId, source: 'prompt-queue', promptQueueAction: 'send-now',
      statusAtSend, queue: statusAtSend === 'busy', settingsIntent: AGENT_SETTINGS_INTENT_NONE, returnDraftOnConflict: false,
      presentationSnapshot: { historySessionId: sessionIdHint, promptChips: item.chips || [], imagePaths: item.imagePaths || [] } }),
  });
  // A non-transferred selected card cannot also become an automatic step
  // (possibly with a different Post body) after an uncertain manual action.
  // Pause the same owner, preserving items/remaining timer; never retry here.
  if (result?.submitted !== true) usePromptQueueStore.getState().setAutoRun(tabId, false);
  return result;
  } catch (error) {
    usePromptQueueStore.getState().setAutoRun(tabId, false);
    throw error;
  }
}
