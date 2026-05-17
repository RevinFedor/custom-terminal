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
//   the busy=true→false transition that ALREADY happened in the background is
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

  // Cold-start watcher: when ALL three conditions are true and Claude is idle,
  // either fire immediately OR start the firstDelay countdown.
  //   queue.items.length > 0  AND  queue.autoRun === true  AND  claude is idle
  // Triggered on EITHER of two edges (whichever happens last makes the trio true):
  //   (a) items 0 → N  (user added a prompt; autoRun was already on)
  //   (b) autoRun false → true (user armed; items were already queued)
  // Edge (b) covers the case: "Claude finished without me, I forgot to arm —
  // I come back, hit Run after — first prompt must fire immediately, not wait
  // for a never-coming turn-end". Without this, the prompt sits forever.
  //
  // FirstDelay flow:
  //   q.firstDelaySeconds > 0 AND no active countdown → startFirstDelayCountdown.
  //     A per-tab setTimeout will later call popNext + clearFirstDelayCountdown.
  //   q.firstDelaySeconds === 0 → immediate popNext + send-command (legacy path).
  //   Subsequent items (turn-end IPC handler above) NEVER use this — only the
  //   very first cold-start fire after arm is delayed. After the first item is
  //   sent, the rest fire via Stop hook with zero delay, exactly as before.
  //
  // Subscribe to queue changes via store subscription (not React useEffect on
  // items — they live in a Map keyed by tabId, we'd need to subscribe per-tab).
  useEffect(() => {
    // Per-tab pending fire timer for active first-delay countdowns. Cleared on
    // user disarm (autoRun false) or when timer elapses and we fire.
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearTimer = (tabId: string) => {
      const t = pendingTimers.get(tabId);
      if (t) { clearTimeout(t); pendingTimers.delete(tabId); }
    };

    // Shared cold-start firing logic — pops head + sends + auto-disarms.
    // Used both by zero-delay path and by the delayed-timer callback.
    let firing = false;
    const fireHead = (tabId: string) => {
      if (firing) return;
      firing = true;
      try {
        const q = usePromptQueueStore.getState().getQueue(tabId);
        if (!q.autoRun || q.items.length === 0) return;
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
    };

    const unsubscribe = usePromptQueueStore.subscribe((state, prevState) => {
      for (const [tabId, q] of state.queues) {
        const prevQ = prevState.queues.get(tabId);

        // Disarm-while-counting: if autoRun went false OR claude turned busy
        // while a countdown was running, cancel the pending timer. (The store
        // helpers handle the remaining-seconds bookkeeping separately — UI's
        // Run-toggle calls cancelFirstDelayCountdown before flipping autoRun off.)
        if (prevQ && prevQ.firstDelayCountdownAt !== null && q.firstDelayCountdownAt === null) {
          clearTimer(tabId);
        }
        if (prevQ && prevQ.autoRun && !q.autoRun) {
          clearTimer(tabId);
        }

        if (!q.autoRun || q.items.length === 0) continue;

        // Edges to consider for cold-start (immediate fire OR countdown start).
        const prevCount = prevQ?.items.length ?? 0;
        const prevAutoRun = prevQ?.autoRun ?? false;
        const itemsArrived = prevCount === 0 && q.items.length > 0;
        const autoRunArmed = !prevAutoRun && q.autoRun;
        if (!itemsArrived && !autoRunArmed) continue;

        // claude busy → turn-end IPC handler will pick it up later, skip.
        const isBusy = prevBusyRef.current.get(tabId) ?? false;
        if (isBusy) continue;

        // Already counting down (e.g. items added during an active countdown)
        // → don't restart. The existing timer will fire when due.
        if (q.firstDelayCountdownAt !== null) continue;

        if (q.firstDelaySeconds > 0) {
          // Start countdown. Store records the timestamp; we schedule the real fire.
          const delayMs = q.firstDelaySeconds * 1000;
          usePromptQueueStore.getState().startFirstDelayCountdown(tabId);
          clearTimer(tabId);
          pendingTimers.set(tabId, setTimeout(() => {
            pendingTimers.delete(tabId);
            const q2 = usePromptQueueStore.getState().getQueue(tabId);
            // Re-check: user may have disarmed while we waited.
            if (!q2.autoRun || q2.items.length === 0 || q2.firstDelayCountdownAt === null) {
              usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
              return;
            }
            usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
            fireHead(tabId);
          }, delayMs));
        } else {
          fireHead(tabId);
        }
      }
    });
    return () => {
      unsubscribe();
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
    };
  }, []);
}
