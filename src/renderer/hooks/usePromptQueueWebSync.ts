import { useEffect } from 'react';
import { usePromptQueueStore, serializePromptQueueCore } from '../store/usePromptQueueStore';

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

    const broadcast = (tabId: string, core: ReturnType<typeof serializePromptQueueCore>) => {
      // Fire-and-forget. main.js relays to webBroadcast (no reply expected).
      try {
        ipcRenderer.send('web:broadcast-queue', { tabId, queue: core });
      } catch {
        // ignore — broadcasting is best-effort; the phone re-fetches on reconnect.
      }
    };

    const diffAndSend = (queues: Map<string, any>) => {
      const seen = new Set<string>();
      for (const [tabId, q] of queues) {
        seen.add(tabId);
        const core = serializePromptQueueCore(q);
        const json = JSON.stringify(core);
        if (lastSent.get(tabId) === json) continue;
        lastSent.set(tabId, json);
        broadcast(tabId, core);
      }
      // A tab that left the store (clearQueue) — send one empty-ish update so a
      // watching phone clears its panel, then stop tracking it.
      for (const tabId of Array.from(lastSent.keys())) {
        if (seen.has(tabId)) continue;
        lastSent.delete(tabId);
        broadcast(tabId, serializePromptQueueCore(usePromptQueueStore.getState().getQueue(tabId)));
      }
    };

    const unsubscribe = usePromptQueueStore.subscribe((state) => {
      diffAndSend(state.queues);
    });
    return () => { unsubscribe(); };
  }, []);
}
