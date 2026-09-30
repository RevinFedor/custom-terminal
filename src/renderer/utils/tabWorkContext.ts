import { useEffect, useSyncExternalStore } from 'react';
import '../styles/tabWorkContext.css';

const { ipcRenderer } = window.require('electron');
export const WORK_CONTEXT_COLOR = 'var(--work-context-accent)';
export interface TabContextUpdateSource {
  tabId: string;
  tabName: string;
  projectId?: string | null;
  sessionId?: string | null;
  operationId?: string | null;
}
export interface TabContextUpdateSection {
  id: string;
  title: string;
  textStart: number;
  textEnd: number;
  hunkCount?: number;
  lineCount?: number;
  paths?: string[];
  sourceTabId?: string | null;
  sourceTabs?: TabContextUpdateSource[];
  hasUnknownSource?: boolean;
  startLine?: number | null;
  endLine?: number | null;
  createdAt: number;
}
export interface TabContextUpdate {
  id: string;
  memberIds?: string[];
  title: string;
  text: string;
  kind: 'message' | 'file' | 'file-batch' | 'file-error';
  path?: string;
  sourceTabId?: string | null;
  sourceTabs?: TabContextUpdateSource[];
  hasUnknownSource?: boolean;
  sections?: TabContextUpdateSection[];
  status: 'pending' | 'sending';
  createdAt: number;
}
export interface TabWorkContextSnapshot {
  tabId: string;
  responsibility: string;
  revision: number;
  files: { path: string; hash?: string; error?: string }[];
  updates: TabContextUpdate[];
  pendingCount: number;
}
const EMPTY: TabWorkContextSnapshot = Object.freeze({
  tabId: '', responsibility: '', revision: 0, files: [], updates: [], pendingCount: 0,
});
const states = new Map<string, TabWorkContextSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const loading = new Map<string, Promise<void>>();
const isLegacyBackend = (error: any) => String(error?.message || error).includes("No handler registered for 'tab-work-context:");
function accept(snapshot: TabWorkContextSnapshot) {
  if (!snapshot?.tabId || (states.get(snapshot.tabId)?.revision ?? -1) > snapshot.revision) return;
  states.set(snapshot.tabId, snapshot);
  listeners.get(snapshot.tabId)?.forEach((notify) => notify());
}
const onChanged = (_event: unknown, snapshot: TabWorkContextSnapshot) => accept(snapshot);
ipcRenderer.on('tab-work-context:changed', onChanged);
if (import.meta.hot) import.meta.hot.dispose(() => ipcRenderer.removeListener('tab-work-context:changed', onChanged));

export function loadTabWorkContext(tabId: string) {
  if (!tabId) return Promise.resolve();
  if (loading.has(tabId)) return loading.get(tabId)!;
  const request = ipcRenderer.invoke('tab-work-context:get', { tabId }).then((result: any) => {
    if (!result?.success) throw new Error(result?.error || 'Could not read tab context');
    accept(result.context);
  }).catch((error: Error) => console.warn('[TabContext] read:', error.message))
    .finally(() => loading.delete(tabId));
  loading.set(tabId, request);
  return request;
}

export function useTabWorkContext(tabId: string) {
  useEffect(() => { void loadTabWorkContext(tabId); }, [tabId]);
  return useSyncExternalStore(
    (notify) => {
      const set = listeners.get(tabId) || new Set();
      set.add(notify);
      listeners.set(tabId, set);
      return () => { set.delete(notify); if (!set.size) listeners.delete(tabId); };
    },
    () => states.get(tabId) || EMPTY,
  );
}

export async function prepareTabWorkContext(tabId: string, handoffId: string, prompt: string) {
  let result;
  try { result = await ipcRenderer.invoke('tab-work-context:prepare', { tabId, handoffId, prompt }); }
  catch (error) {
    // A dev renderer can reload before its old main process. That main cannot
    // own context updates yet, so ordinary pre-feature sends stay available.
    if (isLegacyBackend(error)) return { prompt, prefix: '' };
    throw error;
  }
  if (result?.success !== true) throw new Error(result?.error || 'Could not prepare working context');
  return result as { prompt: string; prefix: string };
}

export async function settleTabWorkContext(tabId: string, handoffId: string | undefined, result: any) {
  if (!handoffId) return;
  try { await ipcRenderer.invoke('tab-work-context:settle', { tabId, handoffId, result }); }
  catch (error) { if (!isLegacyBackend(error)) throw error; }
}

export async function activateTabWorkContext(tabId: string, handoffId: string) {
  try { await ipcRenderer.invoke('tab-work-context:activate', { tabId, handoffId }); }
  catch (error) { if (!isLegacyBackend(error)) throw error; }
}

export async function dismissTabContextUpdate(tabId: string, updateId: string, updateIds?: string[]) {
  const result = await ipcRenderer.invoke('tab-work-context:dismiss', { tabId, updateId, updateIds });
  if (result?.success !== true) throw new Error(result?.error || 'Could not dismiss update');
  accept(result.context);
}

export async function deleteTabContextUpdate(tabId: string, updateId: string, updateIds?: string[]) {
  const result = await ipcRenderer.invoke('tab-work-context:delete', { tabId, updateId, updateIds });
  if (result?.success !== true) throw new Error(result?.error || 'Could not delete update');
  accept(result.context);
}

export async function restoreDismissedTabContextUpdate(tabId: string, updateId: string, updateIds?: string[]) {
  const result = await ipcRenderer.invoke('tab-work-context:restore-dismissed', { tabId, updateId, updateIds });
  if (result?.success !== true) throw new Error(result?.error || 'Could not restore update');
  accept(result.context);
}
