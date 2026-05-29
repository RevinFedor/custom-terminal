import { useEffect } from 'react';
import { usePromptQueueStore } from '../store/usePromptQueueStore';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

const { ipcRenderer } = window.require('electron');

// Walk openProjects → find the project that owns this tab. Used after stopAfter
// fires when closeAfter is also armed — we need both ids to call closeTab.
// O(N) but openProjects rarely has more than a handful of entries.
function findProjectIdForTab(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const [projId, ws] of state.openProjects) {
    if (ws.tabs.has(tabId)) return projId;
  }
  return null;
}

// True if `tabId` exists in any open project workspace. Used to validate stale
// runAfterTabId values (target tab was closed) — without this the runner would
// wait forever for a dead tab's busy→idle edge.
function tabExists(tabId: string): boolean {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    if (ws.tabs.has(tabId)) return true;
  }
  return false;
}

// When the per-tab post-prompt toggle is ON and post-prompt text is non-empty,
// every fired queue item gets the post-prompt appended after a blank-line
// separator. Empty text is treated as disabled (no glue line, no warning).
// Single chokepoint: every send-command call from the runner goes through this.
function withPostPrompt(tabId: string, body: string): string {
  const q = usePromptQueueStore.getState().getQueue(tabId);
  if (!q.postPromptEnabled) return body;
  const post = q.postPromptText;
  if (!post || !post.trim()) return body;
  return body + '\n\n' + post;
}

// Module-scoped per-tab previous busy state. Lives OUTSIDE React state so that
// re-mounts of the hook don't reset busy tracking (which would re-introduce the
// stale-state bug that prompted moving the runner out of the overlay in the
// first place). Written by the busy-state IPC handler, read by both the
// turn-end handler AND the cold-start subscription — they must share the same
// truth or edges get double-counted / missed.
const prevBusyRef = new Map<string, boolean>();

// Public accessor — the overlay reads this to render the "target tab is busy
// now" spinner inside the Run-after dropdown. Not used by the runner itself.
export function isTabBusyNow(tabId: string): boolean {
  return prevBusyRef.get(tabId) === true;
}

// Always-mounted auto-runner for the per-tab prompt queue. Mounted ONCE at app
// root (App.tsx) so it survives tab switches, project switches, view changes —
// anywhere the user could navigate away from the overlay component itself.
//
// Subscribes to three busy-state channels:
//   - claude:busy-state      — PTY claude tabs + SDK tabs forwarded by main
//                              (main.js::ipcMain.on('claude-sdk:busy-state'))
//   - gemini:busy-state      — Gemini PTY tabs
// Both feed into the same per-tab `prevBusyRef` map keyed by tabId. From the
// runner's POV "any agent on tab X is busy" is a single bit — the user picks
// a TAB to wait on, not a specific engine.
//
// Two firing paths exist:
//   (1) Own-tab edge (default): queue lives on tab A, user did NOT pick a
//       target → wait for busy→idle on tab A itself. Identical to old behaviour.
//   (2) Target-tab edge: queue lives on tab A, user picked tab B in dropdown →
//       wait for busy→idle on tab B. When that fires, popNext from queue on
//       tab A and send-command to tab A (NOT to tab B — the queue items belong
//       to A, B is just the trigger source).
//
// Lookup direction inverted vs default: the IPC handler doesn't know "which
// queue is waiting on me?" by tabId alone — we have to walk all queues each
// busy event. O(N) but N = number of armed Run-after queues, usually 0-3.
export function usePromptQueueRunner() {
  useEffect(() => {
    // Shared firing logic — pops head, sends to OWNER tab, auto-disarms on last.
    // ownerTabId = which queue's head to pop (always the queue-owner, never the
    // trigger tab). triggerTabId is only used for diagnostics in logs.
    const fireQueueOwner = (ownerTabId: string, triggerTabId: string) => {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const { popNext, setAutoRun } = usePromptQueueStore.getState();
      if (!queue.autoRun || queue.items.length === 0) return;

      const beforePop = queue.items.length;
      const head = popNext(ownerTabId);
      if (!head) return;

      const payload = withPostPrompt(ownerTabId, head.text);
      const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
      console.log('[PromptQueueRunner] fire owner=' + ownerTabId.slice(-8) + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8) + ' remaining=' + (beforePop - 1));
      ipcRenderer.invoke('claude:send-command', ownerTabId, payload).catch((e: unknown) => {
        console.error('[PromptQueueRunner] send failed for owner tab', ownerTabId, e);
      });
      if (beforePop === 1) setAutoRun(ownerTabId, false);
    };

    // Walk all queues, find one(s) waiting on `triggerTabId` for turn-end edge.
    // For default (runAfterTabId === null) the owner IS the trigger. For
    // pivoted (runAfterTabId !== null) the owner is some OTHER tab whose queue
    // wants this tab's transition.
    const findOwnersWaitingOn = (triggerTabId: string): string[] => {
      const owners: string[] = [];
      const queues = usePromptQueueStore.getState().queues;
      for (const [ownerTabId, q] of queues) {
        if (!q.autoRun || q.items.length === 0) continue;
        // Validate stale target before pivoting — if the picked tab was closed,
        // self-clear and fall through to default own-tab behaviour. This is
        // the lazy validation promised in the store schema comment.
        if (q.runAfterTabId && !tabExists(q.runAfterTabId)) {
          console.warn('[PromptQueueRunner] runAfterTabId ' + q.runAfterTabId.slice(-8) + ' no longer exists, clearing → owner=' + ownerTabId.slice(-8));
          usePromptQueueStore.getState().setRunAfterTab(ownerTabId, null);
          // After clear, q.runAfterTabId is stale in our snapshot; treat as null.
          if (ownerTabId === triggerTabId) owners.push(ownerTabId);
          continue;
        }
        const effectiveTrigger = q.runAfterTabId ?? ownerTabId;
        if (effectiveTrigger === triggerTabId) owners.push(ownerTabId);
      }
      return owners;
    };

    const handleBusyState = (channel: 'claude' | 'gemini') =>
      (_: any, data: { tabId: string; busy: boolean; reason?: string }) => {
        const { tabId, busy, reason } = data;
        const wasBusy = prevBusyRef.get(tabId) ?? false;
        prevBusyRef.set(tabId, busy);

        // Only care about turn-end transition (busy true → false). Turn-start
        // (false → true) doesn't trigger queue actions — user submitted manually
        // or our send-command IPC kicked it off.
        if (!(wasBusy && !busy)) return;

        // reason:'manual-stop' — пользователь явно нажал Stop chip / context-menu
        // Stop / двойной Esc. Это НЕ обычный turn-end. Auto-run следующего промпта
        // создал бы петлю «выключил → процесс снова запустился из очереди». См.
        // main.js::terminal:stop-ai-process. Stop-after тоже пропускаем — terminal
        // уже мёртв, повторный SIGTERM на «нет AI process» вернёт ошибку.
        //
        // The manual-stop guard ALSO applies to pivoted queues: if a user stops
        // the trigger tab, we should NOT fire the owner's queue (the trigger
        // didn't naturally finish, the user yanked it). Skip across the board.
        if (reason === 'manual-stop') {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' manual-stop → skip auto-run/stop-after');
          return;
        }

        // Step 1: pivoted queues — any OWNER tab whose runAfterTabId === tabId.
        // Their head goes to the OWNER (not this trigger tab).
        const owners = findOwnersWaitingOn(tabId);
        for (const ownerTabId of owners) {
          // For pivoted queues we fire and continue — they don't consume the
          // trigger's stopAfter/closeAfter (those belong to the trigger's own
          // queue, processed separately below if applicable).
          if (ownerTabId !== tabId) {
            fireQueueOwner(ownerTabId, tabId);
          }
        }

        // Step 2: own-tab logic for the trigger tab itself (default path).
        // Only when the trigger tab's own queue is NOT pivoted away — pivoted
        // queues run when their target finishes, not when own claude finishes.
        const ownQueue = usePromptQueueStore.getState().getQueue(tabId);
        const { setStopAfter } = usePromptQueueStore.getState();
        const showToast = useUIStore.getState().showToast;

        // autoRun: send next queued prompt (only if not pivoted — pivoted
        // queues already handled in step 1's loop when this very tab IS the
        // owner with target === self, which we coerce to null in the store).
        if (ownQueue.autoRun && ownQueue.items.length > 0 && !ownQueue.runAfterTabId) {
          fireQueueOwner(tabId, tabId);
          return; // wait for THIS prompt's turn before considering stopAfter
        }

        // stopAfter: queue empty (or autoRun off / pivoted away), turn finished
        // → kill claude. closeAfter (chained on top): after the stop fires,
        // also close the whole tab via useWorkspaceStore.closeTab with
        // skipProcessCheck so no confirm dialog appears (we just killed the
        // process — there's nothing to ask).
        if (ownQueue.stopAfter) {
          const shouldCloseTab = ownQueue.closeAfter;
          ipcRenderer.invoke('terminal:stop-ai-process', tabId)
            .then(async (res: { success?: boolean; error?: string }) => {
              if (res?.success) {
                showToast(shouldCloseTab ? 'Claude stopped, closing tab' : 'Claude stopped', 'success', 1500);
              } else if (res?.error) {
                console.warn('[PromptQueueRunner] stop failed:', res.error);
              }
              if (shouldCloseTab) {
                const projectId = findProjectIdForTab(tabId);
                if (!projectId) {
                  console.warn('[PromptQueueRunner] closeAfter: no project found for tab', tabId);
                  return;
                }
                try {
                  await useWorkspaceStore.getState().closeTab(projectId, tabId, {
                    skipProcessCheck: true,
                    forceCleanup: true,
                  });
                } catch (e) {
                  console.error('[PromptQueueRunner] closeAfter failed:', e);
                }
              }
            })
            .catch((e: unknown) => console.error('[PromptQueueRunner] stop error', e));
          setStopAfter(tabId, false);
        }
      };

    const claudeHandler = handleBusyState('claude');
    const geminiHandler = handleBusyState('gemini');
    ipcRenderer.on('claude:busy-state', claudeHandler);
    ipcRenderer.on('gemini:busy-state', geminiHandler);
    return () => {
      ipcRenderer.removeListener('claude:busy-state', claudeHandler);
      ipcRenderer.removeListener('gemini:busy-state', geminiHandler);
    };
  }, []);

  // Cold-start watcher: when ALL three conditions are true and the EFFECTIVE
  // trigger tab (own tab OR runAfterTabId) is idle, either fire immediately OR
  // start the firstDelay countdown.
  //   queue.items.length > 0  AND  queue.autoRun === true  AND  trigger is idle
  // Triggered on EITHER of two edges (whichever happens last makes the trio true):
  //   (a) items 0 → N  (user added a prompt; autoRun was already on)
  //   (b) autoRun false → true (user armed; items were already queued)
  // Edge (b) covers the case: "Claude finished without me, I forgot to arm —
  // I come back, hit Run after — first prompt must fire immediately, not wait
  // for a never-coming turn-end". Without this, the prompt sits forever.
  //
  // Pivoted-target behaviour: cold-start ONLY fires if the trigger tab is
  // currently idle AND has been busy at least once (i.e. there is a "previous"
  // state to compare against — we know it really is idle, not just unknown).
  // If trigger has never been busy (user picked a fresh tab they haven't
  // submitted anything to yet) we wait — the busy-state handler above will
  // pick up the eventual busy→idle edge whenever the user activates it and
  // sends a prompt. Without this guard, picking an inactive tab would fire
  // the queue IMMEDIATELY (trigger is "idle" because never seen busy = false
  // default) — exact opposite of user intent.
  useEffect(() => {
    const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearTimer = (tabId: string) => {
      const t = pendingTimers.get(tabId);
      if (t) { clearTimeout(t); pendingTimers.delete(tabId); }
    };

    let firing = false;
    const fireHead = (ownerTabId: string, triggerTabId: string) => {
      if (firing) return;
      firing = true;
      try {
        const q = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!q.autoRun || q.items.length === 0) return;
        const beforePop = q.items.length;
        const head = usePromptQueueStore.getState().popNext(ownerTabId);
        if (head) {
          const payload = withPostPrompt(ownerTabId, head.text);
          const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
          console.log('[PromptQueueRunner] cold-start owner=' + ownerTabId.slice(-8) + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8));
          ipcRenderer.invoke('claude:send-command', ownerTabId, payload).catch((e: unknown) => {
            console.error('[PromptQueueRunner] cold-start send failed for tab', ownerTabId, e);
          });
          if (beforePop === 1) usePromptQueueStore.getState().setAutoRun(ownerTabId, false);
        }
      } finally {
        firing = false;
      }
    };

    const unsubscribe = usePromptQueueStore.subscribe((state, prevState) => {
      for (const [tabId, q] of state.queues) {
        const prevQ = prevState.queues.get(tabId);

        // Disarm-while-counting: if autoRun went false OR claude turned busy
        // while a countdown was running, cancel the pending timer.
        if (prevQ && prevQ.firstDelayCountdownAt !== null && q.firstDelayCountdownAt === null) {
          clearTimer(tabId);
        }
        if (prevQ && prevQ.autoRun && !q.autoRun) {
          clearTimer(tabId);
        }
        // If the user re-targets to a different tab while armed, cancel any
        // pending countdown — the old trigger no longer applies. The new
        // target will start a fresh cycle via the autoRunArmed edge below
        // (well, NOT quite — autoRun is still true; we need a third edge:
        // target-changed-while-armed. Handled via explicit check below.)
        const prevTarget = prevQ?.runAfterTabId ?? null;
        const targetChanged = (prevTarget ?? null) !== (q.runAfterTabId ?? null);
        if (targetChanged && prevQ?.autoRun) {
          clearTimer(tabId);
        }

        if (!q.autoRun || q.items.length === 0) continue;

        const prevCount = prevQ?.items.length ?? 0;
        const prevAutoRun = prevQ?.autoRun ?? false;
        const itemsArrived = prevCount === 0 && q.items.length > 0;
        const autoRunArmed = !prevAutoRun && q.autoRun;
        // Treat "target swapped while armed" as an arm-edge too — the user
        // explicitly changed who we're waiting on, evaluate cold-start fit
        // against the new target.
        const armEdge = itemsArrived || autoRunArmed || (targetChanged && q.autoRun);
        if (!armEdge) continue;

        // Validate the picked target — stale id behaves as null (fall back to
        // own-tab default).
        const effectiveTrigger = (q.runAfterTabId && tabExists(q.runAfterTabId))
          ? q.runAfterTabId
          : tabId;

        if (effectiveTrigger !== tabId) {
          // Pivoted: only fire cold-start if the target has been seen busy at
          // least once AND is currently idle. Otherwise wait for the busy→idle
          // edge in the IPC handler. The "seen at least once" gate prevents
          // firing on a target the user hasn't touched yet.
          if (!prevBusyRef.has(effectiveTrigger)) {
            console.log('[PromptQueueRunner] cold-start owner=' + tabId.slice(-8) + ' target=' + effectiveTrigger.slice(-8) + ' has no busy history → wait');
            continue;
          }
          if (prevBusyRef.get(effectiveTrigger) === true) {
            // Target is busy right now — wait for its idle edge.
            continue;
          }
          // Target is idle and was seen busy before. Cold-start fires.
          // (No firstDelay support for pivoted — keep it simple; the user
          // already configured a delay implicitly by picking a target tab.)
          fireHead(tabId, effectiveTrigger);
          continue;
        }

        // Default own-tab cold-start (unchanged behaviour).
        const isBusy = prevBusyRef.get(tabId) ?? false;
        if (isBusy) continue;

        if (q.firstDelayCountdownAt !== null) continue;

        if (q.firstDelaySeconds > 0) {
          const delayMs = q.firstDelaySeconds * 1000;
          usePromptQueueStore.getState().startFirstDelayCountdown(tabId);
          clearTimer(tabId);
          pendingTimers.set(tabId, setTimeout(() => {
            pendingTimers.delete(tabId);
            const q2 = usePromptQueueStore.getState().getQueue(tabId);
            if (!q2.autoRun || q2.items.length === 0 || q2.firstDelayCountdownAt === null) {
              usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
              return;
            }
            usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
            fireHead(tabId, tabId);
          }, delayMs));
        } else {
          fireHead(tabId, tabId);
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
