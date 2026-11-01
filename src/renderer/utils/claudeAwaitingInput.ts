import { useCallback, useSyncExternalStore } from 'react';
import { resolveAgentBusyPresentation } from './agentBusyPresentation.mjs';

const { ipcRenderer } = window.require('electron');

// Claude is blocked on AskUserQuestion: main brackets the wait with the
// PreToolUse/PostToolUse hooks and sends `claude:awaiting-input`. The event is a
// TRANSITION, so a surface that mounts mid-question would never see it. This
// module listens from renderer start and keeps one flag per tab; every tab card
// (sidebar row, window chip, pickers) then answers for itself, with no prop
// chain through memoised pane chrome. See fact-claude-awaiting-input.md.
const awaiting = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

function setAwaiting(tabId: string, value: boolean) {
  if (!tabId || awaiting.has(tabId) === value) return;
  if (value) awaiting.add(tabId); else awaiting.delete(tabId);
  // Only the flipped tab wakes; N cards must not all re-evaluate for one tab.
  listeners.get(tabId)?.forEach((notify) => notify());
}

const onAwaitingInput = (_: unknown, data: { tabId?: string; awaiting?: boolean }) => {
  setAwaiting(data?.tabId ?? '', data?.awaiting === true);
};

// awaiting ⊆ busy. Esc on the question cancels the whole turn and PostToolUse
// may never arrive, but the turn end always publishes busy:false. Spinner frames
// are not turn boundaries (same exclusion as every other busy consumer).
const onBusyState = (_: unknown, data: {
  tabId?: string; busy?: boolean; reason?: string; activityBusy?: boolean;
}) => {
  if (data?.reason === 'spinner' || resolveAgentBusyPresentation(data)) return;
  setAwaiting(data?.tabId ?? '', false);
};

ipcRenderer.on('claude:awaiting-input', onAwaitingInput);
ipcRenderer.on('claude:busy-state', onBusyState);
if (import.meta.hot) import.meta.hot.dispose(() => {
  ipcRenderer.removeListener('claude:awaiting-input', onAwaitingInput);
  ipcRenderer.removeListener('claude:busy-state', onBusyState);
});

const isTabAwaitingInput = (tabId: string) => awaiting.has(tabId);

function subscribeTabAwaitingInput(tabId: string, notify: () => void) {
  let set = listeners.get(tabId);
  if (!set) listeners.set(tabId, set = new Set());
  const own = set;
  own.add(notify);
  return () => {
    own.delete(notify);
    if (!own.size && listeners.get(tabId) === own) listeners.delete(tabId);
  };
}

export function useTabAwaitingInput(tabId: string): boolean {
  const subscribe = useCallback((notify: () => void) => subscribeTabAwaitingInput(tabId, notify), [tabId]);
  const snapshot = useCallback(() => isTabAwaitingInput(tabId), [tabId]);
  // The renderer is client-only; the same snapshot also serves SSR fixtures.
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
