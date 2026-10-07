import { useEffect } from 'react';
import { usePromptQueueStore, serializePromptQueueCore, subscribePromptQueueEditorLocks } from '../store/usePromptQueueStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useProjectsStore } from '../store/useProjectsStore';
import { useAutoCompactStore } from '../store/useAutoCompactStore';
import { currentRunAfterMetadata, currentRunAfterEpoch } from '../utils/runAfterApplicationBridge';
import { subscribePromptQueueRuntime } from './usePromptQueueRunner';
import { subscribeHistoryPromptHandoffs } from '../utils/historyPromptHandoffs';

const { ipcRenderer } = window.require('electron');

// ── Prompt-queue → mobile mirror ─────────────────────────────────────────────
// The desktop store (usePromptQueueStore) is the single source of truth for the
// per-tab "Run after" queue, and the App-root usePromptQueueRunner is the single
// firing engine. A connected phone renders a mirror of that queue and pushes
// mutations back through the mutatePromptQueue bridge action — so the only thing
// left is to PUSH live queue deltas TO the phone, the same way main.js broadcasts
// busy/done/message events over SSE.
//
// This hook (mounted ONCE at App root, next to usePromptQueueRunner) subscribes
// to the store, and on every change diffs each tab's PromptQueueCore against the
// last value it sent. When a tab's core JSON changes it fires a fire-and-forget
// IPC `web:broadcast-queue` → main relays it to web-server's webBroadcast() as a
// `queue-update` event. webBroadcast no-ops when no phone is subscribed to that
// tab, so on the 99% desktop-only path this costs one JSON.stringify + a Map diff
// per store mutation and nothing else.
//
// Why App-root and not the overlay: identical reasoning to the runner — the
// overlay unmounts the moment the user leaves the Claude tab, but the phone may
// be watching a BACKGROUND tab. A gated-by-active-tab broadcaster would go silent
// exactly when the phone needs the delta. See
// fact-prompt-queue.md::Auto-runner — singleton hook, не в overlay.
export function usePromptQueueWebSync() {
  useEffect(() => {
    // Last core JSON we broadcast per tab. Lives in the effect closure (the hook
    // mounts once for the app's lifetime). A tab dropping out of the store (queue
    // cleared to cold) is itself a change worth sending once, then we forget it.
    const lastSent = new Map<string, string>();
    const handoffSubscriptions = new Map<string, () => void>();

    const broadcast = (tabId: string, core: ReturnType<typeof serializePromptQueueCore>) => {
      const runAfter = currentRunAfterMetadata(tabId);
      const signature = JSON.stringify([core, runAfter?.epoch, runAfter?.revision, runAfter?.viewRevision, runAfter?.scopeKey]);
      if (lastSent.get(tabId) === signature) return;
      lastSent.set(tabId, signature);
      // Fire-and-forget. main.js relays to webBroadcast (no reply expected).
      try {
        ipcRenderer.send('web:broadcast-queue', { tabId, queue: core, ...(runAfter ? { runAfter } : {}) });
      } catch {
        // ignore — broadcasting is best-effort; the phone re-fetches on reconnect.
      }
    };

    const diffAndSend = (queues: Map<string, any>) => {
      const seen = new Set<string>();
      for (const [tabId, q] of queues) {
        seen.add(tabId);
        const core = serializePromptQueueCore(q);
        broadcast(tabId, core);
        if (!handoffSubscriptions.has(tabId)) handoffSubscriptions.set(tabId,
          subscribeHistoryPromptHandoffs(tabId, () => syncOne(tabId)));
      }
      // A tab that left the store (clearQueue) — send one empty-ish update so a
      // watching phone clears its panel, then stop tracking it.
      for (const tabId of Array.from(lastSent.keys())) {
        if (seen.has(tabId)) continue;
        broadcast(tabId, serializePromptQueueCore(usePromptQueueStore.getState().getQueue(tabId)));
        lastSent.delete(tabId);
        handoffSubscriptions.get(tabId)?.(); handoffSubscriptions.delete(tabId);
      }
    };

    const syncOne = (tabId: string) => {
      if (usePromptQueueStore.getState().queues.has(tabId)) broadcast(tabId,
        serializePromptQueueCore(usePromptQueueStore.getState().getQueue(tabId)));
    };
    const unsubscribe = usePromptQueueStore.subscribe((state) => {
      diffAndSend(state.queues);
    });
    const refresh = () => {
      diffAndSend(usePromptQueueStore.getState().queues);
      const epoch = currentRunAfterEpoch();
      if (epoch) ipcRenderer.send('run-after:metadata-wake', { epoch });
    };
    let workspaceKey = '';
    const workspaceSubscription = useWorkspaceStore.subscribe(state => {
      const key = JSON.stringify({ spaces: state.spaces.map(space => [space.id, space.name, space.projectIds, space.icon]),
        tabs: [...state.openProjects].flatMap(([projectId, value]) => [...value.tabs.values()]
          .map(tab => [projectId, tab.id, tab.name, tab.groupId, tab.parentTabId, tab.commandType, tab.claudeSessionId, tab.codexSessionId, tab.tabType])) });
      if (key !== workspaceKey) { workspaceKey = key; refresh(); }
    });
    const editorSubscription = subscribePromptQueueEditorLocks(tabId => syncOne(tabId));
    const runtimeSubscription = subscribePromptQueueRuntime(tabId => syncOne(tabId));
    const compactSubscription = useAutoCompactStore.subscribe(refresh);
    const projectsSubscription = useProjectsStore.subscribe(refresh);
    const channels = ['claude:busy-state', 'codex:busy-state', 'gemini:busy-state', 'agent:readiness-changed', 'agent:operational-phase'];
    const runtime = (_event: unknown, value: { tabId?: string }) => { if (value?.tabId) syncOne(value.tabId); };
    for (const channel of channels) ipcRenderer.on(channel, runtime);
    return () => {
      unsubscribe(); workspaceSubscription(); editorSubscription(); runtimeSubscription(); compactSubscription(); projectsSubscription();
      for (const channel of channels) ipcRenderer.removeListener(channel, runtime);
      for (const release of handoffSubscriptions.values()) release();
    };
  }, []);
}
