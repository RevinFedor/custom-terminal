import { useEffect, useSyncExternalStore } from 'react';
const { ipcRenderer } = window.require('electron');

type Activity = { tabId: string; sequence: number; busy: boolean; target: string | null; toolType?: string | null; replaceable?: boolean };

// A projection cache, not an operation owner. Listen even when a particular
// ControlBar is unmounted, so A→B→A does not first display an empty busy state.
const snapshots = new Map<string, Activity>();
const listeners = new Map<string, Set<() => void>>();
function snapshot(tabId: string): Activity {
  if (!snapshots.has(tabId)) snapshots.set(tabId, { tabId, sequence: -1, busy: false, target: null });
  return snapshots.get(tabId)!;
}
function accept(next: Activity) {
  if (!next?.tabId || !Number.isFinite(next.sequence)) return;
  const previous = snapshot(next.tabId);
  if (previous.sequence > next.sequence) return;
  if (previous.sequence === next.sequence && previous.busy === next.busy && previous.target === next.target
    && previous.replaceable === next.replaceable) return;
  snapshots.set(next.tabId, next);
  listeners.get(next.tabId)?.forEach(listener => listener());
}
function refresh(tabId: string) {
  void ipcRenderer.invoke('agent:get-settings-activity', { tabId }).then(accept).catch(() => {});
}
const onActivity = (_: unknown, next: Activity) => accept(next);
const onLifecycle = (_: unknown, data: { tabId?: string }) => { if (data?.tabId) refresh(data.tabId); };
ipcRenderer.on('agent:settings-activity', onActivity);
const lifecycleEvents = ['terminal:command-started', 'terminal:command-finished', 'terminal:exit'];
lifecycleEvents.forEach(event => ipcRenderer.on(event, onLifecycle));
if (import.meta.hot) import.meta.hot.dispose(() => {
  ipcRenderer.removeListener('agent:settings-activity', onActivity);
  lifecycleEvents.forEach(event => ipcRenderer.removeListener(event, onLifecycle));
});

export function useAgentSettingsActivity(tabId: string) {
  const activity = useSyncExternalStore(listener => {
    if (!listeners.has(tabId)) listeners.set(tabId, new Set());
    listeners.get(tabId)!.add(listener);
    return () => { listeners.get(tabId)?.delete(listener); };
  }, () => snapshot(tabId));
  useEffect(() => { refresh(tabId); }, [tabId]);
  return activity;
}
