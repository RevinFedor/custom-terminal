import { create } from 'zustand';

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
  setPreviewId: (tabId: string, id: string | null) => void;

  // Pops the head item — used by the auto-runner when Stop hook fires. Returns null if empty.
  popNext: (tabId: string) => QueuedPrompt | null;

  getQueue: (tabId: string) => TabQueue;
}

const EMPTY: TabQueue = { items: [], autoRun: false, stopAfter: false, previewId: null };

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

export const usePromptQueueStore = create<PromptQueueStore>((set, get) => ({
  queues: new Map(),

  addPrompt: (tabId, text, images) => {
    const id = nextId();
    set((state) => {
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
    set((state) => {
      const cur = state.queues.get(tabId);
      if (!cur) return state;
      const items = cur.items.filter((p) => p.id !== id);
      const next = new Map(state.queues);
      next.set(tabId, { ...cur, items, previewId: cur.previewId === id ? null : cur.previewId });
      return { queues: next };
    });
  },

  updatePromptText: (tabId, id, text) => {
    set((state) => {
      const cur = state.queues.get(tabId);
      if (!cur) return state;
      const items = cur.items.map((p) => p.id === id ? { ...p, text, images: countImages(text) } : p);
      const next = new Map(state.queues);
      next.set(tabId, { ...cur, items });
      return { queues: next };
    });
  },

  reorderPrompt: (tabId, fromIndex, toIndex) => {
    set((state) => {
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
    set((state) => {
      const next = new Map(state.queues);
      next.delete(tabId);
      return { queues: next };
    });
  },

  setAutoRun: (tabId, value) => {
    set((state) => {
      const next = new Map(state.queues);
      const cur = next.get(tabId) ?? EMPTY;
      next.set(tabId, { ...cur, autoRun: value });
      return { queues: next };
    });
  },

  setStopAfter: (tabId, value) => {
    set((state) => {
      const next = new Map(state.queues);
      const cur = next.get(tabId) ?? EMPTY;
      next.set(tabId, { ...cur, stopAfter: value });
      return { queues: next };
    });
  },

  setPreviewId: (tabId, id) => {
    set((state) => {
      const next = new Map(state.queues);
      const cur = next.get(tabId) ?? EMPTY;
      next.set(tabId, { ...cur, previewId: id });
      return { queues: next };
    });
  },

  popNext: (tabId) => {
    const cur = get().queues.get(tabId);
    if (!cur || cur.items.length === 0) return null;
    const [head, ...rest] = cur.items;
    set((state) => {
      const next = new Map(state.queues);
      next.set(tabId, { ...cur, items: rest, previewId: cur.previewId === head.id ? null : cur.previewId });
      return { queues: next };
    });
    return head;
  },

  getQueue: (tabId) => get().queues.get(tabId) ?? EMPTY,
}));
