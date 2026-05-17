import { create } from 'zustand';

const { ipcRenderer } = window.require('electron');

// SQLite-backed persistence via the existing app:setState / app:getState
// pattern (same as defaultClaudeEffort, debugHoverBridges, freePorts).
// Persist: items, autoRun, stopAfter, firstDelaySeconds PER TAB. Skip: previewId (UI-only).
// Serialized shape: { [tabId]: { items, autoRun, stopAfter, firstDelaySeconds } }.
const APP_STATE_KEY_QUEUE = 'promptQueueByTab';

// Throttle disk writes — drag-reorder fires many state updates per second and
// SQLite IO on every keystroke would be wasteful. 250ms covers fast typing and
// drag-reorder without losing the last value on unmount.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(snapshot: Map<string, TabQueue>) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const out: Record<string, Pick<TabQueue, 'items' | 'autoRun' | 'stopAfter' | 'firstDelaySeconds'>> = {};
    for (const [tabId, q] of snapshot) {
      // Skip cold tabs with no persistable state — saves space + avoids polluting
      // the kv store with thousands of empty rows over time. Non-default delay is
      // persistable too so the user's chosen "X seconds" survives restarts even
      // when the queue is empty.
      if (q.items.length === 0 && !q.autoRun && !q.stopAfter && q.firstDelaySeconds === 0) continue;
      out[tabId] = { items: q.items, autoRun: q.autoRun, stopAfter: q.stopAfter, firstDelaySeconds: q.firstDelaySeconds };
    }
    ipcRenderer.invoke('app:setState', { key: APP_STATE_KEY_QUEUE, value: JSON.stringify(out) })
      .catch((e: unknown) => console.warn('[PromptQueue] save failed:', e));
  }, 250);
}

// One queued prompt — a draft the user wants to send to Claude after the current turn ends.
// `text` is the raw prompt as the user typed it. `images` is a count of image placeholders
// the user had referenced (e.g. "[Image #1]") — we can't carry the actual image bytes through
// the editor extraction path so we surface a stub marker instead. `id` is monotonic per session.
export type QueuedPrompt = {
  id: string;
  text: string;
  images: number; // number of [Image] / [Pasted image] placeholders the original input had
  createdAt: number;
};

type TabQueue = {
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
};

interface PromptQueueStore {
  // Per-tab queues. Outside Claude tabs the overlay is hidden, but state survives tab switching.
  queues: Map<string, TabQueue>;

  addPrompt: (tabId: string, text: string, images?: number) => string;
  removePrompt: (tabId: string, id: string) => void;
  updatePromptText: (tabId: string, id: string, text: string) => void;
  reorderPrompt: (tabId: string, fromIndex: number, toIndex: number) => void;
  clearQueue: (tabId: string) => void;

  setAutoRun: (tabId: string, value: boolean) => void;
  setStopAfter: (tabId: string, value: boolean) => void;
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

  // Pops the head item — used by the auto-runner when Stop hook fires. Returns null if empty.
  popNext: (tabId: string) => QueuedPrompt | null;

  getQueue: (tabId: string) => TabQueue;
}

const EMPTY: TabQueue = { items: [], autoRun: false, stopAfter: false, previewId: null, firstDelaySeconds: 0, firstDelayCountdownAt: null };

let idCounter = 0;
const nextId = () => `pq-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

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

    addPrompt: (tabId, text, images) => {
      const id = nextId();
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        const detectedImages = images ?? countImages(text);
        const items = [...cur.items, { id, text, images: detectedImages, createdAt: Date.now() }];
        next.set(tabId, { ...cur, items });
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
        next.set(tabId, { ...cur, items, previewId: cur.previewId === id ? null : cur.previewId });
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
        next.set(tabId, { ...cur, autoRun: value });
        return { queues: next };
      });
    },

    setStopAfter: (tabId, value) => {
      setAndPersist((state) => {
        const next = new Map(state.queues);
        const cur = next.get(tabId) ?? EMPTY;
        next.set(tabId, { ...cur, stopAfter: value });
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
    const parsed = JSON.parse(raw) as Record<string, { items?: QueuedPrompt[]; autoRun?: boolean; stopAfter?: boolean }>;
    if (!parsed || typeof parsed !== 'object') return;
    usePromptQueueStore.setState((state) => {
      const next = new Map(state.queues);
      for (const [tabId, entry] of Object.entries(parsed)) {
        if (next.has(tabId)) continue; // don't clobber an in-memory entry
        const items = Array.isArray(entry.items) ? entry.items : [];
        const fd = typeof (entry as { firstDelaySeconds?: number }).firstDelaySeconds === 'number'
          ? Math.max(0, Math.min(3600, Math.floor((entry as { firstDelaySeconds: number }).firstDelaySeconds)))
          : 0;
        next.set(tabId, {
          items,
          autoRun: !!entry.autoRun,
          stopAfter: !!entry.stopAfter,
          previewId: null,
          firstDelaySeconds: fd,
          firstDelayCountdownAt: null, // never restore an in-flight countdown across restart
        });
      }
      return { queues: next };
    });
  } catch (e) {
    console.warn('[PromptQueue] hydrate failed:', e);
  }
}
