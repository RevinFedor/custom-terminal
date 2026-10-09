import { useSyncExternalStore } from 'react';
import { useUIStore } from '../store/useUIStore';

const { ipcRenderer } = window.require('electron');
export interface CodexNativeQuestion {
  tabId: string; sessionId: string; lifecycleGeneration: string; count: number;
  expanded: boolean; current: number | null; targetId: string; questionId?: string | null;
  title: string; options: string[]; draft: string; optionIndex?: number | null;
  countdown?: string | null;
}
const snapshots = new Map<string, CodexNativeQuestion>();
const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const countListeners = new Set<() => void>();
let counts: ReadonlyMap<string, number> = new Map();
function apply(tabId: string, state: CodexNativeQuestion | null, revision: number, notify = false) {
  if ((revisions.get(tabId) || 0) > revision) return;
  revisions.set(tabId, revision);
  const previous = snapshots.get(tabId) || null;
  if (JSON.stringify(previous) === JSON.stringify(state)) return;
  if (state?.count) snapshots.set(tabId, state); else snapshots.delete(tabId);
  if (notify && (state?.count || 0) > (previous?.count || 0)) {
    useUIStore.getState().showToast('Codex задал вопрос. Можно ответить или пропустить — работа продолжается.',
      'info', 4500, false, undefined, undefined, undefined, tabId);
  }
  listeners.get(tabId)?.forEach(callback => callback());
  if ((previous?.count || 0) !== (state?.count || 0)) {
    const next = new Map(counts);
    if (state?.count) next.set(tabId, state.count); else next.delete(tabId);
    counts = next;
    countListeners.forEach(callback => callback());
  }
}
ipcRenderer.on('codex:question-state', (_event: unknown, data: any) => {
  if (data?.tabId && Number.isFinite(data.revision)) apply(data.tabId, data.state || null, data.revision, true);
});
// One lightweight Main read on renderer bootstrap, not per-card polling.
void ipcRenderer.invoke('codex:list-native-questions').then((result: any) => {
  if (result?.success) for (const state of result.states || []) apply(state.tabId, state, result.revision);
}).catch(() => {});

export function useCodexNativeQuestion(tabId: string): CodexNativeQuestion | null {
  return useSyncExternalStore(callback => {
    const set = listeners.get(tabId) || new Set();
    set.add(callback); listeners.set(tabId, set);
    return () => { set.delete(callback); if (!set.size) listeners.delete(tabId); };
  }, () => snapshots.get(tabId) || null, () => null);
}
export function useCodexNativeQuestionCounts(): ReadonlyMap<string, number> {
  return useSyncExternalStore(callback => { countListeners.add(callback); return () => { countListeners.delete(callback); }; },
    () => counts, () => counts);
}
export async function controlCodexNativeQuestion(tabId: string, action: string,
  args: Record<string, unknown> = {}) {
  const state = snapshots.get(tabId);
  if (!state) return { success: false, error: 'question_not_available' };
  return ipcRenderer.invoke('codex:control-native-question', {
    tabId, targetId: state.targetId, requestId: window.require('crypto').randomUUID(), action, ...args,
  });
}
