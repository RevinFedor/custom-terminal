import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

// SQLite-backed persistence via the existing app:setState / app:getState
// pattern (same as defaultClaudeEffort, debugHoverBridges, freePorts).
// Persist: items, autoRun, stopAfter, firstDelaySeconds, postPromptEnabled,
// postPromptText PER TAB. Skip: previewId, firstChipHintActive (UI-only).
// Serialized shape: { [tabId]: { items, autoRun, stopAfter, firstDelaySeconds,
//                                postPromptEnabled, postPromptText } }.
const APP_STATE_KEY_QUEUE = 'promptQueueByTab';

// Throttle disk writes — drag-reorder fires many state updates per second and
// SQLite IO on every keystroke would be wasteful. 250ms covers fast typing and
// drag-reorder without losing the last value on unmount.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(snapshot: Map<string, TabQueue>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out: Record<string, Pick<TabQueue, 'items' | 'autoRun' | 'stopAfter' | 'closeAfter' | 'firstDelaySeconds' | 'postPromptEnabled' | 'postPromptText' | 'runAfterTabId'>> = {};
    for (const [tabId, q] of snapshot) {
      // Skip cold tabs with no persistable state — saves space + avoids polluting
      // the kv store with thousands of empty rows over time. Non-default delay
      // and post-prompt are persistable too so the user's choices survive
      // restarts even when the queue is empty.
      if (
        q.items.length === 0 &&
        !q.autoRun &&
        !q.stopAfter &&
        !q.closeAfter &&
        q.firstDelaySeconds === 0 &&
        !q.postPromptEnabled &&
        !q.postPromptText &&
        !q.runAfterTabId
      ) continue;
      out[tabId] = {
        items: q.items,
        autoRun: q.autoRun,
        stopAfter: q.stopAfter,
        closeAfter: q.closeAfter,
        firstDelaySeconds: q.firstDelaySeconds,
        postPromptEnabled: q.postPromptEnabled,
        postPromptText: q.postPromptText,
        runAfterTabId: q.runAfterTabId,
      };
    }
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_QUEUE, value: JSON.stringify(out) })
      .catch((e: unknown) => console.warn('[PromptQueue] save failed:', e));
  }, 250);
}

// One queued prompt — a draft the user wants to send to Claude after the current turn ends.
// `text` is the raw prompt as the user typed it. `images` is a count of image placeholders
// the user had referenced (e.g. "[Image #1]") — we can't carry the actual image bytes through
// the editor extraction path so we surface a stub marker instead. `id` is monotonic per session.
// Resolved on-disk location of one [Image #N] placeholder. Populated by main
// process when grabbing input: ~/.claude/image-cache/<sessionId>/<id>.<ext>.
// Path may become stale if Claude is restarted in this tab (cleanupOldImageCaches
// wipes non-current sessionIds on boot) — UI treats `path` as best-effort.
export type QueuedImageRef = {
  id: number;        // pasteId Claude assigned (matches the [Image #N] placeholder)
  path: string;      // absolute path on disk while sessionId is alive
  mediaType: string; // image/png|jpeg|...
  size: number;      // bytes at grab time (purely informational)
};

export type QueuedPrompt = {
  id: string;
  text: string;
  images: number; // number of [Image] / [Pasted image] placeholders the original input had
  // Resolved disk paths for each [Image #N] in `text`, in order of appearance.
  // Length may be < `images` if some files were missing at grab time (logged
  // as [GrabImages] ... :MISSING). Undefined for legacy chips loaded from
  // pre-imagePaths persisted state — UI should treat that as "unknown" not "zero".
  imagePaths?: QueuedImageRef[];
  createdAt: number;
};

export type TabQueue = {
  items: QueuedPrompt[];
  // When true, as soon as the current Claude turn ends (Stop hook fires) the next item
  // is shifted off and sent via claude:send-command. After the last item runs, autoRun stays
  // true — user must explicitly disarm. This is fine because with no items the loop is a no-op.
  autoRun: boolean;
  // When true, after the next Claude turn ends AND the queue is empty, we invoke
  // terminal:stop-ai-process for this tab (SIGTERM the claude process).
  // Independent from autoRun: works even without queued items so the user can fire-and-forget
  // a single prompt then have Claude shut down automatically.
  stopAfter: boolean;
  // When true, after stop fires (see stopAfter above) we ALSO close the whole
  // tab via useWorkspaceStore.closeTab — no confirm. Implies stopAfter must be
  // true to make sense (you can't close a tab without stopping its process),
  // so the UI auto-arms stopAfter whenever closeAfter is turned on. Turning
  // closeAfter off does NOT turn stopAfter off — they are two-toggle stack.
  closeAfter: boolean;
  // Open preview slideout for which item (null = closed). UI-only state — not persisted.
  previewId: string | null;
  // Countdown (seconds) BEFORE the first queued prompt fires after Run-after is armed.
  // 0 = fire immediately on arm. Only consumed by the cold-start watcher in the runner —
  // subsequent prompts in the same queue fire on Stop hook with no delay. Persistent so
  // user's preferred delay survives restarts. See usePromptQueueRunner.ts::firstDelay.
  //
  // Two slots:
  //   firstDelaySeconds      — user-configured value (what the input shows when idle).
  //   firstDelayCountdownAt  — timestamp (Date.now()) when the active countdown started,
  //                            OR null if no countdown is running. Remaining seconds =
  //                            firstDelaySeconds - floor((Date.now() - at) / 1000). When
  //                            user disarms Run before fire, we compute remaining,
  //                            overwrite firstDelaySeconds with it, then clear the slot —
  //                            so the input shows what was left, not the original value.
  // Neither slot is consumed for items 2..N — only on the very first arm-after-empty edge.
  firstDelaySeconds: number;
  firstDelayCountdownAt: number | null;

  // ── Post-prompt (Run After post-prompt) ──────────────────────────────────
  // When postPromptEnabled === true, the runner appends `\n\n${postPromptText}`
  // to EVERY queued item just before claude:send-command. Per-tab so different
  // Claude tabs can carry different "answer-all-clarifications-yourself" hints.
  // postPromptText is the raw text user wrote in the editor (empty = treated as
  // disabled even if enabled flag is on — appending empty string is a no-op).
  postPromptEnabled: boolean;
  postPromptText: string;

  // ── First-chip armed hint ────────────────────────────────────────────────
  // True when user added the FIRST chip into an empty queue while Run after
  // was OFF — the Run after pill renders with a soft red glow as a nudge.
  // Cleared on first hover over the pill (consumeFirstChipHint). Re-armed
  // every time the queue transitions from 0 → 1 with autoRun=false.
  // UI-only — not persisted (re-restore would just nag the user on each boot).
  firstChipHintActive: boolean;

  // ── Close-after restore memory ──────────────────────────────────────────
  // Remembers whether stopAfter was already ON at the moment the user armed
  // closeAfter. Turning closeAfter OFF restores stopAfter to that prior value
  // instead of leaving it stuck on, so:
  //   (stop=OFF, close=OFF) → click ⏻ → (stop=ON, close=ON)
  //                         → click ⏻ → (stop=OFF, close=OFF)   ← restored
  //   (stop=ON,  close=OFF) → click ⏻ → (stop=ON, close=ON)
  //                         → click ⏻ → (stop=ON,  close=OFF)   ← preserved
  // Reset to false whenever user clicks left zone directly OR closeAfter
  // returns to OFF (after a restore-cycle the slot has done its job).
  // Non-persistent — across restarts there is no "prior" state to restore to.
  stopBeforeCloseArm: boolean;

  // ── Run-after target tab ────────────────────────────────────────────────
  // When non-null, the auto-runner waits for the busy→idle transition on
  // ANOTHER tab (this id) instead of the queue-owner tab. Use case: «когда
  // вот в той вкладке (Claude/Gemini/SDK) закончится текущий стрим — отправь
  // мне следующий промпт здесь». Null = default behaviour (wait on own
  // claude:busy-state for THIS tab).
  //
  // Selecting a tab that is NOT currently active in its project is allowed:
  // runner stays in "waiting" state until that tab's busy-state becomes true
  // (user activates it and sends a prompt → loader starts) and then false.
  // The UI surfaces this with a "!" icon (waiting for activation) vs spinner
  // (already busy, waiting for finish).
  //
  // Persistent so the choice survives restarts. Stale ids (target tab was
  // closed) are validated lazily in the runner — if the tab no longer exists
  // in any project workspace, the slot self-clears to null and falls back to
  // standard own-tab behaviour. Don't validate in the store (would create a
  // dependency cycle with useWorkspaceStore).
  runAfterTabId: string | null;
};

interface PromptQueueStore {
  // Per-tab queues. Outside Claude tabs the overlay is hidden, but state survives tab switching.
  queues: Map<string, TabQueue>;

  addPrompt: (tabId: string, text: string, images?: number, imagePaths?: QueuedImageRef[]) => string;
  removePrompt: (tabId: string, id: string) => void;
  updatePromptText: (tabId: string, id: string, text: string) => void;
  reorderPrompt: (tabId: string, fromIndex: number, toIndex: number) => void;
  clearQueue: (tabId: string) => void;

  setAutoRun: (tabId: string, value: boolean) => void;
  setStopAfter: (tabId: string, value: boolean) => void;
  setCloseAfter: (tabId: string, value: boolean) => void;
  // Set the target tab whose busy→idle transition should trigger the auto-run.
  // null = clear (fall back to own-tab autoRun behaviour).
  setRunAfterTab: (tabId: string, targetTabId: string | null) => void;
  setFirstDelaySeconds: (tabId: string, value: number) => void;
  // Start the first-delay countdown for this tab. Caller must already have
  // ensured firstDelaySeconds > 0 and autoRun === true.
  startFirstDelayCountdown: (tabId: string) => void;
  // Stop the countdown, freeze remaining seconds into firstDelaySeconds.
  // remaining < 0 (or 0) → store 0 so next arm fires immediately.
  cancelFirstDelayCountdown: (tabId: string) => void;
  // Clear countdown slot WITHOUT touching firstDelaySeconds. Used when the
  // countdown elapses and the runner is about to fire — input goes back to
  // showing the originally-configured value, ready for next arm.
  clearFirstDelayCountdown: (tabId: string) => void;
  setPreviewId: (tabId: string, id: string | null) => void;

  // Post-prompt management. setPostPromptEnabled toggles the per-tab flag;
  // setPostPromptText writes the body. Both are persisted.
  setPostPromptEnabled: (tabId: string, value: boolean) => void;
  setPostPromptText: (tabId: string, text: string) => void;

  // First-chip armed hint helpers. consumeFirstChipHint clears the flag on
  // first hover. (Setting it happens implicitly inside addPrompt on the 0→1
  // edge when autoRun is false.)
  consumeFirstChipHint: (tabId: string) => void;

  // Pops the head item — used by the auto-runner when Stop hook fires. Returns null if empty.
  popNext: (tabId: string) => QueuedPrompt | null;
  commitSentHead: (tabId: string, id: string) => { removed: boolean; beforeCount: number };

  // Drop queue state owned by a closed tab and clear run-after pivots that
  // pointed at it. Called from workspace closeTab.
  cleanupClosedTab: (tabId: string) => void;

  getQueue: (tabId: string) => TabQueue;
}

const EMPTY: TabQueue = {
  items: [],
  autoRun: false,
  stopAfter: false,
  closeAfter: false,
  previewId: null,
  firstDelaySeconds: 0,
  firstDelayCountdownAt: null,
  postPromptEnabled: false,
  postPromptText: '',
  firstChipHintActive: false,
  stopBeforeCloseArm: false,
  runAfterTabId: null,
};

let idCounter = 0;
const nextId = () => `pq-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

// ── Cross-client core shape ──────────────────────────────────────────────────
// The subset of a TabQueue that crosses the wire to mobile (and that SQLite
// persists). UI-only slots (previewId, firstChipHintActive, firstDelayCountdownAt,
// stopBeforeCloseArm) are intentionally NOT here — they are local-presentation
// state, meaningless on another client. Mobile reads this via the getPromptQueue
// bridge action and receives live deltas via the `queue-update` SSE event; it
// never holds its own copy of the queue — the desktop store is the single source
// of truth and the desktop runner is the single firing engine (same model the
// effort/think window-maps use: mobile is a thin remote, not a second store).
export type PromptQueueCore = Pick<
  TabQueue,
  'items' | 'autoRun' | 'stopAfter' | 'closeAfter' | 'runAfterTabId'
  | 'firstDelaySeconds' | 'postPromptEnabled' | 'postPromptText'
>;

export function serializePromptQueueCore(q: TabQueue): PromptQueueCore {
  return {
    items: q.items,
    autoRun: q.autoRun,
    stopAfter: q.stopAfter,
    closeAfter: q.closeAfter,
    runAfterTabId: q.runAfterTabId,
    firstDelaySeconds: q.firstDelaySeconds,
    postPromptEnabled: q.postPromptEnabled,
    postPromptText: q.postPromptText,
  };
}

// Count image placeholders in raw input text. Claude TUI renders pasted images as
// "[Image #N]" tokens. Pasted-text-chips like "[Pasted text #N +M lines]" are NOT
// counted here — those are full-text expansions the editor view exposes verbatim.
const IMAGE_RE = /\[Image(?:\s+#?\d+)?\]/g;
function countImages(text: string): number {
  const m = text.match(IMAGE_RE);
  return m ? m.length : 0;
}

export const usePromptQueueStore = create<PromptQueueStore>((set, get) => {
  // setAndPersist: write next state, then schedule a debounced disk save.
  // PreviewId-only mutations skip the save (UI-only, see scheduleSave).
  const setAndPersist = (updater: (state: { queues: Map<string, TabQueue> }) => { queues: Map<string, TabQueue> }, opts?: { skipSave?: boolean }) => {
    set((state) => {
      const next = updater(state);
      if (!opts?.skipSave) scheduleSave(next.queues);
      return next;
    });
  };

  return {
    queues: new Map(),

    addPrompt: (tabId, text, images, imagePaths) => {
      const id = nextId();
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        const detectedImages = images ?? countImages(text);
        const items = [...cur.items, { id, text, images: detectedImages, imagePaths: (imagePaths && imagePaths.length > 0) ? imagePaths : undefined, createdAt: Date.now() }];
        // First-chip armed hint: only when transitioning empty → 1 AND auto-run
        // is currently OFF. Subsequent adds into a non-empty queue or adds into
        // an already-armed queue don't re-trigger the nudge.
        const wasEmpty = cur.items.length === 0;
        const shouldArmHint = wasEmpty && !cur.autoRun;
        next.set(tabId, { ...cur, items, firstChipHintActive: shouldArmHint ? true : cur.firstChipHintActive });
        return { queues: next };
      });
      return id;
    },

    removePrompt: (tabId, id) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const items = cur.items.filter((p) => p.id !== id);
        const next = new Map(state.queues);
        // Manual drain (×-remove OR Replay ▶) emptied the queue. Run after /
        // Stop after / Close after were waiting on this queue to finish — now
        // that there's nothing left to wait for, they MUST disarm. Otherwise
        // the user sees an active "Run after" or "Stop after" pill with zero
        // context — and on the next turn-end the runner would either send a
        // future prompt unexpectedly or SIGTERM the agent unexpectedly.
        //
        // Carefully NOT applied in popNext: there the LAST chip just left the
        // queue to be SENT to the agent — stopAfter SHOULD still be armed so the
        // runner stops the agent after that prompt's turn finishes. popNext is
        // the autoRun-drain path; this hook only covers manual user removals.
        const queueEmptied = cur.items.length > 0 && items.length === 0;
        const autoRun = queueEmptied ? false : cur.autoRun;
        const stopAfter = queueEmptied ? false : cur.stopAfter;
        const closeAfter = queueEmptied ? false : cur.closeAfter;
        const stopBeforeCloseArm = queueEmptied ? false : cur.stopBeforeCloseArm;
        const firstDelayCountdownAt = queueEmptied ? null : cur.firstDelayCountdownAt;
        next.set(tabId, {
          ...cur,
          items,
          autoRun,
          stopAfter,
          closeAfter,
          stopBeforeCloseArm,
          firstDelayCountdownAt,
          firstChipHintActive: queueEmptied ? false : cur.firstChipHintActive,
          previewId: cur.previewId === id ? null : cur.previewId,
        });
        return { queues: next };
      });
    },

    updatePromptText: (tabId, id, text) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        const items = cur.items.map((p) => p.id === id ? { ...p, text, images: countImages(text) } : p);
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items });
        return { queues: next };
      });
    },

    reorderPrompt: (tabId, fromIndex, toIndex) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur) return state;
        if (fromIndex === toIndex) return state;
        const items = [...cur.items];
        const [removed] = items.splice(fromIndex, 1);
        if (!removed) return state;
        items.splice(toIndex, 0, removed);
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items });
        return { queues: next };
      });
    },

    clearQueue: (tabId) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        next.delete(tabId);
        return { queues: next };
      });
    },

    setAutoRun: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Any user interaction with Run after acknowledges the hint — clear it
        // unconditionally. Re-arming only happens on the next 0→1 chip edge.
        next.set(tabId, {
          ...cur,
          autoRun: value,
          firstChipHintActive: false,
          firstDelayCountdownAt: value ? cur.firstDelayCountdownAt : null,
        });
        return { queues: next };
      });
    },

    setStopAfter: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Turning Stop after OFF must also disable closeAfter — closing a tab
        // whose stop is not scheduled would never fire. (Inverse: turning
        // stopAfter ON doesn't touch closeAfter; user decides separately.)
        const closeAfter = value ? cur.closeAfter : false;
        // User clicked the LEFT zone directly. Whatever the close-arm memory
        // was holding is now stale (the new baseline is whatever stop=value
        // means), so wipe it. Otherwise the next close-arm/disarm cycle
        // would restore stop=true based on data from BEFORE this click.
        next.set(tabId, { ...cur, stopAfter: value, closeAfter, stopBeforeCloseArm: false });
        return { queues: next };
      });
    },

    setCloseAfter: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        if (value) {
          // Arming closeAfter forces stopAfter ON (can't close a tab whose
          // process never gets stopped). Remember whether stopAfter was ALREADY
          // on, so the inverse click can restore it accurately.
          next.set(tabId, {
            ...cur,
            closeAfter: true,
            stopAfter: true,
            stopBeforeCloseArm: cur.stopAfter,
          });
        } else {
          // Disarming closeAfter: restore stopAfter to what it was BEFORE this
          // close-arm cycle. If user had stopAfter on independently before,
          // it stays on. If user clicked ⏻ from the all-off baseline, both
          // toggles return to off — matching user expectation:
          //   "click ⏻ once → both on; click ⏻ again → both off."
          next.set(tabId, {
            ...cur,
            closeAfter: false,
            stopAfter: cur.stopBeforeCloseArm,
            stopBeforeCloseArm: false,
          });
        }
        return { queues: next };
      });
    },

    setRunAfterTab: (tabId, targetTabId) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Self-target makes no semantic sense (waiting on yourself = waiting
        // forever, since the same Stop hook would fire). Coerce to null.
        const value = targetTabId === tabId ? null : targetTabId;
        next.set(tabId, { ...cur, runAfterTabId: value });
        return { queues: next };
      });
    },

    setFirstDelaySeconds: (tabId, value) => {
      const clamped = Math.max(0, Math.min(3600, Math.floor(value)));
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        // Editing the input while a countdown is running is treated as cancel-edit-restart:
        // we drop the active countdown slot, the new value becomes the value the input shows.
        next.set(tabId, { ...cur, firstDelaySeconds: clamped, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    startFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        if (cur.firstDelayCountdownAt !== null) return state; // already running
        next.set(tabId, { ...cur, firstDelayCountdownAt: Date.now() });
        return { queues: next };
      });
    },

    cancelFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || cur.firstDelayCountdownAt === null) return state;
        const elapsedMs = Date.now() - cur.firstDelayCountdownAt;
        const remaining = Math.max(0, cur.firstDelaySeconds - Math.floor(elapsedMs / 1000));
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstDelaySeconds: remaining, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    clearFirstDelayCountdown: (tabId) => {
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || cur.firstDelayCountdownAt === null) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstDelayCountdownAt: null });
        return { queues: next };
      });
    },

    setPreviewId: (tabId, id) => {
      // UI-only state — skip disk save.
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, previewId: id });
        return { queues: next };
      }, { skipSave: true });
    },

    setPostPromptEnabled: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, postPromptEnabled: value });
        return { queues: next };
      });
    },

    setPostPromptText: (tabId, text) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, postPromptText: text });
        return { queues: next };
      });
    },

    consumeFirstChipHint: (tabId) => {
      // UI-only state — skip disk save.
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || !cur.firstChipHintActive) return state;
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, firstChipHintActive: false });
        return { queues: next };
      }, { skipSave: true });
    },

    popNext: (tabId) => {
      const cur = get().queues.get(tabId);
      if (!cur || cur.items.length === 0) return null;
      const [head, ...rest] = cur.items;
      setAndPersist((state) => {
        const next = new Map(state.queues);
        next.set(tabId, { ...cur, items: rest, previewId: cur.previewId === head.id ? null : cur.previewId });
        return { queues: next };
      });
      return head;
    },

    commitSentHead: (tabId, id) => {
      let removed = false;
      let beforeCount = 0;
      setAndPersist((state) => {
        const cur = state.queues.get(tabId);
        if (!cur || cur.items.length === 0) return state;
        beforeCount = cur.items.length;
        const head = cur.items[0];
        if (!head || head.id !== id) return state;
        const next = new Map(state.queues);
        next.set(tabId, {
          ...cur,
          items: cur.items.slice(1),
          previewId: cur.previewId === id ? null : cur.previewId,
        });
        removed = true;
        return { queues: next };
      });
      return { removed, beforeCount };
    },

    cleanupClosedTab: (closedTabId) => {
      setAndPersist((state) => {
        let changed = false;
        const next = new Map(state.queues);

        if (next.delete(closedTabId)) changed = true;

        for (const [ownerTabId, queue] of next) {
          if (queue.runAfterTabId !== closedTabId) continue;
          next.set(ownerTabId, { ...queue, runAfterTabId: null });
          changed = true;
        }

        if (!changed) return state;
        return { queues: next };
      });
    },

    getQueue: (tabId) => get().queues.get(tabId) ?? EMPTY,
  };
});

// Hydrate from SQLite on app boot. Called by App.tsx once at mount. Idempotent —
// safe to call multiple times but only the first one with non-empty data wins
// (we merge, not replace, in case a tab already added entries before hydrate
// completed — unlikely but harmless).
export async function hydratePromptQueueStore(): Promise<void> {
  try {
    const raw = await ipcRenderer.invoke('app:getState', APP_STATE_KEY_QUEUE);
    if (!raw) return;
    // database.getAppState() already JSON.parses the stored string and returns
    // an OBJECT (it only returns the raw string when the parse fails). So `raw`
    // is normally an object here, not a string. Blindly JSON.parse-ing it again
    // coerces the object to "[object Object]" and throws — which is exactly the
    // `[PromptQueue] hydrate failed: {}` that fired on every boot, silently
    // dropping a queue that WAS saved correctly. Accept either shape.
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, {
      items?: QueuedPrompt[];
      autoRun?: boolean;
      stopAfter?: boolean;
      closeAfter?: boolean;
      firstDelaySeconds?: number;
      postPromptEnabled?: boolean;
      postPromptText?: string;
      runAfterTabId?: string | null;
    }>;
    if (!parsed || typeof parsed !== 'object') return;
    usePromptQueueStore.setState((state) => {
      const next = new Map(state.queues);
      for (const [tabId, entry] of Object.entries(parsed)) {
        if (next.has(tabId)) continue; // don't clobber an in-memory entry
        const items = Array.isArray(entry.items) ? entry.items : [];
        const fd = typeof entry.firstDelaySeconds === 'number'
          ? Math.max(0, Math.min(3600, Math.floor(entry.firstDelaySeconds)))
          : 0;
        next.set(tabId, {
          items,
          autoRun: !!entry.autoRun,
          stopAfter: !!entry.stopAfter,
          closeAfter: !!entry.closeAfter,
          previewId: null,
          firstDelaySeconds: fd,
          firstDelayCountdownAt: null, // never restore an in-flight countdown across restart
          postPromptEnabled: !!entry.postPromptEnabled,
          postPromptText: typeof entry.postPromptText === 'string' ? entry.postPromptText : '',
          firstChipHintActive: false, // UI-only, never restored
          stopBeforeCloseArm: false, // UI-only memory, never restored
          runAfterTabId: typeof entry.runAfterTabId === 'string' ? entry.runAfterTabId : null,
        });
      }
      return { queues: next };
    });
  } catch (e) {
    // Surface the real message — an Error serializes to `{}` through the
    // renderer→file log forwarder (JSON.stringify drops non-enumerable props),
    // which once hid this exact bug for days.
    console.warn('[PromptQueue] hydrate failed:', e instanceof Error ? e.message : String(e));
  }
}
