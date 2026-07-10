import { useEffect } from 'react';
import { buildQueuedPromptPayload, countEnabledQueuedPrompts, isQueuedPromptEnabled, queueSendTransferredOwnership, usePromptQueueStore, type TabQueue } from '../store/usePromptQueueStore';
import { useUIStore } from '../store/useUIStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { terminalRegistry } from '../utils/terminalRegistry';

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

function canValidateQueueTabs(): boolean {
  const state = useWorkspaceStore.getState();
  return !state.isRestoring && state.openProjects.size > 0;
}

function tabCanTriggerQueue(ownerTabId: string, targetTabId: string): boolean {
  if (ownerTabId === targetTabId) return false;
  return tabExists(targetTabId);
}

function workspaceTabBusyNow(tabId: string): boolean {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (!tab) continue;
    const sdkBusy = tab.tabType === 'claude-sdk' && (
      tab.sdkState === 'fetching' ||
      tab.sdkState === 'thinking' ||
      tab.sdkState === 'tool_use'
    );
    return !!(tab.aiBusy || tab.claudeBusy || sdkBusy);
  }
  return false;
}

function seedBusySnapshotFromWorkspace(tabId: string): void {
  if (prevBusyRef.has(tabId)) return;
  if (!workspaceTabBusyNow(tabId)) return;
  prevBusyRef.set(tabId, true);
  console.log('[PromptQueueRunner] seed busy snapshot from workspace tab=' + tabId.slice(-12));
}

type QueueAgent = 'claude' | 'codex';

const NON_NATURAL_QUEUE_END_REASONS = new Set([
  'manual-stop',
  'error',
  'interrupt',
  'watchdog',
  'turn_aborted',
  'send-command-failed',
  'send-command-error',
  'command-finished',
  'pty-exit',
  'terminal-kill',
  'replace',
  'close',
]);

function getPromptQueueAgent(tabId: string): QueueAgent {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (!tab) continue;
    if (tab.commandType === 'codex') return 'codex';
    if (tab.commandType !== 'claude' && tab.codexSessionId && !tab.claudeSessionId) return 'codex';
    return 'claude';
  }
  return 'claude';
}

function getWorkspaceCommandType(tabId: string): string | null {
  const state = useWorkspaceStore.getState();
  for (const ws of state.openProjects.values()) {
    const tab = ws.tabs.get(tabId);
    if (tab) return tab.commandType || null;
  }
  return null;
}

function getPromptQueueAgentLabel(tabId: string): string {
  return getPromptQueueAgent(tabId) === 'codex' ? 'Codex' : 'Claude';
}

function sendQueueCommand(tabId: string, payload: string): Promise<unknown> {
  const agent = getPromptQueueAgent(tabId);
  const channel = agent === 'codex' ? 'codex:send-command' : 'claude:send-command';
  const isSlashCommand = String(payload || '').trimStart().startsWith('/');
  const options = {
    source: 'prompt-queue',
    awaitUserMessageAudit: agent === 'claude' && !isSlashCommand,
  };
  const term = terminalRegistry.get(tabId);
  const before = typeof document !== 'undefined' ? document.activeElement?.tagName?.toLowerCase() || '-' : '-';
  try { term?.focus(); } catch {}
  const after = typeof document !== 'undefined' ? document.activeElement?.tagName?.toLowerCase() || '-' : '-';
  console.log('[PromptQueueRunner] focus before send tab=' + tabId.slice(-8) + ' agent=' + agent + ' hadTerm=' + !!term + ' active=' + before + '→' + after + ' slash=' + isSlashCommand + ' awaitAudit=' + options.awaitUserMessageAudit);
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      try { terminalRegistry.get(tabId)?.focus(); } catch {}
    });
  }
  return ipcRenderer.invoke(channel, tabId, payload, options);
}

type EffectiveTriggerOptions = { clearStaleTarget?: boolean };
type QueueStateSnapshot = { queues: Map<string, TabQueue> };

function getEffectiveQueueTrigger(ownerTabId: string, queue: TabQueue, options: EffectiveTriggerOptions = {}): string {
  if (queue.runAfterTabId && !canValidateQueueTabs()) {
    return queue.runAfterTabId;
  }
  if (queue.runAfterTabId && tabCanTriggerQueue(ownerTabId, queue.runAfterTabId)) {
    return queue.runAfterTabId;
  }
  if (queue.runAfterTabId && options.clearStaleTarget) {
    console.warn('[PromptQueueRunner] runAfterTabId ' + queue.runAfterTabId.slice(-8) + ' is no longer a valid target, clearing → owner=' + ownerTabId.slice(-8));
    usePromptQueueStore.getState().setRunAfterTab(ownerTabId, null);
  }
  return ownerTabId;
}

function shortQueueTabId(tabId: string | null | undefined): string {
  return tabId ? String(tabId).slice(-8) : '-';
}

function describeQueueForLog(ownerTabId: string, queue: TabQueue, triggerTabId: string): string {
  const enabled = countEnabledQueuedPrompts(queue.items);
  const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue);
  return [
    'owner=' + shortQueueTabId(ownerTabId),
    'auto=' + (queue.autoRun ? '1' : '0'),
    'items=' + queue.items.length,
    'enabled=' + enabled,
    'target=' + shortQueueTabId(queue.runAfterTabId || ownerTabId),
    'eff=' + shortQueueTabId(effectiveTrigger),
    'matches=' + (effectiveTrigger === triggerTabId ? '1' : '0'),
    'ownerBusy=' + (prevBusyRef.get(ownerTabId) === true ? '1' : '0'),
    'triggerSeen=' + (prevBusyRef.has(effectiveTrigger) ? '1' : '0'),
    'triggerBusy=' + (prevBusyRef.get(effectiveTrigger) === true ? '1' : '0'),
    'inflight=' + (queueSendInflight.has(ownerTabId) ? '1' : '0'),
    'awaitStart=' + (queueAwaitingBusyStart.has(ownerTabId) ? '1' : '0'),
  ].join(',');
}

function describeQueuesForTriggerLog(triggerTabId: string): string {
  const queues = usePromptQueueStore.getState().queues;
  const parts: string[] = [];
  for (const [ownerTabId, queue] of queues) {
    if (
      ownerTabId !== triggerTabId &&
      queue.runAfterTabId !== triggerTabId &&
      !queue.autoRun &&
      queue.items.length === 0 &&
      !queue.stopAfter &&
      queue.firstDelayCountdownAt === null
    ) continue;
    parts.push(describeQueueForLog(ownerTabId, queue, triggerTabId));
  }
  return parts.length > 0 ? parts.join(' | ') : 'none';
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
const queueSendInflight = new Set<string>();
// After send-command resolves successfully there is a short event gap before
// the agent emits busy:true. Keep pivoted owners blocked through that gap.
const queueAwaitingBusyStart = new Set<string>();
const codexTriggerCheckInflight = new Set<string>();

type BusyStatePayload = {
  tabId: string;
  busy: boolean;
  reason?: string;
  localCommand?: string;
  localCommandReason?: string;
};

const SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS = new Set([
  'compact_boundary',
  'compact_summary',
  'compact_stdout',
  'pty-output-compacted',
]);

function isSuccessfulCompactLocalCommandEnd(data: BusyStatePayload): boolean {
  return data.reason === 'local-command' &&
    data.busy === false &&
    data.localCommand === '/compact' &&
    SUCCESSFUL_COMPACT_LOCAL_COMMAND_REASONS.has(data.localCommandReason || '');
}

// Public accessor — the overlay reads this to render the "target tab is busy
// now" spinner inside the Run-after dropdown. Not used by the runner itself.
export function isTabBusyNow(tabId: string): boolean {
  return prevBusyRef.get(tabId) === true;
}

// Snapshot of the current per-tab busy map. The Run-after picker SEEDS its local
// React state from this ON MOUNT. Critical: the picker overlay mounts/unmounts
// with the active Claude tab (Terminal.tsx gate), so subscribing only to FUTURE
// busy edges misses the busy:true that already fired on a background target —
// the spinner then appears only at a late turn-end flap, if at all. This
// always-on runner (App-root) records every edge into prevBusyRef regardless of
// focus, so seeding from it gives the picker the correct state at mount time.
export function getBusyTabsSnapshot(): Map<string, boolean> {
  return new Map(prevBusyRef);
}

// Always-mounted auto-runner for the per-tab prompt queue. Mounted ONCE at app
// root (App.tsx) so it survives tab switches, project switches, view changes —
// anywhere the user could navigate away from the overlay component itself.
//
// Subscribes to three busy-state channels:
//   - claude:busy-state      — PTY claude tabs + SDK tabs forwarded by main
//                              (main.js::ipcMain.on('claude-sdk:busy-state'))
//   - gemini:busy-state      — Gemini PTY tabs
//   - codex:busy-state       — Codex rollout JSONL turn watcher
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
    const fireQueueOwner = (ownerTabId: string, triggerTabId: string): boolean => {
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      const { commitSentHead, setAutoRun, setStopAfter } = usePromptQueueStore.getState();
      const beforePop = countEnabledQueuedPrompts(queue.items);
      if (!queue.autoRun || beforePop === 0) return false;
      if (queueSendInflight.has(ownerTabId)) return false;
      if (prevBusyRef.get(ownerTabId) === true) {
        console.log('[PromptQueueRunner] owner=' + ownerTabId.slice(-8) + ' is busy → wait before firing trigger=' + triggerTabId.slice(-8));
        return false;
      }

      const head = queue.items.find(isQueuedPromptEnabled);
      if (!head) return false;
      queueSendInflight.add(ownerTabId);
      queueAwaitingBusyStart.add(ownerTabId);

      const payload = withPostPrompt(ownerTabId, buildQueuedPromptPayload(head));
      const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
      console.log('[PromptQueueRunner] fire owner=' + ownerTabId.slice(-8) + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8) + ' remaining=' + (beforePop - 1));
      sendQueueCommand(ownerTabId, payload).then((res: any) => {
        if (!queueSendTransferredOwnership(res)) {
          queueAwaitingBusyStart.delete(ownerTabId);
          console.error('[PromptQueueRunner] send refused for owner tab', ownerTabId, res.error);
          setAutoRun(ownerTabId, false);
          setStopAfter(ownerTabId, false);
          return;
        }
        if (res && res.success === false && res.submitted === true) {
          console.warn('[PromptQueueRunner] submitted but audit unverified; committing transfer owner=' + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8) + ' error=' + (res.error || 'unknown'));
        }
        const committed = commitSentHead(ownerTabId, head.id, triggerTabId);
        console.log('[PromptQueueRunner] commit transfer owner=' + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8) + ' removed=' + committed.removed + ' targetCleared=' + committed.targetCleared + ' before=' + committed.beforeCount);
      }).catch((e: unknown) => {
        queueAwaitingBusyStart.delete(ownerTabId);
        console.error('[PromptQueueRunner] send failed for owner tab', ownerTabId, e);
        setAutoRun(ownerTabId, false);
        setStopAfter(ownerTabId, false);
      }).finally(() => {
        queueSendInflight.delete(ownerTabId);
      });
      return true;
    };

    const getReadyTriggerForOwner = (ownerTabId: string): string | null => {
      if (!canValidateQueueTabs()) return null;
      const queue = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (!queue.autoRun || countEnabledQueuedPrompts(queue.items) === 0) return null;
      if (queueAwaitingBusyStart.has(ownerTabId)) return ownerTabId;
      if (queueSendInflight.has(ownerTabId)) return ownerTabId;
      if (prevBusyRef.get(ownerTabId) === true) return null;

      const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, queue, { clearStaleTarget: true });
      if (effectiveTrigger === ownerTabId) return ownerTabId;

      // Pivoted queue can only fire when its target has a real idle snapshot.
      // No busy history means "wait for the first busy→idle edge", not "idle".
      if (!prevBusyRef.has(effectiveTrigger)) return null;
      if (prevBusyRef.get(effectiveTrigger) === true) return null;
      return effectiveTrigger;
    };

    const ownerHasRunnableContinuation = (ownerTabId: string): boolean => {
      if (queueAwaitingBusyStart.has(ownerTabId)) return true;
      if (queueSendInflight.has(ownerTabId)) return true;
      return getReadyTriggerForOwner(ownerTabId) !== null;
    };

    // Walk all queues, find one(s) waiting on `triggerTabId` for turn-end edge.
    // For default (runAfterTabId === null) the owner IS the trigger. For
    // pivoted (runAfterTabId !== null) the owner is some OTHER tab whose queue
    // wants this tab's transition.
    const findOwnersWaitingOn = (triggerTabId: string): string[] => {
      if (!canValidateQueueTabs()) return [];
      const owners: string[] = [];
      const queues = usePromptQueueStore.getState().queues;
      for (const [ownerTabId, q] of queues) {
        if (!tabExists(ownerTabId)) {
          usePromptQueueStore.getState().cleanupClosedTab(ownerTabId);
          continue;
        }
        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) continue;
        // Validate stale target before pivoting — if the picked tab was closed,
        // self-clear and fall through to default own-tab behaviour. This is
        // the lazy validation promised in the store schema comment.
        const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, q, { clearStaleTarget: true });
        if (effectiveTrigger === triggerTabId) owners.push(ownerTabId);
      }
      return owners;
    };

    const handleBusyState = (channel: 'claude' | 'gemini' | 'codex') =>
      (_: any, data: BusyStatePayload) => {
        const { tabId, busy, reason } = data;
        if (channel === 'claude' && reason === 'spinner') {
          const commandType = getWorkspaceCommandType(tabId);
          if (commandType === 'codex' || commandType === 'gemini') {
            console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=claude reason=spinner → IGNORE foreign spinner for ' + commandType);
            return;
          }
        }

        // Spinner frames are presentation-only heuristics. Do not let them
        // overwrite the workflow edge snapshot: a spinner-idle can precede the
        // authoritative Stop/StopFailure/InterruptStop and would otherwise make
        // that real outcome look like a duplicate busy:false event.
        if (reason === 'spinner') {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' reason=spinner → IGNORE presentation signal');
          return;
        }

        const wasBusy = prevBusyRef.get(tabId) ?? false;
        prevBusyRef.set(tabId, busy);

        if (busy) {
          queueAwaitingBusyStart.delete(tabId);
          const { clearFirstDelayCountdown } = usePromptQueueStore.getState();
          const q = usePromptQueueStore.getState().getQueue(tabId);
          if (q.firstDelayCountdownAt !== null) clearFirstDelayCountdown(tabId);
        }

        // An explicit abnormal outcome is authoritative on its own and remains
        // actionable even if an idempotent busy:false reached the renderer first.
        // Cancel both the tab's own workflow and every cross-project queue that
        // selected this tab as its trigger, while preserving queued prompt text.
        if (!busy && reason && NON_NATURAL_QUEUE_END_REASONS.has(reason)) {
          if (!canValidateQueueTabs()) {
            console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' reason=' + reason + ' → SKIP disarm while workspace restores');
            return;
          }
          const queueState = usePromptQueueStore.getState();
          for (const ownerTabId of queueState.queues.keys()) {
            if (!tabExists(ownerTabId)) queueState.cleanupClosedTab(ownerTabId);
          }
          const disarmedOwners = usePromptQueueStore.getState().disarmQueuesForTrigger(tabId);
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' reason=' + reason + ' → DISARM trigger workflow owners=' + (disarmedOwners.length ? disarmedOwners.map(shortQueueTabId).join(',') : 'none'));
          return;
        }

        // Only care about turn-end transition (busy true → false). Turn-start
        // (false → true) doesn't trigger queue actions — user submitted manually
        // or our send-command IPC kicked it off.
        if (!(wasBusy && !busy)) return;

        if (channel === 'codex') {
          const ownersAtEdge = findOwnersWaitingOn(tabId);
          console.log('[PromptQueueRunner] codex idle edge tab=' + tabId.slice(-12)
            + ' reason=' + (reason || 'natural')
            + ' owners=' + (ownersAtEdge.length ? ownersAtEdge.map(shortQueueTabId).join(',') : 'none')
            + ' queues=' + describeQueuesForTriggerLog(tabId));
        }

        // These reasons are NOT normal turn-end signals. They exist for UI
        // liveness only, so never fire or disarm prompt queues from this edge:
        // - 'spinner' — filtered before it can mutate the workflow snapshot.
        // - 'local-command' — slash-command bracket. Successful /compact is the
        //   one exception: it is a durable boundary and Run-after should continue
        //   with the next queued prompt after compact finishes.
        const compactLocalCommandDone = isSuccessfulCompactLocalCommandEnd(data);
        if (reason === 'local-command' && !compactLocalCommandDone) {
          const localSuffix = reason === 'local-command'
            ? ' command=' + (data.localCommand || '-') + ' localReason=' + (data.localCommandReason || '-')
            : '';
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' reason=' + reason + localSuffix + ' → IGNORE non-turn busy edge');
          return;
        }
        if (compactLocalCommandDone) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' ch=' + channel + ' command=/compact localReason=' + data.localCommandReason + ' → CONTINUE queue after compact');
        }

        // Step 1: target tab's OWN continuation wins over external owners.
        // If tab A waits on tab B, and tab B has Run-after ready to send its
        // own next prompt, A must wait for B's whole chain to drain — not just
        // for B's first busy→idle edge. Otherwise both tabs start from the same
        // turn-end and A observes half-complete work from B.
        if (queueSendInflight.has(tabId) || queueAwaitingBusyStart.has(tabId)) {
          console.log('[PromptQueueRunner] tab=' + tabId.slice(-12) + ' has queued turn starting → defer pivoted owners');
          return;
        }
        const ownContinuationTrigger = getReadyTriggerForOwner(tabId);
        if (ownContinuationTrigger) {
          const fired = fireQueueOwner(tabId, ownContinuationTrigger);
          if (fired || queueSendInflight.has(tabId) || queueAwaitingBusyStart.has(tabId)) return; // wait for THIS continuation before pivot fan-out / stopAfter
        }

        // Step 2: pivoted queues — any OWNER tab whose runAfterTabId === tabId.
        // Their head goes to the OWNER (not this trigger tab). This now runs
        // only after the trigger tab has no runnable continuation of its own.
        const owners = findOwnersWaitingOn(tabId);
        for (const ownerTabId of owners) {
          if (ownerTabId !== tabId) fireQueueOwner(ownerTabId, tabId);
        }

        // Step 3: stopAfter for the trigger tab itself. If own Run-after fired
        // above we returned before this block, preserving the existing contract:
        // stopAfter runs only after the queue is empty / no continuation fired.
        const ownQueue = usePromptQueueStore.getState().getQueue(tabId);
        const { setStopAfter } = usePromptQueueStore.getState();
        const showToast = useUIStore.getState().showToast;

        // stopAfter: queue empty (or autoRun off / pivoted away), turn finished
        // → kill claude. closeAfter (chained on top): after the stop fires,
        // also close the whole tab via useWorkspaceStore.closeTab with
        // skipProcessCheck so no confirm dialog appears (we just killed the
        // process — there's nothing to ask).
        if (ownQueue.stopAfter) {
          const shouldCloseTab = ownQueue.closeAfter;
          const agentLabel = getPromptQueueAgentLabel(tabId);
          ipcRenderer.invoke('terminal:stop-ai-process', tabId)
            .then(async (res: { success?: boolean; error?: string }) => {
              if (res?.success) {
                showToast(shouldCloseTab ? agentLabel + ' stopped, closing tab' : agentLabel + ' stopped', 'success', 1500);
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
    const codexHandler = handleBusyState('codex');
    ipcRenderer.on('claude:busy-state', claudeHandler);
    ipcRenderer.on('gemini:busy-state', geminiHandler);
    ipcRenderer.on('codex:busy-state', codexHandler);
    return () => {
      ipcRenderer.removeListener('claude:busy-state', claudeHandler);
      ipcRenderer.removeListener('gemini:busy-state', geminiHandler);
      ipcRenderer.removeListener('codex:busy-state', codexHandler);
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
    const fireHead = (ownerTabId: string, triggerTabId: string): boolean => {
      if (firing) return false;
      firing = true;
      try {
        const q = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) return false;
        if (queueSendInflight.has(ownerTabId)) return false;
        if (prevBusyRef.get(ownerTabId) === true) return false;
        const head = q.items.find(isQueuedPromptEnabled);
        if (head) {
          queueSendInflight.add(ownerTabId);
          queueAwaitingBusyStart.add(ownerTabId);
          const payload = withPostPrompt(ownerTabId, buildQueuedPromptPayload(head));
          const arrow = ownerTabId === triggerTabId ? '↩' : '⇒';
          console.log('[PromptQueueRunner] cold-start owner=' + ownerTabId.slice(-8) + ' ' + arrow + ' trigger=' + triggerTabId.slice(-8));
          sendQueueCommand(ownerTabId, payload).then((res: any) => {
            if (!queueSendTransferredOwnership(res)) {
              queueAwaitingBusyStart.delete(ownerTabId);
              console.error('[PromptQueueRunner] cold-start send refused for tab', ownerTabId, res.error);
              usePromptQueueStore.getState().setAutoRun(ownerTabId, false);
              usePromptQueueStore.getState().setStopAfter(ownerTabId, false);
              return;
            }
            if (res && res.success === false && res.submitted === true) {
              console.warn('[PromptQueueRunner] cold-start submitted but audit unverified; committing transfer owner=' + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8) + ' error=' + (res.error || 'unknown'));
            }
            const committed = usePromptQueueStore.getState().commitSentHead(ownerTabId, head.id, triggerTabId);
            console.log('[PromptQueueRunner] cold-start commit transfer owner=' + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8) + ' removed=' + committed.removed + ' targetCleared=' + committed.targetCleared + ' before=' + committed.beforeCount);
          }).catch((e: unknown) => {
            queueAwaitingBusyStart.delete(ownerTabId);
            console.error('[PromptQueueRunner] cold-start send failed for tab', ownerTabId, e);
            usePromptQueueStore.getState().setAutoRun(ownerTabId, false);
            usePromptQueueStore.getState().setStopAfter(ownerTabId, false);
          }).finally(() => {
            queueSendInflight.delete(ownerTabId);
          });
          return true;
        }
        return false;
      } finally {
        firing = false;
      }
    };

    const ownerHasRunnableContinuationForColdStart = (ownerTabId: string): boolean => {
      if (queueAwaitingBusyStart.has(ownerTabId) || queueSendInflight.has(ownerTabId)) return true;
      const q = usePromptQueueStore.getState().getQueue(ownerTabId);
      if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) return false;
      if (prevBusyRef.get(ownerTabId) === true) return false;
      const effectiveTrigger = getEffectiveQueueTrigger(ownerTabId, q, { clearStaleTarget: true });
      if (effectiveTrigger !== ownerTabId) return false;
      if (!prevBusyRef.has(effectiveTrigger)) return false;
      return prevBusyRef.get(effectiveTrigger) !== true;
    };

    const verifyCodexTriggerIdleThenFire = (ownerTabId: string, triggerTabId: string): boolean => {
      if (getWorkspaceCommandType(triggerTabId) !== 'codex') return false;
      const key = ownerTabId + '→' + triggerTabId;
      if (codexTriggerCheckInflight.has(key)) return true;
      codexTriggerCheckInflight.add(key);
      ipcRenderer.invoke('codex:get-turn-state', triggerTabId).then((res: any) => {
        if (res?.hasWatcher) {
          prevBusyRef.set(triggerTabId, !!res.busy);
          if (res.busy) {
            useWorkspaceStore.getState().setAiBusy(triggerTabId, true, 'codex-turn-state');
            console.log('[PromptQueueRunner] codex-turn-state trigger=' + triggerTabId.slice(-8) + ' busy=true → wait');
            return;
          }
        }

        const q2 = usePromptQueueStore.getState().getQueue(ownerTabId);
        if (!q2.autoRun || countEnabledQueuedPrompts(q2.items) === 0) return;
        if (queueSendInflight.has(ownerTabId) || queueAwaitingBusyStart.has(ownerTabId)) return;
        if (prevBusyRef.get(ownerTabId) === true) return;

        if (ownerTabId !== triggerTabId) {
          if (ownerHasRunnableContinuationForColdStart(triggerTabId)) {
            console.log('[PromptQueueRunner] codex-turn-state owner=' + ownerTabId.slice(-8) + ' target=' + triggerTabId.slice(-8) + ' has own continuation → wait for chain drain');
            return;
          }
          fireHead(ownerTabId, triggerTabId);
          return;
        }

        if (q2.firstDelayCountdownAt !== null) return;
        if (q2.firstDelaySeconds > 0) {
          const delayMs = q2.firstDelaySeconds * 1000;
          usePromptQueueStore.getState().startFirstDelayCountdown(ownerTabId);
          clearTimer(ownerTabId);
          pendingTimers.set(ownerTabId, setTimeout(() => {
            pendingTimers.delete(ownerTabId);
            const q3 = usePromptQueueStore.getState().getQueue(ownerTabId);
            if (!q3.autoRun || countEnabledQueuedPrompts(q3.items) === 0 || q3.firstDelayCountdownAt === null) {
              usePromptQueueStore.getState().clearFirstDelayCountdown(ownerTabId);
              return;
            }
            usePromptQueueStore.getState().consumeFirstDelayCountdown(ownerTabId);
            fireHead(ownerTabId, ownerTabId);
          }, delayMs));
        } else {
          fireHead(ownerTabId, ownerTabId);
        }
      }).catch((e: unknown) => {
        console.warn('[PromptQueueRunner] codex-turn-state check failed owner=' + ownerTabId.slice(-8) + ' trigger=' + triggerTabId.slice(-8), e);
      }).finally(() => {
        codexTriggerCheckInflight.delete(key);
      });
      return true;
    };

    const evaluateQueues = (state: QueueStateSnapshot, prevState: QueueStateSnapshot) => {
      if (!canValidateQueueTabs()) return;
      for (const [tabId, q] of state.queues) {
        if (!tabExists(tabId)) {
          usePromptQueueStore.getState().cleanupClosedTab(tabId);
          continue;
        }
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
          if (q.firstDelayCountdownAt !== null) {
            usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
          }
        }

        if (!q.autoRun || countEnabledQueuedPrompts(q.items) === 0) continue;

        const prevCount = prevQ ? countEnabledQueuedPrompts(prevQ.items) : 0;
        const activeCount = countEnabledQueuedPrompts(q.items);
        const prevAutoRun = prevQ?.autoRun ?? false;
        const itemsArrived = prevCount === 0 && activeCount > 0;
        const autoRunArmed = !prevAutoRun && q.autoRun;
        // Treat "target swapped while armed" as an arm-edge too — the user
        // explicitly changed who we're waiting on, evaluate cold-start fit
        // against the new target.
        const armEdge = itemsArrived || autoRunArmed || (targetChanged && q.autoRun);
        if (!armEdge) continue;

        // Validate the picked target — stale id behaves as null (fall back to
        // own-tab default).
        const effectiveTrigger = getEffectiveQueueTrigger(tabId, q, { clearStaleTarget: true });

        if (effectiveTrigger !== tabId) {
          seedBusySnapshotFromWorkspace(effectiveTrigger);
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
          if (verifyCodexTriggerIdleThenFire(tabId, effectiveTrigger)) continue;
          if (ownerHasRunnableContinuation(effectiveTrigger)) {
            console.log('[PromptQueueRunner] cold-start owner=' + tabId.slice(-8) + ' target=' + effectiveTrigger.slice(-8) + ' has own continuation → wait for chain drain');
            continue;
          }
          // Target is idle and was seen busy before. Cold-start fires.
          // (No firstDelay support for pivoted — keep it simple; the user
          // already configured a delay implicitly by picking a target tab.)
          fireHead(tabId, effectiveTrigger);
          continue;
        }

        // Default own-tab cold-start (unchanged behaviour).
        if (verifyCodexTriggerIdleThenFire(tabId, tabId)) continue;
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
            if (!q2.autoRun || countEnabledQueuedPrompts(q2.items) === 0 || q2.firstDelayCountdownAt === null) {
              usePromptQueueStore.getState().clearFirstDelayCountdown(tabId);
              return;
            }
            usePromptQueueStore.getState().consumeFirstDelayCountdown(tabId);
            fireHead(tabId, tabId);
          }, delayMs));
        } else {
          fireHead(tabId, tabId);
        }
      }
    };

    const unsubscribeQueue = usePromptQueueStore.subscribe((state, prevState) => {
      evaluateQueues(state, prevState);
    });
    const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, prevState) => {
      const wasReady = !prevState.isRestoring && prevState.openProjects.size > 0;
      const isReady = !state.isRestoring && state.openProjects.size > 0;
      if (wasReady || !isReady) return;
      evaluateQueues(usePromptQueueStore.getState(), { queues: new Map() });
    });
    return () => {
      unsubscribeQueue();
      unsubscribeWorkspace();
      for (const t of pendingTimers.values()) clearTimeout(t);
      pendingTimers.clear();
    };
  }, []);
}
