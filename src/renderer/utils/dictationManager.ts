import { useSyncExternalStore } from 'react';
import { DictationSession } from './dictation';
import { appendDictationEntry } from './dictationHistory';

const { ipcRenderer } = window.require('electron');

export const DICTATION_STATE_EVENT = 'dictation:state';
export const DICTATION_STOP_AND_DELIVER_EVENT = 'dictation:stop-and-deliver';
export const DICTATION_DELIVERED_EVENT = 'dictation:delivered';

export type DictationMode = 'sdk' | 'pty-claude' | 'pty-codex' | 'terminal';

export interface DictationOwner {
  tabId: string;
  projectId: string;
  tabName: string;
  mode: DictationMode;
}

export interface DictationSnapshot {
  owner: DictationOwner | null;
  recording: boolean;
  stopping: boolean;
  final: string;
  partial: string;
}

const IDLE_SNAPSHOT: DictationSnapshot = {
  owner: null,
  recording: false,
  stopping: false,
  final: '',
  partial: '',
};

let snapshot: DictationSnapshot = IDLE_SNAPSHOT;
let sessionRef: DictationSession | null = null;
let finalizedSessionRef: DictationSession | null = null;
let notifyError: ((message: string) => void) | null = null;
let pendingSubmitRequests: string[] = [];

const listeners = new Set<() => void>();

function emitState(next: DictationSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
  if (next.owner) {
    window.dispatchEvent(new CustomEvent(DICTATION_STATE_EVENT, {
      detail: {
        tabId: next.owner.tabId,
        recording: next.recording,
        stopping: next.stopping,
        mode: next.owner.mode,
      },
    }));
  }
}

function patchState(patch: Partial<DictationSnapshot>) {
  emitState({ ...snapshot, ...patch });
}

function publishOwnerIdle(owner: DictationOwner | null) {
  if (!owner) return;
  window.dispatchEvent(new CustomEvent(DICTATION_STATE_EVENT, {
    detail: {
      tabId: owner.tabId,
      recording: false,
      stopping: false,
      mode: owner.mode,
    },
  }));
}

function flushSubmitRequests(payload: { success: boolean; delivered: boolean; hadText: boolean; error?: string }) {
  const owner = snapshot.owner;
  const requestIds = pendingSubmitRequests.splice(0);
  if (!owner) return;
  requestIds.forEach((requestId) => {
    window.dispatchEvent(new CustomEvent(DICTATION_DELIVERED_EVENT, {
      detail: { tabId: owner.tabId, requestId, ...payload },
    }));
  });
}

async function deliverFinal(text: string, mode: DictationMode, tabId: string): Promise<{ success: boolean; delivered: boolean; error?: string }> {
  if (mode === 'pty-claude' || mode === 'pty-codex') {
    const result = await ipcRenderer.invoke('terminal:paste', { tabId, content: text, submit: false });
    if (!result?.success) {
      return { success: false, delivered: false, error: result?.error || 'terminal:paste failed' };
    }
    return { success: true, delivered: true };
  }
  if (mode === 'sdk') {
    window.dispatchEvent(new CustomEvent('claude-sdk:dictation-deliver', {
      detail: { tabId, text },
    }));
    return { success: true, delivered: true };
  }
  return { success: true, delivered: false };
}

async function finalizeStop(session: DictationSession, source: string) {
  if (finalizedSessionRef === session) return;
  finalizedSessionRef = session;
  if (sessionRef === session) sessionRef = null;

  ipcRenderer.send('log:renderer', '[DictationManager] onStopped source=' + source);
  const owner = snapshot.owner;
  const captured = (session.getText() || '').trim();
  let success = true;
  let delivered = false;
  let error: string | undefined;

  if (owner && captured) {
    appendDictationEntry(captured);
    try {
      const result = await deliverFinal(captured, owner.mode, owner.tabId);
      success = result.success;
      delivered = result.delivered;
      error = result.error;
    } catch (e: any) {
      success = false;
      error = e?.message || String(e);
    }
  }

  if (!success && error) notifyError?.('Dictation deliver: ' + error);
  publishOwnerIdle(owner);
  patchState({ recording: false, stopping: false });
  flushSubmitRequests({ success, delivered, hadText: !!captured, error });
  emitState(IDLE_SNAPSHOT);
}

export async function startDictation(owner: DictationOwner, onError?: (message: string) => void): Promise<void> {
  if (snapshot.recording || snapshot.stopping) return;

  ipcRenderer.send('log:renderer', '[DictationManager] start tab=' + owner.tabId + ' mode=' + owner.mode);
  notifyError = onError || null;
  finalizedSessionRef = null;
  pendingSubmitRequests = [];
  emitState({
    owner,
    recording: true,
    stopping: false,
    final: '',
    partial: '',
  });

  const session = new DictationSession({
    fetchToken: async () => {
      const r = await ipcRenderer.invoke('soniox:mint-token');
      if (!r?.api_key) throw new Error('no api_key in token response');
      return r.api_key as string;
    },
    onUpdate: ({ final, partial }) => {
      patchState({ final, partial });
    },
    onConnected: () => {
      ipcRenderer.send('log:renderer', '[DictationManager] onConnected');
    },
    onError: (msg) => {
      ipcRenderer.send('log:renderer', '[DictationManager] onError ' + msg);
      if (msg === 'socket error' && (snapshot.stopping || !snapshot.recording)) return;
      notifyError?.('Dictation: ' + msg);
    },
    onStopped: () => { void finalizeStop(session, 'onStopped'); },
    languageHints: ['en', 'ru'],
  });

  sessionRef = session;
  await session.start();
}

export async function stopActiveDictation(): Promise<void> {
  if (snapshot.stopping) return;
  const session = sessionRef;
  if (!session) {
    publishOwnerIdle(snapshot.owner);
    patchState({ recording: false, stopping: false });
    flushSubmitRequests({ success: true, delivered: false, hadText: false });
    emitState(IDLE_SNAPSHOT);
    return;
  }

  ipcRenderer.send('log:renderer', '[DictationManager] stop tab=' + (snapshot.owner?.tabId || 'unknown'));
  patchState({ recording: true, stopping: true });
  await session.stop();
  window.setTimeout(() => {
    if (sessionRef === session) {
      ipcRenderer.send('log:renderer', '[DictationManager] onStopped never fired -> force reset');
      void finalizeStop(session, 'fallback');
    }
  }, 4000);
}

export async function cancelActiveDictation(): Promise<void> {
  if (!snapshot.recording && !snapshot.stopping) return;
  const session = sessionRef;
  const owner = snapshot.owner;
  if (session) {
    finalizedSessionRef = session;
    sessionRef = null;
  }

  ipcRenderer.send('log:renderer', '[DictationManager] cancel tab=' + (owner?.tabId || 'unknown'));
  flushSubmitRequests({ success: true, delivered: false, hadText: false });
  publishOwnerIdle(owner);
  emitState(IDLE_SNAPSHOT);
  if (session) {
    await session.cancel();
  }
}

function respondNoActiveRequest(tabId: string, requestId: string) {
  window.dispatchEvent(new CustomEvent(DICTATION_DELIVERED_EVENT, {
    detail: { tabId, requestId, success: true, delivered: false, hadText: false },
  }));
}

let eventBridgeInstalled = false;
function ensureEventBridge() {
  if (eventBridgeInstalled) return;
  eventBridgeInstalled = true;
  window.addEventListener(DICTATION_STOP_AND_DELIVER_EVENT, (e: Event) => {
    const { tabId, requestId } = (e as CustomEvent).detail || {};
    if (typeof tabId !== 'string' || typeof requestId !== 'string') return;
    if (snapshot.owner?.tabId !== tabId) {
      respondNoActiveRequest(tabId, requestId);
      return;
    }
    if (!pendingSubmitRequests.includes(requestId)) {
      pendingSubmitRequests.push(requestId);
    }
    if (snapshot.recording && !snapshot.stopping) {
      void stopActiveDictation();
    } else if (!snapshot.recording && !snapshot.stopping) {
      flushSubmitRequests({ success: true, delivered: false, hadText: false });
    }
  });
}

ensureEventBridge();

export function getDictationSnapshot(): DictationSnapshot {
  return snapshot;
}

export function subscribeDictation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDictationSnapshot(): DictationSnapshot {
  return useSyncExternalStore(subscribeDictation, getDictationSnapshot, getDictationSnapshot);
}
