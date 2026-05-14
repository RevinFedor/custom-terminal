import { useEffect, useRef } from 'react';
import { usePromptQueueStore } from '../store/usePromptQueueStore';
import { useUIStore } from '../store/useUIStore';

const { ipcRenderer } = window.require('electron');

// Always-mounted auto-runner for the per-tab prompt queue. Mounted ONCE at app
// root (App.tsx) so it survives tab switches, project switches, view changes —
// anywhere the user could navigate away from the overlay component itself.
//
// Why this isn't inside PromptQueueOverlay anymore:
//   The overlay is gated by `effectiveActive && isClaudeTab && hasClaudeSession
//   && claudeProcessAlive`. effectiveActive flips to false the moment the user
//   switches to any other tab. Overlay unmounts → useEffect cleanup runs →
//   prevBusyRef goes away → on remount prevBusyRef.current = current busy, so
#   the busy=true→false transition that ALREADY happened in the background is
//   missed. Net effect: user arms Run after, switches to a Gemini tab to work,
//   Claude finishes its turn — next queued prompt never fires until they come
//   back to the Claude tab. Contradicts the entire purpose of the feature.
//
// Now the runner lives outside the overlay's lifecycle:
//   - Tracks claudeBusy per tab via a Map<tabId, boolean>
//   - Subscribes to claude:busy-state once at mount (in App.tsx)
//   - Fires send-command / stop-ai-process whenever the busy→idle edge happens,
//     regardless of which tab the UI is showing.
export function usePromptQueueRunner() {
  // Per-tab previous busy state (the "wasBusy" snapshot before each transition).
  // Map instead of useRef-of-Record so tab additions/removals are local writes,
  // not React state updates — runner stays render-free.
  const prevBusyRef = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    const handleBusyState = (_: any, data: { tabId: string; busy: boolean }) => {
      const { tabId, busy } = data;
      const wasBusy = prevBusyRef.current.get(tabId) ?? false;
      prevBusyRef.current.set(tabId, busy);

      // Only care about turn-end transition (busy true → false). Turn-start
      // (false → true) doesn't trigger queue actions — user submitted manually
      // or our send-command IPC kicked it off.
      if (!(wasBusy && !busy)) return;

      const queue = usePromptQueueStore.getState().getQueue(tabId);
      const { popNext, setAutoRun, setStopAfter } = usePromptQueueStore.getState();
      const showToast = useUIStore.getState().showToast;

      // autoRun: send next queued prompt
      if (queue.autoRun && queue.items.length > 0) {
        const beforePop = queue.items.length;
        const head = popNext(tabId);
        if (head) {
          ipcRenderer.invoke('claude:send-command', tabId, head.text).catch((e: unknown) => {
            console.error('[PromptQueueRunner] send failed for tab', tabId, e);
          });
          // Auto-disarm after the last prompt drained from the queue.
          if (beforePop === 1) setAutoRun(tabId, false);
        }
        return; // wait for THIS prompt's turn before considering stopAfter
      }

      // stopAfter: queue empty (or autoRun off), turn finished → kill claude
      if (queue.stopAfter) {
        ipcRenderer.invoke('terminal:stop-ai-process', tabId)
          .then((res: { success?: boolean; error?: string }) => {
            if (res?.success) showToast('Claude stopped', 'success', 1500);
            else if (res?.error) console.warn('[PromptQueueRunner] stop failed:', res.error);
          })
          .catch((e: unknown) => console.error('[PromptQueueRunner] stop error', e));
        setStopAfter(tabId, false);
      }
    };

    ipcRenderer.on('claude:busy-state', handleBusyState);
    return () => { ipcRenderer.removeListener('claude:busy-state', handleBusyState); };
  }, []);

  // Cold-start watcher: when items appear in a queue while Claude is idle, fire immediately.
  // Without this, user has to wait for Claude to first become busy and then idle before the
  // first queued prompt sends — which never happens if Claude is fresh and idle.
  // Subscribe to queue changes via store subscription (not React useEffect on items —
  // because items live in a Map keyed by tabId, we'd need to subscribe to all tabs).
  useEffect(() => {
    let firing = false;
    const unsubscribe = usePromptQueueStore.subscribe((state, prevState) => {
      if (firing) return; // re-entrancy guard while we're processing a fire
      // Look for tabs whose queue went from empty → non-empty AND autoRun is on AND claude is idle.
      for (const [tabId, q] of state.queues) {
        if (!q.autoRun || q.items.length === 0) continue;
        const prevQ = prevState.queues.get(tabId);
        const prevCount = prevQ?.items.length ?? 0;
        if (prevCount > 0) continue; // wasn't empty — auto-runner above handles steady state
        // Was empty, now has items. Check if claude is currently idle (i.e. not in mid-turn).
        // prevBusyRef tracks the latest busy state per tab from the IPC listener.
        const isBusy = prevBusyRef.current.get(tabId) ?? false;
        if (isBusy) continue; // mid-turn — autoRun will fire on the next turn-end naturally

        firing = true;
        try {
          const beforePop = q.items.length;
          const head = usePromptQueueStore.getState().popNext(tabId);
          if (head) {
            ipcRenderer.invoke('claude:send-command', tabId, head.text).catch((e: unknown) => {
              console.error('[PromptQueueRunner] cold-start send failed for tab', tabId, e);
            });
            if (beforePop === 1) usePromptQueueStore.getState().setAutoRun(tabId, false);
          }
        } finally {
          firing = false;
        }
      }
    });
    return unsubscribe;
  }, []);
}
