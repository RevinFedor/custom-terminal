import { useSyncExternalStore } from 'react';
import { createAgentSendVisualActivity } from '../utils/agentSendVisualActivity.mjs';
import { subscribeAgentSendScenarios } from '../utils/agentSendSequencer.mjs';
import { getCoordinatedAgentActions, subscribeCoordinatedAgentActions } from '../utils/agentActionCoordinator.mjs';

const activity = createAgentSendVisualActivity();

export function startAgentSendActivity() {
  const { ipcRenderer } = window.require('electron');
  let disposed = false;
  let eventSeen = false;
  const onMain = (_event: unknown, snapshot: any) => {
    eventSeen = true;
    if (!disposed) activity.applyMain(snapshot);
  };
  ipcRenderer.on('agent:send-activity', onMain);
  // Subscribe first. A newer edge wins over a delayed initial snapshot.
  void ipcRenderer.invoke('agent:get-send-activity').then((snapshot: any) => {
    if (!disposed && !eventSeen) activity.applyMain(snapshot);
  }).catch((error: any) => console.warn('[SendActivity] snapshot unavailable:', error?.message));
  const onAction = ({ tabId, state }: any) => activity.setLocal('composer', tabId, !!state,
    [state?.phase === 'stopping' ? null : state?.handoffId || null]);
  const unsubscribeActions = subscribeCoordinatedAgentActions(onAction);
  activity.replaceLocal('composer', getCoordinatedAgentActions().map((state: any) => ({
    ...state, handoffId: state.phase === 'stopping' ? null : state.handoffId,
  })));
  activity.replaceLocal('scenario', []);
  const unsubscribeScenarios = subscribeAgentSendScenarios(({ tabId, pending, handoffIds }: any) => {
    activity.setLocal('scenario', tabId, pending > 0, handoffIds);
  });
  return () => {
    disposed = true;
    ipcRenderer.removeListener('agent:send-activity', onMain);
    unsubscribeActions();
    unsubscribeScenarios();
  };
}

export const useAgentSendPendingTabs = () => useSyncExternalStore(activity.subscribe, activity.snapshot);
export const useAgentSendPending = (tabId: string) => useSyncExternalStore(
  activity.subscribe,
  () => activity.snapshot().has(tabId),
);
